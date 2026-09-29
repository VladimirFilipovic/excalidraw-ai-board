// Electron main process: hosts the Excalidraw window, a localhost HTTP API
// for the `exd` CLI, and the comment queue that connects the user to the agent.
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.EXD_PORT || 7788);
const HOST = "127.0.0.1";
const DIST = path.join(__dirname, "..", "dist");
const DATA_DIR = process.env.EXD_DATA_DIR || app.getPath("userData");
const SCENE_FILE = path.join(DATA_DIR, "scene.json");
const COMMENTS_FILE = path.join(DATA_DIR, "comments.json");

let win = null;

// ---------- persistence ----------

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// ---------- comments ----------

// store.seq increments on every user-authored message so `wait` can hand out
// only what the agent has not seen yet.
const store = readJSON(COMMENTS_FILE, { seq: 0, nextId: 1, delivered: 0, comments: [] });
const waiters = [];

function saveComments() {
  writeJSON(COMMENTS_FILE, store);
  if (win) win.webContents.send("comments:changed", store.comments);
}

function findComment(id) {
  const c = store.comments.find((c) => c.id === id || String(c.n) === String(id));
  if (!c) throw new Error(`comment not found: ${id}`);
  return c;
}

function needsAgent(c) {
  return c.status === "pending" && c.thread.length > 0 && c.thread[c.thread.length - 1].from === "user";
}

function newSince(since) {
  return store.comments.filter((c) => needsAgent(c) && c.thread.some((m) => m.from === "user" && m.seq > since));
}

function flushWaiters() {
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    const items = newSince(w.since);
    if (items.length) {
      waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(items);
    }
  }
}

function addUserMessage(c, text) {
  store.seq += 1;
  c.thread.push({ from: "user", text, at: new Date().toISOString(), seq: store.seq });
  c.status = "pending";
}

function userAddComment({ text, elementIds = [], anchor = null, snapshot = [] }) {
  const n = store.nextId++;
  const c = {
    id: `c${n}`,
    n,
    status: "pending",
    createdAt: new Date().toISOString(),
    elementIds,
    anchor,
    snapshot,
    thread: [],
  };
  addUserMessage(c, text);
  store.comments.push(c);
  saveComments();
  flushWaiters();
  return c;
}

// ---------- renderer bridge ----------

let reqSeq = 0;
const pending = new Map();

function toRenderer(cmd, args = {}, timeoutMs = 20000) {
  if (!win) return Promise.reject(new Error("window not open"));
  const id = ++reqSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`renderer timeout for ${cmd}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    win.webContents.send("cmd", { id, cmd, args });
  });
}

ipcMain.on("cmd-result", (_e, { id, ok, result, error }) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  ok ? p.resolve(result) : p.reject(new Error(error));
});

ipcMain.handle("scene:load", () => readJSON(SCENE_FILE, null));
ipcMain.on("scene:save", (_e, scene) => writeJSON(SCENE_FILE, scene));
ipcMain.handle("comments:list", () => store.comments);
ipcMain.handle("comment:add", (_e, data) => userAddComment(data));
ipcMain.handle("comment:reply", (_e, { id, text }) => {
  const c = findComment(id);
  addUserMessage(c, text);
  saveComments();
  flushWaiters();
  return c;
});
ipcMain.handle("comment:resolve", (_e, { id, resolved }) => {
  const c = findComment(id);
  c.status = resolved ? "resolved" : "pending";
  saveComments();
  return c;
});
ipcMain.handle("comment:delete", (_e, { id }) => {
  store.comments = store.comments.filter((c) => c.id !== id);
  saveComments();
  return true;
});

// ---------- window helpers ----------

function windowInfo() {
  const b = win.getBounds();
  const c = win.getContentBounds();
  const d = screen.getDisplayMatching(b);
  return {
    window: { x: b.x, y: b.y, width: b.width, height: b.height, focused: win.isFocused(), alwaysOnTop: win.isAlwaysOnTop() },
    content: { x: c.x, y: c.y, width: c.width, height: c.height },
    display: { id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor },
    displays: screen.getAllDisplays().map((x) => ({ id: x.id, bounds: x.bounds, scaleFactor: x.scaleFactor })),
  };
}

function origin() {
  const c = win.getContentBounds();
  return { x: c.x, y: c.y };
}

async function sendKey(key, modifiers) {
  win.focus();
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
  win.webContents.sendInputEvent({ type: "char", keyCode: key, modifiers });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
  await new Promise((r) => setTimeout(r, 60));
}

async function withComments(list) {
  const ids = [...new Set(list.flatMap((c) => c.elementIds))];
  let current = {};
  if (ids.length) {
    try {
      current = await toRenderer("summarize", { ids, _origin: origin() });
    } catch {}
  }
  return list.map((c) => ({
    ...c,
    needsAgent: needsAgent(c),
    elements: c.elementIds.map((id) => current[id] || { id, deleted: true }),
  }));
}

// ---------- command dispatch ----------

const mainCommands = {
  ping: () => ({ ok: true, pid: process.pid, port: PORT }),
  window: (a) => {
    if (a.x !== undefined || a.y !== undefined || a.width !== undefined || a.height !== undefined) {
      const b = win.getBounds();
      win.setBounds({ x: a.x ?? b.x, y: a.y ?? b.y, width: a.width ?? b.width, height: a.height ?? b.height });
    }
    if (a.alwaysOnTop !== undefined) win.setAlwaysOnTop(!!a.alwaysOnTop);
    if (a.focus) {
      win.show();
      win.focus();
    }
    if (a.fullscreen !== undefined) win.setFullScreen(!!a.fullscreen);
    return windowInfo();
  },
  screenshot: async (a) => {
    const img = await win.webContents.capturePage(a.rect);
    const png = img.toPNG();
    if (a.out) {
      fs.writeFileSync(a.out, png);
      return { out: path.resolve(a.out), bytes: png.length, size: img.getSize() };
    }
    return { mimeType: "image/png", base64: png.toString("base64"), size: img.getSize() };
  },
  undo: async () => {
    await sendKey("Z", [process.platform === "darwin" ? "meta" : "control"]);
    return { ok: true };
  },
  redo: async () => {
    await sendKey("Z", [process.platform === "darwin" ? "meta" : "control", "shift"]);
    return { ok: true };
  },
  // Synthetic input at window-content coordinates (CSS px).
  click: async (a) => {
    const x = Math.round(Number(a.x));
    const y = Math.round(Number(a.y));
    const button = a.button || "left";
    const modifiers = a.modifiers || [];
    win.webContents.sendInputEvent({ type: "mouseMove", x, y, modifiers });
    for (let i = 1; i <= (a.count || 1); i++) {
      win.webContents.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: i, modifiers });
      win.webContents.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: i, modifiers });
    }
    await new Promise((r) => setTimeout(r, 120));
    return { ok: true, x, y };
  },
  drag: async (a) => {
    const [x1, y1, x2, y2] = [a.x1, a.y1, a.x2, a.y2].map((v) => Math.round(Number(v)));
    const steps = a.steps || 12;
    win.webContents.sendInputEvent({ type: "mouseMove", x: x1, y: y1 });
    win.webContents.sendInputEvent({ type: "mouseDown", x: x1, y: y1, button: "left", clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(x1 + ((x2 - x1) * i) / steps);
      const y = Math.round(y1 + ((y2 - y1) * i) / steps);
      win.webContents.sendInputEvent({ type: "mouseMove", x, y, button: "left" });
      await new Promise((r) => setTimeout(r, 10));
    }
    win.webContents.sendInputEvent({ type: "mouseUp", x: x2, y: y2, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 120));
    return { ok: true };
  },
  type: async (a) => {
    await win.webContents.insertText(String(a.text ?? ""));
    return { ok: true };
  },
  key: async (a) => {
    await sendKey(a.key, a.modifiers || []);
    return { ok: true };
  },
  // Debug escape hatch: run JS in the renderer page.
  eval: (a) => win.webContents.executeJavaScript(String(a.js)),
  quit: () => {
    setTimeout(() => app.quit(), 50);
    return { ok: true };
  },

  comments: async (a) => {
    let list = store.comments;
    const status = a.status ?? "pending";
    if (status !== "all") list = list.filter((c) => c.status === status);
    return { cursor: store.seq, comments: await withComments(list) };
  },
  comment: async (a) => {
    const [c] = await withComments([findComment(a.id)]);
    return c;
  },
  // Long-poll: resolves as soon as the user posts something the agent has not
  // been handed yet. `since` defaults to the last cursor delivered by `wait`.
  wait: (a) =>
    new Promise((resolve) => {
      const since = a.since ?? store.delivered;
      const done = async (items) => {
        store.delivered = Math.max(store.delivered, store.seq);
        writeJSON(COMMENTS_FILE, store);
        resolve({ cursor: store.seq, timedOut: items.length === 0, comments: await withComments(items) });
      };
      const now = newSince(since);
      if (now.length) return done(now);
      const w = { since, resolve: done, timer: null };
      w.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        done([]);
      }, (a.timeout ?? 600) * 1000);
      waiters.push(w);
    }),
  reply: (a) => {
    const c = findComment(a.id);
    c.thread.push({ from: "agent", text: String(a.text ?? ""), at: new Date().toISOString() });
    if (a.resolve) c.status = "resolved";
    saveComments();
    return c;
  },
  resolve: (a) => {
    const c = findComment(a.id);
    c.status = "resolved";
    if (a.text) c.thread.push({ from: "agent", text: String(a.text), at: new Date().toISOString() });
    saveComments();
    return c;
  },
  reopen: (a) => {
    const c = findComment(a.id);
    c.status = "pending";
    saveComments();
    return c;
  },
  "comment-delete": (a) => {
    findComment(a.id);
    store.comments = store.comments.filter((c) => c.id !== a.id && String(c.n) !== String(a.id));
    saveComments();
    return { ok: true };
  },
};

async function dispatch(cmd, args) {
  if (mainCommands[cmd]) return mainCommands[cmd](args);
  const result = await toRenderer(cmd, { ...args, _origin: origin() }, cmd === "mermaid" || cmd === "export" ? 60000 : 20000);
  if (cmd === "state") return { ...windowInfo(), ...result, comments: { needsAgent: store.comments.filter(needsAgent).length, cursor: store.seq } };
  return result;
}

// ---------- HTTP server ----------

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  if (!p) p = "index.html";
  const file = path.join(DIST, p);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

function startServer() {
  const server = http.createServer((req, res) => {
    // Block DNS rebinding and cross-site requests from browser pages; the CLI sends no Origin.
    const hostOk = [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host);
    if (!hostOk) {
      res.writeHead(403).end("forbidden host");
      return;
    }
    if (req.method === "POST" && req.url === "/api") {
      if (req.headers.origin || req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "none") {
        res.writeHead(403).end("forbidden origin");
        return;
      }
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        let status = 200;
        let payload;
        try {
          const { cmd, args = {} } = JSON.parse(body || "{}");
          payload = { ok: true, result: await dispatch(cmd, args) };
        } catch (e) {
          status = 400;
          payload = { ok: false, error: e.message };
        }
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
      return;
    }
    serveStatic(req, res);
  });
  server.requestTimeout = 0;
  server.on("error", (e) => {
    console.error(`[exd] server error: ${e.message}`);
    app.quit();
  });
  return new Promise((r) => server.listen(PORT, HOST, r));
}

// ---------- app lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    await startServer();
    win = new BrowserWindow({
      width: 1400,
      height: 900,
      title: "Excalidraw",
      backgroundColor: "#ffffff",
      webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, backgroundThrottling: false },
    });
    win.loadURL(`http://${HOST}:${PORT}/`);
    win.on("closed", () => {
      win = null;
      app.quit();
    });
    console.log(`[exd] listening on http://${HOST}:${PORT}`);
  });

  app.on("window-all-closed", () => app.quit());
}

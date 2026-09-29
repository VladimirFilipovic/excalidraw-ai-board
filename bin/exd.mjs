#!/usr/bin/env node
// exd — drive the local Excalidraw app from the shell. Every command prints JSON.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.EXD_PORT || 7788);
const API = `http://127.0.0.1:${PORT}/api`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `exd — Excalidraw CLI (JSON in, JSON out). App: ${API}

APP
  start                         launch the app (no-op if running)
  stop | ping
  window [--x --y --w --h] [--on-top|--no-on-top] [--focus] [--fullscreen]
  screenshot [file.png]         capture the window (base64 if no file)

READ
  state [--full] [--visible]    viewport, window/screen geometry, appState, elements
  elements [--type rectangle,text] [--full]
  get <id> [--full]             one element (screen/window/scene coords)
  find [text] [--type t]        match text or shape labels
  selection                     currently selected elements
  coords --scene x,y | --window x,y | --screen x,y

DRAW   (style flags: --stroke --bg --fill hachure|cross-hatch|solid --sw 1|2|4
        --style solid|dashed|dotted --roughness 0|1|2 --opacity 0-100 --id <id>)
  rect|ellipse|diamond [--x --y --w --h] [--label "text"]
  text "hello" [--x --y --fontSize 20 --fontFamily 1|2|3|5]
  arrow --from <id> --to <id> [--label ""]     bound arrow between elements
  arrow|line --x --y --points '[[0,0],[200,50]]' [--endArrowhead arrow|triangle|dot|bar|null]
  connect <fromId> <toId> [--label text]
  freedraw --x --y --points '[[0,0],[5,3],...]'
  frame --x --y --w --h --name N
  image <file.png|jpg|svg> [--x --y --w --h]
  mermaid "<definition>" | --file diagram.mmd  [--x --y]
  add --json '<skeleton | skeleton[]>'   (or: add - < file.json) Excalidraw element skeletons

EDIT
  update <id[,id]> [--props '{...}'] [--text t] [--label t] [--x ..] [style flags]
  move <id...> (--dx --dy | --x --y)
  resize <id> --w --h
  delete <id...> | clear | duplicate <id...> [--dx --dy]
  select [id...]  (no ids = clear selection)
  group <id...> | ungroup <id...> | front <id...> | back <id...>
  undo | redo

INPUT  (window-content CSS px; add --scene or --screen to use those coords)
  click <x> <y> [--count 2] [--button right] [--mod shift,meta]
  drag <x1> <y1> <x2> <y2>
  type "text" | key <Key> [--mod meta,shift]

VIEW / STYLE
  view fit [id...] | view zoom <n> | view center <x> <y> | view scroll <dx> <dy> | view reset
  tool <selection|rectangle|ellipse|diamond|arrow|line|freedraw|text|eraser|hand|laser> [--locked]
  theme light|dark | bg <color> | grid <n|off>
  appstate --json '{...}'

FILES
  export <out.png|out.svg|out.excalidraw> [--ids a,b] [--scale 2] [--dark] [--padding 20] [--no-background]
  load <file.excalidraw> [--merge]

COMMENTS  (user selects elements in the app, 💬 Comment, writes a request)
  wait [--timeout 600] [--since n]   block until the user posts a new comment/reply
  comments [--status pending|resolved|all]
  comment <id>
  reply <id> "text" [--resolve]
  resolve <id> ["text"] | reopen <id> | comment-delete <id>

RAW
  call <cmd> '<json args>'           send any command directly
  batch <file.json|->                [{"cmd":"add","args":{"type":"rectangle",...}}, ...] API cmds, sequential

Global: --pretty  pretty-print JSON`;

// ---------- args ----------

function coerce(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {}
  }
  return v;
}

const ALIASES = { w: "width", h: "height", "on-top": "alwaysOnTop" };

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      let [k, v] = a.slice(2).split(/=(.*)/s);
      if (k.startsWith("no-")) {
        flags[ALIASES[k.slice(3)] || k.slice(3)] = false;
        continue;
      }
      if (v === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && (!next.startsWith("--") || /^--?\d/.test(next))) {
          v = next;
          i++;
        } else v = "true";
      }
      flags[ALIASES[k] || k] = coerce(v);
    } else pos.push(a);
  }
  return { pos, flags };
}

const readStdin = () => fs.readFileSync(0, "utf8");
const readMaybe = (v) => (v === "-" ? readStdin() : fs.existsSync(v) ? fs.readFileSync(v, "utf8") : v);
const pair = (v) => String(v).split(",").map(Number);

// ---------- transport ----------

async function call(cmd, args = {}) {
  let res;
  try {
    res = await fetch(API, { method: "POST", body: JSON.stringify({ cmd, args }) });
  } catch {
    throw new Error(`app not running on port ${PORT} — run: exd start`);
  }
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}

async function isUp() {
  try {
    await call("ping");
    return true;
  } catch {
    return false;
  }
}

async function start() {
  if (await isUp()) return { started: false, running: true, port: PORT };
  if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
    throw new Error(`renderer not built — run: npm --prefix ${ROOT} run build`);
  }
  const electron = createRequire(import.meta.url)("electron");
  const child = spawn(electron, [ROOT], { detached: true, stdio: "ignore", env: { ...process.env, EXD_PORT: String(PORT) } });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isUp()) {
      // give Excalidraw a moment to mount and register the command handler
      for (let j = 0; j < 50; j++) {
        try {
          await call("state");
          return { started: true, running: true, port: PORT, pid: child.pid };
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
  }
  throw new Error("app did not come up within 20s");
}

// ---------- commands ----------

// click/drag take window coords by default; --scene or --screen converts.
async function toWindow(x, y, f) {
  if (f.scene) return (await call("coords", { sceneX: x, sceneY: y })).window;
  if (f.screen) return (await call("coords", { screenX: x, screenY: y })).window;
  return { x, y };
}

const SHAPES = ["rect", "rectangle", "ellipse", "diamond", "text", "arrow", "line", "freedraw", "frame"];

async function run(cmd, pos, f) {
  if (SHAPES.includes(cmd)) {
    const type = cmd === "rect" ? "rectangle" : cmd;
    const el = { type, ...f };
    if (type === "text") el.text = pos.join(" ") || f.text || "";
    if (type === "frame") el.children = f.children || [];
    if (pos.length && type !== "text") el.label = pos.join(" ");
    return call("add", el);
  }
  switch (cmd) {
    case "start":
      return start();
    case "stop":
      return call("quit");
    case "state":
    case "elements":
    case "selection":
    case "ping":
    case "clear":
    case "undo":
    case "redo":
      return call(cmd, f);
    case "get":
    case "comment":
    case "reopen":
    case "comment-delete":
      return call(cmd, { id: pos[0], ...f });
    case "find":
      return call("find", { text: pos.join(" ") || f.text, ...f });
    case "add": {
      const src = f.json ?? (pos[0] ? readMaybe(pos[0]) : readStdin());
      const els = typeof src === "string" ? JSON.parse(src) : src;
      return call("add", { elements: Array.isArray(els) ? els : [els] });
    }
    case "connect":
      return call("connect", { from: pos[0], to: pos[1], ...f });
    case "update":
      return call("update", { id: pos[0], ...(f.props ? { props: f.props } : f) });
    case "move":
    case "delete":
    case "duplicate":
    case "group":
    case "ungroup":
    case "select":
      return call(cmd, { ids: pos, ...f });
    case "front":
    case "back":
      return call("order", { ids: pos, to: cmd });
    case "resize":
      return call("update", { id: pos[0], props: { width: f.width, height: f.height } });
    case "view": {
      const [action = "fit", ...rest] = pos;
      if (action === "zoom") return call("view", { action, value: Number(rest[0] ?? f.value) });
      if (action === "center") return call("view", { action, x: Number(rest[0] ?? f.x), y: Number(rest[1] ?? f.y) });
      if (action === "scroll") return call("view", { action, dx: Number(rest[0] ?? f.dx ?? 0), dy: Number(rest[1] ?? f.dy ?? 0) });
      return call("view", { action, ids: rest, ...f });
    }
    case "coords": {
      if (f.scene) {
        const [x, y] = pair(f.scene);
        return call("coords", { sceneX: x, sceneY: y });
      }
      if (f.window) {
        const [x, y] = pair(f.window);
        return call("coords", { windowX: x, windowY: y });
      }
      if (f.screen) {
        const [x, y] = pair(f.screen);
        return call("coords", { screenX: x, screenY: y });
      }
      throw new Error("coords needs --scene x,y | --window x,y | --screen x,y");
    }
    case "tool":
      return call("tool", { type: pos[0] || "selection", locked: f.locked });
    case "theme":
      return call("appstate", { theme: pos[0] || "light" });
    case "bg":
      return call("appstate", { viewBackgroundColor: pos[0] });
    case "grid":
      return call("appstate", pos[0] === "off" ? { gridModeEnabled: false } : { gridModeEnabled: true, gridSize: Number(pos[0] || 20) });
    case "appstate":
      return call("appstate", f.json ?? f);
    case "window":
      return call("window", f);
    case "screenshot": {
      const out = pos[0] || f.out;
      return call("screenshot", { out: out && path.resolve(out) });
    }
    case "export":
    case "save": {
      const out = pos[0] || f.out;
      const ext = out ? path.extname(out).slice(1) : f.format || "png";
      const format = ext === "excalidraw" || ext === "json" ? "json" : ext;
      const r = await call("export", { ...f, format, ids: f.ids });
      if (!out) return r;
      if (format === "png") fs.writeFileSync(out, Buffer.from(r.base64, "base64"));
      else fs.writeFileSync(out, r.data);
      return { out: path.resolve(out), format, bytes: fs.statSync(out).size };
    }
    case "load":
      return call("load", { scene: fs.readFileSync(pos[0], "utf8"), merge: !!f.merge });
    case "image": {
      const file = pos[0];
      const ext = path.extname(file).slice(1).toLowerCase();
      const mimeType = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" }[ext];
      if (!mimeType) throw new Error(`unsupported image type: ${ext}`);
      const dataURL = `data:${mimeType};base64,${fs.readFileSync(file).toString("base64")}`;
      return call("image", { dataURL, mimeType, ...f });
    }
    case "mermaid": {
      const definition = f.file ? readMaybe(f.file) : pos.length ? pos.join(" ") : readStdin();
      return call("mermaid", { definition, ...f, file: undefined });
    }
    case "click": {
      const p = await toWindow(Number(pos[0]), Number(pos[1]), f);
      return call("click", { ...p, count: f.count, button: f.button, modifiers: f.mod ? String(f.mod).split(",") : undefined });
    }
    case "drag": {
      const a = await toWindow(Number(pos[0]), Number(pos[1]), f);
      const b = await toWindow(Number(pos[2]), Number(pos[3]), f);
      return call("drag", { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    case "type":
      return call("type", { text: pos.join(" ") });
    case "key":
      return call("key", { key: pos[0], modifiers: f.mod ? String(f.mod).split(",") : [] });
    case "wait":
      return call("wait", f);
    case "comments":
      return call("comments", f);
    case "reply":
      return call("reply", { id: pos[0], text: pos.slice(1).join(" ") || f.text, resolve: !!f.resolve });
    case "resolve":
      return call("resolve", { id: pos[0], text: pos.slice(1).join(" ") || f.text });
    case "call":
      return call(pos[0], pos[1] ? JSON.parse(readMaybe(pos[1])) : f);
    case "batch": {
      const list = JSON.parse(readMaybe(pos[0] || "-"));
      const results = [];
      for (const step of list) {
        try {
          results.push({ cmd: step.cmd, ok: true, result: await call(step.cmd, step.args || {}) });
        } catch (e) {
          results.push({ cmd: step.cmd, ok: false, error: e.message });
          if (!f["keep-going"]) break;
        }
      }
      return results;
    }
    default:
      throw new Error(`unknown command: ${cmd} (see: exd help)`);
  }
}

const argv = process.argv.slice(2);
const { pos, flags } = parse(argv);
const pretty = flags.pretty;
delete flags.pretty;
const cmd = pos.shift();

if (!cmd || cmd === "help" || flags.help) {
  console.log(HELP);
  process.exit(0);
}

try {
  const result = await run(cmd, pos, flags);
  console.log(JSON.stringify(result, null, pretty ? 2 : 0));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(1);
}

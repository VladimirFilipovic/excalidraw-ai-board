// CLI command handlers executed inside the renderer against the Excalidraw API.
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  restore,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import {
  addBoundRef,
  bindArrow,
  bounds,
  bump,
  commonBounds,
  layoutBoundText,
  measureText,
  randId,
  relayout,
  routeArrow,
  sceneToWindow,
  summarize,
  viewport,
  windowToScene,
} from "./scene.js";

const STYLE_KEYS = {
  stroke: "strokeColor",
  color: "strokeColor",
  bg: "backgroundColor",
  background: "backgroundColor",
  fill: "fillStyle",
  sw: "strokeWidth",
  style: "strokeStyle",
};


function normalizeProps(p) {
  const out = {};
  for (const [k, v] of Object.entries(p || {})) {
    if (k.startsWith("_")) continue;
    out[STYLE_KEYS[k] || k] = v;
  }
  if (out.w !== undefined) (out.width = out.w), delete out.w;
  if (out.h !== undefined) (out.height = out.h), delete out.h;
  if (out.fontSize !== undefined) out.fontSize = Number(out.fontSize);
  return out;
}

const blobToBase64 = (blob) =>
  new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.readAsDataURL(blob);
  });

const toList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : String(v).split(",").filter(Boolean));

export function createCommands(api) {
  const all = () => api.getSceneElementsIncludingDeleted();
  const live = () => api.getSceneElements();
  const mapOf = (els = all()) => new Map(els.map((e) => [e.id, e]));
  const commit = (elements, appState) =>
    api.updateScene({ elements, ...(appState ? { appState } : {}), captureUpdate: CaptureUpdateAction.IMMEDIATELY });

  const getLive = (id) => {
    const el = all().find((e) => e.id === id && !e.isDeleted);
    if (!el) throw new Error(`element not found: ${id}`);
    return el;
  };

  // Bound text is reported as `label` on its container, so skip it by default.
  const summ = (els, origin, withBound = false) => {
    const map = mapOf();
    const st = api.getAppState();
    return els.filter((e) => withBound || !(e.type === "text" && e.containerId)).map((e) => summarize(e, map, st, origin));
  };

  const viewportCenter = () => {
    const st = api.getAppState();
    const v = viewport(st).visibleScene;
    return { x: v.x + v.width / 2, y: v.y + v.height / 2 };
  };

  // Place new content: explicit x/y wins, else to the right of existing content, else viewport center.
  const freeSpot = () => {
    const b = commonBounds(live());
    return b ? { x: b.x + b.width + 80, y: b.y } : viewportCenter();
  };

  // Convert skeletons, bind arrows to pre-existing elements, route arrows.
  function addSkeletons(skeletons) {
    const existing = mapOf();
    const batchIds = new Set(skeletons.map((s) => s.id).filter(Boolean));
    const manualBindings = [];
    const center = viewportCenter();
    const prepared = skeletons.map((raw) => {
      const s = normalizeProps(raw);
      if (typeof s.label === "string") s.label = { text: s.label };
      if (["rectangle", "ellipse", "diamond"].includes(s.type)) {
        s.width ??= s.type === "rectangle" ? 160 : 180;
        s.height ??= s.type === "rectangle" ? 80 : 100;
      }
      if (!s.id) s.id = randId();
      const isArrow = s.type === "arrow" || s.type === "line";
      if (isArrow) {
        const from = s.from ?? s.start?.id;
        const to = s.to ?? s.end?.id;
        delete s.from;
        delete s.to;
        const ext = (id) => id && !batchIds.has(id) && existing.has(id);
        if (ext(from) || ext(to) || (from && !s.start) || (to && !s.end)) {
          if (from) delete s.start;
          if (to) delete s.end;
          manualBindings.push({ id: s.id, from, to });
        }
        if (Array.isArray(s.points)) {
          const xs = s.points.map((p) => p[0]);
          const ys = s.points.map((p) => p[1]);
          s.width = Math.max(...xs) - Math.min(...xs);
          s.height = Math.max(...ys) - Math.min(...ys);
        }
      }
      if (s.type === "freedraw" && Array.isArray(s.points)) {
        s.pressures = s.pressures || [];
        s.simulatePressure = s.simulatePressure ?? true;
        s.lastCommittedPoint = null;
        s.x ??= center.x;
        s.y ??= center.y;
        const xs = s.points.map((p) => p[0]);
        const ys = s.points.map((p) => p[1]);
        s.width = Math.max(...xs) - Math.min(...xs);
        s.height = Math.max(...ys) - Math.min(...ys);
      }
      if (s.x === undefined || s.y === undefined) {
        s.x ??= center.x - (s.width || 100) / 2;
        s.y ??= center.y - (s.height || 100) / 2;
      }
      s.x = Number(s.x);
      s.y = Number(s.y);
      if (s.width !== undefined) s.width = Number(s.width);
      if (s.height !== undefined) s.height = Number(s.height);
      return s;
    });

    const freedraws = prepared.filter((s) => s.type === "freedraw");
    let created = convertToExcalidrawElements(
      prepared.filter((s) => s.type !== "freedraw"),
      { regenerateIds: false },
    );
    // The skeleton API passes freedraw through untouched, so borrow base
    // element fields (seed, version, index...) from a throwaway rectangle.
    for (const f of freedraws) {
      const [base] = convertToExcalidrawElements([{ type: "rectangle", x: f.x, y: f.y, width: 1, height: 1 }]);
      created.push({ ...base, backgroundColor: "transparent", ...f, type: "freedraw", roundness: null });
    }

    let merged = [...all(), ...created];
    let map = mapOf(merged);
    for (const mb of manualBindings) {
      let arrow = map.get(mb.id);
      const from = mb.from && map.get(mb.from);
      const to = mb.to && map.get(mb.to);
      if (mb.from && !from) throw new Error(`from element not found: ${mb.from}`);
      if (mb.to && !to) throw new Error(`to element not found: ${mb.to}`);
      arrow = bindArrow(arrow, from, to);
      map.set(arrow.id, arrow);
      if (from) map.set(from.id, addBoundRef(from, { id: arrow.id, type: "arrow" }));
      if (to) map.set(to.id, addBoundRef(map.get(to.id), { id: arrow.id, type: "arrow" }));
    }
    merged = merged.map((e) => map.get(e.id));
    // Route every new bound arrow unless explicit points were supplied.
    const routeIds = prepared.filter((s) => (s.type === "arrow" || s.type === "line") && !s.points).map((s) => s.id);
    merged = relayout(merged, routeIds);
    commit(merged);
    const createdIds = new Set(created.map((c) => c.id));
    return merged.filter((e) => createdIds.has(e.id));
  }

  function setLabel(elements, container, text, opts = {}) {
    const map = mapOf(elements);
    const ref = (container.boundElements || []).find((b) => b.type === "text");
    const existing = ref && map.get(ref.id);
    if (existing && !existing.isDeleted) {
      if (text === "" || text === null) {
        return elements.map((e) =>
          e.id === existing.id ? bump(e, { isDeleted: true }) : e.id === container.id ? bump(e, { boundElements: e.boundElements.filter((b) => b.id !== existing.id) }) : e,
        );
      }
      const m = measureText(text, { fontSize: opts.fontSize ?? existing.fontSize, fontFamily: existing.fontFamily });
      let c = container;
      if (c.type !== "arrow" && (m.width + 20 > c.width || m.height + 20 > c.height)) {
        const cx = c.x + c.width / 2;
        const cy = c.y + c.height / 2;
        const w = Math.max(c.width, m.width + 20);
        const h = Math.max(c.height, m.height + 20);
        c = bump(c, { x: cx - w / 2, y: cy - h / 2, width: w, height: h });
      }
      const t = layoutBoundText(c, bump(existing, { text: m.text, originalText: text, width: m.width, height: m.height, ...opts }));
      return elements.map((e) => (e.id === t.id ? t : e.id === c.id ? c : e));
    }
    if (!text) return elements;
    const [tmp, label] = convertToExcalidrawElements([{ type: container.type === "arrow" ? "arrow" : "rectangle", x: container.x, y: container.y, width: container.width, height: container.height, label: { text, ...opts } }]);
    const t = layoutBoundText(container, { ...label, containerId: container.id });
    void tmp;
    return [...elements.map((e) => (e.id === container.id ? addBoundRef(e, { id: t.id, type: "text" }) : e)), t];
  }

  function updateOne(elements, id, rawProps) {
    const props = normalizeProps(rawProps);
    const map = mapOf(elements);
    let el = map.get(id);
    if (!el || el.isDeleted) throw new Error(`element not found: ${id}`);
    const { label, text, ...rest } = props;
    if (rest.points) {
      const xs = rest.points.map((p) => p[0]);
      const ys = rest.points.map((p) => p[1]);
      rest.width = Math.max(...xs) - Math.min(...xs);
      rest.height = Math.max(...ys) - Math.min(...ys);
    }
    el = bump(el, rest);
    if (text !== undefined && el.type === "text") {
      const m = measureText(String(text), { fontSize: el.fontSize, fontFamily: el.fontFamily });
      el = bump(el, { text: m.text, originalText: String(text), width: m.width, height: m.height });
      if (el.containerId && map.get(el.containerId)) el = layoutBoundText(map.get(el.containerId), el);
    } else if (text !== undefined) {
      elements = setLabel(elements.map((e) => (e.id === id ? el : e)), el, String(text));
      el = mapOf(elements).get(id);
    }
    elements = elements.map((e) => (e.id === id ? el : e));
    if (label !== undefined) {
      const l = typeof label === "object" && label !== null ? label : { text: label };
      const { text: lt, ...lopts } = l;
      elements = setLabel(elements, el, lt, normalizeProps(lopts));
    }
    return elements;
  }

  function deleteIds(ids) {
    const del = new Set(ids);
    for (const e of all()) if (del.has(e.id)) for (const b of e.boundElements || []) if (b.type === "text") del.add(b.id);
    return all().map((e) => {
      if (del.has(e.id)) return bump(e, { isDeleted: true });
      let next = e;
      if (e.boundElements?.some((b) => del.has(b.id))) next = bump(next, { boundElements: e.boundElements.filter((b) => !del.has(b.id)) });
      if (e.type === "arrow") {
        if (e.startBinding && del.has(e.startBinding.elementId)) next = bump(next, { startBinding: null });
        if (e.endBinding && del.has(e.endBinding.elementId)) next = bump(next, { endBinding: null });
      }
      return next;
    });
  }

  function moveIds(ids, dx, dy) {
    const set = new Set(ids);
    for (const e of all()) if (set.has(e.id)) for (const b of e.boundElements || []) if (b.type === "text") set.add(b.id);
    const moved = all().map((e) => (set.has(e.id) && !e.isDeleted ? bump(e, { x: e.x + dx, y: e.y + dy }) : e));
    return relayout(moved, [...set]);
  }

  const handlers = {
    state: (a) => {
      const st = api.getAppState();
      const els = live();
      const origin = a._origin;
      const sel = Object.keys(st.selectedElementIds || {}).filter((k) => st.selectedElementIds[k]);
      const vp = viewport(st);
      return {
        viewport: {
          ...vp,
          screen: origin ? { x: origin.x + vp.offsetLeft, y: origin.y + vp.offsetTop, width: vp.width, height: vp.height } : undefined,
          formula: "window = (scene + scroll) * zoom + offset; screen = content.xy + window",
        },
        appState: {
          theme: st.theme,
          viewBackgroundColor: st.viewBackgroundColor,
          activeTool: st.activeTool?.type,
          gridSize: st.gridSize,
          gridModeEnabled: st.gridModeEnabled,
          viewModeEnabled: st.viewModeEnabled,
          zenModeEnabled: st.zenModeEnabled,
          selectedElementIds: sel,
          editingTextElement: st.editingTextElement?.id ?? null,
          currentItem: {
            strokeColor: st.currentItemStrokeColor,
            backgroundColor: st.currentItemBackgroundColor,
            fillStyle: st.currentItemFillStyle,
            strokeWidth: st.currentItemStrokeWidth,
            strokeStyle: st.currentItemStrokeStyle,
            roughness: st.currentItemRoughness,
            opacity: st.currentItemOpacity,
            fontFamily: st.currentItemFontFamily,
            fontSize: st.currentItemFontSize,
          },
        },
        sceneBounds: commonBounds(els),
        count: els.length,
        elements: a.full ? els : summ(els, origin, a.boundText).filter((e) => !a.visible || e.visible),
      };
    },
    elements: (a) => {
      let els = live();
      if (a.type) els = els.filter((e) => toList(a.type).includes(e.type));
      return a.full ? els : summ(els, a._origin, a.boundText);
    },
    get: (a) => {
      const ids = toList(a.id ?? a.ids);
      const els = ids.map(getLive);
      const out = els.map((e) => ({ ...summ([e], a._origin, true)[0], raw: a.full ? e : undefined }));
      return ids.length === 1 ? out[0] : out;
    },
    summarize: (a) => {
      const map = mapOf();
      const st = api.getAppState();
      const out = {};
      for (const id of a.ids) {
        const e = map.get(id);
        if (e && !e.isDeleted) out[id] = summarize(e, map, st, a._origin);
      }
      return out;
    },
    find: (a) => {
      const q = a.text ? String(a.text).toLowerCase() : null;
      const map = mapOf();
      const st = api.getAppState();
      return live()
        .filter((e) => !a.type || toList(a.type).includes(e.type))
        .map((e) => summarize(e, map, st, a._origin))
        .filter((s) => !q || (s.text || "").toLowerCase().includes(q) || (s.label || "").toLowerCase().includes(q))
        .filter((s) => !(s.type === "text" && s.containerId && q && map.get(s.containerId)));
    },
    selection: (a) => {
      const st = api.getAppState();
      const ids = Object.keys(st.selectedElementIds || {}).filter((k) => st.selectedElementIds[k]);
      return summ(live().filter((e) => ids.includes(e.id)), a._origin);
    },
    add: (a) => {
      let skeletons = a.elements;
      if (!skeletons) {
        const { elements, _origin, ...one } = a;
        skeletons = [one];
      }
      if (!Array.isArray(skeletons)) skeletons = [skeletons];
      const created = addSkeletons(skeletons);
      if (a.select !== false) commit(all(), { selectedElementIds: {} });
      return summ(created, a._origin);
    },
    connect: (a) => {
      const { from, to, label, _origin, ...rest } = a;
      if (!from || !to) throw new Error("connect needs from and to");
      getLive(from);
      getLive(to);
      const created = addSkeletons([{ type: "arrow", from, to, label, ...rest }]);
      return summ(created, _origin);
    },
    update: (a) => {
      const { id, ids, props, _origin, ...flat } = a;
      const list = toList(id ?? ids);
      if (!list.length) throw new Error("update needs id");
      let els = all();
      for (const i of list) els = updateOne(els, i, props || flat);
      els = relayout(els, list);
      commit(els);
      return summ(list.map((i) => els.find((e) => e.id === i)), _origin);
    },
    move: (a) => {
      const ids = toList(a.id ?? a.ids);
      if (!ids.length) throw new Error("move needs id");
      let dx = Number(a.dx || 0);
      let dy = Number(a.dy || 0);
      if (a.x !== undefined || a.y !== undefined) {
        const b = commonBounds(ids.map(getLive));
        if (a.x !== undefined) dx = Number(a.x) - b.x;
        if (a.y !== undefined) dy = Number(a.y) - b.y;
      }
      const els = moveIds(ids, dx, dy);
      commit(els);
      return summ(ids.map((i) => els.find((e) => e.id === i)), a._origin);
    },
    resize: (a) => handlers.update({ id: a.id, props: { width: a.width, height: a.height }, _origin: a._origin }),
    delete: (a) => {
      const ids = toList(a.id ?? a.ids);
      ids.forEach(getLive);
      commit(deleteIds(ids));
      return { deleted: ids };
    },
    clear: () => {
      const n = live().length;
      commit(all().map((e) => (e.isDeleted ? e : bump(e, { isDeleted: true }))), { selectedElementIds: {} });
      return { deleted: n };
    },
    duplicate: (a) => {
      const ids = toList(a.id ?? a.ids);
      const dx = Number(a.dx ?? 20);
      const dy = Number(a.dy ?? 20);
      const idMap = new Map();
      const src = ids.map(getLive);
      for (const e of src) for (const b of e.boundElements || []) if (b.type === "text") src.push(getLive(b.id));
      for (const e of src) idMap.set(e.id, randId());
      const copies = src.map((e) =>
        bump(e, {
          id: idMap.get(e.id),
          x: e.x + dx,
          y: e.y + dy,
          seed: Math.floor(Math.random() * 2 ** 31),
          containerId: e.containerId ? idMap.get(e.containerId) ?? null : e.containerId,
          boundElements: (e.boundElements || []).filter((b) => idMap.has(b.id)).map((b) => ({ ...b, id: idMap.get(b.id) })),
          startBinding: e.startBinding && idMap.has(e.startBinding.elementId) ? { ...e.startBinding, elementId: idMap.get(e.startBinding.elementId) } : null,
          endBinding: e.endBinding && idMap.has(e.endBinding.elementId) ? { ...e.endBinding, elementId: idMap.get(e.endBinding.elementId) } : null,
        }),
      );
      commit([...all(), ...copies]);
      return summ(copies.filter((c) => ids.map((i) => idMap.get(i)).includes(c.id)), a._origin);
    },
    select: (a) => {
      const ids = toList(a.id ?? a.ids);
      ids.forEach(getLive);
      commit(all(), { selectedElementIds: Object.fromEntries(ids.map((i) => [i, true])) });
      return { selected: ids };
    },
    group: (a) => {
      const ids = toList(a.id ?? a.ids);
      const gid = randId();
      const set = new Set(ids);
      commit(all().map((e) => (set.has(e.id) ? bump(e, { groupIds: [...(e.groupIds || []), gid] }) : e)));
      return { groupId: gid, ids };
    },
    ungroup: (a) => {
      const ids = toList(a.id ?? a.ids);
      const set = new Set(ids);
      commit(all().map((e) => (set.has(e.id) ? bump(e, { groupIds: (e.groupIds || []).slice(0, -1) }) : e)));
      return { ids };
    },
    order: (a) => {
      const ids = new Set(toList(a.id ?? a.ids));
      const els = all();
      const pick = els.filter((e) => ids.has(e.id));
      const rest = els.filter((e) => !ids.has(e.id));
      const to = a.to || "front";
      commit(to === "back" ? [...pick, ...rest] : [...rest, ...pick]);
      return { order: to, ids: [...ids] };
    },
    view: (a) => {
      const st = api.getAppState();
      const action = a.action || "fit";
      if (action === "fit") {
        const ids = toList(a.id ?? a.ids);
        const target = ids.length ? ids.map(getLive) : live();
        api.scrollToContent(target, { fitToViewport: true, viewportZoomFactor: Number(a.factor ?? 0.8), animate: false });
      } else if (action === "zoom") {
        const z = Math.min(30, Math.max(0.1, Number(a.value)));
        const c = viewportCenter();
        api.updateScene({
          appState: { zoom: { value: z }, scrollX: st.width / 2 / z - c.x, scrollY: st.height / 2 / z - c.y },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      } else if (action === "center") {
        const z = st.zoom.value;
        api.updateScene({
          appState: { scrollX: st.width / 2 / z - Number(a.x), scrollY: st.height / 2 / z - Number(a.y) },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      } else if (action === "scroll") {
        api.updateScene({
          appState: { scrollX: st.scrollX - Number(a.dx || 0), scrollY: st.scrollY - Number(a.dy || 0) },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      } else if (action === "reset") {
        api.updateScene({ appState: { zoom: { value: 1 }, scrollX: 0, scrollY: 0 }, captureUpdate: CaptureUpdateAction.NEVER });
      } else throw new Error(`unknown view action: ${action}`);
      return new Promise((r) => requestAnimationFrame(() => r(viewport(api.getAppState()))));
    },
    coords: (a) => {
      const st = api.getAppState();
      const o = a._origin;
      let scene;
      if (a.sceneX !== undefined) scene = { x: Number(a.sceneX), y: Number(a.sceneY) };
      else if (a.windowX !== undefined) scene = windowToScene(st, Number(a.windowX), Number(a.windowY));
      else if (a.screenX !== undefined) scene = windowToScene(st, Number(a.screenX) - o.x, Number(a.screenY) - o.y);
      else throw new Error("coords needs sceneX/Y, windowX/Y or screenX/Y");
      const w = sceneToWindow(st, scene.x, scene.y);
      return { scene, window: w, screen: { x: o.x + w.x, y: o.y + w.y } };
    },
    tool: (a) => {
      api.setActiveTool({ type: a.type || "selection", locked: !!a.locked });
      return { activeTool: a.type || "selection" };
    },
    appstate: (a) => {
      const { _origin, ...props } = a;
      const p = { ...props };
      if (p.zoom !== undefined && typeof p.zoom !== "object") p.zoom = { value: Number(p.zoom) };
      api.updateScene({ appState: p, captureUpdate: CaptureUpdateAction.NEVER });
      return { ok: true, set: Object.keys(p) };
    },
    export: async (a) => {
      const ids = toList(a.id ?? a.ids);
      const elements = ids.length ? live().filter((e) => ids.includes(e.id) || ids.includes(e.containerId)) : live();
      const st = api.getAppState();
      const files = api.getFiles();
      const appState = {
        ...st,
        exportBackground: a.background !== false,
        exportWithDarkMode: !!a.dark,
        viewBackgroundColor: a.bg ?? st.viewBackgroundColor,
      };
      const padding = Number(a.padding ?? 20);
      const format = a.format || "png";
      if (format === "json") return { format, data: serializeAsJSON(elements, st, files, "local") };
      if (format === "svg") {
        const svg = await exportToSvg({ elements, appState, files, exportPadding: padding });
        return { format, data: svg.outerHTML };
      }
      const scale = Number(a.scale ?? 2);
      const blob = await exportToBlob({
        elements,
        appState,
        files,
        exportPadding: padding,
        mimeType: "image/png",
        getDimensions: (w, h) => ({ width: w * scale, height: h * scale, scale }),
      });
      return { format, base64: await blobToBase64(blob) };
    },
    load: (a) => {
      const data = typeof a.scene === "string" ? JSON.parse(a.scene) : a.scene;
      const r = restore(data, null, null);
      if (r.files && Object.keys(r.files).length) api.addFiles(Object.values(r.files));
      const elements = a.merge ? [...all(), ...r.elements] : [...all().map((e) => bump(e, { isDeleted: true })), ...r.elements];
      commit(elements, a.merge ? undefined : { viewBackgroundColor: r.appState.viewBackgroundColor });
      if (!a.merge) api.scrollToContent(r.elements, { fitToViewport: true, viewportZoomFactor: 0.8 });
      return { loaded: r.elements.filter((e) => !e.isDeleted).length };
    },
    image: async (a) => {
      const fileId = a.fileId || randId() + randId();
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error("cannot decode image"));
        img.src = a.dataURL;
      });
      let width = a.width !== undefined ? Number(a.width) : img.naturalWidth;
      let height = a.height !== undefined ? Number(a.height) : (width / img.naturalWidth) * img.naturalHeight;
      if (a.width === undefined && a.height !== undefined) width = (height / img.naturalHeight) * img.naturalWidth;
      api.addFiles([{ id: fileId, dataURL: a.dataURL, mimeType: a.mimeType, created: Date.now() }]);
      const spot = a.x !== undefined ? { x: Number(a.x), y: Number(a.y) } : freeSpot();
      const created = addSkeletons([{ type: "image", id: a.id, fileId, x: spot.x, y: spot.y, width, height, status: "saved" }]);
      return summ(created, a._origin);
    },
    mermaid: async (a) => {
      const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
      const { elements: sk, files } = await parseMermaidToExcalidraw(a.definition, { themeVariables: { fontSize: `${a.fontSize ?? 16}px` } });
      let els = convertToExcalidrawElements(sk, { regenerateIds: true });
      const b = commonBounds(els);
      const spot = a.x !== undefined ? { x: Number(a.x), y: Number(a.y) } : freeSpot();
      els = els.map((e) => ({ ...e, x: e.x - b.x + spot.x, y: e.y - b.y + spot.y }));
      if (files) api.addFiles(Object.values(files));
      commit([...all(), ...els]);
      api.scrollToContent(live(), { fitToViewport: true, viewportZoomFactor: 0.8 });
      return summ(els.filter((e) => !e.containerId), a._origin);
    },
  };

  // Text is measured synchronously, so the hand-drawn fonts must be loaded first.
  let fontsReady = null;
  const loadFonts = () =>
    (fontsReady ??= Promise.all(
      ["Excalifont", "Nunito", "Comic Shanns", "Lilita One", "Virgil", "Cascadia", "Liberation Sans"].map((f) => document.fonts.load(`20px "${f}"`).catch(() => null)),
    ));

  return async (cmd, args) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unknown command: ${cmd}`);
    await loadFonts();
    return h(args || {});
  };
}

export { bounds, routeArrow };

// Scene helpers shared by CLI commands and the comment UI: geometry,
// element summaries, arrow routing and bound-text layout.
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

export const randId = () => Math.random().toString(36).slice(2, 12);

export function bump(el, props = {}) {
  return {
    ...el,
    ...props,
    version: (el.version || 1) + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now(),
  };
}

export function viewport(appState) {
  const zoom = appState.zoom.value;
  const { scrollX, scrollY, width, height, offsetLeft, offsetTop } = appState;
  return {
    width,
    height,
    offsetLeft,
    offsetTop,
    scrollX,
    scrollY,
    zoom,
    visibleScene: {
      x: -scrollX,
      y: -scrollY,
      width: width / zoom,
      height: height / zoom,
    },
  };
}

// scene -> window-content (CSS px) coordinates
export function sceneToWindow(appState, x, y) {
  const z = appState.zoom.value;
  return {
    x: (x + appState.scrollX) * z + appState.offsetLeft,
    y: (y + appState.scrollY) * z + appState.offsetTop,
  };
}

export function windowToScene(appState, x, y) {
  const z = appState.zoom.value;
  return {
    x: (x - appState.offsetLeft) / z - appState.scrollX,
    y: (y - appState.offsetTop) / z - appState.scrollY,
  };
}

const isLinear = (el) => el.type === "arrow" || el.type === "line" || el.type === "freedraw";

// Axis-aligned bounds in scene coordinates (rotation ignored).
export function bounds(el) {
  if (isLinear(el) && el.points?.length) {
    const xs = el.points.map((p) => p[0]);
    const ys = el.points.map((p) => p[1]);
    const x1 = el.x + Math.min(...xs);
    const y1 = el.y + Math.min(...ys);
    return { x: x1, y: y1, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

export function commonBounds(els) {
  if (!els.length) return null;
  const bs = els.map(bounds);
  const x1 = Math.min(...bs.map((b) => b.x));
  const y1 = Math.min(...bs.map((b) => b.y));
  const x2 = Math.max(...bs.map((b) => b.x + b.width));
  const y2 = Math.max(...bs.map((b) => b.y + b.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

const round = (n) => (typeof n === "number" ? Math.round(n * 100) / 100 : n);

function rect(appState, origin, b) {
  const p = sceneToWindow(appState, b.x, b.y);
  const z = appState.zoom.value;
  const w = { x: round(p.x), y: round(p.y), width: round(b.width * z), height: round(b.height * z) };
  return {
    window: w,
    screen: origin ? { ...w, x: round(origin.x + w.x), y: round(origin.y + w.y) } : undefined,
  };
}

export function summarize(el, map, appState, origin) {
  const b = bounds(el);
  const vp = viewport(appState);
  const vs = vp.visibleScene;
  const s = {
    id: el.id,
    type: el.type,
    x: round(el.x),
    y: round(el.y),
    width: round(el.width),
    height: round(el.height),
    bounds: { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) },
    center: { x: round(b.x + b.width / 2), y: round(b.y + b.height / 2) },
    angle: round(el.angle),
    strokeColor: el.strokeColor,
    backgroundColor: el.backgroundColor,
    fillStyle: el.fillStyle,
    strokeWidth: el.strokeWidth,
    strokeStyle: el.strokeStyle,
    roughness: el.roughness,
    opacity: el.opacity,
    ...rect(appState, origin, b),
    visible: b.x < vs.x + vs.width && b.x + b.width > vs.x && b.y < vs.y + vs.height && b.y + b.height > vs.y,
  };
  if (el.roundness) s.roundness = el.roundness.type;
  if (el.type === "text") {
    Object.assign(s, { text: el.text, fontSize: el.fontSize, fontFamily: el.fontFamily, textAlign: el.textAlign });
    if (el.containerId) s.containerId = el.containerId;
  }
  const label = (el.boundElements || []).find((b) => b.type === "text");
  if (label && map.get(label.id) && !map.get(label.id).isDeleted) {
    s.label = map.get(label.id).text;
    s.labelId = label.id;
  }
  if (isLinear(el)) {
    s.points = el.points.map((p) => [round(p[0]), round(p[1])]);
    if (el.type === "arrow") {
      s.from = el.startBinding?.elementId ?? null;
      s.to = el.endBinding?.elementId ?? null;
      s.startArrowhead = el.startArrowhead;
      s.endArrowhead = el.endArrowhead;
    }
  }
  const arrows = (el.boundElements || []).filter((b) => b.type === "arrow").map((b) => b.id);
  if (arrows.length) s.arrows = arrows;
  if (el.groupIds?.length) s.groupIds = el.groupIds;
  if (el.frameId) s.frameId = el.frameId;
  if (el.locked) s.locked = true;
  if (el.link) s.link = el.link;
  if (el.type === "image") s.fileId = el.fileId;
  if (el.type === "frame") s.name = el.name;
  if (el.customData) s.customData = el.customData;
  return s;
}

// ---------- arrows ----------

function edgePoint(el, toward, gap = 8) {
  const b = bounds(el);
  const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  let dx = toward.x - c.x;
  let dy = toward.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const hw = Math.max(b.width / 2, 1);
  const hh = Math.max(b.height / 2, 1);
  let t;
  if (el.type === "ellipse") t = 1 / Math.sqrt((ux / hw) ** 2 + (uy / hh) ** 2);
  else if (el.type === "diamond") t = 1 / (Math.abs(ux) / hw + Math.abs(uy) / hh);
  else t = Math.min(ux ? hw / Math.abs(ux) : Infinity, uy ? hh / Math.abs(uy) : Infinity);
  return { x: c.x + ux * (t + gap), y: c.y + uy * (t + gap) };
}

const centerOf = (el) => {
  const b = bounds(el);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

// Straight-line route between the bound elements, keeping interior points.
export function routeArrow(arrow, map) {
  const s = arrow.startBinding && map.get(arrow.startBinding.elementId);
  const e = arrow.endBinding && map.get(arrow.endBinding.elementId);
  if (!s && !e) return arrow;
  const pts = arrow.points;
  const absStart = { x: arrow.x + pts[0][0], y: arrow.y + pts[0][1] };
  const absEnd = { x: arrow.x + pts[pts.length - 1][0], y: arrow.y + pts[pts.length - 1][1] };
  const interior = pts.slice(1, -1).map((p) => ({ x: arrow.x + p[0], y: arrow.y + p[1] }));
  const cs = s ? centerOf(s) : absStart;
  const ce = e ? centerOf(e) : absEnd;
  const p1 = s ? edgePoint(s, interior[0] || ce) : absStart;
  const p2 = e ? edgePoint(e, interior[interior.length - 1] || cs) : absEnd;
  const all = [p1, ...interior, p2];
  const points = all.map((p) => [p.x - p1.x, p.y - p1.y]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return bump(arrow, {
    x: p1.x,
    y: p1.y,
    points,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  });
}

export function bindArrow(arrow, fromEl, toEl) {
  return {
    ...arrow,
    startBinding: fromEl ? { elementId: fromEl.id, focus: 0, gap: 8 } : null,
    endBinding: toEl ? { elementId: toEl.id, focus: 0, gap: 8 } : null,
  };
}

export function addBoundRef(el, ref) {
  const list = (el.boundElements || []).filter((b) => b.id !== ref.id);
  return bump(el, { boundElements: [...list, ref] });
}

// ---------- bound text ----------

export function measureText(text, opts = {}) {
  const [t] = convertToExcalidrawElements([{ type: "text", x: 0, y: 0, text, ...opts }]);
  return { width: t.width, height: t.height, text: t.text, originalText: t.originalText, lineHeight: t.lineHeight };
}

export function layoutBoundText(container, text) {
  if (container.type === "arrow" || container.type === "line") {
    const pts = container.points;
    const mid = pts.length % 2 === 1 ? pts[(pts.length - 1) / 2] : [(pts[pts.length / 2 - 1][0] + pts[pts.length / 2][0]) / 2, (pts[pts.length / 2 - 1][1] + pts[pts.length / 2][1]) / 2];
    return bump(text, { x: container.x + mid[0] - text.width / 2, y: container.y + mid[1] - text.height / 2 });
  }
  const c = centerOf(container);
  return bump(text, { x: c.x - text.width / 2, y: c.y - text.height / 2 });
}

// Re-lay-out labels of changed containers and re-route arrows bound to them.
export function relayout(elements, changedIds) {
  const changed = new Set(changedIds);
  let map = new Map(elements.map((e) => [e.id, e]));
  const out = elements.map((el) => {
    if (el.isDeleted || el.type !== "arrow") return el;
    const s = el.startBinding?.elementId;
    const e = el.endBinding?.elementId;
    if (changed.has(el.id) || changed.has(s) || changed.has(e)) {
      changed.add(el.id);
      return routeArrow(el, map);
    }
    return el;
  });
  map = new Map(out.map((e) => [e.id, e]));
  return out.map((el) => {
    if (el.isDeleted || el.type !== "text" || !el.containerId || !changed.has(el.containerId)) return el;
    const c = map.get(el.containerId);
    return c ? layoutBoundText(c, el) : el;
  });
}

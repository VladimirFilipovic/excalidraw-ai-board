import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, getSceneVersion } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import { createCommands } from "./commands.js";
import { CommentLayer, CommentToolbar, useComments } from "./Comments.jsx";

window.EXCALIDRAW_ASSET_PATH = window.location.origin + "/";

const SAVED_APPSTATE = ["viewBackgroundColor", "theme", "gridSize", "gridModeEnabled", "scrollX", "scrollY", "zoom", "currentItemStrokeColor", "currentItemBackgroundColor", "currentItemFillStyle", "currentItemStrokeWidth", "currentItemRoughness", "currentItemFontFamily", "currentItemFontSize"];

function App({ initial }) {
  const [api, setApi] = useState(null);
  const [view, setView] = useState(null);
  const [mode, setMode] = useState(false);
  const [panel, setPanel] = useState(false);
  const [pointer, setPointer] = useState({ down: false, clickAt: null });
  const comments = useComments();
  const saveTimer = useRef(null);
  const raf = useRef(0);
  const downAt = useRef(null);
  const viewKey = useRef("");
  const saveKey = useRef("");

  useEffect(() => {
    if (!api || !window.exd) return;
    window.exd.onCommand(createCommands(api));
    window.exdApi = api;
  }, [api]);

  // Excalidraw fires onChange on every re-render, so only react to real changes.
  const onChange = useCallback((elements, appState, files) => {
    const version = getSceneVersion(elements);
    const sel = Object.keys(appState.selectedElementIds || {}).join(",");
    const busy = [appState.selectionElement, appState.newElement, appState.editingTextElement, appState.selectedElementsAreBeingDragged].map((v) => (v ? 1 : 0)).join("");
    const vk = [version, appState.scrollX, appState.scrollY, appState.zoom.value, appState.width, appState.height, appState.offsetLeft, appState.offsetTop, sel, busy].join("|");
    if (vk !== viewKey.current) {
      viewKey.current = vk;
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => setView({ elements, appState }));
    }
    const st = Object.fromEntries(SAVED_APPSTATE.map((k) => [k, appState[k]]));
    const sk = version + JSON.stringify(st) + Object.keys(files || {}).length;
    if (sk !== saveKey.current) {
      saveKey.current = sk;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => window.exd?.saveScene({ elements, appState: st, files }), 400);
    }
  }, []);

  const renderTopRightUI = useCallback(
    () => <CommentToolbar mode={mode} setMode={setMode} panel={panel} setPanel={setPanel} comments={comments} />,
    [mode, panel, comments],
  );

  // Track clicks on empty canvas (pointer down+up without moving) for point comments.
  const onPointerUpdate = useCallback(({ pointer: p, button }) => {
    if (button === "down" && !downAt.current) {
      downAt.current = { x: p.x, y: p.y };
      setPointer((s) => ({ ...s, down: true }));
    } else if (button === "up" && downAt.current) {
      const d = downAt.current;
      downAt.current = null;
      const click = Math.hypot(p.x - d.x, p.y - d.y) < 4;
      setTimeout(() => setPointer({ down: false, clickAt: click ? { x: p.x, y: p.y, t: Date.now() } : null }), 30);
    }
  }, []);

  return (
    <div className={`exd-root ${mode ? "commenting" : ""}`}>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initial}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        renderTopRightUI={renderTopRightUI}
      />
      {api && <CommentLayer api={api} view={view} comments={comments} mode={mode} setMode={setMode} panel={panel} setPanel={setPanel} pointer={pointer} />}
    </div>
  );
}

(async () => {
  const saved = (await window.exd?.loadScene()) || null;
  const initial = saved ? { elements: saved.elements, appState: saved.appState, files: saved.files, scrollToContent: false } : { appState: { viewBackgroundColor: "#ffffff" } };
  createRoot(document.getElementById("root")).render(<App initial={initial} />);
})();

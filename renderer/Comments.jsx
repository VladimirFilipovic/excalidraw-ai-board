// Comment mode: the user pins comments to elements (or to an empty spot);
// the agent picks them up via `exd wait` / `exd comments` and replies.
import { useEffect, useRef, useState } from "react";
import { commonBounds, sceneToWindow, summarize } from "./scene.js";

const bridge = window.exd?.comments;

function selectedIds(appState) {
  return Object.keys(appState.selectedElementIds || {}).filter((k) => appState.selectedElementIds[k]);
}

function anchorFor(comment, map) {
  const els = comment.elementIds.map((id) => map.get(id)).filter((e) => e && !e.isDeleted);
  const b = commonBounds(els);
  if (b) return { x: b.x + b.width, y: b.y };
  return comment.anchor;
}

function pinState(c) {
  if (c.status === "resolved") return "resolved";
  const last = c.thread[c.thread.length - 1];
  return last?.from === "agent" ? "answered" : "waiting";
}

function Composer({ at, target, onSubmit, onCancel }) {
  const [text, setText] = useState("");
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = () => text.trim() && onSubmit(text.trim());
  return (
    <div className="exd-pop" style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="exd-pop-head">{target}</div>
      <textarea
        ref={ref}
        value={text}
        placeholder="Tell the agent what to change…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="exd-pop-actions">
        <span className="exd-hint">⌘↵ send · Esc cancel</span>
        <button className="exd-btn ghost" onClick={onCancel}>Cancel</button>
        <button className="exd-btn primary" disabled={!text.trim()} onClick={submit}>Send to agent</button>
      </div>
    </div>
  );
}

function Thread({ c, at, onClose, api }) {
  const [text, setText] = useState("");
  const send = async () => {
    if (!text.trim()) return;
    await bridge.reply(c.id, text.trim());
    setText("");
  };
  return (
    <div className="exd-pop" style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="exd-pop-head">
        <span className={`exd-dot ${pinState(c)}`} />#{c.n} · {c.elementIds.length ? `${c.elementIds.length} element(s)` : "canvas point"}
        <button className="exd-x" onClick={onClose}>×</button>
      </div>
      <div className="exd-thread">
        {c.thread.map((m, i) => (
          <div key={i} className={`exd-msg ${m.from}`}>
            <b>{m.from === "user" ? "You" : "Agent"}</b>
            <span>{m.text}</span>
          </div>
        ))}
        {pinState(c) === "waiting" && <div className="exd-msg waiting">waiting for agent…</div>}
      </div>
      <textarea
        value={text}
        placeholder="Reply…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          if (e.key === "Escape") onClose();
        }}
      />
      <div className="exd-pop-actions">
        <button className="exd-btn ghost danger" onClick={() => bridge.remove(c.id).then(onClose)}>Delete</button>
        {c.elementIds.length > 0 && (
          <button className="exd-btn ghost" onClick={() => api.updateScene({ appState: { selectedElementIds: Object.fromEntries(c.elementIds.map((i) => [i, true])) } })}>
            Select
          </button>
        )}
        <button className="exd-btn ghost" onClick={() => bridge.resolve(c.id, c.status !== "resolved")}>
          {c.status === "resolved" ? "Reopen" : "Resolve"}
        </button>
        <button className="exd-btn primary" disabled={!text.trim()} onClick={send}>Reply</button>
      </div>
    </div>
  );
}

export function useComments() {
  const [comments, setComments] = useState([]);
  useEffect(() => {
    if (!bridge) return;
    bridge.list().then(setComments);
    bridge.onChange(setComments);
  }, []);
  return comments;
}

export function CommentToolbar({ mode, setMode, panel, setPanel, comments }) {
  const waiting = comments.filter((c) => pinState(c) === "waiting").length;
  const answered = comments.filter((c) => pinState(c) === "answered").length;
  return (
    <div className="exd-toolbar">
      <button className={`exd-btn ${mode ? "primary" : ""}`} title="Comment mode (click an element or empty spot to comment)" onClick={() => setMode(!mode)}>
        💬 {mode ? "Commenting" : "Comment"}
      </button>
      <button className={`exd-btn ${panel ? "active" : ""}`} onClick={() => setPanel(!panel)} title="All comment threads">
        Threads
        {waiting > 0 && <span className="exd-badge waiting">{waiting}</span>}
        {answered > 0 && <span className="exd-badge answered">{answered}</span>}
      </button>
    </div>
  );
}

// Overlay with pins, composer and thread popovers. `view` is the latest
// {elements, appState} snapshot from Excalidraw's onChange.
export function CommentLayer({ api, view, comments, mode, setMode, panel, setPanel, pointer }) {
  const [composer, setComposer] = useState(null);
  const [open, setOpen] = useState(null);
  const lastSel = useRef("");

  const appState = view?.appState;
  const elements = view?.elements || [];
  const map = new Map(elements.map((e) => [e.id, e]));

  // In comment mode, a finished selection or a click on empty canvas opens the composer.
  useEffect(() => {
    if (!mode || !appState || composer) return;
    const ids = selectedIds(appState).filter((id) => map.get(id) && !map.get(id).containerId);
    const key = ids.join(",");
    const busy = appState.selectionElement || appState.newElement || appState.editingTextElement || appState.selectedElementsAreBeingDragged;
    if (busy || pointer.down) return;
    if (ids.length && key !== lastSel.current) {
      lastSel.current = key;
      const b = commonBounds(ids.map((i) => map.get(i)));
      setOpen(null);
      setComposer({ elementIds: ids, anchor: { x: b.x + b.width, y: b.y } });
    } else if (!ids.length) {
      lastSel.current = "";
    }
  });

  useEffect(() => {
    if (!mode || !pointer.clickAt || composer) return;
    if (selectedIds(api.getAppState()).length) return;
    setOpen(null);
    setComposer({ elementIds: [], anchor: pointer.clickAt });
  }, [pointer.clickAt]);

  useEffect(() => {
    if (!mode) setComposer(null);
  }, [mode]);

  if (!appState) return null;
  const toWin = (p) => sceneToWindow(appState, p.x, p.y);
  const clampPop = (p) => ({ x: Math.min(p.x + 14, window.innerWidth - 340), y: Math.max(8, Math.min(p.y, window.innerHeight - 320)) });

  const submit = async (text) => {
    const snapshot = composer.elementIds.map((id) => map.get(id)).filter(Boolean).map((e) => summarize(e, map, appState));
    const c = await bridge.add({ text, elementIds: composer.elementIds, anchor: composer.anchor, snapshot });
    setComposer(null);
    setOpen(c.id);
  };

  const openComment = comments.find((c) => c.id === open);
  const visible = comments.filter((c) => c.status !== "resolved" || c.id === open);

  return (
    <>
      <div className="exd-layer">
        {visible.map((c) => {
          const a = anchorFor(c, map);
          if (!a) return null;
          const p = toWin(a);
          return (
            <button
              key={c.id}
              className={`exd-pin ${pinState(c)} ${open === c.id ? "open" : ""}`}
              style={{ left: p.x - 4, top: p.y - 26 }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                setComposer(null);
                setOpen(open === c.id ? null : c.id);
              }}
              title={c.thread[0]?.text}
            >
              {c.n}
            </button>
          );
        })}
        {composer && (
          <>
            {composer.elementIds.length === 0 && <div className="exd-point" style={{ left: toWin(composer.anchor).x - 6, top: toWin(composer.anchor).y - 6 }} />}
            <Composer
              at={clampPop(toWin(composer.anchor))}
              target={composer.elementIds.length ? `Comment on ${composer.elementIds.length} element(s)` : "Comment on this spot"}
              onSubmit={submit}
              onCancel={() => setComposer(null)}
            />
          </>
        )}
        {openComment && !composer && (
          <Thread c={openComment} api={api} at={clampPop(toWin(anchorFor(openComment, map) || { x: 0, y: 0 }))} onClose={() => setOpen(null)} />
        )}
        {!composer && mode && selectedIds(appState).length === 0 && (
          <div className="exd-mode-hint">Comment mode — select element(s) or click an empty spot · <button onClick={() => setMode(false)}>exit</button></div>
        )}
      </div>
      {panel && (
        <aside className="exd-panel" onPointerDown={(e) => e.stopPropagation()}>
          <div className="exd-panel-head">
            Threads <button className="exd-x" onClick={() => setPanel(false)}>×</button>
          </div>
          {comments.length === 0 && <p className="exd-empty">No comments yet. Turn on 💬 Comment and select something.</p>}
          {[...comments].reverse().map((c) => (
            <button
              key={c.id}
              className={`exd-row ${open === c.id ? "open" : ""}`}
              onClick={() => {
                setComposer(null);
                setOpen(c.id);
                const els = c.elementIds.map((i) => map.get(i)).filter((e) => e && !e.isDeleted);
                if (els.length) api.scrollToContent(els, { animate: true });
              }}
            >
              <span className={`exd-dot ${pinState(c)}`} />
              <span className="exd-row-n">#{c.n}</span>
              <span className="exd-row-text">{c.thread[0]?.text}</span>
              <span className="exd-row-meta">{c.thread.length > 1 ? `${c.thread.length} msgs · ` : ""}{pinState(c)}</span>
            </button>
          ))}
        </aside>
      )}
    </>
  );
}

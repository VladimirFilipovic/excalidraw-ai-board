# exd — local Excalidraw + JSON CLI for agents

Electron window running Excalidraw 0.18, plus a localhost HTTP API (`127.0.0.1:7788`) that the `exd` CLI talks to. Every command prints one JSON line.

```bash
npm install && npm run build && npm link   # once
exd start                                   # open the app
exd rect --id api --label "API" --bg "#a5d8ff" --fill solid
exd ellipse --id db --x 400 --label "Postgres"
exd connect api db --label SQL
exd state --visible                         # geometry: scene, window and screen coords
exd screenshot view.png
exd help                                    # full command list
```

## Comments (user → agent)

In the app: **💬 Comment** turns on comment mode. Select element(s), or click an empty spot, write a request, and press ⌘↵. Pins show state: orange = waiting for the agent, violet = agent replied, grey = resolved. **Threads** lists every thread.

Agent side:

```bash
exd wait --timeout 1800      # blocks until the user posts something new
exd comments                 # open threads with current element state
exd reply c3 "Renamed to Gateway" --resolve
```

## Layout

| Path | What |
|---|---|
| `electron/main.cjs` | window, HTTP API, comment store, input/screenshot commands |
| `electron/preload.cjs` | IPC bridge exposed as `window.exd` |
| `renderer/commands.js` | scene commands run against the Excalidraw API |
| `renderer/scene.js` | geometry, element summaries, arrow routing, label layout |
| `renderer/Comments.jsx` | comment mode UI |
| `bin/exd.mjs` | CLI |

The scene and comments persist in `~/Library/Application Support/exd/` (`scene.json`, `comments.json`). Set `EXD_PORT` to change the port. The API rejects requests that carry a browser `Origin` or a foreign `Host`, so web pages can't drive it.

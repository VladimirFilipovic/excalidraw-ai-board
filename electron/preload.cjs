const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("exd", {
  onCommand: (handler) =>
    ipcRenderer.on("cmd", async (_e, { id, cmd, args }) => {
      try {
        const result = await handler(cmd, args);
        ipcRenderer.send("cmd-result", { id, ok: true, result });
      } catch (err) {
        ipcRenderer.send("cmd-result", { id, ok: false, error: String(err?.message || err) });
      }
    }),
  loadScene: () => ipcRenderer.invoke("scene:load"),
  saveScene: (scene) => ipcRenderer.send("scene:save", scene),
  comments: {
    list: () => ipcRenderer.invoke("comments:list"),
    add: (data) => ipcRenderer.invoke("comment:add", data),
    reply: (id, text) => ipcRenderer.invoke("comment:reply", { id, text }),
    resolve: (id, resolved) => ipcRenderer.invoke("comment:resolve", { id, resolved }),
    remove: (id) => ipcRenderer.invoke("comment:delete", { id }),
    onChange: (fn) => ipcRenderer.on("comments:changed", (_e, list) => fn(list)),
  },
});

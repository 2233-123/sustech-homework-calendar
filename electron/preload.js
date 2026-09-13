// 作业日程 — preload：向页面暴露窗口能力
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hwShell", {
  setAlwaysOnTop: (value) => ipcRenderer.invoke("shell:set-always-on-top", value),
  setOpacity: (value) => ipcRenderer.invoke("shell:set-opacity", value),
  setAutostart: (value) => ipcRenderer.invoke("shell:set-autostart", value),
  getAutostart: () => ipcRenderer.invoke("shell:get-autostart"),
  notify: (title, body) => ipcRenderer.invoke("shell:notify", { title, body }),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  setWindowScale: (p) => ipcRenderer.invoke("shell:set-window-scale", p),
  hideToEdge: () => ipcRenderer.invoke("shell:hide-to-edge"),
});

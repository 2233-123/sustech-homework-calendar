// 作业日程 — preload：向页面暴露窗口能力
//
// 仅暴露必要能力（contextIsolation:true、nodeIntegration:false）：
//   setAlwaysOnTop/setOpacity/setAutostart/getAutostart/notify
//   openExternal（仅 BB 域名，主进程校验）/ setWindowScale / fitHeight
//   getWindowInfo / nudgeWindow / hideToEdge
// 约定：几何与窗口行为一律由主进程落地，渲染层只传意图与内容高度。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hwShell", {
  setAlwaysOnTop: (value) => ipcRenderer.invoke("shell:set-always-on-top", value),
  setOpacity: (value) => ipcRenderer.invoke("shell:set-opacity", value),
  setAutostart: (value) => ipcRenderer.invoke("shell:set-autostart", value),
  getAutostart: () => ipcRenderer.invoke("shell:get-autostart"),
  notify: (title, body) => ipcRenderer.invoke("shell:notify", { title, body }),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  setWindowScale: (p) => ipcRenderer.invoke("shell:set-window-scale", p),
  fitHeight: (h) => ipcRenderer.invoke("shell:fit-height", h),
  getWindowInfo: () => ipcRenderer.invoke("shell:get-window-info"),
  nudgeWindow: (dx, dy) => ipcRenderer.invoke("shell:nudge-window", { dx, dy }),
  hideToEdge: () => ipcRenderer.invoke("shell:hide-to-edge"),
});

// 作业日程 — Electron 外壳主进程
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, dialog, shell, screen } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const BACKEND_READY_TIMEOUT_MS = 120000;
const WINDOW_WIDTH = 408;
const WINDOW_HEIGHT = 760;
const SCALE_MIN = 40;
const SCALE_MAX = 150;
const MIN_ZOOM = 0.7;

let backendProc = null;
let mainWindow = null;
let tray = null;
let backendPort = 0;
let quitting = false;
let posTimer = null;
let edgeTab = null;
let preCollapseBounds = null;
let scaleCurrent = 100;
let scaleTarget = 100;
let scaleTimer = null;
const EDGE_TAB_W = 16;
const EDGE_TAB_H = 120;

function debounce(fn, ms) {
  return (...args) => {
    clearTimeout(posTimer);
    posTimer = setTimeout(() => fn(...args), ms);
  };
}

function repoRoot() {
  return path.resolve(__dirname, "..");
}

function clampScale(v) {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(Number(v) || 100)));
}

function scaledSize(scale, workArea) {
  const p = clampScale(scale);
  let w = Math.round((WINDOW_WIDTH * p) / 100);
  let h = Math.round((WINDOW_HEIGHT * p) / 100);
  const f = Math.min(1, workArea.width / w, workArea.height / h);
  return { width: Math.round(w * f), height: Math.round(h * f) };
}

function clampBoundsToWorkArea(bounds, wa) {
  const width = Math.min(bounds.width, wa.width);
  const height = Math.min(bounds.height, wa.height);
  const x = Math.min(Math.max(bounds.x, wa.x), wa.x + wa.width - width);
  const y = Math.min(Math.max(bounds.y, wa.y), wa.y + wa.height - height);
  return { x, y, width, height };
}

// 平滑缩放：把 currentScale 逐帧逼近 targetScale，每帧同步落地内容尺寸与 zoom。
function applyScaleFrame(s) {
  if (!mainWindow) return;
  const wa = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  const { width, height } = scaledSize(s, wa);
  const zoom = Math.max(s / 100, MIN_ZOOM);
  mainWindow.setContentSize(width, height);
  mainWindow.webContents.setZoomFactor(zoom);
  const b = mainWindow.getBounds();
  const c = clampBoundsToWorkArea(b, wa);
  if (c.x !== b.x || c.y !== b.y) {
    mainWindow.setPosition(c.x, c.y);
    saveWindowPos();
  }
}

function stopScaleAnim() {
  if (scaleTimer) {
    clearInterval(scaleTimer);
    scaleTimer = null;
  }
}

function startScaleAnim() {
  if (scaleTimer) return;
  scaleTimer = setInterval(() => {
    if (!mainWindow) {
      stopScaleAnim();
      return;
    }
    const d = scaleTarget - scaleCurrent;
    if (Math.abs(d) < 0.5) {
      scaleCurrent = scaleTarget;
      applyScaleFrame(scaleCurrent);
      stopScaleAnim();
      return;
    }
    scaleCurrent += d * 0.35;
    applyScaleFrame(scaleCurrent);
  }, 16);
}

function backendCommand() {
  const packagedExe = path.join(process.resourcesPath || "", "backend", "backend.exe");
  if (process.resourcesPath && fs.existsSync(packagedExe)) {
    return { cmd: packagedExe, args: [], cwd: path.dirname(packagedExe) };
  }
  const venvPy = path.join(repoRoot(), ".venv", "Scripts", "python.exe");
  const python = fs.existsSync(venvPy) ? venvPy : "python";
  return { cmd: python, args: ["-m", "backend.main"], cwd: repoRoot() };
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const { cmd, args, cwd } = backendCommand();
    backendProc = spawn(cmd, args, { cwd, windowsHide: true });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("后端启动超时（120s 内未收到 PORT=）"));
      }
    }, BACKEND_READY_TIMEOUT_MS);
    backendProc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/PORT=(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    backendProc.stderr.on("data", (chunk) => {
      process.stderr.write(`[backend] ${chunk}`);
    });
    backendProc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    backendProc.on("exit", (code) => {
      backendProc = null;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`后端进程提前退出（code=${code}）`));
      } else if (!quitting) {
        console.error(`[shell] 后端进程意外退出（code=${code}）`);
        if (Notification.isSupported()) {
          new Notification({ title: "作业日程", body: "后端进程已退出，数据可能停止刷新；请重启应用。" }).show();
        }
      }
    });
  });
}

async function fetchJson(port, apiPath, method = "GET") {
  const resp = await fetch(`http://127.0.0.1:${port}${apiPath}`, { method });
  return resp.json();
}

async function loadWindowPrefs(port) {
  try {
    const cfg = await fetchJson(port, "/api/settings");
    return {
      alwaysOnTop: cfg.always_on_top !== false,
      opacity: typeof cfg.opacity === "number" ? Math.min(1, Math.max(0.3, cfg.opacity)) : 0.95,
      windowPos:
        Array.isArray(cfg.window_pos) &&
        cfg.window_pos.length === 2 &&
        cfg.window_pos.every(Number.isFinite)
          ? cfg.window_pos
          : null,
      windowScale: clampScale(cfg.window_scale),
    };
  } catch {
    return { alwaysOnTop: true, opacity: 0.95, windowPos: null, windowScale: 100 };
  }
}

async function saveWindowPos() {
  if (!mainWindow || !backendPort) return;
  const [x, y] = mainWindow.getPosition();
  try {
    await fetch(`http://127.0.0.1:${backendPort}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ window_pos: [x, y] }),
    });
  } catch {
    /* 位置记忆非关键路径，忽略失败 */
  }
}

function createWindow(port, prefs) {
  const hasPos = Array.isArray(prefs.windowPos) && prefs.windowPos.every(Number.isFinite);
  const disp = hasPos
    ? screen.getDisplayNearestPoint({ x: prefs.windowPos[0], y: prefs.windowPos[1] })
    : screen.getPrimaryDisplay();
  const wa = disp.workArea;
  const size = scaledSize(prefs.windowScale, wa);
  const bounds = hasPos
    ? clampBoundsToWorkArea(
        { x: prefs.windowPos[0], y: prefs.windowPos[1], width: size.width, height: size.height },
        wa
      )
    : {
        x: wa.x + Math.round((wa.width - size.width) / 2),
        y: wa.y + Math.round((wa.height - size.height) / 2),
        width: size.width,
        height: size.height,
      };
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: prefs.alwaysOnTop,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      zoomFactor: Math.max(prefs.windowScale / 100, MIN_ZOOM), // 最小字号下限；视口 = 内容/zoom
    },
  });
  scaleCurrent = clampScale(prefs.windowScale);
  scaleTarget = scaleCurrent;
  mainWindow.setOpacity(prefs.opacity);
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("moved", debounce(saveWindowPos, 500));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function toggleWindow() {
  if (!mainWindow) return;
  if (edgeTab) {
    restoreFromEdge();
    return;
  }
  if (mainWindow.isVisible()) mainWindow.hide();
  else mainWindow.show();
}

function hideToEdge() {
  if (!mainWindow || !mainWindow.isVisible() || edgeTab) return false;
  stopScaleAnim(); // 收起前让平滑循环落定，避免隐藏时仍在改尺寸
  scaleCurrent = scaleTarget;
  applyScaleFrame(scaleCurrent);
  preCollapseBounds = mainWindow.getContentBounds();
  const wa = screen.getDisplayMatching(preCollapseBounds).workArea;
  const y = Math.min(
    Math.max(preCollapseBounds.y + Math.round((preCollapseBounds.height - EDGE_TAB_H) / 2), wa.y),
    wa.y + wa.height - EDGE_TAB_H
  );
  edgeTab = new BrowserWindow({
    width: EDGE_TAB_W,
    height: EDGE_TAB_H,
    x: wa.x + wa.width - EDGE_TAB_W,
    y,
    type: "toolbar",
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // Windows 对 frameless 窗口有最小宽度约束（本机实测约 20–34 DIP，视窗口类型而定）；仅 type:"toolbar" + 构造后 setBounds 可稳定达 16
  edgeTab.setBounds({ x: wa.x + wa.width - EDGE_TAB_W, y, width: EDGE_TAB_W, height: EDGE_TAB_H });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:transparent;overflow:hidden;}
    .bar{position:absolute;inset:0;border-radius:8px 0 0 8px;background:rgba(37,99,235,.55);box-shadow:0 0 6px rgba(0,0,0,.25);transition:background .12s;}
    body:hover .bar{background:rgba(37,99,235,.9);}
  </style></head><body><div class="bar" title="点击展开"></div></body></html>`;
  edgeTab.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  edgeTab.once("ready-to-show", () => {
    if (edgeTab) edgeTab.showInactive();
  });
  edgeTab.on("focus", restoreFromEdge);
  edgeTab.on("closed", () => {
    edgeTab = null;
  });
  mainWindow.hide();
  return true;
}

function restoreFromEdge() {
  if (edgeTab) {
    const tab = edgeTab;
    edgeTab = null;
    try {
      tab.destroy();
    } catch {
      /* 已销毁则忽略 */
    }
  }
  if (mainWindow) {
    const b = preCollapseBounds;
    preCollapseBounds = null;
    if (b) mainWindow.setContentBounds(clampBoundsToWorkArea(b, screen.getDisplayMatching(b).workArea));
    mainWindow.show();
    mainWindow.focus();
  }
  return true;
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "tray.png"));
  tray = new Tray(icon);
  tray.setToolTip("作业日程");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 / 隐藏", click: toggleWindow },
      {
        label: "立即同步",
        click: () => {
          if (backendPort) {
            fetch(`http://127.0.0.1:${backendPort}/api/sync`, { method: "POST" }).catch(() => {});
          }
        },
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ])
  );
  tray.on("click", toggleWindow);
}

function registerIpc() {
  ipcMain.handle("shell:set-always-on-top", (_e, value) => {
    if (mainWindow) mainWindow.setAlwaysOnTop(!!value);
  });
  ipcMain.handle("shell:set-opacity", (_e, value) => {
    const v = Math.min(1, Math.max(0.3, Number(value) || 0.95));
    if (mainWindow) mainWindow.setOpacity(v);
  });
  ipcMain.handle("shell:set-autostart", (_e, value) => {
    app.setLoginItemSettings({
      openAtLogin: !!value,
      args: app.isPackaged ? [] : [app.getAppPath()],
    });
  });
  ipcMain.handle("shell:get-autostart", () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle("shell:notify", (_e, { title, body }) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  });
  ipcMain.handle("shell:open-external", (_e, url) => {
    const u = String(url || "");
    if (!/^https:\/\/bb\.sustech\.edu\.cn\//.test(u)) return false; // 仅允许 BB 域名
    return shell.openExternal(u).then(() => true, () => false);
  });
  ipcMain.handle("shell:hide-to-edge", () => hideToEdge());
  ipcMain.handle("shell:set-window-scale", (_e, p) => {
    if (!mainWindow) return { ok: false };
    const scale = clampScale(p);
    scaleTarget = scale; // 设定目标，由平滑循环逼近
    startScaleAnim();
    const wa = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
    const { width, height } = scaledSize(scale, wa);
    return { ok: true, scale, width, height };
  });
  ipcMain.handle("shell:get-window-info", () => {
    if (!mainWindow) return null;
    const b = mainWindow.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  ipcMain.handle("shell:nudge-window", (_e, d) => {
    if (!mainWindow) return { ok: false };
    const dx = Number(d && d.dx) || 0;
    const dy = Number(d && d.dy) || 0;
    const wa = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
    const b = mainWindow.getBounds();
    const c = clampBoundsToWorkArea({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height }, wa);
    mainWindow.setPosition(c.x, c.y);
    return { ok: true, x: c.x, y: c.y };
  });
}

function stopBackend() {
  const proc = backendProc;
  if (!proc) return;
  const pid = proc.pid;
  try {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    killer.on("error", () => {
      try {
        proc.kill();
      } catch {
        /* 忽略 */
      }
    });
  } catch {
    try {
      proc.kill();
    } catch {
      /* 忽略 */
    }
  }
  backendProc = null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (edgeTab) {
      restoreFromEdge();
      return;
    }
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpc();
    createTray();
    try {
      const port = await startBackend();
      backendPort = port;
      console.log(`[shell] backend ready on port ${port}`);
      const prefs = await loadWindowPrefs(port);
      createWindow(port, prefs);
      if (process.argv.includes("--smoke-quit")) {
        setTimeout(() => app.quit(), 3000);
      }
    } catch (err) {
      console.error(`[shell] 后端启动失败：${err.message}`);
      dialog.showErrorBox("作业日程", `后端启动失败：${err.message}`);
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    // 托盘常驻：不在此退出；仅托盘「退出」或系统退出走清理
  });

  app.on("before-quit", () => {
    quitting = true;
    stopBackend();
  });
}

// 作业日程 — Electron 外壳主进程
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const BACKEND_READY_TIMEOUT_MS = 120000;
const WINDOW_WIDTH = 408;
const WINDOW_HEIGHT = 760;

let backendProc = null;
let mainWindow = null;
let tray = null;
let backendPort = 0;
let quitting = false;
let posTimer = null;

function debounce(fn, ms) {
  return (...args) => {
    clearTimeout(posTimer);
    posTimer = setTimeout(() => fn(...args), ms);
  };
}

function repoRoot() {
  return path.resolve(__dirname, "..");
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
    };
  } catch {
    return { alwaysOnTop: true, opacity: 0.95, windowPos: null };
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
  const [x, y] = prefs.windowPos || [undefined, undefined];
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
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
    },
  });
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
  if (mainWindow.isVisible()) mainWindow.hide();
  else mainWindow.show();
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

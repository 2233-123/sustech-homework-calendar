# 作业日程小组件 — Electron 外壳与打包实施计划（阶段 4/4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已验证的前后端变成一个可双击运行的 Windows 桌面小组件：Electron 无边框透明置顶窗口 + 系统托盘 + 子进程管理（解析 `PORT=`）+ 设置面板窗口类选项接线 + PyInstaller/electron-builder 打包。

**Architecture:** `electron/` 目录独立成 npm 项目（CJS 主进程）；开发态 spawn `.venv\Scripts\python -m backend.main`，打包态 spawn 随附的 `backend.exe`；窗口加载 `http://127.0.0.1:<PORT>/`（绝不用 file://）。前端通过 `preload.js` 暴露的 `window.hwShell` 调用窗口能力（置顶/透明度/自启/退出）。

**Tech Stack:** Electron（最新稳定版，npm 安装时解析）、electron-builder（NSIS + 便携版）、PyInstaller（后端单文件 exe）、Node v24。

**参考文档:** 设计案 `docs/superpowers/specs/2026-09-12-作业日程小组件-design.md`（§6.6、§9、§11）；阶段 3 终审的 Phase-4 要点见本计划 §0.2。

---

## 0. 执行环境与约定

- 仓库根目录：`E:\Desktop\作业日程`；当前分支 `feature/shell`（已创建）。
- Node v24 + npm 11 已就绪；`npm i` 在 `electron/` 目录内执行。
- Python：`.\.venv\Scripts\python`；后端测试基线 **118 passed**；前端 node 基线 **19 passed**。
- 网络：npm/electron 下载约 100–200MB，首次安装较慢；PyInstaller 经 pip 安装。
- 每个 Task 一个 commit（用户已授权）；不触碰 `docs\`、`.omo\`。
- Windows 环境；无显示限制（本机可真实启动 GUI 应用）。

## 0.1 本阶段并入的前端打磨项（阶段 3 终审移交）

| 项 | 落入 |
|---|---|
| 同步进度反馈（按钮禁用 + 「同步中…」） | Task 1 |
| 表单缺失 全天(`all_day`)/颜色(`color`) 字段 + 列表渲染 | Task 1 |
| 设置面板窗口类选项（置顶/透明度/自启/提醒形式）+ 窗口位置记忆 | Task 3 |

## 0.2 必须遵守的 Phase-4 契约（来自阶段 3 终审）

1. **`PORT=` 等待要宽裕**：后端在静默登录（可能 30s×2 超时）与首次同步之后才打印 `PORT=`；壳必须加载中等待（上限 120s），不得用短超时。
2. **窗口参数**：`frame:false, transparent:true, skipTaskbar:true, maximizable:false, resizable:false, useContentSize:true`（约 408×760）；`alwaysOnTop`/`opacity` 从 `/api/settings` 应用。
3. **加载 URL**：`http://127.0.0.1:<port>/`；`contextIsolation:true, nodeIntegration:false` + preload。
4. **透明玻璃说明**：Chromium 无法对桌面做 backdrop blur，「毛玻璃」呈半透明效果；如需真亚克力可用 `backgroundMaterial:'acrylic'`（与 `transparent:true` 互斥，保持现状即可，视觉 QA 预期相应调整）。
5. **退出清理**：无优雅停机端点——退出时杀子进程（`taskkill /T` 或 `child.kill()` + 兜底）；`window-all-closed` 不退出（托盘常驻），仅托盘「退出」或 `before-quit` 走清理。
6. **打包**：`frontend/tests/`、`frontend/package.json` 不进安装包；PyInstaller 产物随 `extraResources` 置于 `resources/backend/backend.exe`。

## 0.3 文件结构（阶段完成后）

```
packaging/
└── backend_entry.py        PyInstaller 入口（调用 backend.main.main）
electron/
├── package.json            壳项目（main/build 配置）
├── main.js                 主进程：窗口/托盘/子进程/PORT 解析/IPC/自启/位置记忆
├── preload.js              contextBridge：hwShell API
├── make-tray-icon.js       生成 tray.png（zlib 手写 PNG，一次运行后提交产物）
├── tray.png                （生成物，提交）
└── resources/
    └── backend/backend.exe （PyInstaller 产物；打包时随 extraResources）
```

**测试基线**：后端 118 + 前端 19 全程不变；本阶段验证以「真实启动 Electron 应用」为主（Task 5 控制者执行）。

---

### Task 1: 前端打磨 — 同步进度反馈 + 全天/颜色字段

**Files:**
- Modify: `frontend/index.html`（表单增加全天与颜色）
- Modify: `frontend/app.js`（doSync 反馈；表单读写与列表渲染）

- [ ] **Step 1: `index.html` — 在「开始时间」字段之前插入全天开关，在「提醒」字段之后插入颜色选择**

在 `<label class="field">开始时间 …</label>` 之前插入：

```html
          <label class="check">
            <input id="f-all-day" type="checkbox" />
            全天
          </label>
```

在「提醒」字段的 `</label>` 之后插入：

```html
          <label class="field">颜色
            <select id="f-color">
              <option value="">默认</option>
              <option value="#2563eb">蓝</option>
              <option value="#16a34a">绿</option>
              <option value="#ea580c">橙</option>
              <option value="#dc2626">红</option>
              <option value="#7c3aed">紫</option>
            </select>
          </label>
```

- [ ] **Step 2: `app.js` — `doSync` 增加进度反馈**

整体替换 `doSync`：

```js
async function doSync() {
  $("btn-sync").disabled = true;
  setStatus("同步中…");
  let failure = null;
  try {
    await api.sync();
  } catch (err) {
    if (err.code !== "busy") failure = err;
  }
  await refreshState();
  await loadMonth();
  await loadDay();
  $("btn-sync").disabled = false;
  if (failure) setStatus(`同步失败：${failure.message}`);
}
```

- [ ] **Step 3: `app.js` — 表单读写全天/颜色**

`openScheduleForm` 中，在设置 `$("f-title").value` 一行之后插入：

```js
  $("f-all-day").checked = !!(item && item.all_day);
  $("f-color").value = item && item.color ? item.color : "";
```

`submitSchedule` 的 `payload` 对象内部（`note` 行之前）插入：

```js
    all_day: $("f-all-day").checked ? 1 : 0,
    color: $("f-color").value || null,
```

- [ ] **Step 4: `app.js` — 列表渲染全天与颜色**

`renderDay` 中，在 `li.append(time, title);` 之前，将时间格内容的设置替换为：

```js
    if (row.kind === "schedule" && row.item.all_day) {
      time.textContent = "全天";
    } else {
      time.textContent = formatTime(row.at);
    }
```

并在 `li.append(time, title);` 之前（时间/标题就绪后）插入颜色条：

```js
    if (row.item.color) {
      li.style.borderLeft = `3px solid ${row.item.color}`;
      li.style.paddingLeft = "6px";
    }
```

- [ ] **Step 5: 验证**

```powershell
node --test "frontend/tests/**/*.test.js"   # 预期 19 passed（纯逻辑无回归）
node --check frontend/app.js                 # 语法通过
.\.venv\Scripts\python -m pytest             # 预期 118 passed
```

浏览器行为（表单字段与渲染）在 Task 5 的端到端验收中核对。

- [ ] **Step 6: 提交**

```powershell
git add frontend/index.html frontend/app.js
git commit -m "feat(fe): 同步进度反馈与全天/颜色字段"
```

---

### Task 2: Electron 骨架 — 无边框窗口 / 子进程 / 托盘

**Files:**
- Create: `electron/main.js`
- Create: `electron/preload.js`
- Create: `electron/make-tray-icon.js`
- Create: `electron/package.json`（npm 安装后定稿）
- Create（生成物）: `electron/tray.png`, `electron/icon.png`

- [ ] **Step 1: 初始化壳项目并安装依赖**

```powershell
New-Item -ItemType Directory -Force -Path electron | Out-Null
Set-Location electron
npm init -y | Out-Null
npm i --save-dev electron electron-builder
```
（electron 二进制约 100MB，首次安装较慢；完成后记录 npm 解析出的版本号。）

- [ ] **Step 2: 定稿 `electron/package.json`**

用下面结构重写（`devDependencies` 保留 npm 刚安装的版本号）：

```json
{
  "name": "hw-calendar-shell",
  "private": true,
  "version": "0.1.0",
  "description": "作业日程桌面小组件外壳",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder --win nsis portable"
  },
  "build": {
    "appId": "com.hwcal.shell",
    "productName": "作业日程",
    "files": ["main.js", "preload.js", "tray.png"],
    "extraResources": [{ "from": "resources/backend", "to": "backend" }],
    "win": { "target": ["nsis", "portable"], "icon": "icon.png" }
  },
  "devDependencies": {
    "electron": "<npm 安装的版本>",
    "electron-builder": "<npm 安装的版本>"
  }
}
```

- [ ] **Step 3: 写 `electron/make-tray-icon.js` 并生成图标**

```js
// 生成 electron/tray.png (32×32) 与 electron/icon.png (256×256)
// 纯 Node 内置模块手写 PNG（无第三方依赖）。
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(size) {
  const bg = [37, 99, 235];
  const fg = [255, 255, 255];
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size / 4;
  const cx = size / 2;
  const cy = size / 2;
  const dotR = size / 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const off = y * (size * 4 + 1) + 1 + x * 4;
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      let alpha = 255;
      if (dx < radius && dy < radius) {
        const d = Math.hypot(radius - dx, radius - dy);
        if (d > radius) alpha = 0;
      }
      const inDot = Math.hypot(x - cx, y - cy) <= dotR;
      const [r, g, b] = inDot ? fg : bg;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.writeFileSync(path.join(__dirname, "tray.png"), makePng(32));
fs.writeFileSync(path.join(__dirname, "icon.png"), makePng(256));
console.log("written tray.png (32) and icon.png (256)");
```

运行：

```powershell
node electron/make-tray-icon.js
```
Expected: `written tray.png (32) and icon.png (256)`；两个文件存在且 > 0 字节。

- [ ] **Step 4: 写 `electron/preload.js`**

```js
// 作业日程 — preload：向页面暴露窗口能力
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hwShell", {
  setAlwaysOnTop: (value) => ipcRenderer.invoke("shell:set-always-on-top", value),
  setOpacity: (value) => ipcRenderer.invoke("shell:set-opacity", value),
  setAutostart: (value) => ipcRenderer.invoke("shell:set-autostart", value),
  getAutostart: () => ipcRenderer.invoke("shell:get-autostart"),
  notify: (title, body) => ipcRenderer.invoke("shell:notify", { title, body }),
});
```

- [ ] **Step 5: 写 `electron/main.js`**

```js
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
      opacity: typeof cfg.opacity === "number" ? cfg.opacity : 0.95,
      windowPos: Array.isArray(cfg.window_pos) ? cfg.window_pos : null,
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
    app.setLoginItemSettings({ openAtLogin: !!value });
  });
  ipcMain.handle("shell:get-autostart", () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle("shell:notify", (_e, { title, body }) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  });
}

function stopBackend() {
  if (!backendProc) return;
  const pid = backendProc.pid;
  try {
    // 结束整个进程树（Python 进程可能派生其它进程）
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } catch {
    backendProc.kill();
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
```

- [ ] **Step 6: 开发态冒烟（真实启动应用）**

```powershell
$out = "$env:TEMP\hw_shell_out.txt"
$errf = "$env:TEMP\hw_shell_err.txt"
$p = Start-Process -FilePath "npx" -ArgumentList "electron","." -WorkingDirectory "E:\Desktop\作业日程\electron" -PassThru -RedirectStandardOutput $out -RedirectStandardError $errf -WindowStyle Hidden
Start-Sleep -Seconds 12
Get-Content $out | Select-Object -Last 5
$port = (Select-String -Path $out -Pattern "backend ready on port (\d+)").Matches.Groups[1].Value
"port=$port"
if ($port) { (Invoke-RestMethod "http://127.0.0.1:$port/api/state") | ConvertTo-Json -Compress }
taskkill /PID $p.Id /T /F 2>&1 | Out-Null
Start-Sleep -Seconds 2
"leftover listeners on port: $((Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count)"
```
Expected: 日志出现 `[shell] backend ready on port <n>`；`/api/state` 返回 JSON；taskkill 后端口无遗留监听（证明子进程随进程树清理）。

> 提示：窗口会在这台机器的桌面上真实出现（透明无边框置顶）。`npx` 在 Windows 上可能以 `npx.cmd` 形式启动，若 `$p.Id` 指向的壳进程与 electron 不同，用 `Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force` 兜底清理，并在报告中说明。

- [ ] **Step 7: 提交**

```powershell
git add electron/package.json electron/main.js electron/preload.js electron/make-tray-icon.js electron/tray.png electron/icon.png electron/package-lock.json
git commit -m "feat(shell): Electron 无边框窗口与后端子进程管理"
```

> 根 `.gitignore` 已含 `node_modules/`（任意层级匹配），无需改动；构建产物忽略规则在 Task 4 统一追加。

---

### Task 3: 设置面板窗口选项接线（置顶/透明度/自启/提醒形式）

**Files:**
- Modify: `frontend/index.html`（设置弹层新增 4 项）
- Modify: `frontend/app.js`（读写与应用；SSE 提醒按 remind_popup 决定气泡/系统通知）

（`electron/main.js` 的 IPC 与位置记忆已在 Task 2 就绪：`shell:set-always-on-top` / `shell:set-opacity` / `shell:set-autostart` / `shell:get-autostart` / `shell:notify`。）

- [ ] **Step 1: `index.html` — 在设置弹层的「BB 提醒」字段之后插入**

```html
        <label class="check">
          <input id="s-ontop" type="checkbox" />
          窗口置顶
        </label>
        <label class="field">窗口透明度（0.3 – 1.0）
          <input id="s-opacity" type="number" min="0.3" max="1" step="0.05" />
        </label>
        <label class="check">
          <input id="s-autostart" type="checkbox" />
          开机自启
        </label>
        <label class="field">提醒形式
          <select id="s-popup">
            <option value="inapp">应用内气泡</option>
            <option value="toast">系统通知</option>
            <option value="both">两者都要</option>
          </select>
        </label>
```

- [ ] **Step 2: `app.js` — 状态增加 settings 缓存与刷新函数**

在 `state` 对象尾部（`dayData` 行之后）加入：

```js
  settings: {},
```

在 `doLogout` 函数之前插入：

```js
async function refreshSettings() {
  try {
    state.settings = await api.getSettings();
  } catch {
    /* 保持默认 */
  }
}
```

`init()` 中 `await loadDay();` 之后加入：

```js
  await refreshSettings();
```

- [ ] **Step 3: `app.js` — `openSettings` 与 `saveSettings` 全量替换**

```js
async function openSettings() {
  $("settings-msg").textContent = "";
  try {
    const cfg = await api.getSettings();
    state.settings = cfg;
    $("s-interval").value = cfg.refresh_interval_min ?? 30;
    $("s-bb-remind").checked = !!cfg.bb_remind_enabled;
    $("s-bb-defaults").value = (cfg.bb_remind_defaults || []).join(", ");
    $("s-ontop").checked = cfg.always_on_top !== false;
    $("s-opacity").value = typeof cfg.opacity === "number" ? cfg.opacity : 0.95;
    $("s-autostart").checked = window.hwShell ? await window.hwShell.getAutostart() : !!cfg.autostart;
    $("s-popup").value = cfg.remind_popup || "inapp";
  } catch (err) {
    $("settings-msg").textContent = err.message;
  }
  $("modal-settings").hidden = false;
}

async function saveSettings() {
  const defaults = $("s-bb-defaults").value
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const payload = {
    refresh_interval_min: Number($("s-interval").value) || 30,
    bb_remind_enabled: $("s-bb-remind").checked,
    bb_remind_defaults: defaults,
    always_on_top: $("s-ontop").checked,
    opacity: Math.min(1, Math.max(0.3, Number($("s-opacity").value) || 0.95)),
    autostart: $("s-autostart").checked,
    remind_popup: $("s-popup").value,
  };
  try {
    const saved = await api.putSettings(payload);
    state.settings = saved || payload;
    if (window.hwShell) {
      window.hwShell.setAlwaysOnTop(payload.always_on_top);
      window.hwShell.setOpacity(payload.opacity);
      window.hwShell.setAutostart(payload.autostart);
    }
    $("settings-msg").textContent = "已保存";
  } catch (err) {
    $("settings-msg").textContent = err.message;
  }
}
```

- [ ] **Step 4: `app.js` — SSE 提醒按 `remind_popup` 分发**

`connectSSE` 中整体替换 `remind` 处理器：

```js
    remind: (d) => {
      if (!d) return;
      const when = d.at ? formatTime(d.at) : "";
      const kindText = d.kind === "assignment" ? "截止" : "开始";
      const sub = when ? `${when} ${kindText}` : "";
      const popup = state.settings.remind_popup || "inapp";
      if (popup !== "inapp" && window.hwShell) {
        window.hwShell.notify(`🔔 ${d.title || "日程提醒"}`, sub);
      }
      if (popup !== "toast" || !window.hwShell) {
        const show = () => showBubble(d.title || "日程提醒", sub, show);
        show();
      }
    },
```

- [ ] **Step 5: 验证**

```powershell
node --check frontend/app.js                 # 语法通过
node --test "frontend/tests/**/*.test.js"    # 19 passed
.\.venv\Scripts\python -m pytest             # 118 passed
```

再启动开发态壳冒烟（同 Task 2 Step 6 命令）：日志出现 `backend ready`；`Invoke-RestMethod /api/settings` 可见 `always_on_top/opacity/autostart/remind_popup` 键；`PUT /api/settings {"opacity":0.8}` 返回保存后的配置。停止壳并确认无遗留监听。

- [ ] **Step 6: 提交**

```powershell
git add frontend/index.html frontend/app.js
git commit -m "feat(fe): 设置面板窗口选项与系统通知接线"
```

---

### Task 4: 打包 — PyInstaller 后端 + electron-builder 外壳

**Files:**
- Create: `packaging/backend_entry.py`
- Create: `packaging/build.ps1`
- Modify: `.gitignore`（构建产物）
- 生成物（不提交）: `electron/resources/backend/backend.exe`、`electron/dist/*`

- [ ] **Step 1: `packaging/backend_entry.py`**

```python
"""PyInstaller 入口：以模块方式启动后端服务。"""
from backend.main import main

if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: `.gitignore` 追加构建产物**

在仓库根 `.gitignore` 末尾追加：

```text
build/
electron/dist/
electron/resources/
```

- [ ] **Step 3: 安装 PyInstaller 并构建 backend.exe**

```powershell
.\.venv\Scripts\python -m pip install pyinstaller
.\.venv\Scripts\python -m PyInstaller --onefile --name backend `
  --distpath electron\resources\backend `
  --workpath build\pyinstaller --specpath build\pyinstaller `
  --paths . packaging\backend_entry.py
```
Expected: `electron/resources/backend/backend.exe` 生成（约 40–80MB）。注意必须保留控制台输出（`PORT=` 经 stdout 传递给壳），不要加 `--noconsole`。

- [ ] **Step 4: 冒烟 backend.exe**

```powershell
$env:APPDATA = "$env:TEMP\hw_pkg_appdata"
$out = "$env:TEMP\hw_pkg_out.txt"
$p = Start-Process -FilePath "E:\Desktop\作业日程\electron\resources\backend\backend.exe" -PassThru -RedirectStandardOutput $out -WindowStyle Hidden
Start-Sleep -Seconds 8
$port = (Select-String -Path $out -Pattern "^PORT=(\d+)").Matches.Groups[1].Value
"port=$port"
(Invoke-RestMethod "http://127.0.0.1:$port/api/state") | ConvertTo-Json -Compress
Stop-Process -Id $p.Id -Force
Remove-Item -Recurse -Force "$env:TEMP\hw_pkg_appdata" -ErrorAction SilentlyContinue
```
Expected: `port=<n>` 与状态 JSON；进程可停止。（onefile 首次解包启动稍慢，8 秒充足。）

- [ ] **Step 5: `packaging/build.ps1` 一键打包脚本**

```powershell
# 一键打包：PyInstaller 后端 → electron-builder 外壳
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
.\.venv\Scripts\python -m PyInstaller --onefile --name backend `
  --distpath electron\resources\backend `
  --workpath build\pyinstaller --specpath build\pyinstaller `
  --paths . packaging\backend_entry.py
Set-Location electron
npm run dist
```

- [ ] **Step 6: electron-builder 打包**

```powershell
Set-Location electron
npm run dist
```
Expected: `electron/dist/` 出现 NSIS 安装包（`作业日程 Setup 0.1.0.exe`）与便携版（`作业日程 0.1.0.exe`）；首次运行会下载 nsis 等资源（较慢）。若因网络失败，重试一次并在报告中说明。

- [ ] **Step 7: 提交（只提交源码与脚本，不提交二进制）**

```powershell
git add packaging/backend_entry.py packaging/build.ps1 .gitignore
git commit -m "build: 后端 PyInstaller 与外壳 electron-builder 打包"
```

---

### Task 5: 端到端验收（控制者执行）+ 修复轮

> 由**控制者（主会话）**在真实桌面环境执行；发现缺陷派发修复并复验。

- [ ] **Step 1: 开发态启动**（`npx electron .`，同 Task 2 Step 6）→ 要求：
  1. 窗口真实出现：透明、无边框、置顶、约 408×760；页面加载出日历（截图 → 视觉复核）。
  2. 日志 `[shell] backend ready on port <n>`；`/api/state` 正常。
- [ ] **Step 2: 交互抽查**（沿用阶段 3 QA 手法：后端 API 造数据 + 截图）：
  3. 打开设置面板 → 勾选置顶/调透明度（如 0.8）/提醒形式「两者都要」→ 保存 → 面板显示「已保存」；`GET /api/settings` 值已更新。
  4. 创建到点日程（`remind_before=0`）→ ≤35s 内窗口内气泡弹出（both 模式下再叠加系统通知，肉眼/截图确认其一）。
  5. 拖动窗口（模拟：`mainWindow.setPosition` 无 UI 通道时跳过）→ 至少验证 `window_pos` 在移动后经 `moved` 事件写回（可通过 API 修改窗口位置后读 `/api/settings` 间接验证，或记录为人工项）。
- [ ] **Step 3: 退出与清理**：
  6. 正常退出路径（自动化）：`npx electron . --smoke-quit`（就绪后 ~3s 自行 `app.quit()` → `before-quit` → `stopBackend`）→ 验证端口无监听、无残留 python；托盘「退出」为同路径的人工项。
  6b. 窗口关闭行为：Alt+F4 / 关闭应仅隐藏到托盘（应用驻留，`close` 事件 preventDefault + hide），托盘可再唤起。
  6c. 崩溃提示：强杀后端 python 子进程 → 应出现系统通知「后端进程已退出…」（无自动重启，为已知限制）。
- [ ] **Step 4: 打包版冒烟**（便携版）：
  7. 启动 `electron/dist/作业日程 0.1.0.exe` → 窗口出现、`backend.exe` 被 spawn、`/api/state` 正常 → 关闭并清理进程。
- [ ] **Step 5: 修复轮**：任何缺陷 → 派发修复（含复现/期望/实际）→ 复验 → 提交 `fix(shell): …`。

---

## 验收标准（阶段 4 完成标志）

1. 前端 node 19 + 后端 118 不回归；`node --check frontend/app.js` 通过。
2. 开发态与便携版均能启动：窗口出现（透明无边框置顶）、`backend ready`、`/api/state` 正常。
3. 设置面板 4 个窗口类选项生效（置顶/透明度/自启/提醒形式）；`window_pos` 记忆可写回。
4. 提醒气泡在真实窗口中弹出（remind_popup 生效）。
5. `electron/dist/` 产出 NSIS 安装包与便携版；体积与预期相符（~150–250MB 级）。
6. 退出后无遗留后端监听（强杀场景例外，作为已知限制记录）。
7. `git log` 可见阶段 4 提交；二进制产物不进 git。

## 附：已知限制（交付说明用）

- Chromium 无法对桌面做 backdrop blur：窗口呈半透明而非真毛玻璃（如需亚克力可用 `backgroundMaterial`，与透明窗口二选一）。
- 强杀外壳进程（任务管理器结束）会遗留后端进程（无 watchdog；后续可加心跳自退）。
- 后端崩溃：仅系统通知提示，**无自动重启**（设计 §6.6 的「自动重启」显式降级为提示 + 手动重启）。
- 开发态启动等待：后端在慢网络下登录+首同步可能耗时数十秒，窗口此时不显示（上限 120s 后报错并退出）。




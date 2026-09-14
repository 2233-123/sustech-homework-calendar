# electron/ — Electron 外壳

职责：无边框透明窗口与系统托盘；启动时 spawn 后端（打包版为 `resources/backend/backend.exe`，
开发态为 `.venv` 的 python），解析其 stdout 的 `PORT=` 后加载前端 URL。

## 主要文件

| 文件 | 作用 |
|---|---|
| `main.js` | 主进程：窗口/托盘/IPC、平滑缩放、光标锚定、贴边收起、fit-height |
| `preload.js` | `contextBridge` 暴露 `window.hwShell`（窗口能力，无 Node 注入） |
| `build/installer.nsh` | NSIS 自定义安装页（快捷方式选项） |
| `resources/backend/` | 打包用 `backend.exe`（PyInstaller 产物，构建生成） |
| `dist/` | 安装包/便携版输出（构建产物） |
| `icon.png` / `tray.png` | 应用图标（1024，白底毛玻璃+日历，`make-icon.js` 用 headless Chromium 渲染）与托盘图（`make-tray-icon.js` 纯 Node 生成） |
| `package.json` | electron-builder 配置与依赖 |

## 约定

- 页面能力只经 `preload.js` 暴露，保持 `contextIsolation:true`、`nodeIntegration:false`。
- IPC 通道命名 `shell:*`；主进程负责一切窗口几何（渲染层只上报意图/尺寸）。
- 窗口高度由渲染层 `fit-height` 上报驱动；缩放下限 `MIN_ZOOM=0.7`。

## 运行 / 打包

```powershell
cd electron; npm i; npm start    # 开发态自动拉起后端
packaging\build.ps1              # 一键打包（先关闭正在运行的应用）
```

## 修改注意点

- 新增 IPC 需同时改 `preload.js` 与 `main.js` 的 `registerIpc()`。
- 打包脚本对 PyInstaller 的 stderr 敏感：验证时不要在 PowerShell 里加 `2>&1` 重定向。
- 改动窗口尺寸/位置相关逻辑后，务必在隔离实例（`--user-data-dir`+`APPDATA`）真机验证。

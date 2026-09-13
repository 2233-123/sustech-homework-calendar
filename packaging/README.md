# packaging/ — 打包

职责：把后端打成单文件 exe，再用 electron-builder 生成 Windows 安装包与便携版。

## 主要文件

| 文件 | 作用 |
|---|---|
| `build.ps1` | 一键打包：PyInstaller（含前端静态资源）→ electron-builder |
| `backend_entry.py` | PyInstaller 入口，转调 `backend.main` |

## 产物

- `electron/resources/backend/backend.exe`：随安装包分发的后端。
- `electron/dist/作业日程 Setup 0.1.0.exe`：NSIS 安装包。
- `electron/dist/作业日程 0.1.0.exe`：便携版。

## 运行

```powershell
# 先关闭正在运行的 作业日程（否则 backend.exe 被占用，PyInstaller 无法覆盖）
packaging\build.ps1
```

## 修改注意点

- 切勿在 PowerShell 中给 `build.ps1` 加 `2>&1`：PyInstaller 的 INFO 走 stderr，被合并后会被当作错误记录而中止脚本。
- `backend_entry.py` 的 `--add-data` 把 `frontend/` 一并打入 exe，新增前端静态资源无需改脚本。
- 安装器自定义逻辑在 `electron/build/installer.nsh`，本目录不涉及 NSIS。

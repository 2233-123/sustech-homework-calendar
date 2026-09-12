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

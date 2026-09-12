# 一键打包：PyInstaller 后端 → electron-builder 外壳
# 前置：.\.venv\Scripts\python -m pip install pyinstaller；electron\ 已执行过 npm i
# 注意：必须先关闭正在运行的 作业日程/backend.exe（否则 PyInstaller 无法覆盖输出文件）
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$frontend = Join-Path $root "frontend"
.\.venv\Scripts\python -m PyInstaller --onefile --name backend `
  --add-data "$frontend;frontend" `
  --distpath electron\resources\backend `
  --workpath build\pyinstaller --specpath build\pyinstaller `
  --paths . packaging\backend_entry.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller 构建失败（exit $LASTEXITCODE）" }
Set-Location electron
npm run dist
if ($LASTEXITCODE -ne 0) { throw "electron-builder 打包失败（exit $LASTEXITCODE）" }

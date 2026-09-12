"""PyInstaller 入口：以模块方式启动后端服务。"""
from backend.main import main

if __name__ == "__main__":
    raise SystemExit(main())

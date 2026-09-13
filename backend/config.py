"""应用配置与路径管理。

数据目录：%APPDATA%\\作业日程\\
"""
from __future__ import annotations

import copy
import json
import os
import threading
import time
from pathlib import Path

APP_DIR_NAME = "作业日程"

# 串行化全部配置读/写：Flask threaded=True 下，多请求并发写同一份配置快照会
# 相互覆盖（N1：saveWindowPos 的 {window_pos} 与渲染层写穿的 {window_scale} 在
# 缩放钳制场景几乎同时到达，非原子 load→save 会丢更新）；同时 Windows 下
# os.replace 会与读句柄冲突（opens 未带 FILE_SHARE_DELETE）。用 RLock 串行化
# 读与写，既消除丢更新也杜绝共享冲突——锁顺序单一（只此一把）、可重入，无嵌套
# 死锁风险（update_config 持锁时会再次进入 load_config/save_config）。
_CONFIG_LOCK = threading.RLock()

DEFAULT_CONFIG = {
    "refresh_interval_min": 30,
    "bb_remind_defaults": [1440, 120],
    "bb_remind_enabled": True,
    "remind_popup": "inapp",
    "always_on_top": True,
    "opacity": 0.95,
    "autostart": False,
    "window_pos": None,
    "window_scale": 100,
    "port": 0,
    "term_id": None,
    # 课程名 → 色相（前端课程标签配色）。存后端配置而非浏览器 localStorage：
    # 后端端口每次启动随机（origin 变化），localStorage 会随 origin 失效。
    "course_hues": {},
}


def app_dir() -> Path:
    """数据目录：%APPDATA%/作业日程（不存在则创建）。"""
    base = os.environ.get("APPDATA") or str(Path.home())
    d = Path(base) / APP_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return app_dir() / "data.db"


def credentials_path() -> Path:
    return app_dir() / "credentials.bin"


def config_path() -> Path:
    return app_dir() / "config.json"


def load_config() -> dict:
    with _CONFIG_LOCK:
        cfg = copy.deepcopy(DEFAULT_CONFIG)
        p = config_path()
        if p.exists():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError, UnicodeDecodeError):
                return cfg
            if isinstance(data, dict):
                cfg.update(data)
        return cfg


def _replace_with_retry(tmp: Path, path: Path) -> None:
    """Windows 下读句柄可能瞬时阻止覆盖：有界重试（3 次，间隔 10ms）。"""
    for attempt in range(3):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 2:
                raise
            time.sleep(0.01)


def save_config(cfg: dict) -> None:
    with _CONFIG_LOCK:
        merged = copy.deepcopy(DEFAULT_CONFIG)
        merged.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
        path = config_path()
        tmp = path.parent / (path.name + ".tmp")
        try:
            tmp.write_text(
                json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            _replace_with_retry(tmp, path)  # 同盘原子覆盖，避免读到半写文件
        except BaseException:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise


def update_config(patch: dict) -> dict:
    """原子地 load→update→save，返回合并后的配置。

    锁覆盖整个读-改-写，确保并发 patch（如 window_pos 与 window_scale）
    不会互相吞掉对方更新；落盘仍走 save_config 的键过滤。
    """
    with _CONFIG_LOCK:
        cfg = load_config()
        cfg.update(patch)
        save_config(cfg)
        return load_config()

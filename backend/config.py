"""应用配置与路径管理。

数据目录：%APPDATA%\\作业日程\\
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path

APP_DIR_NAME = "作业日程"

DEFAULT_CONFIG = {
    "refresh_interval_min": 30,
    "bb_remind_defaults": [1440, 120],
    "bb_remind_enabled": True,
    "remind_popup": "inapp",
    "always_on_top": True,
    "opacity": 0.95,
    "autostart": False,
    "window_pos": None,
    "port": 0,
    "term_id": None,
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


def save_config(cfg: dict) -> None:
    merged = copy.deepcopy(DEFAULT_CONFIG)
    merged.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
    config_path().write_text(
        json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
    )

"""启动装配：单例 Database、服务、后台线程与 HTTP 服务。

Electron 外壳通过 stdout 的 `PORT=<n>` 行获知实际端口。
"""
from __future__ import annotations

import logging
import socket
import threading
import time

from backend import config
from backend.app import create_app
from backend.db import Database
from backend.events import EventBus
from backend.reminder import offsets_from_config, run_once
from backend.service import Service

logger = logging.getLogger(__name__)

TICK_SEC = 30.0
REMINDER_TICK_SEC = 30.0


def pick_port() -> int:
    """选择一个空闲的本地端口。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_reminder_cycle(db, bus, cfg) -> int:
    """一轮提醒检查（供后台线程与测试调用）。"""
    return run_once(db, bus, offsets_from_config(cfg))


def run_sync_cycle(service) -> None:
    """一轮周期同步：未登录跳过；失败仅记日志（事件已在 service 内发布）。"""
    if not service.is_authenticated():
        return
    try:
        service.sync_now()
    except Exception as e:  # 后台线程不得因单次失败退出
        logger.warning("周期同步失败：%s", e)


def _sync_loop(service, stop: threading.Event, tick: float = TICK_SEC) -> None:
    last = time.monotonic()
    while not stop.wait(tick):
        interval = max(1, int(config.load_config().get("refresh_interval_min", 30))) * 60
        if time.monotonic() - last >= interval:
            last = time.monotonic()
            run_sync_cycle(service)


def _reminder_loop(db, bus, stop: threading.Event, tick: float = REMINDER_TICK_SEC) -> None:
    while not stop.wait(tick):
        try:
            run_reminder_cycle(db, bus, config.load_config())
        except Exception as e:
            logger.warning("提醒检查失败：%s", e)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    db = Database(config.db_path())  # 全局单例：勿按线程新建连接
    bus = EventBus()
    service = Service(db, bus)

    if service.try_silent_login():
        try:
            service.sync_now()
        except Exception as e:
            logger.warning("首次同步失败：%s", e)
    else:
        logger.info("未找到可用凭据，等待用户登录")

    stop = threading.Event()
    threading.Thread(target=_sync_loop, args=(service, stop), daemon=True, name="sync-loop").start()
    threading.Thread(
        target=_reminder_loop, args=(db, bus, stop), daemon=True, name="reminder-loop"
    ).start()

    cfg = config.load_config()
    port = int(cfg.get("port") or 0) or pick_port()
    app = create_app(service, bus)
    print(f"PORT={port}", flush=True)
    logger.info("后端启动：http://127.0.0.1:%d", port)
    app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

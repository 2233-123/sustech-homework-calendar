"""服务层测试替身。"""
from __future__ import annotations

from backend.db import Database
from backend.events import EventBus
from backend.service import Service


class FakeBBSession:
    """最小化 BBSession 替身：get_json 返回固定 uid。"""

    def __init__(self, sid: str, password: str):
        self.sid = sid
        self.password = password

    def get_json(self, path, params=None):
        return {"id": "_1_1"}


def failing_session_factory(exc: Exception):
    class _Failing(FakeBBSession):
        def get_json(self, path, params=None):
            raise exc

    return _Failing


def make_service(tmp_path, monkeypatch, *, fetch_fn=None, session_factory=None):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db = Database(tmp_path / "service.db")
    bus = EventBus()
    svc = Service(
        db,
        bus,
        session_factory=session_factory or FakeBBSession,
        fetch_fn=fetch_fn or (lambda session: []),
    )
    return svc, db, bus

import socket
from datetime import datetime, timedelta

from backend.db import Database
from backend.events import EventBus
from backend.main import pick_port, run_reminder_cycle, run_sync_cycle


def test_pick_port_returns_bindable_port():
    port = pick_port()
    assert 1 <= port <= 65535
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", port))  # 能绑定即有效


def test_run_reminder_cycle_fires_due_reminder(tmp_path):
    db = Database(tmp_path / "main.db")
    bus = EventBus()
    q = bus.subscribe()
    start = (datetime.now() + timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%S")
    db.add_schedule(title="小组会议", start_at=start, remind_before=1800)
    fired = run_reminder_cycle(db, bus, {"bb_remind_enabled": True, "bb_remind_defaults": []})
    assert fired == 1
    assert "remind" in q.get_nowait()


class _StubService:
    def __init__(self, authenticated):
        self._authenticated = authenticated
        self.calls = []

    def is_authenticated(self):
        return self._authenticated

    def sync_now(self):
        self.calls.append("sync")
        return {"added": 0, "updated": 0, "removed": 0, "at": "x"}


def test_run_sync_cycle_skips_when_unauthenticated():
    stub = _StubService(authenticated=False)
    run_sync_cycle(stub)
    assert stub.calls == []


def test_run_sync_cycle_runs_when_authenticated():
    stub = _StubService(authenticated=True)
    run_sync_cycle(stub)
    assert stub.calls == ["sync"]

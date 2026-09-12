import socket
from datetime import datetime, timedelta

from backend.db import Database
from backend.events import EventBus
from backend import main as main_module
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


class _StubStop:
    """limit 次 wait 返回 False，之后返回 True（驱动循环退出）。"""

    def __init__(self, limit):
        self.limit = limit
        self.calls = 0

    def wait(self, tick):
        self.calls += 1
        return self.calls > self.limit


def test_sync_loop_survives_bad_interval(monkeypatch):
    monkeypatch.setattr(main_module.config, "load_config", lambda: {"refresh_interval_min": "abc"})
    stop = _StubStop(limit=2)
    # 坏配置被吞：循环不抛异常地走完两轮后退出
    main_module._sync_loop(_StubService(authenticated=True), stop, tick=0.01)


def test_sync_loop_fires_when_interval_elapsed(monkeypatch):
    monkeypatch.setattr(main_module.config, "load_config", lambda: {"refresh_interval_min": 1})
    times = [0.0, 61.0, 61.0]

    def fake_monotonic():
        return times.pop(0) if times else 61.0

    monkeypatch.setattr(main_module.time, "monotonic", fake_monotonic)
    stub = _StubService(authenticated=True)
    stop = _StubStop(limit=1)
    main_module._sync_loop(stub, stop, tick=0.01)
    assert stub.calls == ["sync"]


def test_reminder_loop_survives_cycle_failure(monkeypatch):
    calls = {"n": 0}

    def boom(db, bus, cfg):
        calls["n"] += 1
        raise RuntimeError("boom")

    monkeypatch.setattr(main_module, "run_reminder_cycle", boom)
    stop = _StubStop(limit=2)
    main_module._reminder_loop(object(), object(), stop, tick=0.01)
    assert calls["n"] == 2

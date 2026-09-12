from datetime import datetime

from backend import reminder
from backend.db import Database
from backend.events import EventBus

NOW = datetime(2026, 9, 12, 13, 30, 0)


def make_db(tmp_path):
    return Database(tmp_path / "reminder.db")


def test_collect_due_schedule_fires_at_time(tmp_path):
    d = make_db(tmp_path)
    d.add_schedule(title="小组会议", start_at="2026-09-12T14:00:00", remind_before=1800)
    due = reminder.collect_due(d, NOW, [])
    assert len(due) == 1
    assert due[0]["kind"] == "schedule"
    assert due[0]["ref_id"] == 1
    assert due[0]["offset_sec"] == 1800
    assert due[0]["fire_at"] == "2026-09-12T13:30:00"
    assert due[0]["at"] == "2026-09-12T14:00:00"


def test_collect_due_schedule_not_before_time(tmp_path):
    d = make_db(tmp_path)
    d.add_schedule(title="小组会议", start_at="2026-09-12T14:00:00", remind_before=600)
    assert reminder.collect_due(d, NOW, []) == []


def test_collect_due_skips_already_fired(tmp_path):
    d = make_db(tmp_path)
    sid = d.add_schedule(title="小组会议", start_at="2026-09-12T14:00:00", remind_before=1800)
    d.mark_fired("schedule", sid, 1800)
    assert reminder.collect_due(d, NOW, []) == []


def test_collect_due_skips_beyond_catchup(tmp_path):
    d = make_db(tmp_path)
    # 触发时刻在 25 小时前（超出 24h 补发窗口）
    d.add_schedule(title="旧会议", start_at="2026-09-11T12:30:00", remind_before=0)
    assert reminder.collect_due(d, NOW, []) == []


def test_collect_due_within_catchup(tmp_path):
    d = make_db(tmp_path)
    # 触发时刻在 23 小时前（窗口内 → 应补发）
    d.add_schedule(title="昨日的会", start_at="2026-09-11T14:30:00", remind_before=0)
    due = reminder.collect_due(d, NOW, [])
    assert len(due) == 1


def test_collect_due_assignment_offsets(tmp_path):
    d = make_db(tmp_path)
    # due 已过 1 小时：2h 档触发时刻距今 3h（窗口内 → 触发）；1 天档距今 25h（超窗 → 跳过）
    d.upsert_assignments([{
        "course_id": "1", "course_name": "OS", "content_id": "2", "title": "实验1",
        "due_at": "2026-09-12T12:30:00", "submitted": 0, "status": None, "score": None, "possible": 100,
    }])
    due = reminder.collect_due(d, NOW, [86400, 7200])
    assert len(due) == 1
    assert due[0]["kind"] == "assignment"
    assert due[0]["offset_sec"] == 7200
    assert due[0]["fire_at"] == "2026-09-12T10:30:00"


def test_offsets_from_config_converts_minutes_and_handles_toggle():
    cfg = {"bb_remind_enabled": True, "bb_remind_defaults": [1440, 120]}
    assert reminder.offsets_from_config(cfg) == [86400, 7200]
    cfg["bb_remind_enabled"] = False
    assert reminder.offsets_from_config(cfg) == []
    assert reminder.offsets_from_config({}) == []


def test_run_once_publishes_and_is_idempotent(tmp_path):
    d = make_db(tmp_path)
    bus = EventBus()
    q = bus.subscribe()
    d.add_schedule(title="小组会议", start_at="2026-09-12T14:00:00", remind_before=1800)
    assert reminder.run_once(d, bus, [], now=NOW) == 1
    msg = q.get_nowait()
    assert msg.startswith("event: remind\n")
    assert "小组会议" in msg
    # 第二轮：已触发过 → 不重复
    assert reminder.run_once(d, bus, [], now=NOW) == 0
    assert q.empty()


def test_collect_due_boundary_exactly_24h(tmp_path):
    d = make_db(tmp_path)
    # 触发时刻恰好 24 小时前 → 仍在补发窗口内（<=）
    d.add_schedule(title="边界会议", start_at="2026-09-11T13:30:00", remind_before=0)
    assert len(reminder.collect_due(d, NOW, [])) == 1


def test_collect_due_skips_malformed_rows(tmp_path):
    d = make_db(tmp_path)
    d.add_schedule(title="坏数据", start_at="not-a-date", remind_before=1800)
    d.add_schedule(title="好数据", start_at="2026-09-12T14:00:00", remind_before=1800)
    due = reminder.collect_due(d, NOW, [])
    assert [c["title"] for c in due] == ["好数据"]


def test_offsets_from_config_dedupes_and_skips_invalid():
    cfg = {"bb_remind_enabled": True, "bb_remind_defaults": [120, 120, "abc", 60]}
    assert reminder.offsets_from_config(cfg) == [7200, 3600]

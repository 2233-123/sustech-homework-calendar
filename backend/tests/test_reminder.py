import sqlite3
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
    # 去重键含触发时刻：以本次 fire_at 登记后才视为已触发
    d.mark_fired("schedule", sid, 1800, "2026-09-12T13:30:00")
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


# ---------- 提醒审计修复：复合键 / 过期抑制 / 已开始不补发 ----------


def test_t1_reschedule_to_future_refires(tmp_path):
    """改期到未来：旧时刻已提醒，新触发时刻更晚 → 应再次触发。"""
    d = make_db(tmp_path)
    sid = d.add_schedule(title="会议", start_at="2026-09-12T14:00:00", remind_before=1800)
    d.mark_fired("schedule", sid, 1800, "2026-09-12T13:30:00", "2026-09-12T13:30:00")  # 旧 fire 已提醒
    d.update_schedule(sid, start_at="2026-09-12T16:00:00")  # 新 fire = 15:30
    later = datetime(2026, 9, 12, 15, 30, 0)
    due = reminder.collect_due(d, later, [])
    assert len(due) == 1
    assert due[0]["fire_at"] == "2026-09-12T15:30:00"


def test_t2_offset_change_into_past_suppressed_when_reminded(tmp_path):
    """改提前量使其触发时刻早于已提醒时刻 → 不触发。"""
    d = make_db(tmp_path)
    sid = d.add_schedule(title="会议", start_at="2026-09-12T14:00:00", remind_before=1800)
    d.mark_fired("schedule", sid, 1800, "2026-09-12T13:30:00")
    d.update_schedule(sid, remind_before=3600)  # fire 13:00 < last_fired 13:30
    assert reminder.collect_due(d, NOW, []) == []


def test_t3_offset_change_into_past_first_time_fires(tmp_path):
    """从未提醒过：即使触发时刻在过去，也触发一次（T1 行为回归保护）。"""
    d = make_db(tmp_path)
    d.add_schedule(title="会议", start_at="2026-09-12T14:00:00", remind_before=3600)
    due = reminder.collect_due(d, NOW, [])
    assert len(due) == 1
    assert due[0]["fire_at"] == "2026-09-12T13:00:00"


def test_t4_revert_to_fired_key_no_duplicate(tmp_path):
    """改到已过值再改回原值：过期抑制 + 精确去重共同保证不重复。"""
    d = make_db(tmp_path)
    sid = d.add_schedule(title="会议", start_at="2026-09-12T14:00:00", remind_before=1800)
    d.mark_fired("schedule", sid, 1800, "2026-09-12T13:30:00")
    assert reminder.collect_due(d, NOW, []) == []
    d.update_schedule(sid, remind_before=3600)  # 过期抑制
    assert reminder.collect_due(d, NOW, []) == []
    d.update_schedule(sid, remind_before=1800)  # 回到已触发键 → 精确去重
    assert reminder.collect_due(d, NOW, []) == []


def test_t5a_started_schedule_no_catchup(tmp_path):
    """已开始（now > start_at）且 offset>0 → 不补发「开始前」提醒。"""
    d = make_db(tmp_path)
    d.add_schedule(title="已开始", start_at="2026-09-12T13:20:00", remind_before=1800)  # fire 12:50
    assert reminder.collect_due(d, NOW, []) == []


def test_t5b_upcoming_schedule_catchup_fires(tmp_path):
    """尚未开始且在补发窗口内 → 触发（补发回归）。"""
    d = make_db(tmp_path)
    d.add_schedule(title="将开始", start_at="2026-09-12T13:40:00", remind_before=1800)  # fire 13:10
    due = reminder.collect_due(d, NOW, [])
    assert len(due) == 1


def test_t5c_started_schedule_offset_zero_still_fires(tmp_path):
    """offset==0（恰在开始时提醒）不受「已开始不补发」限制。"""
    d = make_db(tmp_path)
    d.add_schedule(title="整点提醒", start_at="2026-09-12T13:20:00", remind_before=0)
    due = reminder.collect_due(d, NOW, [])
    assert len(due) == 1


def test_t6_first_fire_idempotent_and_bb_two_slots(tmp_path):
    """正常首触发 + 连跑两轮不重复；BB [1440,120] 两槽各一条。"""
    d = make_db(tmp_path)
    bus = EventBus()
    q = bus.subscribe()
    d.add_schedule(title="会议", start_at="2026-09-12T14:00:00", remind_before=1800)
    d.upsert_assignments([{
        "course_id": "1", "course_name": "OS", "content_id": "2", "title": "实验1",
        "due_at": "2026-09-12T14:30:00", "submitted": 0, "status": None, "score": None, "possible": 100,
    }])
    # 候选：日程 1 条 + 作业两槽（7200 / 86400）
    offsets = sorted(c["offset_sec"] for c in reminder.collect_due(d, NOW, [86400, 7200]))
    assert offsets == [1800, 7200, 86400]
    assert reminder.run_once(d, bus, [86400, 7200], now=NOW) == 3
    events = [q.get_nowait() for _ in range(3)]
    assert all(m.startswith("event: remind\n") for m in events)
    assert sum(1 for m in events if "会议" in m) == 1
    assert sum(1 for m in events if "实验1" in m) == 2
    assert reminder.run_once(d, bus, [86400, 7200], now=NOW) == 0
    assert q.empty()


def test_t7_migrates_legacy_reminder_log(tmp_path):
    """旧表（无 fire_at）→ 新结构：历史保留、更早触发时刻不再补发。"""
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE reminder_log (
          kind       TEXT    NOT NULL,
          ref_id     INTEGER NOT NULL,
          offset_sec INTEGER NOT NULL,
          fired_at   TEXT    NOT NULL,
          UNIQUE(kind, ref_id, offset_sec)
        );
        INSERT INTO reminder_log VALUES ('schedule', 1, 1800, '2026-09-12T13:30:00');
        """
    )
    conn.commit()
    conn.close()
    d = Database(path)
    # 迁移保留历史：旧行 fire_at 回填为 fired_at（等值秒可由精确去重拦截）
    assert d.was_fired("schedule", 1, 1800, "2026-09-12T13:30:00") is True
    assert d.was_fired("schedule", 1, 1800, "") is False
    assert d.last_fired_at("schedule", 1) == "2026-09-12T13:30:00"
    # 迁移幂等：再次初始化不报错、历史仍在
    d2 = Database(path)
    assert d2.last_fired_at("schedule", 1) == "2026-09-12T13:30:00"
    # 旧触发时刻更早（13:00 < 13:30）→ 过期抑制，不重复提醒
    sid = d2.add_schedule(title="旧会议", start_at="2026-09-12T14:00:00", remind_before=3600)
    assert sid == 1
    assert reminder.collect_due(d2, NOW, []) == []
    # 等值秒（fire 13:30 == 旧 fired_at）→ 精确去重拦截（回归：空 fire_at 旧实现会补弹）
    d2.update_schedule(sid, remind_before=1800)
    assert reminder.collect_due(d2, NOW, []) == []


def test_t7b_backfills_blank_fire_at_on_reinit(tmp_path):
    """中间版本已迁移（fire_at 置空）的库：再次启动回填 fire_at=fired_at（幂等）。"""
    path = tmp_path / "blank.db"
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE reminder_log (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          kind       TEXT    NOT NULL,
          ref_id     INTEGER NOT NULL,
          offset_sec INTEGER NOT NULL,
          fire_at    TEXT    NOT NULL,
          fired_at   TEXT    NOT NULL,
          UNIQUE(kind, ref_id, offset_sec, fire_at)
        );
        INSERT INTO reminder_log (kind, ref_id, offset_sec, fire_at, fired_at)
          VALUES ('schedule', 7, 600, '', '2026-09-12T13:30:00');
        """
    )
    conn.commit()
    conn.close()
    d = Database(path)
    assert d.was_fired("schedule", 7, 600, "2026-09-12T13:30:00") is True
    assert d.was_fired("schedule", 7, 600, "") is False
    # 二次启动：回填后保持稳定
    d2 = Database(path)
    assert d2.was_fired("schedule", 7, 600, "2026-09-12T13:30:00") is True

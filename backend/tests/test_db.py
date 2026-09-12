from backend import db


def make_db(tmp_path):
    return db.Database(tmp_path / "test.db")


def test_schedule_crud(tmp_path):
    d = make_db(tmp_path)
    sid = d.add_schedule(title="小组会议", start_at="2026-09-12T14:00:00", remind_before=1800)
    assert sid == 1
    row = d.get_schedule(sid)
    assert row["title"] == "小组会议"
    assert row["remind_before"] == 1800
    d.update_schedule(sid, title="组会", start_at="2026-09-12T15:00:00")
    assert d.get_schedule(sid)["title"] == "组会"
    d.delete_schedule(sid)
    assert d.get_schedule(sid) is None


def test_list_schedules_range(tmp_path):
    d = make_db(tmp_path)
    d.add_schedule(title="a", start_at="2026-09-10T10:00:00")
    d.add_schedule(title="b", start_at="2026-09-12T10:00:00")
    rows = d.list_schedules("2026-09-11T00:00:00", "2026-09-13T00:00:00")
    assert [r["title"] for r in rows] == ["b"]


def test_upsert_assignments_dedup(tmp_path):
    d = make_db(tmp_path)
    rec = {
        "course_id": "8343", "course_name": "OS", "content_id": "610795",
        "title": "实验1", "due_at": "2026-09-20T23:59:00",
        "submitted": 0, "status": None, "score": None, "possible": 100,
    }
    d.upsert_assignments([rec])
    rec2 = dict(rec, title="实验1(改)", submitted=1, status="Completed", score=95.0)
    d.upsert_assignments([rec2])
    rows = d.list_assignments("2026-09-01T00:00:00", "2026-10-01T00:00:00")
    assert len(rows) == 1
    assert rows[0]["title"] == "实验1(改)"
    assert rows[0]["submitted"] == 1
    assert rows[0]["score"] == 95.0


def test_list_assignments_excludes_null_due(tmp_path):
    d = make_db(tmp_path)
    d.upsert_assignments([{
        "course_id": "1", "course_name": "X", "content_id": "2", "title": "无截止",
        "due_at": None, "submitted": 0, "status": None, "score": None, "possible": None,
    }])
    assert d.list_assignments("2026-01-01T00:00:00", "2027-01-01T00:00:00") == []


def test_settings(tmp_path):
    d = make_db(tmp_path)
    assert d.get_setting("missing", "def") == "def"
    d.set_setting("a", 1)
    assert d.get_setting("a") == 1
    d.set_setting("b", {"x": [1, 2]})
    assert d.get_setting("b") == {"x": [1, 2]}


def test_reminder_log(tmp_path):
    d = make_db(tmp_path)
    assert not d.was_fired("schedule", 1, 1800)
    d.mark_fired("schedule", 1, 1800)
    assert d.was_fired("schedule", 1, 1800)
    d.mark_fired("schedule", 1, 1800)  # 重复写入应幂等
    assert d.was_fired("schedule", 1, 1800)
    assert not d.was_fired("schedule", 1, 60)

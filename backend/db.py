"""SQLite 数据层：日程 / 作业缓存 / 设置 / 提醒日志。

时间统一存本地 ISO 字符串 'YYYY-MM-DDTHH:MM:SS'（字典序即时间序）。
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS schedule (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  note          TEXT,
  start_at      TEXT    NOT NULL,
  end_at        TEXT,
  all_day       INTEGER NOT NULL DEFAULT 0,
  remind_before INTEGER,
  color         TEXT,
  created_at    TEXT,
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS assignment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id   TEXT NOT NULL,
  course_name TEXT,
  content_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  due_at      TEXT,
  submitted   INTEGER,
  status      TEXT,
  score       REAL,
  possible    REAL,
  synced_at   TEXT,
  UNIQUE(course_id, content_id)
);

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS reminder_log (
  kind       TEXT    NOT NULL,
  ref_id     INTEGER NOT NULL,
  offset_sec INTEGER NOT NULL,
  fired_at   TEXT    NOT NULL,
  UNIQUE(kind, ref_id, offset_sec)
);

CREATE INDEX IF NOT EXISTS idx_schedule_start ON schedule(start_at);
CREATE INDEX IF NOT EXISTS idx_assignment_due ON assignment(due_at);
"""

_SCHEDULE_FIELDS = ("title", "note", "start_at", "end_at", "all_day", "remind_before", "color")


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class Database:
    def __init__(self, path):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    # ---------- 日程 ----------
    def add_schedule(self, *, title, start_at, end_at=None, all_day=0,
                     remind_before=None, note=None, color=None) -> int:
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO schedule"
                " (title, note, start_at, end_at, all_day, remind_before, color, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (title, note, start_at, end_at, all_day, remind_before, color, _now(), _now()),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def update_schedule(self, sid: int, **fields) -> None:
        updates = {k: v for k, v in fields.items() if k in _SCHEDULE_FIELDS}
        if not updates:
            return
        updates["updated_at"] = _now()
        sets = ", ".join(f"{k}=?" for k in updates)
        with self._lock:
            self._conn.execute(f"UPDATE schedule SET {sets} WHERE id=?", (*updates.values(), sid))
            self._conn.commit()

    def delete_schedule(self, sid: int) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM schedule WHERE id=?", (sid,))
            self._conn.commit()

    def get_schedule(self, sid: int):
        with self._lock:
            row = self._conn.execute("SELECT * FROM schedule WHERE id=?", (sid,)).fetchone()
        return dict(row) if row else None

    def list_schedules(self, start: str, end: str) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM schedule WHERE start_at >= ? AND start_at < ? ORDER BY start_at",
                (start, end),
            ).fetchall()
        return [dict(r) for r in rows]

    # ---------- 作业 ----------
    def upsert_assignments(self, records: list) -> int:
        ts = _now()
        with self._lock:
            for rec in records:
                self._conn.execute(
                    "INSERT INTO assignment"
                    " (course_id, course_name, content_id, title, due_at, submitted, status, score, possible, synced_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?)"
                    " ON CONFLICT(course_id, content_id) DO UPDATE SET"
                    "   course_name=excluded.course_name, title=excluded.title, due_at=excluded.due_at,"
                    "   submitted=excluded.submitted, status=excluded.status, score=excluded.score,"
                    "   possible=excluded.possible, synced_at=excluded.synced_at",
                    (
                        rec["course_id"], rec.get("course_name"), rec["content_id"], rec["title"],
                        rec.get("due_at"), rec.get("submitted"), rec.get("status"),
                        rec.get("score"), rec.get("possible"), ts,
                    ),
                )
            self._conn.commit()
        return len(records)

    def list_assignments(self, start: str, end: str) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM assignment WHERE due_at IS NOT NULL"
                " AND due_at >= ? AND due_at < ? ORDER BY due_at",
                (start, end),
            ).fetchall()
        return [dict(r) for r in rows]

    # ---------- 设置 ----------
    def get_setting(self, key: str, default=None):
        with self._lock:
            row = self._conn.execute("SELECT value FROM setting WHERE key=?", (key,)).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except (TypeError, json.JSONDecodeError):
            return row["value"]

    def set_setting(self, key: str, value) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO setting (key, value) VALUES (?,?)"
                " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value, ensure_ascii=False)),
            )
            self._conn.commit()

    # ---------- 提醒日志 ----------
    def was_fired(self, kind: str, ref_id: int, offset_sec: int) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM reminder_log WHERE kind=? AND ref_id=? AND offset_sec=?",
                (kind, ref_id, offset_sec),
            ).fetchone()
        return row is not None

    def mark_fired(self, kind: str, ref_id: int, offset_sec: int, fired_at: str | None = None) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO reminder_log (kind, ref_id, offset_sec, fired_at) VALUES (?,?,?,?)",
                (kind, ref_id, offset_sec, fired_at or _now()),
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

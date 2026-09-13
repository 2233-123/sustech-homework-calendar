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
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,
  ref_id     INTEGER NOT NULL,
  offset_sec INTEGER NOT NULL,
  fire_at    TEXT    NOT NULL,
  fired_at   TEXT    NOT NULL,
  UNIQUE(kind, ref_id, offset_sec, fire_at)
);

CREATE INDEX IF NOT EXISTS idx_schedule_start ON schedule(start_at);
CREATE INDEX IF NOT EXISTS idx_assignment_due ON assignment(due_at);
"""

_SCHEDULE_FIELDS = ("title", "note", "start_at", "end_at", "all_day", "remind_before", "color")


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class Database:
    """SQLite 数据层。

    线程模型：`sqlite3` 连接以 `check_same_thread=False` 创建，所有读写都在实例锁内
    串行化，可被 Flask 线程与后台调度线程共享（勿按线程新建连接）。
    """

    def __init__(self, path):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._migrate_reminder_log()
            self._conn.commit()

    def _migrate_reminder_log(self) -> None:
        """旧版 reminder_log（无 fire_at 列）→ 新结构；保留 fired_at 历史。

        幂等：以 PRAGMA table_info 判断列是否存在；已迁移的库补一次旧行回填。
        旧行的 fire_at 回填为 fired_at（旧键不含触发时刻）：等值秒由精确去重拦截，
        更早时刻由 last_fired_at 抑制，避免升级后补弹旧提醒。
        """
        cols = {row["name"] for row in self._conn.execute("PRAGMA table_info(reminder_log)")}
        if "fire_at" in cols:
            # 中间版本迁移遗留的空 fire_at 行补一次回填；OR IGNORE 跳过与既有行冲突者
            self._conn.execute(
                "UPDATE OR IGNORE reminder_log SET fire_at = fired_at"
                " WHERE fire_at = '' AND fired_at != ''"
            )
            return
        self._conn.executescript(
            """
            ALTER TABLE reminder_log RENAME TO reminder_log_old;
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
              SELECT kind, ref_id, offset_sec, fired_at, fired_at FROM reminder_log_old;
            DROP TABLE reminder_log_old;
            """
        )

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
        """[start, end) 内按开始时间升序的日程（ISO 字符串比较即时间比较）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM schedule WHERE start_at >= ? AND start_at < ? ORDER BY start_at",
                (start, end),
            ).fetchall()
        return [dict(r) for r in rows]

    # ---------- 作业 ----------
    def upsert_assignments(self, records: list):
        """插入/更新作业缓存，返回 (added, updated) 计数。"""
        ts = _now()
        with self._lock:
            try:
                existing = {
                    (row["course_id"], row["content_id"])
                    for row in self._conn.execute("SELECT course_id, content_id FROM assignment")
                }
                added = 0
                for rec in records:
                    key = (rec["course_id"], rec["content_id"])
                    if key not in existing:
                        added += 1
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
                    existing.add(key)
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise
        return added, len(records) - added

    def list_assignments(self, start: str, end: str) -> list:
        """[start, end) 内按截止时间升序、且 due_at 非空的作业。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM assignment WHERE due_at IS NOT NULL"
                " AND due_at >= ? AND due_at < ? ORDER BY due_at",
                (start, end),
            ).fetchall()
        return [dict(r) for r in rows]

    def purge_assignments_synced_before(self, ts: str) -> int:
        """删除 synced_at < ts 的作业缓存（剔除 BB 上已删除的作业），返回删除数。"""
        with self._lock:
            cur = self._conn.execute("DELETE FROM assignment WHERE synced_at < ?", (ts,))
            self._conn.commit()
            return cur.rowcount

    def list_pending_schedules(self) -> list:
        """所有设置了提醒的日程（供提醒调度扫描）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM schedule WHERE remind_before IS NOT NULL ORDER BY start_at"
            ).fetchall()
        return [dict(r) for r in rows]

    def list_reminder_assignments(self) -> list:
        """所有带截止时间的作业（供提醒调度扫描）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM assignment WHERE due_at IS NOT NULL ORDER BY due_at"
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
    def was_fired(self, kind: str, ref_id: int, offset_sec: int, fire_at: str = "") -> bool:
        """该 (kind, ref_id, offset_sec, fire_at) 是否已触发过（精确匹配）。"""
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM reminder_log"
                " WHERE kind=? AND ref_id=? AND offset_sec=? AND fire_at=?",
                (kind, ref_id, offset_sec, fire_at),
            ).fetchone()
        return row is not None

    def mark_fired(
        self, kind: str, ref_id: int, offset_sec: int, fire_at: str = "", fired_at: str | None = None
    ) -> None:
        """登记一次触发；(kind, ref_id, offset_sec, fire_at) 唯一，重复插入被忽略。"""
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO reminder_log"
                " (kind, ref_id, offset_sec, fire_at, fired_at) VALUES (?,?,?,?,?)",
                (kind, ref_id, offset_sec, fire_at, fired_at or _now()),
            )
            self._conn.commit()

    def last_fired_at(self, kind: str, ref_id: int) -> str | None:
        """该对象最近一次触发时间（MAX(fired_at)）；从未触发返回 None。"""
        with self._lock:
            row = self._conn.execute(
                "SELECT MAX(fired_at) AS m FROM reminder_log WHERE kind=? AND ref_id=?",
                (kind, ref_id),
            ).fetchone()
        return row["m"] if row and row["m"] else None

    def close(self) -> None:
        with self._lock:
            self._conn.close()

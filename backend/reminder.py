"""提醒调度：候选计算 / reminder_log 去重 / 24h 补发窗口。

单位约定：本模块内部一律使用「秒」（offset_sec）；
配置 `bb_remind_defaults` 单位是「分钟」，由 offsets_from_config 负责换算。
"""
from __future__ import annotations

from datetime import datetime, timedelta

CATCHUP_WINDOW = timedelta(hours=24)
_TIME_FMT = "%Y-%m-%dT%H:%M:%S"


def _parse(ts: str) -> datetime:
    return datetime.strptime(ts, _TIME_FMT)


def _in_window(fire_at: datetime, now: datetime) -> bool:
    """已到点，且未超出补发窗口（now - fire_at <= 24h）。"""
    return fire_at <= now and (now - fire_at) <= CATCHUP_WINDOW


def collect_due(db, now: datetime, offsets_sec: list) -> list:
    """收集所有「已到触发时刻、未触发过、在补发窗口内」的提醒候选。"""
    due = []
    for row in db.list_pending_schedules():
        fire_at = _parse(row["start_at"]) - timedelta(seconds=row["remind_before"])
        if _in_window(fire_at, now) and not db.was_fired("schedule", row["id"], row["remind_before"]):
            due.append({
                "kind": "schedule",
                "ref_id": row["id"],
                "offset_sec": row["remind_before"],
                "title": row["title"],
                "at": row["start_at"],
                "fire_at": fire_at.strftime(_TIME_FMT),
            })
    for row in db.list_reminder_assignments():
        for off in offsets_sec:
            fire_at = _parse(row["due_at"]) - timedelta(seconds=off)
            if _in_window(fire_at, now) and not db.was_fired("assignment", row["id"], off):
                due.append({
                    "kind": "assignment",
                    "ref_id": row["id"],
                    "offset_sec": off,
                    "title": row["title"],
                    "at": row["due_at"],
                    "fire_at": fire_at.strftime(_TIME_FMT),
                })
    return due


def run_once(db, bus, offsets_sec: list, now: datetime | None = None) -> int:
    """执行一轮提醒检查：标记 reminder_log + SSE 推送，返回触发数量。"""
    now = now or datetime.now()
    fired = 0
    for cand in collect_due(db, now, offsets_sec):
        db.mark_fired(cand["kind"], cand["ref_id"], cand["offset_sec"])
        bus.publish("remind", {
            "kind": cand["kind"],
            "id": cand["ref_id"],
            "title": cand["title"],
            "at": cand["at"],
        })
        fired += 1
    return fired


def offsets_from_config(cfg: dict) -> list:
    """bb_remind_defaults（分钟）→ 秒列表；未启用返回空列表。"""
    if not cfg.get("bb_remind_enabled", True):
        return []
    return [int(m) * 60 for m in cfg.get("bb_remind_defaults", [])]

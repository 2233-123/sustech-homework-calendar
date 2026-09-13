"""提醒调度：候选计算 / reminder_log 去重 / 24h 补发窗口。

单位约定：本模块内部一律使用「秒」（offset_sec）；
配置 `bb_remind_defaults` 单位是「分钟」，由 offsets_from_config 负责换算。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

CATCHUP_WINDOW = timedelta(hours=24)
_TIME_FMT = "%Y-%m-%dT%H:%M:%S"


def _parse(ts: str) -> datetime:
    return datetime.strptime(ts, _TIME_FMT)


def _in_window(fire_at: datetime, now: datetime) -> bool:
    """已到点，且未超出补发窗口（now - fire_at <= 24h）。"""
    return fire_at <= now and (now - fire_at) <= CATCHUP_WINDOW


def collect_due(db, now: datetime, offsets_sec: list) -> list:
    """收集所有「已到触发时刻、未触发过、在补发窗口内」的提醒候选。

    去重键升级为 (kind, ref_id, offset_sec, fire_at)：改期或改提前量导致触发时刻变化时，
    视为新提醒。三道闸门（顺序固定）：
      1. 过期抑制：已在该触发时刻之后提醒过（last_fired_at 更大）→ 跳过；
         从未提醒过（last_fired_at 为 None）仍会触发（保住「首次进入窗口」场景）。
      2. 精确去重：同一 (…, fire_at) 已触发过 → 跳过。
      3. 已开始日程不补发：schedule 且 offset>0（开始前提醒）且 now > start_at → 跳过；
         offset==0（恰在开始时提醒）不受此限。
    BB 作业只做 1/2，不做 3（截止类补发保留）。

    单行数据损坏（时间格式非法/类型错误）时跳过该行并记日志，不影响其它提醒。
    """
    due = []
    for row in db.list_pending_schedules():
        try:
            offset = row["remind_before"]
            start_at = _parse(row["start_at"])
            fire_at = start_at - timedelta(seconds=offset)
            if not _in_window(fire_at, now):
                continue
            fire_str = fire_at.strftime(_TIME_FMT)
            last = db.last_fired_at("schedule", row["id"])
            if last is not None and fire_str < last:
                continue  # 1. 过期抑制
            if db.was_fired("schedule", row["id"], offset, fire_str):
                continue  # 2. 精确去重
            if offset > 0 and now > start_at:
                continue  # 3. 已开始，不补发「开始前」提醒
            due.append({
                "kind": "schedule",
                "ref_id": row["id"],
                "offset_sec": offset,
                "title": row["title"],
                "at": row["start_at"],
                "fire_at": fire_str,
            })
        except (ValueError, TypeError) as e:
            logger.warning("跳过损坏的日程提醒 id=%s: %s", row.get("id"), e)
    for row in db.list_reminder_assignments():
        for off in offsets_sec:
            try:
                due_at = _parse(row["due_at"])
                fire_at = due_at - timedelta(seconds=off)
                if not _in_window(fire_at, now):
                    continue
                fire_str = fire_at.strftime(_TIME_FMT)
                last = db.last_fired_at("assignment", row["id"])
                if last is not None and fire_str < last:
                    continue  # 1. 过期抑制
                if db.was_fired("assignment", row["id"], off, fire_str):
                    continue  # 2. 精确去重
                due.append({
                    "kind": "assignment",
                    "ref_id": row["id"],
                    "offset_sec": off,
                    "title": row["title"],
                    "at": row["due_at"],
                    "fire_at": fire_str,
                })
            except (ValueError, TypeError) as e:
                logger.warning("跳过损坏的作业提醒 id=%s offset=%s: %s", row.get("id"), off, e)
    return due


def run_once(db, bus, offsets_sec: list, now: datetime | None = None) -> int:
    """执行一轮提醒检查：先标记 reminder_log 再 SSE 推送（at-most-once，推送丢失不重复补发）；返回触发数量。"""
    now = now or datetime.now()
    fired = 0
    for cand in collect_due(db, now, offsets_sec):
        db.mark_fired(cand["kind"], cand["ref_id"], cand["offset_sec"], cand["fire_at"])
        bus.publish("remind", {
            "kind": cand["kind"],
            "id": cand["ref_id"],
            "title": cand["title"],
            "at": cand["at"],
        })
        fired += 1
    return fired


def offsets_from_config(cfg: dict) -> list:
    """bb_remind_defaults（分钟）→ 去重后的秒列表；未启用或非法项跳过。"""
    if not cfg.get("bb_remind_enabled", True):
        return []
    out: list = []
    for m in cfg.get("bb_remind_defaults", []):
        try:
            sec = int(m) * 60
        except (TypeError, ValueError):
            continue
        if sec not in out:
            out.append(sec)
    return out

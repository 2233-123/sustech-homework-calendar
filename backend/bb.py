"""Blackboard Learn 客户端：会话管理（TTL / 401 自动重登）+ REST 接口 + 作业拉取。"""
from __future__ import annotations

import calendar
import logging
import threading
import time
from datetime import date, datetime

import requests

from backend import cas
from backend.cas import NetworkError

logger = logging.getLogger(__name__)

BB_BASE = "https://bb.sustech.edu.cn"
SESSION_TTL = 25 * 60
_TIMEOUT = 30


class SessionExpired(Exception):
    """会话失效且自动重登失败。"""


class BBSession:
    """内存会话：HTTP 层与登录函数可注入（测试用 FakeSession）。

    线程安全：所有请求经实例锁串行化，可跨线程（调度线程 + Flask 线程）共享。
    """

    def __init__(self, sid: str, password: str, *, http=None, login_fn=None,
                 clock=time.monotonic):
        self._sid = sid
        self._password = password
        self._http = http if http is not None else requests.Session()
        self._login_fn = login_fn or cas.login
        self._clock = clock
        self._lock = threading.Lock()
        self._cookies: dict = {}
        self._obtained_at = None

    def _login(self) -> None:
        sess = requests.Session()
        self._cookies = self._login_fn(self._sid, self._password, session=sess)
        if not self._cookies:
            raise NetworkError("CAS 登录未返回有效 Cookie")
        self._obtained_at = self._clock()

    def _expired(self) -> bool:
        return self._obtained_at is None or (self._clock() - self._obtained_at) > SESSION_TTL

    def _ensure(self) -> None:
        if not self._cookies or self._expired():
            self._login()

    def get(self, path: str, params: dict | None = None):
        with self._lock:
            self._ensure()
            url = path if path.startswith("http") else BB_BASE + path
            r = None
            for _ in range(2):
                try:
                    r = self._http.get(
                        url,
                        params=params,
                        headers={"User-Agent": cas.UA},
                        cookies=dict(self._cookies),
                        timeout=_TIMEOUT,
                    )
                except requests.RequestException as e:
                    raise NetworkError(f"Blackboard 请求失败：{path}") from e
                if r.status_code != 401:
                    return r
                self._login()  # 401 → 强制重登后再试一次
            return r

    def get_json(self, path: str, params: dict | None = None):
        r = self.get(path, params)
        if r.status_code == 401:
            raise SessionExpired(f"会话失效且重登失败：{path}")
        if r.status_code != 200:
            raise NetworkError(
                f"Blackboard 接口错误 HTTP {r.status_code}: {path}", status=r.status_code
            )
        try:
            return r.json()
        except ValueError as e:
            raise NetworkError(f"Blackboard 返回非 JSON 响应：{path}") from e


def normalize_bb_id(bb_id: str) -> str:
    """BB 资源 ID 规范化：'_8343_1' → '8343'。"""
    return bb_id.strip().lstrip("_").removesuffix("_1")


def utc_iso_to_local_iso(due_utc: str | None) -> str | None:
    """BB 的 UTC ISO 时间 → 本地 'YYYY-MM-DDTHH:MM:SS'；空值或无法解析返回 None。"""
    if not due_utc:
        return None
    try:
        dt = datetime.fromisoformat(due_utc.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt.astimezone().strftime("%Y-%m-%dT%H:%M:%S")


def get_uid(bb: "BBSession") -> str:
    """当前登录用户 id（用于后续 users/{uid}/courses）。"""
    return bb.get_json("/learn/api/public/v1/users/me")["id"]


def get_courses(bb: "BBSession") -> list:
    """在修课程列表 → [{'id': 原始ID, 'name': 课程名}]。"""
    uid = get_uid(bb)
    data = bb.get_json(f"/learn/api/public/v1/users/{uid}/courses")
    courses = []
    for entry in data.get("results", []):
        cid = entry.get("courseId") or ""
        if not cid:
            continue
        try:
            detail = bb.get_json(f"/learn/api/public/v1/courses/{cid}")
            name = detail.get("name") or cid
        except NetworkError:
            name = cid
        courses.append({"id": cid, "name": name})
    return courses


def get_assignment_columns(bb: "BBSession", course_id: str) -> list:
    """课程的作业型评分列（grading.type == 'Attempts'，带截止时间）。"""
    data = bb.get_json(
        f"/learn/api/public/v1/courses/{course_id}/gradebook/columns",
        params={"_fields": "id,name,contentId,score,grading"},
    )
    out = []
    for col in data.get("results", []):
        grading = col.get("grading") or {}
        if grading.get("type") != "Attempts":
            continue
        score_obj = col.get("score")
        out.append({
            "column_id": col.get("id", ""),
            "title": col.get("name", ""),
            "content_id": col.get("contentId") or "",
            "due_utc": grading.get("due") or "",
            "possible": score_obj.get("possible") if isinstance(score_obj, dict) else None,
        })
    return out


def get_attempts(bb: "BBSession", course_id: str, column_id: str) -> list:
    """某评分列的提交尝试列表（空列表 = 未提交；取最新一次判断状态/分数）。"""
    data = bb.get_json(
        f"/learn/api/public/v1/courses/{course_id}/gradebook/columns/{column_id}/attempts"
    )
    return data.get("results", [])


def subtract_months(d: date, months: int) -> date:
    """自然月减法（月末钳制）：2026-03-31 − 1 月 → 2026-02-28；2024-03-31 − 1 月 → 2024-02-29。"""
    total = d.year * 12 + (d.month - 1) - months
    year, month0 = divmod(total, 12)
    month = month0 + 1
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, min(d.day, last_day))


def pull_cutoff(months: int, today: date | None = None) -> str | None:
    """拉取窗口下界（本地日期 'YYYY-MM-DD'）：今天 − months 个自然月；months<=0 → None（不限）。"""
    try:
        m = int(months)
    except (TypeError, ValueError):
        m = 1
    if m <= 0:
        return None
    return subtract_months(today or date.today(), m).isoformat()


def content_visible(bb: "BBSession", course_id: str, content_id: str) -> bool:
    """内容可见性甄别（可用性而非班级启发式）。

    403（含"别的班"内容）/ 404（已删除或不存在）→ 不可见；
    其余（5xx / 网络错误 / 非 JSON / 401 等）→ **fail-open 保留**，避免瞬时故障误删数据。
    """
    try:
        bb.get_json(f"/learn/api/public/v1/courses/{course_id}/contents/{content_id}")
        return True
    except NetworkError as e:
        return e.status not in (403, 404)
    except SessionExpired:
        return True  # 会话问题不属于"内容不可见"，交由后续 attempts 决定


def fetch_assignments(bb: "BBSession", pull_months: int = 1) -> list:
    """拉取所有课程作业并归一化；单课程失败不影响其它课程。

    三层过滤（全部在取 attempts 之前完成，被丢弃的列不发起 attempts/content 请求）：
    ① 仅 Attempts 型评分列（`get_assignment_columns` 已滤，含截止时间字段）；
    ② 无截止时间 → 丢弃（上游补 due 后下次同步会自动重新拉取）；
    ③ 截止时间早于「今天 − pull_months 个自然月」→ 丢弃（pull_months<=0 不限）；
    ④ 带 contentId 的列做内容可见性甄别：403/404 丢弃，其余 fail-open 保留。
    """
    cutoff = pull_cutoff(pull_months)
    records = []
    for course in get_courses(bb):
        try:
            for col in get_assignment_columns(bb, course["id"]):
                due_at = utc_iso_to_local_iso(col["due_utc"])
                if not due_at:
                    continue  # ② 无截止时间
                if cutoff is not None and due_at[:10] < cutoff:
                    continue  # ③ 早于拉取窗口
                if col["content_id"] and not content_visible(bb, course["id"], col["content_id"]):
                    continue  # ④ 内容此刻不可见（403/404）
                attempts = get_attempts(bb, course["id"], col["column_id"])
                latest = max(attempts, key=lambda a: a.get("created", "")) if attempts else None
                records.append({
                    "course_id": normalize_bb_id(course["id"]),
                    "course_name": course["name"],
                    "content_id": normalize_bb_id(col["content_id"] or col["column_id"]),
                    "title": col["title"],
                    "due_at": due_at,
                    "submitted": 1 if attempts else 0,
                    "status": (latest or {}).get("status"),
                    "score": (latest or {}).get("score"),
                    "possible": col["possible"],
                })
        except (SessionExpired, NetworkError, KeyError, TypeError, AttributeError, ValueError) as e:
            logger.warning("跳过课程 %s: %s", course["id"], e)
            continue
    return records

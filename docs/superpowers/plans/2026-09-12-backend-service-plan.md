# 作业日程小组件 — 后端服务层实施计划（阶段 2/4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已完成的存储/网络基础层之上，实现可独立运行的本地后端服务：提醒调度（30 秒 tick + 24h 补发）、SSE 事件推送、认证/同步编排（含凭据静默登录）、Flask REST API（设计文档 §6.5 全量路由）与启动装配。

**Architecture:** `backend/` 包新增 5 个模块（events / reminder / service / app / main）并对既有 3 个模块做小幅硬化（db 计数与清理、cas 重试、bb 线程锁与日志）。所有网络与时钟均可注入，测试全程离线（Fake 会话 / 伪造 fetch / Flask test client）。

**Tech Stack:** Python 3.11（venv 已就绪）、Flask 3.1、sqlite3、threading、SSE（`text/event-stream`）。

**参考文档:** 设计案 `docs/superpowers/specs/2026-09-12-作业日程小组件-design.md`（§5.2、§6.4、§6.5、§7、§11）。

---

## 0. 执行环境与约定

- 仓库根目录：`E:\Desktop\作业日程`（所有命令在此执行）
- 当前分支：`feature/backend-service`（已从 master 创建；master 含阶段 1 全部 12 个提交）
- Python：一律使用 `.\.venv\Scripts\python`（3.11.9 + pytest 9.1.1）
- **全部测试必须离线运行**
- 当前测试基线：**49 passed**；本阶段结束应为 **91 passed**
- 每个 Task 一个 commit（用户已授权）；提交信息用中文
- ⚠️ **有意的接口变更**（现有测试均未断言旧行为，安全）：
  - `db.upsert_assignments` 返回值 `len(records)` → `(added, updated)` 元组（设计 §6.2 SyncResult 需要）
  - `cas.login` 增加 `attempts=2` 重试参数（默认兼容）
  - `bb.BBSession` 内部加锁（公开接口不变）
- ⚠️ 不触碰 `docs\`、`.omo\`；只提交任务列出的文件
- ⚠️ 不得改名既有函数/参数；实现若与计划有等价微调，需在报告中说明

## 0.1 覆盖来源（阶段 1 最终审查要点 → 任务映射）

| 审查要点 | 落入任务 |
|---|---|
| `upsert_assignments` 无 新增/更新计数 | Task 1 |
| 无过期作业清理路径（幽灵截止） | Task 1 |
| `bb_remind_defaults`（分钟）vs `offset_sec`（秒）单位差异 | Task 3 `offsets_from_config` |
| CAS 缺重试（设计 §4.1：重试 2 次） | Task 4 |
| `BBSession` 线程锁（TODO 落地） | Task 4 |
| `print` → `logging` | Task 4 |
| 同步异常映射契约 | Task 5 / Task 6 |
| 全局单例 `Database`（勿按线程建连接） | Task 7 |
| 无 due 作业不进日历——有意决策（日历按日期键控） | Task 6 注释 |

## 0.2 文件结构（阶段完成后）

```
backend/
├── cas.py               （修改：重试）
├── bb.py                （修改：线程锁 + logging）
├── db.py                （修改：计数/清理/提醒查询）
├── events.py            （新增：SSE 事件总线）
├── reminder.py          （新增：候选/去重/补发）
├── service.py           （新增：认证与同步编排）
├── app.py               （新增：Flask API + SSE）
├── main.py              （新增：启动装配/端口/线程）
└── tests/
    ├── service_fakes.py        （新增）
    ├── test_db.py              （追加 5）
    ├── test_events.py          （新增 5）
    ├── test_reminder.py        （新增 8）
    ├── test_cas.py             （追加 1）
    ├── test_service.py         （新增 9）
    ├── test_app.py             （新增 10）
    └── test_main.py            （新增 4）
```

**测试计数**：T1→54，T2→59，T3→67，T4→68，T5→77，T6→87，T7→91。

> ⚠️ 实际计数修正（T1 质量评审后追加 2 个用例）：基线 56；后续里程碑：T2→61，T3→69，T4→70，T5→79，T6→89，T7→93。

---

### Task 1: db.py 扩展 — 同步计数 / 过期清理 / 提醒查询

**Files:**
- Modify: `backend/db.py`
- Modify: `backend/tests/test_db.py`

- [ ] **Step 1: 追加失败测试** — 在 `backend/tests/test_db.py` 末尾追加：

```python
def test_upsert_assignments_reports_added_and_updated(tmp_path):
    d = make_db(tmp_path)
    rec = {
        "course_id": "1", "course_name": "X", "content_id": "2", "title": "作业A",
        "due_at": "2026-09-20T23:59:00", "submitted": 0, "status": None, "score": None, "possible": 100,
    }
    assert d.upsert_assignments([rec]) == (1, 0)
    assert d.upsert_assignments([dict(rec, title="作业A改")]) == (0, 1)
    assert d.upsert_assignments([rec, {
        "course_id": "9", "course_name": "Y", "content_id": "8", "title": "作业B",
        "due_at": "2026-09-21T23:59:00", "submitted": 0, "status": None, "score": None, "possible": 50,
    }]) == (1, 1)


def test_purge_assignments_synced_before_removes_stale(tmp_path):
    d = make_db(tmp_path)
    d.upsert_assignments([{
        "course_id": "1", "course_name": "X", "content_id": "2", "title": "旧作业",
        "due_at": "2026-09-20T23:59:00", "submitted": 0, "status": None, "score": None, "possible": 100,
    }])
    assert d.purge_assignments_synced_before("9999-01-01T00:00:00") == 1
    assert d.list_assignments("2020-01-01T00:00:00", "2030-01-01T00:00:00") == []


def test_purge_assignments_synced_before_keeps_fresh(tmp_path):
    d = make_db(tmp_path)
    d.upsert_assignments([{
        "course_id": "1", "course_name": "X", "content_id": "2", "title": "新作业",
        "due_at": "2026-09-20T23:59:00", "submitted": 0, "status": None, "score": None, "possible": 100,
    }])
    assert d.purge_assignments_synced_before("2000-01-01T00:00:00") == 0


def test_list_pending_schedules_filters_remind_before(tmp_path):
    d = make_db(tmp_path)
    d.add_schedule(title="有提醒", start_at="2026-09-12T14:00:00", remind_before=1800)
    d.add_schedule(title="无提醒", start_at="2026-09-12T15:00:00")
    rows = d.list_pending_schedules()
    assert [r["title"] for r in rows] == ["有提醒"]


def test_list_reminder_assignments_filters_due(tmp_path):
    d = make_db(tmp_path)
    d.upsert_assignments([
        {"course_id": "1", "course_name": "X", "content_id": "2", "title": "有截止",
         "due_at": "2026-09-20T23:59:00", "submitted": 0, "status": None, "score": None, "possible": 100},
        {"course_id": "1", "course_name": "X", "content_id": "3", "title": "无截止",
         "due_at": None, "submitted": 0, "status": None, "score": None, "possible": 100},
    ])
    rows = d.list_reminder_assignments()
    assert [r["title"] for r in rows] == ["有截止"]
```

- [ ] **Step 2: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_db.py -v
```

Expected: **5 个新用例全部失败，7 个旧用例通过**（purge/list 方法不存在 → AttributeError；upsert 返回 int 而非元组 → 断言失败）。

- [ ] **Step 3: 修改 `backend/db.py`**

(3a) 整体替换 `upsert_assignments` 方法（增加计数 + 保留回滚）：

```python
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
                    if (rec["course_id"], rec["content_id"]) not in existing:
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
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise
        return added, len(records) - added
```

(3b) 在 `list_assignments` 方法之后追加三个新方法：

```python
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
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_db.py -v   # 预期 12 passed
.\.venv\Scripts\python -m pytest                                # 预期 54 passed
```

- [ ] **Step 5: 提交**

```powershell
git add backend/db.py backend/tests/test_db.py
git commit -m "feat: 数据层扩展（同步计数/过期清理/提醒查询）"
```

---

### Task 2: events.py — SSE 事件总线

**Files:**
- Create: `backend/events.py`
- Test: `backend/tests/test_events.py`

- [ ] **Step 1: 写失败测试** — `backend/tests/test_events.py`：

```python
from backend.events import EventBus


def test_publish_reaches_subscriber():
    bus = EventBus()
    q = bus.subscribe()
    bus.publish("remind", {"id": 1, "title": "小组会议"})
    msg = q.get_nowait()
    assert msg.startswith("event: remind\n")
    assert '"id": 1' in msg
    assert msg.endswith("\n\n")


def test_publish_without_subscribers_is_noop():
    EventBus().publish("x", {"a": 1})  # 不应抛异常


def test_unsubscribe_stops_delivery():
    bus = EventBus()
    q = bus.subscribe()
    bus.unsubscribe(q)
    bus.publish("x", {})
    assert q.empty()


def test_stream_yields_event_then_heartbeat():
    bus = EventBus()
    gen = bus.stream(heartbeat=0.05)
    assert next(gen) == ": connected\n\n"
    bus.publish("sync_done", {"added": 1})
    assert next(gen).startswith("event: sync_done\n")
    assert next(gen) == ": heartbeat\n\n"
    gen.close()


def test_slow_subscriber_does_not_block_publish():
    bus = EventBus(max_queue=1)
    q = bus.subscribe()
    bus.publish("a", {})
    bus.publish("b", {})  # 队列已满：静默丢弃，不阻塞
    assert q.qsize() == 1
```

- [ ] **Step 2: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_events.py
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'backend.events'`

- [ ] **Step 3: 写实现** — `backend/events.py`：

```python
"""SSE 事件总线：进程内发布/订阅，供 Flask SSE 端点使用。"""
from __future__ import annotations

import json
import queue
import threading


class EventBus:
    def __init__(self, max_queue: int = 100):
        self._lock = threading.Lock()
        self._subscribers: list = []
        self._max_queue = max_queue

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=self._max_queue)
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def publish(self, event: str, data: dict) -> None:
        """向所有订阅者广播一条 SSE 事件（某订阅者队列满则丢弃其本条）。"""
        payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass

    def stream(self, heartbeat: float = 15.0):
        """SSE 生成器：推送事件 + 周期心跳；生成器关闭时自动退订。"""
        q = self.subscribe()
        try:
            yield ": connected\n\n"
            while True:
                try:
                    yield q.get(timeout=heartbeat)
                except queue.Empty:
                    yield ": heartbeat\n\n"
        finally:
            self.unsubscribe(q)
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_events.py -v   # 预期 5 passed
.\.venv\Scripts\python -m pytest                                    # 预期 59 passed
```

- [ ] **Step 5: 提交**

```powershell
git add backend/events.py backend/tests/test_events.py
git commit -m "feat: SSE 事件总线"
```

---

### Task 3: reminder.py — 提醒候选 / 去重 / 24h 补发

**Files:**
- Create: `backend/reminder.py`
- Test: `backend/tests/test_reminder.py`

- [ ] **Step 1: 写失败测试** — `backend/tests/test_reminder.py`：

```python
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
```

- [ ] **Step 2: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_reminder.py
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'backend.reminder'`

- [ ] **Step 3: 写实现** — `backend/reminder.py`：

```python
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
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_reminder.py -v   # 预期 8 passed
.\.venv\Scripts\python -m pytest                                      # 预期 67 passed
```

- [ ] **Step 5: 提交**

```powershell
git add backend/reminder.py backend/tests/test_reminder.py
git commit -m "feat: 提醒调度（去重/补发窗口）"
```

---

### Task 4: 硬化 — cas 重试 / bb 线程锁 / print→logging

**Files:**
- Modify: `backend/cas.py`（整体替换）
- Modify: `backend/bb.py`（三处小改）
- Modify: `backend/tests/test_cas.py`（追加 1 个用例）

- [ ] **Step 1: 追加失败测试** — 在 `backend/tests/test_cas.py` 末尾追加：

```python
def test_login_retries_once_on_network_error():
    calls = []

    class FlakySession(FakeSession):
        def get(self, url, **kwargs):
            calls.append("get")
            if len(calls) == 1:
                raise requests.exceptions.Timeout("boom")
            return super().get(url, **kwargs)

    sess = FlakySession(
        responses=[
            FakeResponse(200, text=LOGIN_PAGE),
            FakeResponse(302, headers={"Location": "https://cas.sustech.edu.cn/cas/login?ticket=ST-9"}),
            FakeResponse(200, text="ok"),
        ],
        cookies={"JSESSIONID": "abc"},
    )
    cookies = cas.login("12345", "pwd", session=sess)
    assert cookies == {"JSESSIONID": "abc"}
    assert len(calls) == 3  # 第 1 次超时 + 重试后的 2 次 GET（登录页 + ticket 交换）
```

- [ ] **Step 2: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_cas.py
```

Expected: FAIL —— 当前实现不重试，首次超时即抛 `NetworkError`。

- [ ] **Step 3: 整体替换 `backend/cas.py`**（拆出 `_login_once`，外层加重试；错误语义不变）：

```python
"""SUSTech CAS 登录（纯 requests 三步流程，禁止浏览器自动化）。

流程：
1. GET  https://cas.sustech.edu.cn/cas/login?service=<编码后的 SERVICE_URL>
     → 正则提取隐藏字段 execution
2. POST 同一 URL（allow_redirects=False）表单：
     username / password / execution / _eventId=submit / submit=提交
     → 期望 302/303；Location 含 cas 且无 ticket ⇒ 账号密码错误
3. GET  Location（跟随重定向）→ 收集 cookie jar

requests 网络异常（连接失败/超时）自动重试，默认最多尝试 2 次。
"""
from __future__ import annotations

import re
from urllib.parse import quote

import requests

CAS_BASE = "https://cas.sustech.edu.cn/cas/login"
BB_SERVICE_URL = "https://bb.sustech.edu.cn/webapps/bb-sso-BBLEARN/index.jsp"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
TIMEOUT = 30
_EXECUTION_RE = re.compile(r'name="execution"[^>]*value="([^"]+)"')


class InvalidCredentials(Exception):
    """账号或密码错误。"""


class NetworkError(Exception):
    """网络不可达（含校外 / 断网 / 服务异常）。"""


def login(sid: str, password: str, session=None, timeout: int = TIMEOUT,
          attempts: int = 2) -> dict:
    """执行 CAS 登录（requests 网络异常最多尝试 attempts 次），成功返回 cookie 字典。"""
    last_error: Exception | None = None
    for _ in range(max(1, attempts)):
        try:
            return _login_once(sid, password, session=session, timeout=timeout)
        except requests.RequestException as e:
            last_error = e
    raise NetworkError(f"网络请求失败（已重试）：{last_error}") from last_error


def _login_once(sid: str, password: str, session=None, timeout: int = TIMEOUT) -> dict:
    sess = session if session is not None else requests.Session()
    cas_url = f"{CAS_BASE}?service={quote(BB_SERVICE_URL, safe='')}"
    headers = {"User-Agent": UA}

    r = sess.get(cas_url, headers=headers, timeout=timeout)
    m = _EXECUTION_RE.search(r.text)
    if not m:
        raise NetworkError("CAS 登录页异常：未找到 execution 令牌")
    r2 = sess.post(
        cas_url,
        data={
            "username": sid,
            "password": password,
            "execution": m.group(1),
            "_eventId": "submit",
            "submit": "提交",
        },
        headers=headers,
        timeout=timeout,
        allow_redirects=False,
    )

    if r2.status_code not in (302, 303):
        raise NetworkError(f"CAS 响应异常：HTTP {r2.status_code}")

    loc = r2.headers.get("Location", "")
    if not loc:
        raise NetworkError("CAS 响应缺少 Location 头")
    if "cas.sustech.edu.cn" in loc and "ticket" not in loc:
        raise InvalidCredentials("CAS 拒绝了凭据：账号或密码错误")

    sess.get(loc, headers=headers, timeout=timeout, allow_redirects=True)
    return {c.name: c.value for c in sess.cookies if c.value}
```

- [ ] **Step 4: 修改 `backend/bb.py`（三处，其余不动）**

(4a) import 区替换为：

```python
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime

import requests

from backend import cas
from backend.cas import NetworkError

logger = logging.getLogger(__name__)
```

(4b) `BBSession` 类 docstring 替换为（去掉 TODO，说明锁语义）：

```python
    """内存会话：HTTP 层与登录函数可注入（测试用 FakeSession）。

    线程安全：所有请求经实例锁串行化，可跨线程（调度线程 + Flask 线程）共享。
    """
```

(4c) `__init__` 中 `self._clock = clock` 之后加一行：

```python
        self._lock = threading.Lock()
```

(4d) `get` 方法整体替换（`_ensure` 与请求循环都入锁）：

```python
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
```

(4e) `fetch_assignments` 中 `print(...)` 一行替换为：

```python
            logger.warning("跳过课程 %s: %s", course["id"], e)
```

- [ ] **Step 5: 运行确认通过 + 全量回归**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_cas.py -v   # 预期 11 passed
.\.venv\Scripts\python -m pytest backend/tests/test_bb.py       # 预期 20 passed（回归）
.\.venv\Scripts\python -m pytest                                # 预期 68 passed
```

- [ ] **Step 6: 提交**

```powershell
git add backend/cas.py backend/bb.py backend/tests/test_cas.py
git commit -m "refactor: CAS 重试与 BBSession 线程锁"
```

---

### Task 5: service.py — 认证与同步编排

**Files:**
- Create: `backend/service.py`
- Create: `backend/tests/service_fakes.py`
- Test: `backend/tests/test_service.py`

- [ ] **Step 1: 写测试替身** — `backend/tests/service_fakes.py`：

```python
"""服务层测试替身。"""
from __future__ import annotations

from backend.db import Database
from backend.events import EventBus
from backend.service import Service


class FakeBBSession:
    """最小化 BBSession 替身：get_json 返回固定 uid。"""

    def __init__(self, sid: str, password: str):
        self.sid = sid
        self.password = password

    def get_json(self, path, params=None):
        return {"id": "_1_1"}


def failing_session_factory(exc: Exception):
    class _Failing(FakeBBSession):
        def get_json(self, path, params=None):
            raise exc

    return _Failing


def make_service(tmp_path, monkeypatch, *, fetch_fn=None, session_factory=None):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db = Database(tmp_path / "service.db")
    bus = EventBus()
    svc = Service(
        db,
        bus,
        session_factory=session_factory or FakeBBSession,
        fetch_fn=fetch_fn or (lambda session: []),
    )
    return svc, db, bus
```

- [ ] **Step 2: 写失败测试** — `backend/tests/test_service.py`：

```python
import pytest

from backend.cas import InvalidCredentials, NetworkError
from backend.service import (
    LOGIN_FAILED,
    LOGIN_NEED,
    LOGIN_OK,
    NotAuthenticated,
    Service,
    SyncInProgress,
)
from backend.tests.service_fakes import (
    FakeBBSession,
    failing_session_factory,
    make_service,
)


def test_login_success_saves_credentials(tmp_path, monkeypatch):
    svc, db, bus = make_service(tmp_path, monkeypatch)
    assert svc.login("20231234", "pw", remember=True) is True
    assert svc.login_state == LOGIN_OK
    assert svc.load_credentials() == ("20231234", "pw")


def test_login_invalid_credentials_sets_failed(tmp_path, monkeypatch):
    svc, db, bus = make_service(
        tmp_path, monkeypatch,
        session_factory=failing_session_factory(InvalidCredentials("bad")),
    )
    q = bus.subscribe()
    assert svc.login("u", "wrong", remember=False) is False
    assert svc.login_state == LOGIN_FAILED
    assert svc.load_credentials() is None
    assert "login_changed" in q.get_nowait()


def test_silent_login_uses_saved_credentials(tmp_path, monkeypatch):
    svc, db, bus = make_service(tmp_path, monkeypatch)
    svc.save_credentials("u", "p")
    svc2 = Service(db, bus, session_factory=FakeBBSession, fetch_fn=lambda s: [])
    assert svc2.try_silent_login() is True
    assert svc2.login_state == LOGIN_OK


def test_silent_login_without_credentials(tmp_path, monkeypatch):
    svc, db, bus = make_service(tmp_path, monkeypatch)
    assert svc.try_silent_login() is False
    assert svc.login_state == LOGIN_NEED


def test_sync_now_upserts_publishes_and_returns_counts(tmp_path, monkeypatch):
    records = [{
        "course_id": "1", "course_name": "OS", "content_id": "2", "title": "实验1",
        "due_at": "2026-09-20T23:59:00", "submitted": 0, "status": None, "score": None, "possible": 100,
    }]
    svc, db, bus = make_service(tmp_path, monkeypatch, fetch_fn=lambda session: records)
    svc.login("u", "p", remember=False)
    q = bus.subscribe()
    result = svc.sync_now()
    assert (result["added"], result["updated"]) == (1, 0)
    assert result["at"] is not None
    assert db.list_assignments("2026-09-01T00:00:00", "2026-10-01T00:00:00")[0]["title"] == "实验1"
    second = svc.sync_now()
    assert (second["added"], second["updated"]) == (0, 1)
    msgs = []
    while not q.empty():
        msgs.append(q.get_nowait())
    assert any("sync_done" in m for m in msgs)


def test_sync_now_offline_sets_flag_and_event(tmp_path, monkeypatch):
    def boom(session):
        raise NetworkError("down")

    svc, db, bus = make_service(tmp_path, monkeypatch, fetch_fn=boom)
    svc.login("u", "p", remember=False)
    q = bus.subscribe()
    with pytest.raises(NetworkError):
        svc.sync_now()
    assert svc.state()["offline"] is True
    assert "offline" in q.get_nowait()


def test_sync_now_requires_login(tmp_path, monkeypatch):
    svc, db, bus = make_service(tmp_path, monkeypatch)
    with pytest.raises(NotAuthenticated):
        svc.sync_now()


def test_sync_now_rejects_concurrent_sync(tmp_path, monkeypatch):
    svc, db, bus = make_service(tmp_path, monkeypatch)
    svc.login("u", "p", remember=False)
    svc._sync_lock.acquire()
    try:
        with pytest.raises(SyncInProgress):
            svc.sync_now()
    finally:
        svc._sync_lock.release()


def test_logout_clears_session_and_optional_credentials(tmp_path, monkeypatch):
    svc, db, bus = make_service(tmp_path, monkeypatch)
    svc.login("u", "p", remember=True)
    svc.logout(clear_saved=True)
    assert svc.login_state == LOGIN_NEED
    assert svc.load_credentials() is None
    with pytest.raises(NotAuthenticated):
        svc.sync_now()
```

- [ ] **Step 3: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_service.py
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'backend.service'`

- [ ] **Step 4: 写实现** — `backend/service.py`：

```python
"""服务层：认证状态机、凭据管理、同步编排。"""
from __future__ import annotations

import threading
from datetime import datetime

from backend import bb, config, dpapi
from backend.cas import InvalidCredentials, NetworkError

LOGIN_OK = "ok"
LOGIN_NEED = "need_login"
LOGIN_FAILED = "failed"


class NotAuthenticated(Exception):
    """尚未登录。"""


class SyncInProgress(Exception):
    """已有同步在进行。"""


class Service:
    """应用服务：线程安全地管理认证会话与同步。"""

    def __init__(self, db, bus, *, session_factory=None, fetch_fn=None, creds_path=None):
        self.db = db
        self.bus = bus
        self._session_factory = session_factory or bb.BBSession
        self._fetch_fn = fetch_fn or bb.fetch_assignments
        self._creds_path = creds_path or config.credentials_path()
        self._session = None
        self._session_lock = threading.Lock()
        self._sync_lock = threading.Lock()
        self._login_state = LOGIN_NEED
        self._last_sync = None
        self._offline = False

    # ---------- 凭据 ----------
    def load_credentials(self):
        p = self._creds_path
        if not p.exists():
            return None
        try:
            raw = dpapi.unprotect(p.read_bytes()).decode("utf-8")
        except (OSError, UnicodeDecodeError):
            return None
        if ":" not in raw:
            return None
        sid, _, password = raw.partition(":")
        return sid, password

    def save_credentials(self, sid: str, password: str) -> None:
        blob = dpapi.protect(f"{sid}:{password}".encode("utf-8"))
        self._creds_path.write_bytes(blob)

    def clear_credentials(self) -> None:
        try:
            self._creds_path.unlink(missing_ok=True)
        except OSError:
            pass

    # ---------- 认证 ----------
    @property
    def login_state(self) -> str:
        return self._login_state

    def is_authenticated(self) -> bool:
        return self._session is not None and self._login_state == LOGIN_OK

    def login(self, sid: str, password: str, remember: bool = True) -> bool:
        ok = self._login_with(sid, password)
        if ok and remember:
            self.save_credentials(sid, password)
        return ok

    def try_silent_login(self) -> bool:
        creds = self.load_credentials()
        if creds is None:
            self._set_login_state(LOGIN_NEED)
            return False
        try:
            return self._login_with(*creds)
        except NetworkError:
            self.bus.publish("error", {"code": "offline", "message": "网络不可达，无法静默登录"})
            return False

    def logout(self, clear_saved: bool = False) -> None:
        with self._session_lock:
            self._session = None
        if clear_saved:
            self.clear_credentials()
        self._set_login_state(LOGIN_NEED)

    def _login_with(self, sid: str, password: str) -> bool:
        session = self._session_factory(sid, password)
        try:
            bb.get_uid(session)
        except InvalidCredentials:
            self._set_login_state(LOGIN_FAILED)
            return False
        with self._session_lock:
            self._session = session
        self._set_login_state(LOGIN_OK)
        return True

    def _set_login_state(self, state: str) -> None:
        self._login_state = state
        self.bus.publish("login_changed", {"state": state})

    def _require_session(self):
        with self._session_lock:
            session = self._session
        if session is None:
            raise NotAuthenticated("尚未登录")
        return session

    # ---------- 同步 ----------
    def sync_now(self) -> dict:
        """执行一次全量同步；返回 {added, updated, removed, at}。"""
        if not self._sync_lock.acquire(blocking=False):
            raise SyncInProgress("同步进行中")
        try:
            session = self._require_session()
            started = datetime.now().isoformat(timespec="seconds")
            records = self._fetch_fn(session)
            added, updated = self.db.upsert_assignments(records)
            removed = self.db.purge_assignments_synced_before(started)
            at = datetime.now().isoformat(timespec="seconds")
            self._last_sync = at
            self._offline = False
            result = {"added": added, "updated": updated, "removed": removed, "at": at}
            self.bus.publish("sync_done", result)
            return result
        except NetworkError:
            self._offline = True
            self.bus.publish("error", {"code": "offline", "message": "网络不可达"})
            raise
        except bb.SessionExpired:
            self._set_login_state(LOGIN_NEED)
            raise
        except InvalidCredentials:
            self._set_login_state(LOGIN_FAILED)
            raise
        finally:
            self._sync_lock.release()

    def state(self) -> dict:
        return {
            "login": self._login_state,
            "syncing": self._sync_lock.locked(),
            "last_sync": self._last_sync,
            "offline": self._offline,
        }
```

- [ ] **Step 5: 运行确认通过 + 全量回归**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_service.py -v   # 预期 9 passed
.\.venv\Scripts\python -m pytest                                     # 预期 77 passed
```

- [ ] **Step 6: 提交**

```powershell
git add backend/service.py backend/tests/service_fakes.py backend/tests/test_service.py
git commit -m "feat: 服务编排（认证/凭据/同步）"
```

---

### Task 6: app.py — Flask API + SSE + 静态托管

**Files:**
- Create: `backend/app.py`
- Test: `backend/tests/test_app.py`

- [ ] **Step 1: 写失败测试** — `backend/tests/test_app.py`：

```python
from backend.app import create_app
from backend.cas import InvalidCredentials
from backend.tests.service_fakes import failing_session_factory, make_service


def make_client(tmp_path, monkeypatch, *, fetch_fn=None, session_factory=None):
    svc, db, bus = make_service(
        tmp_path, monkeypatch, fetch_fn=fetch_fn, session_factory=session_factory
    )
    app = create_app(svc, bus, frontend_dir=tmp_path / "no_frontend")
    app.testing = True
    return app.test_client(), svc, db, bus


def _text(item):
    return item.decode("utf-8") if isinstance(item, bytes) else item


def test_state_endpoint(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.get("/api/state")
    assert rv.status_code == 200
    data = rv.get_json()
    assert data["login"] == "need_login"
    assert data["offline"] is False


def test_login_endpoint_ok(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.post("/api/auth/login", json={"sid": "u", "password": "p", "remember": False})
    assert rv.status_code == 200
    assert rv.get_json()["ok"] is True
    assert svc.login_state == "ok"


def test_login_endpoint_bad_request(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.post("/api/auth/login", json={"sid": "u"})
    assert rv.status_code == 400
    assert rv.get_json()["error"] == "bad_request"


def test_login_endpoint_invalid_credentials(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(
        tmp_path, monkeypatch,
        session_factory=failing_session_factory(InvalidCredentials("bad")),
    )
    rv = client.post("/api/auth/login", json={"sid": "u", "password": "wrong"})
    assert rv.status_code == 401
    assert rv.get_json()["error"] == "invalid_credentials"


def test_schedule_crud_flow(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.post("/api/schedule", json={
        "title": "小组会议", "start_at": "2026-09-12T14:00:00", "remind_before": 1800,
    })
    assert rv.status_code == 201
    sid = rv.get_json()["id"]
    rv = client.get("/api/day?date=2026-09-12")
    assert [s["title"] for s in rv.get_json()["schedules"]] == ["小组会议"]
    assert client.put(f"/api/schedule/{sid}", json={"title": "组会"}).status_code == 200
    rv = client.get("/api/day?date=2026-09-12")
    assert [s["title"] for s in rv.get_json()["schedules"]] == ["组会"]
    assert client.delete(f"/api/schedule/{sid}").status_code == 200
    assert client.delete(f"/api/schedule/{sid}").status_code == 404


def test_calendar_range(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    client.post("/api/schedule", json={"title": "本月", "start_at": "2026-09-12T10:00:00"})
    client.post("/api/schedule", json={"title": "下月", "start_at": "2026-10-03T10:00:00"})
    rv = client.get("/api/calendar?year=2026&month=9")
    assert [s["title"] for s in rv.get_json()["schedules"]] == ["本月"]


def test_settings_get_and_put(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.get("/api/settings")
    assert rv.get_json()["refresh_interval_min"] == 30
    rv = client.put("/api/settings", json={"refresh_interval_min": 5, "hacker": True})
    assert rv.status_code == 200
    data = rv.get_json()
    assert data["refresh_interval_min"] == 5
    assert "hacker" not in data


def test_sync_endpoint_auth_and_result(tmp_path, monkeypatch):
    records = [{
        "course_id": "1", "course_name": "OS", "content_id": "2", "title": "实验1",
        "due_at": "2026-09-20T23:59:00", "submitted": 0, "status": None, "score": None, "possible": 100,
    }]
    client, svc, db, bus = make_client(tmp_path, monkeypatch, fetch_fn=lambda s: records)
    rv = client.post("/api/sync")
    assert rv.status_code == 401
    assert rv.get_json()["error"] == "not_authenticated"
    client.post("/api/auth/login", json={"sid": "u", "password": "p", "remember": False})
    rv = client.post("/api/sync")
    assert rv.status_code == 200
    body = rv.get_json()
    assert body["ok"] is True and body["added"] == 1


def test_events_streams(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.get("/api/events")
    assert rv.status_code == 200
    assert rv.mimetype == "text/event-stream"
    it = iter(rv.response)
    assert _text(next(it)) == ": connected\n\n"
    bus.publish("sync_done", {"added": 1})
    assert "sync_done" in _text(next(it))
    it.close()


def test_root_placeholder(tmp_path, monkeypatch):
    client, svc, db, bus = make_client(tmp_path, monkeypatch)
    rv = client.get("/")
    assert rv.status_code == 200
    assert "后端运行中" in rv.get_data(as_text=True)
```

- [ ] **Step 2: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_app.py
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'backend.app'`

- [ ] **Step 3: 写实现** — `backend/app.py`：

```python
"""Flask 应用：REST API + SSE + 静态托管（设计文档 §6.5）。"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

from flask import Flask, Response, jsonify, request, stream_with_context

from backend import config
from backend.bb import SessionExpired
from backend.cas import InvalidCredentials, NetworkError
from backend.service import NotAuthenticated, SyncInProgress


def create_app(service, bus, *, frontend_dir=None) -> Flask:
    frontend = Path(frontend_dir) if frontend_dir else Path(__file__).resolve().parent.parent / "frontend"
    app = Flask(__name__, static_folder=str(frontend), static_url_path="")
    app.json.ensure_ascii = False
    app.config["FRONTEND_DIR"] = str(frontend)

    def _error(code: str, message: str, status: int):
        return jsonify({"error": code, "message": message}), status

    @app.get("/api/state")
    def api_state():
        return jsonify(service.state())

    @app.post("/api/auth/login")
    def api_login():
        body = request.get_json(silent=True) or {}
        sid = str(body.get("sid", "")).strip()
        password = str(body.get("password", ""))
        remember = bool(body.get("remember", False))
        if not sid or not password:
            return _error("bad_request", "缺少 sid 或 password", 400)
        try:
            ok = service.login(sid, password, remember=remember)
        except NetworkError as e:
            return _error("offline", str(e), 502)
        if not ok:
            return _error("invalid_credentials", "账号或密码错误", 401)
        return jsonify({"ok": True, "state": service.state()})

    @app.post("/api/auth/logout")
    def api_logout():
        body = request.get_json(silent=True) or {}
        service.logout(clear_saved=bool(body.get("clear_credentials", False)))
        return jsonify({"ok": True, "state": service.state()})

    @app.post("/api/sync")
    def api_sync():
        try:
            result = service.sync_now()
        except NotAuthenticated:
            return _error("not_authenticated", "尚未登录", 401)
        except SessionExpired:
            return _error("session_expired", "会话失效，请重新登录", 401)
        except InvalidCredentials:
            return _error("invalid_credentials", "凭据已失效", 401)
        except SyncInProgress:
            return _error("busy", "同步进行中", 409)
        except NetworkError as e:
            return _error("offline", str(e), 502)
        return jsonify({"ok": True, **result})

    @app.get("/api/calendar")
    def api_calendar():
        today = date.today()
        try:
            year = int(request.args.get("year", today.year))
            month = int(request.args.get("month", today.month))
            start = date(year, month, 1)
        except ValueError:
            return _error("bad_request", "year/month 非法", 400)
        end = date(year + (month == 12), month % 12 + 1, 1)
        start_s = f"{start.isoformat()}T00:00:00"
        end_s = f"{end.isoformat()}T00:00:00"
        # 注意：无截止时间的作业（due_at IS NULL）不会出现在日历上——有意设计（日历按日期键控）
        return jsonify({
            "schedules": service.db.list_schedules(start_s, end_s),
            "assignments": service.db.list_assignments(start_s, end_s),
        })

    @app.get("/api/day")
    def api_day():
        raw = request.args.get("date") or date.today().isoformat()
        try:
            day = date.fromisoformat(raw)
        except ValueError:
            return _error("bad_request", "date 格式应为 YYYY-MM-DD", 400)
        start_s = f"{day.isoformat()}T00:00:00"
        end_s = f"{(day + timedelta(days=1)).isoformat()}T00:00:00"
        return jsonify({
            "schedules": service.db.list_schedules(start_s, end_s),
            "assignments": service.db.list_assignments(start_s, end_s),
        })

    @app.post("/api/schedule")
    def api_schedule_create():
        body = request.get_json(silent=True) or {}
        title = str(body.get("title", "")).strip()
        start_at = str(body.get("start_at", ""))
        if not title or not start_at:
            return _error("bad_request", "缺少 title 或 start_at", 400)
        sid = service.db.add_schedule(
            title=title,
            start_at=start_at,
            end_at=body.get("end_at"),
            all_day=int(body.get("all_day", 0)),
            remind_before=body.get("remind_before"),
            note=body.get("note"),
            color=body.get("color"),
        )
        return jsonify({"ok": True, "id": sid}), 201

    @app.put("/api/schedule/<int:sid>")
    def api_schedule_update(sid):
        if service.db.get_schedule(sid) is None:
            return _error("not_found", "日程不存在", 404)
        body = request.get_json(silent=True) or {}
        service.db.update_schedule(sid, **body)
        return jsonify({"ok": True})

    @app.delete("/api/schedule/<int:sid>")
    def api_schedule_delete(sid):
        if service.db.get_schedule(sid) is None:
            return _error("not_found", "日程不存在", 404)
        service.db.delete_schedule(sid)
        return jsonify({"ok": True})

    @app.get("/api/settings")
    def api_settings_get():
        return jsonify(config.load_config())

    @app.put("/api/settings")
    def api_settings_put():
        body = request.get_json(silent=True) or {}
        cfg = config.load_config()
        cfg.update(body if isinstance(body, dict) else {})
        config.save_config(cfg)
        return jsonify(config.load_config())

    @app.get("/api/events")
    def api_events():
        return Response(
            stream_with_context(bus.stream()),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/")
    def index():
        candidate = Path(app.config["FRONTEND_DIR"]) / "index.html"
        if candidate.exists():
            return app.send_static_file("index.html")
        return "作业日程后端运行中", 200, {"Content-Type": "text/plain; charset=utf-8"}

    return app
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_app.py -v   # 预期 10 passed
.\.venv\Scripts\python -m pytest                                 # 预期 87 passed
```

> 说明：若 `test_events_streams` 因 Werkzeug 测试客户端缓冲而无法流式读取，请勿删弱测试——改用 `client.get("/api/events", buffered=False)` 或 `with client:` 上下文后重试，并在报告中说明调整。

- [ ] **Step 5: 提交**

```powershell
git add backend/app.py backend/tests/test_app.py
git commit -m "feat: Flask API 与 SSE 端点"
```

---

### Task 7: main.py — 启动装配 / 端口 / 后台线程

**Files:**
- Create: `backend/main.py`
- Test: `backend/tests/test_main.py`

- [ ] **Step 1: 写失败测试** — `backend/tests/test_main.py`：

```python
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
```

- [ ] **Step 2: 运行确认失败**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_main.py
```

Expected: FAIL —— `ModuleNotFoundError: No module named 'backend.main'`

- [ ] **Step 3: 写实现** — `backend/main.py`：

```python
"""启动装配：单例 Database、服务、后台线程与 HTTP 服务。

Electron 外壳通过 stdout 的 `PORT=<n>` 行获知实际端口。
"""
from __future__ import annotations

import logging
import socket
import threading
import time

from backend import config
from backend.app import create_app
from backend.db import Database
from backend.events import EventBus
from backend.reminder import offsets_from_config, run_once
from backend.service import Service

logger = logging.getLogger(__name__)

TICK_SEC = 30.0
REMINDER_TICK_SEC = 30.0


def pick_port() -> int:
    """选择一个空闲的本地端口。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_reminder_cycle(db, bus, cfg) -> int:
    """一轮提醒检查（供后台线程与测试调用）。"""
    return run_once(db, bus, offsets_from_config(cfg))


def run_sync_cycle(service) -> None:
    """一轮周期同步：未登录跳过；失败仅记日志（事件已在 service 内发布）。"""
    if not service.is_authenticated():
        return
    try:
        service.sync_now()
    except Exception as e:  # 后台线程不得因单次失败退出
        logger.warning("周期同步失败：%s", e)


def _sync_loop(service, stop: threading.Event, tick: float = TICK_SEC) -> None:
    last = time.monotonic()
    while not stop.wait(tick):
        interval = max(1, int(config.load_config().get("refresh_interval_min", 30))) * 60
        if time.monotonic() - last >= interval:
            last = time.monotonic()
            run_sync_cycle(service)


def _reminder_loop(db, bus, stop: threading.Event, tick: float = REMINDER_TICK_SEC) -> None:
    while not stop.wait(tick):
        try:
            run_reminder_cycle(db, bus, config.load_config())
        except Exception as e:
            logger.warning("提醒检查失败：%s", e)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    db = Database(config.db_path())  # 全局单例：勿按线程新建连接
    bus = EventBus()
    service = Service(db, bus)

    if service.try_silent_login():
        try:
            service.sync_now()
        except Exception as e:
            logger.warning("首次同步失败：%s", e)
    else:
        logger.info("未找到可用凭据，等待用户登录")

    stop = threading.Event()
    threading.Thread(target=_sync_loop, args=(service, stop), daemon=True, name="sync-loop").start()
    threading.Thread(
        target=_reminder_loop, args=(db, bus, stop), daemon=True, name="reminder-loop"
    ).start()

    cfg = config.load_config()
    port = int(cfg.get("port") or 0) or pick_port()
    app = create_app(service, bus)
    print(f"PORT={port}", flush=True)
    logger.info("后端启动：http://127.0.0.1:%d", port)
    app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

```powershell
.\.venv\Scripts\python -m pytest backend/tests/test_main.py -v   # 预期 4 passed
.\.venv\Scripts\python -m pytest                                  # 预期 91 passed
```

- [ ] **Step 5: 手动冒烟（离线安全）** — 启动真实服务并请求 `/api/state`：

```powershell
$out = "$env:TEMP\hw_backend_out.txt"
$p = Start-Process -FilePath ".\.venv\Scripts\python" -ArgumentList "-m","backend.main" -PassThru -RedirectStandardOutput $out -WindowStyle Hidden
Start-Sleep -Seconds 4
$port = (Select-String -Path $out -Pattern "^PORT=(\d+)" | Select-Object -First 1).Matches.Groups[1].Value
"port=$port"
Invoke-RestMethod "http://127.0.0.1:$port/api/state" | ConvertTo-Json -Compress
Stop-Process -Id $p.Id -Force
```

Expected: 输出 `port=<n>` 与状态 JSON（形如 `{"login":"need_login","last_sync":null,"offline":false,"syncing":false}`）；无网络环境亦应正常（静默登录因无凭据而跳过）。

- [ ] **Step 6: 提交**

```powershell
git add backend/main.py backend/tests/test_main.py
git commit -m "feat: 启动装配与后台线程"
```

---

## 验收标准（阶段 2 完成标志）

1. `.\\.venv\\Scripts\\python -m pytest` 全绿：**91 passed**，全程离线
2. `.\\.venv\\Scripts\\python -m backend.main` 可启动，`/api/state` 返回 JSON，`PORT=` 行可被解析（Step 5 冒烟通过）
3. 设计文档 §6.5 的 API 路由全部存在；§6.4 的提醒语义（去重 + 24h 补发）由测试锁定
4. 阶段 1 最终审查的全部移交项已落地（见 §0.1 表）
5. `git log` 本阶段 7 个提交；提交信息与文件范围符合各任务规定

## 附：阶段 3-4 预告

- **阶段 3（前端）**：`frontend/` 日历 UI（月视图/日程增删改/设置面板/提醒气泡），消费 `/api/*` 与 SSE；无构建步骤（原生 ES Modules，由后端静态托管）
- **阶段 4（外壳与打包）**：Electron 无边框置顶窗口 + 托盘 + 拉起 `backend.exe`（解析 stdout 端口）+ PyInstaller/electron-builder 打包






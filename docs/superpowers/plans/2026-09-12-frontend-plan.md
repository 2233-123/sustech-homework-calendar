# 作业日程小组件 — 前端实施计划（阶段 3/4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现由后端静态托管的零构建前端：月视图日历 + 日程增删改 + BB 作业展示 + 登录/设置/状态栏 + SSE 提醒气泡。

**Architecture:** 无构建步骤——原生 ES Modules + 纯 CSS，`frontend/` 目录由 Flask 的 `create_app` 默认托管（`GET /` 返回 `index.html`）。纯逻辑放 `frontend/lib/*.js`（用 `node --test` 零依赖单测），DOM 装配放 `frontend/app.js`（浏览器端到端验收）。

**Tech Stack:** 原生 HTML/CSS/JS（ES Modules）、Node v24 `node --test`（仅逻辑单测）、后端 REST + SSE。

**参考文档:** 设计案 `docs/superpowers/specs/2026-09-12-作业日程小组件-design.md`（§6.5 API、§6.7 前端、§9 视觉）；阶段 2 最终审查的 Phase-3 契约要点见本计划 §0.1。

---

## 0. 执行环境与约定

- 仓库根目录：`E:\Desktop\作业日程`（所有命令在此执行）；当前分支 `feature/frontend`（已创建）。
- Python：`.\.venv\Scripts\python`；后端测试基线 **118 passed**（本阶段不应破坏）。
- Node：`node --version` ≥ 18（本机 v24）；前端逻辑测试命令：`node --test frontend/tests/`。
- 后端已把 `frontend/` 作为静态目录托管（`create_app` 默认 `frontend_dir`），无需改后端。
- 全部单测离线；浏览器验收用真实后端（可离线启动）。
- 每个 Task 一个 commit（用户已授权）；不触碰 `docs\`、`.omo\`；只提交任务列出的文件。

## 0.1 前端必须遵守的接口契约（来自阶段 2 终审）

- **端口/来源**：页面与 API 同源，API 一律相对路径 `/api/...`（无 CORS）。
- **登录**：`POST /api/auth/login {sid,password,remember}`；成功后**不自动同步**，需要前端自行调用 `POST /api/sync`；错误码 `invalid_credentials`(401)/`offline`(502)/`session_expired`(401)/`not_authenticated`(401)/`busy`(409)。
- **state**：`{login:"ok|need_login|failed", syncing, last_sync, offline}`；`last_sync` 首次同步前为 `null`。
- **SSE**（`/api/events`）：命名事件 `remind`/`sync_done`/`login_changed`/`error`；载荷分别为 `{kind,id,title,at}`、`{added,updated,removed,at}`、`{state}`、`{code,message}`；忽略 `: connected`/`: heartbeat` 注释行；浏览器 EventSource 自动重连。
- **字段与单位**：`schedule.remind_before` 为**秒**；`settings.bb_remind_defaults` 为**分钟**；服务端时间格式为本地无时区 `YYYY-MM-DDTHH:MM:SS`，前端按本地时间处理（不得经过 UTC 解析）。
- **日历数据**：`GET /api/calendar?year&month`、`GET /api/day?date=YYYY-MM-DD` 均返回 `{schedules, assignments}`；`assignments` 为 BB 只读项（`due_at` 非空才会出现）。
- **写入校验**：`start_at` 必须恰为 `YYYY-MM-DDTHH:MM:SS`；`note`/`color`/`end_at` 必须是字符串或 null；`all_day` 0/1。

## 0.2 文件结构（阶段完成后）

```
frontend/
├── package.json          {"type":"module","private":true}
├── index.html            页面骨架（标题栏/日历/日面板/弹层/气泡容器）
├── style.css             毛玻璃无边框视觉
├── app.js                应用入口（状态 + 渲染 + 交互装配）
├── lib/
│   ├── fmt.js            时间/日期纯格式化
│   ├── cal.js            月网格与月份运算（纯函数）
│   ├── api.js            REST 客户端（fetch 可注入）
│   └── sse.js            SSE 封装（EventSource 可注入）
└── tests/
    ├── fmt.test.js
    ├── cal.test.js
    ├── api.test.js
    └── sse.test.js
```

**测试计数**：node 测试 T1 后约 9 个、T2 后约 17 个；后端 118 全程不变。

---

### Task 1: 前端骨架 + 纯逻辑（fmt / cal）+ 托管打通

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/lib/fmt.js`
- Create: `frontend/lib/cal.js`
- Create: `frontend/tests/fmt.test.js`
- Create: `frontend/tests/cal.test.js`
- Create: `frontend/index.html`（本任务仅占位版，T3 替换为完整版）

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "hw-calendar-frontend",
  "private": true,
  "type": "module"
}
```

- [ ] **Step 2: 写失败测试** — `frontend/tests/fmt.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";

import { formatDateLabel, formatTime, parseLocal, toDateStr } from "../lib/fmt.js";

test("toDateStr 补零格式", () => {
  assert.equal(toDateStr(new Date(2026, 8, 12)), "2026-09-12");
  assert.equal(toDateStr(new Date(2026, 0, 3)), "2026-01-03");
});

test("parseLocal 按本地时间解析，不经 UTC", () => {
  const d = parseLocal("2026-09-12T14:05:30");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 12);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 5);
});

test("parseLocal 容忍仅日期字符串", () => {
  const d = parseLocal("2026-09-12");
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test("formatTime 输出 HH:MM", () => {
  assert.equal(formatTime("2026-09-12T14:05:00"), "14:05");
  assert.equal(formatTime("2026-09-12T09:00:00"), "09:00");
});

test("formatDateLabel 中文标签（周一起算）", () => {
  assert.equal(formatDateLabel("2026-09-12"), "9 月 12 日 周六");
  assert.equal(formatDateLabel("2026-09-14"), "9 月 14 日 周一");
});
```

`frontend/tests/cal.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";

import { addMonths, monthGrid } from "../lib/cal.js";

test("addMonths 跨年前进/后退", () => {
  assert.deepEqual(addMonths(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(addMonths(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(addMonths(2026, 6, 0), { year: 2026, month: 6 });
});

test("monthGrid 为 6×7 且周一起始", () => {
  const weeks = monthGrid(2026, 9, "2026-09-12");
  assert.equal(weeks.length, 6);
  assert.equal(weeks[0].length, 7);
  assert.equal(weeks[0][0].date, "2026-08-31"); // 2026-09-01 为周二，前一格为周一 8/31
  assert.equal(weeks[0][1].date, "2026-09-01");
});

test("monthGrid 标记 inMonth 与 isToday", () => {
  const weeks = monthGrid(2026, 9, "2026-09-12");
  const flat = weeks.flat();
  assert.equal(flat.filter((c) => c.inMonth).length, 30);
  assert.equal(flat.find((c) => c.isToday).date, "2026-09-12");
  assert.equal(flat.find((c) => c.date === "2026-09-12").inMonth, true);
});
```

- [ ] **Step 3: 运行确认失败**

```powershell
node --test frontend/tests/
```

Expected: FAIL —— `Cannot find module ... frontend/lib/fmt.js`（模块不存在）。

- [ ] **Step 4: 写实现** — `frontend/lib/fmt.js`：

```js
// 时间与日期纯格式化工具（无 DOM、无依赖）
export const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function parseLocal(iso) {
  // 'YYYY-MM-DD[THH:MM:SS]' → 本地 Date（不经 UTC）
  const [datePart, timePart = "00:00:00"] = String(iso).split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm, ss] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0);
}

export function formatTime(iso) {
  const d = parseLocal(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatDateLabel(dateStr) {
  const d = parseLocal(dateStr);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 周${WEEKDAYS[(d.getDay() + 6) % 7]}`;
}
```

`frontend/lib/cal.js`：

```js
// 月视图网格与月份运算（纯函数）
import { toDateStr } from "./fmt.js";

export function addMonths(year, month, delta) {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export function monthGrid(year, month, todayStr = toDateStr(new Date())) {
  // 周一起始；恒定 6 行 × 7 列（含前后补位），保持组件高度稳定
  const offset = (new Date(year, month - 1, 1).getDay() + 6) % 7; // 周一 = 0
  const start = new Date(year, month - 1, 1 - offset);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i);
      const date = toDateStr(d);
      row.push({ date, day: d.getDate(), inMonth: d.getMonth() === month - 1, isToday: date === todayStr });
    }
    weeks.push(row);
  }
  return weeks;
}
```

- [ ] **Step 5: 占位 index.html**（T3 将替换为完整版；本步骤先打通托管链路）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>作业日程</title>
</head>
<body>
  <h1>作业日程前端骨架</h1>
</body>
</html>
```

- [ ] **Step 6: 运行确认通过 + 托管冒烟**

```powershell
node --test frontend/tests/                       # 预期 8 passed
# 托管链路：起后端 → GET / 应返回 index.html（而非占位文本）
$out = "$env:TEMP\hw_fe_out.txt"
$p = Start-Process -FilePath ".\.venv\Scripts\python" -ArgumentList "-m","backend.main" -PassThru -RedirectStandardOutput $out -WindowStyle Hidden
Start-Sleep -Seconds 4
$port = (Select-String -Path $out -Pattern "^PORT=(\d+)" | Select-Object -First 1).Matches.Groups[1].Value
(Invoke-WebRequest "http://127.0.0.1:$port/").Content
Stop-Process -Id $p.Id -Force
```

Expected: `8 passed`；响应 HTML 包含 `前端骨架`（证明 `frontend/index.html` 被托管）。后端全量回归 `.\.venv\Scripts\python -m pytest` 仍 **118 passed**。

- [ ] **Step 7: 提交**

```powershell
git add frontend/package.json frontend/lib frontend/tests frontend/index.html
git commit -m "feat(fe): 前端骨架与日历纯逻辑模块"
```

---

### Task 2: API 与 SSE 客户端模块

**Files:**
- Create: `frontend/lib/api.js`
- Create: `frontend/lib/sse.js`
- Create: `frontend/tests/api.test.js`
- Create: `frontend/tests/sse.test.js`

- [ ] **Step 1: 写失败测试** — `frontend/tests/api.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../lib/api.js";

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const r = responses.shift();
    if (!r) throw new Error(`no queued response for ${url}`);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.body === undefined) throw new SyntaxError("not json");
        return r.body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

test("getState 返回解析后的 JSON", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { login: "need_login" } }]);
  const api = createApi(fetchImpl);
  assert.deepEqual(await api.getState(), { login: "need_login" });
  assert.equal(fetchImpl.calls[0].url, "/api/state");
  assert.equal(fetchImpl.calls[0].opts.method, "GET");
});

test("login 发送 POST JSON 体", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { ok: true } }]);
  const api = createApi(fetchImpl);
  await api.login("20231234", "pw", true);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, "/api/auth/login");
  assert.equal(opts.method, "POST");
  assert.equal(opts.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(opts.body), { sid: "20231234", password: "pw", remember: true });
});

test("错误响应抛出带 code 的 Error", async () => {
  const fetchImpl = fakeFetch([{ status: 401, body: { error: "invalid_credentials", message: "账号或密码错误" } }]);
  const api = createApi(fetchImpl);
  await assert.rejects(
    () => api.login("u", "bad", false),
    (err) => {
      assert.equal(err.code, "invalid_credentials");
      assert.equal(err.status, 401);
      assert.equal(err.message, "账号或密码错误");
      return true;
    }
  );
});

test("非 JSON 错误响应回退到 HTTP 文案", async () => {
  const fetchImpl = fakeFetch([{ status: 500 }]);
  const api = createApi(fetchImpl);
  await assert.rejects(() => api.getSettings(), (err) => err.code === "http_error" && err.status === 500);
});

test("各端点 URL 与方法组装正确", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { schedules: [], assignments: [] } },
    { status: 200, body: { schedules: [], assignments: [] } },
    { status: 201, body: { ok: true, id: 3 } },
    { status: 200, body: { ok: true } },
    { status: 200, body: { ok: true } },
  ]);
  const api = createApi(fetchImpl);
  await api.getCalendar(2026, 9);
  await api.getDay("2026-09-12");
  await api.createSchedule({ title: "x", start_at: "2026-09-12T10:00:00" });
  await api.updateSchedule(3, { title: "y" });
  await api.deleteSchedule(3);
  assert.equal(fetchImpl.calls[0].url, "/api/calendar?year=2026&month=9");
  assert.equal(fetchImpl.calls[1].url, "/api/day?date=2026-09-12");
  assert.equal(fetchImpl.calls[2].url, "/api/schedule");
  assert.equal(fetchImpl.calls[3].url, "/api/schedule/3");
  assert.equal(fetchImpl.calls[3].opts.method, "PUT");
  assert.equal(fetchImpl.calls[4].opts.method, "DELETE");
});
```

`frontend/tests/sse.test.js`：

```js
import test from "node:test";
import assert from "node:assert/strict";

import { createSSE } from "../lib/sse.js";

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name, fn) {
    (this.listeners[name] ||= []).push(fn);
  }
  close() {
    this.closed = true;
  }
  emit(name, ev) {
    for (const fn of this.listeners[name] || []) fn(ev);
  }
}

test("命名事件被解析并分发给处理器", () => {
  FakeEventSource.instances = [];
  const seen = [];
  const sse = createSSE("/api/events", { remind: (d) => seen.push(d) }, FakeEventSource);
  FakeEventSource.instances[0].emit("remind", { data: JSON.stringify({ id: 1, title: "小组会议" }) });
  assert.deepEqual(seen, [{ id: 1, title: "小组会议" }]);
  assert.equal(FakeEventSource.instances[0].url, "/api/events");
  sse.close();
  assert.equal(FakeEventSource.instances[0].closed, true);
});

test("原生传输错误不误触 error 处理器，但触发 disconnected", () => {
  FakeEventSource.instances = [];
  const calls = [];
  createSSE("/api/events", {
    error: () => calls.push("error"),
    disconnected: () => calls.push("disconnected"),
  }, FakeEventSource);
  const es = FakeEventSource.instances[0];
  es.onerror({}); // 原生 error：无 data；同时会走 addEventListener("error") 无数据分支
  es.emit("error", {});
  assert.deepEqual(calls, ["disconnected"]);
});

test("服务端 error 事件（带 data）正常分发", () => {
  FakeEventSource.instances = [];
  const seen = [];
  createSSE("/api/events", { error: (d) => seen.push(d) }, FakeEventSource);
  FakeEventSource.instances[0].emit("error", { data: JSON.stringify({ code: "offline" }) });
  assert.deepEqual(seen, [{ code: "offline" }]);
});

test("坏 JSON 载荷不抛异常（分发 null）", () => {
  FakeEventSource.instances = [];
  const seen = [];
  createSSE("/api/events", { sync_done: (d) => seen.push(d) }, FakeEventSource);
  FakeEventSource.instances[0].emit("sync_done", { data: "{oops" });
  assert.deepEqual(seen, [null]);
});
```

- [ ] **Step 2: 运行确认失败**

```powershell
node --test frontend/tests/
```

Expected: 新增 9 个用例相关文件报 `Cannot find module ... lib/api.js / lib/sse.js`（其余 fmt/cal 用例通过）。

- [ ] **Step 3: 写实现** — `frontend/lib/api.js`：

```js
// REST 客户端：fetch 可注入以便零依赖单测
export function createApi(fetchImpl = globalThis.fetch) {
  async function request(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const resp = await fetchImpl(url, opts);
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    if (!resp.ok) {
      const err = new Error((data && data.message) || `HTTP ${resp.status}`);
      err.code = (data && data.error) || "http_error";
      err.status = resp.status;
      throw err;
    }
    return data;
  }
  return {
    getState: () => request("GET", "/api/state"),
    login: (sid, password, remember) => request("POST", "/api/auth/login", { sid, password, remember }),
    logout: (clear) => request("POST", "/api/auth/logout", { clear_credentials: !!clear }),
    sync: () => request("POST", "/api/sync"),
    getCalendar: (year, month) => request("GET", `/api/calendar?year=${year}&month=${month}`),
    getDay: (date) => request("GET", `/api/day?date=${date}`),
    createSchedule: (payload) => request("POST", "/api/schedule", payload),
    updateSchedule: (id, payload) => request("PUT", `/api/schedule/${id}`, payload),
    deleteSchedule: (id) => request("DELETE", `/api/schedule/${id}`),
    getSettings: () => request("GET", "/api/settings"),
    putSettings: (payload) => request("PUT", "/api/settings", payload),
  };
}
```

`frontend/lib/sse.js`：

```js
// SSE 封装：命名事件分发 + 原生自动重连（EventSourceImpl 可注入以便测试）
const NAMED_EVENTS = ["remind", "sync_done", "login_changed", "error"];

export function createSSE(url, handlers = {}, EventSourceImpl = globalThis.EventSource) {
  const es = new EventSourceImpl(url);
  for (const name of NAMED_EVENTS) {
    es.addEventListener(name, (ev) => {
      if (name === "error" && typeof ev.data !== "string") {
        return; // 原生传输错误：交给 onerror，不作为服务端事件分发
      }
      let data = null;
      try {
        data = JSON.parse(ev.data);
      } catch {
        data = null;
      }
      const fn = handlers[name];
      if (typeof fn === "function") fn(data);
    });
  }
  es.onerror = () => {
    if (typeof handlers.disconnected === "function") handlers.disconnected();
  };
  return { close: () => es.close(), source: es };
}
```

- [ ] **Step 4: 运行确认通过**

```powershell
node --test frontend/tests/     # 预期 17 passed
```

- [ ] **Step 5: 提交**

```powershell
git add frontend/lib/api.js frontend/lib/sse.js frontend/tests/api.test.js frontend/tests/sse.test.js
git commit -m "feat(fe): API 与 SSE 客户端模块"
```

---

### Task 3: UI 主体（index.html / style.css / app.js）

**Files:**
- Modify: `frontend/index.html`（替换 T1 占位版）
- Create: `frontend/style.css`
- Create: `frontend/app.js`

- [ ] **Step 1: 完整 `frontend/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>作业日程</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <main id="app" class="widget">
    <header class="titlebar" id="titlebar">
      <span class="brand">作业日程</span>
      <span class="titlebar-actions">
        <button id="btn-sync" class="icon-btn" title="立即同步">⟳</button>
        <button id="btn-settings" class="icon-btn" title="设置">⚙</button>
      </span>
    </header>

    <div id="statusbar" class="statusbar" hidden></div>

    <section id="login-card" class="card login-card" hidden>
      <h2>登录 SUSTech CAS</h2>
      <label class="field">学号
        <input id="login-sid" type="text" autocomplete="username" />
      </label>
      <label class="field">密码
        <input id="login-pwd" type="password" autocomplete="current-password" />
      </label>
      <label class="check">
        <input id="login-remember" type="checkbox" checked />
        记住账号（Windows 加密存储）
      </label>
      <div class="row">
        <button id="btn-login" class="btn primary">登录</button>
        <span id="login-msg" class="msg"></span>
      </div>
    </section>

    <nav class="month-nav">
      <button id="btn-prev" class="icon-btn" title="上个月">◀</button>
      <span id="month-label" class="month-label"></span>
      <button id="btn-next" class="icon-btn" title="下个月">▶</button>
      <button id="btn-today" class="btn ghost small">今天</button>
    </nav>

    <div class="weekhead">
      <span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>
    </div>
    <div id="calendar" class="calendar"></div>

    <section class="day-panel">
      <div class="day-head">
        <span id="day-label" class="day-label"></span>
        <button id="btn-add" class="btn primary small">＋ 添加日程</button>
      </div>
      <ul id="day-list" class="day-list"></ul>
    </section>

    <div id="bubbles" class="bubbles"></div>

    <div id="modal-schedule" class="modal" hidden>
      <div class="modal-card">
        <h3 id="schedule-form-title">添加日程</h3>
        <form id="schedule-form">
          <label class="field">标题
            <input id="f-title" type="text" required />
          </label>
          <label class="field">开始时间
            <input id="f-start" type="datetime-local" required />
          </label>
          <label class="field">结束时间
            <input id="f-end" type="datetime-local" />
          </label>
          <label class="field">提醒
            <select id="f-remind">
              <option value="">不提醒</option>
              <option value="300">提前 5 分钟</option>
              <option value="900">提前 15 分钟</option>
              <option value="1800">提前 30 分钟</option>
              <option value="3600">提前 1 小时</option>
              <option value="86400">提前 1 天</option>
            </select>
          </label>
          <label class="field">备注
            <textarea id="f-note" rows="2"></textarea>
          </label>
          <div class="row">
            <button type="submit" class="btn primary">保存</button>
            <button type="button" id="btn-cancel-schedule" class="btn ghost">取消</button>
            <button type="button" id="btn-delete-schedule" class="btn danger" hidden>删除</button>
          </div>
          <span id="schedule-msg" class="msg"></span>
        </form>
      </div>
    </div>

    <div id="modal-settings" class="modal" hidden>
      <div class="modal-card">
        <h3>设置</h3>
        <label class="field">同步间隔（分钟）
          <input id="s-interval" type="number" min="1" />
        </label>
        <label class="check">
          <input id="s-bb-remind" type="checkbox" />
          BB 作业截止提醒
        </label>
        <label class="field">BB 提醒（分钟，逗号分隔）
          <input id="s-bb-defaults" type="text" />
        </label>
        <div class="row">
          <button id="btn-save-settings" class="btn primary">保存</button>
          <button id="btn-logout" class="btn ghost">退出登录</button>
          <button id="btn-close-settings" class="btn ghost">关闭</button>
        </div>
        <span id="settings-msg" class="msg"></span>
      </div>
    </div>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 完整 `frontend/style.css`**

```css
/* 作业日程 — 桌面小组件样式（毛玻璃/圆角/无边框） */
:root {
  --bg: rgba(255, 255, 255, 0.84);
  --fg: #1f2937;
  --muted: #6b7280;
  --accent: #2563eb;
  --accent-soft: rgba(37, 99, 235, 0.10);
  --bb: #7c3aed;
  --danger: #dc2626;
  --line: rgba(31, 41, 55, 0.10);
  --radius: 16px;
  --shadow: 0 12px 32px rgba(15, 23, 42, 0.22);
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }

html, body { height: 100%; margin: 0; }
body {
  background: transparent;
  color: var(--fg);
  font: 14px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
}

.widget {
  width: 368px;
  margin: 20px auto;
  border-radius: var(--radius);
  background: var(--bg);
  backdrop-filter: blur(18px) saturate(1.3);
  -webkit-backdrop-filter: blur(18px) saturate(1.3);
  box-shadow: var(--shadow);
  border: 1px solid rgba(255, 255, 255, 0.55);
  overflow: hidden;
}

/* 标题栏（Electron 以 -webkit-app-region: drag 拖拽） */
.titlebar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px 6px;
  -webkit-app-region: drag;
  user-select: none;
}
.titlebar .brand { font-weight: 700; letter-spacing: .5px; }
.titlebar-actions { display: flex; gap: 2px; -webkit-app-region: no-drag; }

.icon-btn {
  border: none; background: transparent; color: var(--muted);
  font-size: 15px; padding: 3px 7px; border-radius: 8px; cursor: pointer;
}
.icon-btn:hover { background: var(--accent-soft); color: var(--accent); }

.statusbar {
  padding: 3px 14px; font-size: 12px; color: #1e40af;
  background: var(--accent-soft);
}

/* 登录卡 */
.card { margin: 8px 14px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: rgba(255,255,255,.7); }
.card h2 { margin: 0 0 10px; font-size: 15px; }

.row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.msg { font-size: 12px; color: var(--danger); }

/* 月份导航 */
.month-nav { display: flex; align-items: center; gap: 6px; padding: 8px 14px 2px; }
.month-label { font-weight: 600; margin-right: auto; }

/* 日历 */
.weekhead {
  display: grid; grid-template-columns: repeat(7, 1fr);
  padding: 4px 10px 2px; font-size: 12px; color: var(--muted); text-align: center;
}
.calendar {
  display: grid; grid-template-columns: repeat(7, 1fr);
  gap: 2px; padding: 2px 10px 8px;
}
.cell {
  position: relative; aspect-ratio: 1 / 1; border: none; background: transparent;
  border-radius: 10px; cursor: pointer; font: inherit; color: var(--fg);
  display: flex; align-items: center; justify-content: center;
}
.cell:hover { background: var(--accent-soft); }
.cell.out { color: rgba(107, 114, 128, .45); }
.cell.today { box-shadow: inset 0 0 0 1.5px var(--accent); }
.cell.selected { background: var(--accent); color: #fff; }
.cell .dots {
  position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 3px;
}
.cell .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.cell .dot.bb { background: var(--bb); }
.cell.selected .dot { background: #fff; }

/* 当日面板 */
.day-panel { border-top: 1px solid var(--line); padding: 8px 14px 12px; }
.day-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.day-label { font-weight: 600; font-size: 13px; }
.day-list { list-style: none; margin: 0; padding: 0; max-height: 200px; overflow-y: auto; }
.day-list li {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 9px; cursor: pointer;
}
.day-list li:hover { background: var(--accent-soft); }
.day-list li.bb-row { cursor: default; }
.day-list li.bb-row:hover { background: rgba(124, 58, 237, .07); }
.item-time { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px; min-width: 42px; }
.item-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag {
  font-size: 11px; color: var(--bb); border: 1px solid rgba(124, 58, 237, .4);
  border-radius: 6px; padding: 0 5px; line-height: 16px;
}
.empty-hint { color: var(--muted); font-size: 12px; padding: 6px 8px; }

/* 按钮 */
.btn {
  border: 1px solid transparent; border-radius: 9px; cursor: pointer;
  font: inherit; padding: 5px 12px; background: #fff; color: var(--fg);
}
.btn.small { padding: 3px 10px; font-size: 12px; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover { filter: brightness(1.06); }
.btn.ghost { background: transparent; border-color: var(--line); color: var(--muted); }
.btn.ghost:hover { border-color: var(--accent); color: var(--accent); }
.btn.danger { background: transparent; border-color: rgba(220, 38, 38, .4); color: var(--danger); }
.btn.danger:hover { background: rgba(220, 38, 38, .08); }

/* 表单 */
.field { display: block; font-size: 12px; color: var(--muted); margin-bottom: 8px; }
.field input, .field select, .field textarea {
  display: block; width: 100%; margin-top: 2px;
  padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 8px;
  font: inherit; color: var(--fg); background: #fff;
}
.check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); margin-bottom: 8px; }

/* 弹层 */
.modal {
  position: fixed; inset: 0; z-index: 20;
  background: rgba(15, 23, 42, 0.35);
  display: grid; place-items: center;
}
.modal-card {
  width: 320px; max-height: 90vh; overflow-y: auto;
  background: #fff; border-radius: 14px; padding: 14px 16px;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.3);
}
.modal-card h3 { margin: 0 0 10px; font-size: 15px; }

/* 提醒气泡 */
.bubbles { position: fixed; right: 16px; bottom: 16px; z-index: 30; display: flex; flex-direction: column; gap: 8px; }
.bubble {
  width: 264px; background: #fff; border-radius: 12px; padding: 10px 12px;
  border-left: 4px solid var(--accent);
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.25);
  animation: bubble-in .18s ease-out;
}
.bubble .bubble-title { font-weight: 600; margin-bottom: 2px; }
.bubble .bubble-sub { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
.bubble .bubble-actions { display: flex; justify-content: flex-end; gap: 8px; }
@keyframes bubble-in {
  from { transform: translateY(8px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
```

- [ ] **Step 3: 完整 `frontend/app.js`**

```js
// 作业日程 — 前端入口：状态 + 渲染 + 交互装配
import { createApi } from "./lib/api.js";
import { createSSE } from "./lib/sse.js";
import { addMonths, monthGrid } from "./lib/cal.js";
import { formatDateLabel, formatTime, toDateStr } from "./lib/fmt.js";

const api = createApi();
const $ = (id) => document.getElementById(id);

const state = {
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  selected: toDateStr(new Date()),
  editingId: null,
  monthData: { schedules: [], assignments: [] },
  dayData: { schedules: [], assignments: [] },
};

// ---------- 状态栏 ----------
function setStatus(text) {
  const el = $("statusbar");
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = text;
}

async function refreshState() {
  let st;
  try {
    st = await api.getState();
  } catch {
    setStatus("后端未就绪");
    return null;
  }
  $("login-card").hidden = st.login === "ok";
  const parts = [];
  if (st.login === "failed") parts.push("登录失败，请重新输入账号密码");
  if (st.offline) parts.push("网络不可达（可能不在校园网/VPN）");
  if (st.syncing) parts.push("同步中…");
  if (st.last_sync) parts.push(`上次同步 ${st.last_sync.replace("T", " ")}`);
  setStatus(parts.join(" · "));
  return st;
}

// ---------- 数据加载 ----------
async function loadMonth() {
  try {
    const data = await api.getCalendar(state.year, state.month);
    state.monthData = { schedules: data.schedules || [], assignments: data.assignments || [] };
  } catch (err) {
    setStatus(`日历加载失败：${err.message}`);
    state.monthData = { schedules: [], assignments: [] };
  }
  renderMonth();
}

async function loadDay() {
  try {
    const data = await api.getDay(state.selected);
    state.dayData = { schedules: data.schedules || [], assignments: data.assignments || [] };
  } catch {
    state.dayData = { schedules: [], assignments: [] };
  }
  renderDay();
}

function selectDate(date) {
  state.selected = date;
  renderMonth();
  loadDay();
}

// ---------- 渲染 ----------
function renderMonth() {
  $("month-label").textContent = `${state.year} 年 ${state.month} 月`;
  const dots = new Map();
  for (const s of state.monthData.schedules) {
    const key = s.start_at.slice(0, 10);
    const d = dots.get(key) || { sched: 0, bb: 0 };
    d.sched += 1;
    dots.set(key, d);
  }
  for (const a of state.monthData.assignments) {
    if (!a.due_at) continue;
    const key = a.due_at.slice(0, 10);
    const d = dots.get(key) || { sched: 0, bb: 0 };
    d.bb += 1;
    dots.set(key, d);
  }
  const grid = $("calendar");
  grid.innerHTML = "";
  for (const week of monthGrid(state.year, state.month, toDateStr(new Date()))) {
    for (const cell of week) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cell";
      if (!cell.inMonth) btn.classList.add("out");
      if (cell.isToday) btn.classList.add("today");
      if (cell.date === state.selected) btn.classList.add("selected");
      btn.textContent = String(cell.day);
      const d = dots.get(cell.date);
      if (d && (d.sched || d.bb)) {
        const wrap = document.createElement("span");
        wrap.className = "dots";
        const nSched = Math.min(d.sched, 3);
        const nBb = Math.min(d.bb, 3 - nSched);
        for (let i = 0; i < nSched; i++) {
          const dot = document.createElement("span");
          dot.className = "dot";
          wrap.appendChild(dot);
        }
        for (let i = 0; i < nBb; i++) {
          const dot = document.createElement("span");
          dot.className = "dot bb";
          wrap.appendChild(dot);
        }
        btn.appendChild(wrap);
      }
      btn.addEventListener("click", () => selectDate(cell.date));
      grid.appendChild(btn);
    }
  }
}

function renderDay() {
  $("day-label").textContent = formatDateLabel(state.selected);
  const list = $("day-list");
  list.innerHTML = "";
  const rows = [];
  for (const s of state.dayData.schedules) rows.push({ kind: "schedule", item: s, at: s.start_at });
  for (const a of state.dayData.assignments) rows.push({ kind: "assignment", item: a, at: a.due_at });
  rows.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    li.textContent = "这一天还没有安排";
    list.appendChild(li);
    return;
  }
  for (const row of rows) {
    const li = document.createElement("li");
    const time = document.createElement("span");
    time.className = "item-time";
    time.textContent = formatTime(row.at);
    const title = document.createElement("span");
    title.className = "item-title";
    title.textContent = row.item.title;
    li.append(time, title);
    if (row.kind === "assignment") {
      li.classList.add("bb-row");
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "BB";
      tag.title = `${row.item.course_name || ""}${row.item.submitted ? " · 已提交" : ""}`;
      li.appendChild(tag);
    } else {
      li.addEventListener("click", () => openScheduleForm(row.item));
    }
    list.appendChild(li);
  }
}

// ---------- 登录 / 同步 ----------
async function doLogin() {
  const sid = $("login-sid").value.trim();
  const password = $("login-pwd").value;
  const remember = $("login-remember").checked;
  $("login-msg").textContent = "";
  if (!sid || !password) {
    $("login-msg").textContent = "请输入学号与密码";
    return;
  }
  try {
    await api.login(sid, password, remember);
    $("login-pwd").value = "";
    $("login-card").hidden = true;
    await refreshState();
    await doSync();
  } catch (err) {
    $("login-msg").textContent = err.message;
  }
}

async function doSync() {
  try {
    await api.sync();
  } catch (err) {
    if (err.code !== "busy") setStatus(`同步失败：${err.message}`);
  }
  await refreshState();
  await loadMonth();
  await loadDay();
}

// ---------- 日程表单 ----------
const toInputValue = (iso) => (iso ? iso.slice(0, 16) : "");
const fromInputValue = (v) => (v ? `${v}:00` : null);

function openScheduleForm(item) {
  state.editingId = item ? item.id : null;
  $("schedule-form-title").textContent = item ? "编辑日程" : "添加日程";
  $("f-title").value = item ? item.title : "";
  $("f-start").value = item ? toInputValue(item.start_at) : `${state.selected}T09:00`;
  $("f-end").value = item && item.end_at ? toInputValue(item.end_at) : "";
  const sel = $("f-remind");
  const val = item && item.remind_before != null ? String(item.remind_before) : "";
  if (val && ![...sel.options].some((o) => o.value === val)) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = `提前 ${Math.round(Number(val) / 60)} 分钟`;
    sel.appendChild(opt);
  }
  sel.value = val;
  $("f-note").value = item && item.note ? item.note : "";
  $("btn-delete-schedule").hidden = !item;
  $("schedule-msg").textContent = "";
  $("modal-schedule").hidden = false;
}

function closeScheduleForm() {
  $("modal-schedule").hidden = true;
  state.editingId = null;
}

async function submitSchedule(ev) {
  ev.preventDefault();
  const payload = {
    title: $("f-title").value.trim(),
    start_at: fromInputValue($("f-start").value),
    end_at: fromInputValue($("f-end").value),
    remind_before: $("f-remind").value ? Number($("f-remind").value) : null,
    note: $("f-note").value.trim() || null,
  };
  if (!payload.title || !payload.start_at) {
    $("schedule-msg").textContent = "标题与开始时间必填";
    return;
  }
  try {
    if (state.editingId) await api.updateSchedule(state.editingId, payload);
    else await api.createSchedule(payload);
    closeScheduleForm();
    await loadMonth();
    await loadDay();
  } catch (err) {
    $("schedule-msg").textContent = err.message;
  }
}

async function deleteSchedule() {
  if (!state.editingId) return;
  try {
    await api.deleteSchedule(state.editingId);
    closeScheduleForm();
    await loadMonth();
    await loadDay();
  } catch (err) {
    $("schedule-msg").textContent = err.message;
  }
}

// ---------- 设置 ----------
async function openSettings() {
  $("settings-msg").textContent = "";
  try {
    const cfg = await api.getSettings();
    $("s-interval").value = cfg.refresh_interval_min ?? 30;
    $("s-bb-remind").checked = !!cfg.bb_remind_enabled;
    $("s-bb-defaults").value = (cfg.bb_remind_defaults || []).join(", ");
  } catch (err) {
    $("settings-msg").textContent = err.message;
  }
  $("modal-settings").hidden = false;
}

async function saveSettings() {
  const defaults = $("s-bb-defaults").value
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  try {
    await api.putSettings({
      refresh_interval_min: Number($("s-interval").value) || 30,
      bb_remind_enabled: $("s-bb-remind").checked,
      bb_remind_defaults: defaults,
    });
    $("settings-msg").textContent = "已保存";
  } catch (err) {
    $("settings-msg").textContent = err.message;
  }
}

async function doLogout() {
  try {
    await api.logout(false);
    $("modal-settings").hidden = true;
    await refreshState();
  } catch (err) {
    $("settings-msg").textContent = err.message;
  }
}

// ---------- 提醒气泡 ----------
function showBubble(title, sub, onSnooze) {
  const box = $("bubbles");
  const el = document.createElement("div");
  el.className = "bubble";
  const t = document.createElement("div");
  t.className = "bubble-title";
  t.textContent = `🔔 ${title}`;
  const s = document.createElement("div");
  s.className = "bubble-sub";
  s.textContent = sub;
  const actions = document.createElement("div");
  actions.className = "bubble-actions";
  const snooze = document.createElement("button");
  snooze.className = "btn ghost small";
  snooze.textContent = "稍后";
  snooze.addEventListener("click", () => {
    el.remove();
    if (onSnooze) setTimeout(onSnooze, 5 * 60 * 1000);
  });
  const ok = document.createElement("button");
  ok.className = "btn primary small";
  ok.textContent = "知道了";
  ok.addEventListener("click", () => el.remove());
  actions.append(snooze, ok);
  el.append(t, s, actions);
  box.appendChild(el);
  setTimeout(() => el.remove(), 30000);
}

// ---------- SSE ----------
function connectSSE() {
  createSSE("/api/events", {
    remind: (d) => {
      if (!d) return;
      const when = d.at ? formatTime(d.at) : "";
      const kindText = d.kind === "assignment" ? "截止" : "开始";
      const sub = when ? `${when} ${kindText}` : "";
      const show = () => showBubble(d.title || "日程提醒", sub, show);
      show();
    },
    sync_done: async () => {
      await refreshState();
      await loadMonth();
      await loadDay();
    },
    login_changed: () => refreshState(),
    error: (d) => {
      if (d && d.message) setStatus(d.message);
    },
    disconnected: () => setStatus("事件流断开，自动重连中…"),
  });
}

// ---------- 装配 ----------
function bind() {
  $("btn-prev").addEventListener("click", () => {
    const m = addMonths(state.year, state.month, -1);
    state.year = m.year;
    state.month = m.month;
    loadMonth();
  });
  $("btn-next").addEventListener("click", () => {
    const m = addMonths(state.year, state.month, 1);
    state.year = m.year;
    state.month = m.month;
    loadMonth();
  });
  $("btn-today").addEventListener("click", () => {
    const now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth() + 1;
    renderMonth();
    selectDate(toDateStr(now));
  });
  $("btn-add").addEventListener("click", () => openScheduleForm(null));
  $("btn-sync").addEventListener("click", () => doSync());
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-login").addEventListener("click", doLogin);
  $("schedule-form").addEventListener("submit", submitSchedule);
  $("btn-cancel-schedule").addEventListener("click", closeScheduleForm);
  $("btn-delete-schedule").addEventListener("click", deleteSchedule);
  $("btn-save-settings").addEventListener("click", saveSettings);
  $("btn-close-settings").addEventListener("click", () => {
    $("modal-settings").hidden = true;
  });
  $("btn-logout").addEventListener("click", doLogout);
}

async function init() {
  bind();
  renderMonth();
  await refreshState();
  await loadMonth();
  await loadDay();
  connectSSE();
}

init();
```

- [ ] **Step 4: 运行确认通过 + 托管冒烟**

```powershell
node --test frontend/tests/     # 预期 17 passed（无回归）
# 三个静态资源均可访问：
$out = "$env:TEMP\hw_fe_out2.txt"
$p = Start-Process -FilePath ".\.venv\Scripts\python" -ArgumentList "-m","backend.main" -PassThru -RedirectStandardOutput $out -WindowStyle Hidden
Start-Sleep -Seconds 4
$port = (Select-String -Path $out -Pattern "^PORT=(\d+)" | Select-Object -First 1).Matches.Groups[1].Value
(Invoke-WebRequest "http://127.0.0.1:$port/").StatusCode          # 200
(Invoke-WebRequest "http://127.0.0.1:$port/app.js").StatusCode    # 200
(Invoke-WebRequest "http://127.0.0.1:$port/style.css").StatusCode # 200
Stop-Process -Id $p.Id -Force
```

Expected: `17 passed`；三个资源均 `200`。后端全量回归仍 **118 passed**。

- [ ] **Step 5: 提交**

```powershell
git add frontend/index.html frontend/style.css frontend/app.js
git commit -m "feat(fe): 日历界面与日程交互"
```

---

### Task 4: 浏览器端到端验收（控制者执行）+ 修复轮

> 本任务由**控制者（主会话）**用真实浏览器（Playwright）针对真实后端执行，属最终使用验收；发现缺陷时派发给前端实现者修复并复验，直至全部通过。

- [ ] **Step 1: 以隔离数据目录启动后端**（避免污染真实 `%APPDATA%`）：

```powershell
$env:APPDATA = "$env:TEMP\hw_qa_appdata"
$out = "$env:TEMP\hw_qa_out.txt"
$p = Start-Process -FilePath ".\.venv\Scripts\python" -ArgumentList "-m","backend.main" -PassThru -RedirectStandardOutput $out -WindowStyle Hidden
Start-Sleep -Seconds 4
$port = (Select-String -Path $out -Pattern "^PORT=(\d+)").Matches.Groups[1].Value
"http://127.0.0.1:$port"
```

- [ ] **Step 2: 浏览器验收清单**（Playwright 打开 `http://127.0.0.1:<port>/`，逐项核对）：

  1. 页面标题「作业日程」；日历为 6×7 网格；月标签为当前年月；今天单元格有 `today` 边框且默认选中。
  2. 无凭据 → 登录卡可见；状态栏显示与 `need_login` 相关文案。
  3. 点击「＋ 添加日程」→ 填标题「QA 测试会议」、开始时间=今天 23:30、提醒=提前 5 分钟 → 保存 → 当日列表出现该项，今日单元格出现圆点。
  4. 点击该日程 → 修改标题为「QA 测试会议（改）」→ 保存 → 列表同步更新。
  5. 月份导航：◀/▶ 改变月份且数据加载；「今天」回到当前月与今日。
  6. 设置：改同步间隔为 5 → 保存 → 显示「已保存」；`GET /api/settings` 的 `refresh_interval_min == 5`。
  7. 未登录点击 ⟳ → 状态栏出现「同步失败」（401 文案），页面不崩溃。
  8. 提醒气泡：用 API 直接创建一个 `start_at` 为当前时刻、`remind_before=0` 的日程

     ```powershell
     Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/schedule" -ContentType "application/json" -Body '{"title":"QA 提醒","start_at":"<当前本地时间 YYYY-MM-DDTHH:MM:SS>","remind_before":0}'
     ```
     等待 ≤35 秒（30 秒 tick）→ 页面右下角出现 `🔔 QA 提醒` 气泡 → 点击「知道了」→ 气泡消失。
  9. 视觉抽查：圆角/毛玻璃/投影正常，无横向滚动条，`day-list` 内容溢出时可滚动；截图留档。
  10. 中文字体渲染正常（无豆腐块）；按钮 `hover` 有反馈。

- [ ] **Step 3: 清理**

```powershell
Stop-Process -Id $p.Id -Force
Remove-Item -Recurse -Force "$env:TEMP\hw_qa_appdata" -ErrorAction SilentlyContinue
```

- [ ] **Step 4: 修复轮**（若有缺陷）：将缺陷清单（含复现步骤/期望/实际/截图路径）派发给前端实现者修复 → 重新执行 Step 1–3 直至全过 → 修复提交信息 `fix(fe): QA 缺陷修复`。

---

## 验收标准（阶段 3 完成标志）

1. `node --test frontend/tests/` **17 passed**；后端 `.\.venv\Scripts\python -m pytest` **118 passed**（无回归）。
2. Task 4 浏览器验收清单 10 项全过（控制者亲测，含真实 SSE 气泡验证）。
3. 设计文档 §6.7 的元素齐备：月日历 / 当日列表（BB 只读标记）/ 添加编辑弹层 / 设置面板 / 登录卡 / 提醒气泡 / 状态栏。
4. `frontend/` 无构建依赖（无需 npm install；纯静态托管）；文件范围与任务一致。
5. `git log` 可见阶段 3 提交（feat(fe)/fix(fe) 风格）。

## 附：阶段 4 预告（Electron 外壳与打包）

- Electron 无边框/透明/置顶窗口 + `-webkit-app-region` 拖拽（已在前端预留）
- 托盘、开机自启、隐藏任务栏图标
- 主进程 spawn `backend.exe`（PyInstaller 打包）并解析 `PORT=` 行；退出时清理子进程
- electron-builder 打包 NSIS 安装包/便携版





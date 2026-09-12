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
    if (row.kind === "schedule" && row.item.all_day) {
      time.textContent = "全天";
    } else {
      time.textContent = formatTime(row.at);
    }
    const title = document.createElement("span");
    title.className = "item-title";
    title.textContent = row.item.title;
    if (row.item.color) {
      li.style.borderLeft = `3px solid ${row.item.color}`;
      li.style.paddingLeft = "6px";
    }
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
  $("btn-sync").disabled = true;
  setStatus("同步中…");
  let failure = null;
  try {
    try {
      await api.sync();
    } catch (err) {
      if (err.code !== "busy") failure = err;
    }
    await refreshState();
    await loadMonth();
    await loadDay();
  } finally {
    $("btn-sync").disabled = false;
  }
  if (failure) setStatus(`同步失败：${failure.message}`);
}

// ---------- 日程表单 ----------
const toInputValue = (iso) => (iso ? iso.slice(0, 16) : "");
const fromInputValue = (v) => (v ? `${v}:00` : null);

function openScheduleForm(item) {
  state.editingId = item ? item.id : null;
  $("schedule-form-title").textContent = item ? "编辑日程" : "添加日程";
  $("f-title").value = item ? item.title : "";
  $("f-all-day").checked = !!(item && item.all_day);
  const colorSel = $("f-color");
  const colorVal = item && item.color ? item.color : "";
  if (colorVal && ![...colorSel.options].some((o) => o.value === colorVal)) {
    const opt = document.createElement("option");
    opt.value = colorVal;
    opt.textContent = "自定义";
    colorSel.appendChild(opt);
  }
  colorSel.value = colorVal;
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
    all_day: $("f-all-day").checked ? 1 : 0,
    color: $("f-color").value || null,
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
    selectDate(toDateStr(now));
    loadMonth();
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

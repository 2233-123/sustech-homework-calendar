// 作业日程 — 前端入口：状态 + 渲染 + 交互装配
import { createApi } from "./lib/api.js";
import { createSSE } from "./lib/sse.js";
import { addMonths, monthGrid } from "./lib/cal.js";
import { formatDateLabel, formatDateTime, formatLead, formatTime, toDateStr } from "./lib/fmt.js";

const api = createApi();
const $ = (id) => document.getElementById(id);

const state = {
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  selected: toDateStr(new Date()),
  editingId: null,
  monthData: { schedules: [], assignments: [] },
  dayData: { schedules: [], assignments: [] },
  settings: {},
  overview: null,
  remindLoaded: [null, null],
  remindDirty: [false, false],
};

// ---------- 状态栏 ----------
function setStatus(text) {
  $("status-text").textContent = text || "尚未同步";
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
    title.textContent = row.item.course_name
      ? `【${row.item.course_name}】${row.item.title}`
      : row.item.title;
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
    }
    li.addEventListener("click", () => openItemOverview(row.kind, row.item));
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
  $("btn-status-sync").disabled = true;
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
    $("btn-status-sync").disabled = false;
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

// ---------- 事务概览 ----------
function bbUrl(item) {
  if (!item.course_id) return null;
  // DB 中 id 为 normalize_bb_id 处理后的裸 id（去 `_`/`_1`），此处还原为 BB 的 `_<id>_1` 形式
  const cid = encodeURIComponent(String(item.course_id));
  if (item.content_id) {
    const kid = encodeURIComponent(String(item.content_id));
    return `https://bb.sustech.edu.cn/webapps/blackboard/content/listContent.jsp?course_id=_${cid}_1&content_id=_${kid}_1`;
  }
  return `https://bb.sustech.edu.cn/webapps/blackboard/execute/courseMain?course_id=_${cid}_1`;
}

function openExternal(url) {
  if (window.hwShell) window.hwShell.openExternal(url);
  else window.open(url, "_blank", "noopener");
}

function openItemOverview(kind, item) {
  state.overview = { kind, item };
  $("item-title").textContent = item.title;
  const dl = $("item-fields");
  dl.replaceChildren();
  const add = (label, value) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  };
  if (kind === "schedule") {
    add("来源", "自建");
    if (item.all_day) {
      add("时间", "全天");
    } else {
      add("开始", formatDateTime(item.start_at));
      add("结束", item.end_at ? formatDateTime(item.end_at) : "—");
    }
    add("提醒", item.remind_before ? "提前 " + formatLead(item.remind_before) : "不提醒");
    add("备注", item.note || "—");
  } else {
    add("来源", "Blackboard");
    add("课程名", item.course_name || "—");
    add("截止时间", formatDateTime(item.due_at));
    add("提交状态", (item.submitted ? "已提交" : "未提交") + (item.status ? " · " + item.status : ""));
    if (item.score != null) {
      add("分数", item.possible != null ? `${item.score} / ${item.possible}` : String(item.score));
    }
    const defaults = state.settings.bb_remind_defaults || [];
    add(
      "提醒",
      state.settings.bb_remind_enabled && defaults.length
        ? "提前 " + defaults.map((m) => formatLead(m * 60)).join("、")
        : "不提醒"
    );
    add("备注", item.note || "—");
  }
  $("btn-item-edit").hidden = kind !== "schedule";
  $("btn-item-open-bb").hidden = kind !== "assignment" || !bbUrl(item);
  $("btn-item-close").hidden = false;
  $("modal-item").hidden = false;
}

function closeItemOverview() {
  $("modal-item").hidden = true;
  state.overview = null;
}

// ---------- 设置 ----------
function fillSelect(sel, max) {
  for (let i = 0; i <= max; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = String(i);
    sel.appendChild(opt);
  }
}

function updateScaleReadout() {
  const p = Number($("s-scale").value) || 100;
  const w = Math.round((408 * p) / 100);
  const h = Math.round((760 * p) / 100);
  $("s-scale-val").textContent = `${p}%（${w}×${h}）`;
}

// 低于 70% 进入紧凑模式：字号钉在 MIN_ZOOM（见 electron/main.js），视口继续收窄、纵向改用页面滚动
function setCompact(p) {
  document.body.classList.toggle("compact", Number(p) < 70);
}

async function openSettings() {
  $("settings-msg").textContent = "";
  state.remindDirty = [false, false];
  try {
    const cfg = await api.getSettings();
    state.settings = cfg;
    $("s-interval").value = cfg.refresh_interval_min ?? 30;
    $("s-bb-remind").checked = !!cfg.bb_remind_enabled;
    const defs = (Array.isArray(cfg.bb_remind_defaults) ? cfg.bb_remind_defaults : []).slice(0, 2);
    state.remindLoaded = [defs[0] ?? null, defs[1] ?? null];
    const PLACEHOLDER = [1440, 120];
    const toDH = (min) => ({
      d: Math.min(30, Math.floor(min / 1440)),
      h: Math.floor((min % 1440) / 60),
    });
    [1, 2].forEach((i) => {
      const base = state.remindLoaded[i - 1] ?? PLACEHOLDER[i - 1];
      const dh = toDH(base);
      $("s-remind" + i + "-days").value = String(dh.d);
      $("s-remind" + i + "-hours").value = String(dh.h);
    });
    $("bb-remind-detail").hidden = !$("s-bb-remind").checked;
    $("s-ontop").checked = cfg.always_on_top !== false;
    $("s-opacity").value =
      typeof cfg.opacity === "number" ? Math.min(1, Math.max(0.3, cfg.opacity)) : 0.95;
    $("s-opacity-val").textContent = Math.round(Number($("s-opacity").value) * 100) + "%";
    $("s-scale").value = String(Math.min(150, Math.max(40, Math.round(Number(cfg.window_scale) || 100))));
    updateScaleReadout();
    setCompact($("s-scale").value);
    let autostart = !!cfg.autostart;
    if (window.hwShell) {
      try {
        autostart = await window.hwShell.getAutostart();
      } catch {
        /* 用配置值兜底 */
      }
    }
    $("s-autostart").checked = autostart;
    $("s-popup").value = ["inapp", "toast", "both"].includes(cfg.remind_popup)
      ? cfg.remind_popup
      : "inapp";
  } catch (err) {
    $("settings-msg").textContent = err.message;
  }
  $("modal-settings").hidden = false;
}

async function saveSettings() {
  const leadOf = (i) => {
    const comp =
      Number($("s-remind" + i + "-days").value) * 1440 +
      Number($("s-remind" + i + "-hours").value) * 60;
    if (!state.remindDirty[i - 1]) return state.remindLoaded[i - 1]; // 未触碰：原样保留（占位 null 不落库，越界值不被改写）
    return comp > 0 ? comp : null; // 已触碰：以当前选择为准（0 天 0 时视为清空该槽）
  };
  const leads = [...new Set([leadOf(1), leadOf(2)].filter((v) => typeof v === "number" && v > 0))];
  const enabled = $("s-bb-remind").checked;
  if (enabled && !leads.length) {
    $("settings-msg").textContent = "请至少设置一个提醒时间";
    return;
  }
  const payload = {
    refresh_interval_min: Number($("s-interval").value) || 30,
    bb_remind_enabled: enabled,
    bb_remind_defaults: leads,
    always_on_top: $("s-ontop").checked,
    opacity: Math.min(1, Math.max(0.3, Number($("s-opacity").value) || 0.95)),
    window_scale: Number($("s-scale").value) || 100,
    autostart: $("s-autostart").checked,
    remind_popup: $("s-popup").value,
  };
  try {
    const saved = await api.putSettings(payload);
    state.settings = saved || payload;
    if (window.hwShell) {
      const results = await Promise.allSettled([
        window.hwShell.setAlwaysOnTop(payload.always_on_top),
        window.hwShell.setOpacity(payload.opacity),
        window.hwShell.setAutostart(payload.autostart),
        window.hwShell.setWindowScale(payload.window_scale),
      ]);
      if (results.some((r) => r.status === "rejected")) {
        $("settings-msg").textContent = "已保存（部分窗口设置未生效）";
        return;
      }
    }
    $("settings-msg").textContent = "已保存";
  } catch (err) {
    $("settings-msg").textContent = err.message;
  }
}

async function refreshSettings() {
  try {
    state.settings = await api.getSettings();
  } catch {
    /* 保持默认 */
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
      const popup = state.settings.remind_popup || "inapp";
      if (popup !== "inapp" && window.hwShell) {
        window.hwShell.notify(`🔔 ${d.title || "日程提醒"}`, sub);
      }
      if (popup !== "toast" || !window.hwShell) {
        const show = () => showBubble(d.title || "日程提醒", sub, show);
        show();
      }
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
  $("btn-status-sync").addEventListener("click", () => doSync());
  $("s-bb-remind").addEventListener("change", () => {
    $("bb-remind-detail").hidden = !$("s-bb-remind").checked;
  });
  [
    ["s-remind1-days", 0],
    ["s-remind1-hours", 0],
    ["s-remind2-days", 1],
    ["s-remind2-hours", 1],
  ].forEach(([id, slot]) => {
    $(id).addEventListener("change", () => {
      state.remindDirty[slot] = true;
    });
  });
  $("btn-edge-hide").addEventListener("click", () => {
    if (window.hwShell) window.hwShell.hideToEdge();
  });
  $("btn-settings").addEventListener("click", openSettings);
  let opacityIpcAt = 0;
  let opacityTimer = null;
  const sendOpacity = (v) => {
    opacityIpcAt = Date.now();
    if (window.hwShell) window.hwShell.setOpacity(v);
  };
  const opacitySlider = $("s-opacity");
  opacitySlider.addEventListener("input", () => {
    const v = Number(opacitySlider.value) || 0.95;
    $("s-opacity-val").textContent = Math.round(v * 100) + "%";
    const now = Date.now();
    if (now - opacityIpcAt > 50) {
      if (opacityTimer) {
        clearTimeout(opacityTimer);
        opacityTimer = null;
      }
      sendOpacity(v);
    } else if (!opacityTimer) {
      opacityTimer = setTimeout(() => {
        opacityTimer = null;
        sendOpacity(Number(opacitySlider.value) || 0.95);
      }, 50);
    }
  });
  opacitySlider.addEventListener("change", async () => {
    if (opacityTimer) {
      clearTimeout(opacityTimer);
      opacityTimer = null;
    }
    const v = Number(opacitySlider.value) || 0.95;
    if (window.hwShell) window.hwShell.setOpacity(v);
    try {
      const saved = await api.putSettings({ opacity: v });
      if (saved) state.settings = saved;
    } catch {
      /* 写穿失败不打断；「保存」仍可统一提交 */
    }
  });
  const scaleSlider = $("s-scale");
  let scaleIpcAt = 0;
  let scaleTimer = null;
  let scaleVisTimer = null;
  function pollScaleVisible(totalMs = 1200) {
    const t0 = Date.now();
    if (scaleVisTimer) clearInterval(scaleVisTimer);
    scaleVisTimer = setInterval(() => {
      ensureScaleVisible();
      if (Date.now() - t0 > totalMs) {
        clearInterval(scaleVisTimer);
        scaleVisTimer = null;
      }
    }, 80);
  }
  const sendScale = (p) => {
    scaleIpcAt = Date.now();
    if (window.hwShell) window.hwShell.setWindowScale(p);
    scheduleAnchor();
  };
  // 低档位下设置卡片可视高度收缩，滑条可能落到折叠线之外：仅滚动卡片内部保持其可见
  // （与窗口锚定解耦：这里动 card.scrollTop，锚定动窗口位置）
  function ensureScaleVisible() {
    const modal = $("modal-settings");
    if (!modal || modal.hidden) return false;
    const card = modal.querySelector(".modal-card");
    if (!card) return false;
    const cr = card.getBoundingClientRect();
    const sr = scaleSlider.getBoundingClientRect();
    const margin = 10;
    let delta = 0;
    if (sr.top < cr.top + margin) delta = sr.top - (cr.top + margin);
    else if (sr.bottom > cr.bottom - margin) delta = sr.bottom - (cr.bottom - margin);
    if (!delta) return false;
    const max = card.scrollHeight - card.clientHeight;
    card.scrollTop = Math.min(Math.max(card.scrollTop + delta, 0), Math.max(0, max));
    return true;
  }
  scaleSlider.addEventListener("input", () => {
    updateScaleReadout();
    const p = Number(scaleSlider.value) || 100;
    setCompact(p);
    ensureScaleVisible();
    const now = Date.now();
    if (now - scaleIpcAt > 60) {
      if (scaleTimer) {
        clearTimeout(scaleTimer);
        scaleTimer = null;
      }
      sendScale(p);
    } else if (!scaleTimer) {
      scaleTimer = setTimeout(() => {
        scaleTimer = null;
        sendScale(Number(scaleSlider.value) || 100);
      }, 60);
    }
  });
  scaleSlider.addEventListener("change", async () => {
    if (scaleTimer) {
      clearTimeout(scaleTimer);
      scaleTimer = null;
    }
    const p = Number(scaleSlider.value) || 100;
    setCompact(p);
    if (window.hwShell) {
      try {
        const r = await window.hwShell.setWindowScale(p);
        if (r && r.ok) {
          $("s-scale-val").textContent = `${r.scale}%（${r.width}×${r.height}）`;
        }
      } catch {
        /* 保持标称读数 */
      }
    }
    stopAnchor();
    pollScaleVisible(); // 键盘/程序化改档：短轮询至布局收敛，避免滑条被卡片折叠线裁掉
    try {
      const saved = await api.putSettings({ window_scale: p });
      if (saved) state.settings = saved;
    } catch {
      /* 写穿失败不打断 */
    }
  });

  // ---- 光标锚定：拖动缩放条时保持「滑条行」屏幕位置不动 ----
  let anchor = null;
  let anchorBusy = false;
  let anchorTimer = null;
  let anchorGen = 0; // 代数令牌：pointerdown 异步读锚点期间若已 pointerup，则丢弃过期结果
  async function readAnchor() {
    if (!window.hwShell || !window.hwShell.getWindowInfo) return null;
    try {
      const info = await window.hwShell.getWindowInfo();
      if (!info) return null;
      const rect = scaleSlider.getBoundingClientRect();
      const zoom = info.width / window.innerWidth;
      return {
        x: info.x + (rect.left + rect.width / 2) * zoom,
        y: info.y + (rect.top + rect.height / 2) * zoom,
      };
    } catch {
      return null;
    }
  }
  async function correctAnchor() {
    if (!anchor || anchorBusy || !window.hwShell || !window.hwShell.nudgeWindow) return;
    anchorBusy = true;
    try {
      const info = await window.hwShell.getWindowInfo();
      if (!info) return;
      const rect = scaleSlider.getBoundingClientRect();
      const zoom = info.width / window.innerWidth;
      const dx = anchor.x - (info.x + (rect.left + rect.width / 2) * zoom);
      const dy = anchor.y - (info.y + (rect.top + rect.height / 2) * zoom);
      // IPC 只传整数：按 1px DIP 取整，避免亚像素 nudge 抖动
      const rx = Math.round(dx);
      const ry = Math.round(dy);
      if ((rx || ry) && Math.abs(dx) + Math.abs(dy) > 0.5) await window.hwShell.nudgeWindow(rx, ry);
    } catch {
      /* 锚定非关键路径 */
    } finally {
      anchorBusy = false;
    }
  }
  function tickAnchor() {
    anchorTimer = null;
    if (!anchor) return;
    ensureScaleVisible(); // 拖到低档位时卡片收缩，及时把滑条滚回可视区
    if (!anchorBusy) {
      correctAnchor().finally(() => {
        if (anchor) anchorTimer = setTimeout(tickAnchor, 12);
      });
    } else {
      anchorTimer = setTimeout(tickAnchor, 12);
    }
  }
  function scheduleAnchor() {
    if (anchor && anchorTimer === null) anchorTimer = setTimeout(tickAnchor, 12);
  }
  function stopAnchor() {
    anchorGen++; // 使进行中的 pointerdown 异步读锚点失效
    anchor = null;
    if (anchorTimer) {
      clearTimeout(anchorTimer);
      anchorTimer = null;
    }
  }
  scaleSlider.addEventListener("pointerdown", async () => {
    ensureScaleVisible();
    const gen = ++anchorGen;
    const a = await readAnchor();
    if (gen !== anchorGen || !a) return; // 过期或已结束 → 丢弃，避免启动无人停止的循环
    anchor = a;
    scheduleAnchor();
  });
  scaleSlider.addEventListener("pointerup", stopAnchor);
  scaleSlider.addEventListener("pointercancel", stopAnchor);
  $("btn-item-close").addEventListener("click", closeItemOverview);
  $("btn-item-edit").addEventListener("click", () => {
    const o = state.overview;
    if (!o) return;
    closeItemOverview();
    openScheduleForm(o.item);
  });
  $("btn-item-open-bb").addEventListener("click", () => {
    const o = state.overview;
    if (!o) return;
    const u = bbUrl(o.item);
    if (u) openExternal(u);
  });
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
  fillSelect($("s-remind1-days"), 30);
  fillSelect($("s-remind1-hours"), 23);
  fillSelect($("s-remind2-days"), 30);
  fillSelect($("s-remind2-hours"), 23);
  renderMonth();
  await refreshState();
  await loadMonth();
  await loadDay();
  await refreshSettings();
  setCompact(Number(state.settings.window_scale) || 100);
  connectSSE();
}

init();

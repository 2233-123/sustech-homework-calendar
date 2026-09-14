// 作业日程 — 前端入口：状态 + 渲染 + 交互装配
import { createApi } from "./lib/api.js";
import { createSSE } from "./lib/sse.js";
import { addMonths, monthGrid } from "./lib/cal.js";
import { assignHues, contrastText, hslColor, hueForName } from "./lib/colors.js";
import { formatDateLabel, formatDateTime, formatLead, formatTime, toDateStr } from "./lib/fmt.js";
import { clampPage, pageCount } from "./lib/page.js";

// 数据流：init() → 拉取 state/月/日/设置 → 渲染（renderMonth/renderDay）；
// 交互（选日期/翻页/增删日程/设置/缩放）改 state 后重渲染并上报 reportFit()；
// reportFit 把 #app 内容高经 hwShell.fitHeight 交给 Electron 主进程驱动窗口自适应；
// SSE（connectSSE）在同步完成/登录变化/提醒时刷新或弹气泡。

const api = createApi();
const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 3;

// 上报内容高度驱动窗口自适应；同时按需切换 overflowing（工作区放不下时滚动兜底）
let lastFitH = -1;
let lastFitAt = 0;
let fitTimer = null;
let overflowState = false;
let lastClientH = -1;
let overflowTrailTimer = null;
let uiReady = false; // 由 init() 数据渲染完成后置位，避免首个 fit 测到半成品高度

// C1/N2：进入需 residual>8 且尺寸稳定；退出只需 residual≤1（不受稳定门阻拦，避免动画后常亮）
function evaluateOverflow() {
  const de = document.documentElement;
  const clientH = de.clientHeight;
  const residual = de.scrollHeight - clientH;
  if (overflowState) {
    if (residual <= 1) {
      overflowState = false;
      document.body.classList.remove("overflowing");
    }
    lastClientH = clientH;
    return;
  }
  const stable = clientH === lastClientH;
  lastClientH = clientH;
  if (stable && residual > 8) {
    overflowState = true;
    document.body.classList.add("overflowing");
  }
}

function scheduleOverflowTrail() {
  if (overflowTrailTimer) clearTimeout(overflowTrailTimer);
  overflowTrailTimer = setTimeout(() => {
    overflowTrailTimer = null;
    evaluateOverflow();
  }, 150);
}

/**
 * 上报内容高度以驱动窗口自适应（值去重 + 50ms 节流）。
 * 副作用：按需切换 body.overflowing；调用 hwShell.fitHeight(h)。
 */
function reportFit() {
  if (!uiReady) return;
  const run = () => {
    fitTimer = null;
    lastFitAt = Date.now();
    evaluateOverflow();
    scheduleOverflowTrail(); // 收敛后尾随再评估一次，确保终态正确
    const h = Math.round($("app").offsetHeight);
    if (h !== lastFitH) {
      lastFitH = h;
      if (window.hwShell && window.hwShell.fitHeight) window.hwShell.fitHeight(h);
    }
  };
  const since = Date.now() - lastFitAt;
  if (since >= 50) {
    if (fitTimer) {
      clearTimeout(fitTimer);
      fitTimer = null;
    }
    run();
  } else if (!fitTimer) {
    fitTimer = setTimeout(run, 50 - since);
  }
}

// ---------- 课程色相表（持久化在后端 config.json，跨重启/端口变化恒定） ----------
// 后端端口每次启动随机 → origin 变化 → localStorage 会失效；因此色表存后端配置的
// course_hues 键（随 %APPDATA%\作业日程\config.json 落盘，与端口/origin 无关）。
const HUE_SAVE_DEBOUNCE_MS = 400;
let huesHydrated = false; // 仅当成功从服务端读到设置后才置 true（N1 落盘门控）
let hueSaveTimer = null; // 防抖定时器
let hueSaveSeq = 0; // 调度代数：每次 scheduleHueSave 自增，标识"最新一轮改动"
let hueSaveSent = 0; // 已起飞请求覆盖到的代数（seq > sent ⇒ 有新改动未落盘）
let hueSaveInFlight = false; // 在途门：同一时刻至多一个 PUT，避免旧包后到覆盖新值

/**
 * 把配置中的 course_hues（dict）并入内存表；仅接受有限数字。
 * 合并语义：**服务端值优先于同名的会话内存值**（服务端为准）；会话独有的名字保留；
 * 缺失的名字随后由 syncCourseHues 按最大空隙补齐并防抖落盘。
 */
function hydrateCourseHues(raw) {
  if (!raw || typeof raw !== "object") return;
  for (const [name, hue] of Object.entries(raw)) {
    if (name && typeof hue === "number" && Number.isFinite(hue)) {
      state.courseHues.set(name, hue); // 覆盖同名会话值（服务端优先）
    }
  }
}

/**
 * 防抖落盘（~400ms）：仅提交 course_hues 一个键——后端 update_config 为 patch 合并
 * 语义，不覆盖其他设置键。
 * N1 门控：仅在成功从服务端读过设置（huesHydrated）后才允许写入；否则内存表可能只是
 * "空表 + 少量新名字"，全表 PUT 会覆盖服务端已存条目并重排颜色。渲染不受影响。
 */
function scheduleHueSave() {
  if (!huesHydrated) return; // 未水合：只渲染内存色，不落盘
  hueSaveSeq += 1;
  if (hueSaveTimer) clearTimeout(hueSaveTimer);
  hueSaveTimer = setTimeout(runHueSave, HUE_SAVE_DEBOUNCE_MS);
}

/**
 * 执行一轮落盘（提交当前内存表快照）。
 * 不变量：同一时刻至多一个 PUT 在途；在途期间到达的新调度不会丢失——在途请求的
 * finally 发现 seq > sent 会立刻补一轮。旧请求的成功回包不改变调度状态，故不会吞掉
 * 新一轮保存（N2 交错：t0 调度 A → t400 PUT#1 在途 → t405 新增 B 调度 → t805 必发 PUT#2）。
 * 失败：sent 已在起飞时推进（失败不回滚、不忙等重试），仅保留内存态，等下一次变化重新调度。
 */
async function runHueSave() {
  hueSaveTimer = null;
  if (hueSaveInFlight) return; // 在途完成后按 seq/sent 对比自行补齐
  const seq = hueSaveSeq;
  hueSaveSent = seq;
  hueSaveInFlight = true;
  try {
    const saved = await api.putSettings({ course_hues: Object.fromEntries(state.courseHues) });
    // 过期回包（期间又有新调度）不覆盖更新的本地设置视图
    if (saved && hueSaveSeq === seq) state.settings = saved;
  } catch {
    /* 失败：保留内存态；下次 syncCourseHues 有新增时再次调度 */
  } finally {
    hueSaveInFlight = false;
    if (hueSaveSeq > hueSaveSent && !hueSaveTimer) hueSaveTimer = setTimeout(runHueSave, 0);
  }
}

const state = {
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  selected: toDateStr(new Date()),
  courseHues: new Map(), // 由 refreshSettings() 从配置载入（见 hydrateCourseHues）
  editingId: null,
  monthData: { schedules: [], assignments: [] },
  dayData: { schedules: [], assignments: [] },
  settings: {},
  overview: null,
  remindLoaded: [null, null],
  remindDirty: [false, false],
  dayPage: 0,
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

/**
 * 汇总月/日数据中出现的课程名（assignments 并集），为未分配者补齐色相并防抖落盘。
 * 新课程按名称排序逐个取最大空隙中点；已分配课程永不改色；无新增不写盘。
 */
function syncCourseHues() {
  const names = [
    ...state.monthData.assignments.map((a) => a.course_name),
    ...state.dayData.assignments.map((a) => a.course_name),
  ];
  const fresh = assignHues(state.courseHues, names.filter((n) => n));
  const keys = Object.keys(fresh);
  if (!keys.length) return;
  for (const k of keys) state.courseHues.set(k, fresh[k]);
  scheduleHueSave();
}

async function loadMonth() {
  try {
    const data = await api.getCalendar(state.year, state.month);
    state.monthData = { schedules: data.schedules || [], assignments: data.assignments || [] };
  } catch (err) {
    setStatus(`日历加载失败：${err.message}`);
    state.monthData = { schedules: [], assignments: [] };
  }
  syncCourseHues(); // 月视图课程名先入表（日数据到达时继续补齐）
  renderMonth();
}

// 代际令牌：快速连续切日期时，旧请求的响应可能后到；只允许最新代际渲染，
// 否则会出现「标签是新日期、内容还是旧日期」（竞态）。
let loadDayGen = 0;
/**
 * 加载选中日的事务并按页渲染日列表。
 * 副作用：更新 state.dayPage/state.dayData，触发 renderDay 与 fit 上报。
 */
async function loadDay() {
  const gen = ++loadDayGen; // I2：代际守卫，快速连续切日期时丢弃过期响应
  state.dayPage = 0;
  try {
    const data = await api.getDay(state.selected);
    if (gen !== loadDayGen) return;
    state.dayData = { schedules: data.schedules || [], assignments: data.assignments || [] };
  } catch {
    if (gen !== loadDayGen) return;
    state.dayData = { schedules: [], assignments: [] };
  }
  syncCourseHues(); // 月+日课程名并集补齐色相，保证本页 chip 一律有稳定颜色
  renderDay();
}

function selectDate(date) {
  state.selected = date;
  state.dayPage = 0;
  renderMonth();
  loadDay();
}

// ---------- 渲染 ----------
/** 渲染月视图：每格两行结构（数字 + 常驻圆点占位），圆点 sched/bb 两色、各 3 枚封顶。 */
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
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = String(cell.day);
      btn.appendChild(num);
      const wrap = document.createElement("span");
      wrap.className = "dots"; // 常驻占位（无事项也占行），保证全网格基线一致
      const d = dots.get(cell.date);
      if (d && (d.sched || d.bb)) {
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
      }
      btn.appendChild(wrap);
      btn.addEventListener("click", () => selectDate(cell.date));
      grid.appendChild(btn);
    }
  }
  reportFit();
}

/**
 * 渲染当日列表：按当前页切片（每页 3 条），构建分页器，最后触发 fit 上报。
 * BB 事务行为两行结构（第 1 行课程彩色 chip、第 2 行单行省略标题），双倍行高；
 * 自建日程行保持原单行外观。
 */
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
    renderPager(1, 0);
    reportFit();
    return;
  }
  const pc = pageCount(rows.length);
  state.dayPage = clampPage(state.dayPage, rows.length);
  const page = state.dayPage;
  for (const row of rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)) {
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
    title.textContent = row.item.title; // 标题只保留原文，课程名改由 chip 承载
    if (row.item.color) {
      li.style.borderLeft = `3px solid ${row.item.color}`;
      li.style.paddingLeft = "6px";
    }
    if (row.kind === "assignment") {
      li.classList.add("bb-row"); // 2 行结构 → 双倍行高（css .bb-row）
      const name = row.item.course_name;
      if (name) {
        const chip = document.createElement("span");
        chip.className = "course-chip";
        chip.textContent = name;
        // 不变量：渲染前必经 syncCourseHues 补齐色表（loadMonth/loadDay 末尾调用）；
        // 此处 ?? 兜底仅防御异常路径（配置读取失败后直接渲染），只算内存色、不落盘。
        const hue = state.courseHues.get(name) ?? hueForName(name, [...state.courseHues.values()]);
        chip.style.background = hslColor(hue);
        chip.style.color = contrastText(hue);
        chip.title = `${name}${row.item.submitted ? " · 已提交" : ""}`; // 沿用原 BB 徽标 tooltip 信息
        const main = document.createElement("div");
        main.className = "bb-main"; // 第 1 行 chip、第 2 行标题（单行省略）
        main.append(chip, title);
        li.append(time, main);
      } else {
        li.classList.add("no-chip"); // 无课程名：标题垂直居中，仍保持 66px 高（= 2×33）
        li.append(time, title);
      }
    } else {
      li.append(time, title);
    }
    li.addEventListener("click", () => openItemOverview(row.kind, row.item));
    list.appendChild(li);
  }
  renderPager(pc, page);
  reportFit();
}

/** 构建/更新分页器：页数 ≤1 隐藏；圆点点击跳页；首/末页对应箭头禁用。 */
function renderPager(pageCount, page) {
  const pager = $("day-pager");
  const dots = $("pager-dots");
  if (pageCount <= 1) {
    pager.hidden = true;
    dots.replaceChildren();
    return;
  }
  pager.hidden = false;
  $("pager-prev").disabled = page <= 0;
  $("pager-next").disabled = page >= pageCount - 1;
  dots.replaceChildren();
  for (let i = 0; i < pageCount; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pager-dot" + (i === page ? " active" : "");
    b.title = `第 ${i + 1} 页`;
    b.addEventListener("click", () => {
      state.dayPage = i;
      renderDay();
    });
    dots.appendChild(b);
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
/**
 * 由 BB 事务生成外链。
 * DB 中的 id 是 normalize_bb_id 处理后的裸 id（已去 `_`/`_1`），这里还原为 BB 的 `_<id>_1`；
 * 有 content_id 用内容页，否则退回课程主页。
 * @param {object} item @returns {string|null} 无 course_id 返回 null
 */
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

/**
 * 打开事务概览弹层（日程/BB 共用）。
 * 字段以 createElement + textContent 构建（外部字符串不拼 innerHTML）；
 * 按 kind 决定可编辑（日程）与可在 BB 打开（作业）。
 * @param {"schedule"|"assignment"} kind @param {object} item
 */
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
  const w = state.winW ?? Math.round((408 * p) / 100);
  const h = state.winH ?? Math.round((760 * p) / 100);
  $("s-scale-val").textContent = `${p}%（${w}×${h}）`;
}

async function openSettings() {
  $("settings-msg").textContent = "";
  state.remindDirty = [false, false];
  try {
    const cfg = await api.getSettings();
    state.settings = cfg;
    huesHydrated = true; // 幂等补读成功：同样开闸（N1；启动时读取失败后的补救路径）
    hydrateCourseHues(cfg.course_hues);
    $("s-interval").value = cfg.refresh_interval_min ?? 30;
    const pullMonths = Number(cfg.bb_pull_months); // 0 = 不限；非法值回退默认 1
    $("s-pull-months").value = [1, 2, 3, 6, 0].includes(pullMonths) ? String(pullMonths) : "1";
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
    bb_pull_months: Number($("s-pull-months").value) || 0, // 0 = 不限
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
    huesHydrated = true; // 服务端设置已成功读取：开闸允许色表落盘（N1）
    hydrateCourseHues(state.settings.course_hues); // 色表随配置载入（首帧渲染前调用）
  } catch {
    /* 读取失败：保持内存态、门控保持关闭——渲染照常（内存色），但本轮不落盘，
       避免"空表 + 新名字"的全表 PUT 覆盖服务端已存条目（N1） */
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
  const sendScale = async (p) => {
    scaleIpcAt = Date.now();
    if (window.hwShell) {
      try {
        const r = await window.hwShell.setWindowScale(p);
        if (r && r.ok) {
          state.winW = r.width;
          state.winH = r.height;
          updateScaleReadout();
        }
      } catch {
        /* 保持标称读数 */
      }
    }
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
    if (window.hwShell) {
      try {
        const r = await window.hwShell.setWindowScale(p);
        if (r && r.ok) {
          state.winW = r.width;
          state.winH = r.height;
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
  // 数学：滑条行中心的「屏幕坐标」= 窗口左上角(DP) + 元素视口坐标 × zoom，
  // 其中 zoom = 窗口宽 / innerWidth（把 CSS px 换算为窗口 DIP）。pointerdown 记下该点，
  // 每 12ms 重算并 nudge 窗口使差值归零；nudge 只传整数（亚像素会抖动）。
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
  $("pager-prev").addEventListener("click", () => {
    if (state.dayPage > 0) {
      state.dayPage--;
      renderDay();
    }
  });
  $("pager-next").addEventListener("click", () => {
    state.dayPage++;
    renderDay();
  });
  window.addEventListener("resize", () => requestAnimationFrame(reportFit));
  // I1 兜底：重新可见/获焦时重置去重并重报，修正隐藏期间的内容高变化
  const onVisible = () => {
    if (document.hidden) return;
    if (Math.round($("app").offsetHeight) === lastFitH) return; // 高未变 → 不重置、不上报（避免无谓 PUT）
    lastFitH = -1;
    reportFit();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
}

/**
 * 启动流程：装配事件 → 载入配置（含色表）→ 首轮数据渲染 → 置 uiReady 并首报 fit → 订阅 SSE。
 * 配置先于数据加载：chip 首帧渲染即用持久化色相，避免"先算后换"的闪烁。
 */
async function init() {
  bind();
  fillSelect($("s-remind1-days"), 30);
  fillSelect($("s-remind1-hours"), 23);
  fillSelect($("s-remind2-days"), 30);
  fillSelect($("s-remind2-hours"), 23);
  renderMonth();
  await refreshState();
  await refreshSettings(); // 先取配置（course_hues），再渲染日列表
  await loadMonth();
  await loadDay();
  uiReady = true; // N1：数据首轮渲染完成后才允许上报 fit（避免半成品高度）
  reportFit(); // 直接首报（offsetHeight 读取强制同步布局；隐藏窗口 rAF 被节流，不能等 rAF）
  setTimeout(reportFit, 0); // 单次兜底，不再用双 rAF
  if (window.ResizeObserver) new ResizeObserver(() => reportFit()).observe($("app")); // 捕获后续内容高变化
  connectSSE();
}

init();

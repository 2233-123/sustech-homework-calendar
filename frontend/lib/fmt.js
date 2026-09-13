// 时间与日期纯格式化工具（无 DOM、无依赖）
// 时间字符串统一为 'YYYY-MM-DDTHH:MM:SS'（本地时间，字典序即时间序）。
export const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

/** 两位补零。@param {number|string} n @returns {string} */
export function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Date → 'YYYY-MM-DD'（本地日期）。@param {Date} d @returns {string} */
export function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 'YYYY-MM-DD[THH:MM:SS]' → 本地 Date（不经 UTC）。
 * 故意不用 `new Date(str)`：后者对仅日期字符串按 UTC 解析，会因时区差一天。
 * @param {string} iso @returns {Date}
 */
export function parseLocal(iso) {
  const [datePart, timePart = "00:00:00"] = String(iso).split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm, ss] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0);
}

/** 时间字符串 → 'HH:MM'（空值返回 ""）。@param {string} iso @returns {string} */
export function formatTime(iso) {
  if (!iso) return "";
  const d = parseLocal(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 日期字符串 → 'M 月 D 日 周X'（周一起算）。@param {string} dateStr @returns {string} */
export function formatDateLabel(dateStr) {
  const d = parseLocal(dateStr);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 周${WEEKDAYS[(d.getDay() + 6) % 7]}`;
}

/**
 * 提前量（秒）→ 可读中文，如 5400 → "1 小时 30 分钟"。非正数/非法返回 ""。
 * @param {number} seconds @returns {string}
 */
export function formatLead(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "";
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} 天${hours > 0 ? ` ${hours} 小时` : ""}`;
  if (hours > 0) return `${hours} 小时${minutes > 0 ? ` ${minutes} 分钟` : ""}`;
  return `${minutes} 分钟`;
}

/** 完整时间 → 'M 月 D 日 HH:MM'（空值返回 ""）。@param {string} iso @returns {string} */
export function formatDateTime(iso) {
  if (!iso) return "";
  const d = parseLocal(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

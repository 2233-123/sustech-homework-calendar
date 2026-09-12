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
  if (!iso) return "";
  const d = parseLocal(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatDateLabel(dateStr) {
  const d = parseLocal(dateStr);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 周${WEEKDAYS[(d.getDay() + 6) % 7]}`;
}

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

// 课程标签配色（纯函数，无 DOM）：名字 → 稳定色相 → 鲜艳 HSL 颜色 + 对比文字色。
// 设计：新色相取"已占用色相"集合上最大空隙的中点，保证同批课程颜色尽量分散；
// 色相由调用方持久化（app.js → 后端 config.json 的 course_hues），已分配课程永不改色。

/**
 * 在已占用色相集合上取最大空隙的中点作为新色相。
 * 空集返回 210（默认蓝）；并列空隙取下限一端（确定性）。
 * @param {string} name 课程名（保留参数以便未来按名散列；当前不参与计算）
 * @param {Iterable<number>} takenHues 已占用色相（度，0–360）
 * @returns {number} 新色相（度，0–360）
 */
export function hueForName(name, takenHues) {
  // 先归一化到 [0,360) 再去重（-30 与 330 视为同一色相）、丢弃非有限值
  const taken = [...new Set(
    [...takenHues]
      .map((h) => Number(h))
      .filter(Number.isFinite)
      .map((h) => ((h % 360) + 360) % 360)
  )].sort((a, b) => a - b);
  if (!taken.length) return 210;
  if (taken.length === 1) return (taken[0] + 180) % 360; // 只有一个占用：取对侧
  // 环形相邻对（含首尾跨 0°）中找最大空隙，取其中点
  let bestGap = -1;
  let bestMid = 0;
  for (let i = 0; i < taken.length; i++) {
    const a = taken[i];
    const b = taken[(i + 1) % taken.length];
    const gap = i === taken.length - 1 ? b + 360 - a : b - a;
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = (a + gap / 2) % 360;
    }
  }
  return bestMid;
}

/**
 * HSL(72%,52%) → sRGB 分量（0–1）；仅用于亮度计算（纯数学，无 DOM）。
 * 与浏览器 `hsl()` 的换算一致（浏览器展示时按 8bit 取整，对亮度判定无实质影响）。
 * @param {number} hue 色相（度）@returns {[number, number, number]}
 */
function hslToRgb(hue) {
  const h = ((Number(hue) % 360) + 360) % 360;
  const s = 0.72;
  const l = 0.52;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((v) => v + m);
}

/**
 * WCAG 相对亮度（0–1）：先做 sRGB 线性化再加权。
 * 峰值在黄绿(≈60°)与青(≈170°)，谷值在蓝紫(≈240°)。
 * @param {number} hue 色相（度）@returns {number}
 */
function relativeLuminance(hue) {
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = hslToRgb(hue).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 按真实相对亮度选文字色：亮度 > 0.2241 用深字 #1f2937，否则白字。
 * 0.2241 为「深字/白字对比度相等点」：由 #1f2937 的 WCAG 相对亮度
 * L(#1f2937) = 0.02153 反解 (L+0.05)² = 1.05×(0.02153+0.05) → L ≈ 0.2241；
 * 即对每个色相都取对比度更高的一侧。实测深字区间 ≈15°–210°（1° 级边界）。
 * @param {number} hue 色相（度）@returns {string} 文字色
 */
export function contrastText(hue) {
  return relativeLuminance(hue) > 0.2241 ? "#1f2937" : "#ffffff";
}

/**
 * 色相 → 鲜艳背景色（固定 S=72%、L=52%）。
 * @param {number} hue 色相（度）
 * @returns {string} hsl() 颜色
 */
export function hslColor(hue) {
  const h = ((Number(hue) % 360) + 360) % 360;
  return `hsl(${h}, 72%, 52%)`;
}

/**
 * 从 name → hue 映射与一批课程名中，为尚未分配的名字生成新色相。
 * 纯函数：不修改传入 Map，返回"名字 → 新 hue"的无原型对象
 * （避免课程名为 `__proto__` 等特殊键时被赋值吞掉；名字按字典序排序后逐个分配，确定性）。
 * @param {Map<string, number>|Iterable<[string, number]>} assigned 已分配映射
 * @param {Iterable<string>} names 候选课程名（可含已分配项，自动跳过）
 * @returns {Record<string, number>} 仅含新分配项
 */
export function assignHues(assigned, names) {
  const map = new Map(assigned);
  const fresh = [...new Set(names)].filter((n) => n && !map.has(n)).sort();
  const out = Object.create(null);
  for (const n of fresh) {
    const hue = hueForName(n, map.values());
    map.set(n, hue);
    out[n] = hue;
  }
  return out;
}

// 分页数学（纯函数，无 DOM）

/**
 * 总条数 → 页数；0 条也视为 1 页（用于显示空提示时隐藏分页器）。
 * @param {number} total @param {number} [size=3] @returns {number}
 */
export function pageCount(total, size = 3) {
  return total <= 0 ? 1 : Math.ceil(total / size);
}

/**
 * 页码钳制到 [0, pageCount(total)-1]；非法输入按 0 处理。
 * @param {number} page @param {number} total @param {number} [size=3] @returns {number}
 */
export function clampPage(page, total, size = 3) {
  const pc = pageCount(total, size);
  return Math.min(Math.max(Number(page) || 0, 0), pc - 1);
}

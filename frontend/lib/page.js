// 分页数学（纯函数，无 DOM）
export function pageCount(total, size = 3) {
  return total <= 0 ? 1 : Math.ceil(total / size);
}

export function clampPage(page, total, size = 3) {
  const pc = pageCount(total, size);
  return Math.min(Math.max(Number(page) || 0, 0), pc - 1);
}

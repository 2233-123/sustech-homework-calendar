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
  assert.equal(weeks[0][0].date, "2026-08-31");
  assert.equal(weeks[0][1].date, "2026-09-01");
});

test("monthGrid 标记 inMonth 与 isToday", () => {
  const weeks = monthGrid(2026, 9, "2026-09-12");
  const flat = weeks.flat();
  assert.equal(flat.filter((c) => c.inMonth).length, 30);
  assert.equal(flat.find((c) => c.isToday).date, "2026-09-12");
  assert.equal(flat.find((c) => c.date === "2026-09-12").inMonth, true);
});

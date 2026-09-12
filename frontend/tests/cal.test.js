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

test("monthGrid 边界：二月天数、周一/周日起始、跨年尾部", () => {
  assert.equal(monthGrid(2023, 2, "2023-02-01").flat().filter((c) => c.inMonth).length, 28);
  assert.equal(monthGrid(2024, 2, "2024-02-01").flat().filter((c) => c.inMonth).length, 29);
  const mondayStart = monthGrid(2027, 2, "2027-02-01"); // 2027-02-01 为周一
  assert.equal(mondayStart[0][0].date, "2027-02-01");
  const sundayStart = monthGrid(2026, 11, "2026-11-01"); // 2026-11-01 为周日
  assert.equal(sundayStart[0][0].date, "2026-10-26");
  const tail = monthGrid(2026, 12, "2026-12-01").flat().filter((c) => c.date.startsWith("2027-01"));
  assert.ok(tail.length > 0);
  assert.ok(tail.every((c) => !c.inMonth));
});

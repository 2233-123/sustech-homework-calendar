import test from "node:test";
import assert from "node:assert/strict";

import { formatDateLabel, formatTime, parseLocal, toDateStr } from "../lib/fmt.js";

test("toDateStr 补零格式", () => {
  assert.equal(toDateStr(new Date(2026, 8, 12)), "2026-09-12");
  assert.equal(toDateStr(new Date(2026, 0, 3)), "2026-01-03");
});

test("parseLocal 按本地时间解析，不经 UTC", () => {
  const d = parseLocal("2026-09-12T14:05:30");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 12);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 5);
});

test("parseLocal 容忍仅日期字符串", () => {
  const d = parseLocal("2026-09-12");
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test("formatTime 输出 HH:MM", () => {
  assert.equal(formatTime("2026-09-12T14:05:00"), "14:05");
  assert.equal(formatTime("2026-09-12T09:00:00"), "09:00");
});

test("formatDateLabel 中文标签（周一起算）", () => {
  assert.equal(formatDateLabel("2026-09-12"), "9 月 12 日 周六");
  assert.equal(formatDateLabel("2026-09-14"), "9 月 14 日 周一");
});

import test from "node:test";
import assert from "node:assert/strict";

import { clampPage, pageCount } from "../lib/page.js";

test("pageCount：0/3/4/7 条", () => {
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(3), 1);
  assert.equal(pageCount(4), 2);
  assert.equal(pageCount(7), 3);
});

test("pageCount：自定义每页条数", () => {
  assert.equal(pageCount(6, 2), 3);
  assert.equal(pageCount(7, 2), 4);
  assert.equal(pageCount(1, 5), 1);
});

test("clampPage：页码越界钳制", () => {
  assert.equal(clampPage(-1, 7), 0);
  assert.equal(clampPage(0, 7), 0);
  assert.equal(clampPage(2, 7), 2);
  assert.equal(clampPage(9, 7), 2);
  assert.equal(clampPage(3, 0), 0);
});

test("clampPage：非法输入回退首页", () => {
  assert.equal(clampPage(undefined, 7), 0);
  assert.equal(clampPage("x", 7), 0);
  assert.equal(clampPage(NaN, 3), 0);
});

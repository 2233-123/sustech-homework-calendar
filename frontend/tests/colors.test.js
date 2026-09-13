import test from "node:test";
import assert from "node:assert/strict";

import { assignHues, contrastText, hslColor, hueForName } from "../lib/colors.js";

// 环形距离（度）：两色相在 360° 圆上的最短夹角
const circDist = (a, b) => {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(d, 360 - d);
};

test("hueForName：空集返回默认蓝 210", () => {
  assert.equal(hueForName("任意课程", []), 210);
  assert.equal(hueForName("任意课程", new Set()), 210);
});

test("hueForName：第二个课程取对侧（距离最大）", () => {
  assert.equal(hueForName("B", [210]), 30);
  assert.equal(hueForName("B", [0]), 180);
});

test("hueForName：已占用色相乱序/去重后仍确定性", () => {
  assert.equal(hueForName("X", [210, 30]), hueForName("X", [30, 210, 30]));
});

test("hueForName：并列空隙取下限一端（确定性）", () => {
  // [30,210] 两侧空隙各 180，取下限 30 侧 → 中点 120
  assert.equal(hueForName("C", [30, 210]), 120);
});

test("assignHues：N=6 任意两色相环距 ≥ 30°", () => {
  const hues = assignHues(new Map(), ["语文", "数学", "英语", "物理", "化学", "生物"]);
  const vals = Object.values(hues);
  assert.equal(vals.length, 6);
  assert.equal(vals[0], 210); // 按字典序首个分配到默认蓝
  for (let i = 0; i < vals.length; i++) {
    for (let j = i + 1; j < vals.length; j++) {
      assert.ok(circDist(vals[i], vals[j]) >= 30, `色相 ${vals[i]} 与 ${vals[j]} 环距不足 30°`);
    }
  }
});

test("assignHues：新增课程不改变已有课程的色相", () => {
  const assigned = new Map([
    ["数学", 210],
    ["英语", 30],
  ]);
  const out = assignHues(assigned, ["数学", "英语", "物理"]);
  assert.deepEqual(Object.keys(out), ["物理"]);
  assert.equal(assigned.get("数学"), 210); // 原映射不被修改
  assert.equal(assigned.get("英语"), 30);
  assert.equal(assigned.has("物理"), false);
  assert.ok(circDist(out["物理"], 210) >= 90);
  assert.ok(circDist(out["物理"], 30) >= 90);
});

test("assignHues：同批重复名只分配一次、空名跳过", () => {
  const out = assignHues(new Map(), ["数学", "数学", "", null, "物理"]);
  assert.deepEqual(Object.keys(out), ["数学", "物理"]);
});

test("assignHues：确定性（同输入同输出）", () => {
  const names = ["甲", "乙", "丙", "丁"];
  assert.deepEqual(assignHues(new Map(), names), assignHues(new Map(), names));
  // 两阶段补齐：已分配课程被跳过（返回仅含新名字），已有色相不受影响
  const step1 = assignHues(new Map(), ["甲", "乙"]);
  const step2 = assignHues(new Map(Object.entries(step1)), names);
  assert.equal(step2["甲"], undefined);
  assert.equal(step2["乙"], undefined);
  assert.deepEqual(Object.keys(step2).sort(), ["丁", "丙"]);
  // 对同一前态重复补齐结果一致（确定性）
  assert.deepEqual(step2, assignHues(new Map(Object.entries(step1)), names));
});

test("contrastText：黄绿浅底用深字、蓝紫深底用白字", () => {
  assert.equal(contrastText(60), "#1f2937");
  assert.equal(contrastText(120), "#1f2937");
  assert.equal(contrastText(240), "#ffffff");
  assert.equal(contrastText(210), "#ffffff");
  assert.equal(contrastText(0), "#ffffff");
  assert.equal(contrastText(300), "#ffffff");
});

test("contrastText：按真实相对亮度判定（橙/青也要深字）", () => {
  // 橙 30°：深字对比 ≈5.1:1（白字仅 2.8:1）；青 165°：深字 ≈8.3:1（白字仅 1.7:1）
  assert.equal(contrastText(30), "#1f2937");
  assert.equal(contrastText(165), "#1f2937");
  assert.equal(contrastText(195), "#1f2937");
  assert.equal(contrastText(255), "#ffffff");
});

test("contrastText：浅/深底分界（亮度 0.2266 两侧）", () => {
  assert.equal(contrastText(25), "#1f2937");
  assert.equal(contrastText(15), "#ffffff");
  assert.equal(contrastText(205), "#1f2937");
  assert.equal(contrastText(215), "#ffffff");
});

test("hslColor：固定饱和度/亮度、色相归一化", () => {
  assert.equal(hslColor(210), "hsl(210, 72%, 52%)");
  assert.equal(hslColor(390), "hsl(30, 72%, 52%)");
  assert.equal(hslColor(-30), "hsl(330, 72%, 52%)");
});

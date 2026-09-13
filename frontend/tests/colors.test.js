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

test("hueForName：环形 wrap 与越界归一化", () => {
  // 300→100 跨 0° 空隙 160 最大 → 中点 (300+80)%360 = 20
  assert.equal(hueForName("x", [100, 200, 300]), 20);
  assert.equal(hueForName("x", [720]), 180); // 720 ≡ 0 → 单元素取对侧
  // -30 ≡ 330（归一化后去重为 {90,330}）：330→90 跨 0° 空隙 240 最大 → 中点 210
  assert.equal(hueForName("x", [-30, 330, 90]), 210);
  assert.equal(hueForName("x", [0, 360]), 180); // 归一化后同值去重 → 单元素对侧
  assert.equal(hueForName("x", [NaN, Infinity, 90]), 270); // 非有限值被丢弃 → 单元素对侧
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

test("assignHues：特殊键名（__proto__/constructor）不被吞掉", () => {
  const out = assignHues(new Map(), ["__proto__", "constructor"]);
  assert.deepEqual(Object.keys(out).sort(), ["__proto__", "constructor"]);
  assert.equal(typeof out["__proto__"], "number");
  assert.equal(typeof out["constructor"], "number");
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
  assert.equal(contrastText(0), "#ffffff");
  assert.equal(contrastText(300), "#ffffff");
});

test("contrastText：按真实相对亮度判定（橙/青/默认蓝 210 都取更高对比一侧）", () => {
  // 橙 30°：深字 ≈5.22:1（白字仅 2.81:1）；青 165°：深字 ≈8.45:1（白字仅 1.74:1）
  assert.equal(contrastText(30), "#1f2937");
  assert.equal(contrastText(165), "#1f2937");
  assert.equal(contrastText(195), "#1f2937");
  assert.equal(contrastText(255), "#ffffff");
  // 默认蓝 210°：深字 3.85:1 略高于白字 3.81:1（在等对比点 0.2241 之上）
  assert.equal(contrastText(210), "#1f2937");
});

test("contrastText：浅/深底分界（等对比点 0.2241 两侧，实测深字区间 15°–210°）", () => {
  assert.equal(contrastText(15), "#1f2937");
  assert.equal(contrastText(14), "#ffffff");
  assert.equal(contrastText(210), "#1f2937");
  assert.equal(contrastText(211), "#ffffff");
});

test("hslColor：固定饱和度/亮度、色相归一化", () => {
  assert.equal(hslColor(210), "hsl(210, 72%, 52%)");
  assert.equal(hslColor(390), "hsl(30, 72%, 52%)");
  assert.equal(hslColor(-30), "hsl(330, 72%, 52%)");
});

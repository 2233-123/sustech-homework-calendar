#!/usr/bin/env node
// 逐帧渲染：playwright-core + 本机缓存 Chromium（headless），viewport 1920×1080 @1x。
// 对每个时刻 t 调 window.renderFrame(t)（确定性，纯时间函数），PNG 落盘。
//
// 用法：
//   node render.js                              # 全量：1800 帧 → <out>/f%05d.png
//   node render.js --times 1.2,5.5,10.8         # 关键帧预审：仅渲染这些秒 → <out>/key-*.png
//   node render.js --from 600 --to 660          # 局部重渲
//   node render.js --out <dir> --html <file>    # 自定义输出目录 / 页面
//
// 环境变量：PLAYWRIGHT_CORE_PATH、CHROMIUM_EXE（覆盖自动探测）
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FPS = 60, TOTAL = 1800, W = 1920, H = 1080;

function loadPlaywrightCore() {
  const errors = [];
  const tryRequire = (p) => { try { return require(p); } catch (e) { errors.push(`${p}: ${e.code || e.message}`); return null; } };
  let mod = tryRequire("playwright-core");
  if (mod) return mod;
  const candidates = [];
  if (process.env.PLAYWRIGHT_CORE_PATH) candidates.push(process.env.PLAYWRIGHT_CORE_PATH);
  const npxCache = path.join(process.env.LOCALAPPDATA || "", "npm-cache", "_npx");
  if (fs.existsSync(npxCache)) for (const d of fs.readdirSync(npxCache)) candidates.push(path.join(npxCache, d, "node_modules", "playwright-core"));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "package.json"))) { mod = tryRequire(c); if (mod) return mod; }
  }
  throw new Error(`未找到 playwright-core（npm i 或设置 PLAYWRIGHT_CORE_PATH）\n${errors.join("\n")}`);
}

function findChromium() {
  if (process.env.CHROMIUM_EXE && fs.existsSync(process.env.CHROMIUM_EXE)) return process.env.CHROMIUM_EXE;
  const root = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
  if (fs.existsSync(root)) {
    const found = fs.readdirSync(root)
      .filter((n) => /^chromium-\d+$/.test(n))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
      .map((n) => path.join(root, n, "chrome-win64", "chrome.exe"))
      .find((p) => fs.existsSync(p));
    if (found) return found;
  }
  throw new Error("未找到本机 Chromium；设置 CHROMIUM_EXE 或 npx playwright install chromium");
}

function parseArgs(argv) {
  const args = { out: path.join(os.tmpdir(), "opencode", "promo", "frames"), html: path.join(__dirname, "index.html"), times: null, from: 0, to: TOTAL - 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else if (argv[i] === "--html") args.html = path.resolve(argv[++i]);
    else if (argv[i] === "--times") args.times = argv[++i].split(",").map((s) => parseFloat(s));
    else if (argv[i] === "--from") args.from = parseInt(argv[++i], 10);
    else if (argv[i] === "--to") args.to = parseInt(argv[++i], 10);
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const { chromium } = loadPlaywrightCore();
  fs.mkdirSync(args.out, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ["--force-color-profile=srgb", "--disable-lcd-text"] });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await page.goto("file:///" + args.html.replace(/\\/g, "/"), { waitUntil: "load" });
    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
    await page.waitForTimeout(200);
    if (args.times) {
      for (const t of args.times) {
        const file = path.join(args.out, `key-${String(Math.round(t * 100)).padStart(5, "0")}.png`);
        await page.evaluate((tt) => window.renderFrame(tt), t);
        await page.screenshot({ path: file });
        console.log(`key t=${t}s -> ${file} (${fs.statSync(file).size} bytes)`);
      }
      return;
    }
    const total = args.to - args.from + 1;
    const t0 = Date.now();
    for (let i = args.from; i <= args.to; i++) {
      await page.evaluate((tt) => window.renderFrame(tt), i / FPS);
      await page.screenshot({ path: path.join(args.out, `f${String(i).padStart(5, "0")}.png`) });
      const done = i - args.from + 1;
      if (done % 60 === 0 || done === total) {
        const el = (Date.now() - t0) / 1000;
        const eta = el / done * (total - done);
        console.log(`frame ${i}/${args.to} (${(done / total * 100).toFixed(1)}%) elapsed ${el.toFixed(0)}s eta ${eta.toFixed(0)}s`);
      }
    }
    console.log(`done: ${total} frames -> ${args.out}`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

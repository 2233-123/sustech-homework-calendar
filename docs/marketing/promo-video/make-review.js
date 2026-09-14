#!/usr/bin/env node
// 视觉自检物料：从已渲染的关键帧生成 contact sheet 与相邻帧对（±1 帧），供直读比对。
// 合成用本机 Chromium（playwright-core，无外部依赖；避免 ffmpeg 滤镜图对异构输入的自适应缩放）。
// 注意：画布页必须以 file:// 源加载，否则绘制 file:// 图片会被同源策略拦截。
//
// 用法：
//   node make-review.js --keys <关键帧目录> --frames <全帧目录> --out <review 目录>
//
// 产物：
//   review/contact-sheet.png               缩略网格（关键帧全览）
//   review/keyframes/key-<t>.png           原尺寸关键帧（直读用）
//   review/adjacent/t<t>_f<a>_f<b>.png     相邻帧对（左右拼接，验连续性/无跳变）
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FPS = 60;
const TILE_W = 480, TILE_H = 270, PAD = 8, COLS = 4;

function loadPlaywrightCore() {
  const cands = ["playwright-core", process.env.PLAYWRIGHT_CORE_PATH, path.join(process.env.LOCALAPPDATA || "", "npm-cache", "_npx")].filter(Boolean);
  for (const c of cands) {
    try { return require(c); } catch (_) { /* try next */ }
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      for (const d of fs.readdirSync(c)) {
        const p = path.join(c, d, "node_modules", "playwright-core");
        if (fs.existsSync(path.join(p, "package.json"))) { try { return require(p); } catch (_) { /* try next */ } }
      }
    }
  }
  throw new Error("未找到 playwright-core（npm i 或设置 PLAYWRIGHT_CORE_PATH）");
}

function findChromium() {
  if (process.env.CHROMIUM_EXE && fs.existsSync(process.env.CHROMIUM_EXE)) return process.env.CHROMIUM_EXE;
  const root = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
  if (fs.existsSync(root)) {
    const found = fs.readdirSync(root).filter((n) => /^chromium-\d+$/.test(n))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
      .map((n) => path.join(root, n, "chrome-win64", "chrome.exe"))
      .find((p) => fs.existsSync(p));
    if (found) return found;
  }
  throw new Error("未找到本机 Chromium；设置 CHROMIUM_EXE");
}

function parseArgs(argv) {
  const a = { keys: "", frames: "", out: path.join(__dirname, "review"), pairs: [5.0, 12.5, 17.5, 21.0, 22.6, 23.6, 29.7] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--keys") a.keys = path.resolve(argv[++i]);
    else if (argv[i] === "--frames") a.frames = path.resolve(argv[++i]);
    else if (argv[i] === "--out") a.out = path.resolve(argv[++i]);
    else if (argv[i] === "--pairs") a.pairs = argv[++i].split(",").map(Number);
  }
  return a;
}

const fileUrl = (p) => "file:///" + p.replace(/\\/g, "/");
const pngSize = (file) => { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

// 在 file:// 画布页上按 jobs 绘制并截图；jobs 的 src 为 file:// 绝对路径
async function compose(page, canvasPage, w, h, jobs, bg) {
  await page.goto(fileUrl(canvasPage), { waitUntil: "load" });
  await page.evaluate(async ({ w, h, jobs, bg }) => {
    const cv = document.getElementById("c");
    cv.width = w; cv.height = h;
    const cx = cv.getContext("2d");
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.fillStyle = bg;
    cx.fillRect(0, 0, w, h);
    for (const j of jobs) {
      const im = new Image();
      await new Promise((res, rej) => { im.onload = res; im.onerror = () => rej(new Error("load fail: " + j.src)); im.src = j.src; });
      cx.drawImage(im, j.x, j.y, j.w, j.h);
      if (j.border) { cx.strokeStyle = j.border; cx.strokeRect(j.x + 0.5, j.y + 0.5, j.w - 1, j.h - 1); }
      if (j.line) { cx.strokeStyle = j.line; cx.beginPath(); cx.moveTo(j.x + 0.5, j.y); cx.lineTo(j.x + 0.5, j.y + j.h); cx.stroke(); }
    }
  }, { w, h, jobs, bg });
  return page.locator("#c").screenshot();
}

(async () => {
  const a = parseArgs(process.argv.slice(2));
  const { chromium } = loadPlaywrightCore();
  const keyDir = path.join(a.out, "keyframes");
  fs.mkdirSync(keyDir, { recursive: true });
  const adjDir = path.join(a.out, "adjacent");
  fs.mkdirSync(adjDir, { recursive: true });

  const keys = fs.existsSync(a.keys) ? fs.readdirSync(a.keys).filter((f) => /^key-\d+\.png$/.test(f)).sort() : [];
  for (const f of keys) fs.copyFileSync(path.join(a.keys, f), path.join(keyDir, f));
  console.log(`keyframes copied: ${keys.length} -> ${keyDir}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promo-review-"));
  const canvasPage = path.join(tmp, "canvas.html");
  fs.writeFileSync(canvasPage, `<!DOCTYPE html><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}</style><canvas id="c" width="16" height="16"></canvas>`);

  const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });

    if (keys.length) {
      const step = keys.length >= 12 ? Math.ceil(keys.length / 12) : 1;
      const pick = keys.filter((_, i) => i % step === 0).slice(0, 12);
      const rows = Math.ceil(pick.length / COLS);
      const W = COLS * TILE_W + (COLS + 1) * PAD;
      const H = rows * TILE_H + (rows + 1) * PAD;
      const jobs = pick.map((f, i) => ({
        src: fileUrl(path.join(a.keys, f)),
        x: (i % COLS) * (TILE_W + PAD) + PAD,
        y: Math.floor(i / COLS) * (TILE_H + PAD) + PAD,
        w: TILE_W, h: TILE_H, border: "rgba(255,255,255,0.07)",
      }));
      await page.setViewportSize({ width: W, height: H });
      const buf = await compose(page, canvasPage, W, H, jobs, "#0b0d12");
      fs.writeFileSync(path.join(a.out, "contact-sheet.png"), buf);
      console.log(`contact-sheet.png -> ${pick.length} tiles, ${W}x${H}`);
    }

    if (!fs.existsSync(a.frames)) {
      console.log("frames dir 不存在，跳过相邻帧对：" + a.frames);
    } else {
      const avail = new Set(fs.readdirSync(a.frames).filter((f) => /^f\d{5}\.png$/.test(f)));
      for (const t of a.pairs) {
        const i = Math.round(t * FPS);
        const f1 = `f${String(i).padStart(5, "0")}.png`;
        const f2 = `f${String(i + 1).padStart(5, "0")}.png`;
        if (!avail.has(f1) || !avail.has(f2)) { console.log(`skip pair t=${t} (${f1}/${f2} 缺)`); continue; }
        const s1 = pngSize(path.join(a.frames, f1));
        const half = Math.round(s1.w / 2), hh = Math.round(s1.h / 2);
        const jobs = [
          { src: fileUrl(path.join(a.frames, f1)), x: 0, y: 0, w: half, h: hh },
          { src: fileUrl(path.join(a.frames, f2)), x: half, y: 0, w: half, h: hh, line: "rgba(255,255,255,0.22)" },
        ];
        await page.setViewportSize({ width: half * 2, height: hh });
        const buf = await compose(page, canvasPage, half * 2, hh, jobs, "#000");
        const dst = path.join(adjDir, `t${t.toFixed(2)}_${f1.replace(".png", "")}_${f2.replace(".png", "")}.png`);
        fs.writeFileSync(dst, buf);
        console.log(`adjacent pair -> ${path.basename(dst)}`);
      }
    }
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

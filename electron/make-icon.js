#!/usr/bin/env node
// 生成 electron/icon.png（1024×1024）——应用图标 rev9：
//   现代平面 + 白色底 + 毛玻璃质感 + 居中日历图标。
//
// 实现：内嵌 HTML/SVG 在 Chromium 中 headless 渲染后截图（透明外圈）。
//   - 毛玻璃：图块内多层模糊色斑（蓝/紫/白）之上覆盖 backdrop-filter 玻璃层，
//     叠加 feTurbulence 噪点、内高光与柔影；真实浏览器合成，无手写像素。
//   - 依赖：playwright-core（本机已装或 npx 缓存）+ 本机 Chromium（ms-playwright 缓存）。
//   - 无可见窗口：headless 合成，不弹任何窗口。
//
// 用法：
//   node make-icon.js                     # 写 electron/icon.png + 多尺寸预览 strip
//   node make-icon.js --out <file.png>    # 指定输出
//   node make-icon.js --no-preview        # 跳过预览图
//   node make-icon.js --preview-dir <dir> # 指定预览目录（默认 %TEMP%/opencode/pwtest/icon-rev9）
//
// 环境变量（可覆盖自动探测）：
//   PLAYWRIGHT_CORE_PATH  playwright-core 目录
//   CHROMIUM_EXE          Chromium/Chrome 可执行文件
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ---------------------------------------------------------------- 设计 tokens
const SIZE = 1024; // 画布
const TILE = 864; // 圆角方形底（四周各 80 透明安全边距）
const TILE_RADIUS = 216; // 25% 圆角（现代平面圆角方形）
const BLUE = "#2563eb"; // 主色（与应用主题一致）
const VIOLET = "#7c3aed"; // 点缀色
const BLUE_DEEP = "#1e40af"; // 阴影/描边用深蓝

// 噪点纹理（毛玻璃微粒感，data URI，低透明度叠加）
const NOISE_URI =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">` +
      `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>` +
      `<feColorMatrix type="saturate" values="0"/></filter>` +
      `<rect width="240" height="240" filter="url(#n)"/></svg>`,
  );

// ---------------------------------------------------------------- 画面（HTML）
function buildHtml() {
  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><style>
  :root {
    --tile: ${TILE}px; --radius: ${TILE_RADIUS}px; --blue: ${BLUE}; --violet: ${VIOLET}; --blue-deep: ${BLUE_DEEP};
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${SIZE}px; height: ${SIZE}px; background: transparent; overflow: hidden; }
  .canvas { position: relative; width: ${SIZE}px; height: ${SIZE}px; }

  /* 圆角方形毛玻璃底：溢出裁剪 + 外部柔影（透明外圈内不被裁切） */
  .tile {
    position: absolute; left: ${(SIZE - TILE) / 2}px; top: ${(SIZE - TILE) / 2}px;
    width: var(--tile); height: var(--tile); border-radius: var(--radius);
    overflow: hidden; isolation: isolate;
    box-shadow:
      0 22px 54px rgba(30, 64, 175, 0.20),
      0 6px 18px rgba(15, 23, 42, 0.10),
      0 2px 4px rgba(15, 23, 42, 0.06);
  }
  /* 玻璃之下的底色：近白冷调渐变 + 蓝/紫/白色斑（毛玻璃的光源色） */
  .tile-bg { position: absolute; inset: 0; background: linear-gradient(165deg, #ffffff 0%, #f4f8ff 55%, #e9f0fd 100%); }
  .blob { position: absolute; border-radius: 50%; }
  .blob-a { width: 600px; height: 600px; left: -170px; top: -190px;
            background: radial-gradient(circle, rgba(37, 99, 235, 0.62) 0%, rgba(37, 99, 235, 0) 68%); filter: blur(28px); }
  .blob-b { width: 660px; height: 660px; right: -180px; bottom: -210px;
            background: radial-gradient(circle, rgba(124, 58, 237, 0.52) 0%, rgba(124, 58, 237, 0) 68%); filter: blur(36px); }
  .blob-c { width: 560px; height: 560px; right: -80px; top: -110px;
            background: radial-gradient(circle, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0) 70%); filter: blur(18px); }
  /* 斜向高光带：毛玻璃的镜面反光 */
  .sheen { position: absolute; width: 1500px; height: 340px; left: -320px; top: 150px; transform: rotate(-24deg); filter: blur(30px);
           background: linear-gradient(90deg, rgba(255, 255, 255, 0) 12%, rgba(255, 255, 255, 0.5) 46%, rgba(255, 255, 255, 0) 72%); }
  /* 玻璃层：backdrop 模糊真实折射下层色斑 + 内高光/内柔影 + 白色描边 */
  .glass {
    position: absolute; inset: 0; border-radius: var(--radius);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.60) 0%, rgba(255, 255, 255, 0.38) 60%, rgba(255, 255, 255, 0.56) 100%);
    -webkit-backdrop-filter: blur(40px) saturate(170%);
    backdrop-filter: blur(40px) saturate(170%);
    box-shadow:
      inset 0 2px 12px rgba(255, 255, 255, 0.95),
      inset 0 -24px 48px rgba(37, 99, 235, 0.10),
      inset 0 0 0 1.5px rgba(255, 255, 255, 0.85);
  }
  .noise { position: absolute; inset: 0; background-image: url("${NOISE_URI}"); opacity: 0.06; mix-blend-mode: overlay; }

  /* 居中日历（平面图形；无文字） */
  .art { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
  .art svg { width: 660px; height: 660px; display: block; }
</style></head><body>
  <div class="canvas">
    <div class="tile">
      <div class="tile-bg"></div>
      <div class="blob blob-a"></div><div class="blob blob-b"></div><div class="blob blob-c"></div>
      <div class="sheen"></div>
      <div class="glass"></div>
      <div class="noise"></div>
      <div class="art">
        <svg viewBox="0 0 660 660" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="cardGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#ffffff" stop-opacity="0.97"/><stop offset="1" stop-color="#f6f9ff" stop-opacity="0.88"/>
            </linearGradient>
            <linearGradient id="headGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="${BLUE}"/>
            </linearGradient>
            <clipPath id="cardClip"><rect x="30" y="82" width="600" height="548" rx="68"/></clipPath>
            <filter id="cardShadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="22" stdDeviation="20" flood-color="${BLUE_DEEP}" flood-opacity="0.16"/>
            </filter>
          </defs>

          <!-- 装订环（藏于日历卡上缘之后，只露上段） -->
          <rect x="190" y="28" width="36" height="86" rx="18" fill="${BLUE}"/>
          <rect x="434" y="28" width="36" height="86" rx="18" fill="${BLUE}"/>

          <!-- 日历卡底（浅色玻璃感 + 柔影） -->
          <rect x="30" y="82" width="600" height="548" rx="68" fill="url(#cardGrad)"
                stroke="rgba(37, 99, 235, 0.16)" stroke-width="3" filter="url(#cardShadow)"/>

          <!-- 顶栏（主题蓝；圆角对上、直角对下） -->
          <g clip-path="url(#cardClip)">
            <rect x="30" y="82" width="600" height="150" fill="url(#headGrad)"/>
            <rect x="30" y="82" width="600" height="3" fill="rgba(255, 255, 255, 0.55)"/>
          </g>

          <!-- 日期格：第一行实心主色；第二行浅蓝 ×2 + 点缀紫 ×1 -->
          <g>
            <rect x="86"  y="284" width="136" height="116" rx="30" fill="${BLUE}"/>
            <rect x="262" y="284" width="136" height="116" rx="30" fill="${BLUE}"/>
            <rect x="438" y="284" width="136" height="116" rx="30" fill="${BLUE}"/>
            <rect x="86"  y="442" width="136" height="116" rx="30" fill="#bdd6fb"/>
            <rect x="262" y="442" width="136" height="116" rx="30" fill="#bdd6fb"/>
            <rect x="438" y="442" width="136" height="116" rx="30" fill="${VIOLET}"/>
          </g>
        </svg>
      </div>
    </div>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------- 依赖探测
function loadPlaywrightCore() {
  const errors = [];
  const tryRequire = (p) => {
    try { return require(p); } catch (e) { errors.push(`${p}: ${e.code || e.message}`); return null; }
  };
  let mod = tryRequire("playwright-core");
  if (mod) return mod;
  const candidates = [];
  if (process.env.PLAYWRIGHT_CORE_PATH) candidates.push(process.env.PLAYWRIGHT_CORE_PATH);
  const npxCache = path.join(process.env.LOCALAPPDATA || "", "npm-cache", "_npx");
  if (fs.existsSync(npxCache)) {
    for (const d of fs.readdirSync(npxCache)) candidates.push(path.join(npxCache, d, "node_modules", "playwright-core"));
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "package.json"))) {
      mod = tryRequire(c);
      if (mod) return mod;
    }
  }
  throw new Error(`未找到 playwright-core。npm i -D playwright-core 或设置 PLAYWRIGHT_CORE_PATH。\n${errors.join("\n")}`);
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
  throw new Error("未找到本机 Chromium；设置 CHROMIUM_EXE 或 npx playwright install chromium。");
}

// ---------------------------------------------------------------- 渲染
async function render() {
  const { chromium } = loadPlaywrightCore();
  const executablePath = findChromium();
  const browser = await chromium.launch({ headless: true, executablePath, args: ["--force-color-profile=srgb"] });
  try {
    const html = buildHtml();
    const shot = async (page) => {
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(250);
    };
    return { browser, shot };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

// ---------------------------------------------------------------- 预览
function stripHtml(dataUri) {
  const sizes = [1024, 256, 64, 32, 16];
  const cells = sizes.map((s) =>
    `<figure><img src="${dataUri}" width="${s}" height="${s}" data-size="${s}" alt="${s}px"><figcaption>${s}px</figcaption></figure>`
  ).join("");
  const width = sizes.reduce((a, b) => a + b, 0) + 32 * (sizes.length - 1) + 80;
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { width: ${width}px; padding: 40px; display: flex; align-items: flex-end; gap: 32px;
      background-color: #eef2f7;
      background-image: conic-gradient(#ffffff 0 25%, #d8dee9 0 50%, #ffffff 0 75%, #d8dee9 0);
      background-size: 24px 24px;
      font: 500 16px/1.4 "Segoe UI", system-ui, sans-serif; color: #1e293b; }
    figure { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
    img { display: block; }
    figcaption { text-align: right; }
  </style></head><body>${cells}</body></html>`;
}

async function renderPreview(browser, iconPath, previewDir) {
  fs.mkdirSync(previewDir, { recursive: true });
  const dataUri = "data:image/png;base64," + fs.readFileSync(iconPath).toString("base64");
  const page = await browser.newPage({ viewport: { width: 1700, height: 1220 }, deviceScaleFactor: 1 });
  await page.setContent(stripHtml(dataUri), { waitUntil: "load" });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(200);
  const written = [];
  for (const s of [1024, 256, 64, 32, 16]) {
    const file = path.join(previewDir, `icon-${s}.png`);
    await page.locator(`img[data-size="${s}"]`).screenshot({ path: file });
    written.push(file);
  }
  const stripFile = path.join(previewDir, "icon-strip.png");
  await page.screenshot({ path: stripFile, fullPage: true });
  written.push(stripFile);
  await page.close();
  return written;
}

// ---------------------------------------------------------------- 入口
function parseArgs(argv) {
  const args = { out: path.join(__dirname, "icon.png"), previewDir: path.join(os.tmpdir(), "opencode", "pwtest", "icon-rev9"), preview: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else if (argv[i] === "--preview-dir") args.previewDir = path.resolve(argv[++i]);
    else if (argv[i] === "--no-preview") args.preview = false;
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const { browser, shot } = await render();
  try {
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
    await shot(page);
    await page.screenshot({ path: args.out, omitBackground: true });
    await page.close();
    console.log(`written ${args.out} (${fs.statSync(args.out).size} bytes, ${SIZE}×${SIZE})`);
    if (args.preview) {
      for (const f of await renderPreview(browser, args.out, args.previewDir)) {
        console.log(`written ${f} (${fs.statSync(f).size} bytes)`);
      }
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

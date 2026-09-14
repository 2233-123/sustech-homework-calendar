#!/usr/bin/env node
// 生成 electron/tray.png（32×32 RGBA）——托盘图标 rev9 重制：
//   与应用图标（icon.png：白底圆角 + 蓝色日历 + 紫色点缀）同一设计语言；
//   去掉玻璃噪点/细碎元素，16–32px 托盘尺寸下清晰可辨。
//
// 抗锯齿：4× 超采样（先画 128×128，再盒式降采样到 32）；纯 Node 内置模块，无第三方依赖。
//
// 候选（--candidate，默认 CHOSEN=a）：
//   a = 白色圆角底板 + 蓝色日历（缩微 icon.png，元素粗化）← 定稿
//   b = 透明底 + 蓝色日历（无底板，托盘更轻；次选）
//   c = 蓝色圆角底板 + 白色日历（反色，16px 最清楚但与旧图同为蓝方块剪影，未选）
//
// 用法：
//   node make-tray-icon.js                             # 写 electron/tray.png + 预览条
//   node make-tray-icon.js --candidate a               # 指定候选写 tray.png
//   node make-tray-icon.js --preview-dir <dir>         # 预览目录（默认 %TEMP%/opencode/pwtest/tray-rev9）
//   node make-tray-icon.js --old <png>                 # 预览里旧图对比来源（默认预览目录/tray-old.png，缺失则跳过）
//   node make-tray-icon.js --sheet-out <png>           # 额外把候选对比条写到指定路径（入库留档用）
//   node make-tray-icon.js --no-preview                # 只写 tray.png
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 32; // 交付尺寸（设计坐标空间 = 32 单位）
const SS = 4; // 超采样倍率
const CHOSEN = "a"; // 定稿候选：A 白底圆角 + 蓝色日历（16/24/32 浅深底实测见 specs 文档）

// 设计 tokens（与应用图标同一套）
const BLUE = [37, 99, 235, 255]; // #2563eb 主色
const BLUE_CARD = [47, 111, 240, 255]; // 反色候选的卡身（比底板略亮）
const VIOLET = [124, 58, 237, 255]; // #7c3aed 点缀
const TINT = [166, 201, 250, 255]; // #a6c9fa 浅蓝日期格（16px 下比 #bdd6fb 更有存在感）
const WHITE = [255, 255, 255, 255];
const EDGE_BLUE = [134, 180, 247, 255]; // #86b4f7 卡边（浅底上界定白色卡身）
const EDGE_SLATE = [185, 197, 214, 255]; // #b9c5d6 白底板描边（浅色任务栏上界定白底）
const PALE_BLUE = [191, 219, 254, 255]; // #bfdbfe 反色候选第二行
const PALE_VIOLET = [196, 181, 253, 255]; // #c4b5fd 反色候选点缀格

// ============================================================ PNG 编解码（8bit RGBA）
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(img) {
  const { w, h, data } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0; // filter: none
    for (let i = 0; i < w * 4; i++) raw[row + 1 + i] = data[y * w * 4 + i];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function decodePng(buf) {
  let off = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error("仅支持 8bit RGBA PNG");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const out = new Uint8ClampedArray(w * h * 4);
  let prev = new Uint8Array(stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) v += paeth(a, b, c); else if (ft !== 0) throw new Error(`未知 PNG filter: ${ft}`);
      cur[x] = v & 0xff;
    }
    out.set(cur, y * stride);
    prev = cur;
  }
  return { w, h, data: out };
}

// ============================================================ 画布与图形（硬覆盖填充，AA 来自超采样）
function img(w, h) { return { w, h, data: new Uint8ClampedArray(w * h * 4) }; }

function setPx(im, x, y, c) {
  const i = (y * im.w + x) * 4;
  im.data[i] = c[0]; im.data[i + 1] = c[1]; im.data[i + 2] = c[2]; im.data[i + 3] = c[3];
}

function blendPx(im, x, y, c) {
  if (c[3] === 255) return setPx(im, x, y, c);
  if (c[3] === 0) return;
  const i = (y * im.w + x) * 4;
  const a = c[3] / 255, ia = 1 - a;
  im.data[i] = c[0] * a + im.data[i] * ia;
  im.data[i + 1] = c[1] * a + im.data[i + 1] * ia;
  im.data[i + 2] = c[2] * a + im.data[i + 2] * ia;
  im.data[i + 3] = Math.min(255, c[3] + im.data[i + 3] * ia);
}

// 设计坐标（32 单位） → 像素：k = im.w / 32
function fillRoundRect(im, k, x, y, w, h, r, color) {
  r = Math.min(r, w / 2, h / 2);
  const x1 = Math.floor(x * k), x2 = Math.ceil((x + w) * k);
  const y1 = Math.floor(y * k), y2 = Math.ceil((y + h) * k);
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2 - r, ry = h / 2 - r;
  for (let py = Math.max(0, y1); py < Math.min(im.h, y2); py++) {
    const sy = (py + 0.5) / k;
    if (sy < y || sy > y + h) continue;
    const qy = Math.max(Math.abs(sy - cy) - ry, 0);
    for (let px = Math.max(0, x1); px < Math.min(im.w, x2); px++) {
      const sx = (px + 0.5) / k;
      if (sx < x || sx > x + w) continue;
      const qx = Math.max(Math.abs(sx - cx) - rx, 0);
      if (qx * qx + qy * qy <= r * r) setPx(im, px, py, color);
    }
  }
}

function fillRect(im, k, x, y, w, h, color) {
  const x1 = Math.max(0, Math.floor(x * k)), x2 = Math.min(im.w, Math.ceil((x + w) * k));
  const y1 = Math.max(0, Math.floor(y * k)), y2 = Math.min(im.h, Math.ceil((y + h) * k));
  for (let py = y1; py < y2; py++) for (let px = x1; px < x2; px++) setPx(im, px, py, color);
}

// 4×4 盒式降采样（预乘 alpha 平均，避免透明边发黑）
function boxDownscale4(im) {
  const n = im.w / SS, out = img(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * im.w + (x * SS + dx)) * 4;
          const a = im.data[i + 3];
          ar += im.data[i] * a; ag += im.data[i + 1] * a; ab += im.data[i + 2] * a; aa += a;
        }
      }
      const a = aa / (SS * SS);
      const i = (y * n + x) * 4;
      out.data[i] = aa > 0 ? ar / aa : 0;
      out.data[i + 1] = aa > 0 ? ag / aa : 0;
      out.data[i + 2] = aa > 0 ? ab / aa : 0;
      out.data[i + 3] = a;
    }
  }
  return out;
}

function downscaleHalf(im) {
  const n = im.w / 2, out = img(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((y * 2 + dy) * im.w + (x * 2 + dx)) * 4;
          const a = im.data[i + 3];
          ar += im.data[i] * a; ag += im.data[i + 1] * a; ab += im.data[i + 2] * a; aa += a;
        }
      }
      const i = (y * n + x) * 4;
      out.data[i] = aa > 0 ? ar / aa : 0;
      out.data[i + 1] = aa > 0 ? ag / aa : 0;
      out.data[i + 2] = aa > 0 ? ab / aa : 0;
      out.data[i + 3] = aa / 4;
    }
  }
  return out;
}

function upscaleNearest(im, f) {
  const out = img(im.w * f, im.h * f);
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      const i = ((Math.floor(y / f)) * im.w + Math.floor(x / f)) * 4;
      const j = (y * out.w + x) * 4;
      out.data[j] = im.data[i]; out.data[j + 1] = im.data[i + 1];
      out.data[j + 2] = im.data[i + 2]; out.data[j + 3] = im.data[i + 3];
    }
  }
  return out;
}

function resizeNearest(im, n) {
  const out = img(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const sx = Math.min(im.w - 1, Math.floor((x + 0.5) * im.w / n));
      const sy = Math.min(im.h - 1, Math.floor((y + 0.5) * im.h / n));
      const i = (sy * im.w + sx) * 4, j = (y * n + x) * 4;
      out.data[j] = im.data[i]; out.data[j + 1] = im.data[i + 1];
      out.data[j + 2] = im.data[i + 2]; out.data[j + 3] = im.data[i + 3];
    }
  }
  return out;
}

function blit(dst, sprite, dx, dy) {
  for (let y = 0; y < sprite.h; y++) {
    for (let x = 0; x < sprite.w; x++) {
      const i = (y * sprite.w + x) * 4;
      const px = dx + x, py = dy + y;
      if (px < 0 || py < 0 || px >= dst.w || py >= dst.h) continue;
      blendPx(dst, px, py, [sprite.data[i], sprite.data[i + 1], sprite.data[i + 2], sprite.data[i + 3]]);
    }
  }
}

// ============================================================ 日历图形（32 空间，参数化）
// box: 卡面 {x,y,w,h,r}；style: 配色与粗化后的格距
function drawCalendar(im, k, box, s) {
  const ringW = s.ringW, ringOut = s.ringOut;
  const ringTop = box.y - ringOut;
  for (const fx of [0.28, 0.72]) {
    const cx = box.x + box.w * fx;
    fillRoundRect(im, k, cx - ringW / 2, ringTop, ringW, ringOut + box.r * 0.45, ringW / 2, s.ring);
  }
  if (s.border) {
    const bw = s.borderW;
    fillRoundRect(im, k, box.x - bw, box.y - bw, box.w + 2 * bw, box.h + 2 * bw, box.r + bw, s.border);
  }
  fillRoundRect(im, k, box.x, box.y, box.w, box.h, box.r, s.body);
  // 顶栏：上圆角随卡、下直角
  fillRoundRect(im, k, box.x, box.y, box.w, s.headH, box.r, s.header);
  fillRect(im, k, box.x, box.y + s.headH - box.r, box.w, box.r, s.header);
  // 日期格 2×3：第一行主色、第二行浅蓝×2 + 点缀
  const cw = s.cellW, ch = s.cellH, gx = s.gapX, gy = s.gapY;
  const padX = (box.w - (3 * cw + 2 * gx)) / 2;
  const row1 = box.y + s.headH + s.padTop;
  const row2 = row1 + ch + gy;
  for (let col = 0; col < 3; col++) {
    const x = box.x + padX + col * (cw + gx);
    fillRoundRect(im, k, x, row1, cw, ch, s.cellR, s.row1);
    fillRoundRect(im, k, x, row2, cw, ch, s.cellR, col < 2 ? s.row2 : s.accent);
  }
}

// 候选 A：白色圆角底板 + 蓝色日历（缩微 icon.png，元素粗化）
function drawCandidateA(im, k) {
  fillRoundRect(im, k, 1.4, 1.4, 29.2, 29.2, 7.7, EDGE_SLATE);
  fillRoundRect(im, k, 2.5, 2.5, 27.0, 27.0, 6.6, WHITE);
  drawCalendar(im, k, { x: 5.0, y: 7.2, w: 22.0, h: 20.0, r: 3.2 }, {
    ringW: 1.5, ringOut: 2.0, ring: BLUE, border: EDGE_BLUE, borderW: 1.0,
    body: WHITE, header: BLUE, headH: 6.4,
    cellW: 5.6, cellH: 4.4, gapX: 1.3, gapY: 1.4, cellR: 1.0, padTop: 1.6,
    row1: BLUE, row2: TINT, accent: VIOLET,
  });
}

// 候选 B：透明底 + 蓝色日历（无底板）
function drawCandidateB(im, k) {
  drawCalendar(im, k, { x: 3.6, y: 6.0, w: 24.8, h: 22.2, r: 3.8 }, {
    ringW: 1.5, ringOut: 2.0, ring: BLUE, border: EDGE_BLUE, borderW: 1.1,
    body: WHITE, header: BLUE, headH: 6.8,
    cellW: 6.4, cellH: 5.0, gapX: 1.5, gapY: 1.6, cellR: 1.2, padTop: 2.2,
    row1: BLUE, row2: TINT, accent: VIOLET,
  });
}

// 候选 C：蓝色圆角底板 + 白色日历（反色）
function drawCandidateC(im, k) {
  fillRoundRect(im, k, 1.4, 1.4, 29.2, 29.2, 7.7, BLUE);
  drawCalendar(im, k, { x: 5.0, y: 7.2, w: 22.0, h: 20.0, r: 3.2 }, {
    ringW: 1.5, ringOut: 2.0, ring: WHITE, border: null,
    body: BLUE_CARD, header: WHITE, headH: 6.4,
    cellW: 5.6, cellH: 4.4, gapX: 1.3, gapY: 1.4, cellR: 1.0, padTop: 1.6,
    row1: WHITE, row2: PALE_BLUE, accent: PALE_VIOLET,
  });
}

const CANDIDATES = { a: drawCandidateA, b: drawCandidateB, c: drawCandidateC };

function renderCandidate(letter, size) {
  const im = img(size * SS, size * SS);
  CANDIDATES[letter](im, (size * SS) / SIZE);
  return boxDownscale4(im);
}

// ============================================================ 预览对照条（3×5 位图字体，无外部依赖）
const FONT = {
  "0": "111/101/101/101/111", "1": "010/110/010/010/111", "2": "111/001/111/100/111",
  "3": "111/001/011/001/111", "4": "101/101/111/001/001", "5": "111/100/111/001/111",
  "6": "111/100/111/101/111", "7": "111/001/001/010/010", "8": "111/101/111/101/111",
  "9": "111/101/111/001/111", "A": "111/101/111/101/101", "B": "110/101/110/101/110",
  "C": "111/100/100/100/111", "D": "110/101/101/101/110", "L": "100/100/100/100/111",
  "O": "111/101/101/101/111", "P": "111/101/111/100/100", "X": "101/101/010/101/101",
};

function textWidth(str, s) { return str.length * (4 * s) - s; }

function drawText(im, str, x, y, s, color) {
  let cx = x;
  for (const ch of str) {
    const glyph = FONT[ch];
    if (glyph) {
      const rows = glyph.split("/");
      for (let ry = 0; ry < 5; ry++) {
        for (let rx = 0; rx < 3; rx++) {
          if (rows[ry][rx] === "1") fillRect(im, 1, cx + rx * s, y + ry * s, s, s, color);
        }
      }
    }
    cx += 4 * s;
  }
}

function composeSheet(entries, opts = {}) {
  const groups = opts.groups || [
    { tag: "16", pick: (e) => e.i16 },
    { tag: "24", pick: (e) => e.i24 },
    { tag: "32", pick: (e) => e.i32 },
    { tag: "16D", pick: (e) => e.i16d }, // 交付 32px 盒式降到 16px（模拟系统缩放）
  ];
  const SLOT = opts.slot || 96, SLOT_GAP = 10, GROUP_GAP = opts.groupGap || 56, MARGIN = 28;
  const TAG_S = Math.max(3, Math.round(SLOT / 32)), LABEL_S = Math.max(2, Math.round(SLOT / 48));
  const groupW = entries.length * SLOT + (entries.length - 1) * SLOT_GAP;
  const bandH = 16 + 5 * TAG_S + 8 + SLOT + 6 + 5 * LABEL_S + 16;
  const W = MARGIN * 2 + groups.length * groupW + (groups.length - 1) * GROUP_GAP;
  const H = MARGIN * 2 + bandH * 2 + 20;
  const sheet = img(W, H);
  const bands = [
    { y: MARGIN, bg: [241, 245, 249, 255], fg: [51, 65, 85, 255] }, // 浅色任务栏 #f1f5f9
    { y: MARGIN + bandH + 20, bg: [15, 23, 42, 255], fg: [226, 232, 240, 255] }, // 深色任务栏 #0f172a
  ];
  for (const band of bands) {
    fillRect(sheet, 1, MARGIN, band.y, W - MARGIN * 2, bandH, band.bg);
    groups.forEach((g, gi) => {
      const gx = MARGIN + gi * (groupW + GROUP_GAP);
      const tw = textWidth(g.tag, TAG_S);
      drawText(sheet, g.tag, gx + (groupW - tw) / 2, band.y + 16, TAG_S, band.fg);
      entries.forEach((e, ei) => {
        const src = g.pick(e);
        const sprite = src.w === SLOT ? src : upscaleNearest(src, SLOT / src.w);
        const sx = gx + ei * (SLOT + SLOT_GAP);
        const sy = band.y + 16 + 5 * TAG_S + 8;
        blit(sheet, sprite, sx, sy);
        const lw = textWidth(e.label, LABEL_S);
        drawText(sheet, e.label, sx + (SLOT - lw) / 2, sy + SLOT + 6, LABEL_S, band.fg);
      });
    });
  }
  return sheet;
}

// ============================================================ 入口
function parseArgs(argv) {
  const args = {
    candidate: CHOSEN,
    preview: true,
    previewDir: path.join(os.tmpdir(), "opencode", "pwtest", "tray-rev9"),
    old: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--candidate") args.candidate = argv[++i];
    else if (argv[i] === "--preview-dir") args.previewDir = path.resolve(argv[++i]);
    else if (argv[i] === "--old") args.old = path.resolve(argv[++i]);
    else if (argv[i] === "--sheet-out") args.sheetOut = path.resolve(argv[++i]);
    else if (argv[i] === "--no-preview") args.preview = false;
  }
  if (!CANDIDATES[args.candidate]) throw new Error(`未知候选：${args.candidate}（可选 a/b/c）`);
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const trayPath = path.join(__dirname, "tray.png");
  fs.writeFileSync(trayPath, encodePng(renderCandidate(args.candidate, SIZE)));
  console.log(`written ${trayPath} (${fs.statSync(trayPath).size} bytes, ${SIZE}×${SIZE}, 候选 ${args.candidate})`);
  if (!args.preview) return;

  const dir = args.previewDir;
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, im) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, encodePng(im));
    console.log(`written ${p} (${fs.statSync(p).size} bytes)`);
  };
  const native = {};
  for (const letter of ["a", "b", "c"]) {
    const imgs = { i16: renderCandidate(letter, 16), i24: renderCandidate(letter, 24), i32: renderCandidate(letter, 32) };
    imgs.i16d = downscaleHalf(imgs.i32);
    native[letter] = imgs;
    write(`cand-${letter}-16.png`, imgs.i16);
    write(`cand-${letter}-24.png`, imgs.i24);
    write(`cand-${letter}-32.png`, imgs.i32);
  }
  const entries = [];
  const oldPath = args.old || path.join(dir, "tray-old.png");
  if (fs.existsSync(oldPath)) {
    const old32 = decodePng(fs.readFileSync(oldPath));
    entries.push({ label: "OLD", i32: old32, i24: resizeNearest(old32, 24), i16: downscaleHalf(old32), i16d: downscaleHalf(old32) });
  } else {
    console.log(`（无旧图对比：${oldPath} 不存在，可用 --old 指定）`);
  }
  for (const letter of ["a", "b", "c"]) entries.push({ label: letter.toUpperCase(), ...native[letter] });
  const sheet = composeSheet(entries);
  write("tray-rev9-sheet.png", sheet);
  const zoom16 = composeSheet(entries, { groups: [{ tag: "16", pick: (e) => e.i16 }], slot: 384 });
  write("tray-rev9-16zoom.png", zoom16);
  if (args.sheetOut) {
    fs.mkdirSync(path.dirname(args.sheetOut), { recursive: true });
    fs.writeFileSync(args.sheetOut, encodePng(sheet));
    console.log(`written ${args.sheetOut} (${fs.statSync(args.sheetOut).size} bytes)`);
  }
  const chosen = native[args.candidate];
  write(`tray-final-16.png`, chosen.i16);
  write(`tray-final-24.png`, chosen.i24);
  write(`tray-final-32.png`, chosen.i32);
}

main();

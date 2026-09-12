// 生成 electron/tray.png (32×32) 与 electron/icon.png (256×256)
// 纯 Node 内置模块手写 PNG（无第三方依赖）。
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
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

function makePng(size) {
  const bg = [37, 99, 235];
  const fg = [255, 255, 255];
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size / 4;
  const cx = size / 2;
  const cy = size / 2;
  const dotR = size / 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const off = y * (size * 4 + 1) + 1 + x * 4;
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      let alpha = 255;
      if (dx < radius && dy < radius) {
        const d = Math.hypot(radius - dx, radius - dy);
        if (d > radius) alpha = 0;
      }
      const inDot = Math.hypot(x - cx, y - cy) <= dotR;
      const [r, g, b] = inDot ? fg : bg;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.writeFileSync(path.join(__dirname, "tray.png"), makePng(32));
fs.writeFileSync(path.join(__dirname, "icon.png"), makePng(256));
console.log("written tray.png (32) and icon.png (256)");

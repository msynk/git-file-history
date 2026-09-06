/**
 * Generates images/icon.png, the Marketplace icon.
 *
 * Drawn procedurally with zlib from Node's standard library so the repository
 * carries no binary asset that cannot be regenerated or reviewed.
 *
 * Usage: node scripts/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const BACKGROUND = [24, 26, 33];
const ACCENT = [88, 166, 255];
const RAIL = [110, 118, 132];

/** Signed distance from a point to a circle outline. */
function ringAlpha(x, y, cx, cy, radius, thickness) {
  const distance = Math.hypot(x - cx, y - cy);
  return coverage(Math.abs(distance - radius) - thickness / 2);
}

function diskAlpha(x, y, cx, cy, radius) {
  return coverage(Math.hypot(x - cx, y - cy) - radius);
}

/** Antialiases an edge over one pixel. */
function coverage(signedDistance) {
  return Math.max(0, Math.min(1, 0.5 - signedDistance));
}

function roundedSquareAlpha(x, y, size, radius) {
  const dx = Math.max(radius - x, x - (size - radius), 0);
  const dy = Math.max(radius - y, y - (size - radius), 0);
  return coverage(Math.hypot(dx, dy) - radius);
}

function blend(target, offset, color, alpha) {
  for (let channel = 0; channel < 3; channel++) {
    target[offset + channel] = Math.round(target[offset + channel] * (1 - alpha) + color[channel] * alpha);
  }
  target[offset + 3] = Math.max(target[offset + 3], Math.round(alpha * 255));
}

function render() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);
  const dots = [
    { cy: 34, r: 9 },
    { cy: 64, r: 9 },
    { cy: 94, r: 9 }
  ];

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const offset = (y * SIZE + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      blend(pixels, offset, BACKGROUND, roundedSquareAlpha(px, py, SIZE, 26));

      // The rail behind the timeline dots.
      const railAlpha = coverage(Math.abs(px - 44) - 1.5) * coverage(Math.abs(py - 64) - 34);
      blend(pixels, offset, RAIL, railAlpha * 0.9);

      dots.forEach((dot, index) => {
        const colour = index === 1 ? ACCENT : RAIL;
        const outline = ringAlpha(px, py, 44, dot.cy, dot.r, 4.5);
        blend(pixels, offset, colour, outline);
        if (index === 1) {
          blend(pixels, offset, ACCENT, diskAlpha(px, py, 44, dot.cy, dot.r - 4));
        }
      });

      // Message bars to the right of each dot.
      dots.forEach((dot, index) => {
        const width = [50, 40, 30][index];
        const bar =
          coverage(Math.abs(px - (62 + width / 2)) - width / 2) * coverage(Math.abs(py - dot.cy) - 4.5);
        blend(pixels, offset, index === 1 ? ACCENT : RAIL, bar * (index === 1 ? 0.95 : 0.6));
      });
    }
  }
  return pixels;
}

function toPng(pixels) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter type: none
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr()),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ];
  return Buffer.concat(chunks);
}

function ihdr() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return header;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

const output = path.join(__dirname, '..', 'images', 'icon.png');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, toPng(render()));
console.log(`Wrote ${output}`);

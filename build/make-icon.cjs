// Renders build/icon.png (1024px, transparent corners) from the same geometry as build/icon.svg: node build/make-icon.cjs build/icon.png
const fs = require('fs'), zlib = require('zlib');
const N = 1024, S = 25.75, O = 100;
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const rrect = (x, y, cx, cy, hw, hh, r) => { const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
const bez = (p0, p1, p2, p3, n = 96) => { const pts = []; for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; pts.push([u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0], u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]]); } return pts.map(([a, b]) => [O + a * S, O + b * S]); };
const curves = [bez([11.4, 11], [16.2, 11], [15.6, 16], [20.4, 16]), bez([11.4, 21], [16.2, 21], [15.6, 16], [20.4, 16])];
const segDist = (x, y, pts) => { let m = 1e9; for (let i = 0; i < pts.length - 1; i++) { const [ax, ay] = pts[i], [bx, by] = pts[i + 1]; const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))); const d = Math.hypot(x - ax - t * dx, y - ay - t * dy); if (d < m) m = d; } return m; };
const SW = 1.6 * S / 2;
const motif = (x, y) => {
  let d = 1e9;
  for (const [cx, cy] of [[9, 11], [9, 21]]) d = Math.min(d, Math.abs(Math.hypot(x - (O + cx * S), y - (O + cy * S)) - 2.3 * S) - SW);
  for (const c of curves) d = Math.min(d, segDist(x, y, c) - SW);
  d = Math.min(d, Math.hypot(x - (O + 23 * S), y - (O + 16 * S)) - 2.9 * S);
  return d;
};
const over = (dst, r, g, b, a) => { const na = a + dst[3] * (1 - a); if (na <= 0) return; for (const [i, c] of [[0, r], [1, g], [2, b]]) dst[i] = (c * a + dst[i] * dst[3] * (1 - a)) / na; dst[3] = na; };
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const px = [0, 0, 0, 0], X = x + 0.5, Y = y + 0.5;
    const ds = rrect(X, Y - 14, 512, 512, 412, 412, 186);
    over(px, 0, 0, 0, 0.28 * 0.5 * (1 - erf(ds / (18 * Math.SQRT2))));
    const dt = rrect(X, Y, 512, 512, 412, 412, 186);
    const cov = Math.max(0, Math.min(1, 0.5 - dt));
    if (cov > 0) {
      const t = Math.max(0, Math.min(1, (Y - 100) / 824));
      over(px, 0x2E + (0x14 - 0x2E) * t, 0x2E + (0x14 - 0x2E) * t, 0x33 + (0x17 - 0x33) * t, cov);
      over(px, 255, 255, 255, 0.08 * Math.max(0, Math.min(1, 0.5 - (Math.abs(dt + 1.5) - 1.5))) * cov);
      if (X > 250 && X < 800 && Y > 250 && Y < 780) over(px, 255, 255, 255, Math.max(0, Math.min(1, 0.5 - motif(X, Y))) * cov);
    }
    const o = y * (N * 4 + 1) + 1 + x * 4;
    raw[o] = Math.round(px[0]); raw[o + 1] = Math.round(px[1]); raw[o + 2] = Math.round(px[2]); raw[o + 3] = Math.round(px[3] * 255);
  }
}
const crc = (buf) => { let c, crcTable = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } let r = 0xFFFFFFFF; for (const b of buf) r = crcTable[(r ^ b) & 255] ^ (r >>> 8); return (r ^ 0xFFFFFFFF) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(process.argv[2], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));

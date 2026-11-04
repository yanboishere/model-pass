// Renders the app icons as PNGs with no dependencies (signed-distance shapes + zlib).
//   node scripts/gen-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5)
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
const clamp = (v) => Math.max(0, Math.min(1, v))
const over = (dst, src, alpha) => dst.map((v, i) => v + (src[i] - v) * alpha)

// signed distances (in icon units)
const segDist = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay
  const t = clamp(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy))
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t))
}
const roundRect = (px, py, x0, y0, x1, y1, r) => {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  const qx = Math.abs(px - cx) - ((x1 - x0) / 2 - r)
  const qy = Math.abs(py - cy) - ((y1 - y0) / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const triangle = (px, py, [a, b, c]) => {
  const edge = (p, q) => (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0])
  const s = Math.sign(edge(a, b, c))
  const inside = edge(a, b) * s >= 0 && edge(b, c) * s >= 0 && edge(c, a) * s >= 0
  const d = Math.min(segDist(px, py, ...a, ...b), segDist(px, py, ...b, ...c), segDist(px, py, ...c, ...a))
  return inside ? -d : d
}

/** Draws on a 24×24 unit grid (like the SVG logo). `fg` returns the glyph's signed distance. */
function icon({ size, from, to, bg = true, scale = 1, glyph }) {
  const unit = (size / 24) * scale
  const offset = (size - 24 * unit) / 2
  const c0 = hex(from), c1 = hex(to)
  return png(size, (x, y) => {
    const t = (x + y) / (2 * size)
    let rgb = mix(c0, c1, t)
    let alpha = bg ? 1 : 0
    // soft highlight
    if (bg) {
      const hl = clamp(1 - Math.hypot(x - size * 0.25, y - size * 0.15) / (size * 0.9))
      rgb = over(rgb, [255, 255, 255], hl * 0.18)
    }
    const ux = (x - offset) / unit, uy = (y - offset) / unit
    const aa = 1 / unit
    for (const layer of glyph(ux, uy)) {
      const cov = clamp(0.5 - layer.d / aa)
      if (cov <= 0) continue
      const col = layer.color === 'bg' ? mix(c0, c1, t) : hex(layer.color)
      const a = cov * (layer.alpha ?? 1)
      if (!bg && alpha < 1) {
        const outA = a + alpha * (1 - a)
        rgb = outA > 0 ? rgb.map((v, i) => (col[i] * a + v * alpha * (1 - a)) / outA) : rgb
        alpha = outA
      } else {
        rgb = over(rgb, col, a)
      }
    }
    return [...rgb.map((v) => Math.round(v)), Math.round(alpha * 255)]
  })
}

const walletGlyph = (x, y) => {
  const w = 1.25
  const m = Math.min(
    segDist(x, y, 7, 16, 7, 8),
    segDist(x, y, 7, 8, 12, 12),
    segDist(x, y, 12, 12, 17, 8),
    segDist(x, y, 17, 8, 17, 16),
  )
  return [
    { d: roundRect(x, y, 3, 3, 21, 21, 5.5), color: '#FFFFFF', alpha: 0.2 },
    { d: m - w, color: '#FFFFFF' },
  ]
}

const chatGlyph = (x, y) => [
  { d: Math.min(roundRect(x, y, 4.5, 5.5, 19.5, 16.5, 3.6), triangle(x, y, [[7.2, 15.5], [6.6, 20], [11.5, 15.5]])), color: '#FFFFFF' },
  { d: Math.hypot(x - 8.6, y - 11) - 1.15, color: 'bg' },
  { d: Math.hypot(x - 12, y - 11) - 1.15, color: 'bg' },
  { d: Math.hypot(x - 15.4, y - 11) - 1.15, color: 'bg' },
]

const apps = [
  { dir: 'apps/wallet/assets', from: '#5B5BF7', to: '#8B5CF6', glyph: walletGlyph },
  { dir: 'apps/demo-chat/assets', from: '#10B981', to: '#0EA5E9', glyph: chatGlyph },
]
for (const a of apps) {
  const dir = join(ROOT, a.dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'icon.png'), icon({ size: 1024, from: a.from, to: a.to, glyph: a.glyph }))
  writeFileSync(join(dir, 'adaptive-icon.png'), icon({ size: 1024, from: a.from, to: a.to, bg: false, scale: 0.62, glyph: a.glyph }))
  writeFileSync(join(dir, 'splash-icon.png'), icon({ size: 512, from: a.from, to: a.to, glyph: a.glyph }))
  writeFileSync(join(dir, 'favicon.png'), icon({ size: 64, from: a.from, to: a.to, glyph: a.glyph }))
  console.log('icons →', a.dir)
}

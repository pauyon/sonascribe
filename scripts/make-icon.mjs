/**
 * Generates build/icon.png, the source electron-builder converts into .ico and
 * .icns at package time.
 *
 * Written as a tiny PNG encoder rather than pulling in an image library: the
 * mark is a few filled shapes, and a build-time-only dependency that ships
 * nothing is still a dependency to audit and update.
 *
 *   node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIZE = 1024

/* ---------------------------------------------------------------- drawing --- */

const pixels = Buffer.alloc(SIZE * SIZE * 4)

function setPixel(x, y, [r, g, b], alpha = 1) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || alpha <= 0) return
  const at = (y * SIZE + x) * 4

  // Source-over compositing, so anti-aliased edges blend with what is beneath.
  const existing = pixels[at + 3] / 255
  const out = alpha + existing * (1 - alpha)
  if (out === 0) return

  pixels[at] = Math.round((r * alpha + pixels[at] * existing * (1 - alpha)) / out)
  pixels[at + 1] = Math.round((g * alpha + pixels[at + 1] * existing * (1 - alpha)) / out)
  pixels[at + 2] = Math.round((b * alpha + pixels[at + 2] * existing * (1 - alpha)) / out)
  pixels[at + 3] = Math.round(out * 255)
}

/** Signed distance to a rounded rectangle; negative inside. */
function roundedRectDistance(x, y, left, top, right, bottom, radius) {
  const dx = Math.max(left + radius - x, 0, x - (right - radius))
  const dy = Math.max(top + radius - y, 0, y - (bottom - radius))
  return Math.hypot(dx, dy) - radius
}

/**
 * Fills a rounded rectangle with a 1px anti-aliased edge.
 * `colorAt` receives the row so the background can carry a gradient.
 */
function fillRoundedRect(left, top, right, bottom, radius, colorAt) {
  for (let y = Math.floor(top); y < Math.ceil(bottom); y++) {
    for (let x = Math.floor(left); x < Math.ceil(right); x++) {
      const distance = roundedRectDistance(x + 0.5, y + 0.5, left, top, right, bottom, radius)
      // Distance is in pixels, so clamping over one pixel gives a clean edge.
      const coverage = Math.min(1, Math.max(0, 0.5 - distance))
      if (coverage > 0) setPixel(x, y, colorAt(x, y), coverage)
    }
  }
}

function lerp(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t))
}

/*
 * Rounded-square app tile: dark bars on white.
 *
 * White rather than the brand navy because the icon is shown against whatever
 * the operating system puts behind it — a dark taskbar, a light dock, a folder
 * of other icons — and a light tile with dark contents stays legible on all of
 * them, where a dark tile disappears into a dark taskbar.
 */
const TOP_COLOR = [255, 255, 255]
const BOTTOM_COLOR = [244, 246, 250]
const INSET = SIZE * 0.06

fillRoundedRect(INSET, INSET, SIZE - INSET, SIZE - INSET, SIZE * 0.22, (_x, y) =>
  lerp(TOP_COLOR, BOTTOM_COLOR, (y - INSET) / (SIZE - INSET * 2))
)

/**
 * A waveform of rounded bars — the app's own subject, and legible down to the
 * 16px favicon size where finer detail would disappear.
 */
const BAR_HEIGHTS = [0.22, 0.44, 0.72, 1.0, 0.62, 0.86, 0.34, 0.54, 0.26]
const BAR_WIDTH = SIZE * 0.058
const BAR_GAP = SIZE * 0.038
const MAX_BAR = SIZE * 0.46
const CENTER_Y = SIZE / 2
const TOTAL_WIDTH = BAR_HEIGHTS.length * BAR_WIDTH + (BAR_HEIGHTS.length - 1) * BAR_GAP
const START_X = (SIZE - TOTAL_WIDTH) / 2

/* Sona Navy, the brand's darkest tone. */
const BAR_COLOR = [23, 32, 51]

BAR_HEIGHTS.forEach((scale, i) => {
  const left = START_X + i * (BAR_WIDTH + BAR_GAP)
  const half = (MAX_BAR * scale) / 2
  fillRoundedRect(
    left,
    CENTER_Y - half,
    left + BAR_WIDTH,
    CENTER_Y + half,
    BAR_WIDTH / 2,
    () => BAR_COLOR
  )
})

/* ---------------------------------------------------------------- encoding --- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // colour type: RGBA
// 10..12 stay zero: deflate compression, adaptive filtering, no interlace.

// Each scanline is prefixed with its filter type; 0 means "none", which costs a
// little size but keeps the encoder trivial.
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1)
  raw[rowStart] = 0
  pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const out = join(ROOT, 'build', 'icon.png')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, png)
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(0)} kB)`)

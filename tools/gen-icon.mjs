/* 生成扩展图标（纯 Node，零依赖）：粉色圆角底 + 白色 B */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'icons')
mkdirSync(outDir, { recursive: true })

const SIZE = 128
const BG = [251, 114, 153, 255]
const FG = [255, 255, 255, 255]

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r))
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r))
  return dx * dx + dy * dy <= r * r
}

function inLetterB(x, y) {
  const stem = x >= 40 && x <= 50 && y >= 30 && y <= 98
  const top = x >= 40 && x <= 92 && y >= 30 && y <= 42
  const mid = x >= 40 && x <= 92 && y >= 56 && y <= 68
  const bottom = x >= 40 && x <= 92 && y >= 82 && y <= 98
  const topLobe = x >= 78 && x <= 92 && y >= 42 && y <= 56
  const bottomLobe = x >= 78 && x <= 92 && y >= 68 && y <= 82
  return stem || top || mid || bottom || topLobe || bottomLobe
}

function drawBase() {
  const canvas = new Uint8Array(SIZE * SIZE * 4)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!inRoundedRect(x, y, 8, 8, 119, 119, 26)) continue
      const color = inLetterB(x, y) ? FG : BG
      const i = (y * SIZE + x) * 4
      canvas[i] = color[0]
      canvas[i + 1] = color[1]
      canvas[i + 2] = color[2]
      canvas[i + 3] = color[3]
    }
  }
  return canvas
}

function downscale(src, dstSize) {
  const dst = new Uint8Array(dstSize * dstSize * 4)
  const scale = SIZE / dstSize
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const x0 = Math.floor(x * scale)
      const x1 = Math.min(SIZE, Math.ceil((x + 1) * scale))
      const y0 = Math.floor(y * scale)
      const y1 = Math.min(SIZE, Math.ceil((y + 1) * scale))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * SIZE + sx) * 4
          const alpha = src[i + 3] / 255
          r += src[i] * alpha
          g += src[i + 1] * alpha
          b += src[i + 2] * alpha
          a += alpha
          n++
        }
      }
      const i = (y * dstSize + x) * 4
      if (a > 0) {
        dst[i] = Math.round(r / a)
        dst[i + 1] = Math.round(g / a)
        dst[i + 2] = Math.round(b / a)
      }
      dst[i + 3] = Math.round((a / n) * 255)
    }
  }
  return dst
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const base = drawBase()
;[16, 32, 48, 128].forEach((size) => {
  const rgba = size === SIZE ? base : downscale(base, size)
  writeFileSync(join(outDir, `icon${size}.png`), encodePng(size, rgba))
})

console.log('icons generated ->', outDir)
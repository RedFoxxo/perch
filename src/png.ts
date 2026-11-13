import { crc32, deflateSync, inflateSync } from 'node:zlib'

// Screenshots on Windows arrive as full-size PNGs; perch shrinks them to the agent's max edge itself,
// so a 4K window costs the same tokens as on Linux. Only what Go's image/png writes is read: 8-bit,
// not interlaced, gray, gray+alpha, RGB or RGBA.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

export interface Fitted {
  png: Buffer
  width: number
  height: number
  /** Output pixels per input pixel (1 when the image already fit). */
  scale: number
}

/** The PNG scaled down so its longest side is at most `maxEdge`; returned as-is when it already fits. */
export function fitPng(png: Buffer, maxEdge: number): Fitted {
  const size = pngSize(png)
  if (Math.max(size.width, size.height) <= maxEdge) return { png, ...size, scale: 1 }
  const { width, height, rgb } = decodePng(png)
  const scale = maxEdge / Math.max(width, height)
  const ow = Math.max(1, Math.round(width * scale))
  const oh = Math.max(1, Math.round(height * scale))
  return { png: encodeRgb(shrink(rgb, width, height, ow, oh), ow, oh), width: ow, height: oh, scale: ow / width }
}

/** Width and height from the header, without decoding. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** RGB pixels, row by row; alpha is dropped. */
export function decodePng(png: Buffer): { width: number; height: number; rgb: Uint8Array } {
  const { width, height } = pngSize(png)
  const bitDepth = png[24]
  const colorType = png[25] ?? -1
  const interlace = png[28]
  const channels = CHANNELS[colorType]
  if (bitDepth !== 8 || channels === undefined || interlace !== 0) {
    throw new Error(`unsupported PNG (bit depth ${bitDepth}, color type ${colorType}, interlace ${interlace})`)
  }
  const idat: Buffer[] = []
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length))
    if (type === 'IEND') break
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    const prev = row - stride
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[row + i - channels]! : 0
      const b = y > 0 ? pixels[prev + i]! : 0
      const c = y > 0 && i >= channels ? pixels[prev + i - channels]! : 0
      const x = raw[src + i]!
      let v: number
      if (filter === 0) v = x
      else if (filter === 1) v = x + a
      else if (filter === 2) v = x + b
      else if (filter === 3) v = x + ((a + b) >> 1)
      else if (filter === 4) v = x + paeth(a, b, c)
      else throw new Error(`bad PNG filter ${filter}`)
      pixels[row + i] = v & 0xff
    }
  }
  if (channels === 3) return { width, height, rgb: pixels }
  // Alpha is dropped: screenshots are opaque.
  const rgb = new Uint8Array(width * height * 3)
  for (let p = 0; p < width * height; p++) {
    for (let k = 0; k < 3; k++) rgb[p * 3 + k] = pixels[p * channels + (channels < 3 ? 0 : k)]!
  }
  return { width, height, rgb }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Box filter: each output pixel is the average of the input pixels it covers. */
function shrink(rgb: Uint8Array, w: number, h: number, ow: number, oh: number): Uint8Array {
  const span = (from: number, to: number, i: number) => {
    const start = Math.floor((i * from) / to)
    return [start, Math.max(start + 1, Math.floor(((i + 1) * from) / to))] as const
  }
  const out = new Uint8Array(ow * oh * 3)
  for (let oy = 0; oy < oh; oy++) {
    const [y0, y1] = span(h, oh, oy)
    for (let ox = 0; ox < ow; ox++) {
      const [x0, x1] = span(w, ow, ox)
      let r = 0
      let g = 0
      let b = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const at = (y * w + x) * 3
          r += rgb[at]!
          g += rgb[at + 1]!
          b += rgb[at + 2]!
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const at = (oy * ow + ox) * 3
      out[at] = Math.round(r / n)
      out[at + 1] = Math.round(g / n)
      out[at + 2] = Math.round(b / n)
    }
  }
  return out
}

/** An RGB PNG; every row uses the Sub filter, which compresses screenshots well. */
export function encodeRgb(rgb: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 3
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 1
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? rgb[y * stride + i - 3]! : 0
      raw[y * (stride + 1) + 1 + i] = (rgb[y * stride + i]! - left) & 0xff
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

#!/usr/bin/env node
/**
 * Turn the source art in `web/assets` into the files the view serves from `web/public`.
 *
 *     npm run logos
 *
 * The source art is 2172×724 and about 400 kB per file, sitting in a box a good deal larger than
 * the drawing. The header draws the wordmark 26 px tall. Trimming the transparent margin and
 * downscaling turns each one into about 20 kB, and — because the margin is gone — makes the height
 * in the stylesheet the height of the artwork rather than of the box around it.
 *
 * `DERIVE_DARK` builds the dark variant from the light source instead of using
 * `probez-logo-dark.png`, by repainting the navy wordmark near-white and leaving the blue mark
 * alone. It is off, because the supplied dark file is good. It exists because an earlier one was
 * not: 48% of its wordmark's ink was missing, whole pixels transparent rather than white, which at
 * a glance looked like lettering eaten away. If a future export comes back looking speckled, check
 * it with the composite in this file's commit message before assuming the renderer is at fault, and
 * turn this on to keep shipping while it is fixed.
 *
 * No dependencies: PNG is a container around zlib, and both are in the standard library.
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'web', 'assets')
const to = join(root, 'web', 'public')
const docs = join(root, 'docs')

/** The dark logo is rebuilt from the light one. See above. */
const DERIVE_DARK = false

/** Height the header draws the wordmark at, times three, so it stays crisp on any display. */
const LOGO_HEIGHT = 96
const ICON_SIZE = 128
/** Width the README asks for, doubled, for retina screens. */
const README_WIDTH = 640

/* PNG ---------------------------------------------------------------------------------------- */

function decode(file) {
  const data = readFileSync(file)
  let at = 8
  let width = 0
  let height = 0
  let colour = 0
  const parts = []
  while (at < data.length) {
    const length = data.readUInt32BE(at)
    const type = data.toString('ascii', at + 4, at + 8)
    const body = data.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8) throw new Error(`${file}: only 8-bit channels are handled`)
      colour = body[9]
    } else if (type === 'IDAT') {
      parts.push(body)
    }
    at += 12 + length
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour]
  if (channels === undefined) throw new Error(`${file}: unsupported colour type ${colour}`)

  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let read = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read]
    read += 1
    const line = raw.subarray(read, read + stride)
    read += stride
    const row = out.subarray(y * stride, (y + 1) * stride)
    const above = y === 0 ? null : out.subarray((y - 1) * stride, y * stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? row[i - channels] : 0
      const b = above === null ? 0 : above[i]
      const c = i >= channels && above !== null ? above[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      row[i] = value & 255
    }
  }
  return { width, height, channels, pixels: out }
}

function chunk(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0)
  return Buffer.concat([head, body, crc])
}

const CRC = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

/** Always RGBA, always filter 0: these are small images and the size is dominated by the pixels. */
function encode({ width, height, pixels }) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* Operations --------------------------------------------------------------------------------- */

function toRgba(image) {
  if (image.channels === 4) return image
  const pixels = Buffer.alloc(image.width * image.height * 4, 255)
  for (let i = 0, o = 0; o < pixels.length; i += image.channels, o += 4) {
    const grey = image.channels <= 2
    pixels[o] = image.pixels[i]
    pixels[o + 1] = grey ? image.pixels[i] : image.pixels[i + 1]
    pixels[o + 2] = grey ? image.pixels[i] : image.pixels[i + 2]
    pixels[o + 3] = image.channels === 2 ? image.pixels[i + 1] : 255
  }
  return { ...image, channels: 4, pixels }
}

/**
 * Crop away the transparent margin.
 *
 * The source art sits in a box a good deal larger than the drawing, so a logo asked to be 24 px
 * tall arrives about 14 px tall and reads as an afterthought. Trimming first means the height in
 * the stylesheet is the height of the artwork, which is the number anyone setting it will assume.
 */
function trim(image, threshold = 8) {
  let top = image.height
  let bottom = -1
  let left = image.width
  let right = -1
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.pixels[(y * image.width + x) * 4 + 3] <= threshold) continue
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (x < left) left = x
      if (x > right) right = x
    }
  }
  if (bottom < 0) return image

  const width = right - left + 1
  const height = bottom - top + 1
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const start = ((top + y) * image.width + left) * 4
    image.pixels.copy(pixels, y * width * 4, start, start + width * 4)
  }
  return { width, height, channels: 4, pixels }
}

/**
 * Box-filter downscale, averaging in premultiplied alpha.
 *
 * Averaging straight RGBA would let fully transparent pixels drag colour into the edges of the
 * glyphs, which on a logo shows up as a dark fringe around every letter.
 */
function resize(image, width, height) {
  const out = Buffer.alloc(width * height * 4)
  const xs = image.width / width
  const ys = image.height / height
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * ys)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * ys))
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * xs)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xs))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * image.width + sx) * 4
          const alpha = image.pixels[i + 3] / 255
          r += image.pixels[i] * alpha
          g += image.pixels[i + 1] * alpha
          b += image.pixels[i + 2] * alpha
          a += alpha
          n += 1
        }
      }
      const o = (y * width + x) * 4
      const mean = a / n
      out[o] = mean === 0 ? 0 : Math.round(r / n / mean)
      out[o + 1] = mean === 0 ? 0 : Math.round(g / n / mean)
      out[o + 2] = mean === 0 ? 0 : Math.round(b / n / mean)
      out[o + 3] = Math.round(mean * 255)
    }
  }
  return { width, height, channels: 4, pixels: out }
}

/**
 * Repaint the wordmark for a dark surface, leaving the mark alone.
 *
 * The wordmark is one flat navy (#051f44) and the mark is saturated blue, so the two separate on
 * the blue channel with a wide margin. Alpha is untouched, which is what keeps the letter edges
 * antialiasing correctly against whatever they end up on.
 */
function repaint(image, [r, g, b]) {
  const pixels = Buffer.from(image.pixels)
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue
    const navy = pixels[i + 2] < 150 && pixels[i + 1] < 90
    if (!navy) continue
    pixels[i] = r
    pixels[i + 1] = g
    pixels[i + 2] = b
  }
  return { ...image, pixels }
}

/* ---------------------------------------------------------------------------------------------- */

mkdirSync(to, { recursive: true })

const light = trim(toRgba(decode(join(from, 'probez-logo-light.png'))))
const width = Math.round((light.width / light.height) * LOGO_HEIGHT)

const dark = DERIVE_DARK
  ? repaint(light, [246, 246, 244])
  : trim(toRgba(decode(join(from, 'probez-logo-dark.png'))))

const icon = trim(toRgba(decode(join(from, 'probez-icon.png'))))

/**
 * The README's logo is a third file, and a different design problem.
 *
 * `probez-logo.png` is the one used everywhere a renderer cannot tell us the theme — npm, and any
 * markdown that ignores `<picture>` — which is the right default, because those surfaces are white
 * and its wordmark measures 12.1:1 there.
 *
 * On a dark background it measures **1.5:1**, so GitHub's dark mode gets `probez-logo-dark.png`
 * through a `<source>` instead. That is not a preference: 1.5:1 is a wordmark you have to look for,
 * and dark mode is not a minority case on GitHub.
 *
 * Both go to `docs/` rather than `web/public/`, because `web/public` is copied verbatim into the
 * published package and nothing in the app ever loads either of them.
 */
const universal = trim(toRgba(decode(join(from, 'probez-logo.png'))))
const readmeHeight = Math.round((universal.height / universal.width) * README_WIDTH)
const readmeDarkHeight = Math.round((dark.height / dark.width) * README_WIDTH)

const written = []
for (const [name, image] of [
  ['logo-light.png', resize(light, width, LOGO_HEIGHT)],
  ['logo-dark.png', resize(dark, width, LOGO_HEIGHT)],
  ['icon.png', resize(icon, ICON_SIZE, ICON_SIZE)],
]) {
  const body = encode(image)
  writeFileSync(join(to, name), body)
  written.push(`web/public/${name}  ${image.width}×${image.height}  ${(body.length / 1024).toFixed(1)} kB`)
}

for (const [name, image] of [
  ['logo.png', resize(universal, README_WIDTH, readmeHeight)],
  ['logo-dark.png', resize(dark, README_WIDTH, readmeDarkHeight)],
]) {
  const body = encode(image)
  writeFileSync(join(docs, name), body)
  written.push(`docs/${name}  ${image.width}×${image.height}  ${(body.length / 1024).toFixed(1)} kB`)
}

console.log(written.map((line) => `  ${line}`).join('\n'))
if (DERIVE_DARK) {
  console.log('\n  logo-dark.png was derived from the light source; see the note in this file.')
}

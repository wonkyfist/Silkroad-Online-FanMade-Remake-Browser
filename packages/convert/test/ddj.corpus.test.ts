import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { DDSD_MIPMAPCOUNT, decodeDds, parseDdj, readDdsHeader } from '@sro/formats'
import { ARCHIVES, loadConfig, openArchive, REPO_ROOT } from '../src/node-io.ts'
import { crc32, encodePng } from '../src/png.ts'

/** Tiny PNG reader for round-trip checks: validates every chunk CRC, supports 8-bit RGBA and all five filters. */
function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array; chunks: string[] } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  expect(Array.from(png.subarray(0, 8))).toEqual(sig)
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const chunks: string[] = []
  const idat: Uint8Array[] = []
  let width = 0
  let height = 0
  for (let o = 8; o < png.length; ) {
    const len = view.getUint32(o)
    const type = new TextDecoder('latin1').decode(png.subarray(o + 4, o + 8))
    const data = png.subarray(o + 8, o + 8 + len)
    expect(view.getUint32(o + 8 + len), `${type} CRC`).toBe(crc32(png.subarray(o + 4, o + 8 + len)))
    chunks.push(type)
    if (type === 'IHDR') {
      width = view.getUint32(o + 8)
      height = view.getUint32(o + 12)
      expect(Array.from(data.subarray(8))).toEqual([8, 6, 0, 0, 0])
    } else if (type === 'IDAT') idat.push(data)
    o += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  expect(raw.length).toBe((stride + 1) * height)
  const rgba = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[y * stride + i - 4]! : 0
      const b = y > 0 ? rgba[(y - 1) * stride + i]! : 0
      const c = i >= 4 && y > 0 ? rgba[(y - 1) * stride + i - 4]! : 0
      let pred = 0
      if (filter === 1) pred = a
      else if (filter === 2) pred = b
      else if (filter === 3) pred = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else expect(filter).toBe(0)
      rgba[y * stride + i] = (src[i]! + pred) & 0xff
    }
  }
  return { width, height, rgba, chunks }
}

describe('encodePng', () => {
  it('crc32 matches the PNG spec check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082)
  })

  it('round-trips RGBA through inflate with valid chunk CRCs', () => {
    for (const [w, h] of [[1, 1], [3, 5], [17, 9], [64, 32]] as const) {
      const rgba = new Uint8Array(w * h * 4)
      for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + (i >> 6) * 11) & 0xff
      // smooth rows so both filter choices get exercised
      for (let y = h >> 1; y < h; y++) rgba.fill(y * 3, y * w * 4, (y + 1) * w * 4)
      const png = decodePng(encodePng(w, h, rgba))
      expect(png.chunks).toEqual(['IHDR', 'IDAT', 'IEND'])
      expect([png.width, png.height]).toEqual([w, h])
      expect(Buffer.compare(Buffer.from(png.rgba), Buffer.from(rgba))).toBe(0)
    }
  })

  it('rejects mismatched buffers', () => {
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow(/expected 16/)
    expect(() => encodePng(0, 2, new Uint8Array(0))).toThrow(/invalid size/)
  })
})

const HAS_CONFIG = existsSync(join(REPO_ROOT, 'sro.config.json'))

/**
 * Files expected to fail, as "Archive:path" -> reason. Empty: every DDJ in vSRO 1.188 parses, decodes and
 * meets every per-file invariant. (Full decode of all ~32.6k files takes ~10 s, so no sampling is needed.)
 */
const ALLOWLIST = new Map<string, string>()

/**
 * DDJ files found by signature whose name does not end in .ddj. The client never loads this one (it is a
 * byte-identical stray copy of icon/action/cos_cmd_inventory.ddj), but it is still decoded like the rest.
 */
const EXPECTED_EXTENSION_MISMATCHES = ['Media:icon/action/cos_cmd_inventory']

const isPot = (n: number) => (n & (n - 1)) === 0

/**
 * Mean absolute difference (all four channels) between mip level 1 and a box-filtered level 0. A correct
 * mip offset gives a few units; reading the wrong bytes gives noise. Odd sizes fold the last row/column in.
 */
function mipBoxError(l0: { width: number; height: number; rgba: Uint8Array }, l1: { width: number; height: number; rgba: Uint8Array }): number {
  let sum = 0
  for (let y = 0; y < l1.height; y++) {
    const y0 = Math.min(2 * y, l0.height - 1)
    const y1 = Math.min(2 * y + 1, l0.height - 1)
    for (let x = 0; x < l1.width; x++) {
      const x0 = Math.min(2 * x, l0.width - 1)
      const x1 = Math.min(2 * x + 1, l0.width - 1)
      for (let c = 0; c < 4; c++) {
        const avg =
          (l0.rgba[(y0 * l0.width + x0) * 4 + c]! +
            l0.rgba[(y0 * l0.width + x1) * 4 + c]! +
            l0.rgba[(y1 * l0.width + x0) * 4 + c]! +
            l0.rgba[(y1 * l0.width + x1) * 4 + c]!) /
          4
        sum += Math.abs(avg - l1.rgba[(y * l1.width + x) * 4 + c]!)
      }
    }
  }
  return sum / (l1.width * l1.height * 4)
}

const percentile = (values: number[], p: number) => {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0
}
const bump = (m: Record<string, number>, k: string | number, by = 1) => {
  m[k] = (m[k] ?? 0) + by
}
const sorted = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]))

describe.skipIf(!HAS_CONFIG)('DDJ corpus (vSRO 1.188)', () => {
  it('parses and decodes every DDJ (by signature or extension) in every archive', () => {
    const t0 = performance.now()
    const perArchive: Record<string, number> = {}
    const formats: Record<string, number> = {}
    const dims: Record<string, number> = {}
    const mips: Record<string, number> = {}
    const textureTypes: Record<string, number> = {}
    const failures: string[] = []
    const allowlisted: string[] = []
    const sizeFieldMismatch: string[] = []
    const payloadMismatch: string[] = []
    const nonPotExamples: string[] = []
    const extensionMismatch: string[] = []
    const mipErrors: number[] = []
    const worstMips: Array<[number, string]> = []
    let files = 0
    let nonPot = 0
    let cube = 0
    let volume = 0
    let pixels = 0
    // DXT1: blocks in 3-color mode and texels decoded as transparent
    const dxt1 = { files: 0, threeColorBlocks: 0, blocks: 0, filesWithTransparency: 0, transparentTexels: 0 }
    // DXT2: is the stored color really premultiplied (rgb <= a)?
    const dxt2 = { files: 0, texels: 0, translucentTexels: 0, colorAboveAlpha: 0, filesColorAboveAlpha: 0, examples: [] as string[] }

    for (const archiveName of ARCHIVES) {
      const archive = openArchive(archiveName)
      for (const file of archive.files.values()) {
        // Select by signature as well as extension: one DDJ in Media has no extension.
        const byExtension = file.path.toLowerCase().endsWith('.ddj')
        const bySignature =
          file.size >= 12 &&
          file.offset + 12 <= archive.source.size &&
          new TextDecoder('latin1').decode(archive.source.read(file.offset, 8)) === 'JMXVDDJ '
        if (!byExtension && !bySignature) continue
        const id = `${archiveName}:${file.path}`
        if (byExtension !== bySignature) extensionMismatch.push(id)
        files++
        bump(perArchive, archiveName)
        try {
          const ddj = parseDdj(archive.read(file))
          bump(textureTypes, ddj.textureType)
          const header = readDdsHeader(ddj.dds)
          const problems: string[] = []
          if (ddj.declaredSize !== ddj.dds.length + 8) {
            sizeFieldMismatch.push(`${id} declared ${ddj.declaredSize}, actual ${ddj.dds.length + 8}`)
            problems.push(`size field ${ddj.declaredSize} != dds.length + 8 = ${ddj.dds.length + 8}`)
          }
          const expected = header.dataOffset + header.dataSize
          if (ddj.dds.length !== expected) {
            payloadMismatch.push(`${id} dds ${ddj.dds.length} bytes, mip chain needs ${expected}`)
            problems.push(`dds is ${ddj.dds.length} bytes, header + full chain needs ${expected}`)
          }
          const expectedType = header.isCube ? 5 : header.isVolume ? 4 : 3
          if (ddj.textureType !== expectedType) problems.push(`textureType ${ddj.textureType} but DDS caps2 implies ${expectedType}`)
          if (((header.flags & DDSD_MIPMAPCOUNT) !== 0) !== header.mipMapCount > 0) {
            problems.push(`DDSD_MIPMAPCOUNT flag disagrees with mipMapCount ${header.mipMapCount}`)
          }

          const img = decodeDds(ddj.dds, { unpremultiply: false })
          expect(img.rgba.length).toBe(header.width * header.height * 4)
          if (header.mipCount > 1) {
            // Level 1 must look like a box-filtered level 0 (checks the mip offset arithmetic semantically).
            const m1 = decodeDds(ddj.dds, { mip: 1, unpremultiply: false })
            const err = mipBoxError(img, m1)
            mipErrors.push(err)
            worstMips.push([err, `${id} ${header.format} ${header.width}x${header.height}`])
            // The smallest level is the last surface in the file.
            const last = decodeDds(ddj.dds, { mip: header.mipCount - 1 })
            if (last.width * last.height === 0) problems.push('empty last mip')
          }
          if (problems.length > 0) throw new Error(problems.join('; '))

          bump(formats, img.format)
          bump(dims, `${img.width}x${img.height}`)
          bump(mips, header.mipCount)
          pixels += img.width * img.height
          if (!isPot(img.width) || !isPot(img.height)) {
            nonPot++
            if (nonPotExamples.length < 8) nonPotExamples.push(`${id} ${img.width}x${img.height} ${img.format}`)
          }
          if (header.isCube) cube++
          if (header.isVolume) volume++

          if (img.format === 'DXT1') {
            dxt1.files++
            const dds = ddj.dds
            const blocks = Math.max(1, (header.width + 3) >> 2) * Math.max(1, (header.height + 3) >> 2)
            for (let b = 0, o = header.dataOffset; b < blocks; b++, o += 8) {
              if ((dds[o]! | (dds[o + 1]! << 8)) <= (dds[o + 2]! | (dds[o + 3]! << 8))) dxt1.threeColorBlocks++
            }
            dxt1.blocks += blocks
            let transparent = 0
            for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] === 0) transparent++
            dxt1.transparentTexels += transparent
            if (transparent) dxt1.filesWithTransparency++
          } else if (img.format === 'DXT2') {
            dxt2.files++
            let above = 0
            for (let i = 0; i < img.rgba.length; i += 4) {
              const a = img.rgba[i + 3]!
              dxt2.texels++
              if (a < 255) dxt2.translucentTexels++
              if (img.rgba[i]! > a || img.rgba[i + 1]! > a || img.rgba[i + 2]! > a) above++
            }
            dxt2.colorAboveAlpha += above
            if (above) {
              dxt2.filesColorAboveAlpha++
              if (dxt2.examples.length < 5) dxt2.examples.push(id)
            }
            // default (un-premultiplied) path must decode too
            decodeDds(ddj.dds)
          }
          if (ALLOWLIST.has(id)) allowlisted.push(`${id}: decoded although allowlisted (${ALLOWLIST.get(id)})`)
        } catch (e) {
          if (ALLOWLIST.has(id)) allowlisted.push(`${id}: ${(e as Error).message}`)
          else failures.push(`${id}: ${(e as Error).message}`)
        }
      }
    }
    const seconds = (performance.now() - t0) / 1000
    worstMips.sort((a, b) => b[0] - a[0])
    const mipCheck = {
      files: mipErrors.length,
      p50: Number(percentile(mipErrors, 0.5).toFixed(2)),
      p99: Number(percentile(mipErrors, 0.99).toFixed(2)),
      max: Number(percentile(mipErrors, 1).toFixed(2)),
      worst: worstMips.slice(0, 5).map(([e, id]) => `${e.toFixed(1)} ${id}`),
    }

    const dimsSorted = sorted(dims)
    const report = {
      files,
      perArchive,
      seconds: Number(seconds.toFixed(1)),
      megapixels: Number((pixels / 1e6).toFixed(1)),
      formats: sorted(formats),
      textureTypes,
      mipCounts: mips,
      distinctDimensions: Object.keys(dims).length,
      dimensions: dimsSorted,
      nonPot,
      nonPotExamples,
      cube,
      volume,
      sizeFieldMismatches: sizeFieldMismatch.length,
      sizeFieldMismatchExamples: sizeFieldMismatch.slice(0, 20),
      payloadMismatches: payloadMismatch.length,
      payloadMismatchExamples: payloadMismatch.slice(0, 20),
      extensionMismatch,
      mipCheck,
      dxt1,
      dxt2,
      failures,
      allowlisted,
    }
    const outDir = join(loadConfig().workDir, 'out', 'debug')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'ddj-corpus.json'), JSON.stringify(report, null, 2))
    console.log(
      JSON.stringify({ ...report, dimensions: Object.fromEntries(Object.entries(dimsSorted).slice(0, 25)) }, null, 2),
    )

    expect(failures).toEqual([])
    expect(files).toBeGreaterThan(30_000)
    expect(extensionMismatch).toEqual(EXPECTED_EXTENSION_MISMATCHES)
    // vSRO 1.188: level 1 differs from a 2x2 box filter of level 0 by ~3 units on average (the few
    // outliers are hand-edited or differently filtered chains). Shifting the data by a single block
    // raises the median to ~20, so these bounds catch misplaced mip offsets.
    expect(mipErrors.length).toBeGreaterThan(5_000)
    expect(mipCheck.p50).toBeLessThan(6)
    expect(mipCheck.p99).toBeLessThan(16)
    expect(mipCheck.max).toBeLessThan(48)
  })

  it('writes debug PNGs of the test assets to work/out/debug', () => {
    const assets: Array<[Parameters<typeof openArchive>[0], string, string]> = [
      // diffuse maps named by prim/mtrl/char/china/man/chinaman_adventurer.bmt
      ['Data', 'prim/mtrl/char/china/man/chinaman_adventurer_body.ddj', 'DXT3'],
      ['Data', 'prim/mtrl/char/china/man/chinaman_adventurer_hair.ddj', 'DXT3'],
      ['Media', 'icon/item/china/weapon/blade_01.ddj', 'A1R5G5B5'],
    ]
    const outDir = join(loadConfig().workDir, 'out', 'debug')
    mkdirSync(outDir, { recursive: true })
    for (const [archiveName, path, format] of assets) {
      const img = decodeDds(parseDdj(openArchive(archiveName).read(path)).dds)
      expect(img.format).toBe(format)
      const png = encodePng(img.width, img.height, img.rgba)
      const back = decodePng(png)
      expect(Buffer.compare(Buffer.from(back.rgba), Buffer.from(img.rgba))).toBe(0)
      writeFileSync(join(outDir, path.slice(path.lastIndexOf('/') + 1).replace(/\.ddj$/, '.png')), png)
    }
  })
})

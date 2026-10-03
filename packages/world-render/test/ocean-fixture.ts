/**
 * CST-O test helpers: a synthetic coast field for the 7 × 7 streaming fixture (COAST §12.4: "until CST-C's first export
 * lands, CST-O works on a synthetic field written by its own test helper"), in the manifest's WorldCoast format, as a
 * real PNG (so the exact decoder runs), with A = 0 everywhere (no authoring).
 *
 * The layout (glTF metres; the fixture's regions span x −576 … 768, z −768 … 576): open sea east of x = 800, its bed
 * falling 1 m per 10 m; a sandy beach rising 1 m per 20 m west of the shore; a "town" patch below the sea level far
 * inland (x −400 … −300, z −100 … 0: 8 m below, like Jangan at −3.26 m); and a retail water block at the sea level
 * right at the shore (region (106, 103), block (5, 2)), the join.
 */
import { deflateSync } from 'node:zlib'
import type { WorldCoast } from '../../convert/src/world/manifest.ts'
import type { Fixture } from './stream-fixture.ts'
import { BASE_URL, CX, CZ } from './stream-fixture.ts'

export const SEA_LEVEL = 5
export const SHORE_X = 800
export const FIELD: WorldCoast['field'] = { file: 'coast/field.png', x0: -1200, z0: -1200, metresPerTexel: 4, width: 700, height: 600 }
export const TOWN = { x0: -400, x1: -300, z0: -100, z1: 0 }

/** An RGBA8 PNG (filter 0, one IDAT). */
export function encodePng(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff
    for (const v of b) c = table[(c ^ v) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const raw = new Uint8Array((w * 4 + 1) * h)
  for (let j = 0; j < h; j++) raw.set(rgba.subarray(j * w * 4, (j + 1) * w * 4), j * (w * 4 + 1) + 1)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** The field's RGBA (the file's encoding: R mask, G distance 0.5 m steps, B depth / height 0.2 m steps, A 0). */
export function fieldPixels(): Uint8Array {
  const { width: w, height: h, x0, z0, metresPerTexel: m } = FIELD
  const px = new Uint8Array(w * h * 4)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = x0 + (i + 0.5) * m, z = z0 + (j + 0.5) * m
      const o = (j * w + i) * 4
      const d = x - SHORE_X
      const sea = d >= 0
      let ground = sea ? SEA_LEVEL - d / 10 : SEA_LEVEL + -d / 20
      const town = x >= TOWN.x0 && x < TOWN.x1 && z >= TOWN.z0 && z < TOWN.z1
      if (town) ground = SEA_LEVEL - 8
      px[o] = sea ? 255 : 0
      px[o + 1] = Math.min(255, Math.round(Math.abs(d) / 0.5))
      px[o + 2] = Math.min(255, Math.round(Math.min(51, Math.abs(ground - SEA_LEVEL)) / 0.2))
      px[o + 3] = 0
    }
  }
  return px
}

/** Adds manifest.coast, the field file and the join's retail water block to a fixture. */
export function addCoast(fx: Fixture, o: { join?: boolean } = {}): void {
  fx.manifest.coast = { seaLevelM: SEA_LEVEL, field: { ...FIELD }, mapColor: '#2a5a78', sourceHash: 'test' }
  fx.files.set(BASE_URL + FIELD.file, encodePng(fieldPixels(), FIELD.width, FIELD.height))
  if (o.join ?? true) {
    const r = fx.manifest.regions.find(r => r.x === CX + 3 && r.z === CZ)!
    r.blocks[2 * 6 + 5]!.water = { kind: 'water', type: 0, wave: 1, heightM: SEA_LEVEL }
  }
}

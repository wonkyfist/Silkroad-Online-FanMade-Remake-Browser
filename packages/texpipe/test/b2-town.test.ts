/**
 * TL-B phase 2: the B2 town batch config (docs/TOWN_LIFE.md §7.6; docs/WAVE_PLAN7.md TL-B, D27, D28). The batch is
 * data: its list in content/texpipe/b2-town.json and its entries in content/texpipe/overrides.json: the buildings are
 * hero sets on the GAN route (Medium gets their maps); the paving and street tiles are not heroes (TEXPIPE §1.3's 16
 * stay the hero tiles; High maps all terrain) and take the SDXL route with the soft maps their B1 siblings needed. It runs on the GPU queue in I-11, only if the LAB-11 gate passes. With the export and
 * the inventory present, its scope is checked against what stands around the plaza; once it has been encoded into
 * work/out/pbr/index.json, its sets are checked there too (skipped otherwise). Wave 12's TT-B (docs/TERRAIN_TEX.md D6,
 * content/texpipe/b3-terrain.json) supersedes the tile rows: the eight tiles are B3a heroes on the GAN route.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateOverrides, type PbrIndex, type TexpipeOverrides } from '../src/format.ts'

const ROOT = join(import.meta.dirname, '../../..')
const overrides = JSON.parse(readFileSync(join(ROOT, 'content/texpipe/overrides.json'), 'utf8')) as TexpipeOverrides

interface BatchFile {
  format: 'sro-texpipe-batch'
  version: 1
  batch: string
  run: string
  gate: { baseTextureVramMiB: number; maxAddedVramMiB: number; maxAddedP95Ms: number; projectedAddedVramMiB: number; fallback: string }
  keys: string[]
}
const b2 = JSON.parse(readFileSync(join(ROOT, 'content/texpipe/b2-town.json'), 'utf8')) as BatchFile
const tiles = b2.keys.filter(k => k.startsWith('tile2d:'))
const world = b2.keys.filter(k => !k.startsWith('tile2d:'))

/** The plaza's centre (glTF metres, TOWN_LIFE §1.9) and how far a building may stand from it and still be "seen from the plaza and the market". */
const PLAZA = { x: 97, z: -110 }
const SEEN_M = 120
/** RGBA8 with mips, bytes per texel (TEXPIPE §6.5), × albedo, normal, ORMH: the Medium upper bound of a hero set at retail size. */
const BYTES_PER_TEXEL = 5.3
const PLANES = 3

describe('B2 town batch config', () => {
  it('b2-town.json: about 40 unique keys, the §7.6 gate (+60 MiB, +0.3 ms) and its fallback', () => {
    expect(b2.format).toBe('sro-texpipe-batch')
    expect(b2.batch).toBe('B2')
    expect(b2.keys.length).toBeGreaterThanOrEqual(30)
    expect(b2.keys.length).toBeLessThanOrEqual(45)
    expect(new Set(b2.keys).size).toBe(b2.keys.length)
    expect(b2.gate.baseTextureVramMiB).toBe(807)
    expect(b2.gate.maxAddedVramMiB).toBe(60)
    expect(b2.gate.maxAddedP95Ms).toBe(0.3)
    expect(b2.gate.projectedAddedVramMiB).toBeLessThanOrEqual(b2.gate.maxAddedVramMiB)
    expect(b2.gate.fallback).toMatch(/High only/)
    expect(b2.run).toMatch(/--set all/)
    expect(b2.run).toMatch(/gpu\.lock/)
  })

  it('overrides.json validates; every building is noted as B2 and is a hero set; the tiles are B3a rows now (wave 12)', () => {
    expect(validateOverrides(overrides)).toEqual([])
    for (const k of b2.keys) {
      const e = overrides.sets[k]
      expect(e, k).toBeDefined()
      // Wave 12's TT-B (TERRAIN_TEX D6) took over the eight paving and street tiles: B3a rows, heroes.
      expect(e!.hero ?? false, k).toBe(true)
      expect(e!.note, k).toMatch(k.startsWith('tile2d:') ? /^B3a / : /B2 town batch/)
      expect(e!.status, k).toBeUndefined()
    }
  })

  it('the paving and street tiles: the GAN route (TT-B0 kept SDXL on none), soft maps or the painterly rule; the buildings: GAN', () => {
    expect(tiles.length).toBeGreaterThanOrEqual(6)
    for (const k of tiles) {
      const e = overrides.sets[k]!
      expect(['gan', 'retail'], k).toContain(e.detail)
      expect(e.pbr?.normalScale, k).toBeLessThanOrEqual(0.6)
      expect(e.pbr?.aoScale, k).toBeLessThanOrEqual(0.5)
    }
    for (const k of world) {
      expect(k, k).toMatch(/^prim\/mtrl\/bldg\/china\/jangan0[13]\/[a-z0-9_]+\.ddj$/)
      expect(overrides.sets[k]!.detail ?? 'gan', k).toBe('gan')
    }
  })

  const INV = join(ROOT, 'work/texpipe/inventory.json')
  it.skipIf(!existsSync(INV))('in the inventory: every key; the Medium VRAM upper bound (the maps of the hero buildings) within the gate', () => {
    const inv = JSON.parse(readFileSync(INV, 'utf8')) as { entries: Array<{ key: string; size: [number, number]; group: string }> }
    const by = new Map(inv.entries.map(e => [e.key, e]))
    let texels = 0
    for (const k of b2.keys) {
      const e = by.get(k)
      expect(e, k).toBeDefined()
      expect(e!.group, k).toBe(k.startsWith('tile2d:') ? 'tile' : 'world')
      if (!k.startsWith('tile2d:')) texels += e!.size[0] * e!.size[1]
    }
    const mib = (texels * PLANES * BYTES_PER_TEXEL) / 2 ** 20
    expect(mib).toBeLessThanOrEqual(b2.gate.maxAddedVramMiB)
    expect(Math.abs(mib - b2.gate.projectedAddedVramMiB)).toBeLessThan(2)
  })

  const W = join(ROOT, 'work/out/world/jangan-fields')
  it.skipIf(!existsSync(join(W, 'manifest.json')))('in the export: the tiles are town tiles; every building texture stands within SEEN_M of the plaza', () => {
    for (const k of tiles) expect(existsSync(join(W, 'tiles', `${k.slice('tile2d:'.length)}.png`)), k).toBe(true)
    const m = JSON.parse(readFileSync(join(W, 'manifest.json'), 'utf8')) as {
      models: Array<{ index: number; sidecar?: string | null; boundsMin: number[]; boundsMax: number[] }>
      placements: Array<{ models: number[]; position: [number, number, number] }>
    }
    const near = new Set<number>()
    for (const p of m.placements) {
      for (const i of p.models) {
        const b = m.models[i]!
        const r = 0.5 * Math.hypot(b.boundsMax[0]! - b.boundsMin[0]!, b.boundsMax[2]! - b.boundsMin[2]!)
        if (Math.hypot(p.position[0] - PLAZA.x, p.position[2] - PLAZA.z) - r <= SEEN_M) near.add(i)
      }
    }
    const seen = new Set<string>()
    for (const i of near) {
      const sc = m.models[i]!.sidecar
      if (!sc || !existsSync(join(W, sc))) continue
      const s = JSON.parse(readFileSync(join(W, sc), 'utf8')) as { materials?: Array<{ texture?: string }> }
      for (const mat of s.materials ?? []) if (mat.texture) seen.add(mat.texture.replace(/\\/g, '/').toLowerCase())
    }
    for (const k of world) expect(seen.has(k), k).toBe(true)
  })

  const INDEX = join(ROOT, 'work/out/pbr/index.json')
  // The tiles are B3's sets now (encoded by TT-B, checked in b3-terrain.test.ts): the B2 run is the buildings.
  const encoded = existsSync(INDEX) && world.some(k => k in (JSON.parse(readFileSync(INDEX, 'utf8')) as PbrIndex).sets)
  it.skipIf(!encoded)('in work/out/pbr/index.json (after the batch ran): every building key has its set', () => {
    const idx = JSON.parse(readFileSync(INDEX, 'utf8')) as PbrIndex
    for (const k of world) {
      expect(idx.sets[k], k).toBeDefined()
      expect(Object.keys(idx.sets[k]!.tiers).length, k).toBeGreaterThan(0)
    }
  })
})

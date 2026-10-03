/**
 * H-12 adversarial hunt, lens "set-range" (docs/WAVE_PLAN8.md §6.7 item 9; TERRAIN_TEX §1.3, §5.2): walking out of town
 * at the unload radius, which hero tiles lose their maps (overflow above the set range), no black layer, no hitch
 * (array growth) when the reserved layers fill.
 *
 * The rig is tile-atlas.test.ts's (fake textures, recorded uploads). The walk cases replay the real export's regions
 * (work/out/world/jangan-fields manifest + work/out/pbr/index.json hero flags and cover) through the atlas with the
 * stream's load / unload hysteresis (stream.ts STREAM_DEFAULTS medium / high); they skip without work/out.
 *
 * FINDING (H12-SR-1): TileAtlas.takeLayer takes any allowed FREE layer before it considers evicting an unreferenced
 * tile, so a hero tile overflows into a free layer above the range (512 base, neutral maps, no 1024 tier on High) while
 * range layers still hold tiles nobody references (the town's, after its regions passed the unload radius). The layer
 * then never moves while referenced. On the real export 5-13 hero tiles per walk out of town lose their maps, 0-4 of
 * them needlessly (e.g. c_stone_jinfild_05/06, wc_grass02_01 with 1-20 stale range layers beside them).
 * Checked and green here: no walk grows the atlas (no growth hitch, so the growth path's decode-failure blank layer is
 * not reached).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BaseTexture } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { planSetRange, TileAtlas, type TileAtlasSetup, type TilePlane, type TileSetInfo, type TileSetRange } from '../src/tile-atlas.ts'
import { STREAM_DEFAULTS } from '../src/index.ts'

let serial = 0
function fakeTexture(): BaseTexture {
  const t = { id: ++serial, disposed: false, dispose() { t.disposed = true } }
  return t as unknown as BaseTexture
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0))
}

const levels = (size: number) => {
  const out: Uint8Array[] = []
  for (let s = size >> 1; s >= 1; s >>= 1) out.push(new Uint8Array(s * s * 4))
  return out
}

function rig(opts: { layers: number; range: TileSetRange; sets: (id: number) => boolean; growBy?: number; decode?: (id: number) => Promise<Uint8Array> }) {
  const created: Array<{ plane: TilePlane; size: number; layers: number }> = []
  const uploads: Array<{ plane: TilePlane; layer: number; first: number; alpha: number }> = []
  const setup: TileAtlasSetup = {
    maps: { ormh: { size: 2, decode: async () => null } },
    tier: null,
    sets: opts.range,
    upgrade: {
      has: opts.sets,
      decode: async (id, _plane, size) => ({ data: new Uint8Array(size * size * 4).fill(150 + (id % 100)), levels: levels(size) }),
    },
  }
  const a = new TileAtlas({
    scene: null as never,
    size: 4,
    layers: opts.layers,
    growBy: opts.growBy ?? 16,
    decode: opts.decode ?? (async id => new Uint8Array(4 * 4 * 4).fill(1 + (id % 100))),
    prepare: async () => setup,
    create: (size, layers, plane = 'albedo') => {
      created.push({ plane, size, layers })
      return fakeTexture()
    },
    upload: (_tex, layer, rgba, _size, plane = 'albedo') => {
      uploads.push({ plane, layer, first: rgba[0]!, alpha: rgba[3]! })
      return true
    },
    rebuild: () => fakeTexture(),
  })
  return { a, created, uploads }
}

describe('set range overflow: a hero tile and a stale range layer', () => {
  it('a hero tile evicts an unreferenced tile from the range before it overflows into a free layer above it', async () => {
    // A 2-layer range in a 6-layer atlas. Town: hero tiles 1, 2 fill the range; the player walks off, the town regions
    // unload (refs 0). Field: hero tile 3 arrives. The range holds two dead tiles, yet tile 3 takes a free layer above
    // the range, so it draws with neutral maps (no ORMH, no tier) for as long as a region references it.
    const range = planSetRange(new Map<number, TileSetInfo>([[1, { maps: true, cover: null }], [2, { maps: true, cover: null }], [3, { maps: true, cover: null }]]), 2, 0)
    const { a } = rig({ layers: 6, range, sets: id => id <= 3 })
    await a.acquire([1, 2], () => 0)
    await settle()
    expect([a.layerOf(1), a.layerOf(2)].sort()).toEqual([0, 1])
    a.release([1, 2])
    await a.acquire([3], () => 0)
    await settle()
    expect(a.layerOf(3)!).toBeLessThan(a.setLayers)
  })
})

// ---- the real walk ------------------------------------------------------------------------------------------------

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const MANIFEST = join(REPO, 'work/out/world/jangan-fields/manifest.json')
const INDEX = join(REPO, 'work/out/pbr/index.json')
const hasExport = existsSync(MANIFEST) && existsSync(INDEX)

interface Region { x: number; z: number; ids: number[] }

function loadExport() {
  const man = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { regions: Array<{ x: number; z: number; terrain: { tileIds: number[] } }>; tiles: Array<{ id: number; file: string }> }
  const idx = JSON.parse(readFileSync(INDEX, 'utf8')) as { sets: Record<string, { hero?: boolean; cover?: number }> }
  const regions: Region[] = man.regions.map(r => ({ x: r.x, z: r.z, ids: r.terrain.tileIds }))
  const info = new Map<number, TileSetInfo>()
  for (const t of man.tiles) {
    const stem = (t.file.split('/').pop() ?? '').replace(/\.[^.]*$/, '').toLowerCase()
    const s = idx.sets[`tile2d:${stem}`]
    if (s) info.set(t.id, { maps: !!s.hero, cover: typeof s.cover === 'number' ? s.cover : null })
  }
  return { regions, info }
}

const distTo = (r: Region, px: number, pz: number) => {
  const dx = Math.max(r.x * 192 - px, 0, px - (r.x * 192 + 192))
  const dz = Math.max(r.z * 192 - pz, 0, pz - (r.z * 192 + 192))
  return Math.hypot(dx, dz)
}

/** Replays a straight walk from the town centre to (tx, tz) with the stream's hysteresis; reports the overflow. */
async function walk(preset: 'medium' | 'high', to: Region) {
  const { regions, info } = loadExport()
  const s = STREAM_DEFAULTS[preset]
  const range = planSetRange(info)
  const { a, created, uploads } = rig({ layers: s.tileLayers, range, sets: id => info.has(id) })
  await a.acquire([], () => 0)
  await settle()
  const loaded = new Set<Region>()
  const fx = 168 * 192 + 96, fz = 97 * 192 + 96
  const tx = to.x * 192 + 96, tz = to.z * 192 + 96
  const steps = Math.ceil(Math.hypot(tx - fx, tz - fz) / 16)
  let needless = 0
  let worst = ''
  const heroOverflow = new Set<number>()
  const entries = (a as unknown as { entries: Map<number, { layer: number; refs: number; state: string }> }).entries
  const open = a.setLayers - a.reservedLayers
  const important = (id: number) => a.reservedLayers > 0 && !!range.important?.(id)
  for (let i = 0; i <= steps; i++) {
    const px = fx + ((tx - fx) * i) / steps, pz = fz + ((tz - fz) * i) / steps
    for (const r of regions) {
      const d = distTo(r, px, pz)
      if (loaded.has(r) && d > s.unloadRadiusM) {
        loaded.delete(r)
        a.release(r.ids)
      } else if (!loaded.has(r) && d <= s.loadRadiusM) {
        loaded.add(r)
        const fresh = r.ids.filter(id => !entries.has(id))
        void a.acquire(r.ids, () => d)
        // The range layers this tile could have had by evicting a tile nobody references (TileAtlas.takeLayer's rules).
        // F-12: counted after the acquire, so a stale layer another fresh tile of the same region took is not counted
        // twice (the hunter's count before the acquire flagged the second of two fresh hero tiles that shared one).
        const stale = [...entries.values()].filter(e => e.refs === 0 && e.state === 'ready' && e.layer < a.setLayers)
        for (const id of fresh) {
          const e = entries.get(id)
          if (!e || !info.get(id)?.maps || e.layer < a.setLayers) continue
          heroOverflow.add(id)
          const could = stale.filter(t => t.layer < open || important(id))
          if (could.length) {
            needless++
            if (!worst) worst = `step ${i}: hero tile ${id} placed at layer ${e.layer} (range ${a.setLayers}) while ${could.length} range layers held unreferenced tiles`
          }
        }
      }
    }
    await settle(4)
  }
  // Never a layer committed blank: every albedo upload carries a non-zero tile (the magenta or the tile itself).
  const blank = uploads.filter(u => u.plane === 'albedo' && u.first === 0).length
  return { needless, worst, heroOverflow: heroOverflow.size, grew: a.capacity - s.tileLayers, created, blank, a }
}

describe.skipIf(!hasExport)('set range overflow: walking out of town on the real export (work/out)', () => {
  const far = (): Region[] => {
    const { regions } = loadExport()
    const by = (f: (r: Region) => number) => regions.reduce((m, r) => (f(r) > f(m) ? r : m))
    return [...new Set([by(r => r.x), by(r => -r.x), by(r => r.z), by(r => -r.z), by(r => r.x + r.z), by(r => r.x - r.z)])]
  }
  for (const preset of ['medium', 'high'] as const) {
    it(`${preset}: no referenced hero tile overflows while the range still holds an unreferenced tile`, async () => {
      const bad: string[] = []
      for (const to of far()) {
        const r = await walk(preset, to)
        console.log(`[set-range] ${preset} town -> (${to.x}, ${to.z}): hero tiles overflowed ${r.heroOverflow}, needlessly ${r.needless}, grew ${r.grew}; ${r.worst}`)
        if (r.worst) bad.push(`town -> (${to.x}, ${to.z}): ${r.needless} needless; first ${r.worst}`)
      }
      expect(bad).toEqual([])
    }, 240_000)
    it(`${preset}: the atlas never grows on a walk out of town (growth re-uploads every layer: a hitch)`, async () => {
      for (const to of far()) {
        const r = await walk(preset, to)
        expect(r.grew, `town -> (${to.x}, ${to.z})`).toBe(0)
      }
    }, 120_000)
  }
})

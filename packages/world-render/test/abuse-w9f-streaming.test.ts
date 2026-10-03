/**
 * W9F adversarial hunt, lens "streaming" (docs/WAVE_PLAN3.md §4.1 commit steps; WEATHER §6.2 wet maps; SKY §7.3 night
 * splats; TEXPIPE §6.4 progressive swap). Each `it` states a property that should hold and fails today:
 *
 *  1. Wet maps at region borders: two neighbours disagree on the puddle potential of the vertices they share, because
 *     each region's 5 × 5 basin window is clamped to its own bin (buildWetMap has no neighbour heights). Synthetic slope
 *     and the real jangan-fields export (skipped without work/out-opt).
 *  2. The terrain night splat at a region border: the two sides sample different texels (lp / 1920 clamps half a texel
 *     inside each region), so a lamp near a border draws a step in its light along the border line.
 *  3. The progressive swap survives a live path switch: after PBR → Classic (the preview turned off, or High → Low in a
 *     session) the Classic terrain samples the atlas layers the swap overwrote with the remastered albedo, and tiles
 *     streamed in on Classic are still upgraded. The Low guard (retail look) holds only for a world that started on
 *     Classic.
 */
import { NullEngine, Scene, type BaseTexture } from '@babylonjs/core'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { GRID, decodeTerrainBin } from '../../convert/src/world/format.ts'
import type { WorldManifest } from '../../convert/src/world/manifest.ts'
import { Assets, RegionStreamer, STREAM_DEFAULTS, TERRAIN_SURFACE, World, WorldRegions, loadNavStreamed } from '../src/index.ts'
import { NIGHT_LIGHT_KINDS, bakeSplat, type NightLight } from '../src/night-lights.ts'
import { buildWetMap, surfaceLookup } from '../src/weather/wetmap.ts'
import { BASE_URL, fakeModels, makeFixture, settle } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const n = GRID

// ---- 1. wet maps at region borders --------------------------------------------------------------------------------

/** A region cut from a global height field: global vertex (bx + gx, bz + gz). Normals from global central differences. */
function slice(h: (gx: number, gz: number) => number, bx: number, bz: number) {
  const heights = new Float32Array(n * n)
  const normals = new Int8Array(n * n * 4)
  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      const X = bx + gx, Z = bz + gz
      heights[gz * n + gx] = h(X, Z)
      const dx = (h(X + 1, Z) - h(X - 1, Z)) / 4
      const dz = -(h(X, Z + 1) - h(X, Z - 1)) / 4
      const l = Math.hypot(dx, 1, dz)
      normals.set([Math.round((-dx / l) * 127), Math.round((1 / l) * 127), Math.round((-dz / l) * 127), 0], (gz * n + gx) * 4)
    }
  }
  return { heights, normals, textures: new Uint16Array(n * n).fill(1) }
}

const dirt = () => TERRAIN_SURFACE.dirt
const R = (map: Uint8Array, gx: number, gz: number) => map[(gz * n + gx) * 4]! / 255

describe('wet maps at region borders (WEATHER §6.2)', () => {
  it('a gentle planar slope: both regions give the shared border vertices the same puddle potential as the interior', () => {
    // 0.1 m per 2 m vertex rising east (a 5 % grade: flat enough for puddles, no basin anywhere on a plane).
    const slope = (X: number) => 5 + 0.1 * X
    const west = buildWetMap(slice(X => slope(X), 0, 0), dirt)
    const east = buildWetMap(slice(X => slope(X), 96, 0), dirt)
    const interior = R(west, 48, 48)
    // The shared column: west gx 96 = east gx 0 (bit-identical heights and normals).
    const w = R(west, 96, 48), e = R(east, 0, 48)
    expect({ west: w, east: e }).toEqual({ west: interior, east: interior })
  })

  const REPO = fileURLToPath(new URL('../../../', import.meta.url))
  const FIELDS = join(REPO, 'work', 'out-opt', 'world', 'jangan-fields')
  it.skipIf(!existsSync(join(FIELDS, 'manifest.json')))('jangan-fields: neighbours agree on their shared border vertices (heights are identical there)', () => {
    const m = JSON.parse(readFileSync(join(FIELDS, 'manifest.json'), 'utf8')) as WorldManifest
    const surfaceOf = surfaceLookup(m.tiles as { id: number; typeName?: string | null; file?: string; source?: string }[])
    const maps = new Map<number, { map: Uint8Array; heights: Float32Array }>()
    for (const r of m.regions) {
      const t = decodeTerrainBin(new Uint8Array(readFileSync(join(FIELDS, r.terrain.file))))
      maps.set((r.z << 8) | r.x, { map: buildWetMap(t, surfaceOf), heights: t.heights })
    }
    let shared = 0, sameHeight = 0, off = 0, worst = 0
    for (const r of m.regions) {
      const a = maps.get((r.z << 8) | r.x)!
      for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
        const b = maps.get(((r.z + dz) << 8) | (r.x + dx))
        if (!b) continue
        for (let k = 0; k < n; k++) {
          const ia = dx ? k * n + (n - 1) : (n - 1) * n + k
          const ib = dx ? k * n : k
          shared++
          if (a.heights[ia] === b.heights[ib]) sameHeight++
          const d = Math.abs(a.map[ia * 4]! - b.map[ib * 4]!) / 255
          if (d >= 0.1) off++
          worst = Math.max(worst, d)
        }
      }
    }
    expect(sameHeight).toBe(shared)
    // Today: ~18 % of the shared vertices differ by ≥ 0.1 (worst ~0.7): a straight puddle line on every region border.
    expect({ off, worst: Math.round(worst * 100) / 100 }).toEqual({ off: 0, worst: 0 })
  })
})

// ---- 2. night splat at a region border ----------------------------------------------------------------------------

/** What the chunk reads at region-local file position lp (0..1920): bilinear, clamp-to-edge, `lp / 1920` (night-chunks.ts). */
function sampleSplat(splat: Uint8Array, lpE: number, lpN: number): number {
  const S = 192
  const u = (lpE / 1920) * S - 0.5, v = (lpN / 1920) * S - 0.5
  const cl = (i: number) => Math.min(S - 1, Math.max(0, i))
  const i0 = Math.floor(u), j0 = Math.floor(v)
  const fu = u - i0, fv = v - j0
  const t = (i: number, j: number) => splat[(cl(j) * S + cl(i)) * 4]!
  return ((t(i0, j0) * (1 - fu) + t(i0 + 1, j0) * fu) * (1 - fv) + (t(i0, j0 + 1) * (1 - fu) + t(i0 + 1, j0 + 1) * fu) * fv) / 255
}

describe('night splat at a region border (SKY §7.3.1)', () => {
  it('a lamp 1 m inside the west region lights the border line the same from both sides', () => {
    const flat = new Float32Array(n * n)
    // West region origin x 0, east region origin x 192; both span z 0 .. −192 (glTF), row j = the j-th metre north.
    const lamp: NightLight = { x: 191, y: 3, z: -96, kind: NIGHT_LIGHT_KINDS[0]!, owner: 1, seed: 0, fromNight: true }
    const west = new Uint8Array(192 * 192 * 4)
    const east = new Uint8Array(192 * 192 * 4)
    bakeSplat(west, { origin: [0, 0, 0], heights: flat }, [lamp])
    bakeSplat(east, { origin: [192, 0, 0], heights: flat }, [lamp])
    // The border x = 192 at 96 m north: west lp.x = 1920 (its east edge), east lp.x = 0 (its west edge).
    const fromWest = sampleSplat(west, 1920, 960)
    const fromEast = sampleSplat(east, 0, 960)
    // Today: they differ by ~0.08 of the splat range (× albedo × nlNight 2 at night): a hard step along the border.
    expect(Math.abs(fromWest - fromEast)).toBeLessThan(0.02)
  })
})

// ---- 3. the progressive swap and a live path switch -----------------------------------------------------------------

const RETAIL = 128
const REMASTER = 200

describe('terrain atlas swap across a live PBR → Classic switch (the Low guard)', () => {
  it('after switching a streamed PBR world to Classic, the Classic terrain samples retail tiles again', async () => {
    const { world, stream, albedo, run } = await pbrRig('pbr')
    await run(() => stream.atlas.upgrades > 0)
    expect(world.render.mode).toBe('pbr')
    const layer = stream.atlas.layerOf(10)!
    expect(layer).toBeDefined()
    // On PBR the swap is intended: the base array's layer holds the remastered albedo (Medium's retail-size remaster).
    expect(albedo.get(layer)).toBe(REMASTER)

    world.setRenderMode('classic')
    await run(() => true)
    expect(world.terrain.regionCount).toBe(21)
    const classicLayer = stream.atlas.layerOf(10)!
    const mat = world.terrain.materials.find(m => m.name.startsWith('terrain_'))!
    expect((mat as unknown as { _textures: Record<string, unknown> })._textures.tiles).toBe(stream.atlas.texture)
    // The Classic terrain must look like the pre-wave game: tile 10's layer holds the retail tile.
    expect(albedo.get(classicLayer)).toBe(RETAIL)
  })

  it('a world that started on Classic and switches to PBR live gets the terrain texture sets too', async () => {
    const { world, stream, albedo, run } = await pbrRig('classic')
    await run(() => true)
    expect(world.render.mode).toBe('classic')
    world.setRenderMode('pbr')
    await run(() => stream.atlas.upgrades > 0, 300)
    expect(world.terrain.pbrMaterials.length).toBe(21)
    // The preview is opt-in: a player turning it on in Options sees the PBR terrain with no texture set at all
    // (the TileAtlas `prepare` ran only if the streamer was built on PBR) until the next world entry.
    expect({ setLayers: stream.atlas.setLayers, upgrades: stream.atlas.upgrades, tile10: albedo.get(stream.atlas.layerOf(10)!) })
      .toEqual({ setLayers: 1, upgrades: 2, tile10: REMASTER })
  })

  it('a WebGL context restore re-streams a PBR world on a fresh atlas and swaps the sets in again (W9F X1)', async () => {
    const { world, stream, run } = await pbrRig('pbr')
    await run(() => stream.atlas.upgrades > 0)
    const lost = stream.atlas
    world.scene.getEngine().onContextRestoredObservable.notifyObservers(world.scene.getEngine())
    expect(stream.atlas).not.toBe(lost)
    // The rig's upload probe lives on the old atlas' options; the new atlas copies them.
    await run(() => stream.atlas.upgrades > 0, 300)
    expect({ ready: stream.stats.ready, setLayers: stream.atlas.setLayers, upgrades: stream.atlas.upgrades }).toEqual({ ready: 21, setLayers: 1, upgrades: 2 })
  })
})

/** The same rig as above, starting on `mode`. */
async function pbrRig(mode: 'pbr' | 'classic') {
  const fx = makeFixture()
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const assets = new Assets(BASE_URL, fx.io)
  const nav = await loadNavStreamed(fx.manifest, assets)
  const world = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, {
    baseUrl: BASE_URL, minimap: false, render: mode,
  })
  await world.water.init(assets)
  cleanups.push(() => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  })
  const pbr = world.materials.pbr
  // TT-R: a hero set (maps under the policy), so it takes the set range (a set without maps would sit above it).
  const setFor10 = {
    key: 'tile2d:10', cover: null, normal: null,
    albedo: (size: number) => ({ kind: 'image', url: 'mem://t10.png', size, levels: true }),
    ormh: (size: number) => ({ kind: 'ormh', defaults: { roughness: 0.9, metallic: 0 }, size, levels: true }),
  }
  ;(pbr as unknown as { maps: () => Promise<unknown> }).maps = async () => ({ tile: (stem: string) => (stem === '10' ? setFor10 : null) })
  ;(pbr as unknown as { policy: () => unknown }).policy = () => ({ tier: 1024 })
  ;(pbr.cache.source as { decode?: (job: { size?: number }) => Promise<unknown> }).decode = async job => {
    const s = job.size ?? 4
    return { width: s, height: s, levels: [{ width: s, height: s, data: new Uint8Array(s * s * 4).fill(REMASTER) }] }
  }
  const models = fakeModels(scene)
  const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium }, {
    now: () => 0, autoPump: false, objects: true, nav: nav.chunks, loadModel: models.loadModel, disposeModel: models.disposeModel,
  })
  world.stream = stream
  stream.booting = false
  const albedo = new Map<number, number>()
  const opts = (stream.atlas as unknown as { opts: { upload?: (tex: BaseTexture, layer: number, rgba: Uint8Array, size: number, plane?: string) => boolean } }).opts
  opts.upload = (_tex, layer, rgba, _size, plane = 'albedo') => {
    if (plane === 'albedo') albedo.set(layer, rgba[0]!)
    return true
  }
  const focus = { x: 96, z: -96 }
  const run = async (done: () => boolean, frames = 600) => {
    for (let i = 0; i < frames; i++) {
      stream.update(focus, null)
      await settle(2)
      if (stream.stats.ready === 21 && stream.stats.objectsReady === 21 && !stream.stats.jobs && done()) return
    }
  }
  return { world, stream, albedo, run }
}


/**
 * TL-B (docs/TOWN_LIFE.md §7.4, §7.5; docs/WAVE_PLAN7.md D5): the town's decals and its pond (src/town/decals.ts).
 *
 * - `town-decals.json` read tolerantly, at most DECALS_PER_REGION a region;
 * - the quads: 4 corners per decal on its ground + LIFT_M, turned by +yaw about +Y, inside its atlas cell;
 * - the atlas: white (unchanged under the multiply) at the cells' edges, the blotch darker; the puddle cell fades;
 * - TownDecals on NullEngine: one mesh for dirt and moss (one draw), the puddles apart and hidden while dry, both
 *   tagged 'town', not pickable, multiply-blended, one sampler; dispose leaves nothing;
 * - the pond: `applyTownPond` gives the regions the 'town' profile and clears both on null;
 * - `attachTownDressing`: loads the dressing named by manifest.town and its decals, follows the weather's puddles,
 *   clears the pond on dispose; a world without the dressing gets nothing.
 */
import { Constants, NullEngine, Scene } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DECALS_PER_REGION, DECAL_ATLAS_SIZE, LIFT_M, TOWN_DECALS_FILE, TOWN_DECALS_FORMAT, TownDecals, applyTownPond, attachTownDressing,
  decalAtlas, decalQuads, readTownDecals, type TownDecalRow, type TownPondTarget,
} from '../src/town/decals.ts'
import { isTownMesh, type TownHost } from '../src/town/types.ts'

const scenes: Scene[] = []
afterEach(() => {
  for (const s of scenes.splice(0)) {
    const e = s.getEngine()
    s.dispose()
    e.dispose()
  }
})
const scene = () => {
  const s = new Scene(new NullEngine())
  scenes.push(s)
  return s
}

const row = (over: Partial<TownDecalRow> = {}): TownDecalRow => ({ kind: 'dirt', x: 10, y: -3.3, z: -20, yaw: 0, size: [2, 4], region: 25000, ...over })

describe('town-decals.json', () => {
  it('reads valid rows, drops bad ones, keeps at most DECALS_PER_REGION a region', () => {
    const ok = { kind: 'moss', x: 1, y: 2, z: 3, yaw: 0.5, size: [1, 2], region: 7 }
    const json = {
      format: TOWN_DECALS_FORMAT, version: 1,
      decals: [ok, { ...ok, kind: 'soot' }, { ...ok, size: [0, 1] }, { ...ok, x: 'a' }, ...Array.from({ length: DECALS_PER_REGION + 5 }, () => ({ ...ok, region: 8 }))],
    }
    const rows = readTownDecals(json)
    expect(rows[0]).toEqual(ok)
    expect(rows.filter(r => r.region === 8)).toHaveLength(DECALS_PER_REGION)
    expect(rows).toHaveLength(1 + DECALS_PER_REGION)
    expect(readTownDecals({ format: 'other', decals: [ok] })).toEqual([])
    expect(readTownDecals(null)).toEqual([])
  })

  it('quads: four corners on the ground + LIFT_M, turned by +yaw about +Y, inside the cell', () => {
    const q = decalQuads([row({ yaw: Math.PI / 2, size: [2, 4] }), row({ kind: 'moss', x: 0, z: 0 })])
    expect(q.positions).toHaveLength(24)
    expect(q.indices).toHaveLength(12)
    for (let i = 1; i < 24; i += 3) expect(q.positions[i]).toBeCloseTo(i < 12 ? -3.3 + LIFT_M : -3.3 + LIFT_M)
    // decal 0: local (−1, −2) at yaw π/2 → x' = x cos + z sin = −2, z' = −x sin + z cos = 1
    expect(q.positions[0]).toBeCloseTo(10 - 2)
    expect(q.positions[2]).toBeCloseTo(-20 + 1)
    // the dirt cell is u, v in [0, 0.5], the moss cell u in [0.5, 1]
    for (let k = 0; k < 8; k += 2) {
      expect(q.uvs[k]).toBeGreaterThanOrEqual(0)
      expect(q.uvs[k]).toBeLessThanOrEqual(0.5)
      expect(q.uvs[8 + k]).toBeGreaterThanOrEqual(0.5)
    }
    for (let k = 1; k < 24; k += 3) expect(q.normals[k]).toBe(1)
  })

  it('atlas: white at the cell edges, darker inside; the puddle cell fades with the level', () => {
    const a = decalAtlas(1)
    expect(a).toHaveLength(DECAL_ATLAS_SIZE * DECAL_ATLAS_SIZE * 4)
    const px = (x: number, y: number, img = a) => Array.from(img.subarray((y * DECAL_ATLAS_SIZE + x) * 4, (y * DECAL_ATLAS_SIZE + x) * 4 + 4))
    const half = DECAL_ATLAS_SIZE / 2
    expect(px(0, 0)).toEqual([255, 255, 255, 255])
    expect(px(half / 2, half / 2).slice(0, 3).every(v => v < 230)).toBe(true)
    expect(px(half / 2, half + half / 2).slice(0, 3).every(v => v < 230)).toBe(true)
    const dry = decalAtlas(0)
    expect(px(half / 2, half + half / 2, dry)).toEqual([255, 255, 255, 255])
    expect(px(half / 2, half / 2, dry)).toEqual(px(half / 2, half / 2))
  })
})

describe('TownDecals', () => {
  it('one mesh for dirt and moss, the puddles apart and hidden while dry; town-tagged, unpickable, multiply-blended', () => {
    const s = scene()
    const d = new TownDecals(s, [row(), row({ kind: 'moss', x: 20 }), row({ kind: 'puddle', x: 30 })])
    expect(d.ground!.getTotalIndices()).toBe(12)
    expect(d.wet!.getTotalIndices()).toBe(6)
    expect(d.meshes()).toHaveLength(2)
    for (const m of d.meshes()) {
      expect(isTownMesh(m)).toBe(true)
      expect(m.isPickable).toBe(false)
      expect(m.receiveShadows).toBe(false)
      expect(m.material!.alphaMode).toBe(Constants.ALPHA_MULTIPLY)
      expect(m.material!.needAlphaBlending()).toBe(true)
      expect(m.material!.getActiveTextures()).toHaveLength(1)
      // unlit: the emissive white carries the texture (Babylon's diffuse term is 0 with lighting off)
      expect((m.material as unknown as { emissiveColor: { r: number; g: number; b: number } }).emissiveColor).toMatchObject({ r: 1, g: 1, b: 1 })
    }
    expect(d.wet!.isVisible).toBe(false)
    expect(d.count).toBe(2)
    d.setPuddles(0.5)
    expect(d.wet!.isVisible).toBe(true)
    expect(d.count).toBe(3)
    d.setPuddles(0)
    expect(d.wet!.isVisible).toBe(false)
    const before = { meshes: s.meshes.length, mats: s.materials.length, tex: s.textures.length }
    expect(before.meshes).toBe(2)
    d.dispose()
    expect(s.meshes).toHaveLength(0)
    expect(s.materials).toHaveLength(0)
    expect(s.textures).toHaveLength(0)
  })

  it('no puddles: no wet mesh, no wet atlas', () => {
    const s = scene()
    const d = new TownDecals(s, [row()])
    expect(d.wet).toBeNull()
    expect(s.textures).toHaveLength(1)
    d.setPuddles(1)
    d.dispose()
  })
})

class FakeWater implements TownPondTarget {
  profile: unknown = null
  lookup: ((id: number) => string | null) | null = null
  setProfile(_id: 'town', p: unknown) {
    this.profile = p
  }
  setProfileLookup(fn: ((id: number) => 'town' | null) | null) {
    this.lookup = fn
  }
}

describe('the pond and the dressing layer', () => {
  it('applyTownPond: the regions take the town profile; null clears both', () => {
    const w = new FakeWater()
    applyTownPond(w, { regions: [25257, 24999], color: [0.04, 0.06, 0.02], turbidity: 0.6, reflection: 0.9 })
    expect(w.profile).toEqual({ color: [0.04, 0.06, 0.02], turbidity: 0.6, reflection: 0.9 })
    expect(w.lookup!(25257)).toBe('town')
    expect(w.lookup!(25000)).toBeNull()
    applyTownPond(w, null)
    expect(w.profile).toBeNull()
    expect(w.lookup).toBeNull()
  })

  const host = (files: Record<string, unknown>, dressing: string | null = 'town-dressing.json') => {
    const s = scene()
    const water = new FakeWater()
    const wxA = { y: 0 }
    const world = {
      manifest: { town: dressing ? { file: null, dressing } : undefined },
      assets: { json: async (rel: string) => { if (!(rel in files)) throw new Error(`404 ${rel}`); return files[rel] } },
      water,
      weather: { u: { wxA } },
    }
    return { h: { scene: s, world } as unknown as TownHost, s, water, wxA }
  }

  it('attachTownDressing: the pond and the decals of manifest.town; the puddles follow the weather; dispose clears', async () => {
    const decals = { format: TOWN_DECALS_FORMAT, version: 1, decals: [row(), row({ kind: 'puddle', x: 30 })] }
    const dressing = { schema: 1, kind: 'townDressing', world: 'w', town: 'jangan', props: [], banners: [], lamps: [], decals: [{ kind: 'dirt', x: 10, z: -20, yaw: 0, size: [2, 4] }], crackBands: [], pond: { regions: [25257], color: [0.04, 0.06, 0.02], turbidity: 0.6 } }
    const { h, s, water, wxA } = host({ 'town-dressing.json': dressing, [TOWN_DECALS_FILE]: decals })
    const layer = attachTownDressing(h)
    await layer.ready
    expect(water.lookup!(25257)).toBe('town')
    expect(layer.meshes()).toHaveLength(2)
    expect(layer.stats()).toEqual({ decals: 1, decalDraws: 1, pond: 1 })
    wxA.y = 0.8
    layer.update()
    expect(layer.stats()).toEqual({ decals: 2, decalDraws: 2, pond: 1 })
    layer.dispose()
    expect(water.lookup).toBeNull()
    expect(water.profile).toBeNull()
    expect(s.meshes).toHaveLength(0)
  })

  it('a world without the dressing (or a dressing without decals) gets no mesh; a late dispose is safe', async () => {
    const none = host({}, null)
    const a = attachTownDressing(none.h)
    await a.ready
    expect(a.meshes()).toEqual([])
    expect(none.water.lookup).toBeNull()
    a.dispose()
    const bare = host({ 'town-dressing.json': { kind: 'townDressing', decals: [] } })
    const b = attachTownDressing(bare.h)
    b.dispose()
    await b.ready
    expect(b.meshes()).toEqual([])
    expect(bare.s.meshes).toHaveLength(0)
  })
})

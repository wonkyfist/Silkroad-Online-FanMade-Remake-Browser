/**
 * WE-D (docs/WAVE_PLAN8.md §6.2, D18; docs/WORLD_EDITOR.md §4.6, §6.2 step 2, F8, D51): the lightmap re-bake with
 * object shadows. A moved fixture tree leaves no shadow texel at its old spot and casts one at the new spot; a planted
 * tree shades the ground; leaf cards are cut at alpha 0.5; a swapped tree casts its species' LOD1; a raised hill shades
 * unmoved ground beside it; texels outside the change stay bit for bit; two bakes give the same bytes.
 */
import { describe, expect, it } from 'vitest'
import { readShadowCaster, type ShadowCaster } from '../src/world/edits/glb.ts'
import {
  bakeEditedLightmap, casterOf, maskWeights, MASK_FEATHER_TEXELS, MASK_GROW_TEXELS, type CasterInstance, type CasterPart, type LightmapBakeInput,
} from '../src/world/edits/shadows.ts'
import { boxMesh, cardMesh, model, placement, writeGlb } from './world-edits-fixture.ts'

const W = 512
const TREE_GLB = writeGlb([{ mesh: boxMesh(-0.2, -1, -0.2, 0.2, 4, 0.2) }, { mesh: cardMesh(6, 2.5) }])
const decodeOpaque = () => ({ width: 2, height: 2, rgba: new Uint8Array(16).fill(255) })
const decodeClear = () => ({ width: 2, height: 2, rgba: new Uint8Array([255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0]) })

function loader(decode = decodeOpaque): (part: CasterPart) => ShadowCaster | null {
  const geo = readShadowCaster(TREE_GLB, { decodeImage: decode })
  return () => geo
}

const tree = (key: string, x: number, z: number, scale = 1): CasterInstance => ({
  key, parts: [{ model: 0, min: [-2.5, -1, -2.5], max: [2.5, 6, 2.5] }], position: [x, 10, z], yaw: 0.3, scale,
})

const flat = () => 10
const white = () => ({ width: W, height: W, rgba: new Uint8Array(W * W * 4).fill(255) })

function bake(over: Partial<LightmapBakeInput>) {
  return bakeEditedLightmap({
    rx: 168, rz: 97, origin: [0, 0, 0], image: white(), heightBefore: flat, heightAfter: flat, terrainChanged: false, maxHeightM: 40,
    gone: [], come: [], scene: [], load: loader(), ...over,
  })
}

/** The texel of a glTF point of region 168,97 (origin 0, 0, 0; row 0 = south). */
const texel = (x: number, z: number) => Math.round((-z / 192) * (W - 1)) * W + Math.round((x / 192) * (W - 1))
const at = (img: { rgba: Uint8Array }, x: number, z: number) => img.rgba[texel(x, z) * 4]!

/** The darkest texel within `r` m of a glTF point. */
function darkest(img: { rgba: Uint8Array }, x: number, z: number, r: number): number {
  let m = 255
  for (let dz = -r; dz <= r; dz += 0.25) for (let dx = -r; dx <= r; dx += 0.25) m = Math.min(m, at(img, x + dx, z + dz))
  return m
}

// the crown (6 m above the ground) falls 6 x 1.28 m from its tree, away from the light (west and a little south)
const SHADOW = (x: number, z: number): [number, number] => [x - 6 * 1.2416, z + 6 * 0.3095]

describe('the object-shadow bake', () => {
  it('a planted tree shades the ground; texels outside the mask stay bit for bit', () => {
    const r = bake({ come: [tree('a', 60, -60)], scene: [tree('a', 60, -60)] })!
    expect(r).not.toBeNull()
    expect(darkest(r.image, ...SHADOW(60, -60), 1)).toBeLessThanOrEqual(160)
    expect(at(r.image, 150, -150)).toBe(255)
    // the change stays local: well under 2 % of the texels
    expect(r.texels).toBeLessThan(W * W * 0.02)
    let changed = 0
    for (let k = 0; k < W * W; k++) if (r.image.rgba[k * 4] !== 255) changed++
    expect(changed).toBeGreaterThan(50)
    expect(changed).toBeLessThanOrEqual(r.texels)
  })

  it('a moved tree leaves no shadow texel at its old spot and casts one at the new spot', () => {
    const retail = bake({ come: [tree('a', 60, -60)], scene: [tree('a', 60, -60)] })!.image
    expect(darkest(retail, ...SHADOW(60, -60), 1)).toBeLessThanOrEqual(160)
    const moved = bake({ image: retail, gone: [tree('a', 60, -60)], come: [tree('a', 130, -130)], scene: [tree('a', 130, -130)] })!
    // nothing darker than lit anywhere around the old tree and its old shadow
    expect(darkest(moved.image, ...SHADOW(60, -60), 6)).toBe(255)
    expect(darkest(moved.image, 60, -60, 3)).toBe(255)
    expect(darkest(moved.image, ...SHADOW(130, -130), 1)).toBeLessThanOrEqual(160)
    // every texel far from both trees is the retail one
    for (const [x, z] of [[10, -10], [180, -20], [100, -180], [20, -170]] as const) expect(at(moved.image, x, z)).toBe(at(retail, x, z))
  })

  it('deleting a tree whose shadow other casters overlap keeps theirs', () => {
    const retail = bake({ come: [tree('a', 60, -60), tree('b', 62, -60)], scene: [tree('a', 60, -60), tree('b', 62, -60)] })!.image
    const r = bake({ image: retail, gone: [tree('a', 60, -60)], scene: [tree('b', 62, -60)] })!
    expect(darkest(r.image, ...SHADOW(62, -60), 0.5)).toBeLessThanOrEqual(160)
  })

  it('is deterministic (two bakes, same bytes) and does nothing without a change', () => {
    const a = bake({ gone: [tree('a', 60, -60)], come: [tree('a', 70, -90, 1.15)], scene: [tree('a', 70, -90, 1.15)] })!
    const b = bake({ gone: [tree('a', 60, -60)], come: [tree('a', 70, -90, 1.15)], scene: [tree('a', 70, -90, 1.15)] })!
    expect(Buffer.from(a.image.rgba).equals(Buffer.from(b.image.rgba))).toBe(true)
    expect(bake({ scene: [tree('a', 60, -60)] })).toBeNull()
  })

  it('cuts leaf cards at alpha 0.5: a clear crown casts nothing, the trunk still does', () => {
    const r = bake({ come: [tree('a', 60, -60)], scene: [tree('a', 60, -60)], load: loader(decodeClear) })!
    expect(darkest(r.image, ...SHADOW(60, -60), 1)).toBe(255)
    expect(darkest(r.image, 57, -59, 2.5)).toBeLessThan(255)
  })

  it('a raised hill shades unmoved ground beside it', () => {
    const hill = (ggx: number, ggz: number) => {
      const x = (ggx - 168 * 96) * 2
      const z = -(ggz - 97 * 96) * 2
      return 10 + Math.max(0, 20 - Math.hypot(x - 100, z + 100) * 4)
    }
    const r = bake({ heightAfter: hill, terrainChanged: true })!
    // 20 m high: its shadow reaches ~ 20 m west of the summit, where the ground did not move
    expect(at(r.image, 100 - 12, -100 + 2)).toBeLessThan(200)
    expect(at(r.image, 30, -30)).toBe(255)
  })

  it('the mask grows by MASK_GROW_TEXELS and fades over MASK_FEATHER_TEXELS', () => {
    const core = new Uint8Array(64 * 64)
    core[32 * 64 + 32] = 1
    const w = maskWeights(core, 64, 64)
    expect(w[32 * 64 + 32 + MASK_GROW_TEXELS]).toBe(1)
    expect(w[32 * 64 + 32 + MASK_GROW_TEXELS + 1]).toBeGreaterThan(0)
    expect(w[32 * 64 + 32 + MASK_GROW_TEXELS + 1]).toBeLessThan(1)
    expect(w[32 * 64 + 32 + MASK_GROW_TEXELS + MASK_FEATHER_TEXELS + 1]).toBe(0)
  })
})

describe('the casters', () => {
  it('reads node transforms, tiers and the alpha of masked parts from a glb', () => {
    const glb = writeGlb([
      { mesh: boxMesh(0, 0, 0, 1, 1, 1), translation: [5, 0, 0], tier: 1 },
      { mesh: boxMesh(0, 0, 0, 3, 3, 3), tier: 2 },
      { mesh: cardMesh(2, 1) },
    ])
    const all = readShadowCaster(glb, { tier: 2, decodeImage: decodeOpaque })
    expect(all.meshes).toHaveLength(1)
    expect(all.max).toEqual([3, 3, 3])
    const lod1 = readShadowCaster(glb, { decodeImage: decodeOpaque })
    expect(lod1.meshes).toHaveLength(1)
    expect([lod1.min, lod1.max]).toEqual([[5, 0, 0], [6, 1, 1]])
    const untiered = readShadowCaster(writeGlb([{ mesh: boxMesh(0, 0, 0, 1, 1, 1) }, { mesh: cardMesh(2, 1) }]), { decodeImage: decodeOpaque })
    expect(untiered.meshes).toHaveLength(2)
    expect(untiered.meshes[1]!.alpha!.cutoff).toBe(0.5)
    expect(untiered.meshes[0]!.alpha).toBeUndefined()
    expect(() => readShadowCaster(new Uint8Array(24))).toThrow(/magic/)
  })

  it('a swapped tree casts its species\' LOD1 with the fit and offset; a skinned model its static variant; dressing props none', () => {
    const models = [
      model(0, 'res\\nature\\tree\\tre_a.bsr', { treeSwap: { model: 3, fit: [1.1, 0.9, 1.1], tint: 0, offset: [0.5, 0, 0] } }),
      model(1, 'res\\nature\\tree\\tre_b.bsr', { kind: 'skinned', staticVariant: 2 }),
      model(2, 'res\\nature\\tree\\tre_b.bsr#static'),
      model(3, 'res\\nature\\common\\tree\\w12\\maple03.bsr#species', { boundsMin: [-4, 0, -4], boundsMax: [4, 11, 4] }),
    ]
    const swapped = casterOf(placement(1, 7, [0], models[0]!.source, [1, 2, 3]), models)!
    expect(swapped.parts).toEqual([{ model: 3, tier: 1, fit: [1.1, 0.9, 1.1], offset: [0.5, 0, 0], min: [-4, 0, -4], max: [4, 11, 4] }])
    expect(casterOf(placement(1, 8, [1], models[1]!.source, [1, 2, 3]), models)!.parts[0]!.model).toBe(2)
    expect(casterOf(placement(1, 1_000_004, [1], models[1]!.source, [1, 2, 3]), models)).toBeNull()
    // ground cover casts no baked shadow (the retail lightmaps carry none)
    expect(casterOf(placement(1, 9, [2], 'res\\nature\\common\\grass\\group_grs01.bsr', [1, 2, 3]), models)).toBeNull()
  })
})

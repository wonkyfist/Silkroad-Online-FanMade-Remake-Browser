// H-12 hunt, lens "trees look" (WAVE_PLAN8 §6.7 item 7): the tint and the sprite tiers. Each test is a finding: it
// fails on 95d49e2 and passes once the fix lands (F-12).
import { NullEngine, PBRMaterial, Scene, Texture } from '@babylonjs/core'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel } from '../../convert/src/world/manifest.ts'
import { PbrMapIndex, TEXTURE_SETTINGS, mapPolicy, parsePbrIndex, type PbrTextureCache } from '../src/pbr/maps.ts'
import { slotSources } from '../src/batch/table.ts'
import { TreeTints } from '../src/batch/trees.ts'
import type { MaterialBatchRecord } from '../src/materials.ts'

const ROOT = join(import.meta.dirname, '../../..')
const OUT = join(ROOT, 'work/out')
const WILLOW_FAR = join(OUT, 'world/jangan-fields/models/trees/willow03/far.json')

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

describe('H-12 trees look: the LOD0 overlay has no sprite of its own', () => {
  // TREES WF19: the sprites are embedded once per species, in far.glb; near.glb (the LOD0 overlay, near-field.ts)
  // "carries the keys only": its leaf and bark materials have no image (glTF images [] in every near.glb). The overlay's
  // table slot therefore gets its albedo only from TX-R swapping in the key's set. With Options -> Graphics ->
  // Textures: Retail (graphics.textures 'retail', a supported pin on Medium / High: textureTierFor -> 'retail',
  // PbrMapIndex.resolve returns null for every key) nothing ever arrives, and every new tree within 40 m (band 0)
  // draws as solid, opaque, untextured cards and trunks: white "paper" trees (repro: the look lab, view maple r 38,
  // Medium WebGPU, textures=retail; work/tmp/hunt-w12-look/shots/tex_retail_maple_wide.png). The same holds for the
  // first seconds of every load on 'auto', until TX-R's lowest-priority fetch lands (the species counts as ready when
  // its table slots are uploaded, not when its sprite is).
  const NEAR_DIR = join(OUT, 'world/jangan-fields/models/trees')
  const INDEX = join(OUT, 'pbr/index.json')
  it.skipIf(!existsSync(NEAR_DIR) || !existsSync(INDEX))('every species\' LOD0 has its sprites on every texture tier the Options offer', () => {
    const pbr = parsePbrIndex(JSON.parse(readFileSync(INDEX, 'utf8')), '/out/pbr/index.json')
    const index = new PbrMapIndex({ pbr })
    const missing: string[] = []
    for (const id of readdirSync(NEAR_DIR)) {
      const file = join(NEAR_DIR, id, 'near.glb')
      if (!existsSync(file)) continue
      const glb = readFileSync(file)
      const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as { images?: unknown[] }
      const embedded = (json.images ?? []).length > 0
      const side = JSON.parse(readFileSync(join(NEAR_DIR, id, 'near.json'), 'utf8')) as { materials: Array<{ name: string; texture?: string }> }
      // F-12 (TRL-1): near-field.ts gives a LOD0 material without an image of its own the species' far.glb sprite of
      // the same texture key (record.albedoFallback; slotSources reads it, checked below), whatever the tier
      const farSprites = farSpriteKeys(join(NEAR_DIR, id))
      for (const setting of TEXTURE_SETTINGS) {
        const policy = mapPolicy('medium', { textures: setting })
        for (const m of side.materials) {
          if (embedded || (m.texture && index.resolve({ texture: m.texture }, policy))) continue
          if (m.texture && farSprites.has(m.texture.toLowerCase())) continue
          missing.push(`${id} ${m.name} (textures ${setting})`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('a LOD0 record without an albedo of its own takes its far sprite in the table (slotSources)', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const near = new PBRMaterial('willow03_leaf', scene)
    const far = new PBRMaterial('willow03_leaf', scene)
    const sprite = new Texture(null, scene)
    ;(sprite as unknown as { getInternalTexture: () => unknown }).getInternalTexture = () => ({ _buffer: new Uint8Array([137, 80, 78, 71]) })
    far.albedoTexture = sprite
    const texture = 'prim/mtrl/nature/common/tree/tre_w12_willow03_leaf.ddj'
    const record = {
      material: near, path: 'pbr', model: 'static', name: 'willow03_leaf', texture, cls: 'foliage', unlit: false, alpha: 'mask',
      twoSided: false, lightmap: null, lampModel: false, emissive: false, maps: null,
    } as unknown as MaterialBatchRecord
    expect(slotSources(record).albedo.key.startsWith('solid|')).toBe(true)
    record.albedoFallback = () => far.albedoTexture
    expect(slotSources(record).albedo.key).toBe('tex|prim/mtrl/nature/common/tree/tre_w12_willow03_leaf.ddj')
  })
})

/** The texture keys (lower case, as far.json writes them) of a species' far.glb materials that embed an image. */
function farSpriteKeys(dir: string): Set<string> {
  const out = new Set<string>()
  if (!existsSync(join(dir, 'far.glb')) || !existsSync(join(dir, 'far.json'))) return out
  const glb = readFileSync(join(dir, 'far.glb'))
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as { materials?: Array<{ name?: string; pbrMetallicRoughness?: { baseColorTexture?: unknown } }>; images?: unknown[] }
  if (!(json.images ?? []).length) return out
  const named = new Set((json.materials ?? []).filter(m => m.pbrMetallicRoughness?.baseColorTexture).map(m => m.name))
  const side = JSON.parse(readFileSync(join(dir, 'far.json'), 'utf8')) as { materials: Array<{ name: string; texture?: string }> }
  for (const m of side.materials) if (m.texture && named.has(m.name)) out.add(m.texture.toLowerCase())
  return out
}

describe('H-12 trees look: the crown tints and the texture tier', () => {
  // TREES WF2 / §W4.1 rule 1: the species' sprites are the retail size on Medium and their 2x TX-R tier on High+
  // (`graphics.textures`). The tints (far.json trees.tints; 1,124 of the 4,886 swapped placements: weed_tall 348,
  // weed_mid 217, bigleaf 93, pine08 55, ginkgo 49, maple03 49, willow03 12, ...) are made by TreeTints.recordFor as a
  // view of the species' material whose albedo is the tint's embedded 1x PNG (`sroTint:<key>`). The table keys that
  // cell `tex|<tint key>` and never asks TX-R, and BT-A's refresh (`onMapsChanged`) only fires for the base record.
  // So on High a tinted tree keeps the 1x sprite while its untinted neighbour of the same species draws the 2x tier,
  // although texpipe encoded a 2x tier (tier2x) for every tint key (work/out/pbr/index.json tre_w12_*_<tint>).
  it.skipIf(!existsSync(WILLOW_FAR))('on High a tinted crown draws the tint key\'s 2x tier, as the untinted crown draws its own', async () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const dir = join(OUT, 'world/jangan-fields')
    const tints = new TreeTints({
      json: async <T>(rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8')) as T,
      bytesOf: async (rel: string) => new Uint8Array(readFileSync(join(dir, rel))),
    })
    const species = { index: 558, source: 'res\\nature\\common\\tree\\w12\\willow03.bsr#species', glb: 'models/trees/willow03/far.glb', sidecar: 'models/trees/willow03/far.json' } as WorldModel
    await tints.load(species)
    expect(tints.loaded).toBeGreaterThan(0)

    // The species' own leaf on High: TX-R swapped in the 2x tier of tre_w12_willow03_leaf (a map texture of the cache).
    const mat = new PBRMaterial('willow03_leaf', scene)
    const hi = new Texture(null, scene)
    mat.albedoTexture = hi
    const url = '/out-opt/pbr/prim/mtrl/nature/common/tree/tre_w12_willow03_leaf/albedo@512.webp'
    const cache = { keyOfTex: new Map([[hi, `m|s|i|${url}|cutout|0.5`]]) } as unknown as PbrTextureCache
    const base = {
      material: mat, path: 'pbr', model: 'static', name: 'willow03_leaf', texture: 'prim\\mtrl\\nature\\common\\tree\\tre_w12_willow03_leaf.ddj',
      cls: 'foliage', unlit: false, alpha: 'mask', twoSided: false, lightmap: null, lampModel: false, emissive: false, maps: null,
    } as unknown as MaterialBatchRecord
    const own = slotSources(base, { maps: cache })
    expect(own.albedo.key).toBe(`map|m|s|i|${url}|cutout|0.5`)

    // Tint 1 (willow02) of the same material: its key has a 2x tier in the index too.
    const tinted = tints.recordFor(species, base, 1)
    expect(tinted).not.toBe(base)
    expect(tinted.texture).toMatch(/tre_w12_willow03_leaf_willow02\.ddj$/)
    const index = JSON.parse(readFileSync(join(OUT, 'pbr/index.json'), 'utf8')) as { sets: Record<string, { tier2x?: string; tiers: Record<string, unknown> }> }
    const set = index.sets['prim/mtrl/nature/common/tree/tre_w12_willow03_leaf_willow02.ddj']!
    expect(set.tier2x).toBe('512')
    const src = slotSources(tinted, { maps: cache })
    // Today: `tex|prim\...\tre_w12_willow03_leaf_willow02.ddj` (the 256 x 256 1x PNG), whatever the tier.
    expect(src.albedo.key.startsWith('map|')).toBe(true)
  })
})

/**
 * DRAGON-INT (docs/REMASTER.md "World models"): a retail model with a `remasterVariant` (the converter's remaster step)
 * loads the variant on the PBR path through `RegionBatcher.modelFor`, on a streamed NullEngine world:
 * - Medium+ with batching loads the variant, never the retail glb, and merges it for the retail model's placements;
 * - Low (Classic) never loads the variant: the retail model draws as today (the Low guard);
 * - PBR without a batcher (Options → World batching off) draws the retail model, as BT-T's static tree variants do;
 * - `remasterVariantOf` only takes a converted static `#remaster` twin;
 * - on the served remaster manifest (skipped without it): the plaza dragon's gold set resolves for the variant's glb
 *   and image on every PBR tier (@1024 below Ultra), never for the retail statue's glb, and not on the 'retail' tier.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AssetContainer, Mesh, MeshBuilder, NullEngine, PBRMaterial, Scene, TransformNode, type BaseTexture } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel } from '../../convert/src/world/manifest.ts'
import {
  Assets,
  RegionStreamer,
  STREAM_DEFAULTS,
  World,
  WorldRegions,
  loadNavStreamed,
  prepareStatic,
  type CachedModel,
  type RenderPath,
  type SidecarLite,
} from '../src/index.ts'
import { PbrMapIndex, parseRemasterManifest, policyForTier, type TextureTier } from '../src/pbr/maps.ts'
import { RegionBatchPart } from '../src/batch/region-batch.ts'
import { REMASTER_SOURCE_SUFFIX, remasterVariantOf } from '../src/batch/remaster.ts'
import { BASE_URL, CX, CZ, makeFixture, settle, type Fixture } from './stream-fixture.ts'
import { addModel, centre } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const PLAZA = 'res\\bldg\\china\\jangan01\\cj_jang_gate.bsr'

function boxContainer(scene: Scene, model: WorldModel): { container: AssetContainer; sidecar: SidecarLite } {
  const container = new AssetContainer(scene)
  const root = new TransformNode(`${model.glb}#root`, scene)
  scene.removeTransformNode(root)
  container.transformNodes.push(root)
  container.rootNodes.push(root)
  const mesh = MeshBuilder.CreateBox(`${model.index}:stone`, { size: 1 }, scene) as Mesh
  scene.removeMesh(mesh)
  mesh.parent = root
  const mat = new PBRMaterial(`stone${model.index}`, scene)
  scene.removeMaterial(mat)
  mesh.material = mat
  container.meshes.push(mesh)
  container.materials.push(mat)
  return { container, sidecar: { materials: [{ name: mat.name, flags: 0, diffuse: [], ambient: [], texture: 'res\\bldg\\stone.ddj', alphaMode: 'OPAQUE' }] } }
}

interface Setup {
  world: World
  fx: Fixture
  parts: RegionBatchPart[]
  loads: number[]
  ids: { plaza: number; variant: number }
  run(): Promise<void>
}

async function plazaWorld(o: { render?: RenderPath; batch?: boolean } = {}): Promise<Setup> {
  const fx = makeFixture()
  const plaza = addModel(fx, PLAZA)
  const models = fx.manifest.models
  const variant = models.length
  models.push({ ...models[plaza]!, index: variant, source: PLAZA + REMASTER_SOURCE_SUFFIX, glb: `models/m${plaza}.remaster.glb` })
  models[plaza]!.remasterVariant = variant
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const assets = new Assets(BASE_URL, fx.io)
  const nav = await loadNavStreamed(fx.manifest, assets)
  const parts: RegionBatchPart[] = []
  const world = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, {
    baseUrl: BASE_URL, minimap: false, render: o.render ?? 'pbr',
    parts: {
      batch: o.batch === false ? null : host => {
        const p = new RegionBatchPart(host, { tables: null, worker: null })
        parts.push(p)
        return p
      },
      life: null, ocean: null,
    },
  })
  await world.water.init(assets)
  const loads: number[] = []
  const loadModel = async (model: WorldModel): Promise<CachedModel> => {
    loads.push(model.index)
    const { container, sidecar } = boxContainer(scene, model)
    const converted = await world.materials.convert(container, sidecar, false, { model: model.glb!, source: model.source, kind: 'static' })
    return { model, container, converted, prep: prepareStatic(container) }
  }
  const disposeModel = (e: CachedModel) => {
    if (e.converted) world.materials.release(e.converted)
    e.container.dispose()
  }
  const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium }, {
    now: () => 0, autoPump: false, objects: true, nav: nav.chunks, loadModel, disposeModel,
    atlas: { create: () => ({ dispose() {}, getInternalTexture: () => null }) as unknown as BaseTexture, upload: () => true },
  })
  world.stream = stream
  stream.booting = false
  const run = async () => {
    const focus = centre(CX, CZ)
    for (let i = 0; i < 800; i++) {
      stream.update(focus, null)
      await settle(2)
      const s = stream.stats
      if (!s.jobs && !s.fetching && s.ready + s.failed === s.resident && s.objectsReady === s.ready) {
        stream.update(focus, null)
        if (!stream.stats.jobs) return
      }
    }
  }
  cleanups.push(() => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { world, fx, parts, loads, ids: { plaza, variant }, run }
}

describe('remastered world models (DRAGON-INT)', () => {
  it('remasterVariantOf takes only a converted static #remaster twin', () => {
    const base = { glb: 'models/a.glb', sidecar: null, kind: 'static', animations: [], defaultClip: null, lightmappedMeshes: 0, boundsMin: [0, 0, 0], boundsMax: [1, 1, 1], bytes: 0, validatorErrors: null }
    const models = [
      { ...base, index: 0, source: PLAZA, remasterVariant: 1 },
      { ...base, index: 1, source: PLAZA + REMASTER_SOURCE_SUFFIX, glb: 'models/a.remaster.glb' },
      { ...base, index: 2, source: 'res\\bldg\\x.bsr', remasterVariant: 1 },
      { ...base, index: 3, source: 'res\\bldg\\y.bsr', remasterVariant: 4 },
      { ...base, index: 4, source: 'res\\bldg\\y.bsr#remaster', glb: null, kind: 'failed' },
      { ...base, index: 5, source: 'res\\bldg\\z.bsr', kind: 'skinned', remasterVariant: 6 },
      { ...base, index: 6, source: 'res\\bldg\\z.bsr#remaster' },
      { ...base, index: 7, source: 'res\\bldg\\w.bsr' },
      { ...base, index: 8, source: 'res\\bldg\\v.bsr', remasterVariant: 8 },
    ] as unknown as WorldModel[]
    expect(remasterVariantOf(models[0]!, models)?.index).toBe(1)
    // another model's twin, a failed twin, a skinned retail model, no variant, itself
    expect(remasterVariantOf(models[2]!, models)).toBeNull()
    expect(remasterVariantOf(models[3]!, models)).toBeNull()
    expect(remasterVariantOf(models[5]!, models)).toBeNull()
    expect(remasterVariantOf(models[7]!, models)).toBeNull()
    expect(remasterVariantOf(models[8]!, models)).toBeNull()
    expect(remasterVariantOf(models[1]!, models)).toBeNull()
  })

  it('Medium+ with batching loads the variant, never the retail glb, and merges it for the retail placements', async () => {
    const s = await plazaWorld()
    await s.run()
    expect(s.loads).toContain(s.ids.variant)
    expect(s.loads).not.toContain(s.ids.plaza)
    expect(s.parts[0]!.modelFor(s.fx.manifest.models[s.ids.plaza]!).index).toBe(s.ids.variant)
    expect(s.parts[0]!.stats.claims).toBeGreaterThan(0)
    // the variant itself is placed nowhere: every placement still names the retail model
    expect(s.fx.manifest.placements.some(p => p.models.includes(s.ids.variant))).toBe(false)
  })

  it('Low (Classic) never loads the variant: the retail model draws as today', async () => {
    const low = await plazaWorld({ render: 'classic' })
    await low.run()
    expect(low.parts.length).toBe(0)
    expect(low.loads).toContain(low.ids.plaza)
    expect(low.loads).not.toContain(low.ids.variant)
  })

  it('PBR without a batcher (World batching off) draws the retail model', async () => {
    const off = await plazaWorld({ batch: false })
    await off.run()
    expect(off.loads).toContain(off.ids.plaza)
    expect(off.loads).not.toContain(off.ids.variant)
  })
})

const WORK = fileURLToPath(new URL('../../../work/', import.meta.url))
const SERVED = `${WORK}out/remaster/manifest.json`
const DRAGON_KEY = 'world/jangan-fields/models/bldg/china/jangan01/cj_jang_gate_dragon.remaster#cj_jang_dragon_m1'
const hasGold = existsSync(SERVED) && (JSON.parse(readFileSync(SERVED, 'utf8')) as { textures?: Record<string, unknown> }).textures?.[DRAGON_KEY] !== undefined

describe.skipIf(!hasGold)('the plaza dragon\'s gold set (work/out/remaster)', () => {
  it('resolves for the variant on every PBR tier, never for the retail statue or the retail tier', () => {
    const remaster = parseRemasterManifest(JSON.parse(readFileSync(SERVED, 'utf8')) as unknown, '/out/remaster/manifest.json')!
    expect(remaster.warnings).toEqual([])
    const index = new PbrMapIndex({ remaster })
    const glb = 'world/jangan-fields/models/bldg/china/jangan01/cj_jang_gate_dragon.remaster'
    const q = { glb, image: 'cj_jang_dragon_m1', texture: 'prim\\mtrl\\bldg\\china\\jangan01\\cj_jang_dragon_m1.ddj' }
    for (const tier of ['remaster', '2x', 2048] as TextureTier[]) {
      const rec = index.resolve(q, policyForTier(tier))
      expect(rec?.origin, String(tier)).toBe('remaster')
      expect(rec?.key).toBe(DRAGON_KEY)
      expect(rec?.albedo).toMatch(/^\/out\/remaster\/sets\/jangan_dragon_m1\/albedo(@1024)?\.webp$/)
      expect(rec?.cls).toBe('metal')
    }
    expect(index.resolve(q, policyForTier('retail'))).toBeNull()
    expect(index.resolve({ ...q, glb: 'world/jangan-fields/models/bldg/china/jangan01/cj_jang_gate_dragon', image: 'cj_jang_dragon' }, policyForTier('remaster'))).toBeNull()
  })
})

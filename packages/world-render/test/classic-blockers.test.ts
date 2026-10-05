/**
 * Item 7: on Low (Classic: QUALITY_PRESETS.low hides the animated objects) every object that blocks movement is drawn.
 * A skinned model whose object has a nav footprint draws as its static variant (thin instances) or, without one, as
 * its clone (still); the non-blocking skinned ones stay hidden, and Medium is unchanged. The real export check (skipped
 * without work/out-opt/world/jangan-fields) fails when any blocking placement has no Low representation.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BaseTexture } from '@babylonjs/core'
import { NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { NAV_DATA_VERSION, decodeNavData, encodeNavData, type NavInstance, type NavModel } from '@sro/nav'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldManifest, WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import {
  Assets,
  QUALITY_PRESETS,
  RegionStreamer,
  STREAM_DEFAULTS,
  World,
  WorldRegions,
  blockingModelsOf,
  loadNavStreamed,
  loadWorld,
  lowModelOf,
  type WorldQuality,
} from '../src/index.ts'
import { BASE_URL, CX, CZ, ROOT_URL, WORLD_NAME, fakeModels, makeFixture, settle, type Fixture } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const model = (index: number, kind: WorldModel['kind'], extra: Partial<WorldModel> = {}): WorldModel => ({
  index, source: `m${index}.bsr`, glb: `models/m${index}.glb`, sidecar: null, kind, animations: [], defaultClip: null,
  lightmappedMeshes: 0, boundsMin: [-1, 0, -1], boundsMax: [1, 2, 1], bytes: 0, validatorErrors: null, ...extra,
})

describe('blockingModelsOf / lowModelOf', () => {
  const models = [
    model(0, 'static'),
    model(1, 'skinned', { staticVariant: 2 }),
    model(2, 'static', { source: 'm1.bsr#static' }),
    model(3, 'skinned'),
    model(4, 'skinned'),
    model(5, 'failed', { glb: null }),
    model(6, 'skinned', { staticVariant: 5 }),
  ]

  it('a model blocks when any placement of its object has a nav instance (also its placements without one)', () => {
    const placements = [
      { objId: 10, models: [1] },
      { objId: 10, models: [1] },
      { objId: 30, models: [3, 0] },
      { objId: 40, models: [4] },
    ]
    expect([...blockingModelsOf(placements, [{ objId: 10 }, { objId: 30 }])].sort()).toEqual([0, 1, 3])
    expect(blockingModelsOf(placements, []).size).toBe(0)
  })

  it('Low draws a static model, a blocking skinned one as its static variant or itself, a non-blocking skinned one never', () => {
    expect(lowModelOf(models[0]!, models, false)).toBe(models[0])
    expect(lowModelOf(models[1]!, models, true)).toBe(models[2])
    expect(lowModelOf(models[3]!, models, true)).toBe(models[3])
    expect(lowModelOf(models[1]!, models, false)).toBeNull()
    expect(lowModelOf(models[4]!, models, false)).toBeNull()
    expect(lowModelOf(models[5]!, models, true)).toBeNull()
    // A broken variant (failed, no glb) leaves the clone.
    expect(lowModelOf(models[6]!, models, true)).toBe(models[6])
  })
})

// ---- a synthetic world: model 0 static everywhere; in the centre region model 1 (skinned, blocking, static variant
// 2), model 3 (skinned, blocking, no variant) and model 4 (skinned, not blocking) ----------------------------------------

const TRI: NavModel = {
  key: 'tri.bms',
  vertices: new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 10]),
  cells: new Uint16Array([0, 1, 2]),
  outline: { vertices: new Uint16Array([0, 1, 1, 2, 2, 0]), cells: new Uint16Array([0, 0xffff, 0, 0xffff, 0, 0xffff]), flags: new Uint8Array([3, 3, 3]) },
  inline: { vertices: new Uint16Array(0), cells: new Uint16Array(0), flags: new Uint8Array(0) },
  events: [],
}

function blockerFixture(): Fixture {
  const fx = makeFixture()
  const m = fx.manifest
  m.models[1]!.staticVariant = 2
  m.models.push(model(2, 'static', { source: 'm1.bsr#static' }), model(3, 'skinned'), model(4, 'skinned'))
  const centre = m.placements.find(p => p.models[0] === 1)!
  const near = (index: number, dx: number): WorldPlacement => ({
    ...centre, objId: index, source: `m${index}.bsr`, models: [index], uid: 900 + index,
    position: [centre.position[0] + dx, centre.position[1], centre.position[2]],
  })
  m.placements.push(near(3, 6), near(4, 12))
  const instance = (objId: number, uid: number): NavInstance => ({ id: ((((CZ << 8) | CX) << 16) | uid) >>> 0, objId, model: 0, x: 0, y: 0, z: 0, yaw: 0, links: [] })
  fx.files.set(`${BASE_URL}nav-objects.bin`, encodeNavData({ version: NAV_DATA_VERSION, regions: [], models: [TRI], instances: [instance(1, centre.uid), instance(3, 903)] }))
  return fx
}

interface Placed {
  index: number
  kind: 'static' | 'clone'
  meshes: number
}

async function streamed(quality: WorldQuality) {
  const fx = blockerFixture()
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const assets = new Assets(BASE_URL, fx.io)
  const nav = await loadNavStreamed(fx.manifest, assets)
  const world = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, { baseUrl: BASE_URL, minimap: false, quality })
  await world.water.init(assets)
  const models = fakeModels(scene)
  const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium }, {
    now: () => 0,
    autoPump: false,
    objects: true,
    nav: nav.chunks,
    loadModel: models.loadModel,
    disposeModel: models.disposeModel,
    atlas: { create: () => ({ dispose() {}, getInternalTexture: () => null }) as unknown as BaseTexture, upload: () => true },
  })
  world.stream = stream
  stream.booting = false
  cleanups.push(() => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  })
  const placed: Placed[] = []
  world.objects.addRegionListener({ placed: (_r, _m, info, meshes) => placed.push({ index: info.index, kind: info.kind, meshes: meshes.length }), removed() {} })
  const focus = { x: 96, z: -96 }
  for (let i = 0; i < 600; i++) {
    stream.update(focus, null)
    await settle(2)
    const s = stream.stats
    if (!s.jobs && !s.fetching && s.ready + s.failed === s.resident && s.objectsReady === s.ready) break
  }
  // The camera at the centre placements: every clone in range.
  world.objects.update(new Vector3(focus.x, 0, focus.z), true)
  return { world, models, placed }
}

describe('Low draws every blocking object (streamed regions)', () => {
  it('Low: the blocking skinned tree loads as its static variant, the blocking clone stays drawn and still, the rest stays hidden', async () => {
    const { world, models, placed } = await streamed('low')
    expect(QUALITY_PRESETS.low.animated).toBe(false)
    expect(world.objects.animatedVisible).toBe(false)
    expect([...world.blockingModels()].sort()).toEqual([1, 3])
    expect(models.loads).toContain(2)
    expect(models.loads).not.toContain(1)
    const of = (i: number) => placed.filter(p => p.index === i)
    expect(of(1).map(p => p.kind)).toEqual(['static'])
    expect(of(1)[0]!.meshes).toBeGreaterThan(0)
    expect(of(3).map(p => p.kind)).toEqual(['clone'])
    expect(of(4).map(p => p.kind)).toEqual(['clone'])
    // Drawn: model 3's clone (blocking); hidden: model 4's (not blocking). Nothing animates on Low.
    expect(world.objects.visibleCounts.clones).toBe(1)
    expect(world.objects.animatingCount).toBe(0)
    // Animated objects shown again (no re-placing): every clone draws and animates; the variant's chunk stays.
    world.objects.setAnimatedVisible(true)
    expect(world.objects.visibleCounts.clones).toBe(2)
    expect(world.objects.animatingCount).toBe(2)
    world.objects.setAnimatedVisible(false)
    expect(world.objects.visibleCounts.clones).toBe(1)
  })

  it('zoomed far out on Low, an object at the player stays drawn: the range counts from the nearer of the camera and its focus', async () => {
    const { world } = await streamed('low')
    const far = new Vector3(96 + 400, 0, -96)
    world.objects.update(far, true)
    expect(world.objects.visibleCounts.clones).toBe(0)
    world.objects.update(far, true, { x: 96, z: -96 })
    expect(world.objects.visibleCounts.clones).toBe(1)
  })

  it('Medium is unchanged: the skinned models are clones, all drawn and animating; the variant is never loaded', async () => {
    const { world, models, placed } = await streamed('medium')
    expect(world.objects.animatedVisible).toBe(true)
    expect(models.loads).not.toContain(2)
    expect(models.loads).toEqual(expect.arrayContaining([0, 1, 3, 4]))
    expect(placed.filter(p => p.index !== 0).map(p => `${p.index}:${p.kind}`).sort()).toEqual(['1:clone', '3:clone', '4:clone'])
    expect(world.objects.visibleCounts.clones).toBe(3)
    expect(world.objects.animatingCount).toBe(3)
  })
})

/** A one-triangle glb (no material): enough for the whole-world load to place it. */
function tinyGlb(): Uint8Array {
  const bin = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]).buffer)
  const json = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 0, 1] }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }], buffers: [{ byteLength: bin.length }],
  })
  const j = new TextEncoder().encode(json + ' '.repeat((4 - (json.length % 4)) % 4))
  const out = new Uint8Array(12 + 8 + j.length + 8 + bin.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x46546c67, true)
  v.setUint32(4, 2, true)
  v.setUint32(8, out.length, true)
  v.setUint32(12, j.length, true)
  v.setUint32(16, 0x4e4f534a, true)
  out.set(j, 20)
  v.setUint32(20 + j.length, bin.length, true)
  v.setUint32(24 + j.length, 0x004e4942, true)
  out.set(bin, 28 + j.length)
  return out
}

describe('Low draws every blocking object (whole-world load)', () => {
  it('loads the static variant in place of a blocking skinned model, never its own glb', async () => {
    const fx = blockerFixture()
    for (const m of fx.manifest.models) fx.files.set(`${BASE_URL}${m.glb}`, tinyGlb())
    ;(fx.manifest as unknown as { nav?: unknown }).nav = { file: 'nav-objects.bin' }
    fx.files.set(`${BASE_URL}manifest.json`, new TextEncoder().encode(JSON.stringify(fx.manifest)))
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const world = await loadWorld(scene, { baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, stream: false, quality: 'low' })
    cleanups.push(() => {
      world.dispose()
      scene.dispose()
      engine.dispose()
    })
    expect(world.objects.errors).toEqual([])
    expect(fx.fetched).toContain(`${BASE_URL}models/m2.glb`)
    expect(fx.fetched).not.toContain(`${BASE_URL}models/m1.glb`)
    world.objects.update(new Vector3(96, 0, -96), true)
    // Model 3's clone draws (blocking), model 4's does not.
    expect(world.objects.visibleCounts.clones).toBe(1)
    expect(world.objects.animatingCount).toBe(0)
  })
})

// ---- the real export ------------------------------------------------------------------------------------------------

const EXPORT = join(fileURLToPath(new URL('../../../', import.meta.url)), 'work', 'out-opt', 'world', 'jangan-fields')
const hasExport = existsSync(join(EXPORT, 'manifest.json')) && existsSync(join(EXPORT, 'nav-objects.bin'))

describe.skipIf(!hasExport)('jangan-fields on Low (work/out-opt)', () => {
  it('every placement that blocks movement has a Low representation', () => {
    const m = JSON.parse(readFileSync(join(EXPORT, 'manifest.json'), 'utf8')) as WorldManifest
    const nav = decodeNavData(new Uint8Array(readFileSync(join(EXPORT, 'nav-objects.bin'))))
    const ids = new Set(nav.instances.map(i => i.objId))
    const blocking = blockingModelsOf(m.placements, nav.instances)
    const missing: string[] = []
    let blockers = 0, variants = 0, clones = 0
    for (const p of m.placements) {
      if (!ids.has(p.objId)) continue
      blockers++
      const low = p.models.map(i => lowModelOf(m.models[i]!, m.models, blocking.has(i)))
      if (!low.some(x => x !== null)) missing.push(`${p.source} region ${p.region} uid ${p.uid} at ${p.position.map(v => v.toFixed(1)).join(', ')}`)
      p.models.forEach((i, k) => {
        if (m.models[i]!.kind !== 'skinned' || !low[k]) return
        if (low[k]!.kind === 'static') variants++
        else clones++
      })
    }
    console.log(`[classic-blockers] ${blockers} blocking placements; skinned ones on Low: ${variants} as static variants, ${clones} as clones`)
    expect(blockers).toBeGreaterThan(1000)
    expect(missing).toEqual([])
    // The skinned retail trees draw as their static variants (thin instances), not as clones.
    expect(variants).toBeGreaterThan(clones)
  })
})

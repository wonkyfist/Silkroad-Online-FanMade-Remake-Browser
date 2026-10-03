/**
 * RND-L's shadow proxies (docs/RENDER.md §4.3, docs/WAVE_PLAN3.md §6.12): every opaque static instance of a region
 * merged into one position-only mesh on SHADOW_PROXY_LAYER (outside the camera mask), with the summed triangle count
 * and the instances' world positions; alpha-tested and foliage chunks stay out (they are cut-out casters); small props
 * (LOD group 3) only on Ultra; the newest owner of a region wins while an old chunk unloads; the whole-world load is
 * split by position; the streamed world builds them as the `shadowProxy` commit step and drops them with the region.
 */
import { BaseTexture, DirectionalLight, Matrix, MeshBuilder, NullEngine, PBRMaterial, Scene, Vector3, VertexBuffer, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import { RegionStreamer, STREAM_DEFAULTS, type PlacedModelInfo, type RegionData } from '../src/index.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import { SHADOW_PROXY_LAYER, ShadowProxies, WorldShadows, isOpaqueMaterial, mergeInstances } from '../src/render/shadows.ts'
import { CX, CZ, X0, fakeModels, makeFixture, makeWorld, settle } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function scene(): Scene {
  const engine = new NullEngine()
  const s = new Scene(engine)
  s.useRightHandedSystem = true
  cleanups.push(() => {
    s.dispose()
    engine.dispose()
  })
  return s
}

/** A thin-instance chunk like WorldObjects.placeStatic makes: a unit box at each translation (optionally yawed). */
function chunk(s: Scene, at: Array<[number, number, number]>, yaw = 0): Mesh {
  const m = MeshBuilder.CreateBox('chunk', { size: 1 }, s)
  const buf = new Float32Array(16 * at.length)
  // Row vectors: v × RotationY × Translation (rotate about the model origin, then place).
  at.forEach((p, i) => Matrix.RotationY(yaw).multiply(Matrix.Translation(p[0], p[1], p[2])).copyToArray(buf, 16 * i))
  m.thinInstanceSetBuffer('matrix', buf, 16, true)
  m.thinInstanceRefreshBoundingInfo(false)
  m.freezeWorldMatrix()
  return m
}

const info = (o: Partial<PlacedModelInfo> = {}): PlacedModelInfo => ({ index: 0, source: 'm0.bsr', heightM: 4, isFoliage: false, kind: 'static', ...o })
const placement = (region: number, group = 2): WorldPlacement => ({ region, group } as WorldPlacement)
const model = {} as WorldModel
const regionData = (id: number, origin: [number, number, number]): RegionData => ({ region: { id, origin } } as unknown as RegionData)

describe('mergeInstances', () => {
  it('bakes every instance into world space: summed triangles, the instances\' positions', () => {
    const s = scene()
    const a = chunk(s, [[10, 0, 0], [20, 5, -3]])
    const b = chunk(s, [[-4, 1, 7]], Math.PI / 2)
    const { positions, indices } = mergeInstances([a, b])
    const tris = a.getTotalIndices() / 3
    expect(indices.length / 3).toBe(tris * 3)
    expect(positions.length / 3).toBe(a.getTotalVertices() * 3)
    // Instance centres: the mean of each instance's 24 box vertices.
    const n = a.getTotalVertices()
    const centre = (k: number) => {
      const c = new Vector3()
      for (let v = 0; v < n; v++) c.addInPlaceFromFloats(positions[(k * n + v) * 3]!, positions[(k * n + v) * 3 + 1]!, positions[(k * n + v) * 3 + 2]!)
      return c.scale(1 / n)
    }
    expect(centre(0).subtract(new Vector3(10, 0, 0)).length()).toBeLessThan(1e-5)
    expect(centre(1).subtract(new Vector3(20, 5, -3)).length()).toBeLessThan(1e-5)
    expect(centre(2).subtract(new Vector3(-4, 1, 7)).length()).toBeLessThan(1e-5)
    // Indices address their own instance's vertices.
    expect(Math.max(...indices)).toBe(positions.length / 3 - 1)
    // The filter drops instances by their translation.
    const kept = mergeInstances([a], x => x < 15)
    expect(kept.indices.length / 3).toBe(tris)
  })
})

describe('ShadowProxies', () => {
  it('merges a region\'s opaque statics into one hidden position-only mesh; cut-outs, foliage and props stay out', () => {
    const s = scene()
    const p = new ShadowProxies(s, () => [])
    cleanups.unshift(() => p.dispose())
    const R = 5
    const opaque = chunk(s, [[0, 0, 0], [3, 0, 0]])
    const cut = chunk(s, [[6, 0, 0]])
    const mat = new PBRMaterial('leaf', s)
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    cut.material = mat
    const tree = chunk(s, [[9, 0, 0]])
    const prop = chunk(s, [[12, 0, 0]])
    p.placed(1, model, info(), [opaque, cut], [placement(R)])
    p.placed(1, model, info({ isFoliage: true }), [tree], [placement(R)])
    p.placed(1, model, info(), [prop], [placement(R, 3)])
    expect(isOpaqueMaterial(opaque.material)).toBe(true)
    expect(isOpaqueMaterial(mat)).toBe(false)
    const proxy = p.build(regionData(R, [0, 0, 0]))!
    expect(proxy.triangles).toBe(2 * opaque.getTotalIndices() / 3)
    expect(proxy.mesh.layerMask).toBe(SHADOW_PROXY_LAYER)
    expect(proxy.mesh.layerMask & 0x0fffffff).toBe(0) // no camera sees it
    expect(proxy.mesh.isPickable).toBe(false)
    expect(proxy.mesh.material).toBe(p.material)
    expect(p.material.backFaceCulling).toBe(false)
    expect(proxy.mesh.getVerticesData(VertexBuffer.NormalKind)).toBeNull() // positions only
    expect(proxy.center.x).toBeCloseTo(1.5, 5)
    // The cut-out chunk and the tree cast on their own (the foliage range); the prop is not a caster at all.
    expect(p.cutouts()).toEqual([cut, tree])
    // Ultra merges group-3 props too.
    p.props = true
    expect(p.build(regionData(R, [0, 0, 0]))!.triangles).toBe(3 * opaque.getTotalIndices() / 3)
    expect(proxy.mesh.isDisposed()).toBe(true) // the rebuild replaced it
  })

  it('takes the newest owner of a region, and drops a proxy only with the owner it was built from', () => {
    const s = scene()
    const p = new ShadowProxies(s, () => [])
    cleanups.unshift(() => p.dispose())
    const R = 7
    const old = chunk(s, [[0, 0, 0]])
    const fresh = chunk(s, [[0, 0, 0], [2, 0, 0]])
    p.placed(3, model, info(), [old], [placement(R)])
    p.placed(8, model, info(), [fresh], [placement(R)]) // the region loaded again while the old chunk unloads
    const proxy = p.build(regionData(R, [0, 0, 0]))!
    expect(proxy.owner).toBe(8)
    expect(proxy.triangles).toBe(2 * fresh.getTotalIndices() / 3)
    p.removed(3)
    expect(p.proxies.get(R)).toBe(proxy)
    p.removed(8)
    expect(p.proxies.has(R)).toBe(false)
    expect(proxy.mesh.isDisposed()).toBe(true)
  })

  it('splits the whole-world load by position: each instance in the region that holds it (or the nearest)', () => {
    const s = scene()
    const regions = [regionData(1, [0, 0, 0]), regionData(2, [192, 0, 0])] // x in [0, 192) and [192, 384), z in (−192, 0]
    const p = new ShadowProxies(s, () => regions)
    cleanups.unshift(() => p.dispose())
    const all = chunk(s, [[10, 0, -10], [200, 0, -50], [500, 0, -20], [-30, 0, -5]])
    p.placed(-1, model, info(), [all], [])
    const tris = all.getTotalIndices() / 3
    expect(p.build(regions[0]!)!.triangles).toBe(2 * tris) // 10 and −30 (nearest)
    expect(p.build(regions[1]!)!.triangles).toBe(2 * tris) // 200 and 500 (nearest)
  })
})

describe('shadow proxies on a streamed world', () => {
  it('are built per region by the shadowProxy commit step after the debounce, and removed with the region', async () => {
    const fx = makeFixture()
    const { engine, scene: s, world, chunks } = await makeWorld(fx)
    let clock = 0
    const models = fakeModels(s)
    const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium }, {
      now: () => clock,
      autoPump: false,
      objects: true,
      nav: chunks,
      loadModel: models.loadModel,
      disposeModel: models.disposeModel,
      atlas: { create: () => ({ dispose() {}, getInternalTexture: () => null }) as unknown as BaseTexture, upload: () => true },
    })
    world.stream = stream
    stream.booting = false
    const light = new DirectionalLight('celestial', new Vector3(0, -1, 0), s)
    const shadows = new WorldShadows(s, light, world, { quality: RENDER_PRESETS.high })
    cleanups.push(() => {
      shadows.dispose()
      world.dispose()
      s.dispose()
      engine.dispose()
    })
    const centre = (x: number, z: number) => ({ x: 192 * (x - CX) + 96, z: -192 * (z - CZ) - 96 })
    const run = async (focus: { x: number; z: number }) => {
      for (let i = 0; i < 600; i++) {
        stream.update(focus, null)
        await settle(2)
        clock += 50
        const st = stream.stats
        if (!st.jobs && !st.fetching && st.ready + st.failed === st.resident && st.objectsReady === st.ready) {
          // Let the debounced commit steps (500 ms) come due and run.
          for (let j = 0; j < 12; j++) {
            clock += 100
            stream.update(focus, null)
            await settle(1)
          }
          if (!stream.stats.jobs) return
        }
      }
    }
    expect(stream.commitSteps).toContain('shadowProxy')
    await run(centre(CX, CZ))
    const ready = [...Array(49).keys()].map(i => stream.chunk(X0 + (i % 7), 100 + Math.floor(i / 7))).filter(c => c?.objectsReady)
    expect(ready.length).toBeGreaterThan(0)
    expect(shadows.proxies.proxies.size).toBe(ready.length)
    const cx = stream.chunk(CX, CZ)!
    const proxy = shadows.proxies.proxies.get(cx.id)!
    expect(proxy.owner).toBe(cx.owner)
    // One unit box, plus the region's terrain skin on High (BT-S: 24 × 24 cells of 8 m, two triangles each).
    expect(proxy.triangles).toBe(12 + 24 * 24 * 2)
    expect(proxy.skin).toBe(true)
    // The fixture places the region's box at its centre (origin + 96, −96).
    expect(proxy.center.x).toBeCloseTo(96, 3)
    expect(proxy.center.z).toBeCloseTo(-96, 3)
    // Objects receive shadows.
    expect(world.objects.meshes().every(m => m.receiveShadows)).toBe(true)
    // Moving away unloads regions: their proxies go with them.
    await run(centre(X0, CZ))
    expect(stream.state(CX + 2, CZ)).toBe('absent')
    for (const [id, p] of shadows.proxies.proxies) {
      expect(p.mesh.isDisposed()).toBe(false)
      expect(stream.chunk(id & 0xff, id >> 8)?.alive ?? false).toBe(true)
    }
    expect([...shadows.proxies.proxies.keys()]).not.toContain(stream.chunk(CX + 2, CZ)?.id ?? ((CZ << 8) | (CX + 2)))
  }, 30_000)
})

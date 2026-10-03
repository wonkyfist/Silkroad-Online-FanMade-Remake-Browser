// The viewer's trees lab (T12-L, docs/TREES.md §W4.1 rule 3, WF1; WAVE_PLAN8 §6.2 T12-L): the crown luminance A/B
// method on synthetic frames (only the differing green pixels count, per frame; the ±10 % gate) and the row flip of a
// WebGL read; step 2: ?trees= / ?bands=1, the band view's markers, the counters, and the toggle: New ↔ Retail on the
// W12-SA object world (World.setTreeMode) rebuilds without leftovers, cycle after cycle; the Classic path never swaps
// (the Low guard).
import { AssetContainer, MeshBuilder, NullEngine, PBRMaterial, Scene, TransformNode, Vector3, VertexBuffer, type Camera, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { SidecarLite } from '../../../packages/world-render/src/materials.ts'
import { TreesNearField, type NearModel } from '../../../packages/world-render/src/trees/index.ts'
import { settle } from '../../../packages/world-render/test/stream-fixture.ts'
import { objectWorld, type ObjectWorld } from '../../../packages/world-render/test/w12-fixture.ts'
import {
  BandView,
  CROWN_GATE,
  CROWN_VIEWS,
  bandMarkers,
  crownLuma,
  findTreeLeftovers,
  flipRows,
  formatTreesCounters,
  formatTreesToggle,
  parseTreesParams,
  toggleTrees,
  treeCountGrowth,
  treeLeftoverProblems,
  treeSceneCounts,
  treesState,
} from '../src/world/trees-panel.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function frame(px: [number, number, number][]): Uint8Array {
  const out = new Uint8Array(px.length * 4)
  px.forEach(([r, g, b], i) => out.set([r, g, b, 255], i * 4))
  return out
}

describe('crownLuma (WF1)', () => {
  const sky: [number, number, number] = [120, 160, 220]
  const ground: [number, number, number] = [110, 100, 80]

  it('counts only the green pixels that differ, and gives new / retail', () => {
    const a = frame([sky, ground, [60, 120, 40], [60, 120, 40], [200, 40, 30]])
    const b = frame([sky, ground, [30, 60, 20], [60, 120, 40], [200, 40, 30]])
    const r = crownLuma(a, b, 5)
    expect(r.retail.px).toBe(1)
    expect(r.next.px).toBe(1)
    expect(r.ratio).toBeCloseTo(0.5, 2)
    expect(r.pass).toBe(false)
  })

  it('a crown that moved but kept its brightness passes', () => {
    const leaf: [number, number, number] = [70, 130, 50]
    const a = frame([leaf, sky, leaf, ground])
    const b = frame([sky, leaf, [72, 132, 50], ground])
    const r = crownLuma(a, b, 4)
    expect(r.retail.px).toBe(1)
    expect(r.next.px).toBe(1)
    expect(Math.abs(r.ratio - 1)).toBeLessThan(CROWN_GATE)
    expect(r.pass).toBe(true)
  })

  it('reports saturation and NaN without crown pixels', () => {
    const r = crownLuma(frame([sky, ground]), frame([sky, ground]), 2)
    expect(r.retail.px).toBe(0)
    expect(Number.isNaN(r.ratio)).toBe(true)
    expect(r.pass).toBe(false)
    const s = crownLuma(frame([[100, 200, 0]]), frame([[50, 100, 50]]), 1)
    expect(s.retail.sat).toBeCloseTo(1, 5)
    expect(s.next.sat).toBeCloseTo(0.5, 5)
    expect(() => crownLuma(new Uint8Array(4), new Uint8Array(8), 2)).toThrow()
  })

  it('flips a bottom-up read to top-down rows', () => {
    const px = frame([[1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0], [5, 0, 0], [6, 0, 0]])
    flipRows(px, 2, 3)
    expect([px[0], px[4], px[8], px[12], px[16], px[20]]).toEqual([5, 6, 3, 4, 1, 2])
  })

  it('has the four B1 family views at the game camera range', () => {
    for (const v of Object.values(CROWN_VIEWS)) {
      expect(v.b).toBeGreaterThan(1.1)
      expect(v.b).toBeLessThan(1.4)
    }
  })
})

describe('the panel parameters', () => {
  it('?trees=new|retail and ?bands=1; anything else is the default', () => {
    expect(parseTreesParams('?trees=retail&bands=1')).toEqual({ mode: 'retail', bands: true })
    expect(parseTreesParams('?trees=new')).toEqual({ mode: 'new', bands: false })
    expect(parseTreesParams('?trees=old&bands=yes')).toEqual({ mode: null, bands: false })
    expect(parseTreesParams('')).toEqual({ mode: null, bands: false })
  })
})

describe('the band view', () => {
  it('one marker per placement in its band, at the sphere top, sized from the radius; unknown bands count as hidden', () => {
    const m = bandMarkers([
      { x: 1, y: 2, z: 3, r: 5, band: 0 },
      { x: 4, y: 0, z: 0, r: 40, band: 2 },
      { x: 0, y: 0, z: 0, r: 1, band: 2 },
      { x: 0, y: 0, z: 0, r: 1, band: 255 },
    ])
    expect(m.counts).toEqual([1, 0, 2, 1])
    const a = m.matrices[0]!
    expect(a.length).toBe(16)
    expect([a[12], a[13], a[14], a[15]]).toEqual([1, 7, 3, 1])
    expect(a[0]).toBeCloseTo(0.6, 5)
    // clamped 0.5 … 2
    expect(m.matrices[2]![0]).toBe(2)
    expect(m.matrices[2]![16]).toBe(0.5)
    expect(m.matrices[1]!.length).toBe(0)
  })

  it('its own meshes and materials, made and disposed whole; nothing drawn without a part', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const before = { meshes: scene.meshes.length, materials: scene.materials.length }
    const v = new BandView(scene)
    expect(scene.meshes.length).toBe(before.meshes + 4)
    v.sync(null)
    expect(v.counts).toEqual([0, 0, 0, 0])
    expect(scene.meshes.filter(m => m.isVisible && (m.metadata as { sroTreesLab?: boolean } | null)?.sroTreesLab)).toHaveLength(0)
    const fake = { slots: { entries: () => [{ x: 0, y: 0, z: 0, r: 4, band: 1 }, { x: 9, y: 0, z: 0, r: 4, band: 1 }] } }
    v.sync(fake as never)
    expect(v.counts).toEqual([0, 2, 0, 0])
    const mid = scene.meshes.find(m => m.name === 'treesLab:band1') as Mesh
    expect(mid.thinInstanceCount).toBe(2)
    expect(mid.isVisible).toBe(true)
    expect(mid.isPickable).toBe(false)
    // the lab's meshes are not counted as the world's
    expect(treeSceneCounts(scene).meshes).toBe(before.meshes)
    v.dispose()
    expect(scene.meshes.length).toBe(before.meshes)
    expect(scene.materials.length).toBe(before.materials)
  })
})

describe('the leftover rules', () => {
  const clean = { part: false, overlayMeshes: 0, strayOverlay: 0, overlayMaterials: 0, bandTexture: false, bandedVertices: 0 }
  it('without a part nothing of it may stay; with one only its own overlay', () => {
    expect(treeLeftoverProblems(clean, false)).toEqual([])
    expect(treeLeftoverProblems({ ...clean, part: true, overlayMeshes: 2 }, true)).toEqual([])
    expect(treeLeftoverProblems(clean, true)).toEqual(['World.trees is not set'])
    expect(treeLeftoverProblems({ ...clean, overlayMeshes: 2, strayOverlay: 2, overlayMaterials: 1, bandTexture: true, bandedVertices: 12 }, false)).toEqual([
      '2 overlay mesh(es) owned by no part',
      '1 overlay material(s) left without a part',
      'the band texture is still on the foliage plugins',
      '12 banded merged vertices without a part',
    ])
    expect(treeCountGrowth({ meshes: 3, materials: 2, textures: 1, geometries: 1 }, { meshes: 3, materials: 3, textures: 1, geometries: 0 })).toEqual(['materials 2 → 3'])
  })
})

describe('the leftovers scan', () => {
  it('counts the merged vertices whose pivot word carries a tier (slot × 4 + tier), not the overlay nor non-tree meshes', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const mk = (name: string, words: number[], md: Record<string, unknown>) => {
      const m = MeshBuilder.CreateBox(name, { size: 1 }, scene)
      const n = m.getTotalVertices()
      const piv = new Float32Array(n * 4)
      for (let v = 0; v < n; v++) piv[v * 4 + 3] = words[v % words.length]!
      m.setVerticesData('sroPivot', piv, false, 4)
      m.metadata = md
      return m
    }
    // 24 vertices each: words 0, 5 (slot 1 tier 1), 10 (slot 2 tier 2), 8 (slot 2 tier 0: never written, still 0-tier)
    mk('tree', [0, 5, 10, 8], { sroTree: true })
    mk('overlay', [5], { sroTree: true, sroTreeOverlay: true })
    mk('building', [5], { sroWorld: 'object' })
    const world = { trees: null, foliage: { shared: { band: null } } } as never
    const l = findTreeLeftovers(scene, world)
    expect(l.bandedVertices).toBe(12)
    expect(l.overlayMeshes).toBe(1)
    expect(l.strayOverlay).toBe(1)
    expect(treeLeftoverProblems(l, false)).toEqual(['1 overlay mesh(es) owned by no part', '12 banded merged vertices without a part'])
  })
})

// ---- the toggle on the W12-SA object world -------------------------------------------------------------------------

const BARK_KEY = 'prim\\mtrl\\nature\\common\\tree\\tre_w12_pine07_bark.ddj'
const LEAF_KEY = 'prim\\mtrl\\nature\\common\\tree\\tre_w12_pine07_leaf.ddj'

/** A species LOD0 test container (bark box, leaf card; the wind data in TEXCOORD_1 / TEXCOORD_2). */
function nearContainer(scene: Scene): NearModel {
  const container = new AssetContainer(scene)
  const root = new TransformNode('near#root', scene)
  scene.removeTransformNode(root)
  container.transformNodes.push(root)
  container.rootNodes.push(root)
  const sidecar: SidecarLite & { trees: unknown } = { materials: [], trees: { kind: 'tree', tints: [] } }
  for (const [name, key, mask] of [['pine07_bark', BARK_KEY, false], ['pine07_leaf', LEAF_KEY, true]] as const) {
    const mesh = (mask ? MeshBuilder.CreatePlane(name, { size: 3 }, scene) : MeshBuilder.CreateBox(name, { size: 0.6 }, scene)) as Mesh
    scene.removeMesh(mesh)
    mesh.position.set(0, mask ? 4 : 1, 0)
    mesh.parent = root
    const n = mesh.getTotalVertices()
    mesh.setVerticesData(VertexBuffer.UV2Kind, Float32Array.from({ length: n * 2 }, (_, i) => (i % 2 ? 0.75 : 0.5)), false, 2)
    mesh.setVerticesData(VertexBuffer.UV3Kind, Float32Array.from({ length: n * 2 }, (_, i) => (i % 2 ? 0.1 : 0.4)), false, 2)
    const src = new PBRMaterial(name, scene)
    scene.removeMaterial(src)
    if (mask) src.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    mesh.material = src
    container.meshes.push(mesh)
    container.materials.push(src)
    sidecar.materials!.push({ name, flags: 0, diffuse: [], ambient: [], texture: key, alphaMode: mask ? 'MASK' : 'OPAQUE' })
  }
  return { container, sidecar, path: 'models/trees/pine07/near.glb' }
}

/** The object world with the pine swapped to a species (T12-N's part with the test LOD0). */
async function treesWorld(o: { render?: 'pbr' | 'classic'; trees?: 'new' | 'retail' } = {}): Promise<ObjectWorld> {
  const w = await objectWorld({
    ...(o.render ? { render: o.render } : {}),
    ...(o.trees ? { trees: o.trees } : {}),
    edit: (fx, ids) => {
      const models = fx.manifest.models
      const species = models.length
      models.push({
        ...models[ids.pine]!, index: species, source: 'res\\nature\\common\\tree\\w12\\pine07.bsr#species', glb: 'models/trees/pine07/far.glb',
        sidecar: null, boundsMin: [-1, 0, -1], boundsMax: [1, 6, 1],
      })
      models[ids.pine]!.treeSwap = { model: species, fit: [1, 1, 1], tint: 0 }
    },
    parts: {
      trees: host => new TreesNearField(host, {
        load: async () => {
          await settle(1)
          return nearContainer(host.scene)
        },
        kindOf: async () => 'tree',
      }),
    },
  })
  cleanups.push(() => w.dispose())
  return w
}

/** The camera beside the centre pine; updates the part until its overlay draws it. */
async function nearPine(w: ObjectWorld): Promise<void> {
  const pines = w.fx.manifest.placements.filter(p => p.models[0] === w.ids.pine)
  const pine = pines.reduce((a, b) => (Math.hypot(a.position[0] - 96, a.position[2] + 96) < Math.hypot(b.position[0] - 96, b.position[2] + 96) ? a : b))
  const cam = { globalPosition: new Vector3(pine.position[0] + 3, pine.position[1] + 2, pine.position[2]) } as unknown as Camera
  for (let i = 0; i < 60; i++) {
    w.world.trees!.update(cam, 0.016)
    if (w.world.trees!.stats().overlayInstances >= 1) return
    await settle(2)
  }
  throw new Error(`overlay did not settle: ${JSON.stringify(w.world.trees!.stats())}`)
}

describe('the toggle rebuilds without leftovers (World.setTreeMode: New ↔ Retail)', () => {
  it('cycle after cycle: Retail leaves no overlay, no band texture, no banded vertex; New comes back whole; no growth', async () => {
    const w = await treesWorld()
    await w.run()
    expect(w.world.trees).not.toBeNull()
    expect(treesState(w.world)).toBe('new (swapping)')
    await nearPine(w)
    const first = findTreeLeftovers(w.scene, w.world)
    expect(first).toMatchObject({ part: true, strayOverlay: 0, bandTexture: true })
    expect(first.overlayMeshes).toBeGreaterThan(0)
    // (the fixture's species has no LOD tiers: its merged words are tier 0, never banded; the count is tested below)
    expect(treeLeftoverProblems(first, true)).toEqual([])
    const lines = formatTreesCounters(w.world, [1, 2, 3, 0])
    expect(lines[0]).toBe('trees     new (swapping)')
    expect(lines.some(l => /^bands {5}near \d+ · mid \d+ · far \d+ · hidden \d+$/.test(l))).toBe(true)
    expect(lines.some(l => /^overlay {3}\d+ draws · \d+ instances/.test(l))).toBe(true)
    expect(lines.at(-1)).toBe('band view near 1 · mid 2 · far 3 · hidden 0')

    const retail: ReturnType<typeof treeSceneCounts>[] = []
    const wait = () => w.run()
    for (let cycle = 0; cycle < 3; cycle++) {
      const off = await toggleTrees(w.world, 'retail', wait, 5_000)
      expect(off.settleMs).toBeGreaterThanOrEqual(0)
      expect(off.problems).toEqual([])
      expect(off.leftovers).toMatchObject({ part: false, overlayMeshes: 0, overlayMaterials: 0, bandTexture: false, bandedVertices: 0 })
      expect(w.world.treeMode).toBe('retail')
      expect(treesState(w.world)).toBe('retail')
      expect(formatTreesCounters(w.world)).toEqual(['trees     retail'])
      expect(formatTreesToggle(off)).toMatch(/no leftovers$/)
      retail.push(treeSceneCounts(w.scene))
      const on = await toggleTrees(w.world, 'new', wait, 5_000)
      expect(on.problems).toEqual([])
      expect(w.world.trees).not.toBeNull()
      await nearPine(w)
      const back = findTreeLeftovers(w.scene, w.world)
      expect(back).toMatchObject({ part: true, strayOverlay: 0, bandTexture: true })
      expect(back.bandedVertices).toBe(first.bandedVertices)
      expect(back.overlayMeshes).toBe(first.overlayMeshes)
    }
    // the same mode visited again holds the same scene (no leak per cycle)
    expect(treeCountGrowth(retail[0]!, retail[1]!)).toEqual([])
    expect(treeCountGrowth(retail[1]!, retail[2]!)).toEqual([])
  })

  it('?trees=retail at load: no part, no banded vertex; the Classic path never swaps (the Low guard)', async () => {
    const r = await treesWorld({ trees: 'retail' })
    await r.run()
    expect(r.world.trees).toBeNull()
    const rl = findTreeLeftovers(r.scene, r.world)
    expect(treeLeftoverProblems(rl, false)).toEqual([])
    expect(rl.bandedVertices).toBe(0)
    const c = await treesWorld({ render: 'classic' })
    await c.run()
    expect(c.world.trees).toBeNull()
    expect(treesState(c.world)).toBe('new, not applied: the Classic path draws retail (the Low guard)')
    const t = await toggleTrees(c.world, 'retail', () => c.run(), 5_000)
    expect(t.problems).toEqual([])
    const back = await toggleTrees(c.world, 'new', () => c.run(), 5_000)
    expect(back.problems).toEqual([])
    expect(c.world.trees).toBeNull()
    expect(findTreeLeftovers(c.scene, c.world)).toMatchObject({ part: false, overlayMeshes: 0, bandedVertices: 0, bandTexture: false })
  })
})

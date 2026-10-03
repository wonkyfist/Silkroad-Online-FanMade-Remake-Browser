/**
 * GL-F, the cull and the field's meshes (docs/GRASS_LIFE.md §2.3, §2.4, §3.3, §8.3; BATCHING §3.6): tiers by cell
 * distance per level; the frustum test on each cell's box; empty cells skipped; three meshes (one draw per tier) tagged
 * 'scatter', no casters, no picking; a tier with no cell is hidden with `isVisible` and never `setEnabled` (so wave 9's
 * EnabledMeshCandidates does not rebuild while walking the grass edge, H-GL lens 17) and a visible tier never has 0
 * instances (never drawn at the origin, lens 12); an unchanged cull uploads nothing; Off hides everything; the World
 * makes the real field on the PBR path only (the Low guard).
 */
import { FreeCamera, Frustum, Vector3, type Plane } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GRASS_LEVELS, cellTier, cullGrass, grassCullOut, type GrassLevel } from '../src/grass/cull.ts'
import { GrassField } from '../src/grass/field.ts'
import { grassFieldOf } from '../src/grass/index.ts'
import { GRASS_CELL_M } from '../src/grass/shaders.ts'
import { GRASS_WINDOW_CELLS } from '../src/grass/window.ts'
import { SCATTER_TAG } from '../src/grass/types.ts'
import { EnabledMeshCandidates } from '../src/render/active-meshes.ts'
import { T, fieldRig, region, type FieldRig } from './grass-fixture.ts'
import { w10World, type W10Setup } from './w10-fixture.ts'

const rigs: FieldRig[] = []
const worlds: W10Setup[] = []
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose()
  for (const w of worlds.splice(0)) w.dispose()
  vi.restoreAllMocks()
})

function rig(o: Parameters<typeof fieldRig>[0] = {}): FieldRig {
  const r = fieldRig(o)
  rigs.push(r)
  return r
}

/** A window stand-in: every cell grassy at height 0 (or as `grassy` says). */
function flatWindow(grassy: (cx: number, cz: number) => boolean = () => true) {
  const C = GRASS_WINDOW_CELLS
  const cellMax = new Float32Array(C * C)
  const cellY = new Float32Array(C * C * 2)
  for (let cz = 0; cz < C; cz++) for (let cx = 0; cx < C; cx++) cellMax[cz * C + cx] = grassy(cx, cz) ? 1 : 0
  return { x0: -128, z0: -128, cellMax, cellY }
}

function cellDistance(cx: number, cz: number, x: number, z: number): number {
  const minX = -128 + cx * 8, minZ = -128 + cz * 8
  const dx = x < minX ? minX - x : x > minX + 8 ? x - minX - 8 : 0
  const dz = z < minZ ? minZ - z : z > minZ + 8 ? z - minZ - 8 : 0
  return Math.hypot(dx, dz)
}

describe('the cell cull (GRASS_LIFE §2.3, §3.3)', () => {
  it('tiers by cell distance per level: Medium 14 / 32 / 58 m, High 20 / 46 / 82 m, Low 0.6 × Medium', () => {
    const tiers = (l: GrassLevel) => [5, 13.9, 14, 31.9, 32, 57.9, 58].map(d => cellTier(d, l))
    expect(tiers(GRASS_LEVELS.medium!)).toEqual([0, 0, 1, 1, 2, 2, -1])
    expect([19.9, 20, 45.9, 46, 81.9, 82].map(d => cellTier(d, GRASS_LEVELS.high!))).toEqual([0, 1, 1, 2, 2, -1])
    const low = GRASS_LEVELS.low!
    expect([low.near, low.mid, low.far].map(v => Math.round(v))).toEqual([8, 19, 35])
  })

  for (const name of ['low', 'medium', 'high'] as const) {
    it(`${name}: every grassy cell within the far tier is drawn once, in its tier; empty cells never`, () => {
      const level = GRASS_LEVELS[name]!
      const win = flatWindow((cx, cz) => (cx + cz) % 5 !== 0)
      const out = grassCullOut()
      const cam = { x: 3.3, z: -7.1 }
      cullGrass(win, cam.x, cam.z, level, null, out)
      const want = [0, 0, 0]
      for (let cz = 0; cz < GRASS_WINDOW_CELLS; cz++) {
        for (let cx = 0; cx < GRASS_WINDOW_CELLS; cx++) {
          if ((cx + cz) % 5 === 0) continue
          const t = cellTier(cellDistance(cx, cz, cam.x, cam.z), level)
          if (t >= 0) want[t]!++
        }
      }
      expect(out.counts).toEqual(want)
      // The instances are the cells' corners, on the 8 m grid.
      for (let t = 0; t < 3; t++) {
        for (let i = 0; i < out.counts[t]!; i++) {
          const b = out.buffers[t]!
          expect(((b[i * 16 + 12]! % GRASS_CELL_M) + GRASS_CELL_M) % GRASS_CELL_M).toBe(0)
          expect(b[i * 16 + 15]).toBe(1)
        }
      }
    })
  }

  it('the frustum: cells behind the camera are skipped, cells the view touches kept', () => {
    const r = rig()
    const cam = new FreeCamera('c', new Vector3(0, 5, 0), r.scene)
    cam.setTarget(new Vector3(40, 0, 0))
    cam.fov = 0.85
    r.scene.activeCamera = cam
    const planes = (r.field as unknown as { planes: Plane[] }).planes
    Frustum.GetPlanesToRef(cam.getViewMatrix().multiply(cam.getProjectionMatrix()), planes)
    const win = flatWindow()
    const out = grassCullOut()
    cullGrass(win, 0, 0, GRASS_LEVELS.medium!, planes, out)
    const all = grassCullOut()
    cullGrass(win, 0, 0, GRASS_LEVELS.medium!, null, all)
    const total = (o: typeof out) => o.counts[0] + o.counts[1] + o.counts[2]
    expect(total(out)).toBeGreaterThan(10)
    expect(total(out)).toBeLessThan(total(all) * 0.6)
    for (let t = 0; t < 3; t++) for (let i = 0; i < out.counts[t]!; i++) expect(out.buffers[t]![i * 16 + 12]! + 8 + 0.6).toBeGreaterThan(0)
    // The cells just in front of the camera (their boxes reach the lowest view ray, ≈ 6 m ahead at 1.2 m up) are kept.
    let front = 0
    for (let i = 0; i < out.counts[0]!; i++) if (out.buffers[0]![i * 16 + 12] === 0 && Math.abs(out.buffers[0]![i * 16 + 14]! + 4) <= 4) front++
    expect(front).toBe(2)
  })
})

describe('the field\'s meshes (BATCHING §3.6: ≤ 3 draws + GRASS_FAR\'s 3 ring draws, hidden at count 0, never drawn at the origin)', () => {
  /** A grass region west of x = 0 and a road region east of it (one row of regions along z −192..0). */
  function twoRegions(r: FieldRig) {
    r.field.addRegion(region({ id: 1, ox: -192, oz: 0 }))
    r.field.addRegion(region({ id: 2, ox: 0, oz: 0, base: T.road }))
  }

  function walk(r: FieldRig, cam: FreeCamera, xs: number[], onFrame?: () => void) {
    for (const x of xs) {
      cam.position.set(x, 3, -96)
      cam.setTarget(new Vector3(x + 20, 0, -96))
      r.field.update({ x, y: 3, z: -96 })
      onFrame?.()
    }
  }

  it('three meshes (and the meadow ring\'s three) tagged \'scatter\', no picking, no shadows; hidden with isVisible at count 0 (never setEnabled); visible ⇒ instances > 0', () => {
    const r = rig()
    twoRegions(r)
    const cam = new FreeCamera('c', new Vector3(-96, 3, -96), r.scene)
    r.scene.activeCamera = cam
    const meshes = r.field.meshes()
    expect(meshes.length).toBe(6)
    const enabled = meshes.map(m => vi.spyOn(m, 'setEnabled'))
    for (const m of meshes) {
      expect(m.metadata.sroWorld).toBe(SCATTER_TAG)
      expect(m.isPickable).toBe(false)
      expect(m.receiveShadows).toBe(false)
      expect(m.alwaysSelectAsActiveMesh).toBe(true)
      expect(m.material).toBe((m.metadata as { grassRing?: number }).grassRing === undefined ? r.field.material : r.field.ringMaterial)
    }
    // Bake everything (the urgent budget near the camera), then walk from the grass into the road.
    for (let i = 0; i < 400 && r.field.stats.pending; i++) r.field.update({ x: -96, y: 3, z: -96 })
    expect(r.field.stats.pending).toBe(0)
    let sawHidden = false, sawShown = false
    walk(r, cam, Array.from({ length: 120 }, (_, i) => -120 + i * 2), () => {
      for (const m of meshes) {
        if (m.isVisible) {
          sawShown = true
          expect(m.thinInstanceCount).toBeGreaterThan(0)
        } else sawHidden = true
        expect(m.isEnabled()).toBe(true)
      }
    })
    expect(sawShown && sawHidden).toBe(true)
    for (const s of enabled) expect(s).not.toHaveBeenCalled()
    // Walking the grass edge never rebuilds the enabled-mesh list.
    const list = new EnabledMeshCandidates(r.scene)
    list.candidates()
    const rebuilds = list.rebuilds
    walk(r, cam, Array.from({ length: 80 }, (_, i) => 60 - i * 2), () => list.candidates())
    expect(list.rebuilds).toBe(rebuilds)
    list.dispose()
  })

  it('an unchanged cull uploads nothing; a moved camera does', () => {
    const r = rig()
    twoRegions(r)
    const cam = new FreeCamera('c', new Vector3(-96, 3, -96), r.scene)
    cam.setTarget(new Vector3(-60, 0, -96))
    r.scene.activeCamera = cam
    for (let i = 0; i < 400 && (r.field.stats.pending || !r.field.ringSettled); i++) r.field.update({ x: -96, y: 3, z: -96 })
    r.field.update({ x: -96, y: 3, z: -96 })
    const u = r.field.stats.uploads
    const upd = r.field.meshes().map(m => vi.spyOn(m, 'thinInstanceBufferUpdated'))
    for (let i = 0; i < 10; i++) r.field.update({ x: -96, y: 3, z: -96 })
    expect(r.field.stats.uploads).toBe(u)
    for (const s of upd) expect(s).not.toHaveBeenCalled()
    walk(r, cam, [-40])
    expect(r.field.stats.uploads).toBeGreaterThan(u)
    expect(r.field.stats.cells.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
    expect(r.field.stats.vertices).toBeGreaterThan(0)
  })

  it('Off hides every mesh; High rebuilds the patches (74 blades/m²) in the same meshes', () => {
    const r = rig()
    twoRegions(r)
    const cam = new FreeCamera('c', new Vector3(-96, 3, -96), r.scene)
    r.scene.activeCamera = cam
    for (let i = 0; i < 400 && r.field.stats.pending; i++) r.field.update({ x: -96, y: 3, z: -96 })
    const meshes = [...r.field.meshes()]
    const near = meshes[0]!.getTotalVertices()
    r.field.setLevel('off')
    for (const m of meshes) expect(m.isVisible).toBe(false)
    r.field.update({ x: -96, y: 3, z: -96 })
    for (const m of meshes) expect(m.isVisible).toBe(false)
    r.field.setLevel('high')
    expect(r.field.meshes()).toEqual(meshes)
    expect(meshes[0]!.getTotalVertices()).toBe(34_272)
    expect(near).toBe(21_252)
    r.field.update({ x: -96, y: 3, z: -96 })
    expect(meshes.some(m => m.isVisible)).toBe(true)
  })

  it('dispose leaves no mesh, material or texture behind', () => {
    const r = rig()
    twoRegions(r)
    const before = { meshes: r.scene.meshes.length, materials: r.scene.materials.length, textures: r.scene.textures.length }
    r.field.dispose()
    expect(r.scene.meshes.length).toBe(before.meshes - 6)
    expect(r.scene.materials.length).toBe(before.materials - 2)
    expect(r.scene.textures.length).toBe(before.textures - 4)
  })
})

describe('the World makes the real field (PBR only: the Low guard)', () => {
  it('Medium on the PBR path draws GrassField; the Classic path keeps the retail scatter and makes none', async () => {
    const pbr = await w10World({ render: 'pbr', grassStyle: 'field' })
    worlds.push(pbr)
    await pbr.run()
    expect(pbr.world.scatter.style).toBe('field')
    const g = grassFieldOf(pbr.world.scatter)
    expect(g).toBeInstanceOf(GrassField)
    expect((g as GrassField).stats.regions).toBe(pbr.stream.stats.ready)
    expect(pbr.world.retailTuftsHidden).toBe(true)
    // The field's material follows the facade (a later shared value and define reach it).
    expect(pbr.world.scatter.adopts((g as GrassField).material)).toBe(true)
    const classic = await w10World({ render: 'classic', grassStyle: 'field' })
    worlds.push(classic)
    await classic.run()
    expect(classic.world.scatter.style).toBe('retail')
    expect(grassFieldOf(classic.world.scatter)).toBeNull()
    expect(classic.scene.meshes.some(m => m.name.startsWith('grass_field'))).toBe(false)
    // A live switch to Classic drops the field and its meshes.
    pbr.world.setRenderMode('classic')
    expect(grassFieldOf(pbr.world.scatter)).toBeNull()
    expect(pbr.scene.meshes.some(m => m.name.startsWith('grass_field') && !m.isDisposed())).toBe(false)
  })
})

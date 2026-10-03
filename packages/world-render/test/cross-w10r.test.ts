/**
 * I-10R, the cross-item tests of docs/WAVE_PLAN6.md §6.3 (the five wave-10 items in one NullEngine world):
 * - S-DRAW: a placement the converter's C9 drops (passes.ts applyPlacementEdits) is offered to no region batch, loads
 *   no static variant and carries no perch;
 * - the retail-tuft filter runs before the claim on the PBR path, and never on Low (the Classic path), live both ways;
 * - no 'scatter' / 'life' / 'ocean' mesh is ever claimed or merged, with the real grass field, wildlife and ocean on;
 * - World.waterLevelAt: +5 m over the real coast field's sea mask, the block plane in a moat, null on dry ground;
 * - a live Low <-> Medium switch with all five items on leaves no batch, grass field, life pool or ocean leftovers.
 * The stage world's part (batching, life without ground flocks, the ocean switch, the create cap reaching the batch) is
 * in apps/game/test/stage-host.test.ts.
 */
import { Vector3, type AbstractMesh, type Scene } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import { applyPlacementEdits } from '../../convert/src/world/passes.ts'
import type { BatchFactory, BatchModelSource } from '../src/index.ts'
import { createOceanPart, SroOcean } from '../src/ocean/index.ts'
import { lifePlacesOf } from '../src/life/spawn.ts'
import { CX, CZ } from './stream-fixture.ts'
import { SEA_LEVEL, SHORE_X, addCoast } from './ocean-fixture.ts'
import { FakeBatch, TUFT_SOURCE, addModel, w10World, type W10Options, type W10Setup } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

async function world(o: W10Options = {}): Promise<W10Setup> {
  vi.spyOn(console, 'warn').mockImplementation(() => {}) // NullEngine: no LUT grade, no clustered lights
  const s = await w10World(o)
  cleanups.push(s.dispose)
  return s
}

/** A FakeBatch that also records the (region, uid) of every placement it is offered. */
class UidBatch extends FakeBatch {
  readonly uids: string[] = []
  override claim(owner: number, source: BatchModelSource, placements: readonly WorldPlacement[]): readonly WorldPlacement[] {
    for (const p of placements) this.uids.push(`${p.region}:${p.uid}`)
    return super.claim(owner, source, placements)
  }

  /** The fake's slot materials go with their batch (the real batch frees its group materials, region-batch.test.ts). */
  override removeRegion(owner: number): void {
    for (const slot of this.live.get(owner)?.slots ?? []) slot.material.dispose()
    super.removeRegion(owner)
  }
}

function uidFactory() {
  const made: UidBatch[] = []
  const factory: BatchFactory = host => {
    const b = new UidBatch(host.scene)
    made.push(b)
    return b
  }
  return { made, factory }
}

const CENTRE_ID = (CZ << 8) | CX
const TAGS = ['scatter', 'life', 'ocean']
const tagOf = (m: AbstractMesh) => (m.metadata as { sroWorld?: string } | null)?.sroWorld

describe('S-DRAW: a C9-dropped placement is drawn nowhere (converter + world)', () => {
  it('no region batch is offered it, its static variant never loads, and it carries no perch', async () => {
    let building = -1, tree = -1, variant = -1, wall = -1
    const dropped: string[] = []
    const f = uidFactory()
    const s = await world({
      parts: { batch: f.factory, life: null, ocean: null },
      edit: fx => {
        const m = fx.manifest
        // A house (its roof carries perches), a skinned tree with its static variant and a wall, in the centre region.
        const only = (id: number) => id === CENTRE_ID
        building = addModel(fx, 'res\\bldg\\china\\jangan\\cj_house_test.bsr', { regions: only })
        Object.assign(m.models[building]!, { boundsMin: [-6, 0, -3], boundsMax: [6, 6, 3] })
        variant = addModel(fx, 'res\\nature\\common\\tree\\tre_test_static.bsr', { regions: () => false })
        tree = addModel(fx, 'res\\nature\\common\\tree\\tre_test.bsr', { kind: 'skinned', regions: only })
        ;(m.models[tree] as WorldModel).staticVariant = variant
        wall = addModel(fx, 'res\\bldg\\china\\jangan\\cj_wall_test.bsr', { regions: only })
        // The converter's C9 drops all three (passes.ts applies it before the static-variant and grass passes).
        const drop = m.placements.filter(p => p.models.some(i => i === building || i === tree || i === wall))
        expect(drop.length).toBe(3)
        for (const p of drop) dropped.push(`${p.region}:${p.uid}`)
        const warnings: string[] = []
        const out = applyPlacementEdits(m.placements, { drop: drop.map(p => ({ region: p.region, uid: p.uid })), resnap: [], add: [] }, m.models.length, warnings)
        expect(warnings).toEqual([])
        expect(out.report.dropped.length).toBe(3)
        m.placements = out.placements
      },
    })
    await s.run()
    const b = f.made[0]!
    expect(b.uids.length).toBeGreaterThan(0) // the fixture's own placements are batched
    for (const k of dropped) expect(b.uids).not.toContain(k)
    expect(b.offered).not.toContain(building)
    expect(b.offered).not.toContain(tree)
    expect(b.offered).not.toContain(wall)
    for (const i of [building, tree, variant, wall]) expect(s.models.loads).not.toContain(i)
    for (const batch of b.live.values()) for (const slot of batch.slots) expect([building, tree, variant, wall]).not.toContain(slot.model.index)
    expect(lifePlacesOf(s.world.manifest).perches.count).toBe(0)
    expect(lifePlacesOf(s.world.manifest).trees.count).toBe(0)
  })

  it('the same placements kept: the batch is offered them and the house carries perches (the test can fail)', async () => {
    let building = -1
    const f = uidFactory()
    const s = await world({
      parts: { batch: f.factory, life: null, ocean: null },
      edit: fx => {
        building = addModel(fx, 'res\\bldg\\china\\jangan\\cj_house_test.bsr', { regions: id => id === CENTRE_ID })
        Object.assign(fx.manifest.models[building]!, { boundsMin: [-6, 0, -3], boundsMax: [6, 6, 3] })
      },
    })
    await s.run()
    expect(f.made[0]!.offered).toContain(building)
    expect(lifePlacesOf(s.world.manifest).perches.count).toBe(2)
  })
})

describe('the retail-tuft filter: before the claim on PBR, never on Low', () => {
  it('Classic places the tufts (no batcher); PBR hides them before any claim; back on Classic they are placed again', async () => {
    let tuft = -1
    const f = uidFactory()
    const s = await world({
      render: 'classic', grassStyle: 'field', parts: { batch: f.factory, life: null, ocean: null },
      edit: fx => {
        tuft = addModel(fx, TUFT_SOURCE)
      },
    })
    await s.run()
    expect(s.world.retailTuftsHidden).toBe(false)
    expect(s.world.scatter.style).toBe('retail')
    expect(s.models.loads).toContain(tuft)
    expect(f.made.length).toBe(0)
    const tuftMeshes = () => s.world.objects.meshes().filter(m => m.name.includes(`box${tuft}`) || m.name.includes(`m${tuft}`))
    expect(s.world.objects.stats.chunks).toBeGreaterThan(0)

    s.world.setRenderMode('pbr')
    await s.run()
    expect(s.world.retailTuftsHidden).toBe(true)
    const b = f.made[0]!
    expect(b.offered.length).toBeGreaterThan(0)
    expect(b.offered).not.toContain(tuft)
    expect(tuftMeshes().length).toBe(0)

    s.world.setRenderMode('classic')
    await s.run()
    expect(s.world.retailTuftsHidden).toBe(false)
    expect(s.world.batch).toBeNull()
    expect(b.released).toBeGreaterThan(0)
    expect(s.world.objects.stats.chunks).toBeGreaterThan(0)
  })
})

/** A world with all five items: a recording batch, the real grass field, the real wildlife and the real ocean. */
async function fiveWorld(): Promise<{ s: W10Setup; f: ReturnType<typeof uidFactory> }> {
  const f = uidFactory()
  const s = await world({
    render: 'pbr', quality: 'medium', grassStyle: 'field',
    parts: { batch: f.factory, ocean: host => createOceanPart(host, { worker: false }) },
    edit: fx => {
      addCoast(fx)
      addModel(fx, TUFT_SOURCE)
    },
  })
  await s.run()
  await (s.world.ocean as SroOcean).loaded
  return { s, f }
}

/** Drives one frame of the world's parts the way World.update does (no render loop on the NullEngine). */
function frame(s: W10Setup, scene: Scene) {
  const cam = scene.activeCamera!
  cam.getViewMatrix(true)
  s.world.ocean?.update(cam, 1 / 60)
  s.world.life?.update(cam, 1 / 60)
}

describe('all five items together', () => {
  it('no scatter, life or ocean mesh is ever claimed or merged (the real grass field, wildlife and ocean)', async () => {
    const { s, f } = await fiveWorld()
    expect(s.world.batch).toBe(f.made[0])
    expect(s.world.scatter.groundCover).not.toBeNull()
    expect(s.world.life).not.toBeNull()
    expect(s.world.ocean).toBeInstanceOf(SroOcean)
    const b = f.made[0]!
    const merged = new Set(b.meshes())
    for (const m of [...(s.world.scatter.groundCover?.meshes() ?? []), ...(s.world.life?.meshes() ?? []), ...(s.world.ocean?.meshes() ?? [])]) {
      expect(TAGS).toContain(tagOf(m))
      expect(merged.has(m)).toBe(false)
    }
    // The batcher was offered only models that are not ground cover (the tufts are filtered) or tagged meshes.
    for (const i of b.offered) expect(s.fx.manifest.models[i]!.source).not.toBe(TUFT_SOURCE)
    for (const m of s.world.objects.meshes()) expect(TAGS).not.toContain(tagOf(m))
  })

  it('World.waterLevelAt: +5 m over the sea mask, the block plane in a moat, null on dry ground', async () => {
    const s = await world({
      render: 'pbr',
      parts: { batch: null, life: null, ocean: host => createOceanPart(host, { worker: false }) },
      edit: fx => {
        addCoast(fx)
        const r = fx.manifest.regions.find(x => x.id === CENTRE_ID)!
        r.blocks[0]!.water = { kind: 'water', type: 1, wave: 0, heightM: 3 }
      },
    })
    await s.run()
    await (s.world.ocean as SroOcean).loaded
    const r = s.fx.manifest.regions.find(x => x.id === CENTRE_ID)!
    const [x0, y0, z0] = r.origin
    expect(s.world.waterLevelAt(SHORE_X + 50, 0)).toBe(SEA_LEVEL)
    expect(SEA_LEVEL).toBe(5)
    expect(s.world.waterLevelAt(x0 + 5, z0 - 5)).toBe(y0 + 3)
    expect(s.world.waterLevelAt(x0 + 100, z0 - 100)).toBeNull()
  })

  it('a live Low <-> Medium switch leaves no batch, grass field, life pool or ocean leftovers', async () => {
    const { s, f } = await fiveWorld()
    const scene = s.scene
    const { FreeCamera } = await import('@babylonjs/core')
    const cam = new FreeCamera('cam', new Vector3(SHORE_X + 60, 25, -50), scene)
    cam.maxZ = 2000
    cam.setTarget(new Vector3(SHORE_X + 400, 0, -50))
    scene.activeCamera = cam
    for (let i = 0; i < 3; i++) frame(s, scene)
    const ocean = s.world.ocean as SroOcean
    expect(ocean.stats.path).toBe('pbr')
    // The shore's lace is generated in slices after the field loads: wait for it (it is made once per ocean).
    const shore = () => (ocean as unknown as { shore: { ready: boolean } | null }).shore
    for (let i = 0; i < 4000 && !shore()?.ready; i++) await new Promise(r => setTimeout(r, 0))
    expect(shore()?.ready).toBe(true)
    const snap = () => ({
      meshes: scene.meshes.length,
      materials: scene.materials.map(m => `${m.getClassName()}:${m.name}`).sort(),
      // Not counted: the NullEngine's failed 3D LUT (RenderPost.ensureGrade: Babylon adds the RawTexture3D to the
      // scene before its upload throws; on a GPU the grade is made once and disposed with the post stack).
      textures: scene.textures.filter(t => t.name || t.getSize().width > 0).map(t => t.name).sort(),
    })
    let before = snap()
    const batchMeshes = f.made[0]!.meshes().length
    expect(batchMeshes).toBeGreaterThan(0)
    const tagged = (t: string) => scene.meshes.filter(m => tagOf(m) === t && !m.isDisposed()).length
    const grassBefore = s.world.scatter.groundCover!.meshes().length
    const lifeBefore = s.world.life!.meshes().length

    for (let round = 0; round < 2; round++) {
      // Low: the Classic path and the Low preset, as WorldGraphics applies them.
      s.world.setRenderMode('classic')
      s.world.setQuality('low')
      await s.run()
      for (let i = 0; i < 3; i++) frame(s, scene)
      expect(s.world.batch).toBeNull()
      expect(s.world.objects.batcher).toBeNull()
      for (const b of f.made) expect(b.meshes().length).toBe(0)
      expect(scene.meshes.some(m => m.name.startsWith('batch:'))).toBe(false)
      expect(s.world.scatter.groundCover).toBeNull()
      expect(s.world.scatter.style).toBe('retail')
      expect(s.world.retailTuftsHidden).toBe(false)
      expect(s.world.life).toBeNull()
      expect(tagged('life')).toBe(0)
      expect(scene.meshes.some(m => tagOf(m) === 'scatter' && (m.metadata as { grassLod?: unknown }).grassLod !== undefined)).toBe(false)
      expect(s.world.ocean).toBe(ocean)
      expect(ocean.stats.path).toBe('classic')
      expect(tagged('ocean')).toBe(1)

      // Medium again: one of each, and nothing more than before the round.
      s.world.setRenderMode('pbr')
      s.world.setQuality('medium')
      await s.run()
      for (let i = 0; i < 3; i++) frame(s, scene)
      expect(s.world.batch).toBe(f.made.at(-1))
      expect(f.made.at(-1)!.meshes().length).toBe(batchMeshes)
      expect(s.world.scatter.groundCover).not.toBeNull()
      expect(s.world.scatter.groundCover!.meshes().length).toBe(grassBefore)
      expect(s.world.retailTuftsHidden).toBe(true)
      expect(s.world.life).not.toBeNull()
      expect(s.world.life!.meshes().length).toBe(lifeBefore)
      expect(ocean.stats.path).toBe('pbr')
      expect(tagged('ocean')).toBe(1)
      const after = snap()
      if (round === 0) {
        // The first visit to Low makes three things that stay cached for the next one: the Classic ocean's Gerstner
        // material and the Classic terrain's shared white and black textures. Nothing else is new.
        const extra = (a: string[], b: string[]) => {
          const left = [...b]
          for (const x of a) left.splice(left.indexOf(x), left.includes(x) ? 1 : 0)
          return left
        }
        expect(after.meshes).toBe(before.meshes)
        expect(extra(before.materials, after.materials)).toEqual(['ShaderMaterial:oceanClassic'])
        expect(extra(before.textures, after.textures).sort()).toEqual(['terrainChunkBlack', 'white'])
        expect(extra(after.materials, before.materials)).toEqual([])
        before = after
      } else expect(after).toEqual(before) // the second round adds nothing at all

    }
  })
})

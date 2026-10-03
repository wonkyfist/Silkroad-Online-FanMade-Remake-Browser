/**
 * W12-SA, S-OBJ and S-FILTER (docs/WORLD_EDITOR.md §2.3, §9.3 items 1–3; docs/WAVE_PLAN8.md §4.2 steps 1, 4, §5.3):
 * - `WorldObjects.setEditorOwned(pred)` keeps the editor's placements out of their region (chunks, clones, batch);
 * - `RegionStreamer.reloadObjects(rx, rz)` places one region's objects again (re-batched through the merge path), the
 *   old set swapped out for the new one in one turn, the other regions untouched; a new placement list (the editor's
 *   moves, adds and deletes) is kept for later stream-ins; an unload during a reload leaves nothing; on Classic too;
 * - `LoadWorldOptions.regionFilter` reaches every region's decoded data before its terrain is built (S-FILTER).
 */
import { MeshBuilder, PBRMaterial, Vector3, type AbstractMesh, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import { prepareStatic, type RegionBatch, type RegionData, type RegionListener } from '../src/index.ts'
import { CX, CZ, centre, isTreeMesh, objectWorld, pumpUntil, type ObjectWorld, type ObjectWorldOptions } from './w12-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

async function made(o: ObjectWorldOptions = {}): Promise<ObjectWorld> {
  const w = await objectWorld(o)
  cleanups.push(() => w.dispose())
  return w
}

const CENTRE_ID = (CZ << 8) | CX

/** A listener that logs every event by owner. */
function recorder(w: ObjectWorld) {
  const log: Array<{ ev: 'placed' | 'removed' | 'batched'; owner: number; model?: number; uids?: number[]; batch?: RegionBatch }> = []
  const l: RegionListener = {
    placed: (owner, model, _info, _meshes, placements) => log.push({ ev: 'placed', owner, model: model.index, uids: placements.map(p => p.uid) }),
    removed: owner => log.push({ ev: 'removed', owner }),
    batched: (owner, batch) => log.push({ ev: 'batched', owner, batch }),
  }
  const off = w.world.objects.addRegionListener(l)
  log.length = 0
  return { log, off }
}

/** The chunk of the centre region. */
const centreChunk = (w: ObjectWorld) => w.stream.chunk(CX, CZ)!

/** The centre region's wall placement (model 0) and its skinned prop (model 1). */
const centrePlacement = (w: ObjectWorld, model: number): WorldPlacement =>
  w.fx.manifest.placements.find(p => p.region === CENTRE_ID && p.models[0] === model)!

const wallMeshes = (batch: RegionBatch): AbstractMesh[] => batch.meshes.filter(m => !isTreeMesh(m))

describe('S-OBJ: one region placed again, the others untouched (PBR, batched)', () => {
  it('an editor-owned wall leaves the centre region\'s batch; the other regions keep their batch objects', async () => {
    const w = await made()
    await w.run()
    const objects = w.world.objects
    const chunk = centreChunk(w)
    const old = chunk.objectsOwner
    expect(old).toBe(chunk.owner)
    const before = new Map(objects.regionBatches)
    const oldBatch = before.get(old)!
    expect(wallMeshes(oldBatch).length).toBe(1)
    const rec = recorder(w)
    const wall = centrePlacement(w, 0)
    objects.setEditorOwned(p => p === wall)
    const { value, updates } = await pumpUntil(w, w.stream.reloadObjects(CX, CZ))
    expect(value).toBe(true)
    expect(updates).toBeLessThanOrEqual(10)
    // The centre region has a new owner and a new batch without the wall; its old batch is gone (meshes disposed).
    const owner = chunk.objectsOwner
    expect(owner).not.toBe(old)
    expect(objects.regionBatches.has(old)).toBe(false)
    const batch = objects.regionBatches.get(owner)!
    expect(wallMeshes(batch).length).toBe(0)
    expect(batch.meshes.filter(isTreeMesh).length).toBe(2)
    for (const m of oldBatch.meshes) expect(m.isDisposed()).toBe(true)
    for (const m of batch.meshes) expect(m.isDisposed()).toBe(false)
    // Every other region: the same batch object, its meshes alive.
    for (const [o, b] of before) {
      if (o === old) continue
      expect(objects.regionBatches.get(o)).toBe(b)
      for (const m of b.meshes) expect(m.isDisposed()).toBe(false)
    }
    // The listeners heard the new owner's placements (no wall), its batch, then the old owner's removal: nothing else.
    expect(rec.log.every(e => e.owner === owner || e.owner === old)).toBe(true)
    expect(rec.log.filter(e => e.ev === 'removed')).toEqual([{ ev: 'removed', owner: old }])
    expect(rec.log.filter(e => e.ev === 'placed').flatMap(e => e.uids!)).not.toContain(wall.uid)
    expect(rec.log.filter(e => e.ev === 'placed' && e.model === 0).length).toBe(0)
    expect(rec.log.filter(e => e.ev === 'batched').map(e => e.owner)).toEqual([owner])
    expect(rec.log.findIndex(e => e.ev === 'batched')).toBeLessThan(rec.log.findIndex(e => e.ev === 'removed'))
    // Owned no more: the wall comes back with the next reload.
    objects.setEditorOwned(null)
    expect((await pumpUntil(w, w.stream.reloadObjects(CX, CZ))).value).toBe(true)
    expect(wallMeshes(objects.regionBatches.get(chunk.objectsOwner)!).length).toBe(1)
    rec.off()
  })

  it('the editor-owned skinned prop: no clone while owned; back after', async () => {
    const w = await made()
    await w.run()
    const objects = w.world.objects
    expect(objects.stats.clones).toBe(1)
    const prop = centrePlacement(w, 1)
    objects.setEditorOwned(p => p.uid === prop.uid && p.region === prop.region)
    expect(objects.isEditorOwned(prop, w.fx.manifest.models[1]!)).toBe(true)
    await pumpUntil(w, w.stream.reloadObjects(CX, CZ))
    expect(objects.stats.clones).toBe(0)
    objects.setEditorOwned(null)
    await pumpUntil(w, w.stream.reloadObjects(CX, CZ))
    expect(objects.stats.clones).toBe(1)
  })

  it('an unchanged animated clone is kept (the same instance, its clip running), heard placed under the new owner', async () => {
    const w = await made()
    await w.run()
    const objects = w.world.objects
    const holder = () => w.scene.transformNodes.find(n => /^models\/m1\.glb#\d+$/.test(n.name) && !n.isDisposed())
    const before = holder()!
    expect(before).toBeTruthy()
    const old = centreChunk(w).objectsOwner
    expect([...objects.clonePlacements(old)]).toEqual([centrePlacement(w, 1)])
    const rec = recorder(w)
    // An unrelated edit (the wall owned) re-places the region: the prop's clone moves over as it is.
    const wall = centrePlacement(w, 0)
    objects.setEditorOwned(p => p === wall)
    await pumpUntil(w, w.stream.reloadObjects(CX, CZ))
    const owner = centreChunk(w).objectsOwner
    expect(holder()).toBe(before)
    expect(before.isDisposed()).toBe(false)
    expect(before.isEnabled()).toBe(true)
    expect(objects.stats.clones).toBe(1)
    expect([...objects.clonePlacements(owner)]).toEqual([centrePlacement(w, 1)])
    expect(objects.clonePlacements(old).size).toBe(0)
    expect(rec.log.filter(e => e.ev === 'placed' && e.model === 1).map(e => e.owner)).toEqual([owner])
    rec.off()
  })

  it('the \'objects\' commit steps of the reloaded region run again (night splat, shadow proxy), the others\' do not', async () => {
    const w = await made()
    await w.run()
    const runs = new Map<number, number>()
    w.world.addCommitStep('count', r => runs.set(r.region.id, (runs.get(r.region.id) ?? 0) + 1), 'objects')
    await w.run()
    const before = new Map(runs)
    await pumpUntil(w, w.stream.reloadObjects(CX, CZ))
    await w.run()
    for (const [id, n] of runs) expect(n, `region ${id}`).toBe((before.get(id) ?? 0) + (id === CENTRE_ID ? 1 : 0))
  })

  it('a new placement list (a moved wall, an added one) is used now and kept for the region\'s next load', async () => {
    const w = await made()
    await w.run()
    const objects = w.world.objects
    const wall = centrePlacement(w, 0)
    const list = w.fx.manifest.placements.filter(p => p.region === CENTRE_ID && p !== wall)
    const moved: WorldPlacement = { ...wall, position: [wall.position[0] + 20, wall.position[1], wall.position[2]] }
    const added: WorldPlacement = { ...wall, uid: 0xe000, position: [wall.position[0] - 30, wall.position[1], wall.position[2] - 10] }
    const { value } = await pumpUntil(w, w.stream.reloadObjects(CX, CZ, { placements: [...list, moved, added] }))
    expect(value).toBe(true)
    const batch = objects.regionBatches.get(centreChunk(w).objectsOwner)!
    const walls = wallMeshes(batch)
    expect(walls.length).toBe(1)
    const xs = (walls[0] as Mesh).getVerticesData('position')!.filter((_, i) => i % 3 === 0)
    expect(Math.min(...xs)).toBeLessThan(added.position[0] + 1)
    expect(Math.max(...xs)).toBeGreaterThan(moved.position[0] - 1)
    expect(Math.max(...xs)).toBeLessThan(moved.position[0] + 1)
    const info = w.stream.regions.find(r => r.id === CENTRE_ID)!
    expect(info.models.get(0)).toEqual([moved, added])
    expect(info.placements).toBe(list.length + 2)
    // Not resident: nothing to place now (false), the list is still kept.
    expect(await w.stream.reloadObjects(CX + 40, CZ)).toBe(false)
  })

  it('a reload asked while one runs folds into one more; a region still loading reloads once its objects are in', async () => {
    const w = await made()
    // Not loaded yet: the first update starts the region; the reload waits for its objects.
    w.stream.update(centre(CX, CZ), null)
    const early = w.stream.reloadObjects(CX, CZ)
    await w.run()
    expect((await pumpUntil(w, early)).value).toBe(true)
    const a = w.stream.reloadObjects(CX, CZ)
    const b = w.stream.reloadObjects(CX, CZ)
    const c = w.stream.reloadObjects(CX, CZ)
    const [ra, rb, rc] = await pumpUntil(w, Promise.all([a, b, c])).then(r => r.value)
    expect([ra, rb, rc]).toEqual([true, true, true])
    // One batch per resident region, still.
    expect(w.world.objects.regionBatches.size).toBe(w.stream.stats.ready)
  })

  it('an unload during a reload resolves false and leaves no mesh of either owner', async () => {
    const w = await made()
    await w.run()
    const chunk = centreChunk(w)
    const old = chunk.objectsOwner
    const p = w.stream.reloadObjects(CX, CZ)
    // Far away at once: the centre region goes before its reload swaps.
    const far = centre(CX + 40, CZ + 40)
    w.stream.setFocus(far.x, far.z)
    let result: boolean | undefined
    void p.then(v => {
      result = v
    })
    for (let i = 0; i < 50 && result === undefined; i++) {
      w.stream.update(far, null)
      await new Promise(r => setTimeout(r, 0))
    }
    expect(result).toBe(false)
    for (let i = 0; i < 20; i++) w.stream.update(far, null)
    const objects = w.world.objects
    expect(objects.regionBatches.has(old)).toBe(false)
    expect(objects.regionBatches.has(chunk.objectsOwner)).toBe(false)
    expect(w.scene.meshes.filter(m => m.name.startsWith(`batch:${chunk.objectsOwner}:`) && !m.isDisposed()).length).toBe(0)
    expect(w.scene.meshes.filter(m => m.name.startsWith(`batch:${old}:`) && !m.isDisposed()).length).toBe(0)
  })
})

describe('S-OBJ on Classic (Low: no batcher, chunks)', () => {
  it('the editor-owned wall leaves the region\'s chunks; the other regions\' chunks are the same meshes', async () => {
    const w = await made({ render: 'classic' })
    await w.run()
    const objects = w.world.objects
    const chunk = centreChunk(w)
    const wall = centrePlacement(w, 0)
    const old = chunk.objectsOwner
    // Chunk meshes are named `<mesh>@m<model>|<owner>|<group>|<cell>`.
    const ownerOf = (m: AbstractMesh) => Number(/@m\d+\|(\d+)\|/.exec(m.name)?.[1] ?? NaN)
    const others = objects.meshes().filter(m => m.name.includes('@m') && ownerOf(m) !== old)
    expect(others.length).toBeGreaterThan(0)
    const wallChunks = () => objects.meshes().filter(m => m.name.includes(`@m0|${chunk.objectsOwner}|`))
    expect(wallChunks().length).toBe(1)
    objects.setEditorOwned(p => p === wall)
    expect((await pumpUntil(w, w.stream.reloadObjects(CX, CZ))).value).toBe(true)
    expect(chunk.objectsOwner).not.toBe(old)
    expect(wallChunks().length).toBe(0)
    expect(objects.meshes().filter(m => ownerOf(m) === old).length).toBe(0)
    const now = new Set(objects.meshes())
    for (const m of others) {
      expect(m.isDisposed(), m.name).toBe(false)
      expect(now.has(m), m.name).toBe(true)
    }
  })

  it('a staged owner\'s chunks stay hidden until showRegion', () => {
    return (async () => {
      const w = await made({ render: 'classic' })
      await w.run()
      const objects = w.world.objects
      const src = MeshBuilder.CreateBox('stagedSrc', { size: 1 }, w.scene)
      src.material = new PBRMaterial('stagedMat', w.scene)
      const container = { meshes: [src], rootNodes: [], addAllToScene() {}, transformNodes: [] }
      const prep = prepareStatic(container as never)
      const model = { ...w.fx.manifest.models[0]!, index: 0 } as WorldModel
      const p = { ...centrePlacement(w, 0), uid: 0xe001 }
      objects.stageRegion(9999)
      objects.addStatic(9999, [0, 0], model, prep, [p])
      const mine = objects.meshes().filter(m => m.name.includes('@m0|9999|'))
      expect(mine.length).toBe(1)
      expect(mine[0]!.isEnabled(false)).toBe(false)
      objects.update(new Vector3(p.position[0], 0, p.position[2]), true)
      expect(mine[0]!.isEnabled(false)).toBe(false)
      objects.showRegion(9999)
      expect(mine[0]!.isEnabled(false)).toBe(true)
      objects.removeRegion(9999)
    })()
  })
})

describe('S-FILTER: the editor\'s layers reach the decoded region before its terrain is built', () => {
  it('runs once per decoded region, before the terrain build reads the heights; a throw is logged', async () => {
    const seen: number[] = []
    const filter = (rx: number, rz: number, data: RegionData) => {
      seen.push((rz << 8) | rx)
      expect(data.region.x).toBe(rx)
      expect(w.world.terrain.region(data.region.id)).toBeFalsy()
      // A 3 m raise over the whole region.
      const h = data.terrain.heights
      for (let i = 0; i < h.length; i++) h[i]! += 3
      if (rx === CX + 1 && rz === CZ) throw new Error('a broken layer')
    }
    const w = await made({ regionFilter: filter })
    expect(w.world.regionFilter).toBe(filter)
    await w.run()
    const ready = w.stream.stats.ready
    expect(new Set(seen).size).toBe(ready)
    expect(seen.length).toBe(ready)
    // The region data the world keeps (and builds from) carries the raise.
    const data = w.world.regions.get(CENTRE_ID)!
    expect(data.terrain.heights[0]).toBeCloseTo(w.fx.manifest.regions.find(r => r.id === CENTRE_ID)!.terrain.heightMinM + 3, 5)
    // Off: regions decoded later are left alone.
    w.world.setRegionFilter(null)
    expect(w.world.regionFilter).toBeNull()
  })
})

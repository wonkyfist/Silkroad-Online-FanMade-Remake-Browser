// WE-U on the real world object (NullEngine, the W12 object fixture): the editor session reaches the renderer through
// the step-0 seams (docs/WORLD_EDITOR.md §2.3; docs/WAVE_PLAN8.md §4.2, §4.3): a height stroke across a seam
// uploads both regions (S-TERR) with the same delta on the shared vertices; a region decoded again gets its edits
// from the region filter (S-FILTER); paint re-layers; a moved object re-batches its region with the lowered list
// (S-OBJ), the selection stays out of its batch while the editor owns it, and a revert puts the export's list back.
import { VertexBuffer, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { paintWord } from '../../../packages/shared/src/world-edits/index.ts'
import type { WorldPlacement } from '../../../packages/convert/src/world/manifest.ts'
import type { RegionData, RegionListener } from '../../../packages/world-render/src/index.ts'
import { CX, CZ, centre, objectWorld, pumpUntil, type ObjectWorld } from '../../../packages/world-render/test/w12-fixture.ts'
import { GRID } from '../src/editor/lattice.ts'
import { retailRef } from '../src/editor/object-edits.ts'
import { EditSession } from '../src/editor/session.ts'
import { WorldLink } from '../src/editor/world-link.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const CENTRE = (CZ << 8) | CX
const EAST = (CZ << 8) | (CX + 1)

async function setup() {
  const w: ObjectWorld = await objectWorld()
  cleanups.push(() => w.dispose())
  await w.run()
  const world = w.world
  const m = world.manifest
  const session = new EditSession({
    world: 'w', originRegion: m.space.originRegion, regions: m.regions.map(r => r.id), placements: m.placements,
    host: { heights: id => world.regions.get(id)?.terrain.heights ?? null, words: id => world.regions.get(id)?.terrain.textures ?? null },
  })
  let invalidated = 0
  const link = new WorldLink(world, session, () => invalidated++)
  link.install()
  return { w, world, session, link, invalidated: () => invalidated }
}

const meshY = (world: ObjectWorld['world'], id: number, i: number) => {
  const g = world.terrain.region(id)!
  const pos = (g.mesh as Mesh).getVerticesData(VertexBuffer.PositionKind)!
  return pos[i * 3 + 1]!
}

describe('the editor on the world', () => {
  it('a stroke across a seam uploads both regions with one delta on the shared vertices', async () => {
    const { world, session, link } = await setup()
    const c = centre(CX, CZ)
    const seamX = c.x + 96 // the east edge of the centre region
    session.heights.begin('raise', { radiusM: 16, strength: 1, softness: 0.4 })
    for (let i = 0; i < 12; i++) session.heights.stamp(seamX, c.z)
    const ch = session.heights.end()!
    session.record({ height: ch }, 'raise', ch.regions)
    expect(ch.regions).toContain(CENTRE)
    expect(ch.regions).toContain(EAST)
    while (link.flush()) { /* ≤ 4 regions per frame */ }
    const dc = session.heights.deltaOf(CENTRE)!, de = session.heights.deltaOf(EAST)!
    let seam = 0
    for (let gz = 0; gz < GRID; gz++) {
      const ic = gz * GRID + 96, ie = gz * GRID
      expect(dc[ic]).toBe(de[ie])
      if (dc[ic]) seam++
      // the GPU positions are the live heights
      expect(meshY(world, CENTRE, ic)).toBe(world.regions.get(CENTRE)!.terrain.heights[ic])
      expect(meshY(world, EAST, ie)).toBe(world.regions.get(EAST)!.terrain.heights[ie])
    }
    expect(seam).toBeGreaterThan(0)

    // the region decoded again (streamed out and in): the filter writes the edit before the mesh is built
    const data = world.regions.get(CENTRE)!
    const fresh: RegionData = {
      region: data.region, navmesh: null,
      terrain: { ...data.terrain, heights: Float32Array.from(session.heights.baseOf(CENTRE)!), textures: Uint16Array.from(data.terrain.textures), normals: Int8Array.from(data.terrain.normals) },
    }
    world.filterRegion(fresh)
    expect(Buffer.from(fresh.terrain.heights.buffer).equals(Buffer.from(data.terrain.heights.buffer))).toBe(true)

    // undo: the export's heights, uploaded
    session.undo()
    while (link.flush()) { /* drain */ }
    expect(Buffer.from(data.terrain.heights.buffer).equals(Buffer.from(session.heights.baseOf(CENTRE)!.buffer))).toBe(true)
  })

  it('paint re-layers the region through S-TERR and the filter keeps it', async () => {
    const { world, session, link } = await setup()
    const data = world.regions.get(CENTRE)!
    const c = centre(CX, CZ)
    const word = paintWord(11, 1)
    session.paint.begin(word, { radiusM: 10, strength: 1, softness: 0.1 })
    session.paint.stamp(c.x, c.z)
    const p = session.paint.end()!
    session.record({ paint: p }, 'paint', p.regions)
    while (link.flush()) { /* drain */ }
    expect(data.terrain.textures[48 * GRID + 48]).toBe(word)
    const fresh: RegionData = { region: data.region, navmesh: null, terrain: { ...data.terrain, textures: Uint16Array.from(session.paint.wordsFor(CENTRE)!.map((_, i) => data.terrain.textures[i]!)) } }
    fresh.terrain.textures.fill(paintWord(10, 1))
    world.filterRegion(fresh)
    // the filter's base is the fresh decode; the painted vertices carry the paint
    expect(fresh.terrain.textures[48 * GRID + 48]).toBe(word)
  })

  it('a moved object re-batches its region with the lowered list; the selection stays out of the batch', async () => {
    const { w, world, session, link } = await setup()
    const placed: Array<{ owner: number; placements: readonly WorldPlacement[] }> = []
    const l: RegionListener = { placed: (owner, _m, _i, _meshes, placements) => placed.push({ owner, placements }), removed: () => {} }
    world.objects.addRegionListener(l)
    placed.length = 0
    const p = world.manifest.placements.filter(x => x.region === CENTRE).at(-1)!
    const ref = retailRef(p.region, p.uid)
    const before = session.objects.current(ref)!
    const after = { ...before, position: [p.position[0] + 20, p.position[1], p.position[2] - 10] as [number, number, number], yaw: 0.5 }
    session.objects.set(ref, after)
    session.record({ objects: { items: [{ ref, before, after }] } }, 'move', [CENTRE])
    // owned while selected: the region's batch leaves it out
    await pumpUntil(w, link.setOwned(new Set([`${CENTRE}:${p.uid}`]), new Set([CENTRE])))
    const ownedLists = placed.flatMap(e => e.placements).filter(x => x.region === CENTRE)
    expect(ownedLists.some(x => x.uid === p.uid)).toBe(false)
    placed.length = 0
    // released: the moved placement is in the batch at its new place
    await pumpUntil(w, link.setOwned(new Set(), new Set()))
    const lists = placed.flatMap(e => e.placements).filter(x => x.region === CENTRE)
    const moved = lists.find(x => x.uid === p.uid)!
    expect(moved.position).toEqual(after.position)
    expect(moved.yaw).toBe(0.5)
    // revert: the export's list again
    placed.length = 0
    session.undo()
    await pumpUntil(w, link.syncObjects())
    const back = placed.flatMap(e => e.placements).filter(x => x.region === CENTRE)
      .find(x => x.uid === p.uid)!
    expect(back.position).toEqual(p.position)
  })
})

describe('objects in the editor', () => {
  async function view() {
    const s = await setup()
    const { ObjectsView } = await import('../src/editor/objects-view.ts')
    const said: string[] = []
    const objects = new ObjectsView({
      scene: s.w.scene, world: s.world, session: s.session, link: s.link,
      ground: (x, z) => s.world.regions.heightAt(x, z),
      baseGround: (x, z) => s.session.heights.baseGround(x, z),
      holdHeight: () => false, canEdit: () => true, invalidate: () => {}, say: t => said.push(t), changed: () => {},
    })
    return { ...s, objects, said }
  }

  it('keeps props on raised ground with their exported clearance; refuses to leave the map', async () => {
    const { session, objects, said, w } = await view()
    const p = w.world.manifest.placements.filter(x => x.region === CENTRE).at(-1)!
    const ref = retailRef(p.region, p.uid)
    const clearance = p.position[1] - session.heights.baseGround(p.position[0], p.position[2])!
    session.heights.begin('raise', { radiusM: 20, strength: 1, softness: 0.5 })
    for (let i = 0; i < 10; i++) session.heights.stamp(p.position[0], p.position[2])
    session.heights.end()
    const box = { x0: p.position[0] - 5, z0: p.position[2] - 5, x1: p.position[0] + 5, z1: p.position[2] + 5 }
    const items = objects.followGround(box)
    const it = items.find(i => i.ref === ref)!
    expect(it.after!.position[1]).toBeCloseTo(w.world.regions.heightAt(p.position[0], p.position[2])! + clearance, 3)
    // a move off the export is refused with a sentence
    const ok = await pumpUntil(w, objects.commitStates(new Map([[ref, { ...session.objects.current(ref)!, position: [99_999, 0, 0] as [number, number, number] }]]), 'Moved'))
    expect(ok.value).toBe(false)
    expect(said.at(-1)).toContain('would leave the map')
    expect(session.objects.edited(ref)).toBe(false)
  })

  it('Place lands exactly at each clicked ground point, with no mouse move between clicks (V-12)', async () => {
    const { session, objects, said, w } = await view()
    const p = w.world.manifest.placements.filter(x => x.region === CENTRE).at(-1)!
    const adds = () => session.objects.editedRefs().filter(r => !session.objects.placementOf(r))
    const c = centre(CX, CZ)
    const clicks = [{ x: c.x + 7.25, z: c.z - 3.5 }, { x: c.x - 11.5, z: c.z + 6.75 }, { x: c.x + 2.125, z: c.z + 13 }]
    // pick the model; no pointer move ever reaches the ghost (a click straight after picking, then Shift+clicks)
    await pumpUntil(w, objects.beginPlace(p.source))
    expect(objects.placing).toBe(true)
    await pumpUntil(w, objects.landGhost(true, clicks[0]!))
    // Shift keeps placing: the next ghost starts at the clicked point, never at the world origin
    expect(objects.placing).toBe(true)
    const ghost = w.scene.getTransformNodeByName('editorGhost')!
    expect(ghost.position.x).toBeCloseTo(clicks[0]!.x, 6)
    expect(ghost.position.z).toBeCloseTo(clicks[0]!.z, 6)
    await pumpUntil(w, objects.landGhost(true, clicks[1]!))
    await pumpUntil(w, objects.landGhost(false, clicks[2]!))
    expect(objects.placing).toBe(false)
    const placed = adds().map(r => session.objects.current(r)!)
    expect(placed).toHaveLength(3)
    // the exported clearance of the model's template (as Place keeps it)
    const t = session.objects.templateOf(p.source)!
    const tg = session.heights.baseGround(t.position[0], t.position[2])
    const clearance = tg === null ? 0 : t.position[1] - tg
    for (let i = 0; i < 3; i++) {
      const s = placed.find(q => Math.abs(q.position[0] - clicks[i]!.x) < 1e-6 && Math.abs(q.position[2] - clicks[i]!.z) < 1e-6)
      expect(s, `click ${i}`).toBeDefined()
      expect(s!.position[1]).toBeCloseTo(w.world.regions.heightAt(clicks[i]!.x, clicks[i]!.z)! + clearance, 4)
    }
    // a click off the ground (the sky) places nothing and says why
    await pumpUntil(w, objects.beginPlace(p.source))
    await pumpUntil(w, objects.landGhost(false, null))
    expect(adds()).toHaveLength(3)
    expect(said.at(-1)).toContain('Click the ground')
    objects.cancelGhost()
  })

  it('delete, show deleted and restore are one change each, undoable', async () => {
    const { session, objects, w } = await view()
    const p = w.world.manifest.placements.filter(x => x.region === CENTRE).at(-1)!
    const ref = retailRef(p.region, p.uid)
    await pumpUntil(w, objects.select([ref]))
    expect(objects.selection).toEqual([ref])
    await pumpUntil(w, objects.deleteSelected())
    expect(session.objects.current(ref)).toBeNull()
    expect(objects.selection).toEqual([])
    objects.setShowDeleted(true)
    expect(objects.isDeleted(ref)).toBe(true)
    await pumpUntil(w, objects.restore(ref))
    expect(session.objects.current(ref)).not.toBeNull()
    expect(session.history.changes.map(c => c.label)).toEqual([expect.stringContaining('Deleted'), expect.stringContaining('Restored')])
    session.undo()
    expect(session.objects.current(ref)).toBeNull()
  })
})

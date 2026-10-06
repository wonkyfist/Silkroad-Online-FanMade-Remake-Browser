/**
 * Siege of Jangan (docs/SIEGE.md §9.1): the S-OBJ seam as a list of owners. `WorldObjects.addOwner(pred)` keeps a
 * placement out of its region like the World Editor's `setEditorOwned`, both owners at once; removing the owner brings
 * the placement back with the next reload (the walls feature takes Jangan's retail walls over this way).
 */
import { type AbstractMesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldPlacement } from '../../convert/src/world/manifest.ts'
import type { RegionBatch } from '../src/index.ts'
import { CX, CZ, isTreeMesh, objectWorld, pumpUntil, type ObjectWorld } from './w12-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const CENTRE_ID = (CZ << 8) | CX
const wallMeshes = (batch: RegionBatch): AbstractMesh[] => batch.meshes.filter((m) => !isTreeMesh(m))
const centreWall = (w: ObjectWorld): WorldPlacement => w.fx.manifest.placements.find((p) => p.region === CENTRE_ID && p.models[0] === 0)!

describe('WorldObjects.addOwner (the walls feature)', () => {
  it('an owned wall leaves its region; the editor owner works alongside; removing the owner brings it back', async () => {
    const w = await objectWorld()
    cleanups.push(() => w.dispose())
    await w.run()
    const objects = w.world.objects
    const chunk = w.stream.chunk(CX, CZ)!
    const batchNow = () => objects.regionBatches.get(chunk.objectsOwner)!
    expect(wallMeshes(batchNow()).length).toBe(1)
    const wall = centreWall(w)

    const remove = objects.addOwner((p) => p.uid === wall.uid && p.region === wall.region)
    expect(objects.isEditorOwned(wall, w.fx.manifest.models[0]!)).toBe(true)
    expect((await pumpUntil(w, w.stream.reloadObjects(CX, CZ))).value).toBe(true)
    expect(wallMeshes(batchNow()).length).toBe(0)

    // the editor's own slot alongside: still owned by the walls, nothing else changes
    objects.setEditorOwned(() => false)
    expect(objects.isEditorOwned(wall, w.fx.manifest.models[0]!)).toBe(true)
    objects.setEditorOwned(null)

    // a throwing owner owns nothing (and does not break the others)
    const bad = objects.addOwner(() => {
      throw new Error('boom')
    })
    expect(objects.isEditorOwned(wall, w.fx.manifest.models[0]!)).toBe(true)
    bad()

    remove()
    expect(objects.isEditorOwned(wall, w.fx.manifest.models[0]!)).toBe(false)
    expect((await pumpUntil(w, w.stream.reloadObjects(CX, CZ))).value).toBe(true)
    expect(wallMeshes(batchNow()).length).toBe(1)
  })
})

// H-12 GH-2 (F-12): the editor bakes the lightmaps of the regions an object edit's shadows touch, from the export's
// lightmap, with every edited object's export state as a shadow that goes and its current state as one that comes.
// The worker (the converter's bake) is stubbed here; this checks the jobs the editor sends and the upload.
import { NullEngine, Observable, Scene } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { paintWord, regionIdOf } from '../../../packages/shared/src/world-edits/index.ts'
import type { WorldModel, WorldPlacement } from '../../../packages/convert/src/world/manifest.ts'
import { GRID } from '../src/editor/lattice.ts'
import { retailRef } from '../src/editor/object-edits.ts'
import { EditSession } from '../src/editor/session.ts'
import { BAKE_DEBOUNCE_MS, ShadowBaker } from '../src/editor/shadow-bake.ts'
import type { BakeRequest, BakeResponse } from '../src/editor/shadow-bake-worker.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const OX = 168, OZ = 97
const REGIONS = [168, 169].flatMap(x => [97, 98].map(z => regionIdOf(x, z)))
const TREE = 'res\\nature\\common\\tree\\tre_tree01.bsr'

function setup() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  const regions = REGIONS.map(id => ({
    id, x: id & 0xff, z: id >> 8, origin: [((id & 0xff) - OX) * 192, 0, -((id >> 8) - OZ) * 192] as [number, number, number],
    lightmap: { file: `lightmaps/${id & 0xff}_${id >> 8}.png`, width: 512, height: 512 },
  }))
  const models = [{ index: 0, source: TREE, glb: 'models/tree.glb', kind: 'static', boundsMin: [-1, 0, -1], boundsMax: [1, 8, 1] }] as unknown as WorldModel[]
  const r0 = regionIdOf(OX, OZ)
  const placements: WorldPlacement[] = [{
    objId: 7, source: TREE, models: [0], compound: false, position: [150, 4, -150], rotation: [0, 0, 0, 1], yaw: 0,
    flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid: 32770, region: r0, group: 3, inConvertedRegion: true,
  }]
  const heights = new Map(REGIONS.map(id => [id, new Float32Array(GRID * GRID).fill(4)]))
  const uploads: number[] = []
  const world = {
    scene,
    manifest: { regions, models, space: { originRegion: { x: OX, z: OZ } } },
    regions: { get: (id: number) => (heights.has(id) ? { terrain: { heights: heights.get(id)! } } : null) },
    terrain: {
      onRegionBuilt: new Observable<{ id: number }>(),
      updateRegion: (id: number, u: { lightmap?: { dispose(): void } | null }) => {
        uploads.push(id)
        u.lightmap?.dispose()
        return { id, lightmap: true }
      },
    },
    assets: { url: (rel: string) => `http://editor.test/out/world/w/${rel}` },
  }
  const session = new EditSession({
    world: 'w', originRegion: { x: OX, z: OZ }, regions: REGIONS, placements,
    host: { heights: id => heights.get(id) ?? null, words: () => new Uint16Array(GRID * GRID).fill(paintWord(0, 1)) },
  })
  for (const [id, h] of heights) session.heights.captureBase(id, h)
  const posted: BakeRequest[] = []
  const worker = {
    onmessage: null as ((ev: MessageEvent<BakeResponse>) => void) | null,
    postMessage(req: BakeRequest) {
      posted.push(req)
      setTimeout(() => this.onmessage?.({ data: { id: req.id, width: 2, height: 2, rgba: new Uint8Array(16).fill(200), ms: 1 } } as MessageEvent<BakeResponse>), 0)
    },
    terminate() {},
  }
  const baker = new ShadowBaker({ world: world as never, session, worker: () => worker as unknown as Worker })
  cleanups.push(() => baker.dispose())
  return { session, baker, posted, uploads, ref: retailRef(r0, 32770), r0 }
}

const settle = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('the editor re-bakes the lightmaps an object edit touches (GH-2)', () => {
  it('a move bakes the regions of its old and new shadow, with the export state gone and the new one come', async () => {
    const { session, baker, posted, uploads, ref, r0 } = setup()
    const before = session.objects.current(ref)!
    const after = { ...before, position: [180, 4, -150] as [number, number, number] }
    session.objects.set(ref, after)
    session.record({ objects: { items: [{ ref, before, after }] } }, 'Moved a tree', [r0])
    await settle(BAKE_DEBOUNCE_MS + 100)
    // the old spot (150 m) is in 168,97; the new one (180 m) is within the shadow reach of 169,97 too
    const ids = posted.map(p => regionIdOf(p.rx, p.rz)).sort((a, b) => a - b)
    expect(ids).toContain(r0)
    expect(ids).toContain(regionIdOf(169, 97))
    const job = posted.find(p => regionIdOf(p.rx, p.rz) === r0)!
    expect(job.gone.map(c => c.position[0])).toEqual([150])
    expect(job.come.map(c => c.position[0])).toEqual([180])
    expect(job.scene.map(c => c.position[0])).toEqual([180])
    expect(job.glbs[0]).toBe('http://editor.test/out/world/w/models/tree.glb')
    expect(job.imageUrl).toBe('http://editor.test/out/world/w/lightmaps/168_97.png')
    expect(job.heights.length).toBeGreaterThan(0)
    expect(uploads).toContain(r0)
    expect(baker.stats().baked).toBe(posted.length)
  })

  it('a delete bakes a shadow that goes and none that comes; its undo bakes the export again', async () => {
    const { session, posted, ref, r0 } = setup()
    const before = session.objects.current(ref)!
    session.objects.set(ref, null)
    session.record({ objects: { items: [{ ref, before, after: null }] } }, 'Deleted a tree', [r0])
    await settle(BAKE_DEBOUNCE_MS + 100)
    const job = posted.find(p => regionIdOf(p.rx, p.rz) === r0)!
    expect(job.gone).toHaveLength(1)
    expect(job.come).toHaveLength(0)
    expect(job.scene).toHaveLength(0)
    posted.length = 0
    session.history.undo()
    await settle(BAKE_DEBOUNCE_MS + 100)
    const again = posted.find(p => regionIdOf(p.rx, p.rz) === r0)!
    expect(again.gone).toHaveLength(0)
    expect(again.come).toHaveLength(0)
    expect(again.scene).toHaveLength(1)
  })
})

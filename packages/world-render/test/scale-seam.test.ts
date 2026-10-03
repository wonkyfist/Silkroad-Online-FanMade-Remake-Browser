/**
 * W12-SA, S-SCALE (docs/WORLD_EDITOR.md F6, D12; docs/WAVE_PLAN8.md §4.2 step 3, D17): the optional uniform
 * `WorldPlacement.scale` at every compose site (objects.ts chunks and clones, the region batch's merge, the trees'
 * instancing fallback, the ambient emitters, the perches, the town's fx points). Absent = 1 = byte-identical batches;
 * 1.15 scales the merged vertices about the placement origin and the clone.
 */
import { Matrix, MeshBuilder, NullEngine, PBRMaterial, Quaternion, Scene, TransformNode, Vector3, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import { placementScale } from '../src/index.ts'
import { placeEmitter } from '../src/ambient-fx.ts'
import { TreeInstances } from '../src/batch/trees.ts'
import { perchPointsOf } from '../src/life/spawn.ts'
import { placeAt } from '../src/town/fx.ts'
import { batchBytes, isTreeMesh, objectWorld, type ObjectWorld, type ObjectWorldOptions } from './w12-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

async function made(o: ObjectWorldOptions = {}): Promise<ObjectWorld> {
  const w = await objectWorld(o)
  cleanups.push(() => w.dispose())
  return w
}

/** Sets `scale` on every placement of model 0 (the walls) and model 1 (the skinned prop): undefined deletes it. */
const scaled = (s: number | undefined): ObjectWorldOptions['edit'] => fx => {
  for (const p of fx.manifest.placements) {
    if (p.models[0] !== 0 && p.models[0] !== 1) continue
    if (s === undefined) delete p.scale
    else p.scale = s
  }
}

const QUAT = Quaternion.RotationYawPitchRoll(0.7, 0, 0)
const pl = (scale?: number): Pick<WorldPlacement, 'position' | 'rotation' | 'scale'> => ({
  position: [10, 2, -5], rotation: [QUAT.x, QUAT.y, QUAT.z, QUAT.w], ...(scale === undefined ? {} : { scale }),
})

describe('placementScale and the pure compose sites', () => {
  it('reads a finite positive scale; absent or corrupt = 1', () => {
    expect(placementScale({})).toBe(1)
    expect(placementScale({ scale: 1.15 })).toBe(1.15)
    for (const bad of [0, -1, NaN, Infinity]) expect(placementScale({ scale: bad })).toBe(1)
    expect(placementScale({ scale: '2' as unknown as number })).toBe(1)
  })

  it('ambient emitters, town fx points and perches: absent = 1 exactly; 1.15 scales the model-space offset', () => {
    const local: [number, number, number] = [1.5, 3, -0.5]
    expect(placeEmitter(pl(), local)).toEqual(placeEmitter(pl(1), local))
    expect(placeAt(pl(), local)).toEqual(placeAt(pl(1), local))
    const a = placeEmitter(pl(), local.map(v => v * 1.15))
    const b = placeEmitter(pl(1.15), local)
    for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i]!, 10)
    const c = placeAt(pl(), local.map(v => v * 1.15) as [number, number, number])
    const d = placeAt(pl(1.15), local)
    for (let i = 0; i < 3; i++) expect(d[i]).toBeCloseTo(c[i]!, 10)
    // The two emitters agree on the placement's rotation (one rule, two implementations).
    for (let i = 0; i < 3; i++) expect(placeAt(pl(1.15), local)[i]).toBeCloseTo(placeEmitter(pl(1.15), local)[i]!, 10)
    const model = { boundsMin: [-4, 0, -1], boundsMax: [4, 3, 1] } as Pick<WorldModel, 'boundsMin' | 'boundsMax'>
    expect(perchPointsOf(model, pl())).toEqual(perchPointsOf(model, pl(1)))
    const big = perchPointsOf({ boundsMin: model.boundsMin.map(v => v * 1.15), boundsMax: model.boundsMax.map(v => v * 1.15) } as typeof model, pl())
    const sp = perchPointsOf(model, pl(1.15))
    expect(sp.length).toBe(2)
    for (let k = 0; k < 2; k++) for (let i = 0; i < 3; i++) expect(sp[k]![i]).toBeCloseTo(big[k]![i]!, 10)
  })

  it('the trees\' instancing fallback: the instance matrix and its range sphere scale', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const src = MeshBuilder.CreateBox('src', { size: 1 }, scene)
    src.material = new PBRMaterial('leaf', scene)
    src.setEnabled(false)
    const model = { index: 3, source: 'res\\nature\\common\\tree\\tre_pine03.bsr', boundsMin: [-1, 0, -1], boundsMax: [1, 4, 1] } as unknown as WorldModel
    const at = (scale?: number) => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1], group: 2, uid: 1, ...(scale ? { scale } : {}) } as unknown as WorldPlacement)
    const prep = { geometry: [src as Mesh], locals: [Matrix.Identity()] }
    const set = new TreeInstances(scene)
    set.add(1, model, prep, [at()])
    set.add(2, model, prep, [at(1.15)])
    const inst = (set as unknown as { sets: Map<string, { inst: Array<{ m: Float32Array; r: number; y: number }> }> }).sets.get('3:0')!.inst
    expect([...inst[0]!.m]).toEqual([...Matrix.Identity().toArray()])
    expect(inst[1]!.m[0]).toBeCloseTo(1.15, 6)
    expect(inst[1]!.m[5]).toBeCloseTo(1.15, 6)
    expect(inst[1]!.r).toBeCloseTo(inst[0]!.r * 1.15, 6)
    expect(inst[1]!.y).toBeCloseTo(inst[0]!.y * 1.15, 6)
    set.release()
  })
})

describe('the region batch and the objects (PBR, batched)', () => {
  it('absent scale = scale 1 = byte-identical batches', async () => {
    const absent = await made({ edit: scaled(undefined) })
    await absent.run()
    const one = await made({ edit: scaled(1) })
    await one.run()
    const a = batchBytes(absent.world)
    const b = batchBytes(one.world)
    expect(a.size).toBeGreaterThan(0)
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort())
    for (const [k, v] of a) expect(b.get(k), k).toEqual(v)
  })

  it('scale 1.15 scales the merged vertices about the placement origin (normals stay unit); the trees are untouched', async () => {
    const base = await made()
    await base.run()
    const big = await made({ edit: scaled(1.15) })
    await big.run()
    const a = batchBytes(base.world)
    const b = batchBytes(big.world)
    const walls = new Map<number, [number, number, number]>()
    for (const p of base.fx.manifest.placements) if (p.models[0] === 0) walls.set(p.region, p.position)
    let checked = 0
    for (const [k, va] of a) {
      const vb = b.get(k)!
      expect(vb, k).toBeTruthy()
      if (k.includes('tree:')) {
        expect(vb, k).toEqual(va)
        continue
      }
      const o = walls.get(Number(k.split('|')[0]))!
      const pa = va.position!, pb = vb.position!
      expect(pb.length).toBe(pa.length)
      for (let i = 0; i < pa.length; i += 3) {
        for (let c = 0; c < 3; c++) expect(pb[i + c]! - o[c]!).toBeCloseTo((pa[i + c]! - o[c]!) * 1.15, 4)
        const nb = vb.normal!
        expect(Math.hypot(nb[i]!, nb[i + 1]!, nb[i + 2]!)).toBeCloseTo(1, 5)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('the skinned clone takes the scale on its holder; absent leaves it 1', async () => {
    const clone = (w: ObjectWorld) => {
      const holder = w.scene.transformNodes.find(n => n instanceof TransformNode && /^models\/m1\.glb#\d+$/.test(n.name))!
      expect(holder).toBeTruthy()
      return holder
    }
    const base = await made()
    await base.run()
    expect(clone(base).scaling.asArray()).toEqual([1, 1, 1])
    const big = await made({ edit: scaled(1.15) })
    await big.run()
    for (const v of clone(big).scaling.asArray()) expect(v).toBeCloseTo(1.15, 6)
  })
})

describe('the chunks (Classic: Low draws the scale too, edited placements only)', () => {
  it('absent = 1 = the same thin-instance matrices; 1.15 scales the matrix\'s 3 × 3', async () => {
    const matrices = async (s: number | undefined) => {
      const w = await made({ render: 'classic', edit: scaled(s) })
      await w.run()
      const out = new Map<string, number[]>()
      for (const m of w.world.objects.meshes()) {
        if (!m.name.includes('@m0|') || isTreeMesh(m)) continue
        const buf = (m as Mesh).thinInstanceGetWorldMatrices().flatMap(x => [...x.toArray()])
        out.set(m.name.replace(/\|\d+\|/, '|'), buf)
      }
      expect(out.size).toBeGreaterThan(0)
      return out
    }
    const absent = await matrices(undefined)
    const one = await matrices(1)
    const big = await matrices(1.15)
    const strip = (m: Map<string, number[]>) => [...m.values()].sort((x, y) => x[12]! - y[12]! || x[14]! - y[14]!)
    expect(strip(one)).toEqual(strip(absent))
    const a = strip(absent)
    const b = strip(big)
    expect(b.length).toBe(a.length)
    for (let k = 0; k < a.length; k++) {
      for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) expect(b[k]![i]).toBeCloseTo(a[k]![i]! * 1.15, 5)
      // The translation: the placement's position plus the box's model-space offset (0, 0.5, 0), scaled.
      expect(b[k]![12]).toBeCloseTo(a[k]![12]!, 5)
      expect(b[k]![14]).toBeCloseTo(a[k]![14]!, 5)
      expect(b[k]![13]).toBeCloseTo(a[k]![13]! - 0.5 + 0.5 * 1.15, 5)
    }
    // A unit vector through the matrix grows by the scale.
    const v = Vector3.TransformNormal(new Vector3(1, 0, 0), Matrix.FromArray(b[0]!))
    expect(v.length()).toBeCloseTo(1.15, 5)
  })
})

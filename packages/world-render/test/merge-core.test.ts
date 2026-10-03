/**
 * BT-M, the pure region merge (docs/BATCHING.md §3.1, §3.3, §4.5; docs/WAVE_PLAN6.md §6.1): a rotated instance's
 * positions and normals equal Babylon's (the aliased in-place transpose of §4.5 finding 1 would fail this), a mirrored
 * instance, a flipped piece and a mirroring node transform keep front faces front, a two-sided piece is emitted twice,
 * UV2 ids round-trip through float32, the proxy takes the flagged groups' front faces only, and the worker protocol.
 */
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import {
  MergeHost,
  UV2_ID_LIMIT,
  checkUv2Pack,
  det3,
  mergeGroup,
  mergeProxy,
  mergeRegion,
  mergeTransferables,
  normalMatrix3,
  packUv2,
  unpackUv2,
  type MergeGroupJob,
  type MergeModelData,
  type MergePiece,
  type MergePrimitive,
} from '../src/batch/merge-core.ts'

/** A quad in the z = 0 plane facing +z (counter-clockwise seen from +z): two triangles, normals +z, UVs, UV2s. */
function quad(opts: { mirrored?: boolean; uv2?: boolean; normals?: boolean } = {}): MergePrimitive {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: opts.normals === false ? null : new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    uvs2: opts.uv2 === false ? null : new Float32Array([0.03, 0.03, 0.97, 0.03, 0.97, 0.97, 0.03, 0.97]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    mirrored: opts.mirrored ?? false,
  }
}

function models(...prims: MergePrimitive[]): (id: number) => MergeModelData | undefined {
  const m: MergeModelData = { primitives: prims }
  return id => (id === 1 ? m : undefined)
}

function mats(...ms: Matrix[]): Float32Array {
  const out = new Float32Array(ms.length * 16)
  ms.forEach((m, i) => m.copyToArray(out, i * 16))
  return out
}

function piece(over: Partial<MergePiece> = {}): MergePiece {
  return { model: 1, primitive: 0, matrices: mats(Matrix.Identity()), twoSided: false, flip: false, uv2: null, ...over }
}

function group(pieces: MergePiece[], over: Partial<MergeGroupJob> = {}): MergeGroupJob {
  return { key: 'g', pieces, pivotSize: 0, proxy: false, ...over }
}

/** Each emitted triangle's winding normal (cross(b − a, c − a)) dotted with its vertices' mean normal. */
function windingAgreement(positions: Float32Array, normals: Float32Array, indices: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!]
    const p = (i: number) => new Vector3(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!)
    const n = (i: number) => new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!)
    const cross = Vector3.Cross(p(b).subtract(p(a)), p(c).subtract(p(a)))
    out.push(Math.sign(Vector3.Dot(cross, n(a).add(n(b)).add(n(c)))))
  }
  return out
}

describe('transforms (§3.3, §4.5 finding 1)', () => {
  it("a rotated, scaled instance's positions and normals equal Babylon's", () => {
    const m = Matrix.Compose(new Vector3(1, 2, 0.5), Quaternion.RotationYawPitchRoll(0.7, -0.4, 1.1), new Vector3(10, -3, 7))
    const src = quad()
    const g = mergeGroup(group([piece({ matrices: mats(m) })]), models(src))!
    const nm = Matrix.Invert(m).transpose()
    for (let v = 0; v < 4; v++) {
      const want = Vector3.TransformCoordinates(Vector3.FromArray(src.positions, v * 3), m)
      expect(g.positions[v * 3]).toBeCloseTo(want.x, 4)
      expect(g.positions[v * 3 + 1]).toBeCloseTo(want.y, 4)
      expect(g.positions[v * 3 + 2]).toBeCloseTo(want.z, 4)
      const n = Vector3.TransformNormal(Vector3.FromArray(src.normals!, v * 3), nm).normalize()
      expect(g.normals[v * 3]).toBeCloseTo(n.x, 5)
      expect(g.normals[v * 3 + 1]).toBeCloseTo(n.y, 5)
      expect(g.normals[v * 3 + 2]).toBeCloseTo(n.z, 5)
    }
    // The normals stay perpendicular to the transformed surface.
    const e1 = new Vector3(g.positions[3]! - g.positions[0]!, g.positions[4]! - g.positions[1]!, g.positions[5]! - g.positions[2]!)
    expect(Math.abs(Vector3.Dot(e1, new Vector3(g.normals[0]!, g.normals[1]!, g.normals[2]!)))).toBeLessThan(1e-4)
  })

  it('normalMatrix3 writes its own output (the source is never touched) and equals transpose(inverse)', () => {
    const m = Matrix.Compose(new Vector3(2, 1, 3), Quaternion.RotationYawPitchRoll(0.3, 0.2, -0.9), new Vector3(1, 2, 3))
    const src = Float32Array.from(m.m)
    const before = Float32Array.from(src)
    const out = new Float64Array(9)
    const det = normalMatrix3(src, 0, out)
    expect([...src]).toEqual([...before])
    expect(det).toBeCloseTo(det3(src), 6)
    const want = Matrix.Invert(m).transpose().m
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) expect(out[r * 3 + c]).toBeCloseTo(want[r * 4 + c]!, 5)
    // A degenerate matrix gives the identity, not NaNs.
    const flat = new Float32Array(16)
    expect(normalMatrix3(flat, 0, out)).toBe(0)
    expect([...out]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  it('a batch of instances lands in instance order with its own offsets; bounds cover every vertex', () => {
    const a = Matrix.Translation(100, 0, 0)
    const b = Matrix.Compose(Vector3.One(), Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2), new Vector3(-50, 5, 20))
    const g = mergeGroup(group([piece({ matrices: mats(a, b) })]), models(quad()))!
    expect(g.vertices).toBe(8)
    expect(g.triangles).toBe(4)
    expect([...g.indices.slice(6)]).toEqual([4, 5, 6, 4, 6, 7])
    expect(g.positions[0]).toBe(100)
    const minX = Math.min(...Array.from({ length: 8 }, (_, v) => g.positions[v * 3]!))
    expect(g.min[0]).toBeCloseTo(minX, 5)
    expect(g.max[1]).toBeCloseTo(6, 5)
    expect(g.indices).toBeInstanceOf(Uint16Array)
  })
})

describe('winding (§3.1): front faces stay front-facing', () => {
  it('identity: every triangle agrees with its normals', () => {
    const g = mergeGroup(group([piece()]), models(quad()))!
    expect(windingAgreement(g.positions, g.normals, g.indices)).toEqual([1, 1])
  })

  it('a mirrored instance (determinant < 0) reverses its triangles', () => {
    const m = Matrix.Scaling(-1, 1, 1).multiply(Matrix.Translation(5, 0, 0))
    expect(det3(m.m)).toBeLessThan(0)
    const g = mergeGroup(group([piece({ matrices: mats(m) })]), models(quad()))!
    expect(windingAgreement(g.positions, g.normals, g.indices)).toEqual([1, 1])
    expect([...g.indices]).toEqual([0, 2, 1, 0, 3, 2])
  })

  it('a mirroring node transform (the export says `mirrored`) and a flipped piece reverse too; both cancel', () => {
    const mirrored = mergeGroup(group([piece()]), models(quad({ mirrored: true })))!
    expect([...mirrored.indices]).toEqual([0, 2, 1, 0, 3, 2])
    const flipped = mergeGroup(group([piece({ flip: true })]), models(quad()))!
    expect([...flipped.indices]).toEqual([0, 2, 1, 0, 3, 2])
    const both = mergeGroup(group([piece({ flip: true })]), models(quad({ mirrored: true })))!
    expect([...both.indices]).toEqual([0, 1, 2, 0, 2, 3])
  })

  it('a two-sided piece is emitted twice: the back copy reversed, its normals negated; both agree with their winding', () => {
    const g = mergeGroup(group([piece({ twoSided: true })]), models(quad()))!
    expect(g.vertices).toBe(8)
    expect(g.triangles).toBe(4)
    expect(windingAgreement(g.positions, g.normals, g.indices)).toEqual([1, 1, 1, 1])
    expect([...g.normals.slice(12, 15)]).toEqual([-0, -0, -1])
    expect([...g.indices.slice(6)]).toEqual([4, 6, 5, 4, 7, 6])
    // Two-sided and mirrored: still front-facing both ways.
    const m = mergeGroup(group([piece({ twoSided: true, matrices: mats(Matrix.Scaling(1, -1, 1)) })]), models(quad()))!
    expect(windingAgreement(m.positions, m.normals, m.indices)).toEqual([1, 1, 1, 1])
  })
})

describe('UV2 (§3.3): the lightmap quadrant and the (layer, slot) ids', () => {
  it('packs and unpacks exactly through float32 up to the id limit, with 2⁻¹⁰ of lightmap UV kept', () => {
    const f = new Float32Array(2)
    for (const [slot, layer] of [[0, 0], [1, 0], [7, 183], [UV2_ID_LIMIT - 1, UV2_ID_LIMIT - 1], [2047, 3]]) {
      for (const [scale, ou, ov] of [[1, 0, 0], [0.5, 0.5, 0], [0.5, 0.5, 0.5]]) {
        const p = { slot: slot!, layer: layer!, scale: scale!, offsetU: ou!, offsetV: ov! }
        checkUv2Pack(p)
        for (const [u, v] of [[0.03, 0.03], [0.97, 0.97], [0.5, 0.25]]) {
          const [pu, pv] = packUv2(u!, v!, p)
          f[0] = pu
          f[1] = pv
          const back = unpackUv2(f[0]!, f[1]!)
          expect(back.layer).toBe(layer)
          expect(back.slot).toBe(slot)
          expect(Math.abs(back.u - (u! * scale! + ou!))).toBeLessThan(2 ** -10)
          expect(Math.abs(back.v - (v! * scale! + ov!))).toBeLessThan(2 ** -10)
          // The quadrant keeps the texel off the integer (the decode's floor never crosses).
          expect(back.u).toBeGreaterThan(0)
          expect(back.u).toBeLessThan(1)
        }
      }
    }
  })

  it('refuses ids at the limit and quadrants outside the layer', () => {
    expect(() => checkUv2Pack({ slot: UV2_ID_LIMIT, layer: 0, scale: 1, offsetU: 0, offsetV: 0 })).toThrow()
    expect(() => checkUv2Pack({ slot: 0, layer: -1, scale: 1, offsetU: 0, offsetV: 0 })).toThrow()
    expect(() => checkUv2Pack({ slot: 1.5, layer: 0, scale: 1, offsetU: 0, offsetV: 0 })).toThrow()
    expect(() => checkUv2Pack({ slot: 0, layer: 0, scale: 0.5, offsetU: 0.75, offsetV: 0 })).toThrow()
    expect(() => mergeGroup(group([piece({ uv2: { slot: UV2_ID_LIMIT, layer: 0, scale: 1, offsetU: 0, offsetV: 0 } })]), models(quad()))).toThrow()
  })

  it('the merge writes the packed UV2; a piece without a lightmap lands on its quadrant centre; material mode keeps UV2 raw', () => {
    const pack = { slot: 9, layer: 3, scale: 0.5, offsetU: 0.5, offsetV: 0 }
    const g = mergeGroup(group([piece({ uv2: pack })]), models(quad()))!
    expect(g.uvs2![0]).toBeCloseTo(0.03 * 0.5 + 0.5 + 6, 5)
    expect(g.uvs2![1]).toBeCloseTo(0.03 * 0.5 + 0 + 18, 5)
    const white = mergeGroup(group([piece({ uv2: { slot: 2, layer: 0, scale: 0.5, offsetU: 0, offsetV: 0 } })]), models(quad({ uv2: false })))!
    expect([...white.uvs2!.slice(0, 2)]).toEqual([0.25, 4.25])
    const raw = mergeGroup(group([piece()]), models(quad()))!
    expect(raw.uvs2![2]).toBeCloseTo(0.97, 6)
    expect(raw.uvs![4]).toBe(1)
    // No UV2 anywhere and no pack: no UV2 array (the material sets no lightmap).
    expect(mergeGroup(group([piece()]), models(quad({ uv2: false })))!.uvs2).toBeNull()
  })
})

describe('pivots, the proxy, sizes', () => {
  it('writes each instance\'s pivot to its vertices (BT-T\'s trees: the origin)', () => {
    const m = mats(Matrix.Translation(1, 2, 3), Matrix.Translation(4, 5, 6))
    const g = mergeGroup(group([piece({ matrices: m, pivots: new Float32Array([1, 2, 3, 4, 5, 6]) })], { pivotSize: 3 }), models(quad()))!
    expect(g.pivotSize).toBe(3)
    expect([...g.pivots!.slice(0, 3)]).toEqual([1, 2, 3])
    expect([...g.pivots!.slice(12, 15)]).toEqual([4, 5, 6])
    expect(mergeGroup(group([piece()]), models(quad()))!.pivots).toBeNull()
  })

  it('the proxy has the flagged groups\' positions once (no back copies, no normals)', () => {
    const jobs = [
      group([piece({ twoSided: true, matrices: mats(Matrix.Translation(0, 0, 0), Matrix.Translation(3, 0, 0)) })], { key: 'a', proxy: true }),
      group([piece()], { key: 'b', proxy: false }),
    ]
    const p = mergeProxy(jobs, models(quad()))!
    expect(p.positions.length).toBe(8 * 3)
    expect(p.triangles).toBe(4)
    expect(p.max[0]).toBe(4)
    expect(mergeProxy([jobs[1]!], models(quad()))).toBeNull()
    const r = mergeRegion(jobs, models(quad()))
    expect(r.groups.map(g => g.key)).toEqual(['a', 'b'])
    expect(r.triangles).toBe(8 + 2)
    expect(r.proxy!.triangles).toBe(4)
    expect(r.ms).toBeGreaterThanOrEqual(0)
  })

  it('32-bit indices above 65 536 vertices; empty groups are left out; a missing primitive throws', () => {
    const many = new Float32Array(20000 * 16)
    for (let i = 0; i < 20000; i++) Matrix.Translation(i, 0, 0).copyToArray(many, i * 16)
    const g = mergeGroup(group([piece({ matrices: many })]), models(quad()))!
    expect(g.vertices).toBe(80000)
    expect(g.indices).toBeInstanceOf(Uint32Array)
    expect(g.indices[g.indices.length - 1]).toBe(79999)
    expect(mergeGroup(group([piece({ matrices: new Float32Array(0) })]), models(quad()))).toBeNull()
    expect(mergeRegion([group([piece({ matrices: new Float32Array(0) })])], models(quad())).groups).toEqual([])
    expect(() => mergeGroup(group([piece({ model: 2 })]), models(quad()))).toThrow(/not loaded/)
  })

  it('normals missing: up; UVs missing in one piece of a group: zeros there', () => {
    const noUv: MergePrimitive = { ...quad({ normals: false }), uvs: null }
    const g = mergeGroup(group([piece(), piece({ primitive: 1 })]), models(quad(), noUv))!
    expect([...g.normals.slice(12, 15)]).toEqual([0, 1, 0])
    expect([...g.uvs!.slice(8, 10)]).toEqual([0, 0])
  })
})

describe('the worker protocol (MergeHost)', () => {
  it('models, merge, drop; a merge naming a dropped model answers an error; transferables are the result buffers', () => {
    const host = new MergeHost()
    expect(host.handle({ t: 'models', models: [{ id: 1, primitives: [quad()] }] })).toBeNull()
    const ok = host.handle({ t: 'merge', id: 7, groups: [group([piece()], { proxy: true })] })
    expect(ok && 't' in ok && ok.t).toBe('merged')
    if (!ok || !('t' in ok) || ok.t !== 'merged') throw new Error('no answer')
    expect(ok.id).toBe(7)
    expect(ok.result.groups[0]!.triangles).toBe(2)
    const buffers = mergeTransferables(ok.result)
    expect(new Set(buffers).size).toBe(buffers.length)
    expect(buffers.length).toBe(5 + 2) // positions, normals, uvs, uvs2, indices; the proxy's two
    expect(host.handle({ t: 'drop', ids: [1] })).toBeNull()
    const err = host.handle({ t: 'merge', id: 8, groups: [group([piece()])] })
    expect(err && 't' in err && err.t).toBe('error')
  })
})

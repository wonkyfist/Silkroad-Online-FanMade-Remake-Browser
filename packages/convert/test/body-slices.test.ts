// The licensed bodies' slices cut by coverage (packages/convert/src/tools/licensed/body-slices.ts, CHARACTERS §16.9):
// skin is hidden only where the worn pieces cover it entirely. The bug this guards: loose garment pants that end at the
// calf and short boots covered 73 % of the girl's leg slice, the whole slice was hidden (threshold 0.7) and the boots
// floated under the pants with nothing between.
import { Document, type Node } from '@gltf-transform/core'
import { describe, expect, it } from 'vitest'
import { refineBodySlices, subSlicesOf, TriBvh } from '../src/tools/licensed/body-slices.ts'
import { hiddenSlices, outfitFromGear, partKeyOf, wearablePieceSets, type WardrobeCoverage } from '../../../apps/game/src/three/licensed-outfit.ts'

/** A tube around the y axis (outward normals, CCW seen from outside), `rings` + 1 vertex rings from y0 to y1. */
function tube(doc: Document, name: string, r: number, y0: number, y1: number, rings = 16, seg = 16): Node {
  const pos: number[] = [], nrm: number[] = [], idx: number[] = []
  for (let i = 0; i <= rings; i++) for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2
    pos.push(Math.cos(a) * r, y0 + ((y1 - y0) * i) / rings, Math.sin(a) * r)
    nrm.push(Math.cos(a), 0, Math.sin(a))
  }
  for (let i = 0; i < rings; i++) for (let k = 0; k < seg; k++) {
    const a = i * seg + k, b = i * seg + ((k + 1) % seg), c = a + seg, d = b + seg
    idx.push(a, c, b, b, c, d)
  }
  const buf = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buf))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buf))
  const node = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim))
  doc.getRoot().listScenes()[0]!.addChild(node)
  return node
}

const PIECES = ['PANTS', 'SHOES', 'TOP']
const garment = (slots: Record<string, string>) => outfitFromGear(slots, 'f')
const PANTS = 'ITEM_CH_W_CLOTHES_01_LA_A'
const SHOES = 'ITEM_CH_W_CLOTHES_01_FA_A'

/** A leg (y 0.1..0.9) in pants down to y 0.4 and boots up to y 0.25: the calf between is bare. */
function legDoc(): Document {
  const doc = new Document()
  doc.createBuffer()
  doc.createScene('s')
  tube(doc, 'SK_RIVERSPIRIT_F_BODY_PART_04', 0.06, 0.1, 0.9)
  tube(doc, 'SK_RIVERSPIRIT_F_BODY_PART_04__LOD1', 0.06, 0.1, 0.9, 6, 8)
  tube(doc, 'SK_RIVERSPIRIT_F_PANTS', 0.14, 0.4, 0.95)
  tube(doc, 'SK_RIVERSPIRIT_F_PANTS__LOD1', 0.14, 0.4, 0.95, 4, 8)
  tube(doc, 'SK_RIVERSPIRIT_F_SHOES', 0.08, 0.0, 0.25)
  tube(doc, 'SK_RIVERSPIRIT_F_SHOES__LOD1', 0.08, 0.0, 0.25, 2, 8)
  return doc
}

/** The y extent of every body triangle shown (not hidden) at LOD `lod`. */
function shownYs(doc: Document, hidden: ReadonlySet<string>, lod: number): number[] {
  const ys: number[] = []
  for (const n of doc.getRoot().listNodes()) {
    const key = partKeyOf(n.getName())
    if (!key?.startsWith('BODY_PART') || hidden.has(key) || /__LOD(\d)$/.exec(n.getName())?.[1] !== (lod ? String(lod) : undefined)) continue
    for (const p of n.getMesh()!.listPrimitives()) {
      const P = p.getAttribute('POSITION')!
      for (let i = 0; i < P.getCount(); i++) ys.push(P.getElement(i, [0, 0, 0])[1]!)
    }
  }
  return ys
}

describe('body slices cut by coverage', () => {
  it('the bare calf between loose pants and short boots stays (the floating boots)', () => {
    const doc = legDoc()
    const r = refineBodySlices(doc, PIECES, 'f')
    const cov: WardrobeCoverage = { pieces: PIECES, slices: r.slices, exact: true }
    expect(subSlicesOf(r.slices, 'BODY_PART_04').length).toBeGreaterThan(1)
    for (const lod of [0, 1]) {
      const hidden = hiddenSlices(garment({ legs: PANTS, feet: SHOES }), cov)
      const ys = shownYs(doc, hidden, lod)
      // skin is drawn all the way across the gap (0.25..0.4), and the thigh deep in the pants is not
      for (let y = 0.27; y < 0.39; y += 0.02) expect(ys.some(v => Math.abs(v - y) < 0.06)).toBe(true)
      expect(Math.max(...ys)).toBeLessThanOrEqual(lod ? 0.51 : 0.46) // (one ring of triangles past the hem: no gap)
      // no gear: the whole leg
      expect(Math.min(...shownYs(doc, hiddenSlices(garment({}), cov), lod))).toBeLessThan(0.11)
      expect(Math.max(...shownYs(doc, hiddenSlices(garment({}), cov), lod))).toBeGreaterThan(0.89)
    }
  })

  it('a sub-slice goes only when the worn pieces cover all of it; the old share rule hid the calf', () => {
    const doc = legDoc()
    const r = refineBodySlices(doc, PIECES, 'f')
    // the same coverage read the old way (one slice, share >= 0.7) hides the whole leg under pants + boots
    const whole = new Map<number, number>()
    for (const rows of Object.values(r.slices)) for (const [m, n] of rows) whole.set(m, (whole.get(m) ?? 0) + n)
    const old: WardrobeCoverage = { pieces: PIECES, slices: { BODY_PART_04: [...whole] } }
    expect(hiddenSlices(garment({ legs: PANTS, feet: SHOES }), old).has('BODY_PART_04')).toBe(true)
    // the cut one: every hidden sub-slice is covered vertex for vertex by the worn set, for every wearable set
    const cov: WardrobeCoverage = { pieces: PIECES, slices: r.slices, exact: true }
    for (const set of wearablePieceSets('f')) {
      const o = { gender: 'f' as const, pieces: set.map(p => ({ piece: p as never, gear: null as never })) }
      const mask = set.reduce((m, p) => (PIECES.includes(p) ? m | (1 << PIECES.indexOf(p)) : m), 0)
      for (const k of hiddenSlices(o, cov)) for (const [m] of r.slices[k]!) expect(m & mask).not.toBe(0)
    }
  })

  it('wearable sets: every slot empty or of each class, the lingerie where chest / legs are empty', () => {
    const sets = wearablePieceSets('f').map(s => s.join(','))
    expect(sets).toContain('PANTS,SHOES,TOP')
    expect(sets).toContain('LINGERIE_BOTTOM,LINGERIE_TOP')
    expect(sets.every(s => s.includes('LINGERIE_TOP') || s.includes('TOP'))).toBe(true)
    expect(partKeyOf('SK_RIVERSPIRIT_F_BODY_PART_04_S3__LOD2')).toBe('BODY_PART_04_S3')
  })

  it('the BVH: nearest hit along a ray and the near test', () => {
    const t = new TriBvh(new Float64Array([-1, -1, 1, 1, -1, 1, 0, 1, 1]))
    expect(t.ray([0, 0, 0], [0, 0, 1], 2)!.t).toBeCloseTo(1)
    expect(t.ray([0, 0, 0], [0, 0, 1], 0.5)).toBeNull()
    expect(t.ray([0, 0, 0], [0, 0, -1], 2)).toBeNull()
    expect(t.near([0, 0, 0.995], 0.006)).toBe(true)
    expect(t.near([0, 0, 0.9], 0.006)).toBe(false)
  })
})

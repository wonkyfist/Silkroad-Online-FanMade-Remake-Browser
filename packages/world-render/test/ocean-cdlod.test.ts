/**
 * CST-O, the CDLOD grid (docs/COAST.md §8.2, §12.4; D27): the selection covers the view with no holes and no overlap;
 * a vertex on an edge a node shares with a coarser node lands on the coarser lattice after the morph (no crack); a
 * quadrant kept at its parent's lod has its parent's spacing; nodes wholly over land are culled; nothing is selected
 * beyond the fog cut; the node cap holds; the grid data is (G + 1)² vertices.
 */
import { describe, expect, it } from 'vitest'
import {
  CDLOD_LEAF_M,
  CDLOD_MAX_NODES,
  cdlodMorph,
  cdlodMorphStart,
  cdlodRange,
  gridData,
  selectNodes,
  type CdlodSettings,
  type CdlodView,
} from '../src/ocean/cdlod.ts'

const S: CdlodSettings = { originX: -1000, originZ: -1000, levels: 8, seaLevelM: 5 }
const G = 16

interface Node { x: number; z: number; size: number; lod: number }

function select(view: CdlodView, water: (x: number, z: number, size: number) => boolean = () => true, s = S): Node[] {
  const out = new Float32Array(CDLOD_MAX_NODES * 4)
  const n = selectNodes(view, s, water, out)
  return Array.from({ length: n }, (_, i) => ({ x: out[i * 4]!, z: out[i * 4 + 1]!, size: out[i * 4 + 2]!, lod: out[i * 4 + 3]! }))
}

/** A deterministic pseudo-random sequence. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('CDLOD selection', () => {
  it('ranges: leaf · 2^l · 2.5, the coarsest past the far plane; the morph starts in the last 34 %', () => {
    expect(cdlodRange(0)).toBe(20)
    expect(cdlodRange(7)).toBe(2560)
    expect(cdlodMorphStart(3)).toBeCloseTo(80 + 80 * 0.66, 9)
    expect(cdlodMorphStart(0)).toBeCloseTo(20 * 0.66, 9)
  })

  it('covers every point within the cut exactly once (no hole, no overlap), from a low and a high camera', () => {
    for (const [cy, cut] of [[12, 600], [40, 900], [200, 1500]] as const) {
      const view: CdlodView = { x: 37, y: cy, z: -81, planes: null, cutM: cut }
      const nodes = select(view)
      expect(nodes.length).toBeGreaterThan(4)
      expect(nodes.length).toBeLessThan(CDLOD_MAX_NODES)
      const r = rng(cy)
      for (let i = 0; i < 3000; i++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * Math.sqrt(Math.max(0, (cut * 0.95) ** 2 - (cy - 5) ** 2))
        const px = view.x + Math.cos(a) * d, pz = view.z + Math.sin(a) * d
        const hits = nodes.filter(n => px >= n.x && px < n.x + n.size && pz >= n.z && pz < n.z + n.size)
        expect(hits.length, `(${px.toFixed(1)}, ${pz.toFixed(1)})`).toBe(1)
      }
    }
  })

  it('nothing beyond the fog cut (D27), and nothing at all when the cut is 0', () => {
    const view: CdlodView = { x: 0, y: 20, z: 0, planes: null, cutM: 300 }
    for (const n of select(view)) {
      const dx = Math.max(n.x - view.x, 0, view.x - (n.x + n.size))
      const dz = Math.max(n.z - view.z, 0, view.z - (n.z + n.size))
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(300)
    }
    expect(select({ ...view, cutM: 0 })).toEqual([])
  })

  it('nodes wholly over land are culled; with no water in reach nothing is selected', () => {
    const view: CdlodView = { x: 0, y: 20, z: 0, planes: null, cutM: 800 }
    const seaEast = (x: number, _z: number, size: number) => x + size > 150
    const nodes = select(view, seaEast)
    expect(nodes.length).toBeGreaterThan(0)
    for (const n of nodes) expect(n.x + n.size).toBeGreaterThan(150)
    expect(select(view, () => false)).toEqual([])
  })

  it('frustum planes cull what is behind the camera', () => {
    // One plane: keep x ≥ 0 (normal +x, d = 0).
    const view: CdlodView = { x: 0, y: 20, z: 0, planes: [{ normal: { x: 1, y: 0, z: 0 }, d: 0 }], cutM: 800 }
    for (const n of select(view)) expect(n.x + n.size).toBeGreaterThanOrEqual(0)
  })
})

describe('CDLOD morph', () => {
  const cam = { x: 37, y: 12, z: -81 }
  const view: CdlodView = { ...cam, planes: null, cutM: 1200 }
  const nodes = select(view)
  const spacingOf = (lod: number) => (CDLOD_LEAF_M * 2 ** lod) / G
  /** Snap to a lattice of `step` relative to the origin. */
  const onLattice = (v: number, origin: number, step: number) => {
    const t = (v - origin) / step
    return Math.abs(t - Math.round(t)) < 1e-3
  }

  it('a quadrant kept at its parent\'s lod has its parent\'s spacing (its extra vertices collapse)', () => {
    const quads = nodes.filter(n => n.size < CDLOD_LEAF_M * 2 ** n.lod - 1e-6)
    expect(quads.length).toBeGreaterThan(0)
    for (const n of quads) {
      for (let i = 0; i <= G; i++) {
        const p = cdlodMorph(n, { u: i / G, v: 0 }, G, S, { x: 1e9, y: 0, z: 1e9 })
        expect(onLattice(p.x, S.originX, spacingOf(n.lod))).toBe(true)
      }
    }
  })

  it('on an edge shared with a coarser node, every vertex lands on the coarser lattice (no crack)', () => {
    let checked = 0
    for (const f of nodes) {
      for (const c of nodes) {
        if (c.lod <= f.lod) continue
        // A shared vertical edge: f's east edge on c's west edge (or the reverse), overlapping in z.
        for (const [fx, cx, fu] of [[f.x + f.size, c.x, 1], [f.x, c.x + c.size, 0]] as const) {
          if (Math.abs(fx - cx) > 1e-6) continue
          const z0 = Math.max(f.z, c.z), z1 = Math.min(f.z + f.size, c.z + c.size)
          if (z1 - z0 < 1e-6) continue
          for (let j = 0; j <= G; j++) {
            const v = j / G
            const pz = f.z + v * f.size
            if (pz < z0 - 1e-6 || pz > z1 + 1e-6) continue
            const p = cdlodMorph(f, { u: fu, v }, G, S, cam)
            // The coarser node's edge vertices sit on its lattice, and morph toward twice that.
            const cs = spacingOf(c.lod)
            const cp = cdlodMorph(c, { u: fu === 1 ? 0 : 1, v: (Math.round((p.z - c.z) / cs) * cs) / c.size }, G, S, cam)
            expect(onLattice(p.z, S.originZ, spacingOf(c.lod)) || Math.abs(p.z - cp.z) < 1e-3, `lod ${f.lod}→${c.lod} at z ${p.z}`).toBe(true)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10)
  })

  it('the grid is (G + 1)² vertices in the unit square with up normals and 2 G² triangles', () => {
    const g = gridData(4)
    expect(g.positions.length).toBe(25 * 3)
    expect(g.indices.length).toBe(4 * 4 * 6)
    expect(Math.max(...g.positions)).toBe(1)
    for (let i = 0; i < 25; i++) expect(g.normals[i * 3 + 1]).toBe(1)
  })
})

/**
 * GRASS_FAR (docs/GRASS_FAR.md; lane P-GRASS-FAR): grass to the horizon.
 * - the levels: Medium and High carry the meadow ring and the far carpet; Low keeps today's near field (no band noise,
 *   the plain tint) and gets B1 only to ≤ 150 m (wave 11 GF-R: one draw), Off none; every ring stays inside the ring
 *   window's reach; the ring fades in over the near ring's tier-0 cut-off;
 * - the ring patches: B2 is exactly B1's survivors and B3 B2's (one random sequence), so a cell's sub-ring never shows;
 *   9 vertices per tuft, the flower dots only where the dots can still show;
 * - the hand-overs: ring B's fade-in is the complement of the near ring's tier-0 cut-off (the coverage stays even),
 *   moved inward by the same band noise; a dropped tuft is gone before the next sub-ring's cells take over; the outer
 *   edge is a wide, noisy fade, never a step;
 * - the ring window: the 2 × 2 boxed bake, the copy rows, the exact terrain heights, the sliced fill and the swap;
 * - the cull: nothing nearer than the ring's first tuft or dot, nothing past its last tuft, B1 / B2 / B3 by distance;
 * - the field: six meshes (the ring's three tagged 'scatter', never pickable, no shadows), the ring's own material
 *   without the CSM tap, the ring drawn on Medium, B1 alone on Low, hidden on Off, no new meshes on a level change;
 * - the shaders: both languages, the skeleton's chunk points, NullEngine-ready for every grass define set, the same
 *   varyings as the near field; the tint: the band noise and the far carpet off on Low (only the ring's root shade).
 */
import { FreeCamera, Mesh, NullEngine, Scene, ShaderLanguage, ShaderMaterial, Vector3, Vector4, VertexData } from '@babylonjs/core'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { terrainHeightAt } from '../../convert/src/world/format.ts'
import { GRASS_TINT_PX, GRASS_TINT_SHEEN_GAIN, GRASS_TINT_SHEEN_SHARE, GRASS_TINT_WGSL, GRASS_TINT_GLSL } from '../src/grass/chunks.ts'
import { GRASS_BAND_NOISE_M, GRASS_LEVELS, RING_OUT_NOISE_M, ringReach } from '../src/grass/cull.ts'
import { GRASS_RING_LODS, buildRingPatch, cullGrassRing, grassRingCullOut, ringShare } from '../src/grass/ring.ts'
import { GRASS_SHEEN_GAIN, GRASS_SHEEN_SHARE, GRASS_RING_UNIFORMS, grassNoise, grassRingShaders, ringTuftVisible } from '../src/grass/ring-shaders.ts'
import {
  GRASS_COARSE,
  GRASS_RING_CELLS,
  GRASS_RING_CELL_M,
  GRASS_RING_RECENTER_M,
  GRASS_RING_TEXELS,
  GRASS_RING_WINDOW_M,
  GrassRingWindow,
  coarseGrass,
  type GrassRingRegion,
} from '../src/grass/ring-window.ts'
import { GRASS_ATTRIBUTES, GRASS_BAND_FREQ, grassShaders, registerSkeletonShader } from '../src/grass/shaders.ts'
import { grassTintLook, grassTintWind } from '../src/grass/tint.ts'
import { GRASS_CSM_DEFINE } from '../src/render/grass-chunks.ts'
import type { GrassPoint, WorldShaderChunks } from '../src/shader-chunks.ts'
import { fieldRig, region, type FieldRig } from './grass-fixture.ts'
import { bakeRegionGrass, grassBakeSource, grassTileTable } from '../src/grass/bake.ts'
import { TILES } from './grass-fixture.ts'

const rigs: FieldRig[] = []
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose()
})
const engines: NullEngine[] = []
afterAll(() => {
  for (const e of engines.splice(0)) e.dispose()
})

const MEDIUM = GRASS_LEVELS.medium!
const HIGH = GRASS_LEVELS.high!
const fract = (v: number) => v - Math.floor(v)
const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

describe('the levels (GRASS_FAR §2)', () => {
  it('Medium and High carry the ring and the far carpet; Low keeps today\'s near field plus B1; Off none', () => {
    for (const l of [MEDIUM, HIGH]) {
      expect(l.ring).not.toBeNull()
      expect(l.band).toBe(GRASS_BAND_NOISE_M)
      expect(l.carpet).toEqual({ pattern: 1, sheen: 1 })
      // the ring fades in exactly where the near ring's tier-0 blades drop out
      expect(l.ring!.in).toEqual(l.cut0)
      // the flower dots fade in where the near flowers fade out (flowers × 0.7 .. flowers)
      expect(l.ring!.dots[0]).toBeCloseTo(l.flowers * 0.7, 6)
      expect(l.ring!.dots[1]).toBe(l.flowers)
      expect(l.ring!.dots[3]).toBeLessThanOrEqual(l.ring!.thin2[1])
    }
    const low = GRASS_LEVELS.low!
    // the near field is today's (Medium's density over 0.6 of its reach), no band noise, the plain tint
    expect([low.near, low.mid, low.far]).toEqual([MEDIUM.near * 0.6, MEDIUM.mid * 0.6, MEDIUM.far * 0.6])
    expect(low.cut0).toEqual([MEDIUM.cut0[0] * 0.6, MEDIUM.cut0[1] * 0.6])
    expect(low.density).toEqual(MEDIUM.density)
    expect(low.band).toBe(0)
    expect(low.carpet).toEqual({ pattern: 0, sheen: 0 })
    // GF-R: the ring fades in where Low's tier-0 blades drop out, its dots where Low's flowers fade
    expect(low.ring!.in).toEqual(low.cut0)
    expect(low.ring!.dots[0]).toBeCloseTo(low.flowers * 0.7, 6)
    expect(low.ring!.dots[1]).toBe(low.flowers)
    expect(low.ring!.dots[2]).toBeGreaterThan(low.ring!.in[1])
    expect(low.ring!.dots[3]).toBeLessThanOrEqual(low.ring!.out[0])
    // sparser than Medium's B1 (the Mac / iGPU default): ≤ half the tufts per cell
    expect(low.ring!.grid ** 2).toBeLessThanOrEqual(MEDIUM.ring!.grid ** 2 / 2)
    expect(GRASS_LEVELS.off).toBeNull()
  })

  it('Grass: Low\'s ring is B1 alone to ≤ 150 m (GF-R): its thinning lies past its last tuft, the share stays 1', () => {
    const low = GRASS_LEVELS.low!
    const r = low.ring!
    const reach = ringReach(low)!
    expect(reach.outer).toBeLessThanOrEqual(150)
    expect(reach.outer).toBeGreaterThanOrEqual(140)
    // every cell the cull keeps is nearer than `outer` < b1: B1 only (one draw)
    expect(reach.b1).toBeGreaterThan(reach.outer)
    expect(reach.b2).toBeGreaterThan(reach.outer)
    expect(r.in[1]).toBeLessThan(r.out[0] - RING_OUT_NOISE_M)
    for (let d = 0; d <= reach.outer; d += 5) expect(ringShare(r, d)).toBe(1)
    // the near ring hands over with no band noise (Low's near field is unchanged)
    expect(reach.inner).toBeCloseTo(Math.min(r.in[0] - 6, r.dots[0] - 3), 6)
  })

  it('the ring reaches ≥ 250 m on Medium and further on High, always inside the ring window\'s reach', () => {
    const m = ringReach(MEDIUM)!, h = ringReach(HIGH)!
    expect(MEDIUM.ring!.out[0]).toBeGreaterThanOrEqual(200)
    expect(m.outer).toBeGreaterThanOrEqual(250)
    expect(h.outer).toBeGreaterThan(m.outer)
    // the front window may lag the camera by the re-centre distance; a cell reaches one cell past its nearest point
    const reach = GRASS_RING_WINDOW_M / 2 - GRASS_RING_RECENTER_M - GRASS_RING_CELL_M
    expect(h.outer).toBeLessThanOrEqual(reach)
    // the first thing the ring draws: the dots where the near flowers fade, or a tuft at the band-shifted cut-off
    expect(m.inner).toBeCloseTo(Math.min(MEDIUM.cut0[0] - MEDIUM.band - 6, MEDIUM.flowers * 0.7 - 3), 6)
    for (const l of [MEDIUM, HIGH]) {
      const r = l.ring!
      expect(r.in[1]).toBeLessThan(r.thin1[0])
      expect(r.thin1[1]).toBeLessThanOrEqual(r.thin2[0])
      expect(r.thin2[1]).toBeLessThanOrEqual(r.out[0])
      expect(r.keep3).toBeLessThan(r.keep2)
    }
  })
})

describe('the ring patches (one random sequence: B2 = B1\'s survivors, B3 = B2\'s)', () => {
  const ring = MEDIUM.ring!
  const p = GRASS_RING_LODS.map(lod => buildRingPatch(lod, ring))
  /** Each tuft as (x, z, crand, keep) from its first vertex (9 vertices per tuft, the dots skipped). */
  function tufts(patch: ReturnType<typeof buildRingPatch>): string[] {
    const out: string[] = []
    for (let v = 0; v < patch.vertices; v++) {
      if (patch.positions[v * 3 + 2]! > 2.5) continue
      if (patch.positions[v * 3 + 2] !== 0 || patch.positions[v * 3] !== -1) continue
      out.push(Array.from(patch.bladeA.slice(v * 4, v * 4 + 4)).map(n => n.toFixed(5)).join(','))
    }
    return out
  }

  it('B1 holds every tuft (grid²), 3 one-triangle blades each; B2 and B3 only the kept ones', () => {
    expect(p[0]!.tufts).toBe(ring.grid * ring.grid)
    const b1 = tufts(p[0]!), b2 = tufts(p[1]!), b3 = tufts(p[2]!)
    expect(b1.length).toBe(p[0]!.tufts)
    expect(b2.length).toBe(p[1]!.tufts)
    expect(b3.length).toBe(p[2]!.tufts)
    const s1 = new Set(b1), s2 = new Set(b2)
    for (const t of b2) expect(s1.has(t)).toBe(true)
    for (const t of b3) expect(s2.has(t)).toBe(true)
    for (const t of b2) expect(Number(t.split(',')[3])).toBeLessThan(ring.keep2)
    for (const t of b3) expect(Number(t.split(',')[3])).toBeLessThan(ring.keep3)
    expect(p[1]!.tufts / p[0]!.tufts).toBeCloseTo(ring.keep2, 1)
    expect(p[2]!.tufts / p[0]!.tufts).toBeCloseTo(ring.keep3, 1)
    for (const q of p) {
      expect(q.vertices).toBe(q.tufts * 9 + q.dots * 4)
      expect(q.triangles).toBe(q.tufts * 3 + q.dots * 2)
      // every tuft's root inside its 16 m cell
      for (let v = 0; v < q.vertices; v++) {
        expect(q.bladeA[v * 4]!).toBeGreaterThan(0)
        expect(q.bladeA[v * 4]!).toBeLessThan(GRASS_RING_CELL_M)
      }
    }
    // dots in B1 and B2 (they are gone before B3), on ≈ 16 % of the tufts
    expect(p[0]!.dots / p[0]!.tufts).toBeGreaterThan(0.1)
    expect(p[0]!.dots / p[0]!.tufts).toBeLessThan(0.22)
    expect(p[1]!.dots).toBeGreaterThan(0)
    expect(p[2]!.dots).toBe(0)
    // Medium's B1 patch: about 5.5 k vertices per 16 m cell
    expect(p[0]!.vertices).toBeLessThan(6000)
  })
})

describe('the hand-overs (GRASS_FAR §2.3: no line, no circle)', () => {
  const ring = MEDIUM.ring!

  it('ring B fades in as the near ring\'s tier-0 blades drop out: the two presences sum to ≈ 1 across the band', () => {
    const N = 4000
    for (let d = MEDIUM.cut0[0] - 8; d <= MEDIUM.cut0[1] + 2; d += 2) {
      let near = 0, ringIn = 0
      for (let k = 0; k < N; k++) {
        const r = (k + 0.5) / N
        // grass/shaders.ts: f0 = 1 − smoothstep(cut0 − 6, cut0, d), cut0 = mix(c0, c1, fract(crand × 13.7))
        const cut0 = MEDIUM.cut0[0] + (MEDIUM.cut0[1] - MEDIUM.cut0[0]) * fract(r * 13.7)
        near += 1 - ss(cut0 - 6, cut0, d)
        ringIn += ringTuftVisible(ring, r, 0, d)
      }
      expect(Math.abs(near / N + ringIn / N - 1), `d ${d}`).toBeLessThan(0.03)
    }
  })

  it('the band noise moves both the same way, inward only, up to the level\'s band', () => {
    let lo = Infinity, hi = -Infinity
    for (let x = 0; x < 400; x += 3.7) for (let z = 0; z < 400; z += 4.1) {
      const n = grassNoise(x * Number(GRASS_BAND_FREQ), z * Number(GRASS_BAND_FREQ))
      lo = Math.min(lo, n)
      hi = Math.max(hi, n)
    }
    expect(lo).toBeGreaterThanOrEqual(0)
    expect(hi).toBeLessThanOrEqual(1)
    expect(hi - lo).toBeGreaterThan(0.6)
    // a band shift of b moves the ring's fade-in by exactly b
    for (const b of [0, 4, 10]) {
      expect(ringTuftVisible(ring, 0.3, 0, 45 - b, b)).toBeCloseTo(ringTuftVisible(ring, 0.3, 0, 45, 0), 9)
    }
  })

  it('a tuft a sub-ring drops is gone before the next sub-ring\'s cells start; the survivors grow to keep the coverage', () => {
    for (let k = 0; k < 2000; k++) {
      const crand = fract(k * 0.618034), keep = fract(k * 0.7548777 + 0.1)
      if (keep >= ring.keep2) expect(ringTuftVisible(ring, crand, keep, ring.thin1[1])).toBe(0)
      else if (keep >= ring.keep3) expect(ringTuftVisible(ring, crand, keep, ring.thin2[1])).toBe(0)
    }
    expect(ringShare(ring, 0)).toBe(1)
    expect(ringShare(ring, ring.thin1[1] + 5)).toBeCloseTo(ring.keep2, 6)
    expect(ringShare(ring, ring.thin2[1] + 5)).toBeCloseTo(ring.keep3, 6)
  })

  it('the outer edge is a wide, noisy fade (≥ 40 m from first to last tuft), never a step', () => {
    const N = 3000
    const share = (d: number, noise: number) => {
      let v = 0
      for (let k = 0; k < N; k++) {
        const crand = (k + 0.5) / N
        v += ringTuftVisible(ring, crand, 0.05, d, 0, noise)
      }
      return v / N
    }
    let first = -1, last = -1
    for (let d = 150; d <= 320; d += 1) {
      const s = share(d, 0.5)
      if (first < 0 && s < 0.99) first = d
      if (s > 0.01) last = d
      // no step: neighbouring metres never differ by more than 6 % of the tufts
      expect(Math.abs(share(d + 1, 0.5) - s)).toBeLessThan(0.06)
    }
    expect(last - first).toBeGreaterThanOrEqual(40)
    // the world noise moves the edge by up to ± RING_OUT_NOISE_M
    expect(share(ring.out[0] + 10, 0)).toBeLessThan(share(ring.out[0] + 10, 1))
    expect(ringReach(MEDIUM)!.outer).toBe(ring.out[1] + RING_OUT_NOISE_M)
  })
})

// ---- the ring window -------------------------------------------------------------------------------------------------

/** A ring region from a fixture region and its bake. */
function ringRegion(spec: NonNullable<Parameters<typeof region>[0]>): GrassRingRegion & { data: ReturnType<typeof region>; bake: Uint8Array } {
  const data = region(spec)
  const bake = bakeRegionGrass(grassBakeSource(data), grassTileTable(TILES))
  const h = data.terrain.heights
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < h.length; i++) {
    lo = Math.min(lo, h[i]!)
    hi = Math.max(hi, h[i]!)
  }
  return { ox: spec.ox ?? 0, oz: spec.oz ?? 0, heights: h, hMin: lo, hMax: hi, coarse: coarseGrass(bake), data, bake }
}

describe('the ring window (GRASS_FAR §3)', () => {
  it('coarseGrass: mean density, meadow and light of each 2 × 2, the densest texel\'s slot', () => {
    const bake = new Uint8Array(192 * 192 * 4)
    const put = (i: number, j: number, r: number, g: number, b: number, a: number) => bake.set([r, g, b, a], (j * 192 + i) * 4)
    put(0, 0, 200, 40, 3, 255)
    put(1, 0, 100, 0, 5, 255)
    put(0, 1, 0, 0, 0, 100)
    put(1, 1, 255, 80, 7, 255)
    const c = coarseGrass(bake)
    expect(c.length).toBe(GRASS_COARSE * GRASS_COARSE * 4)
    expect(Array.from(c.slice(0, 4))).toEqual([(200 + 100 + 0 + 255 + 2) >> 2, (40 + 80 + 2) >> 2, 7, (255 * 3 + 100 + 2) >> 2])
  })

  it('a fill copies each region\'s 2 m box and the exact terrain heights; nothing outside the regions', () => {
    // one terrain across both (a border vertex is the same in both regions, as in the export)
    const ground = (x: number, z: number) => 10 + x * 0.15 + z * 0.085 + Math.sin(x * 0.07) * 3
    const a = ringRegion({ id: 1, ox: 0, oz: 0, height: (gx, gz) => ground(2 * gx, -2 * gz) })
    const b = ringRegion({ id: 2, ox: 192, oz: 0, base: 2, height: (gx, gz) => ground(192 + 2 * gx, -2 * gz) })
    const w = new GrassRingWindow()
    expect(w.needsCentre(0, 0)).toBe(true)
    w.start(150, -100, [a, b])
    let calls = 0
    // tiny slices: the front stays empty until the swap
    while (!w.step(() => true)) {
      calls++
      expect(w.front.grassCells).toBe(0)
      if (calls > 5000) break
    }
    expect(calls).toBeGreaterThan(100)
    expect(w.busy).toBe(false)
    expect(w.fills).toBe(1)
    const f = w.front
    expect(Math.abs(f.x0 % GRASS_RING_CELL_M)).toBe(0)
    expect(Math.abs(f.z0 % GRASS_RING_CELL_M)).toBe(0)
    // a texel inside region a (grass) and one inside region b (a road: no grass)
    expect(w.densityAt(50.5, -60.5)).toBeCloseTo(a.coarse![(((0 - -60.5) / 2 | 0) * GRASS_COARSE + (50.5 / 2 | 0)) * 4]! / 255, 6)
    expect(w.densityAt(50.5, -60.5)).toBeGreaterThan(0.5)
    expect(w.densityAt(250.5, -60.5)).toBe(0)
    expect(w.densityAt(-50.5, -60.5)).toBe(0)
    // heights: the terrain's own triangulation, to the 16-bit step
    for (const [x, z, r] of [[13.3, -77.9, a], [101.7, -3.2, a], [230.1, -150.6, b], [191.99, -50, a]] as const) {
      const lx = (x - r.ox) * 10, lz = (r.oz - z) * 10
      expect(w.heightAt(x, z)!).toBeCloseTo(terrainHeightAt(r.heights, lx, lz), 2)
    }
    expect(w.heightAt(-30, -30)).toBeNull()
    // the cell table: grass cells over region a only
    let grass = 0
    for (let k = 0; k < GRASS_RING_CELLS * GRASS_RING_CELLS; k++) if (f.cellMax[k]! > 0) grass++
    expect(grass).toBe(f.grassCells)
    expect(grass).toBe((192 / GRASS_RING_CELL_M) ** 2)
  })

  it('re-centres only past GRASS_RING_RECENTER_M; a running fill keeps the old front drawing', () => {
    const a = ringRegion({ id: 1, ox: 0, oz: 0 })
    const w = new GrassRingWindow()
    w.start(96, -96, [a])
    w.step()
    const front = w.front
    expect(w.needsCentre(96 + GRASS_RING_RECENTER_M * 0.9, -96)).toBe(false)
    expect(w.needsCentre(96 + GRASS_RING_RECENTER_M * 1.1, -96)).toBe(true)
    w.start(300, -96, [a])
    w.step(() => true)
    expect(w.front).toBe(front)
    expect(w.busy).toBe(true)
    w.step()
    expect(w.front).not.toBe(front)
    expect(w.version).toBe(2)
  })
})

describe('the ring cull', () => {
  function window(): GrassRingWindow {
    const w = new GrassRingWindow()
    // every cell grassy at height 0 (a synthetic front)
    w.front.x0 = -GRASS_RING_WINDOW_M / 2
    w.front.z0 = -GRASS_RING_WINDOW_M / 2
    w.front.cellMax.fill(1)
    return w
  }

  it('B1 / B2 / B3 by the cell\'s nearest distance; nothing wholly nearer than the first tuft or dot, nothing past the last', () => {
    const w = window()
    const out = grassRingCullOut()
    const n = cullGrassRing(w.front, 0, 0, MEDIUM, null, out)
    const reach = ringReach(MEDIUM)!
    expect(n).toBeGreaterThan(0)
    expect(out.counts.every(c => c > 0)).toBe(true)
    const cm = GRASS_RING_CELL_M
    for (const tier of [0, 1, 2] as const) {
      for (let i = 0; i < out.counts[tier]; i++) {
        const x = out.buffers[tier][i * 16 + 12]!, z = out.buffers[tier][i * 16 + 14]!
        const dx = Math.max(x - 0, 0 - x - cm, 0), dz = Math.max(z - 0, 0 - z - cm, 0)
        const d = Math.hypot(dx, dz)
        const far = Math.hypot(Math.max(Math.abs(x), Math.abs(x + cm)), Math.max(Math.abs(z), Math.abs(z + cm)))
        expect(d).toBeLessThan(reach.outer)
        expect(far).toBeGreaterThanOrEqual(reach.inner)
        expect(tier === 0 ? d < reach.b1 : tier === 1 ? d >= reach.b1 && d < reach.b2 : d >= reach.b2).toBe(true)
      }
    }
    // Low (GF-R): B1 alone, nothing past 150 m
    const low = GRASS_LEVELS.low!
    const lowReach = ringReach(low)!
    expect(cullGrassRing(w.front, 0, 0, low, null, out)).toBeGreaterThan(0)
    expect(out.counts[0]).toBeGreaterThan(0)
    expect([out.counts[1], out.counts[2]]).toEqual([0, 0])
    for (let i = 0; i < out.counts[0]; i++) {
      const x = out.buffers[0][i * 16 + 12]!, z = out.buffers[0][i * 16 + 14]!
      const dx = Math.max(x, -x - cm, 0), dz = Math.max(z, -z - cm, 0)
      expect(Math.hypot(dx, dz)).toBeLessThan(Math.min(150, lowReach.outer))
    }
    // cells without grass are skipped
    w.front.cellMax.fill(0)
    expect(cullGrassRing(w.front, 0, 0, MEDIUM, null, out)).toBe(0)
  })
})

// ---- the field -------------------------------------------------------------------------------------------------------

describe('the field with the ring (GrassField)', () => {
  /** 3 × 3 regions of even grass around (288, −288). */
  function meadow(r: FieldRig) {
    let id = 1
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) r.field.addRegion(region({ id: id++, ox: 192 * a, oz: -192 * b }))
  }

  it('Medium draws the ring\'s three meshes (tagged \'scatter\', never pickable, no shadows) with its own material', () => {
    const r = fieldRig({ sliceMs: 50, urgentSliceMs: 50 })
    rigs.push(r)
    meadow(r)
    const cam = new FreeCamera('c', new Vector3(288, 3, -288), r.scene)
    cam.setTarget(new Vector3(288, 0, -100))
    r.scene.activeCamera = cam
    for (let i = 0; i < 600 && (r.field.stats.pending || !r.field.ringSettled); i++) r.field.update({ x: 288, y: 3, z: -288 })
    r.field.update({ x: 288, y: 3, z: -288 })
    const meshes = r.field.meshes()
    expect(meshes.length).toBe(6)
    const ring = meshes.slice(3)
    for (const m of ring) {
      expect(m.metadata.sroWorld).toBe('scatter')
      expect(m.isPickable).toBe(false)
      expect(m.receiveShadows).toBe(false)
      expect(m.material).toBe(r.field.ringMaterial)
      expect(m.material).not.toBe(r.field.material)
    }
    expect(r.field.stats.ring[0]).toBeGreaterThan(0)
    expect(ring[0]!.isVisible).toBe(true)
    expect(ring[0]!.thinInstanceCount).toBe(r.field.stats.ring[0])
    expect(r.field.stats.ringFills).toBeGreaterThan(0)
  })

  it('the ring\'s material never takes the CSM tap; it takes every other define', () => {
    const r = fieldRig()
    rigs.push(r)
    const mat = r.field.ringMaterial
    mat.setDefine(GRASS_CSM_DEFINE, true)
    mat.setDefine('SRO_HDR', true)
    const defs = (mat.options as { defines: string[] }).defines.join(' ')
    expect(defs).not.toContain(GRASS_CSM_DEFINE)
    expect(defs).toContain('SRO_HDR')
    r.field.material.setDefine(GRASS_CSM_DEFINE, true)
    expect((r.field.material.options as { defines: string[] }).defines.join(' ')).toContain(GRASS_CSM_DEFINE)
  })

  it('Low draws B1 alone (one draw), Off hides the ring; back to Medium draws it again in the same meshes', () => {
    const r = fieldRig({ sliceMs: 50, urgentSliceMs: 50 })
    rigs.push(r)
    meadow(r)
    const cam = new FreeCamera('c', new Vector3(288, 3, -288), r.scene)
    cam.setTarget(new Vector3(288, 0, -100))
    r.scene.activeCamera = cam
    for (let i = 0; i < 600 && (r.field.stats.pending || !r.field.ringSettled); i++) r.field.update({ x: 288, y: 3, z: -288 })
    const meshes = r.field.meshes()
    r.field.setLevel('low')
    for (let i = 0; i < 600 && !r.field.ringSettled; i++) r.field.update({ x: 288, y: 3, z: -288 })
    r.field.update({ x: 288, y: 3, z: -288 })
    expect(r.field.meshes()).toEqual(meshes)
    expect(r.field.stats.ring[0]).toBeGreaterThan(0)
    expect([r.field.stats.ring[1], r.field.stats.ring[2]]).toEqual([0, 0])
    expect(meshes.slice(3).map(m => m.isVisible)).toEqual([true, false, false])
    expect(meshes[3]!.thinInstanceCount).toBe(r.field.stats.ring[0])
    r.field.setLevel('off')
    r.field.update({ x: 288, y: 3, z: -288 })
    // Off hides every mesh (its stats keep the last frame drawn, as the near field's cells always have)
    for (const m of meshes.slice(3)) expect(m.isVisible).toBe(false)
    r.field.setLevel('medium')
    r.field.update({ x: 288, y: 3, z: -288 })
    expect(r.field.meshes()).toEqual(meshes)
    expect(meshes.slice(3).some(m => m.isVisible)).toBe(true)
  })
})

// ---- the shaders -----------------------------------------------------------------------------------------------------

const POINTS: GrassPoint[] = ['uniforms', 'varyings', 'vertexDecl', 'samplers', 'vertexSway', 'vertexLight', 'fragmentColor']
const MARKER: WorldShaderChunks = {
  grass: {
    uniforms: ['mkU'],
    samplers: ['mkS'],
    wgsl: Object.fromEntries(POINTS.map(p => [p, `// MARK_${p}\n`])),
    glsl: Object.fromEntries(POINTS.map(p => [p, `// MARK_${p}\n`])),
  },
}
const count = (s: string, needle: string) => s.split(needle).length - 1

describe('the ring shaders (both languages, the grass skeleton)', () => {
  it('the near field\'s chunk points, in both languages; its own uniforms and window textures', () => {
    const near = grassShaders([MARKER])
    const ring = grassRingShaders([MARKER])
    for (const p of POINTS) {
      const m = `// MARK_${p}`
      expect(count(ring.vertexWGSL, m), p).toBe(count(near.vertexWGSL, m))
      expect(count(ring.fragmentWGSL, m), p).toBe(count(near.fragmentWGSL, m))
      expect(count(ring.vertexGLSL, m), p).toBe(count(near.vertexGLSL, m))
      expect(count(ring.fragmentGLSL, m), p).toBe(count(near.fragmentGLSL, m))
    }
    const own = GRASS_RING_UNIFORMS.map(u => u.name)
    for (const u of own) expect(ring.uniforms).toContain(u)
    expect(ring.samplers.slice(0, 3)).toEqual(['scLightmap', 'grRingA', 'grRingH'])
    // the lightmap uv spans the ring window
    expect(ring.fragmentWGSL).toContain(`${GRASS_RING_WINDOW_M * 10}.0`)
    expect(ring.fragmentGLSL).toContain(`${GRASS_RING_WINDOW_M * 10}.0`)
    // the texel clamp is the ring window's
    expect(ring.vertexWGSL).toContain(`vec2i(${GRASS_RING_TEXELS - 1})`)
    // no name clash with the near field's uniforms but the shared ones
    expect(own.filter(n => !['grPal', 'grView'].includes(n)).every(n => !grassShaders().uniforms.includes(n))).toBe(true)
  })

  it('no GLSL idiom in the WGSL, no WGSL idiom in the GLSL; every #if closed; the band noise and the sheen in both', () => {
    const s = grassRingShaders()
    for (const w of [s.vertexWGSL, s.fragmentWGSL]) {
      expect(w).not.toMatch(/\b(float|vec[234]|ivec[234]|texture2D|texelFetch|textureLod|dFdx|dFdy|gl_\w+)\s*[(\s]/)
      expect((w.match(/^#if/gm) ?? []).length).toBe((w.match(/^#endif/gm) ?? []).length)
    }
    for (const g of [s.vertexGLSL, s.fragmentGLSL]) {
      expect(g).not.toMatch(/\b(fn|let|var)\s|vec[234]f\(|vec2i\(|var<private>|fragmentInputs|vertexInputs|uniforms\.|textureLoad\(/)
      expect((g.match(/^#if/gm) ?? []).length).toBe((g.match(/^#endif/gm) ?? []).length)
    }
    for (const v of [s.vertexWGSL, s.vertexGLSL]) {
      expect(v).toContain(`grNoise(rxz * ${GRASS_BAND_FREQ})`)
      expect(v).toContain(GRASS_SHEEN_GAIN)
      expect(v).toContain('riGrow')
    }
    // the near field's tier-0 cut-off moves by the same noise
    expect(grassShaders().vertexWGSL).toContain(`grNoise(rxz * ${GRASS_BAND_FREQ}) * uniforms.grView.z`)
    expect(grassShaders().vertexGLSL).toContain(`grNoise(rxz * ${GRASS_BAND_FREQ}) * grView.z`)
    // the tint's copies agree
    expect(GRASS_TINT_SHEEN_GAIN).toBe(GRASS_SHEEN_GAIN)
    expect(Number(GRASS_TINT_SHEEN_SHARE)).toBeCloseTo(GRASS_SHEEN_SHARE, 6)
    for (const t of [GRASS_TINT_WGSL, GRASS_TINT_GLSL]) expect(t).toContain(`sroGtNoise(wp.xz * ${GRASS_BAND_FREQ})`)
    expect(GRASS_TINT_PX).toBeGreaterThan((2 * Math.tan(0.425)) / 1080)
  })

  it('NullEngine-ready (GLSL, as WebGL2 compiles it) for every grass define set; the near field\'s varyings', async () => {
    const engine = new NullEngine()
    engines.push(engine)
    const scene = new Scene(engine)
    scene.createDefaultCamera()
    const patch = buildRingPatch(0, MEDIUM.ring!)
    const mesh = new Mesh('ring', scene)
    const vd = new VertexData()
    vd.positions = patch.positions
    vd.indices = patch.indices
    vd.applyToMesh(mesh)
    mesh.setVerticesData('bladeA', patch.bladeA, false, 4)
    mesh.setVerticesData('bladeB', patch.bladeB, false, 4)
    mesh.thinInstanceSetBuffer('matrix', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 16, true)
    const ringSrc = grassRingShaders()
    registerSkeletonShader('sroGrassRingTest', ringSrc)
    const nearSrc = grassShaders()
    registerSkeletonShader('sroGrassNearTest', nearSrc)
    const WX: readonly (readonly string[])[] = [[], ['WX', 'WX_WIND', 'WX_SHELTER', 'WX_OCC8']]
    let sets = 0
    for (const hdr of [false, true]) for (const wx of WX) for (const night of [false, true]) for (const cloud of [false, true]) {
      const defs = [...(hdr ? ['SRO_HDR'] : []), ...wx, ...(night ? ['SRO_NIGHT_GRASS'] : []), ...(cloud ? ['SRO_CLOUDSHADOW'] : [])]
      const varyings: number[] = []
      for (const [name, src] of [['sroGrassRingTest', ringSrc], ['sroGrassNearTest', nearSrc]] as const) {
        const mat = new ShaderMaterial(name, scene, name, { attributes: [...GRASS_ATTRIBUTES], uniforms: src.uniforms, samplers: src.samplers, shaderLanguage: ShaderLanguage.GLSL })
        for (const d of defs) mat.setDefine(d, true)
        mesh.material = mat
        let ready = false
        for (let i = 0; i < 400 && !ready; i++) {
          ready = mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!, true)
          if (!ready) await new Promise(res => setTimeout(res, 2))
        }
        expect(ready, `${name} ${defs.join(' ')}`).toBe(true)
        const code = (mesh.subMeshes[0]!.effect as unknown as { _vertexSourceCode: string })._vertexSourceCode
        varyings.push((code.match(/^\s*(?:flat\s+)?(?:out|varying)\s+/gm) ?? []).length)
        mat.dispose()
      }
      expect(varyings[0], defs.join(' ')).toBe(varyings[1])
      sets++
    }
    expect(sets).toBe(16)
  }, 120_000)
})

describe('the far carpet\'s values (grass/tint.ts)', () => {
  it('the look: the level\'s pattern share, band and the ring\'s outer fade; Low: no pattern or band, its B1 fade', () => {
    const r = MEDIUM.ring!
    expect(grassTintLook(MEDIUM).asArray()).toEqual([1, GRASS_BAND_NOISE_M, r.out[0] - RING_OUT_NOISE_M, r.out[1] + RING_OUT_NOISE_M])
    const lr = GRASS_LEVELS.low!.ring!
    expect(grassTintLook(GRASS_LEVELS.low!).asArray()).toEqual([0, 0, lr.out[0] - RING_OUT_NOISE_M, lr.out[1] + RING_OUT_NOISE_M])
  })

  it('the wind: the weather\'s direction (normalised), strength and clock × the sheen share; else a calm breeze', () => {
    const w = grassTintWind(new Vector4(3, 4, 0.5, 42), 1, 7)
    expect(w.x).toBeCloseTo(0.6, 6)
    expect(w.y).toBeCloseTo(0.8, 6)
    expect(w.z).toBeCloseTo(0.35 + 0.65 * 0.5, 6)
    expect(w.w).toBe(42)
    const calm = grassTintWind(null, 1, 7)
    expect(Math.hypot(calm.x, calm.y)).toBeCloseTo(1, 6)
    expect(calm.w).toBe(7)
    expect(grassTintWind(new Vector4(1, 0, 1, 3), 0, 0).z).toBe(0)
  })
})

/**
 * The terrain brushes (docs/WORLD_EDITOR.md §4.1, §3.1, §3.4, §7.3; WAVE_PLAN8 lane WE-U): Raise, Lower, Smooth, Flatten
 * and Noise on the global 2 m lattice, the per-region height deltas, and the exact undo / redo / revert of a stroke.
 *
 * - **Deltas, not heights** (D8): each region keeps the export's heights (`base`, captured when the region is decoded,
 *   before any edit) and a delta per vertex. The live height is `fround(base + delta)`, exactly what the converter's
 *   `applyHeightLayer` computes from the saved layer.
 * - **Snapped strokes** (§F1, D50): while a stroke runs its deltas are free; when it ends every touched delta snaps to
 *   the 1/256 m grid (`snapHeightDelta`), so the preview equals the export bit for bit, and every recorded value is a
 *   multiple of 1/256: undo, redo and "revert this one change" are exact float64 arithmetic.
 * - **Seams** (§4.1): a vertex is written once into every region holding it (Lattice.holdersOf), so shared seam
 *   vertices stay bit-identical; a holder that is not loaded keeps its delta and gets it when it streams in (the
 *   region filter calls `applyTo`).
 * - **Guards** (§7.3): the export's edge fades the brush over its last 8 m; the coast guard keeps the sea floor 0.5 m
 *   under the sea and dry ground near the sea 0.3 m above it.
 * Typed arrays only on the hot path (§7.1: a stamp stays under 1 ms).
 */
import { WE_EDGE_FADE_M, snapHeightDelta, type HeightLayer } from '../../../../packages/shared/src/world-edits/index.ts'
import { CELL_M, CELLS, GRID, Lattice, falloff, keyGX, keyGZ, latticeKey, valueNoise } from './lattice.ts'

export type HeightTool = 'raise' | 'lower' | 'smooth' | 'flatten' | 'noise'

export interface BrushParams {
  /** Brush radius (m): half the Size slider (2-60 m). */
  radiusM: number
  /** 0..1 (the Strength slider, 1-100 %). */
  strength: number
  /** 0..1: the outer part of the radius that fades (the Softness slider). */
  softness: number
}

/** Raise / Lower: metres per stamp at full strength and falloff (≈ 30 stamps / s, the prototype's rate). */
export const RAISE_M_PER_STAMP = 0.12
/** Smooth: the share of the way to the 4-neighbour mean per stamp at full strength. */
export const SMOOTH_RATE = 0.6
/** Flatten: the share of the way to the target height per stamp at full strength. */
export const FLATTEN_RATE = 0.25
/** Noise: the amplitude (m) at full strength; the wavelength is a third of the brush size. */
export const NOISE_AMPLITUDE_M = 1

/** Where the live heights are (the resident regions' TerrainBin.heights, written in place). */
export interface HeightHost {
  heights(id: number): Float32Array | null
}

/** Clamps a new height against protected ground (§7.3). `prepare` runs once per stamp. */
export interface GroundGuard {
  prepare?(x: number, z: number, radiusM: number): void
  clamp(x: number, z: number, base: number, h: number): number
}

/** The coast's sea mask and level, as World.coast gives them. */
export interface SeaAccess {
  readonly seaLevelM: number
  seaAt(x: number, z: number): boolean
}

/** The sea floor stays this far under the sea level; dry ground near the sea this far above it (§7.3). */
export const SEA_FLOOR_MARGIN_M = 0.5
export const SHORE_MARGIN_M = 0.3
/** "Near the sea": within this distance of the sea mask (m). */
export const SHORE_REACH_M = 200

/** The spacing of the guard's sea samples around a stamp (m). */
const SEA_SAMPLE_M = 12

/**
 * The coast guard (§7.3): a vertex in the sea mask stays at least 0.5 m below the sea level, a dry vertex near the
 * sea at least 0.3 m above it; a vertex already past the line (retail ground) is never pushed further past it.
 */
export class CoastGuard implements GroundGuard {
  private nearSea = false
  clamped = 0

  constructor(private readonly sea: SeaAccess) {}

  prepare(x: number, z: number, radiusM: number): void {
    // sample the disc out to the shore reach every ~SEA_SAMPLE_M: any sea there makes the brush "near the sea" (the
    // shore margin below). The sea mask itself is tested per vertex in clamp(), whatever these samples saw (PS-4).
    const reach = SHORE_REACH_M + radiusM
    const rings = Math.max(1, Math.ceil(reach / SEA_SAMPLE_M))
    this.nearSea = false
    for (let ring = 0; ring <= rings && !this.nearSea; ring++) {
      const r = (reach * ring) / rings
      const n = ring === 0 ? 1 : Math.max(8, Math.ceil((2 * Math.PI * r) / SEA_SAMPLE_M))
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        if (this.sea.seaAt(x + Math.cos(a) * r, z + Math.sin(a) * r)) {
          this.nearSea = true
          break
        }
      }
    }
  }

  clamp(x: number, z: number, base: number, h: number): number {
    const level = this.sea.seaLevelM
    if (this.sea.seaAt(x, z)) {
      const top = Math.max(base, level - SEA_FLOOR_MARGIN_M)
      if (h > top) {
        this.clamped++
        return top
      }
      return h
    }
    if (!this.nearSea) return h
    const bottom = Math.min(base, level + SHORE_MARGIN_M)
    if (h < bottom) {
      this.clamped++
      return bottom
    }
    return h
  }
}

/** A stroke's record: per lattice vertex its delta before and after (both multiples of 1/256 m). */
export interface HeightChangeData {
  keys: Float64Array
  before: Float64Array
  after: Float64Array
  /** Regions holding any of the vertices. */
  regions: number[]
  /** The largest |after - before| (m). */
  maxAbs: number
  /** The largest rise and fall (m). */
  maxUp: number
  maxDown: number
}

/** A region's grid rect touched since the last flush (inclusive vertex indices). */
export interface DirtyRect {
  x0: number
  z0: number
  x1: number
  z1: number
}

interface StrokeEntry {
  before: number
  /** Noise: the strongest falloff the vertex has seen in this stroke. */
  maxF: number
}

export interface StampResult {
  vertices: number
  clamped: number
  ms: number
}

const EMPTY = new Float64Array(0)

export class HeightEdits {
  private readonly base = new Map<number, Float32Array>()
  private readonly delta = new Map<number, Float64Array>()
  private readonly dirty = new Map<number, DirtyRect>()
  private stroke: Map<number, StrokeEntry> | null = null
  private toolValue: HeightTool = 'raise'
  private params: BrushParams = { radiusM: 10, strength: 0.5, softness: 0.5 }
  private flattenTo = NaN
  private seed = 1
  // scratch for one stamp (grown on demand)
  private sKeys = EMPTY
  private sVals = EMPTY
  guard: GroundGuard | null = null

  constructor(readonly lattice: Lattice, private readonly host: HeightHost) {}

  // ---- regions ------------------------------------------------------------------------------------------------------

  /**
   * A region was decoded (the region filter, before its mesh is built): its decoded heights are the export's (the
   * base), and the edits are written into them. Returns the vertices it changed.
   */
  captureBase(id: number, heights: Float32Array): number[] {
    this.base.set(id, Float32Array.from(heights))
    return this.applyTo(id, heights)
  }

  /** Writes fround(base + delta) into `heights` where the region has a delta; returns the changed vertex indices. */
  applyTo(id: number, heights: Float32Array): number[] {
    const d = this.delta.get(id)
    const b = this.base.get(id)
    const changed: number[] = []
    if (!d || !b) return changed
    for (let i = 0; i < d.length; i++) {
      if (d[i] === 0 && heights[i] === b[i]) continue
      const v = Math.fround(b[i]! + d[i]!)
      if (Object.is(v, heights[i])) continue
      heights[i] = v
      changed.push(i)
    }
    return changed
  }

  /** The export's heights of a region (null: not loaded and never decoded here). */
  baseOf(id: number): Float32Array | null {
    return this.baseFor(id)
  }

  /**
   * A region's base: captured at decode (the filter), or, for a region resident before the editor's filter was
   * installed and never written since, its live heights (still the export's).
   */
  private baseFor(id: number): Float32Array | null {
    const b = this.base.get(id)
    if (b) return b
    const h = this.host.heights(id)
    const d = this.delta.get(id)
    if (!h || (d && d.some(v => v !== 0))) return null
    const copy = Float32Array.from(h)
    this.base.set(id, copy)
    return copy
  }

  /** The region's deltas (m; 0 untouched), or null. */
  deltaOf(id: number): Float64Array | null {
    return this.delta.get(id) ?? null
  }

  /** Regions with any non-zero delta. */
  touchedRegions(): number[] {
    const out: number[] = []
    for (const [id, d] of this.delta) if (d.some(v => v !== 0)) out.push(id)
    return out.sort((a, b) => a - b)
  }

  /** The saved layer of a region (delta float32, mask where non-zero), or null when it has none. */
  layer(id: number): HeightLayer | null {
    const d = this.delta.get(id)
    if (!d) return null
    const delta = new Float32Array(GRID * GRID)
    const mask = new Uint8Array(GRID * GRID)
    let any = false
    for (let i = 0; i < d.length; i++) {
      if (d[i] === 0) continue
      delta[i] = d[i]!
      mask[i] = 1
      any = true
    }
    return any ? { delta, mask } : null
  }

  /** Loads a saved layer (the editor's start): its deltas replace the region's; resident heights follow. */
  loadLayer(id: number, layer: HeightLayer): void {
    const h = this.host.heights(id)
    this.baseFor(id)
    const d = this.deltaArr(id)
    for (let i = 0; i < d.length; i++) d[i] = layer.mask[i] ? snapHeightDelta(layer.delta[i]!) : 0
    if (h && this.base.has(id) && this.applyTo(id, h).length) this.markAll(id)
  }

  /** Drops every delta of a region (revert this region); resident heights go back to the export's. */
  clearRegion(id: number): HeightChangeData | null {
    const d = this.delta.get(id)
    if (!d) return null
    const keys: number[] = [], before: number[] = []
    const rx = id & 0xff, rz = id >> 8
    for (let i = 0; i < d.length; i++) {
      if (d[i] === 0) continue
      keys.push(latticeKey(rx * CELLS + (i % GRID), rz * CELLS + Math.floor(i / GRID)))
      before.push(d[i]!)
    }
    if (!keys.length) return null
    const change = this.makeChange(keys, before, keys.map(() => 0))
    this.apply(change, 'after')
    return change
  }

  // ---- reading ------------------------------------------------------------------------------------------------------

  /** The live height of lattice vertex (GX, GZ) (a resident holder's), or undefined. */
  heightAt(GX: number, GZ: number): number | undefined {
    const L = this.lattice
    const n = L.holdersOf(GX, GZ)
    for (let k = 0; k < n; k++) {
      const h = this.host.heights(L.holders[k * 2]!)
      if (h) return h[L.holders[k * 2 + 1]!]
    }
    return undefined
  }

  /** The current delta of lattice vertex (GX, GZ) (0 when untouched). */
  deltaAt(GX: number, GZ: number): number {
    const L = this.lattice
    const n = L.holdersOf(GX, GZ)
    for (let k = 0; k < n; k++) {
      const d = this.delta.get(L.holders[k * 2]!)
      if (d) return d[L.holders[k * 2 + 1]!]!
    }
    return 0
  }

  /** The export's height of lattice vertex (GX, GZ), or undefined. */
  baseAt(GX: number, GZ: number): number | undefined {
    const L = this.lattice
    const n = L.holdersOf(GX, GZ)
    for (let k = 0; k < n; k++) {
      const b = this.baseFor(L.holders[k * 2]!)
      if (b) return b[L.holders[k * 2 + 1]!]
    }
    return undefined
  }

  /** The export's ground (bilinear on the base heights) at glTF (x, z), or null. */
  baseGround(x: number, z: number): number | null {
    const GX = this.lattice.toGX(x), GZ = this.lattice.toGZ(z)
    const i0 = Math.floor(GX), j0 = Math.floor(GZ)
    const h00 = this.baseAt(i0, j0), h10 = this.baseAt(i0 + 1, j0), h01 = this.baseAt(i0, j0 + 1), h11 = this.baseAt(i0 + 1, j0 + 1)
    if (h00 === undefined || h10 === undefined || h01 === undefined || h11 === undefined) return null
    const tx = GX - i0, tz = GZ - j0
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
  }

  /** The live ground (bilinear on the edited heights) at glTF (x, z), or null. */
  ground(x: number, z: number): number | null {
    const GX = this.lattice.toGX(x), GZ = this.lattice.toGZ(z)
    const i0 = Math.floor(GX), j0 = Math.floor(GZ)
    const h00 = this.heightAt(i0, j0), h10 = this.heightAt(i0 + 1, j0), h01 = this.heightAt(i0, j0 + 1), h11 = this.heightAt(i0 + 1, j0 + 1)
    if (h00 === undefined || h10 === undefined || h01 === undefined || h11 === undefined) return null
    const tx = GX - i0, tz = GZ - j0
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
  }

  // ---- strokes ------------------------------------------------------------------------------------------------------

  get stroking(): boolean {
    return this.stroke !== null
  }

  /** The tool of the current (or last) stroke. */
  get tool(): HeightTool {
    return this.toolValue
  }

  /**
   * Starts a stroke. `flattenTo`: Flatten's target height (default: the ground under the first stamp); `seed`: Noise's
   * seed (the change id: deterministic).
   */
  begin(tool: HeightTool, params: BrushParams, opts: { flattenTo?: number; seed?: number } = {}): void {
    this.stroke = new Map()
    this.toolValue = tool
    this.params = { ...params }
    this.flattenTo = opts.flattenTo ?? NaN
    this.seed = opts.seed ?? 1
  }

  /** Changes the brush mid-stroke (the sliders' keys). */
  setParams(params: BrushParams): void {
    this.params = { ...params }
  }

  /** One stamp at glTF (cx, cz). */
  stamp(cx: number, cz: number): StampResult {
    const t0 = performance.now()
    const s = this.stroke
    const res: StampResult = { vertices: 0, clamped: 0, ms: 0 }
    if (!s) return res
    const L = this.lattice
    const { radiusM, strength, softness } = this.params
    const GXc = L.toGX(cx), GZc = L.toGZ(cz)
    const rv = radiusM / CELL_M
    const x0 = Math.ceil(GXc - rv), x1 = Math.floor(GXc + rv), z0 = Math.ceil(GZc - rv), z1 = Math.floor(GZc + rv)
    const cap = (x1 - x0 + 1) * (z1 - z0 + 1)
    if (this.sKeys.length < cap) {
      this.sKeys = new Float64Array(cap)
      this.sVals = new Float64Array(cap)
    }
    if (this.toolValue === 'flatten' && Number.isNaN(this.flattenTo)) {
      const g = this.ground(cx, cz)
      if (g === null) return res
      this.flattenTo = g
    }
    this.guard?.prepare?.(cx, cz, radiusM)
    const clampedBefore = this.guard instanceof CoastGuard ? this.guard.clamped : 0
    // the export-edge fade only where a missing region lies within the fade of the brush's box
    const pad = WE_EDGE_FADE_M / CELL_M + 1
    let nearEdge = false
    for (let rz = Math.floor((z0 - pad) / CELLS); rz <= Math.floor((z1 + pad) / CELLS) && !nearEdge; rz++) {
      for (let rx = Math.floor((x0 - pad) / CELLS); rx <= Math.floor((x1 + pad) / CELLS); rx++) {
        if (!L.exists((rz << 8) | rx)) {
          nearEdge = true
          break
        }
      }
    }
    let n = 0
    for (let GZ = z0; GZ <= z1; GZ++) {
      for (let GX = x0; GX <= x1; GX++) {
        const f0 = falloff(Math.hypot(GX - GXc, GZ - GZc) * CELL_M, radiusM, softness)
        if (f0 <= 0) continue
        const f = nearEdge ? f0 * L.edgeFade(GX, GZ, WE_EDGE_FADE_M) : f0
        if (f <= 0) continue
        const h = this.heightAt(GX, GZ)
        if (h === undefined) continue
        const base = this.baseAt(GX, GZ)
        if (base === undefined) continue
        const key = latticeKey(GX, GZ)
        let e = s.get(key)
        if (!e) s.set(key, (e = { before: this.deltaAt(GX, GZ), maxF: 0 }))
        let v: number
        switch (this.toolValue) {
          case 'raise':
            v = h + RAISE_M_PER_STAMP * strength * f
            break
          case 'lower':
            v = h - RAISE_M_PER_STAMP * strength * f
            break
          case 'smooth': {
            let sum = 0, cnt = 0
            const a = this.heightAt(GX - 1, GZ), b = this.heightAt(GX + 1, GZ), c = this.heightAt(GX, GZ - 1), d = this.heightAt(GX, GZ + 1)
            if (a !== undefined) (sum += a), cnt++
            if (b !== undefined) (sum += b), cnt++
            if (c !== undefined) (sum += c), cnt++
            if (d !== undefined) (sum += d), cnt++
            const avg = cnt ? sum / cnt : h
            v = h + (avg - h) * Math.min(1, SMOOTH_RATE * strength) * f
            break
          }
          case 'flatten':
            v = h + (this.flattenTo - h) * Math.min(1, FLATTEN_RATE * strength) * f
            break
          case 'noise': {
            // the stroke's noise only grows with the strongest falloff seen: nothing to write otherwise
            if (f <= e.maxF) continue
            e.maxF = f
            const wave = (2 * radiusM) / 3 / CELL_M
            v = base + e.before + NOISE_AMPLITUDE_M * strength * valueNoise(GX, GZ, wave, this.seed) * e.maxF
            break
          }
        }
        if (this.guard) v = this.guard.clamp(L.x(GX), L.z(GZ), base, v)
        this.sKeys[n] = key
        this.sVals[n] = v - base
        n++
      }
    }
    // write after reading (Smooth reads its neighbours' heights from before this stamp)
    for (let k = 0; k < n; k++) {
      const key = this.sKeys[k]!
      this.set(keyGX(key), keyGZ(key), this.sVals[k]!)
    }
    res.vertices = n
    res.clamped = this.guard instanceof CoastGuard ? this.guard.clamped - clampedBefore : 0
    res.ms = performance.now() - t0
    return res
  }

  /** Ends the stroke: every touched delta snaps to the 1/256 m grid; returns its record (null: nothing changed). */
  end(): HeightChangeData | null {
    const s = this.stroke
    this.stroke = null
    if (!s || !s.size) return null
    const keys: number[] = [], before: number[] = [], after: number[] = []
    for (const [key, e] of s) {
      const GX = keyGX(key), GZ = keyGZ(key)
      const a = snapHeightDelta(this.deltaAt(GX, GZ))
      this.set(GX, GZ, a)
      if (a === e.before) continue
      keys.push(key)
      before.push(e.before)
      after.push(a)
    }
    return keys.length ? this.makeChange(keys, before, after) : null
  }

  /** Aborts the stroke (Esc while painting): its vertices go back to their deltas before it. */
  cancel(): void {
    const s = this.stroke
    this.stroke = null
    if (!s) return
    for (const [key, e] of s) this.set(keyGX(key), keyGZ(key), e.before)
  }

  // ---- history ------------------------------------------------------------------------------------------------------

  /** Undo ('before') or redo ('after') a change: the recorded deltas, exactly. */
  apply(c: HeightChangeData, which: 'before' | 'after'): void {
    const v = which === 'before' ? c.before : c.after
    for (let i = 0; i < c.keys.length; i++) this.set(keyGX(c.keys[i]!), keyGZ(c.keys[i]!), v[i]!)
  }

  /**
   * "Revert this one change" (sign -1) or re-apply it (+1): adds its own difference to whatever is there now, so later
   * changes on top stay (§3.4). Exact: every value is a multiple of 1/256 m.
   */
  shift(c: HeightChangeData, sign: 1 | -1): void {
    for (let i = 0; i < c.keys.length; i++) {
      const GX = keyGX(c.keys[i]!), GZ = keyGZ(c.keys[i]!)
      this.set(GX, GZ, snapHeightDelta(this.deltaAt(GX, GZ) + sign * (c.after[i]! - c.before[i]!)))
    }
  }

  /** The regions whose live heights changed since the last call, with their touched vertex rects. */
  takeDirty(): Array<{ id: number; rect: DirtyRect }> {
    const out = [...this.dirty].map(([id, rect]) => ({ id, rect }))
    this.dirty.clear()
    return out
  }

  // ---- internals ----------------------------------------------------------------------------------------------------

  private makeChange(keys: number[], before: number[], after: number[]): HeightChangeData {
    const regions = new Set<number>()
    let maxAbs = 0, maxUp = 0, maxDown = 0
    for (let i = 0; i < keys.length; i++) {
      const n = this.lattice.holdersOf(keyGX(keys[i]!), keyGZ(keys[i]!))
      for (let k = 0; k < n; k++) regions.add(this.lattice.holders[k * 2]!)
      const d = after[i]! - before[i]!
      maxAbs = Math.max(maxAbs, Math.abs(d))
      maxUp = Math.max(maxUp, d)
      maxDown = Math.min(maxDown, d)
    }
    return { keys: Float64Array.from(keys), before: Float64Array.from(before), after: Float64Array.from(after), regions: [...regions].sort((a, b) => a - b), maxAbs, maxUp, maxDown }
  }

  private deltaArr(id: number): Float64Array {
    let d = this.delta.get(id)
    if (!d) this.delta.set(id, (d = new Float64Array(GRID * GRID)))
    return d
  }

  /** Sets lattice vertex (GX, GZ)'s delta in every region holding it, and its live height where resident. */
  private set(GX: number, GZ: number, d: number): void {
    const L = this.lattice
    const n = L.holdersOf(GX, GZ)
    for (let k = 0; k < n; k++) {
      const id = L.holders[k * 2]!, i = L.holders[k * 2 + 1]!
      this.baseFor(id)
      this.deltaArr(id)[i] = d
      const h = this.host.heights(id)
      if (!h) continue
      const b = this.baseFor(id)
      if (!b) continue
      const v = Math.fround(b[i]! + d)
      if (Object.is(v, h[i])) continue
      h[i] = v
      this.mark(id, i % GRID, Math.floor(i / GRID))
    }
  }

  private mark(id: number, gx: number, gz: number): void {
    const r = this.dirty.get(id)
    if (!r) this.dirty.set(id, { x0: gx, z0: gz, x1: gx, z1: gz })
    else {
      if (gx < r.x0) r.x0 = gx
      if (gx > r.x1) r.x1 = gx
      if (gz < r.z0) r.z0 = gz
      if (gz > r.z1) r.z1 = gz
    }
  }

  private markAll(id: number): void {
    this.dirty.set(id, { x0: 0, z0: 0, x1: GRID - 1, z1: GRID - 1 })
  }
}

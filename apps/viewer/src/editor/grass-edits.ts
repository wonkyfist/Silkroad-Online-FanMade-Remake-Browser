/**
 * Grass and Flowers (docs/WORLD_EDITOR.md §4.4, D22, D23): a 1 m mask per region (192 x 192) that multiplies
 * GRASS_LIFE's density (R / 128: x0 ... x2) and paints flowers (G amount, B kind). The live preview hands the mask to
 * the grass field (S-GRASS `setMask`, the bake's own texel order: south first, z * 192 + x); Low ignores masks.
 *
 * Texels never share a seam: global texel TX = 192 rx + x, TZ = 192 rz + z (x east, z north, 1 m). A texel's state is
 * packed in one integer (0: untouched; else touched | kind << 16 | flowers << 8 | density), so undo / redo / revert one
 * are exact.
 */
import {
  WE_GRASS, WE_GRASS_DENSITY_ONE, type GrassLayer,
} from '../../../../packages/shared/src/world-edits/index.ts'
import { falloff, regionIdOf } from './lattice.ts'
import type { BrushParams } from './terrain-edits.ts'

export type GrassMode = 'less' | 'more' | 'flowers' | 'clear'

/** Density code units per stamp at full strength and falloff (≈ 30 stamps / s: ×1 → ×0 in about half a second). */
export const GRASS_RATE = 24
/**
 * The flower kind the brush paints. The bake reads B only as "painted" (B > 0: the meadow amount is G instead of the
 * meadow noise's drifts; grass/bake.ts), so one kind is all the runtime shows today.
 */
export const FLOWER_KIND = 1

const TOUCHED = 1 << 24
const pack = (density: number, flowers: number, kind: number) => (TOUCHED | ((kind & 0xff) << 16) | ((flowers & 0xff) << 8) | (density & 0xff)) >>> 0
const UNTOUCHED = 0

export const grassKey = (TX: number, TZ: number) => TX * 65536 + TZ

export interface GrassChangeData {
  keys: Float64Array
  before: Uint32Array
  after: Uint32Array
  regions: number[]
  mode: GrassMode
}

export class GrassEdits {
  private readonly state = new Map<number, Uint32Array>()
  private readonly dirty = new Set<number>()
  private stroke: Map<number, number> | null = null
  private mode: GrassMode = 'less'
  private kind = 1
  private params: BrushParams = { radiusM: 6, strength: 0.5, softness: 0.5 }

  constructor(
    readonly ox: number,
    readonly oz: number,
    private readonly exists: (id: number) => boolean,
  ) {}

  touchedRegions(): number[] {
    const out: number[] = []
    for (const [id, s] of this.state) if (s.some(v => v !== UNTOUCHED)) out.push(id)
    return out.sort((a, b) => a - b)
  }

  /** The region's layer for Save (null: untouched). */
  layer(id: number): GrassLayer | null {
    const s = this.state.get(id)
    if (!s || !s.some(v => v !== UNTOUCHED)) return null
    const n = WE_GRASS * WE_GRASS
    const out: GrassLayer = { density: new Uint8Array(n).fill(WE_GRASS_DENSITY_ONE), flowers: new Uint8Array(n), kind: new Uint8Array(n), mask: new Uint8Array(n) }
    for (let i = 0; i < n; i++) {
      const v = s[i]!
      if (!v) continue
      out.density[i] = v & 0xff
      out.flowers[i] = (v >> 8) & 0xff
      out.kind[i] = (v >> 16) & 0xff
      out.mask[i] = 1
    }
    return out
  }

  loadLayer(id: number, layer: GrassLayer): void {
    const s = this.stateArr(id)
    for (let i = 0; i < s.length; i++) s[i] = layer.mask[i] ? pack(layer.density[i]!, layer.flowers[i]!, layer.kind[i]!) : UNTOUCHED
    this.dirty.add(id)
  }

  /** The live mask of a region for GrassField.setMask (192 x 192 RGBA8, south first), or null when untouched. */
  mask(id: number): Uint8Array | null {
    const s = this.state.get(id)
    if (!s || !s.some(v => v !== UNTOUCHED)) return null
    const out = new Uint8Array(WE_GRASS * WE_GRASS * 4)
    for (let i = 0; i < s.length; i++) {
      const v = s[i]!
      const o = i * 4
      if (!v) {
        out[o] = WE_GRASS_DENSITY_ONE
        continue
      }
      out[o] = v & 0xff
      out[o + 1] = (v >> 8) & 0xff
      out[o + 2] = (v >> 16) & 0xff
      out[o + 3] = 255
    }
    return out
  }

  clearRegion(id: number): GrassChangeData | null {
    const s = this.state.get(id)
    if (!s) return null
    const keys: number[] = [], before: number[] = []
    const rx = id & 0xff, rz = id >> 8
    for (let i = 0; i < s.length; i++) {
      if (!s[i]) continue
      keys.push(grassKey(rx * WE_GRASS + (i % WE_GRASS), rz * WE_GRASS + Math.floor(i / WE_GRASS)))
      before.push(s[i]!)
    }
    if (!keys.length) return null
    const c = this.makeChange(keys, before, keys.map(() => UNTOUCHED), 'clear')
    this.apply(c, 'after')
    return c
  }

  /** The packed state of global texel (TX, TZ) (0: untouched). */
  at(TX: number, TZ: number): number {
    const id = regionIdOf(Math.floor(TX / WE_GRASS), Math.floor(TZ / WE_GRASS))
    const s = this.state.get(id)
    if (!s) return UNTOUCHED
    return s[(TZ - Math.floor(TZ / WE_GRASS) * WE_GRASS) * WE_GRASS + (TX - Math.floor(TX / WE_GRASS) * WE_GRASS)]!
  }

  /** The density multiplier and flower amount at glTF (x, z) (1, 0 untouched). */
  sample(x: number, z: number): { density: number; flowers: number; kind: number } {
    const v = this.at(Math.floor(x) + WE_GRASS * this.ox, Math.floor(-z) + WE_GRASS * this.oz)
    if (!v) return { density: 1, flowers: 0, kind: 0 }
    return { density: (v & 0xff) / WE_GRASS_DENSITY_ONE, flowers: ((v >> 8) & 0xff) / 255, kind: (v >> 16) & 0xff }
  }

  get stroking(): boolean {
    return this.stroke !== null
  }

  begin(mode: GrassMode, params: BrushParams, kind = FLOWER_KIND): void {
    this.stroke = new Map()
    this.mode = mode
    this.kind = kind
    this.params = { ...params }
  }

  setParams(params: BrushParams): void {
    this.params = { ...params }
  }

  stamp(cx: number, cz: number): number {
    const s = this.stroke
    if (!s) return 0
    const { radiusM, strength, softness } = this.params
    const TXc = cx + WE_GRASS * this.ox, TZc = -cz + WE_GRASS * this.oz
    const x0 = Math.floor(TXc - radiusM), x1 = Math.floor(TXc + radiusM), z0 = Math.floor(TZc - radiusM), z1 = Math.floor(TZc + radiusM)
    let n = 0
    for (let TZ = z0; TZ <= z1; TZ++) {
      for (let TX = x0; TX <= x1; TX++) {
        const f = falloff(Math.hypot(TX + 0.5 - TXc, TZ + 0.5 - TZc), radiusM, softness)
        if (f <= 0) continue
        if (!this.exists(regionIdOf(Math.floor(TX / WE_GRASS), Math.floor(TZ / WE_GRASS)))) continue
        const cur = this.at(TX, TZ)
        const next = this.next(cur, f * strength)
        if (next === cur) continue
        const key = grassKey(TX, TZ)
        if (!s.has(key)) s.set(key, cur)
        this.set(TX, TZ, next)
        n++
      }
    }
    return n
  }

  end(): GrassChangeData | null {
    const s = this.stroke
    this.stroke = null
    if (!s || !s.size) return null
    const keys: number[] = [], before: number[] = [], after: number[] = []
    for (const [key, b] of s) {
      const a = this.at(Math.floor(key / 65536), key % 65536)
      if (a === b) continue
      keys.push(key)
      before.push(b)
      after.push(a)
    }
    return keys.length ? this.makeChange(keys, before, after, this.mode) : null
  }

  cancel(): void {
    const s = this.stroke
    this.stroke = null
    if (!s) return
    for (const [key, b] of s) this.set(Math.floor(key / 65536), key % 65536, b)
  }

  apply(c: GrassChangeData, which: 'before' | 'after'): void {
    const v = which === 'before' ? c.before : c.after
    for (let i = 0; i < c.keys.length; i++) this.set(Math.floor(c.keys[i]! / 65536), c.keys[i]! % 65536, v[i]!)
  }

  /** The packed state of a texel key, and its setter (the journal's rebase). */
  getKey(key: number): number {
    return this.at(Math.floor(key / 65536), key % 65536)
  }

  setKey(key: number, v: number): void {
    this.set(Math.floor(key / 65536), key % 65536, v)
  }

  takeDirty(): number[] {
    const out = [...this.dirty]
    this.dirty.clear()
    return out
  }

  // ---- internals ----------------------------------------------------------------------------------------------------

  private next(cur: number, f: number): number {
    const density = cur ? cur & 0xff : WE_GRASS_DENSITY_ONE
    const flowers = cur ? (cur >> 8) & 0xff : 0
    const kind = cur ? (cur >> 16) & 0xff : 0
    switch (this.mode) {
      case 'clear':
        return UNTOUCHED
      case 'less':
        return pack(Math.max(0, Math.round(density - GRASS_RATE * f)), flowers, kind)
      case 'more':
        return pack(Math.min(255, Math.round(density + GRASS_RATE * f)), flowers, kind)
      case 'flowers': {
        const target = Math.round(255 * Math.min(1, f))
        return pack(density, Math.max(kind === this.kind ? flowers : 0, target), this.kind)
      }
    }
  }

  private makeChange(keys: number[], before: number[], after: number[], mode: GrassMode): GrassChangeData {
    const regions = new Set<number>()
    for (const k of keys) regions.add(regionIdOf(Math.floor(Math.floor(k / 65536) / WE_GRASS), Math.floor((k % 65536) / WE_GRASS)))
    return { keys: Float64Array.from(keys), before: Uint32Array.from(before), after: Uint32Array.from(after), regions: [...regions].sort((a, b) => a - b), mode }
  }

  private stateArr(id: number): Uint32Array {
    let s = this.state.get(id)
    if (!s) this.state.set(id, (s = new Uint32Array(WE_GRASS * WE_GRASS)))
    return s
  }

  private set(TX: number, TZ: number, v: number): void {
    const rx = Math.floor(TX / WE_GRASS), rz = Math.floor(TZ / WE_GRASS)
    const id = regionIdOf(rx, rz)
    const s = this.stateArr(id)
    const i = (TZ - rz * WE_GRASS) * WE_GRASS + (TX - rx * WE_GRASS)
    if (s[i] === v) return
    s[i] = v
    this.dirty.add(id)
  }
}

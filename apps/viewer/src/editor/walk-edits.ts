/**
 * The Walkable brush (docs/WORLD_EDITOR.md §4.7, D29): per 2 m nav tile an override over the nav rule, WE_WALK codes
 * (0 auto, 1 force open, 2 force closed), saved as walk/<x>_<z>.png. The nav rule applies it last (shared
 * nav-rule.ts), so force open opens even a retail-closed or steep tile and force closed closes an open one.
 *
 * Tiles never share a seam: global tile TX = 96 rx + tx, TZ = 96 rz + tz (x east, z north, 2 m). A stroke marks every
 * tile whose centre lies inside the brush (hard edge; strength and softness do not apply). Force open refuses the
 * tiles the hard limits forbid (shared world-edits/walk.ts `walkRefusals`: outside the playable bounds, in the sea,
 * under a building or object); `refused` counts them per stroke, for the status line. Undo / redo / revert one are
 * exact (one byte per tile).
 */
import {
  WE_TILES, WE_WALK, noWalkRefusals, walkRefusalKind, type WalkLayer, type WalkRefusalCounts,
} from '../../../../packages/shared/src/world-edits/index.ts'
import { regionIdOf } from './lattice.ts'

export type WalkMode = 'open' | 'close' | 'auto'

const CODE: Record<WalkMode, number> = { open: WE_WALK.open, close: WE_WALK.closed, auto: WE_WALK.auto }

export const walkKey = (TX: number, TZ: number) => TX * 65536 + TZ
const keyTX = (k: number) => Math.floor(k / 65536)
const keyTZ = (k: number) => k % 65536

export interface WalkChangeData {
  keys: Float64Array
  before: Uint8Array
  after: Uint8Array
  regions: number[]
  mode: WalkMode
}

export class WalkEdits {
  private readonly codes = new Map<number, Uint8Array>()
  private readonly dirty = new Set<number>()
  private stroke: Map<number, number> | null = null
  private refusedKeys = new Map<number, number>()
  private mode: WalkMode = 'open'
  private radiusM = 10
  /** The hard limits of a region (96 x 96 WALK_REFUSAL codes), or null: none known. The page sets it. */
  guard: ((id: number) => ArrayLike<number> | null) | null = null

  constructor(
    readonly ox: number,
    readonly oz: number,
    private readonly exists: (id: number) => boolean,
  ) {}

  touchedRegions(): number[] {
    const out: number[] = []
    for (const [id, c] of this.codes) if (c.some(v => v !== WE_WALK.auto)) out.push(id)
    return out.sort((a, b) => a - b)
  }

  /** The region's live codes (96 x 96, tz * 96 + tx; read only), or null when it has no override. */
  codesOf(id: number): Uint8Array | null {
    const c = this.codes.get(id)
    return c && c.some(v => v !== WE_WALK.auto) ? c : null
  }

  /** The region's layer for Save (null: no override). */
  layer(id: number): WalkLayer | null {
    const c = this.codesOf(id)
    return c ? { codes: Uint8Array.from(c) } : null
  }

  loadLayer(id: number, layer: WalkLayer): void {
    this.codesArr(id).set(layer.codes)
    this.dirty.add(id)
  }

  clearRegion(id: number): WalkChangeData | null {
    const c = this.codes.get(id)
    if (!c) return null
    const keys: number[] = [], before: number[] = []
    const rx = id & 0xff, rz = id >> 8
    for (let i = 0; i < c.length; i++) {
      if (!c[i]) continue
      keys.push(walkKey(rx * WE_TILES + (i % WE_TILES), rz * WE_TILES + Math.floor(i / WE_TILES)))
      before.push(c[i]!)
    }
    if (!keys.length) return null
    const ch = this.makeChange(keys, before, keys.map(() => WE_WALK.auto), 'auto')
    this.apply(ch, 'after')
    return ch
  }

  /** The code of global tile (TX, TZ) (0: auto). */
  at(TX: number, TZ: number): number {
    const rx = Math.floor(TX / WE_TILES), rz = Math.floor(TZ / WE_TILES)
    const c = this.codes.get(regionIdOf(rx, rz))
    return c ? c[(TZ - rz * WE_TILES) * WE_TILES + (TX - rx * WE_TILES)]! : WE_WALK.auto
  }

  /** The global tile under glTF (x, z). */
  tileAt(x: number, z: number): { TX: number; TZ: number } {
    return { TX: Math.floor(x / 2) + WE_TILES * this.ox, TZ: Math.floor(-z / 2) + WE_TILES * this.oz }
  }

  get stroking(): boolean {
    return this.stroke !== null
  }

  /** The tiles the current (or last) stroke could not force open, by reason. */
  get refused(): WalkRefusalCounts {
    const out = noWalkRefusals()
    for (const code of this.refusedKeys.values()) out[walkRefusalKind(code)!]++
    return out
  }

  begin(mode: WalkMode, radiusM: number): void {
    this.stroke = new Map()
    this.refusedKeys = new Map()
    this.mode = mode
    this.radiusM = radiusM
  }

  setRadius(radiusM: number): void {
    this.radiusM = radiusM
  }

  /** Marks the tiles whose centre lies within the brush at glTF (cx, cz) (always the tile under it); returns how many changed. */
  stamp(cx: number, cz: number): number {
    const s = this.stroke
    if (!s) return 0
    const want = CODE[this.mode]
    const TXc = cx / 2 + WE_TILES * this.ox, TZc = -cz / 2 + WE_TILES * this.oz
    const r = this.radiusM / 2
    const x0 = Math.floor(TXc - r), x1 = Math.floor(TXc + r), z0 = Math.floor(TZc - r), z1 = Math.floor(TZc + r)
    const under = { TX: Math.floor(TXc), TZ: Math.floor(TZc) }
    const guards = new Map<number, ArrayLike<number> | null>()
    const guardOf = (id: number) => {
      let g = guards.get(id)
      if (g === undefined) guards.set(id, (g = this.guard?.(id) ?? null))
      return g
    }
    let n = 0
    for (let TZ = z0; TZ <= z1; TZ++) {
      for (let TX = x0; TX <= x1; TX++) {
        if (Math.hypot(TX + 0.5 - TXc, TZ + 0.5 - TZc) > r && !(TX === under.TX && TZ === under.TZ)) continue
        const rx = Math.floor(TX / WE_TILES), rz = Math.floor(TZ / WE_TILES)
        const id = regionIdOf(rx, rz)
        if (!this.exists(id)) continue
        const cur = this.at(TX, TZ)
        if (cur === want) continue
        const key = walkKey(TX, TZ)
        if (want === WE_WALK.open) {
          const why = guardOf(id)?.[(TZ - rz * WE_TILES) * WE_TILES + (TX - rx * WE_TILES)] ?? 0
          if (why) {
            this.refusedKeys.set(key, why)
            continue
          }
        }
        if (!s.has(key)) s.set(key, cur)
        this.set(TX, TZ, want)
        n++
      }
    }
    return n
  }

  end(): WalkChangeData | null {
    const s = this.stroke
    this.stroke = null
    if (!s || !s.size) return null
    const keys: number[] = [], before: number[] = [], after: number[] = []
    for (const [key, b] of s) {
      const a = this.at(keyTX(key), keyTZ(key))
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
    for (const [key, b] of s) this.set(keyTX(key), keyTZ(key), b)
  }

  apply(c: WalkChangeData, which: 'before' | 'after'): void {
    const v = which === 'before' ? c.before : c.after
    for (let i = 0; i < c.keys.length; i++) this.set(keyTX(c.keys[i]!), keyTZ(c.keys[i]!), v[i]!)
  }

  /** The code of a tile key, and its setter (the journal's rebase). */
  getKey(key: number): number {
    return this.at(keyTX(key), keyTZ(key))
  }

  setKey(key: number, v: number): void {
    this.set(keyTX(key), keyTZ(key), v)
  }

  /** Regions whose codes changed since the last call (the walking overlay and the nav preview follow them). */
  takeDirty(): number[] {
    const out = [...this.dirty]
    this.dirty.clear()
    return out
  }

  // ---- internals ----------------------------------------------------------------------------------------------------

  private makeChange(keys: number[], before: number[], after: number[], mode: WalkMode): WalkChangeData {
    const regions = new Set<number>()
    for (const k of keys) regions.add(regionIdOf(Math.floor(keyTX(k) / WE_TILES), Math.floor(keyTZ(k) / WE_TILES)))
    return { keys: Float64Array.from(keys), before: Uint8Array.from(before), after: Uint8Array.from(after), regions: [...regions].sort((a, b) => a - b), mode }
  }

  private codesArr(id: number): Uint8Array {
    let c = this.codes.get(id)
    if (!c) this.codes.set(id, (c = new Uint8Array(WE_TILES * WE_TILES)))
    return c
  }

  private set(TX: number, TZ: number, v: number): void {
    const rx = Math.floor(TX / WE_TILES), rz = Math.floor(TZ / WE_TILES)
    const id = regionIdOf(rx, rz)
    const c = this.codesArr(id)
    const i = (TZ - rz * WE_TILES) * WE_TILES + (TX - rx * WE_TILES)
    if (c[i] === v) return
    c[i] = v
    this.dirty.add(id)
  }
}

/**
 * Texture paint (docs/WORLD_EDITOR.md §4.3, §3.1, D9): the brush writes the per-vertex texture word (2 m, the native
 * resolution of retail paint; bits 0-9 the tile id, 13-15 the tiling code) on the global lattice, into every region
 * holding a vertex (seams agree). The native layering is rebuilt from the words by the world renderer's `relayer`
 * (S-TERR), the converter's own rule, so an edge looks like a retail edge.
 *
 * State per region: the export's words (`base`, captured at decode) and the painted word per vertex (-1: unpainted).
 * A stroke covers each vertex inside the brush with probability falloff x strength (a fixed hash of the vertex: soft
 * edges are dithered the same way every time); Shift erases (back to the export's word). Undo / redo / revert one are
 * exact (integers).
 */
import { paintWord, paintWordTile, paintWordTiling, type PaintLayer } from '../../../../packages/shared/src/world-edits/index.ts'
import { CELL_M, CELLS, GRID, Lattice, falloff, hash01, keyGX, keyGZ, latticeKey } from './lattice.ts'
import type { BrushParams, DirtyRect } from './terrain-edits.ts'

/** Live texture words of the resident regions (TerrainBin.textures: read only here; updates go through S-TERR). */
export interface WordsHost {
  words(id: number): Uint16Array | null
}

export interface PaintChangeData {
  keys: Float64Array
  /** -1: unpainted (the export's word). */
  before: Int32Array
  after: Int32Array
  regions: number[]
  /** The tile painted (-1: erased). */
  tile: number
}

const DITHER_SEED = 0x5a1d

export class PaintEdits {
  private readonly base = new Map<number, Uint16Array>()
  private readonly paint = new Map<number, Int32Array>()
  private readonly dirty = new Map<number, DirtyRect>()
  private stroke: Map<number, number> | null = null
  private word = -1
  private params: BrushParams = { radiusM: 10, strength: 1, softness: 0.3 }

  constructor(readonly lattice: Lattice, private readonly host: WordsHost) {}

  /** A region was decoded: its words are the export's; returns the painted words to apply (null: none). */
  captureBase(id: number, words: Uint16Array): Uint16Array | null {
    this.base.set(id, Uint16Array.from(words))
    const p = this.paint.get(id)
    if (!p || !p.some(v => v >= 0)) return null
    return this.wordsFor(id)
  }

  /** The region's words with the paint on top (a new array), or null when the region was never decoded here. */
  wordsFor(id: number): Uint16Array | null {
    const b = this.base.get(id) ?? this.host.words(id)
    if (!b) return null
    const out = Uint16Array.from(b)
    const p = this.paint.get(id)
    if (p) for (let i = 0; i < p.length; i++) if (p[i]! >= 0) out[i] = p[i]!
    return out
  }

  touchedRegions(): number[] {
    const out: number[] = []
    for (const [id, p] of this.paint) if (p.some(v => v >= 0)) out.push(id)
    return out.sort((a, b) => a - b)
  }

  layer(id: number): PaintLayer | null {
    const p = this.paint.get(id)
    if (!p) return null
    const words = new Uint16Array(GRID * GRID)
    const mask = new Uint8Array(GRID * GRID)
    let any = false
    for (let i = 0; i < p.length; i++) {
      if (p[i]! < 0) continue
      words[i] = p[i]!
      mask[i] = 1
      any = true
    }
    return any ? { words, mask } : null
  }

  loadLayer(id: number, layer: PaintLayer): void {
    const p = this.paintArr(id)
    for (let i = 0; i < p.length; i++) p[i] = layer.mask[i] ? layer.words[i]! : -1
    this.markAll(id)
  }

  clearRegion(id: number): PaintChangeData | null {
    const p = this.paint.get(id)
    if (!p) return null
    const keys: number[] = [], before: number[] = []
    const rx = id & 0xff, rz = id >> 8
    for (let i = 0; i < p.length; i++) {
      if (p[i]! < 0) continue
      keys.push(latticeKey(rx * CELLS + (i % GRID), rz * CELLS + Math.floor(i / GRID)))
      before.push(p[i]!)
    }
    if (!keys.length) return null
    const c = this.makeChange(keys, before, keys.map(() => -1), -1)
    this.apply(c, 'after')
    return c
  }

  /** The painted word of a lattice vertex (-1: unpainted). */
  paintAt(GX: number, GZ: number): number {
    const L = this.lattice
    const n = L.holdersOf(GX, GZ)
    for (let k = 0; k < n; k++) {
      const p = this.paint.get(L.holders[k * 2]!)
      if (p) return p[L.holders[k * 2 + 1]!]!
    }
    return -1
  }

  /** The word the ground shows at a lattice vertex (painted, else the export's), or -1 when not loaded. */
  wordAt(GX: number, GZ: number): number {
    const p = this.paintAt(GX, GZ)
    if (p >= 0) return p
    const L = this.lattice
    const n = L.holdersOf(GX, GZ)
    for (let k = 0; k < n; k++) {
      const w = this.base.get(L.holders[k * 2]!) ?? this.host.words(L.holders[k * 2]!)
      if (w) return w[L.holders[k * 2 + 1]!]!
    }
    return -1
  }

  // ---- strokes ------------------------------------------------------------------------------------------------------

  get stroking(): boolean {
    return this.stroke !== null
  }

  /** Starts a stroke painting `word` (paintWord(tile, tiling)), or erasing (word -1: back to the export's). */
  begin(word: number, params: BrushParams): void {
    this.stroke = new Map()
    this.word = word
    this.params = { ...params }
  }

  setParams(params: BrushParams): void {
    this.params = { ...params }
  }

  stamp(cx: number, cz: number): number {
    const s = this.stroke
    if (!s) return 0
    const L = this.lattice
    const { radiusM, strength, softness } = this.params
    const GXc = L.toGX(cx), GZc = L.toGZ(cz)
    const rv = radiusM / CELL_M
    const x0 = Math.ceil(GXc - rv), x1 = Math.floor(GXc + rv), z0 = Math.ceil(GZc - rv), z1 = Math.floor(GZc + rv)
    let n = 0
    for (let GZ = z0; GZ <= z1; GZ++) {
      for (let GX = x0; GX <= x1; GX++) {
        const f = falloff(Math.hypot(GX - GXc, GZ - GZc) * CELL_M, radiusM, softness) * strength
        if (f <= 0 || hash01(GX, GZ, DITHER_SEED) >= f) continue
        if (this.wordAt(GX, GZ) < 0) continue
        const cur = this.paintAt(GX, GZ)
        if (cur === this.word) continue
        const key = latticeKey(GX, GZ)
        if (!s.has(key)) s.set(key, cur)
        this.set(GX, GZ, this.word)
        n++
      }
    }
    return n
  }

  end(): PaintChangeData | null {
    const s = this.stroke
    this.stroke = null
    if (!s || !s.size) return null
    const keys: number[] = [], before: number[] = [], after: number[] = []
    for (const [key, b] of s) {
      const a = this.paintAt(keyGX(key), keyGZ(key))
      if (a === b) continue
      keys.push(key)
      before.push(b)
      after.push(a)
    }
    return keys.length ? this.makeChange(keys, before, after, this.word < 0 ? -1 : paintWordTile(this.word)) : null
  }

  cancel(): void {
    const s = this.stroke
    this.stroke = null
    if (!s) return
    for (const [key, b] of s) this.set(keyGX(key), keyGZ(key), b)
  }

  apply(c: PaintChangeData, which: 'before' | 'after'): void {
    const v = which === 'before' ? c.before : c.after
    for (let i = 0; i < c.keys.length; i++) this.set(keyGX(c.keys[i]!), keyGZ(c.keys[i]!), v[i]!)
  }

  /** The painted value of a lattice key (-1: unpainted), and its setter (the journal's rebase). */
  getKey(key: number): number {
    return this.paintAt(keyGX(key), keyGZ(key))
  }

  setKey(key: number, v: number): void {
    this.set(keyGX(key), keyGZ(key), v)
  }

  takeDirty(): Array<{ id: number; rect: DirtyRect }> {
    const out = [...this.dirty].map(([id, rect]) => ({ id, rect }))
    this.dirty.clear()
    return out
  }

  // ---- internals ----------------------------------------------------------------------------------------------------

  private makeChange(keys: number[], before: number[], after: number[], tile: number): PaintChangeData {
    const regions = new Set<number>()
    for (const key of keys) {
      const n = this.lattice.holdersOf(keyGX(key), keyGZ(key))
      for (let k = 0; k < n; k++) regions.add(this.lattice.holders[k * 2]!)
    }
    return { keys: Float64Array.from(keys), before: Int32Array.from(before), after: Int32Array.from(after), regions: [...regions].sort((a, b) => a - b), tile }
  }

  private paintArr(id: number): Int32Array {
    let p = this.paint.get(id)
    if (!p) {
      // a resident region never painted by this session still shows the export's words: its base
      const w = this.base.has(id) ? null : this.host.words(id)
      if (w) this.base.set(id, Uint16Array.from(w))
      this.paint.set(id, (p = new Int32Array(GRID * GRID).fill(-1)))
    }
    return p
  }

  private set(GX: number, GZ: number, v: number): void {
    const L = this.lattice
    const n = L.holdersOf(GX, GZ)
    for (let k = 0; k < n; k++) {
      const id = L.holders[k * 2]!, i = L.holders[k * 2 + 1]!
      const p = this.paintArr(id)
      if (p[i] === v) continue
      p[i] = v
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

/**
 * The tiling code a tile is usually painted with in the export (§4.3: "the tile's most common code"): counted over
 * the given regions' words; a tile not found takes the most common code of all.
 */
export function tilingCodes(regionsWords: Iterable<ArrayLike<number>>): { forTile(tile: number): number } {
  const counts = new Map<number, number[]>()
  const all = new Array<number>(8).fill(0)
  for (const words of regionsWords) {
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!
      const t = paintWordTile(w), c = paintWordTiling(w)
      let a = counts.get(t)
      if (!a) counts.set(t, (a = new Array<number>(8).fill(0)))
      a[c]!++
      all[c]!++
    }
  }
  const mode = (a: number[]) => a.reduce((best, v, i) => (v > a[best]! ? i : best), 0)
  const fallback = mode(all)
  return { forTile: (tile: number) => (counts.has(tile) ? mode(counts.get(tile)!) : fallback) }
}

export { paintWord }

/**
 * The terrain grass tint at run time (docs/GRASS_LIFE.md §3.3 "beyond the far tier", X6; lane GL-T): fills the
 * uniforms of grass/chunks.ts's `sroGrassTint` extern on the PBR terrain and switches its define.
 *
 * - **On** while GRASS_LIFE's field draws (the scatter's ground cover is the 'field' style and Grass is not Off); the
 *   define `SRO_GRASS_TINT` then goes on the terrain (TerrainRenderer.setDefine: one recompile, an Options-time
 *   event). Off (Low / Classic, the retail style, Grass: Off): the define is off and no shared value is set, so the
 *   terrain's strings and bindings are today's.
 * - **The table** (`sroGt0..5`): one byte per tile-array layer, the grass weight (4 bits) and palette slot (4 bits) of
 *   the tile living there (grass/bake.ts `grassTileTable`: GL-C's weights and palettes, else the built-in rule). The
 *   streamer's atlas assigns layers as tiles come and go (tile-atlas.ts), so `update` re-reads the layer of every grass
 *   tile each frame (a few dozen map reads, no allocation) and repacks only when one moved.
 * - **The palette** (`sroGtPal`): per slot the blade colour a distant viewer sees: `mix(base, tip, TIP_SHARE) × SHADE`
 *   (the blades are lit from `vShade` 0.5 at the root to 1 at the tip and seen mostly from their upper part).
 * - **The fade** (`sroGtFade`): the far tier's thinning of the level the field draws at (grass/cull.ts GRASS_LEVELS:
 *   tier-0 blades drop out one by one between `cut0 − 6` and `cut0.max`), the near and far strengths.
 * - **The far carpet** (GRASS_FAR, docs/GRASS_FAR.md §4): `sroGtLook` = the level's tuft pattern share and band noise
 *   (Medium and High 1 and 10 m; Low 0 and 0: today's look), `sroGtWind` = the wind the sheen follows, every frame from
 *   the weather's `wxB` on the terrain (direction, strength, its sway clock), else a calm breeze on the tint's clock;
 *   × the level's sheen share.
 */
import { Matrix, Vector4 } from '@babylonjs/core'
import type { TileTexture } from '../../../convert/src/world/manifest.ts'
import type { ScatterLevel } from '../scatter.ts'
import { grassTileTable, type GrassTileTable } from './bake.ts'
import {
  GRASS_TINT_FADE_UNIFORM,
  GRASS_TINT_LAYERS,
  GRASS_TINT_LOOK_UNIFORM,
  GRASS_TINT_WIND_UNIFORM,
  GRASS_TINT_MATRICES,
  GRASS_TINT_PALETTE_UNIFORM,
  GRASS_TINT_PER_FLOAT,
  GRASS_TINT_SLOTS,
  GRASS_TINT_TABLE_UNIFORMS,
  GRASS_TINT_WEIGHT_STEPS,
} from './chunks.ts'
import { GRASS_LEVELS, RING_OUT_NOISE_M, type GrassLevel } from './cull.ts'
import { GRASS_TINT_DEFINE } from './types.ts'

/**
 * How far along the blade (base → tip) its seen colour sits, and the blade's mean shade there. SHADE was matched in the
 * viewer (High, WebGL2, noon, 55 m up): the carpet at 50–60 m and the tinted ground at 100 m read the same colour
 * but for the fog's blue (≈ (62, 73, 20) vs (61, 73, 28) sRGB); 0.85 read ≈ 15 % too bright.
 */
export const GRASS_TINT_TIP_SHARE = 0.65
export const GRASS_TINT_SHADE = 0.72
/**
 * The pull toward the palette under the carpet and beyond it (× the grass density). Near 0: the ground between the
 * blades keeps its texture and the shader skips its layer loop there (the cost stays ≤ 0.1 ms, §5).
 */
export const GRASS_TINT_NEAR = 0
export const GRASS_TINT_FAR = 0.85
/** The breeze the sheen follows without a weather (direction x, z, strength 0..1). */
export const GRASS_TINT_CALM_WIND = [0.8, 0.6, 0.1] as const

type Rgb = readonly [number, number, number]
type TintTile = Pick<TileTexture, 'id' | 'typeName' | 'source' | 'grass'> & { file?: string }

/** A tile's table byte: weight in the high nibble (0: no grass), palette slot in the low one. */
export function grassTintByte(weight: number, slot: number): number {
  const w = Math.round(Math.min(1, Math.max(0, weight)) * GRASS_TINT_WEIGHT_STEPS)
  return w > 0 ? (w << 4) | (Math.max(0, Math.min(GRASS_TINT_SLOTS - 1, slot | 0))) : 0
}

/** Packs one byte per layer into the table's floats (three per float, little end first). */
export function packGrassTintTable(bytes: ArrayLike<number>, out: Float32Array = new Float32Array(GRASS_TINT_MATRICES * 16)): Float32Array {
  for (let i = 0; i < out.length; i++) {
    const b = i * GRASS_TINT_PER_FLOAT
    out[i] = (bytes[b] ?? 0) + (bytes[b + 1] ?? 0) * 256 + (bytes[b + 2] ?? 0) * 65536
  }
  return out
}

/** The table byte of `layer` from packed floats (the shader's `sroGtEntry`, for tests and tools). */
export function readGrassTintTable(floats: ArrayLike<number>, layer: number): number {
  const b = Math.max(0, Math.min(GRASS_TINT_LAYERS - 1, layer))
  const v = Math.round(floats[Math.floor(b / GRASS_TINT_PER_FLOAT)] ?? 0)
  return Math.floor(v / 256 ** (b % GRASS_TINT_PER_FLOAT)) & 255
}

/** The colour a distant viewer sees of a palette (display sRGB 0..1). */
export function grassTintMid(base: Rgb, tip: Rgb): [number, number, number] {
  return [0, 1, 2].map(i => Math.min(1, Math.max(0, (base[i]! + (tip[i]! - base[i]!) * GRASS_TINT_TIP_SHARE) * GRASS_TINT_SHADE))) as [number, number, number]
}

/** The palette matrix's 16 floats: each slot's mid colour as sRGB 8:8:8 (`grPal`'s (base, tip) pairs in, GrassTileTable). */
export function grassTintPalette(palette: readonly number[], out: Float32Array = new Float32Array(16)): Float32Array {
  for (let s = 0; s < GRASS_TINT_SLOTS; s++) {
    const o = s * 8
    const base: Rgb = [palette[o] ?? 0, palette[o + 1] ?? 0, palette[o + 2] ?? 0]
    const tip: Rgb = [palette[o + 4] ?? 0, palette[o + 5] ?? 0, palette[o + 6] ?? 0]
    const [r, g, b] = grassTintMid(base, tip).map(v => Math.round(v * 255))
    out[s] = r! + g! * 256 + b! * 65536
  }
  return out
}

/** The fade vector of a grass level: (ramp start, ramp end, near, far). */
export function grassTintFade(level: Pick<GrassLevel, 'cut0'>, out: Vector4 = new Vector4()): Vector4 {
  return out.set(Math.max(0, level.cut0[0] - 6), level.cut0[1], GRASS_TINT_NEAR, GRASS_TINT_FAR)
}

/**
 * The look vector of a grass level: (tuft pattern share, band noise m, the meadow ring's outer fade start and end m, or
 * 0, 0 without a ring).
 */
export function grassTintLook(level: Pick<GrassLevel, 'carpet' | 'band' | 'ring'>, out: Vector4 = new Vector4()): Vector4 {
  const r = level.ring
  return out.set(level.carpet.pattern, level.band, r ? r.out[0] - RING_OUT_NOISE_M : 0, r ? r.out[1] + RING_OUT_NOISE_M : 0)
}

/**
 * The wind vector: the weather's `wxB` (direction x, z; strength 0..1; time s) normalised, × the sheen share; without
 * one, GRASS_TINT_CALM_WIND at `clockS`.
 */
export function grassTintWind(wx: { x: number; y: number; z: number; w: number } | null, sheen: number, clockS: number, out: Vector4 = new Vector4()): Vector4 {
  let [x, z, strength] = GRASS_TINT_CALM_WIND as readonly number[] as [number, number, number]
  let t = clockS
  if (wx) {
    const l = Math.hypot(wx.x, wx.y)
    if (l > 1e-3) {
      x = wx.x / l
      z = wx.y / l
    }
    strength = Math.min(1, Math.max(0, wx.z))
    t = wx.w
  }
  return out.set(x, z, sheen * (0.35 + 0.65 * strength), t)
}

/** Where the tint writes: the terrain renderer's shared values and defines (TerrainRenderer). */
export interface GrassTintTarget {
  readonly sharedUniforms: { set(name: string, value: Matrix | Vector4): unknown; delete(name: string): boolean; get?(name: string): unknown }
  setDefine(name: string, on: boolean): void
}

export interface GrassTintSource {
  readonly terrain: GrassTintTarget
  readonly tiles: readonly TintTile[]
  /** The tile-array layer of a tile (the streamer's atlas; undefined: not resident). */
  layerOf(id: number): number | undefined
  /** The level the field draws at, or null (no field: Classic, the retail style, Grass: Off). */
  level(): ScatterLevel | null
}

export interface GrassTintStats {
  active: boolean
  /** Tiles with grass, and how many of them hold a layer now. */
  grassTiles: number
  resident: number
  /** Table repacks so far. */
  repacks: number
}

export class GrassTerrainTint {
  readonly table: readonly Matrix[] = GRASS_TINT_TABLE_UNIFORMS.map(() => new Matrix())
  readonly palette = new Matrix()
  readonly fade = new Vector4()
  /** GRASS_FAR: the far carpet's look and the wind its sheen follows. */
  readonly look = new Vector4()
  readonly wind = new Vector4()
  readonly stats: GrassTintStats = { active: false, grassTiles: 0, resident: 0, repacks: 0 }
  readonly tiles: GrassTileTable
  private readonly ids: Int32Array
  private readonly codes: Uint8Array
  private readonly layers: Int32Array
  private readonly bytes = new Uint8Array(GRASS_TINT_LAYERS)
  private readonly floats = new Float32Array(GRASS_TINT_MATRICES * 16)
  private levelName: ScatterLevel | null = null
  private sheen = 0
  private disposed = false

  constructor(private readonly src: GrassTintSource) {
    this.tiles = grassTileTable(src.tiles)
    const ids: number[] = []
    const codes: number[] = []
    for (const [id, w] of this.tiles.weight) {
      const code = grassTintByte(w, this.tiles.slot.get(id) ?? 0)
      if (!code) continue
      ids.push(id)
      codes.push(code)
    }
    this.ids = Int32Array.from(ids)
    this.codes = Uint8Array.from(codes)
    this.layers = new Int32Array(ids.length).fill(-2)
    this.stats.grassTiles = ids.length
    Matrix.FromArrayToRef(grassTintPalette(this.tiles.palette), 0, this.palette)
  }

  get active(): boolean {
    return this.stats.active
  }

  /** Per frame (World.update, after the scatter): follows the field's level and the atlas' layers. */
  update(): void {
    if (this.disposed) return
    const name = this.src.level()
    const level = name ? GRASS_LEVELS[name] : null
    const want = !!level && this.ids.length > 0
    if (!want) {
      if (this.stats.active) this.switchOff()
      return
    }
    if (name !== this.levelName) {
      this.levelName = name
      grassTintFade(level!, this.fade)
      grassTintLook(level!, this.look)
      this.sheen = level!.carpet.sheen
    }
    const wx = this.src.terrain.sharedUniforms.get?.('wxB')
    grassTintWind(wx instanceof Vector4 ? wx : null, this.sheen, performance.now() / 1000, this.wind)
    let moved = false
    for (let i = 0; i < this.ids.length; i++) {
      const l = this.src.layerOf(this.ids[i]!)
      const layer = l === undefined || l < 0 || l >= GRASS_TINT_LAYERS ? -1 : l
      if (layer !== this.layers[i]) {
        this.layers[i] = layer
        moved = true
      }
    }
    if (moved) this.repack()
    if (!this.stats.active) this.switchOn()
  }

  private repack(): void {
    const bytes = this.bytes
    bytes.fill(0)
    let resident = 0
    for (let i = 0; i < this.ids.length; i++) {
      const l = this.layers[i]!
      if (l < 0) continue
      bytes[l] = this.codes[i]!
      resident++
    }
    packGrassTintTable(bytes, this.floats)
    this.table.forEach((m, q) => Matrix.FromArrayToRef(this.floats, q * 16, m))
    this.stats.resident = resident
    this.stats.repacks++
  }

  private switchOn(): void {
    const u = this.src.terrain.sharedUniforms
    this.table.forEach((m, q) => u.set(GRASS_TINT_TABLE_UNIFORMS[q]!, m))
    u.set(GRASS_TINT_PALETTE_UNIFORM, this.palette)
    u.set(GRASS_TINT_FADE_UNIFORM, this.fade)
    u.set(GRASS_TINT_LOOK_UNIFORM, this.look)
    u.set(GRASS_TINT_WIND_UNIFORM, this.wind)
    this.src.terrain.setDefine(GRASS_TINT_DEFINE, true)
    this.stats.active = true
  }

  private switchOff(): void {
    this.src.terrain.setDefine(GRASS_TINT_DEFINE, false)
    const u = this.src.terrain.sharedUniforms
    for (const name of [...GRASS_TINT_TABLE_UNIFORMS, GRASS_TINT_PALETTE_UNIFORM, GRASS_TINT_FADE_UNIFORM, GRASS_TINT_LOOK_UNIFORM, GRASS_TINT_WIND_UNIFORM]) u.delete(name)
    this.stats.active = false
    this.levelName = null
  }

  dispose(): void {
    if (this.disposed) return
    if (this.stats.active) this.switchOff()
    this.disposed = true
  }
}

/** What worldGrassTint reads from a World (structural: world.ts imports this file). */
export interface GrassTintWorld {
  readonly terrain: GrassTintTarget
  readonly manifest: { readonly tiles: readonly TintTile[] }
  readonly stream: { readonly atlas: { layerOf(id: number): number | undefined } } | null
  readonly scatter: { readonly level: ScatterLevel; readonly groundCover: { readonly style: string } | null }
}

/**
 * The tint of a World: layers from the streamer's atlas, or a whole-world load's (TerrainRenderer.loadTiles: the
 * manifest's tile order); on while the scatter's ground cover is the field and Grass is not Off.
 */
export function worldGrassTint(world: GrassTintWorld): GrassTerrainTint {
  const index = new Map(world.manifest.tiles.map((t, i) => [t.id, i]))
  return new GrassTerrainTint({
    terrain: world.terrain,
    tiles: world.manifest.tiles,
    layerOf: id => {
      const s = world.stream
      return s ? s.atlas.layerOf(id) : index.get(id)
    },
    level: () => {
      const s = world.scatter
      return s.groundCover?.style === 'field' && s.level !== 'off' ? s.level : null
    },
  })
}

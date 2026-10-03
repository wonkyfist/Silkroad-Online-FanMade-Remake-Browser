/**
 * Texture words for the coast (docs/COAST.md §5.4 step 2, §3B.5, §7; beaches fact-check G7): which tile2d tile every
 * lattice vertex shows after the coast pass. Node-free.
 *
 * Retail words stay wherever the coast leaves the ground alone. The procedural rules paint, on sea sides outside the
 * bounds (and inside them only in a height patch, S1, within `paint.allowInsideBoundsM` of the line):
 * - the sea bed (seabed below SL - 0.5 m, wet sand up to the waterline), the wet sand and the dry sand of the pass's
 *   surface classes (sand with a sprinkle of pebble sand);
 * - the lowered or filled flank (ground moved by more than `placements.dropMovedM`, or with no retail data): grass up to
 *   `paint.grassMaxDeg`, a dithered blend to rock up to `paint.rockFromDeg`, rock above. The grass keeps the retail
 *   grass tile of the vertex, or of the nearest kept retail vertex, and falls back to the palette's grass.
 * The tomb keep, the land edges and retail water above the sea level keep their retail words.
 *
 * Deterministic: the dithering is the integer hash of the lattice point.
 */
import { MAPM_TEXTURE_ID_MASK } from '@sro/formats'
import type { CoastConfig } from './config.ts'
import { extrapolate } from './grid.ts'
import { COAST_CLASS, type CoastResult } from './pass.ts'
import { hash2 } from './noise.ts'
import { smoothstep } from './profile.ts'

/** Palette names the rules use (coast.json paint.palette[].name). */
export const PAINT_NAMES = ['sand', 'sand-pebble', 'wet-sand', 'rock', 'seabed', 'grass'] as const
export type PaintName = (typeof PAINT_NAMES)[number]

/** Share of dry sand painted as pebble sand. */
const PEBBLE_SHARE = 0.18
/** Below this depth under SL the sea floor is seabed, above it wet sand (m). */
export const SEABED_BELOW_M = 0.5
/** Seed offsets of the dithering hashes. */
const SEED_PEBBLE = 303
const SEED_ROCK = 307

/** A texture word: tile2d id in the low 10 bits, the tiling code in bits 13..15. */
export const textureWord = (tile: number, code: number) => (tile & MAPM_TEXTURE_ID_MASK) | ((code & 7) << 13)

export interface PaintInput {
  /** Retail texture words on the coast lattice (0 where there is no retail data). */
  words: Uint16Array
  /** Retail heights (m) on the lattice, NaN where none: the flank rule repaints ground that moved. */
  heights: Float64Array
  /** Whether a tile2d id is a grass tile (tile2d.ifo typeName 'Grass'). */
  isGrass: (tile: number) => boolean
}

export interface CoastPaint {
  /** Final texture words (retail where the coast did not paint). */
  words: Uint16Array
  /** 1 where the procedural rules painted the vertex. */
  painted: Uint8Array
  /** The palette's words by name. */
  palette: Record<PaintName, number>
}

/** The palette's words by name; throws when coast.json lacks one the rules need. */
export function paletteWords(cfg: CoastConfig): Record<PaintName, number> {
  const out = {} as Record<PaintName, number>
  for (const name of PAINT_NAMES) {
    const e = cfg.paint.palette.find(p => p.name === name)
    if (!e) throw new Error(`coast.json paint.palette: no '${name}' entry`)
    out[name] = textureWord(e.tile, e.code)
  }
  return out
}

export function paintCoast(r: CoastResult, cfg: CoastConfig, input: PaintInput): CoastPaint {
  const { rows, cols } = r.shape
  const N = rows * cols
  const SL = cfg.seaLevelM
  const pal = paletteWords(cfg)
  const m = r.masks
  const words = Uint16Array.from(input.words)
  const painted = new Uint8Array(N)
  const moveM = cfg.placements.dropMovedM
  const inside = cfg.paint.allowInsideBoundsM

  // the nearest kept retail word, for ground the pass made up (beyond the export, the filler)
  const keptWord = new Float64Array(N)
  const keptMask = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if (m.kept[i] && !m.patch[i] && input.words[i]) {
      keptWord[i] = input.words[i]!
      keptMask[i] = 1
    }
  }
  const nearest = extrapolate(keptWord, keptMask, rows, cols, { drop: 0 }).value

  for (let i = 0; i < N; i++) {
    if (m.tombKeep[i] || r.landFade[i]! >= 0.5) continue
    const s = r.s[i]!
    if (m.inPlay[i]) {
      if (!m.patch[i] || r.patchWeight[i]! <= 0 || s < -inside) continue
    } else if (m.inCorr[i]) continue
    const k = r.cls[i]!
    if (k === COAST_CLASS.retailWater) continue
    const h = r.h[i]!
    const col = i % cols
    const row = (i - col) / cols
    let w = -1
    if (k === COAST_CLASS.sea) w = h < SL - SEABED_BELOW_M ? pal.seabed : pal['wet-sand']
    else if (k === COAST_CLASS.wetSand) w = pal['wet-sand']
    else if (k === COAST_CLASS.sand) w = hash01(col, row, cfg.seed + SEED_PEBBLE) < PEBBLE_SHARE ? pal['sand-pebble'] : pal.sand
    else if (!m.inPlay[i]) {
      const H = input.heights[i]!
      const moved = !m.have[i] || Number.isNaN(H) || Math.abs(h - H) > moveM
      if (!moved) continue
      const rock = smoothstep(cfg.paint.grassMaxDeg, cfg.paint.rockFromDeg, r.slope[i]!)
      if (rock > 0 && hash01(col, row, cfg.seed + SEED_ROCK) < rock) w = pal.rock
      else {
        const own = m.have[i] ? input.words[i]! : 0
        const near = Number.isFinite(nearest[i]!) ? nearest[i]! : 0
        w = own && input.isGrass(own & MAPM_TEXTURE_ID_MASK) ? own : near && input.isGrass(near & MAPM_TEXTURE_ID_MASK) ? near : pal.grass
      }
    }
    if (w < 0) continue
    words[i] = w
    painted[i] = 1
  }
  // ground with no retail word the rules above left (land edges beyond the export): the nearest kept word
  for (let i = 0; i < N; i++) {
    if (painted[i] || m.have[i]) continue
    const near = nearest[i]!
    words[i] = Number.isFinite(near) && near ? near : pal.grass
    painted[i] = 1
  }
  return { words, painted, palette: pal }
}

/** Hash of a lattice point to [0, 1). */
const hash01 = (col: number, row: number, seed: number) => (hash2(col, row, seed) + 1) / 2

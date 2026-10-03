/**
 * The coast's Blender round trip (docs/COAST.md §6, §3B.7, §12.2, §12.13; lane CST-B owns this file):
 *
 *   pnpm sro coast-export --area 156-161,87-90 [--world jangan-fields] [--from procedural|export]
 *                         [--pass <name>[:seed]] [--seed <n>] ... [--watch] [--out <dir>] [--renders <dir>]
 *   pnpm sro coast-export --session <name>|all [--dry-run] [--renders <dir>] [--phase <n>]
 *   pnpm sro coast-import --blend <file> [--dry-run]
 *   pnpm sro coast-import --check
 *
 * coast-export computes the base of an edge area, writes a bundle (../../tools/blender/coast_edge.py documents it)
 * and builds a .blend with Blender headless (build_edge.py): the terrain on the global 2 m lattice, the sea plane, the
 * playable bounds and region labels, and a `.sculpt_mask` over everything that must not move. `--from procedural`
 * (the default and the normal start for sculpting) runs the converter's coast pass (../world/coast/pass.ts) on the
 * retail terrain; `--from export` reads the terrain bins of the world export instead (the prototype's bundle). Earlier
 * authored layers of the area are merged in, so a second session starts from the first one's result. `--pass` runs
 * the scripted passes (tools/blender/passes/*.py: gullies, spurs, dunes, cove, soften) headless; `--watch` runs them
 * in the Blender window instead, a strip at a time, and leaves it open for brushes.
 *
 * coast-import reads a sculpted .blend back (readback_edge.py) into per-region LA16 height layers, validates them
 * (docs/COAST.md §6.4, validateHeightLayers below) against the CURRENT procedural base and protections, and writes
 * them to content/coast/height/ (the area's own regions are replaced: changed ones written, unchanged ones removed).
 * `--check` validates the layers already in content/coast/ (a stale layer is one whose region's base has changed
 * since it was authored: re-run its session).
 *
 * Sessions: COAST_SESSIONS are Claude's scripted hand passes for the hotspots of docs/COAST.md §3B.7 (the default the
 * user chose, WAVE_PLAN6 §8 item 4). A session = export (start = the base) -> passes -> readback -> validate -> write,
 * plus retail / base / sculpted renders from one camera. Deterministic: the same base and session give the same
 * layers, so a session is re-run after the base changes (CST-C retuning coast.json, the phase-2 sections).
 *
 * The rules a layer must keep (validated here and on every import): no weight on the frozen playable rectangle
 * (stream.playable; an allowHeightPatches rectangle excepted), within 30 m outside the bounds or corridor line, on the
 * tomb keep, on retail water the coast keeps, on a land edge, or on a moved area border; shared edge vertices equal in
 * both files; unweighted vertices equal to the base (to half a height step + 1 mm). Every path handed to Blender is
 * absolute (../blender.ts refuses relative ones; docs/COAST.md §6.6 finding 1).
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { assembleRegionGrid, isRegionActive, parseMapM, parseMfo, type MfoFile } from '@sro/formats'
import sharp from 'sharp'
import { runBlender, type BlenderArg, type BlenderRun } from '../blender.ts'
import { openArchive, REPO_ROOT, type SroConfig } from '../node-io.ts'
import { parseCoastConfig, type CoastConfig, type Rect } from '../world/coast/config.ts'
import { CELLS_PER_REGION, latticeShape, type LatticeShape, type RegionRect } from '../world/coast/lattice.ts'
import { COAST_CLASS, runCoastPass, type CoastResult } from '../world/coast/pass.ts'
import { readRetailLattice as readCoastRetail } from '../world/coast/retail.ts'
import { WORLD_PRESETS } from '../world/convert-world.ts'
import { decodeTerrainBin } from '../world/format.ts'

// ------------------------------------------------------------------------------------------------ constants and areas

/** Hard protection reasons (the bundle's guard bits). Keep in step with GUARD in tools/blender/coast_edge.py. */
export const GUARD = { frozen: 1, corridor: 2, line: 4, landEdge: 8, tombKeep: 16, keptWater: 32, border: 64 } as const
export type GuardName = keyof typeof GUARD
const GUARD_TEXT: Record<GuardName, string> = {
  frozen: 'the frozen playable area',
  corridor: 'the corridor (retail scenery)',
  line: 'within 30 m outside the bounds line',
  landEdge: 'a land edge (kept retail)',
  tombKeep: 'the tomb crest keep',
  keptWater: 'retail water the coast keeps',
  border: 'the area border',
}

/** Metres outside the bounds (or corridor) line that no pass or brush may touch (docs/COAST.md §12.13). */
export const LINE_GUARD_M = 30
/** The soft mask fades from 1 to 0 over this many metres beyond the line guard, the tomb keep and the area border. */
export const FADE_M = 60
/** Kept retail water fades over this many metres. */
export const WATER_FADE_M = 8
/** The tomb keep fades over this many metres (the converter's smooth join along the keep line is about 20 m, G12). */
export const TOMB_FADE_M = 30
/** The readback's weight: 0 up to 1 mm of change, then |d| / 5 cm, full from 5 cm (docs/COAST.md §6.4). */
export const WEIGHT = { thresholdM: 0.001, fullM: 0.05 } as const
/** LA16 height encoding (docs/COAST.md §6.3): L = round((h + 100) / 500 * 65535). */
export const LA16 = { minM: -100, spanM: 500, step: 500 / 65535 } as const
const GRID = CELLS_PER_REGION + 1

export interface CoastArea {
  x0: number
  x1: number
  z0: number
  z1: number
}

/** '156-161,87-90' -> the area (regions, inclusive). */
export function parseArea(spec: string): CoastArea {
  const m = /^(\d+)-(\d+),(\d+)-(\d+)$/.exec(spec.trim())
  if (!m) throw new Error(`--area: expected <x0>-<x1>,<z0>-<z1> (regions), got ${JSON.stringify(spec)}`)
  const [x0, x1, z0, z1] = m.slice(1).map(Number) as [number, number, number, number]
  if (x1 < x0 || z1 < z0) throw new Error(`--area ${spec}: empty`)
  if ((x1 - x0 + 1) * (z1 - z0 + 1) > 48) throw new Error(`--area ${spec}: at most 48 regions (docs/COAST.md §3B.7: 3 x 3 to 6 x 4)`)
  return { x0, x1, z0, z1 }
}
export const areaSpec = (a: CoastArea) => `${a.x0}-${a.x1},${a.z0}-${a.z1}`
export const areaDirName = (a: CoastArea) => `${a.x0}-${a.x1}_${a.z0}-${a.z1}`
export const areaLattice = (a: CoastArea) => ({ nx: (a.x1 - a.x0 + 1) * CELLS_PER_REGION + 1, nz: (a.z1 - a.z0 + 1) * CELLS_PER_REGION + 1 })
const inArea = (a: CoastArea, x: number, z: number) => x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1
const regionKey = (x: number, z: number) => `${x}_${z}`

/** The Blender frame (docs/COAST.md §6.1): metres from the south-west corner of the origin region; X east, Y north. */
export interface CoastFrame {
  originRegion: { x: number; z: number }
  /** stream.playable: the frozen rectangle (regions, inclusive; docs/COAST.md C19), not manifest.bounds. */
  playable: RegionRect
}
const bx = (f: CoastFrame, xRegion: number) => 192 * (xRegion - f.originRegion.x)
const by = (f: CoastFrame, zRegion: number) => 192 * (zRegion - f.originRegion.z)
/** The frozen rectangle in Blender metres (its line included). */
export function playableBlender(f: CoastFrame) {
  return { minX: bx(f, f.playable.x0), maxX: bx(f, f.playable.x1 + 1), minY: by(f, f.playable.z0), maxY: by(f, f.playable.z1 + 1) }
}

// ------------------------------------------------------------------------------------------------ the base of an area

/** What a bundle carries for one area (every array nz x nx, row 0 = south, column 0 = west). */
export interface AreaBase {
  area: CoastArea
  nx: number
  nz: number
  /** The procedural base (or the export's heights with --from export). */
  base: Float32Array
  retail?: Float32Array
  tex: Uint16Array
  /** Linear preview colours, nz x nx x 3. */
  colors: Float32Array
  /** Soft protection, 1 = never moves. */
  mask: Float32Array
  /** Hard protection reasons (GUARD bits). */
  guard: Uint8Array
  s?: Float32Array
  u?: Float32Array
  cls?: Uint8Array
}

/** The retail terrain on the coast lattice (docs/COAST.md §5.3 step 4 input), read from Map.pk2. */
export interface RetailLattice {
  shape: LatticeShape
  heights: Float64Array
  water: Float64Array
  textures: Uint16Array
  active: (x: number, z: number) => boolean
}

/**
 * Reads the retail heights, water surfaces and texture words of the coast domain with the coast pass's own reader
 * (../world/coast/retail.ts, CST-C: the prototype's mosaic rules, so the base here is the converter's base), from the
 * Map archive; `active` is mapinfo.mfo's flag, as the pass takes it.
 */
export function readRetailLattice(cfg: CoastConfig, sro: SroConfig): RetailLattice {
  const map = openArchive('Map', sro)
  const mfo: MfoFile = parseMfo(map.read('mapinfo.mfo'))
  const lat = readCoastRetail(cfg.domain, (x, z) => {
    const path = `${z}/${x}.m`
    if (x < 0 || x > 255 || z < 0 || z > 127 || !map.has(path)) return null
    const mapm = parseMapM(map.read(path))
    return { mapm, grid: assembleRegionGrid(mapm) }
  })
  return { shape: lat.shape, heights: lat.heights, water: lat.water, textures: lat.words, active: (x, z) => isRegionActive(mfo, x, z) }
}

/** The world's frame and export rectangle (the preset; stream.playable wins when the export's manifest has it). */
export function worldFrame(world: string, sro?: SroConfig): { frame: CoastFrame; exportRect: RegionRect; manifest?: WorldManifestLite } {
  const preset = WORLD_PRESETS[world]
  if (!preset) throw new Error(`unknown world ${JSON.stringify(world)}; expected one of ${Object.keys(WORLD_PRESETS).join(', ')}`)
  let playable: RegionRect = preset.playable ?? { x0: preset.x0, x1: preset.x1, z0: preset.z0, z1: preset.z1 }
  const manifest = sro ? readManifestLite(join(sro.workDir, 'out', 'world', world)) : undefined
  if (manifest?.stream?.playable) playable = manifest.stream.playable
  return {
    frame: { originRegion: { x: preset.centre.x, z: preset.centre.z }, playable },
    exportRect: { x0: preset.x0, x1: preset.x1, z0: preset.z0, z1: preset.z1 },
    ...(manifest ? { manifest } : {}),
  }
}

/** The procedural base of the whole coast domain: the converter's coast pass on the retail terrain. */
export function proceduralBase(cfg: CoastConfig, retail: RetailLattice, frame: CoastFrame, exportRect: RegionRect): CoastResult {
  return runCoastPass({ heights: retail.heights, water: retail.water, active: retail.active, playable: frame.playable, exportRect }, cfg)
}

const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/**
 * Chamfer distance (m) from every vertex of a grid to the nearest seed vertex (8 neighbours; 2 m and 2.83 m steps).
 * Infinity where there is no seed.
 */
export function distanceField(seed: Uint8Array, rows: number, cols: number, cellM = 2): Float32Array {
  const d = new Float32Array(rows * cols).fill(Infinity)
  for (let i = 0; i < d.length; i++) if (seed[i]) d[i] = 0
  const a = cellM
  const b = cellM * Math.SQRT2
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      let v = d[i]!
      if (c > 0) v = Math.min(v, d[i - 1]! + a)
      if (r > 0) {
        v = Math.min(v, d[i - cols]! + a)
        if (c > 0) v = Math.min(v, d[i - cols - 1]! + b)
        if (c < cols - 1) v = Math.min(v, d[i - cols + 1]! + b)
      }
      d[i] = v
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c
      let v = d[i]!
      if (c < cols - 1) v = Math.min(v, d[i + 1]! + a)
      if (r < rows - 1) {
        v = Math.min(v, d[i + cols]! + a)
        if (c < cols - 1) v = Math.min(v, d[i + cols + 1]! + b)
        if (c > 0) v = Math.min(v, d[i + cols - 1]! + b)
      }
      d[i] = v
    }
  }
  return d
}

/** Inputs of the protection mask, per area vertex (row 0 = south). */
export interface ProtectionInput {
  area: CoastArea
  frame: CoastFrame
  /** Metres past the bounds or corridor line (< 0 inside); default: the distance to the playable rectangle. */
  s?: ArrayLike<number>
  /** The coast pass's landFade (1 = a land edge, kept retail). */
  landFade?: ArrayLike<number>
  tombKeep?: ArrayLike<number>
  keptWater?: ArrayLike<number>
}

/** The soft mask (1 = never moves) and the hard reasons of an area (docs/COAST.md §6.2, §12.13). */
export function protection(p: ProtectionInput): { mask: Float32Array; guard: Uint8Array } {
  const { nx, nz } = areaLattice(p.area)
  const n = nx * nz
  const pb = playableBlender(p.frame)
  const X0 = bx(p.frame, p.area.x0)
  const Y0 = by(p.frame, p.area.z0)
  const guard = new Uint8Array(n)
  const mask = new Float32Array(n)
  const tomb = new Uint8Array(n)
  const water = new Uint8Array(n)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      const X = X0 + 2 * i
      const Y = Y0 + 2 * j
      const frozen = X >= pb.minX && X <= pb.maxX && Y >= pb.minY && Y <= pb.maxY
      let s = p.s ? p.s[k]! : Math.hypot(Math.max(pb.minX - X, X - pb.maxX, 0), Math.max(pb.minY - Y, Y - pb.maxY, 0))
      if (frozen) s = Math.min(s, 0)
      let g = 0
      if (frozen) g |= GUARD.frozen
      else if (s <= 0) g |= GUARD.corridor
      else if (s <= LINE_GUARD_M) g |= GUARD.line
      const lf = p.landFade ? p.landFade[k]! : 0
      if (!frozen && lf >= 0.999) g |= GUARD.landEdge
      if (p.tombKeep?.[k]) {
        g |= GUARD.tombKeep
        tomb[k] = 1
      }
      if (!frozen && p.keptWater?.[k]) {
        g |= GUARD.keptWater
        water[k] = 1
      }
      if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) g |= GUARD.border
      guard[k] = g
      const border = 2 * Math.min(i, j, nx - 1 - i, nz - 1 - j)
      mask[k] = Math.max(1 - sstep(LINE_GUARD_M, LINE_GUARD_M + FADE_M, s), Math.min(1, 2 * lf), 1 - sstep(0, FADE_M, border))
    }
  }
  const fades: Array<[Uint8Array, number]> = [[tomb, TOMB_FADE_M], [water, WATER_FADE_M]]
  for (const [seed, fade] of fades) {
    if (!seed.some(v => v)) continue
    const d = distanceField(seed, nz, nx)
    for (let k = 0; k < n; k++) mask[k] = Math.max(mask[k]!, 1 - sstep(0, fade, d[k]!))
  }
  for (let k = 0; k < n; k++) if (guard[k]) mask[k] = 1
  return { mask, guard }
}

/** Preview colours (linear) from the classes and the slope (docs/COAST.md §7 G7: grass to 38 deg, rock above 45). */
export function previewColors(h: ArrayLike<number>, nx: number, nz: number, SL: number, cls?: ArrayLike<number>, guard?: ArrayLike<number>): Float32Array {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const hex = (s: string) => [1, 3, 5].map(i => lin(parseInt(s.slice(i, i + 2), 16) / 255)) as [number, number, number]
  const GRASS = hex('#5d7a3c')
  const ROCK = hex('#7d776c')
  const SAND = hex('#d8c9a0')
  const WET = hex('#a08f6c')
  const BED = hex('#7c705a')
  const WATER = hex('#3c6e96')
  const out = new Float32Array(nx * nz * 3)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      const z = h[k]!
      const gx = (h[j * nx + Math.min(i + 1, nx - 1)]! - h[j * nx + Math.max(i - 1, 0)]!) / (2 * 2)
      const gy = (h[Math.min(j + 1, nz - 1) * nx + i]! - h[Math.max(j - 1, 0) * nx + i]!) / (2 * 2)
      const slope = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI
      const t = Math.min(1, Math.max(0, (slope - 38) / 7))
      let c: number[] = GRASS.map((g, q) => g * (1 - t) + ROCK[q]! * t)
      const cl = cls?.[k]
      if (cl === COAST_CLASS.retailWater) c = WATER
      else if (cl === COAST_CLASS.sand) c = SAND
      else if (cl === COAST_CLASS.wetSand) c = WET
      else if (z < SL - 0.3) c = BED
      if (guard && guard[k]! & GUARD.frozen) c = c.map(v => v * 0.8 + 0.04)
      out[k * 3] = c[0]!
      out[k * 3 + 1] = c[1]!
      out[k * 3 + 2] = c[2]!
    }
  }
  return out
}

/** Slices an area out of the coast pass's result (row 0 = north) into bundle order (row 0 = south). */
export function areaFromCoast(r: CoastResult, retail: RetailLattice | null, area: CoastArea, frame: CoastFrame, SL: number): AreaBase {
  const l = r.shape
  if (area.x0 < l.x0 || area.x1 > l.x1 || area.z0 < l.z0 || area.z1 > l.z1) {
    throw new Error(`area ${areaSpec(area)} is outside the coast domain ${l.x0}-${l.x1},${l.z0}-${l.z1}`)
  }
  const { nx, nz } = areaLattice(area)
  const n = nx * nz
  const idx = new Int32Array(n)
  for (let j = 0; j < nz; j++) {
    const row = CELLS_PER_REGION * (l.z1 + 1 - area.z0) - j
    for (let i = 0; i < nx; i++) idx[j * nx + i] = row * l.cols + CELLS_PER_REGION * (area.x0 - l.x0) + i
  }
  const pick32 = (a: ArrayLike<number>) => Float32Array.from(idx, k => a[k]!)
  const base = pick32(r.h)
  const cls = Uint8Array.from(idx, k => r.cls[k]!)
  const keptWater = Uint8Array.from(idx, k => (r.cls[k] === COAST_CLASS.retailWater ? 1 : 0))
  const s = pick32(r.s)
  const { mask, guard } = protection({ area, frame, s, landFade: pick32(r.landFade), tombKeep: Uint8Array.from(idx, k => r.masks.tombKeep[k]!), keptWater })
  return {
    area, nx, nz, base, cls, s, u: pick32(r.u), mask, guard,
    tex: retail ? Uint16Array.from(idx, k => retail.textures[k]!) : new Uint16Array(n),
    ...(retail ? { retail: pick32(retail.heights) } : {}),
    colors: previewColors(base, nx, nz, SL, cls, guard),
  }
}

/** The export's terrain bins over an area (the prototype's export-edge.ts; `--from export`). */
export function areaFromExport(worldDir: string, area: CoastArea, frame: CoastFrame, SL: number): AreaBase {
  const man = readManifestLite(worldDir)
  if (!man) throw new Error(`no world export at ${worldDir} (manifest.json)`)
  const { nx, nz } = areaLattice(area)
  const base = new Float32Array(nx * nz).fill(NaN)
  const tex = new Uint16Array(nx * nz)
  for (let z = area.z0; z <= area.z1; z++) {
    for (let x = area.x0; x <= area.x1; x++) {
      const r = man.regions.find(q => q.x === x && q.z === z)
      if (!r) continue
      const t = decodeTerrainBin(new Uint8Array(readFileSync(join(worldDir, r.terrain.file))))
      for (let gz = 0; gz < GRID; gz++) {
        for (let gx = 0; gx < GRID; gx++) {
          const k = (gz + CELLS_PER_REGION * (z - area.z0)) * nx + gx + CELLS_PER_REGION * (x - area.x0)
          const h = t.heights[gz * GRID + gx]!
          if (!Number.isNaN(base[k]!) && base[k] !== h) throw new Error(`seam mismatch at region ${x},${z} vertex ${gx},${gz}: ${base[k]} vs ${h}`)
          base[k] = h
          tex[k] = t.textures[gz * GRID + gx]!
        }
      }
    }
  }
  const { mask, guard } = protection({ area, frame })
  return { area, nx, nz, base, tex, mask, guard, colors: previewColors(base, nx, nz, SL, undefined, guard) }
}

/** SHA-256 (16 hex) of a region's 97 x 97 window of an area array, rows north -> south (the PNG's order). */
export function regionSha(a: Float32Array, area: CoastArea, x: number, z: number): string {
  const { nx } = areaLattice(area)
  const win = new Float32Array(GRID * GRID)
  const j0 = CELLS_PER_REGION * (z - area.z0)
  const i0 = CELLS_PER_REGION * (x - area.x0)
  for (let row = 0; row < GRID; row++) {
    const j = j0 + CELLS_PER_REGION - row
    for (let c = 0; c < GRID; c++) win[row * GRID + c] = a[j * nx + i0 + c]!
  }
  return createHash('sha256').update(new Uint8Array(win.buffer)).digest('hex').slice(0, 16)
}

/** A region's 97 x 97 window (row 0 = north, as in the layer PNGs). */
export function regionWindow<T extends Float32Array | Uint8Array>(a: T, area: CoastArea, x: number, z: number): T {
  const { nx } = areaLattice(area)
  const out = new (a.constructor as { new (n: number): T })(GRID * GRID)
  const j0 = CELLS_PER_REGION * (z - area.z0)
  const i0 = CELLS_PER_REGION * (x - area.x0)
  for (let row = 0; row < GRID; row++) {
    const j = j0 + CELLS_PER_REGION - row
    for (let c = 0; c < GRID; c++) out[row * GRID + c] = a[j * nx + i0 + c]!
  }
  return out
}

// ------------------------------------------------------------------------------------------------ height layers (LA16)

/** One content/coast/height/<x>_<z>.png: 97 x 97, row 0 = north (gz 96), column 0 = west (gx 0). */
export interface HeightLayer {
  x: number
  z: number
  /** The raw 16-bit values. */
  L: Uint16Array
  A: Uint16Array
  /** The `sro-coast` tEXt metadata, when present. */
  meta?: HeightLayerMeta
  file?: string
}

export interface HeightLayerMeta {
  format?: string
  region?: [number, number]
  area?: CoastArea
  from?: string
  base?: string
  passes?: string[]
  session?: string
  [k: string]: unknown
}

/** numpy's round (half to even), so the TypeScript and the Blender side quantise alike. */
const roundHalfEven = (v: number) => {
  const r = Math.round(v)
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}
export const decodeHeight = (L: number) => L * LA16.step + LA16.minM
export const encodeHeight = (h: number) => Math.min(65535, Math.max(0, roundHalfEven(((h - LA16.minM) / LA16.spanM) * 65535)))

/**
 * The layers of an area from its sculpted heights, as readback_edge.py writes them (the weight of docs/COAST.md §6.4:
 * 0 up to 1 mm of change, |d| / 5 cm, full from 5 cm; L = h where full, base + d / A where partial, the base where 0),
 * so lerp(base, L, A) gives the heights back. Only regions with a weighted vertex get a layer.
 */
export function authorLayers(base: Float32Array, heights: ArrayLike<number>, area: CoastArea, meta: (x: number, z: number) => HeightLayerMeta | undefined = () => undefined): Map<string, HeightLayer> {
  const { nx } = areaLattice(area)
  const out = new Map<string, HeightLayer>()
  for (let z = area.z0; z <= area.z1; z++) {
    for (let x = area.x0; x <= area.x1; x++) {
      const L = new Uint16Array(GRID * GRID)
      const A = new Uint16Array(GRID * GRID)
      let any = false
      const j0 = CELLS_PER_REGION * (z - area.z0)
      const i0 = CELLS_PER_REGION * (x - area.x0)
      for (let row = 0; row < GRID; row++) {
        const j = j0 + CELLS_PER_REGION - row
        for (let c = 0; c < GRID; c++) {
          const k = j * nx + i0 + c
          const b = base[k]!
          const h = Number.isNaN(heights[k]!) ? b : heights[k]!
          const d = h - b
          const ad = Math.abs(d)
          const w = ad <= WEIGHT.thresholdM ? 0 : Math.min(1, ad / WEIGHT.fullM)
          const l = w >= 1 ? h : w > 0 ? b + d / Math.max(w, 1e-9) : b
          L[row * GRID + c] = encodeHeight(l)
          A[row * GRID + c] = roundHalfEven(w * 65535)
          if (A[row * GRID + c]) any = true
        }
      }
      const m = meta(x, z)
      if (any) out.set(regionKey(x, z), { x, z, L, A, ...(m ? { meta: m } : {}) })
    }
  }
  return out
}

/** The tEXt chunks of a PNG (keyword -> text). */
export function pngText(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = 8
  while (p + 8 <= bytes.length) {
    const n = view.getUint32(p)
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8))
    if (type === 'tEXt') {
      const d = bytes.subarray(p + 8, p + 8 + n)
      const z = d.indexOf(0)
      out[Buffer.from(d.subarray(0, z)).toString('latin1')] = Buffer.from(d.subarray(z + 1)).toString('latin1')
    }
    if (type === 'IEND') break
    p += 12 + n
  }
  return out
}

/**
 * Reads one height layer. The pixels through sharp's grey16 path (docs/COAST.md §6.3 pitfall: `raw({ depth: 'ushort' })`
 * alone silently gives 8-bit RGBA); the format must be 97 x 97, 16-bit, grey + alpha.
 */
export async function readHeightLayer(file: string): Promise<HeightLayer> {
  const m = /(\d+)_(\d+)\.png$/.exec(file)
  if (!m) throw new Error(`${file}: expected <x>_<z>.png`)
  const bytes = new Uint8Array(readFileSync(file))
  const md = await sharp(bytes).metadata()
  if (md.width !== GRID || md.height !== GRID || md.channels !== 2 || md.depth !== 'ushort') {
    throw new Error(`${file}: expected 97 x 97 16-bit grey + alpha (LA16), got ${md.width} x ${md.height}, ${md.channels} channel(s), ${md.depth}`)
  }
  const { data, info } = await sharp(bytes).toColourspace('grey16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true })
  if (info.channels !== 2) throw new Error(`${file}: decoded to ${info.channels} channels, expected 2`)
  const px = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
  const L = new Uint16Array(GRID * GRID)
  const A = new Uint16Array(GRID * GRID)
  for (let k = 0; k < GRID * GRID; k++) {
    L[k] = px[2 * k]!
    A[k] = px[2 * k + 1]!
  }
  const text = pngText(bytes)['sro-coast']
  let meta: HeightLayerMeta | undefined
  if (text) {
    try {
      meta = JSON.parse(text) as HeightLayerMeta
    } catch {
      meta = undefined
    }
  }
  return { x: Number(m[1]), z: Number(m[2]), L, A, ...(meta ? { meta } : {}), file }
}

/** Every <x>_<z>.png of a height folder (other files are ignored). */
export async function readHeightLayers(dir: string): Promise<{ layers: Map<string, HeightLayer>; errors: string[] }> {
  const layers = new Map<string, HeightLayer>()
  const errors: string[] = []
  if (!existsSync(dir)) return { layers, errors }
  for (const f of readdirSync(dir).sort()) {
    if (!/^\d+_\d+\.png$/.test(f)) continue
    try {
      const L = await readHeightLayer(join(dir, f))
      layers.set(regionKey(L.x, L.z), L)
    } catch (e) {
      errors.push((e as Error).message)
    }
  }
  return { layers, errors }
}

/** A deterministic LA16 PNG (filter 0, zlib level 9) with optional tEXt chunks: tests and fixtures. */
export async function encodeLa16Png(L: Uint16Array, A: Uint16Array, text?: Record<string, string>): Promise<Uint8Array> {
  const { deflateSync, crc32 } = await import('node:zlib')
  const raw = new Uint8Array(GRID * (1 + GRID * 4))
  for (let row = 0; row < GRID; row++) {
    const o = row * (1 + GRID * 4)
    for (let c = 0; c < GRID; c++) {
      const k = row * GRID + c
      raw[o + 1 + c * 4] = L[k]! >> 8
      raw[o + 2 + c * 4] = L[k]! & 255
      raw[o + 3 + c * 4] = A[k]! >> 8
      raw[o + 4 + c * 4] = A[k]! & 255
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const v = new DataView(out.buffer)
    v.setUint32(0, data.length)
    out.set(Buffer.from(type, 'latin1'), 4)
    out.set(data, 8)
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, GRID)
  new DataView(ihdr.buffer).setUint32(4, GRID)
  ihdr.set([16, 4, 0, 0, 0], 8)
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]
  for (const [k, v] of Object.entries(text ?? {})) parts.push(chunk('tEXt', new Uint8Array(Buffer.from(`${k}\0${v}`, 'latin1'))))
  parts.push(chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))), chunk('IEND', new Uint8Array(0)))
  return new Uint8Array(Buffer.concat(parts))
}

/** The merge the converter applies (docs/COAST.md §6.3): lerp(base, L, A) per vertex of the layers over an area. */
export function mergeLayers(base: Float32Array, area: CoastArea, layers: ReadonlyMap<string, HeightLayer>): Float32Array {
  const { nx } = areaLattice(area)
  const out = Float32Array.from(base)
  for (const L of layers.values()) {
    if (!inArea(area, L.x, L.z)) continue
    const j0 = CELLS_PER_REGION * (L.z - area.z0)
    const i0 = CELLS_PER_REGION * (L.x - area.x0)
    for (let row = 0; row < GRID; row++) {
      const j = j0 + CELLS_PER_REGION - row
      for (let c = 0; c < GRID; c++) {
        const w = L.A[row * GRID + c]! / 65535
        if (!w) continue
        const k = j * nx + i0 + c
        out[k] = base[k]! + (decodeHeight(L.L[row * GRID + c]!) - base[k]!) * w
      }
    }
  }
  return out
}

// ------------------------------------------------------------------------------------------------ validation (§6.4)

/** The current base and protections of the regions a validation looks at (row 0 = north per region window). */
export interface RegionTruth {
  base: Float32Array
  guard: Uint8Array
  sha: string
}

export interface ValidateOptions {
  frame: CoastFrame
  /** allowHeightPatches (continuous region coordinates): weights allowed on frozen ground there. */
  patches?: ReadonlyArray<Rect>
  /** The coast domain (regions): a layer outside it is an error. */
  domain?: Rect
  /** The current base and guard of a region (null: unknown, those checks are skipped for it). */
  truth?: (x: number, z: number) => RegionTruth | null
  /** The area being imported: its outer vertex ring must not be weighted (a moved area border). */
  area?: CoastArea
  /** Only these regions get the per-vertex checks (seams are checked wherever one side is in the set). */
  only?: ReadonlySet<string>
}

export interface ValidateResult {
  errors: string[]
  weighted: number
  /** Largest |decoded L - base| over unweighted vertices (m). */
  quantMaxM: number
  stale: string[]
}

/** Half a height step plus 1 mm: how far an unweighted vertex may sit from the base. */
export const UNWEIGHTED_TOLERANCE_M = LA16.step / 2 + 0.001

const guardNames = (bits: number) => (Object.keys(GUARD) as GuardName[]).filter(k => bits & GUARD[k]).map(k => GUARD_TEXT[k]).join(', ')

/**
 * docs/COAST.md §6.4 on a set of height layers: file names inside the domain; no weight on the frozen rectangle
 * (stream.playable, allowHeightPatches excepted) or on any other protected vertex; a moved area border; seams equal
 * in both files, and a weighted edge vertex with no neighbour file; unweighted vertices at the base (the quantisation
 * check, which also catches a stale layer); the layer's recorded base hash against the current one.
 */
export function validateHeightLayers(layers: ReadonlyMap<string, HeightLayer>, o: ValidateOptions): ValidateResult {
  const errors: string[] = []
  const stale: string[] = []
  const err = (s: string) => {
    if (errors.length < 400) errors.push(s)
  }
  const pb = playableBlender(o.frame)
  let weighted = 0
  let quantMaxM = 0
  const inPatch = (xr: number, zr: number) => (o.patches ?? []).some(p => xr > p.x[0] && xr < p.x[1] && zr > p.z[0] && zr < p.z[1])
  for (const L of layers.values()) {
    const name = `${L.x}_${L.z}.png`
    const key = regionKey(L.x, L.z)
    if (o.domain && (L.x < o.domain.x[0] || L.x > o.domain.x[1] || L.z < o.domain.z[0] || L.z > o.domain.z[1])) {
      err(`${name}: region ${L.x},${L.z} is outside the coast domain`)
      continue
    }
    const check = !o.only || o.only.has(key)
    const truth = check ? (o.truth?.(L.x, L.z) ?? null) : null
    if (check && truth && L.meta?.base && L.meta.base !== truth.sha) stale.push(`${name}: authored on base ${L.meta.base}, the base is now ${truth.sha}`)
    let quantBad = 0
    for (let row = 0; row < GRID; row++) {
      const gz = CELLS_PER_REGION - row
      for (let gx = 0; gx < GRID; gx++) {
        const k = row * GRID + gx
        const w = L.A[k]!
        if (check) {
          const X = 192 * (L.x - o.frame.originRegion.x) + 2 * gx
          const Y = 192 * (L.z - o.frame.originRegion.z) + 2 * gz
          const where = `${name}: vertex (${gx},${gz}) at glTF (${X}, ${-Y})`
          if (w > 0) {
            weighted++
            const frozen = X >= pb.minX && X <= pb.maxX && Y >= pb.minY && Y <= pb.maxY
            const xr = L.x + gx / CELLS_PER_REGION
            const zr = L.z + gz / CELLS_PER_REGION
            if (frozen && !inPatch(xr, zr)) err(`${where} is inside the frozen playable area and weighted ${(w / 65535).toFixed(3)}`)
            else if (truth && truth.guard[k]! & ~(GUARD.frozen | GUARD.border)) err(`${where} is weighted on protected ground (${guardNames(truth.guard[k]! & ~GUARD.border)})`)
            if (o.area) {
              const gxA = CELLS_PER_REGION * (L.x - o.area.x0) + gx
              const gzA = CELLS_PER_REGION * (L.z - o.area.z0) + gz
              const { nx, nz } = areaLattice(o.area)
              if (inArea(o.area, L.x, L.z) && (gxA === 0 || gzA === 0 || gxA === nx - 1 || gzA === nz - 1)) {
                err(`${where}: the area border moved (region ${L.x},${L.z}); it is shared with regions outside ${areaSpec(o.area)}`)
              }
            }
          } else if (truth) {
            const dh = Math.abs(decodeHeight(L.L[k]!) - truth.base[k]!)
            if (dh > UNWEIGHTED_TOLERANCE_M) quantBad++
            else quantMaxM = Math.max(quantMaxM, dh)
          }
        }
        // seams: the west/east and south/north edges against the neighbour's file
        const nb: Array<[number, number, number, number]> = []
        if (gx === 0) nb.push([L.x - 1, L.z, CELLS_PER_REGION, gz])
        if (gx === CELLS_PER_REGION) nb.push([L.x + 1, L.z, 0, gz])
        if (gz === 0) nb.push([L.x, L.z - 1, gx, CELLS_PER_REGION])
        if (gz === CELLS_PER_REGION) nb.push([L.x, L.z + 1, gx, 0])
        for (const [x2, z2, gx2, gz2] of nb) {
          if (!check && !(o.only?.has(regionKey(x2, z2)) ?? true)) continue
          const N = layers.get(regionKey(x2, z2))
          if (!N) {
            if (w > 0) err(`${name}: weighted edge vertex (${gx},${gz}), but ${x2}_${z2}.png is missing (region ${x2},${z2} would keep the procedural height)`)
            continue
          }
          if (regionKey(x2, z2) < key) continue // each shared edge once
          const k2 = (CELLS_PER_REGION - gz2) * GRID + gx2
          if (N.A[k2] !== w || N.L[k2] !== L.L[k]) {
            err(`seam: ${name} (${gx},${gz}) = ${L.L[k]}/${w} but ${x2}_${z2}.png (${gx2},${gz2}) = ${N.L[k2]}/${N.A[k2]}`)
          }
        }
      }
    }
    if (quantBad) err(`${name}: ${quantBad} unweighted vertex(es) differ from the current base by more than ${(UNWEIGHTED_TOLERANCE_M * 1000).toFixed(1)} mm (a stale layer: re-run its session)`)
  }
  for (const s of stale) err(`stale: ${s}`)
  return { errors, weighted, quantMaxM, stale }
}

// ------------------------------------------------------------------------------------------------ sessions

export interface PassSpec {
  name: string
  seed: number
  params?: Record<string, unknown>
  /** The driver's slope guard (deg; default 40): the pass may not make ground steeper than this, or than it was. */
  maxSlopeDeg?: number
}

export interface CoastSession {
  /** COAST §3B.7's hotspot number(s). */
  hotspots: number[]
  area: string
  /** The config phase the session's sections need (phase-2 sessions write nothing before coast.json's phase is 2). */
  phase: 1 | 2
  note: string
  passes: PassSpec[]
  /** The review cameras, in region coordinates (x, z) and metres (h): from over the sea toward the area. */
  cameras: SessionCamera[]
}

export interface SessionCamera {
  view: string
  at: [number, number, number]
  look: [number, number, number]
  lens?: number
}

/**
 * Claude's scripted hand passes for the hotspots (docs/COAST.md §3B.7; the user's default, WAVE_PLAN6 §8 item 4). The
 * areas never overlap (the validator's seam rule), and the seeds are fixed, so each session re-runs to the same layers
 * on the same base.
 */
export const COAST_SESSIONS: Readonly<Record<string, CoastSession>> = {
  tiger: {
    hotspots: [5], area: '156-161,87-90', phase: 1,
    note: 'The Tiger flank (S4): spurs toward the beach, gullies down the flank, dunes behind the Tiger beach',
    passes: [
      { name: 'spurs', seed: 5101 },
      { name: 'gullies', seed: 4242 },
      { name: 'dunes', seed: 5103 },
    ],
    cameras: [
      { view: 'wide', at: [159.9, 85.2, 330], look: [158.6, 89.0, 70] },
      { view: 'close', at: [159.15, 86.2, 160], look: [158.8, 89.3, 90], lens: 32 },
    ],
  },
  'tomb-ridge': {
    hotspots: [1, 5], area: '162-165,87-90', phase: 1,
    note: 'The tomb-ridge beach (S3) and the S2 river mouth: cut the retail bank at the mouth back to 32 deg where the line guard and the kept river bed allow (most of the bank lies within 90 m of the bounds line: coast.json hotspot s2-mouth-bank), spurs and gullies on the S3 flank, dunes',
    passes: [
      { name: 'soften', seed: 5201, params: { windows: [[-640, -1450, 200]], talusDeg: 32 } },
      { name: 'spurs', seed: 5202, params: { wavelength: 260 } },
      { name: 'gullies', seed: 5203 },
      { name: 'dunes', seed: 5204 },
    ],
    cameras: [
      { view: 'wide', at: [164.6, 85.4, 300], look: [163.6, 88.9, 60] },
      { view: 'mouth', at: [164.0, 87.6, 110], look: [164.65, 89.5, 45], lens: 32 },
    ],
  },
  tomb: {
    hotspots: [2], area: '171-174,102-105', phase: 1,
    note: 'The tomb\'s regraded north face (N5): two spurs toward the beach and gullies, so it reads as the back of the same mountain; the crest keep is masked. The free face lies only 60-170 m past the line and 70 % of it is already 40 deg or steeper (rock), so the spurs grow in from 30 m and the slope guard is the rock limit (45 deg: no new cell over 45)',
    passes: [
      { name: 'spurs', seed: 5301, params: { wavelength: 200, amplitude: 18, growM: [30, 110] }, maxSlopeDeg: 45 },
      { name: 'gullies', seed: 5302, params: { amplitude: 7 }, maxSlopeDeg: 45 },
      { name: 'dunes', seed: 5303 },
    ],
    cameras: [
      { view: 'wide', at: [172.0, 106.6, 330], look: [172.4, 103.4, 60] },
      { view: 'close', at: [172.6, 105.6, 140], look: [172.5, 103.5, 70], lens: 32 },
    ],
  },
  corridor: {
    hotspots: [3], area: '150-155,95-97', phase: 2,
    note: 'The corridor\'s south face (A-S): retail canyon relief next to the look-only corridor; spurs and gullies',
    passes: [
      { name: 'spurs', seed: 5401 },
      { name: 'gullies', seed: 5402 },
      { name: 'dunes', seed: 5403 },
    ],
    cameras: [{ view: 'wide', at: [152.4, 93.2, 320], look: [152.6, 96.0, 60] }],
  },
  'corridor-north': {
    hotspots: [3], area: '150-153,103-105', phase: 2,
    note: 'The corridor\'s north side (A-N): the Northern Road beach; gullies on the flank and dunes',
    passes: [
      { name: 'gullies', seed: 5501, params: { amplitude: 7 } },
      { name: 'dunes', seed: 5502 },
    ],
    cameras: [{ view: 'wide', at: [151.6, 106.4, 300], look: [151.6, 104.2, 50] }],
  },
  n2: {
    hotspots: [4], area: '160-163,103-105', phase: 2,
    note: 'The N2 spur cove (the bay\'s west arm): spurs and gullies on the spur, dunes behind the cove beach',
    passes: [
      { name: 'spurs', seed: 5602, params: { wavelength: 240 } },
      { name: 'gullies', seed: 5603 },
      { name: 'dunes', seed: 5604 },
    ],
    cameras: [{ view: 'wide', at: [161.8, 106.6, 320], look: [162.0, 104.0, 60] }],
  },
  'tiger-west': {
    hotspots: [6], area: '152-155,87-94', phase: 2,
    note: 'The Tiger west flank (W1) and the W2 strait: spurs, gullies, dunes',
    passes: [
      { name: 'spurs', seed: 5701 },
      { name: 'gullies', seed: 5702 },
      { name: 'dunes', seed: 5703 },
    ],
    cameras: [{ view: 'wide', at: [151.0, 88.6, 340], look: [154.6, 90.6, 70] }],
  },
}

// ------------------------------------------------------------------------------------------------ the export verb

interface WorldManifestLite {
  regions: Array<{ x: number; z: number; terrain: { file: string } }>
  stream?: { playable?: RegionRect }
  createdAt?: string
  coast?: unknown
}

function readManifestLite(worldDir: string): WorldManifestLite | undefined {
  const f = join(worldDir, 'manifest.json')
  if (!existsSync(f)) return undefined
  return JSON.parse(readFileSync(f, 'utf8')) as WorldManifestLite
}

const sha16 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16)
const f32bytes = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

/** Where the tools live, absolute (every path handed to Blender is absolute). */
export const BLENDER_TOOLS = resolve(REPO_ROOT, 'packages', 'convert', 'tools', 'blender')
const tool = (name: string) => join(BLENDER_TOOLS, name)

export interface BundleInfo {
  dir: string
  json: string
  blend: string
  meta: Record<string, unknown>
}

/**
 * Writes the bundle of an area (./tools/blender/coast_edge.py documents the format): the meta JSON and the raw
 * arrays, into `dir` (absolute). `start` = the heights the .blend starts from (default: the base).
 */
export function writeBundle(dir: string, b: AreaBase, o: {
  world: string
  from: 'procedural' | 'export' | 'fixture'
  frame: CoastFrame
  seaLevelM: number
  start?: Float32Array
  source?: Record<string, unknown>
  camera?: { loc: number[]; target: number[]; lens?: number }
}): BundleInfo {
  if (!isAbsolute(dir)) throw new Error(`writeBundle: ${dir} is not absolute`)
  mkdirSync(dir, { recursive: true })
  const files: Record<string, string> = {}
  const put = (key: string, ext: string, bytes: Uint8Array) => {
    const name = `bundle.${key}.${ext}`
    writeFileSync(join(dir, name), bytes)
    files[key] = name
  }
  put('start', 'f32', f32bytes(o.start ?? b.base))
  put('base', 'f32', f32bytes(b.base))
  put('tex', 'u16', new Uint8Array(b.tex.buffer, b.tex.byteOffset, b.tex.byteLength))
  put('colors', 'f32', f32bytes(b.colors))
  put('mask', 'f32', f32bytes(b.mask))
  put('guard', 'u8', b.guard)
  if (b.s) put('s', 'f32', f32bytes(b.s))
  if (b.u) put('u', 'f32', f32bytes(b.u))
  if (b.cls) put('cls', 'u8', b.cls)
  if (b.retail) put('retail', 'f32', f32bytes(b.retail))
  const a = b.area
  const regions = []
  for (let z = a.z0; z <= a.z1; z++) for (let x = a.x0; x <= a.x1; x++) regions.push({ x, z, baseSha: regionSha(b.base, a, x, z) })
  const meta = {
    format: 'sro-coast-edge', version: 2, world: o.world, from: o.from,
    area: a, nx: b.nx, nz: b.nz,
    frame: {
      note: 'Blender Z-up metres: X = east = glTF x, Y = north = -glTF z, Z = up = glTF y; origin = SW corner of originRegion',
      originRegion: o.frame.originRegion, metresPerUnit: 0.1, cellM: 2, regionM: 192,
      latticeOriginXY: [bx(o.frame, a.x0), by(o.frame, a.z0)],
      fileWorldOfLattice00: [1920 * a.x0, 1920 * a.z0],
    },
    playable: o.frame.playable,
    playableBlender: playableBlender(o.frame),
    seaLevelM: o.seaLevelM,
    guard: { bits: GUARD, lineGuardM: LINE_GUARD_M, fadeM: FADE_M },
    weight: WEIGHT,
    files, regions,
    ...(o.camera ? { camera: o.camera } : {}),
    source: o.source ?? {},
  }
  const json = join(dir, 'bundle.json')
  writeFileSync(json, JSON.stringify(meta, null, 1) + '\n')
  return { dir, json, blend: join(dir, 'edge.blend'), meta }
}

/** Blender argument for a JSON value that may contain slashes (never checked as a path). */
const value = (v: string): BlenderArg => ({ value: v })

/** The Blender runs of the round trip (every path absolute; ../blender.ts refuses anything else). */
export function buildRun(bundle: BundleInfo): BlenderRun {
  return { script: tool('build_edge.py'), args: [bundle.json, bundle.blend], cwd: bundle.dir }
}

export function passesRun(bundle: BundleInfo, o: { spec: string; blendIn: string; blendOut: string; report: string; watch?: boolean; quit?: boolean }): BlenderRun {
  return {
    script: tool('sculpt_edge.py'), blend: o.blendIn, background: !o.watch, cwd: bundle.dir,
    args: [bundle.json, o.blendOut, '--spec', o.spec, '--report', o.report, ...(o.watch ? ['--watch'] : []), ...(o.quit ? ['--quit'] : [])],
  }
}

export function readbackRun(bundle: BundleInfo, blend: string, outDir: string, report: string, extraMeta: Record<string, unknown> = {}): BlenderRun {
  return { script: tool('readback_edge.py'), blend, cwd: bundle.dir, args: [bundle.json, outDir, '--report', report, '--meta', value(JSON.stringify(extraMeta))] }
}

export function renderRun(bundle: BundleInfo, heights: string, png: string, o: { cam?: number[]; target?: number[]; lens?: number; size?: string; samples?: number; plain?: boolean } = {}): BlenderRun {
  const args: BlenderArg[] = [bundle.json, heights, png]
  if (o.plain) args.push('--plain')
  if (o.cam) args.push('--cam', value(o.cam.join(',')))
  if (o.target) args.push('--target', value(o.target.join(',')))
  if (o.lens) args.push('--lens', String(o.lens))
  args.push('--size', o.size ?? '1280x720', '--samples', String(o.samples ?? 32))
  return { script: tool('render_edge.py'), args, cwd: bundle.dir }
}

/** A failure a busy machine causes (out of memory, a crash), worth a retry; a script error is not. */
const transient = (e: unknown) => /memory|ACCESS_VIOLATION|Segmentation|exited with (null|-?\d{6,})/i.test(String((e as Error)?.message ?? e))

/** runBlender, retried twice after a transient failure (the runs are deterministic, so a retry is safe). */
async function runBlenderRetry(sro: Pick<SroConfig, 'blenderExe'>, run: BlenderRun) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runBlender(sro, run)
    } catch (e) {
      if (attempt >= 3 || !transient(e)) throw e
      await new Promise(r => setTimeout(r, 15_000 * attempt))
    }
  }
}

/** Builds the .blend of a bundle (build_edge.py, headless). */
export async function buildBlend(sro: Pick<SroConfig, 'blenderExe'>, bundle: BundleInfo, log = (_: string) => {}) {
  const r = await runBlenderRetry(sro, buildRun(bundle))
  const line = /^BUILD_EDGE (.*)$/m.exec(r.stdout)
  log(`built ${bundle.blend} in ${(r.ms / 1000).toFixed(1)} s`)
  return line ? (JSON.parse(line[1]!) as Record<string, unknown>) : {}
}

/** Runs the scripted passes on a .blend (sculpt_edge.py): headless, or in the Blender window with `watch`. */
export async function runPasses(sro: Pick<SroConfig, 'blenderExe'>, bundle: BundleInfo, specs: PassSpec[], o: {
  blendIn?: string
  blendOut?: string
  watch?: boolean
  quit?: boolean
} = {}) {
  const spec = join(bundle.dir, 'passes.json')
  writeFileSync(spec, JSON.stringify(specs, null, 1) + '\n')
  const out = o.blendOut ?? join(bundle.dir, 'sculpted.blend')
  const report = join(bundle.dir, 'sculpt-report.json')
  const run = passesRun(bundle, { spec, blendIn: o.blendIn ?? bundle.blend, blendOut: out, report, ...(o.watch ? { watch: true } : {}), ...(o.quit ? { quit: true } : {}) })
  const r = o.watch ? await runBlender(sro, run) : await runBlenderRetry(sro, run)
  const line = /^SCULPT_EDGE (\{.*)$/m.exec(r.stdout)
  return { blend: out, report: line ? (JSON.parse(line[1]!) as Record<string, unknown>) : existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : {} }
}

export interface ReadbackReport {
  written: Array<[number, number]>
  weighted: number
  maxAbsM: number
  protectedWeighted: number
  method: string
  outOfRange: number
}

/** Reads a .blend back into staged layers (readback_edge.py): <out>/height/*.png and <out>/sculpted.f32. */
export async function readBack(sro: Pick<SroConfig, 'blenderExe'>, bundle: BundleInfo, blend: string, outDir: string, extraMeta: Record<string, unknown> = {}): Promise<ReadbackReport> {
  const report = join(outDir, 'readback.json')
  mkdirSync(outDir, { recursive: true })
  const r = await runBlenderRetry(sro, readbackRun(bundle, blend, outDir, report, extraMeta))
  const line = /^READBACK_EDGE (\{.*)$/m.exec(r.stdout)
  return line ? (JSON.parse(line[1]!) as ReadbackReport) : (JSON.parse(readFileSync(report, 'utf8')) as ReadbackReport)
}

/** Renders a height array of the bundle (render_edge.py, Cycles on the CPU). */
export async function renderHeights(sro: Pick<SroConfig, 'blenderExe'>, bundle: BundleInfo, heights: string, png: string, o: {
  cam?: number[]
  target?: number[]
  lens?: number
  size?: string
  samples?: number
  plain?: boolean
} = {}) {
  await runBlenderRetry(sro, renderRun(bundle, heights, png, o))
}

/** Side by side with labels (sharp): the before/after sheet. */
export async function composite(panels: Array<{ file: string; label: string }>, out: string) {
  const imgs = await Promise.all(panels.map(p => sharp(p.file).metadata()))
  const w = imgs[0]!.width!
  const h = imgs[0]!.height!
  const gap = 8
  const esc = (s: string) => s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)
  const layers = []
  for (let k = 0; k < panels.length; k++) {
    layers.push({ input: panels[k]!.file, left: k * (w + gap), top: 0 })
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="44"><rect x="0" y="0" width="${Math.min(w, 20 + 11 * panels[k]!.label.length)}" height="44" fill="rgba(0,0,0,0.55)"/><text x="12" y="30" font-family="Segoe UI, Arial, sans-serif" font-size="22" fill="#fff">${esc(panels[k]!.label)}</text></svg>`
    layers.push({ input: Buffer.from(svg), left: k * (w + gap), top: 0 })
  }
  await sharp({ create: { width: panels.length * w + (panels.length - 1) * gap, height: h, channels: 3, background: '#ffffff' } })
    .composite(layers).png().toFile(out)
}

interface ExportOptions {
  world: string
  area: CoastArea
  from: 'procedural' | 'export'
  passes: PassSpec[]
  watch: boolean
  outDir: string
  configFile: string
  contentDir: string
  phase?: number
}

export interface Context {
  sro: SroConfig
  cfg: CoastConfig
  /** coast.json's own phase (cfg.phase may be overridden by --phase for a preview). */
  filePhase: number
  configFile: string
  frame: CoastFrame
  exportRect: RegionRect
  retail: RetailLattice | null
  result: CoastResult | null
  log: (s: string) => void
}

export async function loadContext(sro: SroConfig, world: string, configFile: string, phase: number | undefined, from: 'procedural' | 'export', log: (s: string) => void): Promise<Context> {
  const cfg = parseCoastConfig(readFileSync(configFile, 'utf8'))
  const filePhase = cfg.phase
  if (phase !== undefined) {
    if (phase !== 1 && phase !== 2) throw new Error('--phase: 1 or 2')
    cfg.phase = phase
  }
  const { frame, exportRect } = worldFrame(world, sro)
  let retail: RetailLattice | null = null
  let result: CoastResult | null = null
  if (from === 'procedural') {
    const t0 = performance.now()
    retail = readRetailLattice(cfg, sro)
    result = proceduralBase(cfg, retail, frame, exportRect)
    log(`procedural base (coast.json phase ${cfg.phase}): ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  }
  return { sro, cfg, filePhase, configFile, frame, exportRect, retail, result, log }
}

interface ReviewCamera {
  view: string
  loc: number[]
  target: number[]
  lens?: number
}

function sessionCameras(ctx: Context, s: CoastSession): ReviewCamera[] {
  const f = ctx.frame
  const p = (v: [number, number, number]) => [bx(f, v[0]), by(f, v[1]), v[2]]
  return s.cameras.map(c => ({ view: c.view, loc: p(c.at), target: p(c.look), lens: c.lens ?? 30 }))
}

function defaultCamera(ctx: Context, a: CoastArea) {
  const f = ctx.frame
  const cx = (bx(f, a.x0) + bx(f, a.x1 + 1)) / 2
  const cy = (by(f, a.z0) + by(f, a.z1 + 1)) / 2
  const pb = playableBlender(f)
  // look from the sea side: the side of the area farthest from the playable rectangle
  const dirs: Array<[number, number]> = [[0, -1], [0, 1], [-1, 0], [1, 0]]
  const out = (dx: number, dy: number) => (dx ? (dx < 0 ? pb.minX - bx(f, a.x0) : bx(f, a.x1 + 1) - pb.maxX) : dy < 0 ? pb.minY - by(f, a.z0) : by(f, a.z1 + 1) - pb.maxY)
  const [dx, dy] = dirs.reduce((best, d) => (out(d[0], d[1]) > out(best[0], best[1]) ? d : best))
  const span = Math.max(bx(f, a.x1 + 1) - bx(f, a.x0), by(f, a.z1 + 1) - by(f, a.z0))
  return { view: 'wide', loc: [cx + dx * span * 0.9 + 120, cy + dy * span * 0.9, 380], target: [cx, cy, 50], lens: 28 }
}

function areaBaseFor(ctx: Context, area: CoastArea, from: 'procedural' | 'export', world: string): AreaBase {
  if (from === 'procedural') return areaFromCoast(ctx.result!, ctx.retail, area, ctx.frame, ctx.cfg.seaLevelM)
  return areaFromExport(join(ctx.sro.workDir, 'out', 'world', world), area, ctx.frame, ctx.cfg.seaLevelM)
}

function sourceInfo(ctx: Context, from: string) {
  return { config: rel(ctx.configFile), configSha: sha16(readFileSync(ctx.configFile)), phase: ctx.cfg.phase, from, seed: ctx.cfg.seed }
}

const rel = (p: string) => p.replace(REPO_ROOT + (p.includes('\\') ? '\\' : '/'), '').replace(/\\/g, '/')

// ------------------------------------------------------------------------------------------------ import

interface ImportPlan {
  write: HeightLayer[]
  remove: string[]
  errors: string[]
  stale: string[]
  weighted: number
  quantMaxM: number
}

/** The current truth (base, guard, hash) of the regions of an area from a fresh procedural base. */
function truthFor(ctx: Context, area: CoastArea): (x: number, z: number) => RegionTruth | null {
  const b = areaFromCoast(ctx.result!, null, area, ctx.frame, ctx.cfg.seaLevelM)
  const memo = new Map<string, RegionTruth>()
  return (x, z) => {
    if (!inArea(area, x, z)) return null
    const k = regionKey(x, z)
    let t = memo.get(k)
    if (!t) memo.set(k, (t = { base: regionWindow(b.base, area, x, z), guard: regionWindow(b.guard, area, x, z), sha: regionSha(b.base, area, x, z) }))
    return t
  }
}

/**
 * Plans an import: the staged layers of the area replace the area's regions in the content folder; the merged set is
 * validated. An existing layer of another (overlapping) area in the way is an error.
 */
async function planImport(ctx: Context, area: CoastArea, stagedDir: string, contentHeight: string | null): Promise<ImportPlan> {
  const staged = await readHeightLayers(stagedDir)
  const existing = contentHeight ? await readHeightLayers(contentHeight) : { layers: new Map<string, HeightLayer>(), errors: [] }
  const errors = [...staged.errors, ...existing.errors]
  const merged = new Map(existing.layers)
  const remove: string[] = []
  for (const [k, L] of existing.layers) {
    if (!inArea(area, L.x, L.z)) continue
    const from = L.meta?.area
    if (from && areaSpec(from) !== areaSpec(area)) errors.push(`${k}.png belongs to the earlier import of area ${areaSpec(from)}, which overlaps ${areaSpec(area)}: re-export that area, or pick one that does not overlap`)
    merged.delete(k)
    if (!staged.layers.has(k)) remove.push(k)
  }
  for (const [k, L] of staged.layers) merged.set(k, L)
  const only = new Set<string>()
  for (let z = area.z0; z <= area.z1; z++) for (let x = area.x0; x <= area.x1; x++) only.add(regionKey(x, z))
  const v = validateHeightLayers(merged, { frame: ctx.frame, patches: ctx.cfg.allowHeightPatches, domain: ctx.cfg.domain, truth: truthFor(ctx, area), area, only })
  return { write: [...staged.layers.values()], remove, errors: [...errors, ...v.errors], stale: v.stale, weighted: v.weighted, quantMaxM: v.quantMaxM }
}

function applyImport(plan: ImportPlan, contentHeight: string, log: (s: string) => void) {
  mkdirSync(contentHeight, { recursive: true })
  for (const L of plan.write) copyFileSync(L.file!, join(contentHeight, `${L.x}_${L.z}.png`))
  for (const k of plan.remove) rmSync(join(contentHeight, `${k}.png`))
  log(`wrote ${plan.write.length} layer(s), removed ${plan.remove.length} in ${rel(contentHeight)}`)
}

// ------------------------------------------------------------------------------------------------ the CLI

interface Args {
  flags: Set<string>
  opts: Map<string, string[]>
}

function parseArgs(args: readonly string[], flagNames: readonly string[]): Args {
  const flags = new Set<string>()
  const opts = new Map<string, string[]>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(a)}`)
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
    if (flagNames.includes(key)) {
      flags.add(key)
      continue
    }
    const v = eq > 0 ? a.slice(eq + 1) : args[++i]
    if (v === undefined) throw new Error(`--${key}: missing value`)
    opts.set(key, [...(opts.get(key) ?? []), v])
  }
  return { flags, opts }
}
const one = (a: Args, k: string) => a.opts.get(k)?.at(-1)
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p))

const EXPORT_USAGE = `pnpm sro coast-export --area <x0>-<x1>,<z0>-<z1> [--world jangan-fields] [--from procedural|export]
                      [--pass <name>[:<seed>] [--seed <n>]]... [--watch] [--out <dir>] [--renders <dir>]
       pnpm sro coast-export --session <name>|all [--dry-run] [--renders <dir>] [--phase 1|2]
  passes: gullies, spurs, dunes, cove, soften (packages/convert/tools/blender/passes/)
  sessions: ${Object.keys(COAST_SESSIONS).join(', ')}`

/** `pnpm sro coast-export …`: returns the process exit code. */
export async function coastExportCli(args: readonly string[], sro: SroConfig): Promise<number> {
  let a: Args
  try {
    a = parseArgs(args, ['watch', 'dry-run', 'no-renders', 'help'])
  } catch (e) {
    console.error(`coast-export: ${(e as Error).message}\n${EXPORT_USAGE}`)
    return 2
  }
  if (a.flags.has('help')) {
    console.log(EXPORT_USAGE)
    return 0
  }
  const log = (s: string) => console.log(`coast-export: ${s}`)
  const world = one(a, 'world') ?? 'jangan-fields'
  const configFile = abs(one(a, 'config') ?? 'content/coast/coast.json')
  const contentDir = abs(one(a, 'content') ?? 'content/coast')
  const phase = one(a, 'phase') !== undefined ? Number(one(a, 'phase')) : undefined
  try {
    const session = one(a, 'session')
    if (session) {
      const names = session === 'all' ? Object.keys(COAST_SESSIONS) : session.split(',')
      for (const n of names) if (!COAST_SESSIONS[n]) throw new Error(`unknown session ${JSON.stringify(n)}; expected ${Object.keys(COAST_SESSIONS).join(', ')} or all`)
      const ctx = await loadContext(sro, world, configFile, phase, 'procedural', log)
      let failed = 0
      for (const n of names) {
        const r = await runSession(ctx, n, {
          world, contentDir, dryRun: a.flags.has('dry-run'), renders: a.flags.has('no-renders') ? null : abs(one(a, 'renders') ?? join('work', 'tmp', 'w10r', 'coast-passes')),
        })
        if (!r.ok) failed++
      }
      return failed ? 1 : 0
    }
    const areaText = one(a, 'area')
    if (!areaText) throw new Error('--area or --session is required')
    const area = parseArea(areaText)
    const from = (one(a, 'from') ?? 'procedural') as 'procedural' | 'export'
    if (from !== 'procedural' && from !== 'export') throw new Error('--from: procedural or export')
    const passes: PassSpec[] = []
    const seeds = (a.opts.get('seed') ?? []).map(Number)
    for (const [k, p] of (a.opts.get('pass') ?? []).entries()) {
      const [name, seed] = p.split(':')
      passes.push({ name: name!, seed: seed !== undefined ? Number(seed) : (seeds[k] ?? 1) })
    }
    const ctx = await loadContext(sro, world, configFile, phase, from, log)
    const outDir = abs(one(a, 'out') ?? join(sro.workDir, 'coast', world, areaDirName(area)))
    const base = areaBaseFor(ctx, area, from, world)
    const existing = await readHeightLayers(join(contentDir, 'height'))
    const start = from === 'procedural' ? mergeLayers(base.base, area, existing.layers) : base.base
    const bundle = writeBundle(outDir, base, {
      world, from, frame: ctx.frame, seaLevelM: ctx.cfg.seaLevelM, start, source: sourceInfo(ctx, from), camera: defaultCamera(ctx, area),
    })
    log(`bundle ${bundle.json} (${base.nx} x ${base.nz})`)
    await buildBlend(sro, bundle, log)
    let blend = bundle.blend
    if (passes.length || a.flags.has('watch')) {
      if (!passes.length) throw new Error('--watch needs at least one --pass')
      const r = await runPasses(sro, bundle, passes, { watch: a.flags.has('watch') })
      blend = r.blend
      if (!a.flags.has('watch')) log(`passes: ${JSON.stringify(r.report)}`)
    }
    const renders = one(a, 'renders')
    if (renders && !a.flags.has('watch')) await renderReview(ctx, bundle, blend, abs(renders), areaDirName(area), [defaultCamera(ctx, area)], log)
    log(`next: sculpt ${blend} (or not), save, then: pnpm sro coast-import --blend ${blend}`)
    return 0
  } catch (e) {
    console.error(`coast-export: ${(e as Error).message}`)
    return 1
  }
}

/**
 * Renders retail | base | sculpted from each camera and composes the sheets (<name>-<view>-before-after.png, and
 * with the retail panel <name>-<view>-retail-base-after.png); returns the sheets' paths.
 */
async function renderReview(ctx: Context, bundle: BundleInfo, blend: string, dir: string, name: string, cams: ReviewCamera[], log: (s: string) => void) {
  mkdirSync(dir, { recursive: true })
  const rb = join(bundle.dir, 'review')
  await readBack(ctx.sro, bundle, blend, rb)
  const files = (bundle.meta.files ?? {}) as Record<string, string>
  const shots: Array<[string, string, string]> = []
  if (files.retail) shots.push(['retail', join(bundle.dir, files.retail), 'retail (today)'])
  shots.push(['base', join(bundle.dir, files.base!), 'procedural base (before)'], ['sculpted', join(rb, 'sculpted.f32'), 'scripted passes (after)'])
  const sheets: string[] = []
  for (const cam of cams) {
    const panels: Array<{ file: string; label: string }> = []
    for (const [tag, heights, label] of shots) {
      const png = join(dir, `${name}-${cam.view}-${tag}.png`)
      await renderHeights(ctx.sro, bundle, heights, png, { cam: cam.loc, target: cam.target, lens: cam.lens, plain: tag === 'retail' })
      panels.push({ file: png, label })
    }
    const sheet = join(dir, `${name}-${cam.view}-before-after.png`)
    await composite(panels.slice(-2), sheet)
    if (panels.length === 3) await composite(panels, join(dir, `${name}-${cam.view}-retail-base-after.png`))
    for (const p of panels) rmSync(p.file)
    sheets.push(sheet)
  }
  log(`renders: ${sheets.map(rel).join(', ')}`)
  return sheets
}

/** One scripted session: export (start = the base) -> passes -> readback -> validate -> write -> renders. */
export async function runSession(ctx: Context, name: string, o: { world: string; contentDir: string; dryRun: boolean; renders: string | null }): Promise<{ ok: boolean; report: Record<string, unknown> }> {
  const s = COAST_SESSIONS[name]!
  const area = parseArea(s.area)
  const log = (t: string) => ctx.log(`[${name}] ${t}`)
  // a session whose sections coast.json does not build yet, or run on a --phase the converter will not use, only
  // previews: its layers would sit on a base the converter never makes
  const preview = s.phase > ctx.filePhase || ctx.cfg.phase !== ctx.filePhase
  const outDir = join(ctx.sro.workDir, 'coast', o.world, `session-${name}`)
  rmSync(outDir, { recursive: true, force: true })
  const base = areaBaseFor(ctx, area, 'procedural', o.world)
  const cams = sessionCameras(ctx, s)
  const bundle = writeBundle(outDir, base, { world: o.world, from: 'procedural', frame: ctx.frame, seaLevelM: ctx.cfg.seaLevelM, source: { ...sourceInfo(ctx, 'procedural'), session: name }, camera: cams[0] })
  await buildBlend(ctx.sro, bundle, log)
  const t0 = performance.now()
  const sculpt = await runPasses(ctx.sro, bundle, s.passes)
  const staged = join(outDir, 'readback')
  const rb = await readBack(ctx.sro, bundle, sculpt.blend, staged, { session: name })
  const contentHeight = join(o.contentDir, 'height')
  // a preview is checked on its own: the content layers sit on the current base, not on the preview's
  const plan = await planImport(ctx, area, join(staged, 'height'), preview ? null : contentHeight)
  if (rb.outOfRange) plan.errors.push(`${rb.outOfRange} height(s) outside the layer range ${LA16.minM} .. ${LA16.minM + LA16.spanM} m`)
  const report: Record<string, unknown> = {
    session: name, area: s.area, hotspots: s.hotspots, phase: s.phase, basePhase: ctx.cfg.phase, configPhase: ctx.filePhase, preview, note: s.note,
    passes: (sculpt.report as { passes?: unknown }).passes, moved: (sculpt.report as { moved?: unknown }).moved,
    maxAbsM: (sculpt.report as { maxAbsM?: unknown }).maxAbsM, protectedTouched: (sculpt.report as { protectedTouched?: unknown }).protectedTouched,
    readback: { written: rb.written.length, weighted: rb.weighted, method: rb.method, protectedWeighted: rb.protectedWeighted },
    validation: { errors: plan.errors.length, firstErrors: plan.errors.slice(0, 12), stale: plan.stale.length, quantMaxMm: +(plan.quantMaxM * 1000).toFixed(2) },
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
  }
  let ok = plan.errors.length === 0
  if (!ok) log(`validation failed:\n  ${plan.errors.slice(0, 20).join('\n  ')}`)
  if (ok && preview) log(`phase ${s.phase} session, base at phase ${ctx.cfg.phase}, coast.json at phase ${ctx.filePhase}: preview only, nothing written (run it without --phase once coast.json's phase is ${s.phase})`)
  else if (ok && o.dryRun) log(`dry run: would write ${plan.write.length} and remove ${plan.remove.length} layer(s)`)
  else if (ok) applyImport(plan, contentHeight, log)
  report.written = ok && !preview && !o.dryRun ? plan.write.map(L => `${L.x}_${L.z}`) : []
  if (o.renders) {
    try {
      report.sheets = (await renderReview(ctx, bundle, sculpt.blend, o.renders, `${name}${preview ? '-preview' : ''}`, cams, log)).map(rel)
    } catch (e) {
      log(`renders failed: ${(e as Error).message}`)
      ok = false
    }
    writeFileSync(join(o.renders, `${name}${preview ? '-preview' : ''}.json`), JSON.stringify(report, null, 1) + '\n')
  }
  log(`${ok ? 'OK' : 'FAILED'}: ${JSON.stringify({ moved: report.moved, written: (report.written as string[]).length, errors: plan.errors.length })}`)
  return { ok, report }
}

const IMPORT_USAGE = `pnpm sro coast-import --blend <file> [--bundle <bundle.json>] [--dry-run]
       pnpm sro coast-import --check`

/** `pnpm sro coast-import …`: returns the process exit code. */
export async function coastImportCli(args: readonly string[], sro: SroConfig): Promise<number> {
  let a: Args
  try {
    a = parseArgs(args, ['dry-run', 'check', 'help'])
  } catch (e) {
    console.error(`coast-import: ${(e as Error).message}\n${IMPORT_USAGE}`)
    return 2
  }
  if (a.flags.has('help')) {
    console.log(IMPORT_USAGE)
    return 0
  }
  const log = (s: string) => console.log(`coast-import: ${s}`)
  const configFile = abs(one(a, 'config') ?? 'content/coast/coast.json')
  const contentDir = abs(one(a, 'content') ?? 'content/coast')
  const contentHeight = join(contentDir, 'height')
  try {
    if (a.flags.has('check')) {
      const world = one(a, 'world') ?? 'jangan-fields'
      const ctx = await loadContext(sro, world, configFile, undefined, 'procedural', log)
      const { layers, errors } = await readHeightLayers(contentHeight)
      const l = ctx.result!.shape
      const all: CoastArea = { x0: l.x0, x1: l.x1, z0: l.z0, z1: l.z1 }
      const v = validateHeightLayers(layers, { frame: ctx.frame, patches: ctx.cfg.allowHeightPatches, domain: ctx.cfg.domain, truth: truthFor(ctx, all) })
      const errs = [...errors, ...v.errors]
      log(`${layers.size} layer(s), ${v.weighted} weighted vertices, unweighted within ${(v.quantMaxM * 1000).toFixed(2)} mm of the base; ${v.stale.length} stale`)
      if (errs.length) console.error(`coast-import: ${errs.length} problem(s):\n  ${errs.slice(0, 60).join('\n  ')}`)
      return errs.length ? 1 : 0
    }
    const blendArg = one(a, 'blend')
    if (!blendArg) throw new Error('--blend <file> (or --check) is required')
    const blend = abs(blendArg)
    if (!existsSync(blend)) throw new Error(`${blend}: no such file`)
    const bundleJson = abs(one(a, 'bundle') ?? join(dirname(blend), 'bundle.json'))
    if (!existsSync(bundleJson)) throw new Error(`${bundleJson}: no bundle next to the .blend (pass --bundle)`)
    const meta = JSON.parse(readFileSync(bundleJson, 'utf8')) as { area: CoastArea; world?: string; regions: Array<{ x: number; z: number; baseSha: string }>; source?: { configSha?: string } }
    const bundle: BundleInfo = { dir: dirname(bundleJson), json: bundleJson, blend, meta }
    const world = one(a, 'world') ?? meta.world ?? 'jangan-fields'
    const ctx = await loadContext(sro, world, configFile, undefined, 'procedural', log)
    // staleness (docs/COAST.md §6.4 rule 5): the bundle's base must be today's procedural base
    const truth = truthFor(ctx, meta.area)
    const staleRegions = meta.regions.filter(r => truth(r.x, r.z)?.sha !== r.baseSha)
    if (staleRegions.length) {
      throw new Error(`the bundle is stale: the procedural base of ${staleRegions.map(r => `${r.x},${r.z}`).join(' ')} changed since the export; re-export the area (coast-export --area ${areaSpec(meta.area)}) and sculpt again`)
    }
    const staged = join(bundle.dir, 'readback')
    const rb = await readBack(sro, bundle, blend, staged)
    log(`read back ${rb.written.length} region layer(s), ${rb.weighted} weighted vertices, max |dh| ${rb.maxAbsM} m (${rb.method})`)
    const plan = await planImport(ctx, meta.area, join(staged, 'height'), contentHeight)
    if (rb.outOfRange) plan.errors.push(`${rb.outOfRange} height(s) outside the layer range ${LA16.minM} .. ${LA16.minM + LA16.spanM} m`)
    if (plan.errors.length) {
      console.error(`coast-import: ${plan.errors.length} error(s), nothing written:\n  ${plan.errors.slice(0, 60).join('\n  ')}`)
      return 1
    }
    if (a.flags.has('dry-run')) {
      log(`dry run OK: would write ${plan.write.length} and remove ${plan.remove.length} layer(s)`)
      return 0
    }
    applyImport(plan, contentHeight, log)
    log(`next: re-convert (pnpm sro convert-region --preset ${world}) and look in the viewer`)
    return 0
  } catch (e) {
    console.error(`coast-import: ${(e as Error).message}`)
    return 1
  }
}


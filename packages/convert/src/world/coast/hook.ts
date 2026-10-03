/**
 * The coast pass's entry point for ../convert-world.ts (docs/COAST.md §5; lane CST-C owns this file and ./**).
 *
 * `createCoastPass` runs once, before the terrain step, when the world preset names a coast config (WorldPreset.coast):
 * 1. reads coast.json and the retail .m of every region in the coast domain (./retail.ts);
 * 2. runs the procedural pass (./pass.ts), merges the authored height layers (./authored.ts), paints the texture
 *    words (./paint.ts), fills the sea mask (./field.ts) and counts the synthetic regions to emit (./census.ts);
 * 3. writes coast/field.png (manifest.coast, §8.1).
 * The returned object is the region-source overlay (`source`, ./source.ts: terrain, normals' heights, navigation) and
 * the pipeline's coast pass (../passes.ts): the C9 placement edits by uid (./placements.ts), manifest.coast and the
 * report.coast census with the §12.13 checks (./checks.ts). ../convert-world.ts adds the navigation totals, S1's
 * in-bounds link check (./links.ts) and the coast places after it built nav.bin.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { assembleRegionGrid, isRegionActive, parseMapM, parseMfo, parseTile2d, type MapMFile } from '@sro/formats'
import { NavWorld, type NavData } from '@sro/nav'
import { openArchive, type SroConfig } from '../../node-io.ts'
import { encodePng } from '../../png.ts'
import type { WorldCoast, WorldModel, WorldPlacement } from '../manifest.ts'
import type { CoastPass, WorldPassContext } from '../passes.ts'
import { mergeAuthoredHeights, readAuthoredHeights } from './authored.ts'
import { settleBanks } from './banks.ts'
import { changedRegions, emitCensus } from './census.ts'
import * as checks from './checks.ts'
import { parseCoastConfig, type CoastConfig } from './config.ts'
import { coastField, seaMasks } from './field.ts'
import { slopeDeg } from './grid.ts'
import { CELL_M, type RegionRect } from './lattice.ts'
import { closeRing, reachesBothWays } from './links.ts'
import type { NavEditStats } from './navgen.ts'
import { paintCoast } from './paint.ts'
import { COAST_CLASS, runCoastPass, type CoastResult } from './pass.ts'
import { placementEdits, type DropFootprint } from './placements.ts'
import { readRetailLattice, type ReadRetailRegion, type RetailLattice } from './retail.ts'
import { CoastSource } from './source.ts'

/** Where coast/field.png goes (relative to the export). */
export const COAST_FIELD_FILE = 'coast/field.png'
/** S1's test point (region units): the walkable beach must reach the town's component with the ring closed. */
export const S1_POINT: readonly [number, number] = [170.5, 90.6]
const SAMPLES = 40

export interface CoastPassOptions {
  /** The coast config (content/coast/coast.json), absolute. */
  configFile: string
  /** The export folder (absolute). */
  outDir: string
  /** The floating origin region. */
  origin: { x: number; z: number }
  /** The export's regions (region units). */
  regions: ReadonlyArray<{ x: number; z: number }>
  /** stream.playable: the frozen rectangle (docs/COAST.md C19), region units, inclusive. Default: the export minus its ring. */
  playable?: { x0: number; x1: number; z0: number; z1: number }
  cfg?: SroConfig
  warnings: string[]
  log: (line: string) => void
  /** A retail region's terrain (any .m file, active or not); default: the Map archive of `cfg`. */
  readRegion?: ReadRetailRegion
  /** mapinfo.mfo's active flag; default: the Map archive's. */
  active?: (x: number, z: number) => boolean
  /** tile2d.ifo typeName of a tile id; default: the Map archive's. */
  tileType?: (id: number) => string | null
}

/** The pass as ../convert-world.ts drives it. */
export interface CoastRun extends CoastPass {
  config: CoastConfig
  result: CoastResult
  retail: RetailLattice
  source: CoastSource
  /** Adds one region's navigation edit totals to the report. */
  noteNav(stats: NavEditStats): void
  /** S1's in-bounds link (G1): with the ring closed, S1 reaches the home position (file space) and back. */
  checkLink(nav: NavData, home: { x: number; y: number; z: number }): boolean
  /** manifest.places entries of coast.json `places`, snapped on the navigation (glTF metres). */
  places(nav: NavWorld, origin: { x: number; z: number }): Array<{ name: string; x: number; y: number; z: number; source: string }>
  /** tiles[].typeName overrides from the palette (tile id -> typeName). */
  typeNames(): Map<number, string>
  /** The footprints of the placements C9 dropped (empty before the placement pass): the minimap draws over them. */
  dropFootprints(): DropFootprint[]
}

export async function createCoastPass(opts: CoastPassOptions): Promise<CoastRun> {
  const t0 = performance.now()
  const text = readFileSync(opts.configFile, 'utf8')
  const cfg = parseCoastConfig(text)
  const contentDir = dirname(opts.configFile)
  const exportRect = rectOf(opts.regions)
  const playable: RegionRect = opts.playable ?? { x0: exportRect.x0 + 1, x1: exportRect.x1 - 1, z0: exportRect.z0 + 1, z1: exportRect.z1 - 1 }

  let readRegion = opts.readRegion
  let active = opts.active
  let tileType = opts.tileType
  if (!readRegion || !active || !tileType) {
    const map = openArchive('Map', opts.cfg)
    const mfo = parseMfo(map.read('mapinfo.mfo'))
    const tile2d = parseTile2d(map.read('tile2d.ifo'))
    readRegion ??= (x, z) => {
      const path = `${z}/${x}.m`
      if (x < 0 || x > 255 || z < 0 || z > 127 || !map.has(path)) return null
      const mapm: MapMFile = parseMapM(map.read(path))
      return { mapm, grid: assembleRegionGrid(mapm) }
    }
    active ??= (x, z) => isRegionActive(mfo, x, z)
    tileType ??= id => tile2d.byId.get(id)?.typeName ?? null
  }
  const isGrass = (id: number) => tileType!(id) === 'Grass'

  // 1-2: the retail lattice, the pass, the authored layers, the paint, the sea
  const retail = readRetailLattice(cfg.domain, readRegion)
  const result = runCoastPass({ heights: retail.heights, water: retail.water, active, playable, exportRect }, cfg)
  // the in-bounds retail water blocks at the sea level (ground above the water or not): ./banks.ts holds the bank
  // above SL beside them, so their plane always ends buried
  const slPlane = new Uint8Array(retail.water.length)
  for (let i = 0; i < slPlane.length; i++) {
    const w = retail.water[i]!
    slPlane[i] = result.masks.inPlay[i] && !Number.isNaN(w) && Math.abs(w - cfg.seaLevelM) <= 0.5 ? 1 : 0
  }
  retail.water = new Float64Array(0)
  const authoredErrors: string[] = []
  const layers = await readAuthoredHeights(contentDir, authoredErrors)
  const authored = mergeAuthoredHeights(result, layers, authoredErrors)
  if (authored.weighted) result.slope = Float32Array.from(slopeDeg(result.h, result.shape.rows, result.shape.cols, CELL_M))
  // the banks of the in-bounds sea-level water (W10R CST-H1/H2): no water plane ends over a dry trench below SL
  const banks = settleBanks(result, cfg, slPlane)
  for (const e of authoredErrors) opts.warnings.push(`coast: ${e}`)
  const paint = paintCoast(result, cfg, { words: retail.words, heights: retail.heights, isGrass })
  const masks = seaMasks(result)
  const census = emitCensus(result, cfg, exportRect, active)
  const source = new CoastSource({ cfg, retail, result, paint, masks, exportRegions: opts.regions, emitted: census.emitted, bankFilled: banks.filled })
  const changed = changedRegions(result, retail.heights, opts.regions.filter(r => retail.regions.has((r.z << 8) | r.x)))

  // 3: coast/field.png
  const field = coastField(result, cfg, masks)
  const fieldPath = join(opts.outDir, ...COAST_FIELD_FILE.split('/'))
  mkdirSync(dirname(fieldPath), { recursive: true })
  writeFileSync(fieldPath, encodePng(field.width, field.height, field.rgba))
  const l = result.shape
  const manifestCoast: WorldCoast = {
    seaLevelM: cfg.seaLevelM,
    field: {
      file: COAST_FIELD_FILE, x0: 192 * (l.x0 - opts.origin.x) + 0, z0: -192 * (l.z1 + 1 - opts.origin.z) + 0,
      metresPerTexel: field.metresPerTexel, width: field.width, height: field.height,
    },
    mapColor: cfg.ocean.mapColor,
    sourceHash: sourceHash(opts.configFile, contentDir),
  }

  // the checks (§12.13), on the merged result
  const sc = checks.slopeCensus(result, cfg)
  const lc = checks.lineCreases(result, retail.heights, cfg)
  const kc = checks.keepLineCreases(result, retail.heights, cfg)
  const nb = checks.newBenches(result, retail.heights, cfg)
  const sand = checks.sandCoverage(result, cfg, masks, paint.words)
  const flank = checks.flankGrassShare(result, cfg, retail.heights, paint.words, isGrass)
  const mouths = checks.riverMouthFills(result, retail.heights)
  const walls = checks.waterWalls(result, cfg, masks)
  const nav = { opened: 0, closed: 0, planesDropped: 0, objectsDropped: 0, regions: 0 }
  let link: { reachable: boolean; opened: number } | null = null
  let c9: ReturnType<typeof placementEdits> | null = null
  const outside = (fs: checks.CreaseFinding[]) => fs.filter(f => !f.hotspot)
  const sample = <T>(a: readonly T[]) => a.slice(0, SAMPLES)
  const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d
  const problems: string[] = []
  if (sc.outside) problems.push(`${sc.outside} vertex(es) steeper than ${checks.CENSUS_MAX_DEG}° outside the hotspots`)
  if (outside(lc.findings).length) problems.push(`${outside(lc.findings).length} crease(s) along the bounds line`)
  if (outside(kc.findings).length) problems.push(`${outside(kc.findings).length} crease(s) along the tomb keep line`)
  if (outside(nb.findings).length) problems.push(`${outside(nb.findings).length} new bench(es) outside the line`)
  if (sand.gaps.length) problems.push(`${sand.gaps.length} sea shore vertex(es) with no sand within ${checks.SAND_WITHIN_M} m`)
  if (flank.share < checks.FLANK_GRASS_SHARE) problems.push(`the flank below ${cfg.paint.grassMaxDeg}° is ${(flank.share * 100).toFixed(1)} % grass`)
  if (mouths.filled.length) problems.push(`${mouths.filled.length} river-mouth bed vertex(es) filled`)
  if (walls.walls.length) problems.push(`${walls.walls.length} water wall vertex(es) beside in-bounds sea-level water`)
  if (!result.stats.tombKeepBitIdentical) problems.push('the tomb keep is not bit-identical')
  if (result.stats.playChangedOutsidePatch) problems.push(`${result.stats.playChangedOutsidePatch} playable vertex(es) changed outside the height patches`)
  for (const p of problems) opts.warnings.push(`coast check: ${p}`)

  const secs = (performance.now() - t0) / 1000
  opts.log(`coast: ${cfg.domain.x[0]}-${cfg.domain.x[1]} x ${cfg.domain.z[0]}-${cfg.domain.z[1]} (phase ${cfg.phase}) in ${secs.toFixed(1)} s; ` +
    `${census.emitted.length} synthetic regions (${census.land} land, ${census.shallow} shallow), ${changed.length} changed export regions, ` +
    `${authored.layers} authored layer(s); checks ${problems.length ? problems.join('; ') : 'clean'}`)

  const run: CoastRun = {
    config: cfg,
    result,
    retail,
    source,
    placementEdits(ctx: WorldPassContext) {
      c9 = placementEdits(result, cfg, retail.heights, ctx.origin, ctx.placements as WorldPlacement[], ctx.models as WorldModel[])
      for (const k of c9.unmatched) opts.warnings.push(`coast: placements.drop ${k} matches no placement`)
      return c9.edits
    },
    manifestCoast: () => manifestCoast,
    noteNav(s) {
      nav.regions++
      nav.opened += s.opened
      nav.closed += s.closed
      nav.planesDropped += s.planesDropped
      nav.objectsDropped += s.objectsDropped
    },
    checkLink(data, home) {
      const world = new NavWorld(closeRing(data, playable))
      const reachable = reachesBothWays(world, { x: S1_POINT[0] * 1920, z: S1_POINT[1] * 1920 }, home)
      link = { reachable, opened: nav.opened }
      if (!reachable) opts.warnings.push('coast check: S1 does not reach the town with the ring closed (its openTiles link is broken, docs/COAST.md §3.5 G1)')
      return reachable
    },
    places(world, origin) {
      const out: Array<{ name: string; x: number; y: number; z: number; source: string }> = []
      for (const p of cfg.places) {
        const fx = p.x * 1920
        const fz = p.z * 1920
        const pos = world.locate(fx, fz, Infinity)
        const y = pos ? pos.y / 10 : NaN
        if (!pos || !world.terrainOpen(fx, fz) || !(y > cfg.seaLevelM)) {
          opts.warnings.push(`coast: place ${p.name} (${p.x}, ${p.z}) is not on open ground above the sea level`)
          continue
        }
        out.push({
          name: p.name, x: round(192 * (p.x - origin.x)), y: round(y), z: round(-192 * (p.z - origin.z)),
          source: `content/coast/coast.json places (${p.x}, ${p.z}); on the coast's terrain, above the sea level`,
        })
      }
      return out
    },
    dropFootprints() {
      return c9 ? (c9 as ReturnType<typeof placementEdits>).dropFootprints : []
    },
    typeNames() {
      const m = new Map<number, string>()
      for (const p of cfg.paint.palette) if (p.typeName) m.set(p.tile, p.typeName)
      return m
    },
    report() {
      const st = result.stats
      return {
        config: { phase: cfg.phase, seaLevelM: cfg.seaLevelM, option: cfg.option, sourceHash: manifestCoast.sourceHash },
        timeS: round(secs, 1),
        emitted: { land: census.land, shallow: census.shallow, deepOnly: census.deepOnly, landEdge: census.landEdge,
          regions: census.emitted.map(e => `${e.x},${e.z}:${e.kind}`),
          lookOnly: census.emitted.filter(e => source.isLookOnly(e.x, e.z)).map(e => `${e.x},${e.z}`) },
        changedRegions: changed.map(c => ({ x: c.x, z: c.z, maxDeltaM: round(c.maxDeltaM, 2) })),
        stats: {
          landFrac: round(st.landFrac), sandVertices: st.sandPx, playChanged: st.playChanged, playChangedOutsidePatch: st.playChangedOutsidePatch,
          ringLoweredOver2m: st.ringLoweredOver2m, ringLoweredMaxM: round(st.ringLoweredMax, 1), ringRaisedOver2m: st.ringRaisedOver2m,
          ringRaisedMaxM: round(st.ringRaisedMax, 1), ringVolumeRemovedMm3: round(st.ringVolumeRemovedMm3, 2), ringDryBecomesSea: st.ringDryBecomesSea,
          tombKeepVertices: st.tombKeepVertices, tombKeepBitIdentical: st.tombKeepBitIdentical, minH: round(st.minH, 1), maxH: round(st.maxH, 1),
        },
        authored: { layers: authored.layers, weightedVertices: authored.weighted, errors: authoredErrors.length },
        checks: {
          problems,
          slopeCensus: { land: sc.land, over45: sc.over45, over50: sc.over50, byHotspot: sc.byHotspot, outside: sc.outside, samples: sample(sc.samples) },
          boundsLine: { checked: lc.checked, creases: lc.findings.length, outsideHotspots: outside(lc.findings).length, samples: sample(outside(lc.findings)) },
          tombKeepLine: { checked: kc.checked, creases: kc.findings.length, outsideHotspots: outside(kc.findings).length },
          benches: { checked: nb.checked, retail: nb.retailBenches, new: nb.findings.length, outsideHotspots: outside(nb.findings).length },
          sand: { shore: sand.shore, exempt: sand.exempt, gaps: sand.gaps.length, gapsInHotspots: sand.gapsInHotspots, samples: sample(sand.gaps) },
          flankGrass: { vertices: flank.flank, share: round(flank.share) },
          riverMouths: { checked: mouths.checked, filled: mouths.filled.length },
          waterWalls: { checked: walls.checked, walls: walls.walls.length, samples: sample(walls.walls) },
        },
        hotspots: cfg.hotspots.map(h => h.name),
        nav: { ...nav, openTiles: cfg.openTiles.length },
        s1Link: link,
        placementsListed: c9 ? (c9 as ReturnType<typeof placementEdits>).listed : [],
        footprintsOnMovedGround: c9 ? (c9 as ReturnType<typeof placementEdits>).footprints : [],
        footprintsAccepted: c9 ? (c9 as ReturnType<typeof placementEdits>).accepted : [],
        placementsDropUnmatched: c9 ? (c9 as ReturnType<typeof placementEdits>).unmatched : [],
        banks: banks.stats,
        seaVertices: countOf(masks.ocean),
        sandClassVertices: countClass(result, COAST_CLASS.sand) + countClass(result, COAST_CLASS.wetSand),
      }
    },
  }
  return run
}

function rectOf(list: ReadonlyArray<{ x: number; z: number }>): RegionRect {
  if (!list.length) throw new Error('coast pass: the export has no regions')
  return {
    x0: Math.min(...list.map(r => r.x)), x1: Math.max(...list.map(r => r.x)),
    z0: Math.min(...list.map(r => r.z)), z1: Math.max(...list.map(r => r.z)),
  }
}

/** sha256 of coast.json and every file under content/coast (sorted by path). */
function sourceHash(configFile: string, dir: string): string {
  const h = createHash('sha256')
  h.update(readFileSync(configFile))
  const walk = (d: string): string[] => readdirSync(d).sort().flatMap(f => {
    const p = join(d, f)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
  if (existsSync(dir)) {
    for (const f of walk(dir)) {
      if (f === configFile) continue
      h.update(relative(dir, f).replace(/\\/g, '/'))
      h.update(readFileSync(f))
    }
  }
  return h.digest('hex').slice(0, 16)
}

const countOf = (m: Uint8Array) => {
  let n = 0
  for (let i = 0; i < m.length; i++) n += m[i]!
  return n
}

const countClass = (r: CoastResult, k: number) => {
  let n = 0
  for (let i = 0; i < r.cls.length; i++) if (r.cls[i] === k) n++
  return n
}

/**
 * content/coast/coast.json: the authored coast design (docs/COAST.md §5.2, the "beaches everywhere" block of §3B), and
 * its validator. Node-free.
 *
 * Region units: a region is 192 m; x runs east and z north (file space), so "north" is +z. Rectangles are
 * `{ x: [x0, x1], z: [z0, z1] }` in region units; "inclusive" rectangles name whole regions (x1 = the last region),
 * line rectangles (allowHeightPatches, corridor) are continuous coordinates.
 *
 * What each field feeds is in ./pass.ts. The fact-check fixes are fields, so the prototype's behaviour stays
 * reproducible for the parity check: `flank.inSlope[0]` (G11; the prototype clipped at 0), `tombKeep.continueFace`
 * (G12), `allowHeightPatches[].feather` (G2; the prototype blurred outward) and `holeBelowM` (G5; the prototype -200).
 */

export const COAST_CONFIG_FORMAT = 'sro-coast'
export const COAST_CONFIG_VERSION = 1

export type Range = [number, number]
export interface Rect {
  x: Range
  z: Range
}

/**
 * Which line a section follows. north/south/east/west are the playable rectangle's edges; corridor-south and
 * corridor-north the Option A land bridge's faces (z = corridor.z[0] / corridor.z[1], west of the playable rectangle).
 */
export type CoastSide = 'north' | 'south' | 'east' | 'west' | 'corridor-south' | 'corridor-north'
export const COAST_SIDES: readonly CoastSide[] = ['north', 'south', 'east', 'west', 'corridor-south', 'corridor-north']

export interface CoastSection {
  code: string
  name?: string
  /**
   * The player-facing area name of the coast this section shapes (data/zones.ts): the zone label of the synthetic
   * regions, the nameless ring regions and the height patches nearest to the section (P-DATA, wave 10r polish).
   */
  area?: string
  side: CoastSide
  /**
   * First and last region along the side: control points sit at the half-region centres from..to on the side's line
   * (x + 0.5 on north/south/corridor sides, z + 0.5 on east/west).
   */
  from: number
  to: number
  /** Extra control points (region units), e.g. the corner of the playable rectangle. */
  corners?: Array<[number, number]>
  /** A key of `beachKinds`. */
  kind: string
  /** Minimum waterline offset past the line (m; negative = inside the bounds). */
  c0: number
  /** Coastline noise amplitude (m). */
  amp: number
  /** 1 = phase 1 (E, S, NE), 2 = phase 2 (W, NW, the corridor). A section above the config's phase is a land edge. */
  phase: 1 | 2
}

export interface BeachKind {
  /** Waterline -> dune crest or flank toe (m). */
  width: number
  /** Dune or backshore crest above SL (m). */
  dune: number
  /** Top of the dry sand above SL (m). */
  dry: number
  /** Flank grade behind the beach (m/m). */
  grade: number
  /** Shelf depth (m) at 120 / 300 / 700 m offshore. */
  depth: [number, number, number]
}

export interface HeightPatch {
  name: string
  /** Continuous region coordinates; the patch is the in-bounds lattice strictly inside x0 < x and z < z1 ... */
  x: Range
  z: Range
  /** Only retail ground below this height (m) and not under retail water is patched. */
  maxHeightM: number
  /** 'inward': the weight falls to 0 toward the frozen playable ground only (G2); 'blur': the prototype's blur. */
  feather: 'inward' | 'blur'
}

/** A retail placement by its owner region id ((z << 8) | x) and uid, with why it is listed. */
export interface PlacementRef {
  region: number
  uid: number
  note: string
}

export interface CoastConfig {
  format: typeof COAST_CONFIG_FORMAT
  version: typeof COAST_CONFIG_VERSION
  /** Free-text notes for reviewers (ignored). */
  notes?: string[]
  /** Noise seed (C14). */
  seed: number
  /** Sea level (m, glTF y). */
  seaLevelM: number
  /** A = the land bridge to Donwhang (the user's choice); B = all coast. Only A is built. */
  option: 'A' | 'B'
  /** Which sections are sea coast: those with section.phase <= phase. */
  phase: 1 | 2
  /** The coast lattice (regions, inclusive). */
  domain: Rect
  /** Where synthetic regions may be emitted (regions, inclusive), and the depth rule (land or water shallower). */
  emit: Rect & { depthM: number }
  /** Option A's land bridge (continuous region coordinates; its east end meets the playable rectangle's west line). */
  corridor: Rect | null
  /** Corner rule (C13): below this z the south side wins over a west land edge. */
  cornerBelowZ: number
  /** Width (m) of the corner rule's ramp across cornerBelowZ (96 m when absent): the land edge fades into the sea over it. */
  cornerBlendM?: number
  /** Gaussian sigma (m) of the section blend along the line. */
  sectionBlendM: number
  /**
   * Gaussian sigma (m) of the land-edge channel along the line (./sections.ts LAND_BLEND_M when absent): how far the
   * phase split's fade reaches into the sea side. Short leaves a wall where a lowered flank meets a retail land edge.
   */
  landEdgeBlendM?: number
  sections: CoastSection[]
  beachKinds: Record<string, BeachKind>
  flank: {
    /** Rounded shoulder length (m). */
    shoulderM: number
    /** Distance inside the line where the incoming retail slope is measured (m). */
    inSampleM: number
    /** Clamp of the incoming slope (m/m): [-0.9, 0.9] (G11); the prototype used [0, 0.9]. */
    inSlope: Range
    /** Blur of the incoming slope along the line (m). */
    inSlopeBlurM: number
    /** Blur of the line height: [at the line, far, the distance where "far" is reached] (m). */
    lineBlurM: [number, number, number]
    /** Retail relief kept under the envelope as gullies (m), from retail blurred by reliefBlurM. */
    reliefM: number
    reliefBlurM: number
    ridgeNoise: { ampM: number; wavelengthM: number; octaves: number; seedOffset: number }
    /** Smooth-max width where the envelope meets the beach (m). */
    toeSmoothM: number
    /** Blend from the retail ring at the line (m). */
    blendM: number
    /** Smoothing of the reshaped and synthetic ground (m, Gaussian sigma). */
    smoothM: number
  }
  hinterland: { riseSlope: number; riseBehindM: number; holdM: number; relaxM: number }
  /** Retail sea-level water in the bounds keeps its bed and banks within about this distance (m). */
  riverMouthKeepM: number
  tombKeep: {
    /** Columns (region x) whose ring crest is kept; the weight fades in over the first and last half region. */
    x: Range
    /** Kept up to the crest line plus this (m). */
    beyondCrestM: number
    /** Crest distance smoothed along x (m). */
    crestSmoothM: number
    /** Keep-line height smoothed along x (m). */
    lineSmoothM: number
    /** G12: the regrade continues the kept face's slope (clamped by flank.inSlope) instead of starting flat. */
    continueFace: boolean
    /**
     * The steepest face slope (m/m, falling) the regrade continues from the keep line (with continueFace). Beyond the
     * flank's own clamp, so the regrade and the kept face agree where the ring blends from one to the other; the
     * shoulder then turns it to the grade. Absent: the flank's clamp (flank.inSlope[0]).
     */
    maxFaceSlope?: number
    /** Where the kept face's slope is measured, metres back from the keep line. Absent: flank.inSampleM. */
    faceSampleM?: number
  }
  /** Retail heights below this are holes (m). */
  holeBelowM: number
  allowHeightPatches: HeightPatch[]
  /** In-bounds rectangles where retail-closed tiles may open (G1; chosen by CST-C's nav search). */
  openTiles: Array<Rect & { note?: string }>
  /**
   * The Blender hotspots (§3B.7): steep or creased spots of the procedural base left for the hand pass. The slope census
   * and the line checks (§12.13 tests 1 and 2) allow them; everything outside them must pass.
   */
  hotspots: Array<Rect & { name: string; note?: string }>
  paint: {
    palette: Array<{ i: number; tile: number; code: number; name: string; rgb: string; typeName?: string }>
    grassMaxDeg: number
    rockFromDeg: number
    /** Paint (never heights) may reach this far inside the bounds (m). */
    allowInsideBoundsM: number
  }
  placements: {
    resnapVegetation: boolean
    dropBelowSeaM: number
    dropMovedM: number
    /** Retail placements (owner region id, uid) dropped by hand after a look at them (./placements.ts). */
    drop?: PlacementRef[]
    /** Footprint findings checked by hand and kept as they are (./placements.ts): not listed again. */
    accept?: PlacementRef[]
  }
  /** GM tp places (region units). */
  places: Array<{ name: string; x: number; z: number }>
  ocean: { mapColor: string; fieldMetresPerTexel: number }
  /** Land that goes under the sea after the pass (./drown.ts): Jangan stays an island, with no other region in view. */
  drown?: CoastDrown
}

/**
 * The drowned area (docs/COAST.md §4.1, ./drown.ts). `regions` are whole regions (inclusive rectangles, region units): a
 * vertex drowns when every region sharing it does, so a kept neighbour stays bit for bit. `areas` are continuous
 * rectangles (region coordinates, inclusive) for land that crosses a region line. In `soft` regions only the water and
 * the land of small islands drown. A dry island the drowned area cuts off (smaller than islandMaxKm2) drowns too.
 */
export interface CoastDrown {
  regions: Rect[]
  areas: Rect[]
  /** Whole regions where only water and small cut-off land drown; a big landmass keeps its ground there. */
  soft?: Rect[]
  /**
   * Continuous rectangles where the in-bounds retail water at the sea level (the old strait, Jangan Bay) becomes open
   * sea (./drown.ts `opened`): its blocks go, the ocean draws it, the map shades it like the sea; the bed stays retail.
   */
  openWater?: Rect[]
  islandMaxKm2: number
  /** Sea depth (m below the sea level) at the shore and far out, and the distance (m) over which it reaches the far one. */
  depthM: Range
  shelfM: number
  /** The slope (degrees) from kept land down to the sea floor; at least rampMinM (m) wide. */
  rampDeg: number
  rampMinM: number
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isRange = (v: unknown): v is Range => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) && v[0] <= v[1]
const isRect = (v: unknown): v is Rect => isObj(v) && isRange(v.x) && isRange(v.z)

/** Every problem with a parsed coast.json (empty = valid). */
export function validateCoastConfig(m: unknown): string[] {
  const errors: string[] = []
  const err = (path: string, what: string) => {
    if (errors.length < 200) errors.push(`${path}: ${what}`)
  }
  if (!isObj(m)) return ['coast: not an object']
  if (m.format !== COAST_CONFIG_FORMAT) err('format', `expected ${COAST_CONFIG_FORMAT}`)
  if (m.version !== COAST_CONFIG_VERSION) err('version', `expected ${COAST_CONFIG_VERSION}`)
  if (!Number.isInteger(m.seed)) err('seed', 'expected an integer')
  if (!isNum(m.seaLevelM)) err('seaLevelM', 'expected a number')
  if (m.option !== 'A' && m.option !== 'B') err('option', 'expected A or B')
  if (m.phase !== 1 && m.phase !== 2) err('phase', 'expected 1 or 2')
  if (!isRect(m.domain)) err('domain', 'expected {x: [x0, x1], z: [z0, z1]}')
  if (!isObj(m.emit) || !isRect(m.emit) || !isNum(m.emit.depthM)) err('emit', 'expected {x, z, depthM}')
  if (m.corridor !== null && !isRect(m.corridor)) err('corridor', 'expected a rectangle or null')
  if (m.option === 'A' && !isRect(m.corridor)) err('corridor', 'option A needs the corridor')
  if (!isNum(m.cornerBelowZ)) err('cornerBelowZ', 'expected a number')
  if (m.cornerBlendM !== undefined && (!isNum(m.cornerBlendM) || m.cornerBlendM <= 0)) err('cornerBlendM', 'expected a positive number')
  if (!isNum(m.sectionBlendM) || m.sectionBlendM <= 0) err('sectionBlendM', 'expected a positive number')
  if (m.landEdgeBlendM !== undefined && (!isNum(m.landEdgeBlendM) || m.landEdgeBlendM <= 0)) err('landEdgeBlendM', 'expected a positive number')

  const kinds = isObj(m.beachKinds) ? m.beachKinds : null
  if (!kinds) err('beachKinds', 'expected an object')
  else {
    for (const [k, v] of Object.entries(kinds)) {
      if (!isObj(v)) {
        err(`beachKinds.${k}`, 'expected an object')
        continue
      }
      for (const f of ['width', 'dune', 'dry', 'grade']) if (!isNum(v[f]) || (v[f] as number) <= 0) err(`beachKinds.${k}.${f}`, 'expected a positive number')
      if (isNum(v.dry) && isNum(v.dune) && v.dry > v.dune) err(`beachKinds.${k}`, 'dry sand above the dune crest')
      const d = v.depth
      if (!Array.isArray(d) || d.length !== 3 || !d.every(isNum) || !(d[0] <= d[1] && d[1] <= d[2])) {
        err(`beachKinds.${k}.depth`, 'expected three non-decreasing depths')
      }
    }
  }

  const codes = new Set<string>()
  if (!Array.isArray(m.sections) || !m.sections.length) err('sections', 'expected a non-empty array')
  else {
    m.sections.forEach((s: unknown, i: number) => {
      const p = `sections[${i}]`
      if (!isObj(s)) return err(p, 'expected an object')
      if (typeof s.code !== 'string' || !s.code) err(`${p}.code`, 'expected a string')
      else if (codes.has(s.code)) err(`${p}.code`, `duplicate ${s.code}`)
      else codes.add(s.code)
      if (!COAST_SIDES.includes(s.side as CoastSide)) err(`${p}.side`, `expected one of ${COAST_SIDES.join(', ')}`)
      if (!Number.isInteger(s.from) || !Number.isInteger(s.to) || (s.from as number) > (s.to as number)) err(`${p}.from/to`, 'expected integers from <= to')
      if (s.corners !== undefined && (!Array.isArray(s.corners) || !s.corners.every(c => Array.isArray(c) && c.length === 2 && c.every(isNum)))) {
        err(`${p}.corners`, 'expected [[x, z], ...]')
      }
      if (s.area !== undefined && (typeof s.area !== 'string' || !/^[A-Za-z][A-Za-z0-9 '.-]{0,47}$/.test(s.area))) {
        err(`${p}.area`, 'expected an area name (letters, digits, spaces, apostrophes, dots, hyphens; at most 48)')
      }
      if (typeof s.kind !== 'string' || !kinds || !(s.kind in kinds)) err(`${p}.kind`, 'expected a key of beachKinds')
      if (!isNum(s.c0)) err(`${p}.c0`, 'expected a number')
      if (!isNum(s.amp) || s.amp < 0) err(`${p}.amp`, 'expected a number >= 0')
      if (s.phase !== 1 && s.phase !== 2) err(`${p}.phase`, 'expected 1 or 2')
      if ((s.side === 'corridor-south' || s.side === 'corridor-north') && !isRect(m.corridor)) err(`${p}.side`, 'a corridor side needs the corridor')
    })
  }

  const f = m.flank
  if (!isObj(f)) err('flank', 'expected an object')
  else {
    for (const k of ['shoulderM', 'inSampleM', 'inSlopeBlurM', 'reliefM', 'reliefBlurM', 'toeSmoothM', 'blendM', 'smoothM']) {
      if (!isNum(f[k]) || (f[k] as number) <= 0) err(`flank.${k}`, 'expected a positive number')
    }
    if (!isRange(f.inSlope)) err('flank.inSlope', 'expected [min, max]')
    if (!Array.isArray(f.lineBlurM) || f.lineBlurM.length !== 3 || !f.lineBlurM.every(v => isNum(v) && v > 0)) err('flank.lineBlurM', 'expected three positive numbers')
    const r = f.ridgeNoise
    if (!isObj(r) || !isNum(r.ampM) || !isNum(r.wavelengthM) || !Number.isInteger(r.octaves) || !Number.isInteger(r.seedOffset)) {
      err('flank.ridgeNoise', 'expected {ampM, wavelengthM, octaves, seedOffset}')
    }
  }
  const h = m.hinterland
  if (!isObj(h) || !['riseSlope', 'riseBehindM', 'holdM', 'relaxM'].every(k => isNum(h[k]))) err('hinterland', 'expected {riseSlope, riseBehindM, holdM, relaxM}')
  if (!isNum(m.riverMouthKeepM) || m.riverMouthKeepM <= 0) err('riverMouthKeepM', 'expected a positive number')
  const t = m.tombKeep
  if (!isObj(t) || !isRange(t.x) || !isNum(t.beyondCrestM) || !isNum(t.crestSmoothM) || !isNum(t.lineSmoothM) || typeof t.continueFace !== 'boolean') {
    err('tombKeep', 'expected {x, beyondCrestM, crestSmoothM, lineSmoothM, continueFace}')
  } else {
    if (t.maxFaceSlope !== undefined && (!isNum(t.maxFaceSlope) || t.maxFaceSlope <= 0)) err('tombKeep.maxFaceSlope', 'expected a positive number')
    if (t.faceSampleM !== undefined && (!isNum(t.faceSampleM) || t.faceSampleM < 2)) err('tombKeep.faceSampleM', 'expected a number >= 2')
  }
  if (!isNum(m.holeBelowM) || m.holeBelowM >= 0) err('holeBelowM', 'expected a negative number')

  if (!Array.isArray(m.allowHeightPatches)) err('allowHeightPatches', 'expected an array')
  else {
    m.allowHeightPatches.forEach((p: unknown, i: number) => {
      if (!isObj(p) || typeof p.name !== 'string' || !isRange(p.x) || !isRange(p.z) || !isNum(p.maxHeightM) ||
        (p.feather !== 'inward' && p.feather !== 'blur')) err(`allowHeightPatches[${i}]`, 'expected {name, x, z, maxHeightM, feather}')
    })
  }
  if (!Array.isArray(m.openTiles) || !m.openTiles.every(isRect)) err('openTiles', 'expected an array of rectangles')
  if (!Array.isArray(m.hotspots) || !m.hotspots.every((h: unknown) => isObj(h) && isRect(h) && typeof h.name === 'string' && !!h.name)) {
    err('hotspots', 'expected an array of named rectangles')
  }

  const paint = m.paint
  if (!isObj(paint)) err('paint', 'expected an object')
  else {
    if (!isNum(paint.grassMaxDeg) || !isNum(paint.rockFromDeg) || paint.grassMaxDeg >= paint.rockFromDeg) err('paint', 'expected grassMaxDeg < rockFromDeg')
    if (!isNum(paint.allowInsideBoundsM) || paint.allowInsideBoundsM < 0) err('paint.allowInsideBoundsM', 'expected a number >= 0')
    const seen = new Set<number>()
    if (!Array.isArray(paint.palette) || !paint.palette.length) err('paint.palette', 'expected a non-empty array')
    else {
      paint.palette.forEach((e: unknown, i: number) => {
        if (!isObj(e) || !Number.isInteger(e.i) || !Number.isInteger(e.tile) || !Number.isInteger(e.code) || typeof e.name !== 'string' ||
          typeof e.rgb !== 'string' || !/^#[0-9a-f]{6}$/i.test(e.rgb)) return err(`paint.palette[${i}]`, 'expected {i, tile, code, name, rgb}')
        if (seen.has(e.i as number)) err(`paint.palette[${i}].i`, 'duplicate index')
        seen.add(e.i as number)
      })
    }
  }
  const pl = m.placements
  if (!isObj(pl) || typeof pl.resnapVegetation !== 'boolean' || !isNum(pl.dropBelowSeaM) || !isNum(pl.dropMovedM)) {
    err('placements', 'expected {resnapVegetation, dropBelowSeaM, dropMovedM}')
  }
  if (isObj(pl)) {
    const refs = new Set<string>()
    for (const key of ['drop', 'accept'] as const) {
      const list = pl[key]
      if (list === undefined) continue
      if (!Array.isArray(list)) {
        err(`placements.${key}`, 'expected [{region, uid, note}]')
        continue
      }
      list.forEach((e: unknown, i: number) => {
        if (!isObj(e) || !Number.isInteger(e.region) || !Number.isInteger(e.uid) || typeof e.note !== 'string' || !e.note) {
          return err(`placements.${key}[${i}]`, 'expected {region, uid, note}')
        }
        const id = `${e.region}:${e.uid}`
        if (refs.has(id)) err(`placements.${key}[${i}]`, `placement ${id} listed twice`)
        refs.add(id)
      })
    }
  }
  if (!Array.isArray(m.places) || !m.places.every(p => isObj(p) && typeof p.name === 'string' && /^[a-z0-9_-]{1,32}$/.test(p.name) && isNum(p.x) && isNum(p.z))) {
    err('places', 'expected [{name (a tp name), x, z}]')
  }
  const o = m.ocean
  if (!isObj(o) || typeof o.mapColor !== 'string' || !isNum(o.fieldMetresPerTexel)) err('ocean', 'expected {mapColor, fieldMetresPerTexel}')
  const d = m.drown
  if (d !== undefined) {
    if (!isObj(d)) err('drown', 'expected an object')
    else {
      if (d.openWater !== undefined && (!Array.isArray(d.openWater) || !d.openWater.every(isRect))) err('drown.openWater', 'expected an array of rectangles')
      for (const key of ['regions', 'areas'] as const) {
        if (!Array.isArray(d[key]) || !(d[key] as unknown[]).every(isRect)) err(`drown.${key}`, 'expected an array of rectangles')
      }
      for (const key of ['regions', 'soft'] as const) {
        const list = d[key]
        if (key === 'soft' && list === undefined) continue
        if (!Array.isArray(list) || !list.every((r: unknown) => isRect(r) && [...r.x, ...r.z].every(Number.isInteger))) {
          err(`drown.${key}`, 'expected whole regions (integer rectangles)')
        }
      }
      if (!isNum(d.islandMaxKm2) || d.islandMaxKm2 < 0) err('drown.islandMaxKm2', 'expected a number >= 0')
      if (!isRange(d.depthM) || d.depthM[0] <= 0) err('drown.depthM', 'expected [shore, far] depths > 0')
      for (const k of ['shelfM', 'rampDeg', 'rampMinM']) if (!isNum(d[k]) || (d[k] as number) <= 0) err(`drown.${k}`, 'expected a positive number')
      if (isNum(d.rampDeg) && d.rampDeg >= 90) err('drown.rampDeg', 'expected less than 90')
    }
  }
  return errors
}

/** Parses and validates coast.json text; throws with every problem listed. */
export function parseCoastConfig(text: string): CoastConfig {
  const m = JSON.parse(text) as unknown
  const errors = validateCoastConfig(m)
  if (errors.length) throw new Error(`coast.json invalid:\n  ${errors.join('\n  ')}`)
  return m as CoastConfig
}

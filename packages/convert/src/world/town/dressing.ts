/**
 * The town dressing pass (docs/TOWN_LIFE.md §7, docs/WAVE_PLAN7.md D13, D15, D18, D33; lane TL-B): the dressing file
 * (`content/town/<town>-dressing.json`, kind 'townDressing') as placements in the export, applied by ../passes.ts after
 * the coast's C9 and before the cloth reclass, the static variants and the grass masks, so the batcher merges the new
 * props with the town at no extra draw.
 *
 * - **props** and **banners**: a model by name: one of our props (`town/props/<name>`: the Blender builder's mesh JSON
 *   and PNG in content/town/props/, written here as a glb + sidecar), a model the export already has (by base name or
 *   resource path, the way ambient.ts matches lamps), or a retail resource (`res/...bsr`) converted from Data.pk2. A
 *   `scale` other than 1 makes a scaled copy of the model (placements carry no scale). A banner's `kind` and `height`
 *   (and a prop's `cloth`) go on the model's cloth material as the manifest's `models[].cloth` (the batcher's sway).
 * - **crackBands**: short grass tufts (our `tuft_a` / `tuft_b`) along each polyline, `density` blades per m² across
 *   `width`, seeded by the band, so the same file gives the same tufts (TOWN_LIFE §7.3: placements, no new draw and no
 *   grass/** edit).
 * - **decals**: their ground height resolved here and written to `town-decals.json` beside the manifest (the client's
 *   world-render town/decals.ts draws them, Medium and up; ≤ DECALS_PER_REGION a region).
 * - **lamps** are not placements: ./ambient.ts reads them into ambient.json (W11-CV); **pond** is the client's (the
 *   water's 'town' profile, world-render town/decals.ts `applyTownPond`), except that the retail lilies of the pond
 *   regions lying under their water plane are re-snapped onto it (`floatLilies`): under the turbid profile a pad
 *   13 cm down would read as drowned.
 *
 * **Every placement stands on the ground, off the walkable paths; the nav is unchanged** (TOWN_LIFE §12.2 TL-B: props
 * are decoration only). A row is placed only when (`checkRow`): its ground is the walkable surface of the export's main
 * nav component under it (the plaza's floor, a street, a lawn; never a roof or a closed cell), its footprint is flat
 * (every sample within FLAT_M of the lowest, which the prop stands on), it clears every retail obstacle (buildings,
 * walls, lamps, stalls; not foliage or floors) and every other dressing prop by CLEAR_M, keeps NPC_CLEAR_M from every
 * NPC. A town graph edge (TL-R's walkers' paths, when the export has `town.json`) passing within ROUTE_CLEAR_M of a
 * placed prop is a warning, not a skip: the graph is rebuilt around the dressing (D27), so the dressing is not lost to
 * an older graph; the tests hold the file to zero crossings with the current graph. A row that fails is a warning and
 * is skipped: the export never carries a floating, sunken or blocking prop. nav.bin is read, never written.
 *
 * The node work (nav.bin, Data.pk2, glb writing) is ./dressing-io.ts's, injected as `DressingDeps` (tests pass fakes).
 */
import type { TownBanner, TownClothKind, TownCrackBand, TownDecal, TownDressingFile, TownPondProfile, TownProp } from '../../../../shared/src/town.ts'
import type { WorldModel, WorldModelCloth, WorldPlacement, WorldRegion } from '../manifest.ts'
import type { PlacementRef, TownDressingEdits, TownDressingPass, WorldPassContext } from '../passes.ts'
import { modelKey } from '../ambient.ts'

/** Model names of our props: `town/props/<name>` (content/town/props/<name>.json + its PNGs). */
export const TOWN_PROP_PREFIX = 'town/props/'
/** First uid of the dressing's placements in each region (retail uids stay far below). */
export const TOWN_UID_BASE = 1_000_000
/** The resolved decals beside the manifest (world-render town/decals.ts reads it). */
export const TOWN_DECALS_FILE = 'town-decals.json'
export const TOWN_DECALS_FORMAT = 'sro-town-decals'
/** Decals a region may hold (TOWN_LIFE §7.4). */
export const DECALS_PER_REGION = 40
/** A footprint is flat when every sample lies within this of the lowest (m). */
export const FLAT_M = 0.2
/** A decal's corners lie within this of its centre (m): flat paving. */
export const DECAL_FLAT_M = 0.12
/** Clearance between a prop's footprint and a retail obstacle or another prop (m). */
export const CLEAR_M = 0.25
/** No prop within this of an NPC (m; the stall rule of social/stall.ts). */
export const NPC_CLEAR_M = 3
/**
 * No town graph edge passes within this of a prop's footprint (m): the walkers' paths (TL-R's graph) never run through
 * a prop (their own clearance from nav edges is 0.4 m).
 */
export const ROUTE_CLEAR_M = 0.3
/** Retail models that are no obstacle: floors and flat pieces lower than this (m), or footprints larger than OBSTACLE_MAX_M2. */
export const OBSTACLE_MIN_HEIGHT_M = 0.6
export const OBSTACLE_MAX_M2 = 600
/** Blades per tuft model (the builder's cards × ≈ 2 blades a card), for a band's `density` (blades per m²). */
export const TUFT_BLADES = 7
export const TUFT_MODELS = ['town/props/tuft_a', 'town/props/tuft_b'] as const
/** Retail models that float on a pond (`floatLilies`), and how far above the plane they sit (m). */
export const LILY_MODELS = /c_pondflower|lotus|lily/i
export const LILY_LIFT_M = 0.02
/** Lilies deeper than this under their plane are left alone (m). */
export const LILY_MAX_DEPTH_M = 0.6

/** The walkable ground under glTF (x, z): the main nav component's surface height (m), or null. */
export type DressingGround = (x: number, z: number) => number | null

/** One of our props, as the Blender builder writes it (packages/convert/tools/blender/town/props/build.py). */
export interface TownPropMesh {
  format: 'sro-town-prop'
  version: 1
  name: string
  triangles: number
  boundsMin: [number, number, number]
  boundsMax: [number, number, number]
  materials: Array<{
    name: string
    texture: string
    alphaMode: 'OPAQUE' | 'MASK' | 'BLEND'
    alphaCutoff?: number
    doubleSided: boolean
    cloth?: { kind: TownClothKind; pinY: number; height: number }
  }>
  primitives: Array<{ material: number; positions: number[]; normals: number[]; uvs: number[]; indices: number[] }>
}

/** A model to write (our prop or a scaled copy), or to convert (retail), with what the pass wants of it. */
export interface DressingModelRequest {
  /** 'prop': content/town/props/<name>; 'retail': a Data.pk2 resource; 'export': a model the export already has. */
  from: 'prop' | 'retail' | 'export'
  /** Prop name, resource path, or the export model's index (as a string). */
  ref: string
  scale: number
  /** Cloth kind / height overrides for the prop's cloth materials. */
  cloth?: { kind: TownClothKind; height?: number }
  /** File stem under models/ (unique per request). */
  stem: string
}

/** The node side of the pass (./dressing-io.ts `nodeDressingDeps`). */
export interface DressingDeps {
  /** The walkable ground of the export in ctx.outDir (nav.bin's main component); null: no nav (nothing is placed). */
  ground(ctx: WorldPassContext): DressingGround | null
  /** NPC positions (glTF m) for the keep-out; [] when unknown. */
  npcs(ctx: WorldPassContext): Array<{ x: number; z: number }>
  /** The town graph's edges (glTF m) from the export's town.json; [] when none. */
  routes(ctx: WorldPassContext): Array<[number, number, number, number]>
  /** Our prop's mesh (null: missing or invalid, with a warning). */
  prop(name: string, warnings: string[]): TownPropMesh | null
  /** Writes (or converts) a model into ctx.outDir; null on failure (with a warning). */
  writeModel(req: DressingModelRequest, ctx: WorldPassContext, base: WorldModel | null): Promise<Omit<WorldModel, 'index' | 'staticVariant'> | null>
  /** Writes a JSON file under ctx.outDir. */
  writeJson(ctx: WorldPassContext, rel: string, value: unknown): void
}

/** A decal with its ground height and region (`town-decals.json`). */
export interface ResolvedDecal {
  kind: TownDecal['kind']
  x: number
  y: number
  z: number
  yaw: number
  size: [number, number]
  region: number
}

export interface TownDecalsFile {
  format: typeof TOWN_DECALS_FORMAT
  version: 1
  decals: ResolvedDecal[]
}

/** A row the pass places: a prop, a banner or a crack-grass tuft. */
interface Row {
  what: string
  model: string
  x: number
  z: number
  y?: number
  yaw: number
  scale: number
  cloth?: { kind: TownClothKind; height?: number }
  tuft?: boolean
}

/** A rotated rectangle on the ground (glTF x, z): centre, half extents along its own axes, yaw (+yaw about +Y). */
export interface Footprint {
  x: number
  z: number
  hx: number
  hz: number
  /** Local box centre offset (before rotation). */
  ox: number
  oz: number
  yaw: number
}

/** The footprint of a model (its bounds × scale) placed at (x, z) with yaw. */
export function footprintOf(m: Pick<WorldModel, 'boundsMin' | 'boundsMax'>, x: number, z: number, yaw: number, scale = 1): Footprint {
  return {
    x, z, yaw,
    hx: ((m.boundsMax[0] - m.boundsMin[0]) / 2) * scale,
    hz: ((m.boundsMax[2] - m.boundsMin[2]) / 2) * scale,
    ox: ((m.boundsMax[0] + m.boundsMin[0]) / 2) * scale,
    oz: ((m.boundsMax[2] + m.boundsMin[2]) / 2) * scale,
  }
}

/** A local point (lx, lz) of a footprint in glTF (x, z): +yaw about +Y (x' = x cos + z sin, z' = −x sin + z cos). */
export function footprintPoint(f: Footprint, lx: number, lz: number): [number, number] {
  const c = Math.cos(f.yaw)
  const s = Math.sin(f.yaw)
  const x = f.ox + lx
  const z = f.oz + lz
  return [f.x + x * c + z * s, f.z - x * s + z * c]
}

/** Ground samples of a footprint: the centre, the four corners and the edge midpoints, `inset` inside its edges. */
export function footprintSamples(f: Footprint, inset = 0.05): Array<[number, number]> {
  const ax = Math.max(0, f.hx - inset)
  const az = Math.max(0, f.hz - inset)
  const out: Array<[number, number]> = []
  for (const u of [-1, 0, 1]) for (const v of [-1, 0, 1]) out.push(footprintPoint(f, u * ax, v * az))
  return out
}

/** Whether two footprints overlap or come closer than `pad` (separating axis test of two rectangles). */
export function footprintsOverlap(a: Footprint, b: Footprint, pad = 0): boolean {
  const ca = footprintPoint(a, 0, 0)
  const cb = footprintPoint(b, 0, 0)
  const axes = (f: Footprint): Array<[number, number]> => [[Math.cos(f.yaw), -Math.sin(f.yaw)], [Math.sin(f.yaw), Math.cos(f.yaw)]]
  const half = (f: Footprint): [number, number] => [f.hx + pad / 2, f.hz + pad / 2]
  const dx = cb[0] - ca[0]
  const dz = cb[1] - ca[1]
  for (const [ux, uz] of [...axes(a), ...axes(b)]) {
    const proj = (f: Footprint) => {
      const [x, z] = axes(f)
      const [h0, h1] = half(f)
      return h0 * Math.abs(x[0] * ux + x[1] * uz) + h1 * Math.abs(z[0] * ux + z[1] * uz)
    }
    if (Math.abs(dx * ux + dz * uz) > proj(a) + proj(b)) return false
  }
  return true
}

/** Distance from (x, z) to the segment (ax, az)-(bx, bz). */
export function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  const l2 = dx * dx + dz * dz
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz))
}

/**
 * Whether the segment (ax, az)-(bx, bz) passes within `pad` of a footprint (the segment clipped against the footprint
 * grown by `pad`, in its own frame: Liang–Barsky).
 */
export function segmentHitsFootprint(f: Footprint, ax: number, az: number, bx: number, bz: number, pad = 0): boolean {
  const c = Math.cos(f.yaw)
  const s = Math.sin(f.yaw)
  // world -> local: invert x' = x c + z s, z' = -x s + z c (a rotation), then remove the box offset
  const local = (x: number, z: number): [number, number] => {
    const dx = x - f.x
    const dz = z - f.z
    return [dx * c - dz * s - f.ox, dx * s + dz * c - f.oz]
  }
  const [x0, z0] = local(ax, az)
  const [x1, z1] = local(bx, bz)
  const hx = f.hx + pad
  const hz = f.hz + pad
  let t0 = 0
  let t1 = 1
  const dx = x1 - x0
  const dz = z1 - z0
  for (const [p, q] of [[-dx, x0 + hx], [dx, hx - x0], [-dz, z0 + hz], [dz, hz - z0]] as Array<[number, number]>) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false
    } else {
      const r = q / p
      if (p < 0) t0 = Math.max(t0, r)
      else t1 = Math.min(t1, r)
      if (t0 > t1) return false
    }
  }
  return true
}

/** The owner region id ((z << 8) | x) of glTF (x, z) for a floating origin region. */
export function regionOf(origin: { x: number; z: number }, x: number, z: number): number {
  const rx = origin.x + Math.floor(x / 192)
  const rz = origin.z + Math.floor(-z / 192)
  return (rz << 8) | rx
}

/** A placement's glTF rotation for yaw (+yaw about +Y; the same quaternion as objects.ts placementRotation). */
export function yawQuat(yaw: number): [number, number, number, number] {
  const h = yaw / 2
  const r = (v: number) => Math.round(v * 1e9) / 1e9 + 0
  return [0, r(Math.sin(h)), 0, r(Math.cos(h))]
}

/** A seeded random sequence (mulberry32): the same band gives the same tufts. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The tufts of a crack band: about `density × width × length / TUFT_BLADES` tufts, evenly spread along the polyline
 * with jitter, each offset across the band within ±width/2, a seeded yaw and one of TUFT_MODELS.
 */
export function crackTufts(band: TownCrackBand, seed: number): Array<{ x: number; z: number; yaw: number; model: string }> {
  const rnd = seeded(0x7b1d ^ Math.imul(seed + 1, 0x9e3779b1))
  const out: Array<{ x: number; z: number; yaw: number; model: string }> = []
  const pts = band.points
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i]!
    const [bx, bz] = pts[i + 1]!
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 1e-6) continue
    const n = Math.max(0, Math.round((band.density * band.width * len) / TUFT_BLADES))
    const ux = (bx - ax) / len
    const uz = (bz - az) / len
    for (let k = 0; k < n; k++) {
      const t = (k + 0.15 + 0.7 * rnd()) / n
      const off = (rnd() - 0.5) * band.width
      out.push({
        x: ax + ux * len * t - uz * off,
        z: az + uz * len * t + ux * off,
        yaw: rnd() * Math.PI * 2,
        model: TUFT_MODELS[rnd() < 0.5 ? 0 : 1]!,
      })
    }
  }
  return out
}

const isOurProp = (name: string) => name.trim().toLowerCase().startsWith(TOWN_PROP_PREFIX)
const propName = (name: string) => name.trim().slice(TOWN_PROP_PREFIX.length).replace(/\.(json|glb)$/i, '')
const isResource = (name: string) => /\.(bsr)$/i.test(name.trim())
const fmt = (v: number) => Number(v.toFixed(2))

/** Models that are no obstacle for a prop: vegetation, flowers, grass, and our own tufts. */
function softModel(source: string): boolean {
  const s = source.toLowerCase().replace(/\\/g, '/')
  return /(^|\/)res\/nature\//.test(s) || /tree|bush|grass|flower|flw_|reed|tre_|grs_/.test(s) || s.startsWith(TOWN_PROP_PREFIX + 'tuft')
}

/** The retail obstacles of the export near the dressing: footprints of every placed non-foliage, non-floor model. */
export function retailObstacles(ctx: Pick<WorldPassContext, 'placements' | 'models'>): Footprint[] {
  const out: Footprint[] = []
  for (const p of ctx.placements) {
    for (const mi of p.models) {
      const m = ctx.models[mi]
      if (!m || m.kind === 'failed' || softModel(m.source)) continue
      const h = m.boundsMax[1] - m.boundsMin[1]
      const area = (m.boundsMax[0] - m.boundsMin[0]) * (m.boundsMax[2] - m.boundsMin[2])
      if (h < OBSTACLE_MIN_HEIGHT_M || area > OBSTACLE_MAX_M2) continue
      out.push(footprintOf(m, p.position[0], p.position[2], p.yaw))
    }
  }
  return out
}

/** The first town route passing within ROUTE_CLEAR_M of a footprint, as a message (null: none). */
export function routeCrossing(f: Footprint, routes: ReadonlyArray<readonly [number, number, number, number]>): string | null {
  for (const [ax, az, bx, bz] of routes) {
    if (segmentHitsFootprint(f, ax, az, bx, bz, ROUTE_CLEAR_M)) return `on a town route (${fmt(ax)}, ${fmt(az)})-(${fmt(bx)}, ${fmt(bz)})`
  }
  return null
}

/** Why a footprint may not stand at its spot (null: it may), and the height it stands at. */
export function checkFootprint(
  f: Footprint,
  ground: DressingGround,
  opts: { y?: number; obstacles?: readonly Footprint[]; placed?: readonly Footprint[]; npcs?: ReadonlyArray<{ x: number; z: number }>; routes?: ReadonlyArray<readonly [number, number, number, number]>; flatM?: number },
): { y: number; problem: null } | { y: null; problem: string } {
  const samples = footprintSamples(f)
  const hs: number[] = []
  for (const [x, z] of samples) {
    const h = ground(x, z)
    if (h === null || !Number.isFinite(h)) return { y: null, problem: `no walkable ground at (${fmt(x)}, ${fmt(z)})` }
    hs.push(h)
  }
  const lo = Math.min(...hs)
  const hi = Math.max(...hs)
  const flat = opts.flatM ?? FLAT_M
  if (hi - lo > flat) return { y: null, problem: `ground not flat (${fmt(hi - lo)} m over the footprint)` }
  const [cx, cz] = footprintPoint(f, 0, 0)
  for (const n of opts.npcs ?? []) {
    if (Math.hypot(n.x - cx, n.z - cz) - Math.hypot(f.hx, f.hz) < NPC_CLEAR_M) return { y: null, problem: `within ${NPC_CLEAR_M} m of an NPC at (${fmt(n.x)}, ${fmt(n.z)})` }
  }
  const crossing = routeCrossing(f, opts.routes ?? [])
  if (crossing) return { y: null, problem: crossing }
  for (const o of opts.obstacles ?? []) {
    if (footprintsOverlap(f, o, CLEAR_M)) {
      const [ox, oz] = footprintPoint(o, 0, 0)
      return { y: null, problem: `overlaps a retail object at (${fmt(ox)}, ${fmt(oz)})` }
    }
  }
  for (const o of opts.placed ?? []) {
    if (footprintsOverlap(f, o, CLEAR_M)) {
      const [ox, oz] = footprintPoint(o, 0, 0)
      return { y: null, problem: `overlaps another dressing prop at (${fmt(ox)}, ${fmt(oz)})` }
    }
  }
  return { y: opts.y ?? lo, problem: null }
}

/** The water plane (glTF y, m) at glTF (x, z) from the region's blocks (32 m, `bz * 6 + bx`), or null. */
export function waterPlaneAt(regions: ReadonlyMap<number, WorldRegion>, origin: { x: number; z: number }, x: number, z: number): number | null {
  const r = regions.get(regionOf(origin, x, z))
  if (!r) return null
  const bx = Math.floor((x - r.origin[0]) / 32)
  const bz = Math.floor((r.origin[2] - z) / 32)
  const b = r.blocks.find(k => k.bx === bx && k.bz === bz)
  return b?.water && b.water.kind === 'water' ? (r.origin[1] ?? 0) + b.water.heightM : null
}

/**
 * The pond's lilies onto their water: every placement of a LILY_MODELS model in a pond region whose origin lies up to
 * LILY_MAX_DEPTH_M under its block's water plane is re-snapped to the plane + LILY_LIFT_M.
 */
export function floatLilies(pond: TownPondProfile, ctx: Pick<WorldPassContext, 'regions' | 'models' | 'placements' | 'origin'>): Array<PlacementRef & { y: number }> {
  const wanted = new Set(pond.regions)
  const byId = new Map(ctx.regions.map(r => [r.id, r]))
  const out: Array<PlacementRef & { y: number }> = []
  for (const p of ctx.placements) {
    const [x, y, z] = p.position
    if (!wanted.has(regionOf(ctx.origin, x, z))) continue
    if (!p.models.some(i => LILY_MODELS.test(ctx.models[i]?.source ?? ''))) continue
    const h = waterPlaneAt(byId, ctx.origin, x, z)
    if (h === null || y >= h + LILY_LIFT_M - 1e-4 || y < h - LILY_MAX_DEPTH_M) continue
    out.push({ region: p.region, uid: p.uid, y: Number((h + LILY_LIFT_M).toFixed(4)) })
  }
  return out
}

/** The pass's plan: the rows in file order (props, banners, then each band's tufts). */
function rowsOf(file: TownDressingFile): Row[] {
  const rows: Row[] = []
  file.props.forEach((p: TownProp, i) => rows.push({
    what: `props[${i}]${p.id ? ` (${p.id})` : ''}`, model: p.model, x: p.x, z: p.z, ...(p.y !== undefined ? { y: p.y } : {}), yaw: p.yaw,
    scale: p.scale ?? 1, ...(p.cloth ? { cloth: { kind: p.cloth } } : {}),
  }))
  file.banners.forEach((b: TownBanner, i) => rows.push({
    what: `banners[${i}]${b.id ? ` (${b.id})` : ''}`, model: b.model, x: b.x, z: b.z, yaw: b.yaw, scale: 1, cloth: { kind: b.kind, height: b.height },
  }))
  file.crackBands.forEach((band, i) => {
    crackTufts(band, i).forEach((t, k) => rows.push({ what: `crackBands[${i}] tuft ${k}`, model: t.model, x: t.x, z: t.z, yaw: t.yaw, scale: 1, tuft: true }))
  })
  return rows
}

/** What the pass did (for the log and the tests). */
export interface DressingReport {
  placed: number
  tufts: number
  skipped: Array<{ what: string; problem: string }>
  models: number
  decals: number
  decalsSkipped: Array<{ what: string; problem: string }>
  /** Lilies re-snapped onto their pond. */
  lilies: number
  /** Placed rows a town route crosses (warnings: TL-R's graph should go round them). */
  routeCrossings: Array<{ what: string; problem: string }>
}

/** The dressing pass for a validated dressing file (`deps` default: ./dressing-io.ts, the node side). */
export function createTownDressingPass(file: TownDressingFile, deps?: DressingDeps, report?: (r: DressingReport) => void): TownDressingPass {
  return async (ctx: WorldPassContext): Promise<TownDressingEdits> => {
    const empty: TownDressingEdits = { drop: [], resnap: [], add: [], models: [] }
    const rows = rowsOf(file)
    if (!rows.length && !file.decals.length && !file.pond) return empty
    const d = deps ?? (await import('./dressing-io.ts')).nodeDressingDeps()
    const ground = d.ground(ctx)
    if (!ground) {
      ctx.warnings.push('town dressing: the export has no nav (nav.bin); nothing placed')
      return empty
    }
    const out = await applyDressing(file, rows, ctx, d, ground)
    report?.(out.report)
    const r = out.report
    ctx.log(`town dressing: ${r.placed} placement(s) (${r.tufts} crack-grass tuft(s)), ${r.models} new model(s), ` +
      `${r.decals} decal(s), ${r.lilies} lily(ies) floated; ${r.skipped.length + r.decalsSkipped.length} row(s) skipped, ` +
      `${r.routeCrossings.length} on a town route`)
    return out.edits
  }
}

async function applyDressing(file: TownDressingFile, rows: readonly Row[], ctx: WorldPassContext, d: DressingDeps, ground: DressingGround):
  Promise<{ edits: TownDressingEdits; report: DressingReport }> {
  const report: DressingReport = { placed: 0, tufts: 0, skipped: [], models: 0, decals: 0, decalsSkipped: [], lilies: 0, routeCrossings: [] }
  const skip = (what: string, problem: string) => {
    report.skipped.push({ what, problem })
    ctx.warnings.push(`town dressing: ${what} skipped: ${problem}`)
  }
  const newModels: Array<Omit<WorldModel, 'index' | 'staticVariant'>> = []
  /** Model key (name | scale | cloth) -> its index (existing or appended), or null when it failed. */
  const byKey = new Map<string, number | null>()
  const props = new Map<string, TownPropMesh | null>()
  const prop = (name: string) => {
    if (!props.has(name)) props.set(name, d.prop(name, ctx.warnings))
    return props.get(name) ?? null
  }

  const modelFor = async (row: Row): Promise<{ index: number; model: Pick<WorldModel, 'boundsMin' | 'boundsMax' | 'source'> } | string> => {
    const clothKey = row.cloth ? `${row.cloth.kind}:${row.cloth.height ?? ''}` : ''
    const key = `${modelKey(row.model)}|${row.scale}|${clothKey}`
    const at = (i: number) => ({ index: i, model: i < ctx.models.length ? ctx.models[i]! : newModels[i - ctx.models.length]! })
    if (byKey.has(key)) {
      const i = byKey.get(key)
      return i === null || i === undefined ? `model ${row.model} unavailable` : at(i)
    }
    const remember = (m: Omit<WorldModel, 'index' | 'staticVariant'> | null): number | null => {
      if (!m) {
        byKey.set(key, null)
        return null
      }
      const i = ctx.models.length + newModels.length
      newModels.push(m)
      byKey.set(key, i)
      return i
    }
    const scaleTag = row.scale === 1 ? '' : `@s${Math.round(row.scale * 100)}`
    const clothTag = row.cloth ? `@${row.cloth.kind}${row.cloth.height !== undefined ? Math.round(row.cloth.height * 100) : ''}` : ''
    if (isOurProp(row.model)) {
      const name = propName(row.model)
      const mesh = prop(name)
      if (!mesh) {
        byKey.set(key, null)
        return `prop ${name} not found`
      }
      if (row.cloth && !mesh.materials.some(m => m.cloth)) ctx.warnings.push(`town dressing: ${row.what}: ${name} has no cloth material; cloth ignored`)
      const i = remember(await d.writeModel({ from: 'prop', ref: name, scale: row.scale, ...(row.cloth ? { cloth: row.cloth } : {}), stem: `town/props/${name}${scaleTag}${clothTag}` }, ctx, null))
      return i === null ? `prop ${name} failed to write` : at(i)
    }
    if (row.cloth) ctx.warnings.push(`town dressing: ${row.what}: cloth on a retail model is TL-M's reclass list (world/town/cloth.ts); ignored`)
    // a model the export has (by base name or path), else a retail resource to convert
    const want = modelKey(row.model)
    const have = ctx.models.find(m => m.kind !== 'failed' && !m.source.includes('#') && (want.includes('/') ? modelKey(m.source) === want || modelKey(m.source).endsWith('/' + want) : modelKey(m.source).split('/').pop() === want))
    if (have && row.scale === 1) {
      byKey.set(key, have.index)
      return at(have.index)
    }
    if (have) {
      const stem = `${modelKey(have.source)}${scaleTag}`
      const i = remember(await d.writeModel({ from: 'export', ref: String(have.index), scale: row.scale, stem }, ctx, have))
      return i === null ? `scaled ${row.model} failed` : at(i)
    }
    if (!isResource(row.model)) {
      byKey.set(key, null)
      return `model ${row.model} is not in the export and is not a res/...bsr path`
    }
    const stem = `${modelKey(row.model)}${scaleTag}`
    const i = remember(await d.writeModel({ from: 'retail', ref: row.model, scale: row.scale, stem }, ctx, null))
    return i === null ? `retail ${row.model} failed to convert` : at(i)
  }

  const regionIds = new Set(ctx.regions.map(r => r.id))
  const npcs = d.npcs(ctx)
  const routes = d.routes(ctx)
  const obst = retailObstacles(ctx)
  const placedPrints: Footprint[] = []
  const nextUid = new Map<number, number>()
  const add: WorldPlacement[] = []
  for (const row of rows) {
    const m = await modelFor(row)
    if (typeof m === 'string') {
      skip(row.what, m)
      continue
    }
    const region = regionOf(ctx.origin, row.x, row.z)
    if (!regionIds.has(region)) {
      skip(row.what, `(${fmt(row.x)}, ${fmt(row.z)}) is outside the converted regions`)
      continue
    }
    // the resolved model is already at the row's scale (a scaled copy), so its bounds are the footprint as they are
    const f = footprintOf(m.model, row.x, row.z, row.yaw)
    let y: number
    if (row.tuft) {
      const h = ground(row.x, row.z)
      if (h === null || !Number.isFinite(h)) {
        report.skipped.push({ what: row.what, problem: 'no walkable ground' })
        continue
      }
      y = h
    } else {
      const c = checkFootprint(f, ground, { ...(row.y !== undefined ? { y: row.y } : {}), obstacles: obst, placed: placedPrints, npcs })
      if (c.problem !== null) {
        skip(row.what, c.problem)
        continue
      }
      y = c.y
      placedPrints.push(f)
      // the walkers' paths: a crossing is reported, not skipped (TL-R's graph is rebuilt around the dressing, D27)
      const crossing = routeCrossing(f, routes)
      if (crossing) {
        report.routeCrossings.push({ what: row.what, problem: crossing })
        ctx.warnings.push(`town dressing: ${row.what}: ${crossing}`)
      }
    }
    const uid = nextUid.get(region) ?? TOWN_UID_BASE
    nextUid.set(region, uid + 1)
    const big = Math.max(f.hx, f.hz) * 2 > 3 || m.model.boundsMax[1] > 2.5
    add.push({
      objId: -1,
      source: m.model.source,
      models: [m.index],
      compound: false,
      position: [Number(row.x.toFixed(4)), Number(y.toFixed(4)), Number(row.z.toFixed(4))],
      rotation: yawQuat(row.yaw),
      yaw: row.yaw,
      flags: { static: true, big: false, struct: false },
      staticFlag: 0xffff,
      uid,
      region,
      group: row.tuft || !big ? 3 : 2,
      inConvertedRegion: true,
    })
    report.placed++
    if (row.tuft) report.tufts++
  }
  report.models = newModels.length

  // decals: their ground (flat paving), at most DECALS_PER_REGION a region, written beside the manifest
  const decals: ResolvedDecal[] = []
  const perRegion = new Map<number, number>()
  file.decals.forEach((dc, i) => {
    const what = `decals[${i}]`
    const bad = (problem: string) => {
      report.decalsSkipped.push({ what, problem })
      ctx.warnings.push(`town dressing: ${what} skipped: ${problem}`)
    }
    const region = regionOf(ctx.origin, dc.x, dc.z)
    if (!regionIds.has(region)) return bad('outside the converted regions')
    const n = perRegion.get(region) ?? 0
    if (n >= DECALS_PER_REGION) return bad(`region ${region} already holds ${DECALS_PER_REGION} decals`)
    const f: Footprint = { x: dc.x, z: dc.z, hx: dc.size[0] / 2, hz: dc.size[1] / 2, ox: 0, oz: 0, yaw: dc.yaw }
    const c = checkFootprint(f, ground, { flatM: DECAL_FLAT_M })
    if (c.problem !== null) return bad(c.problem)
    perRegion.set(region, n + 1)
    decals.push({ kind: dc.kind, x: dc.x, y: Number(c.y.toFixed(4)), z: dc.z, yaw: dc.yaw, size: [dc.size[0], dc.size[1]], region })
  })
  report.decals = decals.length
  // written only when the file has decals (the client reads it only then: a file left by an earlier run is never read)
  const decalFile: TownDecalsFile = { format: TOWN_DECALS_FORMAT, version: 1, decals }
  if (file.decals.length) d.writeJson(ctx, TOWN_DECALS_FILE, decalFile)

  const resnap = file.pond ? floatLilies(file.pond, ctx) : []
  report.lilies = resnap.length

  return { edits: { drop: [], resnap, add, models: newModels }, report }
}

/** The cloth records of one of our props for a row's override (kind; height scales nothing else). */
export function propCloth(mesh: TownPropMesh, scale: number, over?: { kind: TownClothKind; height?: number }): WorldModelCloth[] {
  const out: WorldModelCloth[] = []
  for (const m of mesh.materials) {
    if (!m.cloth) continue
    out.push({
      material: m.name,
      kind: over?.kind ?? m.cloth.kind,
      pinY: Number((m.cloth.pinY * scale).toFixed(4)),
      height: Number(((over?.height ?? m.cloth.height) * (over?.height !== undefined ? 1 : scale)).toFixed(4)),
    })
  }
  return out
}

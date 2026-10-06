/**
 * Siege of Jangan, the walls (docs/SIEGE.md §2, §4.2, §10.2, §11.2): the pure rules the server, the client and the
 * converter share.
 *
 * - **Segments**: the four outer walls are cut into 33 segments (N1..N10, S1..S9, W1..W7, E1..E7), each into thirds
 *   `a`, `b` (the middle), `c`. The converter writes them, with the nav pieces and the breach tiles of every third, to
 *   the world export's `siege/walls.json` (`WallsExport`, checked by `checkWallsExport`).
 * - **Integrity** `ip` per segment, an integer in [rubblePct, 100] % of `maxIp`; the stage is `wallStage` (with the
 *   +5 % hysteresis on the way up). Natural wear (lightning, tornado) stops at `naturalFloorPct` (`wearIp`).
 * - **Nav**: `wallNav` turns the stages into the nav instances to switch off and the tiles to force open; the server
 *   and the client apply the same result to their own NavWorld, so a walk through a gap predicts.
 * - **Safe area**: `breachZones` are the circles behind the gaps that are no longer safe.
 */
import type { Vec3 } from './protocol.ts'

export type WallStage = 'intact' | 'cracked' | 'breached' | 'rubble'
export const WALL_STAGES: readonly WallStage[] = ['intact', 'cracked', 'breached', 'rubble']

export type WallSide = 'N' | 'S' | 'W' | 'E'
export const WALL_SIDES: readonly WallSide[] = ['N', 'S', 'W', 'E']
export const WALL_SIDE_NAMES: Readonly<Record<WallSide, string>> = { N: 'North', S: 'South', W: 'West', E: 'East' }

/** A segment id: side + 1-based index (`N1`..`N10`); a third adds `a` / `b` / `c` (`W3b`). */
export const WALL_SEGMENT_ID = /^[NSWE](?:[1-9]|1[0-9])$/
export const WALL_THIRDS = ['a', 'b', 'c'] as const
export type WallThird = (typeof WALL_THIRDS)[number]

/** What a segment looks like to the client (`walls`, `wallUpdate`). `pct` is ip / maxIp in % (one decimal). */
export interface WallSegView {
  id: string
  stage: WallStage
  pct: number
  /** Repair scaffolding over `a` / `c` (a rubble segment climbing back: layer 3 draws it). */
  scaffold?: true
  /**
   * Layer 3 (docs/SIEGE.md §2.4, §9.2): work is being done on the segment right now (Master Mason Ko's builders
   * applying donated work, or a player's Mason's Kit channel). The client shows scaffolding and hammer sounds while set.
   */
  repairing?: true
  /** Layer 3: donated repair work waiting for the builders, in % of the segment (one decimal; absent = none). */
  queued?: number
}

/**
 * Layer 3 (docs/SIEGE.md §2.4, §11.2): the repair numbers the client shows (Master Mason Ko's donation window, the
 * Mason's Kit). Sent with `walls`; the server is the judge of every number.
 */
export interface WallRepairTerms {
  /** Gold per 1 % of a segment. */
  goldPerPct: number
  /** Stone Blocks per 1 %. */
  blocksPerPct: number
  /** Donated work queued on one segment stops at this % (the excess beyond a full repair waits for the next damage). */
  queueCapPct: number
  /** The builders apply at most this % per minute to each segment. */
  builderPctPerMin: number
  /** A Mason's Kit channel adds this % ... */
  kitPct: number
  /** ... every this many seconds. */
  kitChannelS: number
  /** The kit's price at Ko's shop (gold). */
  kitPrice: number
  /** A kit works within this distance of the segment (m, either side). */
  kitRangeM: number
}

export type WallFxKind = 'chip' | 'crack' | 'breach' | 'collapse' | 'repair'
export const WALL_FX_KINDS: readonly WallFxKind[] = ['chip', 'crack', 'breach', 'collapse', 'repair']

/** Server -> client (protocol v1, additive; docs/SIEGE.md §10.2). An older client ignores them. */
export type WallServerMessage =
  /** Every segment that is not intact at 100 %, on enter-world and on bulk changes (GM reset, restore). */
  | { t: 'walls'; segs: WallSegView[]; repair?: WallRepairTerms }
  /**
   * One segment changed stage or integrity (at most once a second per segment, stage changes at once). Layer 3:
   * `repairing` and `queued` as in WallSegView (absent = not repairing, nothing queued); a change of either alone also
   * sends an update.
   */
  | { t: 'wallUpdate'; id: string; stage: WallStage; pct: number; at: number; repairing?: true; queued?: number }
  /** A cosmetic moment at a point of segment `id` (dust, chips; layer 2 adds the collapse and the sounds). */
  | { t: 'wallFx'; id: string; kind: WallFxKind; x: number; y: number; z: number; at: number }

/** Wire limits (validate.ts). */
export const WALL_LIMITS = { segments: 64, coord: 1_000_000 } as const

// ---- settings (docs/SIEGE.md §11.2: the walls, wear and breach groups; the rest lands with later layers) ------------

export interface WallSettings {
  /** Integrity of a whole segment. */
  maxIp: number
  /** At or below this % the segment is cracked (above: intact). */
  crackedPct: number
  /** A breached segment closes again above this % (the hysteresis; going down it breaks at 0). */
  closePct: number
  /** The bottom of the scale (rubble), a negative %. */
  rubblePct: number
  /** A lightning strike on the wall walk takes [lo, hi] % (seeded by the strike). */
  lightningPct: [number, number]
  /** A tornado within `tornadoReachM` of a segment's outer face takes this % every 10 s. */
  tornadoPctPer10s: number
  tornadoReachM: number
  /** Lightning and tornado never take a segment below this % (never a breach). */
  naturalFloorPct: number
  /** Repair on its own (+% per 10 min), not during a siege. */
  naturalPctPer10Min: number
  /** Radius of a breach zone (m; centred 10 m inside the gap); during a siege `siegeZoneM`. */
  zoneM: number
  siegeZoneM: number
  // ---- layer 3, repair (docs/SIEGE.md §2.4, §11.2 'repair' and 'breach') ----
  /** A donation: gold per 1 %, or Stone Blocks per 1 %. */
  goldPerPct: number
  blocksPerPct: number
  /** Ko's builders apply donated work at this % per minute to every damaged segment at once. */
  builderPctPerMin: number
  /** Donated work queued on one segment is capped at this % (the excess beyond a full repair waits). */
  queueCapPct: number
  /** A Mason's Kit channel: +kitPct every kitChannelS, within kitRangeM of the segment; the kit costs kitPrice. */
  kitPct: number
  kitChannelS: number
  kitPrice: number
  kitRangeM: number
  /** Looters at every open gap outside a siege: this many Bandits, back this many minutes after a death. */
  looters: number
  looterRespawnMin: number
}

export const WALL_DEFAULTS: Readonly<WallSettings> = Object.freeze({
  maxIp: 20_000,
  crackedPct: 70,
  closePct: 5,
  rubblePct: -50,
  lightningPct: [3, 5] as [number, number],
  tornadoPctPer10s: 1,
  tornadoReachM: 120,
  naturalFloorPct: 35,
  naturalPctPer10Min: 1,
  zoneM: 50,
  siegeZoneM: 80,
  goldPerPct: 2000,
  blocksPerPct: 2,
  builderPctPerMin: 1,
  queueCapPct: 50,
  kitPct: 1,
  kitChannelS: 10,
  kitPrice: 1500,
  kitRangeM: 8,
  looters: 3,
  looterRespawnMin: 5,
})

type NumberKey = Exclude<keyof WallSettings, 'lightningPct'>

/** Inclusive bounds of each number (§11.2). */
export const WALL_BOUNDS: Readonly<Record<NumberKey | 'lightningPct', readonly [number, number]>> = {
  maxIp: [1_000, 200_000],
  crackedPct: [10, 95],
  closePct: [0, 30],
  rubblePct: [-100, -10],
  lightningPct: [0, 20],
  tornadoPctPer10s: [0, 10],
  tornadoReachM: [0, 300],
  naturalFloorPct: [0, 95],
  naturalPctPer10Min: [0, 10],
  zoneM: [0, 200],
  siegeZoneM: [0, 300],
  goldPerPct: [100, 100_000],
  blocksPerPct: [1, 20],
  builderPctPerMin: [0, 10],
  queueCapPct: [0, 150],
  kitPct: [0, 10],
  kitChannelS: [2, 60],
  kitPrice: [0, 100_000],
  kitRangeM: [2, 30],
  looters: [0, 10],
  looterRespawnMin: [1, 60],
}

/** Problems of a (partial) settings object: unknown keys, wrong types, numbers out of WALL_BOUNDS. */
export function checkWallSettings(v: unknown): string[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['walls settings must be an object']
  const out: string[] = []
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const b = (WALL_BOUNDS as Record<string, readonly [number, number]>)[k]
    if (!b) {
      out.push(`unknown setting ${k}`)
      continue
    }
    const values = k === 'lightningPct' ? (Array.isArray(raw) && raw.length === 2 ? raw : null) : [raw]
    if (!values) {
      out.push(`${k} must be [lo, hi]`)
      continue
    }
    for (const n of values) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < b[0] || n > b[1]) out.push(`${k} must be a number in ${b[0]}..${b[1]}`)
    }
    if (k === 'lightningPct' && out.length === 0 && (values[0] as number) > (values[1] as number)) out.push('lightningPct must be [lo, hi] with lo <= hi')
  }
  return out
}

/** The defaults with a checked patch on top (throws on a bad patch). */
export function wallSettings(patch?: unknown): WallSettings {
  const s: WallSettings = { ...WALL_DEFAULTS, lightningPct: [...WALL_DEFAULTS.lightningPct] }
  if (patch === undefined || patch === null) return s
  const problems = checkWallSettings(patch)
  if (problems.length) throw new Error(`walls settings: ${problems.join('; ')}`)
  return { ...s, ...(patch as Partial<WallSettings>) }
}

// ---- integrity and stages ----------------------------------------------------------------------------------------

const pctIp = (pct: number, s: Pick<WallSettings, 'maxIp'>) => Math.round((pct / 100) * s.maxIp)

/** The lowest integrity (rubble). */
export const rubbleIp = (s: Pick<WallSettings, 'maxIp' | 'rubblePct'>) => pctIp(s.rubblePct, s)

/** An integrity clamped to the scale [rubble, max] and rounded. */
export function clampIp(ip: number, s: Pick<WallSettings, 'maxIp' | 'rubblePct'>): number {
  if (!Number.isFinite(ip)) return s.maxIp
  return Math.max(rubbleIp(s), Math.min(s.maxIp, Math.round(ip)))
}

/** Breached or rubble: the wall has a gap. */
export const wallOpen = (stage: WallStage) => stage === 'breached' || stage === 'rubble'

/**
 * The stage of a segment at integrity `ip` (docs/SIEGE.md §2.2). Going down it breaks at 0; a segment that is open
 * (`prev` breached or rubble) closes only above `closePct` (the hysteresis, so a segment hovering at 0 does not flip
 * the nav every hit). Rubble is the very bottom of the scale; a rubble segment climbing back is breached again.
 */
export function wallStage(ip: number, s: Pick<WallSettings, 'maxIp' | 'crackedPct' | 'closePct' | 'rubblePct'>, prev?: WallStage): WallStage {
  if (ip <= rubbleIp(s)) return 'rubble'
  if (ip <= 0) return 'breached'
  if (prev && wallOpen(prev) && ip <= pctIp(s.closePct, s)) return 'breached'
  return ip > pctIp(s.crackedPct, s) ? 'intact' : 'cracked'
}

/** ip as a % of max, one decimal (what players see). */
export function wallPct(ip: number, s: Pick<WallSettings, 'maxIp'>): number {
  return Math.round((ip / s.maxIp) * 1000) / 10
}

/** The crack look of a closed segment: 0 none (> crackedPct), 1 cracked, 2 deep cracks (<= half of crackedPct). */
export function crackLevel(pct: number, s: Pick<WallSettings, 'crackedPct'> = WALL_DEFAULTS): 0 | 1 | 2 {
  if (pct > s.crackedPct) return 0
  return pct > s.crackedPct / 2 ? 1 : 2
}

/**
 * Natural wear (lightning, tornado): `dmg` ip taken off, never below the floor; a segment already at or below the
 * floor is not touched (so wear never repairs, and never breaches).
 */
export function wearIp(ip: number, dmg: number, s: Pick<WallSettings, 'maxIp' | 'naturalFloorPct'>): number {
  const floor = pctIp(s.naturalFloorPct, s)
  if (ip <= floor || !(dmg > 0)) return ip
  return Math.max(floor, ip - Math.round(dmg))
}

/** A lightning strike's wall damage (ip): lightningPct [lo, hi] at `u` in [0, 1) (seeded by the strike). */
export function lightningIp(u: number, s: Pick<WallSettings, 'maxIp' | 'lightningPct'>): number {
  const [lo, hi] = s.lightningPct
  const t = Math.min(1, Math.max(0, u))
  return pctIp(lo + (hi - lo) * t, s)
}

// ---- the export (packages/convert/src/world/siege/walls.ts writes it) -------------------------------------------

/** One third of a segment: its nav pieces and the tiles a gap there forces open. */
export interface WallsThird {
  /** `N1a`. */
  id: string
  /** Along the wall's axis (glTF m): x for N and S, z for W and E; from < to. */
  from: number
  to: number
  /** Nav instance ids (regionId << 16 | 0xF000 | n) of this third's collision pieces (walls-nav.bin). */
  instances: number[]
  /** Terrain tiles forced open while the third is down: [regionId, tz * 96 + tx]. */
  tiles: [number, number][]
  /** On the ground 2 m outside the outer face, at the third's middle (glTF m). */
  assault: Vec3
  /** On the ground 10 m inside the inner face, at the third's middle (glTF m). */
  rally: Vec3
}

export interface WallsSegment {
  id: string
  side: WallSide
  /** Along the axis (glTF m). */
  from: number
  to: number
  thirds: [WallsThird, WallsThird, WallsThird]
}

/** One side's geometry (glTF m). */
export interface WallsSideInfo {
  side: WallSide
  /** The axis the wall runs along. */
  axis: 'x' | 'z'
  /** The wall's centre line across the axis (z for N and S, x for W and E). */
  line: number
  /** Outer and inner face across the axis. */
  outer: number
  inner: number
  /** +1 / -1: outward along the cross axis (N: -1 (north is -z), S: +1, W: -1, E: +1). */
  out: 1 | -1
  /** Height of the wall walk (m), for lightning rods. */
  walkY: number
  /** The wall's retail placement (manifest: its glTF position) and nav instance id. */
  placement: { region: number; uid: number; source: string; position: Vec3 }
  retailInstance: number
  /**
   * The cut model (relative to the world manifest; Blender's cut of the retail glb): one node per piece, named by the
   * piece's id (a third `W3b`, a fixed span `W-gate`), in the retail model's own frame (place it like the retail
   * placement). Absent: not cut yet (the client keeps drawing the retail wall). `sidecar`: the retail model's sidecar.
   */
  glb?: string
  sidecar?: string
  /** The indestructible spans along the axis (gatehouse, corners, the ends). */
  fixed: { id: string; from: number; to: number; what: string; instances: number[] }[]
}

export interface WallsExport {
  version: 1
  world: string
  /** The plan it was cut from (content/siege/jangan.json) and its hash. */
  plan: { file: string; hash: string }
  /** The nav pieces (encodeNavData, no regions), relative to the world manifest. */
  navFile: string
  sides: WallsSideInfo[]
  segments: WallsSegment[]
}

/** Problems of a parsed walls.json (empty: usable). */
export function checkWallsExport(v: unknown): string[] {
  const out: string[] = []
  const w = v as Partial<WallsExport> | null
  if (!w || typeof w !== 'object') return ['walls.json must be an object']
  if (w.version !== 1) out.push('walls.json version must be 1')
  if (typeof w.navFile !== 'string' || !w.navFile || /(^|[\\/])\.\.([\\/]|$)/.test(w.navFile)) out.push('navFile must be a relative path')
  if (!Array.isArray(w.sides) || !Array.isArray(w.segments)) return [...out, 'sides and segments must be lists']
  const sides = new Set(w.sides.map(s => s?.side))
  const ids = new Set<string>()
  for (const s of w.segments) {
    if (!s || typeof s.id !== 'string' || !WALL_SEGMENT_ID.test(s.id)) {
      out.push(`bad segment id ${JSON.stringify(s?.id)}`)
      continue
    }
    if (ids.has(s.id)) out.push(`segment ${s.id} twice`)
    ids.add(s.id)
    if (!sides.has(s.side) || s.id[0] !== s.side) out.push(`segment ${s.id}: side ${s.side} unknown`)
    if (!(s.from < s.to)) out.push(`segment ${s.id}: from must be below to`)
    if (!Array.isArray(s.thirds) || s.thirds.length !== 3) {
      out.push(`segment ${s.id}: needs three thirds`)
      continue
    }
    s.thirds.forEach((t, k) => {
      if (t?.id !== `${s.id}${WALL_THIRDS[k]}`) out.push(`segment ${s.id}: third ${k} must be ${s.id}${WALL_THIRDS[k]}`)
      if (!Array.isArray(t?.instances) || !t.instances.every(n => Number.isInteger(n) && n >= 0)) out.push(`${t?.id}: bad instances`)
      if (!Array.isArray(t?.tiles) || !t.tiles.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isInteger(n) && n >= 0))) out.push(`${t?.id}: bad tiles`)
    })
  }
  return out
}

// ---- runtime nav (docs/SIEGE.md §4.2) ------------------------------------------------------------------------------

/** The thirds a stage takes down: breached the middle, rubble all three. */
export function thirdsDown(stage: WallStage): readonly number[] {
  return stage === 'rubble' ? [0, 1, 2] : stage === 'breached' ? [1] : []
}

export interface WallNav {
  /** Nav instance ids to switch off. */
  disabled: number[]
  /** Tiles to force open: [regionId, tile]. */
  open: [number, number][]
}

/**
 * The nav of a set of stages (one rule for the server and the client): the instances of every third that is down
 * are switched off and its tiles forced open; everything else is as exported. Segments missing from `stages` are
 * intact.
 */
export function wallNav(stages: ReadonlyMap<string, WallStage>, walls: Pick<WallsExport, 'segments'>): WallNav {
  const disabled: number[] = []
  const open: [number, number][] = []
  const seen = new Set<number>()
  for (const s of walls.segments) {
    const stage = stages.get(s.id)
    if (!stage) continue
    for (const k of thirdsDown(stage)) {
      const t = s.thirds[k]!
      disabled.push(...t.instances)
      for (const tile of t.tiles) {
        const key = tile[0] * 16384 + tile[1]
        if (seen.has(key)) continue
        seen.add(key)
        open.push([tile[0], tile[1]])
      }
    }
  }
  return { disabled, open }
}

// ---- breach zones (docs/SIEGE.md §2.5) -----------------------------------------------------------------------------

export interface BreachZone {
  seg: string
  x: number
  z: number
  r: number
}

/** Metres inside the gap's middle that a breach zone is centred on. */
export const BREACH_ZONE_INSET_M = 10

/**
 * The breach zones of the open segments: a circle of `zoneM` (`siegeZoneM` during a siege) centred 10 m inside the
 * gap's middle; a rubble gap (all three thirds) is three times as wide, so its circle grows by the extra half-width
 * (≈ 16 m) [decision, docs/SIEGE.md §2.2 "wider"].
 */
export function breachZones(
  stages: ReadonlyMap<string, WallStage>, walls: Pick<WallsExport, 'segments' | 'sides'>,
  s: Pick<WallSettings, 'zoneM' | 'siegeZoneM'>, siege = false,
): BreachZone[] {
  const out: BreachZone[] = []
  const sides = new Map(walls.sides.map(i => [i.side, i]))
  for (const seg of walls.segments) {
    const stage = stages.get(seg.id)
    if (!stage || !wallOpen(stage)) continue
    const side = sides.get(seg.side)
    if (!side) continue
    const b = seg.thirds[1]!
    const along = stage === 'rubble' ? (seg.from + seg.to) / 2 : (b.from + b.to) / 2
    const across = side.inner - side.out * BREACH_ZONE_INSET_M
    const base = siege ? s.siegeZoneM : s.zoneM
    if (!(base > 0)) continue
    const r = stage === 'rubble' ? base + ((seg.to - seg.from) - (b.to - b.from)) / 2 : base
    out.push(side.axis === 'x' ? { seg: seg.id, x: along, z: across, r } : { seg: seg.id, x: across, z: along, r })
  }
  return out
}

export function inBreachZone(zones: readonly BreachZone[], x: number, z: number): BreachZone | null {
  for (const b of zones) if ((x - b.x) ** 2 + (z - b.z) ** 2 <= b.r * b.r) return b
  return null
}

// ---- where things are --------------------------------------------------------------------------------------------

/**
 * The segment (and third index) a point on or at the wall belongs to: within `slackM` of the wall's body across the
 * axis and inside the segment's span along it; null over a gatehouse, a corner or away from the walls.
 */
export function segmentAt(walls: Pick<WallsExport, 'segments' | 'sides'>, x: number, z: number, slackM = 3): { seg: WallsSegment; third: number } | null {
  for (const side of walls.sides) {
    const along = side.axis === 'x' ? x : z
    const across = side.axis === 'x' ? z : x
    const lo = Math.min(side.outer, side.inner) - slackM
    const hi = Math.max(side.outer, side.inner) + slackM
    if (across < lo || across > hi) continue
    for (const seg of walls.segments) {
      if (seg.side !== side.side || along < seg.from || along > seg.to) continue
      const third = seg.thirds.findIndex(t => along >= t.from && along <= t.to)
      return { seg, third: third < 0 ? 1 : third }
    }
  }
  return null
}

/**
 * Shortest distance (m, XZ) from a point to a segment's outer face (the stretch of the face line over its span).
 */
export function outerFaceDistance(side: Pick<WallsSideInfo, 'axis' | 'outer'>, seg: Pick<WallsSegment, 'from' | 'to'>, x: number, z: number): number {
  const along = side.axis === 'x' ? x : z
  const across = side.axis === 'x' ? z : x
  const da = along < seg.from ? seg.from - along : along > seg.to ? along - seg.to : 0
  return Math.hypot(da, across - side.outer)
}

/** "the West wall (W3)". */
export function wallName(id: string): string {
  const side = id[0] as WallSide
  return `the ${WALL_SIDE_NAMES[side] ?? '?'} wall (${id})`
}

// ---- applying the nav (one class for the server's and the client's NavWorld) -----------------------------------------

/** The two NavWorld switches (packages/nav/src/world.ts), structurally. */
export interface WallNavTarget {
  setInstanceEnabled(index: number, on: boolean): boolean
  setTileOverride(regionId: number, tile: number, mode: 'open' | 'closed' | null): boolean
}

/**
 * Keeps a NavWorld in step with the wall stages: `apply` switches off the instances and forces open the tiles of every
 * third that is down (wallNav), and undoes what it set for a third that stands again; the rest of the world is never
 * touched. `indexOf` maps a piece's instance id to its index in that world (after the pieces were installed).
 */
export class WallNavState {
  private disabled = new Set<number>()
  private open = new Set<string>()

  constructor(private readonly walls: Pick<WallsExport, 'segments'>, private readonly indexOf: ReadonlyMap<number, number>) {}

  /** Applies the stages; returns how many switches changed (0: the nav was already so). */
  apply(target: WallNavTarget, stages: ReadonlyMap<string, WallStage>): number {
    const nav = wallNav(stages, this.walls)
    const wantOff = new Set<number>()
    for (const id of nav.disabled) {
      const i = this.indexOf.get(id >>> 0)
      if (i !== undefined) wantOff.add(i)
    }
    const wantOpen = new Map<string, [number, number]>(nav.open.map(t => [`${t[0]}:${t[1]}`, t]))
    let n = 0
    for (const i of this.disabled) if (!wantOff.has(i) && target.setInstanceEnabled(i, true)) n++
    for (const i of wantOff) if (!this.disabled.has(i) && target.setInstanceEnabled(i, false)) n++
    for (const k of this.open) {
      if (wantOpen.has(k)) continue
      const [r, t] = k.split(':').map(Number) as [number, number]
      if (target.setTileOverride(r, t, null)) n++
    }
    for (const [k, t] of wantOpen) if (!this.open.has(k) && target.setTileOverride(t[0], t[1], 'open')) n++
    this.disabled = wantOff
    this.open = new Set(wantOpen.keys())
    return n
  }
}

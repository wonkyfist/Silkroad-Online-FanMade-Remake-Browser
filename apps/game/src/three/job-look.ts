// The job system's looks (docs/JOBS.md §3.3, §10; layer 6), the pure part: how a job member in job mode is drawn.
// - Licensed Waterbender bodies (the standard, CHARACTERS.md §16.9): the worn outfit stays, its cloth takes the job's
//   palette (MAIN / SECOND from tier I, the trim from tier II, the D4-style twill and the metal trim at tier III) and an
//   emblem is sewn into the cloth (chest from tier I, back from tier II) with the job level as pips over it. No meshes:
//   the colours and the emblem go through the outfit strip and ClothDyePlugin (three/licensed-cloth.ts).
// - Retail bodies (`?newchar=0`, servers without the pack): the exported retail suits (`jobSuitCode`), REPLACE suits
//   instead of the armour, ADD ones (the flags, the identity cards) over it; without the suit rows the worn gear stays
//   and only the label shows the job.
// - The name plate's job line and the transport's goods bundles.
import { JOB_NAMES, jobLevelName, jobSuitCode, suitTier, type EquipSlot, type JobBadge, type JobId, type SuitTier } from '@sro/shared'
import type { DyeRegion, PaletteRow } from './licensed-outfit.ts'

/** A piece of a job member's outfit: the job and its level (1-7; the tier follows, suitTier). */
export interface JobDye {
  job: JobId
  level: number
}

export function jobDyeOf(b: JobBadge | null | undefined): JobDye | null {
  if (!b || !JOB_NAMES[b.job]) return null
  return { job: b.job, level: Math.max(1, Math.min(7, Math.floor(b.level) || 1)) }
}

// ---- palettes ---------------------------------------------------------------------------------------------------------

/** A tier's colours: MAIN and SECOND always, the trim from tier II (null: the gear's own trim stays). */
export interface JobTierColours {
  main: string
  second: string
  trim: string | null
}

/**
 * The job palettes (§3.3) per tier I / II / III [decision]: Trader gold-brown (gold trim at III), Bounty Hunter blue
 * (today's badge; silver trim at III), Thief black with red trim (soot-black trim at III over an oxblood cloth, so the
 * red still reads). Dark and saturated enough that the shade map's folds stay visible (never a white wash).
 */
export const JOB_PALETTES: Readonly<Record<JobId, readonly [JobTierColours, JobTierColours, JobTierColours]>> = {
  trader: [
    { main: '#a47634', second: '#5a3c20', trim: null },
    { main: '#b0802e', second: '#56391c', trim: '#d8aa4c' },
    { main: '#9c6a24', second: '#472c12', trim: '#f0c860' },
  ],
  hunter: [
    { main: '#355f9e', second: '#21324e', trim: null },
    { main: '#2e5ea8', second: '#1a2b4a', trim: '#86ace4' },
    { main: '#244c94', second: '#121c34', trim: '#d8dde6' },
  ],
  thief: [
    { main: '#2b282a', second: '#171416', trim: null },
    { main: '#262224', second: '#120f11', trim: '#b0222c' },
    { main: '#3a1418', second: '#0d0a0b', trim: '#2c2627' },
  ],
}

/** The gear's palette row with the job's colours over it (leather and the linen stay the gear's). */
export function jobPaletteRow(base: PaletteRow, dye: JobDye): PaletteRow {
  const c = JOB_PALETTES[dye.job][suitTier(dye.level) - 1]!
  return { ...base, main: c.main, second: c.second, trim: c.trim ?? base.trim } as Record<DyeRegion, string>
}

/** The job's cloth effects: a silk sheen on the job trim from tier II, the twill at tier III (§3.3). */
export function jobClothFx(fx: { sheen: number; weave: number }, dye: JobDye): { sheen: number; weave: number } {
  const t = suitTier(dye.level)
  return { sheen: t >= 2 ? Math.max(fx.sheen, 0.45) : fx.sheen, weave: t >= 3 ? Math.max(fx.weave, 0.7) : fx.weave }
}

/** The palette key's job part (`|j1l7`: job code, level): bodies of the same job and level share their materials. */
export function jobKey(dye: JobDye | null | undefined): string {
  return dye ? `|j${EMBLEM_JOB[dye.job]}l${dye.level}` : ''
}

// ---- the emblem -------------------------------------------------------------------------------------------------------

/** The emblem's job code in the strip (0: none). */
export const EMBLEM_JOB: Readonly<Record<JobId, 1 | 2 | 3>> = { trader: 1, hunter: 2, thief: 3 }

/**
 * Where the emblem sits on the body (bind pose, metres; x to the body's left, y up, z forward) [decision]: a badge
 * over the left breast (the centre line is a UV seam on both packs' tops; measured, work/tmp/jobs-looks/anchor.cjs)
 * and a crest between the shoulder blades. `yFrac` is the height inside the chest pieces' bounds.
 */
export const EMBLEM_SPOTS = {
  front: { x: -0.085, yFrac: 0.47, radius: 0.06 },
  back: { x: 0, yFrac: 0.5, radius: 0.085 },
} as const
export type EmblemSide = keyof typeof EMBLEM_SPOTS

/** The pieces that may carry the emblem (the outermost one at the spot shows it; the others are covered). */
export const EMBLEM_PIECES = ['TOP', 'LAYERING', 'FRONT_CLOTH', 'TAILS'] as const

/** The emblem on the front (tier I+) and on the back (tier II+). */
export function emblemSides(level: number): EmblemSide[] {
  return suitTier(level) >= 2 ? ['front', 'back'] : ['front']
}

/** A spot on a piece's UV: its uv and M, the 2×2 map from a uv offset to the body's (x, y) in metres (row-major). */
export interface EmblemAnchor {
  u: number
  v: number
  m: [number, number, number, number]
  /** The hit's depth toward the viewer side (the outermost layer wins). */
  z: number
}

/**
 * The anchor of a body point on one mesh (bind pose arrays as in the glb): the triangle hit by the ray along z at
 * (x, y) from the front (`dir` 1) or the back (−1), its uv there and the uv → metres map of that triangle. null: no
 * triangle covers the point, or a degenerate uv.
 */
export function emblemAnchor(pos: ArrayLike<number>, uv: ArrayLike<number>, idx: ArrayLike<number>, x: number, y: number, dir: 1 | -1): EmblemAnchor | null {
  let best: EmblemAnchor | null = null
  let bestZ = -Infinity
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!
    const ax = pos[a * 3]!, ay = pos[a * 3 + 1]!, bx = pos[b * 3]!, by = pos[b * 3 + 1]!, cx = pos[c * 3]!, cy = pos[c * 3 + 1]!
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (Math.abs(d) < 1e-12) continue
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d
    const l3 = 1 - l1 - l2
    if (l1 < 0 || l2 < 0 || l3 < 0) continue
    const z = (l1 * pos[a * 3 + 2]! + l2 * pos[b * 3 + 2]! + l3 * pos[c * 3 + 2]!) * dir
    if (z <= bestZ) continue
    const ua = uv[a * 2]!, va = uv[a * 2 + 1]!
    const f1u = uv[b * 2]! - ua, f1v = uv[b * 2 + 1]! - va, f2u = uv[c * 2]! - ua, f2v = uv[c * 2 + 1]! - va
    const det = f1u * f2v - f2u * f1v
    if (Math.abs(det) < 1e-12) continue
    // M = E · F⁻¹ (E: the edges in xy, F: the edges in uv)
    const i00 = f2v / det, i01 = -f2u / det, i10 = -f1v / det, i11 = f1u / det
    const e1x = bx - ax, e1y = by - ay, e2x = cx - ax, e2y = cy - ay
    bestZ = z
    best = {
      u: l1 * ua + l2 * uv[b * 2]! + l3 * uv[c * 2]!,
      v: l1 * va + l2 * uv[b * 2 + 1]! + l3 * uv[c * 2 + 1]!,
      m: [e1x * i00 + e2x * i10, e1x * i01 + e2x * i11, e1y * i00 + e2y * i10, e1y * i01 + e2y * i11],
      z,
    }
  }
  return best
}

/** The emblem's anchors per piece and side of one body (absent: the piece does not cover that spot). */
export type EmblemAnchors = Map<string, Partial<Record<EmblemSide, EmblemAnchor>>>

/** The range M's entries are stored in (|m| ≤ this, metres per uv unit). */
export const EMBLEM_M_RANGE = 8

/**
 * The emblem's strip columns of one piece row (STRIP_W ≥ EMBLEM_COL + 5, RGBA8): EMBLEM_COL the front uv (16 bits
 * each: hi, lo), +1 the front M (each entry (m / range + 1) / 2), +2 / +3 the back's, +4 the flags (job / 3, level / 7,
 * sides / 3: front 1, back 2). Columns of a side the piece has no anchor for stay 0.
 */
export const EMBLEM_COL = 7
export function writeEmblem(out: Uint8Array, anchors: Partial<Record<EmblemSide, EmblemAnchor>> | undefined, dye: JobDye | null | undefined): void {
  if (!dye || !anchors) return
  let sides = 0
  const u16 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 65535)
  const m8 = (v: number) => Math.round(255 * Math.max(0, Math.min(1, (v / EMBLEM_M_RANGE + 1) / 2)))
  for (const side of emblemSides(dye.level)) {
    const a = anchors[side]
    if (!a) continue
    const col = EMBLEM_COL + (side === 'front' ? 0 : 2)
    const u = u16(a.u), v = u16(a.v)
    out.set([u >> 8, u & 255, v >> 8, v & 255], col * 4)
    out.set(a.m.map(m8), (col + 1) * 4)
    sides |= side === 'front' ? 1 : 2
  }
  if (!sides) return
  const q = (v: number) => Math.round(255 * Math.max(0, Math.min(1, v)))
  out.set([q(EMBLEM_JOB[dye.job] / 3), q(dye.level / 7), q(sides / 3), 255], (EMBLEM_COL + 4) * 4)
}

/** Reads back writeEmblem's flags (tests, the bench). */
export function readEmblemFlags(row: Uint8Array): { job: number; level: number; sides: number } {
  const o = (EMBLEM_COL + 4) * 4
  return { job: Math.round((row[o]! / 255) * 3), level: Math.round((row[o + 1]! / 255) * 7), sides: Math.round((row[o + 2]! / 255) * 3) }
}

/**
 * The emblems' colours (sRGB): ground, rim, symbol, pips [decision]. Trader: a gold cash coin (the square hole) on a
 * dark rim; Bounty Hunter: a silver plate with a blue arrowhead; Thief: three black claw slashes on blood red. The
 * pips (one per job level, 1-7) arc over the emblem in the job's metal.
 */
export const EMBLEM_COLOURS: Readonly<Record<JobId, { ground: string; rim: string; symbol: string; pip: string }>> = {
  trader: { ground: '#e0aa3a', rim: '#3a240e', symbol: '#3a240e', pip: '#f2cc62' },
  hunter: { ground: '#dfe6ef', rim: '#14244a', symbol: '#2458b8', pip: '#dfe6ef' },
  thief: { ground: '#b31c26', rim: '#100c0d', symbol: '#100c0d', pip: '#d8343e' },
}

// ---- retail bodies ----------------------------------------------------------------------------------------------------

/** The armour slots a REPLACE suit takes over (the retail black suits and simple clothes are whole-body outfits). */
export const SUIT_REPLACES: readonly EquipSlot[] = ['head', 'chest', 'legs', 'shoulders', 'hands', 'feet']

/**
 * What a retail body wears in job mode: the suit for its job, tier and body; `method` is the suit's attach method from
 * the equipment manifest (undefined: the export has no such row). REPLACE: the armour slots are taken off and the suit
 * worn in the chest slot (the weapon, shield and accessories stay); ADD (the flags, the cards): the worn gear stays and
 * the suit comes over it (`extra`). No row: the worn gear, nothing else (the label alone shows the job, §3.3).
 */
export function retailSuitPlan(
  equip: Partial<Record<EquipSlot, string>> | undefined,
  dye: JobDye,
  body: 'm' | 'f',
  method: (code: string) => 'REPLACE' | 'ADD' | 'BASE' | undefined,
): { equip: Partial<Record<EquipSlot, string>>; extra: string[]; suit: string | null } {
  const suit = jobSuitCode(dye.job, suitTier(dye.level) as SuitTier, body)
  const m = method(suit)
  const worn = { ...(equip ?? {}) }
  if (!m) return { equip: worn, extra: [], suit: null }
  if (m === 'ADD') return { equip: worn, extra: [suit], suit }
  for (const s of SUIT_REPLACES) delete worn[s]
  worn.chest = suit
  return { equip: worn, extra: [], suit }
}

// ---- the name plate ---------------------------------------------------------------------------------------------------

/** The plate's job line: one label line per job (its colour and badge from CSS), the level's name in it. */
export function jobPlate(b: JobBadge | null | undefined, format: (job: string, level: string) => string): { key: string; text: string } | null {
  const d = jobDyeOf(b)
  if (!d) return null
  return { key: `job-${d.job}`, text: format(JOB_NAMES[d.job].toUpperCase(), jobLevelName(d.job, d.level)) }
}

/** Every job line key (a change of job clears the others). */
export const JOB_PLATE_KEYS: readonly string[] = (['trader', 'hunter', 'thief'] as const).map(j => `job-${j}`)

/** The plate colours (CSS): Trader gold, Bounty Hunter blue (the old badge's), Thief red. */
export const JOB_PLATE_COLOURS: Readonly<Record<JobId, string>> = { trader: '#f0c860', hunter: '#7ab8ff', thief: '#ff5a5a' }

// ---- transports -------------------------------------------------------------------------------------------------------

/** One goods bundle on a transport (metres in the model's bind space: x left, y up, z forward; scale of the bag). */
export interface BundleSpot {
  x: number
  y: number
  z: number
  yaw: number
  s: number
}

/**
 * Ten crates on a pack saddle whose top is at `y`, the bag scaled by `s` (the retail bag is a 0.18 m drop at scale 1:
 * its mesh node carries 0.3): a 2 × 2 layer, three over it, two, and one on the very top, so a full load is piled high.
 * The first one sits in the middle of the saddle (a light load is one small bundle, not a crate off to one side).
 */
function packSpots(y: number, z: number, s: number): BundleSpot[] {
  const h = 0.072 * s
  return [
    { x: 0, y, z, yaw: 0.1, s },
    { x: 0.14, y, z: z + 0.16, yaw: -0.15, s },
    { x: -0.14, y, z: z - 0.16, yaw: 0.2, s },
    { x: -0.14, y, z: z + 0.16, yaw: -0.05, s },
    { x: 0.14, y, z: z - 0.16, yaw: 0.15, s },
    { x: -0.08, y: y + h, z: z - 0.1, yaw: 0.6, s: s * 0.95 },
    { x: 0.09, y: y + h, z: z + 0.08, yaw: -0.3, s: s * 0.95 },
    { x: -0.04, y: y + h * 2, z: z - 0.04, yaw: -0.4, s: s * 0.88 },
    { x: 0.05, y: y + h * 2, z: z + 0.1, yaw: 0.5, s: s * 0.85 },
    { x: 0.01, y: y + h * 3, z: z + 0.02, yaw: 0.9, s: s * 0.8 },
  ]
}

/**
 * Where the goods ride on each transport (the retail pack animals already carry their side bags; the load's crates,
 * the retail goods bag `drop_trade`, pile on the pack saddle) [decision]: model space of the cos glb (x left, y up, z
 * forward; the saddle tops measured on the exported glbs, work/tmp/jobs-looks/bones.cjs), followed through the pelvis
 * joint. Filled in order: the first ones low on the saddle, the last stacked on top.
 */
export const TRANSPORT_LOAD: Readonly<Record<string, { bone: string; spots: readonly BundleSpot[] }>> = {
  COS_T_DONKEY: { bone: 'Bip01 Pelvis', spots: packSpots(1.76, -0.52, 1.7) },
  COS_T_HORSE1: { bone: 'Bip01 Pelvis', spots: packSpots(1.82, -0.52, 1.7) },
  COS_T_HORSE2: { bone: 'Bip01 Pelvis', spots: packSpots(1.82, -0.52, 1.7) },
  COS_T_DHORSE1: { bone: 'Bip01 Pelvis', spots: packSpots(1.96, -0.45, 1.8) },
}

/**
 * Bundles shown per stars 0-5 (of the ten spots) and their size: a light load is one small bundle in the middle of the
 * saddle, a full one ten big ones piled three high [decision; "Polish status": a 1-star and a 5-star load must read
 * apart at a glance, the stars over the name say the rest].
 */
export const LOAD_BUNDLES: readonly number[] = [0, 1, 3, 5, 7, 10]
export const LOAD_SCALE: readonly number[] = [0, 0.62, 0.74, 0.86, 0.96, 1.08]

/** How many bundles a load of `stars` shows on a transport with `spots` places (0 stars: none; 5 stars: all). */
export function bundleCount(stars: number, spots: number): number {
  const s = Math.max(0, Math.min(5, Math.floor(stars)))
  if (s === 0 || spots <= 0) return 0
  return Math.max(1, Math.min(spots, Math.round((spots * LOAD_BUNDLES[s]!) / 10)))
}

/** The bundles' size for a load of `stars` (× the spot's own scale). */
export function bundleScale(stars: number): number {
  return LOAD_SCALE[Math.max(0, Math.min(5, Math.floor(stars)))]!
}

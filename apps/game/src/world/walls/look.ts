/**
 * Siege of Jangan, layer 2 (docs/SIEGE.md §2.2, §9.2): what a segment looks like, as a pure function of what the server
 * says about it, and what a change of look sets off. No Babylon here (view.ts draws it; tests read it).
 *
 * - **Thirds**: breached takes the middle third down, rubble all three (shared `thirdsDown`).
 * - **Cracks** per standing third: 0 none, 1 cracked (≤ crackedPct), 2 deep (≤ half of it). A third standing beside a
 *   gap is always deep-cracked (the broken end of a breach).
 * - **Piles**: a rubble pile lies where a third is down.
 * - **Scaffold** over the standing thirds while builders or a kit work (`repairing`), and over `a` / `c` of a rubble
 *   segment climbing back (`scaffold`); the hammer is heard only while `repairing`.
 * - **Tiers**: Low draws about half the stone and dust, one scaffold face, a short collapse; Medium and up the full look.
 */
import { WALL_DEFAULTS, crackLevel, thirdsDown, type WallFxKind, type WallSettings, type WallStage } from '@sro/shared'

export type WallTier = 'low' | 'medium' | 'high'

/** The graphics tier of a render preset (Low cheaper; Ultra draws as High). */
export function wallTierFor(preset: string): WallTier {
  return preset === 'low' ? 'low' : preset === 'medium' ? 'medium' : 'high'
}

/** What the client knows of a segment. */
export interface WallLookInput {
  stage: WallStage
  pct: number
  /** A rubble segment climbing back (server `scaffold`, or seen live: rubble → breached). */
  scaffold?: boolean
  /** Builders or a Mason's Kit at work now (layer 3, WallSegView.repairing). */
  repairing?: boolean
}

export type Crack = 0 | 1 | 2
type Three<T> = [T, T, T]

export interface WallLook {
  /** Per third: down (hidden, a pile in its place). */
  down: Three<boolean>
  /** Per third: crack level of the standing stone (0 for a third that is down). */
  crack: Three<Crack>
  /** Per third: scaffolding on its faces. */
  scaffold: Three<boolean>
  /** Hammer strokes from the segment (repair under way). */
  hammer: boolean
}

export const INTACT_LOOK: Readonly<WallLook> = Object.freeze({
  down: [false, false, false] as Three<boolean>,
  crack: [0, 0, 0] as Three<Crack>,
  scaffold: [false, false, false] as Three<boolean>,
  hammer: false,
})

/** The look of a segment (docs/SIEGE.md §2.2 table, §9.2). */
export function wallLook(v: WallLookInput, s: Pick<WallSettings, 'crackedPct'> = WALL_DEFAULTS): WallLook {
  const downList = thirdsDown(v.stage)
  const down: Three<boolean> = [downList.includes(0), downList.includes(1), downList.includes(2)]
  const base: Crack = v.stage === 'cracked' || v.stage === 'intact' ? crackLevel(v.pct, s) : 2
  const crack = down.map((d, k) => {
    if (d) return 0
    // the ends of a gap are broken stone, whatever the integrity says
    const besideGap = (k > 0 && down[k - 1]) || (k < 2 && down[k + 1])
    return besideGap ? 2 : base
  }) as Three<Crack>
  const climbing = !!v.scaffold && v.stage === 'breached'
  const working = !!v.repairing && v.stage !== 'rubble'
  const scaffold = down.map((d) => !d && (climbing || working)) as Three<boolean>
  return { down, crack, scaffold, hammer: !!v.repairing }
}

export function sameLook(a: WallLook | undefined, b: WallLook): boolean {
  if (!a) return false
  for (let k = 0; k < 3; k++) {
    if (a.down[k] !== b.down[k] || a.crack[k] !== b.crack[k] || a.scaffold[k] !== b.scaffold[k]) return false
  }
  return a.hammer === b.hammer
}

/** What a change of look sets off: the thirds that fall (collapse animation) and those that stand again. */
export function lookChange(before: WallLook | undefined, after: WallLook): { fall: number[]; rise: number[] } {
  const fall: number[] = []
  const rise: number[] = []
  const b = before ?? INTACT_LOOK
  for (let k = 0; k < 3; k++) {
    if (!b.down[k] && after.down[k]) fall.push(k)
    else if (b.down[k] && !after.down[k]) rise.push(k)
  }
  return { fall, rise }
}

/**
 * The client's own scaffold flag for a segment (the server sends `scaffold` only with `walls`): set when a rubble
 * segment climbs back to breached, kept while it stays open, cleared once it closes or falls again.
 */
export function nextScaffold(prev: boolean, before: WallStage | undefined, after: WallStage): boolean {
  if (after !== 'breached') return false
  return prev || before === 'rubble'
}

// ---- amounts per tier ----------------------------------------------------------------------------------------------

export interface WallTierTable {
  /** Stone chunks in the pile of one downed third (≈ 16 m of wall). */
  pileChunks: number
  /** Broken teeth on a standing third's end beside a gap. */
  teeth: number
  /** Chunks that fly from a chip (lightning, a hit) and from a crack burst. */
  chipChunks: number
  crackChunks: number
  /** Small bits thrown out while a third falls (they vanish), besides the pile's own chunks. */
  collapseBits: number
  /** Dust particles: a chip, a crack, a third falling. */
  dust: { chip: number; crack: number; fall: number }
  /** Crack decals per standing third at levels 1 and 2 (outer face, inner face). */
  decals: [[number, number], [number, number]]
  /** Scaffold on both faces (false: the outer face only). */
  bothFaces: boolean
  /** Mound grid cells along and across one third. */
  mound: [number, number]
  /** Live chunks the debris pool can hold per side at once (chips, falling stone). */
  bitsCap: number
}

export const WALL_TIERS: Readonly<Record<WallTier, WallTierTable>> = {
  low: { pileChunks: 60, teeth: 8, chipChunks: 3, crackChunks: 6, collapseBits: 8, dust: { chip: 3, crack: 10, fall: 70 }, decals: [[1, 1], [2, 1]], bothFaces: false, mound: [12, 10], bitsCap: 48 },
  medium: { pileChunks: 130, teeth: 16, chipChunks: 7, crackChunks: 12, collapseBits: 24, dust: { chip: 6, crack: 24, fall: 180 }, decals: [[2, 1], [3, 2]], bothFaces: true, mound: [20, 16], bitsCap: 128 },
  high: { pileChunks: 170, teeth: 22, chipChunks: 9, crackChunks: 16, collapseBits: 36, dust: { chip: 8, crack: 32, fall: 230 }, decals: [[2, 1], [4, 2]], bothFaces: true, mound: [26, 20], bitsCap: 192 },
}

// ---- timing of the collapse (docs/SIEGE.md §9.2: a 2.5 s fall, dust 8 s) --------------------------------------------

export const COLLAPSE = {
  /** Gravity (m/s²) of falling stone, and the bounce kept on the first ground contact. */
  gravity: 9.8,
  bounce: 0.22,
  /** A chunk starts falling within this spread (s): the face peels from the top down. */
  stagger: 1.1,
  /** The mound rises under the dust over this long (s). */
  moundRise: 2.2,
  /** Camera shake within this distance (m), for this long (s), at this amplitude (screen offset units). */
  shakeM: 150,
  shakeS: 0.45,
  shakeAmp: 0.06,
} as const

// ---- sound (docs/SIEGE.md §9.4; cues: packages/shared/src/sound.ts SIEGE_CUES) --------------------------------------

export interface WallSoundStep {
  cue: string
  /** Seconds after the moment. */
  at: number
  gain: number
}

/** The cues of a wall moment, in order. */
export function wallSounds(kind: WallFxKind): WallSoundStep[] {
  switch (kind) {
    case 'chip':
      return [{ cue: 'siege.wall.chip', at: 0, gain: 0.7 }]
    case 'crack':
      return [{ cue: 'siege.wall.chip', at: 0, gain: 1 }, { cue: 'siege.stone.fall', at: 0.35, gain: 0.7 }]
    case 'breach':
      return [
        { cue: 'siege.wall.blast', at: 0, gain: 1 },
        { cue: 'siege.wall.collapse', at: 0.15, gain: 1 },
        { cue: 'siege.stone.fall', at: 1.0, gain: 0.9 },
        { cue: 'siege.stone.fall', at: 1.7, gain: 0.8 },
        { cue: 'siege.bell', at: 2.5, gain: 0.9 },
      ]
    case 'collapse':
      return [
        { cue: 'siege.wall.collapse', at: 0, gain: 1 },
        { cue: 'siege.stone.fall', at: 0.8, gain: 1 },
        { cue: 'siege.wall.collapse', at: 1.1, gain: 0.7 },
        { cue: 'siege.stone.fall', at: 1.6, gain: 0.9 },
        { cue: 'siege.stone.fall', at: 2.3, gain: 0.8 },
        { cue: 'siege.bell', at: 3, gain: 0.9 },
      ]
    case 'repair':
      return [{ cue: 'siege.repair', at: 0, gain: 1 }]
  }
}

/** How far each cue carries (m): full within `near`, a long roll-off to 0 at `range`. */
export const WALL_SOUND_RANGE: Readonly<Record<string, { near: number; range: number }>> = {
  'siege.wall.chip': { near: 15, range: 180 },
  'siege.wall.collapse': { near: 40, range: 750 },
  'siege.wall.blast': { near: 40, range: 750 },
  'siege.keg.blast': { near: 40, range: 750 },
  'siege.stone.fall': { near: 20, range: 260 },
  'siege.bell': { near: 80, range: 900 },
  'siege.repair': { near: 10, range: 90 },
}

/** A cue's gain at `d` metres: 1 within `near`, then near / d (a long inverse roll-off), 0 beyond `range`. */
export function wallSoundGain(cue: string, d: number): number {
  const r = WALL_SOUND_RANGE[cue] ?? { near: 15, range: 150 }
  if (d > r.range) return 0
  const g = d <= r.near ? 1 : r.near / d
  // fade the last 20 % of the range so nothing stops on a cliff
  const edge = Math.min(1, (r.range - d) / (0.2 * r.range))
  return g * edge
}

/** Hammer strokes while repairing: one every [lo, hi] s, heard within the repair range. */
export const HAMMER_EVERY_S: readonly [number, number] = [2, 4]

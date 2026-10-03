/**
 * The town's sound (docs/TOWN_LIFE.md §6; docs/WAVE_PLAN7.md lane TL-S), inside docs/SOUND.md's system:
 *
 * - **The bed**: the crowd murmur, distant steps and carts (packages/convert/src/sound/town-synth.ts: `town/bed_calm`
 *   and `town/bed_busy`), as its own loop voices at the listener beside the area loop (as the coast's surf runs beside
 *   it). Its gain is `smoothstep(0, 25, folk within 30 m)`, cross-faded over 1.5 s, the calm loop handing over to the
 *   busy one as the count grows (the sum stays monotone in the count); at night it is silent below 5 folk. The count
 *   comes from a folk counter (the pure schedule's `populationNear` when the app plugs it in, `setFolkCounter`), else
 *   from `estimateFolkNear` over the town file's districts and hour bands, so it plays on every preset, Low included
 *   (no `World.town` there: WAVE_PLAN7 D23).
 * - **The temple bell** (retail `env/bell towel 3.wav`): once on every game hour of the server clock (`clockT` when the
 *   app has the clock, so Low's frozen-noon sky still rings it: H11 S1; else the sky's solar time) crossing h/24, moving
 *   forward by less than an hour: a clock jump never rings), three strokes at 06:00 and 18:00. Heard over the whole town
 *   with a long roll-off (`bellGain`): the voice is placed on the line to the tower at the distance the panner turns
 *   into that gain, so it still comes from the temple.
 * - **Life and work**: the vendors' murmurs (with each call, ≤ 20 m), the smith's hammer (≤ 30 m), horses at the
 *   stable, chickens, dogs (the pet wolf pitched up) and the cat, the pigeons' wing claps, the fountain's splash loop
 *   (≤ 25 m). Until the crowd sends its events (`vendorCall`, `hammerHit`, `animal`; `setExternal`), each spot plays on
 *   its own schedule: a pure function of the server clock and the spot, so friends hear the same hammer.
 * - **Night** (20:00–05:00 solar, in town): the area's day birds are muted and the retail night layers of the town
 *   area (insects, night birds) play instead. With the Low guard's frozen noon it is never night: nothing changes.
 *
 * Voices: at most TOWN_ONESHOT_CAP town one-shots at a time inside the ambient bus's 5 (the bell may add one), and at
 * most 3 loops (2 bed, 1 fountain). Pure: the clock, the files and the voices come in through the output and `update`.
 */
import type { AmbientLayer } from '@sro/shared'
import type { Vec3Like, VoiceHandle } from './backend.ts'

// ---- numbers ------------------------------------------------------------------------------------------------------

/** The bed hears folk within this radius (m) … */
export const BED_RADIUS_M = 30
/** … and is full at this many. */
export const BED_FULL_FOLK = 25
/** At night the bed is silent below this many folk. */
export const BED_NIGHT_MIN_FOLK = 5
/** The busy loop takes over between these counts. */
export const BED_BUSY_FROM = 6
export const BED_BUSY_TO = 22
/** The bed loops' voice gain at full count. */
export const BED_GAIN = 0.9
/** Cross-fade of the bed's gain changes (s). */
export const BED_FADE_S = 1.5
/** The folk count is taken this often (s). */
export const COUNT_PERIOD_S = 0.5
/** Town one-shots at most at a time (the ambient bus has 5 one-shot voices: SOUND §5.5). */
export const TOWN_ONESHOT_CAP = 3
/** The bell: strokes apart (s), its range (m) and roll-off distance (m). */
export const BELL_STROKE_S = 3.2
export const BELL_RANGE_M = 450
export const BELL_ROLLOFF_M = 60
export const BELL_GAIN = 1
/** The fountain loop starts within FOUNTAIN_ON_M and stops beyond FOUNTAIN_OFF_M. */
export const FOUNTAIN_ON_M = 25
export const FOUNTAIN_OFF_M = 32
export const FOUNTAIN_GAIN = 1.4
/** A clock step longer than this (s) skips the scheduled spots (the first frame, a tab back from the background). */
const MAX_STEP_S = 2
/** The panner's distance model (backend.ts PANNER): gain = 3 / (3 + 1.2 (d − 3)). */
const PANNER_REF_M = 3
const PANNER_ROLLOFF = 1.2
/** Ears above the feet (index.ts LISTENER_HEIGHT_M). */
const HEAD_M = 1.6

/** Night in town: the solar hours [from, to) wrapping midnight. */
export const NIGHT_FROM_H = 20
export const NIGHT_TO_H = 5

/** The cue names (sound index; packages/convert/src/sound/build.ts TOWN_CUES and sound/town-synth.ts). */
export const TOWN_SOUND_CUES = {
  bell: 'town.bell',
  bedCalm: 'town.bed.calm',
  bedBusy: 'town.bed.busy',
  fountain: 'town.fountain',
  murmur: 'town.murmur',
  hammer: 'town.hammer',
  horse: 'town.horse.snort',
  chicken: 'town.chicken',
  dog: ['town.dog.pitched', 'town.dog'],
  cat: 'town.cat',
  donkey: 'town.donkey',
  cow: 'town.cow',
  wings: 'town.wings',
} as const

/** The animals the crowd may sound (`animal`). */
export type TownAnimal = 'horse' | 'chicken' | 'dog' | 'cat' | 'donkey' | 'cow'

/** A spot's schedule: every everyS[0]..everyS[1] s, between solar hours [from, to) (wrapping), heard within cullM. */
interface SpotRule {
  everyS: readonly [number, number]
  hours?: readonly [number, number]
  cullM: number
  gain: number
}

export const SPOT_RULES = {
  stall: { everyS: [12, 25], hours: [7, 18], cullM: 20, gain: 0.7 },
  horse: { everyS: [20, 60], cullM: 30, gain: 0.8 },
  chicken: { everyS: [8, 30], hours: [5, 20], cullM: 20, gain: 0.6 },
  dog: { everyS: [15, 40], cullM: 20, gain: 0.5 },
  cat: { everyS: [45, 120], cullM: 20, gain: 0.7 },
} as const satisfies Record<string, SpotRule>

/**
 * The smith works from dawn to dusk: bursts of strokes, then a rest. The hours are the anvil worker's in Jangan's town
 * file (06:00–20:00; H11 S6), and a town file's HAMMER worker overrides them (townSoundFromFile).
 */
export const HAMMER = { hours: [6, 20] as const, cycleS: 14, strokeS: 0.85, cullM: 30, gain: 0.8 }
/** Event-driven sounds' culls (m). */
export const EVENT_CULL_M = { murmur: 20, hammer: 30, animal: 20, wings: 25 } as const

// ---- the town's spots and population --------------------------------------------------------------------------------

/** Where the town's sounds come from (glTF metres, world manifest frame). */
export interface TownSoundSpots {
  /** The temple's bell tower. */
  bell: Vec3Like
  fountain: Vec3Like | null
  stalls: Vec3Like[]
  anvils: Vec3Like[]
  stables: Vec3Like[]
  coops: Vec3Like[]
  dogs: Vec3Like[]
  cats: Vec3Like[]
  /** The smith's working hours (default HAMMER.hours). */
  hammerHours?: readonly [number, number]
}

/**
 * Jangan's spots from the jangan-fields manifest [confirmed]: the bell tower `cj5_tem_tower` (258, −307) [decision: the
 * tower, not the main hall (259, −351), as the bell hangs there], the dragon fountain `cj_wf_dr` (97, −80), the three
 * `cj_streetstall`, the smithy `cj_weapon` (14, −146), the stable `cj_stab` (25, −46), the chickens' yard (165, −155);
 * the dogs at the plaza and the west street, the cat by the tea tables [decision]. H11 S5: the dogs and the cat are where
 * the town part draws them (world-render town/index.ts plazaStandIn: the resting dog at (130, −82), the owner's dog on
 * the plaza, the cat's sitting spots round the plaza), so a bark or a meow comes from a drawn animal; on Low (none drawn)
 * they are simply the plaza's.
 */
export const JANGAN_SOUND_SPOTS: TownSoundSpots = {
  bell: { x: 258, y: 14, z: -307 },
  fountain: { x: 97, y: 2, z: -80 },
  stalls: [{ x: -31, y: 3, z: -57 }, { x: -93, y: 1, z: -164 }, { x: 316, y: 1, z: -171 }],
  anvils: [{ x: 16, y: 1, z: -140 }],
  stables: [{ x: 25, y: 2, z: -46 }],
  coops: [{ x: 166, y: 1, z: -156 }],
  dogs: [{ x: 84, y: 1, z: -118 }, { x: 130, y: 1, z: -82 }],
  cats: [{ x: 112, y: 1, z: -80 }],
}

/** The roaming population for the bed's fallback count (the town file's `folk` and `schedule` shapes). */
export interface TownPopulation {
  /** Roaming folk at the day peak. */
  population: number
  districts: ReadonlyArray<{ x: number; z: number; radius: number; weight: number }>
  bands: ReadonlyArray<{ from: number; to: number; share: number }>
}

/** TOWN_LIFE §3.5's hour curve, and Jangan's districts with the plaza holding about 40 % [decision: fallback numbers]. */
export const JANGAN_POPULATION: TownPopulation = {
  population: 180,
  districts: [
    { x: 97, z: -110, radius: 60, weight: 4 },
    { x: -55, z: -60, radius: 55, weight: 2 },
    { x: -140, z: -100, radius: 40, weight: 1 },
    { x: 20, z: -110, radius: 45, weight: 1 },
    { x: 220, z: -170, radius: 60, weight: 1.5 },
    { x: 260, z: -290, radius: 45, weight: 0.5 },
  ],
  bands: [
    { from: 5, to: 7, share: 0.25 },
    { from: 7, to: 18, share: 1 },
    { from: 18, to: 20, share: 0.6 },
    { from: 20, to: 23, share: 0.25 },
    { from: 23, to: 5, share: 0.08 },
  ],
}

/** The shape of a town file the audio reads (packages/shared town.ts TownFile; only these fields). */
export interface TownFileLike {
  places?: ReadonlyArray<{ kind: string; x: number; z: number }>
  folk?: {
    population?: number
    districts?: ReadonlyArray<{ x: number; z: number; radius: number; weight: number }>
    fixed?: ReadonlyArray<{ clip?: string; hours?: readonly [number, number] }>
  }
  schedule?: { bands?: ReadonlyArray<{ from: number; to: number; share: number }> }
}

/**
 * The spots and population of a town file (TL-R's `town.json`): stalls, anvils, stables and the fountain rim from its
 * places, the population from its folk and bands; whatever the file lacks keeps the defaults.
 */
export function townSoundFromFile(file: TownFileLike, base: { spots: TownSoundSpots; pop: TownPopulation } = { spots: JANGAN_SOUND_SPOTS, pop: JANGAN_POPULATION }): { spots: TownSoundSpots; pop: TownPopulation } {
  const places = file.places ?? []
  const at = (kind: string, y: number) => places.filter(p => p.kind === kind && Number.isFinite(p.x) && Number.isFinite(p.z)).map(p => ({ x: p.x, y, z: p.z }))
  const rim = at('fountainRim', 2)
  const hammer = file.folk?.fixed?.find(f => f.clip === 'HAMMER' && f.hours)?.hours
  const spots: TownSoundSpots = {
    ...base.spots,
    stalls: at('stall', 2).length ? at('stall', 2) : base.spots.stalls,
    anvils: at('smithAnvil', 1).length ? at('smithAnvil', 1) : base.spots.anvils,
    stables: at('stable', 2).length ? at('stable', 2) : base.spots.stables,
    fountain: rim.length ? { x: rim.reduce((s, p) => s + p.x, 0) / rim.length, y: 2, z: rim.reduce((s, p) => s + p.z, 0) / rim.length } : base.spots.fountain,
    ...(hammer ? { hammerHours: [hammer[0], hammer[1]] as const } : {}),
  }
  const pop: TownPopulation = {
    population: file.folk?.population && file.folk.population > 0 ? file.folk.population : base.pop.population,
    districts: file.folk?.districts?.length ? file.folk.districts : base.pop.districts,
    bands: file.schedule?.bands?.length ? file.schedule.bands : base.pop.bands,
  }
  return { spots, pop }
}

// ---- pure helpers -------------------------------------------------------------------------------------------------

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** True when solar hour `h` lies in [from, to), wrapping past midnight when from > to. */
export function inHours(h: number, from: number, to: number): boolean {
  return from <= to ? h >= from && h < to : h >= from || h < to
}

/** The solar hour 0..24 of solar time `t` (0 = midnight, 0.5 = noon). */
export const solarHour = (t: number): number => (((t % 1) + 1) % 1) * 24

export const isNight = (t: number): boolean => inHours(solarHour(t), NIGHT_FROM_H, NIGHT_TO_H)

/** The share of the population out at solar time `t` (the band holding its hour; 0 when none does). */
export function populationShare(bands: TownPopulation['bands'], t: number): number {
  const h = solarHour(t)
  return bands.find(b => inHours(h, b.from, b.to))?.share ?? 0
}

/** The area of the intersection of two circles with centres `d` apart. */
export function circleOverlap(d: number, r1: number, r2: number): number {
  if (d >= r1 + r2) return 0
  const lo = Math.min(r1, r2)
  if (d <= Math.abs(r1 - r2)) return Math.PI * lo * lo
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1))
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2))
  const c = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2))
  return a + b - c
}

/**
 * The folk expected within `r` of (x, z) at solar time `t`: each district's share of the out population spread evenly
 * over its circle (the bed's count without the pure schedule).
 */
export function estimateFolkNear(pop: TownPopulation, x: number, z: number, r: number, t: number): number {
  const out = pop.population * populationShare(pop.bands, t)
  const total = pop.districts.reduce((s, d) => s + Math.max(0, d.weight), 0)
  if (out <= 0 || total <= 0) return 0
  let n = 0
  for (const d of pop.districts) {
    if (d.weight <= 0 || d.radius <= 0) continue
    const folk = (out * d.weight) / total
    n += (folk * circleOverlap(Math.hypot(x - d.x, z - d.z), d.radius, r)) / (Math.PI * d.radius * d.radius)
  }
  return n
}

/** The two bed loops' gains (0..1 before BED_GAIN) for `folk` near; their sum is monotone in `folk`. */
export function bedGains(folk: number, night: boolean): { calm: number; busy: number } {
  if (!(folk > 0) || (night && folk < BED_NIGHT_MIN_FOLK)) return { calm: 0, busy: 0 }
  const g = smoothstep(0, BED_FULL_FOLK, folk)
  const m = smoothstep(BED_BUSY_FROM, BED_BUSY_TO, folk)
  return { calm: g * (1 - m), busy: g * m }
}

/** Strokes of the bell at solar hour `hour` (0..23): three at 06:00 and 18:00, else one. */
export const bellStrokes = (hour: number): number => (hour === 6 || hour === 18 ? 3 : 1)

/**
 * The game hour the solar time just struck going from `prev` to `t` (0..23), or null: no boundary crossed, or a jump
 * (backwards, or forward by an hour or more: a clock restart, a GM `/time`).
 */
export function hourStruck(prev: number, t: number): number | null {
  if (!Number.isFinite(prev) || !Number.isFinite(t)) return null
  const step = (((t - prev) % 1) + 1) % 1
  if (step <= 0 || step >= 1 / 24) return null
  const a = Math.floor(solarHour(prev)), b = Math.floor(solarHour(t))
  return a === b ? null : b
}

/** The bell's gain at `d` metres (long roll-off; 0 beyond BELL_RANGE_M). */
export const bellGain = (d: number): number => (d > BELL_RANGE_M ? 0 : BELL_ROLLOFF_M / (BELL_ROLLOFF_M + Math.max(0, d)))

/** The distance at which the backend's panner gives gain `g` (≤ d: the voice never moves away). */
export function pannerDistanceFor(g: number, d: number): number {
  if (g >= 1) return Math.min(d, PANNER_REF_M)
  return Math.min(d, PANNER_REF_M + (PANNER_REF_M / Math.max(1e-3, g) - PANNER_REF_M) / PANNER_ROLLOFF)
}

/** A hash in [0, 1) of a spot id and an integer (the shared, stateless schedules). */
export function hash01(id: string, k: number): number {
  let h = 0x811c9dc5 ^ (k | 0)
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

/**
 * The times in (fromS, toS] (server seconds) at which spot `id` sounds, every `everyS` on average: one event per slot
 * of the mean period, at a hashed point of the slot. The same on every client.
 */
export function spotEvents(id: string, everyS: readonly [number, number], fromS: number, toS: number): number[] {
  const slot = (everyS[0] + everyS[1]) / 2
  const spread = Math.max(0, Math.min(1, (everyS[1] - everyS[0]) / slot))
  const out: number[] = []
  for (let k = Math.floor(fromS / slot); k <= Math.floor(toS / slot); k++) {
    const at = k * slot + slot * (0.5 - spread / 2 + spread * hash01(id, k))
    if (at > fromS && at <= toS) out.push(at)
  }
  return out
}

/** The hammer strokes in (fromS, toS]: per cycle a burst of 3–6 strokes, then a rest. */
export function hammerEvents(id: string, fromS: number, toS: number): number[] {
  const out: number[] = []
  for (let k = Math.floor(fromS / HAMMER.cycleS); k <= Math.floor(toS / HAMMER.cycleS); k++) {
    const n = 3 + Math.floor(hash01(id, k) * 4)
    const start = k * HAMMER.cycleS + 1 + 3 * hash01(id, k + 7919)
    for (let i = 0; i < n; i++) {
      const at = start + i * HAMMER.strokeS * (1 + 0.06 * (hash01(id, k * 8 + i) - 0.5))
      if (at > fromS && at <= toS) out.push(at)
    }
  }
  return out
}

// ---- the player ----------------------------------------------------------------------------------------------------

/** What TownAudio plays through (GameAudio in the game; a fake in tests). */
export interface TownAudioOutput {
  /** The files of a cue ([] when the index lacks it). */
  files(cue: string): readonly string[]
  /** A file's length in ms (for the one-shot budget; 0 when unknown). */
  ms(file: string): number
  /** A looped positional voice on the ambient bus; null when it cannot start yet. */
  loopAt(file: string, o: { pos: Vec3Like; gain: number; fadeS: number; offset?: number }): VoiceHandle | null
  /**
   * A one-shot on the ambient bus at `pos` (`unculled`: past the voice policy's distance cull, the bell). `follow`
   * re-places a long sound every frame. True when it was asked to play.
   */
  oneShot(file: string, o: { pos: Vec3Like; gain: number; unculled?: boolean; follow?: () => Vec3Like | null }): boolean
  /** The town area's night one-shot layers (insects, night birds); [] when none. */
  nightLayers?(): readonly AmbientLayer[]
  /** Mutes the area's own (day) one-shots while it is night in town. */
  muteDayLayers?(on: boolean): void
}

/**
 * Where the folk count comes from: the drawn crowd, or the pure schedule's `populationNear(x, z, r, nowS, solarT)`
 * (TL-R). null: no count yet (the town file is loading): the district estimate.
 */
export type FolkCounter = (x: number, z: number, r: number, nowS: number, solarT: number) => number | null

/** What `update` reads each frame. */
export interface TownAudioInput {
  /** The listener's feet (glTF metres). */
  x: number
  y: number
  z: number
  /** The server clock (s): the shared schedules. */
  nowS: number
  /** The solar time the sky shows (0 = midnight): the night layers and the bed's night rule. */
  solarT: number
  /**
   * The server clock's solar time (H11 S1/S2): the bell's hours and the folk count follow it, so the Low guard's frozen
   * noon sky still has its bell and its schedule. Absent: `solarT`.
   */
  clockT?: number
  /** Inside the town (the music's check): the night layers. */
  inTown: boolean
  /** Seconds since the last update. */
  dt: number
}

interface Shot {
  until: number
  bell: boolean
}

interface NightPending {
  layer: AmbientLayer
  at: number
}

export class TownAudio {
  private spots: TownSoundSpots
  private pop: TownPopulation
  private counter: FolkCounter | null = null
  private external = { calls: false, hammer: false, animals: false }
  private t = 0
  private lastNow = NaN
  private lastSolar = NaN
  private countT = 0
  private folkNear = 0
  private calm: VoiceHandle | null = null
  private busy: VoiceHandle | null = null
  private calmGain = -1
  private busyGain = -1
  private fountain: VoiceHandle | null = null
  private shots: Shot[] = []
  private pendingStrokes: Array<{ at: number }> = []
  private night = false
  private nightPending: NightPending[] = []
  private head: Vec3Like = { x: 0, y: 0, z: 0 }
  private bedPos: Vec3Like = { x: 0, y: 0, z: 0 }
  private readonly played = { bell: 0, oneShots: 0, dropped: 0 }
  private readonly rng: () => number

  constructor(private readonly out: TownAudioOutput, opts: { spots?: TownSoundSpots; pop?: TownPopulation; rng?: () => number } = {}) {
    this.spots = opts.spots ?? JANGAN_SOUND_SPOTS
    this.pop = opts.pop ?? JANGAN_POPULATION
    this.rng = opts.rng ?? Math.random
  }

  /** The town file's spots and population (townSoundFromFile). */
  configure(c: { spots?: TownSoundSpots; pop?: TownPopulation }): void {
    if (c.spots) this.spots = c.spots
    if (c.pop) this.pop = c.pop
  }

  /** The pure schedule's count (null: the district estimate). */
  setFolkCounter(fn: FolkCounter | null): void {
    this.counter = fn
  }

  /** The crowd sends these events itself: the matching built-in schedules stop. */
  setExternal(e: Partial<{ calls: boolean; hammer: boolean; animals: boolean }>): void {
    this.external = { ...this.external, ...e }
  }

  /** Folk within BED_RADIUS_M at the last count. */
  get folk(): number {
    return this.folkNear
  }

  /** The bed's two gains now (0..1, before BED_GAIN). */
  get bed(): { calm: number; busy: number } {
    return { calm: Math.max(0, this.calmGain), busy: Math.max(0, this.busyGain) }
  }

  /** Loops playing now (bed and fountain). */
  get loops(): number {
    return (this.calm ? 1 : 0) + (this.busy ? 1 : 0) + (this.fountain ? 1 : 0)
  }

  /** Town one-shots sounding now. */
  get oneShots(): number {
    return this.shots.filter(s => s.until > this.t).length
  }

  get isNight(): boolean {
    return this.night
  }

  /** Counters for the debug view and the tests. */
  stats(): Readonly<{ bell: number; oneShots: number; dropped: number }> {
    return { ...this.played }
  }

  // ---- events from the crowd -----------------------------------------------------------------------------------

  /** A vendor called out at `pos` (TL-C's bubbles): a murmur, within 20 m. */
  vendorCall(pos: Vec3Like): boolean {
    return this.shotAt(TOWN_SOUND_CUES.murmur, pos, EVENT_CULL_M.murmur, SPOT_RULES.stall.gain)
  }

  /** The apprentice's HAMMER hit event at `pos`. */
  hammerHit(pos: Vec3Like): boolean {
    return this.shotAt(TOWN_SOUND_CUES.hammer, pos, EVENT_CULL_M.hammer, HAMMER.gain)
  }

  /** An animal of the crowd at `pos` (the cat's EMOTION01, a led horse, a porter's donkey). */
  animal(kind: TownAnimal, pos: Vec3Like): boolean {
    const cue = kind === 'horse' ? TOWN_SOUND_CUES.horse : kind === 'dog' ? TOWN_SOUND_CUES.dog : TOWN_SOUND_CUES[kind]
    return this.shotAt(cue, pos, EVENT_CULL_M.animal, 0.7)
  }

  /** A pigeon flock flushed at `pos` (World.life.onFlush, in town). */
  wings(pos: Vec3Like): boolean {
    return this.shotAt(TOWN_SOUND_CUES.wings, pos, EVENT_CULL_M.wings, 0.6)
  }

  // ---- per frame ---------------------------------------------------------------------------------------------------

  update(q: TownAudioInput): void {
    const dt = Math.max(0, q.dt)
    this.t += dt
    this.head.x = q.x
    this.head.y = q.y + HEAD_M
    this.head.z = q.z
    this.bedPos.x = this.head.x
    this.bedPos.y = this.head.y
    this.bedPos.z = this.head.z
    this.calm?.setPosition(this.bedPos)
    this.busy?.setPosition(this.bedPos)

    this.countT -= dt
    if (this.countT <= 0 || this.calmGain < 0) {
      this.countT = COUNT_PERIOD_S
      this.recount(q)
    }
    this.syncBed(isNight(q.solarT))
    this.syncFountain(q)
    this.bell(q.clockT ?? q.solarT)
    this.syncNight(q)

    const step = q.nowS - this.lastNow
    if (step > 0 && step <= MAX_STEP_S) this.spotsBetween(this.lastNow, q.nowS, solarHour(q.solarT))
    this.lastNow = q.nowS
    this.shots = this.shots.filter(s => s.until > this.t)
  }

  /** Fades everything out and forgets the state (leaving the world). */
  stop(): void {
    this.calm?.stop(BED_FADE_S)
    this.busy?.stop(BED_FADE_S)
    this.fountain?.stop(BED_FADE_S)
    this.calm = this.busy = this.fountain = null
    this.calmGain = this.busyGain = -1
    this.pendingStrokes = []
    this.nightPending = []
    if (this.night) this.out.muteDayLayers?.(false)
    this.night = false
    this.lastNow = NaN
    this.lastSolar = NaN
    this.countT = 0
    this.folkNear = 0
  }

  private recount(q: TownAudioInput): void {
    const t = q.clockT ?? q.solarT
    let n: number | null = null
    try {
      n = this.counter ? this.counter(q.x, q.z, BED_RADIUS_M, q.nowS, t) : null
    } catch {
      n = null
    }
    if (n === null) n = estimateFolkNear(this.pop, q.x, q.z, BED_RADIUS_M, t)
    this.folkNear = Number.isFinite(n) ? Math.max(0, n) : 0
  }

  private syncBed(night: boolean): void {
    const g = bedGains(this.folkNear, night)
    this.calm = this.syncLoop(this.calm, TOWN_SOUND_CUES.bedCalm, g.calm, this.calmGain)
    this.busy = this.syncLoop(this.busy, TOWN_SOUND_CUES.bedBusy, g.busy, this.busyGain)
    if (Math.abs(g.calm - this.calmGain) > 0.01 || g.calm === 0) this.calmGain = g.calm
    if (Math.abs(g.busy - this.busyGain) > 0.01 || g.busy === 0) this.busyGain = g.busy
  }

  /** Starts, re-gains or stops one bed loop (a gain change of more than 0.01 ramps over BED_FADE_S). */
  private syncLoop(voice: VoiceHandle | null, cue: string, g: number, last: number): VoiceHandle | null {
    if (g <= 0.001) {
      voice?.stop(BED_FADE_S)
      return null
    }
    if (!voice) {
      const file = this.out.files(cue)[0]
      if (!file) return null
      return this.out.loopAt(file, { pos: this.bedPos, gain: g * BED_GAIN, fadeS: BED_FADE_S, offset: this.rng() * 20 })
    }
    if (Math.abs(g - last) > 0.01) voice.setGain?.(g * BED_GAIN, BED_FADE_S)
    return voice
  }

  private syncFountain(q: TownAudioInput): void {
    const f = this.spots.fountain
    const d = f ? Math.hypot(q.x - f.x, q.z - f.z) : Infinity
    if (this.fountain && d > FOUNTAIN_OFF_M) {
      this.fountain.stop(BED_FADE_S)
      this.fountain = null
    } else if (!this.fountain && f && d <= FOUNTAIN_ON_M) {
      const file = this.out.files(TOWN_SOUND_CUES.fountain)[0]
      if (file) this.fountain = this.out.loopAt(file, { pos: { ...f }, gain: FOUNTAIN_GAIN, fadeS: BED_FADE_S, offset: this.rng() * 12 })
    }
  }

  /** The bell: strike on an hour crossing, then play the due strokes. */
  private bell(t: number): void {
    const hour = Number.isFinite(this.lastSolar) ? hourStruck(this.lastSolar, t) : null
    this.lastSolar = t
    if (hour !== null) {
      for (let i = 0; i < bellStrokes(hour); i++) this.pendingStrokes.push({ at: this.t + i * BELL_STROKE_S })
    }
    if (!this.pendingStrokes.length) return
    const due = this.pendingStrokes.filter(s => s.at <= this.t)
    this.pendingStrokes = this.pendingStrokes.filter(s => s.at > this.t)
    for (const _ of due) this.strike()
  }

  /** The bell's position as heard: on the line to the tower, at the panner distance of its long roll-off gain. */
  bellVoicePos(head: Vec3Like = this.head): Vec3Like | null {
    const b = this.spots.bell
    const dx = b.x - head.x, dy = b.y - head.y, dz = b.z - head.z
    const d = Math.hypot(dx, dy, dz)
    const g = bellGain(d)
    if (g <= 0) return null
    if (d < 1e-6) return { ...b }
    const k = pannerDistanceFor(g, d) / d
    return { x: head.x + dx * k, y: head.y + dy * k, z: head.z + dz * k }
  }

  private strike(): void {
    const pos = this.bellVoicePos()
    const file = this.pick(TOWN_SOUND_CUES.bell)
    if (!pos || !file) return
    if (this.out.oneShot(file, { pos, gain: BELL_GAIN, unculled: true, follow: () => this.bellVoicePos() })) {
      this.played.bell++
      this.shots.push({ until: this.t + Math.max(1, this.out.ms(file) / 1000), bell: true })
    }
  }

  /** In town at night: the day one-shots muted, the night layers on their own timers. */
  private syncNight(q: TownAudioInput): void {
    const night = q.inTown && isNight(q.solarT)
    if (night !== this.night) {
      this.night = night
      this.out.muteDayLayers?.(night)
      this.nightPending = night ? (this.out.nightLayers?.() ?? []).filter(l => !l.loop).map(layer => ({ layer, at: this.t + this.delay(layer) })) : []
    }
    for (const p of this.nightPending) {
      if (p.at > this.t) continue
      p.at = this.t + this.delay(p.layer)
      if (this.shots.filter(s => s.until > this.t && !s.bell).length >= TOWN_ONESHOT_CAP) continue
      const a = this.rng() * Math.PI * 2, r = 8 + this.rng() * 14
      const pos = { x: q.x + Math.cos(a) * r, y: q.y + 0.5, z: q.z + Math.sin(a) * r }
      if (this.out.oneShot(p.layer.file, { pos, gain: 0.5 + 0.4 * this.rng(), unculled: true })) {
        this.played.oneShots++
        this.shots.push({ until: this.t + Math.max(0.5, this.out.ms(p.layer.file) / 1000), bell: false })
      }
    }
  }

  private delay(layer: AmbientLayer): number {
    const [a, b] = layer.everyS
    return a + (Math.max(a, b) - a) * this.rng()
  }

  /** The built-in spots' events in (from, to]. */
  private spotsBetween(from: number, to: number, hour: number): void {
    const run = (prefix: string, list: readonly Vec3Like[], rule: SpotRule, cue: string | readonly string[]) => {
      if (rule.hours && !inHours(hour, rule.hours[0], rule.hours[1])) return
      list.forEach((p, i) => {
        if (Math.hypot(this.head.x - p.x, this.head.z - p.z) > rule.cullM) return
        for (const _ of spotEvents(`${prefix}${i}`, rule.everyS, from, to)) this.shotAt(cue, p, rule.cullM, rule.gain)
      })
    }
    if (!this.external.calls) run('stall', this.spots.stalls, SPOT_RULES.stall, TOWN_SOUND_CUES.murmur)
    if (!this.external.animals) {
      run('horse', this.spots.stables, SPOT_RULES.horse, TOWN_SOUND_CUES.horse)
      run('chicken', this.spots.coops, SPOT_RULES.chicken, TOWN_SOUND_CUES.chicken)
      run('dog', this.spots.dogs, SPOT_RULES.dog, TOWN_SOUND_CUES.dog)
      run('cat', this.spots.cats, SPOT_RULES.cat, TOWN_SOUND_CUES.cat)
    }
    const [hFrom, hTo] = this.spots.hammerHours ?? HAMMER.hours
    if (!this.external.hammer && inHours(hour, hFrom, hTo)) {
      this.spots.anvils.forEach((p, i) => {
        if (Math.hypot(this.head.x - p.x, this.head.z - p.z) > HAMMER.cullM) return
        for (const _ of hammerEvents(`anvil${i}`, from, to)) this.shotAt(TOWN_SOUND_CUES.hammer, p, HAMMER.cullM, HAMMER.gain)
      })
    }
  }

  /** The first file of the first cue the index has (a cue list: the synthesized dog before the retail wolf). */
  private pick(cue: string | readonly string[]): string | null {
    for (const c of typeof cue === 'string' ? [cue] : cue) {
      const files = this.out.files(c)
      if (files.length) return files[Math.min(files.length - 1, Math.floor(this.rng() * files.length))]!
    }
    return null
  }

  /** One town one-shot at `pos` within `cullM`, inside the cap. */
  private shotAt(cue: string | readonly string[], pos: Vec3Like, cullM: number, gain: number): boolean {
    if (Math.hypot(this.head.x - pos.x, this.head.y - pos.y, this.head.z - pos.z) > cullM) return false
    if (this.shots.filter(s => s.until > this.t && !s.bell).length >= TOWN_ONESHOT_CAP) {
      this.played.dropped++
      return false
    }
    const file = this.pick(cue)
    if (!file || !this.out.oneShot(file, { pos: { ...pos }, gain })) return false
    this.played.oneShots++
    this.shots.push({ until: this.t + Math.max(0.3, this.out.ms(file) / 1000), bell: false })
    return true
  }
}

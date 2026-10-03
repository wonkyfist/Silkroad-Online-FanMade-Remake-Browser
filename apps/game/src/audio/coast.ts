/**
 * The coast's sound (docs/COAST.md §10.1, §12.6; docs/WAVE_PLAN6.md lane CST-A): the `COAST` area switch and the
 * positional surf.
 *
 * - **The area.** Once a second the listener's surroundings are scanned against the coast field's sea mask (24 rays,
 *   a sample every 6 m out to 160 m, each crossing refined to < 0.5 m). Within COAST_ENTER_M (120 m) of the sea the
 *   ambience becomes `COAST` (the field's bed with the beach's gull calls: packages/convert/src/sound/coast.ts); it
 *   goes back beyond COAST_LEAVE_M (140 m), so walking along the line never flickers (hysteresis). The town wins over
 *   the coast (world/features/coast.ts).
 * - **The surf.** Up to SURF_MAX_EMITTERS (4) looping `env/sea_wave1` voices at the nearest shore points of that scan,
 *   at least SURF_SEPARATION_M apart, so the surf comes from where the sea is and grows louder walking down to it
 *   (the backend's inverse-distance panner). An emitter keeps its voice while its point moves (a matched point glides
 *   over 0.5 s); a point that goes away fades its voice out over 2 s. In a storm `env/oceana` joins at the nearest
 *   emitter, its gain from the sea's significant wave height (CST-O's `stats.hs`).
 *
 * Pure: the sea probe, the clock and the voices come in through the constructor and `update`, so it runs in vitest.
 */
import type { Vec3Like, VoiceHandle } from './backend.ts'

/** The area id (the sound index's COAST area). */
export const COAST_AREA = 'COAST'
/** The area switches on within this of the sea (m) … */
export const COAST_ENTER_M = 120
/** … and off beyond this (m): the hysteresis. */
export const COAST_LEAVE_M = 140
/** Surf voices at most (positional emitters). */
export const SURF_MAX_EMITTERS = 4
/** Emitters stand at least this far apart (m). */
export const SURF_SEPARATION_M = 40
/** The shore scan: rays, step (m), range (m), and its period (s). */
export const SHORE_SCAN = { rays: 24, stepM: 6, rangeM: 160, periodS: 1 } as const
/** The files. */
export const SURF_FILE = 'env/sea_wave1'
export const STORM_SURF_FILE = 'env/oceana'
/** The surf voice gain (sea_wave1 is quiet: RMS −34 dB), and its lift with the wave height. */
export const SURF_GAIN = 1.6
/** The storm surf: on above STORM_HS_ON (m), full at STORM_HS_FULL, off again below STORM_HS_OFF. */
export const STORM_HS_ON = 1.4
export const STORM_HS_OFF = 1.2
export const STORM_HS_FULL = 2.4
export const STORM_GAIN = 1.2
/** Fades (s). */
export const SURF_FADE_S = 2
/** An emitter's point glides to its new place with this time constant (s). */
const GLIDE_S = 0.5
/** Emitters stand this far above the sea level (m). */
const EMITTER_LIFT_M = 0.8

/** The sea mask (World.coast: CoastAccess fits). */
export interface SeaProbe {
  readonly seaLevelM: number
  seaAt(x: number, z: number): boolean
}

/** A shore crossing found by the scan. */
export interface ShorePoint {
  x: number
  z: number
  /** Metres from the listener. */
  d: number
}

/** The scan's result. */
export interface ShoreScan {
  /** Metres to the nearest sea (0 when standing in it; Infinity when none within range). */
  distM: number
  /** One crossing per ray that found one (the nearest along it). */
  points: ShorePoint[]
}

/**
 * Scans around (x, z): along each ray, the first sample whose sea mask differs from the origin's, refined by
 * bisection. Standing in the sea, the crossings are the way back to land and the distance is 0.
 */
export function scanShore(sea: SeaProbe, x: number, z: number, opts: { rays?: number; stepM?: number; rangeM?: number } = {}): ShoreScan {
  const rays = opts.rays ?? SHORE_SCAN.rays
  const step = opts.stepM ?? SHORE_SCAN.stepM
  const range = opts.rangeM ?? SHORE_SCAN.rangeM
  const origin = sea.seaAt(x, z)
  const points: ShorePoint[] = []
  for (let k = 0; k < rays; k++) {
    const a = (k / rays) * Math.PI * 2
    const dx = Math.cos(a), dz = Math.sin(a)
    for (let r = step; r <= range + 1e-6; r += step) {
      if (sea.seaAt(x + dx * r, z + dz * r) === origin) continue
      let lo = r - step, hi = r
      for (let i = 0; i < 4; i++) {
        const m = (lo + hi) / 2
        if (sea.seaAt(x + dx * m, z + dz * m) === origin) lo = m
        else hi = m
      }
      const d = (lo + hi) / 2
      points.push({ x: x + dx * d, z: z + dz * d, d })
      break
    }
  }
  const distM = origin ? 0 : points.reduce((m, p) => Math.min(m, p.d), Infinity)
  return { distM, points }
}

/** The emitter points: the nearest crossings within `rangeM`, greedily at least `sepM` apart, at most `max`. */
export function pickEmitters(points: readonly ShorePoint[], max = SURF_MAX_EMITTERS, sepM = SURF_SEPARATION_M, rangeM = COAST_ENTER_M): ShorePoint[] {
  const out: ShorePoint[] = []
  for (const p of [...points].sort((a, b) => a.d - b.d)) {
    if (out.length >= max) break
    if (p.d > rangeM) break
    if (out.some(q => (q.x - p.x) ** 2 + (q.z - p.z) ** 2 < sepM * sepM)) continue
    out.push(p)
  }
  return out
}

/** The area state with hysteresis: on at ≤ enter, off at > leave. */
export function coastZone(wasIn: boolean, distM: number, enterM = COAST_ENTER_M, leaveM = COAST_LEAVE_M): boolean {
  return wasIn ? distM <= leaveM : distM <= enterM
}

/** Where the surf voices come from (GameAudio.loopAt). */
export interface CoastAudioOutput {
  /** A looped positional voice on the ambient bus; null when it cannot start yet (no context, still loading). */
  loopAt(file: string, o: { pos: Vec3Like; gain: number; fadeS: number; offset?: number }): VoiceHandle | null
}

/** What `update` reads each frame. */
export interface CoastAudioInput {
  /** The listener's feet (glTF metres). */
  x: number
  y: number
  z: number
  /** The sea mask (null: no coast, everything fades out). */
  sea: SeaProbe | null
  /** The sea's significant wave height (m; 0 when unknown). */
  hs: number
  /** Seconds since the last update. */
  dt: number
}

interface Emitter {
  /** Where it glides to, and where it is. */
  target: { x: number; y: number; z: number }
  pos: { x: number; y: number; z: number }
  voice: VoiceHandle | null
}

export class CoastAudio {
  private zone = false
  private dist = Infinity
  private scanT = 0
  private emitters: Emitter[] = []
  private storm: VoiceHandle | null = null
  private stormOn = false
  private lastGain = -1

  constructor(private readonly out: CoastAudioOutput, private readonly rng: () => number = Math.random) {}

  /** Inside the coast area now (with hysteresis). */
  get inZone(): boolean {
    return this.zone
  }

  /** Metres to the nearest sea at the last scan (Infinity: none within range). */
  get distanceM(): number {
    return this.dist
  }

  /** The surf emitters now (≤ SURF_MAX_EMITTERS), for tests and the debug panel. */
  emitterPositions(): ReadonlyArray<Readonly<Vec3Like>> {
    return this.emitters.map(e => e.pos)
  }

  /** The surf voices playing now (emitters with a voice, plus the storm layer). */
  get voices(): number {
    return this.emitters.filter(e => e.voice).length + (this.storm ? 1 : 0)
  }

  /** Per frame; returns true when the area state changed this frame. */
  update(q: CoastAudioInput): boolean {
    const was = this.zone
    this.scanT -= q.dt
    if (this.scanT <= 0) {
      this.scanT = SHORE_SCAN.periodS
      this.rescan(q)
    }
    this.glide(q.dt)
    return was !== this.zone
  }

  /** Fades every voice out and forgets the state (leaving the world, a new world). */
  stop(): void {
    for (const e of this.emitters) e.voice?.stop(SURF_FADE_S)
    this.emitters = []
    this.storm?.stop(SURF_FADE_S)
    this.storm = null
    this.stormOn = false
    this.zone = false
    this.dist = Infinity
    this.scanT = 0
    this.lastGain = -1
  }

  private rescan(q: CoastAudioInput): void {
    if (!q.sea) {
      if (this.emitters.length || this.storm || this.zone) this.stop()
      return
    }
    const scan = scanShore(q.sea, q.x, q.z)
    this.dist = scan.distM
    this.zone = coastZone(this.zone, scan.distM)
    const y = q.sea.seaLevelM + EMITTER_LIFT_M
    const picked = this.zone ? pickEmitters(scan.points, SURF_MAX_EMITTERS, SURF_SEPARATION_M, COAST_LEAVE_M) : []
    const gain = SURF_GAIN * (0.85 + 0.3 * Math.min(1, Math.max(0, q.hs) / STORM_HS_FULL))
    this.assign(picked.map(p => ({ x: p.x, y, z: p.z })), gain)
    this.syncStorm(q.hs)
  }

  /** Matches the emitters to the new points (nearest first), starts the new ones and fades the dropped ones. */
  private assign(targets: Array<{ x: number; y: number; z: number }>, gain: number): void {
    const free = [...this.emitters]
    const next: Emitter[] = []
    for (const t of targets) {
      let bi = -1, bd = Infinity
      free.forEach((e, i) => {
        const d = (e.target.x - t.x) ** 2 + (e.target.z - t.z) ** 2
        if (d < bd) {
          bd = d
          bi = i
        }
      })
      if (bi >= 0) {
        const e = free.splice(bi, 1)[0]!
        e.target = t
        next.push(e)
      } else {
        next.push({ target: t, pos: { ...t }, voice: null })
      }
    }
    for (const e of free) e.voice?.stop(SURF_FADE_S)
    const regain = Math.abs(gain - this.lastGain) > 0.02
    for (const e of next) {
      if (!e.voice) e.voice = this.out.loopAt(SURF_FILE, { pos: { ...e.pos }, gain, fadeS: SURF_FADE_S, offset: this.rng() * 7 })
      else if (regain) e.voice.setGain?.(gain, 1)
    }
    if (regain) this.lastGain = gain
    this.emitters = next
  }

  /** The storm surf at the nearest emitter while the waves are high (hysteresis on Hs). */
  private syncStorm(hs: number): void {
    const near = this.emitters[0]
    this.stormOn = !!near && (this.stormOn ? hs >= STORM_HS_OFF : hs >= STORM_HS_ON)
    if (!this.stormOn) {
      this.storm?.stop(SURF_FADE_S * 2)
      this.storm = null
      return
    }
    const g = STORM_GAIN * Math.min(1, Math.max(0.2, (hs - STORM_HS_OFF) / (STORM_HS_FULL - STORM_HS_OFF)))
    if (!this.storm) this.storm = this.out.loopAt(STORM_SURF_FILE, { pos: { ...near!.pos }, gain: g, fadeS: SURF_FADE_S * 2, offset: this.rng() * 10 })
    else this.storm.setGain?.(g, 1)
  }

  private glide(dt: number): void {
    const k = 1 - Math.exp(-Math.max(0, dt) / GLIDE_S)
    this.emitters.forEach((e, i) => {
      const p = e.pos, t = e.target
      if (p.x === t.x && p.y === t.y && p.z === t.z) return
      p.x += (t.x - p.x) * k
      p.y += (t.y - p.y) * k
      p.z += (t.z - p.z) * k
      if (Math.abs(t.x - p.x) + Math.abs(t.z - p.z) < 0.01) Object.assign(p, t)
      e.voice?.setPosition(p)
      if (i === 0) this.storm?.setPosition(p)
    })
  }
}

/**
 * Sound zones (docs/WORLD_EDITOR.md §3.3, §4.10, D14, D31; docs/WAVE_PLAN8.md D13, lane WE-R): the user's own ambience
 * zones from the world editor (`zones.json` of the edit layers; the export's `sound-zones.json`), played as loop
 * voices beside the area loop, as the coast's surf (audio/coast.ts) and the town's bed (audio/town.ts) do.
 *
 * - **A zone** is a circle or a polygon in glTF metres, a sound (a file or a cue of the exported sound index), a
 *   loudness (`gainDb`, −60 … +12), an edge fade (`fadeM`) and a time (`day`, `night` or `always`; the town's night
 *   hours, 20:00–05:00, on the server clock when there is one, so Low's frozen-noon sky still has its nights).
 * - **Its gain**: full inside, falling with a smoothstep to silence `fadeM` outside the edge; times 10^(gainDb / 20).
 * - **The voices**: at most ZONE_MAX_LOOPS (2) zone loops at a time, nearest first (inside = distance 0; then the louder,
 *   then the id), at most ZONE_MAX_IN_TOWN (1) inside the town box (wave 11's town sound runs up to 3 loops there);
 *   two zones of one sound share one voice (the nearer's, at the louder gain). A voice sits within the panner's reference distance on
 *   the line to the zone's nearest point (inside: at the listener), so it is heard from the zone's side and its level
 *   is the zone's gain alone. Gain changes ramp; a zone left behind fades out over ZONE_FADE_S.
 * - **The cost**: the choice runs every ZONE_TICK_S (0.25 s) behind a bounding-box test; between ticks a frame only
 *   moves the (≤ 2) voices with the listener: ≤ 0.05 ms of main thread a frame (WAVE_PLAN8 §5.3).
 *
 * Pure: the files and the voices come in through the output and `update`, so it runs in vitest.
 */
import { validateWorldEditZones, type WorldEditZone, type WorldEditZoneWhen } from '@sro/shared'
import { PANNER, type Vec3Like, type VoiceHandle } from './backend.ts'
import { isNight } from './town.ts'

/** Zone loops at most at a time (the nearest first) … */
export const ZONE_MAX_LOOPS = 2
/** … and at most this many inside the town box (wave 11's town sound runs up to 3 loops there). */
export const ZONE_MAX_IN_TOWN = 1
/** The choice's period (s). */
export const ZONE_TICK_S = 0.25
/** A voice's fade in and out (s), and the ramp of a gain change (s). */
export const ZONE_FADE_S = 1.5
export const ZONE_RAMP_S = 0.3
/** A gain change smaller than this keeps the voice's gain (no ramp). */
const GAIN_STEP = 0.01
/** A zone quieter than this is not played. */
const GAIN_MIN = 0.001
/** The voice's distance from the listener toward an outside zone (m): inside the panner's reference distance. */
export const ZONE_VOICE_M = Math.min(2, PANNER.refDistance)
/** The voice stands this high above the listener's feet (m), as the head. */
const HEAD_M = 1.6

/** What SoundZones plays through (GameAudio in the game; a fake in tests). */
export interface SoundZonesOutput {
  /** The file of a zone's sound key (a file of the index, else a cue's first file), or null when the index lacks it. */
  file(sound: string): string | null
  /** A looped positional voice on the ambient bus; null when it cannot start yet (it is asked again next tick). */
  loopAt(file: string, o: { pos: Vec3Like; gain: number; fadeS: number; offset?: number }): VoiceHandle | null
}

/** What `update` reads each frame. */
export interface SoundZonesInput {
  /** The listener's feet (glTF metres). */
  x: number
  y: number
  z: number
  /** The solar time the sky shows (0 = midnight). */
  solarT: number
  /** The server clock's solar time: `when` follows it when present (Low's sky is a frozen noon). */
  clockT?: number
  /** Inside the town box (the music's check). */
  inTown: boolean
  /** Seconds since the last update. */
  dt: number
}

/** A zone ready to test: its shape, its bounding box grown by the fade, and its linear gain. */
interface Zone {
  readonly id: string
  readonly name: string
  readonly sound: string
  readonly when: WorldEditZoneWhen
  readonly fadeM: number
  readonly amp: number
  readonly circle: { x: number; z: number; r: number } | null
  /** Polygon vertices, x and z interleaved. */
  readonly poly: Float64Array | null
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}

/** A playing zone voice. */
interface Playing {
  readonly id: string
  readonly file: string
  voice: VoiceHandle
  gain: number
  /** Unit direction (x, z) from the listener to the zone and the voice's offset along it (0 inside). */
  dx: number
  dz: number
  off: number
}

/** A zone's distance from (x, z) and its nearest point. */
export interface ZoneDistance {
  /** Metres outside the edge (0 inside). */
  d: number
  /** The nearest edge point when outside (the listener's point inside). */
  x: number
  z: number
}

/** The fade weight at `d` metres outside a zone's edge (1 inside; 0 at `fadeM` and beyond; a smoothstep between). */
export function zoneWeight(d: number, fadeM: number): number {
  if (d <= 0) return 1
  if (fadeM <= 0 || d >= fadeM) return 0
  const t = 1 - d / fadeM
  return t * t * (3 - 2 * t)
}

/** dB to an amplitude factor. */
export const dbToGain = (db: number): number => Math.pow(10, db / 20)

/** Whether a zone of `when` sounds at the solar time `t` (the town's night: 20:00–05:00). */
export function zoneSounds(when: WorldEditZoneWhen, t: number): boolean {
  return when === 'always' || (when === 'night') === isNight(t)
}

/** The distance from (x, z) to a circle or a polygon (even-odd inside test; the nearest point on the outline). */
export function zoneDistance(shape: { circle: { x: number; z: number; r: number } | null; poly: ArrayLike<number> | null }, x: number, z: number): ZoneDistance {
  const c = shape.circle
  if (c) {
    const vx = x - c.x, vz = z - c.z
    const len = Math.hypot(vx, vz)
    if (len <= c.r) return { d: 0, x, z }
    return { d: len - c.r, x: c.x + (vx / len) * c.r, z: c.z + (vz / len) * c.r }
  }
  const p = shape.poly
  if (!p || p.length < 6) return { d: Infinity, x, z }
  const n = p.length / 2
  let inside = false
  let best = Infinity, bx = x, bz = z
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = p[j * 2]!, az = p[j * 2 + 1]!, cx = p[i * 2]!, cz = p[i * 2 + 1]!
    if ((cz > z) !== (az > z) && x < ((ax - cx) * (z - cz)) / (az - cz) + cx) inside = !inside
    const ex = cx - ax, ez = cz - az
    const l2 = ex * ex + ez * ez
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0
    const qx = ax + ex * t, qz = az + ez * t
    const d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz)
    if (d2 < best) {
      best = d2
      bx = qx
      bz = qz
    }
  }
  return inside ? { d: 0, x, z } : { d: Math.sqrt(best), x: bx, z: bz }
}

function prepare(z: WorldEditZone): Zone {
  const s = z.shape
  const circle = 'circle' in s ? { ...s.circle } : null
  const poly = 'poly' in s ? Float64Array.from(s.poly.flat()) : null
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  if (circle) {
    minX = circle.x - circle.r
    maxX = circle.x + circle.r
    minZ = circle.z - circle.r
    maxZ = circle.z + circle.r
  } else if (poly) {
    for (let i = 0; i < poly.length; i += 2) {
      minX = Math.min(minX, poly[i]!)
      maxX = Math.max(maxX, poly[i]!)
      minZ = Math.min(minZ, poly[i + 1]!)
      maxZ = Math.max(maxZ, poly[i + 1]!)
    }
  }
  const f = Math.max(0, z.fadeM)
  return {
    id: z.id, name: z.name, sound: z.sound, when: z.when, fadeM: f, amp: dbToGain(z.gainDb), circle, poly,
    minX: minX - f, maxX: maxX + f, minZ: minZ - f, maxZ: maxZ + f,
  }
}

/**
 * The zones of a file: the edit layer's list (`zones.json`) or an export wrapper `{ zones: [...] }`. A list that does
 * not validate keeps every row that does on its own (one warning names the rest); anything else gives [].
 */
export function readSoundZones(json: unknown, warn: (msg: string) => void = () => {}): WorldEditZone[] {
  const list = Array.isArray(json) ? json : (json as { zones?: unknown } | null)?.zones
  if (!Array.isArray(list)) return []
  if (validateWorldEditZones(list).ok) return list as WorldEditZone[]
  const ids = new Set<string>()
  const out: WorldEditZone[] = []
  const bad: string[] = []
  list.forEach((row, i) => {
    const id = (row as { id?: unknown } | null)?.id
    if (validateWorldEditZones([row]).ok && !ids.has(id as string)) {
      ids.add(id as string)
      out.push(row as WorldEditZone)
    } else bad.push(typeof id === 'string' ? id : `#${i}`)
  })
  if (bad.length) warn(`[sound-zones] ${bad.length} zone(s) skipped (invalid or duplicate): ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', ...' : ''}`)
  return out
}

export class SoundZones {
  private zones: Zone[] = []
  private playing: Playing[] = []
  private tickT = Infinity
  private inTown: boolean | null = null
  private head: Vec3Like = { x: 0, y: 0, z: 0 }
  private readonly rng: () => number
  private readonly counts = { ticks: 0, started: 0, stopped: 0 }

  constructor(private readonly out: SoundZonesOutput, opts: { rng?: () => number } = {}) {
    this.rng = opts.rng ?? Math.random
  }

  /** Replaces the zones (a loaded file, or the editor's preview); the next update chooses again. */
  setZones(zones: readonly WorldEditZone[]): void {
    this.zones = zones.map(prepare)
    this.tickT = Infinity
  }

  /** The zones known. */
  get size(): number {
    return this.zones.length
  }

  /** Zone loops playing now. */
  get loops(): number {
    return this.playing.length
  }

  /** The ids of the zones playing now, with their voice gains. */
  get active(): Array<{ id: string; file: string; gain: number }> {
    return this.playing.map(p => ({ id: p.id, file: p.file, gain: p.gain }))
  }

  stats(): { zones: number; loops: number; ticks: number; started: number; stopped: number } {
    return { zones: this.zones.length, loops: this.playing.length, ...this.counts }
  }

  update(q: SoundZonesInput): void {
    this.head = { x: q.x, y: q.y + HEAD_M, z: q.z }
    this.tickT += Math.max(0, q.dt)
    // entering the town box chooses again at once (its cap of 1 holds from that frame)
    if (this.tickT >= ZONE_TICK_S || q.inTown !== this.inTown) {
      this.inTown = q.inTown
      this.tickT = 0
      this.tick(q)
    }
    for (const p of this.playing) p.voice.setPosition(this.voicePos(p))
  }

  /** Fades every zone voice out (leaving the world); the zones stay. */
  stop(): void {
    for (const p of this.playing) p.voice.stop(ZONE_FADE_S)
    this.counts.stopped += this.playing.length
    this.playing = []
    this.tickT = Infinity
  }

  private voicePos(p: Playing): Vec3Like {
    return { x: this.head.x + p.dx * p.off, y: this.head.y, z: this.head.z + p.dz * p.off }
  }

  /** Chooses the zones that sound here and syncs the voices to them. */
  private tick(q: SoundZonesInput): void {
    this.counts.ticks++
    const t = q.clockT ?? q.solarT
    const cands: Array<{ z: Zone; file: string; d: number; gain: number; nx: number; nz: number }> = []
    for (const z of this.zones) {
      if (q.x < z.minX || q.x > z.maxX || q.z < z.minZ || q.z > z.maxZ) continue
      if (!zoneSounds(z.when, t)) continue
      const near = zoneDistance(z, q.x, q.z)
      const gain = zoneWeight(near.d, z.fadeM) * z.amp
      if (gain <= GAIN_MIN) continue
      const file = this.out.file(z.sound)
      if (!file) continue
      cands.push({ z, file, d: near.d, gain, nx: near.x, nz: near.z })
    }
    cands.sort((a, b) => a.d - b.d || b.gain - a.gain || (a.z.id < b.z.id ? -1 : a.z.id > b.z.id ? 1 : 0))
    const cap = q.inTown ? ZONE_MAX_IN_TOWN : ZONE_MAX_LOOPS
    const chosen: typeof cands = []
    for (const c of cands) {
      if (chosen.length >= cap) break
      const same = chosen.find(o => o.file === c.file)
      if (same) {
        // one voice per sound: the nearer zone keeps it, at the louder gain of the two
        same.gain = Math.max(same.gain, c.gain)
        continue
      }
      chosen.push(c)
    }
    // stop what is no longer chosen (by zone and file), then start or re-gain the rest
    const keep: Playing[] = []
    for (const p of this.playing) {
      if (chosen.some(c => c.z.id === p.id && c.file === p.file)) keep.push(p)
      else {
        p.voice.stop(ZONE_FADE_S)
        this.counts.stopped++
      }
    }
    this.playing = keep
    for (const c of chosen) {
      const len = Math.hypot(c.nx - q.x, c.nz - q.z)
      const dx = len > 1e-6 ? (c.nx - q.x) / len : 0
      const dz = len > 1e-6 ? (c.nz - q.z) / len : 0
      const off = c.d > 0 ? Math.min(ZONE_VOICE_M, len) : 0
      const p = this.playing.find(o => o.id === c.z.id)
      if (p) {
        p.dx = dx
        p.dz = dz
        p.off = off
        if (Math.abs(c.gain - p.gain) > GAIN_STEP) {
          p.voice.setGain?.(c.gain, ZONE_RAMP_S)
          p.gain = c.gain
        }
        continue
      }
      const pos = { x: this.head.x + dx * off, y: this.head.y, z: this.head.z + dz * off }
      const voice = this.out.loopAt(c.file, { pos, gain: c.gain, fadeS: ZONE_FADE_S, offset: this.rng() * 20 })
      if (!voice) continue
      this.counts.started++
      this.playing.push({ id: c.z.id, file: c.file, voice, gain: c.gain, dx, dz, off })
    }
  }
}

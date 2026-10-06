/**
 * Weather on the client (docs/WEATHER.md §5.4, §7, docs/WAVE_PLAN3.md §6.9): keeps the WeatherSync from `worldEnter` /
 * `weather` / `lightning`, blends it each frame into a WeatherFrame (zone climate, gusts, flash) for
 * `world.setWeather(frame)`, sets the weather level from the effective graphics settings, drives the weather audio,
 * decorates actor materials with the wetness plugin and adds its option rows. The weather is purely cosmetic.
 *
 * - The server owns the state; `WeatherClient` (pure, unit-tested) mirrors it: a late joiner blends from the sync's
 *   `fromVec` (else `P[from]`) at the sync's own start, a change that arrives mid-transition blends from the CURRENT
 *   vector (no jump) and reaches `to` when the server does, and the surface wetness is integrated with the server's own
 *   `stepSurface` from `at`: per frame while frames come, and after a gap (a hidden tab, a stall) or a jump of the
 *   server clock estimate, again from the sync's own (wet, puddle, at) in one-second steps along the blend, as the
 *   server integrates it (W9F F2, P2).
 * - The zone under the camera modulates the world state (ZONE_CLIMATE), blended over ~10 s at a border.
 * - Lightning: the flash at the strike's `at` (at most one per 2 s; `ui.reduceFlashing` scales it to a quarter before
 *   any subsystem sees it) and the thunder `distM / 343` s later, both on the server clock. A placed `strike`
 *   (docs/WEATHER.md §2.7) flashes with its own return strokes, brighter the closer it is, toward where it really is
 *   (its bolt, telegraph and aftermath are world/features/lightning.ts'); the old `lightning` copy of it is skipped.
 * - Classic character lights (screens/world.ts `sun` 1.2 / `hemi` 0.7): scaled by the weather only on the Classic
 *   material path with the classic sky (WEATHER §7.1); the modern sky dims them through SkyState (GAME).
 * - Debug: `?weather=storm` (or `rain:0.6`) holds a state offline until the first `weather` message;
 *   `window.__sroWeather` shows the frame, the sync and the level.
 * - Winter (docs/WINTER.md §8): the snow season's state (`worldEnter.world.winter`, `winter`) is mirrored by
 *   WinterClient (world/winter/client.ts) and its cover and frost ride in the frame (`cover`, `frost`; the snowfall
 *   rate `snow` comes with the weather). The snow on the ground is drawn even without the new weather look (Low and its
 *   classic combination too: the season is content); the flakes follow the weather like the rain.
 *   `?winter=<0..1>` holds a look offline.
 */
import type { Material, Scene } from '@babylonjs/core'
import {
  WEATHER_KINDS,
  NEUTRAL_CLIMATE,
  SPEED_OF_SOUND,
  STORM_TABLE,
  blendWeather,
  flashAt,
  strikeFlashPeak,
  strokeBrightness,
  strikeStrokes,
  stepSurface,
  weatherParams,
  zoneClimate,
  type LightningStrike,
  type StormStatus,
  type Stroke,
  type SurfaceState,
  type WeatherKind,
  type WeatherParams,
  type WeatherSync,
  type ZoneClimate,
} from '@sro/shared'
import { CLEAR_FRAME, attachWetness, type World, type WeatherFrame, type WeatherLevel } from '@sro/world-render'
import type { GameAudio } from '../../audio/index.ts'
import { registerOptionRow } from '../../hud/options.ts'
import { t } from '../../i18n/index.ts'
import { WEATHER_SETTINGS, settings, weatherLevelFor, weatherShown, type SettingsStore, type WeatherSetting } from '../../settings.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { zoneAt } from '../map/zones.ts'
import { WinterClient, parseWinterOverride } from '../winter/client.ts'

/** Zone climate follows the camera with this time constant (s): ~95 % after 10 s. */
export const CLIMATE_TAU_S = 10 / 3
/** The wind direction turns toward a new one with this time constant (s). */
export const WIND_DIR_TAU_S = 4
/** The surface wetness is integrated in steps of this length (s). */
export const SURFACE_STEP_S = 0.25
/** A catch-up integrates in steps of at most this length along the blend (s): the server's tick. */
export const SURFACE_CATCHUP_STEP_S = 1
/** A gap between frames longer than this (s), or a server clock that went back, re-derives the surface from the sync. */
export const SURFACE_REBASE_S = 2
/** A catch-up takes at most this many steps (a longer span takes longer steps). */
const SURFACE_MAX_STEPS = 4096
/** Flashes closer together than this are dropped (the thunder still plays). */
export const FLASH_MIN_GAP_MS = 2000
/** A thunder more than this late (a hidden tab, a stall) is skipped. */
export const THUNDER_STALE_MS = 3000
/** `ui.reduceFlashing`: the flash at a quarter strength. */
export const REDUCED_FLASH = 0.25
/** The world screen's character lights (screens/world.ts) at their base intensities. */
export const CHARACTER_LIGHTS = { sun: 1.2, hemi: 0.7 } as const
/** A cover this far above the listener's feet (m) counts as shelter (a roof, a canopy). */
export const SHELTER_HEAD_M = 2
/** How long a `?weather=` override pretends it has been going (s): puddles already formed. */
const OVERRIDE_SOAK_S = 900

const TAU = Math.PI * 2
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** A held state for offline checks (`?weather=storm`, `?weather=rain:0.6`). */
export interface WeatherOverride {
  kind: WeatherKind
  intensity: number
}

/** `?weather=<state>[:intensity]` → an override (null: none or malformed). */
export function parseWeatherOverride(search: string): WeatherOverride | null {
  const raw = new URLSearchParams(search).get('weather')
  if (!raw) return null
  const [k, i] = raw.toLowerCase().split(':')
  if (!(WEATHER_KINDS as readonly string[]).includes(k ?? '')) return null
  const n = i === undefined ? 1 : Number(i)
  const intensity = k === 'rain' && Number.isFinite(n) ? Math.min(1, Math.max(0.4, n)) : 1
  return { kind: k as WeatherKind, intensity }
}

/** A 32-bit integer hash to −1..1. */
function hash(seed: number, i: number): number {
  let h = Math.imul(seed ^ Math.imul(i | 0, 0x9e3779b1), 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return ((h >>> 0) / 4294967296) * 2 - 1
}

/** Smooth 1D value noise, −1..1. */
function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const s = f * f * (3 - 2 * f)
  return hash(seed, i) * (1 - s) + hash(seed, i + 1) * s
}

/** Gust noise n(t) for a segment seed at server time `tS` seconds: two octaves (~4 s and ~1.3 s), −1..1. */
export function gustNoise(seed: number, tS: number): number {
  return 0.65 * valueNoise(seed >>> 0, tS / 4) + 0.35 * valueNoise((seed + 0x5bd1e995) >>> 0, tS / 1.3)
}

/** Shortest turn from `a` toward `b` by fraction `k` (radians, result in 0..2π). */
function turn(a: number, b: number, k: number): number {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return (((a + d * k) % TAU) + TAU) % TAU
}

type Transition = Pick<WeatherSync, 'start' | 'dur' | 'from' | 'to' | 'intensity'>

function sameTransition(a: Transition, b: Transition): boolean {
  return a.start === b.start && a.dur === b.dur && a.from === b.from && a.to === b.to && a.intensity === b.intensity
}

function clearSync(now: number): WeatherSync {
  const p = weatherParams('clear')
  return { start: now, dur: 0, from: 'clear', to: 'clear', intensity: 1, until: now + 3_600_000, windDir: 0.35, windMs: p.windMs, wet: 0, puddle: 0, at: now, seed: 1 }
}

/**
 * The client's mirror of the server weather (pure: no Babylon, no DOM). `enter` / `message` / `strike` take the wire,
 * `frame` turns it into this frame's WeatherFrame, `takeThunder` hands out the thunder that is due.
 */
export class WeatherClient {
  private sync: WeatherSync
  /** The transition blended now (a mid-transition message is re-timed to start at its arrival). */
  private trans: Transition
  /** The vector the transition starts from (undefined: P[from]). */
  private startVec: WeatherParams | undefined
  private surface: SurfaceState
  /**
   * Server ms the surface was last integrated to. It follows the server clock, not the frame times (I9A): a clamped
   * long frame, the warm-up or a hidden tab no longer leaves the puddles behind the other clients until a resync.
   */
  private surfaceAt: number
  private windDir: number
  private readonly climate: ZoneClimate = { ...NEUTRAL_CLIMATE }
  private primed = false
  private readonly strikes: { at: number; bearing: number; strokes?: readonly Stroke[]; peak?: number }[] = []
  private readonly thunders: { due: number; distM: number; bearing: number }[] = []
  private lastFlashAt = -Infinity
  private overridden: boolean
  private last: Readonly<WeatherFrame> | null = null

  constructor(override: WeatherOverride | null = null, now = 0) {
    this.sync = clearSync(now)
    this.trans = this.sync
    this.surface = { wet: 0, puddle: 0 }
    this.surfaceAt = now
    this.windDir = this.sync.windDir
    this.overridden = !!override
    if (override) this.hold(override, now)
  }

  /** The server's sync (or the override's). */
  get current(): Readonly<WeatherSync> {
    return this.sync
  }

  /** The `?weather=` override still holds (no `weather` message yet). */
  get isOverridden(): boolean {
    return this.overridden
  }

  /** The last frame made (null before the first). */
  get lastFrame(): Readonly<WeatherFrame> | null {
    return this.last
  }

  /** `worldEnter.world.weather` (absent: an older server, clear). A late joiner: the blend from P[from], as is. */
  enter(s: WeatherSync | undefined, now: number): void {
    if (this.overridden) return
    const sync = s ?? clearSync(now)
    this.sync = sync
    this.trans = sync
    // W9F P1: the server's own start vector while its transition runs (a change mid-transition, a light rain).
    this.startVec = sync.fromVec ? { ...sync.fromVec } : undefined
    this.windDir = sync.windDir
    this.primed = false
    this.takeSurface(sync, now)
  }

  /** A `weather` message: a new transition starts from the current blend (no jump), and ends when the server's does. */
  message(s: WeatherSync, now: number): void {
    this.overridden = false
    if (!sameTransition(s, this.sync)) {
      this.startVec = this.params(now)
      this.trans = { start: now, dur: Math.max(0, s.start + s.dur - now), from: s.from, to: s.to, intensity: s.intensity }
    }
    this.sync = s
    this.takeSurface(s, now)
  }

  /**
   * A `lightning` strike: the flash at `at` (false: dropped, too close to the last flash) and its thunder later. A placed
   * strike passes its return strokes and peak (docs/WEATHER.md §2.7): its flash follows them instead of `flashAt`.
   */
  strike(at: number, distM: number, bearing: number, placed?: { strokes: readonly Stroke[]; peak: number }): boolean {
    this.thunders.push({ due: at + (distM / SPEED_OF_SOUND) * 1000, distM, bearing })
    if (at - this.lastFlashAt < FLASH_MIN_GAP_MS) return false
    this.lastFlashAt = at
    this.strikes.push(placed ? { at, bearing, strokes: placed.strokes, peak: placed.peak } : { at, bearing })
    if (this.strikes.length > 4) this.strikes.shift()
    return true
  }

  /** Thunder due at `now` (server ms), removed from the queue; stale ones are dropped. */
  takeThunder(now: number): { distM: number; bearing: number }[] {
    const out: { distM: number; bearing: number }[] = []
    for (let i = this.thunders.length - 1; i >= 0; i--) {
      const th = this.thunders[i]!
      if (th.due > now) continue
      this.thunders.splice(i, 1)
      if (now - th.due <= THUNDER_STALE_MS) out.unshift({ distM: th.distM, bearing: th.bearing })
    }
    return out
  }

  /** The blended world parameters at `now` (before the zone climate), with the server's GM wind override. */
  params(now: number): WeatherParams {
    const p = blendWeather(this.trans, now, this.startVec)
    // The server sends P[to].windMs unless a GM overrides the wind (apps/server/src/weather.ts `params`).
    if (this.sync.windMs !== weatherParams(this.sync.to, this.sync.intensity).windMs) p.windMs = this.sync.windMs
    return p
  }

  /** This frame's WeatherFrame at server ms `now`, `dtS` after the last one, under the zone climate `zone`. */
  frame(now: number, dtS: number, zone: Readonly<ZoneClimate> = NEUTRAL_CLIMATE, reduceFlashing = false): Readonly<WeatherFrame> {
    const dt = Number.isFinite(dtS) && dtS > 0 ? Math.min(dtS, 1) : 0
    const p = this.params(now)
    const since = (now - this.surfaceAt) / 1000
    // A gap (a hidden tab, a stall) or a jump of the server clock estimate either way: from the sync again, along the
    // blend (W9F F2, P2). A jump forward that is later taken back is then undone rather than kept until a resync.
    if (since > SURFACE_REBASE_S || since < -SURFACE_STEP_S) this.takeSurface(this.sync, now)
    else if (since >= SURFACE_STEP_S) {
      this.surface = stepSurface(this.surface, p, since)
      this.surfaceAt = now
    }
    const c = this.climate
    const k = this.primed ? 1 - Math.exp(-dt / CLIMATE_TAU_S) : 1
    c.rainMul += (zone.rainMul - c.rainMul) * k
    c.fogAdd += (zone.fogAdd - c.fogAdd) * k
    c.windMul += (zone.windMul - c.windMul) * k
    c.wetFloor += (zone.wetFloor - c.wetFloor) * k
    this.windDir = this.primed ? turn(this.windDir, this.sync.windDir, 1 - Math.exp(-dt / WIND_DIR_TAU_S)) : this.sync.windDir
    this.primed = true

    const windMs = p.windMs * c.windMul
    const gustMs = Math.max(0, windMs * (1 + p.gust * gustNoise(this.sync.seed, now / 1000)))
    let flash = 0
    let bearing = 0
    let owned = false
    for (const s of this.strikes) {
      const f = s.strokes ? Math.min(3, (s.peak ?? 3) * strokeBrightness(s.strokes, (now - s.at) / 1000)) : flashAt(s, now)
      if (f > flash) {
        flash = f
        bearing = s.bearing
        owned = !!s.strokes
      }
    }
    while (this.strikes.length && now - this.strikes[0]!.at > 2000) this.strikes.shift()
    if (reduceFlashing) flash *= REDUCED_FLASH
    const frame: WeatherFrame = {
      cloud: p.cloud,
      cloudDark: p.cloudDark,
      cirrus: p.cirrus,
      rain: clamp01(p.rain * c.rainMul),
      // docs/WINTER.md §3: the snowfall rate (the zone's precipitation share applies to it too)
      snow: clamp01((p.snow ?? 0) * c.rainMul),
      fog: clamp01(p.fog + c.fogAdd),
      sun: p.sun,
      desat: p.desat,
      windX: Math.cos(this.windDir),
      windZ: -Math.sin(this.windDir),
      windMs,
      gustMs,
      wet: Math.max(this.surface.wet, c.wetFloor),
      puddle: this.surface.puddle,
      flash,
      flashX: flash > 0 ? Math.cos(bearing) : 0,
      flashZ: flash > 0 ? -Math.sin(bearing) : 0,
      ...(owned && flash > 0 ? { boltOwned: true } : {}),
      time: ((now / 1000) % 3600 + 3600) % 3600,
    }
    this.last = frame
    return frame
  }

  /**
   * The sync's surface state carried forward from its `at` to `now` with the server's integrator, in steps of at most
   * SURFACE_CATCHUP_STEP_S along the blend (the server ticks once a second with the blend of that second).
   */
  private takeSurface(s: WeatherSync, now: number): void {
    const span = (now - s.at) / 1000
    let surface: SurfaceState = { wet: s.wet, puddle: s.puddle }
    if (span > 0) {
      const steps = Math.min(SURFACE_MAX_STEPS, Math.ceil(span / SURFACE_CATCHUP_STEP_S))
      const dt = span / steps
      for (let i = 1; i <= steps; i++) surface = stepSurface(surface, this.params(s.at + i * dt * 1000), dt)
    }
    this.surface = surface
    this.surfaceAt = now
  }

  private hold(o: WeatherOverride, now: number): void {
    const p = weatherParams(o.kind, o.intensity)
    const soaked = stepSurface({ wet: 0, puddle: 0 }, p, OVERRIDE_SOAK_S)
    this.sync = { start: now, dur: 0, from: o.kind, to: o.kind, intensity: o.intensity, until: now + 3_600_000, windDir: 0.35, windMs: p.windMs, wet: soaked.wet, puddle: soaked.puddle, at: now, seed: 1 }
    this.trans = this.sync
    this.startVec = undefined
    this.surface = soaked
    this.surfaceAt = now
  }
}

/** A placed strike's distance (m) and bearing (radians, 0 = east, π/2 = north) from the listener at (x, y, z). */
export function strikeFromListener(s: Pick<LightningStrike, 'pos'>, x: number, y: number, z: number): { distM: number; bearing: number } {
  const dx = s.pos[0] - x
  const dz = s.pos[2] - z
  const b = Math.atan2(-dz, dx) || 0
  return { distM: Math.hypot(dx, s.pos[1] - y, dz), bearing: b < 0 ? b + TAU : b }
}

/** The stereo pan (−1..1) of a sound toward `bearing` for a listener looking along (fx, fz) (Babylon: +x right). */
export function panToward(bearing: number, fx: number, fz: number): number {
  const len = Math.hypot(fx, fz)
  if (!(len > 1e-6)) return 0
  const dx = Math.cos(bearing)
  const dz = -Math.sin(bearing)
  return 0.8 * (dx * (fz / len) - dz * (fx / len))
}

/** True when the shelter map has a cover more than SHELTER_HEAD_M above (x, y, z). */
export function shelteredAt(world: Pick<World, 'weather'> | null | undefined, x: number, y: number, z: number): boolean {
  const map = world?.weather.shelter
  if (!map?.valid) return false
  const top = map.topAt(x, z)
  return top !== null && top > y + SHELTER_HEAD_M
}

/** The Classic character lights under a frame (WEATHER §7.1), from the base intensities (never compounding). */
/**
 * The extra fog of a night storm (docs/WEATHER.md §12.2) from the server's storm status: its `night` effect (the
 * monsters' sight change, which already carries the night's depth and the strength) scaled to STORM_TABLE.nightFogAdd.
 */
export function stormNightFog(s: Pick<StormStatus, 'effects'>): number {
  const pct = s.effects.find((e) => e.id === 'night')?.pct
  const full = (STORM_TABLE.nightSightMul - 1) * 100
  if (pct === undefined || full === 0) return 0
  return Math.min(1, STORM_TABLE.nightFogAdd * Math.min(2, Math.max(0, pct / full)))
}

export function characterLightIntensities(f: Pick<WeatherFrame, 'sun' | 'cloudDark'>): { sun: number; hemi: number } {
  return { sun: CHARACTER_LIGHTS.sun * clamp01(f.sun), hemi: CHARACTER_LIGHTS.hemi * (1 - 0.2 * clamp01(f.cloudDark)) }
}

export interface WeatherFeatureOptions {
  /** The settings store (default the page's). */
  store?: SettingsStore
  /** Location search for `?weather=` (default the page's). */
  search?: string
  /** Zone name at (x, z) (default map/zones.ts zoneAt). */
  zoneAt?: (x: number, z: number) => string | null
}

export function weatherFeature(ctx: WorldFeatureContext, opts: WeatherFeatureOptions = {}): WorldFeature {
  const store = opts.store ?? settings
  const search = opts.search ?? (typeof location === 'undefined' ? '' : location.search)
  const zoneOf = opts.zoneAt ?? zoneAt
  const client = new WeatherClient(parseWeatherOverride(search), ctx.serverNow())
  const winter = new WinterClient(parseWinterOverride(search))
  const audio: GameAudio | undefined = ctx.app?.audio
  const scene: Scene = ctx.scene
  const offs: Array<() => void> = []
  let world: World | null = null
  let level: WeatherLevel | null = null
  let lightsTouched = false
  let offDecorator: (() => void) | null = null
  /** docs/WEATHER.md §12.2: the night-storm fog the server's `storm` status asks for (target, and eased). */
  let nightFogTarget = 0
  let nightFog = 0

  const applyLevel = () => {
    if (!world) return
    const next = weatherLevelFor(store.get(), world.render.gpu)
    if (next === level) return
    level = next
    world.setWeatherLevel(next)
  }

  // Actor wetness is the Classic path's (WEATHER §6.4); on PBR presets RND-M's surface plugin wets characters (D19).
  const syncDecorator = () => {
    const want = !!ctx.addMaterialDecorator && world?.render.mode === 'classic'
    if (want && !offDecorator) {
      offDecorator = ctx.addMaterialDecorator!((mat: Material) => {
        if (ctx.world()?.world.render.mode === 'classic') attachWetness(mat, 'actor')
      })
    } else if (!want && offDecorator) {
      offDecorator()
      offDecorator = null
    }
  }

  const setLights = (sun: number, hemi: number) => {
    const s = scene.getLightByName('sun')
    const h = scene.getLightByName('hemi')
    if (s) s.intensity = sun
    if (h) h.intensity = hemi
  }

  const updateLights = (f: Readonly<WeatherFrame>) => {
    const classic = !!world && world.render.mode === 'classic' && world.skyStyle === 'classic'
    if (classic) {
      const i = characterLightIntensities(f)
      setLights(i.sun, i.hemi)
      lightsTouched = true
    } else if (lightsTouched) {
      setLights(CHARACTER_LIGHTS.sun, CHARACTER_LIGHTS.hemi)
      lightsTouched = false
    }
    // The fires' rain dimming (1 − 0.3 × rain) is NL's own: night-lights.ts reads RenderWeather.rain.
  }

  offs.push(
    store.onChange(() => applyLevel()),
    registerOptionRow('graphics', {
      id: 'graphics.weather',
      kind: 'choice',
      style: 'select',
      label: 'options.weather',
      choices: WEATHER_SETTINGS.map(v => ({ value: v, label: t(`options.weather.${v}`) })),
      get: s => s.graphics.weather,
      patch: v => ({ graphics: { weather: v as WeatherSetting } }),
    }),
    registerOptionRow('interface', {
      id: 'ui.reduceFlashing',
      kind: 'toggle',
      label: 'options.reduceFlashing',
      get: s => s.ui.reduceFlashing,
      patch: v => ({ ui: { reduceFlashing: v } }),
    }),
  )

  if (typeof window !== 'undefined') {
    const w = window as unknown as { __sroWeather?: unknown }
    w.__sroWeather = {
      get frame() {
        return client.lastFrame
      },
      get sync() {
        return client.current
      },
      get level() {
        return level
      },
      get overridden() {
        return client.isOverridden
      },
      get winter() {
        return { sync: winter.current, state: winter.raw }
      },
    }
    offs.push(() => {
      delete w.__sroWeather
    })
  }

  /** Where the listener stands: the own (or, Play the Boss, the steered) character, else the camera target. */
  const listener = () => {
    const selfId = ctx.controlledId?.() ?? ctx.selfId()
    const self = selfId !== null ? ctx.view(selfId) : undefined
    return self?.root.position ?? ctx.camera.target
  }

  return {
    onMessage(msg) {
      const now = ctx.serverNow()
      if (msg.t === 'worldEnter') {
        client.enter(msg.world.weather, now)
        winter.enter(msg.world.winter, now)
        nightFogTarget = nightFog = 0
      } else if (msg.t === 'weather') client.message(msg.weather, now)
      else if (msg.t === 'winter') winter.message(msg.winter)
      else if (msg.t === 'storm') nightFogTarget = stormNightFog(msg.storm)
      else if (msg.t === 'strike') {
        // a placed strike (docs/WEATHER.md §2.7): flash and thunder from where it really is
        const s = msg.strike
        const at = listener()
        const { distM, bearing } = strikeFromListener(s, at.x, at.y, at.z)
        client.strike(s.at, distM, bearing, { strokes: strikeStrokes(s.seed), peak: strikeFlashPeak(distM) })
        if (weatherShown(store.get())) audio?.weather.prepareThunder(distM)
      } else if (msg.t === 'lightning') {
        // the old copy of a placed strike, for older clients: the `strike` above has it
        if (msg.strike !== undefined) return
        client.strike(msg.at, msg.distM, msg.bearing)
        // W9F A4: without the new look no thunder plays, so none is fetched either.
        if (weatherShown(store.get())) audio?.weather.prepareThunder(msg.distM)
      }
    },

    onFrame(now, dt) {
      const w = ctx.world()?.world ?? null
      if (w !== world) {
        world = w
        level = null
        applyLevel()
      }
      syncDecorator()
      const cam = ctx.camera
      const zone = zoneClimate(zoneOf(cam.target.x, cam.target.z))
      // GAME's rollout gate (settings.ts weatherShown): without the new look the world and the speakers get a clear
      // frame, as before wave 9; the client keeps following the server underneath.
      const shown = weatherShown(store.get())
      const raw = client.frame(now, dt, zone, store.get().ui.reduceFlashing)
      // a night storm closes the view in (docs/WEATHER.md §12.2), eased over a few seconds
      nightFog += (nightFogTarget - nightFog) * (1 - Math.exp(-Math.max(0, dt) / 3))
      const live = nightFog > 0.002 ? { ...raw, fog: Math.min(1, raw.fog + nightFog) } : raw
      // docs/WINTER.md §8: the snow on the ground and the frost, under the weather the player sees
      const look = winter.frame(now, dt, raw, 1 - (w?.sky?.state.night ?? 0))
      const snowy = look.cover > 0 || look.frost > 0
      const frame = shown ? (snowy ? { ...live, cover: look.cover, frost: look.frost } : live) : snowy ? { ...CLEAR_FRAME, cover: look.cover, frost: look.frost } : CLEAR_FRAME
      world?.setWeather(frame)
      updateLights(frame)
      if (!audio) return
      const at = listener()
      audio.weather.update(frame, shelteredAt(world, at.x, at.y, at.z))
      const fx = cam.target.x - cam.position.x
      const fz = cam.target.z - cam.position.z
      for (const th of client.takeThunder(now)) if (shown) audio.weather.thunder(th.distM, panToward(th.bearing, fx, fz))
    },

    dispose() {
      for (const off of offs.splice(0)) off()
      offDecorator?.()
      offDecorator = null
      audio?.weather.stop()
      if (lightsTouched) setLights(CHARACTER_LIGHTS.sun, CHARACTER_LIGHTS.hemi)
      lightsTouched = false
      world = null
    },
  }
}

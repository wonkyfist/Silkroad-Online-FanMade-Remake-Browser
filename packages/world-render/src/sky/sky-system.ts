/**
 * The sky system (docs/SKY.md §3–6, docs/WAVE_PLAN3.md §4.1, §6.6, D2, D14, D17, D28): owns the dome, derives
 * `SkyState` every frame and tells World which environment to apply (`envFor`). Owned by SKY-B.
 *
 * Two styles (Options → Sky style; D4):
 * - 'classic': the retail dome (sky/classic-sky.ts) and palette exactly as before wave 9; SkyState is filled from the
 *   palette (key light = the retail direction and Diffuse × 0.6, ambient = ObjectAmbient, fog = FogColor). With the
 *   Classic material path this is the Low guard: nothing else is created, loaded or defined.
 * - 'modern': a physical atmosphere (Hillaire 2020 LUTs on the CPU, sky/atmosphere.ts), sun and moon on the server
 *   clock, procedural stars, lit clouds on a drifting shell, and the retail palette as an art grade (SKY §6.4). Its
 *   SkyState drives the key light (sun by day, moon or starlight by night, dimmed by a cloud over the sun and by rain),
 *   the ambient, the SH, the fog colour, the exposure, the Classic ground's day/night light and the cloud shadows.
 *
 * World drives it each frame: setRetail (the block's smoothed palette at the world time) → update(dt, camera) →
 * envFor() → the scene, terrain, water and grass. `attach` (World's constructor) hands it the asset base and the
 * Classic ground renderers, whose shared uniforms and defines carry sky/chunks.ts.
 *
 * CPU per frame (modern): a few sky-view LUT rows while a refresh runs (at most one every `lut.refreshS`, and only
 * when the light moved 0.1° or the atmosphere changed; 2 s apart at the default day length), 16 LUT taps for the fog
 * colour, 1–3 noise taps for the sun occlusion; a haze change rebuilds the atmosphere in 40 steps of ~1 ms.
 */
import { Constants, Observable, RawTexture, Vector3, Vector4, type Camera, type Mesh, type Scene } from '@babylonjs/core'
import { DEFAULT_CLOCK } from '../../../shared/src/world-clock.ts'
import type { Assets } from '../assets.ts'
import { approachEnv, evaluateProfile, sampleColor, sampleFloat, saturate, type EnvProfile, type EnvValues, type RGB } from '../environment.ts'
import type { SharedUniforms } from '../shader-chunks.ts'
import { Atmosphere, luminance, mieScaleFor, sampleSkyView, skyIrradianceUp } from './atmosphere.ts'
import { moonAt, moonFrame, paletteTime, starRotation, sunDir } from './celestial.ts'
import { displayToExposed, displayToScene, sceneDisplay } from '../render/display.ts'
import { ClassicSky } from './classic-sky.ts'
import { NOON_AMBIENT_LUMINANCE } from './lights.ts'
import { CLOUD_HEIGHT_KM, CLOUD_SCALE_KM, CloudLayer, cloudThickness, type CloudNoise } from './clouds.ts'
import { SkyDome } from './dome.ts'
import { fillHorizonRing, fillSkyCube, skySH, type RGB3, type SkyRadiance } from './ibl.ts'
import { SkyViewLut, toHalf } from './sky-luts.ts'
import {
  BAKED_LIGHT_DIR,
  CLEAR_SKY_WEATHER,
  SKY_PRESETS,
  lutRowsPerFrame,
  type SkyQuality,
  type SkyState,
  type SkyStyle,
  type SkyWeather,
} from './types.ts'

/** What World hands the sky each time its retail palette or time changes. */
export interface SkyRetailInput {
  /** The retail palette of the block under the focus, smoothed (TERRAIN.md 5.1), at the world time `t`. */
  env: EnvValues
  /** Solar time 0..1 (0 = midnight). */
  t: number
  /** Clock days (fractional) when a server clock runs, else null (a local, frozen time). */
  days: number | null
  /** Season declination (degrees) of the clock (DEFAULT_CLOCK's without one). */
  declination: number
  /** The block's environment profile (the modern sky evaluates it at its own remapped time, SKY §6.4). */
  profile: EnvProfile | null
}

export interface SkySystemOptions {
  style?: SkyStyle
  quality?: SkyQuality
  /** Dome radius (m); default 1400, today's. */
  radiusM?: number
}

/** A Classic ground renderer (TerrainRenderer, WorldScatter): the sky binds its chunk uniforms and defines. */
export interface SkyGroundTarget {
  readonly sharedUniforms: SharedUniforms
  setDefine(name: string, on: boolean): void
}

export interface SkyAttachOptions {
  /** The world's asset base (<out>/world/<name>/); the sky's files are <out>/sky/ (SKY-C's sky.json). */
  assets?: Assets
  /** The Classic ground (terrain, grass) that carries sky/chunks.ts. */
  ground?: readonly SkyGroundTarget[]
  /** The material path, read every frame: outputMode follows it (D17) unless setOutputMode pinned it. */
  renderMode?: () => 'classic' | 'pbr'
  /**
   * The classic dome's palette filter: World passes the Classic weather multipliers (weather/env.ts applyWeatherToEnv),
   * so the retail dome greys with the fog, terrain and objects in rain. It returns the same env for a clear frame.
   */
  classicEnv?: (env: EnvValues) => EnvValues
}

/** keyLight units per sky (LUT) unit: 0.43 / luminance(transmittance at 66°) (SKY §6.2; the test checks it). */
export const SKY_LDR_PER_LUT = 0.492
/** luminance(sky irradiance + key × 0.3) of a clear 66° noon in LUT units: the exposure 8 reference (SKY §6.5). */
export const SKY_EXPOSURE_REF = 0.306
/** Sky irradiance → ambient (SKY §3.4). */
export const AMBIENT_BOOST = 2.5
/** Key light of the moon (× illuminated fraction) and of starlight, in noon units (SKY §6.2; the floor is ours). */
export const MOON_KEY = 0.12
export const STAR_KEY = 0.03
/** The moonlit sky's weight on the moon's sky-view LUT (a physical 0.12 would light the night like a grey day). */
const MOON_SKY = 0.01
const MOON_CLOUD = 0.03
const NOON_KEY = 0.43
const MOON_COLOR: RGB = [0.77, 0.91, 1]
/** Partial eye adaptation: exposure = 8 × (ref / lum)^0.5 (the physical 1.0 would turn nights into grey days). */
const EXPOSURE_ADAPT = 0.5
/**
 * The most the weather (cloud, rain) may raise the exposure over the clear sky's at the same time and moon, by day and
 * at night (blended by SkyState.night). W9 LOOK: the day cap went 1.4 → 1.1 (a day storm at 1.4 read as a washed-out
 * grey: the eye must not adapt a storm back to a bright day); the night keeps a little more, and the night ambient
 * (NIGHT_AMBIENT) keeps characters readable instead.
 */
export const WEATHER_EXPOSURE_GAIN = 1.1
export const WEATHER_EXPOSURE_GAIN_NIGHT = 1.2
/**
 * W9 LOOK (dusk): a low sun's key light is never redder than this (normalised, red = 1). The physical transmittance
 * at 0.5° is (1, 0.18, 0.005): the whole town went pink-red at 18:30. About 3,000 K, never magenta.
 */
export const GOLDEN_KEY: Readonly<RGB> = [1, 0.7, 0.4]
/**
 * W9 LOOK (dusk): the twilight afterglow. While the sun is within a few degrees of the horizon (fading in from −5° to
 * +0.5°) the key keeps at least NOON_KEY × this, golden: the sunset light on walls and faces lasts until the moon
 * takes over instead of dropping to black at 18:30–18:45.
 */
export const TWILIGHT_KEY = 0.16
/**
 * W9 LOOK (night): the night sky's diffuse light in keyLight units (luminance, bluish): the moonlit or overcast sky
 * lights the shadowed sides, so a character's back and a mob at 30 m stay readable. The physical night ambient was 1/26
 * of the moon key (a character's dark side at ~4 % of white).
 */
export const NIGHT_AMBIENT = 0.0075
const NIGHT_AMBIENT_COLOR: RGB = [0.6, 0.74, 1]
/** W9 LOOK (night storm): the share of the hidden moon's (or starlight's) key that the clouds scatter back as ambient. */
export const STORM_GLOW = 0.1
/** W9 LOOK (dusk): the fog follows the sky's warm horizon more than the retail FogColor while the sun is low. */
const GRADE_FOG_TWILIGHT = 0.3
/**
 * W9 LOOK (storms): how much darker the retail part of the fog colour gets at full rain (the retail palette has no
 * weather; its clear-day fog made a storm's distance a bright white wall).
 */
const STORM_FOG_DIM = 0.5
const DEG = Math.PI / 180
const SUN_RADIUS = 0.27 * 1.6 * DEG
const MOON_RADIUS = 2.2 * DEG
const SUN_DISC = 40
/** The airglow floor shows the retail midnight SkyTop (× 0.6) at this exposure (brighter on darker nights). */
const AIRGLOW_EXPOSURE = 40
const NIGHT_TOP: RGB = [0.05, 0.07, 0.19]
const GRADE_SKY = 0.2
/** The share of the sky a full cloud cover hides (the rest shows through gaps and thin edges). */
const CLOUD_SKY_WEIGHT = 0.85
/** SKY §6.4 says 0.3; 0.65 keeps the noon fog within ΔE 10 of the retail FogColor (the §6.6 test). */
const GRADE_FOG = 0.65
const STAR_DENSITY = 0.004
const HORIZON_RING = 64
/** Classic dome vertex colours refresh at most this often unless something changed (s). */
const CLASSIC_REFRESH_S = 0.25
/** A time step larger than this (days) is a jump: LUTs build whole, the palette and exposure snap. */
const JUMP_T = 0.003

const smoothstep = (e0: number, e1: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return k * k * (3 - 2 * k)
}
const lum = (c: Readonly<RGB>) => luminance(c as [number, number, number])
const aces = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)))
const toLinear = (c: number) => Math.pow(Math.max(0, c), 2.2)

/**
 * The share of the sky the clouds hide at `cover`: CLOUD_SKY_WEIGHT (gaps and thin edges show the sky), rising to all
 * of it as the cover closes (W9 LOOK: a full overcast or storm showed blue through 15 % of the sky and the IBL; the dome
 * closes with its overcast deck, sky-shaders.ts, over the same range).
 */
export function cloudSkyWeight(cover: number): number {
  const c = Math.max(0, Math.min(1, cover))
  return c * (CLOUD_SKY_WEIGHT + (1 - CLOUD_SKY_WEIGHT) * smoothstep(0.7, 0.98, c))
}

/**
 * W9 LOOK (dusk): the eye's extra adaptation around sunset, × (1 + TWILIGHT_EXPOSURE) at its peak (the sun at the
 * horizon), gone by −6° and by +9°. The partial adaptation alone left the golden hour at ~14 % of the noon white level
 * on the ground: a black 18:30.
 */
export const TWILIGHT_EXPOSURE = 0.6
export function twilightExposure(sunElevationDeg: number): number {
  const el = sunElevationDeg
  return 1 + TWILIGHT_EXPOSURE * smoothstep(-6, 0, el) * (1 - smoothstep(0, 9, el))
}

/** W9 LOOK (dusk): the share of the low sun's key that reaches level ground as golden ambient (haze and ground glow). */
export const TWILIGHT_BOUNCE = 0.3
/** The bounce's weight by sun elevation: from −4° up, gone above 14°. */
export function twilightBounceWeight(sunElevationDeg: number): number {
  return smoothstep(-4, 0, sunElevationDeg) * (1 - smoothstep(6, 14, sunElevationDeg))
}

/** The clouds' sunlight at sunset: redder than the key light may be, but never magenta. */
const CLOUD_GOLDEN: Readonly<RGB> = [1, 0.5, 0.22]

/** Raises green and blue to `floor` × the largest channel (in place): a low sun reads golden, never pink-red. */
export function goldenFloor(c: RGB | RGB3, floor: Readonly<RGB>): RGB | RGB3 {
  const m = Math.max(c[0], c[1], c[2])
  if (!(m > 0)) return c
  c[1] = Math.max(c[1], floor[1] * m)
  c[2] = Math.max(c[2], floor[2] * m)
  return c
}

interface SkyJson {
  moons?: { file: string }[]
  cloud?: { file: string }
  cloudNoise?: { file: string }
}

/** Everything the modern style owns (made on the first switch to it). */
interface ModernParts {
  dome: SkyDome
  atm: Atmosphere
  atmHaze: number
  atmJob: Generator<void, Atmosphere> | null
  atmJobHaze: number
  sun: SkyViewLut
  moon: SkyViewLut
  /** Last LUT start time (s) per LUT and which one steps next. */
  sunStarted: number
  moonStarted: number
  turn: 0 | 1
  /** Transmittance at 66° (the white point) of `atm`. */
  t66: [number, number, number]
  sunIrr: [number, number, number]
  moonIrr: [number, number, number]
  /** Sun LUT zenith radiance (grade reference). */
  zenith: [number, number, number]
  clouds: CloudLayer
  noiseTex: RawTexture | null
  retailTex: RawTexture | null
  moonTex: RawTexture | null
  moonIndex: number
  ring: RawTexture | null
  ringData: Float32Array
  ringHalf: Uint16Array
  ringTimer: number
  loading: Promise<void> | null
  json: SkyJson | null
}

export class SkySystem {
  /** Today's retail dome (docs/TERRAIN.md 5.3). */
  readonly classic: ClassicSky
  /** Fired after every state change larger than the notify threshold (consumers that are not per-frame). */
  readonly onSky = new Observable<SkyState>()
  style: SkyStyle
  quality: SkyQuality
  /** The sky's weather (setWeather; already blended by the weather feature, so the sky does not smooth it again). */
  weather: SkyWeather = CLEAR_SKY_WEATHER
  /** 0: the sky shader tone-maps itself (Classic path); 1: linear HDR for the post stack (PBR presets, D17). */
  outputMode: 0 | 1 = 0
  /** Sky radiance → the linear output of outputMode 1 (RND-L / RND-P rescale it to their light units). */
  hdrScale = 1
  /** Bumped whenever the sky's radiance changed enough to refresh an IBL cube (a LUT finished, weather, a jump). */
  lutVersion = 0
  /** Average CPU ms of `update` (modern), for the perf overlay. */
  cpuMs = 0
  private outputPinned = false
  private retail: SkyRetailInput
  private readonly stateValue: SkyState
  private dirty = true
  private timer = 0
  private clock = 0
  private lastT = NaN
  private notified = { t: NaN, night: NaN }
  private modern: ModernParts | null = null
  private assets: Assets | null = null
  private ground: readonly SkyGroundTarget[] = []
  private groundDefines = { light: false, shadow: false }
  private renderMode: (() => 'classic' | 'pbr') | null = null
  private classicEnv: (env: EnvValues) => EnvValues = env => env
  private palette: EnvValues | null = null
  private readonly derived: EnvValues
  private readonly radiusM: number
  private readonly camPos = new Vector3()
  private readonly camFwd = new Vector3()
  private readonly u = {
    ground: new Vector4(1, 1, 1, 1),
    groundSun: new Vector4(1, 1, 1, 1),
    cloudShadow: new Vector4(0, 0, 1 / (CLOUD_SCALE_KM * 1000), 0),
    cloudProj: new Vector4(0, 1, CLOUD_HEIGHT_KM * 1000, 0),
  }
  private readonly stars = new Float32Array(9)
  private readonly tmp: RGB3 = [0, 0, 0]
  private readonly tmp2: RGB3 = [0, 0, 0]
  private readonly tmp3: RGB3 = [0, 0, 0]
  private readonly fogLin: [number, number, number] = [0, 0, 0]
  private visibleValue = true
  private readonly sunColor: RGB3 = [1, 1, 1]
  private readonly moonU: RGB3 = [0, 0, 0]
  private readonly moonV: RGB3 = [0, 0, 0]
  private readonly sunV: RGB3 = [0, 1, 0]
  private readonly moonDirV: RGB3 = [0, -1, 0]
  private moonVisible = true
  private moonEl = -Math.PI / 2
  private sunEl = Math.PI / 2
  private cloudLight: RGB = [0, 0, 0]
  private cloudAmb: RGB = [0, 0, 0]
  private grade: RGB = [1, 1, 1]
  private airglow: RGB = [0, 0, 0]
  private moonSkyW = 0
  private starAlpha = 0
  private exposureTarget = 8
  private shTimer = 0

  constructor(readonly scene: Scene, env: EnvValues, opts: SkySystemOptions = {}) {
    this.radiusM = opts.radiusM ?? 1400
    this.classic = new ClassicSky(scene, this.radiusM)
    this.style = opts.style ?? 'classic'
    this.quality = opts.quality ?? SKY_PRESETS.medium
    this.retail = { env, t: 0.5, days: null, declination: DEFAULT_CLOCK.declination, profile: null }
    this.derived = { ...env }
    this.stateValue = {
      t: 0.5, day: 0, phase: 0.5,
      sunDir: new Vector3(0, 1, 0), moonDir: new Vector3(0, -1, 0), sunElevationDeg: 90,
      moon: { age: 14.77, illum: 1, texture: 16 },
      keyLight: { dir: BAKED_LIGHT_DIR.clone(), color: [1, 1, 1], intensity: 1 },
      ambient: { sky: [1, 1, 1], horizon: [1, 1, 1], ground: [0.25, 0.25, 0.25] },
      sh: null,
      fogColor: [1, 1, 1],
      horizonRing: null,
      exposure: 1,
      night: 0,
      twilight: 0,
      cloudCover: CLEAR_SKY_WEATHER.cloudCover,
      cloudShadow: null,
      cloudShadowProj: null,
      cloudNoise: null,
      ground: { ambient: [1, 1, 1], sun: [1, 1, 1] },
      env,
    }
    this.fillCommon()
    this.fillRetail()
    // A modern sky from the start builds its dome on the first update; the retail dome never shows.
    if (this.style === 'modern') this.classic.mesh.setEnabled(false)
  }

  /** Whether the dome draws at all (a debug toggle: the viewer's "Sky" box). */
  get visible(): boolean {
    return this.visibleValue
  }

  /**
   * Shows or hides the sky. Only the active style's dome is ever enabled: enabling `mesh` directly before the modern
   * dome existed turned the retail dome on under it, and the two coincident spheres z-fought into a white/blue
   * diamond pattern across the sky (W9F TEX-5, the viewer lab on WebGL2).
   */
  setVisible(on: boolean): void {
    this.visibleValue = on
    this.syncDomes()
  }

  private syncDomes(): void {
    this.classic.mesh.setEnabled(this.visibleValue && this.style === 'classic')
    this.modern?.dome.setEnabled(this.visibleValue && this.style === 'modern')
  }

  /** The active dome mesh (World.meshes lists it; the viewer and worldmap tests read `world.sky.mesh`). */
  get mesh(): Mesh {
    return this.style === 'modern' && this.modern ? this.modern.dome.mesh : this.classic.mesh
  }

  /** The current state (read-only for consumers; the same object every frame). */
  get state(): Readonly<SkyState> {
    return this.stateValue
  }

  /** World's constructor: the asset base, the Classic ground renderers and the material path. */
  attach(opts: SkyAttachOptions): void {
    if (opts.assets) this.assets = opts.assets
    if (opts.ground) {
      this.ground = opts.ground
      for (const g of this.ground) {
        g.sharedUniforms.set('skyGround', this.u.ground)
        g.sharedUniforms.set('skyGroundSun', this.u.groundSun)
        g.sharedUniforms.set('skyCloudShadow', this.u.cloudShadow)
        g.sharedUniforms.set('skyCloudProj', this.u.cloudProj)
        if (this.modern?.noiseTex) g.sharedUniforms.set('cloudNoise', this.modern.noiseTex)
      }
      this.groundDefines = { light: false, shadow: false }
    }
    if (opts.renderMode) this.renderMode = opts.renderMode
    if (opts.classicEnv) this.classicEnv = opts.classicEnv
    this.syncGround()
  }

  /** The retail palette and time (World calls this whenever either changes). */
  setRetail(input: SkyRetailInput): void {
    this.retail = input
  }

  /** Forces a refresh on the next update (profile or time jumped). */
  markDirty(): void {
    this.dirty = true
  }

  /**
   * The environment World applies this frame. Classic style: the retail palette exactly (the Low guard). Modern: the
   * palette at the remapped time with the sky's fog colour, the key light as the objects' sun (diffuse × 0.6 = key)
   * and the palette ambient dimmed by rain.
   */
  envFor(): EnvValues {
    return this.style === 'modern' ? this.derived : this.retail.env
  }

  setStyle(style: SkyStyle): void {
    if (style === this.style) return
    this.style = style
    this.dirty = true
    if (style === 'modern') this.ensureModern()
    else this.fillRetail()
    this.syncDomes()
    this.syncGround()
  }

  setQuality(q: SkyQuality): void {
    this.quality = q
    const m = this.modern
    if (m) {
      m.dome.setQuality(q)
      if (m.sun.W !== q.lut.width || m.sun.H !== q.lut.height) {
        m.sun.dispose()
        m.moon.dispose()
        m.sun = new SkyViewLut(q.lut.width, q.lut.height, 'skyViewSun')
        m.moon = new SkyViewLut(q.lut.width, q.lut.height, 'skyViewMoon')
        m.dome.setTexture('skyView', m.sun.ensureTexture(this.scene))
        m.dome.setTexture('moonView', m.moon.ensureTexture(this.scene))
        this.dirty = true
      }
      if (!q.horizonRing && m.ring) {
        m.ring.dispose()
        m.ring = null
        this.stateValue.horizonRing = null
      }
    }
    this.syncGround()
  }

  setWeather(w: SkyWeather): void {
    if (Math.abs(w.cloudCover - this.weather.cloudCover) > 0.05 || Math.abs(w.precipitation - this.weather.precipitation) > 0.05) this.lutVersion++
    this.weather = w
  }

  /**
   * The GPU context was restored (World.onContextRestored): the LUTs and textures Babylon restored from their CPU
   * copies are current again, the rest is rebuilt at the next update, and IBL consumers refresh on `lutVersion`.
   */
  restoreGpu(): void {
    this.dirty = true
    this.lutVersion++
  }

  /** Pins the output mode (D17; WorldRender); without it the mode follows the attached material path. */
  setOutputMode(mode: 0 | 1): void {
    if (mode !== this.outputMode) this.dirty = true
    this.outputMode = mode
    this.outputPinned = true
    this.syncGround()
  }

  /** Per frame (World.update, before applyEnv). */
  update(dt: number, camera: Camera | null): void {
    this.clock = (this.clock + dt) % 3600
    if (!this.outputPinned && this.renderMode) {
      const mode = this.renderMode() === 'pbr' ? 1 : 0
      if (mode !== this.outputMode) {
        this.outputMode = mode
        // The classic dome's colours and the fog/ring encoding follow the output (D2/D4): refresh them now.
        this.dirty = true
        this.syncGround()
      }
    }
    this.fillCommon()
    const t = this.retail.t
    let dtT = Math.abs(t - this.lastT)
    dtT = Math.min(dtT, 1 - dtT)
    const jump = !(dtT < JUMP_T)
    this.lastT = t
    if (this.style === 'modern') {
      const t0 = performance.now()
      this.updateModern(dt, camera, jump || (this.dirty && dtT > 1e-4))
      this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.05
      this.dirty = false
    } else {
      this.fillRetail()
      this.timer += dt
      if (this.dirty || this.timer > CLASSIC_REFRESH_S) {
        // outputMode 1 (a PBR preset with the classic sky): the dome's display colours go through the post stack's
        // exposure, tone curve and gamma, so they are written as the scene-linear colours that show them (D2).
        const display = this.outputMode === 1 ? sceneDisplay(this.scene, this.stateValue.exposure) : null
        this.classic.update(this.classicEnv(this.retail.env), t, display)
        this.timer = 0
        this.dirty = false
      }
    }
    const s = this.stateValue
    if (!(Math.abs(s.t - this.notified.t) < 1e-3) || !(Math.abs(s.night - this.notified.night) < 0.01)) {
      this.notified = { t: s.t, night: s.night }
      this.onSky.notifyObservers(s)
    }
  }

  // ---- IBL data (D14: SKY-B produces, RND-L owns the cube) --------------------------------------------------------

  /**
   * The sky's radiance by direction in keyLight units × ambientBoost (so its up irradiance is SkyState.ambient.sky): the
   * LUTs, airglow and grade above the horizon with the cloud cover as its coverage-weighted colour, the ground bounce
   * (albedo 0.25 of the sky irradiance) below. The classic sky: its retail gradient. Reads the current LUTs (call it
   * again after `lutVersion` changes).
   */
  radiance(): SkyRadiance {
    const m = this.modern
    const s = this.stateValue
    if (this.style !== 'modern' || !m) {
      const env = this.retail.env
      return (_x, y, _z, out) => {
        const k = Math.max(0, Math.min(1, y))
        for (let c = 0; c < 3; c++) out[c] = y >= 0 ? toLinear(env.skyBottom[c]! + (env.skyTop[c]! - env.skyBottom[c]!) * k) : toLinear(env.fogColor[c]!) * 0.5
        return out
      }
    }
    const cover = this.weather.cloudCover
    const cloudCol: RGB = [this.cloudAmb[0] + this.cloudLight[0] * 0.25, this.cloudAmb[1] + this.cloudLight[1] * 0.25, this.cloudAmb[2] + this.cloudLight[2] * 0.25]
    // Below the horizon: the ground bounce (ambient.ground = sky irradiance × albedo 0.25) as Lambert radiance.
    const g = s.ambient.ground
    const ground: RGB = [g[0] / Math.PI, g[1] / Math.PI, g[2] / Math.PI]
    const k = SKY_LDR_PER_LUT * AMBIENT_BOOST
    const tmp: RGB3 = [0, 0, 0]
    return (x, y, z, out) => {
      if (y < 0) {
        out[0] = ground[0]; out[1] = ground[1]; out[2] = ground[2]
        return out
      }
      this.skyAt(Math.atan2(z, x), Math.asin(Math.min(1, y)), out, tmp)
      const w = cloudSkyWeight(cover)
      for (let c = 0; c < 3; c++) out[c] = (out[c]! + (cloudCol[c]! - out[c]!) * w) * k
      return out
    }
  }

  /** Six RGBA float faces of the sky (sky/ibl.ts fillSkyCube; 32² Medium, 64² High+). */
  fillSkyCube(size: number): Float32Array[] {
    return fillSkyCube(this.radiance(), size)
  }

  /** L1 SH of the sky (sky/ibl.ts skySH), keyLight units. */
  skySH(): Float32Array {
    return skySH(this.radiance())
  }

  // ---- the modern style -------------------------------------------------------------------------------------------

  private ensureModern(): ModernParts {
    if (this.modern) return this.modern
    const q = this.quality
    const dome = new SkyDome(this.scene, this.radiusM, q)
    const atm = Atmosphere.build(mieScaleFor(this.weather.haze))
    const m: ModernParts = {
      dome,
      atm,
      atmHaze: this.weather.haze,
      atmJob: null,
      atmJobHaze: 0,
      sun: new SkyViewLut(q.lut.width, q.lut.height, 'skyViewSun'),
      moon: new SkyViewLut(q.lut.width, q.lut.height, 'skyViewMoon'),
      sunStarted: -1e9,
      moonStarted: -1e9,
      turn: 0,
      t66: atm.sunTransmittance(66 * DEG),
      sunIrr: [0, 0, 0],
      moonIrr: [0, 0, 0],
      zenith: [0, 0, 0],
      clouds: new CloudLayer(),
      noiseTex: null,
      retailTex: null,
      moonTex: null,
      moonIndex: 0,
      ring: null,
      ringData: new Float32Array(HORIZON_RING * 4),
      ringHalf: new Uint16Array(HORIZON_RING * 4),
      ringTimer: 0,
      loading: null,
      json: null,
    }
    dome.setTexture('skyView', m.sun.ensureTexture(this.scene))
    dome.setTexture('moonView', m.moon.ensureTexture(this.scene))
    dome.setEnabled(this.visibleValue && this.style === 'modern')
    this.modern = m
    this.dirty = true
    m.loading = this.loadAssets(m)
    return m
  }

  /** Loads sky.json, the cloud noise (GPU + CPU copy), the retail cloud layer; the moon loads by phase later. */
  private async loadAssets(m: ModernParts): Promise<void> {
    const root = this.skyAssets()
    if (!root) return
    try {
      const json = await root.json<SkyJson>('sky.json')
      if (this.modern !== m) return
      m.json = json
      const noiseFile = json.cloudNoise?.file ?? 'cloud-noise.png'
      const img = await this.decode(root, noiseFile)
      if (this.modern !== m) return
      const noise: CloudNoise = { width: img.width, height: img.height, data: img.data }
      m.clouds.noise = noise
      m.noiseTex = this.rawTexture(img, 'skyCloudNoise', true)
      m.dome.setTexture('cloudNoise', m.noiseTex)
      this.stateValue.cloudNoise = m.noiseTex
      for (const g of this.ground) g.sharedUniforms.set('cloudNoise', m.noiseTex)
      const cloudFile = json.cloud?.file
      if (cloudFile) {
        const c = await this.decode(root, cloudFile)
        if (this.modern !== m) return
        m.retailTex = this.rawTexture(c, 'skyCloudRetail', true)
        m.dome.setTexture('cloudRetail', m.retailTex)
      }
    } catch (err) {
      console.warn('[sky] assets:', err)
    }
  }

  private async loadMoon(m: ModernParts, index: number): Promise<void> {
    const root = this.skyAssets()
    const file = m.json?.moons?.[index - 1]?.file
    if (!root || !file) return
    try {
      const img = await this.decode(root, file)
      if (this.modern !== m || m.moonIndex !== index) return
      const tex = this.rawTexture(img, `skyMoon${index}`, false)
      m.moonTex?.dispose()
      m.moonTex = tex
      m.dome.setTexture('moonTex', tex)
    } catch (err) {
      console.warn('[sky] moon:', err)
    }
  }

  private skyAssets(): Assets | null {
    const a = this.assets
    if (!a) return null
    return a.sub('../../sky')
  }

  private async decode(root: Assets, file: string) {
    const bytes = await root.bytesOf(file)
    const mime = /\.webp$/i.test(file) ? 'image/webp' : 'image/png'
    return root.io.decodeImage(bytes, mime)
  }

  private rawTexture(img: { width: number; height: number; data: Uint8Array }, name: string, wrap: boolean): RawTexture {
    const tex = RawTexture.CreateRGBATexture(img.data, img.width, img.height, this.scene, wrap, false,
      wrap ? Constants.TEXTURE_TRILINEAR_SAMPLINGMODE : Constants.TEXTURE_BILINEAR_SAMPLINGMODE)
    tex.name = name
    const mode = wrap ? Constants.TEXTURE_WRAP_ADDRESSMODE : Constants.TEXTURE_CLAMP_ADDRESSMODE
    tex.wrapU = mode
    tex.wrapV = mode
    return tex
  }

  private updateModern(dt: number, camera: Camera | null, jump: boolean): void {
    const m = this.ensureModern()
    if (!(m.sun.builds > 0)) jump = true
    const q = this.quality
    const w = this.weather
    const s = this.stateValue
    if (camera) {
      this.camPos.copyFrom(camera.globalPosition)
      camera.getDirectionToRef(this.scene.useRightHandedSystem ? Vector3.Forward(true) : Vector3.Forward(false), this.camFwd)
    }

    // The atmosphere follows the haze (sliced; the old one stays live meanwhile).
    if (m.atmJob) {
      const r = m.atmJob.next()
      if (r.done) {
        m.atm = r.value
        m.atmHaze = m.atmJobHaze
        m.atmJob = null
        m.t66 = m.atm.sunTransmittance(66 * DEG)
      }
    } else if (Math.abs(w.haze - m.atmHaze) > 0.05) {
      m.atmJobHaze = w.haze
      m.atmJob = Atmosphere.sliced(mieScaleFor(w.haze))
    }

    // Sky-view LUTs: the sun's while it can light the sky, the moon's at night.
    const sunNeeded = this.sunEl > -18 * DEG
    const moonNeeded = this.moonVisible && this.moonEl > -3 * DEG && this.sunEl < 3 * DEG
    const rows = lutRowsPerFrame(q)
    let changed = false
    if (jump) {
      m.sun.buildNow(m.atm, this.sunEl, q.lut.steps)
      m.sunStarted = this.clock
      if (moonNeeded) { m.moon.buildNow(m.atm, this.moonEl, q.lut.steps); m.moonStarted = this.clock }
      changed = true
    } else {
      const stale = (lut: SkyViewLut, el: number, started: number) =>
        !lut.busy && (lut.builtAtm !== m.atm || !(Math.abs(lut.builtEl - el) < 0.1 * DEG)) && (this.clock - started >= q.lut.refreshS || this.clock < started)
      if (sunNeeded && stale(m.sun, this.sunEl, m.sunStarted)) { m.sun.start(m.atm, this.sunEl, q.lut.steps); m.sunStarted = this.clock }
      if (moonNeeded && stale(m.moon, this.moonEl, m.moonStarted)) { m.moon.start(m.atm, this.moonEl, q.lut.steps); m.moonStarted = this.clock }
      // One LUT steps per frame, alternating when both run (SKY §3.5).
      const order = m.turn === 0 ? [m.sun, m.moon] : [m.moon, m.sun]
      const busy = order.find(l => l.busy)
      if (busy) {
        if (busy.step(rows)) changed = true
        m.turn = busy === m.sun ? 1 : 0
      }
    }
    if (changed) this.onLuts(m)
    this.moonSkyW = moonNeeded && m.moon.builds > 0 ? MOON_SKY * s.moon.illum * smoothstep(-2 * DEG, 4 * DEG, this.moonEl) : 0

    // Palette at the remapped time (SKY §6.4), smoothed like World smooths profile changes.
    const profile = this.retail.profile
    const tPal = paletteTime(this.retail.t, this.retail.declination)
    const target = profile ? evaluateProfile(profile, tPal) : this.retail.env
    this.palette = !this.palette || jump ? target : approachEnv(this.palette, target, Math.min(1, dt * 0.5))
    const pal = this.palette
    s.env = pal
    this.starAlpha = profile ? Math.min(1, Math.max(0, sampleFloat(profile.graph15, tPal, -1))) : s.night
    const skyTop = profile ? sampleColor(profile.skyTopColor, tPal, [0.17, 0.57, 0.95]) : pal.skyTop
    const nightTop = profile ? sampleColor(profile.skyTopColor, 0, NIGHT_TOP) : NIGHT_TOP

    // Clouds drift with the wind; the sky's light on them (transmittance at the shell altitude, the moon at night).
    m.clouds.drift(w.wind.x, w.wind.z, dt)
    const cover = Math.max(0, Math.min(1, w.cloudCover))
    const dark = Math.max(0, Math.min(1, w.cloudDarkness))
    const tc = m.atm.sunTransmittance(this.sunEl, CLOUD_HEIGHT_KM, this.tmp)
    const moonLight = this.moonVisible ? MOON_CLOUD * s.moon.illum * smoothstep(-2 * DEG, 3 * DEG, this.moonEl) : 0
    const dim = (1 - 0.6 * dark) * (1 - 0.4 * w.precipitation)
    // The clouds' sunlight gets the same golden floor as the key light (a red sunset band, not magenta clouds).
    goldenFloor(tc, CLOUD_GOLDEN)
    for (let c = 0; c < 3; c++) this.cloudLight[c] = (tc[c]! + moonLight * MOON_COLOR[c]!) * dim / Math.PI

    // Key light: the sun, crossfading to the moon (or starlight) between −1° and −4° (SKY §6.2).
    const sunT = m.atm.sunTransmittance(this.sunEl, undefined, this.tmp2)
    const wSun = smoothstep(-4 * DEG, -1 * DEG, this.sunEl)
    // W9 LOOK: the twilight afterglow keeps a golden key near the horizon (TWILIGHT_KEY).
    const glow = NOON_KEY * TWILIGHT_KEY * smoothstep(-5 * DEG, 0.5 * DEG, this.sunEl)
    const sunLdr = Math.max(NOON_KEY * (lum(sunT as RGB) / Math.max(1e-6, lum(m.t66 as RGB))), glow)
    const moonLdr = this.moonVisible ? NOON_KEY * MOON_KEY * s.moon.illum * smoothstep(-1 * DEG, 4 * DEG, this.moonEl) : 0
    const nightLdr = Math.max(moonLdr, NOON_KEY * STAR_KEY)
    // The cloud between the camera and the light (all presets; less where the ground shows real cloud shadows).
    const lightDir = wSun > 0.5 ? this.sunV : this.moonDirV
    const occ = m.clouds.occlusion(this.camPos.x, this.camPos.y, this.camPos.z, lightDir[0], lightDir[1], lightDir[2], cover, dark)
    const occStrength = q.cloudShadows === 'off' ? 0.75 : q.cloudShadows === 'ground' ? 0.45 : 0
    const weatherDim = (1 - occ * occStrength) * (1 - 0.8 * w.precipitation)
    const keyLdr = (wSun * sunLdr + (1 - wSun) * nightLdr) * weatherDim
    // The sun's colour relative to the noon white point, never redder than GOLDEN_KEY; below the horizon (no
    // transmittance left) the afterglow is GOLDEN_KEY itself.
    const sunMax = Math.max(sunT[0], sunT[1], sunT[2], 1e-6)
    const sc = this.sunColor
    for (let c = 0; c < 3; c++) sc[c] = sunMax > 1e-5 ? sunT[c]! / Math.max(1e-6, m.t66[c]!) : GOLDEN_KEY[c]!
    goldenFloor(sc, GOLDEN_KEY)
    const col = s.keyLight.color
    for (let c = 0; c < 3; c++) col[c] = wSun * sc[c]! + (1 - wSun) * MOON_COLOR[c]!
    const cm = Math.max(col[0], col[1], col[2], 1e-6)
    col[0] /= cm; col[1] /= cm; col[2] /= cm
    s.keyLight.intensity = keyLdr / Math.max(1e-6, lum(col))
    this.keyDirection(wSun)

    // Ambient (LUT units first): the irradiance of the sky, moonlit sky and airglow.
    const irr = this.tmp
    for (let c = 0; c < 3; c++) irr[c] = m.sunIrr[c]! + m.moonIrr[c]! * this.moonSkyW + this.airglow[c]! * Math.PI * 0.7
    // Under cover the clouds replace that much of the sky with their own radiance (the dome and radiance() use the
    // same mix), so an overcast sky lights the ground from above with the sun it blocks.
    const cw = cloudSkyWeight(cover)
    for (let c = 0; c < 3; c++) {
      this.cloudAmb[c] = irr[c]! * 0.5 * (1 - 0.7 * dark)
      irr[c] = (irr[c]! * (1 - cw) + Math.PI * (this.cloudAmb[c]! + this.cloudLight[c]! * 0.25) * cw) * (1 - 0.5 * w.precipitation)
    }
    const keyLut = keyLdr / SKY_LDR_PER_LUT
    // The eye adapts to the time of day, but only partly to the weather: a storm may raise the exposure at most
    // WEATHER_EXPOSURE_GAIN × the clear sky's by day, WEATHER_EXPOSURE_GAIN_NIGHT at night (gate 2: a night storm
    // reached 113 against ~24 clear, and the wet ground, grass and rain read as a lit white-out instead of a dark storm).
    const clear = this.tmp3
    for (let c = 0; c < 3; c++) clear[c] = m.sunIrr[c]! + m.moonIrr[c]! * this.moonSkyW + this.airglow[c]! * Math.PI * 0.7
    const clearLum = lum(clear) + ((wSun * sunLdr + (1 - wSun) * nightLdr) / SKY_LDR_PER_LUT) * 0.3
    const clearTarget = 8 * Math.pow(SKY_EXPOSURE_REF / Math.max(1e-6, clearLum), EXPOSURE_ADAPT)
    const gain = WEATHER_EXPOSURE_GAIN + (WEATHER_EXPOSURE_GAIN_NIGHT - WEATHER_EXPOSURE_GAIN) * s.night
    const expTarget = Math.min(8 * Math.pow(SKY_EXPOSURE_REF / Math.max(1e-6, lum(irr as RGB) + keyLut * 0.3), EXPOSURE_ADAPT), clearTarget * gain)
    this.exposureTarget = Math.min(160, Math.max(2, expTarget * twilightExposure(s.sunElevationDeg)))
    s.exposure = jump || !(s.exposure > 0) || s.exposure === 1 ? this.exposureTarget : s.exposure + (this.exposureTarget - s.exposure) * Math.min(1, dt / 1.5)
    const k = AMBIENT_BOOST * SKY_LDR_PER_LUT
    const amb = s.ambient
    // W9 LOOK: the night sky's diffuse light (NIGHT_AMBIENT) on top of the physical sky, plus STORM_GLOW of the moon or
    // starlight the clouds and rain take from the key (the clouds scatter it). It lights the ground and characters only:
    // the dome, the IBL cube (radiance()) and the exposure do not see it.
    const lostNight = (1 - wSun) * nightLdr * (1 - weatherDim)
    const nightAmb = (NIGHT_AMBIENT * s.night + STORM_GLOW * lostNight) / lum(NIGHT_AMBIENT_COLOR)
    // W9 LOOK (dusk): the low sun's glow off the haze and the ground (TWILIGHT_BOUNCE), in the key's golden colour:
    // the grazing key barely reaches level ground, which the purple twilight sky alone turned mauve.
    const bounce = TWILIGHT_BOUNCE * wSun * sunLdr * weatherDim * twilightBounceWeight(s.sunElevationDeg) / Math.max(1e-6, lum(sc as RGB))
    for (let c = 0; c < 3; c++) {
      amb.sky[c] = irr[c]! * k + nightAmb * NIGHT_AMBIENT_COLOR[c]! + bounce * sc[c]!
      amb.ground[c] = amb.sky[c]! * 0.25
    }

    // Airglow keeps the retail night blue (SKY §7.3 night palette); the grade leans the sky toward SRO's hue.
    const nightK = (s.night * 0.6) / AIRGLOW_EXPOSURE
    for (let c = 0; c < 3; c++) this.airglow[c] = nightK * 4.7 * toLinear(nightTop[c]!)
    const retailLin: RGB = [toLinear(skyTop[0]), toLinear(skyTop[1]), toLinear(skyTop[2])]
    const zen: RGB = [m.zenith[0] + this.airglow[0]!, m.zenith[1] + this.airglow[1]!, m.zenith[2] + this.airglow[2]!]
    const lr = lum(retailLin), lz = lum(zen)
    for (let c = 0; c < 3; c++) {
      const ratio = lr > 1e-6 && lz > 1e-8 ? (retailLin[c]! / lr) / Math.max(1e-6, zen[c]! / lz) : 1
      this.grade[c] = 1 + (Math.min(1.6, Math.max(0.6, ratio)) - 1) * GRADE_SKY
    }

    // Fog colour: the horizon at 1° over the camera's forward azimuth ±60°, exposed, mixed with the retail fog.
    this.fogAt(Math.atan2(this.camFwd.z, this.camFwd.x), 60 * DEG, s.fogColor, pal.fogColor)
    for (let c = 0; c < 3; c++) amb.horizon[c] = (toLinear(s.fogColor[c]!) / Math.max(1, s.exposure)) * Math.PI * k
    s.cloudCover = cover

    // Horizon ring (High+): the same colour by azimuth, twice a second.
    m.ringTimer += dt
    if (q.horizonRing && (changed || m.ringTimer > 0.5 || !m.ring)) {
      m.ringTimer = 0
      fillHorizonRing((az, out) => this.fogAt(az, 0, out, pal.fogColor), HORIZON_RING, m.ringData)
      // Only the PBR height fog reads the ring: store the exposed-linear colour that shows the designed one after the
      // post's tone curve (the fog shader divides by the exposure; D4).
      const tm = sceneDisplay(this.scene, s.exposure).toneMap
      const px: [number, number, number] = [0, 0, 0]
      for (let i = 0; i < m.ringData.length; i += 4) {
        displayToExposed(m.ringData.subarray(i, i + 3), tm, px)
        m.ringData[i] = px[0]; m.ringData[i + 1] = px[1]; m.ringData[i + 2] = px[2]
      }
      for (let i = 0; i < m.ringData.length; i++) m.ringHalf[i] = toHalf(m.ringData[i]!)
      if (!m.ring) {
        m.ring = new RawTexture(m.ringHalf, HORIZON_RING, 1, Constants.TEXTUREFORMAT_RGBA, this.scene, false, false,
          Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT)
        m.ring.name = 'skyHorizonRing'
        m.ring.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE
        m.ring.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE
      } else m.ring.update(m.ringHalf)
      s.horizonRing = m.ring
    }

    // Moon texture by phase.
    if (s.moon.texture !== m.moonIndex) {
      m.moonIndex = s.moon.texture
      if (m.json) void this.loadMoon(m, m.moonIndex)
      else void m.loading?.then(() => {
        if (this.modern === m && m.moonIndex === s.moon.texture) void this.loadMoon(m, m.moonIndex)
      })
    }

    // The Classic ground and the cloud shadows (sky/chunks.ts).
    const gs = s.ground
    for (let c = 0; c < 3; c++) gs.sun[c] = col[c]! * keyLdr / NOON_KEY
    const ambK = Math.min(1.1, Math.max(0.35, lum(s.ambient.sky) / NOON_AMBIENT_LUMINANCE))
    const ac = s.ambient.sky
    const am = Math.max(ac[0], ac[1], ac[2], 1e-6)
    for (let c = 0; c < 3; c++) gs.ambient[c] = ambK * (0.7 + 0.3 * ac[c]! / am)
    this.u.ground.set(gs.ambient[0], gs.ambient[1], gs.ambient[2], 1)
    this.u.groundSun.set(gs.sun[0], gs.sun[1], gs.sun[2], 1)
    const shadowOn = q.cloudShadows !== 'off'
    const base = q.cloudShadows === 'ground' ? 0.55 : 0.75
    const kl = s.keyLight.dir
    const ly = Math.max(0.1, kl.y)
    this.u.cloudShadow.set(m.clouds.offsetU, m.clouds.offsetV, 1 / (CLOUD_SCALE_KM * 1000), shadowOn ? base * (1 - s.night) * (1 - smoothstep(0.8, 0.95, cover)) : 0)
    this.u.cloudProj.set(kl.x / ly, kl.z / ly, CLOUD_HEIGHT_KM * 1000, cover)
    s.cloudShadow = shadowOn ? this.u.cloudShadow : null
    s.cloudShadowProj = shadowOn ? this.u.cloudProj : null

    // The SH after the ambient it integrates to: when a LUT finished, after a jump, and once a second (weather).
    this.shTimer += dt
    if (changed || jump || !s.sh || this.shTimer > 1) {
      this.shTimer = 0
      s.sh = skySH(this.radiance(), 8)
    }
    this.fillDerived(pal)
    this.bindDome(m)
    if (jump) this.lutVersion++
  }

  /** A LUT finished: irradiance and the zenith (grade); IBL consumers refresh on `lutVersion`. */
  private onLuts(m: ModernParts): void {
    skyIrradianceUp(m.sun.rgb, m.sun.W, m.sun.H, m.sunIrr)
    if (m.moon.builds > 0) skyIrradianceUp(m.moon.rgb, m.moon.W, m.moon.H, m.moonIrr)
    sampleSkyView(m.sun.rgb, m.sun.W, m.sun.H, 0, Math.PI / 2 - 0.01, m.zenith)
    this.lutVersion++
  }

  /** The key light's direction: the sun or moon (dynamic, elevation ≥ 6°) or the retail bake direction (baked). */
  private keyDirection(wSun: number): void {
    const d = this.stateValue.keyLight.dir
    if (this.quality.sunPath === 'baked') {
      d.copyFrom(BAKED_LIGHT_DIR)
      return
    }
    const a = this.sunV, b = this.moonDirV
    let x = b[0] + (a[0] - b[0]) * wSun
    let y = b[1] + (a[1] - b[1]) * wSun
    let z = b[2] + (a[2] - b[2]) * wSun
    const minY = Math.sin(6 * DEG)
    let h = Math.hypot(x, z)
    if (!(h > 1e-6)) { x = 1; z = 0; h = 1 }
    const l = Math.hypot(x, y, z) || 1
    y = Math.max(minY, y / l)
    const k = Math.sqrt(Math.max(0, 1 - y * y)) / h
    d.set(x * k, y, z * k)
  }

  /**
   * Sky radiance (LUT units, graded, no clouds) at world azimuth `az` (rad, atan2(z, x)) and elevation `el`.
   */
  private skyAt(az: number, el: number, out: RGB3, tmp: RGB3): RGB3 {
    const m = this.modern!
    const sunAz = Math.atan2(this.sunV[2], this.sunV[0])
    const moonAz = Math.atan2(this.moonDirV[2], this.moonDirV[0])
    sampleSkyView(m.sun.rgb, m.sun.W, m.sun.H, angleDiff(az, sunAz), el, out)
    if (this.moonSkyW > 0) {
      sampleSkyView(m.moon.rgb, m.moon.W, m.moon.H, angleDiff(az, moonAz), el, tmp)
      out[0] += tmp[0] * this.moonSkyW; out[1] += tmp[1] * this.moonSkyW; out[2] += tmp[2] * this.moonSkyW
    }
    const up = Math.max(0, Math.sin(el))
    for (let c = 0; c < 3; c++) out[c] = (out[c]! + this.airglow[c]! * (0.35 + 0.65 * up)) * this.grade[c]!
    return out
  }

  /**
   * Fog colour (LDR) toward azimuth `az`, averaged over ±`spread` (16 taps; 1 when spread is 0): the horizon at 1°,
   * clouds by cover, exposed and tone mapped like the dome, then mixed with the retail FogColor (gradeFog 0.3).
   */
  private fogAt(az: number, spread: number, out: RGB | RGB3, retailFog: Readonly<RGB>): RGB | RGB3 {
    const n = spread > 0 ? 16 : 1
    const acc: RGB3 = [0, 0, 0]
    const c3: RGB3 = [0, 0, 0]
    const t3: RGB3 = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      const a = n > 1 ? az + ((i + 0.5) / n - 0.5) * 2 * spread : az
      this.skyAt(a, DEG, c3, t3)
      acc[0] += c3[0]; acc[1] += c3[1]; acc[2] += c3[2]
    }
    const s = this.stateValue
    const w = this.weather
    const cover = Math.max(0, Math.min(1, w.cloudCover)) * 0.6
    const e = s.exposure > 0 ? s.exposure : 8
    // W9 LOOK: near sunset the physical horizon leads (the retail dusk FogColor is olive against a warm sky), and in
    // rain the retail part darkens (a storm's distance closes in dark, not as a bright wall).
    const low = smoothstep(-8, -2, s.sunElevationDeg) * (1 - smoothstep(8, 16, s.sunElevationDeg))
    const gradeFog = GRADE_FOG + (GRADE_FOG_TWILIGHT - GRADE_FOG) * low * (1 - s.night)
    const retailK = 1 - STORM_FOG_DIM * Math.max(0, Math.min(1, w.precipitation)) * (1 - 0.5 * s.night)
    for (let c = 0; c < 3; c++) {
      const sky = acc[c]! / n
      const cl = this.cloudAmb[c]! + this.cloudLight[c]! * 0.25
      const lin = (sky + (cl - sky) * cover) * e
      const ldr = Math.pow(aces(lin), 1 / 2.2)
      out[c] = ldr + (Math.min(1, Math.max(0, retailFog[c]!)) * retailK - ldr) * gradeFog
    }
    const g = lum(out as RGB)
    const d = 0.3 * w.precipitation
    for (let c = 0; c < 3; c++) out[c] = Math.min(1, Math.max(0, out[c]! + (g - out[c]!) * d))
    return out
  }

  /** The env World applies on the modern sky (see envFor). */
  private fillDerived(pal: EnvValues): void {
    const d = this.derived
    const s = this.stateValue
    Object.assign(d, pal)
    d.fogColor = [s.fogColor[0], s.fogColor[1], s.fogColor[2]]
    const kc = s.keyLight.color
    const ki = s.keyLight.intensity / 0.6
    d.diffuse = [kc[0] * ki, kc[1] * ki, kc[2] * ki]
    const rain = 1 - 0.15 * this.weather.precipitation
    d.objectAmbient = [pal.objectAmbient[0] * rain, pal.objectAmbient[1] * rain, pal.objectAmbient[2] * rain]
  }

  /** The dome's uniforms for this frame (sky-shaders.ts). */
  private bindDome(m: ModernParts): void {
    const u = m.dome.u
    const s = this.stateValue
    const w = this.weather
    const sv = this.sunV, mv = this.moonDirV
    const tc = m.atm.sunTransmittance(this.sunEl, undefined, this.tmp)
    u.skySun!.set(sv[0], sv[1], sv[2], SUN_DISC)
    const moonW = this.moonVisible ? (1.2 / Math.max(1, s.exposure)) * smoothstep(-1 * DEG, 2 * DEG, this.moonEl) : 0
    u.skyMoon!.set(mv[0], mv[1], mv[2], moonW)
    u.skySunColor!.set(tc[0], tc[1], tc[2], SUN_RADIUS)
    u.skyParams!.set(s.exposure, this.moonSkyW, this.starAlpha, this.outputMode)
    const r = starRotation(s.t, s.day, this.stars)
    u.skyStarsX!.set(r[0]!, r[1]!, r[2]!, this.quality.stars.perFace)
    u.skyStarsY!.set(r[3]!, r[4]!, r[5]!, STAR_DENSITY)
    u.skyStarsZ!.set(r[6]!, r[7]!, r[8]!, 0)
    u.skyCloud0!.set(m.clouds.offsetU, m.clouds.offsetV, Math.max(0, Math.min(1, w.cloudCover)), cloudThickness(w.cloudDarkness))
    u.skyCloud1!.set(w.cirrus, w.cloudDarkness, w.precipitation, this.hdrScale)
    u.skyCloudLight!.set(this.cloudLight[0], this.cloudLight[1], this.cloudLight[2], Math.max(0, Math.min(1, w.flash)))
    u.skyCloudAmb!.set(this.cloudAmb[0], this.cloudAmb[1], this.cloudAmb[2], MOON_RADIUS)
    const wSun = smoothstep(-8 * DEG, -3 * DEG, this.sunEl)
    let cx = mv[0] + (sv[0] - mv[0]) * wSun, cy = mv[1] + (sv[1] - mv[1]) * wSun, cz = mv[2] + (sv[2] - mv[2]) * wSun
    const cl = Math.hypot(cx, cy, cz) || 1
    cx /= cl; cy /= cl; cz /= cl
    u.skyCloudDir!.set(cx, cy, cz, 0)
    if (this.outputMode === 1) {
      // The HDR dome below the horizon: the fog colour as the post stack shows it (one tone curve, D4).
      const f = displayToScene(s.fogColor, sceneDisplay(this.scene, s.exposure), this.fogLin)
      u.skyFog!.set(f[0]!, f[1]!, f[2]!, 0)
    } else u.skyFog!.set(s.fogColor[0], s.fogColor[1], s.fogColor[2], 0)
    u.skyGrade!.set(this.grade[0], this.grade[1], this.grade[2], 0)
    u.skyNight!.set(this.airglow[0], this.airglow[1], this.airglow[2], 0.02)
    u.skyCam!.set(this.camPos.x, this.camPos.y, this.camPos.z, this.clock)
    moonFrame(mv, sv, s.moon.age, this.moonU, this.moonV)
    u.skyMoonU!.set(this.moonU[0], this.moonU[1], this.moonU[2], 0)
    u.skyMoonV!.set(this.moonV[0], this.moonV[1], this.moonV[2], 0)
  }

  // ---- both styles -------------------------------------------------------------------------------------------------

  /** Time, bodies and the night factor (both styles). */
  private fillCommon(): void {
    const s = this.stateValue
    const { t, days, declination } = this.retail
    s.t = t
    s.day = days === null ? 0 : Math.floor(days)
    s.phase = days === null ? t : days - Math.floor(days)
    const sun = sunDir(t, declination, this.sunV)
    s.sunDir.set(sun[0], sun[1], sun[2])
    const moon = moonAt(days ?? 14.77, t, declination, this.moonDirV)
    s.moonDir.set(moon.dir[0], moon.dir[1], moon.dir[2])
    this.sunEl = Math.asin(Math.max(-1, Math.min(1, sun[1])))
    this.moonEl = Math.asin(Math.max(-1, Math.min(1, moon.dir[1])))
    this.moonVisible = moon.visible
    s.sunElevationDeg = this.sunEl / DEG
    s.moon.age = moon.age
    s.moon.illum = moon.illum
    s.moon.texture = moon.texture
    s.night = smoothstep(2, -6, s.sunElevationDeg)
    s.twilight = Math.abs(s.sunElevationDeg) <= 6 ? 1 : 0
  }

  /** The classic sky's state: the retail palette as it is (the W9A-S skeleton's derivation, kept for the Low guard). */
  private fillRetail(): void {
    const s = this.stateValue
    const env = this.retail.env
    if (this.quality.sunPath === 'baked') s.keyLight.dir.copyFrom(BAKED_LIGHT_DIR)
    else {
      const d = s.sunElevationDeg > -4 ? s.sunDir : s.moonDir
      const minY = Math.sin(6 * DEG)
      const h = Math.hypot(d.x, d.z) || 1
      const y = Math.max(minY, d.y)
      const k = Math.sqrt(Math.max(0, 1 - y * y)) / h
      s.keyLight.dir.set(d.x * k, y, d.z * k)
    }
    s.keyLight.color = [env.diffuse[0] * 0.6, env.diffuse[1] * 0.6, env.diffuse[2] * 0.6]
    s.keyLight.intensity = 1
    const amb = env.objectAmbient
    s.ambient = { sky: [amb[0], amb[1], amb[2]], horizon: [env.skyBottom[0], env.skyBottom[1], env.skyBottom[2]], ground: [amb[0] * 0.25, amb[1] * 0.25, amb[2] * 0.25] }
    s.fogColor = saturate(env.fogColor) as RGB
    s.cloudCover = this.weather.cloudCover
    s.sh = null
    s.exposure = 1
    s.horizonRing = null
    s.cloudShadow = null
    s.cloudShadowProj = null
    s.ground = { ambient: [1, 1, 1], sun: [1, 1, 1] }
    s.env = env
  }

  /** The ground defines follow the style, the material path and the preset (Options only, never per frame). */
  private syncGround(): void {
    const modern = this.style === 'modern'
    const light = modern && this.outputMode === 0
    const shadow = modern && this.quality.cloudShadows !== 'off'
    if (light === this.groundDefines.light && shadow === this.groundDefines.shadow) return
    this.groundDefines = { light, shadow }
    for (const g of this.ground) {
      g.setDefine('SRO_SKY_LIGHT', light)
      g.setDefine('SRO_CLOUDSHADOW', shadow)
    }
  }

  dispose(): void {
    this.onSky.clear()
    this.classic.dispose()
    const m = this.modern
    if (m) {
      m.dome.dispose()
      m.sun.dispose()
      m.moon.dispose()
      m.noiseTex?.dispose()
      m.retailTex?.dispose()
      m.moonTex?.dispose()
      m.ring?.dispose()
      m.atmJob = null
      this.modern = null
    }
    for (const g of this.ground) {
      for (const n of ['skyGround', 'skyGroundSun', 'skyCloudShadow', 'skyCloudProj', 'cloudNoise']) g.sharedUniforms.delete(n)
    }
    this.ground = []
  }
}

/** |a − b| wrapped to 0..π. */
function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI)
  if (d > Math.PI) d = 2 * Math.PI - d
  return d
}

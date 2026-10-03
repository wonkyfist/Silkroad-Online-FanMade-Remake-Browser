// The viewer's render lab (docs/WAVE_PLAN3.md §6.16, lane LAB; RENDER.md §14 RND-I): the query string of a lab view,
// and a panel with live toggles for every §5.1 row, the time, the weather, exposure, tone map, LUT key and wetness,
// plus the bench (lab-bench.ts: the work/tmp/render/bench.ts method), the §5.2 suite, the DETAIL H8 normal check and
// the D14 cube probe. Without any lab parameter the viewer is the Classic viewer it was: the panel changes nothing
// until it is used.
//
// Lab query parameters (all optional; any of them turns the lab on):
//   preset=low|medium|high|ultra   the graphics preset (draw distance, render and sky blocks; default path = its own)
//   render=classic|pbr             the material path (default: the preset's; 'classic' without a preset)
//   sky=modern|classic             the sky style (default modern with a preset, else classic)
//   weather=<state>[:intensity]    clear|cloudy|overcast|rain|storm|fog, held and soaked (the game's ?weather= format)
//   wxlevel=auto|off|low|medium|high|ultra  the weather level (default auto = the preset's)
//   clock=fast|<minutes>           run a local server-style clock: fast = 2 real minutes per game day
//   tonemap=neutral|filmic  lut=<time>_<weather>  exposure=<trim>   image overrides
//   ssao=1  taaReproj=1            post options that need a fresh post stack (SSAO; TAA reprojection, D30)
//   fix=sheen,prepass              lab-only workarounds for two engine bugs the lab found (applyLabShaderFixes, tick)
import type { Camera } from '@babylonjs/core'
import {
  LUT_KEYS,
  QUALITY_PRESETS,
  RENDER_PRESETS,
  RenderPost,
  SKY_PRESETS,
  WEATHER_LEVELS,
  builtinLutStrip,
  formatTime,
  type GpuInfo,
  type LutKey,
  type RenderPath,
  type RenderQuality,
  type SkyQuality,
  type SkyStyle,
  type ToneMap,
  type WeatherFrame,
  type WeatherLevel,
  type World,
  type WorldQuality,
} from '@sro/world-render'
import { WEATHER_KINDS, flashAt, stepSurface, weatherParams, type SurfaceState, type WeatherKind, type WeatherParams } from '../../../../packages/shared/src/weather.ts'
import { CLOCK_LIMITS, DEFAULT_CLOCK, phaseForSolarTime, type WorldClockState } from '../../../../packages/shared/src/world-clock.ts'
import {
  benchFrames,
  formatCubeProbe,
  formatNormalCheck,
  formatSuite,
  probeCube,
  runNormalCheck,
  runSuite,
  suiteCases,
  type BenchHost,
  type LabControls,
  type SuiteRow,
} from './lab-bench.ts'

export const PRESETS: readonly WorldQuality[] = ['low', 'medium', 'high', 'ultra']
const TONE_MAPS: readonly ToneMap[] = ['neutral', 'filmic']

// ---- query string ----------------------------------------------------------------------------------------------

export interface LabParams {
  preset: WorldQuality | null
  render: RenderPath | null
  sky: SkyStyle | null
  weather: { kind: WeatherKind; intensity: number } | null
  weatherLevel: WeatherLevel | 'auto' | null
  /** Real minutes per game day of the local clock (null: frozen time). */
  clockMin: number | null
  toneMap: ToneMap | null
  lut: LutKey | null
  exposure: number | null
  ssao: boolean
  taaReprojection: boolean
  /** Lab-only workarounds (`?fix=sheen,prepass`, see applyLabShaderFixes and RenderPanel.tick). */
  fixes: string[]
}

const oneOf = <T extends string>(list: readonly T[], v: string | null): T | null =>
  v !== null && (list as readonly string[]).includes(v.toLowerCase()) ? (v.toLowerCase() as T) : null

/** Reads the lab parameters (unknown values are ignored, as if absent). */
export function parseLabParams(search: string): LabParams {
  const q = new URLSearchParams(search)
  let weather: LabParams['weather'] = null
  const w = q.get('weather')
  if (w) {
    const [k, i] = w.toLowerCase().split(':')
    const kind = oneOf(WEATHER_KINDS, k ?? null)
    if (kind) {
      const n = i === undefined ? 1 : Number(i)
      weather = { kind, intensity: kind === 'rain' && Number.isFinite(n) ? Math.min(1, Math.max(0.4, n)) : 1 }
    }
  }
  const clock = q.get('clock')
  let clockMin: number | null = null
  if (clock === 'fast') clockMin = 2
  else if (clock !== null && Number.isFinite(Number(clock)) && Number(clock) > 0) clockMin = Number(clock)
  const exposure = Number(q.get('exposure'))
  const on = (k: string) => q.get(k) === '1' || q.get(k) === 'true'
  return {
    preset: oneOf(PRESETS, q.get('preset')),
    render: oneOf(['classic', 'pbr'] as const, q.get('render')),
    sky: oneOf(['modern', 'classic'] as const, q.get('sky')),
    weather,
    weatherLevel: oneOf([...WEATHER_LEVELS, 'auto'] as const, q.get('wxlevel')),
    clockMin,
    toneMap: oneOf(TONE_MAPS, q.get('tonemap')),
    lut: (LUT_KEYS as readonly string[]).includes(q.get('lut') ?? '') ? (q.get('lut') as LutKey) : null,
    exposure: q.has('exposure') && Number.isFinite(exposure) && exposure > 0 ? exposure : null,
    ssao: on('ssao'),
    taaReprojection: on('taaReproj'),
    fixes: (q.get('fix') ?? '').split(',').map(f => f.trim()).filter(f => f === 'sheen' || f === 'prepass'),
  }
}

/** A lab view, resolved against the defaults (see the file comment). */
export interface LabConfig extends LabParams {
  /** Any lab parameter given: the panel drives the world's weather and the night lights run. */
  active: boolean
  quality: WorldQuality
  renderPath: RenderPath
  skyStyle: SkyStyle
  /** The level asked for ('auto' = the preset's) and the level it resolves to. */
  level: WeatherLevel | 'auto'
  resolvedLevel: WeatherLevel
  weatherState: { kind: WeatherKind; intensity: number }
}

/** The game's 'auto' weather level for a preset (§5.1; the first-run iGPU rule is the game's). */
export function autoWeatherLevel(q: WorldQuality): WeatherLevel {
  return q
}

/** Fills the defaults; `legacyQuality` is the viewer's old `?quality=` (draw distance only). */
export function resolveLab(p: LabParams, legacyQuality: WorldQuality): LabConfig {
  const active = p.preset !== null || p.render !== null || p.sky !== null || p.weather !== null || p.weatherLevel !== null ||
    p.clockMin !== null || p.toneMap !== null || p.lut !== null || p.exposure !== null || p.ssao || p.taaReprojection
  const quality = p.preset ?? legacyQuality
  const renderPath = p.render ?? (p.preset ? RENDER_PRESETS[p.preset].path : 'classic')
  const skyStyle = p.sky ?? (p.preset ? 'modern' : 'classic')
  // Weather runs with a preset or a weather state; a bare lab view (e.g. only ?sky=) keeps it off.
  const level = p.weatherLevel ?? (p.preset !== null || p.weather !== null ? 'auto' : 'off')
  const resolvedLevel = level === 'auto' ? autoWeatherLevel(quality) : level
  return { ...p, active, quality, renderPath, skyStyle, level, resolvedLevel, weatherState: p.weather ?? { kind: 'clear', intensity: 1 } }
}

// ---- lab shader fixes ------------------------------------------------------------------------------------------

/**
 * `?fix=sheen` (lab only, the viewer never applies it by itself): Babylon 9.28's PBR clustered-light include
 * (`pbrClusteredLightingFunctions`, WGSL and GLSL) calls `computeSheenLighting(preInfo, normalW, …)`, but inside
 * `computeClusteredLighting` the normal is the parameter `N`. So once a ClusteredLightContainer exists (NL, Medium+),
 * every material with sheen (RND-M's cloth class: tents, flags, signs) fails to compile, and on WebGPU the invalid
 * pipeline in the prepass drops the whole frame (a black screen at any time of day). The patch swaps the name in the
 * shader store before any PBR shader compiles; it shows the fix the renderer needs (lab report). Returns what it did.
 */
export async function applyLabShaderFixes(fixes: readonly string[]): Promise<string[]> {
  const done: string[] = []
  if (fixes.includes('sheen')) {
    const [{ ShaderStore }] = await Promise.all([
      import('@babylonjs/core'),
      import('@babylonjs/core/ShadersWGSL/ShadersInclude/pbrClusteredLightingFunctions.js'),
      import('@babylonjs/core/Shaders/ShadersInclude/pbrClusteredLightingFunctions.js'),
    ])
    const name = 'pbrClusteredLightingFunctions'
    for (const store of [ShaderStore.IncludesShadersStoreWGSL, ShaderStore.IncludesShadersStore]) {
      const src = store[name]
      if (src && src.includes('computeSheenLighting(preInfo,normalW')) {
        store[name] = src.split('computeSheenLighting(preInfo,normalW').join('computeSheenLighting(preInfo,N')
        done.push(store === ShaderStore.IncludesShadersStoreWGSL ? 'sheen (WGSL)' : 'sheen (GLSL)')
      }
    }
  }
  return done
}

// ---- the §5.1 rows as data -------------------------------------------------------------------------------------

export type RenderRowKey = Exclude<keyof RenderQuality, 'path'>
export type SkyRowKey = keyof SkyQuality

/** Every render row the panel offers (all of RenderQuality but the material path, which needs a reload). */
export const RENDER_ROW_KEYS = (Object.keys(RENDER_PRESETS.high) as (keyof RenderQuality)[]).filter((k): k is RenderRowKey => k !== 'path')
export const SKY_ROW_KEYS = Object.keys(SKY_PRESETS.high) as SkyRowKey[]

/** Extra values a row offers beyond the four presets' (for A/B work the presets never pair). */
const ROW_EXTRAS: Partial<Record<RenderRowKey, readonly unknown[]>> = {
  bloom: [0, 0.5, 1],
  aa: ['msaa', 'fxaa', 'taa'],
  ssr: ['off', 'puddles', 'always'],
  toneMap: ['neutral', 'filmic'],
  renderScale: [1, 0.75, 0.5],
}

export interface RowChoice {
  value: unknown
  /** The presets whose value this is (empty for an extra). */
  presets: WorldQuality[]
  label: string
}

/** A short text for a row value (shadow sizes, cube sizes, flags that are on). */
export function summarize(v: unknown): string {
  if (v === null || v === undefined || v === false) return 'off'
  if (v === true) return 'on'
  if (typeof v !== 'object') return String(v)
  const o = v as Record<string, unknown>
  if ('mapSize' in o) return `${o.mapSize}×${o.cascades} ${o.distanceM} m${o.foliageM ? ` fol ${o.foliageM}` : ''}${o.terrain ? ' +terr' : ''}${o.props ? ' +props' : ''}`
  if ('cubeSize' in o) return `${o.cubeSize}² / ${o.refreshS} s`
  if ('cluster' in o) return `cluster ${o.cluster}${o.terrainSplat ? ' +terrain splat' : ''}`
  if ('samples' in o && 'halfRes' in o) return `${o.halfRes ? 'half' : 'full'} ${o.samples}`
  if ('width' in o && 'steps' in o) return `${o.width}×${o.height} ${o.steps} st ${o.refreshS} s`
  if ('kind' in o && 'taps' in o) return o.kind === 'retail' ? 'retail' : `cumulus ${o.taps}+${o.lightTaps}${o.cirrus ? ' cirrus' : ''}${o.detailOctave ? ' detail' : ''}`
  if ('perFace' in o) return `${o.perFace}${o.twinkle ? ' twinkle' : ''}${o.milkyWay ? ' MW' : ''}`
  const on = Object.entries(o).filter(([, x]) => x === true).map(([k]) => k)
  return on.length ? on.join(' ') : 'none'
}

/** The distinct values of one row across the four presets (+ the extras), labelled with the presets that use them. */
export function rowChoices<T extends object>(table: Readonly<Record<WorldQuality, Readonly<T>>>, key: keyof T, extras: readonly unknown[] = []): RowChoice[] {
  const out: RowChoice[] = []
  const find = (v: unknown) => out.find(c => JSON.stringify(c.value) === JSON.stringify(v))
  for (const q of PRESETS) {
    const v = table[q][key]
    const hit = find(v)
    if (hit) hit.presets.push(q)
    else out.push({ value: v, presets: [q], label: '' })
  }
  for (const v of extras) if (!find(v)) out.push({ value: v, presets: [], label: '' })
  for (const c of out) c.label = `${summarize(c.value)}${c.presets.length ? ` (${c.presets.join('/')})` : ''}`
  return out
}

export function renderRowChoices(key: RenderRowKey): RowChoice[] {
  return rowChoices(RENDER_PRESETS, key, ROW_EXTRAS[key] ?? [])
}

export function skyRowChoices(key: SkyRowKey): RowChoice[] {
  return rowChoices(SKY_PRESETS, key)
}

/** A preset's block with some rows replaced. */
export function withRows<T extends object>(base: Readonly<T>, rows: ReadonlyMap<keyof T, unknown>): T {
  const out = { ...base } as T
  for (const [k, v] of rows) (out as Record<keyof T, unknown>)[k] = v
  return out
}

// ---- weather and clock -----------------------------------------------------------------------------------------

/** How long a held state has already rained when the lab starts it (the game's override soaks the same way). */
export const SOAK_S = 1800

/** The surface state after `SOAK_S` seconds of `p` from dry. */
export function soaked(p: Pick<WeatherParams, 'rain' | 'sun' | 'windMs'>): SurfaceState {
  return stepSurface({ wet: 0, puddle: 0 }, p, SOAK_S)
}

/**
 * The lab's WeatherFrame (the game builds it in WX-C's WeatherClient; the viewer has no server): the held state's
 * parameters, a surface state, a gusting wind from `windDir` (radians, 0 = +X), and the flash of the last strike.
 */
export function labFrame(p: Readonly<WeatherParams>, surface: Readonly<SurfaceState>, nowMs: number, strikeAtMs: number | null, windDir = 0.35): WeatherFrame {
  const tS = nowMs / 1000
  const gust = 0.6 * Math.sin(tS * 1.7) + 0.4 * Math.sin(tS * 4.3 + 1.3)
  const flash = strikeAtMs === null ? 0 : flashAt({ at: strikeAtMs }, nowMs)
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
  return {
    cloud: p.cloud,
    cloudDark: p.cloudDark,
    cirrus: p.cirrus,
    rain: clamp01(p.rain),
    fog: clamp01(p.fog),
    sun: p.sun,
    desat: p.desat,
    windX: Math.cos(windDir),
    windZ: -Math.sin(windDir),
    windMs: p.windMs,
    gustMs: Math.max(0, p.windMs * (1 + p.gust * gust)),
    wet: clamp01(surface.wet),
    puddle: clamp01(surface.puddle),
    flash,
    flashX: flash > 0 ? Math.cos(windDir + 1) : 0,
    flashZ: flash > 0 ? -Math.sin(windDir + 1) : 0,
    time: ((tS % 3600) + 3600) % 3600,
  }
}

/**
 * A running clock that shows solar time `t` at `nowMs` and lasts `minutes` real minutes per game day (the server's
 * maths: night speed-up and season from DEFAULT_CLOCK). Day 14 puts a near-full moon in the night sky.
 */
export function fastClockState(t: number, nowMs: number, minutes: number): WorldClockState {
  const [lo, hi] = CLOCK_LIMITS.dayMs
  return {
    anchorMs: Math.floor(nowMs),
    anchorDays: 14 + phaseForSolarTime(((t % 1) + 1) % 1, DEFAULT_CLOCK.nightSpeedup),
    dayMs: Math.round(Math.min(hi, Math.max(lo, minutes * 60_000))),
    running: true,
    nightSpeedup: DEFAULT_CLOCK.nightSpeedup,
    declination: DEFAULT_CLOCK.declination,
  }
}

// ---- the panel -------------------------------------------------------------------------------------------------

export interface RenderPanelHost extends BenchHost {
  readonly gpu: GpuInfo
  /** 'WebGPU' | 'WebGL2' | 'WebGL1'. */
  readonly kind: string
  /** Puts the orbit camera at the bench view (the spawn, fixed angles). */
  benchView(): void
  /** The camera the page renders with. */
  camera(): Camera | null
}

/**
 * The lab panel: mounted into world.html's `#render-panel`. It is also the suite's `LabControls` and, as
 * `window.sroWorld.lab`, a console handle (bench, suite, normalCheck, probeCube, screenshot).
 */
export class RenderPanel implements LabControls {
  private preset: WorldQuality
  private readonly renderRows = new Map<RenderRowKey, unknown>()
  private readonly skyRows = new Map<SkyRowKey, unknown>()
  private kind: WeatherKind
  private intensity: number
  private level: WeatherLevel | 'auto'
  private surface: SurfaceState = { wet: 0, puddle: 0 }
  private wetManual: number | null = null
  private puddleManual: number | null = null
  private strikeAt: number | null = null
  private toneMap: ToneMap | null
  private lut: LutKey | null
  private exposureTrim: number
  private clockMin: number | null
  private readonly out: HTMLPreElement
  private readonly info: HTMLDivElement
  private readonly controls = new Map<string, HTMLSelectElement | HTMLInputElement>()
  private busy = false
  /** The last results (console / the report). */
  readonly results: { suite: SuiteRow[]; text: string[] } = { suite: [], text: [] }

  constructor(readonly root: HTMLElement, readonly host: RenderPanelHost, readonly cfg: LabConfig) {
    this.preset = cfg.quality
    this.kind = cfg.weatherState.kind
    this.intensity = cfg.weatherState.intensity
    this.level = cfg.level
    this.toneMap = cfg.toneMap
    this.lut = cfg.lut
    this.exposureTrim = cfg.exposure ?? 1
    this.clockMin = cfg.clockMin
    if (cfg.active) this.surface = soaked(this.params())
    root.innerHTML = ''
    this.info = document.createElement('div')
    this.info.className = 'lab-info muted'
    this.out = document.createElement('pre')
    this.out.className = 'lab-out'
    this.build()
    if (cfg.active) {
      this.applyImage()
      if (cfg.clockMin !== null) this.setClockMinutes(cfg.clockMin)
    }
    host.scene.onBeforeRenderObservable.add(() => this.tick(), -1, true)
    window.setInterval(() => this.renderInfo(), 500)
  }

  get world(): World {
    return this.host.world
  }

  get path(): RenderPath {
    return this.world.render.mode
  }

  private get post(): RenderPost | null {
    const p = this.world.render.post
    return p instanceof RenderPost ? p : null
  }

  private params(): WeatherParams {
    return weatherParams(this.kind, this.intensity)
  }

  // ---- per frame ----

  private tick(): void {
    if (this.cfg.fixes.includes('prepass')) this.guardPrePass()
    if (!this.cfg.active) return
    const now = performance.now()
    const dt = Math.min(1, this.host.engine.getDeltaTime() / 1000)
    const p = this.params()
    if (dt > 0) this.surface = stepSurface(this.surface, p, dt)
    const surface = { wet: this.wetManual ?? this.surface.wet, puddle: this.puddleManual ?? this.surface.puddle }
    if (this.strikeAt !== null && now - this.strikeAt > 3000) this.strikeAt = null
    this.world.setWeather(labFrame(p, surface, now, this.strikeAt))
  }

  /**
   * `?fix=prepass` (lab only): on High, once rain starts, Babylon's PrePassRenderer re-evaluates itself while a render
   * target with its own camera renders (the new weather materials mark it dirty); that camera has no post-processes, so
   * the prepass switches off and `imageProcessingConfiguration.applyByPostProcess` goes back to false: SSR stops, the
   * materials tone-map on top of the post stack, and a post rebuild in that state throws in SSR every frame. Marking it
   * dirty again from here (World.update's camera is the main one) restores both. The lab report has the details.
   */
  private guardPrePass(): void {
    const pp = this.host.scene.prePassRenderer
    const post = this.post
    if (pp && !pp.enabled && post?.plan.prepass && post.stages.length) pp.markAsDirty()
  }

  // ---- LabControls (the suite, the console) ----

  setPreset(q: WorldQuality): void {
    // Unchanged: no rebuild (a post rebuild costs frames; the suite sets the preset for every case).
    if (q === this.preset && !this.renderRows.size && !this.skyRows.size && this.world.render.quality === RENDER_PRESETS[q]) return
    this.preset = q
    this.renderRows.clear()
    this.skyRows.clear()
    this.world.setQuality(q)
    this.world.setWeatherLevel(this.resolvedLevel())
    this.applyImage()
    this.syncControls()
    this.syncUrl()
  }

  setWeather(kind: 'clear' | 'storm' | 'rain' | WeatherKind | null, level?: WeatherLevel): void {
    this.kind = kind ?? 'clear'
    this.intensity = 1
    this.surface = kind ? soaked(this.params()) : { wet: 0, puddle: 0 }
    this.wetManual = this.puddleManual = null
    this.level = level ?? 'auto'
    this.world.setWeatherLevel(this.resolvedLevel())
    this.syncControls()
    this.syncUrl()
  }

  setTime(t: number): void {
    this.clockMin = null
    this.world.setTimeOfDay(t)
    this.syncControls()
  }

  setSkyStyle(s: SkyStyle): void {
    this.world.setSkyStyle(s)
    this.syncControls()
    this.syncUrl()
  }

  setRow(key: string, fromPreset: WorldQuality | undefined, value?: unknown): void {
    if ((SKY_ROW_KEYS as string[]).includes(key)) {
      const k = key as SkyRowKey
      if (fromPreset) this.skyRows.set(k, SKY_PRESETS[fromPreset][k])
      else if (value !== undefined) this.skyRows.set(k, value)
      else this.skyRows.delete(k)
    } else {
      const k = key as RenderRowKey
      if (fromPreset) this.renderRows.set(k, RENDER_PRESETS[fromPreset][k])
      else if (value !== undefined) this.renderRows.set(k, value)
      else this.renderRows.delete(k)
    }
    this.applyRows()
    this.syncControls()
  }

  benchView(): void {
    this.host.benchView()
  }

  async idle(timeoutMs = 30_000): Promise<void> {
    const t0 = performance.now()
    await Promise.race([this.world.objectsReady, new Promise(r => setTimeout(r, timeoutMs))])
    for (;;) {
      const st = this.world.stream?.stats
      if (!st || (st.jobs === 0 && st.fetching === 0) || performance.now() - t0 > timeoutMs) return
      await new Promise(r => setTimeout(r, 100))
    }
  }

  /** The level in force: the chosen one, or the preset's for 'auto'. */
  resolvedLevel(): WeatherLevel {
    return this.level === 'auto' ? autoWeatherLevel(this.preset) : this.level
  }

  /** Starts a strike's flash now (the sky, the env and the PBR flash light follow the frame). */
  strike(): void {
    this.strikeAt = performance.now()
  }

  /** Runs a local clock at `minutes` real minutes per game day from the current time (null: freeze). */
  setClockMinutes(minutes: number | null): void {
    this.clockMin = minutes
    if (minutes === null) this.world.setTimeOfDay(this.world.timeOfDay)
    else this.world.setClock(fastClockState(this.world.timeOfDay, Date.now(), minutes), () => Date.now())
    this.syncControls()
  }

  // ---- applying ----

  private applyRows(): void {
    const q = this.preset
    if (!this.renderRows.size && !this.skyRows.size) {
      this.world.setQuality(q)
      return
    }
    this.world.setQuality({
      ...QUALITY_PRESETS[q],
      render: withRows(RENDER_PRESETS[q] as RenderQuality, this.renderRows as Map<keyof RenderQuality, unknown>),
      sky: withRows(SKY_PRESETS[q] as SkyQuality, this.skyRows),
    })
  }

  private applyImage(): void {
    const post = this.post
    if (!post) return
    post.exposureTrim = this.exposureTrim
    post.setToneMap(this.toneMap)
    const grade = post.grade
    if (grade) for (const k of LUT_KEYS) grade.setStrip(k, builtinLutStrip(this.lut ?? k))
  }

  // ---- measurements ----

  private log(s: string): void {
    this.results.text.push(s)
    this.out.textContent = this.results.text.slice(-60).join('\n')
    this.out.scrollTop = this.out.scrollHeight
    console.log('[lab]', s)
  }

  private async guarded(what: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy) {
      this.log(`busy: ${what} waits for the running measurement`)
      return
    }
    this.busy = true
    try {
      await fn()
    } catch (err) {
      this.log(`${what} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    } finally {
      this.busy = false
    }
  }

  /** The bench on the current view: 1080p, and 4K for the GPU estimate when `uhd`. */
  bench(uhd = true): Promise<void> {
    return this.guarded('bench', async () => {
      const label = this.describe()
      this.log(`bench: ${label} (the loop pauses)`)
      const hd = await benchFrames(this.host, label, { width: 1920, height: 1080 })
      const uhdS = uhd ? await benchFrames(this.host, label, { width: 3840, height: 2160, frames: 45 }) : null
      const row: SuiteRow = { label: label.slice(0, 34), hd, uhd: uhdS, gpuEstMs: uhdS ? uhdS.wallMs / 4 : null }
      this.results.suite.push(row)
      this.log(formatSuite([row]))
    })
  }

  /** The §5.2 suite on this page's material path (the Classic path and the PBR path are two page loads). */
  suite(which: 'presets' | 'features' | 'all' = 'all', uhd = true): Promise<void> {
    return this.guarded('suite', async () => {
      const before = { preset: this.preset, t: this.world.timeOfDay, sky: this.world.skyStyle, kind: this.kind, level: this.level }
      const cases = suiteCases(this.path, which)
      this.log(`suite (${this.path}, ${which}): ${cases.length} cases, 1080p${uhd ? ' + 4K' : ''}; ${this.gpuLine()}`)
      this.log(formatSuite([]))
      const rows = await runSuite(this.host, this, cases, { uhd, log: s => this.log(s) })
      this.results.suite.push(...rows)
      this.setPreset(before.preset)
      this.setWeather(before.kind === 'clear' ? null : before.kind, before.level === 'auto' ? undefined : before.level)
      this.setSkyStyle(before.sky)
      this.setTime(before.t)
      this.log('suite done')
    })
  }

  normalCheck(): Promise<void> {
    return this.guarded('normal check', async () => {
      this.log('DETAIL H8 normal check (normal_gl through normalInvert, converter Z mirror):')
      this.log(formatNormalCheck(await runNormalCheck(this.host)))
    })
  }

  probeCube(): Promise<void> {
    return this.guarded('cube probe', async () => {
      for (const size of [32, 64]) this.log(formatCubeProbe(await probeCube(this.host, size)))
    })
  }

  /**
   * A PNG of the frame exactly as the canvas shows it (post stack included), as a data URL: one frame rendered at
   * `width` × `height` and read back from the swap chain. (Babylon's render-target screenshot waits for scene.isReady,
   * which a lab view with night lights never reached in a hidden pane, and re-renders without the TAA history.)
   */
  async screenshot(width = 1280, height = 720): Promise<string> {
    const { engine, scene } = this.host
    const resize = engine.getRenderWidth() !== width || engine.getRenderHeight() !== height
    this.host.pause()
    try {
      if (resize) {
        engine.setSize(width, height, true)
        for (let i = 0; i < 8; i++) {
          engine.beginFrame()
          scene.render()
          engine.endFrame()
        }
      }
      engine.beginFrame()
      scene.render()
      const read = engine.readPixels(0, 0, width, height, true)
      engine.endFrame()
      const px = new Uint8Array((await read).buffer)
      // WebGPU canvases are usually BGRA; WebGL rows run bottom-up.
      const fmt = (navigator as Navigator & { gpu?: { getPreferredCanvasFormat(): string } }).gpu?.getPreferredCanvasFormat()
      const bgra = engine.isWebGPU && fmt === 'bgra8unorm'
      const flip = !engine.isWebGPU
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      const img = ctx.createImageData(width, height)
      for (let y = 0; y < height; y++) {
        const src = (flip ? height - 1 - y : y) * width * 4
        for (let x = 0; x < width; x++) {
          const i = src + x * 4
          const o = (y * width + x) * 4
          img.data[o] = px[bgra ? i + 2 : i]!
          img.data[o + 1] = px[i + 1]!
          img.data[o + 2] = px[bgra ? i : i + 2]!
          img.data[o + 3] = 255
        }
      }
      ctx.putImageData(img, 0, 0)
      return canvas.toDataURL('image/png')
    } finally {
      if (resize) engine.resize(true)
      this.host.resume()
    }
  }


  /** One line for the log: path, preset, overrides, sky, time, weather. */
  describe(): string {
    const rows = [...this.renderRows.keys(), ...this.skyRows.keys()]
    return `${this.path} ${this.preset}${rows.length ? ` [${rows.join(',')}]` : ''} sky ${this.world.skyStyle} ${formatTime(this.world.timeOfDay)} ${this.kind}/${this.resolvedLevel()}`
  }

  private gpuLine(): string {
    const g = this.host.gpu
    return `${this.host.kind} · ${g.vendor || '?'} ${g.architecture} · ${g.maxInterStageShaderVariables} varyings · ${g.features.join(', ') || 'no features'}`
  }

  // ---- DOM ----

  private build(): void {
    const root = this.root
    const head = document.createElement('header')
    head.innerHTML = '<h1>Render lab</h1>'
    const hide = button('–', () => root.classList.toggle('collapsed'), 'Collapse the lab panel')
    head.appendChild(hide)
    root.append(head, this.info)

    // Look
    const look = section(root, 'Look')
    this.select(look, 'preset', 'Preset', PRESETS.map(q => [q, q === 'low' ? 'low (Classic)' : q]), this.preset, v => {
      const q = v as WorldQuality
      if (RENDER_PRESETS[q].path !== this.path && !this.cfg.render) return this.reload({ preset: q, render: null })
      this.setPreset(q)
    })
    this.select(look, 'path', 'Material path', [['classic', 'classic (reload)'], ['pbr', 'pbr (reload)']], this.path, v => this.reload({ render: v }))
    this.select(look, 'sky', 'Sky', [['modern', 'modern'], ['classic', 'classic (retail)']], this.world.skyStyle, v => this.setSkyStyle(v as SkyStyle))

    // Time
    const time = section(root, 'Time')
    this.select(time, 'clock', 'Clock', [['', 'frozen (slider)'], ['2', '2 min / day'], ['10', '10 min / day'], ['120', '120 min / day (game)']],
      this.clockMin === null ? '' : String(this.clockMin), v => this.setClockMinutes(v ? Number(v) : null))
    const times = document.createElement('div')
    times.className = 'lab-buttons'
    for (const t of [0, 0.25, 0.3, 0.5, 0.6, 0.7, 0.77]) times.appendChild(button(formatTime(t), () => this.setTime(t), `t = ${t}`))
    time.appendChild(times)

    // Weather
    const wx = section(root, 'Weather')
    this.select(wx, 'weather', 'State', WEATHER_KINDS.map(k => [k, k]), this.kind, v => {
      this.kind = v as WeatherKind
      this.syncUrl()
    })
    this.range(wx, 'intensity', 'Rain intensity', 0.4, 1, 0.05, this.intensity, v => {
      this.intensity = v
      this.syncUrl()
    })
    this.select(wx, 'level', 'Level', [['auto', 'auto (preset)'], ...WEATHER_LEVELS.map(l => [l, l] as [string, string])], this.level, v => {
      this.level = v as WeatherLevel | 'auto'
      this.world.setWeatherLevel(this.resolvedLevel())
      this.syncUrl()
    })
    this.range(wx, 'wet', 'Wetness', -0.05, 1, 0.05, this.wetManual ?? -0.05, v => { this.wetManual = v < 0 ? null : v }, 'left of 0 = the soaking model')
    this.range(wx, 'puddle', 'Puddles', -0.05, 1, 0.05, this.puddleManual ?? -0.05, v => { this.puddleManual = v < 0 ? null : v }, 'left of 0 = the soaking model')
    const wxButtons = document.createElement('div')
    wxButtons.className = 'lab-buttons'
    wxButtons.append(
      button('Soak', () => { this.surface = soaked(this.params()) }, `the surface after ${SOAK_S / 60} min of this state`),
      button('Dry', () => { this.surface = { wet: 0, puddle: 0 } }),
      button('Lightning', () => this.strike()),
    )
    wx.appendChild(wxButtons)

    // Image
    const img = section(root, 'Image (PBR)')
    this.range(img, 'exposure', 'Exposure trim (EV)', -2, 2, 0.1, Math.log2(this.exposureTrim), v => {
      this.exposureTrim = 2 ** v
      this.applyImage()
      this.syncUrl()
    })
    this.select(img, 'tonemap', 'Tone map', [['', 'preset'], ['neutral', 'PBR Neutral'], ['filmic', 'ACES (filmic)']], this.toneMap ?? '', v => {
      this.toneMap = (v || null) as ToneMap | null
      this.applyImage()
      this.syncUrl()
    })
    this.select(img, 'lut', 'LUT key', [['', 'auto (time × weather)'], ...LUT_KEYS.map(k => [k, k] as [string, string])], this.lut ?? '', v => {
      this.lut = (v || null) as LutKey | null
      this.applyImage()
      this.syncUrl()
    })
    const postOpts = document.createElement('div')
    postOpts.className = 'lab-checks'
    postOpts.append(
      check('SSAO (reload)', this.cfg.ssao, on => this.reload({ ssao: on ? '1' : null })),
      check('TAA reprojection (reload)', this.cfg.taaReprojection, on => this.reload({ taaReproj: on ? '1' : null })),
    )
    img.appendChild(postOpts)

    // §5.1 rows
    const rows = details(root, '§5.1 rows (render)')
    for (const key of RENDER_ROW_KEYS) {
      const choices = renderRowChoices(key)
      this.select(rows, `r.${key}`, key, [['', 'preset'], ...choices.map((c, i) => [String(i), c.label] as [string, string])], '', v => {
        this.setRow(key, undefined, v === '' ? undefined : choices[Number(v)]!.value)
      })
    }
    const skyRows = details(root, '§5.1 rows (sky)')
    for (const key of SKY_ROW_KEYS) {
      const choices = skyRowChoices(key)
      this.select(skyRows, `s.${key}`, key, [['', 'preset'], ...choices.map((c, i) => [String(i), c.label] as [string, string])], '', v => {
        this.setRow(key, undefined, v === '' ? undefined : choices[Number(v)]!.value)
      })
    }
    rows.appendChild(button('Reset rows', () => {
      this.renderRows.clear()
      this.skyRows.clear()
      this.applyRows()
      this.syncControls()
    }))

    // Tools
    const tools = section(root, 'Measure')
    const tb = document.createElement('div')
    tb.className = 'lab-buttons'
    tb.append(
      button('Bench view', () => void this.bench(true), '1080p + 4K ÷ 4 of this view (bench.ts method)'),
      button('§5.2 suite', () => void this.suite('all', true), 'presets × noon/storm/night + feature deltas; minutes'),
      button('Normals (H8)', () => void this.normalCheck()),
      button('Cube (D14)', () => void this.probeCube()),
      button('Camera', () => this.benchView(), 'the bench view: spawn, fixed angles'),
      button('Shot', () => void this.saveShot(), 'save a PNG of this view'),
      button('Copy', () => void navigator.clipboard?.writeText(this.results.text.join('\n'))),
    )
    tools.append(tb, this.out)
  }

  private async saveShot(): Promise<void> {
    try {
      const url = await this.screenshot()
      const a = document.createElement('a')
      a.href = url
      a.download = `lab-${this.path}-${this.preset}-${this.world.skyStyle}-${formatTime(this.world.timeOfDay).replace(':', '')}-${this.kind}.png`
      a.click()
    } catch (err) {
      this.log(`screenshot failed: ${String(err)}`)
    }
  }

  private select(parent: HTMLElement, id: string, label: string, options: readonly (readonly [string, string])[], value: string, onChange: (v: string) => void): void {
    const row = document.createElement('label')
    row.className = 'row'
    row.textContent = label
    const sel = document.createElement('select')
    for (const [v, text] of options) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = text
      sel.appendChild(o)
    }
    sel.value = value
    sel.addEventListener('change', () => onChange(sel.value))
    row.appendChild(sel)
    parent.appendChild(row)
    this.controls.set(id, sel)
  }

  private range(parent: HTMLElement, id: string, label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void, title?: string): void {
    const row = document.createElement('label')
    row.className = 'row'
    row.textContent = label
    if (title) row.title = title
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    input.value = String(value)
    const out = document.createElement('output')
    const show = () => { out.textContent = Number(input.value) < 0 && min < 0 && id !== 'exposure' ? 'auto' : Number(input.value).toFixed(2) }
    show()
    input.addEventListener('input', () => {
      show()
      onInput(Number(input.value))
    })
    row.append(input, out)
    parent.appendChild(row)
    this.controls.set(id, input)
  }

  /** Puts the controls back in line with the state (after the suite or a console call). */
  private syncControls(): void {
    const set = (id: string, v: string) => {
      const c = this.controls.get(id)
      if (c && c.value !== v) c.value = v
    }
    set('preset', this.preset)
    set('sky', this.world.skyStyle)
    set('weather', this.kind)
    set('level', this.level)
    set('clock', this.clockMin === null ? '' : String(this.clockMin))
    for (const key of RENDER_ROW_KEYS) {
      const v = this.renderRows.get(key)
      set(`r.${key}`, v === undefined ? '' : String(renderRowChoices(key).findIndex(c => JSON.stringify(c.value) === JSON.stringify(v))))
    }
    for (const key of SKY_ROW_KEYS) {
      const v = this.skyRows.get(key)
      set(`s.${key}`, v === undefined ? '' : String(skyRowChoices(key).findIndex(c => JSON.stringify(c.value) === JSON.stringify(v))))
    }
  }

  /** Keeps the URL in step with the look, so a reload (or a shared link) shows the same view. */
  private syncUrl(): void {
    if (!this.cfg.active) return
    const url = new URL(location.href)
    const s = url.searchParams
    s.set('preset', this.preset)
    s.set('sky', this.world.skyStyle)
    if (this.kind === 'clear') s.delete('weather')
    else s.set('weather', this.kind === 'rain' && this.intensity < 1 ? `rain:${this.intensity}` : this.kind)
    if (this.level === 'auto') s.delete('wxlevel')
    else s.set('wxlevel', this.level)
    if (this.toneMap) s.set('tonemap', this.toneMap)
    else s.delete('tonemap')
    if (this.lut) s.set('lut', this.lut)
    else s.delete('lut')
    if (this.exposureTrim !== 1) s.set('exposure', this.exposureTrim.toFixed(3))
    else s.delete('exposure')
    history.replaceState(null, '', url)
  }

  private reload(set: Record<string, string | null>): void {
    const url = new URL(location.href)
    url.searchParams.set('preset', this.preset)
    for (const [k, v] of Object.entries(set)) {
      if (v === null) url.searchParams.delete(k)
      else url.searchParams.set(k, v)
    }
    location.href = url.toString()
  }

  private renderInfo(): void {
    const w = this.world
    const sky = w.skyState
    const post = this.post
    const lines = [
      this.gpuLine(),
      `${this.describe()}${w.worldClock ? ` · clock ${this.clockMin} min/day` : ''}`,
    ]
    if (this.path === 'pbr') {
      const plan = post?.plan
      lines.push(`post ${plan ? plan.stages.join(' → ') || 'none' : 'none'}${plan?.dropped.length ? ` (dropped: ${plan.dropped.map(d => d.split(':')[0]).join(', ')})` : ''}`)
      lines.push(`exposure ${(sky.exposure * (post?.exposureTrim ?? 1)).toFixed(2)} (sky ${sky.exposure.toFixed(2)}) · tone ${plan?.toneMap ?? '-'} · lut ${this.lut ?? 'auto'}${post?.ssrActive ? ' · ssr on' : ''}`)
    }
    const f = w.weatherState
    lines.push(`weather rain ${f.rain.toFixed(2)} wet ${f.wet.toFixed(2)} puddle ${f.puddle.toFixed(2)} wind ${f.gustMs.toFixed(1)} m/s${f.flash > 0 ? ` flash ${f.flash.toFixed(2)}` : ''}`)
    lines.push(`sun ${sky.sunElevationDeg.toFixed(1)}° night ${sky.night.toFixed(2)}`)
    this.info.textContent = lines.join('\n')
  }
}

function section(parent: HTMLElement, title: string): HTMLElement {
  const s = document.createElement('section')
  const h = document.createElement('h2')
  h.textContent = title
  s.appendChild(h)
  parent.appendChild(s)
  return s
}

function details(parent: HTMLElement, title: string): HTMLElement {
  const d = document.createElement('details')
  const s = document.createElement('summary')
  s.textContent = title
  d.appendChild(s)
  parent.appendChild(d)
  return d
}

function button(text: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = text
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}

function check(text: string, on: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const l = document.createElement('label')
  const c = document.createElement('input')
  c.type = 'checkbox'
  c.checked = on
  c.addEventListener('change', () => onChange(c.checked))
  l.append(c, ` ${text}`)
  return l
}


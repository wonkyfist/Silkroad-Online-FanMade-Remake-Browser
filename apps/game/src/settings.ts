/**
 * Client settings, per viewer (docs/UX_GAPS.md §4.3, lane UX-A): graphics, interface and controls, kept in
 * localStorage['sro.settings']. Every read and write is guarded; defaults apply when storage is missing, blocked or
 * corrupt, and every value is clamped to its range on load and on `set`. No audio here: docs/SOUND.md §5.2 owns
 * volumes and mute (audio/settings.ts).
 * Also: `qualityFor` (graphics preset x sight range -> World.setQuality), `weatherLevelFor` (graphics.weather ->
 * World.setWeatherLevel) and `applyGraphics` (resolution scale).
 *
 * Wave 9 (GAME, docs/WAVE_PLAN3.md §5.1, §6.15): `effectiveGraphics` is the one place that decides what this device
 * and these settings render (the rollout gate of rollout.ts, the 16-varying cap, the Advanced rows); `worldQualityFor`,
 * `weatherLevelFor` and `weatherShown` read it. Also the first-run device check (`recommendGraphics`, `runFirstRun`),
 * the frame-time watchdog (`FrameWatchdog`) and the render-scale hand-off to FSR1 (`setRenderScaleHandler`).
 */
import type { AbstractEngine } from '@babylonjs/core'
import {
  BLOOM_LEVELS,
  QUALITY_PRESETS,
  RENDER_PRESETS,
  SKY_PRESETS,
  TEXTURE_SETTINGS as WR_TEXTURE_SETTINGS,
  gpuInfoFromEngine,
  isTextureSetting,
  setPageRemasterSets,
  setPageTextureSetting,
  textureTierFor,
  withBloom,
  withLightShafts,
  type BloomLevel,
  type GpuInfo,
  type LightShaftLevel,
  type QualitySettings,
  type RenderPath,
  type RenderQuality,
  type ScatterLevel,
  type SkyQuality,
  type SkyStyle,
  type TextureSetting,
  type TextureTier,
  type WeatherLevel,
  type WorldQuality,
} from '@sro/world-render'
import { RENDER_ROLLOUT, type RenderRollout } from './rollout.ts'
import { UI_SCALE_MODES, type UiScaleMode } from './ui/kit/scale.ts'

export type GraphicsPreset = WorldQuality
export type Resolution = 1 | 0.75 | 0.5
export type SightRange = 0 | 1 | 2 | 3
export type ItemNames = 'always' | 'near' | 'hover'
export type CameraMode = 'free' | 'third' | 'quarter'
/** Grass and plants (W5-G, world-render scatter.ts); 'auto' follows the graphics preset. */
export type ScatterSetting = 'auto' | ScatterLevel
/** Wave 9 sky style (docs/SKY.md §9.1): the modern atmosphere or the 2005 retail sky. */
export type SkySetting = 'modern' | 'classic'
/** Wave 9 weather level (docs/WEATHER.md §9.1); 'auto' follows the preset (iGPU → low, GAME/WX-C). */
export type WeatherSetting = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'ultra'
/** Wave 9 tone mapping (docs/RENDER.md §5.2). */
export type ToneMapSetting = 'neutral' | 'filmic'
/** Options → Graphics → Bloom (render/quality.ts BLOOM_LOOKS): off, only the brightest lights, or the shipped look. */
export type BloomSetting = BloomLevel
/** Wave 10 (docs/WAVE_PLAN6.md §4.2, GRASS_LIFE §8.3): the wildlife (World.life: butterflies, birds, fireflies) on or off. */
export type WildlifeSetting = 'on' | 'off'
/**
 * Wave 11 (docs/TOWN_LIFE.md §8.2, WAVE_PLAN7 D10/D26): Options → Graphics → Town life, the Jangan crowd, animals and
 * bubbles (World.town). 'auto' is Full, Low on an Apple or integrated GPU (`townLifeFor`), and nothing on Low (Classic).
 */
export type TownLifeSetting = 'auto' | 'off' | 'low' | 'full'
/** What the town runs (`townLifeFor`): 'low' halves the counts. */
export type TownLifeLevel = 'off' | 'low' | 'full'
/**
 * Wave 10 (GRASS_LIFE §1): which grass the world draws: the retail scatter, or our own field. The world-render name is
 * `ScatterStyle` (scatter.ts); the preset rows (QUALITY_PRESETS) say which style each preset draws.
 */
export type GrassStyle = 'retail' | 'field'
/**
 * Wave 12 (docs/TREES.md Part W, WAVE_PLAN8 D9, §3.4): Options → Graphics → Trees. 'new' draws our 35 species in place of
 * the retail tree and plant models (`WorldModel.treeSwap`), 'retail' keeps the retail ones (the A/B and the fallback).
 * The PBR presets only: Low (Classic) and the Low guard always draw retail (`EffectiveGraphics.trees`).
 */
export type TreesSetting = 'new' | 'retail'

/**
 * Wave 9 "Advanced" graphics overrides (docs/WAVE_PLAN3.md §4.3): each is 'auto' (the preset's value, render/quality.ts
 * RENDER_PRESETS) or a fixed value. GAME maps them onto QualitySettings.render.
 */
export interface AdvancedGraphics {
  /** Sun shadows: off, or the shadow block of that preset. */
  shadows: 'auto' | 'off' | 'medium' | 'high' | 'ultra'
  /** SSAO: off, half or full resolution. */
  ao: 'auto' | 'off' | 'half' | 'full'
  /** SSR: off, only on puddles, or always. */
  reflections: 'auto' | 'off' | 'puddles' | 'always'
  aa: 'auto' | 'msaa' | 'fxaa' | 'taa'
  toneMap: ToneMapSetting
  /**
   * Mini-wave w12r (GODRAYS, render/volumetrics): the sun shafts' level; 'auto' is the preset's (Medium 'low', High and
   * Ultra 'high'). Low / Classic never draws them (no post stack), so the row is hidden there.
   */
  lightShafts: 'auto' | LightShaftLevel
  /**
   * Wave 10 (docs/BATCHING.md §3, Q3; WAVE_PLAN6 §4.2): the region batches (static objects merged per region). On by
   * default; the PBR presets only (Low never batches, and the row is not shown there). A change rebuilds the regions
   * (World.setBatching: release + stream.rebuild()), like a path switch.
   */
  batching: 'on' | 'off'
}

/** Why the first-run check picked its preset (the Options hint names the device class). */
export type RecommendReason = 'webgl' | 'integrated' | 'apple' | 'apple-pro' | 'discrete' | 'varyings'

/** What the first-run device check recommends (docs/WAVE_PLAN3.md §5.1, the user's hardware note). */
export interface Recommendation {
  preset: GraphicsPreset
  resolution: Resolution
  weather: WeatherSetting
  why: RecommendReason
}

export interface Settings {
  v: 1
  graphics: {
    /** WorldQuality; applies live via World.setQuality. */
    preset: GraphicsPreset
    /** Fraction of device pixels rendered (engine.setHardwareScalingLevel(1 / (dpr * resolution))). */
    resolution: Resolution
    /** Very narrow .. very broad: SIGHT_MUL, multiplied into the preset's drawDistance. */
    sight: SightRange
    /**
     * Grass and plants (Options → Grass): 'auto' (the preset's level) or a fixed level; applies live via World.setQuality.
     * Wave 10 (GRASS_LIFE §7.1, Q2): on the PBR presets 'low' is the new grass at full density over 0.6 of the reach,
     * and 'auto' is 'low' on an Apple or integrated GPU (`grassQualityFor`) until the M1 check.
     */
    scatter: ScatterSetting
    /** Wave 10 (GRASS_LIFE §5): the wildlife on the PBR presets (World.life.setEnabled); on by default. */
    wildlife: WildlifeSetting
    /** Wave 11 (TOWN_LIFE §8.2): the town life on the PBR presets (World.town, through `townLifeFor`); 'auto' by default. */
    townLife: TownLifeSetting
    /** Wave 12 (TREES Part W): the new trees and plants on the PBR presets ('new' by default; Low always retail). */
    trees: TreesSetting
    /**
     * Retired (wave 9B, TX-R): the remastered-textures test switch (three/remaster.ts twins and RemasterLighting; no
     * Options row any more, `?remaster=1|0` still overrides it). Kept one wave as an alias: a saved `true` without a
     * `textures` value starts on `textures: 'remaster'`, and the first change of the Textures row clears it.
     */
    remaster: boolean
    /**
     * Wave 9B (TX-R): the texture tier. 'auto' follows the preset (Low retail, Medium the retail-size remaster, High
     * the '2x' tier, Ultra ≤ 2048 / KTX2); 'retail', 'remaster', 1024 and 2048 pin one. Applies after a reload.
     */
    textures: TextureSetting
    /** Wave 9: sky style (default modern; classic = the retail sky). */
    sky: SkySetting
    /** Wave 9: weather level ('auto' follows the preset). */
    weather: WeatherSetting
    /** Wave 9: Advanced overrides of the preset's render features. */
    advanced: AdvancedGraphics
    /**
     * Bloom on the PBR presets, over the preset's own (off by default, for every save: the release's bloom made white
     * clothes, sunlit stone and the sky glow; nobody had chosen it, so there is no old value to keep). Applies live.
     */
    bloom: BloomSetting
    /**
     * Wave 9: true until the first-run detection (GAME) picked a preset for this device. Settings saved before wave 9
     * normalise to false, so a saved preset is never replaced.
     */
    firstRun: boolean
    /**
     * Wave 9 preview (rollout.ts RENDER_ROLLOUT 'preview'): Options → Graphics → "Modern graphics (preview)". Off: the
     * world renders as before wave 9. Ignored once the rollout is 'on'.
     */
    modern: boolean
    /** Wave 9: the first-run device check's recommendation (null until it ran); in 'preview' it is only shown. */
    recommended: Recommendation | null
    /**
     * The release's one-time move of a saved blob ran (`runReleaseMigration`, rollout 'on'). A fresh profile starts
     * true (nothing to keep); a blob saved before the release (v: 1 without the key) starts false.
     */
    releaseMigrated: boolean
  }
  ui: {
    /** Unused since the retail scale steps (kept for old saved settings); see scaleMode. */
    scale: number
    /** UI scale (docs/UI.md §4.1): 'auto' (never below 1 on a desktop viewport) or a fixed step. */
    scaleMode: UiScaleMode
    /** The FPS / ping / draws overlay (hud/perf-overlay.ts). */
    showFps: boolean
    names: { players: boolean; mobs: boolean; npcs: boolean; items: ItemNames }
    damageNumbers: boolean
    expInChat: boolean
    /** 0..4 (the minimap's zoom steps). */
    minimapZoom: number
    /** Sessions the "H: help" hint was shown in (it hides after HELP_HINT_SESSIONS). */
    helpHintSessions: number
    /** Wave 9 accessibility: lightning flashes at a quarter strength, no bolt (docs/WEATHER.md §7.3). */
    reduceFlashing: boolean
    /** Wave 9: the in-game clock next to the minimap (docs/SKY.md, GAME). */
    clock: boolean
    /**
     * Berserk's own-screen effects (world/features/berserk.ts, docs/EFFECTS.md §3.9): the red pulsing edge, the start
     * flash, the heartbeat, the richer colours, the camera push-in and bumps, the hit-stop. On by default.
     */
    berserkScreen: boolean
  }
  controls: {
    holdToMove: boolean
    /** 0.5..2 */
    cameraSpeed: number
    invertY: boolean
    cameraMode: CameraMode
    nearestTargetKey: boolean
    /** A short camera shake when a critical hit lands on you (F11). */
    cameraShake: boolean
    /**
     * MV-WASD: W A S D and the arrow keys walk, relative to the camera (world/features/keymove.ts). Off: only clicks
     * walk, and the arrows turn and zoom the camera again (world/camera-keys.ts).
     */
    keyboardMove: boolean
    /**
     * The "You cannot get there." warning of a click the walk cannot reach (world/move-feedback.ts K5): the red ring,
     * the dashed line, the line of text and its error sound. Off: none of it (the server still walks to the last
     * reachable point on the line). On by default.
     */
    unreachableWarning: boolean
  }
  /** Auto potion (Options → Controls; world/auto-potion.ts): off by default. */
  autoPotion: {
    enabled: boolean
    /** Drink an HP potion below this % of max HP; 0 = never (AUTO_POTION_PCT_MIN..MAX in steps of 5). */
    hp: number
    /** Drink an MP potion below this % of max MP; 0 = never. */
    mp: number
    /** Universal Pills on abnormal states (burn, poison, freeze, ...). */
    cure: boolean
  }
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

export const SETTINGS_KEY = 'sro.settings'
export const PRESETS: readonly GraphicsPreset[] = ['low', 'medium', 'high', 'ultra']
export const RESOLUTIONS: readonly Resolution[] = [1, 0.75, 0.5]
/** Sight range steps (very narrow, narrow, broad, very broad) as draw-distance multipliers [our rule]. */
export const SIGHT_MUL: readonly number[] = [0.6, 0.8, 1, 1.4]
export const SCATTER_SETTINGS: readonly ScatterSetting[] = ['auto', 'off', 'low', 'medium', 'high']
export const SKY_SETTINGS: readonly SkySetting[] = ['modern', 'classic']
export const WEATHER_SETTINGS: readonly WeatherSetting[] = ['auto', 'off', 'low', 'medium', 'high', 'ultra']
export const TONE_MAPS: readonly ToneMapSetting[] = ['neutral', 'filmic']
export const BLOOM_SETTINGS: readonly BloomSetting[] = BLOOM_LEVELS
/** Wave 10: Options → Graphics → Wildlife. */
export const WILDLIFE_SETTINGS: readonly WildlifeSetting[] = ['on', 'off']
/** Wave 11: Options → Graphics → Town life. */
export const TOWN_LIFE_SETTINGS: readonly TownLifeSetting[] = ['auto', 'off', 'low', 'full']
/** Wave 12: Options → Graphics → Trees. */
export const TREES_SETTINGS: readonly TreesSetting[] = ['new', 'retail']
/** Wave 9B (TX-R): the Options texture tiers (pbr/maps.ts TEXTURE_SETTINGS). */
export const TEXTURE_SETTINGS: readonly TextureSetting[] = WR_TEXTURE_SETTINGS
export const ADVANCED_CHOICES: { readonly [K in Exclude<keyof AdvancedGraphics, 'toneMap'>]: readonly AdvancedGraphics[K][] } = {
  shadows: ['auto', 'off', 'medium', 'high', 'ultra'],
  ao: ['auto', 'off', 'half', 'full'],
  reflections: ['auto', 'off', 'puddles', 'always'],
  aa: ['auto', 'msaa', 'fxaa', 'taa'],
  lightShafts: ['auto', 'off', 'low', 'high'],
  batching: ['on', 'off'],
}
export const UI_SCALE_MIN = 0.8
export const UI_SCALE_MAX = 1.4
export const CAMERA_SPEED_MIN = 0.5
export const CAMERA_SPEED_MAX = 2
export const MINIMAP_ZOOM_MAX = 4
/** Auto potion thresholds (percent of max HP / MP; 0 = never). */
export const AUTO_POTION_PCT_MIN = 0
export const AUTO_POTION_PCT_MAX = 90
export const AUTO_POTION_PCT_STEP = 5

export function defaultSettings(): Settings {
  return {
    v: 1,
    graphics: {
      preset: 'medium',
      resolution: 1,
      sight: 2,
      scatter: 'auto',
      wildlife: 'on',
      townLife: 'auto',
      trees: 'new',
      remaster: false,
      textures: 'auto',
      sky: 'modern',
      weather: 'auto',
      advanced: { shadows: 'auto', ao: 'auto', reflections: 'auto', aa: 'auto', toneMap: 'neutral', lightShafts: 'auto', batching: 'on' },
      bloom: 'off',
      firstRun: true,
      modern: false,
      recommended: null,
      releaseMigrated: true,
    },
    ui: {
      scale: 1,
      scaleMode: 'auto',
      showFps: false,
      names: { players: true, mobs: true, npcs: true, items: 'near' },
      damageNumbers: true,
      expInChat: false,
      minimapZoom: 2,
      helpHintSessions: 0,
      reduceFlashing: false,
      clock: true,
      berserkScreen: true,
    },
    controls: { holdToMove: true, cameraSpeed: 1, invertY: false, cameraMode: 'free', nearestTargetKey: true, cameraShake: true, keyboardMove: true, unreachableWarning: true },
    autoPotion: { enabled: false, hp: 50, mp: 30, cure: false },
  }
}

// ---- normalising (any JSON -> a valid Settings) -------------------------------------------------

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const oneOf = <T>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d)
function num(v: unknown, d: number, min: number, max: number, step = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return d
  const c = Math.min(max, Math.max(min, v))
  return step ? Number((Math.round(c / step) * step).toFixed(4)) : c
}

/** Fills missing fields with defaults and clamps every value to its range. */
export function normalizeSettings(raw: unknown): Settings {
  const d = defaultSettings()
  const r = obj(raw)
  const g = obj(r.graphics)
  const a = obj(g.advanced)
  const u = obj(r.ui)
  const n = obj(u.names)
  const c = obj(r.controls)
  const ap = obj(r.autoPotion)
  return {
    v: 1,
    graphics: {
      preset: oneOf(g.preset, PRESETS, d.graphics.preset),
      resolution: oneOf(g.resolution, RESOLUTIONS, d.graphics.resolution),
      sight: oneOf(g.sight, [0, 1, 2, 3] as const, d.graphics.sight),
      scatter: oneOf(g.scatter, SCATTER_SETTINGS, d.graphics.scatter),
      // Wave 10: a save from before the Wildlife row starts with it on.
      wildlife: oneOf(g.wildlife, WILDLIFE_SETTINGS, d.graphics.wildlife),
      // Wave 11: a save from before the Town life row starts on 'auto' (Full on Medium and up, Low on a Mac or an
      // integrated GPU, nothing on Low: townLifeFor).
      townLife: oneOf(g.townLife, TOWN_LIFE_SETTINGS, d.graphics.townLife),
      // Wave 12: a save from before the Trees row starts on the new trees (Low draws retail whatever is saved).
      trees: oneOf(g.trees, TREES_SETTINGS, d.graphics.trees),
      remaster: bool(g.remaster, d.graphics.remaster),
      // TX-R: a save from before the texture row with the retired test switch on starts on the remastered tier.
      textures: isTextureSetting(g.textures) ? g.textures : g.remaster === true ? 'remaster' : d.graphics.textures,
      sky: oneOf(g.sky, SKY_SETTINGS, d.graphics.sky),
      weather: oneOf(g.weather, WEATHER_SETTINGS, d.graphics.weather),
      advanced: {
        shadows: oneOf(a.shadows, ADVANCED_CHOICES.shadows, d.graphics.advanced.shadows),
        ao: oneOf(a.ao, ADVANCED_CHOICES.ao, d.graphics.advanced.ao),
        reflections: oneOf(a.reflections, ADVANCED_CHOICES.reflections, d.graphics.advanced.reflections),
        aa: oneOf(a.aa, ADVANCED_CHOICES.aa, d.graphics.advanced.aa),
        toneMap: oneOf(a.toneMap, TONE_MAPS, d.graphics.advanced.toneMap),
        // w12r: the wave-9 row was auto / off / on; a saved 'on' is the High level (what it drew).
        lightShafts: a.lightShafts === 'on' ? 'high' : oneOf(a.lightShafts, ADVANCED_CHOICES.lightShafts, d.graphics.advanced.lightShafts),
        // Wave 10: a save from before the World batching row starts with it on.
        batching: oneOf(a.batching, ADVANCED_CHOICES.batching, d.graphics.advanced.batching),
      },
      bloom: oneOf(g.bloom, BLOOM_SETTINGS, d.graphics.bloom),
      // A saved settings blob (v: 1) from before wave 9 has no flag: it keeps its preset (not a first run).
      firstRun: bool(g.firstRun, r.v !== 1),
      modern: bool(g.modern, d.graphics.modern),
      recommended: recommendation(g.recommended),
      // Like firstRun: a saved blob without the key was saved before the release and still gets its one-time move.
      releaseMigrated: bool(g.releaseMigrated, r.v !== 1),
    },
    ui: {
      scale: num(u.scale, d.ui.scale, UI_SCALE_MIN, UI_SCALE_MAX, 0.05),
      scaleMode: oneOf(u.scaleMode, UI_SCALE_MODES, d.ui.scaleMode),
      showFps: bool(u.showFps, d.ui.showFps),
      names: {
        players: bool(n.players, d.ui.names.players),
        mobs: bool(n.mobs, d.ui.names.mobs),
        npcs: bool(n.npcs, d.ui.names.npcs),
        items: oneOf(n.items, ['always', 'near', 'hover'] as const, d.ui.names.items),
      },
      damageNumbers: bool(u.damageNumbers, d.ui.damageNumbers),
      expInChat: bool(u.expInChat, d.ui.expInChat),
      minimapZoom: num(u.minimapZoom, d.ui.minimapZoom, 0, MINIMAP_ZOOM_MAX, 1),
      helpHintSessions: num(u.helpHintSessions, d.ui.helpHintSessions, 0, 1000, 1),
      reduceFlashing: bool(u.reduceFlashing, d.ui.reduceFlashing),
      clock: bool(u.clock, d.ui.clock),
      berserkScreen: bool(u.berserkScreen, d.ui.berserkScreen),
    },
    controls: {
      holdToMove: bool(c.holdToMove, d.controls.holdToMove),
      cameraSpeed: num(c.cameraSpeed, d.controls.cameraSpeed, CAMERA_SPEED_MIN, CAMERA_SPEED_MAX, 0.05),
      invertY: bool(c.invertY, d.controls.invertY),
      cameraMode: oneOf(c.cameraMode, ['free', 'third', 'quarter'] as const, d.controls.cameraMode),
      nearestTargetKey: bool(c.nearestTargetKey, d.controls.nearestTargetKey),
      cameraShake: bool(c.cameraShake, d.controls.cameraShake),
      keyboardMove: bool(c.keyboardMove, d.controls.keyboardMove),
      unreachableWarning: bool(c.unreachableWarning, d.controls.unreachableWarning),
    },
    autoPotion: {
      enabled: bool(ap.enabled, d.autoPotion.enabled),
      hp: num(ap.hp, d.autoPotion.hp, AUTO_POTION_PCT_MIN, AUTO_POTION_PCT_MAX, AUTO_POTION_PCT_STEP),
      mp: num(ap.mp, d.autoPotion.mp, AUTO_POTION_PCT_MIN, AUTO_POTION_PCT_MAX, AUTO_POTION_PCT_STEP),
      cure: bool(ap.cure, d.autoPotion.cure),
    },
  }
}

const RECOMMEND_REASONS: readonly RecommendReason[] = ['webgl', 'integrated', 'apple', 'apple-pro', 'discrete', 'varyings']

/** A saved recommendation, or null when it is missing or broken (the check runs again). */
function recommendation(v: unknown): Recommendation | null {
  const o = obj(v)
  const pick = <T>(x: unknown, list: readonly T[]): T | null => (list.includes(x as T) ? (x as T) : null)
  const preset = pick(o.preset, PRESETS)
  const resolution = pick(o.resolution, RESOLUTIONS)
  const weather = pick(o.weather, WEATHER_SETTINGS)
  const why = pick(o.why, RECOMMEND_REASONS)
  return preset && resolution && weather && why ? { preset, resolution, weather, why } : null
}

function merge(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch
  const out: Obj = { ...obj(base) }
  for (const [k, v] of Object.entries(patch as Obj)) out[k] = merge(out[k], v)
  return out
}

/** The settings `patch` would give (normalised, not stored): Options asks before a change that rebuilds the world. */
export function patchedSettings(s: Settings, patch: DeepPartial<Settings>): Settings {
  return normalizeSettings(merge(s, patch))
}

// ---- the store ------------------------------------------------------------------------------------

/** The part of Storage the store uses (tests pass a map, or one that throws). */
export interface SettingsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type SettingsListener = (s: Settings, prev: Settings) => void

export class SettingsStore {
  private value: Settings
  private readonly listeners = new Set<SettingsListener>()

  constructor(private readonly storage: SettingsStorage | null) {
    this.value = this.load()
  }

  /** The current settings (a frozen snapshot: replace values through `set`). */
  get(): Settings {
    return this.value
  }

  /** Merges `patch`, clamps, saves and notifies (only when something changed). */
  set(patch: DeepPartial<Settings>): void {
    const prev = this.value
    const next = normalizeSettings(merge(prev, patch))
    if (JSON.stringify(next) === JSON.stringify(prev)) return
    this.value = deepFreeze(next)
    this.save()
    for (const fn of [...this.listeners]) {
      try {
        fn(this.value, prev)
      } catch (err) {
        console.error('[settings] listener failed', err)
      }
    }
  }

  /** Back to the defaults (Options → Default). */
  reset(): void {
    this.set(defaultSettings())
  }

  onChange(fn: SettingsListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private load(): Settings {
    let raw: unknown = null
    try {
      const text = this.storage?.getItem(SETTINGS_KEY)
      raw = text ? JSON.parse(text) : null
    } catch {
      raw = null
    }
    return deepFreeze(normalizeSettings(raw))
  }

  private save(): void {
    try {
      this.storage?.setItem(SETTINGS_KEY, JSON.stringify(this.value))
    } catch {
      // storage blocked or full: the settings still apply for this page
    }
  }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v)
    Object.freeze(o)
  }
  return o
}

function browserStorage(): SettingsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The page's settings. */
export const settings = new SettingsStore(browserStorage())

// ---- graphics -------------------------------------------------------------------------------------

/**
 * World.setQuality argument without the wave-9 blocks: the preset's settings with the sight range folded into the draw
 * distance and the grass setting. These are the preset's non-render effects, the same in every rollout mode;
 * `worldQualityFor` adds the render and sky blocks.
 */
export function qualityFor(s: Settings, preset: GraphicsPreset = s.graphics.preset): QualitySettings {
  const q = QUALITY_PRESETS[preset]
  const out: QualitySettings = { ...q, drawDistance: q.drawDistance * (SIGHT_MUL[s.graphics.sight] ?? 1) }
  if (s.graphics.scatter !== 'auto') out.scatter = s.graphics.scatter
  return out
}

/** The part of the GPU info (world-render GpuInfo) the graphics rules read. */
export type GpuHint = Partial<Pick<GpuInfo, 'vendor' | 'architecture' | 'isFallbackAdapter' | 'maxInterStageShaderVariables'>>

/** Everything the first-run check reads about the device (`deviceHintOf` fills it from the engine). */
export interface DeviceHint extends GpuHint {
  engine: 'WebGPU' | 'WebGL2' | 'WebGL1'
  /** GPUAdapterInfo.description (Babylon getInfo().version): sometimes names the chip ("Apple M2 Pro"). */
  description?: string
  /** navigator's platform ("MacIntel", "macOS"): an Apple GPU when the adapter hides its vendor. */
  platform?: string
  /** window.devicePixelRatio (2 on a Retina Mac): an Apple GPU at 2× renders at scale 0.75 on its first run. */
  dpr?: number
}

/** Adapter strings Babylon fills in when the browser gives none ("unknown vendor"): read as empty. */
const known = (v: string | undefined): string => {
  const s = (v ?? '').trim().toLowerCase()
  return s.startsWith('unknown') ? '' : s
}

/**
 * AMD APU graphics as the adapter strings name them (WebGL2's ANGLE renderer, or a WebGPU description): "AMD Radeon(TM)
 * Graphics", "AMD Radeon 780M Graphics", "Radeon(TM) 890M", "Radeon Vega 8 Graphics". A discrete card names its series
 * ("Radeon RX 7600M XT", "Radeon Pro 5500M"), which the pattern leaves alone.
 */
const AMD_APU = /radeon(\(tm\))?\s+(graphics|vega\s*\d+\s+graphics|\d{3}m\b)/
/** Software renderers (no GPU at all): SwiftShader, llvmpipe / softpipe, Microsoft Basic Render Driver. */
const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|basic render/

/**
 * An integrated or software GPU (docs/WAVE_PLAN3.md §5.1 first-run rule): Intel without "Arc", the gen-12lp / xe-lpg
 * architectures, an AMD APU the strings name (WebGL2 always does; WebGPU only when the adapter gives a description), a
 * software renderer, or a fallback adapter. An AMD APU behind a bare WebGPU 'amd' / 'rdna-3' adapter is not caught.
 */
export function isIntegratedGpu(gpu: (GpuHint & { description?: string }) | null | undefined): boolean {
  if (!gpu) return false
  if (gpu.isFallbackAdapter) return true
  const arch = known(gpu.architecture)
  if (arch === 'gen-12lp' || arch === 'xe-lpg') return true
  const vendor = known(gpu.vendor)
  const names = `${vendor} ${arch} ${known(gpu.description)}`
  if (AMD_APU.test(names) || SOFTWARE_GPU.test(names)) return true
  return vendor.includes('intel') && !`${vendor} ${arch}`.includes('arc')
}

/**
 * An Apple-silicon GPU: the adapter says "apple" (Chrome: vendor 'apple', architecture 'metal-3'), or it names no
 * vendor at all on a Mac (Safari keeps the adapter strings empty). An Intel Mac reports its Intel or AMD GPU instead.
 */
export function isAppleGpu(d: Pick<DeviceHint, 'vendor' | 'architecture' | 'description' | 'platform'> | null | undefined): boolean {
  if (!d) return false
  const vendor = known(d.vendor)
  const arch = known(d.architecture)
  if (vendor.includes('apple') || arch.startsWith('metal') || arch.includes('apple') || /\bapple\b/.test(known(d.description))) return true
  return !vendor && /mac/i.test(d.platform ?? '')
}

/** An M-series Pro, Max or Ultra chip, when the adapter names it (Chrome and Safari usually do not). */
export function isAppleProGpu(d: Pick<DeviceHint, 'vendor' | 'architecture' | 'description'> | null | undefined): boolean {
  if (!d) return false
  return /\bm\d+\s*(pro|max|ultra)\b/.test(`${known(d.description)} ${known(d.architecture)} ${known(d.vendor)}`)
}

/** An adapter that grants only WebGPU's default 16 inter-stage variables (PBR + CSM + a prepass need 17; RENDER §3.5). */
export function hasFewVaryings(gpu: GpuHint | null | undefined): boolean {
  const n = gpu?.maxInterStageShaderVariables
  return typeof n === 'number' && n > 0 && n <= 16
}

const PRESET_RANK: Record<GraphicsPreset, number> = { low: 0, medium: 1, high: 2, ultra: 3 }

/** The next preset down (the watchdog's step), null below Low, or below `floor` when one is given. */
export function lowerPreset(p: GraphicsPreset, floor: GraphicsPreset = 'low'): GraphicsPreset | null {
  const next = PRESETS[PRESET_RANK[p] - 1] ?? null
  return next && PRESET_RANK[next] >= PRESET_RANK[floor] ? next : null
}

/**
 * The first-run preset for this device (docs/WAVE_PLAN3.md §5.1; the user's decision of 2026-09-29, "Default Medium,
 * High optional"): Medium on every adapter class, WebGPU and WebGL2 alike (a discrete desktop or laptop GPU, an Apple
 * GPU, an adapter that names nothing); High and Ultra are the player's own pick in Options. An integrated GPU
 * (`isIntegratedGpu`: Intel without "Arc", a named AMD APU, a software or fallback adapter) → Medium at render scale
 * 0.75 (FSR1 on WebGPU) with weather low. An Apple GPU on a Retina screen (devicePixelRatio ≥ 2) renders at scale 0.75
 * (the coast doc projects a base M1 at 15–20 ms of GPU for the High stack at full Retina resolution; 0.75 of 2× is
 * still 1.5× the CSS pixels). WebGL1 → Low (the Classic path; the PBR presets need WebGL2 or WebGPU). `why` names the
 * device class for the Options hint (shown in the 'preview' rollout only).
 */
export function recommendGraphics(d: DeviceHint): Recommendation {
  if (d.engine === 'WebGL1') return { preset: 'low', resolution: 1, weather: 'auto', why: 'webgl' }
  if (isIntegratedGpu(d)) return { preset: 'medium', resolution: 0.75, weather: 'low', why: 'integrated' }
  const apple = isAppleGpu(d)
  const resolution: Resolution = apple && (d.dpr ?? 1) >= 2 ? 0.75 : 1
  let why: RecommendReason
  if (d.engine !== 'WebGPU') why = 'webgl'
  else if (apple) why = isAppleProGpu(d) ? 'apple-pro' : 'apple'
  else why = hasFewVaryings(d) ? 'varyings' : 'discrete'
  return { preset: 'medium', resolution, weather: 'auto', why }
}

/** The device hint of a created engine (its GpuInfo, the adapter description, the page's platform). */
export function deviceHintOf(engine: AbstractEngine, kind: DeviceHint['engine']): DeviceHint {
  const gpu = gpuInfoFromEngine(engine)
  let description = ''
  try {
    description = (engine as { getInfo?: () => { version?: string } }).getInfo?.().version ?? ''
  } catch {
    // no adapter strings: the vendor rules decide
  }
  let platform = ''
  try {
    const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { userAgentData?: { platform?: string } })
    platform = nav?.userAgentData?.platform || nav?.platform || ''
  } catch {
    platform = ''
  }
  let dpr = 1
  try {
    dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  } catch {
    dpr = 1
  }
  return { ...gpu, engine: kind, description, platform, dpr }
}

/**
 * The first-run device check, once per settings blob: records the recommendation whenever there is none (so the
 * Options hint shows it); only on a first run with the rollout 'on' does it also apply it (preset, resolution, weather).
 * In 'preview' nothing but the record changes. Returns the recommendation, or null when one was already recorded.
 */
export function runFirstRun(store: SettingsStore, device: DeviceHint, rollout: RenderRollout = RENDER_ROLLOUT): Recommendation | null {
  const g = store.get().graphics
  if (!g.firstRun && g.recommended) return null
  const rec = recommendGraphics(device)
  if (g.firstRun && rollout === 'on') store.set({ graphics: { preset: rec.preset, resolution: rec.resolution, weather: rec.weather, recommended: rec, firstRun: false } })
  else store.set({ graphics: { recommended: rec, firstRun: false } })
  return rec
}

/**
 * The release's one-time move of a saved settings blob (rollout 'on'; the W9 release verify, check b). Before the
 * release a player who never turned the preview on saw the Low guard state whatever the preset (Classic path, classic
 * sky, weather off, a frozen noon). In 'on' a saved Medium moves to PBR (the user's decision) and High and Ultra stay;
 * a saved Low keeps the Classic material path, and without this move it would also switch to §5.1's Low defaults (the
 * modern sky, weather 'auto' → low, the running clock). So a blob saved before the release on Low, with the preview
 * off, keeps the look it had: sky 'classic' and weather 'off' are written into it, which is the Low guard's
 * combination (`classicLook`): the whole pre-wave look, the frozen noon and the clear sky included. The player leaves
 * it with the Sky or Weather row. A Low player who had the preview on already saw §5.1's Low, and keeps it. Runs once
 * per blob (`releaseMigrated`), nothing in 'preview'; true when it kept the Low look.
 */
export function runReleaseMigration(store: SettingsStore, rollout: RenderRollout = RENDER_ROLLOUT): boolean {
  if (rollout !== 'on') return false
  const g = store.get().graphics
  if (g.releaseMigrated) return false
  const keepLow = g.preset === 'low' && !g.modern
  store.set({ graphics: keepLow ? { sky: 'classic', weather: 'off', releaseMigrated: true } : { releaseMigrated: true } })
  return keepLow
}

/**
 * The wave-9 look is on: the rollout is 'on', or the player turned on the preview (rollout.ts). It decides the Options
 * rows (the Sky and Weather rows stay, so the Low guard's combination can be left again) and the Low label; what
 * renders is `newLook`.
 */
export function modernGraphics(s: Settings, rollout: RenderRollout = RENDER_ROLLOUT): boolean {
  return rollout === 'on' || s.graphics.modern
}

/**
 * The Low guard's combination (W9 release verify 2, check b): Low (Classic) with the classic sky and weather off is the
 * look from before wave 9, all of it, in every rollout: the Classic material path, the classic sky at a frozen noon, a
 * clear weather frame and no weather sound, Low's blocks without the night splats (PREVIEW_OFF_RENDER), retail
 * textures, and every pose every frame. `preset`: the preset the world runs (`?quality=`), else the saved one.
 */
export function classicLook(s: Settings, preset: GraphicsPreset = s.graphics.preset): boolean {
  return preset === 'low' && s.graphics.sky === 'classic' && s.graphics.weather === 'off'
}

/** The wave-9 look renders: `modernGraphics`, except in the Low guard's combination (`classicLook`). */
export function newLook(s: Settings, rollout: RenderRollout = RENDER_ROLLOUT, preset: GraphicsPreset = s.graphics.preset): boolean {
  return modernGraphics(s, rollout) && !classicLook(s, preset)
}

/** What this device renders with these settings (see `effectiveGraphics`). */
export interface EffectiveGraphics {
  /** The player's preset: sight range, effect budgets and streaming, the same in every mode. */
  preset: GraphicsPreset
  /** The preset the renderer runs: the player's, at most Medium with 16 inter-stage variables, Low without the new look. */
  renderPreset: GraphicsPreset
  /** The wave-9 look renders (`newLook`: modernGraphics, but not in the Low guard's combination). */
  modern: boolean
  /** Material path, sky style and weather level for World (setRenderMode, setSkyStyle, setWeatherLevel). */
  render: RenderPath
  sky: SkyStyle
  weather: WeatherLevel
  /** The weather's frames and sounds reach the world (false: a clear frame and silence, as before wave 9). */
  weatherShown: boolean
  /** The time of day follows the server clock (false: a frozen noon, as before wave 9). */
  clock: boolean
  /** Options → Tone mapping (the post stack's live override; PBR presets only). */
  toneMap: ToneMapSetting
  /** World.setQuality's `render` and `sky` blocks (Advanced, bloom and the texture setting folded in). */
  renderQuality: Readonly<RenderQuality>
  skyQuality: Readonly<SkyQuality>
  /**
   * Wave 9B (TX-R): the texture tier this device loads (retail without the new look: the Low guard). The character
   * screens read it (three/actor-textures.ts); the world reads `renderQuality.textures`.
   */
  textureTier: TextureTier
  /**
   * Wave 10 (BATCHING §3, WAVE_PLAN6 §4.2): the region batches draw (a PBR path with Options → Advanced → World batching
   * on). Low and the Low guard never batch.
   */
  batching: boolean
  /**
   * Wave 10 (GRASS_LIFE §1): the grass the world draws: the preset's style (QUALITY_PRESETS) on the PBR path, the
   * retail scatter on the Classic path and without the new look (the Low guard).
   */
  grassStyle: GrassStyle
  /** Wave 10 (GRASS_LIFE §5): the wildlife runs (a PBR path with Options → Wildlife on). */
  wildlife: boolean
  /**
   * Wave 12 (TREES Part W, WAVE_PLAN8 D9): the trees and plants the world draws (`LoadWorldOptions.trees`): Options →
   * Trees on the PBR path; 'retail' on the Classic path and without the new look (the Low guard: the swap never applies).
   */
  trees: TreesSetting
}

export interface EffectiveOptions {
  gpu?: GpuHint | null
  rollout?: RenderRollout
  /** The preset the world runs, when it differs from the settings' (`?quality=`). */
  preset?: GraphicsPreset
  /** The texture tier for this page, when it differs from the settings' (`?textures=`; default TEXTURES_FROM_URL). */
  textures?: TextureSetting | null
}

/** `?textures=auto|retail|remaster|1024|2048` (a page-load A/B of the texture tier; anything else: null). */
export function texturesFromSearch(search: string): TextureSetting | null {
  let v: string | null
  try {
    v = new URLSearchParams(search).get('textures')
  } catch {
    return null
  }
  if (v === null) return null
  const t = /^\d+$/.test(v) ? Number(v) : v
  return isTextureSetting(t) ? t : null
}

/** The page's `?textures=` override (TX-R lab A/B; never saved). */
export const TEXTURES_FROM_URL: TextureSetting | null = (() => {
  try {
    return texturesFromSearch(globalThis.location?.search ?? '')
  } catch {
    return null
  }
})()

// TX-R: the world's materials and terrain read the tier when they load ("applies after reload"): the page's setting is
// fixed here, before any world loads (RenderQuality.textures carries the same value once World.setQuality runs).
setPageTextureSetting(TEXTURES_FROM_URL ?? settings.get().graphics.textures)

/** `?remaster=`: true for 1 (any value but 0 / false / off), false for 0 / false / off, null when absent. */
function remasterParam(search: string): boolean | null {
  let v: string | null = null
  try {
    v = new URLSearchParams(search).get('remaster')
  } catch {
    return null
  }
  return v === null ? null : !(v === '0' || v === 'false' || v === 'off')
}

/**
 * The sro-remaster sets (the Meshy sets the user approved on 2026-09-29, work/out/remaster/manifest.json, D35: they win
 * over the pipeline's sro-pbr set for the same image) are looked for on every page, production included: the deploy
 * ships `out/remaster/` (docs/DEPLOY.md), and a missing manifest is "no sets", silently (D40). `?remaster=0` leaves
 * them out for this page load (an A/B against the pipeline's sets).
 */
export function remasterSetsWanted(search: string): boolean {
  return remasterParam(search) !== false
}

/**
 * The retired test switch's twin materials (three/remaster.ts RemasterScene; graphics.remaster) read the same manifest
 * only on the dev server or with `?remaster=1` (I9A), as before the sets shipped: a production save with the switch
 * still on never builds twins over the in-place swaps (ActorMaps).
 */
export function remasterTestSetsWanted(dev: boolean, search: string): boolean {
  return dev || remasterParam(search) === true
}

setPageRemasterSets(remasterSetsWanted(globalThis.location?.search ?? ''))

/** The page's answer to `remasterTestSetsWanted` (three/remaster.ts reads it before fetching the manifest). */
export const REMASTER_TEST_SETS: boolean = remasterTestSetsWanted(!!import.meta.env?.DEV, globalThis.location?.search ?? '')

/**
 * W9F LG-2: the render block without the new look (the preview off, or the Low guard's combination: `classicLook`). It
 * is Low's minus the night splats: fx-world attaches the night lights to every world, and on Low they define
 * SRO_NIGHT_SPLAT / SRO_NIGHT_GRASS, which the pre-wave image (dc737cc) never had. Without the new look no night light
 * reaches the terrain or the grass.
 */
export const PREVIEW_OFF_RENDER: RenderQuality = {
  ...RENDER_PRESETS.low,
  nightLights: { ...RENDER_PRESETS.low.nightLights, terrainSplat: false, grassSplat: false },
}

/**
 * The effective graphics (docs/WAVE_PLAN3.md §5.1, rollout.ts): the one function that turns the settings, the rollout
 * gate and the GPU into what the world renders. Without the new look (the preview off, whatever the preset; or the
 * Low guard's combination, Low + classic sky + weather off: `classicLook`) it is the Low guard state (Classic path,
 * classic sky, weather off and not shown, frozen noon: HEAD's image) while the preset still drives the non-render
 * effects. With it, the preset's render and sky rows, capped at Medium on a 16-varying adapter, with the Advanced rows
 * and the bloom choice folded in on the PBR presets.
 */
export function effectiveGraphics(s: Settings, o: EffectiveOptions = {}): EffectiveGraphics {
  const rollout = o.rollout ?? RENDER_ROLLOUT
  const preset = o.preset ?? s.graphics.preset
  const toneMap = s.graphics.advanced.toneMap
  if (!newLook(s, rollout, preset)) {
    return {
      preset, renderPreset: 'low', modern: false, render: 'classic', sky: 'classic', weather: 'off', weatherShown: false, clock: false, toneMap,
      renderQuality: PREVIEW_OFF_RENDER, skyQuality: SKY_PRESETS.low, textureTier: 'retail', batching: false, grassStyle: 'retail', wildlife: false,
      trees: 'retail',
    }
  }
  const renderPreset = renderPresetFor(preset, o.gpu)
  const base = RENDER_PRESETS[renderPreset]
  const textures = (o.textures === undefined ? TEXTURES_FROM_URL : o.textures) ?? s.graphics.textures
  const folded = base.path === 'pbr' ? withBloom(foldAdvanced(base, s.graphics.advanced), s.graphics.bloom) : base
  return {
    preset,
    renderPreset,
    modern: true,
    render: base.path,
    sky: s.graphics.sky,
    weather: weatherLevelFor(s, o.gpu, preset, rollout),
    weatherShown: true,
    clock: true,
    toneMap,
    // 'auto' leaves the preset's block as it is (the preset's tier); a pinned tier rides along for the materials.
    renderQuality: textures === 'auto' ? folded : { ...folded, textures },
    skyQuality: SKY_PRESETS[renderPreset],
    textureTier: textureTierFor(renderPreset === 'low' ? 'classic' : renderPreset, textures),
    batching: base.path === 'pbr' && s.graphics.advanced.batching === 'on',
    grassStyle: base.path === 'pbr' ? presetGrassStyle(preset) : 'retail',
    wildlife: base.path === 'pbr' && s.graphics.wildlife === 'on',
    trees: base.path === 'pbr' ? s.graphics.trees : 'retail',
  }
}

/**
 * The grass style a preset's row names (world-render QUALITY_PRESETS, W10-S: Low keeps 'retail'); 'retail' while the
 * rows carry none.
 */
export function presetGrassStyle(preset: GraphicsPreset): GrassStyle {
  const q: QualitySettings & { grassStyle?: GrassStyle } = QUALITY_PRESETS[preset]
  return q.grassStyle === 'field' ? 'field' : 'retail'
}

/**
 * Wave 10: the grass part of World.setQuality for these effective graphics (`worldQualityFor` and world/graphics.ts
 * add it over `qualityFor`): the style (`EffectiveGraphics.grassStyle`), and Grass: Low for 'auto' on an Apple or
 * integrated GPU on the PBR path (GRASS_LIFE §7.1, Q13: the Mac and iGPU default until the M1 check; a level the player
 * picked is kept).
 */
export function grassQualityFor(s: Settings, e: EffectiveGraphics, gpu?: GpuHint | DeviceHint | null): { grassStyle: GrassStyle; scatter?: ScatterLevel } {
  const out: { grassStyle: GrassStyle; scatter?: ScatterLevel } = { grassStyle: e.grassStyle }
  if (s.graphics.scatter === 'auto' && e.render === 'pbr' && (isAppleGpu(gpu) || isIntegratedGpu(gpu))) out.scatter = 'low'
  return out
}

/**
 * Wave 11 (TOWN_LIFE §8.2, WAVE_PLAN7 D10/D26): the town life these effective graphics run. Off on the Classic path
 * (Low, the Low guard: World.town is null there anyway); 'auto' is Full, or Low on an Apple or integrated GPU (the
 * Grass: Low rule); a level the player picked is kept on every device.
 */
export function townLifeFor(s: Settings, e: Pick<EffectiveGraphics, 'render'>, gpu?: GpuHint | DeviceHint | null): TownLifeLevel {
  if (e.render !== 'pbr') return 'off'
  const v = s.graphics.townLife
  if (v !== 'auto') return v
  return isAppleGpu(gpu) || isIntegratedGpu(gpu) ? 'low' : 'full'
}

/** The renderer's preset: at most Medium on an adapter with 16 inter-stage variables (§5.1). */
function renderPresetFor(preset: GraphicsPreset, gpu: GpuHint | null | undefined): GraphicsPreset {
  return hasFewVaryings(gpu) && PRESET_RANK[preset] > PRESET_RANK.medium ? 'medium' : preset
}

/** The Advanced rows over a PBR preset's render block (the same object when every row is 'auto'). */
function foldAdvanced(base: Readonly<RenderQuality>, a: AdvancedGraphics): Readonly<RenderQuality> {
  if (a.shadows === 'auto' && a.ao === 'auto' && a.reflections === 'auto' && a.aa === 'auto' && a.lightShafts === 'auto') return base
  const q: RenderQuality = { ...base }
  if (a.shadows !== 'auto') q.shadows = a.shadows === 'off' ? null : RENDER_PRESETS[a.shadows].shadows
  if (a.ao !== 'auto') q.ssao = a.ao === 'off' ? null : { halfRes: a.ao === 'half', samples: a.ao === 'half' ? 8 : 16 }
  if (a.reflections !== 'auto') q.ssr = a.reflections === 'off' ? 'off' : a.reflections
  if (a.aa !== 'auto') q.aa = a.aa
  return withLightShafts(q, a.lightShafts)
}

/**
 * World.setQuality argument with the wave-9 blocks: `qualityFor` (the preset's non-render effects) plus the effective
 * render and sky blocks (`effectiveGraphics`).
 */
export function worldQualityFor(s: Settings, preset: GraphicsPreset = s.graphics.preset, o: Omit<EffectiveOptions, 'preset'> = {}): QualitySettings {
  const e = effectiveGraphics(s, { ...o, preset })
  return { ...qualityFor(s, preset), ...grassQualityFor(s, e, o.gpu), render: e.renderQuality, sky: e.skyQuality }
}

/**
 * Wave 9: the weather level the world runs (docs/WEATHER.md §9.1): `graphics.weather`, with `auto` following the preset
 * (low → low, medium → medium, high → high, ultra → ultra, at most Medium on a 16-varying adapter) and dropping to `low`
 * on Medium or above for an integrated GPU. The weather feature reads the level only through here (with the normalised
 * settings), so the rollout gate applies to it: without the new look (rollout.ts 'preview', toggle off) it is 'off'.
 */
export function weatherLevelFor(s: Settings, gpu?: GpuHint | null, preset: GraphicsPreset = s.graphics.preset, rollout: RenderRollout = RENDER_ROLLOUT): WeatherLevel {
  if (!modernGraphics(s, rollout)) return 'off'
  const w = s.graphics.weather
  if (w !== 'auto') return w
  const p = renderPresetFor(preset, gpu)
  if (p === 'low') return 'low'
  return isIntegratedGpu(gpu) ? 'low' : p
}

/**
 * Whether the weather reaches the world and the speakers at all (rollout.ts): false without the new look (the preview
 * off, or the Low guard's combination), where the weather feature sends the world a clear frame and plays nothing (a
 * level of 'off' alone still greys the sky and fog). The same answer as `effectiveGraphics(s).weatherShown`.
 */
export function weatherShown(s: Settings, rollout: RenderRollout = RENDER_ROLLOUT): boolean {
  return newLook(s, rollout)
}

// ---- the frame-time watchdog (RENDER §10) -----------------------------------------------------------

/**
 * Drop one preset when the frame time's p95 over the window is above p95Ms. Nothing is judged during the grace (after
 * entering the world or a switch), while the world is busy (streaming, shader compiles) and for settleMs after it was;
 * a frame of stallMs or more is a hitch, not the frame rate, and does not count.
 */
export const WATCHDOG = { windowMs: 10_000, p95Ms: 33, graceMs: 15_000, stallMs: 1000, settleMs: 3000, minFrames: 60 } as const

/**
 * The lowest preset the watchdog drops to on its own (W9A perf pass). Low is the Classic material path: dropping to
 * it is a live path switch with its own rebuild, and on this path it only ever followed the stall of the switch before.
 */
export const WATCHDOG_FLOOR: GraphicsPreset = 'medium'

/**
 * V-12: a frame rate capped by the display or the browser (a 30 Hz screen, a battery saver, a throttled window) is
 * not slowness, and a lower preset cannot help it. Before a drop the watchdog asks its `FrameCost`:
 * - frames at the display's own pace (p95 within `paceSlack` of the best cadence seen lately) are vsync: no drop;
 * - with the GPU frame time measured (and the CPU work), frames whose work is at most `workFraction` of their interval
 *   wait on the display, not on the GPU or the CPU: no drop. When the GPU time can be measured but is not on, the
 *   watchdog asks for it (`wantsGpu`) and waits up to `probeMs` for it before it decides.
 */
export const WATCHDOG_CAP = { paceSlack: 1.15, workFraction: 0.5, probeMs: 4000 } as const

/** What the watchdog asks before a drop (V-12; world/frame-pace.ts and world/graphics.ts give it). */
export interface FrameCost {
  /** The display's or the browser's own frame period (ms): the best sustained cadence lately; null when unknown. */
  paceMs(): number | null
  /** A frame's CPU work (ms, p90 of the recent frames); null when unknown. */
  cpuMs(): number | null
  /** The GPU frame time (ms) when it is measured now; null when not. */
  gpuMs(): number | null
  /** True when the GPU frame time can be measured (timestamp-query): the watchdog asks for it before a drop. */
  gpuMeasurable(): boolean
}

/** Why the last judgement over the limit did not drop: the display's pace, or frames with little work in them. */
export type WatchdogHold = 'pace' | 'work'

/**
 * The frame-time watchdog (docs/WAVE_PLAN3.md §2.5: p95 > 33 ms over 10 s drops one preset, and the game says so in
 * chat). Pure: the world screen feeds it frame times; `sample` returns true once when it trips (then it starts over,
 * with a new grace for the rebuild). W9A perf pass: a switch streams and compiles for 5–26 s on the dev PC, longer
 * than the 15 s grace, so one slow switch tripped the next drop; the caller now says when the world is busy.
 */
export class FrameWatchdog {
  private readonly at: number[] = []
  private readonly ms: number[] = []
  private graceUntil = -Infinity
  private lastCheck = -Infinity
  private probeSince = NaN
  /** Why the last judgement over the limit held back (V-12), or null. */
  hold: WatchdogHold | null = null

  constructor(private readonly cfg: { windowMs: number; p95Ms: number; graceMs: number; stallMs: number; settleMs: number; minFrames: number } = WATCHDOG) {}

  /** Forget the window and wait the grace (after entering the world, a preset change or a rebuild). */
  reset(nowMs: number): void {
    this.at.length = 0
    this.ms.length = 0
    this.graceUntil = nowMs + this.cfg.graceMs
    this.lastCheck = -Infinity
    this.probeSince = NaN
  }

  /** True while the watchdog waits for the GPU frame time before it decides (the caller turns the measuring on). */
  get wantsGpu(): boolean {
    return this.probeSince >= 0
  }

  /** The world is busy (streaming, compiling shaders): forget the window and wait settleMs past now (or the grace). */
  settle(nowMs: number): void {
    this.at.length = 0
    this.ms.length = 0
    this.graceUntil = Math.max(this.graceUntil, nowMs + this.cfg.settleMs)
    this.lastCheck = -Infinity
    this.probeSince = NaN
  }

  /**
   * One frame of `frameMs` (the rAF interval) at `nowMs` (`busy`: the world is streaming or compiling). True when the
   * p95 is over the limit and `cost` (when given) does not show a frame rate capped by the display (V-12).
   */
  sample(frameMs: number, nowMs: number, busy = false, cost?: FrameCost | null): boolean {
    if (busy) {
      this.settle(nowMs)
      return false
    }
    if (nowMs < this.graceUntil || !(frameMs > 0) || frameMs >= this.cfg.stallMs) return false
    this.at.push(nowMs)
    this.ms.push(frameMs)
    const from = nowMs - this.cfg.windowMs
    let drop = 0
    while (drop < this.at.length && this.at[drop]! < from) drop++
    if (drop) {
      this.at.splice(0, drop)
      this.ms.splice(0, drop)
    }
    // Judge once a second, and only over a (nearly) full window.
    if (nowMs - this.lastCheck < 1000) return false
    this.lastCheck = nowMs
    if (this.ms.length < this.cfg.minFrames || nowMs - this.at[0]! < this.cfg.windowMs * 0.9) return false
    if (this.p95() <= this.cfg.p95Ms) {
      this.probeSince = NaN
      return false
    }
    const why = cost ? this.capped(cost, nowMs) : null
    if (why === 'wait') return false
    if (why) {
      // capped, not slow: a fresh window (no new grace), judged again once it is full
      this.hold = why
      this.at.length = 0
      this.ms.length = 0
      return false
    }
    this.hold = null
    this.reset(nowMs)
    return true
  }

  /** Over the limit: is the frame rate capped by the display rather than slow? ('wait': the GPU time is coming.) */
  private capped(cost: FrameCost, nowMs: number): WatchdogHold | 'wait' | null {
    const pace = cost.paceMs()
    if (pace !== null && pace > 0 && this.p95() <= pace * WATCHDOG_CAP.paceSlack) {
      this.probeSince = NaN
      return 'pace'
    }
    const gpu = cost.gpuMs()
    const cpu = cost.cpuMs()
    if (gpu !== null && gpu > 0 && cpu !== null) {
      this.probeSince = NaN
      return Math.max(gpu, cpu) <= this.median() * WATCHDOG_CAP.workFraction ? 'work' : null
    }
    if (cost.gpuMeasurable() && cpu !== null) {
      if (!(this.probeSince >= 0)) this.probeSince = nowMs
      if (nowMs - this.probeSince < WATCHDOG_CAP.probeMs) return 'wait'
    }
    // no GPU time to be had: the CPU alone cannot clear a frame (the GPU may be the slow part)
    this.probeSince = NaN
    return null
  }

  /** The median of the window's frame times (ms; 0 when empty). */
  private median(): number {
    if (!this.ms.length) return 0
    const sorted = [...this.ms].sort((a, b) => a - b)
    return sorted[sorted.length >> 1]!
  }

  /** The 95th percentile of the window's frame times (ms; 0 when empty). */
  p95(): number {
    if (!this.ms.length) return 0
    const sorted = [...this.ms].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
  }
}

// ---- resolution -------------------------------------------------------------------------------------

/** Hardware scaling level for a resolution fraction (Babylon renders at 1/level device pixels per CSS pixel). */
export function scalingLevel(resolution: number, dpr: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  return 1 / (d * resolution)
}

/**
 * Who takes the resolution instead of the canvas: the world's post stack on the PBR presets, which renders at that
 * scale and upscales with FSR1 (RENDER §5.6). It returns true when FSR1 took it (the canvas then stays at full size),
 * false when the canvas must scale (Classic, or a preset whose prepass renders at full size).
 */
export type RenderScaleHandler = (resolution: Resolution) => boolean

let scaleHandler: RenderScaleHandler | null = null
let reapplyResolution: (() => void) | null = null

/** Sets (or clears) the render-scale handler and applies the resolution again. */
export function setRenderScaleHandler(h: RenderScaleHandler | null): void {
  scaleHandler = h
  reapplyResolution?.()
}

/** Applies the resolution again (after the world's material path or post stack changed). */
export function refreshResolution(): void {
  reapplyResolution?.()
}

/**
 * Applies the resolution now and on every change. Babylon (adaptToDeviceRatio) rescales the level itself when the
 * device pixel ratio changes, so the chosen fraction survives moving the window between screens. Wave 9: while a
 * render-scale handler takes the fraction (FSR1 on the PBR presets), the canvas renders at full size.
 */
export function applyGraphics(engine: { resize(): void; setHardwareScalingLevel(level: number): void }, store: SettingsStore = settings): () => void {
  const apply = () => {
    try {
      const r = store.get().graphics.resolution
      let fsr = false
      try {
        fsr = scaleHandler?.(r) ?? false
      } catch (err) {
        console.warn('[settings] render scale not handed to the post stack', err)
      }
      // resize() first so Babylon's own DPR bookkeeping is current and does not rescale the new level.
      engine.resize()
      engine.setHardwareScalingLevel(scalingLevel(fsr ? 1 : r, typeof window === 'undefined' ? 1 : window.devicePixelRatio))
    } catch (err) {
      console.warn('[settings] resolution not applied', err)
    }
  }
  reapplyResolution = apply
  apply()
  const off = store.onChange((s, prev) => {
    if (s.graphics.resolution !== prev.graphics.resolution) apply()
  })
  return () => {
    off()
    if (reapplyResolution === apply) reapplyResolution = null
  }
}

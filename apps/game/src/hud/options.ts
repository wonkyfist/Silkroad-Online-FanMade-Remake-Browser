/**
 * Options window (Esc → Options, or the menu bar; docs/UX_GAPS.md W1, §4.3, R4–R6). Tabs Graphics / Interface /
 * Controls / Audio. Every change applies at once and persists (settings.ts), like SRO's Apply-Cancel-Confirm without
 * the Apply step; Default restores everything. Audio lives in the sound lane's own window (docs/SOUND.md §5.12): the
 * Audio tab only opens it, through the Esc-menu entry that lane registers (id 'sound').
 * Rows whose setting nothing in the game reads yet stay out (OPTIONAL_ROWS), so no control is a dead switch.
 *
 * Wave 9 (GAME, docs/WAVE_PLAN3.md §6.15): the preset with Ultra (Low reads "Low (Classic)" once the new look is on),
 * the "Modern graphics (preview)" toggle while rollout.ts says 'preview' (with the first-run recommendation under it),
 * the sky style and the Advanced rows. A row may depend on the settings (`when`: the page is laid out again when that
 * changes), and a change that switches the material path asks first (`confirm`: the world rebuilds).
 */
import { t, type StringKey } from '../i18n/index.ts'
import { RENDER_ROLLOUT, type RenderRollout } from '../rollout.ts'
import {
  ADVANCED_CHOICES,
  AUTO_POTION_PCT_MAX,
  AUTO_POTION_PCT_MIN,
  AUTO_POTION_PCT_STEP,
  BLOOM_SETTINGS,
  CAMERA_SPEED_MAX,
  CAMERA_SPEED_MIN,
  PRESETS,
  SCATTER_SETTINGS,
  SKY_SETTINGS,
  TEXTURE_SETTINGS,
  TONE_MAPS,
  TOWN_LIFE_OFF,
  TOWN_LIFE_SETTINGS,
  TREES_SETTINGS,
  WILDLIFE_SETTINGS,
  classicLook,
  effectiveGraphics,
  modernGraphics,
  newLook,
  patchedSettings,
  settings,
  type AdvancedGraphics,
  type DeepPartial,
  type GraphicsPreset,
  type Settings,
  type SettingsStore,
} from '../settings.ts'
import type { Art } from '../ui/art.ts'
import { el, place } from '../ui/dom.ts'
import { button } from '../ui/kit/button.ts'
import { Checkbox, RadioGroup } from '../ui/kit/check.ts'
import { MessageBox } from '../ui/kit/dialog.ts'
import { Frame } from '../ui/kit/frame.ts'
import { ScrollArea } from '../ui/kit/scroll.ts'
import { Slider } from '../ui/kit/slider.ts'
import { TabBar } from '../ui/kit/tabs.ts'
import { Window } from '../ui/kit/window.ts'
import { UI_SCALE_MODES, type UiScaleMode } from '../ui/kit/scale.ts'
import { Select } from '../ui/kit/select.ts'
import { menuItems, type MenuContext } from './menu-items.ts'
import { ensureUxStyles } from './ux-style.ts'

export type OptionsTab = 'graphics' | 'interface' | 'controls' | 'audio'
export const OPTIONS_TABS: readonly OptionsTab[] = ['graphics', 'interface', 'controls', 'audio']

/**
 * Rows for settings other lanes consume (UX-B nameplates, camera keys, hold-to-move...). A row is shown only when its
 * id is listed here, i.e. once the game actually honours it. Add an id when its consumer lands.
 */
export const OPTIONAL_ROWS: ReadonlySet<string> = new Set<string>([
  // UX-B: nameplates (world/features/ux-world.ts), EXP line in chat, hold to move, camera keys (world/camera-keys.ts)
  'ui.names.players',
  'ui.names.mobs',
  'ui.names.npcs',
  'ui.names.items',
  'ui.expInChat',
  'controls.holdToMove',
  'controls.cameraSpeed',
  'controls.invertY',
  // UX-R: camera modes and shake (world/camera-keys.ts), Z nearest monster (world/features/ux-world.ts)
  'controls.cameraMode',
  'controls.nearestTargetKey',
  'controls.cameraShake',
  // MV-WASD: walking with W A S D and the arrows (world/features/keymove.ts, world/camera-keys.ts)
  'controls.keyboardMove',
  // The "cannot get there" warning (world/move-feedback.ts through ux-world.ts) and the auto potion
  // (world/features/auto-potion.ts).
  'controls.unreachableWarning',
  'autoPotion',
  'autoPotion.enabled',
  'autoPotion.hp',
  'autoPotion.mp',
  'autoPotion.cure',
  // W5-G: grass and plants (world-render scatter.ts, through qualityFor)
  'graphics.scatter',
  // Wave 9B (TX-R): the texture tier (pbr/maps.ts through QualitySettings.render.textures and three/actor-textures.ts);
  // it replaces the retired "Remastered textures (test)" switch (graphics.remaster, an alias for one wave).
  'graphics.textures',
  // Wave 9 (GAME): the preview toggle and its hint, sky style, the Advanced rows (settings.ts effectiveGraphics). The
  // AO row stays out: the post stack keeps SSAO off for now (render/post.ts RenderPostOptions.ssao).
  'graphics.modern',
  'graphics.recommended',
  'graphics.sky',
  'graphics.classicLook',
  'graphics.advanced',
  'graphics.advanced.shadows',
  'graphics.advanced.reflections',
  'graphics.advanced.aa',
  'graphics.advanced.toneMap',
  // Mini-wave w12r (GODRAYS): Light shafts Auto / Off / Low / High (render/volumetrics through withLightShafts).
  'graphics.advanced.lightShafts',
  // Bloom over the preset's (render/quality.ts BLOOM_LOOKS; off by default).
  'graphics.bloom',
  'ui.clock',
  // Wave 10 (docs/WAVE_PLAN6.md §4.2, W10-G): the wildlife (World.life) and the region batches (World.setBatching),
  // both through world/graphics.ts.
  'graphics.wildlife',
  'graphics.advanced.batching',
  // Wave 11 (docs/WAVE_PLAN7.md §4.4, W11-G): the town life (World.town) through world/graphics.ts.
  'graphics.townLife',
  // Wave 12 (docs/WAVE_PLAN8.md D9, W12-G; TREES Part W): the new trees and plants (LoadWorldOptions.trees) through
  // world/graphics.ts.
  'graphics.trees',
  // CHARACTERS §16.2: the licensed characters' springs (three/char-physics.ts through world/graphics.ts).
  'graphics.hairCloth',
  'graphics.bodyPhysics',
])

/** Rows other lanes register that only mean something with the new look on (the weather feature's two rows). */
export const MODERN_ONLY_ROWS: ReadonlySet<string> = new Set(['graphics.weather', 'ui.reduceFlashing'])

type Patch = DeepPartial<Settings>

/**
 * Wave 9 row extras: `when` shows the row only for some settings (the page is laid out again when the answer changes);
 * `confirm` names the question to ask before a change is stored (null: store at once).
 */
interface RowExtras {
  when?(s: Settings): boolean
  /** Runs after a choice or toggle row's change was stored (Graphics mode offers a reload: gpu-loss.ts). */
  after?(s: Settings): void
}

export type OptionRow = RowExtras & (
  | { id: string; kind: 'choice'; label: StringKey; choices: { value: string | number; label: string }[]; get(s: Settings): string | number; patch(v: string | number): Patch; style?: 'buttons' | 'select'; confirm?(s: Settings, patch: Patch): StringKey | null }
  | { id: string; kind: 'toggle'; label: StringKey; get(s: Settings): boolean; patch(v: boolean): Patch; confirm?(s: Settings, patch: Patch): StringKey | null }
  | { id: string; kind: 'range'; label: StringKey; min: number; max: number; step: number; get(s: Settings): number; patch(v: number): Patch; format(v: number): string }
  | { id: string; kind: 'button'; label: StringKey; run(): void; enabled?: () => boolean; note?: () => string }
  | { id: string; kind: 'info'; text(): string }
)

/**
 * The question before a change that switches the material path (Classic ↔ PBR): the world rebuilds around the player,
 * like a resolution change (RENDER §3.1). null when the path stays.
 */
export function rebuildQuestion(s: Settings, patch: Patch, rollout: RenderRollout = RENDER_ROLLOUT): StringKey | null {
  const next = patchedSettings(s, patch)
  return effectiveGraphics(s, { rollout }).render !== effectiveGraphics(next, { rollout }).render ? 'options.rebuild.confirm' : null
}

/** The preset's label: Low is "Low (Classic)" once the new look is on (the other presets are PBR then). */
export function presetLabel(p: GraphicsPreset, s: Settings, rollout: RenderRollout = RENDER_ROLLOUT): string {
  if (p === 'low') return t(modernGraphics(s, rollout) ? 'options.quality.lowClassic' : 'options.quality.low')
  return t(`options.quality.${p}` as StringKey)
}

/** The Advanced rows mean something on the PBR presets only. */
const advancedShown = (rollout: RenderRollout) => (s: Settings) => effectiveGraphics(s, { rollout }).render === 'pbr'

/** One Advanced select row (graphics.advanced.<key>, 'auto' first). */
function advancedRow(key: Exclude<keyof AdvancedGraphics, 'toneMap'>, rollout: RenderRollout): OptionRow {
  return {
    id: `graphics.advanced.${key}`,
    kind: 'choice',
    style: 'select',
    label: `options.advanced.${key}` as StringKey,
    choices: ADVANCED_CHOICES[key].map(v => ({ value: v, label: t(`options.advanced.${key}.${v}` as StringKey) })),
    get: s => s.graphics.advanced[key],
    patch: v => ({ graphics: { advanced: { [key]: v } } }) as Patch,
    when: advancedShown(rollout),
  }
}

/** An auto potion threshold slider (autoPotion.hp / .mp: 0 = never, else the percent of the maximum). */
function autoPotionRow(key: 'hp' | 'mp'): OptionRow {
  return {
    id: `autoPotion.${key}`,
    kind: 'range',
    label: `options.autoPotion.${key}`,
    min: AUTO_POTION_PCT_MIN,
    max: AUTO_POTION_PCT_MAX,
    step: AUTO_POTION_PCT_STEP,
    get: s => s.autoPotion[key],
    patch: v => ({ autoPotion: { [key]: v } }) as Patch,
    format: v => (v > 0 ? t('options.autoPotion.pct', { pct: v }) : t('options.autoPotion.never')),
    when: s => s.autoPotion.enabled,
  }
}

export interface OptionsHost {
  /** The renderer name for the Graphics tab's read-only line. */
  engine: string
  /** Opens the key help window. */
  keyHelp(): void
  /** Short HUD message (fullscreen refused...). */
  toast(text: string): void
  /** For running another lane's Esc-menu entry (the sound window). */
  menu: MenuContext
}

const pct = (v: number) => Math.round(v * 100)

/** Fullscreen on the whole page (needs a user gesture: call from a click). */
export function toggleFullscreen(onFail?: () => void): void {
  try {
    const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()
    void p?.catch(() => onFail?.())
  } catch {
    onFail?.()
  }
}

/** The Esc-menu entry of the sound lane (registered as id 'sound'), if it has landed. */
const soundEntry = () => menuItems().find(m => m.id === 'sound')

/**
 * Every row of every tab (before OPTIONAL_ROWS filtering and `when`). `s` is only read for labels (the preset's Low);
 * `rollout` decides whether the preview toggle exists at all.
 */
export function optionRows(host: OptionsHost, s: Settings = settings.get(), rollout: RenderRollout = RENDER_ROLLOUT): Record<OptionsTab, OptionRow[]> {
  const modern = (x: Settings) => modernGraphics(x, rollout)
  // Rows that only mean something while the new look renders (not in the Low guard's combination: settings.ts newLook).
  const rendersNew = (x: Settings) => newLook(x, rollout)
  const preview: OptionRow[] = rollout === 'preview'
    ? [
      // rollout.ts: the whole new look behind one switch until the release.
      {
        id: 'graphics.modern',
        kind: 'toggle',
        label: 'options.modern',
        get: x => x.graphics.modern,
        patch: v => ({ graphics: { modern: v } }),
        confirm: (x, p) => rebuildQuestion(x, p, rollout),
      },
      {
        id: 'graphics.recommended',
        kind: 'info',
        text: () => {
          const r = s.graphics.recommended
          return r ? `${t('options.modern.recommended', { preset: presetLabel(r.preset, patchedSettings(s, { graphics: { modern: true } }), rollout) })} (${t(`options.modern.why.${r.why}` as StringKey)})` : ''
        },
        when: x => !!x.graphics.recommended,
      },
    ]
    : []
  return {
    graphics: [
      ...preview,
      {
        id: 'graphics.preset',
        kind: 'choice',
        style: 'select',
        label: 'options.quality',
        choices: PRESETS.map(p => ({ value: p, label: presetLabel(p, s, rollout) })),
        get: x => x.graphics.preset,
        patch: v => ({ graphics: { preset: v as Settings['graphics']['preset'] } }),
        confirm: (x, p) => rebuildQuestion(x, p, rollout),
      },
      {
        id: 'graphics.resolution',
        kind: 'choice',
        label: 'options.resolution',
        choices: [1, 0.75, 0.5].map(v => ({ value: v, label: t('options.resolution.value', { pct: pct(v) }) })),
        get: s => s.graphics.resolution,
        patch: v => ({ graphics: { resolution: v as Settings['graphics']['resolution'] } }),
      },
      {
        id: 'graphics.sight',
        kind: 'range',
        label: 'options.sight',
        min: 0,
        max: 3,
        step: 1,
        get: s => s.graphics.sight,
        patch: v => ({ graphics: { sight: v as Settings['graphics']['sight'] } }),
        format: v => t(`options.sight.${v}` as StringKey),
      },
      // Wave 10 (GRASS_LIFE Q2): the scatter row is "Grass" (values unchanged; on the PBR presets Low is the new grass at
      // full density over a shorter reach).
      {
        id: 'graphics.scatter',
        kind: 'choice',
        label: 'options.grass',
        choices: SCATTER_SETTINGS.map(v => ({ value: v, label: t(`options.scatter.${v}`) })),
        get: s => s.graphics.scatter,
        patch: v => ({ graphics: { scatter: v as Settings['graphics']['scatter'] } }),
      },
      // Wave 10 (GRASS_LIFE §5): butterflies, birds, fireflies and dragonflies; the PBR presets only (Low has none).
      {
        id: 'graphics.wildlife',
        kind: 'choice',
        label: 'options.wildlife',
        choices: WILDLIFE_SETTINGS.map(v => ({ value: v, label: t(`options.wildlife.${v}`) })),
        get: x => x.graphics.wildlife,
        patch: v => ({ graphics: { wildlife: v as Settings['graphics']['wildlife'] } }),
        when: advancedShown(rollout),
      },
      // Wave 11 (TOWN_LIFE §8.2): the Jangan townsfolk, animals and bubbles; the PBR presets only (Low has none).
      {
        id: 'graphics.townLife',
        kind: 'choice',
        label: 'options.townLife',
        choices: TOWN_LIFE_SETTINGS.map(v => ({ value: v, label: t(`options.townLife.${v}`) })),
        get: x => x.graphics.townLife,
        patch: v => ({ graphics: { townLife: v as Settings['graphics']['townLife'] } }),
        // hidden while the townsfolk are switched off (settings.ts TOWN_LIFE_OFF)
        when: s => !TOWN_LIFE_OFF && advancedShown(rollout)(s),
      },
      // Wave 12 (TREES Part W): our 35 species or the retail trees and plants; the PBR presets only (Low keeps retail).
      {
        id: 'graphics.trees',
        kind: 'choice',
        label: 'options.trees',
        choices: TREES_SETTINGS.map(v => ({ value: v, label: t(`options.trees.${v}`) })),
        get: x => x.graphics.trees,
        patch: v => ({ graphics: { trees: v as Settings['graphics']['trees'] } }),
        when: advancedShown(rollout),
      },
      // CHARACTERS §16.2: hair and cloth / body springs on the licensed characters; the PBR presets only (Low has none).
      { id: 'graphics.hairCloth', kind: 'toggle', label: 'options.hairCloth', get: x => x.graphics.hairCloth, patch: v => ({ graphics: { hairCloth: v } }), when: advancedShown(rollout) },
      { id: 'graphics.bodyPhysics', kind: 'toggle', label: 'options.bodyPhysics', get: x => x.graphics.bodyPhysics, patch: v => ({ graphics: { bodyPhysics: v } }), when: advancedShown(rollout) },
      // Wave 9B (TX-R): the texture tier, read when a material or a terrain tile loads, so it applies after a reload.
      // With the new look only (without it every texture is retail: the Low guard).
      {
        id: 'graphics.textures',
        kind: 'choice',
        style: 'select',
        label: 'options.textures',
        choices: TEXTURE_SETTINGS.map(v => ({ value: v, label: t(`options.textures.${v}` as StringKey) })),
        get: x => x.graphics.textures,
        // The retired test switch (graphics.remaster, an alias for one wave) goes off with the first change here.
        patch: v => ({ graphics: { textures: v as Settings['graphics']['textures'], remaster: false } }),
        when: rendersNew,
      },
      // Wave 9: the sky style (Classic = the 2005 dome, live without a reload) and the Advanced rows (PBR presets).
      {
        id: 'graphics.sky',
        kind: 'choice',
        label: 'options.sky',
        choices: SKY_SETTINGS.map(v => ({ value: v, label: t(`options.sky.${v}`) })),
        get: x => x.graphics.sky,
        patch: v => ({ graphics: { sky: v as Settings['graphics']['sky'] } }),
        when: modern,
      },
      // The Low guard's combination (Low + Classic sky + Weather off, settings.ts classicLook) is the look from before
      // wave 9: say so, since it also stops the time of day and the weather (the Sky or Weather row leaves it).
      { id: 'graphics.classicLook', kind: 'info', text: () => t('options.classicLook'), when: x => modern(x) && classicLook(x) },
      { id: 'graphics.advanced', kind: 'info', text: () => t('options.advanced'), when: advancedShown(rollout) },
      advancedRow('shadows', rollout),
      advancedRow('ao', rollout),
      advancedRow('reflections', rollout),
      advancedRow('aa', rollout),
      {
        id: 'graphics.advanced.toneMap',
        kind: 'choice',
        label: 'options.advanced.toneMap',
        choices: TONE_MAPS.map(v => ({ value: v, label: t(`options.advanced.toneMap.${v}`) })),
        get: x => x.graphics.advanced.toneMap,
        patch: v => ({ graphics: { advanced: { toneMap: v as AdvancedGraphics['toneMap'] } } }),
        when: advancedShown(rollout),
      },
      // Bloom (live: the post stack rebuilds). Only the PBR presets have one; Low / Classic has no post stack.
      {
        id: 'graphics.bloom',
        kind: 'choice',
        label: 'options.bloom',
        choices: BLOOM_SETTINGS.map(v => ({ value: v, label: t(`options.bloom.${v}`) })),
        get: x => x.graphics.bloom,
        patch: v => ({ graphics: { bloom: v as Settings['graphics']['bloom'] } }),
        when: advancedShown(rollout),
      },
      // Wave 10 (BATCHING Q3): World batching on / off (the regions rebuild); the PBR presets only, like every Advanced row.
      advancedRow('batching', rollout),
      // w12r (GODRAYS): the sun shafts; PBR presets only (Low has no post stack), like every Advanced row.
      advancedRow('lightShafts', rollout),
      {
        id: 'fullscreen',
        kind: 'button',
        label: 'options.fullscreen',
        run: () => toggleFullscreen(() => host.toast(t('options.fullscreenFailed'))),
        enabled: () => typeof document !== 'undefined' && document.fullscreenEnabled !== false,
      },
      { id: 'engine', kind: 'info', text: () => t('options.engine', { engine: host.engine }) },
    ],
    interface: [
      // UI scale (UI-K, docs/UI.md §4.1): Auto or a retail step; the id stays 'ui.scale' (the row's place and tests).
      {
        id: 'ui.scale',
        kind: 'choice',
        style: 'select',
        label: 'options.uiScale',
        choices: UI_SCALE_MODES.map(v => ({ value: v, label: v === 'auto' ? t('options.uiScale.auto') : t('options.uiScale.value', { pct: pct(v) }) })),
        get: s => s.ui.scaleMode,
        patch: v => ({ ui: { scaleMode: v as UiScaleMode } }),
      },
      { id: 'ui.showFps', kind: 'toggle', label: 'options.showFps', get: s => s.ui.showFps, patch: v => ({ ui: { showFps: v } }) },
      { id: 'ui.damageNumbers', kind: 'toggle', label: 'options.damageNumbers', get: s => s.ui.damageNumbers, patch: v => ({ ui: { damageNumbers: v } }) },
      { id: 'ui.names.players', kind: 'toggle', label: 'options.names.players', get: s => s.ui.names.players, patch: v => ({ ui: { names: { players: v } } }) },
      { id: 'ui.names.mobs', kind: 'toggle', label: 'options.names.mobs', get: s => s.ui.names.mobs, patch: v => ({ ui: { names: { mobs: v } } }) },
      { id: 'ui.names.npcs', kind: 'toggle', label: 'options.names.npcs', get: s => s.ui.names.npcs, patch: v => ({ ui: { names: { npcs: v } } }) },
      {
        id: 'ui.names.items',
        kind: 'choice',
        label: 'options.names.items',
        choices: (['always', 'near', 'hover'] as const).map(v => ({ value: v, label: t(`options.names.items.${v}`) })),
        get: s => s.ui.names.items,
        patch: v => ({ ui: { names: { items: v as Settings['ui']['names']['items'] } } }),
      },
      { id: 'ui.expInChat', kind: 'toggle', label: 'options.expInChat', get: s => s.ui.expInChat, patch: v => ({ ui: { expInChat: v } }) },
      // Wave 9: the game clock next to the minimap (world/features/sky-clock.ts; shown while the time runs, so not in
      // the Low guard's combination, where the noon is frozen).
      { id: 'ui.clock', kind: 'toggle', label: 'options.clock', get: x => x.ui.clock, patch: v => ({ ui: { clock: v } }), when: rendersNew },
    ],
    controls: [
      { id: 'controls.keyboardMove', kind: 'toggle', label: 'options.keyboardMove', get: s => s.controls.keyboardMove, patch: v => ({ controls: { keyboardMove: v } }) },
      { id: 'controls.holdToMove', kind: 'toggle', label: 'options.holdToMove', get: s => s.controls.holdToMove, patch: v => ({ controls: { holdToMove: v } }) },
      {
        id: 'controls.cameraSpeed',
        kind: 'range',
        label: 'options.cameraSpeed',
        min: CAMERA_SPEED_MIN,
        max: CAMERA_SPEED_MAX,
        step: 0.25,
        get: s => s.controls.cameraSpeed,
        patch: v => ({ controls: { cameraSpeed: v } }),
        format: v => t('options.cameraSpeed.value', { x: v.toFixed(2).replace(/0$/, '') }),
      },
      { id: 'controls.invertY', kind: 'toggle', label: 'options.invertY', get: s => s.controls.invertY, patch: v => ({ controls: { invertY: v } }) },
      {
        id: 'controls.cameraMode',
        kind: 'choice',
        label: 'options.cameraMode',
        choices: (['free', 'third', 'quarter'] as const).map(v => ({ value: v, label: t(`options.cameraMode.${v}`) })),
        get: s => s.controls.cameraMode,
        patch: v => ({ controls: { cameraMode: v as Settings['controls']['cameraMode'] } }),
      },
      { id: 'controls.nearestTargetKey', kind: 'toggle', label: 'options.nearestTargetKey', get: s => s.controls.nearestTargetKey, patch: v => ({ controls: { nearestTargetKey: v } }) },
      { id: 'controls.cameraShake', kind: 'toggle', label: 'options.cameraShake', get: s => s.controls.cameraShake, patch: v => ({ controls: { cameraShake: v } }) },
      { id: 'controls.unreachableWarning', kind: 'toggle', label: 'options.unreachableWarning', get: s => s.controls.unreachableWarning, patch: v => ({ controls: { unreachableWarning: v } }) },
      { id: 'keyHelp', kind: 'button', label: 'options.keyHelp', run: () => host.keyHelp() },
      // Auto potion (world/features/auto-potion.ts): the thresholds and the pill switch show while it is on.
      { id: 'autoPotion', kind: 'info', text: () => t('options.autoPotion') },
      { id: 'autoPotion.enabled', kind: 'toggle', label: 'options.autoPotion.enabled', get: s => s.autoPotion.enabled, patch: v => ({ autoPotion: { enabled: v } }) },
      autoPotionRow('hp'),
      autoPotionRow('mp'),
      { id: 'autoPotion.cure', kind: 'toggle', label: 'options.autoPotion.cure', get: s => s.autoPotion.cure, patch: v => ({ autoPotion: { cure: v } }), when: s => s.autoPotion.enabled },
    ],
    audio: [
      {
        id: 'sound',
        kind: 'button',
        label: 'options.sound',
        run: () => soundEntry()?.run(host.menu),
        enabled: () => !!soundEntry(),
        note: () => t(soundEntry() ? 'options.soundHint' : 'options.soundMissing'),
      },
    ],
  }
}

/** Rows that are always shown, plus the optional ones whose consumer is listed in OPTIONAL_ROWS. */
const ALWAYS = new Set(['graphics.preset', 'graphics.resolution', 'graphics.sight', 'fullscreen', 'engine', 'ui.scale', 'ui.showFps', 'ui.damageNumbers', 'keyHelp', 'sound'])
export function visibleRows(rows: readonly OptionRow[], optional: ReadonlySet<string> = OPTIONAL_ROWS): OptionRow[] {
  return rows.filter(r => ALWAYS.has(r.id) || optional.has(r.id))
}

// ---- M10: option rows of other lanes ------------------------------------------------------------------------

const registered: Record<OptionsTab, OptionRow[]> = { graphics: [], interface: [], controls: [], audio: [] }
/** Called after a row registers or unregisters (an Options window lays its page out again). */
const rowListeners = new Set<(page: OptionsTab) => void>()

function rowsChanged(page: OptionsTab): void {
  for (const fn of [...rowListeners]) fn(page)
}

/**
 * M10 (decision D18): adds a row to an Options page (wave 8: GU-C's "Display guild name" on Interface). Registered
 * rows are always shown (their consumer exists by definition) and follow the page's own rows. Returns an unregister
 * function. The world features register theirs when the world screen starts, after the Options window was built (the
 * UX shell makes it at boot), so open windows are told (`onOptionRowsChange`).
 */
export function registerOptionRow(page: OptionsTab, row: OptionRow): () => void {
  const list = registered[page]
  const i = list.findIndex(r => r.id === row.id)
  if (i >= 0) list.splice(i, 1)
  list.push(row)
  rowsChanged(page)
  return () => {
    const j = list.indexOf(row)
    if (j < 0) return
    list.splice(j, 1)
    rowsChanged(page)
  }
}

/** Calls `fn` with the page whenever a row registers or unregisters on it; returns the unsubscribe function. */
export function onOptionRowsChange(fn: (page: OptionsTab) => void): () => void {
  rowListeners.add(fn)
  return () => void rowListeners.delete(fn)
}

/** The rows other lanes registered on a page. */
export function registeredOptionRows(page: OptionsTab): readonly OptionRow[] {
  return registered[page]
}

/**
 * A page's rows as shown for settings `s`: its own visible rows, then the registered ones; rows whose `when` says no
 * are left out, and so are the MODERN_ONLY_ROWS other lanes register while the new look is off.
 */
export function pageRows(host: OptionsHost, tab: OptionsTab, s: Settings = settings.get(), rollout: RenderRollout = RENDER_ROLLOUT): OptionRow[] {
  const own = visibleRows(optionRows(host, s, rollout)[tab])
  const modern = modernGraphics(s, rollout)
  const rows = [...own, ...registered[tab].filter(r => !own.some(o => o.id === r.id) && (modern || !MODERN_ONLY_ROWS.has(r.id)))]
  return rows.filter(r => !r.when || r.when(s))
}

/** What decides a page's layout (its row ids and the Low label): the window lays the page out again when it changes. */
export function pageLayoutKey(host: OptionsHost, tab: OptionsTab, s: Settings, rollout: RenderRollout = RENDER_ROLLOUT): string {
  return `${modernGraphics(s, rollout)}|${pageRows(host, tab, s, rollout).map(r => r.id).join(',')}`
}

/** Retail `GDR_OPTION` (`ifsystemwnd.txt`): mframe 386×413, page `int_window_` (11,62,364,313), buttons at y 379. */
export const OPTIONS_W = 386
export const OPTIONS_H = 413

export class OptionsWindow extends Window {
  private tab: OptionsTab = 'graphics'
  private readonly tabBar: TabBar<OptionsTab>
  private readonly panel: ScrollArea
  /** Re-reads the settings into the visible controls. */
  private syncs: ((s: Settings) => void)[] = []
  /** Controls of the shown page that need disposing (selects). */
  private disposers: (() => void)[] = []
  /** The shown page's layout key (pageLayoutKey). */
  private layout = ''
  private readonly off: () => void
  private readonly offRows: () => void

  constructor(art: Art, parent: HTMLElement, private readonly host: OptionsHost, private readonly store: SettingsStore = settings) {
    super(art, parent, { id: 'options', title: t('options.title'), width: OPTIONS_W, height: OPTIONS_H, at: [0.5, 0.4], inset: [0, 0, 0, 0], className: 'hud-window hud-window-options' })
    ensureUxStyles()
    this.titleStrip.classList.add('hud-window-title')
    this.body.classList.add('hud-window-body', 'opt-body')
    this.body.style.top = '36px'
    this.tabBar = new TabBar(art, 'long', OPTIONS_TABS.map(tab => ({ id: tab, label: t(`options.tab.${tab}` as StringKey) })), { className: 'opt-tabs' })
    this.tabBar.onChange = tab => this.show(tab)
    place(this.tabBar.root, [11, 2, 364, 24])
    const page = new Frame(art, 'inner', { at: [11, 26, 364, 313], className: 'opt-page' })
    this.panel = new ScrollArea(art, { w: 340, h: 293, className: 'opt-panel' })
    place(this.panel.root, [12, 10, 340, 293])
    page.root.append(this.panel.root)
    const reset = button(art, { label: t('options.default') }, () => {
      // The help-hint counter is bookkeeping, not an option: keep it.
      const hint = this.store.get().ui.helpHintSessions
      this.store.reset()
      this.store.set({ ui: { helpHintSessions: hint } })
      this.host.toast(t('options.defaulted'))
    })
    const close = button(art, { label: t('options.close'), primary: true }, () => this.close())
    place(reset, [29, 343, 0, 24])
    place(close, [281, 343, 0, 24])
    this.body.append(this.tabBar.root, page.root, reset, close)
    this.off = this.store.onChange(s => this.sync(s))
    // The page is laid out here, at boot, before the world features register their rows (the weather's "Weather
    // effects"): a row that comes or goes later lays the shown page out again (it used to wait for the next settings
    // change, so the menu bar's toggle opened a page without the row).
    this.offRows = onOptionRowsChange(page => {
      if (page === this.tab) this.sync(this.store.get())
    })
    if (typeof document !== 'undefined') this.ls.on(document, 'fullscreenchange', () => this.sync(this.store.get()))
    this.show('graphics')
  }

  /** Opens on `tab` (or the last one). */
  openTab(tab?: OptionsTab): void {
    if (tab) this.show(tab)
    else this.show(this.tab)
    this.open()
  }

  /** Every open (the menu bar's toggle too, which skips openTab) shows the page as the rows and settings are now. */
  protected override onOpen(): void {
    this.sync(this.store.get())
  }

  override dispose(): void {
    this.off()
    this.offRows()
    for (const d of this.disposers.splice(0)) d()
    this.panel.dispose()
    super.dispose()
  }

  private show(tab: OptionsTab, keepScroll = false): void {
    const top = this.panel.view.scrollTop
    const s = this.store.get()
    this.tab = tab
    this.tabBar.value = tab
    this.syncs = []
    for (const d of this.disposers.splice(0)) d()
    this.layout = pageLayoutKey(this.host, tab, s)
    this.panel.view.replaceChildren(...pageRows(this.host, tab, s).map(r => this.row(r)))
    this.panel.view.scrollTop = keepScroll ? top : 0
    this.sync(s)
  }

  private sync(s: Settings): void {
    // Wave 9: a row that comes or goes with the settings (the preview toggle, a PBR preset) lays the page out again.
    if (pageLayoutKey(this.host, this.tab, s) !== this.layout) return this.show(this.tab, true)
    for (const fn of this.syncs) fn(s)
  }

  /** Stores a row's change, first asking its question when it has one (a Classic ↔ PBR switch rebuilds the world). */
  private commit(r: OptionRow, patch: Patch): void {
    const ask = (r.kind === 'choice' || r.kind === 'toggle') && r.confirm ? r.confirm(this.store.get(), patch) : null
    const store = () => {
      this.store.set(patch)
      r.after?.(this.store.get())
    }
    if (!ask) return store()
    void MessageBox.confirm({ art: this.art, title: t('options.rebuild.title'), text: t(ask) }).then(ok => {
      if (ok) store()
      else this.sync(this.store.get()) // the control goes back to the stored value
    })
  }

  private row(r: OptionRow): HTMLElement {
    const art = this.art
    const line = el('div', `ux-opt-row opt-row opt-${r.kind}`)
    line.dataset.row = r.id
    if (r.kind === 'info') {
      line.append(el('div', 'opt-info', r.text()))
      return line
    }
    if (r.kind === 'button') {
      const b = button(art, { label: t(r.label), minWidth: 150 }, () => {
        try {
          r.run()
        } catch (err) {
          console.error(`[options] ${r.id} failed`, err)
        }
      })
      const note = el('div', 'opt-note')
      line.append(b, note)
      this.syncs.push(() => {
        b.setDisabled(r.enabled ? !r.enabled() : false)
        note.textContent = r.note?.() ?? ''
        if (r.id === 'fullscreen') b.setLabel(t(document.fullscreenElement ? 'options.fullscreenExit' : 'options.fullscreen'))
      })
      return line
    }
    if (r.kind === 'toggle') {
      const check = new Checkbox(art, { label: t(r.label) })
      check.onChange = v => this.commit(r, r.patch(v))
      line.append(check.root)
      this.syncs.push(s => {
        check.checked = r.get(s)
      })
      return line
    }
    line.append(el('div', 'opt-label kit-t-label', t(r.label)))
    if (r.kind === 'choice' && r.style === 'select') {
      const select = new Select(art, r.choices, { w: 150, label: t(r.label) })
      select.onChange = v => this.commit(r, r.patch(v))
      line.append(select.root)
      this.disposers.push(() => select.dispose())
      this.syncs.push(s => {
        select.value = r.get(s)
      })
    } else if (r.kind === 'choice') {
      const group = new RadioGroup(art, r.choices, { className: 'opt-choices' })
      group.onChange = v => this.commit(r, r.patch(v))
      line.append(group.root)
      this.syncs.push(s => {
        group.value = r.get(s)
      })
    } else {
      const slider = new Slider(art, { min: r.min, max: r.max, step: r.step, value: r.get(this.store.get()) })
      const value = el('span', 'opt-value kit-t-value')
      // The value text follows the drag; the setting applies on release (a live UI scale would move the window away).
      slider.onInput = v => {
        value.textContent = r.format(v)
      }
      slider.onChange = v => this.store.set(r.patch(v))
      line.append(el('div', 'opt-control', slider.root, value))
      this.syncs.push(s => {
        const v = r.get(s)
        slider.set(v)
        value.textContent = r.format(v)
      })
    }
    return line
  }
}

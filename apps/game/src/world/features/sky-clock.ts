/**
 * The world clock on the client (docs/SKY.md §2.2, docs/WAVE_PLAN3.md §6.15, lane GAME): takes `worldEnter.world.clock`
 * and `worldClock` messages and runs `world.setClock(clock, ctx.serverNow)`, so the sun, the moon and the retail palette
 * follow the server's time of day; shows the game time next to the minimap while `ui.clock` is on.
 *
 * - The rollout gate (rollout.ts, settings.ts effectiveGraphics().clock): without the new look (the preview off, or the
 *   Low guard's combination Low + classic sky + weather off) the world keeps the frozen noon it had before wave 9
 *   (`setTimeOfDay(0.5)` after a switch back) and no clock shows; the messages are still kept, so turning the new look
 *   on starts the right time at once.
 * - An older server without `world.clock` (I9A check 6): a local clock from noon at the default day length.
 * - `/time` in chat is the server's GM command (it answers in chat itself).
 */
import { DEFAULT_CLOCK, phaseForSolarTime, type WorldClockState } from '@sro/shared'
import type { World } from '@sro/world-render'
import { t } from '../../i18n/index.ts'
import { RENDER_ROLLOUT, type RenderRollout } from '../../rollout.ts'
import { effectiveGraphics, settings, type SettingsStore } from '../../settings.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'

/** The HUD clock's text refreshes this often (ms of page time). */
export const CLOCK_TEXT_MS = 1000

/** "05:27" for solar time `t` (0 = midnight). */
export function clockText(t: number): string {
  const f = Number.isFinite(t) ? t - Math.floor(t) : 0.5
  const minutes = Math.min(1439, Math.floor(f * 1440 + 1e-6))
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** The local clock of a server that sends none: noon now, running at the default day length. */
export function localNoonClock(serverNowMs: number): WorldClockState {
  return { anchorMs: serverNowMs, anchorDays: phaseForSolarTime(0.5, DEFAULT_CLOCK.nightSpeedup), ...DEFAULT_CLOCK }
}

/** Under the minimap plate, left of the corner mute button (style.css .corner: native top 178 px, right 6 px). */
const CSS = `
.sky-clock {
  position: absolute; left: 8px; top: 176px; min-width: 38px; padding: 1px 6px; pointer-events: auto;
  font: 11px/14px var(--font-body); color: var(--c-text); text-align: center; font-variant-numeric: tabular-nums;
  background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(156, 131, 80, 0.55); border-radius: 2px; text-shadow: var(--t-outline);
}
.sky-clock[hidden] { display: none; }
`
let styled = false

function ensureStyle(): void {
  if (styled || typeof document === 'undefined') return
  styled = true
  const style = document.createElement('style')
  style.dataset.owner = 'sky-clock'
  style.textContent = CSS
  document.head.append(style)
}

export interface SkyClockOptions {
  /** The settings store (default the page's). */
  store?: SettingsStore
  /** The rollout gate (default rollout.ts). */
  rollout?: RenderRollout
}

export function skyClockFeature(ctx: WorldFeatureContext, opts: SkyClockOptions = {}): WorldFeature {
  // A bare context (the feature-list test) gets no clock.
  if (!ctx.session) return {}
  const store = opts.store ?? settings
  const rollout = opts.rollout ?? RENDER_ROLLOUT
  /** The server's clock (null before worldEnter, or from a server without one). */
  let clock: WorldClockState | null = null
  /** The local clock for a server without one (made once, so the time carries on across a preview switch). */
  let local: WorldClockState | null = null
  let entered = false
  /** Whether the time runs (the rollout gate); read again on every settings change. */
  let on = effectiveGraphics(store.get(), { rollout }).clock
  /** What was last handed to which world (a clock, or null for the frozen noon); null before the first sync. */
  let applied: { world: World | null; clock: WorldClockState | null } | null = null
  let label: HTMLElement | null = null
  let labelParent: HTMLElement | null = null
  let nextText = 0

  const sync = () => {
    const world = ctx.world()?.world ?? null
    const want = on && entered ? clock ?? (local ??= localNoonClock(ctx.serverNow())) : null
    if (applied && applied.world === world && applied.clock === want) return
    applied = { world, clock: want }
    if (!world) return
    if (want) world.setClock(want, ctx.serverNow)
    // Back to the frozen noon of before wave 9 (only when something moved it: the load itself is at noon).
    else if (world.worldClock || world.timeOfDay !== 0.5) world.setTimeOfDay(0.5)
  }

  const showClock = (now: number) => {
    const world = ctx.world()?.world ?? null
    const parent = ctx.minimap()?.root ?? null
    const shown = !!world && !!parent && !!applied?.clock && store.get().ui.clock
    if (!shown) {
      if (label) label.hidden = true
      return
    }
    if (!label && typeof document !== 'undefined') {
      ensureStyle()
      label = document.createElement('div')
      label.className = 'sky-clock'
    }
    if (!label) return
    if (labelParent !== parent) {
      parent!.append(label)
      labelParent = parent
      nextText = 0
    }
    label.hidden = false
    if (now < nextText) return
    nextText = now + CLOCK_TEXT_MS
    label.textContent = clockText(world!.timeOfDay)
    label.title = t('sky.clock.title', { hours: +((applied?.clock?.dayMs ?? DEFAULT_CLOCK.dayMs) / 3_600_000).toFixed(1) })
  }

  const pageNow = () => (typeof performance === 'undefined' ? Date.now() : performance.now())
  const off = store.onChange(s => {
    on = effectiveGraphics(s, { rollout }).clock
    sync()
    nextText = 0
    showClock(pageNow())
  })

  return {
    onMessage(msg) {
      if (msg.t === 'worldEnter') {
        entered = true
        clock = msg.world.clock ?? null
      } else if (msg.t === 'worldClock') clock = msg.clock
      else return
      sync()
    },

    onFrame() {
      sync()
      showClock(pageNow())
    },

    dispose() {
      off()
      label?.remove()
      label = null
      labelParent = null
    },
  }
}

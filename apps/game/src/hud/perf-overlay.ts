/**
 * The FPS / ping / draw-call line (docs/UX_GAPS.md H1): hidden by default, shown by Options → Interface → Show FPS or
 * Ctrl+Shift+F. Top-left beside the player frame, light text on a shade. The world screen feeds it the numbers it
 * already measures (every 0.5 s); nothing is computed here.
 *
 * Wave 9 (GAME, docs/WAVE_PLAN3.md §6.15): a second line with the material path and the preset the renderer runs, the
 * GPU frame time where the device measures it (timestamp-query), and the weather (world.weather.stats()).
 */
import { t } from '../i18n/index.ts'
import { settings, type Settings, type SettingsStore } from '../settings.ts'
import { el } from '../ui/dom.ts'
import { ensureUxStyles } from './ux-style.ts'

export interface PerfSample {
  engine: string
  fps: number
  /** Round trip in ms; null before the first pong. */
  ping: number | null
  players: number
  draws: number
  mock: boolean
  /** Wave 9: the material path and the preset the renderer runs (absent: no world yet). */
  render?: { mode: 'classic' | 'pbr'; preset: string } | null
  /** Wave 9: the GPU's frame time in ms (null or absent: not measured on this device). */
  gpuMs?: number | null
  /** Wave 9: the weather the world shows (absent: none). */
  weather?: { level: string; rain: number; wet: number } | null
}

export const perfVisible = (s: Settings): boolean => s.ui.showFps

export function perfText(p: PerfSample): string {
  const line =
    t('world.stats', {
      engine: p.engine,
      fps: p.fps.toFixed(0),
      ping: p.ping !== null && Number.isFinite(p.ping) ? t('world.statsPing', { ms: p.ping.toFixed(0) }) : t('world.statsNoPing'),
      players: p.players,
    }) +
    t('world.statsDraws', { draws: p.draws.toFixed(0) }) +
    (p.mock ? t('world.statsMock') : '')
  if (!p.render) return line
  const render =
    t('world.statsRender', { mode: t(p.render.mode === 'pbr' ? 'world.statsPbr' : 'world.statsClassic'), preset: p.render.preset }) +
    (p.gpuMs !== null && p.gpuMs !== undefined && Number.isFinite(p.gpuMs) ? t('world.statsGpu', { ms: p.gpuMs.toFixed(2) }) : '') +
    (p.weather && p.weather.level !== 'off'
      ? t('world.statsWeather', { level: p.weather.level, rain: p.weather.rain.toFixed(2), wet: p.weather.wet.toFixed(2) })
      : '')
  return `${line}\n${render}`
}

export class PerfOverlay {
  readonly root: HTMLElement
  private readonly off: () => void

  constructor(store: SettingsStore = settings) {
    ensureUxStyles()
    this.root = el('div', 'ux-perf')
    this.root.style.whiteSpace = 'pre' // the wave-9 render line goes under the stats line
    this.root.hidden = !perfVisible(store.get())
    this.off = store.onChange(s => {
      this.root.hidden = !perfVisible(s)
    })
  }

  /** Skipped while hidden (no text layout for nobody). */
  update(p: PerfSample): void {
    if (this.root.hidden) return
    this.root.textContent = perfText(p)
  }

  get visible(): boolean {
    return !this.root.hidden
  }

  dispose(): void {
    this.off()
    this.root.remove()
  }
}

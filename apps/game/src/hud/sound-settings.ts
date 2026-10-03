/**
 * Sound settings window (docs/SOUND.md §5.12): sliders for Master, Music, Effects, Interface and Ambience (0-100)
 * and "Mute when the game is in the background". Changes apply live and persist (audio/settings.ts). Opened from
 * the Esc menu's "Sound" entry (order 30, world/features/sound.ts) and by UX-A's Options -> Audio through
 * `openSoundSettings()`. One window per page; it follows the master mute of the corner button.
 */
import type { App } from '../app.ts'
import type { AudioSettings } from '../audio/settings.ts'
import { AUDIO_LEVELS, type AudioLevel } from '../audio/settings.ts'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button } from '../ui/kit/button.ts'
import { Checkbox } from '../ui/kit/check.ts'
import { Slider } from '../ui/kit/slider.ts'
import { Window } from '../ui/kit/window.ts'

const WIDTH = 300
const HEIGHT = 260

const LABEL: Record<AudioLevel, StringKey> = {
  master: 'sound.master',
  music: 'sound.music',
  sfx: 'sound.sfx',
  ui: 'sound.ui',
  ambient: 'sound.ambient',
}

const CSS = `
.hud-window-sound .sound-body { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 6px; }
.hud-window-sound .sound-row { display: grid; grid-template-columns: 70px 1fr 40px; align-items: center; gap: 6px; }
.hud-window-sound .sound-row .kit-slider { width: 100%; }
.hud-window-sound .sound-row .value { text-align: right; font-variant-numeric: tabular-nums; }
.hud-window-sound .sound-check { margin-top: 4px; }
.hud-window-sound .sound-note { color: var(--c-label); font: 11px/14px var(--font-body); text-shadow: var(--t-shadow); min-height: 14px; }
.hud-window-sound .sound-note .kit-btn { margin-left: 6px; }
.hud-window-sound.is-muted .sound-row { opacity: 0.55; }
`
let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'sound-settings'
  style.textContent = CSS
  document.head.append(style)
}

/** docs/UI.md §4.6 Sound: an mframe window with kit sliders (UI-W swapped the base class and controls). */
export class SoundSettingsWindow extends Window {
  private readonly sliders = new Map<AudioLevel, { slider: Slider; value: HTMLElement }>()
  private readonly hidden: Checkbox
  private readonly note: HTMLElement
  private readonly off: () => void

  constructor(art: Art, parent: HTMLElement, private readonly settings: AudioSettings, private readonly effectsMissing: () => boolean) {
    super(art, parent, { id: 'sound', title: t('sound.title'), width: WIDTH, height: HEIGHT, at: [0.5, 0.35], inset: [46, 18, 16, 18], className: 'hud-window hud-window-sound' })
    this.titleStrip.classList.add('hud-window-title')
    ensureStyles()
    const body = el('div', 'sound-body')
    for (const level of AUDIO_LEVELS) {
      const slider = new Slider(art, { min: 0, max: 100, step: 5, value: 0, label: t(LABEL[level]) })
      const value = el('span', 'value kit-t-value')
      const show = (v: number) => {
        value.textContent = t('sound.percent', { value: Math.round(v) })
      }
      slider.onInput = v => {
        show(v)
        this.settings.set({ [level]: v / 100 })
      }
      slider.onChange = v => this.settings.set({ [level]: v / 100 })
      this.sliders.set(level, { slider, value })
      body.append(el('div', 'sound-row', el('span', 'kit-t-label', t(LABEL[level])), slider.root, value))
    }
    this.hidden = new Checkbox(art, { label: t('sound.muteHidden'), className: 'sound-check' })
    this.hidden.onChange = on => this.settings.set({ muteHidden: on })
    this.note = el('div', 'sound-note')
    body.append(this.hidden.root, this.note)
    this.body.append(body)
    this.off = this.settings.onChange(() => this.refresh())
    this.refresh()
  }

  protected override onOpen(): void {
    this.refresh()
  }

  /** Shows the stored values (another window or the corner button may have changed them). */
  refresh(): void {
    const s = this.settings.get()
    for (const [level, { slider, value }] of this.sliders) {
      const v = Math.round(s[level] * 100)
      slider.set(v)
      value.textContent = t('sound.percent', { value: v })
    }
    this.hidden.checked = s.muteHidden
    this.root.classList.toggle('is-muted', this.settings.muted)
    this.note.replaceChildren()
    if (this.settings.muted) {
      const unmute = button(this.art, { label: t('sound.unmute'), skin: 'small' }, () => this.settings.setMuted(false))
      this.note.append(t('sound.muted'), unmute)
    } else if (this.effectsMissing()) {
      this.note.textContent = t('sound.missing')
    }
  }

  override dispose(): void {
    this.off()
    super.dispose()
  }
}

let win: SoundSettingsWindow | null = null

/** Opens (or raises) the sound window; `parent` defaults to the screen's UI layer. */
export function openSoundSettings(app: App, parent: HTMLElement = app.ui): SoundSettingsWindow {
  if (win && (!win.root.isConnected || win.root.parentElement !== parent)) {
    win.dispose()
    win = null
  }
  win ??= new SoundSettingsWindow(app.art, parent, app.audio.settings, () => !app.audio.index)
  win.open()
  win.raise()
  return win
}

/** The open sound window, if any (Esc closes it). */
export function soundSettingsWindow(): SoundSettingsWindow | null {
  return win?.root.isConnected ? win : null
}

/** Removes the window (leaving the world). */
export function closeSoundSettings(): void {
  win?.dispose()
  win = null
}

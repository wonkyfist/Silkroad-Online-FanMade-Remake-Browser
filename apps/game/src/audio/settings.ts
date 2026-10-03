/**
 * Sound settings (docs/SOUND.md §5.2): per-category volumes in localStorage['sro.audio.v1'] and the master mute in
 * localStorage['sro.muted'] (the corner button and `?mute=1`; the key predates this module, so old choices keep
 * working). Every read and write is guarded: blocked storage or corrupt JSON fall back to the defaults per field.
 */
import type { SoundCategory } from '@sro/shared'

export const AUDIO_SETTINGS_KEY = 'sro.audio.v1'
export const MUTE_KEY = 'sro.muted'

export interface AudioLevels {
  master: number
  music: number
  sfx: number
  ui: number
  ambient: number
  /** Silence everything while the tab is in the background. */
  muteHidden: boolean
}

export type AudioLevel = Exclude<keyof AudioLevels, 'muteHidden'>
export const AUDIO_LEVELS: readonly AudioLevel[] = ['master', 'music', 'sfx', 'ui', 'ambient']

export const AUDIO_DEFAULTS: Readonly<AudioLevels> = { master: 0.8, music: 0.55, sfx: 0.9, ui: 0.7, ambient: 0.6, muteHidden: true }

/** The part of Storage the settings use (tests pass a fake). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** window.localStorage, or null where reading it throws (sandboxed frames, blocked site data). */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Settings from the stored JSON: each field is kept when valid (numbers clamped to 0..1), else defaulted. */
export function parseAudioLevels(raw: string | null): AudioLevels {
  const out: AudioLevels = { ...AUDIO_DEFAULTS }
  if (!raw) return out
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return out
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  const r = v as Record<string, unknown>
  for (const k of AUDIO_LEVELS) {
    const n = r[k]
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = clamp01(n)
  }
  if (typeof r.muteHidden === 'boolean') out.muteHidden = r.muteHidden
  return out
}

export type AudioSettingsListener = (levels: Readonly<AudioLevels>, muted: boolean) => void

export class AudioSettings {
  private levels: AudioLevels
  private mutedValue: boolean
  private readonly listeners = new Set<AudioSettingsListener>()

  /** `forceMuted` (?mute=1) mutes this page without changing the stored choice. */
  constructor(private readonly storage: StorageLike | null = browserStorage(), forceMuted = false) {
    this.levels = parseAudioLevels(this.read(AUDIO_SETTINGS_KEY))
    this.mutedValue = forceMuted || this.read(MUTE_KEY) === '1'
  }

  get(): Readonly<AudioLevels> {
    return this.levels
  }

  get muted(): boolean {
    return this.mutedValue
  }

  /** Changes some fields (numbers clamped to 0..1; invalid values ignored), saves and notifies. */
  set(patch: Partial<AudioLevels>): void {
    const next = { ...this.levels }
    for (const k of AUDIO_LEVELS) {
      const n = patch[k]
      if (typeof n === 'number' && Number.isFinite(n)) next[k] = clamp01(n)
    }
    if (typeof patch.muteHidden === 'boolean') next.muteHidden = patch.muteHidden
    this.levels = next
    this.write(AUDIO_SETTINGS_KEY, JSON.stringify(next))
    this.emit()
  }

  setMuted(muted: boolean): void {
    this.mutedValue = muted
    this.write(MUTE_KEY, muted ? '1' : '0')
    this.emit()
  }

  toggleMuted(): void {
    this.setMuted(!this.mutedValue)
  }

  /** What a category plays at: master x category, 0 while muted. Music also goes through here. */
  gain(category: SoundCategory): number {
    if (this.mutedValue) return 0
    return this.levels.master * this.levels[category]
  }

  onChange(fn: AudioSettingsListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l(this.levels, this.mutedValue)
      } catch (err) {
        console.error('[audio] settings listener failed', err)
      }
    }
  }

  private read(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null
    } catch {
      return null
    }
  }

  private write(key: string, value: string): void {
    try {
      this.storage?.setItem(key, value)
    } catch {
      // storage blocked: the choice lasts for this page only
    }
  }
}

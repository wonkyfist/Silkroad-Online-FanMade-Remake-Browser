/**
 * Background music (streamed HTMLAudioElement, docs/SOUND.md §5.2). Browsers block autoplay, so playback starts on
 * the first user gesture; until then `play()` only records the wanted track. Tracks cross-fade. Volume and mute come
 * from AudioSettings through GameAudio (master x music; the master mute is localStorage['sro.muted']).
 */
const FADE_MS = 900

export class Music {
  private wanted: string | null = null
  private current: { url: string; audio: HTMLAudioElement } | null = null
  private unlocked = false
  private mutedValue: boolean
  private paused = false
  private volume: number

  constructor(opts: { muted?: boolean; volume?: number } = {}) {
    this.mutedValue = !!opts.muted
    this.volume = opts.volume ?? 0.55
    const unlock = () => {
      this.unlocked = true
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
      this.apply()
    }
    window.addEventListener('pointerdown', unlock, true)
    window.addEventListener('keydown', unlock, true)
  }

  get muted(): boolean {
    return this.mutedValue
  }

  setMuted(muted: boolean): void {
    if (muted === this.mutedValue) return
    this.mutedValue = muted
    this.apply()
  }

  /** Playback volume 0..1 (applied at once to the playing track, and as the target of fades). */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v))
    const a = this.current?.audio
    if (a && !fading.has(a)) a.volume = this.volume
  }

  /** Pauses (hidden tab) or resumes the current track without forgetting it. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return
    this.paused = paused
    const a = this.current?.audio
    if (!a) return
    if (paused) a.pause()
    else {
      // A track that started while paused has not faded in yet.
      void a.play().then(() => {
        if (!fading.has(a) && a.volume < this.volume) fadeTo(a, () => this.volume)
      }, () => {})
    }
  }

  /** Switches to `url` (null = silence). */
  play(url: string | null | undefined): void {
    this.wanted = url ?? null
    this.apply()
  }

  private apply(): void {
    const want = this.mutedValue || !this.unlocked ? null : this.wanted
    if (this.current && this.current.url === want) {
      if (this.current.audio.paused && !this.paused) void this.current.audio.play().catch(() => {})
      return
    }
    if (this.current) fadeOut(this.current.audio)
    this.current = null
    if (!want) return
    const audio = new Audio(want)
    audio.loop = true
    audio.volume = 0
    this.current = { url: want, audio }
    if (this.paused) return
    audio.play().then(() => fadeTo(audio, () => this.volume), err => console.warn('[music] cannot play', want, err))
  }
}

/** Elements with a fade in progress (setVolume leaves those to the fade, which reads the latest target). */
const fading = new WeakSet<HTMLAudioElement>()

function fadeTo(audio: HTMLAudioElement, target: () => number, done?: () => void): void {
  const from = audio.volume
  const t0 = performance.now()
  fading.add(audio)
  const step = () => {
    const f = Math.min(1, (performance.now() - t0) / FADE_MS)
    audio.volume = Math.max(0, Math.min(1, from + (target() - from) * f))
    if (f < 1) requestAnimationFrame(step)
    else {
      fading.delete(audio)
      done?.()
    }
  }
  requestAnimationFrame(step)
}

function fadeOut(audio: HTMLAudioElement): void {
  fadeTo(audio, () => 0, () => {
    audio.pause()
    audio.src = ''
  })
}

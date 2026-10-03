/**
 * Weather sounds (docs/WEATHER.md §7.5, docs/SOUND.md §8): the rain bed, the strong-wind bed and gust one-shots, the
 * thunder, the muffling under shelter and the birds going quiet in rain. Pure scheduling behind WeatherAudioHost, so
 * it runs in vitest with a fake backend; GameAudio (audio/index.ts) supplies the WebAudio side and owns one.
 *
 * - Rain: the retail loop `etc/rain1` is only 2.3 s, so two voices play it 1.1 s apart at ±3 % playback rate, which
 *   hides the seam. Gain `0.8 × rain`; under a roof −6 dB through a 900 Hz low-pass.
 * - Wind: the area's light bed (`env/day_wind`, AmbientPlayer) keeps playing; above ~8 m/s of gusting wind the
 *   `weather.wind.strong` loop fades in under `clamp(gustMs / 15)`, and `weather.wind.gust` one-shots come every
 *   5-12 s. Which file sounds right is a listening call (SOUND.md §8). The strong bed is a steady file played by two
 *   detuned voices like the rain (W9F A5), and it is held at gain 0 through a lull rather than stopped: it stops only
 *   after `wind.holdS` below its threshold, and every start begins at a random point of the file, so gusting wind
 *   around the threshold never replays the file's opening over and over (W9F A1).
 * - Beds play at their cue's gain × the weather's.
 * - Thunder: `thunderCue(distM)`, gain `clamp(1.4 − distM / 2500, 0.25, 1)`. The feature times it (`distM / 343` s
 *   after the flash, on the server clock) and calls `thunder` when it is due.
 * - Birds: the area one-shots are muted while `rain > 0.25` or `windMs > 10` (and resume below 0.2 / 9).
 */
import { thunderCue, type SoundCue } from '@sro/shared'
import { LOWPASS_OPEN_HZ, type SoundBuffer, type StartOptions, type VoiceHandle } from './backend.ts'

/** The weather the sounds follow (a WeatherFrame fits). */
export interface WeatherSoundInput {
  /** Rain rate 0..1. */
  rain: number
  /** Mean wind, m/s. */
  windMs: number
  /** The gusting wind right now, m/s. */
  gustMs: number
}

/** What WeatherAudio needs of the audio system (GameAudio; tests pass a fake). */
export interface WeatherAudioHost {
  /** Sounds can start (the context runs). */
  ready(): boolean
  /** Audio clock, seconds. */
  now(): number
  /** A cue of the sound index (undefined: no index yet, or an export without weather sounds). */
  cue(name: string): Readonly<SoundCue> | undefined
  /** The decoded buffer of a file, or null (and its load starts). */
  buffer(file: string): SoundBuffer | null
  /** Starts a voice on the backend (loops are not counted by the voice policy, like the ambient bed). */
  start(buffer: SoundBuffer, opts: StartOptions): VoiceHandle | null
  retain(file: string): void
  release(file: string): void
  /**
   * A non-spatial one-shot on the ambient bus through the voice policy (gusts, thunder). `waitMs`: a file still loading
   * plays when it arrives within that long, instead of being dropped.
   */
  oneShot(file: string, gain: number, pan: number, waitMs?: number): void
  /** The area ambience's one-shot mute (AmbientPlayer.mute). */
  muteBirds(on: boolean): void
  rng(): number
}

export const WEATHER_AUDIO = {
  rain: {
    /** Bed gain at rain 1. */
    gain: 0.8,
    /** The second voice starts this much later (s), and the two play at these rates. */
    offsetS: 1.1,
    rates: [0.97, 1.03] as const,
    /** Under shelter: gain × 0.5 (−6 dB) through a low-pass at this cut-off. */
    shelterGain: 0.5,
    shelterHz: 900,
  },
  wind: {
    /** The strong-wind bed fades in between these gust speeds (m/s); its gain is `clamp(gustMs / fullMs)`. */
    fromMs: 6,
    toMs: 10,
    fullMs: 15,
    /** Gust one-shots above this gust speed, every `everyS` seconds, at up to `gain`. */
    gustMs: 9,
    everyS: [5, 12] as const,
    gain: 0.7,
    /** The strong bed stops only after this long (s) below its threshold (a lull keeps it at gain 0). */
    holdS: 12,
    /** Two voices this far apart (s) at these rates hide the short loop's seam. */
    offsetS: 0.9,
    rates: [0.98, 1.02] as const,
    /**
     * The steady bed file (dd_mainwind, flat at -39 dB, peak -28 dBFS) is lifted by this much (+18 dB) to the level
     * the old gusting bed had (-19 dB mean, peak -9.5 dBFS). A listening call (SOUND.md §8.1).
     */
    bedGain: 8,
  },
  thunder: {
    /** Gain `clamp(1.4 − distM / 2500, min, 1)`. */
    min: 0.25,
    /**
     * A thunder whose file is still loading plays when it arrives within this long (ms; the feature drops a thunder
     * 3 s late, world/features/weather.ts THUNDER_STALE_MS), instead of being lost (W9F A3).
     */
    waitMs: 2500,
    /**
     * The thunder files load once the rain reaches this rate (W9F A3): lightning comes only with rain:0.8 and up
     * (rain rate ≥ 0.44) or a storm, and both ramp in together, so the files are in before the first strike.
     */
    preloadRain: 0.4,
  },
  birds: {
    /** Muted above these (rain rate, mean wind m/s), back below the lower pair. */
    rainOn: 0.25,
    windOn: 10,
    rainOff: 0.2,
    windOff: 9,
  },
  /** Gains ramp over this long (s) and are re-sent only when they moved by more than `step`. */
  rampS: 0.4,
  step: 0.01,
  /** Beds start with this fade-in and stop with this fade-out (s). */
  fadeInS: 1.5,
  fadeOutS: 2.5,
} as const

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/** The rain bed's total gain for a rain rate (sheltered: −6 dB). */
export function rainGain(rain: number, sheltered: boolean): number {
  return WEATHER_AUDIO.rain.gain * clamp01(rain) * (sheltered ? WEATHER_AUDIO.rain.shelterGain : 1)
}

/** The strong-wind bed's gain for a gust speed. */
export function strongWindGain(gustMs: number): number {
  const w = WEATHER_AUDIO.wind
  return smoothstep(w.fromMs, w.toMs, gustMs) * clamp01(gustMs / w.fullMs)
}

/** Thunder gain for a strike `distM` metres away. */
export function thunderGain(distM: number): number {
  return Math.min(1, Math.max(WEATHER_AUDIO.thunder.min, 1.4 - distM / 2500))
}

interface BedVoice {
  file: string
  handle: VoiceHandle
}

/**
 * A looped cue played by `layers` voices (the later ones start `offsetS` apart, each at its own rate), with one gain
 * and one low-pass for the whole bed.
 */
class Bed {
  private voices: (BedVoice | null)[] = []
  private startedAt = 0
  private sentGain = -1
  private sentHz = -1
  private playing = false
  /** Audio time the gain fell below the stop threshold (NaN: above it). */
  private quietSince = NaN

  constructor(
    private readonly host: WeatherAudioHost,
    private readonly cue: string,
    private readonly rates: readonly number[],
    private readonly offsetS: number,
    private readonly filter: boolean,
    /** Seconds below the threshold before the bed stops (0: at once); meanwhile it plays at gain 0. */
    private readonly holdS = 0,
    /** Start each bed at a random point of its file (a loop whose opening should not repeat on every start). */
    private readonly randomStart = false,
  ) {}

  get active(): boolean {
    return this.playing
  }

  /** Voices playing now (tests, debug). */
  get count(): number {
    return this.voices.filter(v => v !== null).length
  }

  /** Per frame: the bed's total gain (0 stops it) and the low-pass cut-off (Hz). */
  update(gain: number, lowpassHz: number): void {
    if (gain <= 0.002) {
      if (!this.playing) return
      const now = this.host.now()
      if (Number.isNaN(this.quietSince)) this.quietSince = now
      if (this.holdS <= 0 || now - this.quietSince >= this.holdS) {
        this.stop(WEATHER_AUDIO.fadeOutS)
        return
      }
      // A lull: the voices ramp to silence and keep their place in the file.
      if (this.sentGain !== 0) {
        this.sentGain = 0
        for (const v of this.voices) v?.handle.setGain?.(0, WEATHER_AUDIO.fadeOutS)
      }
      return
    }
    this.quietSince = NaN
    if (!this.host.ready()) return
    const per = (gain * (this.host.cue(this.cue)?.gain ?? 1)) / Math.sqrt(this.rates.length) // uncorrelated voices add in power
    if (!this.playing) {
      if (!this.startVoice(0, per, lowpassHz)) return
      this.playing = true
      this.startedAt = this.host.now()
      this.sentGain = per
      this.sentHz = lowpassHz
    }
    for (let i = 1; i < this.rates.length; i++) {
      if (!this.voices[i] && this.host.now() - this.startedAt >= this.offsetS * i) this.startVoice(i, per, lowpassHz)
    }
    if (Math.abs(per - this.sentGain) > WEATHER_AUDIO.step) {
      this.sentGain = per
      for (const v of this.voices) v?.handle.setGain?.(per, WEATHER_AUDIO.rampS)
    }
    if (this.filter && lowpassHz !== this.sentHz) {
      this.sentHz = lowpassHz
      for (const v of this.voices) v?.handle.setLowpass?.(lowpassHz, WEATHER_AUDIO.rampS)
    }
  }

  stop(fadeS: number): void {
    for (const v of this.voices) {
      if (!v) continue
      v.handle.stop(fadeS)
      this.host.release(v.file)
    }
    this.voices = []
    this.playing = false
    this.sentGain = -1
    this.sentHz = -1
    this.quietSince = NaN
  }

  private startVoice(i: number, gain: number, lowpassHz: number): boolean {
    const files = this.host.cue(this.cue)?.files
    const file = files?.[i % files.length]
    if (!file) return false
    const buffer = this.host.buffer(file)
    if (!buffer) return false
    const opts: StartOptions = { bus: 'ambient', gain, loop: true, fadeIn: WEATHER_AUDIO.fadeInS, rate: this.rates[i] ?? 1, ...(this.filter ? { filter: true } : {}) }
    if (this.randomStart) opts.offset = this.host.rng() * buffer.duration
    const handle = this.host.start(buffer, opts)
    if (!handle) return false
    this.host.retain(file)
    if (this.filter && lowpassHz < LOWPASS_OPEN_HZ) handle.setLowpass?.(lowpassHz, 0)
    this.voices[i] = { file, handle }
    return true
  }
}

/** The weather's sounds: `update` once a frame, `thunder` when a strike's sound is due. */
export class WeatherAudio {
  private readonly rain: Bed
  private readonly wind: Bed
  private birdsMuted = false
  private nextGust = 0
  private thunderLoaded = false

  constructor(private readonly host: WeatherAudioHost) {
    const r = WEATHER_AUDIO.rain
    this.rain = new Bed(host, 'weather.rain', r.rates, r.offsetS, true)
    const w = WEATHER_AUDIO.wind
    this.wind = new Bed(host, 'weather.wind.strong', w.rates, w.offsetS, false, w.holdS, true)
  }

  /** Once a frame: the beds follow the weather; `sheltered` = a roof or a canopy above the listener. */
  update(w: WeatherSoundInput, sheltered: boolean): void {
    const b = WEATHER_AUDIO.birds
    const mute = this.birdsMuted ? w.rain > b.rainOff || w.windMs > b.windOff : w.rain > b.rainOn || w.windMs > b.windOn
    if (mute !== this.birdsMuted) {
      this.birdsMuted = mute
      this.host.muteBirds(mute)
    }
    if (!this.thunderLoaded && w.rain >= WEATHER_AUDIO.thunder.preloadRain && this.host.cue('weather.thunder.near')) {
      this.thunderLoaded = true
      this.preloadThunder()
    }
    this.rain.update(rainGain(w.rain, sheltered), sheltered ? WEATHER_AUDIO.rain.shelterHz : LOWPASS_OPEN_HZ)
    this.wind.update(strongWindGain(w.gustMs) * WEATHER_AUDIO.wind.bedGain, LOWPASS_OPEN_HZ)
    this.gusts(w.gustMs)
  }

  /** Plays the thunder of a strike `distM` metres away now (`pan` −1..1 toward the strike); late if still loading. */
  thunder(distM: number, pan = 0): void {
    const file = this.cueFile(thunderCue(distM))
    if (file) this.host.oneShot(file, thunderGain(distM), Math.max(-1, Math.min(1, pan)), WEATHER_AUDIO.thunder.waitMs)
  }

  /** Starts loading the thunder file of a strike (it plays ≥ 0.3 s later). */
  prepareThunder(distM: number): void {
    const file = this.cueFile(thunderCue(distM))
    if (file) this.host.buffer(file)
  }

  /** Starts loading every thunder file (weather with lightning on the way: the first close strike is then ready). */
  preloadThunder(): void {
    for (const cue of ['weather.thunder.near', 'weather.thunder.mid', 'weather.thunder.far']) {
      for (const file of this.host.cue(cue)?.files ?? []) this.host.buffer(file)
    }
  }

  /** Stops everything and lets the birds sing again (leaving the world). */
  stop(): void {
    this.rain.stop(0.3)
    this.wind.stop(0.3)
    if (this.birdsMuted) this.host.muteBirds(false)
    this.birdsMuted = false
    this.nextGust = 0
  }

  /** Debug and tests: what plays. */
  state(): { rainVoices: number; windVoices: number; birdsMuted: boolean } {
    return { rainVoices: this.rain.count, windVoices: this.wind.count, birdsMuted: this.birdsMuted }
  }

  private gusts(gustMs: number): void {
    const w = WEATHER_AUDIO.wind
    if (gustMs < w.gustMs || !this.host.ready()) return
    const now = this.host.now()
    if (this.nextGust === 0) this.nextGust = now + this.gustDelay()
    if (now < this.nextGust) return
    this.nextGust = now + this.gustDelay()
    const files = this.host.cue('weather.wind.gust')?.files
    const file = files?.[Math.floor(this.host.rng() * files.length) % files.length]
    if (!file) return
    const gain = w.gain * (0.6 + 0.4 * this.host.rng()) * clamp01((gustMs - 6) / 10)
    this.host.oneShot(file, gain, (this.host.rng() * 2 - 1) * 0.7)
  }

  private gustDelay(): number {
    const [a, b] = WEATHER_AUDIO.wind.everyS
    return a + (b - a) * this.host.rng()
  }

  private cueFile(name: string): string | null {
    const files = this.host.cue(name)?.files
    return files?.length ? files[Math.floor(this.host.rng() * files.length) % files.length]! : null
  }
}

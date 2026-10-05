/**
 * Lightning's own sounds (docs/WEATHER.md §7.3c), synthesized at runtime (nothing is downloaded or exported): the
 * telegraph's crackle (the air buzzing on the spot before a strike, spatial) and the sharp crack of a close strike
 * (non-spatial, layered over the retail near thunder, which the weather feature plays). The far thunder stays the
 * retail `weather.thunder.mid/far` rumble (audio/weather.ts).
 *
 * The buffers are made once (pure `crackleSamples` / `crackSamples`, seeded), encoded as 16-bit WAV and decoded through
 * the same backend as every other sound; until they are decoded the sounds are skipped.
 */
import { mulberry32 } from '@sro/shared'
import type { SoundBuffer, StartOptions, Vec3Like, VoiceHandle } from './backend.ts'

export const SYNTH_RATE = 22050
/** The crackle's length (s): longer than the longest telegraph (1.8 s); stopped when the strike lands. */
export const CRACKLE_S = 2
export const CRACK_S = 2.6
/** A strike closer than this (m) also gets the synthesized crack. */
export const CRACK_MAX_M = 400

export interface LightningAudioHost {
  /** Sounds may start (the context runs, the tab is shown, not muted). */
  ready(): boolean
  decode(bytes: ArrayBuffer): Promise<SoundBuffer>
  start(buffer: SoundBuffer, opts: StartOptions): VoiceHandle | null
}

/** The telegraph: sparse sharp clicks over a faint 120 Hz hum with a flickering level, rising toward the strike. */
export function crackleSamples(seed = 1): Float32Array {
  const n = Math.round(CRACKLE_S * SYNTH_RATE)
  const out = new Float32Array(n)
  const rng = mulberry32(seed)
  let env = 0
  let lp = 0
  for (let i = 0; i < n; i++) {
    const t = i / SYNTH_RATE
    // the level rises over the first 1.4 s (the telegraph) and holds
    const rise = Math.min(1, 0.25 + t / 1.4)
    // clicks: a few hundred a second, each a decaying burst of noise
    if (rng() < (180 + 520 * rise) / SYNTH_RATE) env = 0.5 + 0.5 * rng()
    env *= 0.93
    const noise = rng() * 2 - 1
    // a crude high-pass (noise minus its low-pass) keeps the clicks crisp
    lp += 0.25 * (noise - lp)
    const click = (noise - lp) * env
    const hum = 0.08 * Math.sin(2 * Math.PI * 120 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 7 * t + rng() * 0.3))
    out[i] = (0.7 * click + hum) * rise
  }
  fadeEnds(out, 0.03, 0.08)
  return out
}

/** A close strike: an instant broadband snap, a ripping tear of clicks, then a low boom that rolls off. */
export function crackSamples(seed = 2): Float32Array {
  const n = Math.round(CRACK_S * SYNTH_RATE)
  const out = new Float32Array(n)
  const rng = mulberry32(seed)
  let lowA = 0
  let lowB = 0
  let tear = 0
  for (let i = 0; i < n; i++) {
    const t = i / SYNTH_RATE
    const noise = rng() * 2 - 1
    // the snap: white noise, 2 ms attack, 60 ms decay
    const snap = noise * Math.min(1, t / 0.002) * Math.exp(-t / 0.06)
    // the tear: dense clicks over the first 0.25 s
    if (t < 0.28 && rng() < 0.06) tear = 0.4 + 0.6 * rng()
    tear *= 0.9
    const rip = noise * tear * Math.exp(-t / 0.18)
    // the boom: twice low-passed noise, swelling over 80 ms and decaying over ~0.9 s
    lowA += 0.02 * (noise - lowA)
    lowB += 0.02 * (lowA - lowB)
    const boom = lowB * 9 * Math.min(1, t / 0.08) * Math.exp(-t / 0.9)
    out[i] = 0.9 * snap + 0.5 * rip + boom
  }
  normalize(out, 0.95)
  fadeEnds(out, 0, 0.3)
  return out
}

function fadeEnds(s: Float32Array, inS: number, outS: number): void {
  const a = Math.round(inS * SYNTH_RATE)
  const b = Math.round(outS * SYNTH_RATE)
  for (let i = 0; i < a && i < s.length; i++) s[i]! *= i / a
  for (let i = 0; i < b && i < s.length; i++) s[s.length - 1 - i]! *= i / b
}

function normalize(s: Float32Array, peak: number): void {
  let m = 0
  for (const v of s) m = Math.max(m, Math.abs(v))
  if (m > 0) for (let i = 0; i < s.length; i++) s[i]! *= peak / m
}

/** 16-bit mono PCM WAV of `samples` (clamped to -1..1). */
export function encodeWav(samples: Float32Array, rate = SYNTH_RATE): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), true)
  return buf
}

/** The crack's gain at `distM`: full up close, a quarter at CRACK_MAX_M. */
export function crackGain(distM: number): number {
  return Math.max(0, Math.min(1, 1 - (0.75 * Math.max(0, distM - 30)) / (CRACK_MAX_M - 30)))
}

export class LightningAudio {
  private crackle: SoundBuffer | null = null
  private crack: SoundBuffer | null = null
  private loading = false
  private readonly voices = new Set<VoiceHandle>()

  constructor(private readonly host: LightningAudioHost) {}

  /** Makes and decodes the buffers once (call when a strike is announced; cheap afterwards). */
  prepare(): void {
    if (this.loading) return
    this.loading = true
    void this.host
      .decode(encodeWav(crackleSamples()))
      .then(b => (this.crackle = b))
      .catch(() => {})
    void this.host
      .decode(encodeWav(crackSamples()))
      .then(b => (this.crack = b))
      .catch(() => {})
  }

  /** The telegraph's crackle at `pos`; the returned stop() ends it (the strike landed). */
  crackleAt(pos: Vec3Like, gain = 1): { stop(): void } {
    const b = this.crackle
    if (!b || !this.host.ready()) return { stop() {} }
    const h = this.host.start(b, { bus: 'sfx', gain: 0.9 * gain, pos, fadeIn: 0.15, onEnded: () => this.voices.delete(h!) })
    if (!h) return { stop() {} }
    this.voices.add(h)
    return {
      stop: () => {
        if (!this.voices.delete(h)) return
        h.stop(0.05)
      },
    }
  }

  /** The crack of a strike `distM` metres away (call when its sound arrives: distM / 343 s after the bolt). */
  crackFrom(distM: number, pan = 0): void {
    const b = this.crack
    if (!b || !this.host.ready() || distM > CRACK_MAX_M) return
    const h = this.host.start(b, { bus: 'ambient', gain: crackGain(distM), pan: Math.max(-1, Math.min(1, pan)), onEnded: () => this.voices.delete(h!) })
    if (h) this.voices.add(h)
  }

  /** Stops every voice (the world closed). */
  stop(): void {
    for (const h of this.voices) h.stop(0.05)
    this.voices.clear()
  }
}

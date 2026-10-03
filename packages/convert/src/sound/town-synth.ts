/**
 * The town's synthesized sounds (docs/TOWN_LIFE.md §6; docs/WAVE_PLAN7.md lane TL-S, D29): what the retail client has
 * no file for, made offline by a deterministic, seeded script (nothing is downloaded):
 *
 * - **The bed** (`town/bed_calm`, `town/bed_busy`): 20 s seamless loops of a crowd heard from inside it. The voices are
 *   granulated from the retail emote voices (`emoticon/vc?_*_emo_*`): 60–140 ms grains, half of them reversed, every
 *   grain re-pitched and low-passed per talker, so no word survives; with distant footsteps, a room tone and (busy) a
 *   cart going by. The client mixes the two by the folk near (apps/game/src/audio/town.ts).
 * - **The fountain** (`town/fountain`): a 12 s seamless splash loop (no retail fountain sound) [decision].
 * - **One-shots**: the vendor murmur (`town/murmur_*`, 0.6–1.2 s of one talker), the smith's hammer (`town/hammer_*`:
 *   a retail weapon hit pitched down with a ringing anvil), chickens (`town/chicken_*`, no retail file), the dog
 *   (`town/dog_*`: the pet wolf's voice pitched up 1.3×, TOWN_LIFE §6), and the pigeons' wing claps (`town/wings_*`).
 *
 * Without a retail source (another client build) every sound falls back to pure synthesis (vowel babble, a noise
 * click, a synthesized bark), so the export always has the set. Same seed and sources → the same bytes (the encoder
 * cache of the sound export keys on them). Node-free: the sound export (tools/export-sound.ts) does the I/O.
 */
import type { SoundCategory, SoundCue } from '../../../shared/src/sound.ts'
import { parseWav, writeWav16, type Pcm } from './pcm.ts'

/** The synthesis seed (one per release of the set; change it to re-roll every file). */
export const TOWN_SYNTH_SEED = 0x7a11
/** Output sample rate (the retail files' rate). */
export const TOWN_SYNTH_RATE = 22050
/** Loop lengths (s). */
export const BED_LOOP_S = 20
export const FOUNTAIN_LOOP_S = 12

/** The cues this module adds to the sound index: key → [category, file ids]. */
export const TOWN_SYNTH_CUES: ReadonlyArray<readonly [string, SoundCategory, readonly string[]]> = [
  ['town.bed.calm', 'ambient', ['town/bed_calm']],
  ['town.bed.busy', 'ambient', ['town/bed_busy']],
  ['town.fountain', 'ambient', ['town/fountain']],
  ['town.murmur', 'sfx', ['town/murmur_1', 'town/murmur_2', 'town/murmur_3', 'town/murmur_4']],
  ['town.hammer', 'sfx', ['town/hammer_1', 'town/hammer_2', 'town/hammer_3']],
  ['town.chicken', 'sfx', ['town/chicken_1', 'town/chicken_2', 'town/chicken_3', 'town/chicken_4']],
  ['town.dog.pitched', 'sfx', ['town/dog_1', 'town/dog_2', 'town/dog_3', 'town/dog_4']],
  ['town.wings', 'sfx', ['town/wings_1', 'town/wings_2']],
]

/** Every synthesized file id (relative to the sound folder, without extension). */
export const TOWN_SYNTH_FILES: readonly string[] = TOWN_SYNTH_CUES.flatMap(([, , f]) => f)
/** The looped files (encoded at the ambience bitrate; never trimmed short). */
export const TOWN_SYNTH_LOOPS: readonly string[] = ['town/bed_calm', 'town/bed_busy', 'town/fountain']

/** Retail sources (sound ids under prim/snd, no extension). Missing ones are skipped; none → pure synthesis. */
export const VOICE_SOURCES: readonly string[] = ['vcm', 'vcf'].flatMap(g => ['at', 'bt', 'ct', 'et'].flatMap(t => ['charge', 'down', 'hi', 'no', 'ok', 'up', 'ye'].map(w => `emoticon/${g}_${t}_emo_${w}`)))
export const HIT_SOURCES: readonly string[] = ['player/batswordhit1a', 'player/batswordhit2a', 'player/batspearhit1a', 'player/bataxehit1a']
export const WOLF_SOURCES: readonly string[] = ['cos/cos_wolf_01_stand1', 'cos/cos_wolf_01_moan1', 'cos/cos_wolf_01_moan2', 'cos/cos_wolf_01_shout']
/** The dog is the pet wolf pitched up by this (TOWN_LIFE §6). */
export const DOG_PITCH = 1.3

// ---- small DSP kit ------------------------------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG in [0, 1). */
export function rngOf(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a of a string, mixed with a seed: one independent stream per file. */
export function seedOf(seed: number, name: string): number {
  let h = (0x811c9dc5 ^ seed) >>> 0
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0
  return h
}

type Rng = () => number
const range = (r: Rng, a: number, b: number) => a + (b - a) * r()
function S(sec: number): number {
  return Math.round(sec * TOWN_SYNTH_RATE)
}

type BiquadKind = 'lowpass' | 'highpass' | 'bandpass'

/**
 * An RBJ biquad over `x` in place (bandpass: 0 dB peak gain). `circular`: the signal is a loop, so the filter state is
 * warmed on its last 0.25 s first and the wrap stays seamless.
 */
export function biquad(x: Float32Array, kind: BiquadKind, hz: number, q = Math.SQRT1_2, circular = false): Float32Array {
  const w = (2 * Math.PI * Math.min(hz, TOWN_SYNTH_RATE * 0.45)) / TOWN_SYNTH_RATE
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)
  let b0: number, b1: number, b2: number
  if (kind === 'lowpass') [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
  else if (kind === 'highpass') [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
  else [b0, b1, b2] = [alpha, 0, -alpha]
  const a0 = 1 + alpha
  const a1 = -2 * cos
  const a2 = 1 - alpha
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  const warm = circular ? Math.min(x.length, S(0.25)) : 0
  for (let i = -warm; i < x.length; i++) {
    const x0 = x[i < 0 ? x.length + i : i]!
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
    if (i >= 0) x[i] = y0
  }
  return x
}

/** Linear-interpolated resampling: `ratio` > 1 plays faster (higher, shorter). */
export function resample(x: Float32Array, ratio: number): Float32Array {
  const n = Math.max(1, Math.floor(x.length / ratio))
  const y = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * ratio
    const k = Math.floor(p)
    const f = p - k
    y[i] = (x[k] ?? 0) * (1 - f) + (x[k + 1] ?? 0) * f
  }
  return y
}

/** Adds `src × gain` into `dst` at `at`, wrapping round the end (a seamless loop's events). */
function addWrapped(dst: Float32Array, src: Float32Array, at: number, gain: number): void {
  const n = dst.length
  let j = ((at % n) + n) % n
  for (let i = 0; i < src.length; i++) {
    dst[j] = dst[j]! + src[i]! * gain
    if (++j === n) j = 0
  }
}

/** Adds `src × gain` into `dst` at `at`, clipped to the end (a one-shot). */
function addAt(dst: Float32Array, src: Float32Array, at: number, gain: number): void {
  for (let i = 0; i < src.length && at + i < dst.length; i++) if (at + i >= 0) dst[at + i] = dst[at + i]! + src[i]! * gain
}

function noise(r: Rng, n: number): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = r() * 2 - 1
  return x
}

/** A Hann window over `x` in place. */
function hann(x: Float32Array): Float32Array {
  const n = x.length
  for (let i = 0; i < n; i++) x[i] = x[i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n))
  return x
}

/** Fades the first and last `sec` seconds (one-shots start and end on silence). */
function fadeEnds(x: Float32Array, inS: number, outS: number): Float32Array {
  const a = Math.min(x.length, S(inS)), b = Math.min(x.length, S(outS))
  for (let i = 0; i < a; i++) x[i] = x[i]! * (i / a)
  for (let i = 0; i < b; i++) x[x.length - 1 - i] = x[x.length - 1 - i]! * (i / b)
  return x
}

/**
 * A seamless loop of `len` samples from a signal that runs `len + fade` samples: the tail is cross-faded (equal
 * power) into the head, so the last sample flows into the first.
 */
function loopCrossfade(x: Float32Array, len: number, fade: number): Float32Array {
  const y = x.slice(0, len)
  for (let i = 0; i < fade; i++) {
    const a = (Math.PI / 2) * (i / fade)
    y[i] = x[len + i]! * Math.cos(a) + x[i]! * Math.sin(a)
  }
  return y
}

const rms = (x: Float32Array) => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / Math.max(1, x.length))
}

/** Scales to `db` dBFS RMS (or peak), then soft-limits the peaks (tanh above 0.8). */
function level(x: Float32Array, db: number, mode: 'rms' | 'peak'): Float32Array {
  let m = 0
  if (mode === 'rms') m = rms(x)
  else for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!))
  if (m <= 0) return x
  const k = 10 ** (db / 20) / m
  for (let i = 0; i < x.length; i++) {
    const v = x[i]! * k
    const a = Math.abs(v)
    x[i] = a <= 0.8 ? v : Math.sign(v) * (0.8 + 0.19 * Math.tanh((a - 0.8) / 0.19))
  }
  return x
}

function toPcm(x: Float32Array): Pcm {
  const out = new Int16Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767)))
  return { sampleRate: TOWN_SYNTH_RATE, channels: [out] }
}

/** A source as mono float at TOWN_SYNTH_RATE. */
function fromPcm(p: Pcm): Float32Array {
  const ch = p.channels
  const n = ch[0]?.length ?? 0
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (const c of ch) s += c[i]!
    x[i] = s / ch.length / 32768
  }
  return p.sampleRate === TOWN_SYNTH_RATE ? x : resample(x, p.sampleRate / TOWN_SYNTH_RATE)
}

// ---- the voices -----------------------------------------------------------------------------------------------------

const voicedCache = new WeakMap<Float32Array, number[]>()

/** Where speech energy is in a source clip (start indices of 20 ms frames above a quarter of its loudest). */
function voicedFrames(x: Float32Array): number[] {
  const hit = voicedCache.get(x)
  if (hit) return hit
  const f = S(0.02)
  const e: number[] = []
  for (let i = 0; i + f <= x.length; i += f) e.push(rms(x.subarray(i, i + f)))
  const top = Math.max(0, ...e)
  const frames = e.flatMap((v, k) => (v > top * 0.25 ? [k * f] : []))
  voicedCache.set(x, frames)
  return frames
}

/** The vowel formants of the fallback babble (Hz). */
const VOWELS: ReadonlyArray<readonly [number, number]> = [[730, 1090], [270, 2290], [530, 1840], [570, 840], [440, 1020], [300, 870], [660, 1720]]

/** One grain of a talker: a reversed or forward slice of a retail voice, or a synthesized vowel. */
function grain(r: Rng, voices: readonly Float32Array[], f0: number, len: number): Float32Array {
  const src = voices.length ? voices[Math.floor(r() * voices.length)]! : null
  if (src) {
    const frames = voicedFrames(src)
    const ratio = (f0 / 160) * range(r, 0.96, 1.04)
    const need = Math.ceil(len * ratio) + 2
    const start = frames.length ? Math.min(Math.max(0, src.length - need), frames[Math.floor(r() * frames.length)]!) : 0
    let g = resample(src.subarray(start, start + need), ratio).slice(0, len)
    if (r() < 0.5) g = g.reverse()
    return hann(g)
  }
  // Fallback: a glottal pulse train through two vowel formants.
  const g = new Float32Array(len)
  const [fa, fb] = VOWELS[Math.floor(r() * VOWELS.length)]!
  let ph = 0
  const glide = range(r, -0.15, 0.1)
  for (let i = 0; i < len; i++) {
    ph += (f0 * (1 + (glide * i) / len)) / TOWN_SYNTH_RATE
    if (ph >= 1) ph -= 1
    g[i] = (ph < 0.08 ? 1 : 0) + (r() - 0.5) * 0.05
  }
  const a = biquad(g.slice(), 'bandpass', fa, 6)
  const b = biquad(g, 'bandpass', fb, 8)
  for (let i = 0; i < len; i++) a[i] = a[i]! + 0.6 * b[i]!
  return hann(a)
}

/** One talker's phrase: overlapping grains for `durS` seconds. */
function phrase(r: Rng, voices: readonly Float32Array[], f0: number, durS: number): Float32Array {
  const out = new Float32Array(S(durS) + S(0.2))
  let t = 0
  while (t < S(durS)) {
    const len = S(range(r, 0.06, 0.14))
    addAt(out, grain(r, voices, f0 * range(r, 0.93, 1.08), len), t, range(r, 0.6, 1))
    t += Math.round(len * range(r, 0.55, 0.95))
  }
  return out
}

/** A talker in the bed: phrases and pauses over a loop of `n` samples, heard at `distance` (0 near, 1 far). */
function talker(r: Rng, voices: readonly Float32Array[], n: number, distance: number): Float32Array {
  const out = new Float32Array(n)
  const f0 = r() < 0.5 ? range(r, 105, 150) : range(r, 175, 235)
  let t = Math.floor(r() * n)
  let left = n
  while (left > 0) {
    const dur = range(r, 0.8, 3.2)
    addWrapped(out, phrase(r, voices, f0, dur), t, range(r, 0.6, 1))
    const step = S(dur + range(r, 0.6, 4.5))
    t += step
    left -= step
  }
  biquad(out, 'lowpass', 2600 - 1700 * distance, 0.6, true)
  for (let i = 0; i < n; i++) out[i] = out[i]! * (1 - 0.75 * distance)
  return out
}

/** Distant footsteps: soft low thumps in walking bursts. */
function steps(r: Rng, out: Float32Array, walkers: number): void {
  const n = out.length
  for (let w = 0; w < walkers; w++) {
    const period = range(r, 0.48, 0.62)
    let t = Math.floor(r() * n)
    let left = n
    while (left > 0) {
      const count = Math.floor(range(r, 5, 14))
      const g = range(r, 0.04, 0.1)
      for (let k = 0; k < count; k++) {
        const len = S(0.05)
        const thump = biquad(noise(r, len), 'lowpass', range(r, 280, 520), 0.8)
        for (let i = 0; i < len; i++) thump[i] = thump[i]! * Math.exp(-i / S(0.012))
        addWrapped(out, thump, t + S(k * period * range(r, 0.95, 1.05)), g * (k % 2 ? 0.8 : 1))
      }
      const gap = S(count * period + range(r, 2, 8))
      t += gap
      left -= gap
    }
  }
}

/** A cart going by: a rumble with wheel bumps and a creak, about 7 s. */
function cart(r: Rng, out: Float32Array): void {
  const len = S(7)
  const c = biquad(noise(r, len), 'lowpass', 220, 0.9)
  const bump = range(r, 2.1, 2.8)
  for (let i = 0; i < len; i++) {
    const env = Math.sin((Math.PI * i) / len) ** 2
    const ph = ((i / TOWN_SYNTH_RATE) * bump) % 1
    c[i] = c[i]! * env * (0.55 + 0.45 * Math.exp(-ph * 9))
  }
  addWrapped(out, c, Math.floor(r() * out.length), 0.9)
  for (let k = 0; k < 4; k++) {
    const cl = S(0.14)
    const creak = new Float32Array(cl)
    const f = range(r, 520, 880)
    let ph = 0
    for (let i = 0; i < cl; i++) {
      ph += (f * (1 + 0.25 * (i / cl)) * (1 + 0.04 * Math.sin(i * 0.02))) / TOWN_SYNTH_RATE
      creak[i] = Math.sin(2 * Math.PI * ph) * Math.sin((Math.PI * i) / cl)
    }
    addWrapped(out, creak, S(range(r, 0, 20)), 0.025)
  }
}

/** The bed: `talkers` voices, `walkers` steppers, a room tone, and carts. */
function bed(r: Rng, voices: readonly Float32Array[], talkers: number, walkers: number, carts: number, db: number): Float32Array {
  const n = S(BED_LOOP_S)
  const out = new Float32Array(n)
  for (let k = 0; k < talkers; k++) {
    const t = talker(r, voices, n, k / Math.max(1, talkers - 1))
    for (let i = 0; i < n; i++) out[i] = out[i]! + t[i]!
  }
  biquad(out, 'highpass', 140, 0.7, true)
  steps(r, out, walkers)
  for (let k = 0; k < carts; k++) cart(r, out)
  level(out, db + 1, 'rms')
  // The room tone (a seamless low noise floor, also keeps the export's silence trim off the loop).
  const fade = S(1)
  const tone = loopCrossfade(biquad(biquad(noise(r, n + fade), 'lowpass', 500, 0.7), 'highpass', 60, 0.7), n, fade)
  level(tone, -40, 'rms')
  for (let i = 0; i < n; i++) out[i] = out[i]! + tone[i]!
  return level(out, db, 'rms')
}

/** The vendor's murmur: one talker, close, 0.6–1.2 s. */
function murmur(r: Rng, voices: readonly Float32Array[]): Float32Array {
  const f0 = r() < 0.6 ? range(r, 110, 145) : range(r, 180, 220)
  const x = phrase(r, voices, f0, range(r, 0.6, 1.2))
  biquad(biquad(x, 'lowpass', 3200, 0.7), 'highpass', 160, 0.7)
  return level(fadeEnds(x, 0.03, 0.12), -20, 'rms')
}

/** The ringing of an anvil: inharmonic partials, decaying (s). */
function ring(r: Rng, lenS: number): Float32Array {
  const n = S(lenS)
  const x = new Float32Array(n)
  const k = range(r, 0.97, 1.03)
  const partials: ReadonlyArray<readonly [number, number, number]> = [[620, 1, 0.9], [1390, 0.6, 0.55], [2210, 0.4, 0.35], [3150, 0.25, 0.22], [4380, 0.12, 0.12]]
  for (const [f, a, d] of partials) {
    const w = (2 * Math.PI * f * k) / TOWN_SYNTH_RATE
    for (let i = 0; i < n; i++) x[i] = x[i]! + a * Math.sin(w * i) * Math.exp(-i / (d * TOWN_SYNTH_RATE)) * Math.min(1, i / S(0.002))
  }
  return x
}

/** The smith's hammer: a retail weapon hit pitched down (or a click and thump) with the anvil's ring. */
function hammer(r: Rng, hits: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(S(1.1))
  const src = hits.length ? hits[Math.floor(r() * hits.length)]! : null
  if (src) {
    const h = biquad(resample(src, range(r, 0.68, 0.76)), 'lowpass', 5200, 0.7)
    addAt(out, level(h, -4, 'peak'), 0, 0.8)
  } else {
    const click = biquad(noise(r, S(0.012)), 'highpass', 1800, 0.7)
    addAt(out, click, 0, 0.9)
    const th = new Float32Array(S(0.12))
    for (let i = 0; i < th.length; i++) th[i] = Math.sin((2 * Math.PI * 120 * i) / TOWN_SYNTH_RATE) * Math.exp(-i / S(0.03))
    addAt(out, th, 0, 0.7)
  }
  addAt(out, ring(r, 1.1), 0, 0.35)
  return level(fadeEnds(out, 0, 0.1), -3, 'peak')
}

/** A harmonic-rich tone burst with a pitch glide, through two formants (the clucks and the fallback bark). */
function voicedBurst(r: Rng, lenS: number, f0: number, glide: number, formants: readonly (readonly [number, number])[], rough: number): Float32Array {
  const n = S(lenS)
  const x = new Float32Array(n)
  let ph = 0
  for (let i = 0; i < n; i++) {
    const f = f0 * (1 + (glide * i) / n)
    ph += f / TOWN_SYNTH_RATE
    let s = 0
    for (let h = 1; h <= 8; h++) s += Math.sin(2 * Math.PI * ph * h) / h
    const am = 1 - rough * (0.5 + 0.5 * Math.sin((2 * Math.PI * 35 * i) / TOWN_SYNTH_RATE))
    const env = Math.min(1, i / S(0.005)) * Math.exp(-i / (n * 0.45))
    x[i] = (s + (r() - 0.5) * 0.3) * am * env
  }
  const out = new Float32Array(n)
  for (const [hz, q] of formants) {
    const b = biquad(x.slice(), 'bandpass', hz, q)
    for (let i = 0; i < n; i++) out[i] = out[i]! + b[i]!
  }
  return out
}

/** A chicken: 3–6 clucks, sometimes ending on a longer rising "bawk". */
function chicken(r: Rng): Float32Array {
  const out = new Float32Array(S(1.6))
  let t = S(0.01)
  const count = Math.floor(range(r, 3, 7))
  const f0 = range(r, 380, 520)
  for (let k = 0; k < count; k++) {
    const last = k === count - 1 && r() < 0.6
    const c = last
      ? voicedBurst(r, range(r, 0.18, 0.26), f0 * 1.1, 0.35, [[1100, 3], [2500, 4]], 0.35)
      : voicedBurst(r, range(r, 0.05, 0.09), f0 * range(r, 0.95, 1.05), -0.15, [[1100, 3], [2400, 4]], 0.4)
    addAt(out, c, t, last ? 0.9 : range(r, 0.6, 1))
    t += S(range(r, 0.11, 0.2)) + c.length
    if (t > out.length - S(0.3)) break
  }
  return level(fadeEnds(out.slice(0, Math.min(out.length, t + S(0.05))), 0, 0.03), -5, 'peak')
}

/** The dog: the pet wolf pitched up (or a synthesized double bark). */
function dog(r: Rng, wolf: Float32Array | null): Float32Array {
  if (wolf) return level(fadeEnds(biquad(resample(wolf, DOG_PITCH), 'highpass', 180, 0.7), 0.005, 0.05), -4, 'peak')
  const out = new Float32Array(S(0.8))
  addAt(out, voicedBurst(r, 0.13, range(r, 480, 560), -0.3, [[900, 3], [1800, 4]], 0.2), 0, 1)
  addAt(out, voicedBurst(r, 0.12, range(r, 460, 540), -0.3, [[900, 3], [1800, 4]], 0.2), S(range(r, 0.22, 0.3)), 0.85)
  return level(out, -4, 'peak')
}

/** A pigeon flock's wing claps: a fluttering burst of noise slaps, fading. */
function wings(r: Rng): Float32Array {
  const out = new Float32Array(S(0.9))
  const rate = range(r, 10, 14)
  for (let k = 0; k < 10; k++) {
    const slap = biquad(noise(r, S(0.03)), 'bandpass', range(r, 900, 1600), 0.8)
    for (let i = 0; i < slap.length; i++) slap[i] = slap[i]! * Math.exp(-i / S(0.008))
    addAt(out, slap, S(k / rate + range(r, -0.01, 0.01) + 0.01), Math.exp(-k / 5))
  }
  return level(out, -6, 'peak')
}

/** The fountain: broadband splash, rising droplets and a low gurgle, as a seamless 12 s loop. */
function fountain(r: Rng): Float32Array {
  const n = S(FOUNTAIN_LOOP_S)
  const fade = S(1.5)
  const splash = biquad(biquad(noise(r, n + fade), 'bandpass', 2600, 0.45), 'highpass', 700, 0.7)
  // A slow random sway of the splash (smoothed steps every 0.25 s).
  let g = 0.9, target = 0.9
  for (let i = 0; i < splash.length; i++) {
    if (i % S(0.25) === 0) target = range(r, 0.78, 1)
    g += (target - g) * 0.0004
    splash[i] = splash[i]! * g
  }
  const gurgle = biquad(noise(r, n + fade), 'lowpass', 300, 1.2)
  for (let i = 0; i < gurgle.length; i++) splash[i] = splash[i]! + gurgle[i]! * 0.35
  const out = loopCrossfade(splash, n, fade)
  for (let k = 0; k < FOUNTAIN_LOOP_S * 40; k++) {
    const len = S(range(r, 0.015, 0.04))
    const d = new Float32Array(len)
    const f = range(r, 1200, 4000)
    let ph = 0
    for (let i = 0; i < len; i++) {
      ph += (f * (1 + 0.6 * (i / len))) / TOWN_SYNTH_RATE
      d[i] = Math.sin(2 * Math.PI * ph) * Math.exp(-i / (len * 0.3))
    }
    addWrapped(out, d, Math.floor(r() * n), range(r, 0.02, 0.1))
  }
  return level(out, -22, 'rms')
}

// ---- the set --------------------------------------------------------------------------------------------------------

/** Reads one retail source by sound id (null when absent). */
export type TownSynthSource = (id: string) => Pcm | null

/** Every synthesized file as PCM, by id (TOWN_SYNTH_FILES order). Deterministic in `seed` and the sources. */
export function synthTownSounds(read: TownSynthSource = () => null, seed = TOWN_SYNTH_SEED): Map<string, Pcm> {
  const load = (ids: readonly string[]) => ids.flatMap(id => {
    const p = read(id)
    return p && (p.channels[0]?.length ?? 0) > 0 ? [fromPcm(p)] : []
  })
  const voices = load(VOICE_SOURCES)
  const hits = load(HIT_SOURCES)
  const wolves = WOLF_SOURCES.map(id => load([id])[0] ?? null)
  const out = new Map<string, Pcm>()
  const make = (id: string, fn: (r: Rng) => Float32Array) => out.set(id, toPcm(fn(rngOf(seedOf(seed, id)))))
  make('town/bed_calm', r => bed(r, voices, 5, 2, 0, -27))
  make('town/bed_busy', r => bed(r, voices, 16, 6, 1, -23))
  make('town/fountain', r => fountain(r))
  for (let k = 1; k <= 4; k++) make(`town/murmur_${k}`, r => murmur(r, voices))
  for (let k = 1; k <= 3; k++) make(`town/hammer_${k}`, r => hammer(r, hits))
  for (let k = 1; k <= 4; k++) make(`town/chicken_${k}`, r => chicken(r))
  for (let k = 1; k <= 4; k++) make(`town/dog_${k}`, r => dog(r, wolves[k - 1] ?? null))
  for (let k = 1; k <= 2; k++) make(`town/wings_${k}`, r => wings(r))
  return out
}

/** The set as 16-bit mono WAV bytes (what the sound export encodes), from WAV-byte sources. */
export function townSynthWavs(readWav: (id: string) => Uint8Array | null, seed = TOWN_SYNTH_SEED): Map<string, Uint8Array> {
  const read: TownSynthSource = id => {
    const b = readWav(id)
    if (!b) return null
    try {
      return parseWav(b)
    } catch {
      return null
    }
  }
  return new Map([...synthTownSounds(read, seed)].map(([id, pcm]) => [id, writeWav16(pcm)]))
}

/**
 * Adds the synthesized files and their cues to an export plan (`ids`: the files actually written; a cue keeps the
 * ones it has, and is left out without any). The loops go on the ambience bitrate. Returns the cue keys added.
 */
export function addTownSynthSounds(plan: { files: Set<string>; ambient: Set<string>; index: { cues: Record<string, SoundCue> } }, ids: Iterable<string>): string[] {
  const have = new Set(ids)
  const added: string[] = []
  for (const [key, category, files] of TOWN_SYNTH_CUES) {
    const f = files.filter(id => have.has(id))
    if (!f.length) continue
    for (const id of f) {
      plan.files.add(id)
      if (category === 'ambient') plan.ambient.add(id)
    }
    plan.index.cues[key] = { files: f, gain: 1, category }
    added.push(key)
  }
  return added
}

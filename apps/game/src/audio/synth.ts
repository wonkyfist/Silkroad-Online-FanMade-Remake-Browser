/**
 * Sounds made in code (docs/EFFECTS.md §3.9 "Makeover"): short one-shots the retail client has no file for, rendered once at
 * runtime (seeded, deterministic, nothing downloaded) into 16-bit WAV bytes that GameAudio.prepareSynth decodes and
 * keeps under a `synth/<name>` id. Pure: no WebAudio here, so the recipes are unit-tested.
 *
 * The Berserk makeover's set (docs/EFFECTS.md §3.9): `synth/bz_heart` (a low lub-dub, the own screen's heartbeat),
 * `synth/bz_boom` (a sub drop under the retail start sound and the roar) and `synth/bz_exhale` (a long breath out at the
 * end, over a soft steam hiss).
 */

/** Output sample rate (the retail files' rate). */
export const SYNTH_RATE = 22050

export interface Pcm {
  rate: number
  samples: Float32Array
}

/** mulberry32: a small seeded PRNG in [0, 1). */
export function synthRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 16-bit mono PCM WAV bytes of `pcm` (samples clamped to −1..1). */
export function wavBytes(pcm: Pcm): ArrayBuffer {
  const n = pcm.samples.length
  const buf = new ArrayBuffer(44 + n * 2)
  const dv = new DataView(buf)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(at + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  dv.setUint32(4, 36 + n * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, pcm.rate, true)
  dv.setUint32(28, pcm.rate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  ascii(36, 'data')
  dv.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, pcm.samples[i]!)) * 32767), true)
  return buf
}

/** Scales `s` so its peak is `peak` (silence stays silent). */
export function normalize(s: Float32Array, peak = 0.9): Float32Array {
  let m = 0
  for (const v of s) m = Math.max(m, Math.abs(v))
  if (m > 0) for (let i = 0; i < s.length; i++) s[i] = (s[i]! / m) * peak
  return s
}

/** One body thump: a decaying sine sweeping down from `f0` to `f1` Hz, with a soft click of noise at its onset. */
function thump(out: Float32Array, rate: number, at: number, f0: number, f1: number, decayS: number, gain: number, rnd: () => number): void {
  const start = Math.floor(at * rate)
  const len = Math.min(out.length - start, Math.floor(decayS * 6 * rate))
  let phase = 0
  for (let i = 0; i < len; i++) {
    const t = i / rate
    const f = f1 + (f0 - f1) * Math.exp(-t / (decayS * 0.6))
    phase += (2 * Math.PI * f) / rate
    const env = (1 - Math.exp(-t / 0.004)) * Math.exp(-t / decayS)
    const click = i < rate * 0.006 ? (rnd() * 2 - 1) * 0.15 * (1 - i / (rate * 0.006)) : 0
    out[start + i] = out[start + i]! + (Math.sin(phase) * env + click) * gain
  }
}

/** One-pole low-pass in place (cut-off `hz`). */
function lowpass(s: Float32Array, rate: number, hz: number | ((i: number) => number)): void {
  let y = 0
  for (let i = 0; i < s.length; i++) {
    const fc = typeof hz === 'number' ? hz : hz(i)
    const a = 1 - Math.exp((-2 * Math.PI * fc) / rate)
    y += a * (s[i]! - y)
    s[i] = y
  }
}

/** The heartbeat: lub (55 → 38 Hz) and dub (62 → 44 Hz, softer) 0.24 s apart; 0.75 s long. */
export function heartbeatPcm(seed = 11): Pcm {
  const rate = SYNTH_RATE
  const s = new Float32Array(Math.floor(rate * 0.75))
  const rnd = synthRng(seed)
  thump(s, rate, 0.0, 70, 40, 0.07, 1, rnd)
  thump(s, rate, 0.24, 78, 46, 0.06, 0.62, rnd)
  lowpass(s, rate, 260)
  return { rate, samples: normalize(s, 0.95) }
}

/** The sub drop under the start: a 90 → 28 Hz sweep with a rumble of low-passed noise; 1.4 s. */
export function boomPcm(seed = 23): Pcm {
  const rate = SYNTH_RATE
  const s = new Float32Array(Math.floor(rate * 1.4))
  const rnd = synthRng(seed)
  thump(s, rate, 0, 95, 28, 0.32, 1, rnd)
  const noise = new Float32Array(s.length)
  for (let i = 0; i < noise.length; i++) {
    const t = i / rate
    noise[i] = (rnd() * 2 - 1) * Math.exp(-t / 0.45) * (1 - Math.exp(-t / 0.01))
  }
  lowpass(noise, rate, 160)
  lowpass(noise, rate, 160)
  for (let i = 0; i < s.length; i++) s[i] = s[i]! + noise[i]! * 2.5
  return { rate, samples: normalize(s, 0.95) }
}

/**
 * The exhale: breath noise through a formant-ish band (a falling low-pass over a high-pass), swelling in and dying out,
 * over a quiet steam hiss; 1.6 s.
 */
export function exhalePcm(seed = 37): Pcm {
  const rate = SYNTH_RATE
  const n = Math.floor(rate * 1.6)
  const rnd = synthRng(seed)
  const breath = new Float32Array(n)
  const hiss = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    breath[i] = rnd() * 2 - 1
    hiss[i] = rnd() * 2 - 1
  }
  // Breath: a band that closes from ~1.6 kHz to ~500 Hz (the mouth relaxing).
  lowpass(breath, rate, i => 1600 - 1100 * (i / n))
  lowpass(breath, rate, i => 1800 - 1200 * (i / n))
  let prev = 0
  let hp = 0
  for (let i = 0; i < n; i++) {
    // High-pass (~180 Hz) so it is air, not rumble.
    const x = breath[i]!
    hp = 0.95 * (hp + x - prev)
    prev = x
    breath[i] = hp
  }
  // Hiss: the steam, bright and short.
  let hprev = 0
  let hh = 0
  for (let i = 0; i < n; i++) {
    const x = hiss[i]!
    hh = 0.6 * (hh + x - hprev)
    hprev = x
    hiss[i] = hh
  }
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const env = Math.min(1, t / 0.18) * Math.exp(-Math.max(0, t - 0.25) / 0.45)
    const steam = Math.min(1, t / 0.03) * Math.exp(-t / 0.35)
    s[i] = breath[i]! * env * 3 + hiss[i]! * steam * 0.18
  }
  return { rate, samples: normalize(s, 0.8) }
}

/** The makeover's synthesized sounds by id (GameAudio.prepareSynth keys). */
export const BERSERK_SYNTH: Readonly<Record<string, () => Pcm>> = {
  'synth/bz_heart': () => heartbeatPcm(),
  'synth/bz_boom': () => boomPcm(),
  'synth/bz_exhale': () => exhalePcm(),
}

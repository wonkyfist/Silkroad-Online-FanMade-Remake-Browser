/**
 * The lightning tornado's sounds (docs/WEATHER.md §13.7), synthesized at runtime like audio/synth.ts's set (seeded,
 * deterministic, nothing downloaded; the retail client has no tornado): GameAudio.prepareSynth decodes them once under
 * `synth/tornado_*` and the tornado feature plays them with `playFile`.
 *
 * - `synth/tornado_roar_a` / `_b`: 6.5 s of roar (a deep rumble, the "freight train" band, a wandering howl and the
 *   electric crackle of the arcs inside) with soft 1.5 s ends; the feature starts one every ROAR_EVERY_S, alternating,
 *   so they overlap into one endless roar whose level and pan follow the funnel.
 * - `synth/tornado_whoosh`: the rush of air when the tornado throws you.
 *
 * Pure: no WebAudio here, so the recipes are unit-tested.
 */
import { SYNTH_RATE, normalize, synthRng, type Pcm } from './synth.ts'

export const ROAR_S = 6.5
/** A new roar segment starts this often (s): segments overlap by ROAR_S − ROAR_EVERY_S. */
export const ROAR_EVERY_S = 4.6
const FADE_S = 1.5

/** One roar segment (seeded: the two segments differ, so the overlap never phases). */
export function roarPcm(seed: number): Pcm {
  const rate = SYNTH_RATE
  const n = Math.round(ROAR_S * rate)
  const s = new Float32Array(n)
  const rng = synthRng(seed)
  let lowA = 0
  let lowB = 0
  // a two-pole resonator for the "freight train" band and one for the howl
  let b1 = 0
  let b2 = 0
  let h1 = 0
  let h2 = 0
  let crack = 0
  const lfo = rng() * 10
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const noise = rng() * 2 - 1
    lowA += 0.015 * (noise - lowA)
    lowB += 0.015 * (lowA - lowB)
    const rumble = lowB * 14 * (0.8 + 0.2 * Math.sin(2 * Math.PI * 0.37 * t + lfo))
    // band: centre 160..300 Hz wandering slowly
    const fc = 220 + 70 * Math.sin(2 * Math.PI * 0.21 * t + lfo * 2)
    const w = (2 * Math.PI * fc) / rate
    const r = 0.985
    const band = noise * 0.05 + 2 * r * Math.cos(w) * b1 - r * r * b2
    b2 = b1
    b1 = band
    // howl: 480..760 Hz, a narrow resonance, swelling and fading
    const fh = 620 + 140 * Math.sin(2 * Math.PI * 0.13 * t + lfo * 3) + 30 * Math.sin(2 * Math.PI * 1.7 * t)
    const wh = (2 * Math.PI * fh) / rate
    const rh = 0.997
    const howl = noise * 0.01 + 2 * rh * Math.cos(wh) * h1 - rh * rh * h2
    h2 = h1
    h1 = howl
    const howlEnv = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.29 * t + lfo)
    // crackles of the arcs: sparse bursts of clicks
    if (rng() < 9 / rate) crack = 0.6 + 0.4 * rng()
    crack *= 0.9985
    const click = rng() < 0.08 ? noise * crack : 0
    s[i] = rumble + band * 0.9 + howl * 0.35 * howlEnv + click * 0.25
  }
  normalize(s, 0.85)
  const f = Math.round(FADE_S * rate)
  for (let i = 0; i < f && i < n; i++) {
    const g = Math.sin((i / f) * (Math.PI / 2))
    s[i] = s[i]! * g
    s[n - 1 - i] = s[n - 1 - i]! * g
  }
  return { rate, samples: s }
}

/** The rush when you are thrown: a band of noise sweeping up and down over 1.3 s. */
export function whooshPcm(seed = 61): Pcm {
  const rate = SYNTH_RATE
  const n = Math.round(1.3 * rate)
  const s = new Float32Array(n)
  const rng = synthRng(seed)
  let b1 = 0
  let b2 = 0
  for (let i = 0; i < n; i++) {
    const t = i / n
    const fc = 300 + 1500 * Math.sin(Math.PI * t)
    const w = (2 * Math.PI * fc) / rate
    const r = 0.96
    const v = (rng() * 2 - 1) * 0.2 + 2 * r * Math.cos(w) * b1 - r * r * b2
    b2 = b1
    b1 = v
    s[i] = v * Math.sin(Math.PI * t) ** 1.5
  }
  return { rate, samples: normalize(s, 0.8) }
}

/** The set by id (GameAudio.prepareSynth keys). */
export const TORNADO_SYNTH: Readonly<Record<string, () => Pcm>> = {
  'synth/tornado_roar_a': () => roarPcm(101),
  'synth/tornado_roar_b': () => roarPcm(202),
  'synth/tornado_whoosh': () => whooshPcm(),
}

/** The roar's level at `distM` from the funnel (1 close, 0 at hearM), times how much of the funnel there is. */
export function roarGain(distM: number, hearM: number, presence: number): number {
  const k = Math.max(0, 1 - Math.max(0, distM - 20) / Math.max(1, hearM - 20))
  return Math.max(0, Math.min(1, presence)) * k * k
}

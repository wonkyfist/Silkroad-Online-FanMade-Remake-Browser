/**
 * Winter gameplay sounds (docs/WINTER.md §13.7), synthesized at runtime like audio/winter.ts (seeded, deterministic,
 * nothing downloaded; the retail client has no snowball or yeti): GameAudio.prepareSynth decodes them once under
 * `synth/wp_*` and the winter-play feature plays them with `playFile`.
 *
 * - `wp_throw`: a short airy whoosh (a band of noise sweeping up), 0.28 s.
 * - `wp_splat`: a soft thump with a crunchy burst of snow, 0.34 s.
 * - `wp_roar`: the Ice Yeti's roar: a growling low voice (a buzzy 70-110 Hz source through two moving formants) with
 *   breath on top, 1.7 s.
 * - `wp_slam`: her ground slam: a sub boom with a crack of ice, 1.0 s.
 * - `wp_breath`: her frost breath: a long icy hiss with a whistle, 1.1 s.
 * - `wp_gift`: a gift box opening: a paper rustle and a bright chime arpeggio, 1.0 s.
 * - `wp_fire`: a campfire's crackle (pops on a soft roar), 1.6 s; played now and then near a fire.
 * - `wp_shiver`: a short teeth-chatter warning when freezing sets in, 0.6 s.
 *
 * Pure: no WebAudio here, so the recipes are unit-tested.
 */
import { SYNTH_RATE, normalize, synthRng, type Pcm } from './synth.ts'

function buf(seconds: number): Float32Array {
  return new Float32Array(Math.floor(SYNTH_RATE * seconds))
}

/** One-pole low-pass in place. */
function lp(s: Float32Array, hz: number | ((i: number) => number)): void {
  let y = 0
  for (let i = 0; i < s.length; i++) {
    const fc = typeof hz === 'number' ? hz : hz(i)
    const a = 1 - Math.exp((-2 * Math.PI * fc) / SYNTH_RATE)
    y += a * (s[i]! - y)
    s[i] = y
  }
}

/** One-pole high-pass in place (r close to 1 = a low cut-off). */
function hp(s: Float32Array, r: number): void {
  let prev = 0
  let y = 0
  for (let i = 0; i < s.length; i++) {
    const x = s[i]!
    y = r * (y + x - prev)
    prev = x
    s[i] = y
  }
}

/** A two-pole resonator at `f` Hz (q close to 1 = narrow) over `x`, added into `out` with `gain`. */
function resonate(out: Float32Array, x: Float32Array, f: (i: number) => number, q: number, gain: number): void {
  let a1 = 0
  let a2 = 0
  for (let i = 0; i < x.length; i++) {
    const w = (2 * Math.PI * f(i)) / SYNTH_RATE
    const y = x[i]! * (1 - q) + 2 * q * Math.cos(w) * a1 - q * q * a2
    a2 = a1
    a1 = y
    out[i] = out[i]! + y * gain
  }
}

function noise(n: number, rng: () => number): Float32Array {
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = rng() * 2 - 1
  return s
}

export function throwPcm(seed = 101): Pcm {
  const s = buf(0.28)
  const rng = synthRng(seed)
  const n = noise(s.length, rng)
  resonate(s, n, (i) => 500 + 2200 * (i / s.length), 0.96, 0.6)
  for (let i = 0; i < s.length; i++) {
    const t = i / s.length
    s[i] = s[i]! * Math.sin(Math.PI * t) ** 1.5
  }
  return { rate: SYNTH_RATE, samples: normalize(s, 0.7) }
}

export function splatPcm(seed = 103): Pcm {
  const s = buf(0.34)
  const rng = synthRng(seed)
  let ph = 0
  for (let i = 0; i < s.length; i++) {
    const t = i / SYNTH_RATE
    const f = 70 + 90 * Math.exp(-t / 0.03)
    ph += (2 * Math.PI * f) / SYNTH_RATE
    s[i] = Math.sin(ph) * Math.exp(-t / 0.05) * 0.9
  }
  const crunch = noise(s.length, rng)
  hp(crunch, 0.7)
  lp(crunch, 4500)
  for (let i = 0; i < s.length; i++) {
    const t = i / SYNTH_RATE
    // a few grains in the burst: snow crunch
    const grain = rng() < 0.03 ? 1.6 : 1
    s[i] = s[i]! + crunch[i]! * Math.exp(-t / 0.07) * (1 - Math.exp(-t / 0.002)) * grain * 0.9
  }
  return { rate: SYNTH_RATE, samples: normalize(s, 0.85) }
}

export function roarPcm(seed = 107): Pcm {
  const s = buf(1.7)
  const rng = synthRng(seed)
  const src = new Float32Array(s.length)
  let ph = 0
  for (let i = 0; i < s.length; i++) {
    const t = i / SYNTH_RATE
    // the growl: a buzzy saw-ish source with a slow rise and a rough wobble
    const f = 72 + 38 * Math.sin(Math.PI * Math.min(1, t / 1.2)) + 6 * Math.sin(2 * Math.PI * 23 * t) + (rng() - 0.5) * 8
    ph += f / SYNTH_RATE
    const saw = 2 * (ph - Math.floor(ph)) - 1
    src[i] = saw + (rng() * 2 - 1) * 0.35
  }
  resonate(s, src, (i) => 420 + 160 * Math.sin(i / 9000), 0.985, 0.35)
  resonate(s, src, (i) => 980 + 260 * Math.sin(i / 7000 + 1), 0.98, 0.22)
  const breath = noise(s.length, rng)
  lp(breath, 1800)
  for (let i = 0; i < s.length; i++) {
    const t = i / SYNTH_RATE
    const env = Math.min(1, t / 0.12) * Math.exp(-Math.max(0, t - 0.9) / 0.35)
    s[i] = (s[i]! + src[i]! * 0.08 + breath[i]! * 0.25) * env
  }
  lp(s, 2600)
  return { rate: SYNTH_RATE, samples: normalize(s, 0.9) }
}

export function slamPcm(seed = 109): Pcm {
  const s = buf(1)
  const rng = synthRng(seed)
  let ph = 0
  for (let i = 0; i < s.length; i++) {
    const t = i / SYNTH_RATE
    const f = 30 + 70 * Math.exp(-t / 0.08)
    ph += (2 * Math.PI * f) / SYNTH_RATE
    s[i] = Math.sin(ph) * Math.exp(-t / 0.28) * (1 - Math.exp(-t / 0.003))
  }
  const crack = noise(s.length, rng)
  hp(crack, 0.8)
  const rumble = noise(s.length, rng)
  lp(rumble, 140)
  lp(rumble, 140)
  for (let i = 0; i < s.length; i++) {
    const t = i / SYNTH_RATE
    s[i] = s[i]! + crack[i]! * Math.exp(-t / 0.04) * 0.6 + rumble[i]! * Math.exp(-t / 0.4) * 3
  }
  return { rate: SYNTH_RATE, samples: normalize(s, 0.95) }
}

export function breathPcm(seed = 113): Pcm {
  const s = buf(1.1)
  const rng = synthRng(seed)
  const n = noise(s.length, rng)
  hp(n, 0.9)
  lp(n, (i) => 3000 + 3500 * (i / s.length))
  const whistle = new Float32Array(s.length)
  resonate(whistle, noise(s.length, rng), (i) => 2600 + 500 * Math.sin(i / 3000), 0.997, 1)
  for (let i = 0; i < s.length; i++) {
    const t = i / SYNTH_RATE
    const env = Math.min(1, t / 0.15) * Math.exp(-Math.max(0, t - 0.6) / 0.25)
    s[i] = (n[i]! * 0.9 + whistle[i]! * 0.25) * env
  }
  return { rate: SYNTH_RATE, samples: normalize(s, 0.75) }
}

export function giftPcm(seed = 127): Pcm {
  const s = buf(1)
  const rng = synthRng(seed)
  // the paper: a short rustle
  const paper = noise(s.length, rng)
  hp(paper, 0.6)
  for (let i = 0; i < s.length; i++) {
    const t = i / SYNTH_RATE
    s[i] = paper[i]! * Math.exp(-t / 0.06) * (rng() < 0.3 ? 1 : 0.4) * 0.5
  }
  // the chime: a rising arpeggio of bell partials (C6 E6 G6 C7)
  const notes = [1046.5, 1318.5, 1568, 2093]
  notes.forEach((f, k) => {
    const start = Math.floor((0.12 + k * 0.09) * SYNTH_RATE)
    for (let i = start; i < s.length; i++) {
      const t = (i - start) / SYNTH_RATE
      const env = Math.exp(-t / 0.35) * (1 - Math.exp(-t / 0.002))
      s[i] = s[i]! + (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t / 0.1)) * env * 0.4
    }
  })
  return { rate: SYNTH_RATE, samples: normalize(s, 0.75) }
}

export function firePcm(seed = 131): Pcm {
  const s = buf(1.6)
  const rng = synthRng(seed)
  const roar = noise(s.length, rng)
  lp(roar, 400)
  lp(roar, 400)
  for (let i = 0; i < s.length; i++) s[i] = roar[i]! * 2
  // crackles: short bright pops at random times
  for (let k = 0; k < 14; k++) {
    const start = Math.floor(rng() * (s.length - 400))
    const amp = 0.3 + rng() * 0.7
    for (let i = 0; i < 300; i++) s[start + i] = s[start + i]! + (rng() * 2 - 1) * amp * Math.exp(-i / 40)
  }
  // soft ends so repeats overlap without a click
  const f = Math.floor(0.2 * SYNTH_RATE)
  for (let i = 0; i < f; i++) {
    const g = i / f
    s[i] = s[i]! * g
    s[s.length - 1 - i] = s[s.length - 1 - i]! * g
  }
  return { rate: SYNTH_RATE, samples: normalize(s, 0.6) }
}

export function shiverPcm(seed = 137): Pcm {
  const s = buf(0.6)
  const rng = synthRng(seed)
  // teeth chattering: quick clicks, ~18 a second
  for (let k = 0; k < 10; k++) {
    const start = Math.floor((0.02 + k * 0.055 + (rng() - 0.5) * 0.01) * SYNTH_RATE)
    for (let i = 0; i < 120 && start + i < s.length; i++) s[start + i] = s[start + i]! + (rng() * 2 - 1) * Math.exp(-i / 18) * (1 - k / 14)
  }
  lp(s, 3500)
  return { rate: SYNTH_RATE, samples: normalize(s, 0.55) }
}

/** The set by id (GameAudio.prepareSynth keys). */
export const WINTER_PLAY_SYNTH: Readonly<Record<string, () => Pcm>> = {
  'synth/wp_throw': () => throwPcm(),
  'synth/wp_splat': () => splatPcm(),
  'synth/wp_roar': () => roarPcm(),
  'synth/wp_slam': () => slamPcm(),
  'synth/wp_breath': () => breathPcm(),
  'synth/wp_gift': () => giftPcm(),
  'synth/wp_fire': () => firePcm(),
  'synth/wp_shiver': () => shiverPcm(),
}

/** A campfire's crackle is heard within this (m), and replayed this often (s). */
export const FIRE_HEAR_M = 14
export const FIRE_EVERY_S = 1.3

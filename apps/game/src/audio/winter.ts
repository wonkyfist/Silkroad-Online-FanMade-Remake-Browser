/**
 * Winter sounds (docs/WINTER.md §8.3), synthesized at runtime like audio/synth.ts's (seeded, deterministic, nothing
 * downloaded; the retail client has no blizzard): GameAudio.prepareSynth decodes them once under `synth/winter_*` and
 * the winter feature plays them with `playFile`.
 *
 * - `synth/winter_howl_a` / `_b`: 7 s of blizzard wind (a low roar of air, two wandering narrow howls that swell and
 *   fade, a hiss of driven snow) with soft 1.8 s ends; the feature starts one every HOWL_EVERY_S, alternating, so they
 *   overlap into one endless howl whose level follows the blizzard (`howlGain`).
 * - The crunchy footsteps are the retail snow steps (`player/mvwalksnow`, `mvrunsnow`): GameAudio swaps the footstep
 *   surface to Snow on snowy ground (`snowSurface`); the muffled ambience is a lower ambient bus (`muffleGain`).
 *
 * Pure: no WebAudio here, so the recipes are unit-tested.
 */
import type { SoundSurface } from '@sro/shared'
import { SYNTH_RATE, normalize, synthRng, type Pcm } from './synth.ts'

export const HOWL_S = 7
/** A new howl segment starts this often (s): segments overlap by HOWL_S − HOWL_EVERY_S. */
export const HOWL_EVERY_S = 5
const FADE_S = 1.8

/** One howl segment (seeded: the two segments differ, so the overlap never phases). */
export function howlPcm(seed: number): Pcm {
  const rate = SYNTH_RATE
  const n = Math.round(HOWL_S * rate)
  const s = new Float32Array(n)
  const rng = synthRng(seed)
  let low1 = 0
  let low2 = 0
  let a1 = 0
  let a2 = 0
  let b1 = 0
  let b2 = 0
  let hp = 0
  let prev = 0
  const ph = rng() * 10
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const noise = rng() * 2 - 1
    // the roar of moving air: twice low-passed noise, breathing with the gusts
    low1 += 0.02 * (noise - low1)
    low2 += 0.02 * (low1 - low2)
    const gust = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.18 * t + ph) * Math.sin(2 * Math.PI * 0.07 * t + ph * 2)
    const roar = low2 * 10 * gust
    // two howls: narrow resonances wandering 320..720 Hz and 520..980 Hz
    const f1 = 470 + 150 * Math.sin(2 * Math.PI * 0.11 * t + ph) + 40 * Math.sin(2 * Math.PI * 0.9 * t)
    const w1 = (2 * Math.PI * f1) / rate
    const r1 = 0.9975
    const h1 = noise * 0.012 + 2 * r1 * Math.cos(w1) * a1 - r1 * r1 * a2
    a2 = a1
    a1 = h1
    const f2 = 750 + 230 * Math.sin(2 * Math.PI * 0.083 * t + ph * 3)
    const w2 = (2 * Math.PI * f2) / rate
    const h2 = noise * 0.008 + 2 * r1 * Math.cos(w2) * b1 - r1 * r1 * b2
    b2 = b1
    b1 = h2
    const env1 = Math.max(0, Math.sin(2 * Math.PI * 0.15 * t + ph)) ** 2
    const env2 = Math.max(0, Math.sin(2 * Math.PI * 0.12 * t + ph * 1.7 + 1.3)) ** 2
    // the hiss of driven snow: high-passed noise, following the gusts
    hp = 0.85 * (hp + noise - prev)
    prev = noise
    s[i] = roar + h1 * 0.5 * env1 + h2 * 0.35 * env2 + hp * 0.05 * gust
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

/** The set by id (GameAudio.prepareSynth keys). */
export const WINTER_SYNTH: Readonly<Record<string, () => Pcm>> = {
  'synth/winter_howl_a': () => howlPcm(311),
  'synth/winter_howl_b': () => howlPcm(733),
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/**
 * The howl's level: a blizzard (snowfall from 0.6 toward 1) in a strong wind (gusting from 7 m/s); `sheltered` (a roof
 * over you) takes off half. 0 in plain snow or calm.
 */
export function howlGain(snow: number, gustMs: number, sheltered = false): number {
  const bliz = clamp01((snow - 0.6) / 0.4)
  const wind = clamp01((gustMs - 7) / 8)
  return bliz * (0.35 + 0.65 * wind) * (sheltered ? 0.5 : 1)
}

/** Footstep surfaces that take snow (bare ground, grass, the paving under it); wood floors and water keep theirs. */
const SNOWABLE: ReadonlySet<SoundSurface> = new Set<SoundSurface>(['Dirt', 'Sand', 'Ashfield', 'Stone', 'Mud', 'Grass', 'LongGrass', 'Forest'])
/** The footsteps crunch from this snow cover on. */
export const SNOW_STEP_COVER = 0.35

/** The footstep surface on snowy ground: Snow where the ground takes snow and the cover is deep enough. */
export function snowSurface(surface: SoundSurface, cover: number): SoundSurface {
  return cover >= SNOW_STEP_COVER && SNOWABLE.has(surface) ? 'Snow' : surface
}

/** The ambient bus under snow: the cover softens the world (−2.5 dB at full cover), falling snow a little more. */
export function muffleGain(cover: number, snow: number): number {
  return 1 - 0.25 * clamp01(cover) - 0.12 * clamp01(snow)
}

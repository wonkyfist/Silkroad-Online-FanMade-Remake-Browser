/**
 * The rare-drop chimes (docs/RARITY.md §5.5): one short bell per seal, made in code (audio/synth.ts: rendered once,
 * seeded, nothing downloaded) and played where a Seal of Star / Moon / Sun lands, over the retail rare-drop sound
 * (effectsound ITEM SND_DROPITEM RARE, `item.dropRare`). Pure: no WebAudio here (unit-tested).
 *  - Star: three quick high pings rising (a twinkle);
 *  - Moon: two soft low bells a fifth apart with a long ring;
 *  - Sun: a bright major chord struck at once, with a shimmer on top.
 */
import type { RarityTier } from '@sro/shared'
import { SYNTH_RATE, normalize, synthRng, type Pcm } from '../../audio/synth.ts'

/** One bell partial set (inharmonic, like a small struck bell) added into `out` from `at` seconds. */
function bell(out: Float32Array, rate: number, at: number, f: number, decayS: number, gain: number): void {
  const start = Math.floor(at * rate)
  const partials: readonly (readonly [number, number, number])[] = [[1, 1, 1], [2.01, 0.45, 0.7], [2.76, 0.3, 0.5], [5.4, 0.12, 0.3]]
  const len = Math.min(out.length - start, Math.floor(decayS * 5 * rate))
  for (let i = 0; i < len; i++) {
    const t = i / rate
    const attack = 1 - Math.exp(-t / 0.002)
    let v = 0
    for (const [m, g, d] of partials) v += Math.sin(2 * Math.PI * f * m * t) * g * Math.exp(-t / (decayS * d))
    out[start + i] = out[start + i]! + v * attack * gain
  }
}

export function chimePcm(tier: RarityTier, seed = 5): Pcm {
  const rate = SYNTH_RATE
  const len = tier === 'star' ? 1.2 : tier === 'moon' ? 2.2 : 2
  const s = new Float32Array(Math.floor(rate * len))
  const rnd = synthRng(seed)
  if (tier === 'star') {
    bell(s, rate, 0, 1568, 0.25, 0.8)
    bell(s, rate, 0.09, 2093, 0.25, 0.7)
    bell(s, rate, 0.18, 2637, 0.35, 0.65)
  } else if (tier === 'moon') {
    bell(s, rate, 0, 523, 0.8, 0.9)
    bell(s, rate, 0.16, 784, 0.9, 0.7)
  } else {
    for (const [f, g] of [[523, 0.8], [659, 0.65], [784, 0.6], [1047, 0.5]] as const) bell(s, rate, 0, f, 0.75, g)
    // A shimmer: quick soft high pings spread over the first second.
    for (let k = 0; k < 7; k++) bell(s, rate, 0.12 + k * 0.11 + rnd() * 0.03, 2093 + rnd() * 1400, 0.18, 0.18)
  }
  return { rate, samples: normalize(s, 0.85) }
}

/** The synth ids (GameAudio.prepareSynth / playFile). */
export const CHIME_IDS: Readonly<Record<RarityTier, string>> = { star: 'synth/rare_star', moon: 'synth/rare_moon', sun: 'synth/rare_sun' }

export const RARITY_SYNTH: Readonly<Record<string, () => Pcm>> = {
  [CHIME_IDS.star]: () => chimePcm('star'),
  [CHIME_IDS.moon]: () => chimePcm('moon'),
  [CHIME_IDS.sun]: () => chimePcm('sun'),
}

/**
 * Winter on the Classic environment (docs/WINTER.md §7.6): the classic sky's palette under frost and snow. The fog and
 * the horizon whiten toward a cold grey, the sun cools a little, the object ambient and the terrain's shadow colour lift
 * with the snow cover (the snow throws light back up), all by day only (no blue night). Identity (the input object) with
 * no frost and no cover, so the Low guard holds outside the season. The PBR path takes the winter grade instead
 * (render/grade.ts). A reused output object: valid until the next call.
 */
import type { EnvValues, RGB } from '../environment.ts'

const out: EnvValues = {
  sun: [0, 0, 0], skyTop: [0, 0, 0], skyBottom: [0, 0, 0], diffuse: [0, 0, 0], objectAmbient: [0, 0, 0], scatter: [0, 0, 0],
  terrainShadow: [0, 0, 0], fogColor: [0, 0, 0], water: [0, 0, 0], g7: 0, g8: 0, g10: 0, g11: 0,
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const grey = (c: Readonly<RGB>) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]

function copy(dst: RGB, src: Readonly<RGB>): void {
  dst[0] = src[0]
  dst[1] = src[1]
  dst[2] = src[2]
}

/** dst = mix(src, grey(src) × lift × tint, k). */
function toCold(dst: RGB, src: Readonly<RGB>, lift: number, k: number): void {
  const g = grey(src) * lift
  const tint = [0.97, 0.99, 1.03]
  for (let i = 0; i < 3; i++) dst[i] = src[i]! + (Math.min(1, g * tint[i]!) - src[i]!) * k
}

/** The winter terms on a Classic env: `frost` and `cover` 0..1, `night` 0..1 (the classic sky's darkness). */
export function applyWinterToEnv(env: EnvValues, frost: number, cover: number, night = 0): EnvValues {
  const f = clamp01(frost)
  const c = clamp01(cover)
  if (!(f > 0) && !(c > 0)) return env
  const day = 1 - clamp01(night)
  copy(out.sun, env.sun)
  copy(out.skyTop, env.skyTop)
  copy(out.scatter, env.scatter)
  copy(out.water, env.water)
  out.g7 = env.g7
  out.g8 = env.g8
  out.g10 = env.g10
  out.g11 = env.g11
  toCold(out.fogColor, env.fogColor, 1.12, 0.35 * f * day)
  toCold(out.skyBottom, env.skyBottom, 1.1, 0.3 * f * day)
  for (let i = 0; i < 3; i++) {
    const cool = [0.97, 0.99, 1.02][i]!
    out.diffuse[i] = env.diffuse[i]! * (1 + (cool - 1) * f * day)
    out.objectAmbient[i] = env.objectAmbient[i]! * (1 + 0.14 * c * day)
    out.terrainShadow[i] = Math.min(1, env.terrainShadow[i]! + 0.06 * c * day)
  }
  return out
}

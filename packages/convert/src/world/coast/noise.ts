/**
 * Deterministic value noise for the coast pass (docs/COAST.md §3.1 point 7, §5.4 "Determinism"): an integer hash of
 * the lattice point and the seed, no Math.random and no clock. Bit-for-bit the functions of the beaches prototype
 * (work/tmp/coast-beach/coast_beach.py `hash2`, `value_noise`, `fbm`), so the port reproduces its arrays.
 *
 * Coordinates are metres in the prototype's frame (x east, z north, origin at region (168, 97)'s south-west corner).
 */

/** Integer hash of (ix, iz, seed) -> [-1, 1]. 32-bit wrap-around, as the prototype's `& 0xFFFFFFFF`. */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 2147483647)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return (((h ^ (h >>> 16)) & 0xffffff) / 0xffffff) * 2 - 1
}

/** Smoothed (cubic Hermite) bilinear value noise at wavelength `wl` metres; range [-1, 1]. */
export function valueNoise(xm: number, zm: number, wl: number, seed: number): number {
  const fx = xm / wl
  const fz = zm / wl
  const ix = Math.floor(fx)
  const iz = Math.floor(fz)
  let tx = fx - ix
  let tz = fz - iz
  tx = tx * tx * (3 - 2 * tx)
  tz = tz * tz * (3 - 2 * tz)
  const a = hash2(ix, iz, seed)
  const b = hash2(ix + 1, iz, seed)
  const c = hash2(ix, iz + 1, seed)
  const d = hash2(ix + 1, iz + 1, seed)
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz
}

/** Fractal sum of `octaves` value-noise octaves (wavelength halves, amplitude halves), normalised by the amplitude sum. */
export function fbm(xm: number, zm: number, wl0: number, octaves: number, seed: number): number {
  let tot = 0
  let amp = 1
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    tot = tot + amp * valueNoise(xm, zm, wl0 / 2 ** o, seed + 17 * o)
    norm += amp
    amp *= 0.5
  }
  return tot / norm
}

/** Noise settings as coast.json carries them: `seedOffset` is added to the config's seed. */
export interface NoiseSpec {
  wavelengthM: number
  octaves: number
  seedOffset: number
}

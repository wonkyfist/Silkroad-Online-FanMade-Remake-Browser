/**
 * Portions ported from Tidewater (github.com/dgreenheck/tidewater, `OceanFFT.js` at `4811ba4`), MIT licence, Copyright (c)
 * 2026 DRG Software Solutions LLC. See THIRD_PARTY_NOTICES.md.
 *
 * The ocean's wave spectrum (docs/COAST.md §8.3, §8.4, §8.7): JONSWAP with the TMA finite-depth correction, a
 * directional cos-2s spread that narrows with the swell (Mitsuyasu's spread plus Horvath's swell term), a short-wave
 * fade, two wave systems (a local wind sea and a swell), non-integer cascade ratios with non-overlapping bands, fixed
 * hashed Gaussians (a wind change grows or calms the same sea instead of re-rolling it), angular frequencies rounded to
 * multiples of 2π / 3,600 s (the shader clock wraps at 3,600 s without a seam) and the gameplay clamp Hs ≤ 2.5 m.
 *
 * Pure: shared by the worker tile (Medium), the GPU path's h0 (High/Ultra), Low's Gerstner set and the CPU queries.
 *
 * Conventions: glTF metres (x east, z south); a wave vector k points where the wave travels; the surface is
 * h(x, t) = Σ h̃(k, t) e^{i k·x} with h̃(k, t) = h0(k) e^{−iωt} + conj(h0(−k)) e^{iωt}, so each component travels along
 * +k, and E|h0(k)|² = S(k) Δk² / 2, so the surface variance is m0 = Σ S(k) Δk² (Hs = 4 √m0).
 */

export const GRAVITY = 9.81
/** Every ω is a multiple of this (2π / 3,600 s): t and t + 3,600 s give the same surface. */
export const OMEGA_QUANTUM = (2 * Math.PI) / 3600
/** The gameplay clamp on the significant wave height (COAST §8.7). */
export const HS_MAX_M = 2.5
/** The band factor: cascade c keeps the wavelengths from L_c / 6 down to L_(c+1) / 6 (COAST §8.3). */
export const BAND_FACTOR = 6

/** One wave system (the wind sea or the swell). */
export interface WaveSystem {
  /** Wind speed (m/s) and fetch (m) that grew it (JONSWAP's α and ωp). */
  windMs: number
  fetchM: number
  /** Direction the waves travel toward: radians, atan2(z, x) in glTF xz. */
  dirRad: number
  /** Energy scale (the swell's 0.2 … 0.9). */
  scale: number
  /** 0 = a wind sea … 1 = a swell: narrows the spread (Horvath's ξ). */
  swell: number
  /** JONSWAP peak enhancement (3.3). */
  gamma: number
}

export interface SpectrumParams {
  systems: readonly WaveSystem[]
  /** The TMA depth (m): the open sea the tile stands for (shallow water is the per-cascade attenuation's job). */
  depthM: number
  /** Short-wave fade length (m): exp(−k² l²). */
  shortWaveM: number
  /** Hs clamp (m); the amplitudes are scaled down to it. */
  hsMaxM: number
  /** Seed of the hashed Gaussians (fixed per map: the sea keeps its face). */
  seed: number
}

/** One cascade: a tile of `tileM` metres on a `size`² grid, keeping |k| in [kMin, kMax). */
export interface Cascade {
  tileM: number
  size: number
  kMin: number
  kMax: number
}

/**
 * P-LOOK (wave 10 polish): a cascade keeps waves only down to this many texels per wavelength. The split between two
 * cascades moves to longer waves when the band factor's would put the coarser cascade's shortest waves at its Nyquist
 * (2 texels): such waves are drawn with almost no slope (bilinear taps between 2–3 texels per wavelength), which is
 * how Medium's two 64² cascades lost the calm sea's chop (its ≈ 16 m peak sat at 2.7 texels of the 400 m tile).
 */
export const MIN_TEXELS_PER_WAVE = 4

/** The wavenumber where cascade `c` hands over to `c + 1`: the band factor's, or earlier to stay resolved. */
function splitK(tiles: readonly number[], size: number, c: number): number {
  return Math.min((2 * Math.PI * BAND_FACTOR) / tiles[c + 1]!, (2 * Math.PI * size) / (MIN_TEXELS_PER_WAVE * tiles[c]!))
}

/** The cascades for tile sizes (longest first): non-overlapping bands, the first down to its fundamental. */
export function cascadesFor(tiles: readonly number[], size: number): Cascade[] {
  return tiles.map((tileM, c) => ({
    tileM,
    size,
    kMin: c === 0 ? 0 : splitK(tiles, size, c - 1),
    kMax: c === tiles.length - 1 ? Infinity : splitK(tiles, size, c),
  }))
}

/** The GPU FFT's tiles (m): Tidewater's four, ratio ≈ 4.7 (COAST §8.3). */
export const GPU_TILES_M = [733, 157, 33.3, 7.1] as const
/**
 * The worker tile's two cascades (m): the first holds the storm swell's peak (~400 m, COAST §8.4). P-LOOK: the second
 * is 110 m (was 400 / 5.7 ≈ 70 m), so with the resolved split (MIN_TEXELS_PER_WAVE: waves under 25 m go to the second
 * cascade) the calm wind sea's ≈ 16 m peak lies well inside it (≈ 7 texels per wavelength, 6–7 lattice steps from its
 * origin, so the chop is not a few repeating directions) and its tile repeats every 110 m instead of 70 m.
 */
export const WORKER_TILES_M = [400, 110] as const

// ---- dispersion, JONSWAP, TMA, spread --------------------------------------------------------------------------------

/** ω(k) on depth h (m): √(g k tanh(k h)). */
export function dispersion(k: number, depthM: number): number {
  return Math.sqrt(GRAVITY * k * Math.tanh(Math.min(k * depthM, 20)))
}

/** dω/dk on depth h. */
export function dispersionDerivative(k: number, depthM: number): number {
  const kh = Math.min(k * depthM, 20)
  const th = Math.tanh(kh)
  const ch = Math.cosh(kh)
  const w = Math.sqrt(GRAVITY * k * th)
  return w < 1e-9 ? 0 : (GRAVITY * (th + kh / (ch * ch))) / (2 * w)
}

/** ω rounded to a multiple of 2π / 3,600 s (never 0 for a travelling wave). */
export function roundOmega(w: number): number {
  return Math.max(1, Math.round(w / OMEGA_QUANTUM)) * OMEGA_QUANTUM
}

/** JONSWAP's α and peak ω for a wind speed (m/s) over a fetch (m). */
export function jonswapPeak(windMs: number, fetchM: number): { alpha: number; omegaP: number } {
  const u = Math.max(0.5, windMs)
  const f = Math.max(100, fetchM)
  return {
    alpha: 0.076 * Math.pow((u * u) / (f * GRAVITY), 0.22),
    omegaP: 22 * Math.pow((GRAVITY * GRAVITY) / (u * f), 1 / 3),
  }
}

/** JONSWAP S(ω) (m² s). */
export function jonswap(w: number, alpha: number, omegaP: number, gamma: number): number {
  if (w <= 0) return 0
  const sigma = w <= omegaP ? 0.07 : 0.09
  const r = Math.exp(-((w - omegaP) ** 2) / (2 * sigma * sigma * omegaP * omegaP))
  return ((alpha * GRAVITY * GRAVITY) / w ** 5) * Math.exp(-1.25 * (omegaP / w) ** 4) * Math.pow(gamma, r)
}

/** The TMA (Kitaigorodskii) depth factor Φ(ω, h). */
export function tma(w: number, depthM: number): number {
  const wh = w * Math.sqrt(depthM / GRAVITY)
  if (wh <= 1) return 0.5 * wh * wh
  if (wh < 2) return 1 - 0.5 * (2 - wh) ** 2
  return 1
}

/** ln Γ(x) (Lanczos, g = 7), x > 0. */
export function lnGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x)
  x -= 1
  let a = c[0]!
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** The cos-2s spread exponent at ω: Mitsuyasu's, plus 16 tanh(ωp / ω) ξ² for a swell (Horvath 2015). */
export function spreadExponent(w: number, omegaP: number, windMs: number, swell: number): number {
  const sp = 11.5 * Math.pow(GRAVITY / (omegaP * Math.max(0.5, windMs)), 2.5)
  const r = w / omegaP
  const base = r <= 1 ? sp * r ** 5 : sp * r ** -2.5
  return Math.min(200, Math.max(0.5, base + 16 * Math.tanh(omegaP / Math.max(w, 1e-6)) * swell * swell))
}

/** The normalised cos-2s spread D(θ) (∫ D dθ over −π..π = 1). */
export function spread(theta: number, s: number): number {
  const n = Math.exp(lnGamma(s + 1) - lnGamma(s + 0.5)) / (2 * Math.sqrt(Math.PI))
  return n * Math.pow(Math.abs(Math.cos(theta / 2)), 2 * s)
}

/** The directional wave-number spectrum S(kx, kz) of all systems (m⁴), before the cascade bands. */
export function spectrumAt(kx: number, kz: number, p: SpectrumParams): number {
  const k = Math.hypot(kx, kz)
  if (k < 1e-6) return 0
  const w = dispersion(k, p.depthM)
  const dwdk = dispersionDerivative(k, p.depthM)
  const angle = Math.atan2(kz, kx)
  const fade = Math.exp(-k * k * p.shortWaveM * p.shortWaveM)
  const phi = tma(w, p.depthM)
  let s = 0
  for (const sys of p.systems) {
    if (!(sys.scale > 0)) continue
    const { alpha, omegaP } = jonswapPeak(sys.windMs, sys.fetchM)
    const sw = jonswap(w, alpha, omegaP, sys.gamma) * phi
    if (!(sw > 0)) continue
    const theta = angle - sys.dirRad
    s += sys.scale * sw * spread(theta, spreadExponent(w, omegaP, sys.windMs, sys.swell))
  }
  return (s * fade * dwdk) / k
}

// ---- hashed Gaussians -------------------------------------------------------------------------------------------------

/** PCG hash (32-bit), the same in WGSL. */
export function pcg(v: number): number {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0
  return ((word >>> 22) ^ word) >>> 0
}

/** Two independent N(0, 1) values for a texel of a cascade (Box–Muller on two PCG hashes). */
export function gaussianPair(seed: number, cascade: number, i: number, j: number): [number, number] {
  const base = pcg((seed * 73856093) ^ (cascade * 19349663) ^ pcg(i * 83492791 + j))
  const u1 = (pcg(base) + 1) / 4294967297
  const u2 = pcg(base ^ 0x9e3779b9) / 4294967296
  const r = Math.sqrt(-2 * Math.log(u1))
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)]
}

// ---- h0 per cascade -------------------------------------------------------------------------------------------------

/**
 * One cascade's initial amplitudes, centred: index (i, j), i along x, j along z, k = 2π (i − N/2, j − N/2) / L.
 * `h0` holds h0(k) as (re, im) pairs; `omega` the rounded ω(k); the Nyquist row and column are 0 (no partner).
 */
export interface CascadeH0 {
  cascade: Cascade
  h0: Float32Array
  omega: Float32Array
  /** Σ S Δk² over the band kept (m²): the cascade's height variance before the clamp. */
  variance: number
}

/** The initial amplitudes of every cascade and the clamp scale (≤ 1) that keeps Hs ≤ hsMaxM. */
export function buildH0(cascades: readonly Cascade[], p: SpectrumParams): { cascades: CascadeH0[]; hs: number; hsRaw: number; scale: number } {
  const out: CascadeH0[] = []
  let m0 = 0
  cascades.forEach((c, ci) => {
    const n = c.size
    const dk = (2 * Math.PI) / c.tileM
    const kNyq = Math.PI * n / c.tileM
    const h0 = new Float32Array(n * n * 2)
    const omega = new Float32Array(n * n)
    let variance = 0
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i
        const kx = (i - n / 2) * dk
        const kz = (j - n / 2) * dk
        const k = Math.hypot(kx, kz)
        omega[idx] = k > 0 ? roundOmega(dispersion(k, p.depthM)) : 0
        if (i === 0 || j === 0 || k < 1e-9 || k < c.kMin || k >= c.kMax || k > kNyq) continue
        const s = spectrumAt(kx, kz, p) * dk * dk
        if (!(s > 0)) continue
        variance += s
        const [g1, g2] = gaussianPair(p.seed, ci, i, j)
        // E|h0|² = S Δk² / 2: ξ = (g1 + i g2) / √2 has E|ξ|² = 1.
        const a = Math.sqrt(s / 2) / Math.SQRT2
        h0[idx * 2] = g1 * a
        h0[idx * 2 + 1] = g2 * a
      }
    }
    m0 += variance
    out.push({ cascade: c, h0, omega, variance })
  })
  const hsRaw = 4 * Math.sqrt(m0)
  const scale = hsRaw > p.hsMaxM ? p.hsMaxM / hsRaw : 1
  if (scale < 1) for (const c of out) for (let i = 0; i < c.h0.length; i++) c.h0[i]! *= scale
  return { cascades: out, hs: hsRaw * scale, hsRaw, scale }
}

/** Hs (m) of the parameters over the cascades' bands (no clamp): 4 √Σ S Δk². */
export function significantHeight(cascades: readonly Cascade[], p: SpectrumParams): number {
  let m0 = 0
  for (const c of cascades) {
    const n = c.size
    const dk = (2 * Math.PI) / c.tileM
    const kNyq = Math.PI * n / c.tileM
    for (let j = 1; j < n; j++) {
      for (let i = 1; i < n; i++) {
        const kx = (i - n / 2) * dk
        const kz = (j - n / 2) * dk
        const k = Math.hypot(kx, kz)
        if (k < 1e-9 || k < c.kMin || k >= c.kMax || k > kNyq) continue
        m0 += spectrumAt(kx, kz, p) * dk * dk
      }
    }
  }
  return 4 * Math.sqrt(m0)
}

/** The peak period (s) of the most energetic system (the shore swell's period, COAST §8.8). */
export function peakPeriod(p: SpectrumParams): number {
  let best = 0
  let period = 9
  for (const sys of p.systems) {
    const { alpha, omegaP } = jonswapPeak(sys.windMs, sys.fetchM)
    const e = sys.scale * alpha / omegaP ** 4
    if (e > best) {
      best = e
      period = (2 * Math.PI) / omegaP
    }
  }
  return period
}

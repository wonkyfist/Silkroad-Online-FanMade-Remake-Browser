/**
 * Low's three Gerstner waves (docs/COAST.md §8.4, §8.10): drawn from the same spectrum as the FFT tile, so every preset
 * shows the same sea state. Wave 1 is the swell at its peak, waves 2 and 3 split the wind sea (its peak, and half its
 * wavelength 25° off the wind); each gets the height its system's energy gives (a sine of amplitude A has Hs = 2√2 A),
 * the Hs clamp applies to the set, the frequencies are rounded like the tile's (the 3,600 s wrap is seamless), and the
 * steepness keeps Q k A ≤ 0.6 / N. The shallow-water attenuation is per wave, by wavelength (§8.5).
 */
import { GRAVITY, dispersion, jonswapPeak, roundOmega, type SpectrumParams } from './spectrum.ts'
import { systemVariance } from './weather.ts'

export interface GerstnerWave {
  /** Unit travel direction (glTF xz). */
  dirX: number
  dirZ: number
  /** Wave number (rad/m), rounded ω (rad/s). */
  k: number
  omega: number
  /** Amplitude (m) and steepness Q (horizontal displacement = Q · A along the direction). */
  amp: number
  q: number
  phase: number
  /** The depth (m) at which the wave has its full height, and its floor in very shallow water (§8.5). */
  d0: number
  floor: number
}

/**
 * The attenuation floor for a wavelength: 0.15 / 0.3 / 0.4 / 0.5 for the 733 / 157 / 33 / 7 m tiles. Tidewater's
 * 0 / 0.05 / 0.25 / 0.5 hand the near shore over to its breaker field, which reaches far out; shore v1's swell only
 * covers the 64 m the coast field's distance spans (shore/chunks.ts), so with Tidewater's floors the sea within a few
 * hundred metres of a gentle beach (S1: 5 m deep at 140 m) read flat from the shore (CST-S, the X1 look notes item 4).
 * The floor still meets 0 at the waterline (`floor · smoothstep(0, 0.6, depth)`).
 */
export function attenuationFloor(lengthM: number): number {
  const pts: Array<[number, number]> = [[733, 0.15], [157, 0.3], [33.3, 0.4], [7.1, 0.5]]
  if (lengthM >= pts[0]![0]) return pts[0]![1]
  if (lengthM <= pts[3]![0]) return 0.5
  for (let i = 0; i < 3; i++) {
    const [la, fa] = pts[i]!, [lb, fb] = pts[i + 1]!
    if (lengthM <= la && lengthM >= lb) {
      const t = Math.log(la / lengthM) / Math.log(la / lb)
      return fa + (fb - fa) * t
    }
  }
  return 0.25
}

/** The depth (m) of full height for a wavelength: min(40 m, 0.08 L) (§8.5). */
export function attenuationDepth(lengthM: number): number {
  return Math.min(40, 0.08 * lengthM)
}

/** The shallow-water scale of a wave or cascade at a depth (the shaders' `sroOcAtten`, before the join fade). */
export function shallowScale(depthM: number, d0: number, floor: number): number {
  const ss = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  const lo = floor * ss(0, 0.6, depthM)
  return lo + (1 - lo) * ss(0, d0, depthM)
}

/** The three waves of a spectrum's systems (wind sea = systems[0], swell = systems[1]). */
export function gerstnerSet(p: SpectrumParams): GerstnerWave[] {
  const out: GerstnerWave[] = []
  const hsOf = (i: number) => {
    const s = p.systems[i]
    return s ? 4 * Math.sqrt(Math.max(0, s.scale * systemVariance(s.windMs, s.fetchM, p.depthM))) : 0
  }
  const hsWind = hsOf(0), hsSwell = hsOf(1)
  const total = Math.hypot(hsWind, hsSwell)
  const clamp = total > p.hsMaxM ? p.hsMaxM / total : 1
  const wave = (sysIndex: number, lengthScale: number, angle: number, share: number, hs: number, phase: number) => {
    const sys = p.systems[sysIndex]
    if (!sys) return
    const { omegaP } = jonswapPeak(sys.windMs, sys.fetchM)
    // The deep-water wavelength at the peak, scaled.
    const k = (omegaP * omegaP) / GRAVITY / lengthScale
    const amp = (hs * clamp * share) / (2 * Math.SQRT2)
    const dir = sys.dirRad + angle
    const length = (2 * Math.PI) / k
    out.push({
      dirX: Math.cos(dir), dirZ: Math.sin(dir), k, omega: roundOmega(dispersion(k, p.depthM)), amp,
      q: amp > 0 ? Math.min(1, 0.6 / 3 / (k * amp)) : 0, phase, d0: attenuationDepth(length), floor: attenuationFloor(length),
    })
  }
  wave(1, 1, 0, 1, hsSwell, 0.3)
  wave(0, 1, 0, 0.8, hsWind, 1.7)
  wave(0, 0.5, (25 * Math.PI) / 180, 0.6, hsWind, 4.1)
  return out
}

/** Hs of a Gerstner set (m): 4 √(Σ a² / 2). */
export function gerstnerHs(waves: readonly GerstnerWave[]): number {
  return 4 * Math.sqrt(waves.reduce((s, w) => s + (w.amp * w.amp) / 2, 0))
}

/** The Gerstner surface in TS (the Classic shader's formula; the CPU query on Low): displacement at rest (x, z). */
export function gerstnerAt(waves: readonly GerstnerWave[], x: number, z: number, t: number, depthM = Infinity): { dx: number; dy: number; dz: number } {
  let dx = 0, dy = 0, dz = 0
  for (const w of waves) {
    const a = w.amp * shallowScale(depthM, w.d0, w.floor)
    const th = w.k * (w.dirX * x + w.dirZ * z) - w.omega * t + w.phase
    dy += a * Math.sin(th)
    const c = w.q * a * Math.cos(th)
    dx += c * w.dirX
    dz += c * w.dirZ
  }
  return { dx, dy, dz }
}


/**
 * The atmosphere on the CPU (docs/SKY.md §3; Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere"):
 * the transmittance LUT (Bruneton's horizon mapping, so the sun colour stays monotonic below 1° elevation), the
 * multiple-scattering LUT (ψ_ms) and the sky-view LUT, one row at a time so SkyLuts can slice every rebuild over
 * frames. Pure maths, no Babylon: vitest runs it as it is. Ported from work/tmp/sky/atmosphere-proto.ts, with the
 * planet shadow in the multiple scattering (Hillaire's) and bilinear ψ_ms lookups.
 *
 * Units: kilometres; radiance and irradiance in units of the sun's illuminance at the top of the atmosphere (1).
 * Frames: the sky-view LUT is relative to the light: u = azimuth from the light's azimuth 0..π (the sky is mirrored
 * about the light's vertical plane), v = elevation with Hillaire's quadratic packing (0.5 = the horizon).
 */

type V3 = [number, number, number]

/** Earth: ground and top radius (km). */
export const R_GROUND = 6360
export const R_TOP = 6460
/** The LUT camera height (km): the terrain is under 0.3 km, so one fixed height serves the whole world. */
export const CAMERA_KM = 0.5
const RAY_S: V3 = [5.802e-3, 13.558e-3, 33.1e-3]
const RAY_H = 8
const MIE_S = 3.996e-3
const MIE_E = 4.4e-3
const MIE_H = 1.2
const MIE_G = 0.8
const OZO_A: V3 = [0.65e-3, 1.881e-3, 0.085e-3]
/** H = √(top² − ground²): the distance to the top along the ground's horizon (Bruneton). */
const H_TOP = Math.sqrt(R_TOP * R_TOP - R_GROUND * R_GROUND)

export const TRANS_W = 64
export const TRANS_H = 32
export const MS_SIZE = 16
/** The sky-view march is capped here (km): past it the ray is nearly all ground haze at the horizon. */
const MAX_MARCH_KM = 400

/** Weather haze 0..1 → the Mie density scale 1..8 (SKY §3.1). */
export function mieScaleFor(haze: number): number {
  const h = Math.min(1, Math.max(0, haze))
  return 1 + 7 * h * h
}

/** Distance (km) from radius r along cosine mu to the top of the atmosphere. */
export function rayTop(r: number, mu: number): number {
  const disc = r * r * (mu * mu - 1) + R_TOP * R_TOP
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc)))
}

/** Distance (km) to the ground, or −1 when the ray misses it. */
export function rayGround(r: number, mu: number): number {
  const disc = r * r * (mu * mu - 1) + R_GROUND * R_GROUND
  if (mu >= 0 || disc < 0) return -1
  return -r * mu - Math.sqrt(disc)
}

/** Sky-view v (0..1) → elevation (rad): quadratic toward the horizon (v 0.5). */
export function vToElevation(v: number): number {
  const c = v * 2 - 1
  return Math.sign(c) * c * c * (Math.PI / 2)
}

/** Elevation (rad) → sky-view v (the inverse of vToElevation; the dome shader does the same). */
export function elevationToV(el: number): number {
  return 0.5 + 0.5 * Math.sign(el) * Math.sqrt(Math.min(1, Math.abs(el) / (Math.PI / 2)))
}

// ---- transmittance: Bruneton's (x_mu, x_r) mapping --------------------------------------------------------------

/** Transmittance LUT coordinates of (r, mu) in texel units (fractional x, y). */
function transTexel(r: number, mu: number): [number, number] {
  const rho = Math.sqrt(Math.max(0, r * r - R_GROUND * R_GROUND))
  const d = rayTop(r, mu)
  const dMin = R_TOP - r
  const dMax = rho + H_TOP
  const xMu = dMax > dMin ? (d - dMin) / (dMax - dMin) : 0
  const xR = rho / H_TOP
  return [Math.min(1, Math.max(0, xMu)) * (TRANS_W - 1), Math.min(1, Math.max(0, xR)) * (TRANS_H - 1)]
}

/** (r, mu) of a transmittance texel (x, y). */
function transParams(x: number, y: number): [number, number] {
  const xMu = x / (TRANS_W - 1)
  const xR = y / (TRANS_H - 1)
  const rho = H_TOP * xR
  const r = Math.sqrt(rho * rho + R_GROUND * R_GROUND)
  const dMin = R_TOP - r
  const dMax = rho + H_TOP
  const d = dMin + xMu * (dMax - dMin)
  const mu = d === 0 ? 1 : (H_TOP * H_TOP - rho * rho - d * d) / (2 * r * d)
  return [r, Math.min(1, Math.max(-1, mu))]
}

/** Optical depth (per channel) from radius r along mu to the top, `n` midpoint samples. */
export function opticalDepth(r: number, mu: number, mieScale: number, n = 40, out: V3 = [0, 0, 0]): V3 {
  const dist = rayTop(r, mu)
  const dt = dist / n
  out[0] = out[1] = out[2] = 0
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * dt
    const h = Math.sqrt(r * r + t * t + 2 * r * t * mu) - R_GROUND
    const dr = Math.exp(-h / RAY_H)
    const dm = Math.exp(-h / MIE_H) * mieScale
    const dO = Math.max(0, 1 - Math.abs(h - 25) / 15)
    out[0] += (RAY_S[0] * dr + MIE_E * dm + OZO_A[0] * dO) * dt
    out[1] += (RAY_S[1] * dr + MIE_E * dm + OZO_A[1] * dO) * dt
    out[2] += (RAY_S[2] * dr + MIE_E * dm + OZO_A[2] * dO) * dt
  }
  return out
}

/** One row (xR) of the transmittance LUT into `lut` (RGB f32). */
export function transmittanceRow(lut: Float32Array, y: number, mieScale: number): void {
  const od: V3 = [0, 0, 0]
  for (let x = 0; x < TRANS_W; x++) {
    const [r, mu] = transParams(x, y)
    opticalDepth(r, mu, mieScale, 40, od)
    const o = (y * TRANS_W + x) * 3
    lut[o] = Math.exp(-od[0])
    lut[o + 1] = Math.exp(-od[1])
    lut[o + 2] = Math.exp(-od[2])
  }
}

/** Bilinear transmittance lookup (to the top of the atmosphere). */
export function sampleTransmittance(lut: Float32Array, r: number, mu: number, out: V3): V3 {
  const [fx, fy] = transTexel(r, mu)
  const x0 = Math.min(TRANS_W - 2, fx | 0)
  const y0 = Math.min(TRANS_H - 2, fy | 0)
  const ax = fx - x0
  const ay = fy - y0
  for (let c = 0; c < 3; c++) {
    const a = lut[(y0 * TRANS_W + x0) * 3 + c]!
    const b = lut[(y0 * TRANS_W + x0 + 1) * 3 + c]!
    const cc = lut[((y0 + 1) * TRANS_W + x0) * 3 + c]!
    const d = lut[((y0 + 1) * TRANS_W + x0 + 1) * 3 + c]!
    out[c] = (a + (b - a) * ax) * (1 - ay) + (cc + (d - cc) * ax) * ay
  }
  return out
}

// ---- multiple scattering (ψ_ms) --------------------------------------------------------------------------------

const MS_DIRS = 32
const MS_STEPS = 16
const FIB: Float32Array = (() => {
  const d = new Float32Array(MS_DIRS * 3)
  for (let i = 0; i < MS_DIRS; i++) {
    const y = 1 - (2 * (i + 0.5)) / MS_DIRS
    const rr = Math.sqrt(1 - y * y)
    const phi = i * 2.399963
    d[i * 3] = Math.cos(phi) * rr
    d[i * 3 + 1] = y
    d[i * 3 + 2] = Math.sin(phi) * rr
  }
  return d
})()

/** Columns [x0, x1) of one row (height) of the ψ_ms LUT; needs the whole transmittance LUT. */
export function multiScatterRow(lut: Float32Array, y: number, trans: Float32Array, mieScale: number, x0 = 0, x1 = MS_SIZE): void {
  const r = R_GROUND + ((y + 0.5) / MS_SIZE) * (R_TOP - R_GROUND)
  const tmp: V3 = [0, 0, 0]
  for (let x = x0; x < x1; x++) {
    const muS = ((x + 0.5) / MS_SIZE) * 2 - 1
    const sx = Math.sqrt(1 - muS * muS)
    const sy = muS
    let l0 = 0, l1 = 0, l2 = 0, f0 = 0, f1 = 0, f2 = 0
    for (let k = 0; k < MS_DIRS; k++) {
      const dx = FIB[k * 3]!, dy = FIB[k * 3 + 1]!, dz = FIB[k * 3 + 2]!
      const gnd = rayGround(r, dy)
      const dist = gnd > 0 ? gnd : rayTop(r, dy)
      const dt = dist / MS_STEPS
      let t0 = 1, t1 = 1, t2 = 1
      for (let i = 0; i < MS_STEPS; i++) {
        const t = (i + 0.5) * dt
        const px = dx * t, py = r + dy * t, pz = dz * t
        const pr = Math.sqrt(px * px + py * py + pz * pz)
        const h = pr - R_GROUND
        const dr = Math.exp(-h / RAY_H)
        const dm = Math.exp(-h / MIE_H) * mieScale
        const dO = Math.max(0, 1 - Math.abs(h - 25) / 15)
        const smu = (px * sx + py * sy) / pr
        const lit = rayGround(pr, smu) > 0 ? 0 : 1
        sampleTransmittance(trans, pr, smu, tmp)
        const sM = MIE_S * dm
        // Per channel: in-scattered single light (isotropic phase 1/4π) and the transfer factor f_ms.
        let sR = RAY_S[0] * dr, e = sR + MIE_E * dm + OZO_A[0] * dO, st = Math.exp(-e * dt), g = (1 - st) / Math.max(e, 1e-9)
        l0 += (t0 * (sR + sM) * tmp[0] * lit * g) / (4 * Math.PI) / MS_DIRS
        f0 += (t0 * (sR + sM) * g) / MS_DIRS
        t0 *= st
        sR = RAY_S[1] * dr; e = sR + MIE_E * dm + OZO_A[1] * dO; st = Math.exp(-e * dt); g = (1 - st) / Math.max(e, 1e-9)
        l1 += (t1 * (sR + sM) * tmp[1] * lit * g) / (4 * Math.PI) / MS_DIRS
        f1 += (t1 * (sR + sM) * g) / MS_DIRS
        t1 *= st
        sR = RAY_S[2] * dr; e = sR + MIE_E * dm + OZO_A[2] * dO; st = Math.exp(-e * dt); g = (1 - st) / Math.max(e, 1e-9)
        l2 += (t2 * (sR + sM) * tmp[2] * lit * g) / (4 * Math.PI) / MS_DIRS
        f2 += (t2 * (sR + sM) * g) / MS_DIRS
        t2 *= st
      }
    }
    const o = (y * MS_SIZE + x) * 3
    lut[o] = l0 / (1 - Math.min(0.99, f0))
    lut[o + 1] = l1 / (1 - Math.min(0.99, f1))
    lut[o + 2] = l2 / (1 - Math.min(0.99, f2))
  }
}

/** Bilinear ψ_ms lookup. */
export function sampleMultiScatter(lut: Float32Array, r: number, muS: number, out: V3): V3 {
  const fx = Math.min(MS_SIZE - 1, Math.max(0, (muS * 0.5 + 0.5) * MS_SIZE - 0.5))
  const fy = Math.min(MS_SIZE - 1, Math.max(0, ((r - R_GROUND) / (R_TOP - R_GROUND)) * MS_SIZE - 0.5))
  const x0 = Math.min(MS_SIZE - 2, fx | 0)
  const y0 = Math.min(MS_SIZE - 2, fy | 0)
  const ax = fx - x0
  const ay = fy - y0
  for (let c = 0; c < 3; c++) {
    const a = lut[(y0 * MS_SIZE + x0) * 3 + c]!
    const b = lut[(y0 * MS_SIZE + x0 + 1) * 3 + c]!
    const cc = lut[((y0 + 1) * MS_SIZE + x0) * 3 + c]!
    const d = lut[((y0 + 1) * MS_SIZE + x0 + 1) * 3 + c]!
    out[c] = (a + (b - a) * ax) * (1 - ay) + (cc + (d - cc) * ax) * ay
  }
  return out
}

// ---- the atmosphere (transmittance + ψ_ms), built whole or row by row --------------------------------------------

export class Atmosphere {
  readonly transmittance = new Float32Array(TRANS_W * TRANS_H * 3)
  readonly multiScatter = new Float32Array(MS_SIZE * MS_SIZE * 3)

  private constructor(readonly mieScale: number) {}

  /** The whole build (~35–40 ms on the dev PC; tests and the first frame). */
  static build(mieScale = 1): Atmosphere {
    const a = new Atmosphere(mieScale)
    const it = a.rows()
    while (!it.next().done) {
      // every row
    }
    return a
  }

  /**
   * The build in 40 steps of ~1 ms on the dev PC (8 × 4 transmittance rows, then 32 half rows of ψ_ms): SkySystem runs
   * one step per frame while the old atmosphere stays live (SKY §3.5, the haze rebuild budget).
   */
  static *sliced(mieScale: number): Generator<void, Atmosphere> {
    const a = new Atmosphere(mieScale)
    yield* a.rows()
    return a
  }

  private *rows(): Generator<void, void> {
    for (let y = 0; y < TRANS_H; y++) {
      transmittanceRow(this.transmittance, y, this.mieScale)
      if ((y & 3) === 3) yield
    }
    const half = MS_SIZE >> 1
    for (let y = 0; y < MS_SIZE; y++) {
      multiScatterRow(this.multiScatter, y, this.transmittance, this.mieScale, 0, half)
      yield
      multiScatterRow(this.multiScatter, y, this.transmittance, this.mieScale, half, MS_SIZE)
      yield
    }
  }

  /** Transmittance from radius r (km) toward elevation `el` (rad), 0 inside the planet's shadow (soft over ±0.25°). */
  sunTransmittance(el: number, altKm = CAMERA_KM, out: V3 = [0, 0, 0]): V3 {
    const r = R_GROUND + altKm
    sampleTransmittance(this.transmittance, r, Math.sin(el), out)
    // The horizon dips below 0° with altitude: acos(ground / r).
    const dip = -Math.acos(Math.min(1, R_GROUND / r))
    const k = smoothstep(dip - 0.0044, dip + 0.0044, el)
    out[0] *= k
    out[1] *= k
    out[2] *= k
    return out
  }

  /**
   * Rows [from, to) of a W × H sky-view LUT for a light at elevation `lightEl` (rad) into `out` (RGB f32, W × H × 3),
   * with `steps` march steps. Allocation-free except two small tuples.
   */
  skyViewRows(out: Float32Array, W: number, H: number, lightEl: number, steps: number, from: number, to: number): void {
    const T = this.transmittance
    const MS = this.multiScatter
    const mieScale = this.mieScale
    const r = R_GROUND + CAMERA_KM
    const sx = Math.cos(lightEl)
    const sy = Math.sin(lightEl)
    const tmp: V3 = [0, 0, 0]
    const ms: V3 = [0, 0, 0]
    const g2 = MIE_G * MIE_G
    for (let y = from; y < to; y++) {
      const el = vToElevation((y + 0.5) / H)
      const ce = Math.cos(el)
      const se = Math.sin(el)
      for (let x = 0; x < W; x++) {
        const az = ((x + 0.5) / W) * Math.PI
        const dx = ce * Math.cos(az), dy = se, dz = ce * Math.sin(az)
        const gnd = rayGround(r, dy)
        const dist = Math.min(gnd > 0 ? gnd : rayTop(r, dy), MAX_MARCH_KM)
        const nu = dx * sx + dy * sy
        const pR = (3 / (16 * Math.PI)) * (1 + nu * nu)
        const pM = ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + nu * nu))) / ((2 + g2) * Math.pow(1 + g2 - 2 * MIE_G * nu, 1.5))
        let L0 = 0, L1 = 0, L2 = 0, t0 = 1, t1 = 1, t2 = 1, tPrev = 0
        for (let i = 0; i < steps; i++) {
          const q = (i + 0.3) / steps
          const t = dist * q * q // denser near the camera
          const dt = t - tPrev
          tPrev = t
          const px = dx * t, py = r + dy * t, pz = dz * t
          const pr = Math.sqrt(px * px + py * py + pz * pz)
          const hh = pr - R_GROUND
          const dr = Math.exp(-hh / RAY_H)
          const dm = Math.exp(-hh / MIE_H) * mieScale
          const dO = Math.max(0, 1 - Math.abs(hh - 25) / 15)
          const smu = (px * sx + py * sy) / pr
          sampleTransmittance(T, pr, smu, tmp)
          const sh = rayGround(pr, smu) > 0 ? 0 : 1
          sampleMultiScatter(MS, pr, smu, ms)
          const sM = MIE_S * dm
          let sR = RAY_S[0] * dr, e = sR + MIE_E * dm + OZO_A[0] * dO, st = Math.exp(-e * dt)
          L0 += (t0 * (sh * tmp[0] * (sR * pR + sM * pM) + ms[0] * (sR + sM)) * (1 - st)) / e
          t0 *= st
          sR = RAY_S[1] * dr; e = sR + MIE_E * dm + OZO_A[1] * dO; st = Math.exp(-e * dt)
          L1 += (t1 * (sh * tmp[1] * (sR * pR + sM * pM) + ms[1] * (sR + sM)) * (1 - st)) / e
          t1 *= st
          sR = RAY_S[2] * dr; e = sR + MIE_E * dm + OZO_A[2] * dO; st = Math.exp(-e * dt)
          L2 += (t2 * (sh * tmp[2] * (sR * pR + sM * pM) + ms[2] * (sR + sM)) * (1 - st)) / e
          t2 *= st
        }
        const o = (y * W + x) * 3
        out[o] = L0
        out[o + 1] = L1
        out[o + 2] = L2
      }
    }
  }

  /** A whole sky-view LUT (tests, and the first frame after a time jump). */
  skyView(W: number, H: number, lightEl: number, steps: number, out = new Float32Array(W * H * 3)): Float32Array {
    this.skyViewRows(out, W, H, lightEl, steps, 0, H)
    return out
  }
}

// ---- reading a sky-view LUT ------------------------------------------------------------------------------------

/**
 * Bilinear radiance of a sky-view LUT (RGB f32) at relative azimuth `az` (rad, 0..π) and elevation `el` (rad), the
 * same lookup the dome shader does.
 */
export function sampleSkyView(lut: Float32Array, W: number, H: number, az: number, el: number, out: V3): V3 {
  const fx = Math.min(W - 1, Math.max(0, (Math.min(Math.PI, Math.abs(az)) / Math.PI) * W - 0.5))
  const fy = Math.min(H - 1, Math.max(0, elevationToV(el) * H - 0.5))
  const x0 = Math.min(W - 2, fx | 0)
  const y0 = Math.min(H - 2, fy | 0)
  const ax = fx - x0
  const ay = fy - y0
  for (let c = 0; c < 3; c++) {
    const a = lut[(y0 * W + x0) * 3 + c]!
    const b = lut[(y0 * W + x0 + 1) * 3 + c]!
    const cc = lut[((y0 + 1) * W + x0) * 3 + c]!
    const d = lut[((y0 + 1) * W + x0 + 1) * 3 + c]!
    out[c] = (a + (b - a) * ax) * (1 - ay) + (cc + (d - cc) * ax) * ay
  }
  return out
}

/**
 * Sky irradiance onto an up-facing surface (cosine-weighted integral of the LUT's upper half, both mirrored halves),
 * in units of the light's illuminance (SKY §3.4: noon ≈ (0.021, 0.044, 0.104)).
 */
export function skyIrradianceUp(lut: Float32Array, W: number, H: number, out: V3 = [0, 0, 0]): V3 {
  out[0] = out[1] = out[2] = 0
  for (let y = H >> 1; y < H; y++) {
    const el0 = vToElevation(y / H)
    const el1 = vToElevation((y + 1) / H)
    const el = vToElevation((y + 0.5) / H)
    const w = (Math.sin(el1) - Math.sin(el0)) * ((Math.PI / W) * 2) * Math.max(0, Math.sin(el))
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3
      out[0] += lut[o]! * w
      out[1] += lut[o + 1]! * w
      out[2] += lut[o + 2]! * w
    }
  }
  return out
}

export const luminance = (c: Readonly<V3>): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

function smoothstep(e0: number, e1: number, x: number): number {
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return k * k * (3 - 2 * k)
}

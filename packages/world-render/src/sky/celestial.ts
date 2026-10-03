/**
 * The celestial bodies from the world clock (docs/SKY.md §2.1, §4.2, §6.4): sun and moon directions (the shared
 * world-clock.ts maths: no second sun model), the moon's tangent frame on the dome, the star rotation about the
 * celestial pole, and the retail palette's time remap. Pure.
 */
import { JANGAN_LATITUDE, moonState, moonVisible, sunDirection, sunriseSunset } from '../../../shared/src/world-clock.ts'

type V3 = [number, number, number]

const DEG = Math.PI / 180
const TAU = Math.PI * 2
/** Sidereal days per solar day (SKY §2.1). */
const SIDEREAL = 1.0027

/** Sun direction (glTF, to the sun) at solar time t and declination `decl` (degrees). */
export function sunDir(t: number, decl: number, out: V3 = [0, 0, 0]): V3 {
  const d = sunDirection(t, decl, JANGAN_LATITUDE)
  out[0] = d[0]
  out[1] = d[1]
  out[2] = d[2]
  return out
}

/**
 * The moon at `days` (fractional clock days) and solar time t: its hour angle trails the sun's by 2π · age / 29.53
 * (the full moon rises at sunset), same declination; hidden within 0.75 day of new moon.
 */
export function moonAt(days: number, t: number, decl: number, out: V3 = [0, 0, 0]) {
  const m = moonState(days)
  const d = sunDirection(t - m.hourOffset, decl, JANGAN_LATITUDE)
  out[0] = d[0]
  out[1] = d[1]
  out[2] = d[2]
  return { dir: out, age: m.age, illum: m.illum, texture: m.texture, visible: moonVisible(m.age) }
}

/** Elevation (rad) of a unit direction. */
export const elevationOf = (d: Readonly<V3>): number => Math.asin(Math.max(-1, Math.min(1, d[1])))

/**
 * The retail palette's time (SKY §6.4): the keyframes assume sunrise 0.25 and sunset 0.75, ours move with the season,
 * so [0, rise] → [0, 0.25], [rise, set] → [0.25, 0.75], [set, 1] → [0.75, 1].
 */
export function paletteTime(t: number, decl: number): number {
  const { rise, set } = sunriseSunset(decl, JANGAN_LATITUDE)
  const x = ((t % 1) + 1) % 1
  if (!(set > rise + 1e-3) || rise <= 1e-3 || set >= 1 - 1e-3) return x
  if (x < rise) return (x / rise) * 0.25
  if (x < set) return 0.25 + ((x - rise) / (set - rise)) * 0.5
  return 0.75 + ((x - set) / (1 - set)) * 0.25
}

/**
 * Rows of the matrix taking a world direction to star space: the sky turns about the celestial pole (elevation =
 * latitude, toward north = glTF −Z) by the sidereal angle 2π ((day + t) · 1.0027). Three rows of 3 into `out` (9).
 */
export function starRotation(t: number, day: number, out: Float32Array = new Float32Array(9)): Float32Array {
  const phi = JANGAN_LATITUDE * DEG
  // Pole axis (to the north celestial pole).
  const ax = 0, ay = Math.sin(phi), az = -Math.cos(phi)
  // Continuous in (day + t): at midnight t drops by 1 while day rises by 1, so the stars do not tick.
  const a = -TAU * (((day + t) * SIDEREAL) % 1)
  const c = Math.cos(a), s = Math.sin(a), k = 1 - c
  // Rodrigues rotation about (ax, ay, az) by a.
  out[0] = c + ax * ax * k
  out[1] = ax * ay * k - az * s
  out[2] = ax * az * k + ay * s
  out[3] = ay * ax * k + az * s
  out[4] = c + ay * ay * k
  out[5] = ay * az * k - ax * s
  out[6] = az * ax * k - ay * s
  out[7] = az * ay * k + ax * s
  out[8] = c + az * az * k
  return out
}

/**
 * The moon's tangent frame on the dome (SKY §4.2 step 3): `u` points to the lit limb of a waxing moon (the retail
 * moon01..15 are lit on the right) and away from it once it wanes (moon17..30 are lit on the left), so the lit side
 * always faces the sun; `v` completes the frame. Falls back to the horizon's right near full and new moon.
 */
export function moonFrame(moon: Readonly<V3>, sun: Readonly<V3>, age: number, u: V3 = [0, 0, 0], v: V3 = [0, 0, 0]): { u: V3; v: V3 } {
  const md = moon[0] * sun[0] + moon[1] * sun[1] + moon[2] * sun[2]
  let tx = sun[0] - moon[0] * md, ty = sun[1] - moon[1] * md, tz = sun[2] - moon[2] * md
  let tl = Math.hypot(tx, ty, tz)
  // right = normalize(cross(moon, up)) with up = +Y: (−moon.z, 0, moon.x).
  let rx = -moon[2], rz = moon[0]
  const rl = Math.hypot(rx, rz) || 1
  rx /= rl
  rz /= rl
  const blend = Math.min(1, Math.max(0, (tl - 0.05) / 0.1))
  if (tl > 1e-6) {
    const sgn = age < 14.765 ? 1 : -1
    tx = (tx / tl) * sgn
    ty = (ty / tl) * sgn
    tz = (tz / tl) * sgn
  } else {
    tx = rx
    ty = 0
    tz = rz
  }
  u[0] = tx * blend + rx * (1 - blend)
  u[1] = ty * blend
  u[2] = tz * blend + rz * (1 - blend)
  tl = Math.hypot(u[0], u[1], u[2]) || 1
  u[0] /= tl
  u[1] /= tl
  u[2] /= tl
  // v = cross(u, moon)
  v[0] = u[1] * moon[2] - u[2] * moon[1]
  v[1] = u[2] * moon[0] - u[0] * moon[2]
  v[2] = u[0] * moon[1] - u[1] * moon[0]
  const vl = Math.hypot(v[0], v[1], v[2]) || 1
  v[0] /= vl
  v[1] /= vl
  v[2] /= vl
  return { u, v }
}

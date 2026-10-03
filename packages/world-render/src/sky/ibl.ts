/**
 * The sky as image-based light (docs/WAVE_PLAN3.md D14, docs/SKY.md §3.4, §6.3): SKY-B produces the data, RND-L owns
 * the texture. Pure: a cube of radiance faces from any radiance function (`fillSkyCube`), its L1 spherical harmonics
 * (`skySH`) and the irradiance they give (`shIrradiance`), plus the horizon ring (fog colour by azimuth). SkySystem
 * hands its current sky in as a `SkyRadiance` (sky-view LUTs + clouds + ground bounce).
 *
 * Cube faces: Babylon's order +X, −X, +Y, −Y, +Z, −Z; texel (i, j) of a face (i right, j down) looks along the GL
 * cube-map convention in the scene's world axes: +X (1, −v, −u), −X (−1, −v, u), +Y (u, 1, v), −Y (u, −1, −v),
 * +Z (u, −v, 1), −Z (−u, −v, −1), with u, v = 2 (i, j + 0.5) / size − 1. RGBA float32, alpha 1.
 */

export type RGB3 = [number, number, number]

/** Linear radiance arriving from world direction (x, y, z) (unit), written to `out`. */
export type SkyRadiance = (x: number, y: number, z: number, out: RGB3) => RGB3

/** The direction of cube texel (u, v) of face f (see the header). */
export function cubeDir(f: number, u: number, v: number, out: RGB3): RGB3 {
  let x: number, y: number, z: number
  switch (f) {
    case 0: x = 1; y = -v; z = -u; break
    case 1: x = -1; y = -v; z = u; break
    case 2: x = u; y = 1; z = v; break
    case 3: x = u; y = -1; z = -v; break
    case 4: x = u; y = -v; z = 1; break
    default: x = -u; y = -v; z = -1; break
  }
  const l = Math.hypot(x, y, z)
  out[0] = x / l
  out[1] = y / l
  out[2] = z / l
  return out
}

/** Solid angle of cube texel (i, j) of a size² face. */
function texelSolidAngle(i: number, j: number, size: number): number {
  const a = (x: number, y: number) => Math.atan2(x * y, Math.sqrt(x * x + y * y + 1))
  const x0 = (2 * i) / size - 1, x1 = (2 * (i + 1)) / size - 1
  const y0 = (2 * j) / size - 1, y1 = (2 * (j + 1)) / size - 1
  return a(x0, y0) - a(x0, y1) - a(x1, y0) + a(x1, y1)
}

/** Six RGBA float faces (size² each) of `radiance` (D14: 32² on Medium, 64² on High/Ultra). */
export function fillSkyCube(radiance: SkyRadiance, size: number): Float32Array[] {
  const faces: Float32Array[] = []
  const d: RGB3 = [0, 0, 0]
  const c: RGB3 = [0, 0, 0]
  for (let f = 0; f < 6; f++) {
    const face = new Float32Array(size * size * 4)
    for (let j = 0; j < size; j++) {
      const v = (2 * (j + 0.5)) / size - 1
      for (let i = 0; i < size; i++) {
        const u = (2 * (i + 0.5)) / size - 1
        cubeDir(f, u, v, d)
        radiance(d[0], d[1], d[2], c)
        const o = (j * size + i) * 4
        face[o] = c[0]
        face[o + 1] = c[1]
        face[o + 2] = c[2]
        face[o + 3] = 1
      }
    }
    faces.push(face)
  }
  return faces
}

const Y0 = 0.282095
const Y1 = 0.488603

/**
 * L1 SH projection of `radiance` over the whole sphere (cube-texel quadrature with exact solid angles, `size`² per
 * face): 12 floats, [L00, L1−1 (y), L10 (z), L11 (x)] × RGB.
 */
export function skySH(radiance: SkyRadiance, size = 12): Float32Array {
  const sh = new Float32Array(12)
  const d: RGB3 = [0, 0, 0]
  const c: RGB3 = [0, 0, 0]
  for (let f = 0; f < 6; f++) {
    for (let j = 0; j < size; j++) {
      const v = (2 * (j + 0.5)) / size - 1
      for (let i = 0; i < size; i++) {
        const u = (2 * (i + 0.5)) / size - 1
        cubeDir(f, u, v, d)
        radiance(d[0], d[1], d[2], c)
        const w = texelSolidAngle(i, j, size)
        const b0 = Y0 * w, by = Y1 * d[1] * w, bz = Y1 * d[2] * w, bx = Y1 * d[0] * w
        for (let k = 0; k < 3; k++) {
          sh[k] += c[k]! * b0
          sh[3 + k] += c[k]! * by
          sh[6 + k] += c[k]! * bz
          sh[9 + k] += c[k]! * bx
        }
      }
    }
  }
  return sh
}

/** Irradiance onto a surface with normal n from L1 SH (Ramamoorthi–Hanrahan: A0 = π, A1 = 2π/3). */
export function shIrradiance(sh: Float32Array, nx: number, ny: number, nz: number, out: RGB3 = [0, 0, 0]): RGB3 {
  const a0 = Math.PI * Y0
  const a1 = ((2 * Math.PI) / 3) * Y1
  for (let k = 0; k < 3; k++) {
    out[k] = Math.max(0, a0 * sh[k]! + a1 * (sh[3 + k]! * ny + sh[6 + k]! * nz + sh[9 + k]! * nx))
  }
  return out
}

/** RGBA float texels of a `width` × 1 ring: fog colour at world azimuth atan2(z, x) = 2π (i + 0.5) / width. */
export function fillHorizonRing(colorAt: (az: number, out: RGB3) => RGB3, width: number, out: Float32Array = new Float32Array(width * 4)): Float32Array {
  const c: RGB3 = [0, 0, 0]
  for (let i = 0; i < width; i++) {
    colorAt((2 * Math.PI * (i + 0.5)) / width, c)
    out[i * 4] = c[0]
    out[i * 4 + 1] = c[1]
    out[i * 4 + 2] = c[2]
    out[i * 4 + 3] = 1
  }
  return out
}

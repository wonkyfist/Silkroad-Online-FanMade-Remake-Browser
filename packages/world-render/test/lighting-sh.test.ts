/**
 * RND-L's sky ambient (docs/RENDER.md §4.2, docs/WAVE_PLAN3.md §6.12, D14): the L1 SH maths, and that the harmonics
 * handed to Babylon light a PBR surface exactly like Babylon's own cube → SH conversion of the same sky, with the
 * right-handed cube flip (REFLECTIONMAP_OPPOSITEZ). A constant sky gives irradiance π × L within 1 %; a sky black
 * below the horizon gives nothing straight down; the level follows SkyState.ambient.
 */
import { Constants, CubeMapToSphericalPolynomialTools, SphericalPolynomial, Vector3 } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import type { RGB } from '../src/environment.ts'
import {
  CUBE_FACES,
  SH_L1_FLOATS,
  addConstantSH,
  ambientToSH,
  cubeTexelDir,
  shIrradiance,
  shToPolynomial,
  skyStateSH,
} from '../src/render/lighting.ts'
import type { SkyState } from '../src/sky/types.ts'

const Y00 = 0.28209479177387814
const Y1 = 0.4886025119029199

/** The PBR shader's SPHERICAL_HARMONICS irradiance (harmonicsFunctions), × π: E at cube-space vector v. */
function shaderIrradiance(poly: SphericalPolynomial, v: Vector3): RGB {
  const h = poly.preScaledHarmonics
  const r = h.l00.clone()
    .add(h.l1_1.scale(v.y)).add(h.l10.scale(v.z)).add(h.l11.scale(v.x))
    .add(h.l2_2.scale(v.y * v.x)).add(h.l2_1.scale(v.y * v.z)).add(h.l20.scale(3 * v.z * v.z - 1))
    .add(h.l21.scale(v.z * v.x)).add(h.l22.scale(v.x * v.x - v.y * v.y))
  return [r.x * Math.PI, r.y * Math.PI, r.z * Math.PI]
}

/** The cube-space vector the shader looks up for world normal n (right-handed: z flipped). */
const lookup = (n: Vector3, flipZ: boolean) => new Vector3(n.x, n.y, flipZ ? -n.z : n.z)

/** Exact L1 SH of a constant radiance. */
function constantSH(rgb: RGB): Float32Array {
  const sh = new Float32Array(SH_L1_FLOATS)
  for (let c = 0; c < 3; c++) sh[c] = rgb[c]! * Y00 * 4 * Math.PI
  return sh
}

const NORMALS = [
  new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1),
  new Vector3(1, 1, 0).normalize(), new Vector3(-0.3, 0.5, 0.8).normalize(), new Vector3(0.6, -0.7, -0.2).normalize(),
]

describe('L1 sky SH', () => {
  it('a constant sky projects to irradiance π × L on every normal, within 1 %', () => {
    const L: RGB = [0.3, 0.5, 0.9]
    // Project numerically (like sky/ibl.ts skySH) and analytically; both must light every normal with π L.
    const numeric = new Float32Array(SH_L1_FLOATS)
    const size = 16
    const d: [number, number, number] = [0, 0, 0]
    for (let f = 0; f < 6; f++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      cubeTexelDir(f, x, y, size, false, d)
      const w = texelSolidAngle(x, y, size)
      for (let c = 0; c < 3; c++) {
        numeric[c] = numeric[c]! + L[c]! * Y00 * w
        numeric[3 + c] = numeric[3 + c]! + L[c]! * Y1 * d[1] * w
        numeric[6 + c] = numeric[6 + c]! + L[c]! * Y1 * d[2] * w
        numeric[9 + c] = numeric[9 + c]! + L[c]! * Y1 * d[0] * w
      }
    }
    for (const sh of [numeric, constantSH(L)]) {
      for (const n of NORMALS) {
        const e = shIrradiance(sh, n.x, n.y, n.z)
        for (let c = 0; c < 3; c++) expect(Math.abs(e[c]! - Math.PI * L[c]!) / (Math.PI * L[c]!)).toBeLessThan(0.01)
      }
      // Through Babylon's harmonics and the shader's formula, both handednesses.
      for (const flipZ of [false, true]) {
        const poly = shToPolynomial(sh, flipZ)
        for (const n of NORMALS) {
          const e = shaderIrradiance(poly, lookup(n, flipZ))
          for (let c = 0; c < 3; c++) expect(Math.abs(e[c]! - Math.PI * L[c]!) / (Math.PI * L[c]!)).toBeLessThan(0.01)
        }
      }
    }
  })

  it('a sky black below the horizon gives zero irradiance straight down, full irradiance straight up', () => {
    const L: RGB = [0.2, 0.4, 0.8]
    const sh = ambientToSH({ sky: L, horizon: L, ground: [0, 0, 0] })
    const down = shIrradiance(sh, 0, -1, 0)
    const up = shIrradiance(sh, 0, 1, 0)
    for (let c = 0; c < 3; c++) {
      expect(down[c]).toBeCloseTo(0, 6)
      expect(up[c]! / (Math.PI * L[c]!)).toBeCloseTo(1, 6)
    }
    const poly = shToPolynomial(sh, true)
    const e = shaderIrradiance(poly, lookup(new Vector3(0, -1, 0), true))
    for (let c = 0; c < 3; c++) expect(Math.abs(e[c]!)).toBeLessThan(1e-6)
    // A wall gets half: the upper hemisphere's cosine share.
    const wall = shIrradiance(sh, 1, 0, 0)
    for (let c = 0; c < 3; c++) expect(wall[c]! / (Math.PI * L[c]!)).toBeCloseTo(0.5, 6)
  })

  it('matches Babylon\'s own cube → SH conversion of the same sky (orientation, handedness, scale)', () => {
    // A linear sky L(w) = a + b·w is exactly L1: brighter toward +X and toward −Z (north), blue up.
    const a: RGB = [0.5, 0.6, 0.8]
    const b: [RGB, RGB, RGB] = [[0.2, 0.1, 0], [0.05, 0.1, 0.3], [-0.15, -0.1, -0.05]] // per axis x, y, z
    const radiance = (w: [number, number, number]): RGB => [0, 1, 2].map(c => a[c]! + b[0][c]! * w[0] + b[1][c]! * w[1] + b[2][c]! * w[2]) as RGB
    const k = (4 * Math.PI) / 3 * Y1
    const sh = new Float32Array(SH_L1_FLOATS)
    for (let c = 0; c < 3; c++) {
      sh[c] = a[c]! * 4 * Math.PI * Y00
      sh[3 + c] = b[1][c]! * k
      sh[6 + c] = b[2][c]! * k
      sh[9 + c] = b[0][c]! * k
    }
    for (const flipZ of [false, true]) {
      // Faces as the GPU sees them: texel d shows world direction (d.x, d.y, ±d.z).
      const size = 24
      const faces: Float32Array[] = CUBE_FACES.map((_, f) => {
        const data = new Float32Array(size * size * 4)
        const d: [number, number, number] = [0, 0, 0]
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          cubeTexelDir(f, x, y, size, flipZ, d)
          const r = radiance(d)
          data.set([r[0], r[1], r[2], 1], (y * size + x) * 4)
        }
        return data
      })
      const theirs = CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial({
        size, right: faces[0]!, left: faces[1]!, up: faces[2]!, down: faces[3]!, front: faces[4]!, back: faces[5]!,
        format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_FLOAT, gammaSpace: false,
      })
      const ours = shToPolynomial(sh, flipZ)
      for (const n of NORMALS) {
        const v = lookup(n, flipZ)
        const et = shaderIrradiance(theirs, v)
        const eo = shaderIrradiance(ours, v)
        const expected = shIrradiance(sh, n.x, n.y, n.z)
        for (let c = 0; c < 3; c++) {
          // Babylon's projection carries small L2 terms from the texel quadrature; 2 % of the mean level.
          expect(Math.abs(eo[c]! - et[c]!)).toBeLessThan(0.02 * Math.PI * a[c]!)
          expect(eo[c]).toBeCloseTo(expected[c]!, 5)
        }
      }
    }
  })
})

describe('the ambient level (skyStateSH)', () => {
  const state = (ambient: SkyState['ambient'], sh: Float32Array | null = null) => ({ ambient, sh } as unknown as SkyState)

  it('scales each channel so an up-facing surface gets E / π = ambient.sky, keeping the shape', () => {
    const amb = { sky: [0.8, 0.7, 0.6] as RGB, horizon: [0.9, 0.95, 1] as RGB, ground: [0.2, 0.2, 0.15] as RGB }
    const sh = skyStateSH(state(amb))
    const up = shIrradiance(sh, 0, 1, 0)
    for (let c = 0; c < 3; c++) expect(up[c]! / Math.PI).toBeCloseTo(amb.sky[c]!, 5)
    const shape = ambientToSH(amb)
    const k = up[1]! / shIrradiance(shape, 0, 1, 0)[1]!
    expect(shIrradiance(sh, 1, 0, 0)[1]).toBeCloseTo(shIrradiance(shape, 1, 0, 0)[1]! * k, 5)
    // The sky's own SH gives the shape and the ambient the level; a near-black channel takes the hemisphere's shape.
    const own = ambientToSH({ sky: [0.1, 0.1, 0], horizon: [0.3, 0.2, 0], ground: [0, 0, 0] })
    const mixed = skyStateSH(state(amb, own))
    const e = shIrradiance(mixed, 0, 1, 0)
    for (let c = 0; c < 3; c++) expect(e[c]! / Math.PI).toBeCloseTo(amb.sky[c]!, 5)
    // Red keeps the sky's own shape (wall : up), blue (black in the sky's SH) the hemisphere's.
    const ratio = (s: Float32Array, c: number) => shIrradiance(s, 1, 0, 0)[c]! / shIrradiance(s, 0, 1, 0)[c]!
    expect(ratio(mixed, 0)).toBeCloseTo(ratio(own, 0), 5)
    expect(ratio(mixed, 2)).toBeCloseTo(ratio(ambientToSH(amb), 2), 5)
  })

  it('a flash adds a constant, sky-independent radiance (a night flash reads)', () => {
    const night = skyStateSH(state({ sky: [0.001, 0.001, 0.002], horizon: [0, 0, 0], ground: [0, 0, 0] }))
    const before = shIrradiance(night, 0, 1, 0)[1]!
    addConstantSH(night, [1, 1, 1], 0.5)
    // Every normal gets the flash (L1 lobes of the dim sky move it by < 1 %).
    for (const n of NORMALS) expect(shIrradiance(night, n.x, n.y, n.z)[1]).toBeGreaterThan(Math.PI * 0.5 * 0.99)
    expect(shIrradiance(night, 0, 1, 0)[1]! - before).toBeCloseTo(Math.PI * 0.5, 5)
  })
})

/** Solid angle of cube texel (x, y) of a size² face. */
function texelSolidAngle(x: number, y: number, size: number): number {
  const a = (u: number, v: number) => Math.atan2(u * v, Math.sqrt(u * u + v * v + 1))
  const u0 = (2 * x) / size - 1, u1 = (2 * (x + 1)) / size - 1
  const v0 = (2 * y) / size - 1, v1 = (2 * (y + 1)) / size - 1
  return a(u0, v0) - a(u0, v1) - a(u1, v0) + a(u1, v1)
}

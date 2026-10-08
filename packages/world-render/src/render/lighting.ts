/**
 * The PBR presets' light (docs/RENDER.md §4.1–4.2, docs/WAVE_PLAN3.md §6.12, D14, D16, D25): one celestial
 * DirectionalLight driven by `SkyState.keyLight` (the sun by day, the moon by night; no second sun model), the sky's
 * diffuse ambient as a SphericalPolynomial, and a CPU-built half-float sky cube for reflections. No ReflectionProbe
 * (~570 ms per refresh with 2,030 PBR materials, RENDER §11.2). Owned by RND-L; the Classic path (Low) never builds it.
 *
 * - **Light 0.** PBR plugins (RND-T/RND-M `CUSTOM_LIGHT0_COLOR`: baked sun visibility) scale light 0, so the celestial
 *   light must be first in every mesh's light list. A mesh lists `scene.lights` in order, and the game creates its
 *   character lights before the world, so "create it first" cannot hold on its own. The light takes
 *   `renderPriority = CELESTIAL_RENDER_PRIORITY`, which turns on `scene.requireLightSorting` and sorts it first
 *   (`LightConstants.CompareLightsPriority`; lights added later re-sort), and every existing mesh re-reads its list
 *   once. It is never disabled (a re-enabled light goes to the END of a mesh's list): a dark key light sits at
 *   intensity 0, so the light count, and every material's defines, never change.
 * - **Ambient.** The level is `SkyState.ambient` (the up-facing ambient the sky designed, boost included); the shape
 *   is `SkyState.sh` (L1 radiance SH, modern sky) or, without one, the ambient hemisphere (zenith, horizon, ground)
 *   projected to L1. Each channel is scaled so an up-facing surface gets E / π = ambient.sky. It becomes Babylon
 *   harmonics (L2 zero-padded) on one SphericalPolynomial that the cube carries, updated in place (a few µs).
 * - **Reflections** (`SkyEnvironment`, D14): one `RawCubeTexture` RGBA16F with a full mip chain, assigned to
 *   `scene.environmentTexture` once per preset. A refresh fills one face per frame, then the prefiltered mips one face
 *   per frame, then uploads every face and level in one frame (a cube is never half old, half new). The radiance is
 *   the sky's own (`SkySystem.radiance()`, SKY-B) or the retail gradient, scaled by `cube` so a mirror shows the dome.
 *   The world's cube is still read as sRGB (`WORLD_SKY_CUBE_DECODE`, the shipped look; see `SkyCubeDecode`), which
 *   darkens a dim sky's reflection well below that; the character screens' studio cube is read linear.
 * - **Lightning** (D25): the flash adds a cool, sky-independent ambient to the SH (a night flash has to read, and
 *   scaling `environmentIntensity` would only brighten a black sky) and a short cool fill on the celestial light.
 *
 * Calibration (`LIGHT_CALIBRATIONS`, RENDER §4.1): see the constant. Two regimes, because the sky's units differ: the
 * classic sky (and the pre-SKY-B skeleton) states the retail palette, the modern sky physical light in keyLight units.
 */
import {
  Constants,
  DirectionalLight,
  RawCubeTexture,
  SphericalHarmonics,
  SphericalPolynomial,
  Vector3,
  type AbstractEngine,
  type Camera,
  type InternalTexture,
  type Light,
  type Scene,
} from '@babylonjs/core'
import type { EnvValues, RGB } from '../environment.ts'
import type { SkyState, SkyStyle } from '../sky/types.ts'
import type { RenderPart } from './index.ts'
import type { RenderQuality } from './quality.ts'
import { CLEAR_RENDER_WEATHER, type RenderWeather } from './weather.ts'
import { LIGHT_LOOK } from './look.ts'

export const CELESTIAL_LIGHT_NAME = 'celestial'
/** Sorts the celestial light before every other light (the game's lights keep priority 0). */
export const CELESTIAL_RENDER_PRIORITY = 1000

/** Real SH basis constants, no Condon–Shortley phase: Y00, and Y1m / (y | z | x). */
const Y00 = 0.28209479177387814
const Y1 = 0.4886025119029199
/** Floats in an L1 RGB SH: [c00, c1−1 (y), c10 (z), c11 (x)] × RGB (the `SkyState.sh` layout, sky/ibl.ts skySH). */
export const SH_L1_FLOATS = 12

export const luminance = (c: Readonly<RGB>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
const toLinear = (c: number) => Math.pow(Math.max(0, c), 2.2)

// ---- calibration --------------------------------------------------------------------------------------------------

/** Which units the sky states: the retail palette (classic sky, the skeleton) or physical light (modern sky). */
export type LightRegime = 'classic' | 'modern'

/**
 * World-light calibration (RENDER §4.1 "k_render"), as Babylon's PBR applies it: a white Lambertian surface leaves
 * E / π from an irradiance E; the celestial light gives E = intensity × N·L; the environment E = π × (the SH's
 * E / π) × `scene.environmentIntensity`, where the SH is scaled so an up-facing surface has E / π = ambient.sky.
 */
export interface LightCalibration {
  /** Celestial intensity = keyLight.intensity × sun (keyLight.color keeps its own magnitude). */
  sun: number
  /** `scene.environmentIntensity` (irradiance and reflections). */
  env: number
  /** Cube radiance = the sky's radiance × cube, so a mirror shows the dome (cube = dome units per radiance / env). */
  cube: number
  /** Lightning at flash 1: ambient radiance added to the SH (about the clear-noon ambient, so a night flash reads). */
  flashAmbient: number
  /** Lightning at flash 1: celestial fill intensity (a quarter of the clear-noon key). */
  flashSun: number
}

/**
 * Tuned at a clear noon in Jangan (t 0.5, elevation 67.7°, profile 0) with `calibrateLight` to CALIBRATION_TARGET:
 * - direct : ambient on a horizontal surface = 5 : 1 (RENDER §4.1; the bench's crisp-shadow ratio);
 * - a white horizontal surface leaving 2.15 / exposure. Measured in the RND-L harness (WebGPU, High, Neutral tone
 *   mapping, RND-M's surface plugin, the plaza from the spawn): the Classic plaza shows 0.544 (sRGB mean), PBR at
 *   1.85 showed 0.499 and at 2.22 0.550, so 2.15 lands it on Classic (≈ 0.54). The PBR plaza reads a little cooler
 *   (the ambient hemisphere's cyan horizon); the grade (RND-P) owns warmth.
 * - classic: key 0.463 (Diffuse × 0.6), ambient.sky 0.791 (ObjectAmbient), exposure 1;
 * - modern (SKY-B, measured headless on its in-flight SkySystem, High): key 0.4315 (white × 0.43), ambient.sky lum
 *   0.080, exposure 7.73. `cube` uses the dome's 1 / (SKY_LDR_PER_LUT × AMBIENT_BOOST) = 1 / (0.492 × 2.5): radiance()
 *   carries AMBIENT_BOOST for the SH ambient, the dome does not (else a mirror shows 2.5× the dome: D1). SKY-B still
 *   tunes its sky: the gate re-derives `modern` after the merge (test/lighting-calibration.test.ts prints
 *   calibrateLight of the live state).
 */
export const LIGHT_CALIBRATIONS: Readonly<Record<LightRegime, Readonly<LightCalibration>>> = Object.freeze({
  classic: Object.freeze({ sun: 13.13, env: 0.4532, cube: 2.2064, flashAmbient: 0.7906, flashSun: 1.521 }),
  modern: Object.freeze({ sun: 1.826, env: 0.5818, cube: 1.3974, flashAmbient: 0.0796, flashSun: 0.1966 }),
})

/**
 * SkyState.exposure up to which a lightning flash adds its full light: the day range, storms included (a 14:00 storm
 * runs at ~8.8; SKY §6.5 noon ≈ 8).
 */
export const FLASH_FULL_EXPOSURE = 10

/**
 * The flash light's scale at an exposure (W9F readability R2). The flash is scene-linear light, and the post stack
 * multiplies the scene by the exposure (×3–8 at night against the day), so an unscaled night flash turned the navy
 * scene into a lit grey frame, and 'Reduce flashing' (the flash × 0.25) still jumped more than a full day flash. Above
 * the day range the light is scaled down by the exposure, so a flash adds about the same display light at any time.
 * 1 on the Classic regime (exposure 1).
 */
export function flashExposureScale(exposure: number): number {
  return exposure > FLASH_FULL_EXPOSURE ? FLASH_FULL_EXPOSURE / exposure : 1
}

/** What LIGHT_CALIBRATIONS targets at a clear noon. */
export const CALIBRATION_TARGET = Object.freeze({
  /** Direct : ambient irradiance on a horizontal surface (overcast ≈ 1.5 and rain ≈ 1 come from the sky's dimming). */
  ratio: 5,
  /** Outgoing luminance of a white horizontal surface × SkyState.exposure. */
  white: 2.15,
})

/** Lightning colour (cool white). */
const FLASH_RGB: RGB = [0.82, 0.88, 1]

// ---- spherical harmonics ------------------------------------------------------------------------------------------

/**
 * L1 radiance SH (the `SkyState.sh` layout) of the hemisphere model: radiance `horizon + (sky − horizon) · y` above
 * the horizon (y = the direction's height), `ground` below, in the world (glTF) frame. Exact projection, so a constant
 * model gives irradiance π × that constant everywhere, and a black ground gives zero irradiance straight down.
 */
export function ambientToSH(a: { sky: Readonly<RGB>; horizon: Readonly<RGB>; ground: Readonly<RGB> }, out = new Float32Array(SH_L1_FLOATS)): Float32Array {
  for (let c = 0; c < 3; c++) {
    const s = a.sky[c]!
    const h = a.horizon[c]!
    const g = a.ground[c]!
    out[c] = Y00 * (2 * Math.PI * h + Math.PI * (s - h) + 2 * Math.PI * g)
    out[3 + c] = Y1 * (Math.PI * h + ((2 * Math.PI) / 3) * (s - h) - Math.PI * g)
    out[6 + c] = 0
    out[9 + c] = 0
  }
  return out
}

/** Adds a constant radiance to an L1 SH (in place). */
export function addConstantSH(sh: Float32Array, rgb: Readonly<RGB>, scale = 1): Float32Array {
  const k = Math.sqrt(4 * Math.PI) * scale
  for (let c = 0; c < 3; c++) sh[c] = sh[c]! + rgb[c]! * k
  return sh
}

/**
 * Adds a constant radiance `rgb` × scale over the lower hemisphere (y < 0) to an L1 SH (in place): the sun-lit ground's
 * bounce. Exact L1 projection, so an up-facing surface gets nothing from it and a wall gets π/2 × that radiance.
 */
export function addGroundSH(sh: Float32Array, rgb: Readonly<RGB>, scale = 1): Float32Array {
  for (let c = 0; c < 3; c++) {
    const g = rgb[c]! * scale
    sh[c] = sh[c]! + Y00 * 2 * Math.PI * g
    sh[3 + c] = sh[3 + c]! - Y1 * Math.PI * g
  }
  return sh
}

/**
 * The sun-lit ground's albedo × its share in the sun (docs/LIGHTING.md §1): the key light's irradiance on level ground
 * comes back up as Lambertian radiance E · GROUND_BOUNCE / π. The sky's own ambient below the horizon is only the SKY's
 * irradiance × 0.25 (sky-system), so shaded walls, eaves and the undersides of things were lit by a dim blue copy of
 * the sky; this is the warm light that fills them in a sunny scene. Level ground is unchanged (LIGHT_CALIBRATIONS holds).
 */
export const GROUND_BOUNCE = 0.15

/**
 * The bounce radiance in the SH's units (scene radiance / cal.env) of a key light: colour × intensity × cal.sun ×
 * max(0, sine of its elevation) × albedo / π / cal.env.
 */
export function groundBounceRadiance(key: { color: Readonly<RGB>; intensity: number; dirY: number }, cal: Readonly<Pick<LightCalibration, 'sun' | 'env'>>, albedo = GROUND_BOUNCE, out: RGB = [0, 0, 0]): RGB {
  const e = Math.max(0, key.intensity) * cal.sun * Math.max(0, key.dirY)
  const k = cal.env > 0 ? (e * albedo) / Math.PI / cal.env : 0
  for (let c = 0; c < 3; c++) out[c] = Math.max(0, key.color[c]!) * k
  return out
}

/** Irradiance E (not E / π) of an L1 radiance SH on a surface with world normal n. */
export function shIrradiance(sh: ArrayLike<number>, nx: number, ny: number, nz: number, out: RGB = [0, 0, 0]): RGB {
  const a1 = ((2 * Math.PI) / 3) * Y1
  for (let c = 0; c < 3; c++) {
    out[c] = Math.max(0, Math.PI * Y00 * sh[c]! + a1 * (sh[3 + c]! * ny + sh[6 + c]! * nz + sh[9 + c]! * nx))
  }
  return out
}

/**
 * Babylon harmonics (what `SphericalPolynomial.updateFromHarmonics` takes: SH of the Lambertian radiance E / π, in
 * Babylon's basis whose l1,−1 and l1,1 carry a minus sign) from an L1 world radiance SH. `flipZ` is the cube lookup's
 * right-handed z flip (`REFLECTIONMAP_OPPOSITEZ`: the shader evaluates at (n.x, n.y, −n.z)).
 */
export function shToHarmonics(sh: ArrayLike<number>, flipZ: boolean, out = new SphericalHarmonics()): SphericalHarmonics {
  // Cosine convolution (π, 2π/3) then / π: λ00 = c00, λ1m = 2/3 c1m.
  const k1 = 2 / 3
  const zs = flipZ ? -1 : 1
  out.l00.set(sh[0]!, sh[1]!, sh[2]!)
  out.l1_1.set(-k1 * sh[3]!, -k1 * sh[4]!, -k1 * sh[5]!)
  out.l10.set(zs * k1 * sh[6]!, zs * k1 * sh[7]!, zs * k1 * sh[8]!)
  out.l11.set(-k1 * sh[9]!, -k1 * sh[10]!, -k1 * sh[11]!)
  out.l2_2.setAll(0)
  out.l2_1.setAll(0)
  out.l20.setAll(0)
  out.l21.setAll(0)
  out.l22.setAll(0)
  out.preScaled = false
  return out
}

/** Fills `poly` (in place) from an L1 world radiance SH; the textures holding it see the change at once. */
export function shToPolynomial(sh: ArrayLike<number>, flipZ: boolean, poly = new SphericalPolynomial(), scratch = new SphericalHarmonics()): SphericalPolynomial {
  return poly.updateFromHarmonics(shToHarmonics(sh, flipZ, scratch))
}

/** Largest per-channel rescale of the sky's SH toward the ambient level (a near-black SH channel falls back instead). */
const MAX_LEVEL_SCALE = 50

/**
 * The L1 SH the lighting uses for a sky state: the sky's SH (or the ambient hemisphere) with each channel scaled so an
 * up-facing surface gets E / π = ambient.sky (see the module comment).
 */
export function skyStateSH(sky: Readonly<SkyState>, out = new Float32Array(SH_L1_FLOATS)): Float32Array {
  const a = sky.ambient
  const hasSH = !!sky.sh && sky.sh.length >= SH_L1_FLOATS
  if (hasSH) out.set(sky.sh!.subarray(0, SH_L1_FLOATS))
  else ambientToSH(a, out)
  const e = shIrradiance(out, 0, 1, 0)
  let fallback: Float32Array | null = null
  for (let c = 0; c < 3; c++) {
    const target = Math.PI * Math.max(0, a.sky[c]!)
    let scale = e[c]! > 1e-9 ? target / e[c]! : NaN
    if (!(scale <= MAX_LEVEL_SCALE) && hasSH) {
      // The sky's SH has (almost) nothing in this channel: take the hemisphere's shape for it.
      fallback ??= ambientToSH(a)
      const ef = shIrradiance(fallback, 0, 1, 0)[c]!
      for (let i = 0; i < 4; i++) out[i * 3 + c] = fallback[i * 3 + c]!
      scale = ef > 1e-9 ? target / ef : 0
    }
    if (!(scale <= MAX_LEVEL_SCALE)) scale = 0
    for (let i = 0; i < 4; i++) out[i * 3 + c] = out[i * 3 + c]! * scale
  }
  return out
}

export interface LightBalance {
  /** Direct irradiance on a horizontal surface (luminance). */
  direct: number
  /** Ambient irradiance on a horizontal surface (luminance). */
  ambient: number
  /** direct / ambient. */
  ratio: number
  /** Outgoing luminance of a white horizontal surface, before exposure. */
  white: number
}

/** The sun : sky balance a calibration gives a sky state (no flash). */
export function lightBalance(sky: Readonly<SkyState>, cal: Readonly<LightCalibration>): LightBalance {
  const k = sky.keyLight
  const direct = cal.sun * Math.max(0, k.intensity) * luminance(k.color) * Math.max(0, k.dir.y / (k.dir.length() || 1))
  const ambient = luminance(shIrradiance(skyStateSH(sky), 0, 1, 0)) * cal.env
  return { direct, ambient, ratio: ambient > 0 ? direct / ambient : Infinity, white: (direct + ambient) / Math.PI }
}

/**
 * The calibration that gives `sky` (a clear noon) the target ratio and white level at its own exposure. `domeScale`:
 * the dome's display units per unit of the sky's radiance (1 on the classic sky; 1 / (SKY_LDR_PER_LUT × AMBIENT_BOOST) on
 * the modern, whose radiance() carries the ambient boost).
 */
export function calibrateLight(sky: Readonly<SkyState>, domeScale = 1, target: { ratio: number; white: number } = CALIBRATION_TARGET): LightCalibration {
  const k = sky.keyLight
  const keyE = Math.max(0, k.intensity) * luminance(k.color) * Math.max(0, k.dir.y / (k.dir.length() || 1))
  const skyE = luminance(shIrradiance(skyStateSH(sky), 0, 1, 0))
  const exposure = sky.exposure > 0 ? sky.exposure : 1
  // white = (direct + ambient) / π with direct = ratio × ambient.
  const ambient = ((target.white / exposure) * Math.PI) / (1 + target.ratio)
  const env = skyE > 0 ? ambient / skyE : 1
  const sun = keyE > 0 ? (target.ratio * ambient) / keyE : 1
  const keyNoon = Math.max(0, k.intensity) * luminance(k.color)
  return { sun, env, cube: domeScale / env, flashAmbient: luminance(sky.ambient.sky), flashSun: 0.25 * sun * keyNoon }
}

// ---- the sky cube -------------------------------------------------------------------------------------------------

/**
 * Cube faces in Babylon's order (+X, −X, +Y, −Y, +Z, −Z) with the texel axes of its cube data
 * (`CubeMapToSphericalPolynomialTools` FileFaces, the GL convention sky/ibl.ts uses): texel (x, y), row 0 first,
 * points along `normal + fileX · u + fileY · v` with u, v in (−1, 1) at texel centres.
 */
export const CUBE_FACES: ReadonlyArray<{ normal: readonly [number, number, number]; fileX: readonly [number, number, number]; fileY: readonly [number, number, number] }> = [
  { normal: [1, 0, 0], fileX: [0, 0, -1], fileY: [0, -1, 0] },
  { normal: [-1, 0, 0], fileX: [0, 0, 1], fileY: [0, -1, 0] },
  { normal: [0, 1, 0], fileX: [1, 0, 0], fileY: [0, 0, 1] },
  { normal: [0, -1, 0], fileX: [1, 0, 0], fileY: [0, 0, -1] },
  { normal: [0, 0, 1], fileX: [1, 0, 0], fileY: [0, -1, 0] },
  { normal: [0, 0, -1], fileX: [-1, 0, 0], fileY: [0, -1, 0] },
]

/**
 * The world direction (unit, glTF) a cube texel shows. `flipZ`: the scene's right-handed lookup flips z (the texel
 * at cube direction d shows the world direction (d.x, d.y, −d.z)).
 */
export function cubeTexelDir(face: number, x: number, y: number, size: number, flipZ: boolean, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const f = CUBE_FACES[face]!
  const u = ((x + 0.5) / size) * 2 - 1
  const v = ((y + 0.5) / size) * 2 - 1
  const dx = f.normal[0] + f.fileX[0] * u + f.fileY[0] * v
  const dy = f.normal[1] + f.fileX[1] * u + f.fileY[1] * v
  const dz = f.normal[2] + f.fileX[2] * u + f.fileY[2] * v
  const l = Math.hypot(dx, dy, dz)
  out[0] = dx / l
  out[1] = dy / l
  out[2] = (flipZ ? -dz : dz) / l
  return out
}

/** Sky radiance along a world (glTF, unit) direction, RGB into `out` (sky/ibl.ts SkyRadiance has this shape). */
export type SkyRadiance = (dx: number, dy: number, dz: number, out: RGB) => unknown

/** What the lighting reads from the sky system beyond SkyState (SKY-B's SkySystem; both optional). */
export interface SkyRadianceSource {
  /** The sky's radiance by direction, in keyLight units (SKY-B). */
  radiance?(): SkyRadiance
  /** Bumped when the sky's LUTs finished (the cube refreshes, rate-limited). */
  readonly lutVersion?: number
}

/**
 * The retail sky gradient (the classic dome's colours, linear; SKY-B's classic `radiance()`): SkyBottom → SkyTop
 * with height above the horizon, half the fog colour below, blended over ~3° under the horizon.
 */
export function retailRadiance(env: Readonly<EnvValues>): SkyRadiance {
  const lin = (c: Readonly<RGB>, k = 1): RGB => [toLinear(c[0]) * k, toLinear(c[1]) * k, toLinear(c[2]) * k]
  const ground = lin(env.fogColor, 0.5)
  return (_x, y, _z, out) => {
    const k = Math.min(1, Math.max(0, y))
    const w = Math.min(1, Math.max(0, (y + 0.05) / 0.05))
    for (let c = 0; c < 3; c++) {
      const skyC = toLinear(env.skyBottom[c]! + (env.skyTop[c]! - env.skyBottom[c]!) * k)
      out[c] = ground[c]! + (skyC - ground[c]!) * w
    }
  }
}

/** `r` × k. */
export function scaledRadiance(r: SkyRadiance, k: number): SkyRadiance {
  return (x, y, z, out) => {
    r(x, y, z, out)
    out[0] *= k
    out[1] *= k
    out[2] *= k
  }
}

// Half floats (IEEE 754 binary16), round to nearest; non-finite and negative → 0, large → 65504.
const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)
export function toHalf(v: number): number {
  if (!(v > 0)) return 0
  f32[0] = Math.min(65504, v)
  const x = u32[0]!
  const e = ((x >>> 23) & 0xff) - 112
  const m = x & 0x7fffff
  if (e <= 0) {
    if (e < -10) return 0
    const mm = (m | 0x800000) >>> (1 - e)
    return (mm + 0x1000) >>> 13
  }
  return Math.min(0x7bff, (e << 10) + ((m + 0x1000) >>> 13))
}

export function fromHalf(h: number): number {
  const e = (h >>> 10) & 0x1f
  const m = h & 0x3ff
  const s = h & 0x8000 ? -1 : 1
  if (e === 0) return s * m * 2 ** -24
  if (e === 31) return m ? NaN : s * Infinity
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

/** Directions of a Fibonacci hemisphere around +Z, uniform in cos θ, for the mip prefilter. */
function fibonacciCap(n: number): Float32Array {
  const out = new Float32Array(n * 3)
  const ga = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const z = 1 - (i + 0.5) / n
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    out[i * 3] = Math.cos(ga * i) * r
    out[i * 3 + 1] = Math.sin(ga * i) * r
    out[i * 3 + 2] = z
  }
  return out
}

/** Samples per prefiltered texel: 24 for the wide lobes, 8 for the near-mirror ones (α < 0.1, the big mips). */
const PREFILTER_SAMPLES = 24
const PREFILTER_SAMPLES_NARROW = 8
const CAP = fibonacciCap(PREFILTER_SAMPLES)
const CAP_NARROW = fibonacciCap(PREFILTER_SAMPLES_NARROW)

/**
 * Prefiltered radiance of mip `level` of a `size` cube along world direction d: a cosine-power average matching
 * Babylon's roughness → LOD mapping (lod = log2(size · α), so α = 2^level / size; Phong power 2/α² − 2).
 */
export function prefilteredRadiance(radiance: SkyRadiance, level: number, size: number, dx: number, dy: number, dz: number, out: RGB): RGB {
  if (level === 0) {
    radiance(dx, dy, dz, out)
    return out
  }
  const alpha = Math.min(1, 2 ** level / size)
  const power = Math.max(0, 2 / (alpha * alpha) - 2)
  // Tangent frame around d: t = cross(up, d), b = cross(d, t), up = +Y unless d is nearly vertical.
  const vertical = Math.abs(dy) >= 0.99
  let tx = vertical ? 0 : dz
  let ty = vertical ? -dz : 0
  let tz = vertical ? dy : -dx
  const tl = Math.hypot(tx, ty, tz) || 1
  tx /= tl
  ty /= tl
  tz /= tl
  const bx = dy * tz - dz * ty
  const by = dz * tx - dx * tz
  const bz = dx * ty - dy * tx
  // Shrink the cap to the lobe: samples are uniform in cos θ, so cos θ ≥ 0.05^(1/(power+1)) keeps 95 % of the weight.
  const minCos = power > 0 ? Math.pow(0.05, 1 / (power + 1)) : 0
  let r = 0
  let g = 0
  let b = 0
  let wsum = 0
  const tmp: RGB = [0, 0, 0]
  const narrow = alpha < 0.1
  const cap = narrow ? CAP_NARROW : CAP
  const n = narrow ? PREFILTER_SAMPLES_NARROW : PREFILTER_SAMPLES
  for (let i = 0; i < n; i++) {
    const cz = minCos + (1 - minCos) * cap[i * 3 + 2]!
    const sz = Math.sqrt(Math.max(0, 1 - cz * cz))
    const cr = Math.hypot(cap[i * 3]!, cap[i * 3 + 1]!) || 1
    const cx = (cap[i * 3]! / cr) * sz
    const cy = (cap[i * 3 + 1]! / cr) * sz
    const w = Math.pow(cz, power)
    radiance(tx * cx + bx * cy + dx * cz, ty * cx + by * cy + dy * cz, tz * cx + bz * cy + dz * cz, tmp)
    r += tmp[0] * w
    g += tmp[1] * w
    b += tmp[2] * w
    wsum += w
  }
  out[0] = r / wsum
  out[1] = g / wsum
  out[2] = b / wsum
  return out
}

/** Can this engine upload a raw cube (a real WebGL2 or WebGPU context; not the NullEngine)? */
function canUploadCube(engine: AbstractEngine): boolean {
  const e = engine as AbstractEngine & { _gl?: unknown; isWebGPU?: boolean }
  return !!e.isWebGPU || !!e._gl
}

/**
 * How the PBR shader reads a SkyEnvironment cube (`texture.gammaSpace`, Babylon's GAMMAREFLECTION define).
 * - 'linear' (the default): the cube holds linear radiance (half floats), so it is read as it is.
 * - 'srgb': Babylon's own default for a RawCubeTexture (gammaSpace true). The shader then decodes the linear data as
 *   sRGB (pow 2.2 on the radiance; the SH irradiance is not touched), so a dim radiance comes back far darker (0.35 →
 *   0.10) and one above 1 brighter. The world's sky cube has been read this way since wave 9A, and its reflections
 *   (the water's sky, metals, the Fresnel sheen) were seen and approved so at the wave-9 final gate; WorldLighting
 *   keeps it pinned (WORLD_SKY_CUBE_DECODE) until a look pass moves it to 'linear' (docs/BACKLOG.md).
 */
export type SkyCubeDecode = 'linear' | 'srgb'

/** How WorldLighting's sky cube is read: the shipped wave-9 look (see SkyCubeDecode). */
export const WORLD_SKY_CUBE_DECODE: SkyCubeDecode = 'srgb'

export interface SkyEnvironmentOptions {
  /** Default 'linear' (see SkyCubeDecode). */
  decode?: SkyCubeDecode
}

/**
 * The reflection cube (D14): one RawCubeTexture, RGBA16F, full mip chain, refreshed in slices (one face per frame,
 * then the prefiltered mips one face per frame, then one upload of every face and level). Headless engines keep the
 * data on the CPU (`texture` null). The radiance is stored linear; `decode` says how the shader reads it.
 */
export class SkyEnvironment {
  readonly levels: number
  readonly texture: RawCubeTexture | null
  readonly decode: SkyCubeDecode
  /** Half-float RGBA faces per level: packed[level][face]. */
  readonly packed: Uint16Array[][]
  private radiance: SkyRadiance | null = null
  private stepIndex = -1
  /** Refreshes finished (uploaded, or kept on the CPU headless). */
  refreshes = 0

  constructor(readonly scene: Scene, readonly size: number, readonly flipZ: boolean, options: SkyEnvironmentOptions = {}) {
    this.decode = options.decode ?? 'linear'
    this.levels = Math.floor(Math.log2(size)) + 1
    this.packed = []
    for (let l = 0; l < this.levels; l++) {
      const s = Math.max(1, size >> l)
      this.packed.push(Array.from({ length: 6 }, () => new Uint16Array(s * s * 4)))
    }
    this.texture = canUploadCube(scene.getEngine())
      ? new RawCubeTexture(scene, this.packed[0]!, size, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_HALF_FLOAT, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE)
      : null
    if (this.texture) {
      this.texture.name = 'skyEnvironment'
      this.texture.gammaSpace = this.decode === 'srgb'
    }
  }

  /** A refresh in progress. */
  get busy(): boolean {
    return this.stepIndex >= 0
  }

  /** Starts (or restarts) a refresh from this radiance. */
  begin(radiance: SkyRadiance): void {
    this.radiance = radiance
    this.stepIndex = 0
  }

  /** Runs every remaining slice at once (a time jump, or tests). */
  finish(): void {
    while (this.busy) this.step()
  }

  /** One slice of the refresh (≤ ~1 ms at 64²). Returns true when this call finished it. */
  step(): boolean {
    if (this.stepIndex < 0 || !this.radiance) return false
    const i = this.stepIndex++
    if (i < 6) this.fillLevel0(i)
    else if (i < 12) this.fillMips(i - 6)
    else {
      this.upload()
      this.stepIndex = -1
      this.refreshes++
      return true
    }
    return false
  }

  private fillLevel0(face: number): void {
    const n = this.size
    const dst = this.packed[0]![face]!
    const d: [number, number, number] = [0, 0, 0]
    const c: RGB = [0, 0, 0]
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        cubeTexelDir(face, x, y, n, this.flipZ, d)
        this.radiance!(d[0], d[1], d[2], c)
        const o = (y * n + x) * 4
        dst[o] = toHalf(c[0])
        dst[o + 1] = toHalf(c[1])
        dst[o + 2] = toHalf(c[2])
        dst[o + 3] = 0x3c00
      }
    }
  }

  private fillMips(face: number): void {
    const d: [number, number, number] = [0, 0, 0]
    const c: RGB = [0, 0, 0]
    for (let l = 1; l < this.levels; l++) {
      const n = Math.max(1, this.size >> l)
      const dst = this.packed[l]![face]!
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          cubeTexelDir(face, x, y, n, this.flipZ, d)
          prefilteredRadiance(this.radiance!, l, this.size, d[0], d[1], d[2], c)
          const o = (y * n + x) * 4
          dst[o] = toHalf(c[0])
          dst[o + 1] = toHalf(c[1])
          dst[o + 2] = toHalf(c[2])
          dst[o + 3] = 0x3c00
        }
      }
    }
  }

  private upload(): void {
    const tex = this.texture?.getInternalTexture()
    if (!tex) return
    const engine = this.scene.getEngine() as AbstractEngine & {
      _uploadArrayBufferViewToTexture?: (t: InternalTexture, data: ArrayBufferView, face: number, lod: number) => void
    }
    // Every level was allocated at creation (mipmaps on); without them (no half-float render target) only level 0.
    const levels = tex.generateMipMaps ? this.levels : 1
    for (let l = 0; l < levels; l++) {
      for (let f = 0; f < 6; f++) engine._uploadArrayBufferViewToTexture?.(tex, this.packed[l]![f]!, f, l)
    }
  }

  dispose(): void {
    this.stepIndex = -1
    this.radiance = null
    this.texture?.dispose()
  }
}

// ---- refresh policy -----------------------------------------------------------------------------------------------

export interface CubeRefreshKey {
  /** Unit key-light direction. */
  dir: [number, number, number]
  cloud: number
  rain: number
  /** Luminance of the zenith ambient (the palette moving between env profiles). */
  sky: number
  /** The sky's LUT version (SKY-B) or 0. */
  lut: number
}

/** A move this large in one frame is a time jump: the refresh restarts at once, past the rate limit (D14). */
export const CUBE_JUMP_DEG = 5
/** D14: refresh when the sun moved more than this, or the weather more than CUBE_WEATHER_DELTA. */
export const CUBE_SUN_DEG = 0.5
export const CUBE_WEATHER_DELTA = 0.05

const angleDeg = (a: readonly number[], b: readonly number[]) =>
  (Math.acos(Math.min(1, Math.max(-1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!))) * 180) / Math.PI

/**
 * Whether the sky cube should refresh now: at once after a jump since the last frame (`frame`), or the first time;
 * otherwise after a sun move > 0.5°, a weather change > 0.05, a palette change > 5 % or new sky LUTs since the last
 * refresh (`prev`), at most once per `minIntervalS`.
 */
export function cubeRefreshDue(prev: CubeRefreshKey | null, frame: CubeRefreshKey | null, cur: CubeRefreshKey, elapsedS: number, minIntervalS: number): 'jump' | 'due' | null {
  if (!prev) return 'jump'
  if (frame && angleDeg(frame.dir, cur.dir) > CUBE_JUMP_DEG) return 'jump'
  const changed = angleDeg(prev.dir, cur.dir) > CUBE_SUN_DEG || Math.abs(cur.cloud - prev.cloud) > CUBE_WEATHER_DELTA ||
    Math.abs(cur.rain - prev.rain) > CUBE_WEATHER_DELTA || Math.abs(cur.sky - prev.sky) > 0.05 * Math.max(prev.sky, 1e-3) ||
    cur.lut !== prev.lut
  return changed && elapsedS >= minIntervalS ? 'due' : null
}

// ---- the lighting part --------------------------------------------------------------------------------------------

export interface WorldLightingOptions {
  quality: Readonly<RenderQuality>
  /** Override both regimes' calibration (tests, the lab). */
  calibration?: Readonly<LightCalibration>
  /** The retail fixed-function sun: switched off while this lighting runs (the PBR path has one key light). */
  retailSun?: Light | null
  /** The sky system (its radiance and LUT version, SKY-B). */
  sky?: SkyRadianceSource | null
  /** The sky style (World.skyStyle): 'modern' with SKY-B's radiance → the modern calibration. */
  skyStyle?: () => SkyStyle
  /** Clock (ms), for the cube's rate limit. */
  now?: () => number
}

/**
 * RND-L's lighting part (WorldRender.lighting): the celestial light, the SH ambient, the sky cube and the flash.
 * Per frame it copies SkyState into all three; nothing here changes a define after construction.
 */
export class WorldLighting implements RenderPart {
  readonly celestial: DirectionalLight
  /** The ambient the PBR materials read (carried by the sky cube; kept here too for headless engines). */
  readonly polynomial = new SphericalPolynomial()
  env: SkyEnvironment | null = null
  weather: Readonly<RenderWeather> = CLEAR_RENDER_WEATHER
  quality: Readonly<RenderQuality>
  /** The regime of the last update. */
  regime: LightRegime = 'classic'
  private readonly override: Readonly<LightCalibration> | null
  private readonly sky: SkyRadianceSource | null
  private readonly skyStyle: (() => SkyStyle) | null
  private readonly retailSun: Light | null
  private readonly retailSunWasEnabled: boolean
  /** scene.environmentIntensity before the PBR lighting took it (restored on dispose: the Classic path reads it). */
  private readonly envIntensityWas: number
  private readonly now: () => number
  private readonly direction = new Vector3(0, -1, 0)
  private readonly sh = new Float32Array(SH_L1_FLOATS)
  private readonly lastSH = new Float32Array(SH_L1_FLOATS).fill(NaN)
  private readonly harmonics = new SphericalHarmonics()
  private readonly bounce: RGB = [0, 0, 0]
  private readonly flipZ: boolean
  private lastRefresh: { key: CubeRefreshKey; at: number } | null = null
  private lastFrameKey: CubeRefreshKey | null = null
  private disposed = false

  constructor(readonly scene: Scene, opts: WorldLightingOptions) {
    this.quality = opts.quality
    this.override = opts.calibration ?? null
    this.sky = opts.sky ?? null
    this.skyStyle = opts.skyStyle ?? null
    this.now = opts.now ?? (() => performance.now())
    this.retailSun = opts.retailSun ?? null
    this.retailSunWasEnabled = this.retailSun?.isEnabled(false) ?? false
    this.envIntensityWas = scene.environmentIntensity
    this.retailSun?.setEnabled(false)
    this.celestial = new DirectionalLight(CELESTIAL_LIGHT_NAME, this.direction, scene)
    this.celestial.intensity = 0
    // First in every mesh's light list (see the module comment), whatever was created before it.
    this.celestial.renderPriority = CELESTIAL_RENDER_PRIORITY
    scene.sortLightsByPriority()
    for (const m of scene.meshes) m._resyncLightSources()
    this.flipZ = scene.useRightHandedSystem
    this.setQuality(opts.quality)
  }

  /** The calibration in force (the override, or the regime's). */
  get calibration(): Readonly<LightCalibration> {
    return this.override ?? LIGHT_CALIBRATIONS[this.regime]
  }

  setQuality(q: Readonly<RenderQuality>): void {
    this.quality = q
    const size = q.ibl?.cubeSize ?? 0
    if (!(this.env && this.env.size === size)) {
      this.env?.dispose()
      this.env = null
      this.lastRefresh = null
      if (size > 0) {
        // The shipped (approved) world look reads the cube as sRGB; see SkyCubeDecode before changing it.
        this.env = new SkyEnvironment(this.scene, size, this.flipZ, { decode: WORLD_SKY_CUBE_DECODE })
        if (this.env.texture) this.env.texture.sphericalPolynomial = this.polynomial
      }
      // One assignment per cube (a new cube is an Options change; a refresh never swaps textures).
      this.scene.environmentTexture = this.env?.texture ?? null
    }
    this.scene.environmentIntensity = this.calibration.env
  }

  setWeather(w: Readonly<RenderWeather>): void {
    this.weather = w
  }

  update(_camera: Camera | null, sky: Readonly<SkyState>): void {
    if (this.disposed) return
    const regime: LightRegime = this.skyStyle?.() === 'modern' && typeof this.sky?.radiance === 'function' ? 'modern' : 'classic'
    if (regime !== this.regime) {
      this.regime = regime
      this.lastRefresh = null
    }
    const cal = this.calibration
    const k = sky.keyLight
    const flash = Math.min(1, Math.max(0, this.weather.flash || 0)) * flashExposureScale(sky.exposure)
    // Key light (+ the flash fill): intensity carries the magnitude, diffuse the colour.
    const l = k.dir.length() || 1
    this.direction.set(-k.dir.x / l, -k.dir.y / l, -k.dir.z / l)
    const ki = Math.max(0, k.intensity) * cal.sun
    const r = k.color[0] * ki + FLASH_RGB[0] * flash * cal.flashSun
    const g = k.color[1] * ki + FLASH_RGB[1] * flash * cal.flashSun
    const b = k.color[2] * ki + FLASH_RGB[2] * flash * cal.flashSun
    const total = Math.max(r, g, b)
    const c = this.celestial
    if (total > 0) {
      c.diffuse.set(r / total, g / total, b / total)
      c.intensity = total
    } else {
      c.diffuse.set(k.color[0], k.color[1], k.color[2])
      c.intensity = 0
    }
    c.specular.copyFrom(c.diffuse)
    // Ambient: the sky's SH at the ambient level (+ the flash), re-uploaded only when it moved.
    skyStateSH(sky, this.sh)
    if (flash > 0) addConstantSH(this.sh, FLASH_RGB, flash * cal.flashAmbient)
    if (LIGHT_LOOK.groundBounce) {
      groundBounceRadiance({ color: k.color, intensity: k.intensity, dirY: k.dir.y / l }, cal, GROUND_BOUNCE, this.bounce)
      addGroundSH(this.sh, this.bounce)
    }
    let moved = false
    for (let i = 0; i < SH_L1_FLOATS; i++) {
      const last = this.lastSH[i]!
      if (last !== last || Math.abs(this.sh[i]! - last) > 1e-6 * Math.max(1, Math.abs(last))) {
        moved = true
        break
      }
    }
    if (moved) {
      this.lastSH.set(this.sh)
      shToPolynomial(this.sh, this.flipZ, this.polynomial, this.harmonics)
    }
    if (this.scene.environmentIntensity !== cal.env) this.scene.environmentIntensity = cal.env
    this.updateCube(sky, cal)
  }

  private updateCube(sky: Readonly<SkyState>, cal: Readonly<LightCalibration>): void {
    const env = this.env
    if (!env || !this.quality.ibl) return
    const k = sky.keyLight
    const l = k.dir.length() || 1
    const key: CubeRefreshKey = {
      dir: [k.dir.x / l, k.dir.y / l, k.dir.z / l],
      cloud: this.weather.cloud,
      rain: this.weather.rain,
      sky: luminance(sky.ambient.sky),
      lut: this.sky?.lutVersion ?? 0,
    }
    const now = this.now()
    const elapsed = this.lastRefresh ? (now - this.lastRefresh.at) / 1000 : Infinity
    const due = cubeRefreshDue(this.lastRefresh?.key ?? null, this.lastFrameKey, key, elapsed, this.quality.ibl.refreshS)
    this.lastFrameKey = key
    if (due) {
      const radiance = typeof this.sky?.radiance === 'function' ? this.sky.radiance() : retailRadiance(sky.env)
      env.begin(scaledRadiance(radiance, cal.cube))
      this.lastRefresh = { key, at: now }
      // The first cube runs whole (an empty cube reflects black); a jump restarts at once but stays sliced, so it does
      // not add ~10 ms to the frame where the sky rebuilds its own LUTs (a stale cube for ~13 frames is not visible).
      if (env.refreshes === 0) env.finish()
    }
    if (env.busy) env.step()
  }

  /** Forces a full cube refresh at the next update (a GM `time` jump the caller knows about). */
  refreshNow(): void {
    this.lastRefresh = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.env?.texture && this.scene.environmentTexture === this.env.texture) this.scene.environmentTexture = null
    this.scene.environmentIntensity = this.envIntensityWas
    this.env?.dispose()
    this.env = null
    this.celestial.dispose()
    if (this.retailSun && this.retailSunWasEnabled && !this.retailSun.isDisposed()) this.retailSun.setEnabled(true)
  }
}

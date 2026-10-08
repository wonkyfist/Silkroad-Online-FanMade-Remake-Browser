/**
 * The own character's environment light (docs/CHARACTERS.md §16.4): a small image-based light for the licensed body's
 * materials (skin and eyes: §16.5, on the world's sky alone the sclera, lit by a blue sky without the sun's ground
 * bounce, read blue), in place of the world's
 * sky ambient on those materials only.
 *
 * Why (measured, §16.4 ladder): the world's ambient is the sky's L1 spherical harmonics, and below the horizon its
 * radiance is a ground bounce of the SKY's irradiance only (sky-system `radiance()`: ambient.ground = sky × 0.25). The
 * sun's own light off the ground, at noon ≈ 5× the sky's on a horizontal surface, is missing, so everything a face turns
 * downwards or sideways (under the brows, nose, chin, the cheeks' lower half) is lit by a dim, blue copy of the sky:
 * the lavender, flat skin of the face-fix2 shots. The world was calibrated with that ambient and keeps it; this cube
 * changes the character only.
 *
 * The radiance: above the horizon the world's own sky (its SH turned back into radiance, L = a + 1.5 b·n, so an
 * up-facing surface gets exactly the world's ambient); below it a Lambertian ground of albedo GROUND_ALBEDO lit by the
 * celestial light (sun or moon, its colour and intensity) and the sky. The cube carries its own L2 harmonics (Babylon's
 * radiance → irradiance → Lambertian radiance chain), so the diffuse light has a direction, and is read linear.
 * Refreshed every REFRESH_MS in slices (one cube face per frame, SkyEnvironment). PBR path only (needs the celestial
 * light and the world's environment); `__sroPerf.charEnv` is the A/B switch.
 */
import { Color3, PBRMaterial, SphericalHarmonics, SphericalPolynomial, Vector3, type AbstractMesh, type DirectionalLight } from '@babylonjs/core'
import { SkyEnvironment } from '@sro/world-render'
import { licensedMaterialRole } from '../../three/licensed-materials.ts'
import { PERF } from '../perf.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'

export const SELF_ENV_SIZE = 32
/** The ground's albedo for the bounce (the sky system's own constant). */
export const GROUND_ALBEDO = 0.25
const REFRESH_MS = 1000
const SCAN_MS = 500
const SH_SAMPLES = 512
/**
 * The licensed body's light trim (direct and environment intensity of all its materials, eyes included). The world's
 * exposure is calibrated on the retail textures (a lit white horizontal surface leaves 2.15 after exposure, lighting.ts),
 * and the pack's photographic albedos (skin ≈ 0.43 linear) sat in the tone map's shoulder: at noon 19 % of the face's
 * skin pixels at ≥ 245 against 0 % in the artist's renders (p99 ≈ 205). This trim puts the skin's p99 under the shoulder.
 */
export const SELF_TRIM = 0.6
/** The licensed materials that take the cube (look lab: `__sroSelfEnv.roles`). */
export const SELF_ENV = { roles: new Set<string>(['skin', 'eye']), trim: SELF_TRIM }
;(globalThis as { __sroSelfEnv?: unknown }).__sroSelfEnv = SELF_ENV

type RGB = [number, number, number]

/** The world's sky in polynomial form (E / π, L1 + constant) and the celestial light, as the cube's inputs. */
export interface SelfEnvInputs {
  /** Constant term (rgb). */
  a: RGB
  /** First-order terms per world axis: bx, by, bz (rgb each), already in world axes (no cube z flip). */
  b: [RGB, RGB, RGB]
  /** Celestial light: direction it travels (world), intensity × colour. */
  sunDir: RGB
  sunRgb: RGB
  /** scene.environmentIntensity (the cube's radiance is multiplied by it in the shader). */
  envIntensity: number
}

/** The cube's radiance along a world direction (see the module comment). */
export function selfEnvRadiance(i: SelfEnvInputs): (x: number, y: number, z: number, out: RGB) => RGB {
  const sunDown = Math.max(0, -i.sunDir[1])
  const ground: RGB = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const skyUp = Math.max(0, i.a[c]! + i.b[1][c]!) // E / π of the sky on the ground
    ground[c] = (GROUND_ALBEDO / Math.PI) * ((i.sunRgb[c]! * sunDown) / Math.max(1e-4, i.envIntensity) + Math.PI * skyUp)
  }
  return (x, y, z, out) => {
    if (y < 0) {
      out[0] = ground[0]; out[1] = ground[1]; out[2] = ground[2]
      return out
    }
    for (let c = 0; c < 3; c++) out[c] = Math.max(0, i.a[c]! + 1.5 * (i.b[0][c]! * x + i.b[1][c]! * y + i.b[2][c]! * z))
    return out
  }
}

/** The inputs from the world's polynomial (Babylon cube-lookup axes; `flipZ`: the right-handed z flip). */
export function selfEnvInputsOf(poly: SphericalPolynomial, flipZ: boolean, sun: DirectionalLight, envIntensity: number): SelfEnvInputs {
  const zs = flipZ ? -1 : 1
  const v3 = (v: Vector3): RGB => [v.x, v.y, v.z]
  const a: RGB = [0, 0, 0]
  for (let c = 0; c < 3; c++) a[c] = (v3(poly.xx)[c]! + v3(poly.yy)[c]! + v3(poly.zz)[c]!) / 3
  const bz = v3(poly.z).map(v => v * zs) as RGB
  const d = sun.direction
  const l = Math.hypot(d.x, d.y, d.z) || 1
  return {
    a,
    b: [v3(poly.x), v3(poly.y), bz],
    sunDir: [d.x / l, d.y / l, d.z / l],
    sunRgb: [sun.diffuse.r * sun.intensity, sun.diffuse.g * sun.intensity, sun.diffuse.b * sun.intensity],
    envIntensity,
  }
}

/** L2 harmonics of a radiance, as the polynomial Babylon's PBR reads (E / π), into `out`. */
export function radiancePolynomial(radiance: (x: number, y: number, z: number, out: RGB) => RGB, flipZ: boolean, out: SphericalPolynomial): SphericalPolynomial {
  const sh = new SphericalHarmonics()
  const dir = new Vector3()
  const col = new Color3()
  const c: RGB = [0, 0, 0]
  const w = (4 * Math.PI) / SH_SAMPLES
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let k = 0; k < SH_SAMPLES; k++) {
    const y = 1 - (2 * (k + 0.5)) / SH_SAMPLES
    const r = Math.sqrt(1 - y * y)
    const x = Math.cos(golden * k) * r, z = Math.sin(golden * k) * r
    radiance(x, y, z, c)
    dir.set(x, y, flipZ ? -z : z)
    col.set(c[0], c[1], c[2])
    sh.addLight(dir, col, w)
  }
  sh.convertIncidentRadianceToIrradiance()
  sh.convertIrradianceToLambertianRadiance()
  return out.updateFromHarmonics(sh)
}

export function selfEnvFeature(ctx: WorldFeatureContext): WorldFeature {
  const scene = ctx.scene
  let env: SkyEnvironment | null = null
  const poly = new SphericalPolynomial()
  let pending: ((x: number, y: number, z: number, out: RGB) => RGB) | null = null
  let lastRefresh = -Infinity
  let lastScan = -Infinity
  const bound = new Set<PBRMaterial>()
  let wanted: PBRMaterial[] = []
  /** Every licensed material of the own body and its own intensities before the trim. */
  const trimmed = new Map<PBRMaterial, [number, number]>()
  let licensed: PBRMaterial[] = []
  const untrimAll = () => {
    for (const [m, [d, e]] of trimmed) {
      m.directIntensity = d
      m.environmentIntensity = e
    }
    trimmed.clear()
  }

  const unbindAll = () => {
    for (const m of bound) if (m.reflectionTexture === env?.texture) m.reflectionTexture = null
    bound.clear()
  }

  return {
    onFrame(now) {
      const celestial = scene.lights.find(l => l.name === 'celestial') as DirectionalLight | undefined
      const worldPoly = scene.environmentTexture?.sphericalPolynomial
      const on = PERF.charEnv && !!celestial && !!worldPoly
      if (!on) {
        if (bound.size) unbindAll()
        if (trimmed.size) untrimAll()
        return
      }
      if (now - lastScan > SCAN_MS) {
        lastScan = now
        const id = ctx.selfId()
        const actor = id === null || id === undefined ? null : ctx.view(id)?.actor
        const meshes: AbstractMesh[] = actor ? actor.root.getChildMeshes(false) : []
        const mats = new Set<PBRMaterial>()
        const lic = new Set<PBRMaterial>()
        for (const m of meshes) {
          const mat = m.material
          if (!(mat instanceof PBRMaterial)) continue
          const role = licensedMaterialRole(mat.name.replace(/_soft$/, ''))
          if (role !== 'other') lic.add(mat)
          if (SELF_ENV.roles.has(role)) mats.add(mat)
        }
        wanted = [...mats]
        licensed = [...lic]
        for (const [m, [d, e]] of trimmed) if (!lic.has(m)) { m.directIntensity = d; m.environmentIntensity = e; trimmed.delete(m) }
        for (const m of bound) if (!mats.has(m)) { if (m.reflectionTexture === env?.texture) m.reflectionTexture = null; bound.delete(m) }
      }
      for (const m of licensed) {
        if (!trimmed.has(m)) trimmed.set(m, [m.directIntensity, m.environmentIntensity])
        const [d, e] = trimmed.get(m)!
        if (m.directIntensity !== d * SELF_ENV.trim) m.directIntensity = d * SELF_ENV.trim
        if (m.environmentIntensity !== e * SELF_ENV.trim) m.environmentIntensity = e * SELF_ENV.trim
      }
      if (!wanted.length) return
      if (!env) {
        env = new SkyEnvironment(scene, SELF_ENV_SIZE, scene.useRightHandedSystem, { decode: 'linear' })
        if (env.texture) {
          env.texture.name = 'selfEnvironment'
          env.texture.sphericalPolynomial = poly
        }
        const r = selfEnvRadiance(selfEnvInputsOf(worldPoly!, scene.useRightHandedSystem, celestial!, scene.environmentIntensity))
        env.begin(r)
        env.finish()
        radiancePolynomial(r, scene.useRightHandedSystem, poly)
        lastRefresh = now
      }
      const tex = env.texture
      if (!tex) return
      for (const m of wanted) {
        if (m.reflectionTexture !== tex) {
          m.reflectionTexture = tex
          bound.add(m)
        }
      }
      if (pending) {
        if (env.step()) {
          radiancePolynomial(pending, scene.useRightHandedSystem, poly)
          pending = null
        }
      } else if (now - lastRefresh > REFRESH_MS) {
        lastRefresh = now
        pending = selfEnvRadiance(selfEnvInputsOf(worldPoly!, scene.useRightHandedSystem, celestial!, scene.environmentIntensity))
        env.begin(pending)
      }
    },
    dispose() {
      unbindAll()
      untrimAll()
      env?.dispose()
      env = null
    },
  }
}

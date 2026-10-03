/**
 * A studio environment for the character screens (character select and creation). Those scenes have no sky, so the
 * glTF PBR materials there had no image-based light at all, and a metal (the Copper Blade's pipeline set, blade1_5:
 * metallic near 1 and low roughness on the blade) reflected nothing but the highlights of the screen's lights: near
 * black.
 *
 * With the new look on (the effective render path is PBR: Medium and up), the scene gets a small studio cube for
 * reflections: world-render's SkyEnvironment (RGBA16F with prefiltered mips, filled once on the CPU; WebGPU and WebGL2
 * alike, no shader of its own) over a radiance that follows the screen's own lights, lit like a photo studio: the
 * hemispheric light's sky colour at the top, neutral walls, a lit stage floor, a soft box towards the key light and a
 * darker backdrop behind the character. Its level is the fill plus half the key (STUDIO_KEY_SHARE). The cube carries
 * an empty spherical polynomial, so it adds no diffuse light: the hemispheric light keeps giving the ambient and the
 * non-metals look as they did; what is new is the specular term.
 *
 * The cube is read linear (SkyEnvironment's default decode). The first cut of this studio was read as sRGB, Babylon's
 * default for a raw cube: the shader decoded the linear radiance with pow 2.2, so the dusk plaza's walls (≈ 0.3–0.5)
 * came back at 0.07–0.2 and the blade stayed near black at character select (the W9 release verify, both engines). In
 * the idle pose the blade is seen edge-on and mirrors the backdrop behind the character (measured with a
 * direction-coded cube), so what it shows is the walls' level times STUDIO_BACK. Read linear, at these constants, the
 * blade's luminance at character select matches the Classic path's (median 40–61 against Classic's 45, WebGL2, three
 * camera sways, two idle frames) and the hair stays dark brown (median 32 against 25; the rough hair's lobe averages the
 * whole studio, so a brighter studio greys it: fill + the whole key with a 0.25 backdrop lifted the hair to 37 and left
 * the blade no brighter). Character creation: blade median 49–78, hair 39–40.
 *
 * The Classic path (Low, or the 'preview' rollout with the toggle off) gets nothing: scene.environmentTexture stays
 * null, exactly as before. The choice follows settings changes (the Options menu is not on these screens, but a
 * settings blob can change under them) and goes with the scene.
 */
import { SphericalPolynomial, type DirectionalLight, type HemisphericLight, type Scene } from '@babylonjs/core'
import { SkyEnvironment, type RGB, type SkyCubeDecode } from '@sro/world-render'
import { settings } from '../settings.ts'
import { actorGraphics } from './actor-textures.ts'

/** Cube edge (texels): the gradient is smooth, so Medium's sky-cube size is plenty. */
export const STUDIO_CUBE_SIZE = 32
/** How the PBR shader reads the studio cube: linear (an sRGB read crushed the dusk studio to near black). */
export const STUDIO_DECODE: SkyCubeDecode = 'linear'
/** The studio's level: the fill's intensity plus this share of the key's (see the module comment). */
export const STUDIO_KEY_SHARE = 0.5
/** Horizon radiance as a share of the top's (a studio's neutral walls). */
export const STUDIO_HORIZON = 0.7
/** The stage floor's neutral bounce, as a share of the horizon (added to the fill's ground colour). */
export const STUDIO_FLOOR = 0.4
/** The soft box: its peak over the top radiance, and its half-angle (radians). */
export const STUDIO_SOFTBOX = { gain: 1.6, halfAngle: 0.7 } as const
/** The backdrop behind the character (away from the key), as a share of the lit front. */
export const STUDIO_BACK = 0.6

export interface StudioLights {
  /** The screen's fill: its diffuse (top) and groundColor (floor), times its intensity. */
  hemi: HemisphericLight
  /** The screen's key light: the soft box sits where it comes from. */
  key?: DirectionalLight | null
}

/** Linear radiance of the studio along a world direction (unit; the scene's axes). */
export type StudioRadiance = (x: number, y: number, z: number, out: RGB) => RGB

const smooth = (e0: number, e1: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/**
 * The studio's radiance from a top, a horizon and a floor colour, an optional soft box (`toKey`: the unit direction
 * towards the key light) and the backdrop: away from the key's horizontal direction the gradient falls to STUDIO_BACK.
 * Above the horizon the top blends in with height; below it the floor within ~12°.
 */
export function studioRadiance(o: { top: RGB; horizon: RGB; floor: RGB; toKey?: RGB | null; box?: RGB | null }): StudioRadiance {
  const cosEdge = Math.cos(STUDIO_SOFTBOX.halfAngle)
  const k = o.toKey
  const kh = k ? Math.hypot(k[0], k[2]) : 0
  const front: [number, number] | null = k && kh > 1e-3 ? [k[0] / kh, k[2] / kh] : null
  return (x, y, z, out) => {
    const up = smooth(0, 0.9, y)
    const down = smooth(0, 0.2, -y)
    const f = front ? STUDIO_BACK + (1 - STUDIO_BACK) * smooth(-0.5, 0.5, x * front[0] + z * front[1]) : 1
    for (let c = 0; c < 3; c++) {
      const h = o.horizon[c]!
      out[c] = (y >= 0 ? h + (o.top[c]! - h) * up : h + (o.floor[c]! - h) * down) * f
    }
    if (k && o.box) {
      const w = smooth(cosEdge, 1, x * k[0] + y * k[1] + z * k[2])
      if (w > 0) for (let c = 0; c < 3; c++) out[c] = out[c]! + o.box[c]! * w
    }
    return out
  }
}

/**
 * The studio of a screen's lights (see the module comment): the fill's colours at the fill's intensity plus
 * STUDIO_KEY_SHARE of the key's, neutral walls at STUDIO_HORIZON of the top, the floor's bounce, and the soft box in the
 * key's colour.
 */
export function studioOf(lights: StudioLights): StudioRadiance {
  const h = lights.hemi
  const key = lights.key
  const i = Math.max(0, h.intensity) + STUDIO_KEY_SHARE * Math.max(0, key?.intensity ?? 0)
  const top: RGB = [h.diffuse.r * i, h.diffuse.g * i, h.diffuse.b * i]
  const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  // Neutral walls (the top's level, not its tint), and the stage floor: the fill's ground colour plus a neutral bounce.
  const level = lum(top) * STUDIO_HORIZON
  const horizon: RGB = [level, level, level]
  const bounce = level * STUDIO_FLOOR
  const floor: RGB = [h.groundColor.r * i + bounce, h.groundColor.g * i + bounce, h.groundColor.b * i + bounce]
  let toKey: RGB | null = null
  let box: RGB | null = null
  if (key && key.intensity > 0) {
    const d = key.direction
    const l = Math.hypot(d.x, d.y, d.z) || 1
    toKey = [-d.x / l, -d.y / l, -d.z / l]
    const g = lum(top) * STUDIO_SOFTBOX.gain
    const kl = lum([key.diffuse.r, key.diffuse.g, key.diffuse.b]) || 1
    box = [(key.diffuse.r / kl) * g, (key.diffuse.g / kl) * g, (key.diffuse.b / kl) * g]
  }
  return studioRadiance({ top, horizon, floor, toKey, box })
}

/**
 * The studio environment of one character-screen scene: bound while the effective render path is PBR (`wanted`,
 * default: the page's settings on this engine), unbound otherwise; disposed with the scene.
 */
export class StudioEnvironment {
  private env: SkyEnvironment | null = null
  private readonly offSettings: () => void
  private disposed = false

  constructor(readonly scene: Scene, private readonly lights: StudioLights, private readonly wanted: () => boolean = () => actorGraphics(scene.getEngine()).render === 'pbr') {
    this.offSettings = settings.onChange(() => this.sync())
    scene.onDisposeObservable.addOnce(() => this.dispose())
    this.sync()
  }

  /** The bound cube (null on the Classic path, or on a headless engine). */
  get texture(): SkyEnvironment['texture'] {
    return this.env?.texture ?? null
  }

  /** Binds or unbinds the cube for the current settings. */
  sync(): void {
    if (this.disposed || this.scene.isDisposed) return
    const on = this.wanted()
    if (on && !this.env) {
      // Read linear: the studio's radiance is linear light (see the module comment; never 'srgb' here).
      const env = new SkyEnvironment(this.scene, STUDIO_CUBE_SIZE, this.scene.useRightHandedSystem, { decode: STUDIO_DECODE })
      env.begin(studioOf(this.lights))
      env.finish()
      if (env.texture) {
        env.texture.name = 'studioEnvironment'
        // No diffuse from the cube: the hemispheric light stays the ambient (see the module comment).
        env.texture.sphericalPolynomial = new SphericalPolynomial()
        this.scene.environmentTexture = env.texture
      }
      this.env = env
    } else if (!on && this.env) this.unbind()
  }

  private unbind(): void {
    const env = this.env
    this.env = null
    if (!env) return
    if (env.texture && this.scene.environmentTexture === env.texture) this.scene.environmentTexture = null
    env.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offSettings()
    this.unbind()
  }
}

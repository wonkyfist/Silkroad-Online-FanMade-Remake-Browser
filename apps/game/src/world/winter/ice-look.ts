/**
 * The ice look of the winter monsters (docs/WINTER.md §13.7). A snow spirit is a retail Water Ghost and the Ice Yeti a
 * retail Big-Eyed Ghost (a hulking ape) grown huge; their glbs, and so their materials, are shared with the ordinary
 * monsters of the same model. The look is a material plugin (SroIceLook) on that shared PBR material whose strength is
 * read per draw from the drawn mesh (`ICE_PARAMS`): every other mesh of the material binds amount 0 and draws as before.
 *
 * In the fragment shader, right after the albedo texture is read (whatever set it is: retail, sro-pbr or remaster),
 * the texel's luminance (× `gain`) picks a colour on a ramp from `dark` to `light` (white fur with blue-grey shadows,
 * or pale ice), so the texture's detail stays and its hue goes, with fine streaks along the texture's UVs (`fur`) that
 * break the smooth retail shading into a pelt; the retail self-glow is recoloured to `rim` (× `glow`)
 * and a fresnel rim of `rim` is added (a cold edge light; the spirits' "translucent" edge without alpha blending: the
 * bodies stay solid and keep their depth). The rim is divided by the scene's exposure, so it reads the same at noon and
 * at night. Nothing is cloned or derived per monster: no texture, no material, no per-frame allocation. Babylon cannot
 * remove an active plugin, so it stays on the material (inert at amount 0) until the material goes.
 *
 * An entity attachment: tags the actor's meshes when the model is in, re-scans every SCAN_FRAMES frames (a part merge
 * makes new meshes; the remastered texture set swaps a mesh's material for its own, which gets the plugin then), untags
 * them with the view.
 */
import { MaterialPluginBase, PBRMaterial, ShaderLanguage, type AbstractEngine, type AbstractMesh, type Material, type MaterialDefines, type Scene, type SubMesh, type UniformBuffer } from '@babylonjs/core'
import { sceneExposure } from '@sro/world-render'
import { WINTER_CODES } from '@sro/shared'
import type { EntityAttachment, EntityView } from '../entities.ts'

type RGB = readonly [number, number, number]

export interface IceLook {
  /** How much of the retail albedo turns to ice (0..1). */
  amount: number
  /** Linear albedo at the darkest and the brightest texel of the ramp. */
  dark: RGB
  light: RGB
  /** The texel luminance × this picks the ramp position (the retail textures are dark). */
  gain: number
  /** Fine strands along the texture's V (a pelt): ± half this of the colour, 0 = none. */
  fur: number
  /** The retail self-glow kept (recoloured to `rim`), 0..1. */
  glow: number
  /** The fresnel rim: linear colour, power (higher = thinner) and strength. */
  rim: RGB
  rimPower: number
  rimGain: number
}

/** The spirits: pale ice with a blue edge; the yeti: white fur, blue-grey in its folds, a faint frost on the edge. */
export const ICE_LOOKS: Readonly<Record<string, IceLook>> = {
  [WINTER_CODES.sprite]: { amount: 1, dark: [0.18, 0.36, 0.62], light: [0.78, 0.92, 1], gain: 4, fur: 0, glow: 1, rim: [0.45, 0.75, 1], rimPower: 2.2, rimGain: 0.75 },
  [WINTER_CODES.spirit]: { amount: 1, dark: [0.14, 0.3, 0.58], light: [0.72, 0.88, 1], gain: 4, fur: 0, glow: 1, rim: [0.4, 0.7, 1], rimPower: 2.2, rimGain: 0.85 },
  [WINTER_CODES.yeti]: { amount: 1, dark: [0.46, 0.48, 0.52], light: [1, 1, 1], gain: 5, fur: 0.4, glow: 0.5, rim: [0.6, 0.8, 1], rimPower: 3, rimGain: 0.22 },
}

export const ICE_PLUGIN = 'SroIceLook'
/** The attachment re-scans the actor's meshes this often (frames). */
export const SCAN_FRAMES = 10

/** The look of each tagged mesh (read per draw by the plugin). */
const ICE_PARAMS = new WeakMap<AbstractMesh, IceLook>()
const PLUGINS = new WeakMap<Material, IcePlugin>()

const LUMA_GLSL = 'vec3(0.2126, 0.7152, 0.0722)'
const LUMA_WGSL = 'vec3f(0.2126, 0.7152, 0.0722)'

const ALBEDO_GLSL = `
#ifdef SROICE
if (sroIceA.x > 0.0) {
  float iceL = clamp(dot(surfaceAlbedo, ${LUMA_GLSL}) * sroIceA.y, 0.0, 1.0);
  vec3 iceC = mix(sroIceD.rgb, sroIceB.rgb, sqrt(iceL));
#ifdef ALBEDO
  {
    vec2 iceU = vAlbedoUV * vec2(420.0, 36.0);
    float iceX = floor(iceU.x);
    float iceN = fract(sin((iceX + floor(iceU.y + fract(sin(iceX * 12.9898) * 43758.5453)) * 7.13) * 78.233) * 43758.5453);
    iceC = iceC * (1.0 + sroIceD.w * (iceN - 0.5));
  }
#endif
  surfaceAlbedo = mix(surfaceAlbedo, iceC, sroIceA.x);
}
#endif
`
const ALBEDO_WGSL = `
#ifdef SROICE
if (uniforms.sroIceA.x > 0.0) {
  let iceL = clamp(dot(surfaceAlbedo, ${LUMA_WGSL}) * uniforms.sroIceA.y, 0.0, 1.0);
  var iceC = mix(uniforms.sroIceD.rgb, uniforms.sroIceB.rgb, sqrt(iceL));
#ifdef ALBEDO
  {
    let iceU = fragmentInputs.vAlbedoUV * vec2f(420.0, 36.0);
    let iceX = floor(iceU.x);
    let iceN = fract(sin((iceX + floor(iceU.y + fract(sin(iceX * 12.9898) * 43758.5453)) * 7.13) * 78.233) * 43758.5453);
    iceC = iceC * (1.0 + uniforms.sroIceD.w * (iceN - 0.5));
  }
#endif
  surfaceAlbedo = mix(surfaceAlbedo, iceC, uniforms.sroIceA.x);
}
#endif
`
const EMISSIVE_GLSL = `
#ifdef SROICE
if (sroIceA.x > 0.0) {
  float iceE = dot(finalEmissive, ${LUMA_GLSL});
  finalEmissive = mix(finalEmissive, sroIceR.rgb * (iceE * sroIceB.w), sroIceA.x);
  float iceF = pow(1.0 - clamp(abs(dot(normalW, viewDirectionW)), 0.0, 1.0), sroIceA.z);
  finalEmissive += sroIceR.rgb * (iceF * sroIceA.w);
}
#endif
`
const EMISSIVE_WGSL = `
#ifdef SROICE
if (uniforms.sroIceA.x > 0.0) {
  let iceE = dot(finalEmissive, ${LUMA_WGSL});
  finalEmissive = mix(finalEmissive, uniforms.sroIceR.rgb * (iceE * uniforms.sroIceB.w), uniforms.sroIceA.x);
  let iceF = pow(1.0 - clamp(abs(dot(normalW, viewDirectionW)), 0.0, 1.0), uniforms.sroIceA.z);
  finalEmissive = finalEmissive + uniforms.sroIceR.rgb * (iceF * uniforms.sroIceA.w);
}
#endif
`

/** The shader injections per language (tests read them). */
export function iceCode(lang: 'glsl' | 'wgsl'): Record<string, string> {
  return {
    CUSTOM_FRAGMENT_UPDATE_ALPHA: lang === 'wgsl' ? ALBEDO_WGSL : ALBEDO_GLSL,
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: lang === 'wgsl' ? EMISSIVE_WGSL : EMISSIVE_GLSL,
  }
}

const ICE_UNIFORMS = ['sroIceA', 'sroIceD', 'sroIceB', 'sroIceR'] as const

/**
 * The plugin on a shared monster material. Priority 900: after the surface plugin (250), so the albedo it recolours is
 * the final one and the glow it recolours is the surface plugin's.
 */
export class IcePlugin extends MaterialPluginBase {
  private frame = -1
  private rimScale = 1

  constructor(material: Material) {
    super(material, ICE_PLUGIN, 900, { SROICE: false }, true, false)
    // hardBindForSubMesh (the per-draw look) is an extra event
    this.registerForExtraEvents = true
    this._enable(true)
  }

  override getClassName(): string {
    return ICE_PLUGIN
  }

  override isCompatible(): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines['SROICE'] = true
  }

  override getUniforms(shaderLanguage?: ShaderLanguage): { ubo: Array<{ name: string; size: number; type: string }>; fragment: string } {
    const glsl = shaderLanguage !== ShaderLanguage.WGSL
    return {
      ubo: ICE_UNIFORMS.map(name => ({ name, size: 4, type: 'vec4' })),
      fragment: glsl ? ICE_UNIFORMS.map(n => `uniform vec4 ${n};`).join('\n') : '',
    }
  }

  override hardBindForSubMesh(ubo: UniformBuffer, scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const p = ICE_PARAMS.get(subMesh.getMesh())
    if (!p) {
      ubo.updateFloat4('sroIceA', 0, 0, 1, 0)
      return
    }
    const f = scene.getFrameId()
    if (f !== this.frame) {
      this.frame = f
      const e = sceneExposure(scene)
      this.rimScale = e > 0 && Number.isFinite(e) ? 1 / e : 1
    }
    ubo.updateFloat4('sroIceA', p.amount, p.gain, p.rimPower, p.rimGain * this.rimScale)
    ubo.updateFloat4('sroIceD', p.dark[0], p.dark[1], p.dark[2], p.fur)
    ubo.updateFloat4('sroIceB', p.light[0], p.light[1], p.light[2], p.glow)
    ubo.updateFloat4('sroIceR', p.rim[0], p.rim[1], p.rim[2], 0)
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Record<string, string> | null {
    if (shaderType !== 'fragment') return null
    return iceCode(shaderLanguage === ShaderLanguage.WGSL ? 'wgsl' : 'glsl')
  }
}

/** The ice plugin of a PBR material, added on first use (null for any other material). */
export function icePluginFor(mat: Material | null): IcePlugin | null {
  if (!(mat instanceof PBRMaterial)) return null
  let p = PLUGINS.get(mat)
  if (!p) {
    p = new IcePlugin(mat)
    PLUGINS.set(mat, p)
  }
  return p
}

/** The look a mesh draws with now (tests, the console). */
export function iceLookOf(mesh: AbstractMesh): IceLook | undefined {
  return ICE_PARAMS.get(mesh)
}

/** The attachment for a winter monster's view (null for every other view). */
export function iceLook(v: EntityView): EntityAttachment | null {
  const look = v.state.kind === 'mob' ? ICE_LOOKS[v.state.model] : undefined
  if (!look) return null
  const mine = new Set<AbstractMesh>()
  let frames = 0

  const scan = () => {
    const actor = v.actor
    if (!actor) return
    for (const m of mine) if (m.isDisposed()) mine.delete(m)
    for (const m of actor.allMeshes() as AbstractMesh[]) {
      // the material is checked every time: the remastered set swaps it a moment after the model appears
      if (m.isDisposed() || !icePluginFor(m.material) || mine.has(m)) continue
      ICE_PARAMS.set(m, look)
      mine.add(m)
    }
  }

  return {
    loaded: scan,
    update() {
      if (++frames % SCAN_FRAMES === 0) scan()
    },
    dispose() {
      for (const m of mine) ICE_PARAMS.delete(m)
      mine.clear()
    },
  }
}

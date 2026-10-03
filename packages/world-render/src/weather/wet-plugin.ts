/**
 * The wet look on Classic-path materials (docs/WEATHER.md §6.3, §6.4, §6.7; docs/WAVE_PLAN3.md D19): a material plugin
 * for the world objects' StandardMaterials (ObjectMaterials.convert, through its decorator) and the characters' glTF
 * PBRMaterials (the game's ModelLibrary decorator, `attachWetness(mat, 'actor')`).
 *
 * - StandardMaterial: the diffuse darkens by the class porosity (`CUSTOM_FRAGMENT_UPDATE_DIFFUSE`; tops soak first,
 *   walls get 60 % with vertical streaks), and before fog the sky reflection (Fresnel × gloss, dimmer in baked shadow)
 *   and a sun glint are added (`CUSTOM_FRAGMENT_BEFORE_FOG`; the objects have no specular of their own). Static foliage
 *   on High+ sways with the weather wind (`CUSTOM_VERTEX_UPDATE_WORLDPOS`, WX_FOLIAGE).
 * - PBRMaterial (actors): the albedo darkens (`CUSTOM_FRAGMENT_UPDATE_ALBEDO`), the roughness drops toward 0.08
 *   (`UPDATE_METALLICROUGHNESS`, or `UPDATE_MICROSURFACE` on the specular workflow) and Babylon's own lighting makes
 *   the reflection; the lightning flash is an ambient lift (`BEFORE_FINALCOLORCOMPOSITION`).
 * - Everything is dry under a roof or a canopy: the shelter map is read at the fragment (`sroShelter`).
 *
 * The plugin is always attached (a weather change never recompiles) but its code sits behind `#ifdef WX`, which the
 * weather level sets (weather/index.ts marks every plugin dirty on a level change). It never wets a material that
 * carries a RENDER plugin (`SroSurfacePlugin` / `SroTerrainPlugin`, D19): checked on attach and again on every define
 * pass, whichever decorator ran first. WGSL on a WGSL material, GLSL otherwise, with the same injection points.
 *
 * A character material can carry both: WX-C's decorator wets it on the Classic path, and the live switch to the PBR
 * path (World.setRenderMode) adds RND-M's SroSurfacePlugin to the same material. The render plugin declares the
 * shelter uniforms and sampler too (`WX_SHELTER_UNIFORMS`, `wxOccMap`), and Babylon concatenates every plugin's UBO
 * members into one block: on WebGL2 the duplicate members fail the whole shader ("Duplicate field name in structure"),
 * so every player, mob and NPC vanished after turning the modern graphics on. So the plugin also yields its
 * declarations to a RENDER plugin on the same material (`renderDeclared`), exactly as it yields its code.
 */
import {
  MaterialPluginBase,
  PBRBaseMaterial,
  ShaderLanguage,
  StandardMaterial,
  type AbstractEngine,
  type AbstractMesh,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'
import { MATERIAL_CLASS_PARAMS, classify, isFoliageModel } from '../pbr/classes.ts'
import { WX_SHELTER_GLSL, WX_SHELTER_WGSL, WX_SWAY_GLSL, WX_SWAY_WGSL } from './chunks.ts'
import type { WeatherPreset } from './presets.ts'

/** What the plugin is on: world objects (thin-instance statics or skinned clones) or characters. */
export type WetSurfaceKind = 'static' | 'clone' | 'actor'

/** Plugin names of the RENDER path (D19): a material carrying one is wetted by it, never by this plugin. */
export const RENDER_WET_PLUGINS = ['SroSurfacePlugin', 'SroTerrainPlugin', 'SroSurface', 'SroTerrain'] as const

/** The plugin's name (one per material). */
export const WETNESS_PLUGIN = 'WetnessPlugin'

/** The weather the plugins read: the shared vectors and what the level turns on (weather/index.ts WorldWeather). */
export interface WetnessSource {
  readonly u: Readonly<Record<'wxA' | 'wxB' | 'wxC' | 'wxD' | 'wxE' | 'wxF' | 'wxCam' | 'wxOcc' | 'wxOccM', { x: number; y: number; z: number; w: number }>>
  readonly preset: Readonly<WeatherPreset>
  /** The shelter texture (null: none at this level) and whether it is RGBA8-packed. */
  shelterTexture(): { texture: BaseTexture; packed: boolean } | null
}

const sources = new WeakMap<Scene, WetnessSource>()
/** Every live plugin (a plugin leaves on its material's disposal). */
const live = new Set<WetnessPlugin>()

/**
 * The weather of a scene (set by WorldWeather; the plugins look it up when they bind, so a character loaded before the
 * world, or a new world after the character select, just works). Marks the scene's plugins dirty.
 */
export function setWetnessSource(scene: Scene, source: WetnessSource | null): void {
  if (source) sources.set(scene, source)
  else sources.delete(scene)
  markWetnessDirty(scene)
}

export function wetnessSourceOf(scene: Scene): WetnessSource | null {
  return sources.get(scene) ?? null
}

/** Re-runs the define pass of every plugin in `scene` (a weather level or shelter change; one recompile each). */
export function markWetnessDirty(scene: Scene): void {
  for (const p of live) if (p.scene === scene) p.markAllDefinesAsDirty()
}

/** The live plugins of a scene (tests, stats). */
export function wetnessPlugins(scene: Scene): WetnessPlugin[] {
  return [...live].filter(p => p.scene === scene)
}

const isRenderWetPlugin = (p: MaterialPluginBase) =>
  (RENDER_WET_PLUGINS as readonly string[]).includes(p.name) || /^Sro(Surface|Terrain)/.test(p.getClassName()) || /^Sro(Surface|Terrain)/.test(p.name)

/** The RENDER-path wet plugins on a material (D19). */
function renderWetPluginsOf(mat: Material): MaterialPluginBase[] {
  const list = (mat.pluginManager as unknown as { _plugins?: MaterialPluginBase[] } | null | undefined)?._plugins ?? []
  return list.filter(isRenderWetPlugin)
}

/** True when the material carries a RENDER-path wet plugin (D19). */
export function hasRenderWetPlugin(mat: Material): boolean {
  const pm = mat.pluginManager
  if (!pm) return false
  for (const n of RENDER_WET_PLUGINS) if (pm.getPlugin(n)) return true
  return renderWetPluginsOf(mat).length > 0
}

/**
 * The UBO members and samplers the RENDER-path wet plugins on `mat` declare in `lang` (empty sets without one). The
 * WetnessPlugin leaves these out of its own declarations: Babylon joins every plugin's members into one uniform block,
 * and a member declared twice fails the GLSL shader (the WGSL processor tolerates it).
 */
export function renderDeclared(mat: Material, lang: ShaderLanguage): { ubo: Set<string>; samplers: Set<string> } {
  const ubo = new Set<string>()
  const samplers: string[] = []
  for (const p of renderWetPluginsOf(mat)) {
    for (const u of p.getUniforms(lang)?.ubo ?? []) ubo.add(u.name)
    p.getSamplers(samplers)
  }
  return { ubo, samplers: new Set(samplers) }
}

/**
 * The UBO members and samplers every OTHER plugin on `mat` declares in `lang` (not only the RENDER wet plugins: RND-W's
 * SroFoliagePlugin declares `wxA`/`wxB` too). The WetnessPlugin yields all of them, so no reordering of decorators can
 * put one member into the block twice (the hotfix 4fae288's bug class).
 */
export function otherDeclared(mat: Material, lang: ShaderLanguage, self: MaterialPluginBase): { ubo: Set<string>; samplers: Set<string> } {
  const ubo = new Set<string>()
  const samplers: string[] = []
  const list = (mat.pluginManager as unknown as { _plugins?: MaterialPluginBase[] } | null | undefined)?._plugins ?? []
  for (const p of list) {
    if (p === self || p instanceof WetnessPlugin) continue
    for (const u of p.getUniforms(lang)?.ubo ?? []) ubo.add(u.name)
    p.getSamplers(samplers)
  }
  return { ubo, samplers: new Set(samplers) }
}

/** Wet response of a surface: porosity (albedo × (1 − 0.45 k) when soaked) and gloss (reflection strength). */
export interface WetParams {
  porosity: number
  gloss: number
}

/** WEATHER §6.4: foliage and characters; objects take their class (pbr/classes.ts, D27) with gloss = 1 − wet roughness. */
export const WET_FOLIAGE: Readonly<WetParams> = { porosity: 0.4, gloss: 0.5 }
export const WET_ACTOR: Readonly<WetParams> = { porosity: 0.35, gloss: 0.6 }

export function wetParamsFor(kind: WetSurfaceKind, hints: { texture?: string; name?: string; source?: string; alpha?: 'opaque' | 'mask' | 'blend' } = {}): WetParams {
  if (kind === 'actor') return { ...WET_ACTOR }
  if (hints.source && isFoliageModel(hints.source)) return { ...WET_FOLIAGE }
  const alphaMode = hints.alpha === 'mask' ? 'MASK' : hints.alpha === 'blend' ? 'BLEND' : 'OPAQUE'
  const c = MATERIAL_CLASS_PARAMS[classify(hints.texture ?? hints.name ?? '', { alphaMode })]
  return { porosity: c.porosity, gloss: Math.max(0, Math.min(1, 1 - c.wetRoughness)) }
}

const UBO = ['wxA', 'wxB', 'wxC', 'wxD', 'wxE', 'wxF', 'wxCam', 'wxOcc', 'wxOccM', 'wxMat'] as const
/** Bound per draw: the base set, plus the shelter placement when the shelter map is compiled in (wxMat separately). */
const UBO_BASE = ['wxA', 'wxB', 'wxC', 'wxD', 'wxE'] as const
const UBO_ALL = [...UBO_BASE, 'wxF', 'wxCam', 'wxOcc', 'wxOccM'] as const

/** The plugin's defines and their defaults (all off: weather Off compiles no plugin code). */
const DEFINES = { WX: false, WX_REFL: false, WX_SHELTER: false, WX_OCC8: false, WX_FOLIAGE: false }
type WetnessDefines = typeof DEFINES

// ---- shader code -------------------------------------------------------------------------------------------------

const DEFS_WGSL = /* wgsl */ `#ifdef WX
var<private> wxWet: f32;
#ifdef WX_SHELTER
${WX_SHELTER_WGSL}#endif
#endif
`
const DEFS_GLSL = /* glsl */ `#ifdef WX
float wxWet;
#ifdef WX_SHELTER
${WX_SHELTER_GLSL}#endif
#endif
`

// StandardMaterial, after the diffuse sample: tops soak first, walls get 60 % in vertical streaks (WEATHER §6.3). Before
// fog the sky reflection keeps a small floor (a wet roof or plaza shows a sheen from above too; the sky × 1.25).
const STD_DIFFUSE_WGSL = /* wgsl */ `#ifdef WX
wxWet = 0.0;
if (uniforms.wxA.x > 0.001) {
  var wxX = 1.0;
#ifdef WX_SHELTER
  wxX = sroShelter(fragmentInputs.vPositionW);
#endif
  let wxPw = fragmentInputs.vPositionW;
  let wxK = fract(sin(floor((wxPw.x * 1.3 + wxPw.z * 0.7) * 3.0) * 12.9898) * 43758.5453);
  let wxExp = mix(0.6 * mix(0.5, 1.0, wxK), 1.0, smoothstep(-0.2, 0.6, normalW.y));
  wxWet = clamp(uniforms.wxA.x, 0.0, 1.0) * wxX * wxExp;
  baseColor = vec4f(baseColor.rgb * mix(1.0, 1.0 - 0.45 * uniforms.wxMat.x, wxWet), baseColor.a);
}
#endif
`
const STD_DIFFUSE_GLSL = /* glsl */ `#ifdef WX
wxWet = 0.0;
if (wxA.x > 0.001) {
  float wxX = 1.0;
#ifdef WX_SHELTER
  wxX = sroShelter(vPositionW);
#endif
  float wxK = fract(sin(floor((vPositionW.x * 1.3 + vPositionW.z * 0.7) * 3.0) * 12.9898) * 43758.5453);
  float wxExp = mix(0.6 * mix(0.5, 1.0, wxK), 1.0, smoothstep(-0.2, 0.6, normalW.y));
  wxWet = clamp(wxA.x, 0.0, 1.0) * wxX * wxExp;
  baseColor.rgb *= mix(1.0, 1.0 - 0.45 * wxMat.x, wxWet);
}
#endif
`

const STD_FOG_WGSL = /* wgsl */ `#ifdef WX
if (wxWet > 0.001) {
  let wxNn = normalize(normalW);
  let wxRd = reflect(-viewDirectionW, wxNn);
  let wxFr = 0.02 + 0.98 * pow(1.0 - clamp(dot(wxNn, viewDirectionW), 0.0, 1.0), 5.0);
  let wxG = uniforms.wxMat.y * wxWet * 0.8;
  var wxLf = 1.0;
#ifdef LIGHTMAP
  wxLf = mix(0.55, 1.0, clamp(dot(lightmapColor.rgb, vec3f(0.299, 0.587, 0.114)), 0.0, 1.0));
#endif
#ifdef WX_REFL
  let wxSky = mix(uniforms.wxD.rgb, uniforms.wxC.rgb, clamp(wxRd.y, 0.0, 1.0)) * 1.25;
  color = vec4f(mix(color.rgb, wxSky * wxLf, clamp((wxFr + 0.08) * wxG, 0.0, 1.0)), color.a);
#endif
  let wxGl = uniforms.wxE.w * wxG * pow(max(dot(wxRd, uniforms.wxE.xyz), 0.0), 40.0) * 0.6 * wxLf;
  color = vec4f(color.rgb + vec3f(wxGl), color.a);
}
#endif
`
const STD_FOG_GLSL = /* glsl */ `#ifdef WX
if (wxWet > 0.001) {
  vec3 wxNn = normalize(normalW);
  vec3 wxRd = reflect(-viewDirectionW, wxNn);
  float wxFr = 0.02 + 0.98 * pow(1.0 - clamp(dot(wxNn, viewDirectionW), 0.0, 1.0), 5.0);
  float wxG = wxMat.y * wxWet * 0.8;
  float wxLf = 1.0;
#ifdef LIGHTMAP
  wxLf = mix(0.55, 1.0, clamp(dot(lightmapColor.rgb, vec3(0.299, 0.587, 0.114)), 0.0, 1.0));
#endif
#ifdef WX_REFL
  vec3 wxSky = mix(wxD.rgb, wxC.rgb, clamp(wxRd.y, 0.0, 1.0)) * 1.25;
  color.rgb = mix(color.rgb, wxSky * wxLf, clamp((wxFr + 0.08) * wxG, 0.0, 1.0));
#endif
  float wxGl = wxE.w * wxG * pow(max(dot(wxRd, wxE.xyz), 0.0), 40.0) * 0.6 * wxLf;
  color.rgb += vec3(wxGl);
}
#endif
`

// Static foliage (thin instances): the crown bends downwind with the height above the instance origin squared.
const STD_VERTEX_DEFS_WGSL = `#ifdef WX_FOLIAGE
${WX_SWAY_WGSL}#endif
`
const STD_VERTEX_DEFS_GLSL = `#ifdef WX_FOLIAGE
${WX_SWAY_GLSL}#endif
`
const STD_WORLDPOS_WGSL = /* wgsl */ `#ifdef WX_FOLIAGE
{
  let wxRoot = finalWorld[3].xyz;
  let wxH = clamp(worldPos.y - wxRoot.y, 0.0, 10.0);
  let wxWd = sroWind(wxRoot);
  let wxO = uniforms.wxB.xy * (clamp(uniforms.wxB.z, 0.0, 1.0) * wxH * wxH * 0.012 * wxWd.x);
  worldPos = vec4f(worldPos.x + wxO.x, worldPos.y, worldPos.z + wxO.y, worldPos.w);
}
#endif
`
const STD_WORLDPOS_GLSL = /* glsl */ `#ifdef WX_FOLIAGE
{
  vec3 wxRoot = finalWorld[3].xyz;
  float wxH = clamp(worldPos.y - wxRoot.y, 0.0, 10.0);
  vec3 wxWd = sroWind(wxRoot);
  vec2 wxO = wxB.xy * (clamp(wxB.z, 0.0, 1.0) * wxH * wxH * 0.012 * wxWd.x);
  worldPos.xz += wxO;
}
#endif
`

// PBRMaterial (actors): inside albedoOpacityBlock / reflectivityBlock (module-scope uniforms and inputs are visible).
const PBR_ALBEDO_WGSL = /* wgsl */ `#ifdef WX
wxWet = 0.0;
if (uniforms.wxA.x > 0.001) {
  var wxX = 1.0;
#ifdef WX_SHELTER
  wxX = sroShelter(fragmentInputs.vPositionW);
#endif
  wxWet = clamp(uniforms.wxA.x, 0.0, 1.0) * wxX;
  surfaceAlbedo = surfaceAlbedo * mix(1.0, 1.0 - 0.45 * uniforms.wxMat.x, wxWet);
}
#endif
`
const PBR_ALBEDO_GLSL = /* glsl */ `#ifdef WX
wxWet = 0.0;
if (wxA.x > 0.001) {
  float wxX = 1.0;
#ifdef WX_SHELTER
  wxX = sroShelter(vPositionW);
#endif
  wxWet = clamp(wxA.x, 0.0, 1.0) * wxX;
  surfaceAlbedo *= mix(1.0, 1.0 - 0.45 * wxMat.x, wxWet);
}
#endif
`
const PBR_ROUGH_WGSL = /* wgsl */ `#ifdef WX
metallicRoughness = vec2f(metallicRoughness.r, mix(metallicRoughness.g, 0.08, uniforms.wxMat.y * wxWet));
#endif
`
const PBR_ROUGH_GLSL = /* glsl */ `#ifdef WX
metallicRoughness.g = mix(metallicRoughness.g, 0.08, wxMat.y * wxWet);
#endif
`
const PBR_MICRO_WGSL = /* wgsl */ `#ifdef WX
microSurface = mix(microSurface, 0.92, uniforms.wxMat.y * wxWet);
#endif
`
const PBR_MICRO_GLSL = /* glsl */ `#ifdef WX
microSurface = mix(microSurface, 0.92, wxMat.y * wxWet);
#endif
`
const PBR_FLASH_WGSL = /* wgsl */ `#ifdef WX
finalAmbient = finalAmbient + surfaceAlbedo * (uniforms.wxC.w * 0.25);
#endif
`
const PBR_FLASH_GLSL = /* glsl */ `#ifdef WX
finalAmbient += surfaceAlbedo * (wxC.w * 0.25);
#endif
`

type Code = Record<string, string>

/** The injection points and code per material family, language and stage (the tests compare the key sets). */
export function wetnessCode(family: 'standard' | 'pbr', stage: 'vertex' | 'fragment', lang: 'wgsl' | 'glsl'): Code | null {
  const w = lang === 'wgsl'
  if (family === 'standard') {
    if (stage === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: w ? STD_VERTEX_DEFS_WGSL : STD_VERTEX_DEFS_GLSL,
        CUSTOM_VERTEX_UPDATE_WORLDPOS: w ? STD_WORLDPOS_WGSL : STD_WORLDPOS_GLSL,
      }
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: w ? DEFS_WGSL : DEFS_GLSL,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: w ? STD_DIFFUSE_WGSL : STD_DIFFUSE_GLSL,
      CUSTOM_FRAGMENT_BEFORE_FOG: w ? STD_FOG_WGSL : STD_FOG_GLSL,
    }
  }
  if (stage === 'vertex') return null
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: w ? DEFS_WGSL : DEFS_GLSL,
    CUSTOM_FRAGMENT_UPDATE_ALBEDO: w ? PBR_ALBEDO_WGSL : PBR_ALBEDO_GLSL,
    CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: w ? PBR_ROUGH_WGSL : PBR_ROUGH_GLSL,
    CUSTOM_FRAGMENT_UPDATE_MICROSURFACE: w ? PBR_MICRO_WGSL : PBR_MICRO_GLSL,
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: w ? PBR_FLASH_WGSL : PBR_FLASH_GLSL,
  }
}

// ---- the plugin --------------------------------------------------------------------------------------------------

export class WetnessPlugin extends MaterialPluginBase {
  readonly family: 'standard' | 'pbr'
  /** Porosity and gloss (wxMat.xy). */
  readonly params: WetParams
  readonly scene: Scene
  /** Code compiled in (the last define pass): WX or WX_FOLIAGE. Off: nothing reads the uniforms, so none are bound. */
  private active = false
  private shelterOn = false

  constructor(material: Material, readonly kind: WetSurfaceKind, params: WetParams, readonly foliage = false) {
    super(material, WETNESS_PLUGIN, 250, { ...DEFINES })
    this.family = material instanceof PBRBaseMaterial ? 'pbr' : 'standard'
    this.params = { porosity: params.porosity, gloss: params.gloss }
    this.scene = material.getScene()
    this._enable(true)
    live.add(this)
  }

  override getClassName(): string {
    return 'WetnessPlugin'
  }

  /** WGSL and GLSL both (the base class says GLSL only, and the plugin manager throws on a WGSL material). */
  override isCompatible(_shaderLanguage: ShaderLanguage): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines, _scene: Scene, _mesh: AbstractMesh): void {
    const d = defines as unknown as WetnessDefines
    const src = wetnessSourceOf(this.scene)
    const p = src?.preset
    const on = !!p?.wet && !hasRenderWetPlugin(this._material)
    const shelter = on ? src!.shelterTexture() : null
    d.WX = on
    d.WX_REFL = on && !!p?.reflection && this.family === 'standard'
    d.WX_SHELTER = !!shelter
    d.WX_OCC8 = !!shelter?.packed
    d.WX_FOLIAGE = !!p?.staticSway && this.foliage && this.kind === 'static' && this.family === 'standard' && !hasRenderWetPlugin(this._material)
    this.active = d.WX || d.WX_FOLIAGE
    this.shelterOn = d.WX_SHELTER
  }

  override getUniforms(shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL) {
    // Another plugin on the same material (a RENDER plugin after the live switch to PBR, or the foliage plugin) declares the shared members.
    const taken = otherDeclared(this._material, shaderLanguage, this).ubo
    const names = UBO.filter(n => !taken.has(n))
    const ubo = names.map(name => ({ name, size: 4, type: 'vec4' }))
    if (shaderLanguage === ShaderLanguage.WGSL) return { ubo }
    // GLSL without uniform buffers only (WebGL1; the UBO path ignores these).
    const decl = names.map(n => `uniform vec4 ${n};`).join('\n')
    return { ubo, vertex: `#ifdef WX_FOLIAGE\n${decl}\n#endif`, fragment: `#ifdef WX\n${decl}\n#endif` }
  }

  override getSamplers(samplers: string[]): void {
    if (!otherDeclared(this._material, this._material.shaderLanguage, this).samplers.has('wxOccMap')) samplers.push('wxOccMap')
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const src = wetnessSourceOf(this.scene)
    if (!src || !this.active) return
    const u = src.u
    for (const n of this.shelterOn ? UBO_ALL : UBO_BASE) {
      const v = u[n]
      ubo.updateFloat4(n, v.x, v.y, v.z, v.w)
    }
    ubo.updateFloat4('wxMat', this.params.porosity, this.params.gloss, 0, 0)
    const sh = this.shelterOn ? src.shelterTexture() : null
    if (sh) ubo.setTexture('wxOccMap', sh.texture)
  }

  override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    const lang = shaderLanguage === ShaderLanguage.WGSL ? 'wgsl' : 'glsl'
    return wetnessCode(this.family, shaderType === 'vertex' ? 'vertex' : 'fragment', lang)
  }

  override dispose(forceDisposeTextures?: boolean): void {
    live.delete(this)
    super.dispose(forceDisposeTextures)
  }
}

export interface AttachWetnessOptions {
  /** Porosity and gloss (default from the kind, the material's class, or the foliage rule). */
  params?: WetParams
  /** A tree, grass, flower or reed model (sways on High+ when static). */
  foliage?: boolean
  /** Hints for the class (pbr/classes.ts classify): the retail texture path and the model source. */
  texture?: string
  source?: string
  alpha?: 'opaque' | 'mask' | 'blend'
}

/**
 * Attaches the wetness plugin to a StandardMaterial or PBRMaterial (the actor decorator of WX-C, the object decorator
 * of WorldWeather). Returns the plugin, or null for a material it does not wet: another kind of material, one that
 * carries a RENDER-path plugin (D19), or one it is already on (then that plugin is returned).
 */
export function attachWetness(mat: Material, kind: WetSurfaceKind = 'actor', opts: AttachWetnessOptions = {}): WetnessPlugin | null {
  if (!(mat instanceof StandardMaterial) && !(mat instanceof PBRBaseMaterial)) return null
  const have = mat.pluginManager?.getPlugin(WETNESS_PLUGIN)
  if (have) return have as WetnessPlugin
  if (hasRenderWetPlugin(mat)) return null
  const foliage = opts.foliage ?? (!!opts.source && isFoliageModel(opts.source))
  const params = opts.params ?? wetParamsFor(kind, { texture: opts.texture, name: mat.name, source: opts.source, alpha: opts.alpha })
  try {
    return new WetnessPlugin(mat, kind, params, foliage)
  } catch (err) {
    console.warn('[weather] wetness plugin not attached to', mat.name, err)
    return null
  }
}

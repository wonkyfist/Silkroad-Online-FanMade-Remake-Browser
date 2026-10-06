/**
 * The snow material plugins (docs/WINTER.md §7.1): `SroSnowPlugin` on every PBR material (Medium and up) and
 * `SroSnowStdPlugin` on every StandardMaterial (Classic / Low objects and trees), both registered once with Babylon's
 * plugin factory and attached to the materials that already exist when a scene's SnowState is made.
 *
 * - PBR: priority 280, after the RENDER plugins (terrain 200, water 240, surface 250, foliage 260) and before the
 *   height fog (300). It reads the final world normal at CUSTOM_FRAGMENT_UPDATE_ALPHA (the terrain plugin writes its
 *   normal there first), lays the snow (winter/shaders.ts) and raises the roughness at UPDATE_METALLICROUGHNESS.
 *   Snow only where a RENDER plugin says "world": terrain, world objects (surface plugin, region batches, trees),
 *   foliage; never skinned meshes (characters, monsters), water or the ocean, unlit materials, or the self-lit lanterns
 *   and windows (their glow stays). The winter ice (metadata.snowIce) takes the ice branch.
 * - Standard: priority 280 at CUSTOM_FRAGMENT_UPDATE_DIFFUSE, on the world objects (the WetnessPlugin's materials or
 *   metadata.snowObj), the alpha-tested ones as foliage; never skinned meshes or the effects' materials.
 * - Off is no define and no code. The define changes only when the state's `on` flips (WorldWinter: when the first snow
 *   or frost arrives, and after it has all melted), one recompile per material then; the cover, the frost and the
 *   light change uniforms only, so nothing recompiles from frame to frame.
 */
import {
  MaterialPluginBase,
  PBRBaseMaterial,
  RegisterMaterialPlugin,
  ShaderLanguage,
  StandardMaterial,
  Vector4,
  type AbstractMesh,
  type Material,
  type MaterialDefines,
  type Scene,
  type UniformBuffer,
} from '@babylonjs/core'
import { snowPbrCode, snowStdCode } from './shaders.ts'

export const SNOW_PLUGIN = 'SroSnowPlugin'
export const SNOW_STD_PLUGIN = 'SroSnowStdPlugin'

/** The snow of one scene: the define gate and the shared uniform values (by reference into the Classic chunks too). */
export class SnowState {
  /** The define gate (WorldWinter flips it; `setOn`). */
  on = false
  /** x cover (× strength), y frost, z overcast, w night (winter/shaders.ts header). */
  readonly a = new Vector4(0, 0, 0, 0)
  /** PBR snow albedo (linear) and roughness. */
  readonly b = new Vector4(0.62, 0.63, 0.645, 0.85)
  /** Classic snow colour (display-referred, lit afterwards) and an unused w. */
  readonly bClassic = new Vector4(1.0, 1.01, 1.03, 0)
  readonly plugins = new Set<SroSnowPlugin>()
  readonly stdPlugins = new Set<SroSnowStdPlugin>()

  constructor(readonly scene: Scene) {}

  /** Turns the snow code on or off on every material of the scene (one define pass each, only on a change). */
  setOn(on: boolean): void {
    if (on === this.on) return
    this.on = on
    for (const p of this.plugins) p.markAllDefinesAsDirty()
    for (const p of this.stdPlugins) p.markAllDefinesAsDirty()
  }
}

const STATES = new WeakMap<Scene, SnowState>()

/** The scene's snow state (null: no winter in this scene). */
export function snowStateOf(scene: Scene): SnowState | null {
  return STATES.get(scene) ?? null
}

const pluginNames = (m: Material): Set<string> => {
  const list = (m.pluginManager as unknown as { _plugins?: MaterialPluginBase[] } | null | undefined)?._plugins ?? []
  return new Set(list.map(p => p.name))
}

const isSkinned = (mesh: AbstractMesh | undefined) => !!mesh?.skeleton || !!(mesh?.metadata as { snowSkip?: boolean } | null | undefined)?.snowSkip

const UBO = [
  { name: 'snwA', size: 4, type: 'vec4' },
  { name: 'snwB', size: 4, type: 'vec4' },
]

/** Snow on a PBR material (see the file comment). */
export class SroSnowPlugin extends MaterialPluginBase {
  constructor(material: Material, readonly state: SnowState) {
    super(material, SNOW_PLUGIN, 280, { SNOW: false, SNOW_T: false, SNOW_F: false, SNOW_I: false }, true, true)
    state.plugins.add(this)
  }

  override getClassName(): string {
    return SNOW_PLUGIN
  }

  override isCompatible(language: ShaderLanguage): boolean {
    return language === ShaderLanguage.WGSL || language === ShaderLanguage.GLSL
  }

  /** Whether this material (on `mesh`) takes snow at all. */
  eligible(mesh: AbstractMesh | undefined): { on: boolean; terrain: boolean; foliage: boolean; ice: boolean } {
    const m = this._material as PBRBaseMaterial
    const meta = (m.metadata ?? {}) as { snowIce?: boolean; snowObj?: boolean; snowFol?: boolean; snowSkip?: boolean }
    const names = pluginNames(m)
    const terrain = names.has('SroTerrainPlugin')
    const foliage = names.has('SroFoliagePlugin') || !!meta.snowFol
    const surf = this._material.pluginManager?.getPlugin<MaterialPluginBase & { lamp?: boolean; selfLit?: boolean }>('SroSurfacePlugin') ?? null
    const lit = !surf || (!surf.lamp && !surf.selfLit)
    const water = names.has('SroWaterPlugin') || names.has('SroOceanPlugin')
    const ice = !!meta.snowIce
    const world = terrain || foliage || !!surf || ice || !!meta.snowObj
    const on = world && lit && !water && !meta.snowSkip && !(m as unknown as { unlit?: boolean }).unlit && !isSkinned(mesh)
    return { on, terrain, foliage, ice }
  }

  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    const e = this.state.on ? this.eligible(mesh) : null
    const on = !!e?.on
    defines['SNOW'] = on
    defines['SNOW_I'] = on && e!.ice
    defines['SNOW_T'] = on && !e!.ice && e!.terrain
    defines['SNOW_F'] = on && !e!.ice && !e!.terrain && e!.foliage
  }

  override getUniforms(): { ubo: typeof UBO; fragment: string } {
    return { ubo: UBO, fragment: '#ifdef SNOW\nuniform vec4 snwA;\nuniform vec4 snwB;\n#endif\n' }
  }

  override bindForSubMesh(ubo: UniformBuffer): void {
    if (!this.state.on) return
    const { a, b } = this.state
    ubo.updateFloat4('snwA', a.x, a.y, a.z, a.w)
    ubo.updateFloat4('snwB', b.x, b.y, b.z, b.w)
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    return shaderType === 'fragment' ? snowPbrCode(language === ShaderLanguage.WGSL ? 'wgsl' : 'glsl') : null
  }

  override dispose(force?: boolean): void {
    this.state.plugins.delete(this)
    super.dispose(force)
  }
}

/** Material names of the effects, the sky, the markers: never snow (Classic). */
const STD_FX = /^(fx:|town|target|click|blocked|sky|shadow|batchShadow|default|pilot|storm|tornado|lightning|snow)/i

/** Snow on a Classic StandardMaterial (see the file comment). */
export class SroSnowStdPlugin extends MaterialPluginBase {
  constructor(material: Material, readonly state: SnowState) {
    super(material, SNOW_STD_PLUGIN, 280, { SNOWC: false, SNOWC_F: false, SNOWC_I: false }, true, true)
    state.stdPlugins.add(this)
  }

  override getClassName(): string {
    return SNOW_STD_PLUGIN
  }

  override isCompatible(language: ShaderLanguage): boolean {
    return language === ShaderLanguage.WGSL || language === ShaderLanguage.GLSL
  }

  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    const m = this._material as StandardMaterial
    const meta = (m.metadata ?? {}) as { snowIce?: boolean; snowObj?: boolean; snowSkip?: boolean }
    const world = !!m.pluginManager?.getPlugin('WetnessPlugin') || !!meta.snowObj || !!meta.snowIce
    const on = this.state.on && world && !meta.snowSkip && !isSkinned(mesh) && !STD_FX.test(m.name) && !m.disableLighting
    defines['SNOWC'] = on
    defines['SNOWC_I'] = on && !!meta.snowIce
    defines['SNOWC_F'] = on && !meta.snowIce && (m.needAlphaTesting() || !!m.diffuseTexture?.hasAlpha)
  }

  override getUniforms(): { ubo: typeof UBO; fragment: string } {
    return { ubo: UBO, fragment: '#ifdef SNOWC\nuniform vec4 snwA;\nuniform vec4 snwB;\n#endif\n' }
  }

  override bindForSubMesh(ubo: UniformBuffer): void {
    if (!this.state.on) return
    const { a, bClassic: b } = this.state
    ubo.updateFloat4('snwA', a.x, a.y, a.z, a.w)
    ubo.updateFloat4('snwB', b.x, b.y, b.z, b.w)
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    return shaderType === 'fragment' ? snowStdCode(language === ShaderLanguage.WGSL ? 'wgsl' : 'glsl') : null
  }

  override dispose(force?: boolean): void {
    this.state.stdPlugins.delete(this)
    super.dispose(force)
  }
}

/**
 * Registers the factories (again on every install: Babylon clears every global plugin when its last engine is disposed,
 * e.g. a GPU-loss engine rebuild, so a once-only flag would lose the snow on the next engine; re-registering a name
 * replaces its entry).
 */
function ensureRegistered(): void {
  RegisterMaterialPlugin(SNOW_PLUGIN, material => {
    const s = STATES.get(material.getScene())
    return s && material instanceof PBRBaseMaterial ? new SroSnowPlugin(material, s) : null
  })
  RegisterMaterialPlugin(SNOW_STD_PLUGIN, material => {
    const s = STATES.get(material.getScene())
    return s && material instanceof StandardMaterial ? new SroSnowStdPlugin(material, s) : null
  })
}

/** Attaches the right snow plugin to one material (idempotent; null for other material kinds or without a state). */
export function attachSnow(material: Material): MaterialPluginBase | null {
  const s = STATES.get(material.getScene())
  if (!s) return null
  if (material instanceof PBRBaseMaterial) return material.pluginManager?.getPlugin<SroSnowPlugin>(SNOW_PLUGIN) ?? new SroSnowPlugin(material, s)
  if (material instanceof StandardMaterial) return material.pluginManager?.getPlugin<SroSnowStdPlugin>(SNOW_STD_PLUGIN) ?? new SroSnowStdPlugin(material, s)
  return null
}

/**
 * The scene's snow state, made on the first call (World's constructor, through WorldWinter): new PBR and Standard
 * materials get their plugin at creation (the factory), the existing world materials now.
 */
export function installSnow(scene: Scene): SnowState {
  ensureRegistered()
  let s = STATES.get(scene)
  if (s) return s
  s = new SnowState(scene)
  STATES.set(scene, s)
  for (const m of scene.materials) if (m instanceof PBRBaseMaterial || m instanceof StandardMaterial) attachSnow(m)
  return s
}

/** Drops the scene's state (World disposal): the plugins stay on their materials, switched off. */
export function uninstallSnow(scene: Scene): void {
  const s = STATES.get(scene)
  if (!s) return
  s.setOn(false)
  STATES.delete(scene)
}

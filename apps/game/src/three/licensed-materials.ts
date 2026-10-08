// Licensed characters (docs/CHARACTERS.md §16.1): the material pass the glTF cannot carry. The converter writes the
// pack's maps as plain glTF PBR (base colour sRGB; normal, occlusion/roughness/metallic linear); here, by material name:
// - skin (MAT_HEAD, MAT_BODY): F0 0.028 (metallicF0Factor 0.7 of glTF's 0.04), the scattering warmth baked into the
//   albedo by the converter, a soft warm sheen at grazing angles (the rim a scattering skin shows);
// - eyes: a wet cornea (clear coat, IOR 1.376, near-mirror) over the iris/sclera map;
// - lashes: alpha-tested and blended (no hard black outline);
// - hair: two passes, an alpha-tested core (depth, shadows) and a blended soft pass for the strand tips, with an
//   anisotropic highlight along the strands (the cards run along V);
// - every texture: anisotropic filtering 8 (mipmaps are the loader's default).
// Own character only (the licensed body is never in the crowd), so the extra passes cost one actor.
import { Color3, GetClass, MaterialPluginBase, Mesh, PBRMaterial, ShaderLanguage, Texture, Vector2, type AbstractMesh, type BaseTexture, type Material, type MaterialDefines } from '@babylonjs/core'
import { PERF } from '../world/perf.ts'

/** glTF's dielectric F0 is 0.04; skin's is ≈ 0.028. */
export const SKIN_F0_FACTOR = 0.7
export const SKIN_SHEEN = { intensity: 0.1, color: [1, 0.72, 0.58] as [number, number, number], roughness: 0.55 }
export const CORNEA = { intensity: 1, roughness: 0.03, ior: 1.376 }
export const SCLERA_TINT = [1, 0.97, 0.93] as [number, number, number]
export const HAIR_ANISOTROPY = 0.65
export const TEXTURE_ANISOTROPY = 8
/** §16.3: the lashes' albedo × this (near-black line). */
export const LASH_TINT = 0.35
/** §16.3: hair F0 × this: a clean black sheen instead of a grey env glaze. */
export const HAIR_F0_FACTOR = 0.45

/**
 * §16.7: the skin's scattering term, a cheap stand-in for pre-integrated skin shading: the DIFFUSE part of every point,
 * spot and directional light takes a per-channel wrap, N·L → (N·L + w_c) / (1 + w_c), with red wrapping furthest. Light
 * that scatters under the skin comes back out past the geometric terminator, mostly in red: the shadow edge of a
 * cheek, the nose's flank, the brow's underside roll off softly and warm (the UE renders' subsurface profile) instead of
 * cutting a hard, grey line. Facing the light it is unchanged (energy-neutral there).
 *
 * Diffuse only (§16.7): the §16.5 version rewrote `result.NdotL` in the light setup, which also fed the GGX specular and
 * its visibility term, so a skin lit from behind still caught specular past its terminator.
 */
export const SKIN_SCATTER: readonly [number, number, number] = [0.42, 0.2, 0.13]
const SKIN_WRAP_PLUGIN = 'SroSkinWrap'
/** The diffuse return of Babylon's `computeDiffuseLighting` (pbrDirectLightingFunctions, GLSL and WGSL alike). */
export const SKIN_DIFFUSE_POINT = String.raw`!return diffuseTerm\*info\.attenuation\*info\.NdotL\*lightColor;\}`

export function skinDiffuseCode(lang: 'glsl' | 'wgsl', w: readonly [number, number, number] = SKIN_SCATTER): string {
  const v = w.map(x => x.toFixed(3)).join(',')
  return lang === 'wgsl'
    ? `let sroW=vec3f(${v});return diffuseTerm*info.attenuation*clamp((vec3f(info.NdotLUnclamped)+sroW)/(1.0+sroW),vec3f(0.0),vec3f(1.0))*lightColor;}`
    : `vec3 sroW=vec3(${v});return diffuseTerm*info.attenuation*clamp((vec3(info.NdotLUnclamped)+sroW)/(1.0+sroW),0.0,1.0)*lightColor;}`
}

export class SkinWrapPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, SKIN_WRAP_PLUGIN, 200, { SROSKINWRAP: false }, true, true)
  }

  override getClassName(): string {
    return SKIN_WRAP_PLUGIN
  }

  /** WGSL and GLSL both. */
  override isCompatible(): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines): void {
    const d = defines as MaterialDefines & Record<string, unknown>
    if (d.SROSKINWRAP !== PERF.faceLight) {
      d.SROSKINWRAP = PERF.faceLight
      defines.markAsUnprocessed()
    }
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Record<string, string> | null {
    // off: no code (the define's flip recompiles)
    if (shaderType !== 'fragment' || !PERF.faceLight) return null
    // a regex point (Babylon: '!' prefix) on the code after includes
    return { [SKIN_DIFFUSE_POINT]: skinDiffuseCode(shaderLanguage === ShaderLanguage.WGSL ? 'wgsl' : 'glsl') }
  }
}

export type LicensedMaterialRole = 'skin' | 'eye' | 'lashes' | 'hair' | 'cloth' | 'other'

export function licensedMaterialRole(name: string): LicensedMaterialRole {
  if (/^MAT_(HEAD|BODY)$/.test(name)) return 'skin'
  if (/^MAT_EYES?_[LR]$/.test(name)) return 'eye'
  if (name === 'MAT_LASHES') return 'lashes'
  if (name === 'MAT_HAIR') return 'hair'
  if (/^MAT_CLOTHES/.test(name)) return 'cloth'
  return 'other'
}

/** Tunes the licensed body's materials in place and adds the hair's soft pass. Returns the meshes it added. */
export function tuneLicensedMaterials(meshes: readonly AbstractMesh[], decorate?: (mat: Material) => void): AbstractMesh[] {
  const done = new Set<PBRMaterial>()
  const added: AbstractMesh[] = []
  for (const mesh of meshes) {
    const mat = mesh.material
    if (!(mat instanceof PBRMaterial)) continue
    const role = licensedMaterialRole(mat.name)
    if (!done.has(mat)) {
      done.add(mat)
      // the own character's key light (world/features/self-key.ts) on top of the world's lights
      mat.maxSimultaneousLights = Math.max(mat.maxSimultaneousLights, 8)
      for (const t of mat.getActiveTextures() as BaseTexture[]) t.anisotropicFilteringLevel = TEXTURE_ANISOTROPY
      tune(mat, role)
    }
    // hair cards and lashes cast no shadow (the shadow map draws their whole quads: hard pale/dark rectangles on the
    // face, CHARACTERS §16.3); the head and body still shadow themselves
    // and the head itself (head, teeth, caruncle, eyes): at the sun's 1024² two-cascade map its self-shadow broke into
    // pale and dark blocks on the cheeks and forehead (acne; tested: head no-cast or 3× bias clears it, the world's bias
    // stays). The body and clothes still cast (the figure's shadow on the ground keeps its shape bar the head).
    // (on the material too: every body of this file shares it, also one this pass never saw)
    if (role === 'hair' || role === 'lashes' || role === 'eye' || mat.name === 'MAT_HEAD') {
      mesh.metadata = { ...(mesh.metadata as object | null), sroNoCast: true }
      mat.metadata = { ...(mat.metadata as object | null), sroNoCast: true }
    }
    // the soft pass is LOD0's (a lower LOD, CHARACTERS §16.8, keeps the alpha-tested core only)
    if (role === 'hair' && mesh instanceof Mesh && licensedLodOf(mesh) === 0) added.push(softHairPass(mesh, mat, decorate))
  }
  return added
}

function tune(mat: PBRMaterial, role: LicensedMaterialRole): void {
  switch (role) {
    case 'skin': {
      mat.metallicF0Factor = SKIN_F0_FACTOR
      // no translucency: without a thickness map the sun through the head turned the whole face orange (tested);
      // the scattering warmth is in the albedo (licensed-char.ts skin grade) and this sheen
      mat.sheen.isEnabled = true
      mat.sheen.intensity = SKIN_SHEEN.intensity
      mat.sheen.color = new Color3(...SKIN_SHEEN.color)
      mat.sheen.roughness = SKIN_SHEEN.roughness
      if (!mat.pluginManager?.getPlugin(SKIN_WRAP_PLUGIN)) new SkinWrapPlugin(mat)
      break
    }
    case 'eye':
      mat.clearCoat.isEnabled = true
      mat.clearCoat.intensity = CORNEA.intensity
      mat.clearCoat.roughness = CORNEA.roughness
      mat.clearCoat.indexOfRefraction = CORNEA.ior
      // §16.5: a faintly warm sclera (the renders' eye white is never a cold paper white)
      mat.albedoColor = new Color3(...SCLERA_TINT)
      break
    case 'lashes':
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATESTANDBLEND
      mat.alphaCutOff = 0.08
      mat.backFaceCulling = false
      mat.useAlphaFromAlbedoTexture = true
      // a darker lash line (the renders' lashes read near-black; the pack's map is a mid grey UE tints)
      mat.albedoColor = new Color3(LASH_TINT, LASH_TINT, LASH_TINT)
      break
    case 'hair':
      // the core: alpha-tested at 0.5, writes depth (the soft pass and the shadows rely on it)
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      mat.alphaCutOff = 0.5
      mat.backFaceCulling = false
      mat.metallicF0Factor = HAIR_F0_FACTOR
      mat.anisotropy.isEnabled = true
      mat.anisotropy.intensity = HAIR_ANISOTROPY
      mat.anisotropy.direction = new Vector2(0, 1)
      break
  }
}

/**
 * The LOD a part of a licensed body belongs to (CHARACTERS §16.8): the converter's `<part>__LOD1` / `__LOD2` meshes
 * (or a primitive under such a node), else 0.
 */
export function licensedLodOf(mesh: AbstractMesh): number {
  const m = /__LOD(\d)/.exec(mesh.name) ?? /__LOD(\d)/.exec(mesh.parent?.name ?? '')
  return m ? Number(m[1]) : 0
}

/** The hair's blended pass: the same cards, alpha-blended without depth writes, drawn after the opaque core. */
const softOf = new WeakMap<PBRMaterial, PBRMaterial>()

/**
 * A clone of `mat` without the plugins Babylon cannot re-create by class name (the world's surface plugin, attached by
 * the library's decorators: cloning a decorated material threw for every Waterbender loaded after the world was up).
 * The caller decorates the copy again.
 */
export function cloneUndecorated(mat: PBRMaterial, name: string): PBRMaterial {
  const plugins = (mat.pluginManager as unknown as { _plugins?: MaterialPluginBase[] } | undefined)?._plugins ?? []
  const skipped = plugins.filter(p => !p.doNotSerialize && !GetClass('BABYLON.' + p.getClassName()))
  for (const p of skipped) p.doNotSerialize = true
  try {
    return mat.clone(name) as PBRMaterial
  } finally {
    for (const p of skipped) p.doNotSerialize = false
  }
}

function softHairPass(mesh: Mesh, core: PBRMaterial, decorate?: (mat: Material) => void): Mesh {
  // one soft material per core (a second body of the same file shares it: cloning a material the world's surface
  // plugin is already attached to fails, and two copies would only cost a pipeline)
  let soft = softOf.get(core)
  if (!soft) {
    soft = cloneUndecorated(core, core.name + '_soft')
    soft.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND
    soft.useAlphaFromAlbedoTexture = true
    soft.alphaCutOff = 0
    soft.disableDepthWrite = true
    soft.backFaceCulling = false
    softOf.set(core, soft)
    decorate?.(soft)
  }
  const m = mesh.clone(mesh.name + '_soft', mesh, true) as Mesh
  m.position.setAll(0)
  m.rotationQuaternion = null
  m.rotation.setAll(0)
  m.scaling.setAll(1)
  m.skeleton = mesh.skeleton
  m.material = soft
  m.alphaIndex = 1
  m.alwaysSelectAsActiveMesh = true
  m.metadata = { ...(m.metadata as object | null), sroNoCast: true }
  m.isPickable = false
  return m
}

/**
 * The head's makeup variant (CHARACTERS §16.3; the creator's later choice): swaps the head's base colour for one of the
 * maps the converter wrote (`faces/<g>_<v>.jpg`, `?ncface=`). The glb's own map stays (other bodies share it).
 * Resolves false when the map does not load.
 */
export function setLicensedFace(meshes: readonly AbstractMesh[], url: string): Promise<boolean> {
  const mat = meshes.map(m => m.material).find((m): m is PBRMaterial => m instanceof PBRMaterial && licensedMaterialRole(m.name) === 'skin' && m.name === 'MAT_HEAD')
  if (!mat) return Promise.resolve(false)
  return new Promise(resolve => {
    const old = mat.albedoTexture as Texture | null
    const t = new Texture(url, mat.getScene(), { invertY: false, onLoad: () => {
      t.anisotropicFilteringLevel = TEXTURE_ANISOTROPY
      if (old) t.coordinatesIndex = old.coordinatesIndex
      mat.albedoTexture = t
      resolve(true)
    }, onError: () => resolve(false) })
  })
}

/**
 * A per-look copy of a licensed material (three/licensed-look.ts, CHARACTERS §16.10) gets the pass again: the clone
 * leaves the skin's wrap plugin behind (cloneUndecorated), the rest is idempotent.
 */
export function retuneLicensedMaterial(mat: PBRMaterial): void {
  tune(mat, licensedMaterialRole(mat.name))
}

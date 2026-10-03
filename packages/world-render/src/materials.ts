import {
  Color3,
  Observable,
  PBRMaterial,
  StandardMaterial,
  Texture,
  type AssetContainer,
  type BaseTexture,
  type Material,
  type Scene,
} from '@babylonjs/core'
import { mimeOf, type Assets } from './assets.ts'
import type { BatchClass } from './batch/types.ts'
import { classParams, isFoliageModel, type MaterialClass } from './pbr/classes.ts'
import { applyMapRecord, loadPbrMapIndex, releaseMaps, urlMapSource, type AppliedMaps, type PbrMapIndex, type PbrMapRecord } from './pbr/maps.ts'
import { PbrSurfaces, SroSurfacePlugin } from './pbr/surface-plugin.ts'
import { useWindowedLightFalloff } from './render/babylon-fixes.ts'
import { UvScrollShared, uvScrollOf, type UvScroll } from './uv-scroll.ts'
import type { WorldModelCloth } from '../../convert/src/world/manifest.ts'

/** The sidecar fields this module reads (gltf/convert.ts SidecarMaterial). */
export interface SidecarMaterialLite {
  name: string
  flags: number
  diffuse: number[]
  ambient: number[]
  /**
   * The retail texture path as stored (backslashes, any case; null when the material has none). Wave 9: the join
   * key from a glb image to its `sro-pbr` set (TEXPIPE `keyOf`, docs/WAVE_PLAN3.md D35).
   */
  texture?: string | null
  /** The glTF alpha mode the converter chose. */
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'
  /**
   * Wave 11 (TOWN_LIFE §5.1, F1; WAVE_PLAN7 §4.3 step 2): the converter's cloth reclass (TL-M, `world/town/cloth.ts`):
   * the material sways with this kind in the region batch's `+sheen` group, and takes the cloth class on the PBR path.
   * Absent (every export before TL-M): today's material and merge.
   */
  cloth?: ClothKind
  /**
   * Wave 11: the cloth's pin height and hanging height (m, the model's space: [pinY, height]) where the primitive's own
   * bounds would not do (a banner whose pole is in the same primitive); absent: from the primitive's bounds.
   */
  clothPin?: [number, number]
  /**
   * Wave 12 (UV scroll): the retail texture scroll (the BSR's `texAni` per-second transform, translation only): texture
   * repeats per second along [U, V], glTF UV space. Absent (every export before it, and every material that does not
   * scroll): a still texture. Read through `uvScrollOf` (validated).
   */
  uvScroll?: [number, number]
}

/** How a cloth piece sways (TOWN_LIFE §5.1; packages/shared town.ts TownClothKind): pinned along the top, along its high edge, or at the base. */
export type ClothKind = 'hanging' | 'awning' | 'tent'

/** The cloth kinds; a kind's shader code is its index + 1 (0 = no sway: a `+sheen` piece without a cloth record). */
export const CLOTH_KINDS: readonly ClothKind[] = ['hanging', 'awning', 'tent']

/** The shader's code of a cloth kind (CLOTH_KINDS index + 1), 0 for none or an unknown kind. */
export function clothKindCode(kind: string | null | undefined): number {
  return kind ? CLOTH_KINDS.indexOf(kind as ClothKind) + 1 : 0
}

/** A converted material's cloth (the batch record's): its kind and the converter's pin, if any. */
export interface ClothRecord {
  readonly kind: ClothKind
  /** [pinY, height] in the model's space (SidecarMaterialLite.clothPin), or null: the primitive's bounds. */
  readonly pin: readonly [number, number] | null
}

/** The cloth of a sidecar material (null: none, or an unknown kind). */
export function clothOf(side: Pick<SidecarMaterialLite, 'cloth' | 'clothPin'> | undefined): ClothRecord | null {
  if (!side || !clothKindCode(side.cloth)) return null
  const p = side.clothPin
  const pin = Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0 ? [p[0], p[1]] as const : null
  return { kind: side.cloth!, pin }
}

export interface SidecarLite {
  materials?: SidecarMaterialLite[]
}

/** BMT flag 0x8: unlit / self-illuminated (packages/formats bmt.ts BMT_FLAG.selfIlluminated). */
const BMT_SELF_ILLUMINATED = 0x8
/** NL's lamp models (night-lights.ts): every lit material of a model whose file name matches gets NL's night glow. */
export const LAMP_MODEL = /lamp|_light/i
/** On a model that owns a night emitter (ambient.json), NL lights the materials whose name matches this. */
export const LAMP_MATERIAL = /light/i
/** Jangan object BMTs: diffuse = ambient = 150/255 (TERRAIN.md 3.2). */
const DEFAULT_MAT = 150 / 255

/** A model whose file name (the last path part of `source`) is a lamp's (LAMP_MODEL). */
export function isLampModel(source: string): boolean {
  return LAMP_MODEL.test(source.split(/[\\/]/).pop() ?? '')
}

/**
 * NL's lamp rule (docs/BATCHING.md §3.7, F9; one function for night-lights.ts and `batchClass`, so a lamp is never
 * merged dark): a material glows at night when its model is a lamp model, or when its model owns a night emitter and
 * the material's name says light. The caller skips self-illuminated (unlit) materials, which glow already.
 */
export function lampRule(source: string, materialName: string, nightOwner: boolean): boolean {
  return isLampModel(source) || (nightOwner && LAMP_MATERIAL.test(materialName))
}

/**
 * What the batcher needs to know of one converted material (docs/BATCHING.md §3.2, BT-0): made by ObjectMaterials
 * .convert on both paths, read-only for everyone else (converted materials are never modified by the batcher, §4.5).
 * The textures, class parameters and flags themselves are the material's (`material.albedoTexture`, the surface
 * plugin's `surf`); the record says what they mean.
 */
export interface MaterialBatchRecord {
  readonly material: ObjectMaterial
  /** The path it was converted on (only 'pbr' records are ever batched). */
  readonly path: MaterialPath
  /** The model it belongs to ('' / 'static' when the caller did not say). */
  readonly model: ConvertModelInfo
  /** The glTF (retail) material name: NL's lamp rule tests it. */
  readonly name: string
  /** The retail texture path (TX-R key; null when unknown). */
  readonly texture: string | null
  /** The surface class (null on the Classic path and for unlit materials). */
  readonly cls: MaterialClass | null
  /** BMT 0x8: unlit / self-illuminated. */
  readonly unlit: boolean
  readonly alpha: 'opaque' | 'mask' | 'blend'
  /** Two-sided (no back-face culling): merged twice, the back copy with reversed winding (§3.1). */
  readonly twoSided: boolean
  /** The object lightmap's URI (null: none). */
  readonly lightmap: string | null
  /** A lamp model's material (SroSurfacePlugin selfLit): NL's night glow. */
  readonly lampModel: boolean
  /** A retail emissive colour (the luxury-house tiger): the lamp group's emissive path. */
  readonly emissive: boolean
  /** TX-R's map set on the material (null: none); BT-A rewrites the slot when it swaps in (`onMapsChanged`). */
  readonly maps: AppliedMaps | null
  /**
   * Wave 11 (W11-S, TOWN_LIFE §5.1): the converter's cloth reclass (SidecarMaterialLite.cloth) on a lit PBR material:
   * the region batch gives its pieces a per-piece cloth pivot in the `+sheen` group. Absent or null: none (today).
   */
  readonly cloth?: ClothRecord | null
  /**
   * H-12 TRL-1: where the material has no albedo texture of its own (a species' LOD0 `near.glb` carries the texture
   * keys only, TREES WF19), the texture its slot reads instead: the species' `far.glb` sprite of the same key (or TX-R's
   * map that replaced it). Absent: none (every other record).
   */
  albedoFallback?: () => BaseTexture | null
  /**
   * H-12 TRL-3: a crown tint's record (batch/trees.ts TreeTints) names the species record it tints, so its slot follows
   * the base's TX-R tier (the tint set's own map at the same tier) and is refreshed with it.
   */
  readonly tintOf?: MaterialBatchRecord
  /**
   * Wave 12 (UV scroll): the material's retail texture scroll (SidecarMaterialLite.uvScroll, validated), or absent. A
   * scrolling material is never merged into the table (its atlas cell cannot move): `batchClass` says separate.
   */
  readonly uvScroll?: UvScroll
}

/**
 * The batcher's decision for one material (docs/BATCHING.md §3.7): Classic, unlit (glows) and alpha-blended materials
 * stay separate draws, and so do scrolling materials (UV scroll: the converted material keeps its plugin); NL's lamps (`lampRule`, with `nightOwner` from NL's ambient index) and retail emissive
 * materials go to the region's lamp group; everything else merges.
 */
export function batchClass(r: MaterialBatchRecord, nightOwner = false): BatchClass {
  if (r.path !== 'pbr' || r.unlit || r.alpha === 'blend' || r.material.alpha < 1) return 'separate'
  // UV scroll: the converted material carries the scroll plugin; a table slot would freeze it.
  if (r.uvScroll) return 'separate'
  if (r.lampModel || r.emissive || lampRule(r.model.source, r.name, nightOwner)) return 'lamp'
  return 'merge'
}

interface LightmapExtras {
  path: string
  uri: string | null
  texCoord: number
}

export type LightmapMode = 0 | 1 | 2

/** Which material path ObjectMaterials.convert builds (docs/WAVE_PLAN3.md D4: Classic = Low, PBR = Medium+). */
export type MaterialPath = 'classic' | 'pbr'

/** What a material decorator is told about each converted material. */
export interface MaterialDecoratorInfo {
  /** The model's glb path (manifest-relative); '' when the caller did not say. */
  model: string
  /** The model's retail source path (manifest WorldModel.source); '' when unknown. */
  source: string
  /** 'static' = thin-instance chunks, 'clone' = skinned clones (animated trees, flowers, lanterns). */
  kind: 'static' | 'clone'
  /** BMT 0x8 self-illuminated (lanterns, glows). */
  unlit: boolean
  alpha: 'opaque' | 'mask' | 'blend'
  /** The retail texture path (SidecarMaterialLite.texture), when known. */
  texture?: string
}

/**
 * Runs on every material ObjectMaterials.convert creates, right after it is created, both paths (whole-world load and
 * streaming). Wave 9 seam (docs/WAVE_PLAN3.md §4.1): WX-R `attachWetness`, NL's lamp emissive rule, RND-M's extras.
 */
export type MaterialDecorator = (mat: Material, info: MaterialDecoratorInfo) => void

/** The model a convert() call is for (optional: callers that do not say get '' / 'static'). */
export interface ConvertModelInfo {
  model: string
  source: string
  kind: 'static' | 'clone'
  /**
   * Wave 11 (I-11, joining W11-CV's carrier to W11-S's record): the manifest model's cloth reclass (`models[].cloth`,
   * written by the converter's cloth pass, TL-M). An entry overrides its sidecar material's `cloth` / `clothPin`.
   * Absent: the sidecar's fields (none in any export before TL-M).
   */
  cloth?: readonly WorldModelCloth[]
}

/**
 * The sidecar material with the manifest's cloth entry (by glTF material name, any case) folded in: `kind` becomes
 * `cloth`, and `[pinY, height]` becomes `clothPin` when both are given (else the primitive's bounds). No entry, or no
 * sidecar material: `side` unchanged.
 */
export function withManifestCloth(side: SidecarMaterialLite | undefined, name: string, cloth: readonly WorldModelCloth[] | undefined): SidecarMaterialLite | undefined {
  if (!side || !cloth?.length) return side
  const key = name.toLowerCase()
  const c = cloth.find(e => e.material.toLowerCase() === key)
  if (!c) return side
  const pin: [number, number] | undefined = c.pinY !== undefined && c.height !== undefined ? [c.pinY, c.height] : undefined
  return { ...side, cloth: c.kind, ...(pin ? { clothPin: pin } : {}) }
}

/** A material convert() makes: StandardMaterial on the Classic path, PBRMaterial on the PBR path. */
export type ObjectMaterial = StandardMaterial | PBRMaterial

/** What one convert() call created, for releasing it again (region streaming, model-cache.ts). */
export interface ConvertedMaterials {
  materials: ObjectMaterial[]
  /** W10-S: each material's batch record, in the same order (docs/BATCHING.md §3.2). */
  records: MaterialBatchRecord[]
}

function lightmapExtras(m: Material): LightmapExtras | undefined {
  return (m.metadata as { gltf?: { extras?: { sroLightmap?: LightmapExtras } } } | null)?.gltf?.extras?.sroLightmap
}

/** The glTF alpha mode of a source material: the sidecar's when it says, else the loader's transparency mode. */
function alphaModeOf(src: Material, side: SidecarMaterialLite | undefined): 'OPAQUE' | 'MASK' | 'BLEND' {
  return side?.alphaMode ?? (src instanceof PBRMaterial && src.transparencyMode === PBRMaterial.MATERIAL_ALPHABLEND
    ? 'BLEND'
    : src instanceof PBRMaterial && src.transparencyMode === PBRMaterial.MATERIAL_ALPHATEST ? 'MASK' : 'OPAQUE')
}

/**
 * Replaces the glTF loader's PBR materials with StandardMaterial set up as the fixed-function object lighting of
 * docs/TERRAIN.md 3.2 / 8.4 (v1):
 *   out = saturate(2 tex * saturate(matD * lightD * max(N.l, 0) + matA * envA + emissive))
 * Babylon: diffuseTexture.level = 2 (MODULATE2X, not for BMT 0x8), diffuseColor = BMT diffuse, ambientColor = BMT
 * ambient (scene.ambientColor = ObjectAmbient), specular off, emissive as the glb carries it. Babylon clamps the light
 * term to 1 before the texture multiply and the framebuffer clamps the product, which is the D3D formula.
 * Object lightmaps (material extras.sroLightmap, TEXCOORD_1) multiply the result (useLightmapAsShadowmap) with
 * level = the off/1x/2x mode (TERRAIN.md 3.3: combine unknown). Babylon applies it before the final clamp:
 * min(1, 2 tex L lm) instead of saturate(2 tex L) lm, which differ only where 2 tex L > 1.
 */
export class ObjectMaterials {
  readonly materials: ObjectMaterial[] = []
  private readonly lightmaps = new Map<string, Texture>()
  /** Materials using each lightmap (by URI): the texture is disposed when the last one is released. */
  private readonly lightmapRefs = new Map<string, number>()
  private readonly lightmapBytes = new Map<string, Promise<Uint8Array<ArrayBuffer> | null>>()
  private readonly lightmapped: Array<{ mat: ObjectMaterial; tex: Texture; uri: string }> = []
  private readonly decorators: MaterialDecorator[] = []
  /** Map sets bound on PBR materials (released with the material). */
  private readonly applied = new Map<PBRMaterial, AppliedMaps>()
  /** W10-S: the batch record of every converted material (batchRecord). */
  private readonly records = new WeakMap<ObjectMaterial, MaterialBatchRecord>()
  /** The surface class toPbr chose (for the record). */
  private readonly pbrClass = new WeakMap<PBRMaterial, MaterialClass>()
  /**
   * W10-S (docs/WAVE_PLAN6.md D5): told when TX-R's map set of a PBR material swaps in after the material was made
   * (pbr/maps.ts applyMapRecord's onChange): BT-A rewrites the slot's cells and texels, never the geometry.
   */
  readonly onMapsChanged = new Observable<MaterialBatchRecord>()
  /**
   * Wave 12 (UV scroll): the scroll clock and plugins of the retail scrolling materials (uv-scroll.ts), both paths.
   * World sets `uvScroll.clock` to its server clock so every client shows the same phase.
   */
  readonly uvScroll: UvScrollShared
  /**
   * RND-M's part of WorldRender on the PBR path (docs/WAVE_PLAN3.md §6.10): the surface plugin's shared state, the map
   * sets (`pbr/index.json`, `remaster/manifest.json` under the asset root) and their texture cache, the character
   * decorator. World calls `materials.pbr.attach(render, weather)`; the part joins `render.materials` on the PBR path
   * only.
   */
  readonly pbr: PbrSurfaces
  /** Object lightmaps off / 1x / 2x (setLightmapMode). Wave 9: renamed from `mode`, which is now the material path. */
  lightmapMode: LightmapMode = 1
  private modeValue: MaterialPath = 'classic'
  lightmapFailures = 0

  constructor(readonly scene: Scene, readonly assets: Assets) {
    this.uvScroll = new UvScrollShared(scene)
    const root = assetRoot(assets)
    this.pbr = new PbrSurfaces(scene, {
      source: urlMapSource(scene, url => assets.io.bytes(url), (bytes, mime) => assets.io.decodeImage(bytes, mime)),
      // The world lives at <root>/world/<name>/; the map sets at <root>/pbr/ and <root>/remaster/ (D35, D40).
      loadIndex: () => loadPbrMapIndex(assets.io, root.root),
    })
  }

  /**
   * The material path convert() builds: 'classic' = today's StandardMaterial (fromPbr), 'pbr' = PBRMaterial + the
   * surface plugin (toPbr). Set by World (LoadWorldOptions.render, World.setRenderMode); the PBR part follows it.
   */
  get mode(): MaterialPath {
    return this.modeValue
  }

  set mode(mode: MaterialPath) {
    this.modeValue = mode
    this.pbr.setMode(mode)
  }

  get lightmapCount(): number {
    return this.lightmaps.size
  }

  private fetchLightmap(uri: string): Promise<Uint8Array<ArrayBuffer> | null> {
    let p = this.lightmapBytes.get(uri)
    if (!p) {
      p = this.assets.bytesOf(uri).catch(err => {
        console.warn('[world] object lightmap', uri, err)
        this.lightmapFailures++
        return null
      })
      this.lightmapBytes.set(uri, p)
    }
    return p
  }

  private lightmap(uri: string, bytes: Uint8Array<ArrayBuffer>): Texture {
    let tex = this.lightmaps.get(uri)
    if (!tex) {
      tex = new Texture(this.assets.url(uri), this.scene, {
        buffer: bytes,
        mimeType: mimeOf(uri),
        noMipmap: false,
        invertY: false, // glTF convention: uv (0, 0) = first image row, like the loader's own textures
        samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
        onError: () => {
          this.lightmapFailures++
        },
      })
      tex.coordinatesIndex = 1
      tex.wrapU = Texture.CLAMP_ADDRESSMODE
      tex.wrapV = Texture.CLAMP_ADDRESSMODE
      this.lightmaps.set(uri, tex)
    }
    return tex
  }

  /**
   * Converts every material of `container` in place (meshes are re-pointed; the PBR materials are disposed). Returns
   * what was created, for release().
   */
  async convert(container: AssetContainer, sidecar: SidecarLite | null, lightmaps: boolean, model?: ConvertModelInfo): Promise<ConvertedMaterials> {
    const byName = new Map<string, SidecarMaterialLite>()
    for (const m of sidecar?.materials ?? []) byName.set(m.name.toLowerCase(), m)
    const lmBytes = new Map<string, Uint8Array<ArrayBuffer>>()
    if (lightmaps) {
      const uris = new Set<string>()
      for (const src of container.materials) {
        const uri = lightmapExtras(src)?.uri
        if (uri) uris.add(uri)
      }
      await Promise.all([...uris].map(async uri => {
        const b = await this.fetchLightmap(uri)
        if (b) lmBytes.set(uri, b)
      }))
    }
    const pbr = this.mode === 'pbr'
    // PBR path: the map sets are loaded once, on the first conversion (a missing index is "no sets", D40).
    const index = pbr ? await this.pbr.maps() : null
    const replaced = new Map<Material, ObjectMaterial>()
    // TX-R: a map set swaps in once its textures are uploaded (pbr/maps.ts); the retail texture is freed then (D41).
    const freeRetail = (tex: BaseTexture) => disposeSwapped(container, new Set([tex]), this.materials)
    const records: MaterialBatchRecord[] = []
    for (const src of container.materials) {
      const side = withManifestCloth(byName.get(src.name.toLowerCase()), src.name, model?.cloth)
      const mat = index ? this.toPbr(src, side, lmBytes, index, model, freeRetail) : this.fromPbr(src, side, lmBytes)
      replaced.set(src, mat)
      // UV scroll: the retail texture flow, on both paths (the plugin moves every UV1 texture of the material).
      const scroll = uvScrollOf(side)
      if (scroll) this.uvScroll.attach(mat, scroll)
      const lm = lightmapExtras(src)?.uri
      records.push(this.record(mat, src, side, model, !!index, lm && lmBytes.has(lm) ? lm : null, scroll))
      if (this.decorators.length) this.decorate(mat, src, side, model)
    }
    for (const mesh of container.meshes) {
      const m = mesh.material
      const std = m ? replaced.get(m) : undefined
      if (std) mesh.material = std
    }
    for (const [src, std] of replaced) {
      container.materials.splice(container.materials.indexOf(src), 1)
      src.dispose(false, false)
      this.materials.push(std)
    }
    return { materials: [...replaced.values()], records }
  }

  /** The batch record of a material convert() made (null: not one of ours, or released). */
  batchRecord(mat: Material | null | undefined): MaterialBatchRecord | null {
    return mat ? this.records.get(mat as ObjectMaterial) ?? null : null
  }

  /** Builds (and keeps) the batch record of a converted material: read from the source material and the sidecar. */
  private record(mat: ObjectMaterial, src: Material, side: SidecarMaterialLite | undefined, model: ConvertModelInfo | undefined, pbr: boolean, lightmap: string | null, scroll: UvScroll | null = null): MaterialBatchRecord {
    const unlit = side ? (side.flags & BMT_SELF_ILLUMINATED) !== 0 : false
    const alphaMode = alphaModeOf(src, side)
    const info: ConvertModelInfo = { model: model?.model ?? '', source: model?.source ?? '', kind: model?.kind ?? 'static' }
    const e = src instanceof PBRMaterial ? src.emissiveColor : null
    const lampModel = !!model && isLampModel(model.source)
    // W11-S: the cloth reclass, on the PBR path's lit materials only (the Classic path never batches); none: no key.
    const cloth = pbr && !unlit ? clothOf(side) : null
    const record: MaterialBatchRecord = {
      material: mat,
      path: pbr ? 'pbr' : 'classic',
      model: info,
      name: src.name,
      texture: side?.texture ?? null,
      cls: pbr && mat instanceof PBRMaterial && !unlit ? this.pbrClass.get(mat) ?? null : null,
      unlit,
      alpha: alphaMode === 'BLEND' ? 'blend' : alphaMode === 'MASK' ? 'mask' : 'opaque',
      twoSided: !src.backFaceCulling,
      lightmap,
      lampModel: pbr && !unlit && lampModel,
      emissive: !!e && !lampModel && e.r + e.g + e.b > 0.001,
      maps: mat instanceof PBRMaterial ? this.applied.get(mat) ?? null : null,
      ...(cloth ? { cloth } : {}),
      ...(scroll ? { uvScroll: scroll } : {}),
    }
    this.records.set(mat, record)
    return record
  }

  /**
   * Adds a decorator run on every material convert() creates from now on (not on existing ones). Returns a remover.
   * A decorator that throws is logged and the conversion carries on.
   */
  addDecorator(fn: MaterialDecorator): () => void {
    this.decorators.push(fn)
    return () => {
      const i = this.decorators.indexOf(fn)
      if (i >= 0) this.decorators.splice(i, 1)
    }
  }

  private decorate(mat: ObjectMaterial, src: Material, side: SidecarMaterialLite | undefined, model: ConvertModelInfo | undefined): void {
    const alphaMode = alphaModeOf(src, side)
    const info: MaterialDecoratorInfo = {
      model: model?.model ?? '',
      source: model?.source ?? '',
      kind: model?.kind ?? 'static',
      unlit: side ? (side.flags & BMT_SELF_ILLUMINATED) !== 0 : false,
      alpha: alphaMode === 'BLEND' ? 'blend' : alphaMode === 'MASK' ? 'mask' : 'opaque',
    }
    if (side?.texture) info.texture = side.texture
    for (const fn of this.decorators) {
      try {
        fn(mat, info)
      } catch (err) {
        console.warn('[world] material decorator failed', mat.name, err)
      }
    }
  }

  /**
   * Disposes the materials of one convert() call (their textures too, except the shared lightmaps, which are disposed
   * with their last user). For a model container that is being disposed.
   */
  release(converted: ConvertedMaterials): void {
    const mats = new Set(converted.materials)
    for (let i = this.lightmapped.length - 1; i >= 0; i--) {
      const e = this.lightmapped[i]!
      if (!mats.has(e.mat)) continue
      this.lightmapped.splice(i, 1)
      e.mat.lightmapTexture = null
      const refs = (this.lightmapRefs.get(e.uri) ?? 1) - 1
      if (refs > 0) {
        this.lightmapRefs.set(e.uri, refs)
        continue
      }
      this.lightmapRefs.delete(e.uri)
      this.lightmaps.delete(e.uri)
      this.lightmapBytes.delete(e.uri)
      e.tex.dispose()
    }
    for (let i = this.materials.length - 1; i >= 0; i--) if (mats.has(this.materials[i]!)) this.materials.splice(i, 1)
    for (const m of converted.materials) {
      // Shared map textures go back to the cache first: the forced texture disposal below takes only the retail ones.
      const applied = m instanceof PBRMaterial ? this.applied.get(m) : undefined
      if (applied) {
        releaseMaps(m, applied, this.pbr.cache)
        this.applied.delete(m as PBRMaterial)
      }
      if (m instanceof PBRMaterial) {
        this.pbr.removeExtras(m)
        this.pbr.removeEmissive(m)
      }
      m.dispose(true, true)
    }
  }

  private fromPbr(src: Material, side: SidecarMaterialLite | undefined, lmBytes: Map<string, Uint8Array<ArrayBuffer>>): StandardMaterial {
    const std = new StandardMaterial(src.name, this.scene)
    const unlit = side ? (side.flags & BMT_SELF_ILLUMINATED) !== 0 : false
    const d = side?.diffuse ?? []
    const a = side?.ambient ?? []
    const matD = new Color3(d[0] ?? DEFAULT_MAT, d[1] ?? DEFAULT_MAT, d[2] ?? DEFAULT_MAT)
    const matA = new Color3(a[0] ?? DEFAULT_MAT, a[1] ?? DEFAULT_MAT, a[2] ?? DEFAULT_MAT)
    std.specularColor = Color3.Black()
    std.backFaceCulling = src.backFaceCulling
    std.twoSidedLighting = !src.backFaceCulling
    std.sideOrientation = src.sideOrientation
    let albedo: BaseTexture | null = null
    if (src instanceof PBRMaterial) {
      albedo = src.albedoTexture
      std.emissiveColor = src.emissiveColor.clone()
      std.transparencyMode = src.transparencyMode
      std.alphaCutOff = src.alphaCutOff
      std.useAlphaFromDiffuseTexture = src.useAlphaFromAlbedoTexture
      if (!albedo) matD.copyFrom(src.albedoColor)
    }
    if (albedo) {
      std.diffuseTexture = albedo
      albedo.level = unlit ? 1 : 2
      std.diffuseColor = matD
      std.ambientColor = matA
    } else {
      // No texture: fold the 2x into the colours (the base colour then comes from diffuseColor alone).
      std.diffuseColor = matD.scale(2)
      std.ambientColor = matA.scale(2)
    }
    if (unlit) {
      std.disableLighting = true
      std.emissiveColor = Color3.White()
    }
    const uri = lightmapExtras(src)?.uri
    const bytes = uri ? lmBytes.get(uri) : undefined
    if (uri && bytes) {
      const tex = this.lightmap(uri, bytes)
      std.useLightmapAsShadowmap = true
      this.lightmapped.push({ mat: std, tex, uri })
      this.lightmapRefs.set(uri, (this.lightmapRefs.get(uri) ?? 0) + 1)
      this.applyLightmap(std, tex)
    }
    return std
  }

  /**
   * The PBR path (docs/RENDER.md §3.1–3.4, docs/WAVE_PLAN3.md §6.10): a PBRMaterial per retail material with the
   * class defaults (roughness, metallic; the plugin adds luminance roughness and wetness), the object lightmap as
   * baked sun visibility plus an AO share (SroSurfacePlugin reads it raw; Babylon's multiply is off), the map set of
   * D35's precedence when one exists (the albedo replaces the retail texture), cloth sheen and skin F0 by class.
   * BMT 0x8 materials stay unlit. The glb's albedo keeps its sRGB decode in the shader (gammaSpace), at level 1.
   */
  private toPbr(
    src: Material,
    side: SidecarMaterialLite | undefined,
    lmBytes: Map<string, Uint8Array<ArrayBuffer>>,
    index: PbrMapIndex,
    model: ConvertModelInfo | undefined,
    freeRetail: (tex: BaseTexture) => void,
  ): PBRMaterial {
    const pbr = useWindowedLightFalloff(new PBRMaterial(src.name, this.scene))
    const unlit = side ? (side.flags & BMT_SELF_ILLUMINATED) !== 0 : false
    pbr.backFaceCulling = src.backFaceCulling
    pbr.twoSidedLighting = !src.backFaceCulling
    pbr.sideOrientation = src.sideOrientation
    let albedo: BaseTexture | null = null
    if (src instanceof PBRMaterial) {
      albedo = src.albedoTexture
      pbr.emissiveColor.copyFrom(src.emissiveColor)
      pbr.transparencyMode = src.transparencyMode
      pbr.alphaCutOff = src.alphaCutOff
      pbr.useAlphaFromAlbedoTexture = src.useAlphaFromAlbedoTexture
      if (!albedo) pbr.albedoColor.copyFrom(src.albedoColor)
    } else {
      const d = side?.diffuse ?? []
      pbr.albedoColor = new Color3(d[0] ?? DEFAULT_MAT, d[1] ?? DEFAULT_MAT, d[2] ?? DEFAULT_MAT).toLinearSpace()
    }
    if (albedo) {
      pbr.albedoTexture = albedo
      albedo.level = 1
    }
    if (unlit) {
      // Lanterns and glows: shown as painted (no lights, no wetness, no plugin).
      pbr.unlit = true
      return pbr
    }
    const texture = side?.texture ?? null
    const image = albedo?.getInternalTexture?.()?.label || null
    const alphaMode = side?.alphaMode ?? (pbr.transparencyMode === PBRMaterial.PBRMATERIAL_ALPHATEST ? 'MASK' : undefined)
    const record: PbrMapRecord | null = index.empty ? null : index.resolve({ glb: this.glbKey(model), image, texture }, this.pbr.policy())
    // W11-S (TOWN_LIFE §5.1): a material the converter reclassed as cloth takes the cloth class (absent: today's rule).
    const cls: MaterialClass = clothOf(side) ? 'cloth' : index.classOf(texture ?? image ?? src.name, { alphaMode, materialName: side?.name }, record)
    this.pbrClass.set(pbr, cls)
    const p = classParams(cls)
    pbr.metallic = record?.params?.metallic ?? p.metallic
    pbr.roughness = record?.params?.roughness ?? p.roughness
    let applied: AppliedMaps | null = null
    const lateMaps = { plugin: null as SroSurfacePlugin | null }
    if (record) {
      applied = applyMapRecord(pbr, record, this.pbr.cache, cls, {
        onChange: () => {
          const pl = lateMaps.plugin
          if (!pl || !applied) return
          pl.roughnessMap = applied.roughness
          pl.refresh()
          // W10-S (D5): the batcher's slot follows the swap (BT-A); nobody listens while batching is off.
          const rec = this.records.get(pbr)
          if (rec && this.onMapsChanged.hasObservers()) this.onMapsChanged.notifyObservers(rec)
        },
        onRetailFree: freeRetail,
      })
      this.applied.set(pbr, applied)
    }
    const uri = lightmapExtras(src)?.uri
    const bytes = uri ? lmBytes.get(uri) : undefined
    let baked = false
    if (uri && bytes) {
      const tex = this.lightmap(uri, bytes)
      // Babylon needs the flag for the UV2 lightmap; the plugin turns its colour multiply off (LIGHTMAPEXCLUDED).
      pbr.useLightmapAsShadowmap = true
      this.lightmapped.push({ mat: pbr, tex, uri })
      this.lightmapRefs.set(uri, (this.lightmapRefs.get(uri) ?? 0) + 1)
      this.applyLightmap(pbr, tex)
      baked = true
    }
    const name = `${texture ?? ''} ${image ?? ''} ${src.name}`
    // W9 LOOK: a lamp model's night glow (NL's emissive, night-lights.ts) samples the albedo (SRO_SELFLIT): as a flat
    // colour it drew the stone lanterns as solid cream silhouettes at night. NL keeps driving the emissive colour.
    const lampModel = !!model && isLampModel(model.source)
    const plugin = new SroSurfacePlugin(pbr, this.pbr.shared, {
      cls,
      baked,
      // Lamp glow at night is NL's alone on both paths (night-lights.ts; gate 1: one emissive term, D12).
      roughnessMap: applied?.roughness ?? false,
      porosity: record?.params?.porosity,
      selfLit: lampModel,
    })
    if (cls === 'stone' && /marble/i.test(name)) plugin.ssr = 1
    lateMaps.plugin = plugin
    this.pbr.addExtras(pbr, cls)
    // W9 LOOK: a retail emissive (BMT emissive, e.g. the luxury-house tiger's 0.59) is self-light tied to the ambient,
    // not a scene-linear colour the exposure multiplies (PbrSurfaces.addEmissive).
    if (src instanceof PBRMaterial && !lampModel) this.pbr.addEmissive(pbr, plugin, src.emissiveColor)
    if (model && isFoliageModel(model.source)) pbr.metadata = { ...(pbr.metadata ?? {}), sroFoliage: true }
    return pbr
  }

  /** A model's key in the remaster manifest: its glb path under the asset root without `.glb` (D35). */
  private glbKey(model: ConvertModelInfo | undefined): string | null {
    if (!model?.model) return null
    return assetRoot(this.assets).prefix + model.model.replace(/\\/g, '/').replace(/\.glb$/i, '')
  }

  private applyLightmap(mat: ObjectMaterial, tex: Texture): void {
    mat.lightmapTexture = this.lightmapMode === 0 ? null : tex
    // The PBR plugin reads the lightmap as visibility: its 2x mode is a Classic combine only.
    tex.level = this.lightmapMode === 2 && mat instanceof StandardMaterial ? 2 : 1
  }

  setLightmapMode(mode: LightmapMode): void {
    this.lightmapMode = mode
    for (const { mat, tex } of this.lightmapped) this.applyLightmap(mat, tex)
  }

  /** Disposes every converted material, its textures and the lightmaps. */
  dispose(): void {
    for (const [m, applied] of this.applied) releaseMaps(m, applied, this.pbr.cache)
    this.applied.clear()
    this.pbr.dispose()
    for (const m of this.materials) m.dispose(true, true)
    this.uvScroll.dispose()
    for (const t of this.lightmaps.values()) t.dispose()
    this.materials.length = 0
    this.lightmaps.clear()
    this.lightmapRefs.clear()
    this.lightmapBytes.clear()
    this.lightmapped.length = 0
    this.decorators.length = 0
    this.onMapsChanged.clear()
  }
}

/** The asset root of a world's Assets (`<root>/world/<name>/` → `<root>/`) and the world's path under it. */
function assetRoot(assets: Assets): { root: string; prefix: string } {
  const base = assets.base.href
  const root = new URL('../../', assets.base).href
  return { root, prefix: base.startsWith(root) ? decodeURI(base.slice(root.length)) : '' }
}

/**
 * D41: a retail texture a map set replaced is disposed once no converted material still draws with it (as albedo or
 * as the cutout mask), so the town does not keep both sets resident.
 */
function disposeSwapped(container: AssetContainer, swapped: ReadonlySet<BaseTexture>, mats: readonly ObjectMaterial[]): void {
  for (const tex of swapped) {
    const used = mats.some(m => (m instanceof PBRMaterial ? m.albedoTexture === tex || m.opacityTexture === tex : m.diffuseTexture === tex || m.opacityTexture === tex))
    if (used) continue
    const i = container.textures.indexOf(tex)
    if (i >= 0) container.textures.splice(i, 1)
    tex.dispose()
  }
}

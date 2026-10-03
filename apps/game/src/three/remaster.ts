/**
 * Remastered textures (test switch): PBR maps made offline (Meshy retexture with the original UVs, or any other tool)
 * replace the retail diffuse texture of character, armour and weapon materials, so the classic and the remastered
 * look can be compared in the game. Off by default; Options -> Graphics -> "Remastered textures (test)" (persisted,
 * settings.ts graphics.remaster) or `?remaster=1` / `?remaster=0` for this page load.
 *
 * The manifest: /out/remaster/manifest.json (work/out/remaster/manifest.json), else /out-opt/remaster/manifest.json:
 *   {
 *     "format": "sro-remaster", "version": 1,
 *     "textures": {
 *       "char/china/chinaman_adventurer#chinaman_adventurer_body": {
 *         "albedo": "char/china/chinaman_adventurer_body/albedo.png",       base colour, sRGB (required)
 *         "normal": ".../normal.png",                                       tangent space, linear
 *         "metallicRoughness": ".../mr.png",                                glTF packing: G roughness, B metallic, linear
 *         "metallic": ".../metallic.png", "roughness": ".../roughness.png", or separate greyscale maps (R), linear
 *         "emissive": ".../emission.png",                                   sRGB (glTF emissiveTexture convention)
 *         "normalGreen": "gl",    'gl' (OpenGL / glTF / Meshy: +Y up, the default) or 'dx' (DirectX: green flipped)
 *         "alpha": "original"     'original' (default): cutout/blend alpha from the retail texture (same UVs);
 *                                 'albedo': from the remastered albedo's alpha channel
 *       }
 *     }
 *   }
 * Keys: `<glb path under /out/ without .glb>#<glTF image name>`; the image name is the retail texture file stem
 * (chinaman_adventurer_body.ddj -> "chinaman_adventurer_body"), identical in /out/ and /out-opt/. Image names are not
 * unique across glbs (man_item and woman_item share clothes_01_aa), so the glb path is part of the key; a bare
 * image name (no '#') matches that image in every glb. Map paths are relative to the manifest (or absolute URLs).
 * The maps must be authored on the model's existing UV layout: nothing here remaps UVs.
 *
 * In game: a material with a manifest entry is swapped (mesh by mesh, container meshes included so new instances
 * inherit it) for a PBRMaterial with the maps; alpha mode, cutoff, culling and side orientation are copied from the
 * original. Switching off swaps the originals back. RemasterLighting (world screen) adds, only while the switch is
 * on, an environment cube captured from the sky (scene.environmentTexture, re-captured every PROBE_REFRESH_MS) and a
 * slightly stronger key light.
 */
import {
  Material,
  PBRMaterial,
  RawTexture,
  ReflectionProbe,
  RenderTargetTexture,
  Texture,
  type AbstractMesh,
  type AssetContainer,
  type BaseTexture,
  type Light,
  type Nullable,
  type Observer,
  type Scene,
  type Vector3,
} from '@babylonjs/core'
import { parseRemasterManifest, REMASTER_FORMAT, REMASTER_MANIFEST, type MapKind, type NormalGreen, type RemasterManifest, type RemasterMaps } from '@sro/world-render'
import { REMASTER_TEST_SETS } from '../settings.ts'
import { onRemasterChange, remasterEnabled } from './remaster-switch.ts'
import { OPT_PREFIX, OUT_PREFIX } from './slim.ts'

// The manifest format and parser live in @sro/world-render (pbr/maps.ts, docs/WAVE_PLAN3.md D35), shared with the
// world's PBR map loader; re-exported here for this module's users.
export { parseRemasterManifest, REMASTER_FORMAT, REMASTER_MANIFEST }
export type { MapKind, NormalGreen, RemasterAlpha, RemasterManifest, RemasterMaps } from '@sro/world-render'

/** Colour space of each map: colour data is sRGB (albedo, and emissive as in glTF), data maps are linear. */
export const MAP_SRGB: Readonly<Record<MapKind, boolean>> = {
  albedo: true,
  emissive: true,
  normal: false,
  metallicRoughness: false,
  metallic: false,
  roughness: false,
}

// ---- manifest ---------------------------------------------------------------------------------------------------

/** '/out-opt/char/china/x.glb' or '/out/char/china/x.glb' -> 'char/china/x' (the key's glb part). */
export function glbKeyPath(url: string): string {
  let p = url.split(/[?#]/)[0]!
  if (p.startsWith(OPT_PREFIX)) p = p.slice(OPT_PREFIX.length)
  else if (p.startsWith(OUT_PREFIX)) p = p.slice(OUT_PREFIX.length)
  return p.replace(/^\/+/, '').replace(/\.glb$/i, '')
}

export function remasterKey(glbPath: string, image: string): string {
  return `${glbPath}#${image}`
}

/** The entry for an image of a glb: the exact `glb#image` key first, then the bare image name. */
export function findRemaster(m: RemasterManifest | null, glbPath: string, image: string): { key: string; maps: RemasterMaps } | null {
  if (!m) return null
  for (const key of [remasterKey(glbPath, image), image]) {
    const maps = m.entries.get(key)
    if (maps) return { key, maps }
  }
  return null
}

/** Materials of one loaded glb that get a remastered twin. `image` is the glTF image name of the base texture. */
export function planSwaps<M>(items: readonly { material: M; image: string | null }[], glbPath: string, m: RemasterManifest | null): { material: M; key: string; maps: RemasterMaps }[] {
  const out: { material: M; key: string; maps: RemasterMaps }[] = []
  for (const it of items) {
    if (!it.image) continue
    const hit = findRemaster(m, glbPath, it.image)
    if (hit) out.push({ material: it.material, ...hit })
  }
  return out
}

// ---- the switch (remaster-switch.ts, Babylon-free for the Options row) ----------------------------------------------

export { onRemasterChange, remasterEnabled, remasterFromSearch, remasterWanted } from './remaster-switch.ts'

// ---- manifest loading -------------------------------------------------------------------------------------------

let manifest: Promise<RemasterManifest | null> | null = null

/** The manifest (cached; `reload` fetches it again, e.g. each time the switch turns on). Missing = null. */
export function remasterManifest(reload = false): Promise<RemasterManifest | null> {
  if (manifest && !reload) return manifest
  manifest = (async () => {
    // W9F TEX-4: the retired switch's twins read the manifest only on the dev server or with ?remaster=1
    // (settings.ts REMASTER_TEST_SETS). The approved sets reach the players through the in-place swaps (ActorMaps),
    // which load the same manifest on every page.
    if (!REMASTER_TEST_SETS) return null
    for (const root of [OUT_PREFIX, OPT_PREFIX]) {
      const url = root + REMASTER_MANIFEST
      try {
        const res = await fetch(url, { cache: 'no-cache' })
        if (!res.ok) continue
        const m = parseRemasterManifest((await res.json()) as unknown, url)
        if (!m) {
          console.warn(`[remaster] ${url} is not an ${REMASTER_FORMAT} manifest`)
          continue
        }
        for (const w of m.warnings) console.warn(`[remaster] ${url}: ${w}`)
        console.info(`[remaster] ${m.entries.size} remastered textures (${url})`)
        return m
      } catch {
        // try the next root
      }
    }
    console.info('[remaster] no remaster manifest; models keep their retail textures')
    return null
  })()
  return manifest
}

// ---- materials --------------------------------------------------------------------------------------------------

/** The base colour texture of a material (glTF PBR albedo, or a StandardMaterial diffuse). */
export function baseTextureOf(m: Material): BaseTexture | null {
  const r = m as { albedoTexture?: Nullable<BaseTexture>; diffuseTexture?: Nullable<BaseTexture> }
  return r.albedoTexture ?? r.diffuseTexture ?? null
}

/** The glTF image name of a texture the glTF loader made (it labels the internal texture with it). */
export function imageNameOf(tex: BaseTexture | null): string | null {
  return tex?.getInternalTexture()?.label || null
}

/**
 * glTF normal maps (+Y up) in Babylon: the loader's inversions for the scene's handedness; a DirectX-style map
 * ('dx', green pointing down) flips Y on top of that.
 */
export function normalInversions(rightHanded: boolean, green: NormalGreen): { x: boolean; y: boolean } {
  const x = !rightHanded
  const y = rightHanded
  return { x, y: green === 'dx' ? !y : y }
}

/** glTF packing of separate greyscale maps (red channel of each): R occlusion 1, G roughness, B metallic, A 1. */
export function packMetallicRoughness(metal: ArrayLike<number> | null, rough: ArrayLike<number> | null, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 4)
  for (let i = 0; i < pixels; i++) {
    out[i * 4] = 255
    out[i * 4 + 1] = rough ? rough[i * 4]! : 255
    out[i * 4 + 2] = metal ? metal[i * 4]! : 0
    out[i * 4 + 3] = 255
  }
  return out
}

/** Makes the textures of a remastered material (tests pass fakes; the game loads URLs). */
export interface RemasterTextureSource {
  texture(url: string, srgb: boolean): BaseTexture
  /** Separate metallic/roughness maps packed as one glTF metallicRoughness texture. */
  packed(metal: string | undefined, rough: string | undefined): Promise<BaseTexture>
}

async function imagePixels(url: string, size?: { w: number; h: number }): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const w = size?.w ?? bmp.width
  const h = size?.h ?? bmp.height
  const canvas = new OffscreenCanvas(w, h)
  const g = canvas.getContext('2d', { willReadFrequently: true })
  if (!g) throw new Error('2d canvas unavailable')
  g.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return { data: g.getImageData(0, 0, w, h).data, w, h }
}

/** The game's texture source: URL textures laid out like the glTF loader's (no Y flip, trilinear, repeat). */
export function urlTextures(scene: Scene): RemasterTextureSource {
  return {
    texture(url, srgb) {
      const t = new Texture(url, scene, { noMipmap: false, invertY: false, samplingMode: Texture.TRILINEAR_SAMPLINGMODE, gammaSpace: srgb })
      t.gammaSpace = srgb
      return t
    },
    async packed(metal, rough) {
      if (!metal && !rough) throw new Error('no metallic or roughness map')
      // The first map sets the size; the other is drawn at that size.
      const first = await imagePixels((rough ?? metal)!)
      const size = { w: first.w, h: first.h }
      const roughPx = rough ? first.data : null
      const metalPx = metal ? (rough ? (await imagePixels(metal, size)).data : first.data) : null
      const data = packMetallicRoughness(metalPx, roughPx, first.w * first.h)
      const t = RawTexture.CreateRGBATexture(data, first.w, first.h, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
      t.gammaSpace = false
      t.wrapU = Texture.WRAP_ADDRESSMODE
      t.wrapV = Texture.WRAP_ADDRESSMODE
      return t
    },
  }
}

/** Material state copied from the original (alpha mode and cutoff, culling, winding, depth). */
const COPIED = [
  'transparencyMode',
  'alphaCutOff',
  'alpha',
  'alphaMode',
  'backFaceCulling',
  'twoSidedLighting',
  'sideOrientation',
  'needDepthPrePass',
  'separateCullingPass',
  'disableDepthWrite',
  'forceDepthWrite',
  'zOffset',
  'maxSimultaneousLights',
  'useRadianceOverAlpha',
  'useSpecularOverAlpha',
] as const

const ALPHA_TEST = PBRMaterial.PBRMATERIAL_ALPHATEST
const ALPHA_BLEND = PBRMaterial.PBRMATERIAL_ALPHABLEND
const ALPHA_TEST_BLEND = PBRMaterial.PBRMATERIAL_ALPHATESTANDBLEND

/**
 * The remastered twin of `orig`: a PBRMaterial with the maps in their colour spaces, the glTF normal convention
 * (or the entry's 'dx' flip) and the original's alpha / culling state. Retail alpha stays the cutout mask unless the
 * entry says the albedo carries its own.
 */
export function buildRemasterMaterial(orig: Material, maps: RemasterMaps, scene: Scene, src: RemasterTextureSource, key = ''): PBRMaterial {
  const pbr = new PBRMaterial(`${orig.name} (remaster)`, scene)
  const o = orig as unknown as Record<string, unknown>
  const d = pbr as unknown as Record<string, unknown>
  for (const k of COPIED) if (o[k] !== undefined && k in pbr) d[k] = o[k]
  if (orig instanceof PBRMaterial) pbr.albedoColor.copyFrom(orig.albedoColor)
  pbr.metadata = { remaster: key || true }

  const albedo = src.texture(maps.albedo, MAP_SRGB.albedo)
  albedo.gammaSpace = MAP_SRGB.albedo
  pbr.albedoTexture = albedo
  const mode = orig.transparencyMode
  const cutout = mode === ALPHA_TEST || mode === ALPHA_BLEND || mode === ALPHA_TEST_BLEND
  const base = baseTextureOf(orig)
  if (maps.alpha === 'albedo') {
    albedo.hasAlpha = true
    pbr.useAlphaFromAlbedoTexture = true
  } else if (cutout && base) {
    // Same UVs: the retail texture's alpha is still the right mask.
    pbr.opacityTexture = base
    pbr.useAlphaFromAlbedoTexture = false
  }

  if (maps.normal) {
    const n = src.texture(maps.normal, MAP_SRGB.normal)
    n.gammaSpace = MAP_SRGB.normal
    pbr.bumpTexture = n
    const inv = normalInversions(scene.useRightHandedSystem, maps.normalGreen)
    pbr.invertNormalMapX = inv.x
    pbr.invertNormalMapY = inv.y
  }

  const useMr = (t: BaseTexture) => {
    t.gammaSpace = MAP_SRGB.metallicRoughness
    pbr.metallicTexture = t
    pbr.useRoughnessFromMetallicTextureGreen = true
    pbr.useMetallnessFromMetallicTextureBlue = true
    pbr.useRoughnessFromMetallicTextureAlpha = false
    pbr.useAmbientOcclusionFromMetallicTextureRed = false
    pbr.metallic = 1
    pbr.roughness = 1
  }
  const origPbr = orig instanceof PBRMaterial ? orig : null
  pbr.metallic = origPbr?.metallic ?? 0
  pbr.roughness = origPbr?.roughness ?? 1
  if (maps.metallicRoughness) useMr(src.texture(maps.metallicRoughness, MAP_SRGB.metallicRoughness))
  else if (maps.metallic || maps.roughness) {
    src.packed(maps.metallic, maps.roughness).then(
      t => (pbr.getScene().isDisposed ? t.dispose() : useMr(t)),
      err => console.warn('[remaster] metallic/roughness maps failed', key, err),
    )
  }

  if (maps.emissive) {
    const e = src.texture(maps.emissive, MAP_SRGB.emissive)
    e.gammaSpace = MAP_SRGB.emissive
    pbr.emissiveTexture = e
    pbr.emissiveColor.set(1, 1, 1)
  } else if (origPbr) pbr.emissiveColor.copyFrom(origPbr.emissiveColor)
  return pbr
}

/** Disposes a twin and the maps it owns; the retail texture it borrows as its opacity mask stays. */
export function disposeTwin(m: PBRMaterial): void {
  for (const t of [m.albedoTexture, m.bumpTexture, m.metallicTexture, m.emissiveTexture]) t?.dispose()
  m.dispose(false, false)
}

// ---- per scene --------------------------------------------------------------------------------------------------

interface Tracked {
  container: AssetContainer
  glbPath: string
}

interface Twin {
  sig: string
  material: PBRMaterial
}

/**
 * The remaster state of one scene: the containers its ModelLibraries loaded, the twins built for their materials,
 * and the swap of every mesh (scene instances and the container's own meshes) when the switch changes.
 */
export class RemasterScene {
  private readonly tracked: Tracked[] = []
  private readonly twins = new Map<Material, Twin>()
  private on = false
  private serial = 0
  private readonly off: () => void

  constructor(
    readonly scene: Scene,
    private readonly source: RemasterTextureSource = urlTextures(scene),
    private readonly loadManifest: (reload: boolean) => Promise<RemasterManifest | null> = remasterManifest,
  ) {
    if (scene.isDisposed) {
      this.off = () => {}
      return
    }
    this.off = onRemasterChange(on => this.set(on))
    scene.onDisposeObservable.addOnce(() => this.dispose())
    if (remasterEnabled()) this.set(true)
  }

  /** A newly loaded glb (ModelLibrary): its materials are swapped at once while the switch is on. */
  track(container: AssetContainer, glbUrl: string): void {
    const t = { container, glbPath: glbKeyPath(glbUrl) }
    this.tracked.push(t)
    if (this.on) void this.apply([t], this.serial, false)
  }

  untrack(container: AssetContainer): void {
    const i = this.tracked.findIndex(t => t.container === container)
    if (i >= 0) this.tracked.splice(i, 1)
  }

  private set(on: boolean): void {
    if (on === this.on) return
    this.on = on
    const serial = ++this.serial
    if (on) void this.apply(this.tracked, serial, true)
    else this.swap(new Map([...this.twins].map(([orig, tw]) => [tw.material as Material, orig])))
  }

  private async apply(list: readonly Tracked[], serial: number, reload: boolean): Promise<void> {
    const m = await this.loadManifest(reload)
    if (serial !== this.serial || !this.on || this.scene.isDisposed) return
    const swap = new Map<Material, Material>()
    for (const t of list) {
      const items = t.container.materials.map(material => ({ material, image: imageNameOf(baseTextureOf(material)) }))
      for (const p of planSwaps(items, t.glbPath, m)) {
        const sig = JSON.stringify(p.maps)
        let tw = this.twins.get(p.material)
        if (tw && tw.sig !== sig) {
          disposeTwin(tw.material)
          tw = undefined
        }
        if (!tw) {
          try {
            tw = { sig, material: buildRemasterMaterial(p.material, p.maps, this.scene, this.source, p.key) }
          } catch (err) {
            console.warn('[remaster] material failed', p.key, err)
            continue
          }
          this.twins.set(p.material, tw)
        }
        swap.set(p.material, tw.material)
      }
    }
    this.swap(swap)
  }

  /** Replaces materials on every mesh of the scene and of the tracked containers. */
  private swap(map: Map<Material, Material>): void {
    if (!map.size) return
    const meshes: AbstractMesh[] = [...this.scene.meshes, ...this.tracked.flatMap(t => t.container.meshes)]
    for (const mesh of meshes) {
      const next = mesh.material ? map.get(mesh.material) : undefined
      if (next) mesh.material = next
    }
  }

  /** Twins currently built (tests, the console). */
  get twinCount(): number {
    return this.twins.size
  }

  dispose(): void {
    this.off()
    this.serial++
    this.tracked.length = 0
    this.twins.clear()
    if (scenes.get(this.scene) === this) scenes.delete(this.scene)
  }
}

const scenes = new WeakMap<Scene, RemasterScene>()

/** The remaster state of a scene (created on first use). */
export function remasterFor(scene: Scene): RemasterScene {
  let r = scenes.get(scene)
  if (!r) {
    r = new RemasterScene(scene)
    if (!scene.isDisposed) scenes.set(scene, r)
  }
  return r
}

// ---- lighting ---------------------------------------------------------------------------------------------------

/** Key light factor while the switch is on (a slightly stronger sun for the normal and roughness detail). */
export const KEY_LIGHT_BOOST = 1.25
/** Fill (hemispheric) factor while on: the environment cube's diffuse term takes over part of the ambient. */
export const FILL_WITH_ENV = 0.7
export const PROBE_SIZE = 128
export const PROBE_REFRESH_MS = 30_000

export interface RemasterLightingOptions {
  /** The character key light (a DirectionalLight). */
  key: Light
  /** The character fill light (hemispheric). */
  fill?: Light
  /** Meshes the environment is captured from (the sky dome); empty = the clear colour only. */
  sky(): AbstractMesh[]
  /** Where the probe sits (the camera target). */
  center(): Vector3
}

/**
 * While the switch is on: scene.environmentTexture is a ReflectionProbe cube of the sky (captured once, then every
 * PROBE_REFRESH_MS or on refresh()), the key light is KEY_LIGHT_BOOST stronger and the fill FILL_WITH_ENV weaker.
 * Off: everything as before (the classic look is untouched).
 */
export class RemasterLighting {
  private probe: ReflectionProbe | null = null
  private prevEnv: Nullable<BaseTexture> = null
  private base: { key: number; fill: number } | null = null
  private tick: Observer<Scene> | null = null
  private lastCapture = 0
  private readonly off: () => void

  constructor(readonly scene: Scene, private readonly opts: RemasterLightingOptions) {
    this.off = onRemasterChange(on => this.set(on))
    if (remasterEnabled()) this.set(true)
  }

  get active(): boolean {
    return this.probe !== null
  }

  /** Captures the sky again (after the world loaded, or a time-of-day change). */
  refresh(): void {
    const p = this.probe
    if (!p) return
    p.renderList = this.opts.sky().filter(m => !m.isDisposed())
    p.position.copyFrom(this.opts.center())
    p.cubeTexture.resetRefreshCounter()
    this.lastCapture = performance.now()
  }

  private set(on: boolean): void {
    if (on === this.active || this.scene.isDisposed) return
    const { key, fill } = this.opts
    if (on) {
      const probe = new ReflectionProbe('remasterEnv', PROBE_SIZE, this.scene, true)
      probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE
      probe.cubeTexture.onAfterRenderObservable.add(() => probe.cubeTexture.forceSphericalPolynomialsRecompute())
      this.probe = probe
      this.prevEnv = this.scene.environmentTexture
      this.scene.environmentTexture = probe.cubeTexture
      this.base = { key: key.intensity, fill: fill?.intensity ?? 0 }
      key.intensity = this.base.key * KEY_LIGHT_BOOST
      if (fill) fill.intensity = this.base.fill * FILL_WITH_ENV
      this.refresh()
      this.tick = this.scene.onBeforeRenderObservable.add(() => {
        if (performance.now() - this.lastCapture > PROBE_REFRESH_MS) this.refresh()
      })
    } else {
      this.restore()
    }
  }

  private restore(): void {
    if (this.tick) this.scene.onBeforeRenderObservable.remove(this.tick)
    this.tick = null
    if (this.probe) {
      if (this.scene.environmentTexture === this.probe.cubeTexture) this.scene.environmentTexture = this.prevEnv
      this.probe.dispose()
      this.probe = null
    }
    if (this.base) {
      this.opts.key.intensity = this.base.key
      if (this.opts.fill) this.opts.fill.intensity = this.base.fill
      this.base = null
    }
  }

  dispose(): void {
    this.off()
    if (!this.scene.isDisposed) this.restore()
  }
}

/** Material check for tests and the console: is this mesh drawing a remastered twin? */
export function isRemastered(mesh: AbstractMesh): boolean {
  const md = mesh.material?.metadata as { remaster?: unknown } | null | undefined
  return !!md?.remaster
}

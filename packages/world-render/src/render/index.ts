/**
 * The modern renderer's hub (docs/RENDER.md, docs/WAVE_PLAN3.md §4.1): the material path, the preset, the weather it
 * shows, and the parts each lane fills. `World.render` holds one; World.update calls `update(camera, skyState)` last,
 * after the sky, the environment and the weather.
 *
 * Skeleton written by W9A-S; owned by RND-L afterwards. The parts start null and are filled by their lanes, each
 * through its own module: `lighting` and `shadows` (RND-L: render/lighting.ts, render/shadows.ts), `post` (RND-P:
 * render/post.ts), `materials` (RND-M: character/object PBR decoration). WorldRender forwards every call to the parts
 * that are set, so a lane plugs in by assigning its part and nothing else here changes. On the Classic path (Low) no
 * part is created and nothing here touches the scene.
 *
 * RND-L: once World binds itself (`bindWorld`, the end of its constructor), the PBR path builds its own lighting part
 * at once (the celestial light and the sky cube exist before any world material compiles) and its shadow part at the
 * first update (by then a streamed world has its streamer, so the proxy commit step sees every region). A slot
 * someone else already filled is left alone; switching to 'classic' disposes the parts built here.
 *
 * Gate 1 (I9A): the PBR path also builds RND-P's post part at bind. Its tone map, exposure, grade and height fog are
 * what make the sky's linear output (D17) and the materials' post-applied image processing (D18) correct, so the PBR
 * path never runs without it. Until someone calls attachCamera, the camera World.update renders with is adopted.
 */
import { Vector2, type AbstractMesh, type AssetContainer, type BaseTexture, type Camera, type Light, type Material, type Scene } from '@babylonjs/core'
import type { SkyState, SkyStyle } from '../sky/types.ts'
import type { ShelterMap } from '../weather/index.ts'
import { installEffectCacheFix } from './babylon-fixes.ts'
import { installLinkSettle } from './gpu-guards.ts'
import { gpuInfoFromEngine, type GpuInfo } from './gpu.ts'
import { WorldLighting, type SkyRadianceSource } from './lighting.ts'
import { RenderPost } from './post.ts'
import { RENDER_PRESETS, type RenderPath, type RenderQuality } from './quality.ts'
import { WorldShadows, type ShadowHost } from './shadows.ts'
import { CLEAR_RENDER_WEATHER, type RenderWeather } from './weather.ts'

/** What the renderer's own parts need from the world (World satisfies it; `bindWorld`). */
export interface RenderHost extends ShadowHost {
  /** The retail fixed-function sun (Classic only: the PBR lighting switches it off while it runs). */
  readonly sun: Light
  /** The sky system: its radiance and LUT version feed the sky cube (SKY-B). */
  readonly sky: SkyRadianceSource
  readonly skyStyle: SkyStyle
}

export type { GpuInfo } from './gpu.ts'
export type { RenderPath, RenderQuality } from './quality.ts'
export type { RenderWeather } from './weather.ts'

/**
 * One lane's part of the renderer. Every hook is optional; WorldRender calls the ones a part has, in the slot order
 * lighting → shadows → materials → post.
 */
export interface RenderPart {
  setMode?(mode: RenderPath): void
  setQuality?(q: Readonly<RenderQuality>): void
  setWeather?(w: Readonly<RenderWeather>): void
  update?(camera: Camera | null, sky: Readonly<SkyState>): void
  attachCamera?(camera: Camera): void
  /** A character / equipment material (ModelLibrary decorators, GAME): PBR presets decorate it (RND-M). */
  decorateCharacterMaterial?(mat: Material): void
  addCharacter?(mesh: AbstractMesh): void
  removeCharacter?(mesh: AbstractMesh): void
  /** G1 rescue (the crowd budget): how many shadow cascades a character root casts into (Infinity: all, 0: none). */
  setCharacterCascades?(mesh: AbstractMesh, cascades: number): void
  dispose?(): void
}

export interface WorldRenderOptions {
  mode?: RenderPath
  quality?: Readonly<RenderQuality>
  /** The GPU's limits and features (apps' EngineResult.gpu); default read back from the engine. */
  gpu?: GpuInfo
  /** The weather's shelter map, for the `rainOcclusion` alias (D20). */
  shelter?: () => ShelterMap | null
}

export class WorldRender {
  /** The material path of this world: 'classic' (Low) or 'pbr' (Medium+). World.setRenderMode switches it. */
  mode: RenderPath
  quality: Readonly<RenderQuality>
  weather: Readonly<RenderWeather> = CLEAR_RENDER_WEATHER
  /** The TAA sub-pixel jitter of this frame in clip units (RND-P writes it; the grass chunk adds it, D30). */
  readonly taaJitter = new Vector2(0, 0)
  readonly gpu: GpuInfo
  /** RND-L: the celestial light, SH, the sky cube (D14), the flash (D25). */
  lighting: RenderPart | null = null
  /** RND-L: CSM and shadow proxies. */
  shadows: RenderPart | null = null
  /** RND-P: the post stack, grade, fog plugin. */
  post: RenderPart | null = null
  /** RND-M: character and object PBR decoration. */
  materials: RenderPart | null = null
  private camera: Camera | null = null
  private readonly characters = new Set<AbstractMesh>()
  /** G1 rescue: the crowd budget's cascade counts per character root (for a shadow part built later). */
  private readonly characterCascades = new Map<AbstractMesh, number>()
  private readonly shelterOf: () => ShelterMap | null
  private host: RenderHost | null = null
  private disposed = false

  constructor(readonly scene: Scene, opts: WorldRenderOptions = {}) {
    this.mode = opts.mode ?? 'classic'
    this.quality = opts.quality ?? RENDER_PRESETS.medium
    this.gpu = opts.gpu ?? gpuInfoFromEngine(scene.getEngine())
    this.shelterOf = opts.shelter ?? (() => null)
    // A disposed world must not stay reachable from the page engine's effect cache (W9F LEAK-2).
    installEffectCacheFix()
    // WebGL2: settle each new program's link before its first draw (W9F BF-1: dropped draws on new variants).
    installLinkSettle()
  }

  /** The parts that are set, in call order. */
  parts(): RenderPart[] {
    return [this.lighting, this.shadows, this.materials, this.post].filter((p): p is RenderPart => p !== null)
  }

  /** The active camera the post stack and TAA attach to (null before attachCamera). */
  get activeCamera(): Camera | null {
    return this.camera
  }

  /** The shelter map under its RENDER.md name (D20: one map, owned by the weather). */
  get rainOcclusion(): ShelterMap | null {
    return this.shelterOf()
  }

  /** The rain-occlusion texture (null while none). */
  get rainOcclusionTexture(): BaseTexture | null {
    return this.shelterOf()?.texture ?? null
  }

  /**
   * The world the renderer's own parts draw from (World calls this at the end of its constructor). On the PBR path the
   * lighting part is built now; the shadow part at the first update.
   */
  bindWorld(host: RenderHost): void {
    this.host = host
    this.ensureParts(false)
  }

  /** The material path (World.setRenderMode calls this; the world rebuilds its materials). */
  setMode(mode: RenderPath): void {
    this.mode = mode
    for (const p of this.parts()) p.setMode?.(mode)
    if (mode === 'pbr') this.ensureParts(false)
    else this.dropOwnParts()
  }

  /** Builds the RND-L parts the PBR path needs and are still missing (`withShadows`: the shadow part too). */
  private ensureParts(withShadows: boolean): void {
    const host = this.host
    if (!host || this.mode !== 'pbr' || this.disposed) return
    if (!this.lighting) {
      const l = new WorldLighting(this.scene, { quality: this.quality, retailSun: host.sun, sky: host.sky, skyStyle: () => host.skyStyle })
      l.setWeather(this.weather)
      this.lighting = l
    }
    if (!this.post) this.post = new RenderPost(this)
    if (withShadows && !this.shadows && this.lighting instanceof WorldLighting) {
      const s = new WorldShadows(this.scene, this.lighting.celestial, host, { quality: this.quality })
      for (const m of this.characters) s.addCharacter(m)
      for (const [m, k] of this.characterCascades) s.setCharacterCascades(m, k)
      this.shadows = s
    }
  }

  /** Disposes the parts ensureParts built (the Classic path has none). */
  private dropOwnParts(): void {
    if (this.post instanceof RenderPost) {
      this.post.dispose()
      this.post = null
    }
    if (this.shadows instanceof WorldShadows) {
      this.shadows.dispose()
      this.shadows = null
    }
    if (this.lighting instanceof WorldLighting) {
      this.lighting.dispose()
      this.lighting = null
    }
  }

  setQuality(q: Readonly<RenderQuality>): void {
    this.quality = q
    for (const p of this.parts()) p.setQuality?.(q)
  }

  setWeather(w: Readonly<RenderWeather>): void {
    this.weather = w
    for (const p of this.parts()) p.setWeather?.(w)
  }

  /** Per frame, last in World.update. */
  update(camera: Camera | null, sky: Readonly<SkyState>): void {
    if (this.host && this.mode === 'pbr' && !this.shadows) this.ensureParts(true)
    if (camera && !this.camera && this.mode === 'pbr' && this.host) this.attachCamera(camera)
    for (const p of this.parts()) p.update?.(camera, sky)
  }

  /** The camera the post stack renders through (GAME: the world camera; the viewer: its orbit camera). */
  attachCamera(camera: Camera): void {
    this.camera = camera
    for (const p of this.parts()) p.attachCamera?.(camera)
  }

  /** Decorates one character / equipment material (a no-op until RND-M's part exists, and on the Classic path). */
  decorateCharacterMaterial(mat: Material): void {
    for (const p of this.parts()) p.decorateCharacterMaterial?.(mat)
  }

  /** Decorates every material of a loaded character container (idempotent per material is the part's job). */
  decorateCharacterMaterials(container: AssetContainer): void {
    for (const m of container.materials) this.decorateCharacterMaterial(m)
  }

  /** A character mesh that should cast and receive the renderer's shadows (players, mobs, NPCs). */
  addCharacter(mesh: AbstractMesh): void {
    this.characters.add(mesh)
    for (const p of this.parts()) p.addCharacter?.(mesh)
  }

  removeCharacter(mesh: AbstractMesh): void {
    this.characters.delete(mesh)
    this.characterCascades.delete(mesh)
    for (const p of this.parts()) p.removeCharacter?.(mesh)
  }

  /**
   * G1 rescue (apps/game world/crowd-budget.ts): how many shadow cascades a character root casts into: Infinity (the
   * default) every cascade, 0 none, k the first k. Kept for a shadow part built later; a no-op without shadows.
   */
  setCharacterCascades(mesh: AbstractMesh, cascades: number): void {
    if (cascades === Infinity) this.characterCascades.delete(mesh)
    else this.characterCascades.set(mesh, cascades)
    for (const p of this.parts()) p.setCharacterCascades?.(mesh, cascades)
  }

  /** Characters added so far (for a part attached later). */
  get characterMeshes(): ReadonlySet<AbstractMesh> {
    return this.characters
  }

  dispose(): void {
    this.disposed = true
    for (const p of this.parts()) p.dispose?.()
    this.lighting = this.shadows = this.post = this.materials = null
    this.characters.clear()
    this.characterCascades.clear()
    this.camera = null
    this.host = null
  }
}

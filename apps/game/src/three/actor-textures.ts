/**
 * The texture sets of actors (wave 9B lane TX-R; docs/WAVE_PLAN3.md §7.1, D35; docs/TEXPIPE.md §6.4): every character,
 * armour and weapon glb a ModelLibrary loads, on every screen (character select, character creation, the world),
 * swaps its retail textures for the remastered set of the device's texture tier a moment after it appears
 * (@sro/world-render ActorMaps: decode worker, one upload job per map in the frame budget, the retail texture freed
 * after the swap). Nothing is swapped on the 'retail' tier, which is every tier without the new look (the Low guard).
 *
 * The sets: `pbr/index.json` (sro-pbr, keyed by the retail texture path from the glb's sidecar, else by the image
 * name's stem with the glb path choosing between man_item and woman_item) and `remaster/manifest.json` (sro-remaster,
 * which wins, D35), under the root the models load from (/out-opt/ when the slimmed tree answers, else /out/); loaded
 * once per page. The tier is read when a glb loads (settings.ts effectiveGraphics `textureTier`), so a change applies
 * after a reload. It is the tier of the preset the world runs (W9F TEX-3): the same inputs as screens/world.ts, i.e.
 * `?quality=` and the GPU's 16-varying cap, so a Low world never dresses its actors in a High set. One exception
 * (W9F LG-4): a settings change that makes the tier 'retail' (the preview turned off, a live switch to Low) puts every
 * tracked actor back on its retail textures at once, and leaving 'retail' re-applies the sets (ActorMaps.refresh).
 *
 * Uploads (W9F CPU-1): on a screen without a region streamer the swaps run on their own frame scheduler; in the world
 * the screen hands them the streamer's map scheduler (`useScheduler`), so actor fetches and uploads share the
 * streamer's limiter and frame budget at its lowest priority instead of adding a second budget on top of it.
 */
import type { AbstractEngine, AssetContainer, Scene } from '@babylonjs/core'
import {
  ActorMaps,
  browserIO,
  frameScheduler,
  gpuInfoFromEngine,
  ktx2MapsAvailable,
  loadPbrMapIndex,
  policyForTier,
  urlMapSource,
  type ActorSidecar,
  type MapScheduler,
  type PbrMapIndex,
  type TextureTier,
} from '@sro/world-render'
import { effectiveGraphics, settings, type EffectiveGraphics, type GpuHint } from '../settings.ts'
import { urlQuality } from '../world/jangan/ground.ts'
import { glbKeyPath } from './remaster.ts'
import { OPT_PREFIX, OUT_PREFIX, slimAvailable } from './slim.ts'

/** Main-thread upload work per frame on a screen without a region streamer (ms; at least one job a frame). */
export const ACTOR_UPLOAD_BUDGET_MS = 3

let index: Promise<PbrMapIndex> | null = null

/** The page's map sets (loaded once; a missing index is "no sets"). */
export function actorMapIndex(): Promise<PbrMapIndex> {
  index ??= (async () => {
    const root = (await slimAvailable()) ? OPT_PREFIX : OUT_PREFIX
    return loadPbrMapIndex(browserIO, new URL(root, globalThis.location?.href ?? 'http://localhost/').href)
  })()
  return index
}

const scenes = new WeakMap<Scene, ActorTextures>()
const gpus = new WeakMap<AbstractEngine, GpuHint>()

/**
 * The effective graphics of the preset the world runs on this engine (W9F TEX-3: the same inputs as screens/world.ts,
 * `?quality=` and the GPU): the actors' texture tier, and whether the character screens render the new look.
 */
export function actorGraphics(engine: AbstractEngine): EffectiveGraphics {
  let gpu = gpus.get(engine)
  if (!gpu) {
    try {
      gpu = gpuInfoFromEngine(engine)
    } catch {
      gpu = {}
    }
    gpus.set(engine, gpu)
  }
  const s = settings.get()
  return effectiveGraphics(s, { gpu, preset: urlQuality() ?? s.graphics.preset })
}

/** The texture tier actors load on this engine: the effective graphics of the preset the world runs (W9F TEX-3). */
export function actorTextureTier(engine: AbstractEngine): TextureTier {
  return actorGraphics(engine).textureTier
}

/** One scene's actor texture swaps. */
export class ActorTextures {
  readonly maps: ActorMaps
  private readonly sched: ReturnType<typeof frameScheduler>
  private readonly offSettings: () => void

  constructor(readonly scene: Scene) {
    const source = urlMapSource(scene, url => browserIO.bytes(url), (bytes, mime, size) => browserIO.decodeImage(bytes, mime, size))
    this.maps = new ActorMaps(scene, source, {
      index: actorMapIndex,
      policy: () => policyForTier(actorTextureTier(scene.getEngine()), ktx2MapsAvailable(scene)),
    })
    this.sched = frameScheduler(scene, { budgetMs: ACTOR_UPLOAD_BUDGET_MS, concurrency: 2 })
    this.maps.cache.setScheduler(this.sched)
    this.offSettings = settings.onChange(() => this.maps.refresh())
    scene.onDisposeObservable.addOnce(() => this.dispose())
  }

  /**
   * The scheduler new map work goes to: a region streamer's map scheduler (the world screen), or null for this scene's
   * own frame scheduler. Work already queued on the own scheduler still drains there.
   */
  useScheduler(s: MapScheduler | null): void {
    this.maps.cache.setScheduler(s ?? this.sched)
  }

  /** A glb the library loaded (its URL and converter sidecar). */
  track(container: AssetContainer, glbUrl: string, sidecar?: ActorSidecar | Record<string, unknown> | null): void {
    void this.maps.track(container, glbKeyPath(glbUrl), (sidecar as ActorSidecar | null | undefined) ?? null).catch(err => {
      console.warn('[textures] actor maps failed', glbUrl, err)
    })
  }

  untrack(container: AssetContainer): void {
    this.maps.untrack(container)
  }

  dispose(): void {
    this.offSettings()
    this.sched.dispose()
    this.maps.dispose()
    if (scenes.get(this.scene) === this) scenes.delete(this.scene)
  }
}

/** The actor texture swaps of a scene (created on first use). */
export function actorTexturesFor(scene: Scene): ActorTextures {
  let a = scenes.get(scene)
  if (!a) {
    a = new ActorTextures(scene)
    if (!scene.isDisposed) scenes.set(scene, a)
    // `window.__sroActorTextures` (console, LAB): the latest scene's swaps (maps.cache.stats, applied(container)).
    ;(globalThis as { __sroActorTextures?: ActorTextures }).__sroActorTextures = a
  }
  return a
}

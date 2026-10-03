/**
 * The character-screen stages (docs/SCREENS.md §0B, §4.1, §4.3; lane SCR-S's seam, landed by W10-G): character select
 * and create stand on real Jangan scenery (the south-gate "palace steps"), loaded through the world renderer. Screens
 * only call `app.stage.enter(STAGES.select | STAGES.create)` (app.ts); they never call `loadWorld` or make a `Scene`.
 * The host (stage/host.ts, SCR-R) owns the one stage `World` and its scene. This wave: the fixed camera only (the intro
 * and login paths are deferred), so `StageDef.camera.kind` is `'fixed'`.
 */
import type { ArcRotateCamera, Scene, TransformNode } from '@babylonjs/core'
import type { World } from '@sro/world-render'
import type { ModelLibrary } from '../three/models.ts'

/** The stages of this wave (the intro and login stages are deferred, SCREENS §0B). */
export type StageId = 'select' | 'create'

/**
 * A fixed camera (SCREENS §0B.2): an `ArcRotateCamera` on the spot. `yaw` is the look heading (radians, 0 = looking
 * +Z); `distM` the distance (select applies the fit rule on top), `heightM` / `targetHeightM` above the spot's ground.
 */
export interface StageFixedCamera {
  kind: 'fixed'
  distM: number
  heightM: number
  yaw: number
  fovDeg: number
  targetHeightM: number
  /** Camera and target moved right together (m; create's full body 0.45 m). Default 0. */
  truckM?: number
  /** Create's face zoom key (the zoom button blends to it in 0.5 s). */
  zoom?: { distM: number; heightM: number; targetHeightM: number; truckM?: number }
}

/** One stage (the data of stage/stages.ts, SCR-R). */
export interface StageDef {
  id: StageId
  /** Export folder under /out(-opt)/world/, or 'server' = the selected server's `ServerInfo.world` (default jangan-fields). */
  world: string
  /** The spot (glTF metres, in that export's frame) where characters stand; y is re-snapped to the nav surface. */
  spot: { x: number; z: number; yHint: number }
  /** Heading of the row / the character (radians, 0 = +Z), facing the camera. */
  facing: number
  camera: StageFixedCamera
  /** 0..1 time of day, or 'server' (the ServerInfo clock, SCREENS §9) with `fallback`. */
  time: number | { kind: 'server'; fallback: number }
  /** Weather: 'clear' (default) or 'server'. Stages never start rain on their own. */
  weather: 'clear' | 'server'
  /** Streaming focus radius (m) the screen waits for (default 120; the palace steps use 150, SCREENS §0B.4). */
  readyRadiusM?: number
  /** The objects' draw-range scale cap while this stage is up (create: 0.6, SCREENS §0B.9); absent: the preset's. */
  rangeScaleCap?: number
}

/** A stage the host entered (SCREENS §4.3). */
export interface Stage {
  readonly def: StageDef
  readonly scene: Scene
  readonly world: World
  readonly camera: ArcRotateCamera
  /** Places the fixed camera (a path camera's time t in seconds once the intro lands). */
  setCameraTime(t: number): void
  /**
   * The standing points for n characters (nav-snapped), in slot order, and their facing. SCR-R: `selected` (select)
   * is the slot that stepped forward (SELECT_STEP_M toward the camera).
   */
  slots(n: number, selected?: number): { x: number; y: number; z: number; yaw: number }[]
  /**
   * Registers an actor's meshes with the renderer (shadows, PBR characters, the face key light). After the warm-up the
   * actor is prepared before it shows (P-STALL: hidden while its shaders and pipelines are made, a few frames; on a
   * re-entered stage until the orbit ends); `isShown` says when it is drawn.
   */
  addActor(root: TransformNode): void
  removeActor(root: TransformNode): void
  /** The actor is drawn: enabled, and not being prepared (P-STALL). */
  isShown(root: TransformNode): boolean
  /** SCR-R: the stage scene's model library (the world's character-material decoration is on it; the host owns it). */
  readonly library: ModelLibrary
  /** SCR-R: the spot's ground height (m, nav-snapped). */
  readonly ground: number
  /** SCR-R: create's zoom blend, 0 = full body .. 1 = the face key (the screen tweens it over STAGE_ZOOM_MS). */
  setZoom(f: number): void
}

/** SCR-R: what `enter` takes besides the stage (docs/SCREENS.md §0B.4). */
export interface StageEnterOptions {
  /** 0..1 over the world, the actors and the shader warm-up (one loading bar). */
  onProgress?: (f: number) => void
  /** Aborts a load in progress (`enter` rejects with an AbortError and the stage is released). */
  signal?: AbortSignal
  /**
   * Starts at once, beside the world load (§0B.4 "in parallel, not after"): the screen fetches its characters into the
   * stage's library. `enter` waits for it before `actors`.
   */
  preload?: (scene: Scene, library: ModelLibrary) => Promise<unknown>
  /**
   * Once the world is in and before the shader warm-up: the screen places and registers its actors (`stage.slots`,
   * `stage.addActor`), so the warm-up compiles them with the world. On a reused world it runs as soon as `preload` is
   * done, while the camera may still orbit (P-STALL: the actors are prepared meanwhile), before `enter` resolves.
   */
  actors?: (stage: Stage) => Promise<unknown>
  /**
   * On a reused world whose camera heading changes (select ↔ create): orbit round the spot over this long (ms; ease in
   * and out; STAGE_ORBIT_MS). 0 or absent: the camera jumps.
   */
  orbitMs?: number
}

/** The page's stage host (app.stage; SCREENS §4.3, §4.5). */
export interface StageHost {
  /**
   * Loads (or reuses: select → create on the same export keeps the `World`) the stage world, places the camera, sets
   * time and weather; resolves when the regions within `readyRadiusM` of the spot are in and the stage has rendered
   * once. Rejects when the stage cannot be built (the screens then run today's fallback scene).
   */
  enter(def: StageDef, opts?: StageEnterOptions): Promise<Stage>
  /** Disposes the World and the scene (world screen entry, logout). Safe to call when nothing is entered. */
  release(): void
}

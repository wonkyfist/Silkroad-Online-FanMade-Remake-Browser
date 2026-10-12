/**
 * The perf audit's switches (docs/PERF_AUDIT.md): each fix of the audit is on by default and has one switch here so
 * the bench (`pnpm charbench --scenes crowd --ab <name>`, `window.__sroPerf`) can measure it off and on in interleaved
 * pairs on one page. Nothing else changes them.
 */
export const PERF = {
  /** Hit-effect batch meshes are pooled and reused instead of a new Babylon mesh per effect node (world/skill-fx.ts). */
  fxPool: true,
  /** An effect batch that drew nothing twice in a row skips its three vertex uploads (@sro/fx FxLibrary.skipEmptyUploads). */
  fxSkipEmpty: true,
  /** Name plates read their anchor from numbers kept by the view, not by parsing the label's CSS transform (nameplates.ts). */
  plateAnchor: true,
  /** The own character's key light and the licensed hair's soft pass (world/features/self-key.ts, CHARACTERS §16.1). */
  charLook: true,
  /** The own licensed character's environment light: sky + sun-lit ground bounce (world/features/self-env.ts, CHARACTERS §16.4). */
  charEnv: true,
  /** The face light: the key's sky floor, the face fill, the close licensed bodies and the skin's wrap diffuse (self-key.ts, CHARACTERS §16.5). */
  faceLight: true,
  /**
   * Cloth wear (world/features/cloth-wear.ts, CHARACTERS §16.9) re-dresses a body only where it shows: not at LOD2 / in
   * the crowd (dressed on the way back to LOD1), and the levels drop with hysteresis (a fighter in town no longer
   * flips a step every second). Off: every change re-dressed every body within 40 m (its crowd slot and merges rebuilt).
   */
  wearLazy: true,
  /**
   * The part merge (models.ts setMergeParts) is made again after a licensed LOD switch, a re-dress or leaving the crowd
   * dropped its meshes (world/crowd-budget.ts; they left it on, so the plan never rebuilt it). Off: those bodies stayed
   * unmerged (a LOD1 body of the §16.9 wardrobe export: ≈ 19 meshes instead of ≈ 6).
   */
  mergeRedo: true,
  /**
   * The Overall Pass stutter fix (docs/PERF_OVERALL.md): in play, a mesh draw whose WebGPU render pipeline is missing has
   * it made in the background and is skipped until it is (screens/pipelines.ts), instead of the frame waiting for the
   * GPU process to compile it. Off: Babylon makes it at the draw (the 100-470 ms hitches when walking / turning).
   */
  pipelinesInPlay: true,
  /**
   * New meshes in play have their effects compiled in a budgeted pass and are drawn out of view (as ghosts) for a few
   * frames, so their pipelines exist before the camera turns to them (screens/pipelines.ts watchScene). **Off** since
   * round 6 (docs/PERF_OVERALL.md): on the discrete GPU the route had 23 frames over 33 ms with it and 13 without (the
   * in-play pipeline rule and the persistent effects already remove the stalls it was for); kept for the bench's A/B.
   */
  prewarmNew: false,
  /**
   * Babylon's Effect.PersistentMode (engine.ts): a compiled effect (shader variant) is kept when its last material goes,
   * instead of being released and compiled again, pipelines and all, when the next character of that look appears.
   * Measured on the route: 15 net new effects but ≈ 50 % of all garbage was shader processing (despawn / spawn churn),
   * and the in-play pipeline skips came back with every respawn. Off: Babylon's default release.
   */
  effectsPersistent: true,
  /** ShaderMaterial readiness answered from a per-mesh signature instead of a rebuilt define string (three/shader-ready-cache.ts). */
  shaderReadyCache: true,
  /**
   * The licensed character glbs' embedded images shared by content and made at 1024² on Medium and below
   * (three/gltf-texture-share.ts; round 7: 73 uncompressed 2048² copies were 1.56 GB with 8 players). Read at each load.
   */
  licensedTextureShare: true,
  /** Shader sources of ready effects and the raw data of array / volume textures dropped (three/cpu-copies.ts, round 7). */
  trimCpuCopies: true,
  /** Bounding refreshes keep no per-vertex Vector3 copy on the mesh (three/positions-trim.ts, round 7). */
  trimPositions: true,
  /**
   * Smooth walking (docs/PERF_OVERALL.md, round 8): a view's correction is measured against where its own state has it
   * now (world/entities.ts; it read the stale position of the last frame, so the own `move` echo during a key walk
   * threw the drawn character ahead by the prediction's lead, and a move that began after the last frame pulled it
   * back), the key walk's 100 ms timer only sends (no re-plan between frames), and the camera stays on the drawn
   * character on the ground plane (screens/world.ts; the dt-scaled lerp's lag changed with every frame time). Off:
   * the code before.
   */
  smoothMotion: true,
  /**
   * The world frame's time is the frame's own (vsync-aligned) begin time, `document.timeline.currentTime`, for the
   * views' server time and dt, instead of `performance.now()` read part-way into the frame (screens/world.ts).
   */
  frameClock: true,
}

export type PerfSwitch = keyof typeof PERF

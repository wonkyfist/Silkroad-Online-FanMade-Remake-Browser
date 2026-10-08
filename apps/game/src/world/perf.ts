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
}

export type PerfSwitch = keyof typeof PERF

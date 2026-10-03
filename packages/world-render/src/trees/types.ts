/**
 * The trees part's seams (docs/TREES.md Part W §W3, §W3.9, WF9, WF11, WF14; docs/WAVE_PLAN8.md §4.2 step 1, D2, D16).
 * Written by W12-SA; the near field, the band byte and the slots are T12-N's (`trees/{swap, bands, near-field,
 * index}.ts`), the editor API T12-E's (`trees/editor.ts`), the merge T12-M's (`batch/trees.ts`).
 *
 * `World.trees` is a world-render part like `World.town`: made **only where the swap applies**, i.e. on the PBR path of
 * a streamed world with region batching on and `LoadWorldOptions.trees` 'new' (World.setTreeMode); **null on
 * Low/Classic** (the Low guard), with 'retail', and with batching off. Made before the batching part (the batch reads
 * its slots through `host.world.trees`), updated once per frame after the objects, disposed after the batching part
 * when that goes (a path switch, the batching toggle, a tree-mode change, the world's dispose). Its meshes (the LOD0
 * overlay) carry `metadata.sroWorld = 'object'` and `sroTree: true`; the merged LOD1 + LOD2 tiers are the region
 * batch's.
 */
import type { AbstractMesh, Camera, Scene } from '@babylonjs/core'
import type { World } from '../world.ts'

/**
 * Options → Graphics → Trees (WAVE_PLAN8 §3.4, D9): 'new' draws the species that replace the retail trees and plants
 * (TREES Part W) wherever the manifest carries `treeSwap`; 'retail' draws the retail models (the swap never applies).
 * Low (Classic) never swaps whatever the setting.
 */
export type TreesMode = 'new' | 'retail'

/** The tree modes. */
export const TREES_MODES: readonly TreesMode[] = ['new', 'retail']

/**
 * A placement's key in the trees part and the editor (the band slot's owner, `preview`, `setHidden`): its owner region
 * id and its owner-region-unique uid, as the nav's instance ids (`regionId << 16 | uid`, packages/nav). Region ids are
 * 15-bit and uids 16-bit (the editor's range is 0xE000–0xEFFF), so the key is a non-negative 31-bit integer.
 */
export function placementKey(region: number, uid: number): number {
  return (region & 0x7fff) * 0x10000 + (uid & 0xffff)
}

/** The region and uid of a placement key (placementKey's inverse). */
export function placementOfKey(key: number): { region: number; uid: number } {
  return { region: Math.floor(key / 0x10000) & 0x7fff, uid: key & 0xffff }
}

/**
 * One species of the World Editor's Trees tab (TREES §W3.9, `content/trees/library.json` written by the tree tool):
 * placing it adds a placement of its retail **carrier** (D16), which the swap draws as the species on Medium+.
 */
export interface TreeLibraryEntry {
  /** Species id (`pine07`, `maple`…). */
  readonly id: string
  /** Display name ("Chinese pine"). */
  readonly name: string
  /** The retail carrier model's source path (the swap source with the closest envelope). */
  readonly carrier: string
  /** The review-sheet thumbnail (relative to the asset root), or null. */
  readonly thumbnail: string | null
  /** The size range the editor offers (uniform scale; D17: 0.85–1.15). */
  readonly size: readonly [number, number]
  /** The default tint (a texture key), or null. */
  readonly tint: string | null
}

/** T12-N's trees part (World.trees). */
export interface TreesPart {
  /** Per frame, after the objects (World.update): the band refill and the overlay's instance lists. */
  update(camera: Camera | null, dt: number): void
  /** Every mesh it draws (the LOD0 overlay; the merged tiers belong to the region batch). */
  meshes(): AbstractMesh[]
  /** The species the editor lists (T12-E; `content/trees/library.json`). */
  library(): readonly TreeLibraryEntry[]
  /**
   * The editor's live preview (TREES §W3.9, WF14): one LOD0 overlay instance of `species` at `matrix` (16 floats, world
   * space), with the merged copy of the placement `key` (placementKey; null for a new placement) hidden meanwhile
   * (band 3). `species` null ends the preview (the hidden copy comes back unless `setHidden` holds it).
   */
  preview(key: number | null, species: string | null, matrix?: ArrayLike<number> | null): void
  /** Hides (band 3) or shows a placement's merged copy and overlay instance (the editor's drag and delete). */
  setHidden(key: number, on: boolean): void
  /** Counters for the lab panel and the bench (slots, overlay draws, band counts…). */
  stats(): Readonly<Record<string, number>>
  dispose(): void
}

/** What the trees part is built from (World passes itself: its manifest, objects, batch, render, focus). */
export interface TreesHost {
  readonly scene: Scene
  readonly world: World
}

/** Makes the trees part (trees/index.ts `createTreesPart`; LoadWorldOptions.parts.trees in tests). null: none. */
export type TreesFactory = (host: TreesHost) => TreesPart | null

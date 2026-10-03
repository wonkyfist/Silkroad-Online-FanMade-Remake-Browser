/**
 * Coast seams (docs/COAST.md §8.1, §8.10, §8.13 S-BOUNCE / S-MOVE / S-LIFE, F5; docs/WAVE_PLAN6.md §4.1 step 3, D2,
 * D12, D22, D27). Written by W10-S; the ocean surface is CST-O's (`ocean/**`), the shore CST-S's (`shore/**`,
 * `coast/chunks.ts`), the coast field and `manifest.coast` CST-C's.
 *
 * `World.ocean` is a generic part: made from the manifest on every path (the Classic 3-Gerstner ocean on Low, the FFT
 * ocean on the PBR presets), updated after the objects every frame, disposed with the world. `World.coast` is its
 * coast field accessor (null until CST-O builds one), and `World.waterLevelAt` reads it before the retail water.
 */
import type { AbstractMesh, Camera, Scene } from '@babylonjs/core'
import type { OceanQuality } from '../render/quality.ts'
import type { World } from '../world.ts'

/** The coast field as other parts read it (S-BOUNCE, S-LIFE, S-MOVE): the sea mask and the sea level. */
export interface CoastAccess {
  /** The sea level (glTF metres; `manifest.coast.seaLevelM`, +5 m in Jangan). */
  readonly seaLevelM: number
  /** True where glTF (x, z) is open sea (the coast field's sea mask). */
  seaAt(x: number, z: number): boolean
}

/** CST-O's ocean part (World.ocean). */
export interface OceanPart {
  /** The coast field (null: none yet). */
  readonly coast: CoastAccess | null
  /** Per frame, after the objects (World.update). */
  update(camera: Camera | null, dt: number): void
  /** Every mesh it draws (tagged 'ocean': the region batcher never takes them; a shelter candidate like the water). */
  meshes(): AbstractMesh[]
  /** The preset's ocean row (RENDER_PRESETS[p].ocean; World.setQuality); null on a preset without one. */
  setQuality?(q: Readonly<OceanQuality> | null): void
  /** Shown or hidden (the character stage hides it if it costs more than 0.3 ms there, D27). */
  setVisible?(on: boolean): void
  /** The material path changed (World.setRenderMode, before the regions rebuild). */
  setMode?(mode: 'pbr' | 'classic'): void
  dispose(): void
}

/** What the ocean is built from (World passes itself: manifest.coast, the water's PBR state, the renderer). */
export interface OceanHost {
  readonly scene: Scene
  readonly world: World
}

/** Makes the ocean part (ocean/index.ts `createOceanPart`; LoadWorldOptions.parts.ocean in tests). null: none. */
export type OceanFactory = (host: OceanHost) => OceanPart | null

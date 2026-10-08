/**
 * A rare weapon on the ground (docs/RARITY.md §5.6): the drop moment and its standing mark, drawn by the scene's rare
 * effects (world/rarity/fx.ts, one batch for everything):
 *  - Seal of Star: a constellation draws itself star by star above the drop, then falls onto it as a shooting star and
 *    bursts; a slim violet column with orbiting stars stays;
 *  - Seal of Moon: a moonbeam comes down from the sky onto it, a crescent shockwave runs over the ground, a filigree
 *    crescent floats above it among moonlit ripples; the beam stays, softer;
 *  - Seal of Sun: a pillar of sunfire erupts with a solar flare and god rays, the golden sun-disc opens on the ground
 *    and turns; a burning column with climbing flames and embers stays.
 * A drop already lying there when you arrive shows only its mark. Classic draws it too (a few quads).
 */
import type { Scene, TransformNode } from '@babylonjs/core'
import type { RarityTier } from '@sro/shared'
import { rarityFx, type DropFx } from './rarity/fx.ts'

export interface BeamShape {
  /** The standing column's height and width (m), the ground mark's diameter (m), and its pulse depth (0..1) and period (s). */
  height: number
  width: number
  ring: number
  pulse: number
  pulseS: number
}

/** docs/RARITY.md §5.6 [decision]: each tier a clear step up. */
export const BEAM_SHAPES: Readonly<Record<RarityTier, BeamShape>> = {
  star: { height: 2.6, width: 0.32, ring: 1.1, pulse: 0.15, pulseS: 2.9 },
  moon: { height: 6, width: 1.1, ring: 2.4, pulse: 0.1, pulseS: 5.7 },
  sun: { height: 10, width: 0.85, ring: 2.5, pulse: 0.15, pulseS: 0.8 },
}

/** The mark's alpha at `s` seconds (1 ± pulse). */
export function beamAlpha(shape: BeamShape, s: number): number {
  return 0.85 * (1 - shape.pulse + shape.pulse * (0.5 + 0.5 * Math.sin((2 * Math.PI * s) / shape.pulseS)))
}

/** One rare drop's moment and mark, under `parent` (the drop's root, at the ground). */
export class RarityBeam {
  private readonly fx: DropFx
  private disposed = false

  constructor(readonly scene: Scene, readonly tier: RarityTier, parent: TransformNode, fresh = true) {
    this.fx = rarityFx(scene).addDrop(tier, parent, fresh)
  }

  /** Kept for the drop's frame (the effects run on the scene's clock). */
  update(_dt: number): void {}

  setEnabled(on: boolean): void {
    this.fx.enabled = on
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    rarityFx(this.scene).removeDrop(this.fx)
  }
}

/**
 * The ice look of the winter monsters (docs/WINTER.md §13.7): a snow spirit is a retail ghost and the Ice Yeti a retail
 * Yeoha, drawn under an icy overlay on THAT actor's meshes only (the exposure-aware overlay the hover tint uses,
 * world-render setHighlightOverlay); every other ghost and Yeoha is untouched. The actor shading ignores material
 * colours, so the overlay is what reads. An entity attachment: applied when the model is in, re-applied every frame a
 * mesh has none (after a hover ended, or a part merge made new meshes; a hover's own tint wins while it lasts), and
 * cleared with the view.
 */
import { Color3, type AbstractMesh } from '@babylonjs/core'
import { setHighlightOverlay } from '@sro/world-render'
import { WINTER_CODES } from '@sro/shared'
import type { EntityAttachment, EntityView } from '../entities.ts'

export interface IceTint {
  color: Color3
  /** Overlay opacity 0..1. */
  alpha: number
}

/** The spirits: cold blue; the yeti: frosted white fur with a faint blue. */
export const ICE_TINTS: Readonly<Record<string, IceTint>> = {
  [WINTER_CODES.sprite]: { color: new Color3(0.62, 0.85, 1), alpha: 0.62 },
  [WINTER_CODES.spirit]: { color: new Color3(0.5, 0.78, 1), alpha: 0.66 },
  [WINTER_CODES.yeti]: { color: new Color3(0.97, 0.99, 1), alpha: 0.84 },
}

/** The attachment for a winter monster's view (null for every other view). */
export function iceLook(v: EntityView): EntityAttachment | null {
  const tint = v.state.kind === 'mob' ? ICE_TINTS[v.state.model] : undefined
  if (!tint) return null
  const mine = new Set<AbstractMesh>()

  const apply = () => {
    const actor = v.actor
    if (!actor) return
    for (const m of actor.allMeshes() as AbstractMesh[]) {
      if (!m.material || m.isDisposed() || m.renderOverlay) continue
      setHighlightOverlay(m, tint.color, tint.alpha)
      mine.add(m)
    }
  }

  return {
    loaded: apply,
    update: apply,
    dispose() {
      for (const m of mine) if (!m.isDisposed()) setHighlightOverlay(m, null)
      mine.clear()
    },
  }
}

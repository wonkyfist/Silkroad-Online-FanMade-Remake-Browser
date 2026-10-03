/**
 * The townsfolk on the file being edited (docs/WORLD_EDITOR.md §4.11 "Live preview: the town part re-reads the
 * graph"; lane WE-T): the editor's world gets a town part whose plan is TL-R's schedule on the Routes tool's current
 * file (`content/town/jangan.json` as the API serves it, not the export's copy), so a moved bench shows its sitter
 * once the crowd re-plans.
 *
 * The town part has no "reload your file" call yet (world-render is not this lane's): a re-plan is asked for through
 * the `noFolk` circles, which the part compares and re-plans on when they differ (H11-HI-2). The preview keeps one
 * circle 10,000 km away and nudges its radius, so every refresh is exactly one re-plan on the newest file and nothing
 * is routed round it. Without the API (no file) the default plan runs (the export's town.json).
 */
import type { World } from '@sro/world-render'
import type { TownFile } from '../../../../../packages/shared/src/town.ts'
import { defaultPlan, schedulePlan, townPartWith, type TownPlan } from '../../../../../packages/world-render/src/town/index.ts'
import type { TownFactory } from '../../../../../packages/world-render/src/town/types.ts'

/** Far beyond every map: routing round it changes nothing. */
const FAR = { x: 1e7, z: 1e7 }
/** How long the crowd waits for the editor's file before it falls back to the export's (ms). */
const WAIT_MS = 8000

export class TownPreview {
  private file: TownFile | null = null
  private settled = false
  private resolveReady: () => void = () => {}
  private readonly ready: Promise<void>
  private nudge = 0

  constructor() {
    this.ready = new Promise<void>(r => (this.resolveReady = r))
    setTimeout(() => this.settle(), WAIT_MS)
  }

  private settle(): void {
    if (this.settled) return
    this.settled = true
    this.resolveReady()
  }

  /** The factory for `loadWorld({ parts: { town } })`. */
  factory(): TownFactory {
    return townPartWith({
      plan: (world, noFolk) => this.ready.then(() => (this.file ? this.make(world, noFolk) : defaultPlan(world, noFolk))),
    })
  }

  private make(world: World, noFolk: Parameters<typeof schedulePlan>[2]): TownPlan {
    const plan = schedulePlan(this.file!, world, noFolk)
    plan.replan = next => this.make(world, next)
    return plan
  }

  /** The file the crowd walks (the first call also lets the waiting town start). */
  setFile(file: TownFile | null): void {
    this.file = file
    this.settle()
  }

  /** Re-plans the crowd on the current file (after a committed change; never while dragging). */
  refresh(world: World): void {
    const town = world.town
    if (!town || !this.file) return
    this.nudge = (this.nudge + 1) % 2
    try {
      town.configure({ noFolk: { x: FAR.x, z: FAR.z, r: 1 + this.nudge } })
    } catch (err) {
      console.warn('[editor] the town crowd could not re-plan:', err)
    }
  }
}

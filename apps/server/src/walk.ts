// Walk / run (overall-pass walk mode): every player runs unless it asked to walk (`walk {on}`: the R key or the Action
// window's Walk / Run slot). The choice is per session (the client re-sends its saved one on entering the world). The
// server moves a walking player at WALK_SPEED_FACTOR × its run speed (world.ts moveTo, the chase in gameplay / npc):
// the client only asks, so a cheating client can never move faster than it runs; viewers see the slower `move` and
// play the walk clip (entities.ts gait: below the run threshold).
import { WALK_SPEED_FACTOR, type GameplayRequest } from '@sro/shared'
import type { Gameplay } from './gameplay.ts'
import type { Answer, GameplayMessage, GameplayModule } from './modules.ts'
import type { Player } from './world.ts'

/** Players walking. */
export const walking = new WeakSet<object>()

/** The player's speed factor from walking (1 when running). */
export function walkFactor(p: object): number {
  return walking.has(p) ? WALK_SPEED_FACTOR : 1
}

/**
 * The player's move multiplier: running uses `speedMul` (speed scrolls, buffs, slows); walking is a fixed pace that
 * speed boosts never raise (owner, 2026-10-13), while slows still apply.
 */
export function moveMul(p: { speedMul: number }): number {
  return walking.has(p) ? WALK_SPEED_FACTOR * Math.min(1, p.speedMul) : p.speedMul
}

export class WalkService implements GameplayModule {
  readonly name = 'walk'
  readonly handles: readonly GameplayRequest[] = ['walk']
  readonly whileDead: readonly GameplayRequest[] = ['walk']

  constructor(readonly g: Gameplay) {}

  request(p: Player, msg: GameplayMessage, answer: Answer): void {
    if (msg.t !== 'walk') return answer({ ok: false, reason: 'not_found' })
    if (walking.has(p) !== msg.on) {
      if (msg.on) walking.add(p)
      else walking.delete(p)
      // a move under way goes on at the new pace from here
      this.g.world.setSpeed(p, p.speedMul)
    }
    answer(true)
  }
}

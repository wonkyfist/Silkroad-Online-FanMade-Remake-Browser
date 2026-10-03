import { JUMP_COOLDOWN_KEY, JUMP_COOLDOWN_MS, JUMP_COOLDOWN_SLACK_MS, type GameplayRequest } from '@sro/shared'
import type { Gameplay } from './gameplay.ts'
import { fail } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from './modules.ts'
import type { Player } from './world.ts'

/**
 * The jump (Space) (docs/MOVEMENT.md §4, docs/WAVE_PLAN6.md §3; lane MV-P). A GameplayModule named `movement`.
 *
 * The jump is cosmetic and server-authoritative: an accepted `jump {}` tells the player's viewers (the jumper included)
 * `jump {id, at}` and they play JUMP, or JUMP_RUN while moving. **It never touches the position or the move**: no nav
 * call, no `move`/`stop` broadcast, no state in `EntityState`. So it cannot cross a wall, a blocked nav edge, the coast
 * bounds line or a closed cell, by construction (§4.2 "Crossing terrain").
 *
 * The check order (§4.2, fact-check 2) is the dispatcher's: `Gameplay.request` refuses `dead`, then the module gates
 * run in registration order: `mounted` (mounts.ts `MOUNTED_REFUSED`), the alchemy gate (the jump is NOT a fuse
 * canceller, WAVE_PLAN6 D31: like an emote it keeps the fuse), trade (the jump is on `TRADE_ALLOWED`, and the trade
 * stays open), then `stalling` (a stall owner; `STALL_ALLOWED` has no jump). Only then this module:
 * 1. `cant_act` while stunned, frozen or knocked down (`skills.held`);
 * 2. `busy` during a skill action or a return-scroll cast (the exact test `emote` uses; moving is NOT busy);
 * 3. `cooldown` before `move.jump` in `p.cooldowns`, less JUMP_COOLDOWN_SLACK_MS (arrival jitter of a player tapping
 *    at the client gate's own 1000 ms rhythm).
 * An accepted jump arms the cooldown, stands a sitter up (`entityUpdate {posture: 'stand'}` first, the emote order) and
 * broadcasts. It changes nothing else: auto-attack, a cast, a stall visit and a trade all carry on.
 */
export class MovementService implements GameplayModule {
  readonly name = 'movement'
  readonly handles: readonly GameplayRequest[] = ['jump']

  constructor(readonly g: Gameplay) {}

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t !== 'jump') return answer(fail('not_found'))
    const why = this.problem(p, now)
    if (why) return answer(why)
    p.cooldowns.set(JUMP_COOLDOWN_KEY, now + JUMP_COOLDOWN_MS)
    answer(true)
    this.g.posture.standUp(p)
    this.g.world.broadcastAbout(p, { t: 'jump', id: p.id, at: Math.round(now) })
  }

  /** Why `p` may not jump now (after `dead` and the lock gates), or null. */
  private problem(p: Player, now: number) {
    if (this.g.skills.held(p, now)) return fail('cant_act')
    if (this.g.itemUses.skillBusy(p, now) || this.g.itemUses.casting(p)) return fail('busy', 'casting')
    const readyAt = p.cooldowns.get(JUMP_COOLDOWN_KEY) ?? 0
    if (now < readyAt - JUMP_COOLDOWN_SLACK_MS) return fail('cooldown')
    return null
  }
}

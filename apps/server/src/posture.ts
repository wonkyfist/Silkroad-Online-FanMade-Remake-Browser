import { EMOTE_KINDS, type ActionFailReason, type EmoteKind, type GameplayRequest } from '@sro/shared'
import type { Gameplay } from './gameplay.ts'
import { fail } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule, WarpReason } from './modules.ts'
import type { Player } from './world.ts'

/**
 * Posture and emotes (docs/EFFECTS.md §3.12 and §4 P4, docs/WAVE_PLAN2.md §3.1 and D30; lane FX-S).
 *
 * - `sit {on: true}` sits the player down: `entityUpdate {posture: 'sit'}` to its viewers (the sitter included) and
 *   `EntityState.posture 'sit'` for anyone who sees it later. Refused with `busy` while moving, acting (auto-attack,
 *   a pickup or talk walk), in a skill action or a stun, or reading a return scroll; `in_combat` within 5 s of the
 *   last hit dealt or taken (D30); `dead` comes from Gameplay.request. Sitting twice is `ok`.
 * - `sit {on: false}` stands up; while standing it is simply `ok` (idempotent).
 * - Anything that moves or acts stands a sitter up, `entityUpdate {posture: 'stand'}`: a moveTo (`moved`), stopAction
 *   (`stopped`), an accepted attack, useSkill, pickup or npcTalk (Gameplay.request calls `afterRequest`), a hit dealt
 *   or taken, a started action or cast (`tickPlayer`), death and warps.
 * - `emote` plays for the player's viewers (server `emote`, the sender included). Refused with `busy` while moving,
 *   in a skill action or reading a return scroll; a sitter stands up first. Its budget is CLIENT_RATE_LIMITS.emote.
 *
 * Posture is runtime state only (never saved): a relog or a server restart stands everyone up.
 */

/** D30: sitting is refused this soon after the player's last hit dealt or taken. */
export const SIT_COMBAT_MS = 5000

/**
 * D30: the reason of that refusal: `in_combat` (flipped from wave 7B's 'busy' by I8; the client toasts
 * `action.fail.in_combat`).
 */
export const SIT_COMBAT_REASON: ActionFailReason = 'in_combat'

/** Requests that stand a sitting player up once they are accepted (docs/WAVE_PLAN2.md §3.1 "Standing up"). */
export const STAND_UP_REQUESTS: readonly GameplayRequest[] = ['attack', 'useSkill', 'pickup', 'npcTalk']

export class Posture implements GameplayModule {
  readonly name = 'posture'
  readonly handles: readonly GameplayRequest[] = ['sit', 'emote']
  /** Sitting players: entity id -> server ms they sat down. */
  private readonly sitting = new Map<number, number>()

  constructor(readonly g: Gameplay) {
    // Enter-view and worldEnter snapshots carry the posture (docs/WAVE_PLAN.md decision 37 decorators).
    g.world.decorators.push((e, s) => {
      if (e.kind === 'player' && this.sitting.has(e.id)) s.posture = 'sit'
    })
  }

  /** Whether `p` is sitting. */
  isSitting(p: Player): boolean {
    return this.sitting.has(p.id)
  }

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t === 'sit') return this.sit(p, msg.on, answer, now)
    if (msg.t === 'emote') return this.emote(p, msg.emote, answer, now)
    answer(fail('not_found'))
  }

  private sit(p: Player, on: boolean, answer: Answer, now: number): void {
    if (!on) {
      answer(true)
      return this.standUp(p)
    }
    if (this.sitting.has(p.id)) return answer(true)
    const why = this.sitProblem(p, now)
    if (why) return answer(fail(why === 'in combat' ? SIT_COMBAT_REASON : 'busy', why))
    answer(true)
    this.sitting.set(p.id, now)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, posture: 'sit' })
  }

  /** Why `p` may not sit down now, or null. */
  private sitProblem(p: Player, now: number): string | null {
    if (p.move) return 'moving'
    if (p.action) return 'busy'
    if (this.g.itemUses.skillBusy(p, now) || this.g.skills.held(p, now)) return 'casting'
    if (this.g.itemUses.casting(p)) return 'casting'
    // D30: recent combat answers SIT_COMBAT_REASON ('in_combat').
    if (now - p.lastCombatAt < SIT_COMBAT_MS) return 'in combat'
    return null
  }

  private emote(p: Player, emote: EmoteKind, answer: Answer, now: number): void {
    if (!EMOTE_KINDS.includes(emote)) return answer(fail('not_found'))
    if (p.move) return answer(fail('busy', 'moving'))
    if (this.g.itemUses.skillBusy(p, now) || this.g.itemUses.casting(p)) return answer(fail('busy', 'casting'))
    answer(true)
    // Emote while sitting stands the player up first (docs/WAVE_PLAN2.md §3.1 [decision]).
    this.standUp(p)
    this.g.world.broadcastAbout(p, { t: 'emote', id: p.id, emote })
  }

  /** Stands `p` up when it sits: `entityUpdate {posture: 'stand'}` to its viewers. */
  standUp(p: Player): void {
    if (!this.sitting.delete(p.id)) return
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, posture: 'stand' })
  }

  /** Gameplay.request, after an accepted request of `p`: the acting requests stand it up. */
  afterRequest(p: Player, t: GameplayRequest): void {
    if (this.sitting.has(p.id) && STAND_UP_REQUESTS.includes(t)) this.standUp(p)
  }

  // ---- hooks ----------------------------------------------------------------------------------------

  moved(p: Player): void {
    this.standUp(p)
  }

  stopped(p: Player): void {
    this.standUp(p)
  }

  /** A hit dealt or taken since sitting down, or anything that started an action, a move or a cast. */
  tickPlayer(p: Player, now: number): void {
    const since = this.sitting.get(p.id)
    if (since === undefined) return
    const acting = p.move !== null || p.action !== null || this.g.itemUses.skillBusy(p, now) || this.g.itemUses.casting(p) !== null
    if (acting || p.lastCombatAt >= since) this.standUp(p)
  }

  /** Damage taken stands a player up; death is the last such hit (the client ignores idle changes of a corpse). */
  playerDied(p: Player): void {
    this.standUp(p)
  }

  warped(p: Player, _reason: WarpReason): void {
    this.standUp(p)
  }

  forget(p: Player): void {
    this.sitting.delete(p.id)
  }
}

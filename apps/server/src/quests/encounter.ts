import type { MobVariant, QuestEncounter } from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { NavPoint } from '../nav.ts'
import type { Mob, Player } from '../world.ts'

/**
 * Quest encounters (docs/QUESTS.md §1.6; lane QS-S): a `useItem` objective with an `encounter` (the Tiger Girl's
 * Binding Bell) summons `count` mobs on open ground within 8 m of the user, not tied to a nest:
 * - `g.createMob(..., tuning)` scales HP and attack (hpMul, attackMul); kill EXP is scaled by expMul in `killExp`;
 * - each mob carries `Mob.encounter {quest, owners, despawnAt}`; GM `spawn` does not count them (gm.ts);
 * - one live encounter per quest per owner group (the party, or the player alone): another use answers `cooldown`;
 * - unkilled mobs despawn after `despawnSec`; the owners may summon again only `cooldownSec` (default 60) after the
 *   encounter ended, whether it despawned or was killed by anyone (a kill that gave the owners no credit must not let
 *   them summon a fresh unique at once: that would be an unlimited unique farm). A GM kill ends it with no cooldown;
 * - the cooldown belongs to the character, so abandoning and re-accepting the quest does not reset it;
 * - anyone may fight it, and credit follows the normal kill rules (the engine's mobDied).
 */

/** Metres around the user an encounter mob may appear (docs/QUESTS.md §1.6). */
export const ENCOUNTER_RADIUS_M = 8
/** Nearest an encounter mob appears to the user (so it does not stand inside the player). */
const ENCOUNTER_MIN_M = 3
/** Default wait after an encounter ends before the item summons again (QuestEncounter.cooldownSec). */
export const ENCOUNTER_COOLDOWN_SEC = 60

export interface LiveEncounter {
  quest: string
  objective: string
  /** Mob entity ids still alive. */
  mobs: Set<number>
  /** Character ids of the owner group. */
  owners: Set<number>
  despawnAt: number
  cooldownMs: number
}

export class Encounters {
  private readonly live: LiveEncounter[] = []
  /** `${quest}|${characterId}` -> earliest next summon after an encounter ended (killed, despawned or abandoned). */
  private readonly nextUse = new Map<string, number>()

  constructor(readonly g: Gameplay) {}

  /** Every live encounter (tests, GM tools). */
  all(): readonly LiveEncounter[] {
    return this.live
  }

  /** The live encounter of `quest` owned by any of `owners`, or null. */
  liveFor(quest: string, owners: Iterable<number>): LiveEncounter | null {
    const set = new Set(owners)
    return this.live.find((e) => e.quest === quest && [...e.owners].some((o) => set.has(o))) ?? null
  }

  /** When the live encounter of `quest` owned by `characterId` despawns (QuestProgress.encounterUntil), if any. */
  untilFor(quest: string, characterId: number): number | undefined {
    return this.live.find((e) => e.quest === quest && e.owners.has(characterId))?.despawnAt
  }

  /** Earliest time `characterId` may summon the encounter of `quest` again (0: now). Expired entries are dropped. */
  readyAt(quest: string, characterId: number, now = Date.now()): number {
    const key = `${quest}|${characterId}`
    const at = this.nextUse.get(key) ?? 0
    if (at !== 0 && at <= now) this.nextUse.delete(key)
    return at
  }

  /** Starts the owners' wait before `e` may be summoned again. */
  private cool(e: LiveEncounter, now: number): void {
    for (const o of e.owners) this.nextUse.set(`${e.quest}|${o}`, now + e.cooldownMs)
  }

  /**
   * Summons the encounter next to `p` for `owners`. null when the mob is unknown or no open ground was found for any
   * of them (nothing is spawned then).
   */
  spawn(p: Player, quest: string, objective: string, enc: QuestEncounter, owners: Set<number>, now: number): LiveEncounter | null {
    const g = this.g
    const def = g.data.mob(enc.mob)
    if (!def) {
      g.config.log(`quest ${quest}: encounter mob ${enc.mob} is not in the export`)
      return null
    }
    const variant: MobVariant = def.rarity === 'unique' ? 'unique' : 'normal'
    const tuning = { hpMul: enc.hpMul ?? 1, attackMul: enc.attackMul ?? 1, expMul: enc.expMul ?? 1 }
    const despawnAt = now + enc.despawnSec * 1000
    const at = g.world.livePoint(p, now)
    const e: LiveEncounter = { quest, objective, mobs: new Set(), owners: new Set(owners), despawnAt, cooldownMs: (enc.cooldownSec ?? ENCOUNTER_COOLDOWN_SEC) * 1000 }
    for (let i = 0; i < enc.count; i++) {
      const spot = this.spot(at)
      if (!spot) continue
      const m = g.createMob(def, variant, spot.x, spot.z, spot.y, null, now, spot.surface, tuning)
      m.encounter = { quest, owners: e.owners, despawnAt }
      e.mobs.add(m.id)
    }
    if (e.mobs.size === 0) {
      g.config.log(`quest ${quest}: no open ground for the encounter near ${p.name}`)
      return null
    }
    this.nextUse.delete(`${quest}|${p.characterId}`)
    this.live.push(e)
    return e
  }

  /** Open ground 3-8 m from the user, reached by a straight walk on its surface (never through a wall). */
  private spot(at: NavPoint): NavPoint | null {
    const g = this.g
    for (let tries = 0; tries < 8; tries++) {
      const a = g.rng() * Math.PI * 2
      const r = ENCOUNTER_MIN_M + g.rng() * (ENCOUNTER_RADIUS_M - ENCOUNTER_MIN_M)
      const [x, z] = g.world.clamp(at.x + Math.sin(a) * r, at.z + Math.cos(a) * r)
      if (g.nav.kind !== 'mesh') return { x, y: at.y, z, surface: at.surface }
      const w = g.nav.walk(at, x, z)
      if (w && Number.isFinite(w.end.y) && Math.hypot(w.end.x - at.x, w.end.z - at.z) >= 1) return w.end
    }
    return g.nav.place(at.x, at.z, at.y, ENCOUNTER_RADIUS_M)
  }

  /**
   * An encounter mob died: the encounter ends when none is left, and returns it then. A kill (`cooldown`, whoever got the
   * credit) starts the owners' cooldown exactly like an unkilled despawn; a GM kill (`cooldown` false) ends it with no
   * wait, so a GM who removes a stuck mob does not lock the owners out.
   */
  mobDied(m: Mob, now: number, cooldown: boolean): LiveEncounter | null {
    const i = this.live.findIndex((e) => e.mobs.has(m.id))
    if (i < 0) return null
    const e = this.live[i]
    e.mobs.delete(m.id)
    if (e.mobs.size > 0) return null
    this.live.splice(i, 1)
    if (cooldown) this.cool(e, now)
    return e
  }

  /** Despawns encounters whose time is up (unkilled: the owners wait `cooldownSec`). Returns the ended ones. */
  tick(now: number): LiveEncounter[] {
    const ended: LiveEncounter[] = []
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i]
      if (now < e.despawnAt) continue
      this.live.splice(i, 1)
      this.despawn(e)
      this.cool(e, now)
      ended.push(e)
    }
    return ended
  }

  /**
   * Abandon: an encounter only this player owns despawns and starts its cooldown. The cooldown stays with the character
   * (an abandon and re-accept must not reset it). Returns the despawned encounter, if any.
   */
  abandon(quest: string, characterId: number, now = Date.now()): LiveEncounter | null {
    const i = this.live.findIndex((e) => e.quest === quest && e.owners.size === 1 && e.owners.has(characterId))
    if (i < 0) return null
    const e = this.live[i]
    this.live.splice(i, 1)
    this.despawn(e)
    this.cool(e, now)
    return e
  }

  private despawn(e: LiveEncounter): void {
    for (const id of e.mobs) {
      const m = this.g.world.mobs.get(id)
      if (m && m.ai !== 'dead') this.g.world.removeEntity(id)
    }
    e.mobs.clear()
  }
}

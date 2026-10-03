import type { ClientMessage, GameplayRequest } from '@sro/shared'
import type { Fail, Result } from './inventory.ts'
import type { Mob, Player } from './world.ts'

/**
 * Gameplay modules (docs/WAVE_PLAN.md §3.1): feature code (skills, NPC dialogs, shops, storage, consumables; wave 4
 * quests and party) lives in its own module. Gameplay routes each module's request types to it and fans its
 * lifecycle hooks out to every module, so lanes never edit the dispatch points in gameplay.ts.
 */

export type GameplayMessage = Extract<ClientMessage, { t: GameplayRequest }>
export type Answer = (r: Result<unknown> | true) => void
export type WarpReason = 'town' | 'gm'

export interface GameplayModule {
  readonly name: string
  /** Request types this module answers. Gameplay routes them here; the module answers exactly once. */
  readonly handles?: readonly GameplayRequest[]
  /** Of `handles`, those accepted while the player is dead (PROTOCOL §5 allowlist extension). */
  readonly whileDead?: readonly GameplayRequest[]
  request?(p: Player, msg: GameplayMessage, answer: Answer, now: number): void
  /** Enter-world, after `inventory`, in registration order (skills, then wave 4 quests, party). */
  enter?(p: Player, now: number): void
  /** An accepted client moveTo (Gameplay.onMoveTo), before the move starts. */
  moved?(p: Player, now: number): void
  /** stopAction (after the built-in halt and the actionResult). */
  stopped?(p: Player, now: number): void
  /** Alive players only, after the built-in attack/pickup branches, before regen. */
  tickPlayer?(p: Player, now: number): void
  /** Once per server tick, after mobs. */
  tick?(now: number): void
  playerDied?(p: Player, now: number): void
  /** toTown (respawn, return scroll) or GM tp/summon; runs after the warp was broadcast. */
  warped?(p: Player, reason: WarpReason, now: number): void
  /** End of Gameplay.afterInventory. */
  inventoryChanged?(p: Player): void
  /**
   * After rewards and loot; credit = ids of the players that shared the kill. Wave 11: `owner` is the kill's loot-owner
   * group, taken before Gameplay.mobDied clears `m.damage` (docs/UNIQUES.md §3.3). Not called for GM kills.
   */
  mobDied?(m: Mob, now: number, credit: ReadonlySet<number>, owner: KillOwner): void
  /** The player leaves the world. */
  forget?(p: Player): void
  /**
   * Wave 8 (docs/SYSTEMS_SOCIAL.md §2.3, docs/WAVE_PLAN2.md §4.2): a veto asked before any module (or the core) handles
   * a request of `p`, and before a client moveTo. Return a Fail to refuse (it becomes that request's actionResult; a
   * refused moveTo is dropped without a message), null to let it through. Never asked for the module's own `handles`.
   * Asked in registration order; the first Fail wins. A throwing gate is logged and allows. A module that locks a
   * player (trade, stall) lets through only an allowlist, so a request type added later is refused by default.
   */
  gate?(p: Player, t: GameplayRequest | 'moveTo', now: number): Fail | null
}

/**
 * Asks each module's `gate` about request `t` of `p` (docs/WAVE_PLAN2.md §4.2): in registration order, skipping `own`
 * (the module that handles `t`); the first Fail wins. A throwing gate is reported and allows.
 */
export function askGates(modules: readonly GameplayModule[], own: GameplayModule | null | undefined, p: Player, t: GameplayRequest | 'moveTo', now: number, report: (e: unknown, where: string) => void): Fail | null {
  for (const m of modules) {
    if (m === own || !m.gate) continue
    let veto: Fail | null = null
    try {
      veto = m.gate(p, t, now)
    } catch (e) {
      report(e, `${m.name}.gate`)
      continue
    }
    if (veto) return veto
  }
  return null
}

/**
 * The loot-owner group of a kill (wave 11, docs/UNIQUES.md §3.3; the group PartyManager.killShares / soloShares give the
 * loot to): `player` is the group's top-damage member, `party` its party id when the group is a party (else null).
 * `damage` is the kill's damage map (player entity id -> damage) as it was before Gameplay.mobDied cleared `m.damage`.
 */
export interface KillOwner {
  player: Player | null
  party: number | null
  damage: ReadonlyMap<number, number>
}

/** The lifecycle hooks Gameplay fans out (everything but `request`). */
export type ModuleHook = 'enter' | 'moved' | 'stopped' | 'tickPlayer' | 'tick' | 'playerDied' | 'warped' | 'inventoryChanged' | 'mobDied' | 'forget'

type HookArgs<K extends ModuleHook> = Parameters<NonNullable<GameplayModule[K]>>

/** Request type -> module, from each module's `handles`. Throws when two modules (or a module and the core) claim one type. */
export function buildRoutes(modules: readonly GameplayModule[], core: readonly GameplayRequest[] = []): Map<GameplayRequest, GameplayModule> {
  const routes = new Map<GameplayRequest, GameplayModule>()
  const coreSet = new Set(core)
  for (const m of modules) {
    for (const t of m.handles ?? []) {
      if (coreSet.has(t)) throw new Error(`gameplay module ${m.name} claims ${t}, which Gameplay handles itself`)
      const other = routes.get(t)
      if (other) throw new Error(`gameplay modules ${other.name} and ${m.name} both handle ${t}`)
      if (typeof m.request !== 'function') throw new Error(`gameplay module ${m.name} handles ${t} but has no request()`)
      routes.set(t, m)
    }
    for (const t of m.whileDead ?? []) {
      if (!(m.handles ?? []).includes(t)) throw new Error(`gameplay module ${m.name}: whileDead ${t} is not in its handles`)
    }
  }
  return routes
}

/**
 * Calls `hook` on every module that has it, in registration order. A throwing module is reported and skipped, so
 * one module's bug cannot stop the others (or the rest of the tick).
 */
export function fanOut<K extends ModuleHook>(modules: readonly GameplayModule[], hook: K, args: HookArgs<K>, report: (e: unknown, where: string) => void): void {
  for (const m of modules) {
    const fn = m[hook] as ((...a: HookArgs<K>) => void) | undefined
    if (!fn) continue
    try {
      fn.apply(m, args)
    } catch (e) {
      report(e, `${m.name}.${hook}`)
    }
  }
}

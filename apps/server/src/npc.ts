import { GUILD_MANAGER_NPCS, MAX_NPC_DIALOG_LINE, MAX_NPC_DIALOG_LINES, NPC_APPROACH_RANGE, NPC_INTERACT_RANGE, yawTowards, type GameplayRequest, type NpcCloseReason, type NpcDef, type NpcService } from '@sro/shared'
import type { Gameplay } from './gameplay.ts'
import { done, fail, type Result } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from './modules.ts'
import type { NavPoint, NavProvider } from './nav.ts'
import type { Npc, Player } from './world.ts'

/**
 * NPC dialogs (docs/SHOPS.md §3, docs/WAVE_PLAN.md §4.5; lane NPC-S).
 *
 * - `npcTalk` opens a dialog at once within NPC_INTERACT_RANGE (8 m); farther away the player first walks to
 *   NPC_APPROACH_RANGE (3 m) with a `talk` action. A straight walk that a stall or a wall blocks goes around it once
 *   (`detour`: at most one turn); a walk that still ends short (a counter) opens the dialog when it ended within 8 m
 *   (SHOPS §3.1 caveat), and otherwise tells the player it cannot get there.
 * - One dialog per player: a new talk replaces the old one (`npcDialogClose closed`).
 * - The server closes a dialog by itself when the player walks out of range (`too_far`), dies (`dead`), warps (`warp`,
 *   town and GM) or the NPC disappears (`gone`).
 * - Services (`shop`, `storage`, later `quest`) are offered per NPC, and every service request checks them again
 *   statelessly through `requireService` (live NPC, the service, within 8 m): the dialog is UI state, the distance is
 *   the rule.
 */

/**
 * NPCs that are never placed in the world. Empty: Storage-keeper Wangu (NPC_CH_WAREHOUSE_M) is not a duplicate of
 * Sansan but the storage chest she sits on, with him in front of it (docs/SHOPS.md §1.3), so both are placed.
 */
export const HIDDEN_NPCS: readonly string[] = []

export class NpcDialogs implements GameplayModule {
  readonly name = 'npc'
  readonly handles: readonly GameplayRequest[] = ['npcTalk', 'npcClose']
  readonly whileDead: readonly GameplayRequest[] = ['npcClose']
  /**
   * Quest hook (decision 1, wired by the wave-4 quest module): whether `code` has something to say to `p`. The dialog
   * then offers the 'quest' service.
   */
  topics?: (p: Player, code: string) => boolean
  /** Wave 11 (lane U-Q, docs/UNIQUES.md §3.10): the quest files' conditional greeting lines that hold for `p` now. */
  lines?: (p: Player, code: string) => string[]
  /** Open dialogs: player entity id -> NPC entity id. */
  private readonly open = new Map<number, { npc: number; openedAt: number }>()
  /** Talk walks going around an obstacle, by player entity id. */
  private readonly detours = new Map<number, Detour>()
  private defs: Map<string, NpcDef> | null = null

  constructor(readonly g: Gameplay) {}

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t === 'npcTalk') return this.talk(p, msg.npc, answer, now)
    if (msg.t === 'npcClose') return this.close(p, answer)
    answer(fail('not_found'))
  }

  /** The NPC entity `id` the player may talk to (only NPCs its client has spawned). */
  private npcFor(p: Player, id: number): Npc | null {
    const npc = this.g.world.npcs.get(id)
    return npc && p.known.has(id) ? npc : null
  }

  talk(p: Player, npcId: number, answer: Answer, now: number): void {
    const npc = this.npcFor(p, npcId)
    if (!npc) return answer(fail('not_found'))
    answer(true)
    // A talk is a timed action of its own (decision 9): it interrupts a return-scroll cast.
    this.g.itemUses.cancel(p, 'interrupted')
    this.detours.delete(p.id)
    const near = this.g.world.distance(p, npc, now) <= NPC_INTERACT_RANGE
    const cur = this.open.get(p.id)
    // The old dialog closes, unless this is the same NPC again right here (then its dialog is simply sent again).
    if (cur && !(cur.npc === npc.id && near)) this.closeFor(p, 'closed')
    if (near) {
      p.action = null
      this.face(p, npc, now)
      return this.opened(p, npc, now)
    }
    p.action = { kind: 'talk', npc: npc.id, chaseAt: 0, chaseTo: null }
  }

  /** npcClose: drops the dialog (and a pending talk walk). Always ok: closing twice is harmless. */
  close(p: Player, answer: Answer): void {
    if (p.action?.kind === 'talk') p.action = null
    this.open.delete(p.id)
    answer(true)
  }

  /** The talk walk arrived (or the NPC was already in range): opens the dialog. */
  opened(p: Player, npc: Npc, now: number): void {
    const services = this.servicesOf(p, npc)
    this.open.set(p.id, { npc: npc.id, openedAt: now })
    const lines = this.linesFor(p, npc)
    p.send({ t: 'npcDialog', npc: npc.id, code: npc.code, services, ...(lines.length ? { lines } : {}) })
    if (services.includes('shop')) this.g.shops.sendBuyback(p)
  }

  /** The conditional greeting lines, clipped to the protocol bounds; a throwing hook only loses the lines. */
  private linesFor(p: Player, npc: Npc): string[] {
    try {
      return (this.lines?.(p, npc.code) ?? []).slice(0, MAX_NPC_DIALOG_LINES).map((l) => [...l].slice(0, MAX_NPC_DIALOG_LINE).join(''))
    } catch (e) {
      this.g.config.log(`npc: dialog lines of ${npc.code} failed: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }

  /** A server-side close (walked away, died, warped, NPC gone, replaced by another talk). */
  closeFor(p: Player, reason: NpcCloseReason): void {
    const cur = this.open.get(p.id)
    if (!cur) return
    this.open.delete(p.id)
    p.send({ t: 'npcDialogClose', npc: cur.npc, reason })
  }

  /** The NPC entity whose dialog `p` has open, if any. */
  dialogOf(p: Player): number | null {
    return this.open.get(p.id)?.npc ?? null
  }

  private face(p: Player, npc: Npc, now: number): void {
    const at = this.g.world.positionAt(p, now)
    this.g.world.halt(p, now, yawTowards(npc.pos[0] - at[0], npc.pos[2] - at[2]))
  }

  private def(code: string): NpcDef | undefined {
    if (!this.defs) {
      this.defs = new Map()
      for (const n of this.g.data.npcs) if (n.world === this.g.config.world) this.defs.set(n.code, n)
    }
    return this.defs.get(code)
  }

  /** Whether `npc` offers `service` (to `p`, for quests). */
  has(p: Player | null, npc: Npc, service: NpcService): boolean {
    switch (service) {
      case 'shop':
        return this.g.shops.goods(npc.code).size > 0
      case 'storage':
        return this.g.storage.enabled && (this.def(npc.code)?.roles ?? []).includes('storage')
      case 'quest':
        return p !== null && this.topics?.(p, npc.code) === true
      case 'repair':
        // Wave 8 (docs/SYSTEMS_COMBAT.md §3.3): NPCs with the 'repair' role (the Blacksmith and the Protector Trader).
        return (this.def(npc.code)?.roles ?? []).includes('repair')
      case 'guild':
        // Wave 8 (docs/SYSTEMS_SOCIAL.md §5.2): the Guild Manager.
        return GUILD_MANAGER_NPCS.includes(npc.code)
    }
  }

  /** What the dialog of `npc` offers `p`, in the dialog's order (the client shows 'repair' as shop buttons, D13). */
  servicesOf(p: Player | null, npc: Npc): NpcService[] {
    return (['shop', 'storage', 'quest', 'repair', 'guild'] as const).filter((s) => this.has(p, npc, s))
  }

  /**
   * The rule every service request runs (shop, buyback, storage): a live NPC entity that offers `service` and stands
   * within NPC_INTERACT_RANGE. No open dialog is needed (docs/SHOPS.md §3.1 point 6).
   */
  requireService(p: Player, npcId: number, service: NpcService, now: number): Result<Npc> {
    const npc = this.g.world.npcs.get(npcId)
    if (!npc) return fail('not_found')
    if (!this.has(p, npc, service)) return fail('not_found', `this NPC has no ${service}`)
    if (this.g.world.distance(p, npc, now) > NPC_INTERACT_RANGE) return fail('too_far')
    return done(npc)
  }

  // ---- hooks ----------------------------------------------------------------------------------------

  tickPlayer(p: Player, now: number): void {
    const a = p.action
    // Like the core's attack and pickup walks, the talk walk waits while a skill action runs or the player is held
    // (stun): a server-driven walk must never move a caster whose skill is still charging (docs/SKILLS.md §5).
    if (a?.kind === 'talk' && !this.g.skills.busy(p, now) && !this.g.skills.held(p, now)) {
      const npc = this.g.world.npcs.get(a.npc)
      const route = this.detours.get(p.id)
      if (!npc) p.action = null
      else if (route && route.npc === npc.id) this.followDetour(p, npc, route, now)
      else if (this.g.approach(p, npc, NPC_APPROACH_RANGE, a, now)) this.arrived(p, npc, now)
      else if (p.action !== a) {
        // approach() gave up (the straight walk is blocked): walk around the obstacle once, if there is a way.
        const legs = this.g.world.distance(p, npc, now) > NPC_INTERACT_RANGE ? detour(this.g.world.nav, this.g.world.livePoint(p, now), npc) : null
        if (legs) {
          p.action = a
          this.detours.set(p.id, { npc: npc.id, legs, leg: -1 })
          this.followDetour(p, npc, this.detours.get(p.id)!, now)
        } else this.gaveUp(p, npc, now)
      }
    }
    if (p.action?.kind !== 'talk') this.detours.delete(p.id)
    const cur = this.open.get(p.id)
    if (!cur) return
    const npc = this.g.world.npcs.get(cur.npc)
    if (!npc) this.closeFor(p, 'gone')
    else if (this.g.world.distance(p, npc, now) > NPC_INTERACT_RANGE) this.closeFor(p, 'too_far')
  }

  /** The talk walk reached the NPC: stop facing it and open the dialog. */
  private arrived(p: Player, npc: Npc, now: number): void {
    p.action = null
    this.detours.delete(p.id)
    this.face(p, npc, now)
    this.opened(p, npc, now)
  }

  /** The walk cannot get any closer: close enough to talk over the counter (8 m), or out of reach. */
  private gaveUp(p: Player, npc: Npc, now: number): void {
    p.action = null
    this.detours.delete(p.id)
    if (this.g.world.distance(p, npc, now) <= NPC_INTERACT_RANGE) {
      this.face(p, npc, now)
      this.opened(p, npc, now)
    } else p.send({ t: 'chat', channel: 'system', text: `You cannot get to ${npc.name}.` })
  }

  /** Walks the detour's straight legs one after another (each a normal server move), then talks. */
  private followDetour(p: Player, npc: Npc, route: Detour, now: number): void {
    if (this.g.world.distance(p, npc, now) <= NPC_APPROACH_RANGE) return this.arrived(p, npc, now)
    if (p.move) return
    if (route.leg >= 0) {
      const [x, z] = route.legs[route.leg]
      const at = this.g.world.positionAt(p, now)
      // Stopped short of the leg's end (something moved into the way): the walk ends here.
      if (Math.hypot(at[0] - x, at[2] - z) > DETOUR_ARRIVE_M) return this.gaveUp(p, npc, now)
    }
    route.leg++
    if (route.leg >= route.legs.length) return this.gaveUp(p, npc, now)
    const [x, z] = route.legs[route.leg]
    if (!this.g.world.moveEntity(p, x, z, this.g.world.moveSpeed * p.speedMul, now)) this.gaveUp(p, npc, now)
  }

  playerDied(p: Player): void {
    this.closeFor(p, 'dead')
  }

  warped(p: Player): void {
    if (p.action?.kind === 'talk') p.action = null
    this.closeFor(p, 'warp')
  }

  forget(p: Player): void {
    this.open.delete(p.id)
    this.detours.delete(p.id)
  }
}

/** A talk walk around an obstacle: straight legs, the last one ending next to the NPC. */
interface Detour {
  npc: number
  legs: [number, number][]
  /** The leg being walked (-1: none started yet). */
  leg: number
}

/** A leg counts as walked when the player stands this close to its end (metres). */
const DETOUR_ARRIVE_M = 0.5
/** Where the detour ends: this far from the NPC's centre (inside NPC_APPROACH_RANGE). */
const DETOUR_STAND_M = 2.4
/** Stand points tried around the NPC, and waypoint directions around the player. */
const DETOUR_DIRECTIONS = 16
/** Waypoint distances from the player (metres). */
const DETOUR_RADII = [4, 8, 12, 16, 24, 32]

/**
 * Players walk in straight lines (docs/NAVIGATION.md §6), so a talk walk stops at the first wall, stall or counter in
 * the way. This finds the shortest way around with at most one turn: a stand point next to the NPC reached straight
 * from where the player stands, or through one waypoint on rings around the player. Every leg is a clear straight walk
 * on the navmesh (the same test the moves themselves use). null: there is none (the talk then gives up). About 1,700
 * straight-walk tests at worst, run once per blocked talk.
 */
export function detour(nav: NavProvider, from: NavPoint, npc: Npc): [number, number][] | null {
  const clear = (a: NavPoint, x: number, z: number): NavPoint | null => {
    const w = nav.walk(a, x, z)
    return w && !w.blocked && Math.hypot(w.end.x - x, w.end.z - z) < 0.3 ? w.end : null
  }
  const stands: [number, number][] = []
  for (let i = 0; i < DETOUR_DIRECTIONS; i++) {
    const t = (i / DETOUR_DIRECTIONS) * Math.PI * 2
    stands.push([npc.pos[0] + Math.sin(t) * DETOUR_STAND_M, npc.pos[2] + Math.cos(t) * DETOUR_STAND_M])
  }
  const len = (ax: number, az: number, bx: number, bz: number) => Math.hypot(bx - ax, bz - az)
  let best: { cost: number; legs: [number, number][] } | null = null
  for (const [x, z] of stands) {
    const cost = len(from.x, from.z, x, z)
    if ((!best || cost < best.cost) && clear(from, x, z)) best = { cost, legs: [[x, z]] }
  }
  if (best) return best.legs
  for (const r of DETOUR_RADII) {
    for (let j = 0; j < DETOUR_DIRECTIONS; j++) {
      const t = (j / DETOUR_DIRECTIONS) * Math.PI * 2
      const wx = from.x + Math.sin(t) * r
      const wz = from.z + Math.cos(t) * r
      if (best && r >= best.cost) continue
      const w = clear(from, wx, wz)
      if (!w) continue
      for (const [x, z] of stands) {
        const cost = r + len(wx, wz, x, z)
        if ((!best || cost < best.cost) && clear(w, x, z)) best = { cost, legs: [[wx, wz], [x, z]] }
      }
    }
  }
  return best?.legs ?? null
}

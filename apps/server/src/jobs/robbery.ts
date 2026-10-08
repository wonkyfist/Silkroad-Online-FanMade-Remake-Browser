import {
  CARAVAN_PING_OFFSET_M,
  CARAVAN_SENSE_M,
  DEN_SERVICE,
  HUNTER_SERVICE,
  JOB_CODES,
  JOB_LIMITS,
  caravanPingR,
  denPayout,
  hunterThiefExp,
  recoveryReward,
  robberyPairMul,
  thiefDenExp,
  type GameplayRequest,
  type ItemDef,
  type JobRequest,
  type SackEntryView,
  type SackKind,
} from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { addGold, addItem, fail, type Fail } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from '../modules.ts'
import type { Mob, Player } from '../world.ts'
import { RobberyStore, type SackRow } from './robbery-store.ts'
import type { Bag } from './transport.ts'

/**
 * The job system, layer 4: Thieves and the law (docs/JOBS.md §6.1, §6.3, §6.4, §7, §9.2). A GameplayModule named
 * `robbery`, after `transports`.
 *
 * - **Sacks** (`job_sacks`, migration 27): goods carried outside a transport, never in the bag (no trade, stall, storage
 *   or drop). A Thief's `stolen` crates, a Bounty Hunter's `recovered` ones, a Trader's `own` crates picked up without a
 *   transport. Every change is written at once; `jobSack` to the carrier.
 * - **Bags** (transport.ts `pick` hands over what is not the owner's): a **Thief** in the suit takes them as stolen goods —
 *   never from associates (party, guild, account, IP) or recorded contacts of the owner (`robbery_contact` flag); the
 *   **pair rule** (§7): the same Thief account robbing the same Trader account again within `robbery.pairWindowH` is paid
 *   × (1 − `law.repeatPct` %) per earlier robbery at the den, nothing (and no job EXP) from `law.repeatMax` on
 *   (`robbery_pair` flag). Each pickup opens / raises the **robbery warrant** (law.ts `robbery`: bounty = the recovery
 *   reward, `robbery.recoveryPct` of the den value). A **Bounty Hunter** in the suit takes them as recovered goods; the
 *   owner's associates and contacts get no reward for them (`recovery_contact`).
 * - **The den** (Specialty Trader Seopok, service `den`, 12 m safe ring): `denSell` pays `thief.denPct` of the base price
 *   × the pair multiplier, job EXP payout ÷ `exp.thiefDenDiv`, the robbery warrant closes `sold`. `denBuy`: the Bandit Den
 *   Return Scroll (job level 3); using it warps a Thief to the den (refused with stolen goods, like return scrolls).
 * - **Captain Yun** (`yunTurnIn`): recovered goods for the recovery reward, inside `hunter.dailyBountyCap` (captures and
 *   turn-ins of the account in 24 h).
 * - **Captures** (law.ts `capture` calls `confiscate`): the stolen goods are gone; the robbery ladder jails the Thief.
 * - **Deaths**: whatever a character carries drops as bags (the owner stays the robbed Trader); the robbery warrant closes
 *   `dropped`. A Hunter who kills a Thief in the suit gets `exp.hunterThiefKill` × the Thief's job level (not twice for the
 *   same accounts within `robbery.pairWindowH`: `thief_kill_pair`).
 * - **Caravan pings** (§6.1): every `thief.pingSec`, each Thief in the suit gets a `caravanPing` for every loaded transport
 *   of ≥ `thief.pingMinStars` within CARAVAN_SENSE_M (not his associates').
 * - Refusals: return scrolls while carrying stolen or own goods (`loaded`); the suit off and leaving the job (jobs.carrying).
 * - GM `robbery`; the admin view's sacks.
 */

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const OUT_OF_COMBAT_MS = 10_000
/** Seopok sells the Bandit Den Return Scroll to Thieves of this job level (§3.2). */
export const DEN_SCROLL_LEVEL = 3

interface SackEntry {
  kind: SackKind
  good: string
  crates: number
  cost: number
  ownerChar: number
  ownerAcc: number | null
  batch: number
  /** The den's multiplier (stolen: the pair rule) or the reward's (recovered: 0 for the owner's associates). */
  mul: number
  at: number
}

const toRow = (e: SackEntry): SackRow => ({ kind: e.kind, good: e.good, crates: e.crates, cost: e.cost, owner_character: e.ownerChar, owner_account: e.ownerAcc, batch: e.batch, mul: e.mul, picked_at: e.at })
const fromRow = (r: SackRow): SackEntry => ({ kind: r.kind, good: r.good, crates: r.crates, cost: r.cost, ownerChar: r.owner_character, ownerAcc: r.owner_account, batch: r.batch, mul: r.mul, at: r.picked_at })

export class RobberyService implements GameplayModule {
  readonly name = 'robbery'
  readonly handles: readonly GameplayRequest[] = ['denSell', 'denBuy', 'yunTurnIn'] satisfies readonly JobRequest[]
  private readonly sacks = new Map<number, SackEntry[]>()
  private storeCache: RobberyStore | null = null
  private seq = 0
  private nextPing = 0

  constructor(private readonly g: Gameplay) {
    // the retail Bandit Den Return Scroll has no use row in the export: usable here (the hook below)
    const scroll = g.data.items.get(JOB_CODES.denScroll)
    if (scroll && !scroll.use) g.data.items.set(scroll.code, { ...scroll, use: { cooldownGroup: 'denReturn', cooldownMs: 0 } })
    g.itemUses.hooks.push((p, def, bag, group, answer, now) => this.itemHook(p, def, bag, group, answer, now))
    g.jobs.carrying.push((p) => {
      const s = this.sack(p.characterId)
      if (s.some((e) => e.kind === 'stolen')) return 'You carry stolen goods: sell them at the Bandit Den first.'
      if (s.some((e) => e.kind === 'own')) return 'You carry trade goods: sell them at a trade post first.'
      return null
    })
  }

  get store(): RobberyStore {
    return (this.storeCache ??= new RobberyStore(this.g.store.db))
  }

  private get s() {
    return this.g.jobs.settings
  }

  /** A robbery's id (bags of one transport's death, one tornado, one carrier's death share it). */
  newBatch(now: number): number {
    this.seq = (this.seq + 1) % 1000
    return Math.floor(now) * 1000 + this.seq
  }

  // ---- sacks --------------------------------------------------------------------------------------------------------------

  private sack(characterId: number): SackEntry[] {
    let s = this.sacks.get(characterId)
    if (!s) {
      try {
        s = this.store.sack(characterId).map(fromRow)
      } catch {
        s = []
      }
      this.sacks.set(characterId, s)
    }
    return s
  }

  /** The entries of one kind a character carries. */
  entries(characterId: number, kind: SackKind): readonly { good: string; crates: number; cost: number }[] {
    return this.sack(characterId).filter((e) => e.kind === kind)
  }

  private put(characterId: number, list: SackEntry[]): void {
    this.sacks.set(characterId, list)
    try {
      this.store.replace(characterId, list.map(toRow))
    } catch (e) {
      this.g.config.log(`robbery: could not save the sack of ${characterId}: ${(e as Error).message}`)
    }
    const p = this.g.jobs.playerOf(characterId)
    if (p) this.sendSack(p)
  }

  private add(characterId: number, e: SackEntry): void {
    const list = this.sack(characterId).map((x) => ({ ...x }))
    const same = list.find((x) => x.kind === e.kind && x.good === e.good && x.ownerChar === e.ownerChar && x.batch === e.batch && x.mul === e.mul)
    if (same) {
      same.crates = Math.min(JOB_LIMITS.crates, same.crates + e.crates)
      same.cost += e.cost
    } else list.push(e)
    this.put(characterId, list)
  }

  private base(good: string): number {
    return this.g.market.good(good)?.base ?? 0
  }

  /** The den's payout of entries (× their pair multipliers). */
  denValue(list: readonly SackEntry[], withMul = true): number {
    const pct = this.s.thief.denPct
    return list.reduce((n, e) => n + Math.floor(denPayout(this.base(e.good), e.crates, pct) * (withMul ? e.mul : 1)), 0)
  }

  private value(e: SackEntry): number {
    if (e.kind === 'own') return e.cost
    const den = Math.floor(denPayout(this.base(e.good), e.crates, this.s.thief.denPct) * e.mul)
    return e.kind === 'stolen' ? den : recoveryReward(den, this.s.robbery.recoveryPct)
  }

  private nameOf(characterId: number): string {
    return this.g.store.characterById(characterId)?.name ?? `#${characterId}`
  }

  view(characterId: number): SackEntryView[] {
    return this.sack(characterId)
      .slice(0, JOB_LIMITS.goods)
      .map((e) => ({ kind: e.kind, good: e.good, crates: Math.max(1, e.crates), owner: this.nameOf(e.ownerChar), value: this.value(e) }))
  }

  sendSack(p: Player): void {
    p.send({ t: 'jobSack', entries: this.view(p.characterId) })
  }

  /** A robbery warrant's bounty: the recovery reward of everything stolen carried (the pair rule does not cut it). */
  private bountyFor(characterId: number): number {
    return recoveryReward(this.denValue(this.sack(characterId).filter((e) => e.kind === 'stolen'), false), this.s.robbery.recoveryPct)
  }

  private flag(at: number, thief: Player | number, owner: number, rule: string, withheld: number): void {
    const law = this.g.law
    const cid = typeof thief === 'number' ? thief : thief.characterId
    try {
      law.store.flag(
        { at, wanted_character: cid, wanted_account: law.accountOf(cid) ?? 0, hunter_character: owner, hunter_account: law.accountOf(owner), rule, withheld },
        { actor: this.nameOf(cid), other: this.nameOf(owner) },
      )
    } catch {
      // no law tables in a test
    }
    this.g.config.log(`robbery: ${this.nameOf(cid)} / ${this.nameOf(owner)}: ${rule} (${withheld} gold withheld)`)
  }

  // ---- bags (transport.ts pick) ---------------------------------------------------------------------------------------------

  /** Associates (party, guild, account, IP) or recorded contacts of the bag's owner. */
  private related(p: Player, ownerChar: number, now: number): 'associate' | 'contact' | null {
    const law = this.g.law
    const assoc = law.associates(p)
    const ownerAcc = law.accountOf(ownerChar)
    const owner = this.g.jobs.playerOf(ownerChar)
    if (assoc.chars.has(ownerChar) || (ownerAcc !== null && assoc.accounts.has(ownerAcc)) || (owner && law.isAssociate(assoc, owner))) return 'associate'
    const acc = law.accountOf(p.characterId)
    if (acc === null || ownerAcc === null) return null
    try {
      return law.store.contactSince(acc, ownerAcc, now - law.settings.contactDays * DAY_MS) ? 'contact' : null
    } catch {
      return null
    }
  }

  /** A Thief's or a Bounty Hunter's pickup of another Trader's bag (§6.3, §6.4, §7). */
  pickUp(p: Player, b: Bag, now: number): true | Fail {
    const jobs = this.g.jobs
    const job = jobs.jobOf(p.characterId)
    const other = fail('not_owner', "These goods belong to another Trader's caravan.")
    if (!jobs.settings.jobs.enabled || (job !== 'thief' && job !== 'hunter')) return other
    if (!jobs.inMode(p.characterId)) return fail('not_job_mode', job === 'thief' ? 'Put on your Thief suit first.' : 'Go on duty first.')
    if (this.g.jail.jailedNow(p)) return fail('jailed')
    const law = this.g.law
    const rel = this.related(p, b.ownerChar, now)
    const acc = law.accountOf(p.characterId)
    const ownerAcc = law.accountOf(b.ownerChar)
    const pct = this.s.thief.denPct
    const den = denPayout(this.base(b.good), b.crates, pct)
    if (job === 'hunter') {
      const mul = rel ? 0 : 1
      if (rel) this.flag(now, p, b.ownerChar, 'recovery_contact', recoveryReward(den, this.s.robbery.recoveryPct))
      this.add(p.characterId, { kind: 'recovered', good: b.good, crates: b.crates, cost: b.cost, ownerChar: b.ownerChar, ownerAcc, batch: b.batch, mul, at: now })
      this.g.market.log(p.characterId, 'recovered', null, b.good, b.crates, 0, 0, now)
      p.send({ t: 'chat', channel: 'system', text: `You recover ${b.crates} crate(s) of ${b.ownerName}'s goods: turn them in to Captain Yun${mul ? ' for a reward' : ' (no reward: you know the owner)'}.` })
      return true
    }
    // a Thief
    if (rel) {
      this.flag(now, p, b.ownerChar, 'robbery_contact', den)
      return fail('not_owner', rel === 'associate' ? 'You cannot rob your own party, guild, account or friends.' : 'You cannot rob someone you travelled or traded with lately.')
    }
    let mul = 1
    if (acc !== null && ownerAcc !== null) {
      const since = now - this.s.robbery.pairWindowH * HOUR_MS
      let prior = 0
      try {
        prior = this.store.priorRobberies(acc, ownerAcc, since, b.batch)
        if (!this.store.robbed(acc, b.batch, since)) this.store.log(now, 'rob', p.characterId, acc, b.ownerChar, ownerAcc, b.batch)
      } catch {
        prior = 0
      }
      mul = robberyPairMul(prior, law.settings.repeatPct, law.settings.repeatMax)
      if (mul < 1) {
        this.flag(now, p, b.ownerChar, 'robbery_pair', Math.ceil(den * (1 - mul)))
        p.send({ t: 'chat', channel: 'system', text: mul > 0 ? `You robbed ${b.ownerName} not long ago: the den pays less for these.` : `You robbed ${b.ownerName} too often lately: the den will pay nothing for these.` })
      }
    }
    this.add(p.characterId, { kind: 'stolen', good: b.good, crates: b.crates, cost: b.cost, ownerChar: b.ownerChar, ownerAcc, batch: b.batch, mul, at: now })
    this.g.market.log(p.characterId, 'stolen', null, b.good, b.crates, 0, 0, now)
    law.robbery(p.characterId, this.bountyFor(p.characterId), now)
    return true
  }

  /** The owner without a transport takes his bag into his own sack (sellable by him only at a trade point). */
  pickOwn(p: Player, b: Bag, now: number): true | Fail {
    if (this.g.jobs.jobOf(p.characterId) !== 'trader') return fail('requirements', 'Only Traders carry trade goods.')
    this.add(p.characterId, { kind: 'own', good: b.good, crates: b.crates, cost: b.cost, ownerChar: p.characterId, ownerAcc: this.g.law.accountOf(p.characterId), batch: b.batch, mul: 1, at: now })
    this.g.market.log(p.characterId, 'recovered', null, b.good, b.crates, b.cost, 0, now)
    p.send({ t: 'chat', channel: 'system', text: `You carry ${b.crates} crate(s) of your goods on your back: sell them at a trade post.` })
    return true
  }

  /** The market sells a Trader's own crates (no transport): takes `crates` of `good` out of the sack. */
  takeOwn(characterId: number, good: string, crates: number): number {
    const list = this.sack(characterId).map((x) => ({ ...x }))
    let left = crates
    for (const e of list) {
      if (left <= 0) break
      if (e.kind !== 'own' || e.good !== good) continue
      const n = Math.min(e.crates, left)
      const cost = n >= e.crates ? e.cost : Math.round((e.cost * n) / e.crates)
      e.crates -= n
      e.cost -= cost
      left -= n
    }
    this.put(characterId, list.filter((e) => e.crates > 0))
    return crates - left
  }

  // ---- requests -------------------------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'denSell':
        return answer(this.denSell(p, msg.npc, now))
      case 'denBuy':
        return answer(this.denBuy(p, msg.npc, msg.count, now))
      case 'yunTurnIn':
        return answer(this.turnIn(p, msg.npc, now))
      default:
        return answer(fail('not_found'))
    }
  }

  /** Whether NPC `code` is the den (Seopok, while the jobs are on and the posts stand). */
  offers(code: string): boolean {
    return this.g.jobs.placed && this.s.jobs.enabled && code === this.g.jobs.content.den.npc
  }

  denSell(p: Player, npcId: number, now: number): true | Fail {
    const npc = this.g.npcs.requireService(p, npcId, DEN_SERVICE, now)
    if (!npc.ok) return npc as Fail
    if (this.g.jobs.jobOf(p.characterId) !== 'thief') return fail('requirements', 'Seopok: "I buy from Thieves only."')
    const stolen = this.sack(p.characterId).filter((e) => e.kind === 'stolen')
    if (stolen.length === 0) return fail('not_found', 'You carry no stolen goods.')
    // docs/JOBS.md §8: the Silk Caravan's den multiplier
    const gold = Math.floor(this.denValue(stolen) * this.g.caravan.mul('den', now))
    if (gold > 0) {
      const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => addGold(d, gold, { strict: true }))
      if (!result.ok) return result as Fail
      this.g.afterInventory(p, draft)
    }
    this.put(p.characterId, this.sack(p.characterId).filter((e) => e.kind !== 'stolen'))
    const crates = stolen.reduce((n, e) => n + e.crates, 0)
    for (const e of stolen) this.g.market.log(p.characterId, 'den', null, e.good, e.crates, Math.floor(denPayout(this.base(e.good), e.crates, this.s.thief.denPct) * e.mul), 0, now)
    this.g.law.closeRobbery(p.characterId, 'sold', now)
    const exp = thiefDenExp(gold, this.s.exp)
    if (exp > 0) this.g.jobs.addExp(p.characterId, exp, now, `sold ${crates} stolen crates at the den`)
    p.send({ t: 'chat', channel: 'system', text: `Seopok pays ${gold.toLocaleString('en-US')} gold for ${crates} stolen crate(s)${exp > 0 ? ` (+${exp} job EXP)` : ''}. Nobody asks where they came from.` })
    this.g.config.log(`robbery: ${p.name} sold ${crates} stolen crates at the den for ${gold}`)
    return true
  }

  denBuy(p: Player, npcId: number, count: number, now: number): true | Fail {
    const npc = this.g.npcs.requireService(p, npcId, DEN_SERVICE, now)
    if (!npc.ok) return npc as Fail
    if (this.g.jobs.jobOf(p.characterId) !== 'thief') return fail('requirements', 'Seopok: "I sell to Thieves only."')
    if (this.g.jobs.levelOf(p.characterId) < DEN_SCROLL_LEVEL) return fail('requirements', `Seopok sells his scrolls to Thieves of job level ${DEN_SCROLL_LEVEL} and up.`)
    const def = this.g.data.item(JOB_CODES.denScroll)
    if (!def) return fail('not_found', 'Seopok has no scrolls today.')
    const n = Math.max(1, Math.min(JOB_LIMITS.scrolls, Math.floor(count)))
    const gold = Math.max(0, def.price) * n
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      if (d.gold < gold) return fail('not_enough_gold', `${n} scroll(s) cost ${gold.toLocaleString('en-US')} gold.`)
      const r = addItem(d, def, n)
      if (!r.ok) return r
      return addGold(d, -gold)
    })
    if (!result.ok) return result as Fail
    this.g.afterInventory(p, draft)
    return true
  }

  turnIn(p: Player, npcId: number, now: number): true | Fail {
    const npc = this.g.npcs.requireService(p, npcId, HUNTER_SERVICE, now)
    if (!npc.ok) return npc as Fail
    const rec = this.sack(p.characterId).filter((e) => e.kind === 'recovered')
    if (rec.length === 0) return fail('not_found', 'You carry no recovered goods.')
    let gold = rec.reduce((n, e) => n + this.value(e), 0)
    const acc = this.g.law.accountOf(p.characterId)
    if (gold > 0 && acc !== null) {
      // hunter.dailyBountyCap: bounties and turn-ins of the account in 24 h
      const since = now - DAY_MS
      let earned = 0
      try {
        earned = this.g.hunters.store.capturesSince(since).reduce((sum, c) => sum + c.captors.filter((x) => (x.account ?? this.g.law.accountOf(x.character)) === acc).reduce((t, x) => t + (x.gold ?? 0), 0), 0)
        earned += this.g.market.store.goldSince(acc, 'turnin', since)
      } catch {
        earned = 0
      }
      const room = Math.max(0, this.g.siege.settings.hunter.dailyBountyCap - earned)
      if (gold > room) {
        this.flag(now, p, rec[0]!.ownerChar, 'daily_cap', gold - room)
        gold = room
      }
    }
    if (gold > 0) {
      const g = gold
      const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => addGold(d, g, { strict: true }))
      if (!result.ok) return result as Fail
      this.g.afterInventory(p, draft)
    }
    this.put(p.characterId, this.sack(p.characterId).filter((e) => e.kind !== 'recovered'))
    const crates = rec.reduce((n, e) => n + e.crates, 0)
    this.g.market.log(p.characterId, 'turnin', null, null, crates, gold, 0, now)
    p.send({ t: 'chat', channel: 'system', text: `Captain Yun takes ${crates} recovered crate(s)${gold > 0 ? ` and pays you ${gold.toLocaleString('en-US')} gold` : ''}.` })
    return true
  }

  /** A capture (law.ts): the stolen goods are confiscated. */
  confiscate(characterId: number, now: number): number {
    const stolen = this.sack(characterId).filter((e) => e.kind === 'stolen')
    if (stolen.length === 0) return 0
    this.put(characterId, this.sack(characterId).filter((e) => e.kind !== 'stolen'))
    const crates = stolen.reduce((n, e) => n + e.crates, 0)
    this.g.market.log(characterId, 'confiscated', null, null, crates, this.denValue(stolen), 0, now)
    return crates
  }

  // ---- items ----------------------------------------------------------------------------------------------------------------

  private itemHook(p: Player, def: ItemDef, bag: number, group: string, answer: Answer, now: number): boolean {
    const s = this.sack(p.characterId)
    const hot = s.some((e) => e.kind === 'stolen' || e.kind === 'own')
    if (def.use?.returnToTown && hot) {
      answer(fail('loaded', 'Not while you carry trade goods: they would stay on the road.'))
      return true
    }
    if (def.code !== JOB_CODES.denScroll) return false
    if (this.g.jobs.jobOf(p.characterId) !== 'thief') {
      answer(fail('requirements', 'Only Thieves know the way to the Bandit Den.'))
      return true
    }
    if (s.some((e) => e.kind === 'stolen')) {
      answer(fail('loaded', 'Not with stolen goods: carry them to the den on foot.'))
      return true
    }
    if (p.dead) {
      answer(fail('dead'))
      return true
    }
    if (now - p.lastCombatAt < OUT_OF_COMBAT_MS) {
      answer(fail('in_combat'))
      return true
    }
    if (!this.g.itemUses.consume(p, def, bag, group, answer, now)) return true
    this.toDen(p, now)
    return true
  }

  /** Warps `p` beside Seopok. */
  toDen(p: Player, now: number): void {
    const den = this.g.jobs.denSpot()
    const [, y] = this.g.world.positionAt(p, now)
    const at = this.g.world.placeFor(den.x + 4, den.z + 4, y)
    this.g.mounts.stepDownFor(p, now)
    p.action = null
    this.g.world.warp(p, at?.x ?? den.x + 4, at?.y ?? y, at?.z ?? den.z + 4, now, at)
    this.g.warped(p, 'town', now)
  }

  // ---- hooks ----------------------------------------------------------------------------------------------------------------

  playerDied(p: Player, now: number, killer?: Player | Mob): void {
    const jobs = this.g.jobs
    // a Bounty Hunter kills a Thief in the suit (§3.1): job EXP, the pair rule
    if (killer?.kind === 'player' && killer !== p && jobs.jobOf(p.characterId) === 'thief' && jobs.inMode(p.characterId) && jobs.jobOf(killer.characterId) === 'hunter' && jobs.inMode(killer.characterId)) {
      const acc = this.g.law.accountOf(killer.characterId)
      const vacc = this.g.law.accountOf(p.characterId)
      let again = false
      if (acc !== null && vacc !== null) {
        try {
          again = this.store.kills(acc, vacc, now - this.s.robbery.pairWindowH * HOUR_MS) > 0
          this.store.log(now, 'kill', killer.characterId, acc, p.characterId, vacc, 0)
        } catch {
          again = false
        }
      }
      if (again) this.flag(now, killer, p.characterId, 'thief_kill_pair', 0)
      else jobs.addExp(killer.characterId, hunterThiefExp(jobs.levelOf(p.characterId), false, this.s.exp), now, `killed the Thief ${p.name}`)
    }
    // whatever is carried falls (§6.3): the owner stays the robbed Trader
    const s = this.sack(p.characterId)
    if (s.length === 0) return
    const [x, y, z] = this.g.world.positionAt(p, now)
    const batch = this.newBatch(now)
    s.forEach((e, i) => {
      const a = (i / Math.max(1, s.length)) * Math.PI * 2 + this.g.rng()
      this.g.transports.dropBag({ good: e.good, crates: e.crates, cost: e.cost }, { characterId: e.ownerChar, name: this.nameOf(e.ownerChar) }, batch, x + Math.sin(a) * 2, y, z + Math.cos(a) * 2, now)
    })
    const stolen = s.some((e) => e.kind === 'stolen')
    this.put(p.characterId, [])
    if (stolen) this.g.law.closeRobbery(p.characterId, 'dropped', now)
    p.send({ t: 'chat', channel: 'system', text: 'The goods you carried fell to the ground.' })
  }

  enter(p: Player): void {
    this.sacks.delete(p.characterId)
    if (this.sack(p.characterId).length) this.sendSack(p)
  }

  forget(p: Player): void {
    this.sacks.delete(p.characterId)
  }

  tick(now: number): void {
    if (now < this.nextPing) return
    this.nextPing = now + this.s.thief.pingSec * 1000
    this.ping(now)
  }

  /** Caravan pings (§6.1) now: to every Thief in the suit (or only `to`). */
  ping(now: number, to?: Player): number {
    const jobs = this.g.jobs
    if (!jobs.settings.jobs.enabled) return 0
    const t = this.s.thief
    const thieves = to ? [to] : [...this.g.world.players.values()].filter((p) => !p.dead && jobs.jobOf(p.characterId) === 'thief' && jobs.inMode(p.characterId) && !this.g.jail.jailedNow(p))
    if (thieves.length === 0) return 0
    const caravans = this.g.transports.loadedTransports().filter((c) => c.stars >= t.pingMinStars)
    if (caravans.length === 0) return 0
    let n = 0
    for (const p of thieves) {
      const [px, , pz] = this.g.world.positionAt(p, now)
      const r = caravanPingR(jobs.levelOf(p.characterId), t.pingR)
      for (const c of caravans) {
        const [x, , z] = this.g.world.positionAt(c.c, now)
        if (Math.hypot(x - px, z - pz) > CARAVAN_SENSE_M) continue
        if (this.related(p, c.characterId, now)) continue
        const a = this.g.rng() * Math.PI * 2
        const d = Math.sqrt(this.g.rng()) * Math.min(CARAVAN_PING_OFFSET_M, r)
        p.send({ t: 'caravanPing', id: c.c.id, x: x + Math.sin(a) * d, z: z + Math.cos(a) * d, r, stars: c.stars, at: now })
        n++
      }
    }
    return n
  }

  // ---- GM and admin -----------------------------------------------------------------------------------------------------------

  /** `robbery [status] | robbery <name> [status|give <good> <crates> [stolen|recovered|own]|clear|ping]`. */
  gm(args: readonly string[], now: number): GmResult {
    const [name, verb, a1, a2, a3] = args
    if (!name || name.toLowerCase() === 'status') {
      let rows: (SackRow & { character_id: number })[] = []
      try {
        rows = this.store.all(200)
      } catch {
        rows = []
      }
      const robbers = this.g.law.openList().filter((w) => w.row.reason === 'robbery')
      const lines = rows.slice(0, 10).map((r) => `${this.nameOf(r.character_id)}: ${r.crates} ${r.good} ${r.kind} (of ${this.nameOf(r.owner_character)})`)
      return { ok: true, message: `Robbery warrants open: ${robbers.length}. Sacks: ${rows.length ? lines.join('; ') : 'none'}.`, data: { warrants: robbers.length, sacks: rows.length } }
    }
    const row = this.g.store.characterByName(name.replace(/^@/, ''))
    if (!row) return { ok: false, message: `No character named ${name}.` }
    const v = (verb ?? 'status').toLowerCase()
    const p = this.g.jobs.playerOf(row.id)
    if (v === 'status') {
      const s = this.sack(row.id)
      const w = this.g.law.robberyOf(row.id)
      return { ok: true, message: `${row.name}: ${s.length ? s.map((e) => `${e.crates} ${e.good} ${e.kind}${e.mul < 1 ? ` ×${e.mul}` : ''}`).join(', ') : 'carries nothing'}; robbery warrant ${w ? `#${w.id} (${w.bounty} gold)` : 'none'}.` }
    }
    if (v === 'give') {
      const good = this.g.jobs.content.goods.find((x) => x.code === a1?.toUpperCase() || x.name.toLowerCase() === a1?.toLowerCase())
      const n = Math.floor(Number(a2))
      const kind = ((a3 ?? 'stolen').toLowerCase()) as SackKind
      if (!good || !Number.isInteger(n) || n < 1 || n > JOB_LIMITS.crates || !['stolen', 'recovered', 'own'].includes(kind)) return { ok: false, message: `Usage: ${ROBBERY_USAGE}` }
      this.add(row.id, { kind, good: good.code, crates: n, cost: good.base * n, ownerChar: row.id, ownerAcc: row.account_id, batch: this.newBatch(now), mul: 1, at: now })
      if (kind === 'stolen') this.g.law.robbery(row.id, this.bountyFor(row.id), now)
      return { ok: true, message: `${row.name} carries ${n} ${good.name} (${kind}).` }
    }
    if (v === 'clear') {
      const had = this.sack(row.id).length
      this.put(row.id, [])
      const w = this.g.law.closeRobbery(row.id, 'pardoned', now)
      return { ok: true, message: `${row.name}'s sack cleared (${had} line(s)); ${w} robbery warrant(s) closed.` }
    }
    if (v === 'ping') {
      if (!p) return { ok: false, message: `${row.name} is not online.` }
      return { ok: true, message: `${this.ping(now, p)} caravan ping(s) sent to ${row.name}.` }
    }
    return { ok: false, message: `Usage: ${ROBBERY_USAGE}` }
  }

  adminSacks(): NonNullable<import('@sro/shared').AdminJobsView['sacks']> {
    try {
      return this.store.all(500).map((r) => {
        const e = fromRow(r)
        return { characterId: r.character_id, name: this.nameOf(r.character_id), kind: e.kind, good: e.good, crates: e.crates, owner: this.nameOf(e.ownerChar), value: this.value(e) }
      })
    } catch {
      return []
    }
  }
}

export const ROBBERY_USAGE = 'robbery [status] | robbery <name> [status|give <good> <crates> [stolen|recovered|own]|clear|ping]'

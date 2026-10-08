import {
  HUNTER_CODES,
  HUNTER_SERVICE,
  captureShares,
  hunterThiefExp,
  type CaptureRule,
  inStockade,
  installSiegeHunterContent,
  jobSide,
  pvpAllowed,
  wardenNpc,
  yunNpc,
  type GameplayRequest,
  type HunterView,
  type PvpHit,
  type PvpSide,
  type ServerMessage,
  type SiegeEventSettings,
} from '@sro/shared'
import { addBaseNpc } from '../editors/overrides.ts'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { addGold, fail, takeFromBag, type Fail } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from '../modules.ts'
import type { Mob, Player } from '../world.ts'
import { HunterStore, type HunterRow } from './hunter-store.ts'
import type { CaptureResult } from './law.ts'
import { fmtTime } from './jail.ts'

/**
 * Siege of Jangan, layer 6: the Hunters (docs/SIEGE.md §8.2-§8.4, §8.6). A GameplayModule named `hunters`, after the law
 * (it reads the warrants) and before the jail.
 *
 * - **Content** (with the walls on): Captain Yun by the west gate (his `hunter` service and a shop selling the Hunter's
 *   Net), Warden Bae at the stockade's gate (`warden`), the Net; into GameData and the editors' base content.
 * - **The licence** (`hunterLicence` at Yun): level, gold, not Wanted, not jailed, no offence on the account in the
 *   last `hunter.cleanDays`, not revoked. `char_jobs` (job `hunter`). A Hunter who breaks a wall is revoked for
 *   `hunter.revokeDays` (law.ts calls `revokeFor`).
 * - **Duty** (`hunterDuty`): on only in a safe area, out of combat, not Wanted, not jailed; off refused for
 *   `hunter.offDutyLockMin` after the last PvP hit. EntityState.hunter (the rank) while on duty.
 * - **PvP** (`allowed`, `refusal`; the shared `pvpAllowed`): an on-duty Hunter and a Wanted player, not associates,
 *   anywhere but the stockade (the safe area included). Gameplay's attack paths and the skill engine ask here;
 *   `pvpDamage` scales every player-on-player hit by `hunter.pvpMul`.
 * - **Capture**: a hit that would take a Wanted to 0 HP from a Hunter leaves 1 HP (`subdues`); the Wanted is bound
 *   (`stun`) for `law.subdueSec`, then caught (`law.capture`: the warrants close, the bounty is paid by the server by
 *   damage share among the Hunters with ≥ `law.captureMinPct` of the Wanted's max HP in the last `law.captureWindowSec`;
 *   the anti-collusion rules of law.ts withhold rewards and capture credit from associates, recent contacts, lookouts,
 *   the 7-day pair, a Wanted caught too often, past the daily cap) and jailed for the sentence (jail.ts), rewarded or
 *   not. A Wanted who logs out within
 *   `law.combatLogoutSec` of a Hunter's hit is caught on the spot.
 * - **Pings**: every `hunter.pingSec` each on-duty Hunter gets a `wantedPing` per Wanted online (a circle of `pingR`
 *   around a point within `pingOffsetM` of them).
 * - **The Hunter's Net** (`hunterNet {target}`): an on-duty Hunter throws one at a Wanted within `netRangeM`: a
 *   `netSec` snare (the stun status), `netCooldownSec` cooldown, one Net from the bag.
 * - **The Hunter job** (docs/JOBS.md §2.3; jobs/jobs.ts): the licence is the job (one job per character, one side per
 *   account: `jobs.joinProblem`), duty is its job mode (`jobMode` aliases `hunterDuty`), the rank is the job level − 1
 *   (a credited capture gives `exp.hunterWallCapture` job EXP; `points` still counts the captures), and the PvP rule
 *   carries the job rows (`side`: a Trader or Hunter against a Thief in job mode, outside towns and the safe rings).
 */

/** The chat line to a captor whose reward a rule withheld (docs/SIEGE.md §8.6). */
const WITHHELD: Record<CaptureRule, string> = {
  associate: 'No bounty and no capture for catching {name}: you are their party, guild, account or connection.',
  contact: 'No bounty and no capture for catching {name}: your accounts traded, partied or did business recently.',
  lookout: 'No bounty and no capture for catching {name}: you stood by while their Thunder Keg burned.',
  pair: 'No bounty and no capture this time: you caught {name} within the last {days} days.',
  repeat: '{name} was caught several times this week: the garrison pays less (or nothing) for them now.',
  daily_cap: 'You reached the bounty you may earn in a day: the rest of the bounty for {name} is withheld.',
}

/** Out of combat: no hit given or taken for this long (ms). */
const OUT_OF_COMBAT_MS = 10_000
const DAY_MS = 86_400_000

interface Subdue {
  until: number
  /** The Hunter whose hit subdued (characterId). */
  captor: number
}

export class HunterService implements GameplayModule {
  readonly name = 'hunters'
  readonly handles: readonly GameplayRequest[] = ['hunterLicence', 'hunterDuty', 'hunterNet']
  /** characterId -> the char_jobs row (null: no licence ever), loaded on demand. */
  private readonly rows = new Map<number, HunterRow | null>()
  /** characterId -> the last PvP hit given or taken (ms). */
  private readonly lastPvp = new Map<number, number>()
  /** Wanted characterId -> the Hunters' hits on them. */
  private readonly hits = new Map<number, PvpHit[]>()
  /** Wanted characterId -> being subdued. */
  private readonly subdued = new Map<number, Subdue>()
  /** Hunter characterId -> the Net is ready again then. */
  private readonly netAt = new Map<number, number>()
  private nextPing = 0
  private storeCache: HunterStore | null = null

  constructor(private readonly g: Gameplay) {
    g.world.decorators.push((e, s) => {
      if (e.kind !== 'player') return
      const r = this.onDutyRow(e.characterId)
      if (r) s.hunter = r.rank
    })
    if (!g.walls.on) return
    const d = g.data
    const added = installSiegeHunterContent({ items: d.items, shops: d.shops, npcs: d.npcs }, g.config.world, this.settings.netGold)
    if (d.shops.has(HUNTER_CODES.shop)) d.npcShop.set(HUNTER_CODES.yun, HUNTER_CODES.shop)
    for (const [npc, base] of [[d.npcs.find((n) => n.code === HUNTER_CODES.yun) ?? yunNpc(g.config.world), HUNTER_CODES.yunBase], [d.npcs.find((n) => n.code === HUNTER_CODES.warden) ?? wardenNpc(g.config.world), HUNTER_CODES.wardenBase]] as const) {
      if (!d.npcModel.has(npc.code)) d.npcModel.set(npc.code, base)
      addBaseNpc(d, npc, d.npcModel.get(npc.code))
    }
    g.config.log(`walls: Hunters on (Captain Yun, Warden Bae: ${added.npcs} added; the Hunter's Net${added.shop ? ' in his shop' : ''})`)
  }

  get store(): HunterStore {
    return (this.storeCache ??= new HunterStore(this.g.store.db))
  }

  get settings(): SiegeEventSettings['hunter'] {
    return this.g.siege.settings.hunter
  }

  private get law(): SiegeEventSettings['law'] {
    return this.g.siege.settings.law
  }

  /** Whether NPC `code` offers the `hunter` service (Captain Yun, with the walls on). */
  offers(code: string): boolean {
    return this.g.kegs.on && code === HUNTER_CODES.yun
  }

  // ---- reads ------------------------------------------------------------------------------------------------------------

  private row(characterId: number): HunterRow | null {
    let r = this.rows.get(characterId)
    if (r === undefined) {
      try {
        r = this.store.hunter(characterId)
      } catch {
        r = null
      }
      this.rows.set(characterId, r)
    }
    return r
  }

  private reload(characterId: number): HunterRow | null {
    this.rows.delete(characterId)
    this.g.jobs.invalidate(characterId)
    return this.row(characterId)
  }

  /** Drops the cached row (the jobs module calls it after writing the Hunter's row). */
  invalidate(characterId: number): void {
    this.rows.delete(characterId)
  }

  /** A PvP-like hit (a Thief's on a trade transport, docs/JOBS.md §2.2): the suit stays on for the lock. */
  markPvp(characterId: number, now: number): void {
    this.lastPvp.set(characterId, now)
  }

  /** The last PvP hit given or taken (null: none since the login). */
  lastPvpAt(characterId: number): number | null {
    return this.lastPvp.get(characterId) ?? null
  }

  /** The Hunter's badge (rank on duty, -1 off) and the job badge to everyone around, the own job state. */
  private badge(p: Player, now: number): void {
    const r = this.row(p.characterId)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, hunter: r && r.on_duty === 1 ? r.rank : -1, job: this.g.jobs.badgeOf(p.characterId) })
    this.g.jobs.sendState(p, now)
  }

  private onDutyRow(characterId: number): HunterRow | null {
    const r = this.row(characterId)
    return r && r.on_duty === 1 ? r : null
  }

  /** A licence that is not revoked now. */
  licensed(characterId: number, now: number): boolean {
    const r = this.row(characterId)
    return !!r && (r.revoked_until === null || r.revoked_until <= now)
  }

  onDuty(p: Player): boolean {
    return this.onDutyRow(p.characterId) !== null
  }

  isSubdued(p: Player): boolean {
    return this.subdued.has(p.characterId)
  }

  /** The Hunter's own view (lawState.hunter); null: never licensed. */
  viewOf(p: Player, now: number): HunterView | null {
    const r = this.row(p.characterId)
    if (!r) return null
    const v: HunterView = { licensed: r.revoked_until === null || r.revoked_until <= now, onDuty: r.on_duty === 1, rank: r.rank, captures: r.points }
    if (r.revoked_until !== null && r.revoked_until > now) v.revokedUntil = r.revoked_until
    const lock = this.lockUntil(p)
    if (lock > now) v.lockUntil = lock
    const net = this.netAt.get(p.characterId)
    if (net !== undefined && net > now) v.netAt = net
    return v
  }

  private lockUntil(p: Player): number {
    const last = this.lastPvp.get(p.characterId)
    return last === undefined ? 0 : last + this.settings.offDutyLockMin * 60_000
  }

  // ---- PvP (docs/SIEGE.md §8.3) -------------------------------------------------------------------------------------------

  private side(p: Player, now: number): PvpSide {
    const [x, , z] = this.g.world.positionAt(p, now)
    return {
      hunter: this.onDuty(p),
      // docs/JOBS.md §6.4: a robber is huntable too, but not inside the Bandit Den's ring
      wanted: this.g.law.huntable(p.characterId) && !(this.g.law.robberOnly(p.characterId) && this.g.jobs.inDenRing(x, z)),
      jailed: this.g.jail.jailedNow(p) || this.subdued.has(p.characterId),
      pardoned: this.g.jail.pardoned(p.characterId, now),
      inStockade: inStockade(x, z),
      // docs/JOBS.md §4: the job war
      ...this.g.jobs.pvpSide(p, x, z),
    }
  }

  /** Whether player `a` may attack player `t` now. */
  allowed(a: Player, t: Player, now: number): boolean {
    return this.refusal(a, t, now) === null
  }

  /** Why `a` may not attack `t` (null: allowed). Today's "no PvP" for everyone outside the Hunter / Wanted rule. */
  refusal(a: Player, t: Player, now: number): Fail | null {
    if (a === t) return fail('invalid_target')
    if (t.dead) return fail('target_dead')
    const sa = this.side(a, now)
    const st = this.side(t, now)
    const war = !!(sa.jobMode && st.jobMode && sa.job && st.job && jobSide(sa.job) !== jobSide(st.job))
    if (!sa.hunter && !sa.wanted && !war) return st.wanted ? fail('not_hunter', 'Only Bounty Hunters on duty may fight the Wanted (Captain Yun, by the west gate).') : fail('invalid_target', 'no PvP')
    const assoc = this.g.law.isAssociate(this.g.law.associates(a), t)
    if (pvpAllowed(sa, st, assoc)) return null
    if (sa.inStockade || st.inStockade || st.jailed) return fail('invalid_target', 'No fighting in the Garrison Stockade.')
    if (assoc && ((sa.hunter && st.wanted) || (sa.wanted && st.hunter) || war)) return fail('invalid_target', 'You cannot fight your own party, guild, account or friends.')
    if (sa.hunter && st.pardoned) return fail('invalid_target', 'Just released: the garrison has pardoned them for now.')
    if (war && (sa.inJobSafe || st.inJobSafe)) return fail('safe_zone', 'Towns and the trade posts are safe: the job war is fought on the roads.')
    if (sa.hunter && this.g.law.robberOnly(t.characterId)) return fail('safe_zone', 'The Bandit Den shelters its customers: catch the robber on the road.')
    return fail('invalid_target', 'no PvP')
  }

  /**
   * Damage between players (docs/SIEGE.md §5.2 pvpDamage): × `hunter.pvpMul`, at least 1. An on-duty Bounty Hunter's hit
   * on a robber (docs/JOBS.md §6.4) is × `robbery.hunterMul` instead (the jobs' own balance; the siege's Wanted keep pvpMul).
   */
  pvpDamage(damage: number, a?: Player | Mob, t?: Player): number {
    if (damage <= 0) return 0
    const robber = a?.kind === 'player' && t !== undefined && this.onDuty(a) && this.g.law.robber(t.characterId)
    return Math.max(1, Math.round(damage * (robber ? this.g.jobs.settings.robbery.hunterMul : this.settings.pvpMul)))
  }

  /** A player-on-player hit landed (both sides' combat lock; a Hunter's hit on the Wanted counts for the bounty). */
  onPvpHit(a: Player | Mob, t: Player, dealt: number, now: number): void {
    if (a.kind !== 'player' || a === t) return
    this.lastPvp.set(a.characterId, now)
    this.lastPvp.set(t.characterId, now)
    if (dealt <= 0 || !this.onDuty(a) || !this.g.law.huntable(t.characterId)) return
    const win = this.law.captureWindowSec * 1000
    const list = (this.hits.get(t.characterId) ?? []).filter((h) => now - h.at <= win)
    list.push({ characterId: a.characterId, damage: dealt, at: now })
    this.hits.set(t.characterId, list)
  }

  /** A hit of `a` would take `t` to 0 HP: a Wanted brought down by an on-duty Hunter is subdued instead (dealHits asks). */
  subdues(a: Player | Mob, t: Player): boolean {
    if (a.kind !== 'player' || a === t) return false
    if (this.subdued.has(t.characterId)) return true
    return this.onDuty(a) && this.g.law.huntable(t.characterId)
  }

  /** Starts the subdue (HP 1, bound for `law.subdueSec`); the capture follows in tick. */
  subdue(a: Player, t: Player, now: number): void {
    if (this.subdued.has(t.characterId)) return
    const ms = Math.max(0, this.law.subdueSec * 1000)
    this.subdued.set(t.characterId, { until: now + ms, captor: a.characterId })
    t.action = null
    this.g.world.halt(t, now)
    if (t.hp < 1) this.g.setVitals(t, 1, t.mp)
    if (ms > 0) this.g.skills.applyHazardStatus(t, 'stun', ms, now)
    for (const m of this.g.world.mobs.values()) if (m.target === t.id) m.target = null
    t.send({ t: 'chat', channel: 'system', text: `${a.name} has subdued you! The garrison is taking you to the Stockade.` })
    a.send({ t: 'chat', channel: 'system', text: `You subdue ${t.name}.` })
    if (ms === 0) this.captureNow(t.characterId, now)
  }

  // ---- capture (docs/SIEGE.md §8.4) ------------------------------------------------------------------------------------------

  /**
   * The capture of Wanted `characterId` (subdued, or a combat logout): the bounty split, the warrants closed, the jail.
   * Returns false when they were no longer Wanted.
   */
  captureNow(characterId: number, now: number): boolean {
    const sub = this.subdued.get(characterId)
    this.subdued.delete(characterId)
    const hits = this.hits.get(characterId) ?? []
    this.hits.delete(characterId)
    const target = this.playerOf(characterId)
    const maxHp = target?.maxHp ?? Math.max(1, ...hits.map((h) => h.damage))
    const shares = captureShares(hits, maxHp, now, this.law.captureWindowSec * 1000, this.law.captureMinPct, sub?.captor ?? null)
    const captors: { player: Player; share: number }[] = []
    for (const s of shares) {
      const p = this.playerOf(s.characterId)
      if (p) captors.push({ player: p, share: s.share })
    }
    const r = this.g.law.capture(characterId, captors, now)
    if (!r) return false
    const name = this.g.store.characterById(characterId)?.name ?? `#${characterId}`
    const names = r.captors.map((c) => c.name)
    this.credit(r, name, now)
    this.g.jail.imprison(characterId, r.sentenceMs, r.warrants[0] ?? null, now, `offence ${r.offence}`)
    if (target) target.send({ t: 'lawCapture', name, bounty: r.bounty, gold: 0, sentenceMs: r.sentenceMs, prisoner: true, ...(names.length ? { captors: names.slice(0, 20) } : {}) })
    this.g.config.log(`hunters: ${name} captured by ${names.join(', ') || 'nobody'}: bounty ${r.bounty}, sentence ${fmtTime(r.sentenceMs)}`)
    return true
  }

  /**
   * After a capture (here, or GM `law capture`): the captures and ranks of the captors the anti-collusion rules leave
   * in credit, `lawCapture` to each captor and why a reward was withheld.
   */
  credit(r: CaptureResult, name: string, now: number): void {
    const names = r.captors.map((c) => c.name)
    // a capture counts (captures, rank) only for captors the anti-collusion rules leave in credit (docs/SIEGE.md §8.6)
    for (const c of r.captors) {
      const row = this.row(c.characterId)
      if (c.credit && row) {
        // docs/JOBS.md §2.3, §3.1: the capture counts and gives job EXP (the rank is the job level − 1); jobs.ts sends the
        // promotion line and the badge
        this.store.addCapture(c.characterId)
        // docs/JOBS.md §3.1: a wall-breaker 2,000; a robber 300 × the Thief's job level × 2
        const e = this.g.jobs.settings.exp
        const exp = (r.wall ? e.hunterWallCapture : 0) + (r.robbery ? hunterThiefExp(r.thiefLevel, true, e) : 0)
        this.g.jobs.addExp(c.characterId, exp, now, `captured ${name}`)
      }
      this.reload(c.characterId)
      const p = this.playerOf(c.characterId)
      if (!p) continue
      const msg: Extract<ServerMessage, { t: 'lawCapture' }> = { t: 'lawCapture', name, bounty: r.bounty, gold: c.gold, sentenceMs: r.sentenceMs, captors: names.slice(0, 20) }
      if (c.rule) msg.rule = c.rule
      if (c.rule === 'pair') msg.pair = true
      if (!c.credit) msg.uncounted = true
      p.send(msg)
      if (c.rule && c.rule !== 'daily_cap' && c.rule !== 'repeat') p.send({ t: 'chat', channel: 'system', text: WITHHELD[c.rule].replace('{name}', name).replace('{days}', String(this.law.pairCooldownDays)) })
      else if (c.rule) p.send({ t: 'chat', channel: 'system', text: WITHHELD[c.rule].replace('{name}', name) })
      this.g.law.sendState(p, now)
    }
  }

  // ---- requests ------------------------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'hunterLicence':
        return this.licenceAt(p, msg.npc, answer, now)
      case 'hunterDuty':
        return answer(this.setDuty(p, msg.on, now))
      case 'hunterNet':
        return this.net(p, msg.target, answer, now)
      default:
        return answer(fail('not_found'))
    }
  }

  /** The Bounty Hunter's licence at Yun (`hunterLicence`, or `jobJoin {job: 'hunter'}`). */
  licenceAt(p: Player, npcId: number, answer: Answer, now: number): void {
    if (!this.g.kegs.on) return answer(fail('not_found', 'There are no Bounty Hunters on this server.'))
    const npc = this.g.npcs.requireService(p, npcId, HUNTER_SERVICE, now)
    if (!npc.ok) return answer(npc)
    const s = this.settings
    const r = this.row(p.characterId)
    if (r && r.revoked_until !== null && r.revoked_until > now) return answer(fail('not_usable', `Your licence is revoked until ${new Date(r.revoked_until).toISOString().slice(0, 10)}.`))
    if (r) return answer(fail('not_usable', 'You already hold a Bounty Hunter\'s licence.'))
    if (p.level < s.minLevel) return answer(fail('requirements', `Bounty Hunters are level ${s.minLevel} and up.`))
    if (this.g.law.isWanted(p.characterId)) return answer(fail('not_usable', 'The garrison does not license the Wanted.'))
    if (this.g.jail.jailedNow(p)) return answer(fail('jailed'))
    // docs/JOBS.md §2.1: one job per character, one side per account, the wait after leaving a job
    const job = this.g.jobs.joinProblem(p, 'hunter', now)
    if (job) return answer(job)
    const acc = this.g.law.accountOf(p.characterId)
    const rec = acc === null ? null : this.g.law.store.record(acc)
    if (rec && rec.offences > 0 && rec.lastAt !== null && now - rec.lastAt < s.cleanDays * DAY_MS) {
      const days = Math.ceil((rec.lastAt + s.cleanDays * DAY_MS - now) / DAY_MS)
      return answer(fail('requirements', `Your account broke the law not long ago: come back in ${days} day${days === 1 ? '' : 's'}.`))
    }
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => (d.gold < s.licenceGold ? fail('not_enough_gold', `The licence costs ${s.licenceGold.toLocaleString('en-US')} gold.`) : addGold(d, -s.licenceGold)))
    if (!result.ok) return answer(result)
    this.store.license(p.characterId, now)
    this.reload(p.characterId)
    this.g.jobs.joined(p, 'hunter', now)
    answer(true)
    this.g.afterInventory(p, draft)
    this.g.law.sendState(p, now)
    p.send({ t: 'chat', channel: 'system', text: `Captain Yun hands you a Bounty Hunter's licence (${s.licenceGold.toLocaleString('en-US')} gold). Go on duty to hunt the Wanted.` })
    this.g.config.log(`hunters: ${p.name} bought a Hunter's licence`)
  }

  /** Duty on or off (the request, Yun's dialog, the HUD). */
  setDuty(p: Player, on: boolean, now: number): true | Fail {
    const r = this.row(p.characterId)
    if (!r) return fail('not_hunter', 'You need a Bounty Hunter\'s licence from Captain Yun (west gate).')
    if (on) {
      if (r.on_duty === 1) return true
      if (!this.licensed(p.characterId, now)) return fail('not_hunter', 'Your Bounty Hunter\'s licence is revoked.')
      if (this.g.law.isWanted(p.characterId)) return fail('not_usable', 'The Wanted cannot go on duty.')
      if (this.g.jail.jailedNow(p)) return fail('jailed')
      const [x, , z] = this.g.world.positionAt(p, now)
      if (!this.g.data.inSafeArea(this.g.config.world, x, z)) return fail('wrong_place', 'Go on duty in a town (a safe area).')
      if (now - p.lastCombatAt < OUT_OF_COMBAT_MS) return fail('in_combat', 'Not in the middle of a fight.')
    } else {
      if (r.on_duty === 0) return true
      const lock = this.lockUntil(p)
      if (lock > now) return fail('in_combat', `You fought another player not long ago: off duty in ${Math.ceil((lock - now) / 1000)} s.`)
    }
    this.store.setDuty(p.characterId, on)
    this.reload(p.characterId)
    this.badge(p, now)
    this.g.law.sendState(p, now)
    if (on) this.ping(now, p)
    return true
  }

  /** Forced off duty (jailed, revoked; `quiet`: no lock check). */
  dutyOff(p: Player, now: number, _quiet = true): void {
    const r = this.row(p.characterId)
    if (!r || r.on_duty === 0) return
    this.store.setDuty(p.characterId, false)
    this.reload(p.characterId)
    this.badge(p, now)
    this.g.law.sendState(p, now)
  }

  /** A Hunter broke a wall (law.ts): the licence is revoked for `revokeDays`. */
  revokeFor(characterId: number, now: number, why: string): boolean {
    const r = this.row(characterId)
    if (!r) return false
    this.store.revoke(characterId, now + this.settings.revokeDays * DAY_MS)
    this.reload(characterId)
    const p = this.playerOf(characterId)
    if (p) {
      if (r.on_duty === 1) this.badge(p, now)
      this.g.law.sendState(p, now)
      p.send({ t: 'chat', channel: 'system', text: `Captain Yun revokes your Bounty Hunter's licence for ${this.settings.revokeDays} days (${why}).` })
    }
    this.g.config.log(`hunters: ${this.g.store.characterById(characterId)?.name ?? characterId}'s licence revoked (${why})`)
    return true
  }

  private net(p: Player, targetId: number, answer: Answer, now: number): void {
    if (!this.onDuty(p)) return answer(fail('not_hunter', 'Only Bounty Hunters on duty throw nets.'))
    const t = this.g.world.players.get(targetId)
    if (!t || !p.known.has(targetId)) return answer(fail('not_found'))
    const why = this.refusal(p, t, now)
    if (why) return answer(why)
    if (!this.g.law.huntable(t.characterId)) return answer(fail('invalid_target', 'Nets are for the Wanted.'))
    const s = this.settings
    if (this.g.world.distance(p, t, now) > s.netRangeM) return answer(fail('too_far', `Within ${s.netRangeM} m.`))
    if ((this.netAt.get(p.characterId) ?? 0) > now) return answer(fail('cooldown'))
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => {
      const i = d.bag.findIndex((it) => it?.code === HUNTER_CODES.net)
      return i < 0 ? fail('not_usable', "You have no Bounty Hunter's Net (Captain Yun sells them).") : takeFromBag(d, i, 1)
    })
    if (!result.ok) return answer(result)
    answer(true)
    this.g.afterInventory(p, draft)
    this.netAt.set(p.characterId, now + s.netCooldownSec * 1000)
    this.lastPvp.set(p.characterId, now)
    this.lastPvp.set(t.characterId, now)
    p.lastCombatAt = now
    t.lastCombatAt = now
    if (s.netSec > 0) this.g.skills.applyHazardStatus(t, 'stun', s.netSec * 1000, now)
    t.send({ t: 'chat', channel: 'system', text: `${p.name} throws a Bounty Hunter's Net over you!` })
    this.g.law.sendState(p, now)
  }

  // ---- pings (docs/SIEGE.md §8.1) ---------------------------------------------------------------------------------------------

  /** Pings now: to every on-duty Hunter (or only `to`). */
  ping(now: number, to?: Player): void {
    const hunters = to ? [to] : [...this.g.world.players.values()].filter((p) => this.onDuty(p))
    if (!hunters.length) return
    const s = this.settings
    for (const w of this.g.world.players.values()) {
      if (w.dead || !this.g.law.huntable(w.characterId) || this.g.jail.jailedNow(w)) continue
      const [x, , z] = this.g.world.positionAt(w, now)
      const a = this.g.rng() * Math.PI * 2
      const d = Math.sqrt(this.g.rng()) * Math.min(s.pingOffsetM, s.pingR)
      const msg: Extract<ServerMessage, { t: 'wantedPing' }> = { t: 'wantedPing', id: w.id, name: w.name, x: x + Math.sin(a) * d, z: z + Math.cos(a) * d, r: s.pingR, at: now }
      if (this.g.law.robberOnly(w.characterId)) msg.robbery = true
      for (const h of hunters) if (h !== w) h.send(msg)
    }
  }

  // ---- hooks ---------------------------------------------------------------------------------------------------------------

  /** The subdued may do nothing; a kegged on-duty Hunter is the keg's own business (law.kegRefusal). */
  gate(p: Player, _t: GameplayRequest | 'moveTo'): Fail | null {
    return this.subdued.has(p.characterId) ? fail('cant_act', 'You are subdued.') : null
  }

  enter(p: Player, now: number): void {
    this.reload(p.characterId)
    if (this.row(p.characterId)) this.g.law.sendState(p, now)
  }

  forget(p: Player): void {
    const now = this.g.now
    const cid = p.characterId
    // combat logout: a Wanted who leaves while subdued, or within combatLogoutSec of a Hunter's hit, is caught now
    const last = (this.hits.get(cid) ?? []).reduce((m, h) => Math.max(m, h.at), -Infinity)
    if (this.subdued.has(cid) || (this.g.law.isWanted(cid) && now - last <= this.law.combatLogoutSec * 1000)) {
      if (this.captureNow(cid, now)) this.g.config.log(`hunters: ${p.name} logged out in a fight with Hunters: caught on the spot`)
    }
    this.rows.delete(cid)
    this.subdued.delete(cid)
  }

  tick(now: number): void {
    for (const [cid, s] of [...this.subdued]) if (now >= s.until) this.captureNow(cid, now)
    if (now >= this.nextPing) {
      this.nextPing = now + this.settings.pingSec * 1000
      this.ping(now)
    }
  }

  private playerOf(characterId: number): Player | null {
    for (const p of this.g.world.players.values()) if (p.characterId === characterId) return p
    return null
  }

  // ---- GM ------------------------------------------------------------------------------------------------------------------

  /** `law hunter <name> licence|revoke|restore|duty on|off`. */
  gm(name: string, verb: string, arg: string | undefined, now: number): GmResult {
    const row = this.g.store.characterByName(name.replace(/^@/, ''))
    if (!row) return { ok: false, message: `No character named ${name}.` }
    const p = this.playerOf(row.id)
    const v = verb.toLowerCase()
    if (v === 'licence' || v === 'license' || v === 'restore') {
      const other = this.g.jobs.jobOf(row.id)
      if (other && other !== 'hunter') return { ok: false, message: `${row.name} is a ${other} (one job per character: job ${row.name} leave first).` }
      this.store.license(row.id, now)
      this.reload(row.id)
      if (p) this.g.law.sendState(p, now)
      return { ok: true, message: `${row.name} holds a Bounty Hunter's licence.` }
    }
    if (v === 'revoke') {
      if (!this.row(row.id)) return { ok: false, message: `${row.name} has no licence.` }
      const r = this.row(row.id)!
      this.store.revoke(row.id, now + this.settings.revokeDays * DAY_MS)
      this.reload(row.id)
      if (p) {
        if (r.on_duty === 1) this.badge(p, now)
        this.g.law.sendState(p, now)
      }
      return { ok: true, message: `${row.name}'s licence is revoked for ${this.settings.revokeDays} days.` }
    }
    if (v === 'duty') {
      const on = (arg ?? '').toLowerCase() === 'on'
      if (!['on', 'off'].includes((arg ?? '').toLowerCase())) return { ok: false, message: 'Usage: law hunter <name> duty on|off' }
      const r = this.row(row.id)
      if (!r) return { ok: false, message: `${row.name} has no licence.` }
      this.store.setDuty(row.id, on)
      this.reload(row.id)
      if (p) {
        this.badge(p, now)
        this.g.law.sendState(p, now)
      }
      return { ok: true, message: `${row.name} is ${on ? 'on' : 'off'} duty.` }
    }
    const r = this.row(row.id)
    if (!r) return { ok: false, message: `${row.name} has no Bounty Hunter's licence.` }
    return {
      ok: true,
      message: `${row.name}: Bounty Hunter rank ${r.rank}, ${r.points} captures, ${r.on_duty ? 'on' : 'off'} duty${r.revoked_until && r.revoked_until > now ? `, revoked until ${new Date(r.revoked_until).toISOString().slice(0, 16)}` : ''}.`,
    }
  }

  /** The licensed Hunters (the admin's Law tab). */
  list(now: number): { characterId: number; name: string; rank: number; captures: number; onDuty: boolean; revokedUntil: number | null; online: boolean }[] {
    return this.store.hunters().map((r) => ({
      characterId: r.character_id,
      name: this.g.store.characterById(r.character_id)?.name ?? `#${r.character_id}`,
      rank: r.rank,
      captures: r.points,
      onDuty: r.on_duty === 1,
      revokedUntil: r.revoked_until !== null && r.revoked_until > now ? r.revoked_until : null,
      online: this.playerOf(r.character_id) !== null,
    }))
  }
}

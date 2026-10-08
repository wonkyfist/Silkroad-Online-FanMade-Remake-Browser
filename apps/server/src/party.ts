import {
  PARTY_INVITE_MS,
  PARTY_MAX,
  PARTY_OFFLINE_GRACE_MS,
  PARTY_SHARE_RANGE,
  type GameplayRequest,
  type PartyEventKind,
  type PartyExpMode,
  type PartyItemMode,
  type PartyMember,
  type PartyState,
  type PartyVitals,
  type ServerMessage,
} from '@sro/shared'
import { isGoldCode, killExp, type Gameplay, type KillShares, type LootOwner } from './gameplay.ts'
import { addGold, fail } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from './modules.ts'
import type { GroundItem, Mob, Player } from './world.ts'

/**
 * Parties (docs/QUESTS.md §4; lane PT-S). Runtime only: a restart dissolves parties [rule].
 *
 * - Requests (§4.1): partyInvite / partyRespond / partyLeave / partyKick / partyLeader / partySettings, with the §4.1
 *   reasons. Every membership, leader or mode change sends the full `party` state to the online members, plus a
 *   `partyEvent` line (see PartyEventKind below for who gets which name).
 * - Lifecycle: `enter` brings a member back online (its `party` state comes last in the enter-world sequence);
 *   `forget` marks it offline, and `tick` removes it after PARTY_OFFLINE_GRACE_MS (120 s). Invites expire after 30 s.
 * - `partyVitals`: changed member HP/MP/level/dead at most every 500 ms, positions at 1 Hz.
 * - Kills (§4.2, decision 40/41): `killShares` builds the EXP shares, quest credit and loot plan of every kill a party
 *   took part in; null leaves the kill to the solo rule (gameplay.ts soloShares, the wave-3 behaviour).
 * - Loot (§4.3): `mayLoot` lets party members into an item's owner window (free mode; gold in either mode), and
 *   `goldSplit` splits share-mode party gold at pickup among the members near the picker.
 * - `sameParty` for party-only friendly skills (decision 13) and `chat` for the party channel (§4.4, chat.ts).
 *
 * Event names: 'joined' {joiner} to every member (the joiner too); 'left' {leaver} to those who stay; 'kicked'
 * {kicked member} to everyone, the kicked member included; 'leader' {new leader}; 'settings' {leader}; 'offline' /
 * 'online' {member} to the others; 'declined' {who declined} to the inviter; 'expired' {the other side} to the inviter
 * and to the invitee (an invite also ends this way when either side leaves the world); 'disbanded' {last leaver} to
 * the one member left, followed by `party: null`.
 */

/** Rule: party EXP bonus per member beyond the first (docs/QUESTS.md §4.2: ×1.7 for 8). */
export const PARTY_EXP_BONUS = 0.1
/** How often changed vitals go out (PROTOCOL: at most every 500 ms). */
export const PARTY_VITALS_MS = 500
/** Positions go out at 1 Hz, and only after a move of at least this many metres. */
export const PARTY_POS_MS = 1000
export const PARTY_POS_EPS_M = 0.5

interface MemberRecord {
  characterId: number
  name: string
  model: string
  /** Last known values (kept while the member is offline). */
  level: number
  hp: number
  maxHp: number
  mp: number
  maxMp: number
}

export interface Party {
  id: number
  /** characterId of the leader. */
  leader: number
  /** Join order (the leadership fallback order and the round-robin order). */
  members: MemberRecord[]
  exp: PartyExpMode
  items: PartyItemMode
  /** Round-robin cursor into `members` for 'share' loot. */
  rrIndex: number
  /** characterId -> when it went offline (the 120 s grace). */
  offlineSince: Map<number, number>
  /** Vitals as the members' clients last got them (diff base for partyVitals). */
  sent: Map<number, SentVitals>
}

interface SentVitals {
  entity: number | null
  level: number
  hp: number
  maxHp: number
  mp: number
  maxMp: number
  dead: boolean
  pos?: [number, number]
}

interface Invite {
  from: number
  fromName: string
  to: number
  toName: string
  exp: PartyExpMode
  items: PartyItemMode
  expiresAt: number
}

/** The share-mode pool of a group's EXP (docs/QUESTS.md §4.2 step 3): E_g × (1 + 0.1 × (n − 1)). */
export function partyPool(exp: number, n: number): number {
  return n <= 0 ? 0 : exp * (1 + PARTY_EXP_BONUS * (n - 1))
}

/** A pool split by character level (§4.2 step 3): pool × Lᵢ / ΣL, rounded. */
export function levelShares(pool: number, levels: readonly number[]): number[] {
  const weights = levels.map((l) => Math.max(1, l))
  const total = weights.reduce((s, l) => s + l, 0)
  return weights.map((l) => (total > 0 ? Math.round((pool * l) / total) : 0))
}

/** Gold split at pickup (§4.3): `n` shares of floor(amount / n); the picker keeps its share plus the remainder. */
export function splitGold(amount: number, n: number): { share: number; keep: number } {
  if (n <= 1) return { share: 0, keep: amount }
  const share = Math.floor(amount / n)
  return { share, keep: amount - share * (n - 1) }
}

const round1 = (v: number) => Math.round(v * 10) / 10
const VITAL_KEYS = ['entity', 'level', 'hp', 'maxHp', 'mp', 'maxMp', 'dead'] as const

export class PartyManager implements GameplayModule {
  readonly name = 'party'
  readonly handles: readonly GameplayRequest[] = ['partyInvite', 'partyRespond', 'partyLeave', 'partyKick', 'partyLeader', 'partySettings']
  /** Party bookkeeping stays possible while dead (docs/WAVE_PLAN.md decision 36); inviting is not. */
  readonly whileDead: readonly GameplayRequest[] = ['partyRespond', 'partyLeave', 'partyKick', 'partyLeader', 'partySettings']

  /** Every live party by id. */
  readonly parties = new Map<number, Party>()
  /** characterId -> its party. */
  readonly byChar = new Map<number, Party>()
  /** Invited characterId -> the pending invite (one at a time per invitee). */
  readonly invites = new Map<number, Invite>()
  private nextId = 1
  private nextVitalsAt = 0
  private nextPosAt = 0

  constructor(readonly g: Gameplay) {}

  // ---- queries -------------------------------------------------------------------------------------------

  /** The party of a player (or character id), if any. */
  partyOf(p: Player | number): Party | undefined {
    return this.byChar.get(typeof p === 'number' ? p : p.characterId)
  }

  /** Whether two players are in the same party. */
  sameParty(a: Player, b: Player): boolean {
    const pa = this.byChar.get(a.characterId)
    return pa !== undefined && pa === this.byChar.get(b.characterId)
  }

  /** The online player of a character (entering the world again gives it a new entity id). */
  private online(characterId: number): Player | undefined {
    for (const p of this.g.world.players.values()) if (p.characterId === characterId) return p
    return undefined
  }

  // ---- requests ------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'partyInvite':
        return this.invite(p, msg.target, msg.exp, msg.items, answer, now)
      case 'partyRespond':
        return this.respond(p, msg.inviter, msg.accept, answer, now)
      case 'partyLeave': {
        const party = this.byChar.get(p.characterId)
        if (!party) return answer(fail('not_in_party'))
        answer(true)
        return this.remove(party, p.characterId, 'left')
      }
      case 'partyKick':
        return this.kick(p, msg.member, answer)
      case 'partyLeader':
        return this.setLeader(p, msg.member, answer)
      case 'partySettings':
        return this.settings(p, msg.exp, msg.items, answer)
    }
    answer(fail('not_found'))
  }

  private invite(p: Player, targetId: number, exp: PartyExpMode | undefined, items: PartyItemMode | undefined, answer: Answer, now: number): void {
    if (targetId === p.id) return answer(fail('invalid_target', 'You cannot invite yourself.'))
    const e = this.g.world.entity(targetId)
    if (!e || !p.known.has(targetId)) return answer(fail('not_found'))
    if (e.kind !== 'player') return answer(fail('invalid_target', 'Only players can join a party.'))
    if (!this.g.world.canSee(p, e)) return answer(fail('not_found'))
    if (this.byChar.has(e.characterId)) return answer(fail('in_party', `${e.name} is already in a party.`))
    if (this.invites.has(e.characterId)) return answer(fail('cooldown', `${e.name} already has a party invitation.`))
    const party = this.byChar.get(p.characterId)
    if (party && party.leader !== p.characterId) return answer(fail('not_leader', 'Only the party leader can invite.'))
    if (party && party.members.length >= PARTY_MAX) return answer(fail('party_full'))
    const inv: Invite = {
      from: p.characterId,
      fromName: p.name,
      to: e.characterId,
      toName: e.name,
      exp: party?.exp ?? exp ?? 'share',
      items: party?.items ?? items ?? 'free',
      expiresAt: now + PARTY_INVITE_MS,
    }
    this.invites.set(e.characterId, inv)
    answer(true)
    e.send({ t: 'partyInvited', inviter: p.id, name: p.name, level: p.level, exp: inv.exp, items: inv.items, expiresInMs: PARTY_INVITE_MS })
  }

  private respond(p: Player, inviterId: number, accept: boolean, answer: Answer, now: number): void {
    const inv = this.invites.get(p.characterId)
    if (!inv) return answer(fail('no_invite'))
    const from = this.online(inv.from)
    if (!from) {
      this.invites.delete(p.characterId)
      return answer(fail('no_invite', `${inv.fromName} is no longer online.`))
    }
    if (from.id !== inviterId) return answer(fail('no_invite'))
    this.invites.delete(p.characterId)
    if (!accept) {
      answer(true)
      from.send(this.event('declined', p.name))
      return
    }
    if (this.byChar.has(p.characterId)) return answer(fail('in_party'))
    let party = this.byChar.get(from.characterId)
    if (party && party.leader !== from.characterId) return answer(fail('not_leader', `${from.name} is no longer the party leader.`))
    if (party && party.members.length >= PARTY_MAX) return answer(fail('party_full'))
    answer(true)
    if (!party) {
      party = { id: this.nextId++, leader: from.characterId, members: [], exp: inv.exp, items: inv.items, rrIndex: 0, offlineSince: new Map(), sent: new Map() }
      this.parties.set(party.id, party)
      this.join(party, from)
    }
    this.join(party, p)
    // Siege of Jangan layer 6 (docs/SIEGE.md §8.6): partying together is a recent contact (no bounties on each other)
    for (const m of party.members) if (m.characterId !== p.characterId) this.g.law.contact(p.characterId, m.characterId, 'party', now)
    this.broadcast(party, this.event('joined', p.name))
    this.sendState(party)
    this.g.config.log(`party ${party.id}: ${p.name} joined (${party.members.map((m) => m.name).join(', ')})`)
  }

  private join(party: Party, p: Player): void {
    party.members.push(this.record(p))
    this.byChar.set(p.characterId, party)
    // Someone who joins a party has no use for another invitation.
    const pending = this.invites.get(p.characterId)
    if (pending) {
      this.invites.delete(p.characterId)
      this.online(pending.from)?.send(this.event('expired', p.name))
      p.send(this.event('expired', pending.fromName))
    }
  }

  private kick(p: Player, member: number, answer: Answer): void {
    const party = this.byChar.get(p.characterId)
    if (!party) return answer(fail('not_in_party'))
    if (party.leader !== p.characterId) return answer(fail('not_leader'))
    if (member === p.characterId) return answer(fail('invalid_target', 'Use Leave to leave the party.'))
    if (!party.members.some((m) => m.characterId === member)) return answer(fail('not_found'))
    answer(true)
    this.remove(party, member, 'kicked')
  }

  private setLeader(p: Player, member: number, answer: Answer): void {
    const party = this.byChar.get(p.characterId)
    if (!party) return answer(fail('not_in_party'))
    if (party.leader !== p.characterId) return answer(fail('not_leader'))
    if (member === p.characterId) return answer(fail('invalid_target', 'You already lead the party.'))
    const rec = party.members.find((m) => m.characterId === member)
    if (!rec) return answer(fail('not_found'))
    if (!this.online(member)) return answer(fail('invalid_target', `${rec.name} is offline.`))
    answer(true)
    party.leader = member
    this.broadcast(party, this.event('leader', rec.name))
    this.sendState(party)
  }

  private settings(p: Player, exp: PartyExpMode | undefined, items: PartyItemMode | undefined, answer: Answer): void {
    const party = this.byChar.get(p.characterId)
    if (!party) return answer(fail('not_in_party'))
    if (party.leader !== p.characterId) return answer(fail('not_leader'))
    answer(true)
    if (exp) party.exp = exp
    if (items) party.items = items
    this.broadcast(party, this.event('settings', p.name))
    this.sendState(party)
  }

  /** Takes a member out ('left': leave or offline grace; 'kicked'); passes the lead and disbands a party of one. */
  private remove(party: Party, characterId: number, how: 'left' | 'kicked'): void {
    const i = party.members.findIndex((m) => m.characterId === characterId)
    if (i < 0) return
    const [rec] = party.members.splice(i, 1)
    if (i < party.rrIndex) party.rrIndex--
    if (party.rrIndex >= party.members.length) party.rrIndex = 0
    this.byChar.delete(characterId)
    party.offlineSince.delete(characterId)
    party.sent.delete(characterId)
    const gone = this.online(characterId)
    if (gone) {
      if (how === 'kicked') gone.send(this.event('kicked', rec.name))
      gone.send({ t: 'party', party: null })
    }
    this.broadcast(party, this.event(how, rec.name))
    if (party.members.length <= 1) return this.disband(party, rec.name)
    if (party.leader === characterId) {
      const next = party.members.find((m) => this.online(m.characterId)) ?? party.members[0]
      party.leader = next.characterId
      this.broadcast(party, this.event('leader', next.name))
    }
    this.sendState(party)
    this.g.config.log(`party ${party.id}: ${rec.name} ${how === 'kicked' ? 'was kicked' : 'left'}`)
  }

  private disband(party: Party, by: string): void {
    for (const m of party.members) {
      this.byChar.delete(m.characterId)
      const p = this.online(m.characterId)
      if (p) {
        p.send(this.event('disbanded', by))
        p.send({ t: 'party', party: null })
      }
    }
    party.members = []
    this.parties.delete(party.id)
    this.g.config.log(`party ${party.id} disbanded`)
  }

  // ---- lifecycle hooks -----------------------------------------------------------------------------------

  /** Back in the world (relog within the grace): the member is online again; its `party` comes last on enter. */
  enter(p: Player, _now: number): void {
    const party = this.byChar.get(p.characterId)
    if (!party) return
    party.offlineSince.delete(p.characterId)
    const rec = party.members.find((m) => m.characterId === p.characterId)
    if (rec) Object.assign(rec, this.record(p))
    this.broadcast(party, this.event('online', p.name), p.characterId)
    this.sendState(party)
  }

  /** Left the world: its invites end, and it stays in its party as offline for the grace period. */
  forget(p: Player): void {
    const now = Date.now()
    const mine = this.invites.get(p.characterId)
    if (mine) {
      this.invites.delete(p.characterId)
      this.online(mine.from)?.send(this.event('expired', p.name))
    }
    for (const [to, inv] of this.invites) {
      if (inv.from !== p.characterId) continue
      this.invites.delete(to)
      this.online(to)?.send(this.event('expired', p.name))
    }
    const party = this.byChar.get(p.characterId)
    if (!party) return
    const rec = party.members.find((m) => m.characterId === p.characterId)
    if (rec) Object.assign(rec, this.record(p))
    party.offlineSince.set(p.characterId, now)
    this.broadcast(party, this.event('offline', p.name))
    this.sendState(party)
  }

  tick(now: number): void {
    for (const [to, inv] of this.invites) {
      if (now < inv.expiresAt) continue
      this.invites.delete(to)
      this.online(inv.from)?.send(this.event('expired', inv.toName))
      this.online(to)?.send(this.event('expired', inv.fromName))
    }
    for (const party of [...this.parties.values()]) {
      for (const [id, since] of [...party.offlineSince]) {
        if (now - since >= PARTY_OFFLINE_GRACE_MS && this.parties.has(party.id)) this.remove(party, id, 'left')
      }
    }
    if (now < this.nextVitalsAt) return
    this.nextVitalsAt = now + PARTY_VITALS_MS
    const withPos = now >= this.nextPosAt
    if (withPos) this.nextPosAt = now + PARTY_POS_MS
    for (const party of this.parties.values()) this.sendVitals(party, now, withPos)
  }

  // ---- state and vitals ----------------------------------------------------------------------------------

  private record(p: Player): MemberRecord {
    return { characterId: p.characterId, name: p.name, model: p.model, level: p.level, hp: Math.round(p.hp), maxHp: p.maxHp, mp: Math.round(p.mp), maxMp: p.maxMp }
  }

  private vitalsOf(rec: MemberRecord, now: number): SentVitals {
    const p = this.online(rec.characterId)
    if (!p) return { entity: null, level: rec.level, hp: rec.hp, maxHp: rec.maxHp, mp: rec.mp, maxMp: rec.maxMp, dead: false }
    Object.assign(rec, this.record(p))
    const [x, , z] = this.g.world.positionAt(p, now)
    return { entity: p.id, level: p.level, hp: Math.max(0, Math.round(p.hp)), maxHp: p.maxHp, mp: Math.max(0, Math.round(p.mp)), maxMp: p.maxMp, dead: p.dead, pos: [round1(x), round1(z)] }
  }

  /** The party as its members see it (also what the client parser accepts). */
  state(party: Party, now = Date.now()): PartyState {
    const members: PartyMember[] = party.members.map((rec) => {
      const v = this.vitalsOf(rec, now)
      party.sent.set(rec.characterId, v)
      const m: PartyMember = { characterId: rec.characterId, name: rec.name, model: rec.model, level: v.level, entity: v.entity, hp: v.hp, maxHp: v.maxHp, mp: v.mp, maxMp: v.maxMp }
      if (v.dead) m.dead = true
      if (v.pos) m.pos = v.pos
      return m
    })
    return { id: party.id, leader: party.leader, exp: party.exp, items: party.items, members }
  }

  private sendState(party: Party): void {
    this.broadcast(party, { t: 'party', party: this.state(party) })
  }

  private sendVitals(party: Party, now: number, withPos: boolean): void {
    const out: PartyVitals[] = []
    for (const rec of party.members) {
      const v = this.vitalsOf(rec, now)
      const last = party.sent.get(rec.characterId)
      const d: PartyVitals = { characterId: rec.characterId }
      let changed = false
      for (const k of VITAL_KEYS) {
        if (last && last[k] === v[k]) continue
        Object.assign(d, { [k]: v[k] })
        changed = true
      }
      const next: SentVitals = { ...v, pos: last?.pos }
      if (v.pos && (withPos || !last?.pos)) {
        const lp = last?.pos
        if (!lp || Math.hypot(lp[0] - v.pos[0], lp[1] - v.pos[1]) >= PARTY_POS_EPS_M) {
          d.pos = v.pos
          next.pos = v.pos
          changed = true
        }
      }
      if (!v.pos) next.pos = undefined
      party.sent.set(rec.characterId, next)
      if (changed) out.push(d)
    }
    if (out.length) this.broadcast(party, { t: 'partyVitals', members: out })
  }

  private event(event: PartyEventKind, name: string): ServerMessage {
    return { t: 'partyEvent', event, name }
  }

  /** Sends to every online member (except one character). */
  private broadcast(party: Party, msg: ServerMessage, exceptChar?: number): void {
    for (const m of party.members) {
      if (m.characterId === exceptChar) continue
      this.online(m.characterId)?.send(msg)
    }
  }

  // ---- kills (docs/QUESTS.md §4.2, §4.3) ------------------------------------------------------------------

  /**
   * Shares, credit and loot owners of a kill a party took part in; null = no party involved (the solo rule applies).
   *
   * Damage groups: each damage dealer still in the world belongs to its party, or is its own group. Group g gets
   * E × D_g / ΣD. Solo and 'free' groups split it by damage (exactly shareRewards). A 'share' group gives
   * pool = E_g × (1 + 0.1 × (n − 1)) to its eligible members M_g (online, alive, within 60 m of the corpse, plus its
   * alive damage dealers), weighted by level. Credit = alive dealers ∪ every party group's M_g, whatever the mode.
   * Loot: the group with the most damage decides (solo: top dealer; free: its top dealer, with ownerParty; share:
   * round robin over M_g, with ownerParty).
   */
  killShares(m: Mob, now: number): KillShares | null {
    const world = this.g.world
    interface Group { party: Party | null; damage: number; dealers: { p: Player; d: number }[] }
    const groups = new Map<string, Group>()
    let total = 0
    let partyInvolved = false
    for (const [id, d] of m.damage) {
      const p = world.players.get(id)
      if (!p || !(d > 0)) continue
      const party = this.byChar.get(p.characterId) ?? null
      if (party) partyInvolved = true
      const key = party ? `p${party.id}` : `s${p.id}`
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { party, damage: 0, dealers: [] }))
      g.damage += d
      g.dealers.push({ p, d })
      total += d
    }
    if (!partyInvolved || total <= 0) return null
    const { exp, spExp } = killExp(m)
    const [cx, , cz] = world.positionAt(m, now)
    const shares = new Map<number, { exp: number; spExp: number }>()
    const credit = new Set<number>()
    const eligibleOf = new Map<Group, Player[]>()
    for (const g of groups.values()) {
      for (const { p } of g.dealers) if (!p.dead) credit.add(p.id)
      const eligible: Player[] = []
      if (g.party) {
        for (const rec of g.party.members) {
          const p = this.online(rec.characterId)
          if (!p || p.dead) continue
          const [x, , z] = world.positionAt(p, now)
          if (g.dealers.some((q) => q.p.id === p.id) || Math.hypot(x - cx, z - cz) <= PARTY_SHARE_RANGE) eligible.push(p)
        }
        for (const p of eligible) credit.add(p.id)
      }
      eligibleOf.set(g, eligible)
      if (g.party?.exp === 'share' && eligible.length > 0) {
        const eg = (exp * g.damage) / total
        const sg = (spExp * g.damage) / total
        const n = eligible.length
        const levels = eligible.map((p) => p.level)
        const es = levelShares(partyPool(eg, n), levels)
        const ss = levelShares(partyPool(sg, n), levels)
        eligible.forEach((p, i) => shares.set(p.id, { exp: es[i], spExp: ss[i] }))
      } else {
        for (const { p, d } of g.dealers) shares.set(p.id, { exp: Math.round((exp * d) / total), spExp: Math.round((spExp * d) / total) })
      }
    }
    // Loot: the group with the most damage (first in damage order on a tie).
    let top: Group | null = null
    for (const g of groups.values()) if (!top || g.damage > top.damage) top = g
    const topDealer = (g: Group): Player | null => g.dealers.reduce<{ p: Player; d: number } | null>((b, x) => (!b || x.d > b.d ? x : b), null)?.p ?? null
    const owner = top ? topDealer(top) : null
    const party = top?.party ?? null
    const pool = top ? (eligibleOf.get(top) ?? []) : []
    const next = (): LootOwner => {
      if (!party) return { player: owner, party: null }
      if (party.items === 'share' && pool.length > 0 && party.members.length > 0) {
        // Round robin in join order over the eligible members, carrying the cursor from kill to kill.
        for (let k = 0; k < party.members.length; k++) {
          const i = (party.rrIndex + k) % party.members.length
          const p = pool.find((x) => x.characterId === party.members[i].characterId)
          if (!p) continue
          party.rrIndex = (i + 1) % party.members.length
          return { player: p, party: party.id }
        }
      }
      return { player: owner, party: party.id }
    }
    return { shares, credit, lootOwners: { next }, lootGroup: { player: owner, party: party?.id ?? null } }
  }

  // ---- pickup (docs/QUESTS.md §4.3) ----------------------------------------------------------------------

  /**
   * Whether `p` may take `item` during someone else's owner window: a member of the item's party may, when the item
   * dropped in 'free' item mode, and for gold in either mode (share-mode gold is split at pickup anyway). The mode is
   * the one at drop time (GroundItem.ownerPartyItems), never the party's current one.
   */
  mayLoot(p: Player, item: GroundItem): boolean {
    if (item.ownerParty === undefined || item.ownerParty === null) return false
    const party = this.byChar.get(p.characterId)
    if (!party || party.id !== item.ownerParty) return false
    return (item.ownerPartyItems ?? party.items) === 'free' || isGoldCode(item.code)
  }

  /**
   * Party gold that dropped in share mode, picked up by `p`: the other members online, alive and within 60 m of the
   * picker each get floor(amount / n); the picker keeps its share plus the remainder. Returns null when there is
   * nothing to split.
   * `keep` is what the picker's own transaction adds; call `pay()` after that commit.
   */
  goldSplit(p: Player, item: GroundItem, now: number): { keep: number; pay(): void } | null {
    const party = this.byChar.get(p.characterId)
    if (!party || (item.ownerPartyItems ?? party.items) !== 'share' || item.ownerParty !== party.id) return null
    const world = this.g.world
    const [px, , pz] = world.positionAt(p, now)
    const others: Player[] = []
    for (const rec of party.members) {
      if (rec.characterId === p.characterId) continue
      const q = this.online(rec.characterId)
      if (!q || q.dead) continue
      const [x, , z] = world.positionAt(q, now)
      if (Math.hypot(x - px, z - pz) <= PARTY_SHARE_RANGE) others.push(q)
    }
    const { share, keep } = splitGold(item.count, others.length + 1)
    if (others.length === 0 || share <= 0) return null
    return {
      keep,
      pay: () => {
        for (const q of others) {
          const { result, draft } = this.g.store.inventoryTx(q.characterId, (d) => addGold(d, share))
          if (!result.ok) continue
          this.g.afterInventory(q, draft)
          q.send({ t: 'chat', channel: 'system', text: `You received ${share} gold (party share from ${p.name}).` })
        }
      },
    }
  }

  // ---- chat (docs/QUESTS.md §4.4) ------------------------------------------------------------------------

  /** A party chat line from `p` to the online members; false when `p` is in no party. */
  chat(p: Player, text: string): boolean {
    const party = this.byChar.get(p.characterId)
    if (!party) return false
    this.broadcast(party, { t: 'chat', channel: 'party', fromId: p.id, from: p.name, text })
    return true
  }
}

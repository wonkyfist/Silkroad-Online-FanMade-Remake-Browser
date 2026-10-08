/**
 * Siege of Jangan, layer 6: Hunters and the jail (docs/SIEGE.md §8.2-§8.6, §11.3, §12, §14).
 *
 * - pure rules: `pvpAllowed` (every combination of the two sides), ranks, the bounty's shares (damage in the window, the
 *   10 % floor, the capturing Hunter), the jail clock (real and online, chores and their cap), the settings;
 * - the licence at Captain Yun (level, gold, not Wanted, 30 clean days), duty (a safe area, out of combat; off duty
 *   locked after a PvP hit), the Hunter badge (EntityState.hunter);
 * - PvP gating: only an on-duty Hunter and a Wanted, both ways; not an off-duty Hunter, not a stranger, not associates
 *   (party, the same account), not in the stockade; the safe area does not protect the Wanted; skills too; × pvpMul;
 * - capture: a Hunter's hit that would kill subdues at 1 HP, then the capture (the warrant closes, the server pays the
 *   bounty by damage share, the prisoner goes to the stockade, `lawCapture`); the 7-day pair rule; associates and
 *   Hunters under 10 % get nothing; a combat logout is a capture;
 * - the jail: refusals (attack, return scroll, shop, duty, keg) but potions; moves clamped; an escape put back; relog
 *   and restart keep the term; sentences double per offence (2 h, then 4 h); the real clock runs offline, the online
 *   clock does not; chores (−1 min, capped at 25 %); release with a pardon;
 * - the Hunter's Net, pings, a Hunter who breaks a wall loses the licence, kegs refused in the jail and on duty;
 * - GM `law jail / release / hunter`; the admin Law tab (GET, pardon, jail, release, time, hunter, forgive).
 */
import {
  HUNTER_CODES,
  LAW_CODES,
  SIEGE_EVENT_DEFAULTS,
  STOCKADE,
  captureShares,
  checkSiegeEventSettings,
  choreCreditMs,
  choresLeft,
  hunterRank,
  inStockade,
  installSiegeHunterContent,
  installSiegeLawContent,
  jailLeftMs,
  pvpAllowed,
  yunNpc,
  type AdminLawView,
  type PvpSide,
  type ServerMessage,
  type Vec3,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { GameContext } from '../src/game.ts'
import { rollSkillHit } from '../src/formulas.ts'
import { GameData } from '../src/gamedata.ts'
import { addGold, addItem } from '../src/inventory.ts'
import { routeAdminSiege, saveSiegeSettings } from '../src/siege/event-admin.ts'
import { JailService } from '../src/siege/jail.ts'
import { lawView } from '../src/siege/law-admin.ts'
import { logSocial } from '../src/social/pair-tx.ts'
import type { KegWalls } from '../src/siege/keg.ts'
import type { Player } from '../src/world.ts'
import { item } from './fixtures.ts'
import { SAFE_TOWN, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const LAW = SIEGE_EVENT_DEFAULTS.law

let cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

/** Walls that exist (so the kegs, Yun and Bae are on) but are never touched here. */
const WALLS: KegWalls = { on: true, walls: { segments: [], sides: [] }, settings: { maxIp: 20_000 }, stageOf: () => 'intact', change: () => null }

const SCROLL = item('ITEM_TEST_RETURN', { category: 'etc', typeId: [3, 3, 3, 3], maxStack: 10, use: { returnToTown: true, castMs: 1000 } })
const POTION = item('ITEM_TEST_HP', { category: 'etc', typeId: [3, 3, 1, 1], maxStack: 50, use: { hp: 50, cooldownGroup: 'hp', cooldownMs: 1000 } })

function harness() {
  const data = new GameData({ mobs: [], items: [...SKILL_ITEMS, SCROLL, POTION], levels: SKILL_LEVELS, towns: [{ ...SAFE_TOWN, safeArea: { x: 0, z: 0, halfX: 80, halfZ: 80 } }] })
  installSiegeLawContent({ items: data.items, drops: data.drops, npcs: data.npcs }, 'jangan')
  installSiegeHunterContent({ items: data.items, shops: data.shops, npcs: data.npcs }, 'jangan')
  const h = skillHarness({ data, config: { uniques: false } })
  cleanups.push(h.cleanup)
  const g = h.gameplay
  g.kegs.configure({ walls: WALLS })
  const tick = (ms: number) => h.runTo(h.now + ms)
  /** Jumps the clock (one tick at the end): long waits without 50 ms steps. */
  const jump = (ms: number) => {
    h.now = h.now + ms - 50
    h.runTo(h.now + 50)
  }
  const char = (pos: Vec3, o: { name?: string; level?: number; alt?: Player } = {}) => {
    let characterId: number | undefined
    if (o.alt) {
      const acc = h.store.characterById(o.alt.characterId)!.account_id
      const row = h.store.createCharacter(acc, o.name ?? `Alt${Math.floor(Math.random() * 1e6)}`, 'CHAR_CH_MAN_ADVENTURER', 'sword', 'jangan', 4)
      if (typeof row === 'string') throw new Error(row)
      characterId = row.id
      h.store.saveProgress(row.id, { level: o.level ?? 20, exp: 0, sp: 0, spExp: 0, str: 39, int: 39, statPoints: 0 })
      g.grantStarterKit(row.id, 'sword', row.model)
    }
    const r = h.hero({ pos, level: o.level ?? 20, ...(o.name && !o.alt ? { name: o.name } : {}), ...(characterId ? { characterId } : {}) })
    r.p.maxHp = r.p.hp = 5000
    return r
  }
  const gold = (p: Player, n: number) => {
    const { draft } = h.store.inventoryTx(p.characterId, (d) => addGold(d, n))
    g.afterInventory(p, draft)
  }
  const give = (p: Player, code: string, n = 1) => {
    const { draft } = h.store.inventoryTx(p.characterId, (d) => addItem(d, data.item(code)!, n))
    g.afterInventory(p, draft)
  }
  const goldOf = (p: Player) => h.store.loadInventory(p.characterId).gold
  const slotOf = (p: Player, code: string) => h.store.loadInventory(p.characterId).bag.findIndex((i) => i?.code === code)
  /** A wanted character (a warrant as a keg breach issues it: the account's next offence). */
  const wanted = (p: Player) => g.law.issue([{ characterId: p.characterId, role: 'breaker' }], 'N1', false, h.now)[0]!
  /** A licensed Hunter on duty (GM path: no checks). */
  const onDuty = (p: Player) => {
    g.hunters.gm(p.name, 'licence', undefined, h.now)
    expect(g.hunters.gm(p.name, 'duty', 'on', h.now).ok).toBe(true)
  }
  const attack = (a: { p: Player; inbox: ServerMessage[] }, t: Player) => {
    h.req(a.p, { t: 'attack', target: t.id })
    return h.result(a.inbox, 'attack')
  }
  /** Relog: out of the world and back in (the connection's order: remove, then forget). */
  const relog = (r: { p: Player }, pos: Vec3 = [0, 0, 0]) => {
    h.world.remove(r.p.id, h.now)
    g.forget(r.p)
    const back = h.hero({ pos, characterId: r.p.characterId })
    back.p.maxHp = back.p.hp = 5000
    return back
  }
  const accountOf = (p: Player) => h.store.characterById(p.characterId)!.account_id
  const posOf = (p: Player) => h.world.positionAt(p, h.now)
  return { h, g, data, tick, jump, char, gold, give, goldOf, slotOf, wanted, onDuty, attack, relog, accountOf, posOf }
}

// ---- pure rules -------------------------------------------------------------------------------------------------------------

describe('the PvP rule (§8.3), exhaustively', () => {
  const side = (o: Partial<PvpSide> = {}): PvpSide => ({ hunter: false, wanted: false, jailed: false, pardoned: false, inStockade: false, ...o })
  it('an on-duty Hunter and a Wanted fight each other; nobody else; never associates, the jailed, the pardoned, the stockade', () => {
    const flags = ['hunter', 'wanted', 'jailed', 'pardoned', 'inStockade'] as const
    let allowed = 0
    for (let a = 0; a < 32; a++) {
      for (let b = 0; b < 32; b++) {
        for (const assoc of [false, true]) {
          const sa = side(Object.fromEntries(flags.map((f, i) => [f, !!(a & (1 << i))])))
          const sb = side(Object.fromEntries(flags.map((f, i) => [f, !!(b & (1 << i))])))
          const want = !assoc && !sa.jailed && !sb.jailed && !sa.inStockade && !sb.inStockade && ((sa.hunter && sb.wanted && !sb.pardoned) || (sa.wanted && sb.hunter && !sa.pardoned))
          expect(pvpAllowed(sa, sb, assoc), JSON.stringify({ sa, sb, assoc })).toBe(want)
          if (want) allowed++
        }
      }
    }
    expect(allowed).toBeGreaterThan(0)
    expect(pvpAllowed(side({ hunter: true }), side({ wanted: true }), false)).toBe(true)
    expect(pvpAllowed(side({ wanted: true }), side({ hunter: true }), false)).toBe(true)
    expect(pvpAllowed(side(), side({ wanted: true }), false)).toBe(false)
    expect(pvpAllowed(side({ wanted: true }), side(), false)).toBe(false)
    expect(pvpAllowed(side({ hunter: true }), side({ hunter: true }), false)).toBe(false)
  })
})

describe('ranks, shares, the jail clock, settings', () => {
  it('ranks 1-5 at 1, 3, 10, 25, 60 captures (0: a recruit)', () => {
    expect([0, 1, 2, 3, 9, 10, 24, 25, 59, 60, 500].map(hunterRank)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
  })
  it('shares: damage in the last 90 s, ≥ 10 % of max HP; the capturing Hunter always counts', () => {
    const T = 1_000_000
    const hits = [
      { characterId: 1, damage: 300, at: T - 10_000 },
      { characterId: 2, damage: 100, at: T - 5000 },
      { characterId: 3, damage: 50, at: T - 1000 },
      { characterId: 2, damage: 900, at: T - 100_000 },
    ]
    expect(captureShares(hits, 1000, T, 90_000, 10, 1)).toEqual([{ characterId: 1, share: 300 }, { characterId: 2, share: 100 }])
    expect(captureShares(hits, 1000, T, 90_000, 10, 3)).toEqual([{ characterId: 1, share: 300 }, { characterId: 2, share: 100 }, { characterId: 3, share: 50 }])
    expect(captureShares([], 1000, T, 90_000, 10, 9)).toEqual([{ characterId: 9, share: 1 }])
  })
  it('the clock: real time runs from the start; online time counts the served time; chores −1 min each, ≤ 25 %', () => {
    const t = { startsAt: 0, endsAt: 2 * HOUR, servedMs: 10 * MIN, chores: 0 }
    expect(jailLeftMs(t, 30 * MIN, 'real', LAW)).toBe(90 * MIN)
    expect(jailLeftMs(t, 30 * MIN, 'online', LAW)).toBe(110 * MIN)
    expect(choreCreditMs({ ...t, chores: 5 }, LAW)).toBe(5 * MIN)
    expect(choreCreditMs({ ...t, chores: 500 }, LAW)).toBe(30 * MIN)
    expect(choresLeft({ ...t, chores: 28 }, LAW)).toBe(2)
    expect(jailLeftMs({ ...t, chores: 10 }, 30 * MIN, 'real', LAW)).toBe(80 * MIN)
  })
  it('the layer-6 defaults of §11.2 and their checks (the clock is a choice)', () => {
    expect(SIEGE_EVENT_DEFAULTS.law).toMatchObject({ sentenceClock: 'real', choresCapPct: 25, pardonMin: 10, pairCooldownDays: 7 })
    expect(SIEGE_EVENT_DEFAULTS.hunter).toMatchObject({ minLevel: 15, licenceGold: 10_000, cleanDays: 30, offDutyLockMin: 2, pingSec: 60, pingR: 80, senseM: 120, pvpMul: 0.5 })
    expect(checkSiegeEventSettings({ law: { sentenceClock: 'online', pardonMin: 5 }, hunter: { pvpMul: 0.25 } })).toEqual([])
    expect(checkSiegeEventSettings({ law: { sentenceClock: 'never' }, hunter: { pvpMul: 9 } }).map((i) => i.path)).toEqual(['law.sentenceClock', 'hunter.pvpMul'])
  })
})

// ---- Hunters ---------------------------------------------------------------------------------------------------------------

describe('the licence and duty (§8.2)', () => {
  it('Captain Yun: level 15, 10,000 gold, not Wanted, 30 clean days; the badge goes on and off with duty', () => {
    const x = harness()
    const yun = x.g.placeNpc({ ...yunNpc('jangan'), x: 0, z: 3 }, x.h.now)!
    const low = x.char([0, 0, 1], { level: 12 })
    x.gold(low.p, 50_000)
    x.h.req(low.p, { t: 'hunterLicence', npc: yun.id })
    expect(x.h.result(low.inbox, 'hunterLicence')).toMatchObject({ ok: false, reason: 'requirements' })
    const poor = x.char([1, 0, 1])
    x.h.req(poor.p, { t: 'hunterLicence', npc: yun.id })
    expect(x.h.result(poor.inbox, 'hunterLicence')).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    const crook = x.char([-1, 0, 1])
    x.gold(crook.p, 50_000)
    x.wanted(crook.p)
    x.h.req(crook.p, { t: 'hunterLicence', npc: yun.id })
    expect(x.h.result(crook.inbox, 'hunterLicence')).toMatchObject({ ok: false, reason: 'not_usable' })
    // the Wanted's alt: the account broke the law within 30 days
    const alt = x.char([-2, 0, 1], { alt: crook.p })
    x.gold(alt.p, 50_000)
    x.h.req(alt.p, { t: 'hunterLicence', npc: yun.id })
    expect(x.h.result(alt.inbox, 'hunterLicence')).toMatchObject({ ok: false, reason: 'requirements' })

    const a = x.char([0, 0, 1], { name: 'Yuna' })
    x.gold(a.p, 50_000)
    x.h.req(a.p, { t: 'hunterLicence', npc: yun.id })
    expect(x.h.result(a.inbox, 'hunterLicence')).toMatchObject({ ok: true })
    expect(x.goldOf(a.p)).toBe(40_000 + 0 + (x.goldOf(a.p) - 40_000))
    expect(x.h.all(a.inbox, 'lawState').at(-1)?.hunter).toEqual({ licensed: true, onDuty: false, rank: 0, captures: 0 })
    x.h.req(a.p, { t: 'hunterLicence', npc: yun.id })
    expect(x.h.result(a.inbox, 'hunterLicence')).toMatchObject({ ok: false, reason: 'not_usable' })
    // duty: in the safe area, out of combat
    const o = x.char([2, 0, 0])
    x.h.req(a.p, { t: 'hunterDuty', on: true })
    expect(x.h.result(a.inbox, 'hunterDuty')).toMatchObject({ ok: true })
    expect(x.h.world.state(a.p).hunter).toBe(0)
    expect(x.h.all(o.inbox, 'entityUpdate').some((u) => u.id === a.p.id && u.hunter === 0)).toBe(true)
    x.h.req(a.p, { t: 'hunterDuty', on: false })
    expect(x.h.result(a.inbox, 'hunterDuty')).toMatchObject({ ok: true })
    expect(x.h.world.state(a.p).hunter).toBeUndefined()
    expect(x.h.all(o.inbox, 'entityUpdate').at(-1)).toMatchObject({ id: a.p.id, hunter: -1 })
    // outside a safe area; in combat
    x.h.world.warp(a.p, 200, 0, 0, x.h.now)
    x.h.req(a.p, { t: 'hunterDuty', on: true })
    expect(x.h.result(a.inbox, 'hunterDuty')).toMatchObject({ ok: false, reason: 'wrong_place' })
    x.h.world.warp(a.p, 0, 0, 1, x.h.now)
    a.p.lastCombatAt = x.h.now - 1000
    x.h.req(a.p, { t: 'hunterDuty', on: true })
    expect(x.h.result(a.inbox, 'hunterDuty')).toMatchObject({ ok: false, reason: 'in_combat' })
    // no licence
    x.h.req(o.p, { t: 'hunterDuty', on: true })
    expect(x.h.result(o.inbox, 'hunterDuty')).toMatchObject({ ok: false, reason: 'not_hunter' })
  })

  it('the licence costs 10,000 gold; off duty is refused for 2 min after a PvP hit', () => {
    const x = harness()
    const yun = x.g.placeNpc({ ...yunNpc('jangan'), x: 0, z: 3 }, x.h.now)!
    const a = x.char([0, 0, 1], { name: 'Hana' })
    x.gold(a.p, 15_000)
    const g0 = x.goldOf(a.p)
    x.h.req(a.p, { t: 'hunterLicence', npc: yun.id })
    expect(g0 - x.goldOf(a.p)).toBe(10_000)
    x.h.req(a.p, { t: 'hunterDuty', on: true })
    const w = x.char([1.5, 0, 1], { name: 'Crook' })
    x.wanted(w.p)
    expect(x.attack(a, w.p)).toMatchObject({ ok: true })
    x.tick(3000)
    x.h.req(a.p, { t: 'stopAction' })
    x.h.req(a.p, { t: 'hunterDuty', on: false })
    expect(x.h.result(a.inbox, 'hunterDuty')).toMatchObject({ ok: false, reason: 'in_combat' })
    x.jump(2 * MIN + 1000)
    x.h.req(a.p, { t: 'hunterDuty', on: false })
    expect(x.h.result(a.inbox, 'hunterDuty')).toMatchObject({ ok: true })
  })
})

describe('PvP gating (§8.3, §8.6)', () => {
  it('only an on-duty Hunter attacks a Wanted (and the Wanted the Hunter), even in the safe area', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Crook' })
    const hunter = x.char([1, 0, 0], { name: 'Hunter' })
    const stranger = x.char([0, 0, 1], { name: 'Stranger' })
    const offduty = x.char([1, 0, 1], { name: 'Off' })
    x.wanted(w.p)
    x.g.hunters.gm('Off', 'licence', undefined, x.h.now)
    expect(x.attack(stranger, w.p)).toMatchObject({ ok: false, reason: 'not_hunter' })
    expect(x.attack(offduty, w.p)).toMatchObject({ ok: false, reason: 'not_hunter' })
    expect(x.attack(stranger, hunter.p)).toMatchObject({ ok: false, reason: 'invalid_target', message: 'no PvP' })
    x.onDuty(hunter.p)
    // the safe area (the whole test town) does not protect the Wanted
    expect(x.g.data.inSafeArea('jangan', 0, 0)).toBe(true)
    expect(x.attack(hunter, w.p)).toMatchObject({ ok: true })
    expect(x.attack(w, hunter.p)).toMatchObject({ ok: true })
    // a Hunter on a non-Wanted, the Wanted on a stranger
    expect(x.attack(hunter, stranger.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(x.attack(w, stranger.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
  })

  it('associates may not fight: the same party, the same account; never in the stockade', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Crook' })
    const friend = x.char([1, 0, 0], { name: 'Friend' })
    const alt = x.char([0, 0, 1], { alt: w.p, name: 'CrookAlt' })
    x.wanted(w.p)
    x.onDuty(friend.p)
    x.onDuty(alt.p)
    expect(x.attack(alt, w.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
    x.h.req(w.p, { t: 'partyInvite', target: friend.p.id })
    x.h.req(friend.p, { t: 'partyRespond', inviter: w.p.id, accept: true })
    expect(x.g.party.sameParty(w.p, friend.p)).toBe(true)
    expect(x.attack(friend, w.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
    // the stockade is no battlefield
    const h2 = x.char([STOCKADE.cell.x + 1, 0, STOCKADE.cell.z], { name: 'H2' })
    x.onDuty(h2.p)
    x.h.world.warp(w.p, STOCKADE.cell.x, 0, STOCKADE.cell.z, x.h.now)
    expect(x.attack(h2, w.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
  })

  it('single-target skills follow the same rule; areas never touch players', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Crook' })
    const hunter = x.char([1, 0, 0], { name: 'Hunter' })
    const stranger = x.char([0, 0, 1])
    x.wanted(w.p)
    const code = 'SKILL_CH_SWORD_SMASH_A_01'
    x.h.learn(stranger.p, [code])
    x.h.learn(hunter.p, [code])
    x.h.req(stranger.p, { t: 'useSkill', skill: code, target: w.p.id })
    expect(x.h.result(stranger.inbox, 'useSkill')).toMatchObject({ ok: false, reason: 'not_hunter' })
    x.onDuty(hunter.p)
    const hp0 = w.p.hp
    x.h.req(hunter.p, { t: 'useSkill', skill: code, target: w.p.id })
    expect(x.h.result(hunter.inbox, 'useSkill')).toMatchObject({ ok: true })
    x.tick(3000)
    expect(w.p.hp).toBeLessThan(hp0)
    expect(x.h.all(stranger.inbox, 'combat').some((c) => c.target === stranger.p.id)).toBe(false)
  })

  it('damage between players is × pvpMul (0.5)', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Crook' })
    const hunter = x.char([1, 0, 0], { name: 'Hunter' })
    x.wanted(w.p)
    x.onDuty(hunter.p)
    const pct = x.g.skills.basicFor(hunter.p).pct
    const raw = rollSkillHit(hunter.p.combat, w.p.combat, { pct }, () => 0.5)
    expect(x.attack(hunter, w.p)).toMatchObject({ ok: true })
    x.tick(2000)
    const hit = x.h.all(w.inbox, 'combat').find((c) => c.attacker === hunter.p.id && c.target === w.p.id)!
    expect(hit.hits[0]!.damage).toBe(Math.max(1, Math.round(raw.damage * 0.5)))
  })
})

// ---- capture ---------------------------------------------------------------------------------------------------------------

describe('capture (§8.4)', () => {
  it('a Hunter brings a Wanted to 0 HP: subdued at 1 HP, then caught, paid by the server, jailed in the Stockade', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Crook' })
    const hunter = x.char([1, 0, 0], { name: 'Hunter' })
    const o = x.char([2, 0, 2], { name: 'Watcher' })
    x.wanted(w.p)
    x.onDuty(hunter.p)
    const before = x.goldOf(hunter.p)
    w.p.hp = 3
    w.p.lastCombatAt = x.h.now
    expect(x.attack(hunter, w.p)).toMatchObject({ ok: true })
    x.tick(2000)
    expect(w.p.hp).toBe(1)
    expect(w.p.dead).toBe(false)
    expect(x.g.hunters.isSubdued(w.p)).toBe(true)
    // the subdued can do nothing
    expect(x.attack(w, hunter.p)).toMatchObject({ ok: false })
    x.tick(3500)
    expect(x.g.hunters.isSubdued(w.p)).toBe(false)
    expect(x.g.law.isWanted(w.p.characterId)).toBe(false)
    expect(x.goldOf(hunter.p) - before).toBe(20_000)
    expect(x.h.all(hunter.inbox, 'lawCapture').at(-1)).toMatchObject({ name: 'Crook', bounty: 20_000, gold: 20_000, sentenceMs: 2 * HOUR })
    expect(x.h.all(w.inbox, 'lawCapture').at(-1)).toMatchObject({ name: 'Crook', prisoner: true, sentenceMs: 2 * HOUR, captors: ['Hunter'] })
    expect(x.h.all(o.inbox, 'lawNotice').at(-1)).toMatchObject({ event: 'captured', name: 'Crook', bounty: 20_000 })
    // in the Stockade: the label, the term, the HUD
    const [px, , pz] = x.posOf(w.p)
    expect(inStockade(px, pz)).toBe(true)
    expect(x.h.world.state(w.p).jailed).toBe(true)
    expect(x.g.jail.isJailed(w.p.characterId)).toBe(true)
    expect(x.h.all(w.inbox, 'lawState').at(-1)?.jail).toMatchObject({ leftMs: 2 * HOUR, sentenceMs: 2 * HOUR, offence: 1, chores: 0, choresLeft: 30, clock: 'real' })
    // the Hunter's capture counts: rank 1
    expect(x.h.all(hunter.inbox, 'lawState').at(-1)?.hunter).toMatchObject({ captures: 1, rank: 1, onDuty: true })
    expect(x.h.world.state(hunter.p).hunter).toBe(1)
    const row = x.h.store.db.prepare("SELECT status, captors FROM warrants WHERE character_id = ?").get(w.p.characterId) as { status: string; captors: string }
    expect(row.status).toBe('captured')
    expect(JSON.parse(row.captors)).toEqual([{ character: hunter.p.characterId, account: x.accountOf(hunter.p), gold: 20_000, credit: true }])
  })

  it('the bounty is shared by damage among the Hunters with ≥ 10 % of max HP; associates of the Wanted get nothing', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Crook' })
    const a = x.char([1, 0, 0], { name: 'A' })
    const b = x.char([-1, 0, 0], { name: 'B' })
    const tiny = x.char([0, 0, 1], { name: 'Tiny' })
    x.wanted(w.p)
    for (const p of [a.p, b.p, tiny.p]) x.onDuty(p)
    const g = { a: x.goldOf(a.p), b: x.goldOf(b.p), tiny: x.goldOf(tiny.p) }
    const now = x.h.now
    x.g.hunters.onPvpHit(a.p, w.p, 1500, now)
    x.g.hunters.onPvpHit(b.p, w.p, 500, now)
    x.g.hunters.onPvpHit(tiny.p, w.p, 100, now) // 2 % of 5000: under the floor
    x.g.hunters.subdue(a.p, w.p, now)
    x.tick(3500)
    expect(x.goldOf(a.p) - g.a).toBe(15_000)
    expect(x.goldOf(b.p) - g.b).toBe(5000)
    expect(x.goldOf(tiny.p) - g.tiny).toBe(0)
    // an associate of the next Wanted (same party) among the captors: nothing for them
    const w2 = x.char([5, 0, 0], { name: 'Crook2' })
    x.wanted(w2.p)
    x.h.req(w2.p, { t: 'partyInvite', target: b.p.id })
    x.h.req(b.p, { t: 'partyRespond', inviter: w2.p.id, accept: true })
    const r = x.g.law.capture(w2.p.characterId, [{ player: a.p, share: 1 }, { player: b.p, share: 1 }], x.h.now)!
    expect(r.paid.get(a.p.characterId)).toBe(20_000)
    expect(r.paid.has(b.p.characterId)).toBe(false)
  })

  it('the 7-day pair rule: the same Hunter account catching the same Wanted account again gets 0 gold and no capture', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Crook' })
    const hunter = x.char([1, 0, 0], { name: 'Hunter' })
    x.onDuty(hunter.p)
    const catchIt = () => {
      x.h.world.warp(w.p, 0, 0, 0, x.h.now)
      x.wanted(w.p)
      const before = x.goldOf(hunter.p)
      x.g.hunters.onPvpHit(hunter.p, w.p, 2000, x.h.now)
      x.g.hunters.subdue(hunter.p, w.p, x.h.now)
      x.tick(3500)
      x.g.jail.release(w.p.characterId, x.h.now, 'gm')
      return { gold: x.goldOf(hunter.p) - before, msg: x.h.all(hunter.inbox, 'lawCapture').at(-1)! }
    }
    expect(catchIt().gold).toBe(20_000)
    x.jump(3 * DAY)
    const second = catchIt()
    expect(second.gold).toBe(0)
    expect(second.msg).toMatchObject({ gold: 0, pair: true, rule: 'pair', uncounted: true, bounty: 40_000 })
    // no capture credit, no rank progress (the anti-collusion rule; the Wanted still went to jail)
    expect(x.g.hunters.viewOf(hunter.p, x.h.now)).toMatchObject({ captures: 1, rank: 1 })
    // an alt of the Hunter's account is the same pair
    const halt = x.char([1, 0, 1], { alt: hunter.p, name: 'HunterAlt' })
    x.onDuty(halt.p)
    x.h.world.warp(w.p, 0, 0, 0, x.h.now)
    x.wanted(w.p)
    x.g.hunters.onPvpHit(halt.p, w.p, 2000, x.h.now)
    x.g.hunters.subdue(halt.p, w.p, x.h.now)
    x.tick(3500)
    expect(x.h.all(halt.inbox, 'lawCapture').at(-1)).toMatchObject({ gold: 0, pair: true })
    x.g.jail.release(w.p.characterId, x.h.now, 'gm')
    // after 7 days the pair pays again
    x.jump(8 * DAY)
    expect(catchIt().gold).toBeGreaterThan(0)
  })

  it('a combat logout (within 30 s of a Hunter hit) is a capture on the spot; the term waits for the next login', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Runner' })
    const hunter = x.char([1, 0, 0], { name: 'Hunter' })
    x.wanted(w.p)
    x.onDuty(hunter.p)
    const before = x.goldOf(hunter.p)
    expect(x.attack(hunter, w.p)).toMatchObject({ ok: true })
    x.tick(2000)
    x.h.req(hunter.p, { t: 'stopAction' })
    x.tick(10_000)
    x.h.world.remove(w.p.id, x.h.now)
    x.g.forget(w.p)
    expect(x.g.law.isWanted(w.p.characterId)).toBe(false)
    expect(x.goldOf(hunter.p) - before).toBe(20_000)
    expect(x.g.jail.isJailed(w.p.characterId)).toBe(true)
    // the next login puts them in the cell
    const back = x.h.hero({ pos: [0, 0, 0], characterId: w.p.characterId })
    const [px, , pz] = x.posOf(back.p)
    expect(inStockade(px, pz)).toBe(true)
    expect(x.g.jail.entryPoint(w.p.characterId)).toMatchObject({ x: STOCKADE.cell.x, z: STOCKADE.cell.z })
  })

  it('a logout 31 s after the last hit is not a capture', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Runner' })
    const hunter = x.char([1, 0, 0], { name: 'Hunter' })
    x.wanted(w.p)
    x.onDuty(hunter.p)
    x.g.hunters.onPvpHit(hunter.p, w.p, 100, x.h.now)
    x.tick(31_000)
    x.h.world.remove(w.p.id, x.h.now)
    x.g.forget(w.p)
    expect(x.g.law.isWanted(w.p.characterId)).toBe(true)
    expect(x.g.jail.isJailed(w.p.characterId)).toBe(false)
  })
})

// ---- anti-collusion (the user's rules, docs/SIEGE.md §8.6) ---------------------------------------------------------------

describe('anti-collusion: friends cannot farm bounties, captures or ranks (§8.6)', () => {
  /** Wanted at offence `n` (the account's record set to n − 1 first). */
  const wantedAt = (x: ReturnType<typeof harness>, p: Player, n: number) => {
    x.h.store.db.prepare('INSERT INTO law_records (account_id, offences, last_offence_at) VALUES (?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET offences = excluded.offences, last_offence_at = excluded.last_offence_at').run(x.accountOf(p), n - 1, x.h.now)
    return x.wanted(p)
  }
  /** `hunter` subdues `w` (with a hit for the bounty share) and the capture runs; returns the gold and the message. */
  const catchBy = (x: ReturnType<typeof harness>, hunter: { p: Player; inbox: ServerMessage[] }, w: Player) => {
    const before = x.goldOf(hunter.p)
    x.g.hunters.onPvpHit(hunter.p, w, 2000, x.h.now)
    x.g.hunters.subdue(hunter.p, w, x.h.now)
    x.tick(3500)
    return { gold: x.goldOf(hunter.p) - before, msg: x.h.all(hunter.inbox, 'lawCapture').at(-1)! }
  }
  const flags = (x: ReturnType<typeof harness>) => x.h.store.db.prepare('SELECT rule, withheld, hunter_character AS hunter FROM law_flags ORDER BY id').all() as { rule: string; withheld: number; hunter: number }[]

  it('a bounty never beats the keg price: capped at 80 % of keg.gold (40,000)', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Crook' })
    expect(x.g.law.bountyCap()).toBe(40_000)
    expect(wantedAt(x, w.p, 4).bounty).toBe(40_000)
    expect(x.g.law.wantedOf(w.p.characterId)?.bounty).toBe(40_000)
  })

  it('recent contacts claim nothing and get no capture: a trade or a stall sale (social_log) or a party within 7 days; the Wanted is jailed anyway', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Crook' })
    const trader = x.char([1, 0, 0], { name: 'Trader' })
    const partner = x.char([2, 0, 0], { name: 'Partner' })
    for (const p of [trader.p, partner.p]) x.onDuty(p)
    logSocial(x.h.store, { kind: 'trade', aChar: trader.p.characterId, bChar: w.p.characterId, aGold: 1, bGold: 0, aItems: [], bItems: [] }, x.h.now - 2 * DAY)
    // a party, left again (no longer an associate, still a contact)
    x.h.req(partner.p, { t: 'partyInvite', target: w.p.id })
    x.h.req(w.p, { t: 'partyRespond', inviter: partner.p.id, accept: true })
    x.h.req(w.p, { t: 'partyLeave' })
    expect(x.g.party.sameParty(w.p, partner.p)).toBe(false)
    expect(x.g.law.store.contactSince(x.accountOf(partner.p), x.accountOf(w.p), x.h.now - DAY)).toBe('party')
    x.wanted(w.p)
    const r1 = catchBy(x, trader, w.p)
    expect(r1.gold).toBe(0)
    expect(r1.msg).toMatchObject({ rule: 'contact', uncounted: true })
    expect(x.g.hunters.viewOf(trader.p, x.h.now)).toMatchObject({ captures: 0 })
    // the offence is real: jailed anyway, the warrant closed
    expect(x.g.jail.jailedNow(w.p)).toBe(true)
    expect(x.g.law.isWanted(w.p.characterId)).toBe(false)
    x.g.jail.release(w.p.characterId, x.h.now, 'gm')
    x.h.world.warp(w.p, 0, 0, 0, x.h.now)
    x.jump(11 * MIN)
    x.wanted(w.p)
    expect(catchBy(x, partner, w.p)).toMatchObject({ gold: 0, msg: { rule: 'contact' } })
    expect(flags(x).map((f) => f.rule)).toEqual(['contact', 'contact'])
    // a week later the trade no longer counts
    x.g.jail.release(w.p.characterId, x.h.now, 'gm')
    x.h.world.warp(w.p, 0, 0, 0, x.h.now)
    x.jump(8 * DAY)
    x.wanted(w.p)
    expect(catchBy(x, trader, w.p).gold).toBeGreaterThan(0)
  })

  it('a Wanted caught again within 7 days pays 50 % less per earlier capture; from the 3rd earlier capture nothing, no credit', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Crook' })
    const hs = [1, 2, 3, 4].map((i) => x.char([i, 0, 0], { name: `H${i}` }))
    for (const h of hs) x.onDuty(h.p)
    const got: { gold: number; rule?: string; uncounted?: true }[] = []
    for (const h of hs) {
      x.h.world.warp(w.p, 0, 0, 0, x.h.now)
      wantedAt(x, w.p, 4) // 40,000 every time (the cap)
      const r = catchBy(x, h, w.p)
      got.push({ gold: r.gold, ...(r.msg.rule ? { rule: r.msg.rule } : {}), ...(r.msg.uncounted ? { uncounted: true as const } : {}) })
      x.g.jail.release(w.p.characterId, x.h.now, 'gm')
      x.jump(HOUR)
    }
    expect(got).toEqual([{ gold: 40_000 }, { gold: 20_000, rule: 'repeat' }, { gold: 10_000, rule: 'repeat' }, { gold: 0, rule: 'repeat', uncounted: true }])
    expect(x.g.hunters.viewOf(hs[3]!.p, x.h.now)).toMatchObject({ captures: 0 })
    expect(x.g.hunters.viewOf(hs[2]!.p, x.h.now)).toMatchObject({ captures: 1 })
  })

  it('a Hunter account earns at most 60,000 gold of bounties in 24 h', () => {
    const x = harness()
    const hunter = x.char([1, 0, 0], { name: 'Hunter' })
    x.onDuty(hunter.p)
    const gold: number[] = []
    for (let i = 0; i < 3; i++) {
      const w = x.char([0, 0, i], { name: `Crook${i}` })
      wantedAt(x, w.p, 4)
      gold.push(catchBy(x, hunter, w.p).gold)
    }
    expect(gold).toEqual([40_000, 20_000, 0])
    expect(x.h.all(hunter.inbox, 'lawCapture').at(-1)).toMatchObject({ rule: 'daily_cap', gold: 0 })
    expect(x.g.hunters.viewOf(hunter.p, x.h.now)).toMatchObject({ captures: 3 })
    expect(flags(x).map((f) => [f.rule, f.withheld])).toEqual([['daily_cap', 20_000], ['daily_cap', 40_000]])
    x.jump(DAY + MIN)
    const w = x.char([0, 0, 5], { name: 'Crook9' })
    wantedAt(x, w.p, 1)
    expect(catchBy(x, hunter, w.p).gold).toBe(20_000)
  })

  it('withheld rewards show in the admin Law tab (suspected collusion)', async () => {
    const x = harness()
    x.tick(100)
    const w = x.char([0, 0, 0], { name: 'Crook' })
    const hunter = x.char([1, 0, 0], { name: 'Pal' })
    x.onDuty(hunter.p)
    logSocial(x.h.store, { kind: 'stall', aChar: hunter.p.characterId, bChar: w.p.characterId, aGold: 100, bGold: 0, aItems: [], bItems: [] }, x.h.now)
    x.wanted(w.p)
    catchBy(x, hunter, w.p)
    const ctx = { gameplay: x.g, world: x.h.world, data: x.h.data, store: x.h.store, config: x.h.config } as unknown as GameContext
    const v = lawView(ctx, x.h.now)
    expect(v.flags).toEqual([expect.objectContaining({ hunter: 'Pal', wanted: 'Crook', rule: 'contact', withheld: 20_000 })])
  })
})

// ---- the jail ----------------------------------------------------------------------------------------------------------------

describe('the Garrison Stockade (§8.5)', () => {
  const jailed = (x: ReturnType<typeof harness>, name = 'Con') => {
    const c = x.char([0, 0, 0], { name })
    x.wanted(c.p)
    const r = x.g.law.gm(null, ['capture', name], x.h.now)
    expect(r.ok, r.message).toBe(true)
    x.tick(50)
    return c
  }

  it('refusals: attack, skills, a return scroll, shops, Hunter duty, kegs; potions, chat and party are fine', () => {
    const x = harness()
    const c = jailed(x)
    const m = x.h.dummy(STOCKADE.cell.x + 2, STOCKADE.cell.z)
    x.h.req(c.p, { t: 'attack', target: m.id })
    expect(x.h.result(c.inbox, 'attack')).toMatchObject({ ok: false, reason: 'jailed' })
    x.give(c.p, SCROLL.code)
    x.h.req(c.p, { t: 'itemUse', bag: x.slotOf(c.p, SCROLL.code) })
    expect(x.h.result(c.inbox, 'itemUse')).toMatchObject({ ok: false, reason: 'jailed' })
    x.give(c.p, POTION.code)
    x.g.setVitals(c.p, 100, c.p.mp)
    x.h.req(c.p, { t: 'itemUse', bag: x.slotOf(c.p, POTION.code) })
    expect(x.h.result(c.inbox, 'itemUse')).toMatchObject({ ok: true })
    x.h.req(c.p, { t: 'shopBuy', npc: 1, code: 'X', count: 1 } as never)
    expect(x.h.result(c.inbox, 'shopBuy')).toMatchObject({ ok: false, reason: 'jailed' })
    x.g.hunters.gm('Con', 'licence', undefined, x.h.now)
    x.h.req(c.p, { t: 'hunterDuty', on: true })
    expect(x.h.result(c.inbox, 'hunterDuty')).toMatchObject({ ok: false, reason: 'jailed' })
    x.give(c.p, LAW_CODES.keg)
    x.h.req(c.p, { t: 'itemUse', bag: x.slotOf(c.p, LAW_CODES.keg) })
    expect(x.h.result(c.inbox, 'itemUse')).toMatchObject({ ok: false, reason: 'jailed' })
    x.h.req(c.p, { t: 'jump' } as never)
    expect(x.h.result(c.inbox, 'jump')).toMatchObject({ ok: false, reason: 'jailed' })
    x.h.req(c.p, { t: 'sit' } as never)
    expect(x.h.result(c.inbox, 'sit')?.reason).not.toBe('jailed')
  })

  it('moves are clamped inside; an escape is put back; a relog and a restart keep the term', () => {
    const x = harness()
    const c = jailed(x)
    expect(x.g.jail.clampMove(c.p, 0, 0)).toEqual([STOCKADE.x1 - 1, STOCKADE.z1 - 1])
    expect(x.g.jail.clampMove(c.p, -150, -310)).toEqual([-150, -310])
    const free = x.char([1, 0, 1])
    expect(x.g.jail.clampMove(free.p, 0, 0)).toEqual([0, 0])
    // an escape (a GM warp, a knock-back): back in the cell at the next tick
    x.h.world.warp(c.p, 0, 0, 0, x.h.now)
    x.tick(100)
    let [px, , pz] = x.posOf(c.p)
    expect(inStockade(px, pz)).toBe(true)
    // a relog somewhere else: back in the cell
    x.tick(10 * MIN)
    const back = x.relog(c, [50, 0, 50])
    ;[px, , pz] = x.posOf(back.p)
    expect(inStockade(px, pz)).toBe(true)
    expect(x.h.world.state(back.p).jailed).toBe(true)
    expect(x.h.all(back.inbox, 'lawState').at(-1)?.jail?.leftMs).toBeCloseTo(110 * MIN, -4)
    // a restart: a new jail service over the same database
    const jail2 = new JailService(x.g)
    jail2.enter(back.p, x.h.now)
    expect(jail2.jailedNow(back.p)).toBe(true)
    expect(jail2.viewOf(back.p, x.h.now)?.leftMs).toBeCloseTo(110 * MIN, -4)
  })

  it('sentences double per offence: 2 h, then 4 h; the real clock runs offline; release with a pardon', () => {
    const x = harness()
    const c = jailed(x)
    const o = x.char([0, 0, 0], { name: 'Hunter' })
    x.onDuty(o.p)
    expect(x.g.jail.list(x.h.now)[0]).toMatchObject({ name: 'Con' })
    expect(x.g.jail.list(x.h.now)[0]!.leftMs).toBeCloseTo(2 * HOUR, -3)
    // offline for the whole sentence: served (real time)
    x.h.world.remove(c.p.id, x.h.now)
    x.g.forget(c.p)
    x.jump(2 * HOUR + MIN)
    expect(x.g.jail.entryPoint(c.p.characterId)).toMatchObject({ x: STOCKADE.release.x, z: STOCKADE.release.z })
    const back = x.h.hero({ pos: [STOCKADE.release.x, 0, STOCKADE.release.z], characterId: c.p.characterId })
    expect(x.g.jail.isJailed(c.p.characterId)).toBe(false)
    expect(x.h.all(back.inbox, 'chat').some((m) => /served your sentence/.test(m.text))).toBe(true)
    // the pardon: no Hunter target for 10 min
    x.wanted(back.p)
    x.h.world.warp(o.p, STOCKADE.release.x + 1, 0, STOCKADE.release.z, x.h.now)
    expect(x.attack(o, back.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
    x.jump(11 * MIN)
    // the second offence: 4 h
    const r = x.g.law.gm(null, ['capture', 'Con'], x.h.now)
    expect(r.data).toMatchObject({ sentenceMs: 4 * HOUR })
    expect(x.g.jail.list(x.h.now)[0]).toMatchObject({ leftMs: 4 * HOUR })
  })

  it('the online clock does not run offline; served online, the release opens the gate', () => {
    const x = harness()
    expect(saveSiegeSettings(x.g.siege, x.g.siege.rev, { law: { sentenceClock: 'online' } }, null, x.h.now)).toMatchObject({ ok: true })
    const c = jailed(x)
    x.h.world.remove(c.p.id, x.h.now)
    x.g.forget(c.p)
    x.jump(5 * HOUR)
    expect(x.g.jail.isJailed(c.p.characterId)).toBe(true)
    const back = x.h.hero({ pos: [0, 0, 0], characterId: c.p.characterId })
    expect(x.h.all(back.inbox, 'lawState').at(-1)?.jail).toMatchObject({ clock: 'online' })
    expect(x.h.all(back.inbox, 'lawState').at(-1)!.jail!.leftMs).toBeCloseTo(2 * HOUR, -3)
    x.jump(HOUR)
    x.tick(100)
    expect(x.g.jail.viewOf(back.p, x.h.now)?.leftMs).toBeCloseTo(HOUR, -4)
    x.jump(HOUR)
    x.tick(100)
    expect(x.g.jail.jailedNow(back.p)).toBe(false)
    const [px, , pz] = x.posOf(back.p)
    expect([px, pz]).toEqual([STOCKADE.release.x, STOCKADE.release.z])
    expect(x.h.world.state(back.p).jailed).toBeUndefined()
  })

  it('chores at the rock pile: 10 s, −1 min each, broken by moving, at most 25 % of the sentence', () => {
    const x = harness()
    const c = jailed(x)
    x.h.req(c.p, { t: 'jailChore' })
    expect(x.h.result(c.inbox, 'jailChore')).toMatchObject({ ok: false, reason: 'too_far' })
    x.h.world.warp(c.p, STOCKADE.pile.x, 0, STOCKADE.pile.z + 1, x.h.now)
    x.h.req(c.p, { t: 'jailChore' })
    expect(x.h.result(c.inbox, 'jailChore')).toMatchObject({ ok: true })
    expect(x.h.all(c.inbox, 'lawState').at(-1)?.jail?.choreEndsAt).toBe(x.h.now + 10_000)
    x.tick(10_100)
    const v = x.g.jail.viewOf(c.p, x.h.now)!
    expect(v.chores).toBe(1)
    expect(v.leftMs).toBeCloseTo(2 * HOUR - 10_100 - MIN, -3)
    // moving breaks it
    x.h.req(c.p, { t: 'jailChore' })
    x.h.world.moveTo(c.p, STOCKADE.pile.x + 3, STOCKADE.pile.z + 1)
    x.g.jail.moved(c.p, x.h.now)
    x.tick(10_100)
    expect(x.g.jail.viewOf(c.p, x.h.now)!.chores).toBe(1)
    // the cap: 30 chores on a 2 h sentence (written while logged out)
    x.h.world.remove(c.p.id, x.h.now)
    x.g.forget(c.p)
    x.h.store.db.prepare('UPDATE jail_terms SET chores = 30').run()
    const back = x.h.hero({ pos: [STOCKADE.pile.x, 0, STOCKADE.pile.z + 1], characterId: c.p.characterId })
    x.h.world.warp(back.p, STOCKADE.pile.x, 0, STOCKADE.pile.z + 1, x.h.now)
    x.h.req(back.p, { t: 'jailChore' })
    expect(x.h.result(back.inbox, 'jailChore')).toMatchObject({ ok: false, reason: 'not_usable' })
  })
})

// ---- the rest of the job ------------------------------------------------------------------------------------------------------

describe("the Hunter's Net, pings, a Hunter who breaks a wall, kegs on duty", () => {
  it('the Net snares a Wanted within 12 m (a stun), one Net from the bag, a 60 s cooldown; on-duty Hunters only', () => {
    const x = harness()
    const w = x.char([0, 0, 0], { name: 'Crook' })
    const hunter = x.char([8, 0, 0], { name: 'Hunter' })
    x.wanted(w.p)
    x.h.req(hunter.p, { t: 'hunterNet', target: w.p.id })
    expect(x.h.result(hunter.inbox, 'hunterNet')).toMatchObject({ ok: false, reason: 'not_hunter' })
    x.onDuty(hunter.p)
    x.h.req(hunter.p, { t: 'hunterNet', target: w.p.id })
    expect(x.h.result(hunter.inbox, 'hunterNet')).toMatchObject({ ok: false, reason: 'not_usable' })
    x.give(hunter.p, HUNTER_CODES.net, 2)
    x.h.req(hunter.p, { t: 'hunterNet', target: w.p.id })
    expect(x.h.result(hunter.inbox, 'hunterNet')).toMatchObject({ ok: true })
    expect(x.h.all(w.inbox, 'effectAdd').at(-1)?.effect).toMatchObject({ status: 'stun' })
    x.h.req(hunter.p, { t: 'hunterNet', target: w.p.id })
    expect(x.h.result(hunter.inbox, 'hunterNet')).toMatchObject({ ok: false, reason: 'cooldown' })
    x.h.world.warp(hunter.p, 30, 0, 0, x.h.now)
    x.jump(61_000)
    x.h.req(hunter.p, { t: 'hunterNet', target: w.p.id })
    expect(x.h.result(hunter.inbox, 'hunterNet')).toMatchObject({ ok: false, reason: 'too_far' })
  })

  it('pings: every 60 s each on-duty Hunter gets a circle of 80 m around a point within 50 m of each Wanted', () => {
    const x = harness()
    const w = x.char([100, 0, 100], { name: 'Crook' })
    const hunter = x.char([0, 0, 0], { name: 'Hunter' })
    const off = x.char([1, 0, 0])
    x.wanted(w.p)
    x.onDuty(hunter.p)
    x.tick(61_000)
    const pings = x.h.all(hunter.inbox, 'wantedPing')
    expect(pings.length).toBeGreaterThanOrEqual(1)
    const p = pings.at(-1)!
    expect(p).toMatchObject({ id: w.p.id, name: 'Crook', r: 80 })
    expect(Math.hypot(p.x - 100, p.z - 100)).toBeLessThanOrEqual(50)
    expect(x.h.all(off.inbox, 'wantedPing')).toEqual([])
  })

  it('a Hunter whose keg breaches the wall loses the licence for 30 days; kegs are refused on duty', () => {
    const x = harness()
    const h = x.char([0, 0, 0], { name: 'Turncoat' })
    x.onDuty(h.p)
    x.give(h.p, LAW_CODES.keg)
    x.h.req(h.p, { t: 'itemUse', bag: x.slotOf(h.p, LAW_CODES.keg) })
    expect(x.h.result(h.inbox, 'itemUse')).toMatchObject({ ok: false, reason: 'not_usable' })
    x.g.law.kegBlast({ characterId: h.p.characterId, accountId: x.accountOf(h.p), name: 'Turncoat' }, 'N1', x.h.now, true)
    expect(x.g.law.isWanted(h.p.characterId)).toBe(true)
    expect(x.g.hunters.onDuty(h.p)).toBe(false)
    expect(x.g.hunters.licensed(h.p.characterId, x.h.now)).toBe(false)
    expect(x.g.hunters.licensed(h.p.characterId, x.h.now + 31 * DAY)).toBe(true)
    expect(x.h.all(h.inbox, 'lawState').at(-1)?.hunter).toMatchObject({ licensed: false })
  })
})

// ---- GM and admin ---------------------------------------------------------------------------------------------------------------

describe('GM law jail / release / hunter (§12)', () => {
  it('jails for minutes, lists, releases; licenses, puts on duty, revokes', () => {
    const x = harness()
    const c = x.char([0, 0, 0], { name: 'Loud' })
    const run = (...args: string[]) => x.g.law.gm(null, args, x.h.now)
    expect(run('jail', 'Loud', '30', 'spamming').ok).toBe(true)
    expect(x.g.jail.jailedNow(c.p)).toBe(true)
    expect(x.g.jail.list(x.h.now)[0]).toMatchObject({ name: 'Loud', leftMs: 30 * MIN })
    expect(run('jail').message).toMatch(/Loud: 30 min left/)
    expect(run('jail', 'Loud', 'x').ok).toBe(false)
    expect(run('release', 'Loud').ok).toBe(true)
    expect(x.g.jail.jailedNow(c.p)).toBe(false)
    expect(run('release', 'Loud').ok).toBe(false)
    expect(run('hunter', 'Loud', 'licence').ok).toBe(true)
    expect(run('hunter', 'Loud', 'duty', 'on').ok).toBe(true)
    expect(x.h.world.state(c.p).hunter).toBe(0)
    expect(run('hunter', 'Loud').message).toMatch(/rank 0, 0 captures, on duty/)
    expect(run('hunter', 'Loud', 'revoke').ok).toBe(true)
    expect(x.g.hunters.onDuty(c.p)).toBe(false)
    expect(run('hunter', 'Nobody', 'licence').ok).toBe(false)
  })
})

describe('the admin Law tab (§11.3)', () => {
  function admin() {
    const x = harness()
    const root = x.char([0, 0, 0], { name: 'Root' })
    const ctx = { gameplay: x.g, world: x.h.world, data: x.h.data, store: x.h.store, config: x.h.config } as unknown as GameContext
    const actor = { accountId: x.accountOf(root.p), role: 'admin' as const, username: 'root' }
    const call = async <T = Record<string, unknown>>(method: string, sub: string, body?: unknown, role: 'admin' | 'gm' = 'admin') =>
      (await routeAdminSiege(ctx, { method, path: `/api/admin/siege${sub}`, query: new URLSearchParams(''), body, actor: { ...actor, role } })) as { status: number; body: T }
    return { ...x, call }
  }

  it('admin only; GET lists the Wanted, the jailed, records, Hunters, recent warrants; pardon, jail, time, release, hunter, forgive', async () => {
    const x = admin()
    x.tick(100)
    const w = x.char([3, 0, 0], { name: 'Crook' })
    const hunter = x.char([4, 0, 0], { name: 'Hunter' })
    x.wanted(w.p)
    x.onDuty(hunter.p)
    expect((await x.call('GET', '/law', undefined, 'gm')).status).toBe(403)
    expect((await x.call('POST', '/law/jail', { character: 'Crook', minutes: 5 }, 'gm')).status).toBe(403)
    let v = (await x.call<AdminLawView>('GET', '/law')).body
    expect(v.clock).toBe('real')
    expect(v.wanted).toEqual([expect.objectContaining({ name: 'Crook', bounty: 20_000, offence: 1, role: 'breaker', online: true })])
    expect(v.hunters).toEqual([expect.objectContaining({ name: 'Hunter', onDuty: true, captures: 0, rank: 0 })])
    expect(v.records).toEqual([expect.objectContaining({ level: 1, recorded: 1, characters: ['Crook'] })])
    // pardon closes the warrant
    expect((await x.call('POST', '/law/pardon', { character: 'Crook' })).status).toBe(200)
    expect(x.g.law.isWanted(w.p.characterId)).toBe(false)
    expect((await x.call('POST', '/law/pardon', { character: 'Crook' })).status).toBe(409)
    // jail, add time, release
    expect((await x.call('POST', '/law/jail', { character: 'Crook', minutes: 0 })).status).toBe(400)
    expect((await x.call('POST', '/law/jail', { character: 'Nobody', minutes: 5 })).status).toBe(400)
    expect((await x.call('POST', '/law/jail', { character: 'Crook', minutes: 60, reason: 'test' })).status).toBe(200)
    expect((await x.call('POST', '/law/time', { character: 'Crook', minutes: 30 })).status).toBe(200)
    v = (await x.call<AdminLawView>('GET', '/law')).body
    expect(v.jailed).toEqual([expect.objectContaining({ name: 'Crook', leftMs: 90 * MIN, online: true })])
    expect((await x.call('POST', '/law/release', { character: w.p.characterId })).status).toBe(200)
    expect(x.g.jail.jailedNow(w.p)).toBe(false)
    // the Hunter: revoke, restore
    expect((await x.call('POST', '/law/hunter', { character: 'Hunter', action: 'fire' })).status).toBe(400)
    expect((await x.call('POST', '/law/hunter', { character: 'Hunter', action: 'revoke' })).status).toBe(200)
    expect(x.g.hunters.licensed(hunter.p.characterId, x.h.now)).toBe(false)
    expect((await x.call('POST', '/law/hunter', { character: 'Hunter', action: 'restore' })).status).toBe(200)
    expect(x.g.hunters.licensed(hunter.p.characterId, x.h.now)).toBe(true)
    // forgive the record
    expect((await x.call('POST', '/law/forgive', { character: 'Crook', all: true })).status).toBe(200)
    expect(x.g.law.offences(x.accountOf(w.p), x.h.now)).toBe(0)
    v = (await x.call<AdminLawView>('GET', '/law')).body
    expect(v.recent[0]).toMatchObject({ name: 'Crook', status: 'pardoned' })
    // every write is a gm_audit row
    const audits = x.h.store.db.prepare("SELECT args FROM gm_audit WHERE command = 'siege'").all() as { args: string }[]
    expect(audits.map((a) => JSON.parse(a.args)[0])).toEqual(expect.arrayContaining(['law-pardon', 'law-jail', 'law-time', 'law-release', 'law-hunter', 'law-forgive']))
  })
})

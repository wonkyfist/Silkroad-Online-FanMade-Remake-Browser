/**
 * The job system, layer 4 on the server: Thieves and the law (docs/JOBS.md §3.1, §6.1, §6.3, §6.4, §7, §9.5, §11).
 *
 * - the war: a Thief picks a robbed transport's bags (stolen goods, a robbery warrant: ROBBER, pings to Hunters), a
 *   Hunter subdues and captures him (confiscated, the robbery ladder 15 / 30 min, the recovery reward, job EXP); or he
 *   sells at the den (60 %, job EXP, the warrant closes `sold`), buys and uses the Bandit Den Return Scroll; the den's ring
 *   shelters him; the warrant lapses after 30 min online;
 * - Hunters recover bags and turn them in to Yun; the owner without a transport carries his own bags and sells them;
 *   deaths drop what is carried; Hunters' job EXP for killing Thieves; caravan pings; skills (single and area) on
 *   transports;
 * - abuse: associates and contacts cannot pick, the pair rule (full, half, nothing), no reward for the owner's
 *   associates, the suit / the job / return scrolls refused while carrying, the daily cap; GM `robbery`, admin sacks.
 */
import {
  JOB_SETTINGS_DEFAULTS,
  SIEGE_EVENT_DEFAULTS,
  denPayout,
  fenceNpc,
  hunterThiefExp,
  installSiegeHunterContent,
  installSiegeLawContent,
  recoveryReward,
  yunNpc,
  type AdminJobsView,
  type NpcDef,
  type ServerMessage,
  type Vec3,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { GameContext } from '../src/game.ts'
import { GameData } from '../src/gamedata.ts'
import { addGold, addItem } from '../src/inventory.ts'
import { routeAdminJobs } from '../src/jobs/jobs-admin.ts'
import type { KegWalls } from '../src/siege/keg.ts'
import type { Player } from '../src/world.ts'
import { item, mob } from './fixtures.ts'
import { DUMMY, SAFE_TOWN, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const MIN = 60_000
const S = JOB_SETTINGS_DEFAULTS
const LAW = SIEGE_EVENT_DEFAULTS.law

let cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const WALLS: KegWalls = { on: true, walls: { segments: [], sides: [] }, settings: { maxIp: 20_000 }, stageOf: () => 'intact', change: () => null }
const JODAESAN: NpcDef = { code: 'NPC_CH_SPECIAL', name: 'Specialty Trader Jodaesan', x: 176, z: -48, yaw: 0, world: 'jangan', model: null, provenance: 'client' }
const SEOPOK: NpcDef = { code: 'NPC_CH_SPECIAL2', name: 'Specialty Trader Seopok', x: -400, z: 300, yaw: 0, world: 'jangan', model: null, provenance: 'client' }
const FANG = { x: -300, z: -200 }
const YUN = { x: -60, z: -60 }
const SPOTS: Record<string, [number, number]> = { jangan: [0, 3], 'south-beach': [100, 420], 'tomb-camp': [420, -100], 'ferry-landing': [-420, 100], 'sea-cliffs': [-200, 420] }
const RETURN_NOW = item('ITEM_ETC_SCROLL_RETURN_NOW', { category: 'scroll', maxStack: 50, use: { returnToTown: true } })
const DEN_SCROLL = item('ITEM_ETC_SCROLL_RETURN_THIEFDEN_01', { category: 'scroll', maxStack: 50, price: 1000 })
const BANDIT = mob('MOB_CH_BANDIT', { name: 'Bandit', level: 16, hp: 800 })
const SILK = 'ITEM_ETC_TRADE_CH_01'
/** 10 crates bought → 6 drop (60 %) → the den pays 60 % of 800 each. */
const DEN6 = denPayout(800, 6, S.thief.denPct)
const REWARD6 = recoveryReward(DEN6, S.robbery.recoveryPct)

type Who = { p: Player; inbox: ServerMessage[] }

function harness() {
  const data = new GameData({ mobs: [BANDIT, DUMMY], items: [...SKILL_ITEMS, RETURN_NOW, DEN_SCROLL], levels: SKILL_LEVELS, npcs: [JODAESAN, SEOPOK], towns: [{ ...SAFE_TOWN, safeArea: { x: 0, z: 0, halfX: 80, halfZ: 80 } }] })
  installSiegeLawContent({ items: data.items, drops: data.drops, npcs: data.npcs }, 'jangan')
  installSiegeHunterContent({ items: data.items, shops: data.shops, npcs: data.npcs }, 'jangan')
  const h = skillHarness({ data, config: { uniques: false } })
  cleanups.push(h.cleanup)
  const g = h.gameplay
  g.kegs.configure({ walls: WALLS })
  g.jobs.configure({ content: { den: { ...g.jobs.content.den, x: SEOPOK.x, z: SEOPOK.z }, posts: g.jobs.content.posts.map((p) => ({ ...p, x: SPOTS[p.id]![0], z: SPOTS[p.id]![1] })) } })
  const tick = (ms: number) => h.runTo(h.now + ms)
  const jump = (ms: number) => {
    h.now = h.now + ms - 50
    h.runTo(h.now + 50)
  }
  const jod = g.placeNpc({ ...JODAESAN, x: 0, z: 3 }, h.now)!
  g.placeNpc({ ...fenceNpc('jangan'), ...FANG }, h.now)
  const seopok = g.placeNpc(SEOPOK, h.now)!
  const yun = g.placeNpc({ ...yunNpc('jangan'), ...YUN }, h.now)!
  const post: Record<string, NonNullable<ReturnType<typeof g.placeNpc>>> = { jangan: jod }
  for (const p of g.jobs.content.posts) {
    if (p.id === 'jangan') continue
    const def = data.npcs.find((n) => n.code === p.npc.code)!
    post[p.id] = g.placeNpc({ ...def, x: p.x, z: p.z }, h.now)!
  }
  const char = (pos: Vec3, o: { name?: string; weapon?: 'sword' | 'spear' } = {}): Who => {
    const r = h.hero({ pos, level: 20, ...(o.name ? { name: o.name } : {}), ...(o.weapon ? { weapon: o.weapon } : {}) })
    r.p.maxHp = r.p.hp = 50_000
    const { draft } = h.store.inventoryTx(r.p.characterId, (d) => addGold(d, 1_000_000))
    g.afterInventory(r.p, draft)
    return r
  }
  const goldOf = (p: Player) => h.store.loadInventory(p.characterId).gold
  const req = (r: Who, msg: Parameters<typeof h.req>[1]) => {
    h.req(r.p, msg)
    return h.result(r.inbox, msg.t)
  }
  const warp = (r: Who, x: number, z: number) => h.world.warp(r.p, x, 0, z, h.now)
  const job = (r: Who, j: 'trader' | 'thief' | 'hunter', level = 1) => {
    expect(g.jobs.gm([r.p.name, 'join', j], h.now).ok).toBe(true)
    if (level > 1) g.jobs.gm([r.p.name, 'level', String(level)], h.now)
    g.jobs.gm([r.p.name, 'mode', 'on'], h.now)
    return r
  }
  const trader = (name = 'Tess') => job(char([1, 0, 1], { name }), 'trader')
  const thief = (pos: Vec3, name = 'Thea', level = 1) => job(char(pos, { name }), 'thief', level)
  const hunter = (pos: Vec3, name = 'Hugo') => job(char(pos, { name }), 'hunter')
  /** A transport of `who` with `crates` of silk, killed on the road at (x, z): its bags lie there. */
  const robbed = (who: Who, crates = 10, x = 200, z = 0) => {
    warp(who, 1, -1)
    who.p.lastCombatAt = 0
    expect(req(who, { t: 'tradeSummon', npc: jod.id, tier: 1 })).toMatchObject({ ok: true })
    warp(who, 1, 1)
    expect(req(who, { t: 'tradeBuy', npc: jod.id, good: SILK, crates, dest: 'ferry-landing' })).toMatchObject({ ok: true })
    const t = g.transports.of(who.p.characterId)!
    warp(who, x + 2, z)
    t.c.pos = [x, 0, z]
    t.c.move = null
    h.world.refreshAround(t.c, h.now)
    g.transports.died(t, h.now)
    tick(1200)
    return [...g.transports.bags.values()].filter((b) => b.ownerChar === who.p.characterId)
  }
  const pick = (r: Who, id: number) => {
    const b = g.transports.bags.get(id)!
    warp(r, b.x + 1, b.z)
    tick(1200)
    return req(r, { t: 'bagPick', id })
  }
  const sack = (r: Who) => h.all(r.inbox, 'jobSack').at(-1)?.entries ?? []
  return { h, g, tick, jump, char, goldOf, req, warp, job, trader, thief, hunter, robbed, pick, sack, post, jod, seopok, yun }
}

describe('stolen goods and the robbery warrant (§6.3, §6.4)', () => {
  it('balance: an on-duty Bounty Hunter\'s hits on a robber are × robbery.hunterMul (not hunter.pvpMul); the robber\'s back × pvpMul', () => {
    const x = harness()
    const t = x.trader()
    const bags = x.robbed(t)
    const th = x.thief([205, 0, 5])
    const hu = x.hunter([206, 0, 5])
    expect(x.g.hunters.pvpDamage(100, hu.p, th.p)).toBe(Math.round(100 * SIEGE_EVENT_DEFAULTS.hunter.pvpMul))
    expect(x.pick(th, bags[0]!.id)).toMatchObject({ ok: true })
    const mul = JOB_SETTINGS_DEFAULTS.robbery.hunterMul
    expect(mul).toBeGreaterThan(SIEGE_EVENT_DEFAULTS.hunter.pvpMul)
    expect(x.g.hunters.pvpDamage(100, hu.p, th.p)).toBe(Math.round(100 * mul))
    expect(x.g.hunters.pvpDamage(100, th.p, hu.p)).toBe(Math.round(100 * SIEGE_EVENT_DEFAULTS.hunter.pvpMul))
    expect(x.g.hunters.pvpDamage(0, hu.p, th.p)).toBe(0)
    // through a real hit
    th.p.maxHp = th.p.hp = 10_000
    const hp = th.p.hp
    const r = x.g.dealHits(hu.p, th.p, [{ outcome: 'hit', damage: 40, hp: 0 }], {}, x.h.now)
    expect(r.dealt).toBe(Math.round(40 * mul))
    expect(th.p.hp).toBe(hp - Math.round(40 * mul))
    // live
    x.g.jobs.savePatch({ robbery: { hunterMul: 1 } }, null, x.h.now)
    expect(x.g.hunters.pvpDamage(100, hu.p, th.p)).toBe(100)
  })

  it('a Thief picks the bags: ROBBER, pings to Hunters; a Hunter subdues and captures him: confiscated, 15 min, the reward, job EXP; then 30 min', () => {
    const x = harness()
    const t = x.trader()
    const bags = x.robbed(t)
    expect(bags.map((b) => [b.good, b.crates])).toEqual([[SILK, 6]])
    const th = x.thief([205, 0, 5])
    const hu = x.hunter([220, 0, 0])
    expect(x.pick(th, bags[0]!.id)).toMatchObject({ ok: true })
    expect(x.g.transports.bags.size).toBe(0)
    expect(x.sack(th)).toEqual([{ kind: 'stolen', good: SILK, crates: 6, owner: 'Tess', value: DEN6 }])
    expect(x.g.law.robber(th.p.characterId)).toBe(true)
    expect(x.g.law.robberyOf(th.p.characterId)?.bounty).toBe(REWARD6)
    expect(x.h.world.state(th.p).robber).toBe(true)
    expect(x.h.world.state(th.p).wanted).toBeUndefined()
    expect(x.h.all(hu.inbox, 'entityUpdate').some((m) => m.id === th.p.id && m.robber === true)).toBe(true)
    expect(x.h.all(th.inbox, 'lawState').at(-1)?.wanted).toMatchObject({ bounty: REWARD6, robbery: true, offence: 1 })
    expect(x.g.market.store.recent(1)[0]).toMatchObject({ kind: 'stolen', crates: 6 })
    // the Hunter's ping marks a robber
    x.g.hunters.ping(x.h.now)
    expect(x.h.all(hu.inbox, 'wantedPing').at(-1)).toMatchObject({ id: th.p.id, robbery: true })
    // no suit off, no leaving, no return scroll with stolen goods
    expect(x.req(th, { t: 'jobMode', on: false })).toMatchObject({ ok: false, reason: 'not_usable' })
    // the capture
    th.p.maxHp = th.p.hp = 300
    hu.p.combat.physAttack = [5000, 5000]
    x.warp(hu, 206, 5)
    x.tick(200)
    const g0 = x.goldOf(hu.p)
    expect(x.req(hu, { t: 'attack', target: th.p.id })).toMatchObject({ ok: true })
    x.tick(3000)
    expect(x.g.hunters.isSubdued(th.p)).toBe(true)
    x.tick(LAW.subdueSec * 1000 + 500)
    expect(x.g.jail.jailedNow(th.p)).toBe(true)
    const cap = x.h.all(th.inbox, 'lawCapture').at(-1)!
    expect(cap).toMatchObject({ prisoner: true, sentenceMs: 15 * MIN, bounty: REWARD6 })
    expect(x.goldOf(hu.p) - g0).toBe(REWARD6)
    expect(x.g.jobs.view(hu.p, x.h.now).exp).toBe(hunterThiefExp(1, true, S.exp))
    expect(x.sack(th)).toEqual([])
    expect(x.g.law.robber(th.p.characterId)).toBe(false)
    expect(x.g.market.store.recent(1)[0]).toMatchObject({ kind: 'confiscated', crates: 6 })
    // no wall notice to the world for a robber
    expect(x.h.all(t.inbox, 'lawNotice').length).toBe(0)
    // jailed out of the suit
    expect(x.g.jobs.inMode(th.p.characterId)).toBe(false)
    // the ladder: the next capture is 30 min
    x.g.jail.release(th.p.characterId, x.h.now, 'gm')
    expect(x.g.robbery.gm(['Thea', 'give', SILK, '5'], x.h.now).ok).toBe(true)
    expect(x.g.law.gm(null, ['capture', 'Thea', 'Hugo'], x.h.now)).toMatchObject({ ok: true, data: { sentenceMs: 30 * MIN } })
  })

  it('the den: the Hunters may not touch a robber in its ring; Seopok pays 60 %, job EXP, the warrant closes; the scroll', () => {
    const x = harness()
    const t = x.trader()
    const bags = x.robbed(t)
    const th = x.thief([205, 0, 5])
    x.pick(th, bags[0]!.id)
    // return scrolls refused, the den scroll too
    const give = (code: typeof RETURN_NOW, n: number) => {
      const { draft } = x.h.store.inventoryTx(th.p.characterId, (d) => addItem(d, code, n))
      x.g.afterInventory(th.p, draft)
      return x.h.store.loadInventory(th.p.characterId).bag.findIndex((i) => i?.code === code.code)
    }
    th.p.lastCombatAt = 0
    expect(x.req(th, { t: 'itemUse', bag: give(RETURN_NOW, 1) })).toMatchObject({ ok: false, reason: 'loaded' })
    expect(x.req(th, { t: 'itemUse', bag: give(DEN_SCROLL, 1) })).toMatchObject({ ok: false, reason: 'loaded' })
    expect(x.req(th, { t: 'jobLeave', npc: x.seopok.id }).ok).toBe(false)
    // at the den: a Hunter cannot fight the robber inside the 12 m ring
    x.warp(th, x.seopok.pos[0] + 2, x.seopok.pos[2])
    const hu = x.hunter([x.seopok.pos[0] + 4, 0, x.seopok.pos[2]])
    x.tick(200)
    expect(x.req(hu, { t: 'attack', target: th.p.id })).toMatchObject({ ok: false, reason: 'safe_zone' })
    expect(x.g.hunters.allowed(hu.p, th.p, x.h.now)).toBe(false)
    // a non-Thief cannot sell there
    expect(x.req(hu, { t: 'denSell', npc: x.seopok.id })).toMatchObject({ ok: false, reason: 'requirements' })
    const g0 = x.goldOf(th.p)
    expect(x.req(th, { t: 'denSell', npc: x.seopok.id })).toMatchObject({ ok: true })
    expect(x.goldOf(th.p) - g0).toBe(DEN6)
    expect(x.g.jobs.view(th.p, x.h.now).exp).toBe(Math.floor(DEN6 / S.exp.thiefDenDiv))
    expect(x.g.law.robber(th.p.characterId)).toBe(false)
    expect(x.g.law.store.ofCharacter(th.p.characterId, 1)[0]).toMatchObject({ reason: 'robbery', status: 'sold' })
    expect(x.req(th, { t: 'denSell', npc: x.seopok.id })).toMatchObject({ ok: false, reason: 'not_found' })
    // the scroll: job level 3 to buy; it takes a Thief to the den
    expect(x.req(th, { t: 'denBuy', npc: x.seopok.id, count: 2 })).toMatchObject({ ok: false, reason: 'requirements' })
    x.g.jobs.gm(['Thea', 'level', '3'], x.h.now)
    const g1 = x.goldOf(th.p)
    expect(x.req(th, { t: 'denBuy', npc: x.seopok.id, count: 2 })).toMatchObject({ ok: true })
    expect(g1 - x.goldOf(th.p)).toBe(2000)
    x.warp(th, 300, -300)
    th.p.lastCombatAt = 0
    const bag = x.h.store.loadInventory(th.p.characterId).bag.findIndex((i) => i?.code === DEN_SCROLL.code)
    expect(x.req(th, { t: 'itemUse', bag })).toMatchObject({ ok: true })
    const [px, , pz] = x.h.world.positionAt(th.p, x.h.now)
    expect(Math.hypot(px - x.seopok.pos[0], pz - x.seopok.pos[2])).toBeLessThan(8)
    // a Trader cannot use it
    const { draft } = x.h.store.inventoryTx(t.p.characterId, (d) => addItem(d, DEN_SCROLL, 1))
    x.g.afterInventory(t.p, draft)
    const tb = x.h.store.loadInventory(t.p.characterId).bag.findIndex((i) => i?.code === DEN_SCROLL.code)
    expect(x.req(t, { t: 'itemUse', bag: tb })).toMatchObject({ ok: false, reason: 'requirements' })
  })

  it('the warrant lapses after 30 min online; the goods stay sellable', () => {
    const x = harness()
    const t = x.trader()
    const th = x.thief([205, 0, 5])
    x.pick(th, x.robbed(t)[0]!.id)
    x.jump(S.robbery.warrantOnlineMin * MIN + 1000)
    expect(x.g.law.robber(th.p.characterId)).toBe(false)
    expect(x.g.law.store.ofCharacter(th.p.characterId, 1)[0]).toMatchObject({ status: 'lapsed' })
    expect(x.sack(th)).toHaveLength(1)
    x.warp(th, x.seopok.pos[0] + 2, x.seopok.pos[2])
    expect(x.req(th, { t: 'denSell', npc: x.seopok.id })).toMatchObject({ ok: true })
  })

  it('a dead Thief drops the stolen goods (the Trader still owns them, the warrant closes); a Hunter killing a Thief gets job EXP once per pair window', () => {
    const x = harness()
    const t = x.trader()
    const th = x.thief([205, 0, 5])
    x.pick(th, x.robbed(t)[0]!.id)
    x.g.playerDied(th.p, x.h.now)
    expect(x.sack(th)).toEqual([])
    expect(x.g.law.store.ofCharacter(th.p.characterId, 1)[0]).toMatchObject({ status: 'dropped' })
    x.tick(1200)
    const back = [...x.g.transports.bags.values()]
    expect(back.map((b) => [b.ownerChar, b.crates])).toEqual([[t.p.characterId, 6]])
    // the owner, without a transport, carries them himself
    expect(x.pick(t, back[0]!.id)).toMatchObject({ ok: true })
    expect(x.sack(t)).toEqual([{ kind: 'own', good: SILK, crates: 6, owner: 'Tess', value: expect.any(Number) }])
    // Hunter kills Thief (job war): 300 × level; the same accounts again within the window: nothing, a flag
    const th2 = x.thief([210, 0, 0], 'Theo')
    const hu = x.hunter([212, 0, 0])
    x.g.playerDied(th2.p, x.h.now, hu.p)
    expect(x.g.jobs.view(hu.p, x.h.now).exp).toBe(hunterThiefExp(1, false, S.exp))
    th2.p.dead = false
    th2.p.hp = th2.p.maxHp
    x.g.playerDied(th2.p, x.h.now, hu.p)
    expect(x.g.jobs.view(hu.p, x.h.now).exp).toBe(hunterThiefExp(1, false, S.exp))
    expect(x.g.law.store.flags(5).some((f) => f.rule === 'thief_kill_pair')).toBe(true)
  })
})

describe('Hunters and owners (§6.3)', () => {
  it('a Hunter recovers bags and turns them in to Yun (25 % of the den value); none for the owner\'s associates', () => {
    const x = harness()
    const t = x.trader()
    const hu = x.hunter([205, 0, 5])
    const bags = x.robbed(t)
    expect(x.pick(hu, bags[0]!.id)).toMatchObject({ ok: true })
    expect(x.sack(hu)).toEqual([{ kind: 'recovered', good: SILK, crates: 6, owner: 'Tess', value: REWARD6 }])
    // recovered goods do not stop a return home
    x.warp(hu, x.yun.pos[0] + 1, x.yun.pos[2])
    const g0 = x.goldOf(hu.p)
    expect(x.req(hu, { t: 'yunTurnIn', npc: x.yun.id })).toMatchObject({ ok: true })
    expect(x.goldOf(hu.p) - g0).toBe(REWARD6)
    expect(x.sack(hu)).toEqual([])
    expect(x.req(hu, { t: 'yunTurnIn', npc: x.yun.id })).toMatchObject({ ok: false, reason: 'not_found' })
    // the same IP as the owner: picked, but no reward
    const ips = new Map<number, string>([
      [t.p.id, '203.0.113.7'],
      [hu.p.id, '203.0.113.7'],
    ])
    x.g.law.connect({ ipOf: (p) => ips.get(p.id) ?? null })
    const b2 = x.robbed(t)
    expect(x.pick(hu, b2[0]!.id)).toMatchObject({ ok: true })
    expect(x.sack(hu)[0]).toMatchObject({ value: 0 })
    x.warp(hu, x.yun.pos[0] + 1, x.yun.pos[2])
    const g1 = x.goldOf(hu.p)
    expect(x.req(hu, { t: 'yunTurnIn', npc: x.yun.id })).toMatchObject({ ok: true })
    expect(x.goldOf(hu.p)).toBe(g1)
    expect(x.g.law.store.flags(5).some((f) => f.rule === 'recovery_contact')).toBe(true)
  })

  it('the owner without a transport carries his bags and sells them at a post; return scrolls and the suit off are refused meanwhile', () => {
    const x = harness()
    const t = x.trader()
    const bags = x.robbed(t)
    expect(x.pick(t, bags[0]!.id)).toMatchObject({ ok: true })
    expect(x.req(t, { t: 'jobMode', on: false })).toMatchObject({ ok: false, reason: 'not_usable' })
    const { draft } = x.h.store.inventoryTx(t.p.characterId, (d) => addItem(d, RETURN_NOW, 1))
    x.g.afterInventory(t.p, draft)
    const bag = x.h.store.loadInventory(t.p.characterId).bag.findIndex((i) => i?.code === RETURN_NOW.code)
    t.p.lastCombatAt = 0
    expect(x.req(t, { t: 'itemUse', bag })).toMatchObject({ ok: false, reason: 'loaded' })
    const tc = x.post['tomb-camp']!
    x.warp(t, tc.pos[0] + 1, tc.pos[2] + 1)
    const g0 = x.goldOf(t.p)
    expect(x.req(t, { t: 'tradeSell', npc: tc.id })).toMatchObject({ ok: true })
    expect(x.goldOf(t.p)).toBeGreaterThan(g0)
    expect(x.sack(t)).toEqual([])
    expect(x.req(t, { t: 'jobMode', on: false })).toMatchObject({ ok: true })
  })
})

describe('anti-collusion (§7, §11)', () => {
  it('associates and recorded contacts of the owner cannot pick his bags as Thieves', () => {
    const x = harness()
    const t = x.trader()
    const th = x.thief([3, 0, 3])
    x.tick(200)
    x.h.req(t.p, { t: 'partyInvite', target: th.p.id })
    x.h.req(th.p, { t: 'partyRespond', inviter: t.p.id, accept: true })
    const bags = x.robbed(t)
    // in the party, a picked bag goes back to the owner's (dead) transport: refused
    expect(x.pick(th, bags[0]!.id).ok).toBe(false)
    x.h.req(th.p, { t: 'partyLeave' })
    x.tick(200)
    expect(x.pick(th, bags[0]!.id)).toMatchObject({ ok: false, reason: 'not_owner' })
    expect(x.g.law.store.flags(5).some((f) => f.rule === 'robbery_contact')).toBe(true)
    expect(x.g.law.robber(th.p.characterId)).toBe(false)
  })

  it('the pair rule: the same Thief account robbing the same Trader account pays full, half, then nothing (no job EXP)', () => {
    const x = harness()
    const t = x.trader()
    const th = x.thief([205, 0, 5])
    for (let i = 0; i < 3; i++) {
      const b = x.robbed(t)
      expect(x.pick(th, b[0]!.id)).toMatchObject({ ok: true })
    }
    expect(x.sack(th).map((e) => e.value)).toEqual([DEN6, DEN6 / 2, 0])
    expect(x.g.law.store.flags(10).filter((f) => f.rule === 'robbery_pair').length).toBe(2)
    x.warp(th, x.seopok.pos[0] + 2, x.seopok.pos[2])
    const g0 = x.goldOf(th.p)
    expect(x.req(th, { t: 'denSell', npc: x.seopok.id })).toMatchObject({ ok: true })
    expect(x.goldOf(th.p) - g0).toBe(DEN6 * 1.5)
    expect(x.g.jobs.view(th.p, x.h.now).exp).toBe(Math.floor((DEN6 * 1.5) / S.exp.thiefDenDiv))
    // the warrant's bounty (the recovery reward) is not cut by the pair rule
    expect(x.g.law.robber(th.p.characterId)).toBe(false)
  })

  it('a Thief out of the suit, a plain player or a Trader cannot take another Trader\'s bags', () => {
    const x = harness()
    const t = x.trader()
    const bags = x.robbed(t)
    const th = x.thief([205, 0, 5])
    x.g.jobs.gm(['Thea', 'mode', 'off'], x.h.now)
    x.tick(1200)
    // out of the suit the bag is not even shown
    expect(x.pick(th, bags[0]!.id)).toMatchObject({ ok: false, reason: 'not_found' })
    const t2 = x.trader('Tom')
    expect(x.pick(t2, bags[0]!.id)).toMatchObject({ ok: false, reason: 'not_owner' })
  })
})

describe('caravan pings and skills (§6.1, §4)', () => {
  it('Thieves in the suit sense loaded transports of 3 stars within 400 m; level 5 sharpens the circle', () => {
    const x = harness()
    const t = x.trader()
    x.g.transports.gm(['Tess', 'spawn', '1'], x.h.now)
    x.g.transports.gm(['Tess', 'load', '3'], x.h.now)
    const tr = x.g.transports.of(t.p.characterId)!
    tr.c.pos = [200, 0, 0]
    const th = x.thief([200, 0, 300])
    const far = x.thief([200, 0, -450], 'Fara')
    const sharp = x.thief([150, 0, 0], 'Shar', 5)
    expect(x.g.robbery.ping(x.h.now)).toBe(2)
    expect(x.h.all(th.inbox, 'caravanPing').at(-1)).toMatchObject({ id: tr.c.id, r: 120, stars: 3 })
    expect(x.h.all(sharp.inbox, 'caravanPing').at(-1)).toMatchObject({ r: 80 })
    expect(x.h.all(far.inbox, 'caravanPing')).toHaveLength(0)
    const p = x.h.all(th.inbox, 'caravanPing').at(-1)!
    expect(Math.hypot(p.x - 200, p.z - 0)).toBeLessThanOrEqual(60.001)
    // by the clock
    x.tick(S.thief.pingSec * 1000 + 100)
    expect(x.h.all(th.inbox, 'caravanPing').length).toBeGreaterThanOrEqual(2)
    // 1 star: no ping
    x.g.transports.gm(['Tess', 'load', '1'], x.h.now)
    expect(x.g.robbery.ping(x.h.now)).toBe(0)
  })

  it('a Thief\'s attack skill hits a transport; his area skill reaches one beside a monster; nobody else\'s does', () => {
    const x = harness()
    const t = x.trader()
    x.g.transports.gm(['Tess', 'spawn', '1'], x.h.now)
    x.g.transports.gm(['Tess', 'load', '2'], x.h.now)
    const tr = x.g.transports.of(t.p.characterId)!
    tr.c.pos = [200, 0, 0]
    x.h.world.refreshAround(tr.c, x.h.now)
    const th = x.job(x.char([201.5, 0, 0], { name: 'Thea' }), 'thief')
    th.p.mp = th.p.maxMp = 5000
    x.h.learn(th.p, ['SKILL_CH_SWORD_SMASH_A_01'])
    x.tick(200)
    expect(x.req(th, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: tr.c.id })).toMatchObject({ ok: true })
    x.tick(2000)
    expect(tr.c.hp).toBeLessThan(tr.c.maxHp)
    expect(x.h.all(th.inbox, 'combat').some((m) => m.target === tr.c.id && m.skill === 'SKILL_CH_SWORD_SMASH_A_01')).toBe(true)
    // the area: a spear Thief strikes a monster beside the transport
    const hp0 = tr.c.hp
    const sp = x.job(x.char([197, 0, 0], { name: 'Spike', weapon: 'spear' }), 'thief')
    sp.p.mp = sp.p.maxMp = 5000
    x.h.learn(sp.p, ['SKILL_CH_SPEAR_FRONTAREA_A_01'])
    const m = x.h.dummy(199, 0)
    x.tick(200)
    expect(x.req(sp, { t: 'useSkill', skill: 'SKILL_CH_SPEAR_FRONTAREA_A_01', target: m.id })).toMatchObject({ ok: true })
    x.tick(2500)
    expect(tr.c.hp).toBeLessThan(hp0)
    expect(x.h.all(sp.inbox, 'combat').some((c) => c.target === tr.c.id && c.aoe === true)).toBe(true)
    // a plain player's skill on it: refused; his area leaves it alone
    const plain = x.char([197, 0, 1], { name: 'Plain', weapon: 'spear' })
    plain.p.mp = plain.p.maxMp = 5000
    x.h.learn(plain.p, ['SKILL_CH_SPEAR_FRONTAREA_A_01'])
    x.tick(200)
    expect(x.req(plain, { t: 'useSkill', skill: 'SKILL_CH_SPEAR_FRONTAREA_A_01', target: tr.c.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    const hp1 = tr.c.hp
    x.tick(4000)
    expect(x.req(plain, { t: 'useSkill', skill: 'SKILL_CH_SPEAR_FRONTAREA_A_01', target: m.id })).toMatchObject({ ok: true })
    x.tick(2500)
    expect(tr.c.hp).toBe(hp1)
  })
})

describe('GM and admin (§9.5)', () => {
  it('GM robbery: status, give, clear, ping; admin GET lists the sacks', async () => {
    const x = harness()
    const t = x.trader()
    x.thief([205, 0, 5])
    const gm = (...a: string[]) => x.g.robbery.gm(a, x.h.now)
    expect(gm('Thea', 'give', 'white silk', '4').ok).toBe(true)
    expect(x.g.law.robber(x.g.store.characterByName('Thea')!.id)).toBe(true)
    expect(gm('Thea').message).toMatch(/4 ITEM_ETC_TRADE_CH_01 stolen; robbery warrant #\d+/)
    expect(gm('status')).toMatchObject({ ok: true, data: { warrants: 1, sacks: 1 } })
    expect(gm('Thea', 'give', 'nothing', '4').ok).toBe(false)
    expect(gm('Thea', 'ping').ok).toBe(true)
    const ctx = { gameplay: x.g, world: x.h.world, data: x.h.data, store: x.h.store, config: x.h.config } as unknown as GameContext
    const actor = { accountId: x.h.store.characterById(t.p.characterId)!.account_id, role: 'admin' as const, username: 'root' }
    const v = (await routeAdminJobs(ctx, { method: 'GET', path: '/api/admin/jobs', query: new URLSearchParams(''), body: undefined, actor })) as { status: number; body: AdminJobsView }
    expect(v.body.sacks).toEqual([expect.objectContaining({ name: 'Thea', kind: 'stolen', crates: 4 })])
    expect(gm('Thea', 'clear').message).toMatch(/1 robbery warrant/)
    expect(x.g.law.robber(x.g.store.characterByName('Thea')!.id)).toBe(false)
    // settings bounded
    expect(x.g.jobs.saveSettings(0, { robbery: { sentencesMin: [30, 15, 60, 120] } }, null, x.h.now)).toMatchObject({ ok: false, status: 422 })
    expect(x.g.jobs.saveSettings(0, { robbery: { sentencesMin: [5, 10, 20, 40] }, thief: { denPct: 50 } }, null, x.h.now)).toMatchObject({ ok: true })
  })

  it('the sack survives a relog (job_sacks)', () => {
    const x = harness()
    const t = x.trader()
    const th = x.thief([205, 0, 5])
    x.pick(th, x.robbed(t)[0]!.id)
    x.g.robbery.forget(th.p)
    x.g.robbery.enter(th.p)
    expect(x.sack(th)).toEqual([{ kind: 'stolen', good: SILK, crates: 6, owner: 'Tess', value: DEN6 }])
    expect(x.g.robbery.store.sack(th.p.characterId)).toHaveLength(1)
  })
})

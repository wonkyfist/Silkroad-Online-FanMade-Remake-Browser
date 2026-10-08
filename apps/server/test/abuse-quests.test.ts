/**
 * Adversarial exploit hunt, lens = quests and rewards (wave 4). The real Gameplay + QuestEngine + PartyManager on
 * synthetic content (the quests.test.ts harness shape: temp DATA_DIR, FlatNav, fixtures).
 *
 * Tests named "BUG:" reproduce a real defect and FAIL until it is fixed; their assertions state the correct
 * behaviour. Tests named "safe:" pin attacks the server already refuses.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHARACTER_RULES, MAX_GOLD, type ItemDef, type NpcDef, type QuestDef, type QuestFile, type ServerMessage, type Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay, type GameplayMessage } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { done } from '../src/inventory.ts'
import { FlatNav } from '../src/nav.ts'
import { QuestBook } from '../src/quests/book.ts'
import { questRefs } from '../src/quests/engine.ts'
import { World, type Mob, type Npc, type Player } from '../src/world.ts'
import { ITEMS, LEVELS, MANGNYANG, NPCS, SHOPS, item, mob, seeded } from './fixtures.ts'
import { testConfig } from './helpers.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const MANG = MANGNYANG.code
const BOSS = mob('MOB_CH_BOSS', { name: 'Boss', level: 5, hp: 1000, rarity: 'unique', exp: 500 })
const HERB = 'ITEM_ETC_HP_POTION_01'

const ARMOUR: ItemDef[] = (['M', 'W'] as const).flatMap((g) =>
  (['CLOTHES', 'LIGHT', 'HEAVY'] as const).map((a, i) =>
    item(`ITEM_CH_${g}_${a}_01_BA_A`, {
      category: 'armor', slot: 'chest', armorType: (['garment', 'protector', 'armor'] as const)[i], reqGender: g === 'M' ? 'male' : 'female', race: 'china', degree: 1, reqLevel: 1,
    }),
  ),
)
const QNPCS: NpcDef[] = ['NPC_T_GATE', 'NPC_T_CHIEF', 'NPC_T_POTION'].map((code) => ({ code, name: code.slice(6), x: 0, z: 0, yaw: 0, world: 'jangan', model: null, provenance: 'client' }))
const AT: Record<string, [number, number]> = { NPC_T_GATE: [0, 0], NPC_T_CHIEF: [30, 0], NPC_T_POTION: [60, 0] }

const dialog = { offer: 'Hello {name}.', progress: 'Well?', complete: 'Thanks.' }
const Q = (over: Partial<QuestDef> & Pick<QuestDef, 'id' | 'objectives'>): QuestDef => ({
  title: over.id, kind: 'main', level: 1, giver: 'NPC_T_CHIEF', turnIn: 'NPC_T_CHIEF', summary: 'Test quest.', rewards: { exp: 10, sp: 1, gold: 10 }, dialog, ...over,
})

const QFILE: QuestFile = {
  schema: 1, kind: 'quests', id: 'abuse', title: 'Abuse line', world: 'jangan',
  items: [
    { code: 'QITEM_HIDE', name: 'Hide' },
    { code: 'QITEM_LETTER', name: 'Letter' },
    { code: 'QITEM_BELL', name: 'Bell' },
    { code: 'QITEM_SEAL', name: 'Seal' },
  ],
  locations: [
    { id: 'LOC_FIELD', name: 'Field', x: 100, z: 0, radius: 10 },
    { id: 'LOC_SHRINE', name: 'Shrine', x: -100, z: 0, radius: 10 },
  ],
  quests: [
    Q({ id: 'T_001', giver: 'NPC_T_GATE', objectives: [], rewards: { exp: 20, sp: 1, gold: 100, items: [{ item: HERB, count: 5 }] } }),
    Q({
      id: 'T_002', requires: { quests: ['T_001'] },
      objectives: [{ id: 'pests', type: 'kill', mobs: [MANG], count: 3 }],
      rewards: { exp: 50, sp: 2, gold: 150, choice: [{ item: 'ITEM_CH_BLADE_02_A' }, { item: 'ITEM_CH_SHIELD_01_A' }] },
    }),
    Q({
      id: 'T_003', kind: 'side', turnIn: 'NPC_T_POTION',
      objectives: [
        { id: 'hides', type: 'collect', item: 'QITEM_HIDE', count: 2, from: [{ mob: MANG, chance: 0.5 }] },
        { id: 'herbs', type: 'have', item: HERB, count: 3, consume: true },
      ],
    }),
    Q({
      id: 'T_004', kind: 'side', giveOnAccept: [{ item: 'QITEM_LETTER', count: 1 }],
      objectives: [{ id: 'letter', type: 'deliver', npc: 'NPC_T_POTION', item: 'QITEM_LETTER', count: 1, text: 'A letter for me?' }],
    }),
    Q({
      id: 'T_005', party: true, giveOnAccept: [{ item: 'QITEM_BELL', count: 1 }],
      objectives: [
        { id: 'bell', type: 'useItem', item: 'QITEM_BELL', location: 'LOC_SHRINE', consume: false, text: 'It rings.', encounter: { mob: BOSS.code, count: 1, hpMul: 0.5, despawnSec: 60, cooldownSec: 30 } },
        { id: 'boss', type: 'kill', mobs: [BOSS.code], count: 1, after: 'bell' },
        { id: 'seal', type: 'collect', item: 'QITEM_SEAL', count: 1, after: 'bell', from: [{ mob: BOSS.code, chance: 1 }] },
      ],
    }),
    Q({
      id: 'T_R01', kind: 'repeatable', maxLevel: 5, giver: 'NPC_T_GATE', turnIn: 'NPC_T_GATE', repeat: { reset: 'daily' },
      objectives: [{ id: 'beasts', type: 'kill', mobs: [MANG], count: 1 }],
      rewards: { exp: 0, expPctOfLevel: 10, sp: 1, gold: 5 },
    }),
    Q({ id: 'T_HIGH', level: 5, objectives: [] }),
  ],
}

function harness(opts: { levelCap?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sro-abuse-quests-'))
  const logs: string[] = []
  let roll: () => number = seeded(7)
  const config = { ...testConfig(root, logs), rng: () => roll(), ...(opts.levelCap ? { levelCap: opts.levelCap } : {}) }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [MANGNYANG, BOSS], items: [...ITEMS, ...ARMOUR], levels: LEVELS, npcs: [...NPCS, ...QNPCS], shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: () => roll() })
  const book = QuestBook.fromFiles([{ name: 'abuse.json', json: QFILE }], { refs: questRefs(gameplay) })
  expect(book.files.flatMap((f) => f.issues).filter((i) => i.severity === 'error')).toEqual([])
  gameplay.quests.setContent(book)
  const npcs = new Map<string, Npc>()
  for (const [code, [x, z]] of Object.entries(AT)) {
    const n: Npc = { kind: 'npc', id: world.newId(), code, name: code, pos: [x, 0, z], yaw: 0 }
    world.addEntity(n)
    npcs.set(code, n)
  }
  let n = 0
  const enter = (o: { pos?: Vec3; characterId?: number } = {}) => {
    let characterId = o.characterId
    if (characterId === undefined) {
      const acc = store.createAccount(`abq${++n}`, 'x')!
      const row = store.createCharacter(acc, `Abuser${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4, {})
      if (typeof row === 'string') throw new Error(row)
      characterId = row.id
    }
    const row = store.characterById(characterId)!
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(row), characterId, name: row.name, model: row.model, level: row.level, weapon: row.weapon, pos: o.pos ?? [0, 0, 0], yaw: 0, send: (m) => inbox.push(m) })
    for (const npc of npcs.values()) p.known.add(npc.id)
    gameplay.sendEnter(p)
    return { p, inbox }
  }
  const leave = (p: Player) => {
    gameplay.forget(p)
    world.remove(p.id)
  }
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const h = {
    store, world, gameplay, data, config, logs, npcs, enter, leave,
    engine: gameplay.quests,
    pin(r: () => number) {
      roll = r
    },
    at(p: Player, code: string) {
      const [x, z] = AT[code]
      world.warp(p, x + 1, 0, z)
    },
    act(p: Player, inbox: ServerMessage[], msg: GameplayMessage, now = Date.now()): Msg<'actionResult'> {
      gameplay.request(p, msg, now)
      const r = inbox.filter((m): m is Msg<'actionResult'> => m.t === 'actionResult').at(-1)!
      expect(r.re).toBe(msg.t)
      return r
    },
    accept(p: Player, inbox: ServerMessage[], quest: string, now = Date.now()) {
      const def = h.engine.book.quest(quest)!
      h.at(p, def.giver)
      return h.act(p, inbox, { t: 'questAccept', npc: npcs.get(def.giver)!.id, quest }, now)
    },
    turnIn(p: Player, inbox: ServerMessage[], quest: string, choice?: number, now = Date.now()) {
      const def = h.engine.book.quest(quest)!
      h.at(p, def.turnIn)
      return h.act(p, inbox, { t: 'questTurnIn', npc: npcs.get(def.turnIn)!.id, quest, ...(choice !== undefined ? { choice } : {}) }, now)
    },
    kill(killers: Player[], code = MANG, at: [number, number] = [200, 200]): Mob {
      const m = gameplay.createMob(data.mob(code)!, 'normal', at[0], at[1], 0, null, Date.now())
      for (const k of killers) m.damage.set(k.id, 10)
      gameplay.mobDied(m, Date.now(), true)
      return m
    },
    active: (p: Player, quest: string) => h.engine.logOf(p).active.get(quest),
    bagCount: (p: Player, code: string) => store.loadInventory(p.characterId).bag.reduce((s, i) => s + (i?.code === code ? i.count : 0), 0),
    give(p: Player, code: string, count: number) {
      const r = gameplay.gmItem(p, data.item(code)!, code, count)
      expect(r.ok).toBe(true)
    },
    rows: (sql: string, ...args: unknown[]) => store.db.prepare(sql).all(...args) as Record<string, unknown>[],
    /** Live (not dead) encounter mobs of a quest. */
    bosses: (quest = 'T_005') => [...world.mobs.values()].filter((m) => m.encounter?.quest === quest && m.ai !== 'dead'),
  }
  return h
}

describe('quest exploits that the server must refuse', () => {
  it('BUG: an encounter killed by someone else (the ringer got no credit) can be re-summoned at once, again and again (unique farm, no cooldown)', () => {
    const h = harness()
    const ringer = h.enter()
    const farmer = h.enter() // not in a party with the ringer, no quest: just farms the summoned unique
    h.accept(ringer.p, ringer.inbox, 'T_005')
    h.world.warp(ringer.p, -100, 0, 0)
    h.world.warp(farmer.p, -98, 0, 0)
    const use = (now: number) => h.act(ringer.p, ringer.inbox, { t: 'questUseItem', quest: 'T_005', objective: 'bell' }, now)
    const t0 = Date.now()
    expect(use(t0)).toMatchObject({ ok: true })
    let summoned = 0
    const exp0 = h.store.characterById(farmer.p.characterId)!.exp
    const lv0 = farmer.p.progress.level
    // The farmer kills each summoned boss; the ringer never deals damage, so it gets no credit and its kill stays open.
    for (let i = 0; i < 5; i++) {
      const boss = h.bosses()[0]
      if (!boss) break
      summoned++
      boss.damage.set(farmer.p.id, boss.maxHp)
      h.gameplay.mobDied(boss, t0 + 1000 * (i + 1), true)
      use(t0 + 1000 * (i + 1) + 1)
    }
    // the farmer really was paid for every kill
    expect(farmer.p.progress.level > lv0 || h.store.characterById(farmer.p.characterId)!.exp > exp0).toBe(true)
    expect(h.active(ringer.p, 'T_005')!.counts).toMatchObject({ bell: 1, boss: 0, seal: 0 })
    // Correct: a killed encounter starts the same cooldown as an unkilled despawn (cooldownSec 30), so ringing one
    // second after the kill is refused and at most one boss is summoned in these 5 seconds.
    expect(summoned).toBe(1)
    expect(use(t0 + 6000)).toMatchObject({ ok: false, reason: 'cooldown' })
  })

  it('BUG: a GM /kill of the encounter mob never ends the encounter ("It is already here." with nothing there until the despawn)', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.accept(p, inbox, 'T_005')
    h.world.warp(p, -100, 0, 0)
    const t0 = Date.now()
    expect(h.act(p, inbox, { t: 'questUseItem', quest: 'T_005', objective: 'bell' }, t0)).toMatchObject({ ok: true })
    const boss = h.bosses()[0]
    h.gameplay.gmKill(boss, t0 + 1000) // the gm.ts `kill` command's path
    expect(h.bosses()).toHaveLength(0)
    // Correct: the encounter is over when its last mob is dead, however it died (Encounters.mobDied).
    expect(h.engine.encounters.all()).toHaveLength(0)
    expect(h.engine.progress(p, h.active(p, 'T_005')!).encounterUntil).toBeUndefined()
    expect(h.act(p, inbox, { t: 'questUseItem', quest: 'T_005', objective: 'bell' }, t0 + 2000)).not.toMatchObject({ message: 'It is already here.' })
  })

  it('safe: turn-in without the objectives, double turn-in, the wrong NPC, and turn-in while dead are refused', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.accept(p, inbox, 'T_001')
    expect(h.turnIn(p, inbox, 'T_001')).toMatchObject({ ok: true })
    expect(h.turnIn(p, inbox, 'T_001')).toMatchObject({ ok: false, reason: 'not_found' })
    expect(p.gold).toBe(100)
    expect(h.bagCount(p, HERB)).toBe(5)
    h.accept(p, inbox, 'T_002')
    expect(h.turnIn(p, inbox, 'T_002', 0)).toMatchObject({ ok: false, reason: 'not_complete' })
    for (let i = 0; i < 3; i++) h.kill([p])
    h.at(p, 'NPC_T_GATE')
    expect(h.act(p, inbox, { t: 'questTurnIn', npc: h.npcs.get('NPC_T_GATE')!.id, quest: 'T_002', choice: 0 })).toMatchObject({ ok: false })
    h.gameplay.gmKill(p)
    expect(h.turnIn(p, inbox, 'T_002', 0)).toMatchObject({ ok: false })
    expect(h.active(p, 'T_002')).toBeDefined()
    h.gameplay.gmHeal(p)
    // out of range (and no longer known to the client)
    h.world.warp(p, 400, 0, 400)
    expect(h.act(p, inbox, { t: 'questTurnIn', npc: h.npcs.get('NPC_T_CHIEF')!.id, quest: 'T_002', choice: 0 })).toMatchObject({ ok: false })
    expect(h.active(p, 'T_002')!.status).toBe('ready')
  })

  it('safe: reward choice injection: out of range refused; a choice on a no-choice quest adds nothing; required when there are choices', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.accept(p, inbox, 'T_001')
    const bag0 = h.store.loadInventory(p.characterId).bag.filter(Boolean).length
    expect(h.turnIn(p, inbox, 'T_001', 1)).toMatchObject({ ok: true })
    expect(h.store.loadInventory(p.characterId).bag.filter(Boolean).length - bag0).toBe(1) // just the 5 herbs stack
    h.accept(p, inbox, 'T_002')
    for (let i = 0; i < 3; i++) h.kill([p])
    expect(h.turnIn(p, inbox, 'T_002')).toMatchObject({ ok: false, reason: 'choice_required' })
    expect(h.turnIn(p, inbox, 'T_002', 2)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.turnIn(p, inbox, 'T_002', -1)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.turnIn(p, inbox, 'T_002', 1)).toMatchObject({ ok: true })
    expect(h.bagCount(p, 'ITEM_CH_SHIELD_01_A') + h.bagCount(p, 'ITEM_CH_BLADE_02_A')).toBe(1)
  })

  it('safe: `have` items moved out of the bag behind the hook are recounted at the turn-in (not_complete), and consumed once', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.give(p, HERB, 3)
    h.accept(p, inbox, 'T_003')
    h.pin(() => 0)
    h.kill([p])
    h.kill([p])
    expect(h.active(p, 'T_003')!.status).toBe('ready')
    // take the herbs without telling the quest engine (as a storage deposit that skipped afterInventory would)
    h.store.inventoryTx(p.characterId, (d) => {
      for (let i = 0; i < d.bagSize; i++) if (d.bag[i]?.code === HERB) d.setBag(i, null)
      return done(undefined)
    })
    expect(h.active(p, 'T_003')!.status).toBe('ready')
    expect(h.turnIn(p, inbox, 'T_003')).toMatchObject({ ok: false, reason: 'not_complete' })
    h.give(p, HERB, 3)
    expect(h.turnIn(p, inbox, 'T_003')).toMatchObject({ ok: true })
    expect(h.bagCount(p, HERB)).toBe(0)
  })

  it('safe: abandon + re-accept never duplicates quest items or rewards; quest items never reach the bag or the ground', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    for (let i = 0; i < 3; i++) {
      expect(h.accept(p, inbox, 'T_004')).toMatchObject({ ok: true })
      expect(h.act(p, inbox, { t: 'questAbandon', quest: 'T_004' })).toMatchObject({ ok: true })
    }
    h.accept(p, inbox, 'T_004')
    expect([...h.active(p, 'T_004')!.items]).toEqual([['QITEM_LETTER', 1]])
    h.at(p, 'NPC_T_POTION')
    const potion = h.npcs.get('NPC_T_POTION')!.id
    expect(h.act(p, inbox, { t: 'questTalk', npc: potion, quest: 'T_004', objective: 'letter' })).toMatchObject({ ok: true })
    expect(h.act(p, inbox, { t: 'questTalk', npc: potion, quest: 'T_004', objective: 'letter' })).toMatchObject({ ok: false })
    expect(h.turnIn(p, inbox, 'T_004')).toMatchObject({ ok: true })
    expect(h.accept(p, inbox, 'T_004')).toMatchObject({ ok: false, reason: 'quest_done' })
    // collect drops: abandon mid-way resets the count, nothing lands in the bag or on the ground
    h.give(p, HERB, 3)
    h.accept(p, inbox, 'T_003')
    h.pin(() => 0)
    h.kill([p])
    expect(h.active(p, 'T_003')!.counts.hides).toBe(1)
    h.act(p, inbox, { t: 'questAbandon', quest: 'T_003' })
    h.accept(p, inbox, 'T_003')
    expect(h.active(p, 'T_003')!.counts.hides).toBe(0)
    expect(h.store.loadInventory(p.characterId).bag.some((i) => i?.code.startsWith('QITEM_'))).toBe(false)
    expect([...h.world.items.values()].some((i) => i.code.startsWith('QITEM_'))).toBe(false)
    expect(h.rows('SELECT code, count FROM quest_items WHERE character_id = ?', p.characterId)).toEqual([])
  })

  it('safe: daily reset cannot be skipped by a relog; a second character is its own log; the level range and prerequisites hold', () => {
    const h = harness()
    const a = h.enter()
    const t1 = new Date(2026, 8, 10, 22, 0).getTime()
    h.accept(a.p, a.inbox, 'T_R01', t1)
    h.kill([a.p])
    expect(h.turnIn(a.p, a.inbox, 'T_R01', undefined, t1)).toMatchObject({ ok: true })
    h.leave(a.p)
    const again = h.enter({ characterId: a.p.characterId })
    expect(h.accept(again.p, again.inbox, 'T_R01', t1 + 60_000)).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(h.accept(again.p, again.inbox, 'T_R01', new Date(2026, 8, 11, 3, 59).getTime())).toMatchObject({ ok: false, reason: 'cooldown' })
    // prerequisite and level bypass
    expect(h.accept(again.p, again.inbox, 'T_002')).toMatchObject({ ok: false, reason: 'requirements' })
    expect(h.accept(again.p, again.inbox, 'T_HIGH')).toMatchObject({ ok: false, reason: 'requirements' })
    h.gameplay.gmSetLevel(again.p, 6)
    expect(h.accept(again.p, again.inbox, 'T_R01', new Date(2026, 8, 12, 5, 0).getTime())).toMatchObject({ ok: false, reason: 'requirements' })
  })

  it('safe: kill credit skips dead and offline players; GM kills give no credit', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    const c = h.enter()
    for (const x of [a, b, c]) h.accept(x.p, x.inbox, 'T_R01')
    h.gameplay.gmKill(b.p)
    h.leave(c.p)
    const m = h.gameplay.createMob(MANGNYANG, 'normal', 200, 200, 0, null, Date.now())
    m.damage.set(a.p.id, 5)
    m.damage.set(b.p.id, 5)
    m.damage.set(c.p.id, 5)
    h.gameplay.mobDied(m, Date.now(), true)
    expect(h.active(a.p, 'T_R01')!.status).toBe('ready')
    expect(h.active(b.p, 'T_R01')!.status).toBe('active')
    const back = h.enter({ characterId: c.p.characterId })
    expect(h.active(back.p, 'T_R01')!.counts.beasts).toBe(0)
    const g = h.gameplay.createMob(MANGNYANG, 'normal', 200, 200, 0, null, Date.now())
    g.damage.set(back.p.id, 5)
    h.gameplay.gmKill(g)
    expect(h.active(back.p, 'T_R01')!.counts.beasts).toBe(0)
  })

  it('safe: useItem at the wrong place or while dead; a second ring while it lives; relog keeps the despawn cooldown', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.accept(p, inbox, 'T_005')
    const use = (now = Date.now()) => h.act(p, inbox, { t: 'questUseItem', quest: 'T_005', objective: 'bell' }, now)
    h.world.warp(p, -85, 0, 0) // 15 m from the shrine, radius 10
    expect(use()).toMatchObject({ ok: false, reason: 'wrong_place' })
    h.world.warp(p, -100, 0, 0)
    h.gameplay.gmKill(p)
    expect(use()).toMatchObject({ ok: false })
    expect(h.bosses()).toHaveLength(0)
    h.gameplay.gmHeal(p)
    const t0 = Date.now()
    expect(use(t0)).toMatchObject({ ok: true })
    expect(use(t0 + 1)).toMatchObject({ ok: false, reason: 'cooldown' })
    h.engine.tick(t0 + 60_000)
    h.leave(p)
    const back = h.enter({ characterId: p.characterId, pos: [-100, 0, 0] })
    expect(h.act(back.p, back.inbox, { t: 'questUseItem', quest: 'T_005', objective: 'bell' }, t0 + 61_000)).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(h.bosses()).toHaveLength(0)
  })

  it('safe: reward gold clamps at MAX_GOLD (no overflow); EXP at the level cap turns into SP-EXP and the level stays', () => {
    const h = harness({ levelCap: 5 })
    const { p, inbox } = h.enter()
    const { draft } = h.store.inventoryTx(p.characterId, (d) => {
      d.setGold(MAX_GOLD - 5)
      return done(undefined)
    })
    h.gameplay.afterInventory(p, draft)
    h.gameplay.gmSetLevel(p, 5)
    h.accept(p, inbox, 'T_001')
    expect(h.turnIn(p, inbox, 'T_001')).toMatchObject({ ok: true })
    expect(p.gold).toBe(MAX_GOLD)
    expect(h.store.characterById(p.characterId)!.gold).toBe(MAX_GOLD)
    // 29 SP from gmSetLevel(5) (typical SP of level 5 on the Climb's curve, progression.ts) + 1 from the quest's SP-EXP
    expect(p.progress).toMatchObject({ level: 5, exp: 0, sp: 30, spExp: 20 })
    expect(CHARACTER_RULES.spExpPerSp).toBeGreaterThan(20)
  })
})

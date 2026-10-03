/**
 * The quest engine on synthetic content (docs/QUESTS.md §1.3-§1.6, §7 lane B; docs/WAVE_PLAN.md §5.3 QS-S): accept
 * reasons, kill counting with `after`, quest drops into the quest bag (seeded rolls), talk/deliver, reach via moves,
 * useItem range and the encounter (spawn, one per group, despawn, re-summon), the `have` recount, the one-transaction
 * turn-in ({G}/{ARMOR}, choice, inventory_full), the daily reset, abandon, the hot-reload re-map, the level-cap rule,
 * persistence, the enter snapshot, the NPC 'quest' service and kill credit through modules.mobDied with and without a
 * party.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHARACTER_RULES, MAX_ACTIVE_QUESTS, parseServerMessage, type ItemDef, type NpcDef, type QuestDef, type QuestFile, type ServerMessage, type Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay, type GameplayMessage, type KillShares } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { GM_SPAWN_TOTAL_MAX } from '../src/gm.ts'
import { FlatNav } from '../src/nav.ts'
import { QuestBook } from '../src/quests/book.ts'
import { nextDailyReset, questRefs } from '../src/quests/engine.ts'
import { rewardItems, turnInGain } from '../src/quests/rewards.ts'
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

/** Chest pieces for every {G}/{ARMOR} expansion of ITEM_CH_{G}_{ARMOR}_01_BA_A (the validator wants all six). */
const ARMOUR: ItemDef[] = (['M', 'W'] as const).flatMap((g) =>
  (['CLOTHES', 'LIGHT', 'HEAVY'] as const).map((a, i) =>
    item(`ITEM_CH_${g}_${a}_01_BA_A`, {
      category: 'armor', slot: 'chest', armorType: (['garment', 'protector', 'armor'] as const)[i], reqGender: g === 'M' ? 'male' : 'female', race: 'china', degree: 1, reqLevel: 1,
    }),
  ),
)
const QNPCS: NpcDef[] = ['NPC_T_GATE', 'NPC_T_CHIEF', 'NPC_T_POTION'].map((code) => ({ code, name: code.slice(6), x: 0, z: 0, yaw: 0, world: 'jangan', model: null, provenance: 'client' }))
/** Where the NPC entities stand (x, z). */
const AT: Record<string, [number, number]> = { NPC_T_GATE: [0, 0], NPC_T_CHIEF: [30, 0], NPC_T_POTION: [60, 0] }

const dialog = { offer: 'Hello {name}.', progress: 'Well?', complete: 'Thanks.' }
const Q = (over: Partial<QuestDef> & Pick<QuestDef, 'id' | 'objectives'>): QuestDef => ({
  title: over.id, kind: 'main', level: 1, giver: 'NPC_T_CHIEF', turnIn: 'NPC_T_CHIEF', summary: 'Test quest.', rewards: { exp: 10, sp: 1, gold: 10 }, dialog, ...over,
})

const QFILE: QuestFile = {
  schema: 1, kind: 'quests', id: 'test', title: 'Test line', world: 'jangan',
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
      objectives: [
        { id: 'letter', type: 'deliver', npc: 'NPC_T_POTION', item: 'QITEM_LETTER', count: 1, text: 'A letter for me?' },
        { id: 'gate', type: 'talk', npc: 'NPC_T_GATE', text: 'So you delivered it.', after: 'letter' },
        { id: 'herbs', type: 'deliver', npc: 'NPC_T_POTION', item: HERB, count: 2, text: 'Herbs, good.' },
      ],
    }),
    Q({
      id: 'T_005', party: true, giveOnAccept: [{ item: 'QITEM_BELL', count: 1 }],
      objectives: [
        { id: 'field', type: 'reach', location: 'LOC_FIELD' },
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
    Q({ id: 'T_006', giver: 'NPC_T_GATE', turnIn: 'NPC_T_GATE', objectives: [], rewards: { exp: 5, sp: 0, gold: 0, items: [{ item: 'ITEM_CH_{G}_{ARMOR}_01_BA_A' }] } }),
    Q({ id: 'T_HIGH', level: 5, objectives: [] }),
  ],
}

function harness(opts: { levelCap?: number; file?: QuestFile } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sro-quests-'))
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
  const book = QuestBook.fromFiles([{ name: 'test.json', json: opts.file ?? QFILE }], { refs: questRefs(gameplay) })
  const errors = book.files.flatMap((f) => f.issues).filter((i) => i.severity === 'error')
  expect(errors).toEqual([])
  gameplay.quests.setContent(book)
  const npcs = new Map<string, Npc>()
  for (const [code, [x, z]] of Object.entries(AT)) {
    const n: Npc = { kind: 'npc', id: world.newId(), code, name: code, pos: [x, 0, z], yaw: 0 }
    world.addEntity(n)
    npcs.set(code, n)
  }
  let n = 0
  const enter = (o: { pos?: Vec3; model?: string; outfit?: 'clothes' | 'light' | 'heavy'; characterId?: number } = {}) => {
    let characterId = o.characterId
    if (characterId === undefined) {
      const acc = store.createAccount(`qacc${++n}`, 'x')!
      const row = store.createCharacter(acc, `Quester${n}`, o.model ?? 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4, { outfit: o.outfit })
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
    /** Moves `p` next to the NPC (inside the 8 m interact range). */
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
    /** A mob of `code` dies with damage from `killers` (the real mobDied path: shares, credit, modules.mobDied). */
    kill(killers: Player[], code = MANG, at: [number, number] = [200, 200]): Mob {
      const m = gameplay.createMob(data.mob(code)!, 'normal', at[0], at[1], 0, null, Date.now())
      for (const k of killers) m.damage.set(k.id, 10)
      gameplay.mobDied(m, Date.now(), true)
      return m
    },
    updates: (inbox: ServerMessage[], quest?: string) => inbox.filter((m): m is Msg<'questUpdate'> => m.t === 'questUpdate' && (quest === undefined || m.quest === quest)),
    active: (p: Player, quest: string) => h.engine.logOf(p).active.get(quest),
    bagCount: (p: Player, code: string) => store.loadInventory(p.characterId).bag.reduce((s, i) => s + (i?.code === code ? i.count : 0), 0),
    give(p: Player, code: string, count: number) {
      const r = gameplay.gmItem(p, data.item(code)!, code, count)
      expect(r.ok).toBe(true)
    },
    rows: (sql: string, ...args: unknown[]) => store.db.prepare(sql).all(...args) as Record<string, unknown>[],
  }
  return h
}

/** Every server message must pass the client's strict parser. */
function wire(inbox: ServerMessage[]): void {
  for (const m of inbox) expect(parseServerMessage(JSON.stringify(m)).ok, JSON.stringify(m)).toBe(true)
}

describe('quest book', () => {
  it('loads, validates against the refs, indexes and serves a merged catalog; an override replaces the repo copy', () => {
    const h = harness()
    const b = h.engine.book
    expect(b.quests.size).toBe(QFILE.quests.length)
    expect(b.byGiver.get('NPC_T_GATE')!.map((q) => q.id)).toEqual(['T_001', 'T_R01', 'T_006'])
    expect(b.killIndex.get(MANG)!.map((k) => `${k.quest.id}.${k.objective.id}`)).toEqual(['T_002.pests', 'T_R01.beasts'])
    expect(b.dropIndex.get(MANG)!.map((d) => [d.quest.id, d.item, d.chance])).toEqual([['T_003', 'QITEM_HIDE', 0.5]])
    const rev = b.rev
    const edited = { ...QFILE, id: 'T_002', items: [], locations: [], quests: [{ ...QFILE.quests[1], title: 'Edited', rev: 3 }] }
    expect(b.replace(edited, 'T_002.json').filter((i) => i.severity === 'error')).toEqual([])
    expect(b.rev).toBe(rev + 1)
    expect(b.quest('T_002')!.title).toBe('Edited')
    expect(b.origin.get('T_002')).toEqual({ file: 'T_002.json', source: 'override' })
    const cat = b.catalog()
    const ids = cat.files.flatMap((f) => f.quests.map((q) => q.id))
    expect(ids.filter((id) => id === 'T_002')).toHaveLength(1)
    expect(cat.files.at(-1)!.quests[0].title).toBe('Edited')
    expect(b.remove('T_002')).toBe(true)
    expect(b.quest('T_002')!.title).toBe('T_002')
    // a broken quest is dropped and reported, its file stays
    const broken = QuestBook.fromFiles([{ name: 'x.json', json: { ...QFILE, quests: [...QFILE.quests, { id: 'T_BAD', objectives: 'no' }] } }])
    expect(broken.quests.has('T_BAD')).toBe(false)
    expect(broken.quests.size).toBe(QFILE.quests.length)
    expect(broken.issues.get('T_BAD')!.length).toBeGreaterThan(0)
  })
})

describe('accept', () => {
  it('answers every §1.3 reason in order, then accepts and grants the quest items', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    const gate = h.npcs.get('NPC_T_GATE')!
    const chief = h.npcs.get('NPC_T_CHIEF')!
    // unknown / unsent NPC, too far, wrong giver
    expect(h.act(p, inbox, { t: 'questAccept', npc: 99999, quest: 'T_001' })).toMatchObject({ ok: false, reason: 'not_found' })
    h.at(p, 'NPC_T_GATE')
    p.known.delete(gate.id)
    expect(h.act(p, inbox, { t: 'questAccept', npc: gate.id, quest: 'T_001' })).toMatchObject({ ok: false, reason: 'not_found' })
    p.known.add(gate.id)
    h.world.warp(p, 20, 0, 0)
    expect(h.act(p, inbox, { t: 'questAccept', npc: gate.id, quest: 'T_001' })).toMatchObject({ ok: false, reason: 'too_far' })
    h.at(p, 'NPC_T_CHIEF')
    expect(h.act(p, inbox, { t: 'questAccept', npc: chief.id, quest: 'T_001' })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.act(p, inbox, { t: 'questAccept', npc: chief.id, quest: 'T_NOPE' })).toMatchObject({ ok: false, reason: 'not_found' })
    // level, prerequisite
    expect(h.accept(p, inbox, 'T_HIGH')).toMatchObject({ ok: false, reason: 'requirements' })
    expect(h.accept(p, inbox, 'T_002')).toMatchObject({ ok: false, reason: 'requirements' })
    // accepted, then active
    expect(h.accept(p, inbox, 'T_001')).toMatchObject({ ok: true })
    const up = h.updates(inbox, 'T_001').at(-1)!
    expect(up).toMatchObject({ event: 'accepted', progress: { quest: 'T_001', status: 'ready', counts: {}, items: [] } })
    expect(h.accept(p, inbox, 'T_001')).toMatchObject({ ok: false, reason: 'quest_active' })
    // quest items on accept
    expect(h.accept(p, inbox, 'T_004')).toMatchObject({ ok: true })
    expect(h.updates(inbox, 'T_004').at(-1)!.progress!.items).toEqual([{ code: 'QITEM_LETTER', count: 1 }])
    expect(h.rows('SELECT code, count FROM quest_items WHERE character_id = ?', p.characterId)).toEqual([{ code: 'QITEM_LETTER', count: 1 }])
    // done and not repeatable
    expect(h.turnIn(p, inbox, 'T_001')).toMatchObject({ ok: true })
    expect(h.accept(p, inbox, 'T_001')).toMatchObject({ ok: false, reason: 'quest_done' })
    wire(inbox)
  })

  it(`the log holds ${MAX_ACTIVE_QUESTS} quests (quest_log_full)`, () => {
    const extra = Array.from({ length: MAX_ACTIVE_QUESTS }, (_, i) => Q({ id: `T_FILL${i}`, objectives: [{ id: 'k', type: 'kill', mobs: [MANG], count: 1 }] }))
    const h = harness({ file: { ...QFILE, quests: [...QFILE.quests, ...extra] } })
    const { p, inbox } = h.enter()
    for (let i = 0; i < MAX_ACTIVE_QUESTS; i++) expect(h.accept(p, inbox, `T_FILL${i}`)).toMatchObject({ ok: true })
    expect(h.accept(p, inbox, 'T_003')).toMatchObject({ ok: false, reason: 'quest_log_full' })
  })
})

describe('objectives', () => {
  it('kills count through modules.mobDied for the credited killer; a GM kill counts nothing; ready at the count', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.accept(p, inbox, 'T_001')
    h.turnIn(p, inbox, 'T_001')
    expect(h.accept(p, inbox, 'T_002')).toMatchObject({ ok: true })
    h.kill([p])
    expect(h.updates(inbox, 'T_002').at(-1)).toMatchObject({ event: 'progress', progress: { counts: { pests: 1 }, status: 'active' } })
    const m = h.gameplay.createMob(MANGNYANG, 'normal', 5, 5, 0, null, Date.now())
    m.damage.set(p.id, 5)
    h.gameplay.gmKill(m)
    expect(h.active(p, 'T_002')!.counts.pests).toBe(1)
    h.kill([p])
    h.kill([p])
    expect(h.updates(inbox, 'T_002').at(-1)).toMatchObject({ event: 'ready', progress: { counts: { pests: 3 }, status: 'ready' } })
    h.kill([p])
    expect(h.active(p, 'T_002')!.counts.pests).toBe(3)
    expect(h.rows('SELECT status, counts FROM quest_state WHERE character_id = ? AND quest = ?', p.characterId, 'T_002')).toEqual([{ status: 'ready', counts: '{"pests":3}' }])
    wire(inbox)
  })

  it('a dead damage dealer gets no credit; a party member within reach that did no damage does (killShares credit)', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    const c = h.enter()
    for (const x of [a, b, c]) {
      h.accept(x.p, x.inbox, 'T_R01')
    }
    // solo rule: b dealt damage but is dead
    h.gameplay.gmKill(b.p)
    h.kill([a.p, b.p])
    expect(h.active(a.p, 'T_R01')!.status).toBe('ready')
    expect(h.active(b.p, 'T_R01')!.status).toBe('active')
    // a party's killShares supplies the credit: c did nothing and still counts
    const party = h.gameplay.party as unknown as { killShares: (m: Mob) => KillShares | null }
    party.killShares = (m) => ({
      shares: new Map([[a.p.id, { exp: m.def.exp, spExp: 0 }]]),
      credit: new Set([a.p.id, c.p.id]),
      lootOwners: { next: () => ({ player: a.p, party: 1 }) },
    })
    h.kill([a.p])
    expect(h.active(c.p, 'T_R01')!.status).toBe('ready')
    expect(h.updates(c.inbox, 'T_R01').at(-1)).toMatchObject({ event: 'ready' })
  })

  it('collect: seeded rolls put quest items straight into the quest bag (never the ground), with a chat line', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.give(p, HERB, 3)
    expect(h.accept(p, inbox, 'T_003')).toMatchObject({ ok: true })
    expect(h.active(p, 'T_003')!.counts).toEqual({ hides: 0, herbs: 3 })
    h.pin(() => 0.9) // above the 50 % chance: nothing
    h.kill([p])
    expect(h.active(p, 'T_003')!.items.get('QITEM_HIDE')).toBeUndefined()
    h.pin(() => 0.1)
    h.kill([p])
    expect(inbox.filter((m) => m.t === 'chat').at(-1)).toMatchObject({ channel: 'system', text: 'Hide (1/2)' })
    h.kill([p])
    expect(h.updates(inbox, 'T_003').at(-1)).toMatchObject({ event: 'ready', progress: { counts: { hides: 2, herbs: 3 }, items: [{ code: 'QITEM_HIDE', count: 2 }] } })
    h.kill([p])
    expect(h.active(p, 'T_003')!.items.get('QITEM_HIDE')).toBe(2)
    expect([...h.world.items.values()].some((i) => i.code.startsWith('QITEM'))).toBe(false)
    expect(h.rows('SELECT code, count FROM quest_items WHERE character_id = ? AND quest = ?', p.characterId, 'T_003')).toEqual([{ code: 'QITEM_HIDE', count: 2 }])
    wire(inbox)
  })

  it('have: the bag is counted live; dropping below the count turns ready back into active; consumed at turn-in', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.pin(() => 0)
    h.accept(p, inbox, 'T_003')
    h.kill([p])
    h.kill([p])
    expect(h.active(p, 'T_003')!.counts).toEqual({ hides: 2, herbs: 0 })
    h.give(p, HERB, 5)
    expect(h.updates(inbox, 'T_003').at(-1)).toMatchObject({ event: 'ready', progress: { counts: { herbs: 3 } } })
    const slot = h.store.loadInventory(p.characterId).bag.findIndex((i) => i?.code === HERB)
    expect(h.act(p, inbox, { t: 'itemDrop', bag: slot, count: 3 })).toMatchObject({ ok: true })
    expect(h.updates(inbox, 'T_003').at(-1)).toMatchObject({ event: 'progress', progress: { status: 'active', counts: { herbs: 2 } } })
    expect(h.turnIn(p, inbox, 'T_003')).toMatchObject({ ok: false, reason: 'not_complete' })
    h.give(p, HERB, 4)
    expect(h.active(p, 'T_003')!.status).toBe('ready')
    expect(h.turnIn(p, inbox, 'T_003')).toMatchObject({ ok: true })
    expect(h.bagCount(p, HERB)).toBe(3)
    expect(h.rows('SELECT * FROM quest_items WHERE character_id = ?', p.characterId)).toEqual([])
  })

  it('talk and deliver (a quest item from the quest bag, an item from the bag), with `after` gating the talk', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.accept(p, inbox, 'T_004')
    const gate = h.npcs.get('NPC_T_GATE')!.id
    const potion = h.npcs.get('NPC_T_POTION')!.id
    h.at(p, 'NPC_T_GATE')
    expect(h.act(p, inbox, { t: 'questTalk', npc: gate, quest: 'T_004', objective: 'gate' })).toMatchObject({ ok: false, reason: 'requirements' })
    expect(h.act(p, inbox, { t: 'questTalk', npc: gate, quest: 'T_004', objective: 'letter' })).toMatchObject({ ok: false, reason: 'not_found' })
    h.at(p, 'NPC_T_POTION')
    expect(h.act(p, inbox, { t: 'questTalk', npc: potion, quest: 'T_004', objective: 'letter' })).toMatchObject({ ok: true })
    expect(h.updates(inbox, 'T_004').at(-1)).toMatchObject({ event: 'objective', objective: 'letter', progress: { counts: { letter: 1 }, items: [] } })
    expect(h.act(p, inbox, { t: 'questTalk', npc: potion, quest: 'T_004', objective: 'letter' })).toMatchObject({ ok: false, reason: 'not_found' })
    // herbs from the bag: missing -> not_complete, nothing taken
    h.give(p, HERB, 1)
    expect(h.act(p, inbox, { t: 'questTalk', npc: potion, quest: 'T_004', objective: 'herbs' })).toMatchObject({ ok: false, reason: 'not_complete' })
    expect(h.bagCount(p, HERB)).toBe(1)
    h.give(p, HERB, 2)
    inbox.length = 0
    expect(h.act(p, inbox, { t: 'questTalk', npc: potion, quest: 'T_004', objective: 'herbs' })).toMatchObject({ ok: true })
    expect(h.bagCount(p, HERB)).toBe(1)
    expect(inbox.map((m) => m.t)).toEqual(['actionResult', 'inventoryUpdate', 'questUpdate'])
    h.at(p, 'NPC_T_GATE')
    expect(h.act(p, inbox, { t: 'questTalk', npc: gate, quest: 'T_004', objective: 'gate' })).toMatchObject({ ok: true })
    expect(h.updates(inbox, 'T_004').at(-1)).toMatchObject({ event: 'ready' })
    wire(inbox)
  })

  it('reach: completes from the tick loop once the player stands inside the radius (and at once on accept)', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.accept(p, inbox, 'T_005')
    expect(h.active(p, 'T_005')!.counts.field).toBe(0)
    const now = Date.now()
    h.world.warp(p, 95, 0, 0, now)
    h.gameplay.tick(now)
    expect(h.updates(inbox, 'T_005').at(-1)).toMatchObject({ event: 'objective', objective: 'field', progress: { counts: { field: 1 } } })
    // accept inside the radius: done at once
    const b = h.enter({ pos: [100, 0, 0] })
    h.engine.accept(b.p, h.npcs.get('NPC_T_CHIEF')!.id, 'T_005', () => {}, now)
    expect(h.active(b.p, 'T_005')).toBeUndefined() // too far from the giver
    h.at(b.p, 'NPC_T_CHIEF')
    h.accept(b.p, b.inbox, 'T_005')
    h.world.warp(b.p, 100, 0, 0, now)
    h.gameplay.tick(now + 1000)
    expect(h.active(b.p, 'T_005')!.counts.field).toBe(1)
  })

  it('useItem: range, the encounter (hpMul, one per group, despawn, cooldown, re-summon), GM spawn cap unaffected, after-gated kill and drop', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.accept(p, inbox, 'T_005')
    const use = (now = Date.now()) => h.act(p, inbox, { t: 'questUseItem', quest: 'T_005', objective: 'bell' }, now)
    // the kill before the bell does not count
    h.kill([p], BOSS.code)
    expect(h.active(p, 'T_005')!.counts.boss).toBe(0)
    expect(use()).toMatchObject({ ok: false, reason: 'wrong_place' })
    h.world.warp(p, -100, 0, 5)
    const t0 = Date.now()
    expect(use(t0)).toMatchObject({ ok: true })
    expect(h.updates(inbox, 'T_005').at(-1)).toMatchObject({ event: 'objective', objective: 'bell', progress: { counts: { bell: 1 }, items: [{ code: 'QITEM_BELL', count: 1 }] } })
    const bosses = [...h.world.mobs.values()].filter((m) => m.encounter)
    expect(bosses).toHaveLength(1)
    const boss = bosses[0]
    expect(boss.maxHp).toBe(500)
    expect(boss.encounter).toMatchObject({ quest: 'T_005', owners: new Set([p.characterId]), despawnAt: t0 + 60_000 })
    expect(Math.hypot(boss.pos[0] + 100, boss.pos[2] - 5)).toBeLessThanOrEqual(8.01)
    expect(h.engine.progress(p, h.active(p, 'T_005')!).encounterUntil).toBe(t0 + 60_000)
    // a second use while it lives
    expect(use(t0 + 1000)).toMatchObject({ ok: false, reason: 'cooldown', message: 'It is already here.' })
    // GM spawn still has its whole budget (encounter mobs do not count)
    const alive = [...h.world.mobs.values()].filter((m) => m.nest === null && !m.encounter && m.ai !== 'dead').length
    expect(alive).toBeLessThan(GM_SPAWN_TOTAL_MAX)
    // despawn unkilled -> cooldown 30 s -> summon again
    h.engine.tick(t0 + 60_000)
    expect(h.world.mobs.has(boss.id)).toBe(false)
    expect(h.engine.encounters.all()).toHaveLength(0)
    expect(use(t0 + 70_000)).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(use(t0 + 91_000)).toMatchObject({ ok: true })
    const again = [...h.world.mobs.values()].find((m) => m.encounter && m.ai !== 'dead')!
    // killing it: the after-gated kill and the 100 % seal drop count now
    again.damage.set(p.id, 10)
    h.gameplay.mobDied(again, t0 + 92_000, true)
    expect(h.active(p, 'T_005')!.counts).toMatchObject({ bell: 1, boss: 1, seal: 1 })
    expect(h.engine.encounters.all()).toHaveLength(0)
    // all done except the field: no re-summon needed... the bell stays usable while something is open
    h.world.warp(p, 100, 0, 0)
    h.gameplay.tick(t0 + 93_000)
    expect(h.active(p, 'T_005')!.status).toBe('ready')
    h.world.warp(p, -100, 0, 0)
    expect(use(t0 + 200_000)).toMatchObject({ ok: false, reason: 'not_found' })
    wire(inbox)
  })

  it('useItem of a party quest completes for party members within 60 m; the encounter belongs to the whole group', () => {
    const h = harness()
    const a = h.enter()
    const b = h.enter()
    const far = h.enter()
    for (const x of [a, b, far]) h.accept(x.p, x.inbox, 'T_005')
    const party = h.gameplay.party as unknown as { sameParty: (x: Player, y: Player) => boolean }
    party.sameParty = (x, y) => x !== y
    h.world.warp(a.p, -100, 0, 0)
    h.world.warp(b.p, -95, 0, 5)
    h.world.warp(far.p, 100, 0, 0)
    expect(h.act(a.p, a.inbox, { t: 'questUseItem', quest: 'T_005', objective: 'bell' })).toMatchObject({ ok: true })
    expect(h.active(b.p, 'T_005')!.counts.bell).toBe(1)
    expect(h.active(far.p, 'T_005')!.counts.bell).toBe(0)
    const boss = [...h.world.mobs.values()].find((m) => m.encounter)!
    expect([...boss.encounter!.owners].sort()).toEqual([a.p.characterId, b.p.characterId, far.p.characterId].sort())
    // b is in the group: its own bell cannot summon a second one
    expect(h.act(b.p, b.inbox, { t: 'questUseItem', quest: 'T_005', objective: 'bell' })).toMatchObject({ ok: false, reason: 'cooldown' })
    h.world.warp(far.p, -100, 0, 0)
    expect(h.act(far.p, far.inbox, { t: 'questUseItem', quest: 'T_005', objective: 'bell' })).toMatchObject({ ok: false, reason: 'cooldown' })
  })
})

describe('turn-in', () => {
  it('one transaction: EXP (gain.quest), SP as SP-EXP, gold, items; the message order; persisted', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.accept(p, inbox, 'T_001')
    inbox.length = 0
    expect(h.turnIn(p, inbox, 'T_001')).toMatchObject({ ok: true })
    expect(inbox.map((m) => m.t).filter((t) => t !== 'warp')).toEqual(['actionResult', 'questUpdate', 'inventoryUpdate', 'statsDelta', 'statsDelta'])
    expect(h.updates(inbox).at(-1)).toMatchObject({ event: 'completed', progress: null, done: { quest: 'T_001', times: 1 } })
    const gain = inbox.filter((m): m is Msg<'statsDelta'> => m.t === 'statsDelta').find((m) => m.gain)!
    expect(gain.gain).toEqual({ exp: 20, spExp: CHARACTER_RULES.spExpPerSp, quest: 'T_001' })
    expect(p.progress).toMatchObject({ exp: 20, sp: 1 })
    expect(p.gold).toBe(100)
    expect(h.bagCount(p, HERB)).toBe(5)
    expect(h.store.characterById(p.characterId)).toMatchObject({ exp: 20, sp: 1, gold: 100 })
    expect(h.rows('SELECT quest, times FROM quest_done WHERE character_id = ?', p.characterId)).toEqual([{ quest: 'T_001', times: 1 }])
    expect(h.rows('SELECT * FROM quest_state WHERE character_id = ?', p.characterId)).toEqual([])
    wire(inbox)
  })

  it('reasons: wrong NPC, not_complete, choice_required, invalid_slot; inventory_full changes nothing', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.accept(p, inbox, 'T_001')
    const gate = h.npcs.get('NPC_T_GATE')!.id
    h.at(p, 'NPC_T_GATE')
    expect(h.act(p, inbox, { t: 'questTurnIn', npc: gate, quest: 'T_001' })).toMatchObject({ ok: false, reason: 'not_found' })
    h.turnIn(p, inbox, 'T_001')
    h.accept(p, inbox, 'T_002')
    expect(h.turnIn(p, inbox, 'T_002')).toMatchObject({ ok: false, reason: 'not_complete' })
    for (let i = 0; i < 3; i++) h.kill([p])
    expect(h.turnIn(p, inbox, 'T_002')).toMatchObject({ ok: false, reason: 'choice_required' })
    expect(h.turnIn(p, inbox, 'T_002', 2)).toMatchObject({ ok: false, reason: 'invalid_slot' })
    // fill the bag
    const bagSize = h.store.loadInventory(p.characterId).bagSize
    h.give(p, 'ITEM_CH_RING_01_A', bagSize - h.store.loadInventory(p.characterId).bag.filter(Boolean).length)
    const before = { inv: JSON.stringify(h.store.loadInventory(p.characterId)), prog: { ...p.progress }, row: h.store.characterById(p.characterId) }
    expect(h.turnIn(p, inbox, 'T_002', 1)).toMatchObject({ ok: false, reason: 'inventory_full' })
    expect(JSON.stringify(h.store.loadInventory(p.characterId))).toBe(before.inv)
    expect(p.progress).toEqual(before.prog)
    expect(h.store.characterById(p.characterId)).toEqual(before.row)
    expect(h.active(p, 'T_002')!.status).toBe('ready')
    expect(h.rows('SELECT quest FROM quest_done WHERE character_id = ?', p.characterId)).toEqual([{ quest: 'T_001' }])
    // make room: the chosen shield arrives
    const slot = h.store.loadInventory(p.characterId).bag.findIndex((i) => i?.code === 'ITEM_CH_RING_01_A')
    h.act(p, inbox, { t: 'itemDrop', bag: slot })
    expect(h.turnIn(p, inbox, 'T_002', 1)).toMatchObject({ ok: true })
    expect(h.bagCount(p, 'ITEM_CH_SHIELD_01_A')).toBe(1)
    expect(h.bagCount(p, 'ITEM_CH_BLADE_02_A')).toBe(0)
  })

  it('{G}/{ARMOR}: a woman in protector gear gets the W LIGHT piece; a man with a heavy outfit and no chest, M HEAVY', () => {
    const h = harness()
    const w = h.enter({ model: 'CHAR_CH_WOMAN_ADVENTURER' })
    h.give(w.p, 'ITEM_CH_W_LIGHT_01_BA_A', 1)
    const slot = h.store.loadInventory(w.p.characterId).bag.findIndex((i) => i?.code === 'ITEM_CH_W_LIGHT_01_BA_A')
    expect(h.act(w.p, w.inbox, { t: 'itemEquip', bag: slot })).toMatchObject({ ok: true })
    h.accept(w.p, w.inbox, 'T_006')
    expect(h.turnIn(w.p, w.inbox, 'T_006')).toMatchObject({ ok: true })
    expect(h.bagCount(w.p, 'ITEM_CH_W_LIGHT_01_BA_A')).toBe(1)
    const m = h.enter({ outfit: 'heavy' })
    const inv = h.store.loadInventory(m.p.characterId)
    expect(inv.equip.chest).toBeUndefined()
    h.accept(m.p, m.inbox, 'T_006')
    h.turnIn(m.p, m.inbox, 'T_006')
    expect(h.bagCount(m.p, 'ITEM_CH_M_HEAVY_01_BA_A')).toBe(1)
    expect(rewardItems(h.engine.book.quest('T_006')!, { gender: 'female', armor: 'CLOTHES' })).toEqual([{ code: 'ITEM_CH_W_CLOTHES_01_BA_A', count: 1 }])
  })

  it('at the level cap quest EXP becomes SP-EXP (QUEST_CAP_EXP_TO_SPEXP); off: it is lost', () => {
    expect(turnInGain(QFILE.quests[1], 3, 3, () => 0)).toEqual({ exp: 0, spExp: 50 + 2 * CHARACTER_RULES.spExpPerSp })
    // off: the EXP goes to gainExp, which discards it at the cap
    expect(turnInGain(QFILE.quests[1], 3, 3, () => 0, false)).toEqual({ exp: 50, spExp: 2 * CHARACTER_RULES.spExpPerSp })
    expect(turnInGain(QFILE.quests[1], 2, 3, () => 0)).toEqual({ exp: 50, spExp: 2 * CHARACTER_RULES.spExpPerSp })
    const h = harness({ levelCap: 5 })
    const { p, inbox } = h.enter()
    h.gameplay.gmSetLevel(p, 5)
    h.accept(p, inbox, 'T_001')
    inbox.length = 0
    h.turnIn(p, inbox, 'T_001')
    const gain = inbox.find((m): m is Msg<'statsDelta'> => m.t === 'statsDelta' && !!m.gain)!
    expect(gain.gain).toEqual({ exp: 0, spExp: 20 + CHARACTER_RULES.spExpPerSp, quest: 'T_001' })
    // 10 SP from gmSetLevel(5) (typical SP of level 5, progression.ts) + 1 from the quest
    expect(p.progress).toMatchObject({ level: 5, exp: 0, sp: 11, spExp: 20 })
  })
})

describe('repeatables, abandon, persistence, content', () => {
  it('daily: available again after the next 04:00 (server local time); availableAt is sent', () => {
    const at = (h: number, day = 10) => new Date(2026, 8, day, h, 30).getTime()
    expect(nextDailyReset(at(3), 4)).toBe(new Date(2026, 8, 10, 4, 0).getTime())
    expect(nextDailyReset(at(5), 4)).toBe(new Date(2026, 8, 11, 4, 0).getTime())
    expect(nextDailyReset(new Date(2026, 8, 10, 4, 0).getTime(), 4)).toBe(new Date(2026, 8, 11, 4, 0).getTime())
    const h = harness()
    const { p, inbox } = h.enter()
    const t1 = at(22)
    h.accept(p, inbox, 'T_R01', t1)
    h.kill([p])
    expect(h.turnIn(p, inbox, 'T_R01', undefined, t1)).toMatchObject({ ok: true })
    const done = h.updates(inbox, 'T_R01').at(-1)!.done!
    expect(done).toEqual({ quest: 'T_R01', times: 1, lastAt: t1, availableAt: new Date(2026, 8, 11, 4, 0).getTime() })
    expect(h.accept(p, inbox, 'T_R01', at(3, 11))).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(h.accept(p, inbox, 'T_R01', at(4, 11))).toMatchObject({ ok: true })
    h.kill([p])
    // repeatables pay a percentage of the level's EXP (10 % of expToNext at the current level)
    inbox.length = 0
    const pct = Math.floor(0.1 * h.data.expToNext(p.progress.level, 20))
    expect(pct).toBeGreaterThan(0)
    h.turnIn(p, inbox, 'T_R01', undefined, at(5, 11))
    expect(inbox.find((m): m is Msg<'statsDelta'> => m.t === 'statsDelta' && !!m.gain)!.gain).toMatchObject({ exp: pct, quest: 'T_R01' })
    expect(h.rows('SELECT times FROM quest_done WHERE character_id = ? AND quest = ?', p.characterId, 'T_R01')).toEqual([{ times: 2 }])
  })

  it('abandon removes the state and the quest items (also while dead) and despawns an encounter only this player owns', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.accept(p, inbox, 'T_005')
    h.world.warp(p, -100, 0, 0)
    h.act(p, inbox, { t: 'questUseItem', quest: 'T_005', objective: 'bell' })
    const boss = [...h.world.mobs.values()].find((m) => m.encounter)!
    h.gameplay.gmKill(p)
    expect(h.act(p, inbox, { t: 'questAbandon', quest: 'T_005' })).toMatchObject({ ok: true })
    expect(h.updates(inbox, 'T_005').at(-1)).toMatchObject({ event: 'abandoned', progress: null })
    expect(h.world.mobs.has(boss.id)).toBe(false)
    expect(h.rows('SELECT * FROM quest_items WHERE character_id = ?', p.characterId)).toEqual([])
    expect(h.rows('SELECT * FROM quest_state WHERE character_id = ?', p.characterId)).toEqual([])
    expect(h.act(p, inbox, { t: 'questAbandon', quest: 'T_005' })).toMatchObject({ ok: false, reason: 'not_found' })
    // a main quest can be taken again
    h.gameplay.gmHeal(p)
    expect(h.accept(p, inbox, 'T_005')).toMatchObject({ ok: true })
  })

  it('enter sends quests after skills; the log survives a relog; npcDialog offers quest topics', () => {
    const h = harness()
    const a = h.enter()
    expect(a.inbox.map((m) => m.t)).toEqual(['stats', 'inventory', 'skills', 'quests'])
    expect(a.inbox[3]).toMatchObject({ t: 'quests', active: [], done: [], rev: h.engine.book.rev })
    // topics: T_001 offered at the gate; nothing at the potion NPC yet
    expect(h.engine.hasTopics(a.p, 'NPC_T_GATE')).toBe(true)
    expect(h.engine.hasTopics(a.p, 'NPC_T_POTION')).toBe(false)
    h.accept(a.p, a.inbox, 'T_004')
    expect(h.engine.hasTopics(a.p, 'NPC_T_POTION')).toBe(true) // deliver topic
    h.at(a.p, 'NPC_T_POTION')
    h.gameplay.request(a.p, { t: 'npcTalk', npc: h.npcs.get('NPC_T_POTION')!.id }, Date.now())
    expect(a.inbox.filter((m) => m.t === 'npcDialog').at(-1)).toMatchObject({ services: ['quest'] })
    h.accept(a.p, a.inbox, 'T_001')
    h.turnIn(a.p, a.inbox, 'T_001')
    const id = a.p.characterId
    h.leave(a.p)
    const b = h.enter({ characterId: id })
    const snap = b.inbox.find((m): m is Msg<'quests'> => m.t === 'quests')!
    expect(snap.active.map((q) => q.quest)).toEqual(['T_004'])
    expect(snap.active[0]).toMatchObject({ status: 'active', items: [{ code: 'QITEM_LETTER', count: 1 }] })
    expect(snap.done).toEqual([{ quest: 'T_001', times: 1, lastAt: expect.any(Number) }])
    wire(b.inbox)
  })

  it('hot reload: a re-mapped quest keeps its matching counts (clamped), drops the rest, recomputes status; contentChanged to all', () => {
    const h = harness()
    const { p, inbox } = h.enter()
    h.accept(p, inbox, 'T_001')
    h.turnIn(p, inbox, 'T_001')
    h.accept(p, inbox, 'T_002')
    h.kill([p])
    h.kill([p])
    h.accept(p, inbox, 'T_004')
    const book = h.engine.book
    const t2 = { ...book.quest('T_002')!, rev: 1, objectives: [{ id: 'pests', type: 'kill' as const, mobs: [MANG], count: 1 }, { id: 'extra', type: 'kill' as const, mobs: [MANG], count: 5 }] }
    const t4 = { ...book.quest('T_004')!, rev: 1, giveOnAccept: [], objectives: [{ id: 'gate', type: 'talk' as const, npc: 'NPC_T_GATE', text: 'Hi.' }] }
    book.replace({ ...QFILE, id: 'edits', items: [], locations: [], quests: [t2, t4] }, 'edits.json')
    inbox.length = 0
    h.engine.setContent()
    const changed = h.updates(inbox)
    expect(changed.map((u) => [u.quest, u.event])).toEqual([['T_002', 'changed'], ['T_004', 'changed']])
    expect(changed[0].progress).toMatchObject({ rev: 1, status: 'active', counts: { pests: 1, extra: 0 } })
    expect(changed[1].progress).toMatchObject({ rev: 1, counts: { gate: 0 }, items: [] })
    expect(inbox.at(-1)).toEqual({ t: 'contentChanged', kind: 'quests', rev: book.rev })
    expect(h.rows('SELECT rev, counts FROM quest_state WHERE character_id = ? AND quest = ?', p.characterId, 'T_002')).toEqual([{ rev: 1, counts: '{"pests":1,"extra":0}' }])
    // a disabled quest stays in the log: it can be abandoned, not turned in or progressed
    book.replace({ ...QFILE, id: 'edits', items: [], locations: [], quests: [{ ...t2, disabled: true }] }, 'edits.json')
    h.engine.setContent()
    h.kill([p])
    expect(h.active(p, 'T_002')!.counts.extra).toBe(0)
    expect(h.turnIn(p, inbox, 'T_002')).toMatchObject({ ok: false, reason: 'not_found' })
    expect(h.act(p, inbox, { t: 'questAbandon', quest: 'T_002' })).toMatchObject({ ok: true })
    wire(inbox)
  })
})

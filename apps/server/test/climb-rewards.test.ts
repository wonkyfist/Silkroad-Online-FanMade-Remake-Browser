/**
 * The Climb's rewards and the high country (docs/CLIMB.md §2.7, §4.2, §5.1, §7.3; layers L2 and L7): migration 22
 * (Pioneer for every live character), the titles (a boss ten times, the cap, Deathless; worn with `climbTitle`, shown
 * as EntityState.honor), the set bonuses (the mod provider), the Arts (`climbArt`: the free first pick, the paid change,
 * the mastery gate, the cast-time row) and the high country's area and warning lines.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { CLIMB_ART_RESPEC_GOLD, CLIMB_BANDS, type ClientMessage, type GameplayRequest, type ItemDef, type ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { highCountryLines } from '../src/climb/places.ts'
import { DEATHS_COUNTER } from '../src/climb/rewards.ts'
import { migrate, openStore } from '../src/db.ts'
import { GameData } from '../src/gamedata.ts'
import { addGold } from '../src/inventory.ts'
import type { Mob, Player } from '../src/world.ts'
import { item } from './fixtures.ts'
import { DUMMY, SAFE_TOWN, SKILL_ITEMS, skillHarness } from './skills-fixtures.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})
type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const armour = (slot: ItemDef['slot'], degree: number) => item(`ITEM_CH_M_HEAVY_0${degree}_${String(slot).toUpperCase()}_A`, { category: 'armor', slot, degree, reqLevel: 1, race: 'china' })
const SLOTS = ['head', 'shoulders', 'chest', 'legs', 'hands', 'feet'] as const
const ARMOUR = SLOTS.map((s) => armour(s, 3))
const LEVELS25 = Array.from({ length: 25 }, (_, i) => ({ level: i + 1, exp: 1000 * (i + 1), masterySp: 1 }))

function boot() {
  const data = new GameData({ mobs: [DUMMY], items: [...SKILL_ITEMS, ...ARMOUR], levels: LEVELS25, towns: [SAFE_TOWN] })
  const h = skillHarness({ data, config: { climb: true, levelCap: 25 } })
  cleanups.push(h.cleanup)
  h.gameplay.start(h.now)
  const r = h.gameplay.climbRewards!
  const req = (p: Player, msg: ClientMessage) => h.gameplay.request(p, msg as Extract<ClientMessage, { t: GameplayRequest }>, h.now)
  const climb = (inbox: ServerMessage[]) => (h.all(inbox, 'climb') as Msg<'climb'>[]).at(-1)
  const kill = (p: Player, code: string) => r.mobDied({ def: { code } } as unknown as Mob, h.now, new Set([p.id]), { player: p, party: null, damage: new Map() })
  return { h, r, req, climb, kill }
}

describe('migration 22', () => {
  it('adds title, arts and char_achievements; every live character of the time is a Pioneer (at time 0)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sro-m22-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const raw = new Database(join(dir, 'game.db'))
    expect(migrate(raw, 21)).toBe(21)
    raw.prepare("INSERT INTO accounts (id, username, password_hash, created_at) VALUES (1, 'old', 'x', 0)").run()
    const add = raw.prepare("INSERT INTO characters (account_id, name, model, weapon, world, created_at, deleted_at) VALUES (1, ?, 'CHAR_CH_MAN_ADVENTURER', 'sword', 'jangan', 0, ?)")
    add.run('Veteran', null)
    add.run('Gone', 5)
    raw.close()
    const store = openStore(dir)
    cleanups.push(() => store.close())
    expect(store.schemaVersion).toBe(27)
    expect(store.db.prepare('SELECT c.name, h.at FROM pilot_honors h JOIN characters c ON c.id = h.character_id WHERE h.code = ?').all('pioneer')).toEqual([{ name: 'Veteran', at: 0 }])
    expect(store.db.prepare('SELECT title, arts FROM characters WHERE name = ?').get('Veteran')).toEqual({ title: null, arts: '{}' })
  })
})

describe('titles (§7.3)', () => {
  it('ten kills of a mini-boss earn its title (credited players only); it becomes the shown title', () => {
    const { h, r, climb, kill } = boot()
    const { p, inbox } = h.hero({ level: 10 })
    for (let i = 0; i < 9; i++) kill(p, 'MOB_CL_OLDSCAR_6')
    expect(climb(inbox)!.titles).toEqual([])
    expect(climb(inbox)!.progress.scar_breaker).toBe(9)
    kill(p, 'MOB_CL_OLDSCAR_6')
    expect(climb(inbox)!.titles).toEqual(['scar_breaker'])
    expect((h.all(inbox, 'chat') as Msg<'chat'>[]).some((c) => c.text === 'You earned the title "Scar-Breaker".')).toBe(true)
    expect((h.all(inbox, 'entityUpdate') as Msg<'entityUpdate'>[]).some((u) => u.id === p.id && u.honor === 'scar_breaker')).toBe(true)
    expect(h.store.db.prepare('SELECT code FROM pilot_honors WHERE character_id = ?').all(p.characterId)).toEqual([{ code: 'scar_breaker' }])
    // a kill of anything else counts nothing
    kill(p, 'MOB_CH_DUMMY')
    expect(r.arts(p)).toEqual([])
  })

  it('Climber and Deathless at the cap; a penalised death blocks Deathless; climbTitle wears a held title only', () => {
    const { h, req, climb, kill } = boot()
    const a = h.hero({ level: 25, name: 'Capped' })
    expect(climb(a.inbox)!.titles.sort()).toEqual(['climber', 'deathless'])
    const b = h.hero({ level: 24, name: 'Fallen' })
    h.gameplay.penalty.onTaken.forEach((fn) => fn(b.p, 100, {} as Mob))
    expect(h.store.db.prepare('SELECT progress FROM char_achievements WHERE character_id = ? AND id = ?').get(b.p.characterId, DEATHS_COUNTER)).toEqual({ progress: 1 })
    b.p.level = b.p.progress.level = 25
    kill(b.p, 'MOB_CH_DUMMY')
    expect(climb(b.inbox)!.titles).toEqual(['climber'])
    // wear: an unknown title is refused, a held one is worn and saved
    req(a.p, { t: 'climbTitle', code: 'canyon_breaker' })
    expect(h.result(a.inbox, 'climbTitle')).toMatchObject({ ok: false })
    req(a.p, { t: 'climbTitle', code: 'climber' })
    expect(h.result(a.inbox, 'climbTitle')).toMatchObject({ ok: true })
    expect(climb(a.inbox)!.title).toBe('climber')
    expect(h.store.db.prepare('SELECT title FROM characters WHERE id = ?').get(a.p.characterId)).toEqual({ title: 'climber' })
  })
})

describe('set bonuses (§4.2)', () => {
  it('4 armour pieces of one degree: +3 % max HP; 6: +5 % and +3 % defence', () => {
    const { h } = boot()
    const bare = h.hero({ level: 10 }).p
    const four = h.hero({ level: 10, wear: ARMOUR.slice(0, 4).map((a) => a.code) }).p
    const six = h.hero({ level: 10, wear: ARMOUR.map((a) => a.code) }).p
    for (const p of [bare, four, six]) h.gameplay.refresh(p)
    expect(four.maxHp).toBe(Math.round(bare.maxHp * 1.03))
    expect(six.maxHp).toBe(Math.round(bare.maxHp * 1.05))
    expect(h.gameplay.skills.modsFor(six).physDefencePct).toBe(3)
  })
})

describe('Arts (§5.1)', () => {
  it('a tier needs its mastery; the first pick is free and changes the cast row; a change costs gold', () => {
    const { h, r, req, climb } = boot()
    const { p, inbox } = h.hero({ level: 20 })
    req(p, { t: 'climbArt', tree: 'BICHEON', tier: 10, art: 'heavy_smash' })
    expect(h.result(inbox, 'climbArt')).toMatchObject({ ok: false, reason: 'requirements' })
    h.learn(p, ['SKILL_CH_SWORD_SMASH_A_01'], 10)
    req(p, { t: 'climbArt', tree: 'BICHEON', tier: 15, art: 'long_reach' })
    expect(h.result(inbox, 'climbArt')).toMatchObject({ ok: false, reason: 'requirements' })
    req(p, { t: 'climbArt', tree: 'BICHEON', tier: 10, art: 'wide_bite' })
    expect(h.result(inbox, 'climbArt')).toMatchObject({ ok: false, reason: 'not_found' })
    req(p, { t: 'climbArt', tree: 'BICHEON', tier: 10, art: 'heavy_smash' })
    expect(h.result(inbox, 'climbArt')).toMatchObject({ ok: true })
    expect(climb(inbox)!.arts).toEqual({ 'BICHEON:10': 'heavy_smash' })
    expect(r.arts(p).map((a) => a.id)).toEqual(['heavy_smash'])
    const d = h.dummy(1, 0)
    const plan = h.gameplay.skills.plan(p, 'SKILL_CH_SWORD_SMASH_A_01', d.id, h.now)
    expect(plan.ok && plan.value.row.cooldownMs).toBe(4000)
    expect(plan.ok && plan.value.row.damage!.physPct).toBe(188)
    // a change costs 10,000 gold at tier 10
    req(p, { t: 'climbArt', tree: 'BICHEON', tier: 10, art: 'swift_smash' })
    expect(h.result(inbox, 'climbArt')).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    h.store.inventoryTx(p.characterId, (x) => addGold(x, CLIMB_ART_RESPEC_GOLD + 5))
    req(p, { t: 'climbArt', tree: 'BICHEON', tier: 10, art: 'swift_smash' })
    expect(h.result(inbox, 'climbArt')).toMatchObject({ ok: true })
    expect(h.store.loadInventory(p.characterId).gold).toBe(5)
    expect(JSON.parse((h.store.db.prepare('SELECT arts FROM characters WHERE id = ?').get(p.characterId) as { arts: string }).arts)).toEqual({ 'BICHEON:10': 'swift_smash' })
  })
})

describe('the high country (§2.7)', () => {
  it('the area line names the band; below its first level the warning follows', () => {
    const b7 = CLIMB_BANDS.find((b) => b.id === 'B7')!
    const b8 = CLIMB_BANDS.find((b) => b.id === 'B8')!
    expect(highCountryLines(b7, 19)).toEqual(['You enter the Ferry Heights (levels 19–23).'])
    expect(highCountryLines(b7, 18)[1]).toBe('The Ferry Heights are no place for the green, traveller.')
    expect(highCountryLines(b8, 21)[1]).toBe('The Sea Cliffs are no place for the green, traveller.')
  })

  it('walking into the Sea Cliffs shows the lines once per visit (not for where one logged in)', () => {
    const { h } = boot()
    // region (157, 91) is the Sea Cliffs: put it under the test world's origin
    ;(h.gameplay.setup as { regionOrigin: { ox: number; oz: number } | null }).regionOrigin = { ox: 157, oz: 91 }
    const { p, inbox } = h.hero({ pos: [-300, 0, 0], level: 15 })
    const lines = () => (h.all(inbox, 'chat') as Msg<'chat'>[]).map((c) => c.text).filter((t) => /Sea Cliffs/.test(t))
    h.runTo(h.now + 1100)
    expect(lines()).toEqual([])
    h.world.warp(p, 20, 0, -20, h.now)
    h.runTo(h.now + 1100)
    expect(lines()).toEqual(['You enter the Sea Cliffs (levels 22–25).', 'The Sea Cliffs are no place for the green, traveller.'])
    h.runTo(h.now + 3000)
    expect(lines()).toHaveLength(2)
  })
})

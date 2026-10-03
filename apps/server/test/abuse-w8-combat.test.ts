/**
 * Wave 8 adversarial hunt, lens "combat & items" (docs/WAVE_PLAN2.md §6.8, docs/SYSTEMS_COMBAT.md §8 H6): horses,
 * monster skills, durability/repair, alchemy and Berserk poked at their edges. Tests named "BUG" prove a problem (they
 * fail on the current code); the rest are guards on edges the code gets right today. Synthetic worlds with a hand
 * clock (npc-harness.ts, skills-fixtures.ts).
 */
import type { CosDef, ItemDef, MobDef, ServerMessage, SkillDef } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerConfig } from '../src/config.ts'
import { CORPSE_MS } from '../src/formulas.ts'
import { GameData } from '../src/gamedata.ts'
import { SkillBook } from '../src/skills/book.ts'
import type { Cos, Player } from '../src/world.ts'
import { LEVELS, MANGNYANG, item, mob } from './fixtures.ts'
import { NPC_DEFS, NPC_ITEMS, SHOP_DEFS, npcHarness, type NpcHarness } from './npc-harness.ts'
import { DUMMY, MASTERIES, SAFE_TOWN, SKILLS, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

// ---- shared fixtures -----------------------------------------------------------------------------------------------

const RED: CosDef = {
  code: 'COS_C_HORSE1', id: 2191, name: 'Red Horse', level: 20, hp: 983, walkSpeed: 4.5, runSpeed: 9, radius: 1.2,
  physAbsorb: 20, magAbsorb: 20, parryRate: 65, hitRate: 65, model: null, icon: null,
}
const HORSE = item('ITEM_COS_C_HORSE1', { category: 'scroll', maxStack: 50, reqLevel: 10, price: 1200, sellPrice: 360, use: { summon: 'COS_C_HORSE1' } })

const ELIXIR_RATES = [25, 20, 15, 10, 10, 10, 10, 10, 10, 5, 5, 5]
const POWDER_RATES = [50, 30, 20, 8, 8, 8, 8, 8, 8, 8, 8, 8]
const SWORD = item('ITEM_CH_SWORD_01_A', {
  category: 'weapon', slot: 'weapon', weaponType: 'sword', degree: 1, reqLevel: 1, race: 'china', typeId: [3, 1, 6, 2], range: 1.5,
  stats: { physAttack: [20, 30], magAttack: [10, 14], durability: [62, 76] }, perPlus: { physAttack: 2.4, magAttack: 4.1 },
  canRepair: true, repairCost: 198,
})
const E_WEAPON = item('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A', { category: 'alchemy', typeId: [3, 3, 10, 1], degree: 1, maxStack: 1, price: 50000, reinforce: { kind: 'elixir', targets: [6], rates: ELIXIR_RATES } })
const P1 = item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01', { category: 'alchemy', typeId: [3, 3, 10, 2], degree: 1, maxStack: 50, reinforce: { kind: 'powder', degree: 1, rates: POWDER_RATES } })
const RING = item('ITEM_CH_RING_01_A', { category: 'accessory', slot: 'ring', typeId: [3, 1, 5, 3], degree: 1, reqLevel: 1, stats: { physDefence: [1, 1] } })

/** Far from town (0,0,0) and from every NPC of npc-harness. */
const FIELD: [number, number, number] = [200, 0, 200]

const npcHarnesses: NpcHarness[] = []
type SH = ReturnType<typeof skillHarness>
const skillHarnesses: SH[] = []
afterEach(() => {
  while (npcHarnesses.length) npcHarnesses.pop()!.close()
  while (skillHarnesses.length) skillHarnesses.pop()!.cleanup()
})

/** npc-harness world with horses, alchemy items and the Red Horse def; the clock ticked once so Gameplay.now follows it. */
function world(config: Partial<ServerConfig> = {}) {
  // The harness's armour trader doubles as the Blacksmith here (the 'repair' role).
  const npcs = NPC_DEFS.map((n) => (n.code === 'NPC_CH_ARMOR' ? { ...n, roles: ['shop', 'repair'] as NonNullable<typeof n.roles> } : n))
  const data = new GameData({ mobs: [MANGNYANG], items: [...NPC_ITEMS, HORSE, SWORD, E_WEAPON, P1, RING], levels: LEVELS, drops: [], npcs, shops: SHOP_DEFS, towns: [] })
  const h = npcHarness({ data, config })
  npcHarnesses.push(h)
  h.gameplay.mounts.defs.set(RED.code, RED)
  h.advance(50)
  const g = h.gameplay
  const rider = (pos: [number, number, number] = FIELD, level = 10) => {
    const e = h.enter(pos)
    e.p.progress = { ...e.p.progress, level }
    const horse = h.give(e.p, HORSE.code, 5)
    return { ...e, horse }
  }
  const horseOf = (p: Player): Cos => {
    const c = g.mounts.horseOf(p)
    if (!c) throw new Error('no horse')
    return c
  }
  return { h, g, rider, horseOf }
}

// ---- horses ----------------------------------------------------------------------------------------------------------

describe('horses', () => {
  it('BUG: a GM who is invisible still shows its horse (and its entity id as owner/rider) to ordinary players', () => {
    const { h, g, horseOf } = world()
    const gm = h.enter(FIELD)
    gm.p.staff = true
    gm.p.progress = { ...gm.p.progress, level: 20 }
    const viewer = h.enter([FIELD[0] + 5, 0, FIELD[2]])
    g.world.setInvisible(gm.p, true)
    h.advance(100)
    expect(viewer.p.known.has(gm.p.id)).toBe(false)
    expect(g.mounts.gm(gm.p, [])).toMatchObject({ ok: true })
    const c = horseOf(gm.p)
    h.advance(500)
    // The GM rides around invisibly, but the horse under it is spawned for everyone, with owner and rider = the GM's
    // hidden entity id; the client then draws a riderless horse walking wherever the GM goes.
    const leaked = viewer.inbox.filter((m) => (m.t === 'spawn' && m.entity.id === c.id) || (m.t === 'entityUpdate' && m.id === c.id))
    expect(viewer.p.known.has(c.id), 'the invisible GM\'s horse is spawned for a non-staff viewer').toBe(false)
    expect(leaked, 'messages about the invisible GM\'s horse reach a non-staff viewer').toEqual([])
    // W8C-2 fix: the horse follows the GM's visibility and the viewer's staff flag, both ways.
    g.world.setStaff(viewer.p, true)
    expect(viewer.p.known.has(c.id), 'staff see the invisible GM\'s horse').toBe(true)
    g.world.setStaff(viewer.p, false)
    expect(viewer.p.known.has(c.id)).toBe(false)
    g.world.setInvisible(gm.p, false)
    expect([viewer.p.known.has(gm.p.id), viewer.p.known.has(c.id)], 'the GM and its horse reappear together').toEqual([true, true])
    g.world.setInvisible(gm.p, true)
    expect([viewer.p.known.has(gm.p.id), viewer.p.known.has(c.id)], 'and vanish together').toEqual([false, false])
  })

  it('BUG: with a legal COS_COMBAT_LOCK_MS below CORPSE_MS, a new summon orphans the dead horse (a corpse that never despawns)', () => {
    const { h, g, rider, horseOf } = world({ cosCombatLockMs: 0 })
    const { p, inbox, horse } = rider()
    const viewer = h.enter([FIELD[0] + 5, 0, FIELD[2]])
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: true })
    const first = horseOf(p)
    const m = g.createMob(MANGNYANG, 'normal', FIELD[0] + 1, FIELD[2], 0, null, h.now())
    // The horse dies under its rider.
    g.dealHits(m, p, [{ outcome: 'hit', damage: 5000, hp: 0 }], {}, h.now())
    expect(first.diedAt).toBeGreaterThan(0)
    // Right away (inside CORPSE_MS) a second Red Horse: accepted (the lockout is 0), and it replaces the corpse in the
    // module's map, so Mounts.tick never removes the corpse.
    h.advance(50)
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: true })
    h.advance(CORPSE_MS + 2000)
    expect([...g.world.cos.keys()], 'the first horse\'s corpse is still an entity after CORPSE_MS').not.toContain(first.id)
    expect(viewer.inbox.some((x) => x.t === 'despawn' && x.id === first.id), 'viewers never get the corpse\'s despawn').toBe(true)
  })

  it('guard: moveTo then mountDismount in the same tick is refused `moving`; a DoT tick on a rider hits the rider, not the horse', () => {
    const { h, g, rider, horseOf } = world()
    const { p, inbox, horse } = rider()
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: true })
    const c = horseOf(p)
    expect(g.onMoveTo(p, h.now())).toBe(true)
    g.world.moveTo(p, FIELD[0] + 30, FIELD[2], h.now())
    expect(h.req(p, inbox, { t: 'mountDismount' })).toMatchObject({ ok: false, reason: 'moving' })
    expect(g.mounts.ridden(p)).toBe(c)
    const m = g.createMob(MANGNYANG, 'normal', FIELD[0] + 1, FIELD[2], 0, null, h.now())
    const hp = p.hp
    g.dealHits(m, p, [{ outcome: 'hit', damage: 3, hp: 0 }], { dot: true }, h.now())
    expect(p.hp).toBe(hp - 3)
    expect(c.hp).toBe(RED.hp)
    // A direct hit goes to the horse.
    g.dealHits(m, p, [{ outcome: 'hit', damage: 7, hp: 0 }], {}, h.now())
    expect(c.hp).toBe(RED.hp - 7)
    expect(p.hp).toBe(hp - 3)
  })

  it('guard: a dead horse never takes a redirected hit; the rider is back on foot and takes it', () => {
    const { h, g, rider, horseOf } = world()
    const { p, inbox, horse } = rider()
    p.maxHp = p.hp = 100_000
    expect(h.req(p, inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: true })
    const c = horseOf(p)
    const m = g.createMob(MANGNYANG, 'normal', FIELD[0] + 1, FIELD[2], 0, null, h.now())
    const r = g.dealHits(m, p, [{ outcome: 'hit', damage: 5000, hp: 0 }, { outcome: 'hit', damage: 5000, hp: 0 }], {}, h.now())
    expect(r).toMatchObject({ killed: true, dealt: RED.hp })
    expect(c.diedAt).toBeGreaterThan(0)
    expect(g.mounts.ridden(p)).toBeNull()
    const before = p.hp
    g.dealHits(m, p, [{ outcome: 'hit', damage: 11, hp: 0 }], {}, h.now())
    expect(p.hp).toBe(before - 11)
  })
})

// ---- durability and repair -------------------------------------------------------------------------------------------

/** The skill fixtures' worn items with a Copper-Sword-like durability roll (durability.test.ts DUR_ITEMS). */
const DUR_ITEMS: ItemDef[] = SKILL_ITEMS.map((i) =>
  i.category === 'weapon' || i.category === 'shield' || i.category === 'armor'
    ? { ...i, canRepair: true, repairCost: 198, stats: { ...i.stats, durability: [62, 76] } }
    : i,
)

function durWorld(knobs: Partial<ServerConfig> = {}) {
  const h = skillHarness({ data: new GameData({ mobs: [DUMMY], items: DUR_ITEMS, levels: SKILL_LEVELS, towns: [SAFE_TOWN] }) })
  Object.assign(h.config, knobs)
  skillHarnesses.push(h)
  return h
}

describe('durability', () => {
  it('BUG: a chain skill keeps running its next segments after its first segment broke the weapon', () => {
    const h = durWorld({ durWeaponLossPct: 100 })
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, ['SKILL_CH_SWORD_CHAIN_A_1S_01'])
    // One point left: the first landed hit of segment 1 breaks the sword.
    h.gameplay.durability.gm(p, ['weapon', '1'])
    const t0 = h.now
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_CHAIN_A_1S_01', target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    h.runTo(t0 + 3000)
    expect(h.store.loadInventory(p.characterId).equip.weapon?.durability).toBe(0)
    // A broken weapon refuses every row that needs a weapon (§3.2), but finish() only re-checks the weapon *type*
    // (gear) before a chain segment, so segments 2 and 3 still start and land with the broken sword.
    const skills = h.all(inbox, 'combat').filter((c) => c.attacker === p.id).map((c) => c.skill)
    expect(skills, 'chain segments after the break').toEqual(['SKILL_CH_SWORD_CHAIN_A_1S_01'])
  })

  it('guard: an auto-attack loop stops at the next swing once the weapon broke; attack is refused `broken`', () => {
    const h = durWorld({ durWeaponLossPct: 100 })
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 1.5)
    h.gameplay.durability.gm(p, ['weapon', '1'])
    h.req(p, { t: 'attack', target: m.id })
    expect(h.result(inbox, 'attack')).toMatchObject({ ok: true })
    h.runTo(h.now + 5000)
    const swings = h.all(inbox, 'combat').filter((c) => c.attacker === p.id)
    expect(swings).toHaveLength(1)
    expect(p.action).toBeNull()
    h.req(p, { t: 'attack', target: m.id })
    expect(h.result(inbox, 'attack')).toMatchObject({ ok: false, reason: 'broken' })
  })
})

describe('repair', () => {
  function smith() {
    const w = world()
    return { ...w, npc: w.h.npcByCode('NPC_CH_ARMOR') }
  }

  it('guard: the same slot named twice (and as bag + bag) is repaired and paid once; a ring alone is nothing_to_repair', () => {
    const { h, npc } = smith()
    const { p, inbox } = h.enter([npc.pos[0] + 2, 0, npc.pos[2]], 1000)
    const sword = h.give(p, SWORD.code, 1, { durability: 0 })
    const ring = h.give(p, RING.code, 1)
    expect(h.req(p, inbox, { t: 'repair', npc: npc.id, items: [{ bag: sword }, { bag: sword }, { bag: sword }] })).toMatchObject({ ok: true })
    expect(h.bag(p)[sword]?.durability ?? null).toBeNull()
    expect(h.store.loadInventory(p.characterId).gold).toBe(1000 - 198)
    // Repair all with only the ring and full items left: nothing to do, no gold taken.
    const ringOnly = h.enter([npc.pos[0] + 2, 0, npc.pos[2] + 1], 1000)
    h.give(ringOnly.p, RING.code, 1)
    expect(h.req(ringOnly.p, ringOnly.inbox, { t: 'repair', npc: npc.id })).toMatchObject({ ok: false, reason: 'nothing_to_repair' })
    expect(h.req(p, inbox, { t: 'repair', npc: npc.id, items: [{ bag: ring }] })).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(h.store.loadInventory(ringOnly.p.characterId).gold).toBe(1000)
  })
})

// ---- alchemy ---------------------------------------------------------------------------------------------------------

describe('alchemy', () => {
  function kit(config: Partial<ServerConfig> = {}) {
    const w = world({ alchemyFuseMs: 3000, ...config })
    const r = w.rider()
    const sword = w.h.give(r.p, SWORD.code, 1)
    const el = w.h.give(r.p, E_WEAPON.code, 1)
    const pw = w.h.give(r.p, P1.code, 5)
    return { ...w, ...r, sword, el, pw }
  }

  it('BUG: summoning a horse mid-fuse mounts the player and the fuse still completes on horseback (D43 says no alchemy while mounted)', () => {
    const { h, g, p, inbox, horse, sword, el, pw } = kit()
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: pw })).toMatchObject({ ok: true })
    // The horse item is not in the fuse's soft lock (FUSE_LOCKED) and mounting is not a canceller.
    const summoned = h.req(p, inbox, { t: 'itemUse', bag: horse }).ok
    const fusingWhileMounted = summoned && g.mounts.ridden(p) !== null && g.alchemy.fusing(p) !== null
    h.advance(3100)
    const done = h.of(inbox, 'alchemyResult').at(-1)
    expect(fusingWhileMounted, 'a fuse keeps running after the player mounted').toBe(false)
    // With the summon refused `busy`, the fuse finishes normally on foot: only a result while riding is the bug.
    expect((done?.outcome === 'success' || done?.outcome === 'fail') && g.mounts.ridden(p) !== null, 'the fuse finished while riding').toBe(false)
  })

  it('guard: the same bag index twice is invalid_slot; a swap of the item mid-fuse is refused busy; ALCHEMY_RATE 10 clamps to 100 %', () => {
    const { h, g, p, inbox, sword, el, pw } = kit({ alchemyRate: 10 })
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: sword })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: el })).toMatchObject({ ok: false, reason: 'invalid_slot' })
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: pw })).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'itemMove', from: sword, to: 40 })).toMatchObject({ ok: false, reason: 'busy' })
    expect(h.req(p, inbox, { t: 'itemEquip', bag: sword })).toMatchObject({ ok: false, reason: 'busy' })
    h.advance(3100)
    expect(h.of(inbox, 'alchemyResult').at(-1)).toMatchObject({ outcome: 'success', plus: 1 })
    expect(g.alchemy.fusing(p)).toBeNull()
  })

  it('guard: death and a GM warp mid-fuse cancel it and consume nothing; logout drops it', () => {
    const { h, g, p, inbox, sword, el, pw } = kit()
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: pw })).toMatchObject({ ok: true })
    g.gmKill(p, h.now())
    expect(h.of(inbox, 'alchemyResult').at(-1)).toMatchObject({ outcome: 'cancelled' })
    expect(h.countOf(p, E_WEAPON.code)).toBe(1)
    expect(h.countOf(p, P1.code)).toBe(5)
  })
})

// ---- Berserk ---------------------------------------------------------------------------------------------------------

describe('Berserk', () => {
  it('guard: a dead player is refused; death ends a running Berserk; kills while berserk add no points; relog keeps saved points', () => {
    const { h, g } = world()
    const { p, inbox } = h.enter(FIELD)
    expect(g.berserk.gm(p, ['5'])).toMatchObject({ ok: true })
    expect(h.req(p, inbox, { t: 'berserk' })).toMatchObject({ ok: true })
    expect(g.berserk.active(p)).toBe(true)
    // Kill credit while berserk: nothing.
    const m = g.createMob({ ...MANGNYANG, rarity: 'unique' } as MobDef, 'unique', FIELD[0] + 1, FIELD[2], 0, null, h.now())
    g.berserk.mobDied(m, h.now(), new Set([p.id]))
    expect(g.berserk.points(p)).toBe(0)
    g.gmKill(p, h.now())
    expect(g.berserk.active(p)).toBe(false)
    expect(h.req(p, inbox, { t: 'berserk' })).toMatchObject({ ok: false, reason: 'dead' })
    expect(g.berserk.gm(p, ['4'])).toMatchObject({ ok: true })
    g.forget(p)
    expect(h.store.hwanPoints(p.characterId)).toBe(4)
    expect(g.berserk.points(p)).toBe(4)
  })
})

// ---- monster skills --------------------------------------------------------------------------------------------------

describe('monster skills', () => {
  const enemy = { required: true, groups: ['enemy_mob', 'enemy_player'] } as SkillDef['targets']
  const mrow = (code: string, o: Partial<SkillDef>): SkillDef =>
    ({
      code, id: 1, name: null, mastery: null, masteryLevel: 0, skillLevel: 1, sp: 0, mp: 0, category: 'melee', castMs: 0, actionMs: 0, cooldownMs: 0,
      range: 0, weapons: [], icon: null, group: code, kind: 'attack', targets: enemy, aniGroup: 'DEFAULT', mob: true, aiChance: 100, ...o,
    }) as SkillDef
  const ROWS: SkillDef[] = [
    mrow('MSKILL_CH_TIGERWOMAN_ATTACK01', { castMs: 1109, actionMs: 1391, cooldownMs: 3000, range: 2.8, damage: { physPct: 100, magPct: 0, flat: [181, 217], hits: 2 } }),
    mrow('MSKILL_CH_TIGERWOMAN_SUMMON01', {
      kind: 'buff', category: 'buff', cooldownMs: 500, aiChance: 80, targets: { required: false, groups: [] },
      summon: [{ mob: 'MOB_CH_WHITETIGER', rarity: 0, min: 6, max: 6 }],
    }),
  ]
  const still = { walkSpeed: 0, runSpeed: 0 }
  const MOBS: MobDef[] = [
    mob('MOB_CH_WHITETIGER', { level: 18, physAttack: [120, 143], attackRange: 0.9, attackIntervalMs: 1500, radius: 1.2, ...still }),
    mob('MOB_CH_TIGERWOMAN', { level: 20, rarity: 'unique', hp: 10_000, physAttack: [181, 217], attackRange: 2.8, attackIntervalMs: 3000, radius: 2.8, skills: ROWS.map((r) => r.code), ...still }),
  ]

  function mobWorld(config: Partial<ServerConfig> = {}) {
    const data = new GameData({ mobs: [DUMMY, ...MOBS], items: SKILL_ITEMS, levels: SKILL_LEVELS, towns: [SAFE_TOWN] })
    const h = skillHarness({ data, book: new SkillBook([...SKILLS, ...ROWS], MASTERIES), rng: () => 0.5 })
    Object.assign(h.config, config)
    skillHarnesses.push(h)
    h.runTo(h.now + 50)
    const spawn = (code: string, x: number, z: number) => h.gameplay.createMob(h.data.mob(code)!, h.data.mob(code)!.rarity === 'unique' ? 'unique' : 'normal', x, z, 0, null, h.now)
    return { h, spawn }
  }
  const tigers = (h: SH) => [...h.world.mobs.values()].filter((m) => m.def.code === 'MOB_CH_WHITETIGER' && m.ai !== 'dead').length

  it('BUG: summons never despawn with their summoner, so MOB_SUMMON_CAP stops bounding them once she dies and respawns', () => {
    const { h, spawn } = mobWorld({ mobSummons: 1, mobSummonCap: 6 })
    const first = spawn('MOB_CH_TIGERWOMAN', 0, 0)
    first.hp = first.maxHp * 0.7
    h.runTo(h.now + 100)
    expect(tigers(h)).toBe(6)
    // She dies (or her quest encounter ends); her nest / encounter brings a new one, who is hurt the same way.
    h.gameplay.gmKill(first, h.now)
    h.runTo(h.now + CORPSE_MS + 200)
    expect(h.world.mobs.has(first.id)).toBe(false)
    const second = spawn('MOB_CH_TIGERWOMAN', 0, 0)
    second.hp = second.maxHp * 0.7
    h.runTo(h.now + 100)
    // Nothing ever removes the first batch (nest-less GM-style mobs), so every summoner life adds another capful.
    expect(tigers(h), 'summoned tigers alive around one spot').toBeLessThanOrEqual(6)
  })

  it('guard: a mob that despawns mid-cast is dropped quietly; a stunned one sends castEnd interrupted', () => {
    const { h, spawn } = mobWorld()
    const r = h.hero({ pos: [0, 0, 1.5], level: 20 })
    r.p.maxHp = r.p.hp = 1_000_000
    const m = spawn('MOB_CH_TIGERWOMAN', 0, -2)
    h.gameplay.mobSkills.use(m, ROWS[0], r.p, h.now)
    expect(h.gameplay.mobSkills.busy(m, h.now)).toBe(true)
    h.world.removeEntity(m.id)
    expect(() => h.runTo(h.now + 2000)).not.toThrow()
    expect(h.all(r.inbox, 'combat').filter((c) => c.attacker === m.id)).toHaveLength(0)
    const m2 = spawn('MOB_CH_TIGERWOMAN', 0, -2)
    h.gameplay.mobSkills.use(m2, ROWS[0], r.p, h.now)
    h.gameplay.skills.effects.add({ instance: 999, carrier: m2.id, source: r.p.id, kind: 'status', status: 'stun', overlap: 0, mods: [], startedAt: h.now, until: h.now + 3000 })
    h.runTo(h.now + 1500)
    const ends = h.all(r.inbox, 'castEnd').filter((c: Msg<'castEnd'>) => c.id === m2.id)
    expect(ends.map((c) => c.reason)).toEqual(['interrupted'])
  })
})

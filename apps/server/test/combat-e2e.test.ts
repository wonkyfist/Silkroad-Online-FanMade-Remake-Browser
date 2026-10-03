/**
 * Wave 8 combat end to end (docs/SYSTEMS_COMBAT.md §8 I6, docs/WAVE_PLAN2.md §6.7) on the REAL jangan-fields export
 * (wave8-harness.ts): one bot's day with the new systems, over WebSockets, every frame checked by the shared parser.
 *
 *  1. horse: the Red Horse is refused at level 9 and summoned at 10 (the §12 message order); mounted runs ×1.8; the
 *     ridden horse warps with its rider toward the Tiger Mountain; a mounted attack is refused `mounted`; dismount
 *  2. a Black Tiger (MOB_CH_WHITETIGER_CLON) howl (ATTACK03, forced with /mobskill) lands on both players within 2 m
 *  3. durability: `/dur weapon 0` breaks the sword (attack refused `broken`, stats drop); Repair all at Chulsan brings
 *     it back (the price, the order, the stats)
 *  4. alchemy: an Elixir + a Lucky Powder take a Copper Sword to +2 (pinned rolls), each fuse consuming one of each
 *  5. Berserk: `/hwan 5` → `berserk` (the order), ×2 speed, hits carry `hwan` and roughly double, the end after
 *     HWAN_DURATION_MS (1.5 s here instead of 60 s) restores the speed
 *
 * Knobs: HWAN_DURATION_MS 1.5 s, ALCHEMY_FUSE_MS 0.2 s and MOB_DAMAGE_RATE 0.05 (so the howl never kills the bots).
 *
 * Skipped without the export.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CODES, FIELD, GATE, HAVE_W8, W8Harness, until, type Hero, type Msg } from './wave8-harness.ts'
import { sleep } from './helpers.ts'

describe.skipIf(!HAVE_W8)('wave 8 combat flows on WORLD_EXPORT=jangan-fields', () => {
  const h = new W8Harness('Cbt', { hwanDurationMs: 1500, alchemyFuseMs: 200, mobDamageRate: 0.05 })
  let a: Hero
  let b: Hero
  beforeAll(async () => {
    await h.start()
    a = await h.hero({ level: 9 })
    b = await h.hero({ level: 20 })
  }, 120_000)
  afterAll(async () => {
    await h.bye(...[a, b].filter(Boolean))
    await h.stop()
  })

  it('1. horse: level 10, the summon order, ×1.8 speed, warps along, mounted attacks refused, dismount', async () => {
    await h.tp(a, GATE[0], GATE[1])
    const bag = await h.give(a, CODES.horse, 2)
    expect(await h.act(a.c, { t: 'itemUse', bag })).toMatchObject({ ok: false, reason: 'requirements' })
    await h.gm(a.c, 'setlevel', a.name, '10')
    h.drain(a)
    const from = a.c.log.length
    expect(await h.act(a.c, { t: 'itemUse', bag })).toMatchObject({ ok: true })
    const spawn = await a.c.next('spawn', (m) => m.entity.kind === 'cos')
    const horse = spawn.entity.id
    expect(spawn.entity).toMatchObject({ kind: 'cos', owner: a.id, maxHp: 983 })
    await a.c.next('entityUpdate', (m) => m.id === a.id && m.mount === horse)
    await a.c.next('entityUpdate', (m) => m.id === horse && m.rider === a.id)
    const order = a.c.log.slice(from).map((m) => (m.t === 'entityUpdate' ? `eu:${m.id === a.id ? 'mount' : 'rider'}` : m.t)).filter((t) => ['actionResult', 'inventoryUpdate', 'spawn', 'eu:mount', 'eu:rider'].includes(t))
    expect(order).toEqual(['actionResult', 'inventoryUpdate', 'spawn', 'eu:mount', 'eu:rider'])
    expect(h.count(a.characterId, CODES.horse)).toBe(1)
    // A second horse while one is out.
    expect(await h.act(a.c, { t: 'itemUse', bag: h.slotOf(a.characterId, CODES.horse) })).toMatchObject({ ok: false, reason: 'cos_active' })

    // Mounted: ×1.8 (Red Horse run 9 / player 5) on the configured 30 m/s.
    a.c.send({ t: 'moveTo', x: GATE[0] + 12, z: GATE[1] })
    const mv = await a.c.next('move', (m) => m.id === a.id)
    expect(mv.move.speed).toBeCloseTo(30 * 1.8, 5)
    await a.c.next('stop', (m) => m.id === a.id, 3000).catch(() => undefined)

    // Toward the Tiger Mountain: the ridden horse warps with its rider (FIELD is outside the safe area).
    await h.tp(a, FIELD[0], FIELD[1])
    const c = h.s.ctx.world.cos.get(horse)!
    expect(c.rider).toBe(a.id)
    const p = h.player(a.id)
    expect(Math.hypot(c.pos[0] - p.pos[0], c.pos[2] - p.pos[2])).toBeLessThan(0.5)
    // Attacks and skills are refused while mounted.
    const r = await h.gm(a.c, 'spawn', CODES.mang, '1')
    const mang = (r.data as { ids: number[] }).ids[0]!
    expect(await h.act(a.c, { t: 'attack', target: mang })).toMatchObject({ ok: false, reason: 'mounted' })
    expect(await h.act(a.c, { t: 'sit', on: true })).toMatchObject({ ok: false, reason: 'mounted' })
    // Dismount: the pair of nulls; the horse stays parked.
    expect(await h.act(a.c, { t: 'mountDismount' })).toMatchObject({ ok: true })
    await a.c.next('entityUpdate', (m) => m.id === a.id && m.mount === null)
    await a.c.next('entityUpdate', (m) => m.id === horse && m.rider === null)
    expect(h.s.ctx.world.cos.get(horse)?.rider).toBeNull()
    // Kill the Mangyang on foot, then boarding is refused for 20 s after combat.
    h.s.ctx.world.mobs.get(mang)!.hp = 1
    h.pin(() => 0.999)
    try {
      expect(await h.act(a.c, { t: 'attack', target: mang })).toMatchObject({ ok: true })
      await a.c.next('combat', (m) => m.target === mang && m.killed === true, 10_000)
    } finally {
      h.pin(null)
    }
    expect(await h.act(a.c, { t: 'mountRide', cos: horse })).toMatchObject({ ok: false, reason: 'in_combat' })
    expect(await h.act(a.c, { t: 'mountDismiss' })).toMatchObject({ ok: true })
    await until(() => !h.s.ctx.world.cos.has(horse), 'the horse to go')
  }, 60_000)

  it('2. a Black Tiger howl lands on both players within 2 m (aoe on the second)', async () => {
    await h.gm(a.c, 'setlevel', a.name, '20')
    await h.tp(a, FIELD[0], FIELD[1] + 20)
    await h.tp(b, FIELD[0], FIELD[1] + 20)
    const r = await h.gm(a.c, 'spawn', CODES.blackTiger, '1')
    const tiger = (r.data as { ids: number[] }).ids[0]!
    const m = h.s.ctx.world.mobs.get(tiger)!
    const at = h.s.ctx.world.positionAt(m, Date.now())
    // Both stand on the tiger (well within the 2 m howl).
    await h.tp(a, at[0], at[2])
    await h.tp(b, at[0] + 0.5, at[2])
    await sleep(100)
    const HOWL = 'MSKILL_CH_WHITETIGER_CLON_ATTACK03'
    h.drain(a, b)
    h.pin(() => 0.5)
    try {
      const res = await h.gm(a.c, 'mobskill', String(tiger), 'attack03')
      expect(res.data).toMatchObject({ skill: HOWL })
      const cast = await a.c.next('cast', (x) => x.id === tiger && x.skill === HOWL, 5000)
      expect(cast.castMs).toBeGreaterThan(900)
      const onA = await a.c.next('combat', (x) => x.instance === cast.instance && x.target === a.id, 5000)
      const onB = await b.c.next('combat', (x) => x.instance === cast.instance && x.target === b.id, 5000)
      expect(onA.instance).toBe(cast.instance)
      expect(onB.instance).toBe(cast.instance)
      // The main target first, the rest flagged aoe.
      expect([onA.aoe ?? false, onB.aoe ?? false].sort()).toEqual([false, true])
    } finally {
      h.pin(null)
    }
    // Fight it: an attack on foot is accepted.
    expect(await h.act(a.c, { t: 'attack', target: tiger })).toMatchObject({ ok: true })
    await h.gm(a.c, 'kill', String(tiger)).catch(() => undefined)
    await h.act(a.c, { t: 'stopAction' })
  }, 60_000)

  it('3. durability: /dur weapon 0 breaks the sword; Repair all at Chulsan restores it', async () => {
    await h.tp(a, FIELD[0], FIELD[1])
    const before = h.g.stats(h.player(a.id)).physAttack
    h.drain(a)
    await h.gm(a.c, 'dur', 'weapon', '0')
    const broke = await a.c.next('stats')
    expect(broke.stats.physAttack[1]).toBeLessThan(before[1])
    expect(h.inv(a.characterId).equip.weapon?.durability).toBe(0)
    const r = await h.gm(a.c, 'spawn', CODES.mang, '1')
    const mang = (r.data as { ids: number[] }).ids[0]!
    expect(await h.act(a.c, { t: 'attack', target: mang })).toMatchObject({ ok: false, reason: 'broken' })
    await h.gm(a.c, 'kill', String(mang)).catch(() => undefined)

    const smith = h.npc(CODES.smith)
    await h.tp(a, smith.pos[0] + 1.5, smith.pos[2])
    await h.give(a, CODES.gold, 5000)
    const gold = h.inv(a.characterId).gold
    h.drain(a)
    const from = a.c.log.length
    expect(await h.act(a.c, { t: 'repair', npc: smith.id })).toMatchObject({ ok: true })
    const upd = await a.c.next('inventoryUpdate', (m) => m.equip !== undefined)
    const fixed = await a.c.next('stats')
    expect(a.c.log.slice(from).map((m) => m.t).filter((t) => ['actionResult', 'inventoryUpdate', 'stats'].includes(t))).toEqual(['actionResult', 'inventoryUpdate', 'stats'])
    expect(upd.gold).toBeLessThan(gold)
    const w = h.inv(a.characterId).equip.weapon!
    expect(w.durability == null || w.durability > 0).toBe(true)
    expect(fixed.stats.physAttack).toEqual(before)
    // Nothing left to repair.
    expect(await h.act(a.c, { t: 'repair', npc: smith.id })).toMatchObject({ ok: false, reason: 'nothing_to_repair' })
  }, 60_000)

  it('4. alchemy: a Copper Sword to +2, one elixir and one powder per fuse', async () => {
    const sword = await h.give(a, CODES.sword, 1)
    await h.give(a, CODES.elixir, 2)
    await h.give(a, CODES.powder, 2)
    h.pin(() => 0.001)
    try {
      for (const plus of [1, 2]) {
        const elixir = h.slotOf(a.characterId, CODES.elixir)
        const powder = h.slotOf(a.characterId, CODES.powder)
        expect(await h.act(a.c, { t: 'alchemyReinforce', item: sword, elixir, powder })).toMatchObject({ ok: true })
        const start = await a.c.next('alchemyStart')
        expect(start).toMatchObject({ item: sword, readyInMs: 200 })
        const res = await a.c.next('alchemyResult', () => true, 3000)
        expect(res).toMatchObject({ item: sword, code: CODES.sword, outcome: 'success', plus })
        expect(h.inv(a.characterId).bag[sword]).toMatchObject({ code: CODES.sword, plus })
      }
    } finally {
      h.pin(null)
    }
    expect(h.count(a.characterId, CODES.elixir)).toBe(0)
    expect(h.count(a.characterId, CODES.powder)).toBe(0)
    // Equipped, the +2 adds perPlus × 2 over a +0 of the same sword.
    const plain = h.g.stats(h.player(a.id)).physAttack
    h.drain(a)
    expect(await h.act(a.c, { t: 'itemEquip', bag: sword })).toMatchObject({ ok: true })
    await a.c.next('stats')
    const plus2 = h.g.stats(h.player(a.id)).physAttack
    expect(plus2[0]).toBeGreaterThan(0)
    expect(plain).not.toEqual(plus2)
  }, 60_000)

  it('5. Berserk: /hwan 5 → berserk (the order), ×2 speed, hwan hits roughly doubled, the end restores the speed', async () => {
    await h.tp(a, FIELD[0], FIELD[1])
    const p = h.player(a.id)
    const hit = async (): Promise<Msg<'combat'>> => {
      const r = await h.gm(a.c, 'spawn', CODES.mang, '1')
      const mang = (r.data as { ids: number[] }).ids[0]!
      const m = h.s.ctx.world.mobs.get(mang)!
      m.hp = m.maxHp = 100000
      await h.tp(a, m.pos[0] + 0.5, m.pos[2])
      h.pin(() => 0.5)
      try {
        expect(await h.act(a.c, { t: 'attack', target: mang })).toMatchObject({ ok: true })
        return await a.c.next('combat', (x) => x.attacker === a.id && x.target === mang && x.hits.some((y) => y.damage > 0), 5000)
      } finally {
        h.pin(null)
        await h.act(a.c, { t: 'stopAction' })
        await h.gm(a.c, 'kill', String(mang)).catch(() => undefined)
      }
    }
    const normal = await hit()
    expect(normal.hits.every((x) => x.hwan === undefined)).toBe(true)
    const speed = p.speedMul
    expect(await h.act(a.c, { t: 'berserk' })).toMatchObject({ ok: false, reason: 'berserk_not_ready' })
    await h.gm(a.c, 'hwan', '5')
    h.drain(a)
    const from = a.c.log.length
    expect(await h.act(a.c, { t: 'berserk' })).toMatchObject({ ok: true })
    await a.c.next('entityUpdate', (m) => m.id === a.id && (m.berserkMs ?? 0) > 0)
    await a.c.next('statsDelta', (m) => m.stats.hwan === 0)
    await a.c.next('stats')
    const order = a.c.log.slice(from).map((m) => m.t).filter((t) => ['actionResult', 'entityUpdate', 'statsDelta', 'stats'].includes(t))
    expect(order.slice(0, 4)).toEqual(['actionResult', 'entityUpdate', 'statsDelta', 'stats'])
    expect(p.speedMul).toBeCloseTo(speed * 2, 5)
    expect(await h.act(a.c, { t: 'berserk' })).toMatchObject({ ok: false, reason: 'berserk_active' })
    const mad = await hit()
    expect(mad.hits.every((x) => x.hwan === true)).toBe(true)
    const n = normal.hits.find((x) => x.damage > 0)!.damage
    const d = mad.hits.find((x) => x.damage > 0)!.damage
    expect(d / n).toBeGreaterThan(1.6)
    expect(d / n).toBeLessThan(2.4)
    // The end (HWAN_DURATION_MS = 1.5 s here): stats, then berserkMs 0; the speed is back.
    await a.c.next('entityUpdate', (m) => m.id === a.id && m.berserkMs === 0, 4000)
    expect(p.speedMul).toBeCloseTo(speed, 5)
    expect(h.g.stats(p).hwan).toBe(0)
  }, 60_000)
})

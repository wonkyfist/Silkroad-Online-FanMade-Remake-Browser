/**
 * Berserk (docs/SYSTEMS_COMBAT.md §5.2, docs/WAVE_PLAN2.md D34/D49; lane BZ): points per mob variant, no gain while
 * berserk, the `berserk` request and its message order, ×2 damage and speed through the mod provider, the end at the
 * timer / death / town, the late-viewer `berserkMs`, the GM command and the D34 cache (the first `stats` after a relog
 * carries the saved points). Synthetic NPC world with a controlled clock (npc-harness.ts).
 */
import { HWAN_MAX, type MobVariant, type ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { BERSERK_MODS, HWAN_KILL_POINTS } from '../src/berserk.ts'
import type { ServerConfig } from '../src/config.ts'
import { damageRoll, type CombatStats } from '../src/formulas.ts'
import type { Mob, Player } from '../src/world.ts'
import { MANGNYANG, seeded } from './fixtures.ts'
import { npcHarness, type NpcHarness } from './npc-harness.ts'

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})
function setup(config: Partial<ServerConfig> = {}) {
  const h = npcHarness({ config })
  harnesses.push(h)
  return h
}

/** Far from town (0,0,0) and from every NPC. */
const FIELD: [number, number, number] = [200, 0, 200]
const NEAR: [number, number, number] = [203, 0, 200]

function kill(h: NpcHarness, p: Player, variant: MobVariant = 'normal'): Mob {
  const m = h.gameplay.createMob(MANGNYANG, variant, FIELD[0] + 4, FIELD[2], 0, null, h.now())
  p.known.add(m.id)
  h.gameplay.dealHits(p, m, [{ outcome: 'hit', damage: 1e9, hp: 0 }], {}, h.now())
  expect(m.ai).toBe('dead')
  return m
}

const hwanDeltas = (inbox: ServerMessage[]) =>
  inbox.flatMap((m) => (m.t === 'statsDelta' && m.stats.hwan !== undefined ? [m.stats.hwan] : []))

function fill(h: NpcHarness, p: Player) {
  expect(h.gameplay.berserk.gm(p, [String(HWAN_MAX)])).toMatchObject({ ok: true })
  expect(h.gameplay.berserk.points(p)).toBe(HWAN_MAX)
}

describe('berserk points (gain)', () => {
  it('pays per variant: normal 1 (at 100 %), champion 1, giant/elite/party 2, unique fills', () => {
    expect(HWAN_KILL_POINTS).toMatchObject({ normal: 1, champion: 1, giant: 2, titan: 2, elite: 2, party: 2, unique: HWAN_MAX })
    const h = setup({ hwanKillPct: 100 })
    const { p, inbox } = h.enter(FIELD)
    kill(h, p, 'normal')
    expect(h.gameplay.berserk.points(p)).toBe(1)
    kill(h, p, 'champion')
    expect(h.gameplay.berserk.points(p)).toBe(2)
    kill(h, p, 'giant')
    expect(h.gameplay.berserk.points(p)).toBe(4)
    kill(h, p, 'elite')
    expect(h.gameplay.berserk.points(p)).toBe(HWAN_MAX) // capped at 5
    expect(hwanDeltas(inbox)).toEqual([1, 2, 4, 5])
    expect(h.store.hwanPoints(p.characterId)).toBe(HWAN_MAX) // saved
    kill(h, p, 'normal')
    expect(hwanDeltas(inbox)).toEqual([1, 2, 4, 5]) // full: nothing more

    const q = h.enter(NEAR)
    kill(h, q.p, 'unique')
    expect(h.gameplay.berserk.points(q.p)).toBe(HWAN_MAX)
  })

  it('a normal kill rolls HWAN_KILL_PCT: 0 % never gives a point', () => {
    const h = setup({ hwanKillPct: 0 })
    const { p } = h.enter(FIELD)
    for (let i = 0; i < 10; i++) kill(h, p, 'normal')
    expect(h.gameplay.berserk.points(p)).toBe(0)
    kill(h, p, 'champion') // the other variants do not roll
    expect(h.gameplay.berserk.points(p)).toBe(1)
  })

  it('the default 12 % gives roughly one point in eight normal kills', () => {
    const h = setup()
    const { p } = h.enter(FIELD)
    let got = 0
    for (let i = 0; i < 200; i++) {
      h.gameplay.berserk.gm(p, ['0'])
      kill(h, p, 'normal')
      got += h.gameplay.berserk.points(p)
    }
    expect(got).toBeGreaterThan(8)
    expect(got).toBeLessThan(45)
  })

  it('no gain while berserk, and a GM kill (rewards off) gives nothing', () => {
    const h = setup({ hwanKillPct: 100 })
    const { p, inbox } = h.enter(FIELD)
    fill(h, p)
    expect(h.req(p, inbox, { t: 'berserk' })).toMatchObject({ ok: true })
    kill(h, p, 'unique')
    expect(h.gameplay.berserk.points(p)).toBe(0)
    h.gameplay.berserk.end(p)
    const m = h.gameplay.createMob(MANGNYANG, 'unique', FIELD[0] + 4, FIELD[2], 0, null, h.now())
    m.damage.set(p.id, 1)
    h.gameplay.mobDied(m, h.now(), false)
    expect(h.gameplay.berserk.points(p)).toBe(0)
  })
})

describe('the berserk request', () => {
  it('below a full gauge: berserk_not_ready; while on: berserk_active; dead: dead', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    h.gameplay.berserk.gm(p, ['4'])
    expect(h.req(p, inbox, { t: 'berserk' })).toMatchObject({ ok: false, reason: 'berserk_not_ready' })
    expect(h.gameplay.berserk.points(p)).toBe(4)
    fill(h, p)
    expect(h.req(p, inbox, { t: 'berserk' })).toMatchObject({ ok: true })
    h.gameplay.berserk.gm(p, ['5'])
    expect(h.req(p, inbox, { t: 'berserk' })).toMatchObject({ ok: false, reason: 'berserk_active' })
    h.gameplay.berserk.end(p)
    h.gameplay.playerDied(p, h.now())
    expect(h.req(p, inbox, { t: 'berserk' })).toMatchObject({ ok: false, reason: 'dead' })
  })

  it('activation: actionResult → entityUpdate {berserkMs} to viewers → statsDelta {hwan: 0} → stats; points saved as 0', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const b = h.enter(NEAR)
    h.advance(250)
    expect(b.p.known.has(p.id)).toBe(true)
    fill(h, p)
    const from = inbox.length
    const seen = b.inbox.length
    expect(h.req(p, inbox, { t: 'berserk' })).toEqual({ t: 'actionResult', re: 'berserk', ok: true })
    const out = inbox.slice(from).map((m) => m.t)
    expect(out).toEqual(['actionResult', 'entityUpdate', 'statsDelta', 'stats'])
    expect(inbox[from + 1]).toEqual({ t: 'entityUpdate', id: p.id, berserkMs: 60_000 })
    expect(inbox[from + 2]).toEqual({ t: 'statsDelta', stats: { hwan: 0 } })
    expect(inbox.at(-1)).toMatchObject({ t: 'stats', stats: { hwan: 0 } })
    expect(b.inbox.slice(seen)).toContainEqual({ t: 'entityUpdate', id: p.id, berserkMs: 60_000 })
    expect(h.store.hwanPoints(p.characterId)).toBe(0)
    expect(h.gameplay.berserk.active(p)).toBe(true)
  })

  it('doubles a seeded hit (physDamagePct/magDamagePct +100) and the move speed', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const before = { ...p.combat }
    const speed = p.speedMul
    const target: CombatStats = { ...before, physDefence: 0, magDefence: 0, physAbsorb: 0, magAbsorb: 0, level: p.level }
    const base = damageRoll(before, target, 100, false, seeded(3))
    fill(h, p)
    h.req(p, inbox, { t: 'berserk' })
    expect(p.combat.physDamagePct).toBe((before.physDamagePct ?? 0) + 100)
    expect(p.combat.magDamagePct).toBe((before.magDamagePct ?? 0) + 100)
    const doubled = damageRoll(p.combat, target, 100, false, seeded(3))
    expect(Math.abs(doubled - 2 * base)).toBeLessThanOrEqual(1)
    expect(p.speedMul).toBeCloseTo(speed * 2)
    expect(BERSERK_MODS.map((m) => m.stat)).toEqual(['physDamagePct', 'magDamagePct', 'speedPct'])
  })
})

describe('the end', () => {
  it('ends at 60 s: mods off, stats, then entityUpdate {berserkMs: 0}', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    const speed = p.speedMul
    const pct = p.combat.physDamagePct ?? 0
    fill(h, p)
    h.req(p, inbox, { t: 'berserk' })
    h.advance(59_900)
    expect(h.gameplay.berserk.active(p)).toBe(true)
    const from = inbox.length
    h.advance(200)
    expect(h.gameplay.berserk.active(p)).toBe(false)
    expect(p.speedMul).toBeCloseTo(speed)
    expect(p.combat.physDamagePct ?? 0).toBe(pct)
    const tail = inbox.slice(from).filter((m) => m.t === 'stats' || (m.t === 'entityUpdate' && m.berserkMs !== undefined))
    expect(tail.map((m) => m.t)).toEqual(['stats', 'entityUpdate'])
    expect(tail[1]).toEqual({ t: 'entityUpdate', id: p.id, berserkMs: 0 })
  })

  it('HWAN_DURATION_MS sets the length', () => {
    const h = setup({ hwanDurationMs: 5000 })
    const { p, inbox } = h.enter(FIELD)
    fill(h, p)
    h.req(p, inbox, { t: 'berserk' })
    expect(inbox).toContainEqual({ t: 'entityUpdate', id: p.id, berserkMs: 5000 })
    h.advance(5100)
    expect(h.gameplay.berserk.active(p)).toBe(false)
  })

  it('ends at death and on a warp to town, not on a GM teleport', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    fill(h, p)
    h.req(p, inbox, { t: 'berserk' })
    const m = h.gameplay.createMob(MANGNYANG, 'normal', FIELD[0] + 2, FIELD[2], 0, null, h.now())
    h.gameplay.dealHits(m, p, [{ outcome: 'hit', damage: 1e9, hp: 0 }], {}, h.now())
    expect(p.dead).toBe(true)
    expect(h.gameplay.berserk.active(p)).toBe(false)
    expect(inbox).toContainEqual({ t: 'entityUpdate', id: p.id, berserkMs: 0 })

    const q = h.enter(NEAR)
    fill(h, q.p)
    h.req(q.p, q.inbox, { t: 'berserk' })
    h.gameplay.warped(q.p, 'gm', h.now())
    expect(h.gameplay.berserk.active(q.p)).toBe(true)
    h.gameplay.toTown(q.p)
    expect(h.gameplay.berserk.active(q.p)).toBe(false)
  })

  it('logout ends it; the relog is not berserk', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    fill(h, p)
    h.req(p, inbox, { t: 'berserk' })
    h.gameplay.forget(p)
    expect(h.gameplay.berserk.active(p)).toBe(false)
    expect(h.gameplay.berserk.remainingMs(p, h.now())).toBe(0)
  })
})

describe('late viewers, GM and D34', () => {
  it('EntityState.berserkMs carries the time left to a late viewer; absent when not berserk', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    expect(h.world.state(p).berserkMs).toBeUndefined()
    fill(h, p)
    h.req(p, inbox, { t: 'berserk' })
    h.advance(10_000)
    const late = h.enter(NEAR)
    const snap = h.world.snapshotFor(late.p, h.now()).find((e) => e.id === p.id)
    expect(snap?.berserkMs).toBeGreaterThan(49_000)
    expect(snap?.berserkMs).toBeLessThanOrEqual(50_000)
  })

  it('GM hwan: sets and saves 0..5 with statsDelta, rejects bad input, "stop" ends', () => {
    const h = setup()
    const { p, inbox } = h.enter(FIELD)
    expect(h.gameplay.berserk.gm(p, ['3'])).toMatchObject({ ok: true })
    expect(hwanDeltas(inbox)).toEqual([3])
    expect(h.store.hwanPoints(p.characterId)).toBe(3)
    for (const bad of [[], ['6'], ['-1'], ['x'], ['2.5']]) expect(h.gameplay.berserk.gm(p, bad)).toMatchObject({ ok: false })
    expect(h.gameplay.berserk.gm(p, ['stop'])).toMatchObject({ ok: false })
    fill(h, p)
    h.req(p, inbox, { t: 'berserk' })
    expect(h.gameplay.berserk.gm(p, ['stop'])).toMatchObject({ ok: true })
    expect(h.gameplay.berserk.active(p)).toBe(false)
  })

  it('D34: the first stats after a relog carries the saved points (read from the store, not from enter)', () => {
    const h = setup()
    const { p } = h.enter(FIELD)
    h.gameplay.berserk.gm(p, ['4'])
    h.gameplay.forget(p)
    h.world.remove(p.id, h.now())
    h.store.setHwanPoints(p.characterId, 3) // changed while offline: the cache must not answer
    const inbox: ServerMessage[] = []
    const again = h.world.add({ ...h.gameplay.playerInit(h.store.characterById(p.characterId)!), characterId: p.characterId, name: p.name, model: p.model, level: 1, weapon: p.weapon, pos: FIELD, yaw: 0, send: (m) => inbox.push(m) })
    h.gameplay.sendEnter(again, h.now())
    expect(inbox[0]).toMatchObject({ t: 'stats', stats: { hwan: 3 } })
  })
})

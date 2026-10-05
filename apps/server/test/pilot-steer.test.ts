/**
 * Play the Boss, layer 1 (docs/PLAY_THE_BOSS.md §3.2–§3.4, §8): steering Tiger Girl and her AI fallback, on the
 * in-process harness (a flat world, a hand-driven clock). `/unique pilot attach` links a player to her: the body rests
 * in a trance at the palace steps (never a target, locked), the pilot's interest follows her, its moveTo moves her at
 * her own speed inside the hunt circle (a safe area refused, held / busy dropped), 20 s idle hands her to the AI and any
 * input takes her back, a disconnect ends the turn; no regen and no refill while she is steered.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { clampToArea, rewardGold, steerSpeed } from '../src/pilot/steer.ts'
import { PALACE, pilotHarness, type PilotHarness } from './pilot-harness.ts'

let H: PilotHarness | null = null
afterEach(() => {
  H?.cleanup()
  H = null
})

function setup(o: Parameters<typeof pilotHarness>[0] = {}) {
  H = pilotHarness(o)
  const her = H.spawn()
  const pilotChar = H.player(150, 150, 'Pixi')
  const r = H.gm('attach', 'Pixi')
  expect(r.ok, r.message).toBe(true)
  return { ...H, m: her, pc: pilotChar }
}

describe('pure parts', () => {
  it('the circle clamps radially; points inside stay', () => {
    expect(clampToArea(10, 0, { x: 0, z: 0, r: 350 })).toEqual([10, 0])
    const [x, z] = clampToArea(500, 0, { x: 0, z: 0, r: 350 })
    expect(x).toBeCloseTo(350)
    expect(z).toBeCloseTo(0)
    const [a, b] = clampToArea(300, 400, { x: 0, z: 0, r: 100 })
    expect(Math.hypot(a, b)).toBeCloseTo(100)
    expect(a / b).toBeCloseTo(0.75)
  })
  it('the server picks her speed: run speed × setting × Stalk', () => {
    expect(steerSpeed({ runSpeed: 9, walkSpeed: 2 }, 1, null)).toBe(9)
    expect(steerSpeed({ runSpeed: 9, walkSpeed: 2 }, 1, 0.4)).toBeCloseTo(3.6)
    expect(steerSpeed({ runSpeed: 0, walkSpeed: 2 }, 1.5, null)).toBe(3)
  })
  it('rewards (§3.9): early loss ≈ 6,100, good loss ≈ 12,600, a win ≈ 24,500', () => {
    const r = { baseGold: 5000, perDownGold: 500, perMinuteGold: 300, winGold: 10_000 }
    expect(rewardGold(r, 1, 2 * 60_000, false)).toBe(6100)
    expect(rewardGold(r, 8, 12 * 60_000, false)).toBe(12_600)
    expect(rewardGold(r, 10, 15 * 60_000, true)).toBe(24_500)
  })
})

describe('the link and the trance (§3.2, §3.3)', () => {
  it('attach: the body rests at the palace steps in a trance, the view moves to her, pilotStart lists the kit', () => {
    const { h, m, pc, last } = setup()
    const p = pc.p
    expect(p.trance).toBe(true)
    expect(p.pos[0]).toBeCloseTo(PALACE.x)
    expect(p.pos[2]).toBeCloseTo(PALACE.z)
    expect(p.viewFrom).toBe(m.id)
    expect(p.known.has(m.id)).toBe(true)
    expect(m.pilot).toEqual({ player: p.id, steering: 'player' })
    const start = last(pc.inbox, 'pilotStart')!
    expect(start.mob).toBe(m.id)
    expect(start.event).toBe(0)
    expect(start.kit.map((k) => [k.slot, k.id])).toEqual([[1, 'claw'], [2, 'sweep'], [3, 'curse'], [4, 'pounce'], [5, 'roar'], [6, 'pack'], [7, 'stalk']])
    expect(start.kit.find((k) => k.id === 'sweep')!.target).toBe('none')
    expect(start.kit.find((k) => k.id === 'pounce')).toMatchObject({ target: 'point', clip: 'ATTACK1', rangeM: 12, cooldownMs: 12_000 })
    expect(start.kit.find((k) => k.id === 'pack')!.charges).toBe(2)
    expect(start.area).toEqual({ x: 0, z: 0, r: 350 })
    expect(start.place).toBe('palace-steps')
    // The world's state of both: the body's trance, her `piloted`.
    expect(h.world.state(p).trance).toBe(true)
    expect(h.world.state(m).piloted).toBe(true)
  })

  it('a hunter cannot hurt the body; mobs never target it; it refuses every request but stopAction (piloting)', () => {
    const { h, g, pc, req, result } = setup()
    const p = pc.p
    const hunter = H!.player(PALACE.x + 1, PALACE.z, 'Hunter')
    const hp = p.hp
    g.dealHits(hunter.p, p, [{ outcome: 'hit', damage: 500, hp: 0 }], {}, h.now)
    expect(p.hp).toBe(hp)
    expect(g.target(p.id)).toBeUndefined()
    req(p, { t: 'jump' })
    expect(result(pc.inbox, 'jump')).toMatchObject({ ok: false, reason: 'piloting' })
    req(p, { t: 'attack', target: hunter.p.id })
    expect(result(pc.inbox, 'attack')).toMatchObject({ ok: false, reason: 'piloting' })
    req(p, { t: 'stopAction' })
    expect(result(pc.inbox, 'stopAction')).toMatchObject({ ok: true })
    // Free chat (connection.ts) asks chatBlocked.
    expect(g.pilot!.chatBlocked(p)).toBe(true)
    expect(g.pilot!.chatBlocked(hunter.p)).toBe(false)
  })
})

describe('steering (§3.2)', () => {
  it("the pilot's moveTo moves her at her run speed for every viewer; the body stays", () => {
    const { h, m, pc, moveTo, last } = setup()
    const watcher = H!.player(m.pos[0] + 5, m.pos[2] + 5, 'Watcher')
    const before = [...pc.p.pos]
    const from = [...m.pos]
    moveTo(pc.p, m.pos[0] + 30, m.pos[2])
    expect(m.move).not.toBeNull()
    expect(m.move!.speed).toBe(9)
    expect(m.move!.to[0]).toBeCloseTo(from[0] + 30)
    expect(pc.p.pos).toEqual(before)
    expect(pc.p.move).toBeNull()
    expect(last(watcher.inbox, 'move')).toMatchObject({ id: m.id })
    expect(last(pc.inbox, 'move')).toMatchObject({ id: m.id })
    h.runTo(h.now + 2000)
    expect(h.world.positionAt(m, h.now)[0] - from[0]).toBeCloseTo(18, 0)
  })

  it('a target 500 m away is clamped to the hunt circle; a point in a safe area is refused', () => {
    const { m, pc, moveTo } = setup()
    moveTo(pc.p, 0, 499)
    expect(Math.hypot(m.move!.to[0], m.move!.to[2])).toBeCloseTo(350, 1)
    const before = m.move
    // The town's safe area (200,200 ±10) lies inside her circle: refused, her walk goes on.
    moveTo(pc.p, 200, 200)
    expect(m.move).toBe(before)
  })

  it('held (stun) or busy (a cast): the move is dropped silently', () => {
    const { h, g, m, pc, moveTo } = setup()
    g.skills.applyStatus(pc.p, m, { status: { status: 'stun', level: 99, chancePct: 100 }, row: g.skills.book.skill('MSKILL_CH_TIGERWOMAN_ATTACK01')! }, h.now)
    moveTo(pc.p, 20, 0)
    expect(m.move).toBeNull()
  })

  it('stopAction halts her', () => {
    const { m, pc, moveTo, req } = setup()
    moveTo(pc.p, 30, 0)
    expect(m.move).not.toBeNull()
    req(pc.p, { t: 'stopAction' })
    expect(m.move).toBeNull()
  })

  it('interest follows her: the pilot sees what is around her, not around the body', () => {
    const { h, m, pc, tick } = setup()
    const nearHer = H!.player(10, 0, 'NearHer')
    const nearBody = H!.player(PALACE.x - 2, PALACE.z, 'NearBody')
    tick(300)
    expect(pc.p.known.has(nearHer.p.id)).toBe(true)
    expect(pc.p.known.has(nearBody.p.id)).toBe(false)
    expect(pc.p.known.has(m.id)).toBe(true)
    // Others still see the body where it rests.
    expect(nearBody.p.known.has(pc.p.id)).toBe(true)
    expect(h.world.viewAnchor(pc.p)).toBe(m)
  })
})

describe('her AI fallback (§3.4)', () => {
  it('20 s without input: her AI steers (piloted false); any input takes her back', () => {
    const { h, m, pc, moveTo, tick, last } = setup()
    tick(14_000)
    expect(m.pilot!.steering).toBe('player')
    tick(2000)
    expect(last(pc.inbox, 'pilotState')!.idleWarnAt).toBeGreaterThan(h.now)
    tick(4500)
    expect(m.pilot!.steering).toBe('ai')
    expect(last(pc.inbox, 'pilotState')!.steering).toBe('ai')
    expect(h.all(pc.inbox, 'entityUpdate').some((u) => u.id === m.id && u.piloted === false)).toBe(true)
    moveTo(pc.p, 10, 10)
    expect(m.pilot!.steering).toBe('player')
    expect(last(pc.inbox, 'pilotState')!.steering).toBe('player')
  })

  it('under her AI she fights the top damage dealer inside the circle (thinkMob runs again)', () => {
    const { h, g, m, tick } = setup()
    const hunter = H!.player(3, 0, 'Hunter')
    g.dealHits(hunter.p, m, [{ outcome: 'hit', damage: 300, hp: 0 }], {}, h.now)
    tick(21_000)
    expect(m.pilot!.steering).toBe('ai')
    tick(4000)
    expect(m.target).toBe(hunter.p.id)
    expect(h.all(hunter.inbox, 'cast').some((c) => c.id === m.id)).toBe(true)
  })

  it('a non-pilot cannot act, taunt or quit (no_event); a GM kill of the body ends the turn', () => {
    const { h, g, m, pc, req, result } = setup()
    const other = H!.player(5, 5, 'Other')
    req(other.p, { t: 'pilotAct', ability: 'claw', target: pc.p.id })
    expect(result(other.inbox, 'pilotAct')).toMatchObject({ ok: false, reason: 'no_event' })
    req(other.p, { t: 'pilotTaunt', line: 1 })
    expect(result(other.inbox, 'pilotTaunt')).toMatchObject({ ok: false, reason: 'no_event' })
    req(other.p, { t: 'pilotQuit' })
    expect(result(other.inbox, 'pilotQuit')).toMatchObject({ ok: false, reason: 'no_event' })
    req(other.p, { t: 'pilotVolunteer', on: true })
    expect(result(other.inbox, 'pilotVolunteer')).toMatchObject({ ok: false, reason: 'no_event' })
    expect(g.pilot!.steer(other.p, 0, 0, h.now)).toBe(false)
    g.gmKill(pc.p, h.now)
    expect(g.pilot!.turn).toBeNull()
    expect(m.pilot).toBeUndefined()
    expect(pc.p.trance).toBeUndefined()
  })

  it('a disconnect ends the turn: her AI steers, the body is released', () => {
    const { h, g, m, pc } = setup()
    h.world.remove(pc.p.id, h.now)
    g.forget(pc.p)
    expect(m.pilot?.steering ?? 'none').not.toBe('player')
    expect(g.pilot!.turn).toBeNull()
  })

  it('no regen and no refill at home while she is steered; her normal rules come back on detach', () => {
    const { h, g, m, gm, tick } = setup()
    const hunter = H!.player(3, 0, 'Hunter')
    g.dealHits(hunter.p, m, [{ outcome: 'hit', damage: 5000, hp: 0 }], {}, h.now)
    const hp = m.hp
    tick(30_000)
    expect(m.hp).toBe(hp)
    g.restored(m)
    expect(m.hp).toBe(hp)
    expect(gm('detach').ok).toBe(true)
    expect(m.pilot).toBeUndefined()
    g.restored(m)
    expect(m.hp).toBe(m.maxHp)
  })
})

/**
 * Adversarial exploit hunt, lens = combat and skills (wave 3, SK-S). Each `describe('BUG ...')` block is a repro of a
 * real hole: it FAILS on the current code and its assertions describe the correct behaviour. The last block keeps the
 * attacks the engine already refuses as regression guards (they pass).
 *
 * Synthetic content and a hand-driven 20 Hz clock (skills-fixtures.ts), constant rng (every hit lands).
 */
import type { ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { Npc } from '../src/world.ts'
import { skillHarness } from './skills-fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const TICK = 50
const SMASH = 'SKILL_CH_SWORD_SMASH_A_01' // castMs 400, actionMs 1000, cooldown 3000, sword/blade
const GEOMGI = 'SKILL_CH_SWORD_GEOMGI_A_01' // castMs 300, actionMs 800, range 12, sword/blade
const HEAL = 'SKILL_CH_WATER_HEAL_A_01' // prepare 1000 + cast 1000, range 15, friendly

let h: ReturnType<typeof skillHarness>
afterEach(() => h?.cleanup())

function setup(o: Parameters<typeof skillHarness>[0] = {}) {
  h = skillHarness(o)
  return h
}

/** Runs tick by tick until `to`, calling `each` after every tick. */
function stepTo(to: number, each: () => void): void {
  while (h.now < to) {
    h.runTo(h.now + TICK)
    each()
  }
}

describe('BUG animation cancel: stopAction / moveTo after the release ends the action phase early', () => {
  // docs/SKILLS.md §5 step 4: "The action ends at t0 + preparingMs + castMs + actionMs. The caster cannot start
  // another action before that." and §10.1: "After release the action cannot be cancelled."
  // engine.ts interrupt() clears s.cast even after the release and resets nextSwingAt, so a client that sends
  // stopAction (or a 1 cm moveTo) right after each release skips every actionMs (SMASH real data: 411 ms cast,
  // 1022 ms action -> ~3x skill throughput).
  it('a second skill cannot start before the first one has ended, even after stopAction post-release', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, [SMASH, GEOMGI])
    const t0 = h.now
    h.req(p, { t: 'useSkill', skill: SMASH, target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    const endAt = t0 + 400 + 1000
    h.runTo(t0 + 450)
    expect(h.all(inbox, 'combat').some((c) => c.skill === SMASH)).toBe(true) // released
    h.req(p, { t: 'stopAction' })
    // Still inside SMASH's action phase: the engine must still count the caster as busy.
    expect(h.gameplay.skills.busy(p, h.now)).toBe(true)
    h.req(p, { t: 'useSkill', skill: GEOMGI, target: m.id })
    let secondCastAt = 0
    const check = () => {
      if (!secondCastAt && h.all(inbox, 'cast').some((c) => c.skill === GEOMGI)) secondCastAt = h.now
    }
    check()
    stepTo(endAt + 500, check)
    // Correct: GEOMGI starts (queued) no earlier than SMASH's end, not at t0 + 450.
    expect(secondCastAt, `GEOMGI cast at +${secondCastAt - t0} ms, SMASH ends at +${endAt - t0} ms`).toBeGreaterThanOrEqual(endAt - TICK)
  })

  it('a moveTo after the release does not reset the basic-attack timer inside the action phase', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, [SMASH])
    const t0 = h.now
    h.req(p, { t: 'useSkill', skill: SMASH, target: m.id })
    const endAt = t0 + 400 + 1000
    h.runTo(t0 + 450)
    // A zero-length move (the client clicks under its own feet), then auto-attack again.
    h.gameplay.onMoveTo(p, h.now)
    h.req(p, { t: 'attack', target: m.id })
    expect(h.result(inbox, 'attack')).toMatchObject({ ok: true })
    let basicAt = 0
    stepTo(endAt + 200, () => {
      if (!basicAt && h.all(inbox, 'combat').some((c) => c.skill === 'SKILL_CH_SWORD_BASE_01')) basicAt = h.now
    })
    expect(basicAt, 'a basic swing landed').toBeGreaterThan(0)
    // Correct: the first basic swing after the skill comes when SMASH's action phase is over.
    expect(basicAt, `basic swing at +${basicAt - t0} ms, SMASH ends at +${endAt - t0} ms`).toBeGreaterThanOrEqual(endAt - TICK)
  })
})

describe('BUG casting while walking: an npcTalk walk moves the caster without interrupting the skill', () => {
  // Only Gameplay.onMoveTo fires the `moved` hook. npcTalk sets p.action = talk and NpcDialogs.tickPlayer walks the
  // player with world.moveEntity, so a skill in its prepare/cast phase keeps charging while the caster walks away
  // (kiting with charged bow shots, walking heals, ...). docs/SKILLS.md §5: moving before the release interrupts.
  it('walking before the release interrupts the cast (castEnd interrupted, no skill combat)', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    const npc: Npc = { kind: 'npc', id: h.world.newId(), code: 'NPC_CH_TEST', name: 'Tester', pos: [-20, 0, 0], yaw: 0 }
    h.world.addEntity(npc, h.now)
    expect(p.known.has(npc.id)).toBe(true)
    h.learn(p, [SMASH])
    const t0 = h.now
    const start = h.world.positionAt(p, t0)
    h.req(p, { t: 'useSkill', skill: SMASH, target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    h.req(p, { t: 'npcTalk', npc: npc.id })
    expect(h.result(inbox, 'npcTalk')).toMatchObject({ ok: true })
    h.runTo(t0 + 350) // still before SMASH's release at t0 + 400
    const at = h.world.positionAt(p, h.now)
    const walked = Math.hypot(at[0] - start[0], at[2] - start[2])
    h.runTo(t0 + 600)
    const landed = h.all(inbox, 'combat').some((c) => c.skill === SMASH)
    const interrupted = h.all(inbox, 'castEnd').some((c) => c.reason === 'interrupted')
    // Correct: either the talk walk waits for the action, or the walk interrupts the cast. Never both walk and land.
    expect({ walked: walked > 0.3, landed }, `walked ${walked.toFixed(2)} m before the release`).not.toEqual({ walked: true, landed: true })
    if (walked > 0.3) expect(interrupted).toBe(true)
  })
})

describe('BUG weapon requirement only checked at plan time: swap weapons mid-cast', () => {
  // SkillEngine.requirement() runs in plan() only. itemEquip / itemUnequip are not refused while a skill action runs
  // and do not interrupt it, so a sword skill releases with a spear (or bare hands) in the hand and the damage uses
  // that weapon's combat stats; chain segments after the first are never re-checked either.
  it('a sword skill does not land after the sword was replaced by a spear before the release', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, [SMASH])
    const spear = h.data.item('ITEM_CH_SPEAR_01_A_DEF')!
    expect(h.gameplay.gmItem(p, spear, spear.code, 1).ok).toBe(true)
    const bag = h.store.loadInventory(p.characterId).bag.findIndex((i) => i?.code === spear.code)
    expect(bag).toBeGreaterThanOrEqual(0)
    const t0 = h.now
    h.req(p, { t: 'useSkill', skill: SMASH, target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    h.runTo(t0 + 100)
    h.req(p, { t: 'itemEquip', bag, slot: 'weapon' })
    const equipped = h.result(inbox, 'itemEquip')?.ok === true
    let weaponAtRelease: string | null = null
    stepTo(t0 + 600, () => {
      if (weaponAtRelease === null && h.all(inbox, 'combat').some((c) => c.skill === SMASH)) weaponAtRelease = p.combat.weapon
    })
    // Correct: either the swap is refused while the skill runs, or it interrupts the skill. A SMASH hit may only
    // land with a sword or blade in hand.
    if (weaponAtRelease !== null) expect(['sword', 'blade'], `SMASH landed with a ${weaponAtRelease} (swap ok: ${equipped})`).toContain(weaponAtRelease)
  })
})

describe('BUG friendly skills land at any distance: the heal target warps away during the cast', () => {
  // resolveTarget/begin check reach only at t0; release() looks the target up by id with no known / reach check
  // (unlike the chain's CHAIN_SLACK_M check), so a 2 s heal lands on a player who has since warped across the map.
  it('the heal ends target_lost when the target is no longer in reach at the release', () => {
    setup()
    const { p: healer, inbox } = h.hero({ level: 10 })
    const { p: friend } = h.hero({ level: 10, pos: [5, 0, 0] })
    h.learn(healer, [HEAL])
    h.gameplay.setVitals(friend, friend.maxHp - 200, friend.mp)
    const hpBefore = friend.hp
    const t0 = h.now
    h.req(healer, { t: 'useSkill', skill: HEAL, target: friend.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    expect(h.all(inbox, 'cast').at(-1)).toMatchObject({ skill: HEAL, target: friend.id })
    h.runTo(t0 + 500)
    h.world.warp(friend, 450, 0, 450, h.now)
    h.gameplay.warped(friend, 'gm', h.now)
    h.runTo(t0 + 2500)
    const d = h.world.distance(healer, friend, h.now)
    expect(d).toBeGreaterThan(100)
    // Correct: the heal fails (castEnd target_lost) and the far-away friend is not healed. Natural HP regeneration
    // runs for 2.5 s meanwhile (about +20), so compare against the heal's +200, not the exact HP.
    expect(friend.hp, `healed across ${Math.round(d)} m`).toBeLessThan(hpBefore + 100)
    expect(h.all(inbox, 'castEnd').some((c: Msg<'castEnd'>) => c.reason === 'target_lost')).toBe(true)
  })
})

describe('fix guards (W3-fix): what the fixes above must keep', () => {
  it('a stopAction after the first chain segment lands ends the chain there; the caster stays busy to that end', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, ['SKILL_CH_SWORD_CHAIN_A_1S_01'])
    const t0 = h.now
    h.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_CHAIN_A_1S_01', target: m.id })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    h.runTo(t0 + 100) // released at t0 (cast 0), action runs to +400
    h.req(p, { t: 'stopAction' })
    expect(h.gameplay.skills.busy(p, h.now)).toBe(true)
    h.runTo(t0 + 2500)
    expect(h.gameplay.skills.busy(p, h.now)).toBe(false)
    const hits = h.all(inbox, 'combat').filter((c) => c.skill?.startsWith('SKILL_CH_SWORD_CHAIN_A_'))
    expect(hits.map((c) => c.skill)).toEqual(['SKILL_CH_SWORD_CHAIN_A_1S_01'])
    expect(h.all(inbox, 'castEnd')).toHaveLength(0) // after the release a stop is silent
  })

  it('swapping the sword for a spear mid-cast ends the cast with castEnd interrupted', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, [SMASH])
    const spear = h.data.item('ITEM_CH_SPEAR_01_A_DEF')!
    expect(h.gameplay.gmItem(p, spear, spear.code, 1).ok).toBe(true)
    const bag = h.store.loadInventory(p.characterId).bag.findIndex((i) => i?.code === spear.code)
    const t0 = h.now
    h.req(p, { t: 'useSkill', skill: SMASH, target: m.id })
    h.runTo(t0 + 100)
    h.req(p, { t: 'itemEquip', bag, slot: 'weapon' })
    expect(h.result(inbox, 'itemEquip')).toMatchObject({ ok: true })
    expect(h.all(inbox, 'castEnd').at(-1)).toMatchObject({ reason: 'interrupted' })
    expect(h.gameplay.skills.busy(p, h.now)).toBe(false)
    h.runTo(t0 + 1500)
    expect(h.all(inbox, 'combat').some((c) => c.skill === SMASH)).toBe(false)
  })

  it('a heal still lands on a friend who stepped a few metres further away during the cast', () => {
    setup()
    const { p: healer, inbox } = h.hero({ level: 10 })
    const { p: friend } = h.hero({ level: 10, pos: [5, 0, 0] })
    h.learn(healer, [HEAL])
    h.gameplay.setVitals(friend, friend.maxHp - 300, friend.mp)
    const hpBefore = friend.hp
    const t0 = h.now
    h.req(healer, { t: 'useSkill', skill: HEAL, target: friend.id })
    h.runTo(t0 + 500)
    h.world.warp(friend, 18, 0, 0, h.now) // range 15 + radii, a few metres out
    h.runTo(t0 + 2500)
    expect(friend.hp).toBeGreaterThan(hpBefore + 150)
    expect(h.all(inbox, 'castEnd')).toHaveLength(0)
  })
})

describe('checked and safe (regression guards; these pass)', () => {
  it('masteryUp spam stops at the character level; skillLearn cannot skip a level', () => {
    setup()
    const { p, inbox } = h.hero({ level: 3, sp: 1000 })
    for (let i = 0; i < 6; i++) h.req(p, { t: 'masteryUp', mastery: 'BICHEON' })
    expect(h.gameplay.skills.masteriesOf(p).BICHEON).toBe(3)
    expect(h.result(inbox, 'masteryUp')).toMatchObject({ ok: false, reason: 'mastery_cap' })
    h.req(p, { t: 'skillLearn', skill: 'SKILL_CH_SWORD_SMASH_A_03' })
    expect(h.result(inbox, 'skillLearn')).toMatchObject({ ok: false, reason: 'requirements' })
  })

  it('unlearned, wrong-weapon and hostile-on-player/NPC uses are refused; friendly on a mob lands on the caster', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    const use = (skill: string, target?: number) => {
      h.req(p, target === undefined ? { t: 'useSkill', skill } : { t: 'useSkill', skill, target })
      return h.result(inbox, 'useSkill')
    }
    expect(use(SMASH, m.id)).toMatchObject({ ok: false, reason: 'not_learned' })
    // a later chain segment code does not skip to the strong hit: it is the same (unlearned) line
    expect(use('SKILL_CH_SWORD_CHAIN_A_3S_01', m.id)).toMatchObject({ ok: false, reason: 'not_learned' })
    h.learn(p, [SMASH, 'SKILL_CH_SPEAR_PIERCE_A_01', HEAL])
    expect(use('SKILL_CH_SPEAR_PIERCE_A_01', m.id)).toMatchObject({ ok: false, reason: 'wrong_weapon' })
    const npc: Npc = { kind: 'npc', id: h.world.newId(), code: 'NPC_CH_TEST', name: 'Tester', pos: [1, 0, 1], yaw: 0 }
    h.world.addEntity(npc, h.now)
    expect(use(SMASH, npc.id)).toMatchObject({ ok: false, reason: 'invalid_target' })
    const { p: other } = h.hero({ pos: [1, 0, 0] })
    expect(use(SMASH, other.id)).toMatchObject({ ok: false, reason: 'invalid_target' })
    h.gameplay.setVitals(p, p.maxHp - 200, p.mp)
    const hp = p.hp
    expect(use(HEAL, m.id)).toMatchObject({ ok: true })
    expect(h.all(inbox, 'cast').at(-1)?.target).toBeUndefined()
    h.runTo(h.now + 2100)
    expect(p.hp).toBeGreaterThan(hp)
    expect(m.hp).toBe(m.maxHp)
  })

  it('rapid useSkill while busy queues one skill and never bypasses the cooldown or MP', () => {
    setup()
    const { p, inbox } = h.hero({ level: 10 })
    const m = h.dummy(0, 2)
    h.learn(p, [SMASH])
    const mp0 = p.mp
    for (let i = 0; i < 8; i++) h.req(p, { t: 'useSkill', skill: SMASH, target: m.id })
    h.runTo(h.now + 2900)
    expect(h.all(inbox, 'cast').filter((c) => c.skill === SMASH)).toHaveLength(1)
    expect(p.mp).toBeGreaterThanOrEqual(mp0 - 20)
  })
})

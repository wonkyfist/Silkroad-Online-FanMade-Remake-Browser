/**
 * Play the Boss, the client (docs/PLAY_THE_BOSS.md §4): the pure parts (world/pilot-model.ts), the seams (focus,
 * KeyMover on the controlled id, the hotbar giving way to the kit keys, the skills-view clip fallback) and the strings.
 */
import { PILOT_FAIL_REASONS, PILOT_TAUNT_LINES, parseClientMessage, parseServerMessage, type ClientMessage, type MoveState, type PilotKitView, type ServerMessage, type Vec3 } from '@sro/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillCatalog } from '../src/content/skills.ts'
import { MOCK_TIGER_ID, pilotMock } from '../src/net/mock/pilot.ts'
import { actionFailText } from '../src/hud/index.ts'
import { KeyMap, type KeyEventLike } from '../src/hud/keys.ts'
import { en } from '../src/i18n/en.ts'
import { enPilot } from '../src/i18n/en-pilot.ts'
import { t } from '../src/i18n/index.ts'
import { settings } from '../src/settings.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { keyMoveFeature } from '../src/world/features/keymove.ts'
import { placeName } from '../src/world/features/pilot.ts'
import { panToward } from '../src/world/features/weather.ts'
import {
  abilityOnKey,
  actFor,
  bearingPoint,
  callBanner,
  callChatLines,
  compassOf,
  countdown,
  fadeAt,
  focusId,
  formatClock,
  huntBannerShows,
  huntEndText,
  isPiloting,
  kitSlots,
  nextPingAt,
  offerLine,
  pilotResult,
  roarGain,
  roarPan,
  secondsLeft,
  sensed,
  steeringLine,
  tauntSector,
  tauntSectorDir,
  TAUNT_DEAD_PX,
} from '../src/world/pilot-model.ts'
import { ActionPlayer, clipSkillDef, type ActionPort, type CastMessage, type PhasePlan } from '../src/world/skills-view.ts'

/** Her kit as the server sends it (§5.5 content, PilotKitView). */
const KIT: PilotKitView[] = [
  { id: 'claw', slot: 1, clip: '', rangeM: 2.8, cooldownMs: 3000, target: 'entity' },
  { id: 'sweep', slot: 2, clip: '', rangeM: 4, cooldownMs: 4500, target: 'none' },
  { id: 'curse', slot: 3, clip: '', rangeM: 15, cooldownMs: 5500, target: 'entity' },
  { id: 'pounce', slot: 4, clip: 'ATTACK1', rangeM: 12, cooldownMs: 12000, target: 'point' },
  { id: 'roar', slot: 5, clip: 'FIND', rangeM: 8, cooldownMs: 20000, target: 'none' },
  { id: 'pack', slot: 6, clip: 'HELP', rangeM: 0, cooldownMs: 30000, charges: 2, target: 'none' },
  { id: 'stalk', slot: 7, clip: '', rangeM: 0, cooldownMs: 25000, target: 'none' },
]

const validClient = (m: ClientMessage) => {
  const r = parseClientMessage(JSON.stringify(m))
  if (!r.ok) throw new Error(r.error)
  return r.msg
}
const validServer = (m: ServerMessage) => {
  const r = parseServerMessage(JSON.stringify(m))
  if (!r.ok) throw new Error(r.error)
  return r.msg
}

describe('timers', () => {
  it('formats mm:ss, rounding up, never negative; minutes pass 59', () => {
    expect(formatClock(702_000)).toBe('11:42')
    expect(formatClock(41_001)).toBe('0:42')
    expect(formatClock(1)).toBe('0:01')
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(-5000)).toBe('0:00')
    expect(formatClock(75 * 60_000)).toBe('75:00')
    expect(secondsLeft(10_500, 10_000)).toBe(1)
    expect(secondsLeft(9000, 10_000)).toBe(0)
  })

  it('an attach session has no timer (huntEndsAt 0): the strip shows a dash', () => {
    expect(countdown(0, 5000)).toBeNull()
    expect(countdown(undefined, 5000)).toBeNull()
    expect(countdown(65_000, 5000)).toBe('1:00')
  })

  it('the next sighting counts from the last ping, else from the hunt start; a missed one rolls to the next period', () => {
    expect(nextPingAt(null, null, 60, 1000)).toBeNull()
    expect(nextPingAt(null, 10_000, 60, 20_000)).toBe(70_000)
    expect(nextPingAt(100_000, 10_000, 60, 120_000)).toBe(160_000)
    expect(nextPingAt(100_000, null, 60, 200_000)).toBe(220_000)
  })

  it('fades over the span', () => {
    expect(fadeAt(1000, 1000, 60_000)).toBe(1)
    expect(fadeAt(1000, 31_000, 60_000)).toBeCloseTo(0.5)
    expect(fadeAt(1000, 61_000, 60_000)).toBe(0)
    expect(fadeAt(1000, 500, 60_000)).toBe(1)
  })
})

describe('the kit bar from pilotState', () => {
  const now = 50_000

  it('orders by slot; ready without a state; the pack shows its charges', () => {
    const s = kitSlots([...KIT].reverse(), null, now)
    expect(s.map(x => x.slot)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(s.every(x => !x.disabled && x.why === 'ready')).toBe(true)
    expect(s.find(x => x.id === 'pack')!.charges).toBe(2)
    expect(s.find(x => x.id === 'claw')!.charges).toBeUndefined()
  })

  it('cooldowns from `ready`, charges from `charges`, greyed while her AI steers or she is busy', () => {
    const state = { steering: 'player' as const, charges: { pack: 0 }, ready: { pounce: now + 4000, claw: now - 10 } }
    const s = kitSlots(KIT, state, now)
    const by = (id: string) => s.find(x => x.id === id)!
    expect(by('pounce')).toMatchObject({ disabled: true, why: 'cooldown', readyAt: now + 4000, cooldownMs: 12000 })
    expect(by('claw')).toMatchObject({ disabled: false, why: 'ready', readyAt: 0 })
    expect(by('pack')).toMatchObject({ disabled: true, why: 'charges', charges: 0 })
    expect(kitSlots(KIT, { ...state, steering: 'ai' }, now).find(x => x.id === 'claw')!.why).toBe('ai')
    expect(kitSlots(KIT, state, now, true).find(x => x.id === 'claw')!.why).toBe('busy')
    // A cooldown outranks the AI and busy reasons (the sweep keeps running).
    expect(kitSlots(KIT, { ...state, steering: 'ai' }, now, true).find(x => x.id === 'pounce')!.why).toBe('cooldown')
  })

  it('keys 1–9 map to the kit slots', () => {
    expect(abilityOnKey(KIT, '4')?.id).toBe('pounce')
    expect(abilityOnKey(KIT, '8')).toBeUndefined()
    expect(abilityOnKey(KIT, 'q')).toBeUndefined()
  })

  it('builds valid pilotAct frames: entity on the target, Pounce on the target or the ground, Sweep alone', () => {
    const k = (id: string) => KIT.find(x => x.id === id)!
    expect(validClient(actFor(k('claw'), 77, null)!)).toEqual({ t: 'pilotAct', ability: 'claw', target: 77 })
    expect(actFor(k('claw'), null, { x: 1, z: 2 })).toBeNull()
    expect(validClient(actFor(k('pounce'), 77, { x: 1, z: 2 })!)).toEqual({ t: 'pilotAct', ability: 'pounce', target: 77 })
    expect(validClient(actFor(k('pounce'), null, { x: 1.234567, z: -2.5 })!)).toEqual({ t: 'pilotAct', ability: 'pounce', x: 1.23, z: -2.5 })
    expect(actFor(k('pounce'), null, null)).toBeNull()
    expect(validClient(actFor(k('sweep'), null, null)!)).toEqual({ t: 'pilotAct', ability: 'sweep' })
    expect(validClient(actFor(k('sweep'), 9, null)!)).toEqual({ t: 'pilotAct', ability: 'sweep', target: 9 })
    expect(validClient({ t: 'pilotAct', ability: 'claw', target: 9, repeat: true })).toEqual({ t: 'pilotAct', ability: 'claw', target: 9, repeat: true })
    expect(validClient({ t: 'pilotTaunt', line: 7 })).toEqual({ t: 'pilotTaunt', line: 7 })
    expect(validClient({ t: 'pilotQuit' })).toEqual({ t: 'pilotQuit' })
    expect(validClient({ t: 'pilotAnswer', event: 3, accept: true })).toEqual({ t: 'pilotAnswer', event: 3, accept: true })
  })
})

describe('the taunt wheel', () => {
  it('sector 0 is straight up, numbered clockwise; the centre is a dead zone', () => {
    const n = 8
    expect(tauntSector(0, -80, n)).toBe(0)
    expect(tauntSector(80, 0, n)).toBe(2)
    expect(tauntSector(0, 80, n)).toBe(4)
    expect(tauntSector(-80, 0, n)).toBe(6)
    expect(tauntSector(57, -57, n)).toBe(1)
    expect(tauntSector(-57, -57, n)).toBe(7)
    // Sector edges at ±22.5°: just left of up is still 0, just past 22.5° is 1.
    const at = (deg: number) => tauntSector(Math.sin((deg * Math.PI) / 180) * 100, -Math.cos((deg * Math.PI) / 180) * 100, n)
    expect(at(-22)).toBe(0)
    expect(at(22)).toBe(0)
    expect(at(23)).toBe(1)
    expect(at(337)).toBe(7)
    expect(tauntSector(3, 3, n)).toBeNull()
    expect(tauntSector(TAUNT_DEAD_PX - 1, 0, n)).toBeNull()
    expect(tauntSector(50, 0, 0)).toBeNull()
  })

  it('the label of each sector sits in the middle of it', () => {
    for (let i = 0; i < PILOT_TAUNT_LINES; i++) {
      const d = tauntSectorDir(i, PILOT_TAUNT_LINES)
      expect(Math.hypot(d.x, d.y)).toBeCloseTo(1)
      expect(tauntSector(d.x * 80, d.y * 80, PILOT_TAUNT_LINES)).toBe(i)
    }
  })
})

describe('the steering line', () => {
  it('her AI; the idle warning with the seconds left; else nothing', () => {
    expect(steeringLine('ai', undefined, 0)).toEqual({ kind: 'ai' })
    expect(steeringLine('player', 15_000, 10_000)).toEqual({ kind: 'idle', seconds: 5 })
    expect(steeringLine('player', 40_000, 10_000)).toBeNull()
    expect(steeringLine('player', undefined, 10_000)).toBeNull()
  })
})

describe('focus selection', () => {
  it('the controlled id while piloting, else the own id', () => {
    expect(focusId(5, null)).toBe(5)
    expect(focusId(5, undefined)).toBe(5)
    expect(focusId(5, 900)).toBe(900)
    expect(focusId(null, null)).toBeNull()
  })

  it('isPiloting: only when the controlled id is set and is not the own one', () => {
    expect(isPiloting({ selfId: () => 5 })).toBe(false)
    expect(isPiloting({ selfId: () => 5, controlledId: () => 5 })).toBe(false)
    expect(isPiloting({ selfId: () => 5, controlledId: () => null })).toBe(false)
    expect(isPiloting({ selfId: () => 5, controlledId: () => 900 })).toBe(true)
  })

  it('the hotbar keys give way to the kit keys while piloting, without a key warning; the quest log gives Q to the wheel', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let controlled = 5
    const ctx = { selfId: () => 5, controlledId: () => controlled }
    const keys = new KeyMap()
    const ran: string[] = []
    // As features/skills.ts and features/quests.ts register them, then the pilot feature (registered later).
    keys.register({ id: 'hotbar.1', keys: ['1'], label: 'skills.keys.hotbar', group: 'combat', when: () => !isPiloting(ctx), run: () => ran.push('hotbar') })
    keys.register({ id: 'window.quests', keys: ['q', 'l'], label: 'keys.window.quests', group: 'windows', when: () => !isPiloting(ctx), run: () => ran.push('quests') })
    keys.register({ id: 'pilot.slot1', keys: ['1'], label: 'pilot.keys.slot', group: 'combat', when: () => isPiloting(ctx), run: () => ran.push('claw') })
    keys.register({ id: 'pilot.taunt', keys: ['q'], label: 'pilot.keys.taunt', group: 'combat', when: () => isPiloting(ctx), run: () => ran.push('wheel') })
    const ev = (key: string): KeyEventLike => ({ key, type: 'keydown', repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: null, preventDefault() {} })
    keys.handle(ev('1'))
    keys.handle(ev('q'))
    controlled = 900
    keys.handle(ev('1'))
    keys.handle(ev('q'))
    keys.handle(ev('l'))
    expect(ran).toEqual(['hotbar', 'quests', 'claw', 'wheel'])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('hunters', () => {
  it('the roar pans like the thunder (panToward) and is quieter far away', () => {
    for (const [b, fx, fz] of [[0, 1, 0], [Math.PI / 2, 0, -1], [1.2, -0.3, 0.8], [4, 0.5, 0.5]] as const) expect(roarPan(b, fx, fz)).toBeCloseTo(panToward(b, fx, fz))
    expect(roarPan(0, 0, 0)).toBe(0)
    expect(roarGain(120)).toBeGreaterThan(roarGain(400))
    expect(roarGain(0)).toBe(1)
    expect(roarGain(5000)).toBe(0.25)
  })

  it('bearings: 0 = east (+X), π/2 = north (−Z)', () => {
    expect(compassOf(0)).toBe('e')
    expect(compassOf(Math.PI / 2)).toBe('n')
    expect(compassOf(Math.PI)).toBe('w')
    expect(compassOf(-Math.PI / 2)).toBe('s')
    expect(compassOf(Math.PI / 4)).toBe('ne')
    expect(compassOf(Math.PI * 2 + 0.1)).toBe('e')
    expect(bearingPoint(10, 10, Math.PI / 2, 30)).toEqual({ x: 10 + Math.cos(Math.PI / 2) * 30, z: -20 })
    for (const d of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) expect(en[`hunt.dir.${d}` as keyof typeof en]).toBeTruthy()
  })

  it('the banner shows during the offer and the hunt, never to the pilot', () => {
    const ev = { id: 1, mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', phase: 'hunt' as const }
    expect(huntBannerShows(ev, false)).toBe(true)
    expect(huntBannerShows(ev, true)).toBe(false)
    expect(huntBannerShows({ ...ev, phase: 'offer' }, false)).toBe(true)
    expect(huntBannerShows({ ...ev, phase: 'ended' }, false)).toBe(false)
    expect(huntBannerShows({ ...ev, phase: 'call' }, false)).toBe(false)
    expect(huntBannerShows(null, false)).toBe(false)
  })

  it('the result banner names the outcome, then the pilot', () => {
    expect(huntEndText({ outcome: 'survived', pilot: 'Pixi' }, 'Tiger Girl')).toBe('Tiger Girl survived the hunt! Pixi was Tiger Girl.')
    expect(huntEndText({ outcome: 'killed' }, 'Tiger Girl')).toBe('The hunters brought Tiger Girl down!')
    expect(huntEndText({ outcome: 'downs', downs: 15, pilot: 'Mei' }, 'Tiger Girl')).toContain('15 hunters')
    expect(huntEndText({}, 'Tiger Girl')).toBeNull()
    for (const o of ['killed', 'survived', 'downs', 'cancelled', 'no_volunteers', 'restart'] as const) expect(huntEndText({ outcome: o }, 'X')).toBeTruthy()
  })

  it('the pilot senses living hunters inside the ring only (not the own body)', () => {
    const v = (id: number, kind: string, x: number, dead = false) => ({ id, kind, dead, pos: { x, z: 0 } })
    const list = [v(1, 'player', 10), v(2, 'player', 70), v(3, 'mob', 5), v(4, 'player', 20, true), v(5, 'player', 0)]
    expect(sensed(list, 0, 0, 60, x => x.id === 5).map(x => x.id)).toEqual([1])
  })

  it('the result from pilotEnd', () => {
    expect(pilotResult({ reason: 'survived', gold: 24500, downs: 10, steeredMs: 900_000, honor: 'tiger_spirit' })).toEqual({ won: true, reason: 'survived', gold: 24500, downs: 10, steeredMs: 900_000, honor: 'tiger_spirit', forfeit: false })
    expect(pilotResult({ reason: 'quit' })).toMatchObject({ won: false, forfeit: true, gold: 0, downs: null })
    expect(pilotResult({ reason: 'downs' }).won).toBe(true)
    expect(pilotResult({ reason: 'killed' }).won).toBe(false)
    expect(placeName('palace-steps')).toBe('palace steps')
  })

  it('the server messages the feature reads parse (protocol contract)', () => {
    const msgs: ServerMessage[] = [
      { t: 'huntEvent', event: { id: 4, mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', phase: 'hunt', huntEndsAt: 900_000, downs: 2, downsTarget: 15, hunters: 6, area: 'North-Tiger Mt.' } },
      { t: 'pilotStart', event: 0, mob: 900, kit: KIT, huntEndsAt: 0, downsTarget: 0, area: { x: 1, z: 2, r: 350 }, taunts: 8, senseM: 60, place: 'palace-steps' },
      { t: 'pilotState', steering: 'player', idleWarnAt: 20_000, hunting: 3, downs: 1, charges: { pack: 1 }, ready: { pounce: 30_000 }, enraged: true, stalkUntil: 25_000 },
      { t: 'pilotEnd', event: 4, reason: 'survived', gold: 100, honor: 'tiger_spirit', downs: 3, steeredMs: 60_000 },
      { t: 'pilotOffer', event: 4, expiresAt: 30_000, surviveMin: 15, downsTarget: 15, idleSec: 20 },
      { t: 'huntPing', event: 4, x: 1, z: 2, r: 60, at: 5000 },
      { t: 'huntTrail', points: [[1, 2, 3000], [2, 3, 6000]] },
      { t: 'huntRoar', bearing: 1.5, distM: 200, at: 7000 },
      { t: 'huntTaunt', id: 900, line: 5 },
      { t: 'entityUpdate', id: 7, trance: true, piloted: false, honor: '' },
    ]
    for (const m of msgs) expect(validServer(m)).toEqual(m)
  })
})

describe('the call (§4.5, layer 4)', () => {
  const CALL = { id: 4, mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', phase: 'call' as const, callEndsAt: 600_000, volunteers: 37, minLevel: 20 }

  it('the banner: the draw line, then Volunteer / Not this time, the volunteered line, or the reason', () => {
    expect(callBanner(CALL, 19_000)).toEqual({ meta: 'Draw in 9:41 · 37 volunteers · level 20 only', mode: 'open', why: null })
    expect(callBanner({ ...CALL, you: { volunteered: false, eligible: true } }, 0)!.mode).toBe('open')
    expect(callBanner({ ...CALL, you: { volunteered: true, eligible: true } }, 0)!.mode).toBe('volunteered')
    expect(callBanner({ ...CALL, you: { volunteered: false, eligible: false, why: 'level' } }, 0)).toMatchObject({ mode: 'ineligible', why: 'Only characters of level 20 and above can volunteer.' })
    expect(callBanner({ ...CALL, you: { volunteered: false, eligible: false, why: 'cooldown' } }, 0)!.why).toBe(en['pilot.call.why.cooldown'])
    expect(callBanner({ ...CALL, minLevel: undefined }, 0)!.meta).toBe('Draw in 10:00 · 37 volunteers')
    expect(callBanner({ ...CALL, phase: 'offer' }, 0)).toBeNull()
    expect(callBanner(null, 0)).toBeNull()
    // The hunters' banner never shows during the call; after it "Drawing a volunteer…".
    expect(huntBannerShows(CALL, false)).toBe(false)
    expect(offerLine({ volunteers: 3 })).toBe('Drawing a volunteer…')
    expect(offerLine({})).toBe(en['hunt.stirs'])
  })

  it('the chat lines: at the open, then 5 min and 1 min before the draw; a late joiner gets one line', () => {
    const done = new Set<string>()
    expect(callChatLines(600_000, 0, done)).toEqual(['open'])
    expect(callChatLines(600_000, 200_000, done)).toEqual([])
    expect(callChatLines(600_000, 300_000, done)).toEqual(['soon'])
    expect(callChatLines(600_000, 310_000, done)).toEqual([])
    expect(callChatLines(600_000, 540_000, done)).toEqual(['soon'])
    expect(callChatLines(600_000, 600_000, done)).toEqual([])
    const late = new Set<string>()
    expect(callChatLines(600_000, 330_000, late)).toEqual(['open'])
    expect(callChatLines(600_000, 545_000, late)).toEqual(['soon'])
    // Both marks crossed at once (a stalled tab): one line.
    const jump = new Set<string>()
    callChatLines(600_000, 0, jump)
    expect(callChatLines(600_000, 590_000, jump)).toEqual(['soon'])
  })
})

describe('strings (§4.6)', () => {
  it('every key the spec lists exists, in English', () => {
    const keys = [
      ...['title', 'question', 'meta', 'metaShort', 'volunteer', 'withdraw', 'volunteered', 'joined', 'left', 'chat', 'soon'].map(k => `pilot.call.${k}`),
      ...['level', 'playtime', 'cooldown', 'recent', 'blocked', 'dead', 'busy'].map(k => `pilot.call.why.${k}`),
      ...['title', 'question', 'ruleTrance', 'ruleStats', 'ruleWin', 'ruleIdle', 'accept', 'decline', 'timer'].map(k => `pilot.offer.${k}`),
      ...['you', 'fixed', 'enraged', 'survive', 'downed', 'hunting', 'charges', 'idleWarn', 'aiTook', 'trance', 'quit', 'quitConfirm'].map(k => `pilot.hud.${k}`),
      ...KIT.flatMap(k => [`pilot.ability.${k.id}.name`, `pilot.ability.${k.id}.desc`]),
      ...Array.from({ length: PILOT_TAUNT_LINES }, (_, i) => `pilot.taunt.${i}`),
      'pilot.taunt.chat',
      ...['title', 'won', 'lost', 'gold', 'downs', 'time', 'forfeit'].map(k => `pilot.result.${k}`),
      ...['title', 'sighted', 'ping', 'steered', 'trance', 'down', 'stirs', 'drawing'].map(k => `hunt.${k}`),
      ...['survived', 'downs', 'cancelled', 'noVolunteers', 'pilot'].map(k => `hunt.end.${k}`),
      'pilot.honor.tiger_spirit',
    ]
    for (const k of keys) {
      expect(enPilot[k as keyof typeof enPilot], k).toBeTruthy()
      expect(en[k as keyof typeof en], k).toBe(enPilot[k as keyof typeof enPilot])
    }
    expect(t('pilot.taunt.5')).toBe('Too slow.')
    expect(t('pilot.honor.tiger_spirit')).toBe('Spirit of the Tiger')
  })

  it('a line for every new refusal reason', () => {
    for (const r of PILOT_FAIL_REASONS) {
      expect(actionFailText(r)).not.toBe(t('action.fail.generic'))
      expect(actionFailText(r)).not.toContain('action.fail.')
    }
  })
})

describe('skills-view: a server-built ability plays its clip', () => {
  it('an unknown skill with `clip` plays one SHOT phase of that clip type; without `clip` nothing plays', () => {
    const plays: { group: string | undefined; phases: readonly PhasePlan[] }[] = []
    const port: ActionPort = {
      clip: () => ({ durationMs: 1200, hits: [400] }),
      play: (group, phases) => (plays.push({ group, phases }), 1),
      stop: () => {},
      playing: () => true,
      face: () => {},
    }
    const player = new ActionPlayer(new SkillCatalog([], [], []))
    const cast = (over: Partial<CastMessage>): CastMessage => ({ t: 'cast', id: 900, skill: 'PILOT_TIGERWOMAN_POUNCE', instance: 1, prepareMs: 0, castMs: 0, actionMs: 900, ...over })
    expect(player.cast(cast({}), 0, port)).toBeNull()
    expect(plays).toEqual([])
    const a = player.cast(cast({ instance: 2, clip: 'ATTACK1' }), 0, port)
    expect(a).not.toBeNull()
    expect(plays).toEqual([{ group: 'DEFAULT', phases: [{ phase: 'SHOT', type: 'ATTACK1', ms: 900, loop: false }] }])
    const roar = player.cast(cast({ instance: 3, skill: 'PILOT_TIGERWOMAN_ROAR', clip: 'FIND', prepareMs: 200, actionMs: 1500 }), 5000, port)
    expect(roar?.phases.map(p => p.plan.type)).toEqual(['FIND'])
    expect(clipSkillDef('X', '')).toBeUndefined()
    expect(clipSkillDef('X', 'ANI_HELP')?.animation?.shot).toBe('HELP')
  })
})

// ---- KeyMover on the controlled id ----------------------------------------------------------------------------------

afterEach(() => {
  settings.set({ controls: { keyboardMove: true } })
})

function view(id: number, x: number) {
  return {
    id,
    kind: id === 1 ? 'player' : 'mob',
    dead: false,
    state: {},
    pos: { x, y: 0, z: 0 },
    yaw: 0,
    targetYaw: 0,
    moving: false,
    move: undefined as MoveState | undefined,
    setMove(m: MoveState) {
      this.move = m
    },
    stop(p: Vec3, yaw: number) {
      this.move = undefined
      this.pos = { x: p[0], y: p[1], z: p[2] }
      this.targetYaw = yaw
    },
  }
}

function pilotRig() {
  const keys = new KeyMap()
  const clock = { t: 100_000 }
  const sent: ClientMessage[] = []
  const body = view(1, 0)
  const tiger = view(900, 500)
  const views = new Map<number, ReturnType<typeof view>>([
    [1, body],
    [900, tiger],
  ])
  let controlled: number | null = null
  const ctx = {
    keys,
    hud: { toast() {} },
    send: (m: ClientMessage) => (sent.push(m), true),
    selfId: () => 1,
    controlledId: () => controlled ?? 1,
    view: (id: number) => views.get(id),
    views: () => views.values(),
    serverNow: () => clock.t,
    camera: { alpha: -Math.PI / 2 },
    scene: { useRightHandedSystem: true, onPointerObservable: { add: () => ({}), remove: () => {} } },
    session: { clock: { rtt: 40 } },
    world: () => null,
  } as unknown as WorldFeatureContext
  const feature = keyMoveFeature(ctx)
  const ev = (key: string, type: 'keydown' | 'keyup' = 'keydown'): KeyEventLike => ({ key, type, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: null, preventDefault() {} })
  const frame = (ms = 16) => {
    clock.t += ms
    feature.onFrame?.(clock.t, ms / 1000)
  }
  return {
    keys,
    clock,
    sent,
    body,
    tiger,
    feature,
    ev,
    frame,
    pilot: (on: boolean) => {
      controlled = on ? 900 : null
    },
  }
}

describe('the KeyMover walks the controlled view while piloting', () => {
  const rigs: { feature: { dispose?(): void } }[] = []
  afterEach(() => {
    for (const r of rigs.splice(0)) r.feature.dispose?.()
  })

  it('W predicts her, not the body, sends moveTo ahead of her, and takes her speed from her own moves', () => {
    const r = pilotRig()
    rigs.push(r)
    r.frame()
    r.pilot(true)
    r.frame()
    r.keys.handle(r.ev('w'))
    for (let i = 0; i < 10; i++) r.frame()
    expect(r.body.move).toBeUndefined()
    expect(r.tiger.move).toBeDefined()
    const first = r.sent.find(m => m.t === 'moveTo') as Extract<ClientMessage, { t: 'moveTo' }>
    // Camera alpha −π/2 looks along +z: the target lies ahead of her (x 500), not of the body (x 0).
    expect(first.x).toBeCloseTo(500, 0)
    expect(first.z).toBeGreaterThan(2)
    // Her move echo carries her run speed: the prediction speeds up to it.
    const echo: MoveState = { from: [500, 0, 1], to: [500, 0, 10], speed: 9, startedAt: r.clock.t }
    r.tiger.setMove(echo)
    r.feature.onMessage?.({ t: 'move', id: 900, move: echo })
    r.frame(200)
    expect(r.tiger.move?.speed).toBe(9)
    // The body's echoes no longer touch the walk.
    r.feature.onMessage?.({ t: 'stop', id: 1, pos: [0, 0, 0], yaw: 0 })
    expect(r.tiger.move?.speed).toBe(9)
    r.keys.handle(r.ev('w', 'keyup'))
    for (let i = 0; i < 5; i++) r.frame()
    expect(r.sent.filter(m => m.t === 'moveTo').length).toBeGreaterThan(1)
  })

  it('a change of the controlled id ends the walk and starts afresh on the new view (no keys held over)', () => {
    const r = pilotRig()
    rigs.push(r)
    r.frame()
    r.keys.handle(r.ev('w'))
    r.frame()
    const mover = (r.feature as unknown as { mover: { state: string } }).mover
    expect(mover.state).toBe('active')
    r.pilot(true)
    r.frame()
    expect(mover.state).toBe('idle')
    // A fresh press walks her.
    r.keys.handle(r.ev('w', 'keyup'))
    r.keys.handle(r.ev('w'))
    r.frame()
    expect(mover.state).toBe('active')
    expect(r.tiger.move).toBeDefined()
    r.pilot(false)
    r.frame()
    expect(mover.state).toBe('idle')
  })
})

// ---- the mock (net/mock/pilot.ts) -------------------------------------------------------------------------------------

describe('the mock pilot (?mock=1&gm=1)', () => {
  function mockRig() {
    const out: { to: 'conn' | 'all'; m: ServerMessage }[] = []
    const results: { re: string; ok: boolean; reason?: string }[] = []
    let now = 1_000_000
    const self = { state: { id: 5, kind: 'player', name: 'Pixi', pos: [10, 0, 10] as Vec3 } }
    const bot = { state: { id: 6, kind: 'player', name: 'Mei', pos: [20, 0, 10] as Vec3 } }
    const ctx = {
      content: { mobs: new Map([['MOB_CH_TIGERWOMAN', { name: 'Tiger Girl' }]]) },
      now: () => now,
      selfOf: () => self,
      entity: (id: number) => (id === 6 ? bot : undefined),
      entities: () => [self, bot].values(),
      send: (_c: unknown, m: ServerMessage) => out.push({ to: 'conn', m }),
      broadcast: (m: ServerMessage) => out.push({ to: 'all', m }),
      result: (_c: unknown, re: string, ok: boolean, reason?: string) => results.push({ re, ok, reason }),
    } as unknown as Parameters<NonNullable<typeof pilotMock.handle>>[0]
    const conn = { role: 'gm', entityId: 5 } as Parameters<NonNullable<typeof pilotMock.handle>>[1]
    const handle = (msg: ClientMessage) => pilotMock.handle!(ctx, conn, msg)
    return { out, results, handle, tick: (dt: number) => pilotMock.tick!(ctx, (now += dt)), ctx, conn }
  }

  it('attach: trance, her spawn, pilotStart and pilotState, every frame valid; moves, acts and ends', () => {
    const r = mockRig()
    expect(r.handle({ t: 'chat', text: '/unique pilot attach' })).toBe(true)
    const types = r.out.map(o => o.m.t)
    expect(types).toEqual(['entityUpdate', 'spawn', 'pilotStart', 'pilotState', 'gmResult'])
    const startMsg = r.out.find(o => o.m.t === 'pilotStart')!.m as Extract<ServerMessage, { t: 'pilotStart' }>
    expect(startMsg).toMatchObject({ event: 0, mob: MOCK_TIGER_ID, huntEndsAt: 0, downsTarget: 0 })
    r.out.length = 0
    expect(r.handle({ t: 'moveTo', x: 40, z: 40 })).toBe(true)
    expect(r.out[0]!.m).toMatchObject({ t: 'move', id: MOCK_TIGER_ID, move: { speed: 9 } })
    r.handle({ t: 'pilotAct', ability: 'pounce', x: 30, z: 30 })
    expect(r.results.at(-1)).toEqual({ re: 'pilotAct', ok: true, reason: undefined })
    expect(r.out.some(o => o.m.t === 'cast' && o.m.clip === 'ATTACK1')).toBe(true)
    r.handle({ t: 'pilotAct', ability: 'pounce', x: 30, z: 30 })
    expect(r.results.at(-1)).toMatchObject({ ok: false, reason: 'cooldown' })
    r.handle({ t: 'pilotAct', ability: 'pack' })
    r.handle({ t: 'pilotAct', ability: 'claw' })
    expect(r.results.at(-1)).toMatchObject({ ok: false, reason: 'invalid_target' })
    r.handle({ t: 'pilotTaunt', line: 5 })
    expect(r.out.at(-1)!.m).toEqual({ t: 'huntTaunt', id: MOCK_TIGER_ID, line: 5 })
    // Idle: the warning at 15 s, her AI at 20 s.
    r.tick(15_500)
    expect(r.out.at(-1)!.m).toMatchObject({ t: 'pilotState', steering: 'player', idleWarnAt: expect.any(Number) })
    r.tick(5_000)
    expect(r.out.some(o => o.m.t === 'pilotState' && o.m.steering === 'ai')).toBe(true)
    r.handle({ t: 'stopAction' })
    expect(r.out.some(o => o.m.t === 'entityUpdate' && o.m.piloted === true)).toBe(true)
    r.handle({ t: 'pilotQuit' })
    expect(r.out.some(o => o.m.t === 'pilotEnd' && o.m.reason === 'quit')).toBe(true)
    expect(r.out.at(-1)!.m).toEqual({ t: 'despawn', id: MOCK_TIGER_ID })
    for (const o of r.out) expect(validServer(o.m)).toEqual(o.m)
    expect(r.handle({ t: 'moveTo', x: 1, z: 1 })).toBe(false)
  })

  it('hunt, offer and signs broadcast huntEvent; the end names the pilot; frames valid', () => {
    const r = mockRig()
    r.handle({ t: 'chat', text: '/unique pilot signs' })
    expect(r.out.map(o => o.m.t)).toEqual(['huntEvent', 'huntPing', 'huntTrail', 'huntRoar', 'gmResult'])
    r.out.length = 0
    r.handle({ t: 'chat', text: '/unique pilot offer' })
    expect(r.out.map(o => o.m.t)).toEqual(['huntEvent', 'pilotOffer', 'gmResult'])
    const offer = r.out[1]!.m as Extract<ServerMessage, { t: 'pilotOffer' }>
    r.handle({ t: 'pilotAnswer', event: offer.event, accept: true })
    expect(r.out.some(o => o.m.t === 'pilotStart' && o.m.event > 0 && o.m.downsTarget === 15)).toBe(true)
    r.handle({ t: 'chat', text: '/unique pilot end survived' })
    const ended = r.out.filter(o => o.m.t === 'huntEvent').at(-1)!.m as Extract<ServerMessage, { t: 'huntEvent' }>
    expect(ended.event).toMatchObject({ phase: 'ended', outcome: 'survived', pilot: 'Pixi' })
    expect(r.out.find(o => o.m.t === 'pilotEnd')!.m).toMatchObject({ reason: 'survived', honor: 'tiger_spirit', gold: 15_000 })
    for (const o of r.out) expect(validServer(o.m)).toEqual(o.m)
    const p = mockRig()
    ;(p.conn as { role?: string }).role = 'player'
    p.handle({ t: 'chat', text: '/unique pilot attach' })
    expect(p.out.map(o => o.m.t)).toEqual(['error'])
  })

  it('call: /unique pilot call, each connection its own `you`, Volunteer toggles, the draw offers the turn; frames valid', () => {
    const r = mockRig()
    r.handle({ t: 'pilotVolunteer', on: true })
    expect(r.results.at(-1)).toMatchObject({ re: 'pilotVolunteer', ok: false, reason: 'no_event' })
    r.handle({ t: 'chat', text: '/unique pilot call 30' })
    const call = r.out.find(o => o.m.t === 'huntEvent')!.m as Extract<ServerMessage, { t: 'huntEvent' }>
    expect(call.event).toMatchObject({ phase: 'call', volunteers: 0, minLevel: 20, you: { volunteered: false, eligible: true } })
    r.handle({ t: 'pilotVolunteer', on: true })
    expect(r.results.at(-1)).toMatchObject({ re: 'pilotVolunteer', ok: true })
    expect((r.out.filter(o => o.m.t === 'huntEvent').at(-1)!.m as Extract<ServerMessage, { t: 'huntEvent' }>).event).toMatchObject({ volunteers: 1, you: { volunteered: true } })
    r.tick(31_000)
    expect(r.out.some(o => o.m.t === 'pilotOffer')).toBe(true)
    for (const o of r.out) expect(validServer(o.m)).toEqual(o.m)
  })
})

/**
 * Lane BZ, the Berserk client (docs/SYSTEMS_COMBAT.md §5.3): the gauge layout and its states (hud/berserk.ts), the
 * controller behind Tab and the button, the look start/end events from `entityUpdate {berserkMs}` and late viewers'
 * `EntityState.berserkMs`, the Tab binding (never from a chat input), the i18n lines and the HWAN hit spark of the
 * exported fx index. DOM-free: the controller runs on a fake BerserkIo and every frame it sends passes the validator.
 */
import { existsSync, readFileSync } from 'node:fs'
import { HWAN_MAX, parseClientMessage, type ClientMessage, type ServerMessage } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { BUTTON, burnRect, FACE_GLOW, FRAME_GLOW, gaugeView, hostRect, orbRects, secondsLeft, type BerserkTimer } from '../src/hud/berserk.ts'
import { BERSERK_HOST, BERSERK_ORBS } from '../src/hud/hud-layout.ts'
import { KeyMap } from '../src/hud/keys.ts'
import { en } from '../src/i18n/en.ts'
import { enBerserk } from '../src/i18n/en-berserk.ts'
import { t } from '../src/i18n/index.ts'
import { readFxSkills } from '../src/world/skill-fx.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import {
  BERSERK_DEFAULT_MS,
  BERSERK_GRACE_MS,
  BERSERK_KEY,
  BerserkController,
  berserkFeature,
  HWAN_FX,
  HWAN_HAIR,
  hwanScale,
  registerBerserkKey,
  type BerserkIo,
} from '../src/world/features/berserk.ts'

const SELF = 101
const OTHER = 202

function fakeIo(opts: { selfId?: number | null; dead?: boolean } = {}) {
  const sent: ClientMessage[] = []
  const toasts: string[] = []
  const lines: string[] = []
  const gauges: { points: number; timer: BerserkTimer | null }[] = []
  const events: string[] = []
  let now = 10_000
  let dead = opts.dead ?? false
  const io: BerserkIo = {
    send: msg => {
      expect(parseClientMessage(JSON.stringify(msg))).not.toBeNull()
      sent.push(msg)
      return true
    },
    selfId: () => (opts.selfId === undefined ? SELF : opts.selfId),
    selfDead: () => dead,
    now: () => now,
    toast: text => toasts.push(text),
    line: text => lines.push(text),
    gauge: (points, timer) => gauges.push({ points, timer }),
    start: (id, burst) => events.push(`start ${id}${burst ? ' burst' : ''}`),
    end: (id, fade) => events.push(`end ${id}${fade ? ' fade' : ''}`),
  }
  const c = new BerserkController(io)
  return {
    c, sent, toasts, lines, gauges, events,
    advance(ms: number) {
      now += ms
    },
    get now() {
      return now
    },
    kill() {
      dead = true
    },
  }
}

const stats = (hwan: number): ServerMessage => ({ t: 'stats', stats: { level: 1, exp: 0, expToNext: 100, sp: 0, spExp: 0, hp: 100, maxHp: 100, mp: 50, maxMp: 50, str: 20, int: 20, statPoints: 0, gold: 0, physAttack: [1, 2], magAttack: [1, 2], physDefence: 1, magDefence: 1, hitRate: 1, parryRate: 1, hwan } })
const delta = (hwan: number): ServerMessage => ({ t: 'statsDelta', stats: { hwan } })
const update = (id: number, berserkMs: number): ServerMessage => ({ t: 'entityUpdate', id, berserkMs })

describe('the gauge layout (ifplayerminiinfo.txt rects in the berserk host)', () => {
  it('places the five orbs at GDR_PMI_CIRCLE0..4 shifted into the host', () => {
    const orbs = orbRects()
    expect(orbs).toHaveLength(HWAN_MAX)
    orbs.forEach((r, i) => {
      const o = BERSERK_ORBS[i]!
      expect(r).toEqual([o.x - BERSERK_HOST.x, o.y - BERSERK_HOST.y, 8, 8])
      // Every orb, flame, glow and the button stay inside the host.
      for (const [x, y, w, h] of [r, burnRect(r)]) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(x + w).toBeLessThanOrEqual(BERSERK_HOST.w)
        expect(y + h).toBeLessThanOrEqual(BERSERK_HOST.h)
      }
    })
    expect(hostRect(FRAME_GLOW)).toEqual([0, 3, 220, 80])
    expect(hostRect(FACE_GLOW)).toEqual([19, 13, 48, 48])
    expect(hostRect(BUTTON)).toEqual([20, 1, 20, 20])
  })

  it('a flame stands on its orb (centred, foot at the orb bottom)', () => {
    const orb = orbRects()[0]!
    const f = burnRect(orb)
    expect(f[0] + f[2] / 2).toBe(orb[0] + orb[2] / 2)
    expect(f[1] + f[3]).toBeGreaterThanOrEqual(orb[1] + orb[3])
  })

  it('lit orbs, full, active and the countdown', () => {
    expect(gaugeView(3, null, 0)).toEqual({ lit: 3, full: false, active: false, left: 0 })
    expect(gaugeView(5, null, 0)).toMatchObject({ lit: 5, full: true, active: false })
    expect(gaugeView(9, null, 0).lit).toBe(5)
    expect(gaugeView(-1, null, 0).lit).toBe(0)
    const timer = { until: 60_000, total: 60_000 }
    expect(gaugeView(0, timer, 0)).toEqual({ lit: 0, full: false, active: true, left: 1 })
    expect(gaugeView(0, timer, 45_000).left).toBeCloseTo(0.25)
    expect(gaugeView(0, timer, 60_000).active).toBe(false)
    expect(secondsLeft(timer, 45_001)).toBe(15)
    expect(secondsLeft(null, 0)).toBe(0)
  })
})

describe('BerserkController', () => {
  it('points come from stats and statsDelta and reach the gauge', () => {
    const f = fakeIo()
    f.c.onMessage(stats(2))
    f.c.onMessage(delta(3))
    f.c.onMessage(delta(3)) // no change, no redraw
    f.c.onMessage({ t: 'statsDelta', stats: { hp: 5 } })
    expect(f.c.points).toBe(3)
    expect(f.gauges.map(g => g.points)).toEqual([2, 3])
  })

  it('Tab below a full gauge: "Your Berserk gauge is not full." and nothing is sent (B4)', () => {
    const f = fakeIo()
    f.c.onMessage(stats(4))
    expect(f.c.activate()).toBe('not_ready')
    expect(f.sent).toEqual([])
    expect(f.toasts).toEqual(['Your Berserk gauge is not full.'])
  })

  it('a full gauge sends berserk {}; dead or offline sends nothing', () => {
    const f = fakeIo()
    f.c.onMessage(stats(5))
    expect(f.c.activate()).toBe('sent')
    expect(f.sent).toEqual([{ t: 'berserk' }])
    f.kill()
    expect(f.c.activate()).toBe('dead')
    expect(fakeIo({ selfId: null }).c.activate()).toBe('offline')
    expect(f.sent).toHaveLength(1)
  })

  it('activation: burst on self, gauge timer and a system line; Tab again is refused locally', () => {
    const f = fakeIo()
    f.c.onMessage(stats(5))
    f.c.onMessage(update(SELF, 60_000))
    f.c.onMessage(delta(0))
    expect(f.events).toEqual([`start ${SELF} burst`])
    expect(f.lines).toEqual([t('bz.started')])
    expect(f.gauges.at(-1)).toEqual({ points: 0, timer: { until: f.now + 60_000, total: 60_000 } })
    expect(f.c.activate()).toBe('active')
    expect(f.toasts).toEqual(['Cannot be used in Berserk mode.'])
  })

  it('the end (berserkMs 0) fades the look and clears the timer', () => {
    const f = fakeIo()
    f.c.onMessage(update(SELF, 60_000))
    f.advance(60_000)
    f.c.onMessage(update(SELF, 0))
    expect(f.events).toEqual([`start ${SELF} burst`, `end ${SELF} fade`])
    expect(f.c.active(SELF)).toBe(false)
    expect(f.gauges.at(-1)?.timer).toBeNull()
    expect(f.lines).toEqual([t('bz.started'), t('bz.ended')])
    f.c.onMessage(update(SELF, 0)) // a second end is ignored
    expect(f.events).toHaveLength(2)
  })

  it('other players: burst live; a late viewer sees it without the burst and counts from the default length', () => {
    const f = fakeIo()
    f.c.onMessage(update(OTHER, 60_000))
    expect(f.events).toEqual([`start ${OTHER} burst`])
    expect(f.lines).toEqual([]) // no line for others
    f.c.added(303, { kind: 'player', berserkMs: 20_000 })
    expect(f.events.at(-1)).toBe('start 303')
    expect(f.c.timer(303)).toEqual({ until: f.now + 20_000, total: BERSERK_DEFAULT_MS })
    f.c.added(404, { kind: 'mob', berserkMs: 20_000 })
    f.c.added(405, { kind: 'player' })
    expect(f.c.ids().sort()).toEqual([OTHER, 303])
  })

  it('an entityUpdate before the view existed: added() still starts the look', () => {
    const f = fakeIo()
    f.c.onMessage(update(OTHER, 30_000))
    f.c.added(OTHER, { kind: 'player', berserkMs: 29_000 })
    expect(f.events).toEqual([`start ${OTHER} burst`, `start ${OTHER}`])
    expect(f.c.timer(OTHER)?.total).toBe(30_000)
  })

  it('a view leaving drops its look without the end effect; worldEnter keeps the berserk players of the snapshot', () => {
    const f = fakeIo()
    f.c.onMessage(update(OTHER, 60_000))
    f.c.removed(OTHER)
    expect(f.events.at(-1)).toBe(`end ${OTHER}`)
    expect(f.c.active(OTHER)).toBe(false)
    // world.ts adds the snapshot's views (onEntityAdded) before the features see worldEnter.
    f.c.added(303, { kind: 'player', berserkMs: 30_000 })
    f.c.onMessage({ t: 'worldEnter' } as ServerMessage)
    expect(f.c.ids()).toEqual([303])
  })

  it('a timer whose end never came is dropped after the grace', () => {
    const f = fakeIo()
    f.c.onMessage(update(OTHER, 1000))
    f.c.tick(f.now + 1000 + BERSERK_GRACE_MS)
    expect(f.c.active(OTHER)).toBe(true)
    f.c.tick(f.now + 1001 + BERSERK_GRACE_MS)
    expect(f.c.active(OTHER)).toBe(false)
    expect(f.events.at(-1)).toBe(`end ${OTHER} fade`)
  })
})

describe('the Tab key and the feature', () => {
  it('Tab is registered as combat.berserk and does nothing from a chat input', () => {
    const keys = new KeyMap()
    let runs = 0
    const off = registerBerserkKey(keys, () => runs++)
    const b = keys.list().find(x => x.id === 'combat.berserk')
    expect(b).toMatchObject({ keys: ['tab'], group: 'combat', label: 'bz.key' })
    let prevented = 0
    const ev = (target: unknown) => ({ type: 'keydown', key: 'Tab', repeat: false, target, preventDefault: () => prevented++ })
    keys.handle(ev({ tagName: 'CANVAS' }))
    expect(runs).toBe(1)
    expect(prevented).toBe(1) // Tab never moves the DOM focus in the world
    keys.handle(ev({ tagName: 'INPUT' }))
    keys.handle(ev({ tagName: 'TEXTAREA' }))
    expect(runs).toBe(1)
    keys.handle({ type: 'keydown', key: 'Tab', repeat: true, target: null, preventDefault: () => {} })
    expect(runs).toBe(1) // no key repeat
    off()
    keys.handle(ev(null))
    expect(runs).toBe(1)
  })

  it('a bare context gets no hooks', () => {
    expect(Object.keys(berserkFeature({} as WorldFeatureContext))).toEqual([])
  })

  it('every string the lane uses is in the English table', () => {
    for (const k of Object.keys(enBerserk)) expect((en as Record<string, string>)[k]).toBe((enBerserk as Record<string, string>)[k])
    expect(en[BERSERK_KEY.label]).toBeTruthy()
    expect(t('bz.gaugeTip', { points: 3, max: 5 })).toContain('3 / 5')
    expect(t('bz.activeTip', { seconds: 12 })).toContain('12')
  })

  it('grows to 1.1× (SCT_CHAR_SCALE,1.1)', () => {
    expect(hwanScale(0)).toBe(1)
    expect(hwanScale(1)).toBeCloseTo(1.1)
    expect(hwanScale(2)).toBeCloseTo(1.1)
    expect(hwanScale(0.5)).toBeCloseTo(1.05)
  })
})

// ---- the exported data (skips without work/out) ----------------------------------------------------------------------

const OUT = new URL('../../../work/out/', import.meta.url)
const FX_INDEX = new URL('fx/skills.json', OUT)

describe.skipIf(!existsSync(FX_INDEX))('the exported Berserk effects', () => {
  const skills = readFxSkills(JSON.parse(readFileSync(FX_INDEX, 'utf8')))
  const hwan = skills.get(HWAN_FX)

  it('a hit with hwan: true picks hit_4_hwan (the SYSTEM_CH_HWANMODE DamageEfp)', () => {
    expect(hwan?.damage).toBe('hiteffect/hit_4_hwan.efp')
  })

  it('has the burst on Bip01, the keep loops on the spine and limbs, and the fade', () => {
    const rows = hwan?.stages ?? []
    expect(rows.find(s => s.phase === 'ACT_S')?.startBone).toBe('Bip01')
    const loops = rows.filter(s => s.phase === 'ACT_L')
    expect(loops.map(s => s.startBone)).toContain('Bip01 Spine')
    expect(loops.length).toBeGreaterThanOrEqual(7)
    expect(rows.some(s => s.phase === 'DEACT' && /hwan_disappear/.test(s.effect ?? ''))).toBe(true)
  })
})

describe.skipIf(!existsSync(new URL('char/china/chinaman_hwan_hair.glb', OUT)))('the exported hwan hair', () => {
  it('both hairs exist and hang on Bip01 Head, replacing the HAIR slot', () => {
    for (const g of ['male', 'female'] as const) {
      const side = JSON.parse(readFileSync(new URL(`.${HWAN_HAIR[g].sidecar.slice('/out'.length)}`, OUT), 'utf8')) as { attachBone?: string; attachable?: { attachMethodName?: string; slots?: { slotName: string }[] } }
      expect(existsSync(new URL(`.${HWAN_HAIR[g].glb.slice('/out'.length)}`, OUT))).toBe(true)
      expect(side.attachBone).toBe('Bip01 Head')
      expect(side.attachable?.attachMethodName).toBe('REPLACE')
      expect(side.attachable?.slots?.map(s => s.slotName)).toEqual(['HAIR'])
    }
  })
})

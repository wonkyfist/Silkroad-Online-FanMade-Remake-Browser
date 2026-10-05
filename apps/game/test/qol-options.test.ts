/**
 * Three playtest asks: the "cannot get there" warning switch (world/move-feedback.ts, Options → Controls), the
 * underbar's mouse quick slot (hud/mouse-slot.ts, middle mouse button) and the auto potion (world/auto-potion.ts).
 * DOM-free: the pure parts, the settings and the Options rows.
 */
import { HOTBAR_SLOTS, MOUSE_SLOT, parseClientMessage, type ClientMessage, type HotbarEntry, type ItemDef, type ItemStack, type MoveState } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { SkillCatalog, SkillState } from '../src/content/skills.ts'
import { intent } from '../src/hud/intents.ts'
import { optionRows, pageRows, type OptionsHost } from '../src/hud/options.ts'
import { isMiddlePress, MOUSE_SLOT_KEY, MOUSE_SLOT_MAX_CHARS, MouseSlotStore, mouseSlotDrop, readMouseSlots, type MouseSlotStorage } from '../src/hud/mouse-slot.ts'
import { t } from '../src/i18n/index.ts'
import { defaultSettings, normalizeSettings, SettingsStore } from '../src/settings.ts'
import { AutoPotion, COVER, MIN_GAP_MS, pickPill, pickPotion, pillCandidates, potionCandidates, REFUSED_BACKOFF_MS, restoreOf, TICK_MS, type AutoPotionSettings, type RunOut, type Vitals } from '../src/world/auto-potion.ts'
import { MoveFeedback, type GroundPoint } from '../src/world/move-feedback.ts'

const host: OptionsHost = {
  engine: 'WebGPU',
  keyHelp() {},
  toast() {},
  menu: { app: {} as OptionsHost['menu']['app'], close() {}, characterSelect() {}, logout() {} },
}
const controlIds = (raw: unknown) => pageRows(host, 'controls', normalizeSettings(raw), 'on').map(r => r.id)
const valid = (m: ClientMessage) => parseClientMessage(JSON.stringify(m)).ok

// ---- settings and the Options rows -------------------------------------------------------------------------------

describe('settings: the unreachable warning and the auto potion', () => {
  it('defaults: the warning on, the auto potion off at 50 % HP / 30 % MP without pills', () => {
    const d = defaultSettings()
    expect(d.controls.unreachableWarning).toBe(true)
    expect(d.autoPotion).toEqual({ enabled: false, hp: 50, mp: 30, cure: false })
  })

  it('a save from before the rows gets the defaults; values are clamped to 0..90 in steps of 5', () => {
    const old = normalizeSettings({ v: 1, controls: { holdToMove: false } })
    expect(old.controls.unreachableWarning).toBe(true)
    expect(old.autoPotion).toEqual(defaultSettings().autoPotion)
    const s = normalizeSettings({ controls: { unreachableWarning: false }, autoPotion: { enabled: true, hp: 97, mp: 33, cure: true } })
    expect(s.controls.unreachableWarning).toBe(false)
    expect(s.autoPotion).toEqual({ enabled: true, hp: 90, mp: 35, cure: true })
    const junk = normalizeSettings({ controls: { unreachableWarning: 'no' }, autoPotion: { enabled: 1, hp: -4, mp: 'x', cure: null } })
    expect(junk.controls.unreachableWarning).toBe(true)
    expect(junk.autoPotion).toEqual({ enabled: false, hp: 0, mp: 30, cure: false })
  })

  it('is saved like the other settings and survives a reload', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    const a = new SettingsStore(storage)
    a.set({ controls: { unreachableWarning: false }, autoPotion: { enabled: true, hp: 40 } })
    const b = new SettingsStore(storage)
    expect(b.get().controls.unreachableWarning).toBe(false)
    expect(b.get().autoPotion).toEqual({ enabled: true, hp: 40, mp: 30, cure: false })
  })

  it('Controls has the warning row and the Auto potion section; its sliders and pill row show while it is on', () => {
    const off = controlIds({})
    expect(off).toContain('controls.unreachableWarning')
    expect(off).toContain('autoPotion')
    expect(off).toContain('autoPotion.enabled')
    expect(off).not.toContain('autoPotion.hp')
    const on = controlIds({ autoPotion: { enabled: true } })
    expect(on.slice(on.indexOf('autoPotion'))).toEqual(['autoPotion', 'autoPotion.enabled', 'autoPotion.hp', 'autoPotion.mp', 'autoPotion.cure'])
  })

  it('the rows write their settings; the sliders read "Never" at 0 and a percent otherwise', () => {
    const rows = optionRows(host, defaultSettings(), 'on').controls
    const warn = rows.find(r => r.id === 'controls.unreachableWarning')
    expect(warn?.kind === 'toggle' && warn.patch(false)).toEqual({ controls: { unreachableWarning: false } })
    const hp = rows.find(r => r.id === 'autoPotion.hp')
    if (hp?.kind !== 'range') throw new Error('autoPotion.hp is a range row')
    expect([hp.min, hp.max, hp.step]).toEqual([0, 90, 5])
    expect(hp.patch(45)).toEqual({ autoPotion: { hp: 45 } })
    expect(hp.format(0)).toBe(t('options.autoPotion.never'))
    expect(hp.format(45)).toBe('45%')
    for (const r of rows) if (r.kind !== 'info' && r.kind !== 'button') expect(t(r.label), r.id).not.toBe(r.label)
  })
})

// ---- the "cannot get there" warning (K5) -------------------------------------------------------------------------

describe('the unreachable-spot warning switch', () => {
  const moveTo = (x: number, z: number): MoveState => ({ from: [0, 0, 0], to: [x, 0, z], start: 0, speed: 5.5 })
  function setup(warn: () => boolean) {
    const blocked: { want: GroundPoint; stop: GroundPoint; message: boolean }[] = []
    const sent: ClientMessage[] = []
    const fb = new MoveFeedback({
      send: m => (sent.push(m), true),
      self: () => ({ x: 0, z: 0 }),
      cursorGround: () => null,
      holdToMove: () => true,
      rtt: () => 50,
      blocked: (want, stop, message) => blocked.push({ want, stop, message }),
      warn,
    })
    return { fb, blocked }
  }

  it('off: neither a clipped walk nor a refused one is reported (no marker, line or sound)', () => {
    const { fb, blocked } = setup(() => false)
    fb.begin({ x: 20, z: 0 }, 0)
    fb.end()
    fb.onSelfMove(moveTo(8, 0), 60)
    fb.begin({ x: 0, z: 30 }, 500)
    fb.end()
    fb.tick(2000)
    expect(blocked).toEqual([])
  })

  it('on (and switched back on): reported as before, the line at most once per 2 s', () => {
    let on = false
    const { fb, blocked } = setup(() => on)
    fb.begin({ x: 20, z: 0 }, 0)
    fb.end()
    fb.onSelfMove(moveTo(8, 0), 60)
    expect(blocked).toEqual([])
    on = true
    fb.begin({ x: 20, z: 0 }, 100)
    fb.end()
    fb.onSelfMove(moveTo(8, 0), 160)
    expect(blocked).toEqual([{ want: { x: 20, z: 0 }, stop: { x: 8, z: 0 }, message: true }])
  })
})

// ---- the mouse quick slot ----------------------------------------------------------------------------------------

describe('the mouse quick slot', () => {
  const SMASH: HotbarEntry = { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' }
  const POT: HotbarEntry = { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' }
  const memory = (): MouseSlotStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>()
    return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
  }

  it('is kept per character name; junk and blocked storage read as empty', () => {
    const st = memory()
    const store = new MouseSlotStore(st)
    expect(store.get('Ann')).toBeNull()
    store.set('Ann', SMASH)
    store.set('Bob', POT)
    expect(new MouseSlotStore(st).get('Ann')).toEqual(SMASH)
    expect(new MouseSlotStore(st).get('Bob')).toEqual(POT)
    store.set('Ann', null)
    expect(store.get('Ann')).toBeNull()
    expect(store.get('Bob')).toEqual(POT)
    expect(readMouseSlots('{"A":{"kind":"skill","code":"bad code"},"B":{"kind":"x","code":"A"},"C":[1],"D":{"kind":"item","code":"ITEM_X"}}')).toEqual({ D: { kind: 'item', code: 'ITEM_X' } })
    expect(readMouseSlots('not json')).toEqual({})
    expect(readMouseSlots('[1,2]')).toEqual({})
    const throwing = new MouseSlotStore({ getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(throwing.get('Ann')).toBeNull()
    expect(() => throwing.set('Ann', SMASH)).not.toThrow()
    expect(new MouseSlotStore(null).get('Ann')).toBeNull()
  })

  it('remembers at most MOUSE_SLOT_MAX_CHARS characters (the oldest go first)', () => {
    const st = memory()
    const store = new MouseSlotStore(st)
    for (let i = 0; i <= MOUSE_SLOT_MAX_CHARS; i++) store.set(`C${i}`, SMASH)
    const all = JSON.parse(st.data.get(MOUSE_SLOT_KEY)!) as Record<string, unknown>
    expect(Object.keys(all).length).toBe(MOUSE_SLOT_MAX_CHARS)
    expect(all.C0).toBeUndefined()
    expect(store.get(`C${MOUSE_SLOT_MAX_CHARS}`)).toEqual(SMASH)
  })

  it('drops: from the skill window it fills; with a hotbar slot the two swap; off the bar it clears', () => {
    const hotbar: (HotbarEntry | null)[] = new Array(40).fill(null)
    hotbar[3] = POT
    expect(mouseSlotDrop(hotbar, null, SMASH, null, 'mouse', false)).toEqual({ send: [], mouse: SMASH })
    // hotbar 3 -> mouse (holding SMASH): the potion moves in, SMASH goes to slot 3
    const a = mouseSlotDrop(hotbar, SMASH, POT, 3, 'mouse', false)
    expect(a).toEqual({ send: [{ t: 'hotbarSet', slot: 3, entry: SMASH }], mouse: POT })
    // hotbar 3 -> an empty mouse slot: a move (slot 3 cleared)
    expect(mouseSlotDrop(hotbar, null, POT, 3, 'mouse', false)?.send).toEqual([{ t: 'hotbarSet', slot: 3, entry: null }])
    // mouse -> hotbar 3: SMASH there, the potion back in the mouse slot
    expect(mouseSlotDrop(hotbar, SMASH, SMASH, 'mouse', 3, false)).toEqual({ send: [{ t: 'hotbarSet', slot: 3, entry: SMASH }], mouse: POT })
    // mouse -> off the bar: cleared; onto a window: kept; onto itself: nothing
    expect(mouseSlotDrop(hotbar, SMASH, SMASH, 'mouse', null, false)).toEqual({ send: [], mouse: null })
    expect(mouseSlotDrop(hotbar, SMASH, SMASH, 'mouse', null, true)).toEqual({ send: [] })
    expect(mouseSlotDrop(hotbar, SMASH, SMASH, 'mouse', 'mouse', false)).toEqual({ send: [] })
    // not involved: hotbarDrop's rules
    expect(mouseSlotDrop(hotbar, SMASH, POT, 3, 5, false)).toBeNull()
    expect(mouseSlotDrop(hotbar, SMASH, POT, null, 5, false)).toBeNull()
    for (const m of a!.send) expect(valid(m)).toBe(true)
  })

  it('a middle press is a pointerdown of button 1, or the chorded pointermove while another button is held', () => {
    expect(isMiddlePress({ type: 'pointerdown', button: 1, buttons: 4 })).toBe(true)
    expect(isMiddlePress({ type: 'pointermove', button: 1, buttons: 6 })).toBe(true)
    expect(isMiddlePress({ type: 'pointermove', button: 1, buttons: 2 })).toBe(false) // the middle button released
    expect(isMiddlePress({ type: 'pointermove', button: -1, buttons: 4 })).toBe(false) // a drag with it held
    expect(isMiddlePress({ type: 'pointerdown', button: 0, buttons: 1 })).toBe(false)
    expect(isMiddlePress({ type: 'pointerdown', button: 2, buttons: 2 })).toBe(false)
    expect(isMiddlePress({ type: 'pointerup', button: 1, buttons: 0 })).toBe(false)
  })
})

// ---- the auto potion ---------------------------------------------------------------------------------------------

const item = (code: string, use: ItemDef['use'], extra: Partial<ItemDef> = {}): ItemDef => ({ code, category: 'potion', use, ...extra }) as ItemDef
const ITEMS = new Map<string, ItemDef>([
  item('ITEM_ETC_HP_POTION_01', { hp: 120, cooldownGroup: 'hp', cooldownMs: 1000 }),
  item('ITEM_ETC_HP_POTION_02', { hp: 220, cooldownGroup: 'hp', cooldownMs: 1000 }),
  item('ITEM_ETC_HP_POTION_03', { hp: 370, cooldownGroup: 'hp', cooldownMs: 1000 }),
  item('ITEM_ETC_HP_SPOTION_01', { hpPct: 25, cooldownGroup: 'hp', cooldownMs: 1000 }),
  item('ITEM_ETC_MP_POTION_01', { mp: 120, cooldownGroup: 'mp', cooldownMs: 1000 }),
  item('ITEM_ETC_ALL_POTION_01', { hp: 120, mp: 120, cooldownGroup: 'vigor', cooldownMs: 1000 }),
  item('ITEM_ETC_COS_HP_POTION_01', { hp: 360, cooldownGroup: 'cos_hp', cooldownMs: 1000, target: 'mount' }),
  item('ITEM_ETC_SCROLL_RETURN_01', { returnToTown: true, castMs: 30000 }, { category: 'scroll' }),
  item('ITEM_ETC_CURE_ALL_01', { cooldownGroup: 'cure', cooldownMs: 1000 }, { category: 'pill', cureLevel: 36 }),
  item('ITEM_ETC_CURE_ALL_02', { cooldownGroup: 'cure', cooldownMs: 1000 }, { category: 'pill', cureLevel: 68 }),
  item('ITEM_CH_SWORD_01_A', undefined, { category: 'weapon' }),
].map(d => [d.code, d]))

function harness(bag: (ItemStack | null)[], vitals: Vitals | null, opts: Partial<AutoPotionSettings> = {}) {
  const sent: ClientMessage[] = []
  const notices: RunOut[] = []
  const cooling = new Map<string, number>()
  const s = { enabled: true, hp: 50, mp: 30, cure: false, ...opts }
  const st = { bag, vitals, blocked: false, abnormal: [] as number[], online: true }
  const auto = new AutoPotion({
    settings: () => s,
    vitals: () => st.vitals,
    bagSize: () => st.bag.length,
    bag: i => st.bag[i] ?? null,
    item: code => ITEMS.get(code),
    blocked: () => st.blocked,
    abnormal: () => st.abnormal,
    cooldownLeft: g => cooling.get(g) ?? 0,
    send: m => (st.online ? (sent.push(m), true) : false),
    notice: k => notices.push(k),
  })
  return { auto, sent, notices, cooling, s, st }
}
const stack = (code: string, count = 5): ItemStack => ({ code, count }) as ItemStack
const V = (hp: number, mp: number, maxHp = 1000, maxMp = 1000): Vitals => ({ hp, maxHp, mp, maxMp })

describe('auto potion: choosing', () => {
  it('reads flat and percent restores; skips horse kits, scrolls and pills as potions', () => {
    expect(restoreOf({ hp: 120 }, 'hp', 1000)).toBe(120)
    expect(restoreOf({ hpPct: 25 }, 'hp', 800)).toBe(200)
    expect(restoreOf({ hp: 120 }, 'mp', 1000)).toBe(0)
    const bag = { bagSize: () => 6, bag: (i: number) => [stack('ITEM_ETC_COS_HP_POTION_01'), stack('ITEM_ETC_SCROLL_RETURN_01'), stack('ITEM_ETC_CURE_ALL_01'), stack('ITEM_ETC_HP_POTION_02'), stack('ITEM_ETC_HP_POTION_02'), stack('ITEM_ETC_ALL_POTION_01')][i] ?? null, item: (c: string) => ITEMS.get(c) }
    const hp = potionCandidates(bag, 'hp', 1000)
    expect(hp.map(c => [c.code, c.bag, c.amount, c.pure])).toEqual([['ITEM_ETC_HP_POTION_02', 3, 220, true], ['ITEM_ETC_ALL_POTION_01', 5, 120, false]])
    expect(pillCandidates(bag).map(c => [c.code, c.amount])).toEqual([['ITEM_ETC_CURE_ALL_01', 36]])
  })

  it('the smallest potion covering most of the missing amount, else the biggest', () => {
    const list = [{ amount: 370 }, { amount: 120 }, { amount: 220 }]
    expect(pickPotion(list, 100)?.amount).toBe(120)
    expect(pickPotion(list, 150)?.amount).toBe(120) // 120 >= 0.75 x 150
    expect(pickPotion(list, 170)?.amount).toBe(220)
    expect(pickPotion(list, 2000)?.amount).toBe(370)
    expect(pickPotion([], 100)).toBeNull()
    expect(COVER).toBe(0.75)
  })

  it('the smallest pill whose level covers the worst state, else the biggest that cures one', () => {
    const pills = [{ amount: 68 }, { amount: 36 }]
    expect(pickPill(pills, [10, 30])?.amount).toBe(36)
    expect(pickPill(pills, [10, 50])?.amount).toBe(68)
    expect(pickPill(pills, [10, 90])?.amount).toBe(68)
    expect(pickPill(pills, [80, 90])).toBeNull()
    expect(pickPill(pills, [])).toBeNull()
  })
})

describe('auto potion: when', () => {
  it('drinks the fitting HP potion below the threshold with exactly the hotbar\'s itemUse (lowest bag slot)', () => {
    const h = harness([stack('ITEM_ETC_HP_POTION_03'), stack('ITEM_ETC_HP_POTION_01'), stack('ITEM_ETC_HP_POTION_01')], V(500, 1000))
    h.auto.tick(0)
    expect(h.sent).toEqual([]) // 50 % is not below 50 %
    h.st.vitals = V(450, 1000)
    h.auto.tick(TICK_MS)
    expect(h.sent).toEqual([{ t: 'itemUse', bag: 0 }]) // 550 missing: the 370 potion (the 120 covers too little)
    h.st.vitals = V(880 - 400, 1000)
    h.st.bag = [stack('ITEM_ETC_HP_POTION_01'), stack('ITEM_ETC_HP_POTION_03')]
    h.auto.tick(TICK_MS * 2 + MIN_GAP_MS + 200)
    expect(h.sent[1]).toEqual({ t: 'itemUse', bag: 1 })
    for (const m of h.sent) expect(valid(m)).toBe(true)
  })

  it('never faster than the cooldown: the clock, then the unanswered request', () => {
    const h = harness([stack('ITEM_ETC_HP_POTION_01')], V(100, 1000))
    h.cooling.set('hp', 400)
    h.auto.tick(0)
    expect(h.sent).toEqual([])
    h.cooling.delete('hp')
    h.auto.tick(TICK_MS)
    expect(h.sent.length).toBe(1)
    // No answer yet (no itemCooldown): the group waits MIN_GAP_MS (+ slack) after the request.
    for (let now = 2 * TICK_MS; now < TICK_MS + MIN_GAP_MS; now += TICK_MS) h.auto.tick(now)
    expect(h.sent.length).toBe(1)
    h.auto.tick(TICK_MS + MIN_GAP_MS + 200)
    expect(h.sent.length).toBe(2)
  })

  it('HP and MP potions are separate groups: both go out together; MP below its own threshold only', () => {
    const h = harness([stack('ITEM_ETC_HP_POTION_01'), stack('ITEM_ETC_MP_POTION_01')], V(100, 400))
    h.auto.tick(0)
    expect(h.sent).toEqual([{ t: 'itemUse', bag: 0 }])
    const g = harness([stack('ITEM_ETC_HP_POTION_01'), stack('ITEM_ETC_MP_POTION_01')], V(100, 200))
    g.auto.tick(0)
    expect(g.sent).toEqual([{ t: 'itemUse', bag: 0 }, { t: 'itemUse', bag: 1 }])
    const off = harness([stack('ITEM_ETC_HP_POTION_01')], V(100, 1000), { hp: 0 })
    off.auto.tick(0)
    expect(off.sent).toEqual([])
  })

  it('vigor potions only when no plain potion is in the bag (not while the plain ones cool down)', () => {
    const h = harness([stack('ITEM_ETC_ALL_POTION_01'), stack('ITEM_ETC_HP_POTION_01')], V(100, 1000))
    h.cooling.set('hp', 900)
    h.auto.tick(0)
    expect(h.sent).toEqual([])
    const v = harness([stack('ITEM_ETC_ALL_POTION_01')], V(100, 100))
    v.auto.tick(0)
    expect(v.sent).toEqual([{ t: 'itemUse', bag: 0 }]) // HP takes it; MP finds the vigor group busy
  })

  it('never while dead, blocked (stall, trade), off, offline, or without stats', () => {
    const h = harness([stack('ITEM_ETC_HP_POTION_01')], V(0, 1000))
    h.auto.tick(0)
    h.st.vitals = V(100, 1000)
    h.st.blocked = true
    h.auto.tick(TICK_MS)
    h.st.blocked = false
    h.s.enabled = false
    h.auto.tick(2 * TICK_MS)
    h.s.enabled = true
    h.st.vitals = null
    h.auto.tick(3 * TICK_MS)
    h.st.vitals = V(100, 1000)
    h.st.online = false
    h.auto.tick(4 * TICK_MS)
    expect(h.sent).toEqual([])
    h.st.online = true
    h.auto.tick(5 * TICK_MS)
    expect(h.sent.length).toBe(1)
  })

  it('out of potions: one notice per run-out, not one per check', () => {
    const h = harness([stack('ITEM_CH_SWORD_01_A', 1)], V(100, 100))
    for (let now = 0; now < 5000; now += TICK_MS) h.auto.tick(now)
    expect(h.notices).toEqual(['hp', 'mp'])
    h.st.bag = [stack('ITEM_ETC_HP_POTION_01', 1)]
    h.auto.tick(5000)
    h.st.bag = []
    for (let now = 5100; now < 9000; now += TICK_MS) h.auto.tick(now)
    expect(h.notices).toEqual(['hp', 'mp', 'hp'])
  })

  it('a refusal backs off; reset forgets the waits and the notices', () => {
    const h = harness([stack('ITEM_ETC_HP_POTION_01')], V(100, 1000))
    h.auto.tick(0)
    expect(h.auto.sentWithin(500, 2000)).toBe(true)
    h.auto.refused(500)
    h.auto.tick(MIN_GAP_MS + 500)
    expect(h.sent.length).toBe(1)
    h.auto.tick(500 + REFUSED_BACKOFF_MS)
    expect(h.sent.length).toBe(2)
    h.auto.reset()
    h.auto.tick(500 + REFUSED_BACKOFF_MS + 1)
    expect(h.sent.length).toBe(3)
  })

  it('cures abnormal states with the fitting pill when the option is on (one notice without pills)', () => {
    const h = harness([stack('ITEM_ETC_CURE_ALL_02'), stack('ITEM_ETC_CURE_ALL_01')], V(1000, 1000))
    h.st.abnormal = [20]
    h.auto.tick(0)
    expect(h.sent).toEqual([])
    h.s.cure = true
    h.auto.tick(TICK_MS)
    expect(h.sent).toEqual([{ t: 'itemUse', bag: 1 }])
    const none = harness([], V(1000, 1000), { cure: true })
    none.st.abnormal = [20]
    for (let now = 0; now < 3000; now += TICK_MS) none.auto.tick(now)
    expect(none.notices).toEqual(['pill'])
    none.st.abnormal = []
    expect(none.sent).toEqual([])
  })
})

describe('the mouse quick slot is the server\'s (MOUSE_SLOT)', () => {
  it('comes with the skills snapshot and changes with skillsUpdate, apart from the 40 hotbar slots', () => {
    const state = new SkillState(new SkillCatalog([], [], []))
    const potion: HotbarEntry = { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' }
    state.applySnapshot({ t: 'skills', masteries: {} as never, skills: [], hotbar: new Array(HOTBAR_SLOTS).fill(null), mouse: potion })
    expect(state.mouse).toEqual(potion)
    expect(state.hotbar).toHaveLength(HOTBAR_SLOTS)
    const change = state.applyUpdate({ t: 'skillsUpdate', hotbar: [{ slot: MOUSE_SLOT, entry: null }] })
    expect(change).toMatchObject({ mouse: true, hotbar: [] })
    expect(state.mouse).toBeNull()
    expect(intent.hotbarSet(MOUSE_SLOT, potion)).toEqual({ t: 'hotbarSet', slot: MOUSE_SLOT, entry: potion })
  })
})

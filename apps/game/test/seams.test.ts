/**
 * The wave-3 client seams (docs/WAVE_PLAN.md §3.2–§3.3, §4.2 W3-FC): KeyMap, CooldownClock, level bands, the Esc
 * menu registry, the bag right-click route stack, the world feature runner, the mock extension hook, and every new
 * intent builder against the server's strict frame parser. DOM-free, like hud.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUYBACK_SLOTS, HOTBAR_SLOTS, MASTERY_CODES, MAX_GOLD, MAX_STORAGE_SIZE, parseClientMessage, type ClientMessage, type ServerMessage } from '@sro/shared'
import { CooldownClock, itemCooldownKey, skillCooldownKey } from '../src/hud/cooldowns.ts'
import { RouteStack } from '../src/hud/index.ts'
import { intent } from '../src/hud/intents.ts'
import { KeyMap, type KeyBinding, type KeyEventLike } from '../src/hud/keys.ts'
import { menuItems, registerMenuItem, type MenuContext } from '../src/hud/menu-items.ts'
import { MockServer, type KeyValueStore, type MockExtension } from '../src/net/mock.ts'
import { Session } from '../src/net/session.ts'
import { WORLD_FEATURES, WorldFeatures, type WorldFeatureContext, type WorldFeatureFactory } from '../src/world/features.ts'
import { intents } from '../src/world/intents.ts'
import { LEVEL_BAND_COLOR, LEVEL_BANDS, levelBand } from '../src/world/level-band.ts'

/** The message must survive the server's strict frame parser unchanged. */
function valid<T extends ClientMessage>(msg: T | null): T {
  if (msg === null) throw new Error('expected a message, got null')
  const parsed = parseClientMessage(JSON.stringify(msg))
  if (!parsed.ok) throw new Error(`${JSON.stringify(msg)} rejected: ${parsed.error}`)
  expect(parsed.msg).toEqual(msg)
  return msg
}

// ---- KeyMap ----------------------------------------------------------------------------------------

interface FakeKey extends KeyEventLike {
  prevented: boolean
}

function key(k: string, opts: Partial<Omit<FakeKey, 'preventDefault' | 'prevented'>> = {}): FakeKey {
  const ev: FakeKey = {
    key: k,
    type: 'keydown',
    repeat: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    target: null,
    prevented: false,
    preventDefault() {
      ev.prevented = true
    },
    ...opts,
  }
  return ev
}

function bind(map: KeyMap, keys: string[], extra: Partial<KeyBinding> = {}) {
  const calls: string[] = []
  const off = map.register({ id: extra.id ?? keys.join('+'), keys, label: 'keys.window.inventory', group: 'windows', run: () => calls.push('run'), ...extra })
  return { calls, off }
}

describe('KeyMap (UX_GAPS §4.1, fed through handle())', () => {
  afterEach(() => vi.restoreAllMocks())

  it('matches letters case-insensitively and named keys lower-cased', () => {
    const map = new KeyMap()
    const i = bind(map, ['i'])
    const f1 = bind(map, ['F1'])
    const ev = key('I', { shiftKey: true })
    map.handle(ev)
    map.handle(key('i'))
    map.handle(key('F1'))
    expect(i.calls).toEqual(['run', 'run'])
    expect(f1.calls).toEqual(['run'])
    expect(ev.prevented).toBe(true)
    expect(map.list().map(b => b.keys[0])).toEqual(['i', 'f1'])
  })

  it('fires a mods binding only with its chord and skips undeclared Ctrl/Alt/Meta chords', () => {
    const map = new KeyMap()
    const plain = bind(map, ['f'], { id: 'plain' })
    const chord = bind(map, ['f'], { id: 'fps', mods: ['ctrl', 'shift'] })
    map.handle(key('f', { ctrlKey: true }))
    map.handle(key('f', { altKey: true }))
    map.handle(key('f', { metaKey: true }))
    expect(plain.calls).toEqual([])
    expect(chord.calls).toEqual([])
    map.handle(key('F', { ctrlKey: true, shiftKey: true }))
    expect(chord.calls).toEqual(['run'])
    expect(plain.calls).toEqual([])
    map.handle(key('f'))
    expect(plain.calls).toEqual(['run'])
    expect(chord.calls).toEqual(['run'])
  })

  it('ignores typing targets and open modals', () => {
    let modal = false
    const map = new KeyMap({ blocked: () => modal })
    const b = bind(map, ['c'])
    map.handle(key('c', { target: { tagName: 'INPUT' } as unknown as EventTarget }))
    map.handle(key('c', { target: { tagName: 'TEXTAREA' } as unknown as EventTarget }))
    map.handle(key('c', { target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget }))
    modal = true
    map.handle(key('c'))
    expect(b.calls).toEqual([])
    modal = false
    map.handle(key('c', { target: { tagName: 'CANVAS' } as unknown as EventTarget }))
    expect(b.calls).toEqual(['run'])
  })

  it('gates on when()', () => {
    const map = new KeyMap()
    let staff = false
    const b = bind(map, ['f9'], { when: () => staff })
    map.handle(key('F9'))
    staff = true
    map.handle(key('F9'))
    expect(b.calls).toEqual(['run'])
  })

  it('warns on a duplicate key and lets the later binding win; unregister restores the earlier one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = new KeyMap()
    const first = bind(map, ['s'], { id: 'first' })
    const second = bind(map, ['s', 'k'], { id: 'second' })
    expect(warn).toHaveBeenCalledTimes(1)
    map.handle(key('s'))
    expect(second.calls).toEqual(['run'])
    expect(first.calls).toEqual([])
    second.off()
    map.handle(key('s'))
    map.handle(key('k'))
    expect(first.calls).toEqual(['run'])
    expect(second.calls).toEqual(['run'])
    first.off()
    expect(map.list()).toEqual([])
  })

  it('skips key repeat unless the binding asks for it', () => {
    const map = new KeyMap()
    const once = bind(map, ['i'])
    const held = bind(map, ['arrowleft'], { repeat: true })
    map.handle(key('i', { repeat: true }))
    map.handle(key('ArrowLeft', { repeat: true }))
    expect(once.calls).toEqual([])
    expect(held.calls).toEqual(['run'])
  })

  it('sends the keyup to the binding its keydown fired (also from a typing target), and releases on blur', () => {
    const map = new KeyMap()
    const ups: string[] = []
    bind(map, ['g'], { up: () => ups.push('up') })
    map.handle(key('g'))
    map.handle(key('g', { type: 'keyup', target: { tagName: 'INPUT' } as unknown as EventTarget }))
    map.handle(key('g', { type: 'keyup' }))
    expect(ups).toEqual(['up'])
    map.handle(key('g'))
    map.releaseAll()
    expect(ups).toEqual(['up', 'up'])
  })

  it('keeps going when a binding throws', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const map = new KeyMap()
    map.register({ id: 'bad', keys: ['x'], label: 'keys.window.inventory', group: 'debug', run: () => { throw new Error('boom') } })
    expect(() => map.handle(key('x'))).not.toThrow()
    expect(err).toHaveBeenCalled()
  })
})

// ---- CooldownClock ---------------------------------------------------------------------------------

describe('CooldownClock (decision 8)', () => {
  it('sets, reports remaining time and change events, with skill:/item: keys', () => {
    let now = 1000
    const clock = new CooldownClock(() => now)
    const events: [string, number | null][] = []
    const off = clock.onChange((k, e) => events.push([k, e ? e.readyAt : null]))
    expect(skillCooldownKey('SKILL_CH_SWORD_SMASH_A')).toBe('skill:SKILL_CH_SWORD_SMASH_A')
    expect(itemCooldownKey('HP_POTION')).toBe('item:HP_POTION')
    clock.set('skill:A', 5000, 4000)
    clock.setIn('item:HP', 1000)
    expect(clock.get('skill:A')).toEqual({ readyAt: 5000, totalMs: 4000 })
    expect(clock.get('item:HP')).toEqual({ readyAt: 2000, totalMs: 1000 })
    expect(clock.remaining('skill:A')).toBe(4000)
    expect(clock.remaining('skill:A', 4500)).toBe(500)
    expect(clock.remaining('skill:A', 9000)).toBe(0)
    expect(clock.remaining('unknown')).toBe(0)
    now = 1500
    expect(clock.remaining('item:HP')).toBe(500)
    clock.clear('item:HP')
    expect(clock.get('item:HP')).toBeNull()
    off()
    clock.set('skill:B', 1, 1)
    expect(events).toEqual([
      ['skill:A', 5000],
      ['item:HP', 2000],
      ['item:HP', null],
    ])
    clock.clear()
    expect(clock.get('skill:A')).toBeNull()
    expect(clock.get('skill:B')).toBeNull()
  })

  it('returns copies, so callers cannot change the clock', () => {
    const clock = new CooldownClock(() => 0)
    clock.set('skill:A', 10, 10)
    clock.get('skill:A')!.readyAt = 99
    expect(clock.remaining('skill:A', 0)).toBe(10)
  })
})

// ---- level bands -------------------------------------------------------------------------------------

describe('levelBand (UX_GAPS §4.2)', () => {
  it('uses the table boundaries (d = mob level − own level)', () => {
    const self = 10
    const at = (d: number) => levelBand(self + d, self)
    expect(at(-20)).toBe('weak2')
    expect(at(-6)).toBe('weak2')
    expect(at(-5)).toBe('weak1')
    expect(at(-3)).toBe('weak1')
    expect(at(-2)).toBe('normal')
    expect(at(0)).toBe('normal')
    expect(at(2)).toBe('normal')
    expect(at(3)).toBe('strong1')
    expect(at(5)).toBe('strong1')
    expect(at(6)).toBe('strong2')
    expect(at(30)).toBe('strong2')
    for (const b of LEVEL_BANDS) expect(LEVEL_BAND_COLOR[b]).toMatch(/^#[0-9a-f]{6}$/)
  })
})

// ---- Esc menu ----------------------------------------------------------------------------------------

describe('Esc menu items (decision 20)', () => {
  it('lists the built-ins, then lane entries by order; ids replace, when() hides, unregister removes', () => {
    expect(menuItems().map(i => i.id)).toEqual(['characterSelect', 'logout', 'resume'])
    let showKeys = true
    const offs = [
      registerMenuItem({ id: 'sound', label: 'menu.resume', order: 30, run: () => {} }),
      registerMenuItem({ id: 'options', label: 'menu.resume', order: 10, run: () => {} }),
      registerMenuItem({ id: 'keyhelp', label: 'menu.resume', order: 20, run: () => {}, when: () => showKeys }),
    ]
    expect(menuItems().map(i => i.id)).toEqual(['options', 'keyhelp', 'sound', 'characterSelect', 'logout', 'resume'])
    showKeys = false
    expect(menuItems().map(i => i.id)).toEqual(['options', 'sound', 'characterSelect', 'logout', 'resume'])
    offs.push(registerMenuItem({ id: 'sound', label: 'menu.resume', order: 5, run: () => {} }))
    expect(menuItems().map(i => i.id)).toEqual(['sound', 'options', 'characterSelect', 'logout', 'resume'])
    for (const off of offs) off()
    expect(menuItems().map(i => i.id)).toEqual(['characterSelect', 'logout', 'resume'])
  })

  it('built-ins run the world screen actions', () => {
    const done: string[] = []
    const ctx = { app: null as never, close: () => done.push('close'), characterSelect: () => done.push('select'), logout: () => done.push('logout') } satisfies MenuContext
    for (const item of menuItems()) item.run(ctx)
    expect(done).toEqual(['select', 'logout', 'close'])
  })
})

// ---- bag right-click routes ------------------------------------------------------------------------------

describe('routeBagAction stack (hud.routeBagAction)', () => {
  it('asks the last registered route first and stops at the first that consumes', () => {
    const stack = new RouteStack<number>()
    const asked: string[] = []
    const offShop = stack.push(bag => (asked.push(`shop ${bag}`), bag === 3))
    const offStorage = stack.push(bag => (asked.push(`storage ${bag}`), bag === 1))
    expect(stack.run(1)).toBe(true)
    expect(asked).toEqual(['storage 1'])
    asked.length = 0
    expect(stack.run(3)).toBe(true)
    expect(asked).toEqual(['storage 3', 'shop 3'])
    asked.length = 0
    expect(stack.run(7)).toBe(false) // -> the default use/equip
    expect(asked).toEqual(['storage 7', 'shop 7'])
    offStorage()
    asked.length = 0
    expect(stack.run(1)).toBe(false)
    expect(asked).toEqual(['shop 1'])
    offShop()
    expect(stack.run(3)).toBe(false)
  })

  it('treats a throwing route as not consuming', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stack = new RouteStack<number>()
    stack.push(() => true)
    stack.push(() => {
      throw new Error('boom')
    })
    expect(stack.run(0)).toBe(true)
    vi.restoreAllMocks()
  })
})

// ---- world features ------------------------------------------------------------------------------------

describe('world features (§3.2)', () => {
  it('lists the five wave-3 lanes in order (wave 4 appends; seams-w4.test.ts); a bare context never breaks the runner', () => {
    expect(WORLD_FEATURES.map(f => f.name).slice(0, 5)).toEqual(['skillsFeature', 'npcFeature', 'soundFeature', 'uxWorldFeature', 'mapFeature'])
    // The lanes are filled now (wave 3 merged): a feature may refuse to start on an empty context, but the runner
    // isolates it and keeps the others.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fs = new WorldFeatures({} as WorldFeatureContext)
    let calls = 0
    fs.each(() => void calls++)
    expect(calls).toBeLessThanOrEqual(WORLD_FEATURES.length)
    expect(() => fs.dispose()).not.toThrow()
    vi.restoreAllMocks()
  })

  it('isolates a failing factory or hook, and some() stops at the first consumer', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    const factories: WorldFeatureFactory[] = [
      () => {
        throw new Error('no start')
      },
      () => ({ escape: () => (seen.push('a'), false), onFrame: () => { throw new Error('frame') } }),
      () => ({ escape: () => (seen.push('b'), true), onFrame: () => void seen.push('frame b'), dispose: () => void seen.push('dispose b') }),
      () => ({ escape: () => (seen.push('c'), true) }),
    ]
    const fs = new WorldFeatures({} as WorldFeatureContext, factories)
    expect(fs.some(f => f.escape?.())).toBe(true)
    expect(seen).toEqual(['a', 'b'])
    fs.each(f => f.onFrame?.(0, 0.016))
    fs.dispose()
    expect(seen).toEqual(['a', 'b', 'frame b', 'dispose b'])
    expect(fs.some(f => f.escape?.())).toBe(false)
    vi.restoreAllMocks()
  })
})

// ---- mock extensions --------------------------------------------------------------------------------------

function memory(): KeyValueStore {
  const m = new Map<string, string>()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0))
}

describe('MockServer.extensions (§3.3)', () => {
  it('lets a lane mock claim requests, see enter-world and ticks; unclaimed wave-3 requests get not_implemented', async () => {
    let now = 3_000_000_000
    const seen: string[] = []
    const ext: MockExtension = {
      handle(ctx, conn, msg) {
        if (msg.t !== 'npcTalk') return false
        const self = ctx.selfOf(conn)
        seen.push(`talk ${msg.npc} by ${self?.state.name}`)
        ctx.result(conn, 'npcTalk', true)
        return true
      },
      enter: (ctx, conn) => void seen.push(`enter ${ctx.selfOf(conn)?.state.name}`),
      tick: (_ctx, t) => void seen.push(`tick ${t}`),
    }
    const server = new MockServer(memory(), 0, () => now, [ext])
    await server.register({ username: 'seams', password: 'secret' })
    const { token } = await server.login({ username: 'seams', password: 'secret' })
    const s = new Session(() => server.wire(), token)
    const log: ServerMessage[] = []
    s.on(m => void log.push(m))
    await s.connect()
    const { character } = await s.request({ t: 'charCreate', name: 'Seamer', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' }, ['charCreated'])
    await s.request({ t: 'enterWorld', id: character.id }, ['worldEnter'])
    await flush()
    expect(seen).toContain('enter Seamer')
    const npc = log.flatMap(m => (m.t === 'worldEnter' ? m.entities : [])).find(e => e.kind === 'npc')
    s.send(valid(intents.npcTalk(npc?.id ?? 1) as Extract<ClientMessage, { t: 'npcTalk' }>))
    s.send(valid(intent.npcClose()))
    await flush()
    const results = log.filter(m => m.t === 'actionResult')
    expect(results).toEqual([
      { t: 'actionResult', re: 'npcTalk', ok: true },
      { t: 'actionResult', re: 'npcClose', ok: false, reason: 'not_implemented' },
    ])
    expect(seen).toContain(`talk ${npc?.id ?? 1} by Seamer`)
    now += 100
    server.step()
    expect(seen).toContain(`tick ${now}`)
    s.close()
    server.dropAll()
  })
})

// ---- intent builders -------------------------------------------------------------------------------------

describe('wave-3 intent builders pass parseClientMessage', () => {
  it('HUD builders (hud/intents.ts)', () => {
    valid(intent.skillLearn('SKILL_CH_SWORD_SMASH_A_01'))
    for (const m of MASTERY_CODES) valid(intent.masteryUp(m))
    valid(intent.buffCancel('SKILL_CH_WATER_SELF_A_01'))
    valid(intent.hotbarSet(0, { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' }))
    valid(intent.hotbarSet(HOTBAR_SLOTS - 1, { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' }))
    valid(intent.hotbarSet(5, null))
    valid(intent.useSkill('SKILL_CH_SWORD_SMASH_A_01'))
    valid(intent.useSkill('SKILL_CH_SWORD_SMASH_A_01', 123))
    valid(intent.npcClose())
    valid(intent.storageOpen(55))
    valid(intent.storageDeposit(55, 0))
    valid(intent.storageDeposit(55, 95, 10, MAX_STORAGE_SIZE - 1))
    valid(intent.storageWithdraw(55, 3))
    valid(intent.storageWithdraw(55, 3, 2, 12))
    valid(intent.storageMove(55, 0, 149))
    valid(intent.storageGold(55, 'deposit', 1))
    valid(intent.storageGold(55, 'withdraw', MAX_GOLD))
    valid(intent.shopBuy(55, 'ITEM_ETC_HP_POTION_01', 50))
    valid(intent.shopSell(55, 4))
    valid(intent.shopSell(55, 4, 3))
    valid(intent.shopBuyback(55, 0))
    valid(intent.shopBuyback(55, BUYBACK_SLOTS - 1))
  })

  it('HUD builders refuse what the server would reject', () => {
    expect(intent.skillLearn('bad code')).toBeNull()
    expect(intent.skillLearn('')).toBeNull()
    expect(intent.masteryUp('WATER' as never)).toBeNull()
    expect(intent.hotbarSet(HOTBAR_SLOTS, null)).toBeNull()
    expect(intent.hotbarSet(-1, null)).toBeNull()
    expect(intent.hotbarSet(1.5, null)).toBeNull()
    expect(intent.hotbarSet(0, { kind: 'emote' as never, code: 'X' })).toBeNull()
    expect(intent.hotbarSet(0, { kind: 'skill', code: 'lower' })).toBeNull()
    // Extra keys on the entry are not copied (the server rejects them).
    valid(intent.hotbarSet(0, { kind: 'skill', code: 'X', extra: 1 } as never))
    expect(intent.useSkill('SKILL_X', -1)).toBeNull()
    expect(intent.useSkill('SKILL_X', 1.5)).toBeNull()
    expect(intent.storageOpen(-1)).toBeNull()
    expect(intent.storageDeposit(1, 96)).toBeNull()
    expect(intent.storageDeposit(1, 0, 0)).toBeNull()
    expect(intent.storageDeposit(1, 0, 1, MAX_STORAGE_SIZE)).toBeNull()
    expect(intent.storageWithdraw(1, MAX_STORAGE_SIZE)).toBeNull()
    expect(intent.storageWithdraw(1, 0, 1, -1)).toBeNull()
    expect(intent.storageMove(1, 4, 4)).toBeNull()
    expect(intent.storageGold(1, 'deposit', 0)).toBeNull()
    expect(intent.storageGold(1, 'deposit', MAX_GOLD + 1)).toBeNull()
    expect(intent.storageGold(1, 'steal' as never, 5)).toBeNull()
    expect(intent.shopBuy(1, 'ITEM_X', 0)).toBeNull()
    expect(intent.shopBuy(1, 'item x', 1)).toBeNull()
    expect(intent.shopSell(1, 0, 0)).toBeNull()
    expect(intent.shopBuyback(1, BUYBACK_SLOTS)).toBeNull()
  })

  it('world builders (world/intents.ts)', () => {
    valid(intents.npcTalk(77) as Extract<ClientMessage, { t: 'npcTalk' }>)
    valid(intents.chat('hi') as Extract<ClientMessage, { t: 'chat' }>)
    valid(intents.chat('psst', 'Xiao_Lin') as Extract<ClientMessage, { t: 'chat' }>)
    valid(intents.chat('all', undefined, 'party') as Extract<ClientMessage, { t: 'chat' }>)
    valid(intents.chat('here', undefined, 'local') as Extract<ClientMessage, { t: 'chat' }>)
    // A whisper wins over the party channel (the two together are a bad_request).
    expect(valid(intents.chat('psst', 'MeiHua', 'party') as Extract<ClientMessage, { t: 'chat' }>)).toEqual({ t: 'chat', text: 'psst', to: 'MeiHua' })
    // A malformed name is kept, so the frame is refused instead of the whisper going out as local chat.
    expect(parseClientMessage(JSON.stringify(intents.chat('psst', 'ab'))).ok).toBe(false)
  })
})

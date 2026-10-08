/**
 * Lane UX-A (docs/UX_GAPS.md §8 UX-A, docs/WAVE_PLAN.md §4.13): the settings store, graphics quality and resolution,
 * the refresh resume, the perf overlay rule, the unusable-item rule, key help, the Options rows and the menu bar order.
 * DOM-free, like hud.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ItemDef } from '@sro/shared'
import { QUALITY_PRESETS } from '@sro/world-render'
import { statStep } from '../src/hud/character.ts'
import { HELP_HINT_SESSIONS, keyCaption, keyHelpGroups, keyName, takeHelpHint } from '../src/hud/keyhelp.ts'
import { canUse, ItemCatalog } from '../src/hud/items.ts'
import { KeyMap, type KeyBinding, type KeyEventLike } from '../src/hud/keys.ts'
import { sortEntries } from '../src/hud/menubar.ts'
import { optionRows, OPTIONS_TABS, visibleRows, type OptionsHost } from '../src/hud/options.ts'
import { perfText, perfVisible } from '../src/hud/perf-overlay.ts'
import { clearSession, loadSession, saveSession, sessionKey, tokenRefused, type ResumeStorage } from '../src/net/resume.ts'
import {
  applyGraphics,
  defaultSettings,
  normalizeSettings,
  qualityFor,
  scalingLevel,
  SETTINGS_KEY,
  SettingsStore,
  SIGHT_MUL,
  type Settings,
  type SettingsStorage,
} from '../src/settings.ts'

class MapStorage implements SettingsStorage, ResumeStorage {
  readonly data = new Map<string, string>()
  getItem(k: string) {
    return this.data.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.data.set(k, v)
  }
  removeItem(k: string) {
    this.data.delete(k)
  }
}

const throwing: SettingsStorage & ResumeStorage = {
  getItem() {
    throw new Error('blocked')
  },
  setItem() {
    throw new Error('blocked')
  },
  removeItem() {
    throw new Error('blocked')
  },
}

afterEach(() => vi.restoreAllMocks())

// ---- settings --------------------------------------------------------------------------------------

describe('settings store (UX_GAPS §4.3)', () => {
  it('uses the defaults when storage is missing, throws or holds garbage', () => {
    expect(new SettingsStore(null).get()).toEqual(defaultSettings())
    expect(new SettingsStore(throwing).get()).toEqual(defaultSettings())
    const bad = new MapStorage()
    bad.setItem(SETTINGS_KEY, '{not json')
    expect(new SettingsStore(bad).get()).toEqual(defaultSettings())
    bad.setItem(SETTINGS_KEY, '[1,2,3]')
    expect(new SettingsStore(bad).get()).toEqual(defaultSettings())
  })

  it('clamps every range and rejects unknown enum values', () => {
    const s = normalizeSettings({
      graphics: { preset: 'extreme', resolution: 0.3, sight: 9 },
      ui: { scale: 3, minimapZoom: 12, names: { items: 'never', players: 'yes' }, helpHintSessions: -4 },
      controls: { cameraSpeed: 0.1, cameraMode: 'fps' },
    })
    expect(s.graphics).toEqual(defaultSettings().graphics)
    expect(s.ui.scale).toBe(1.4)
    expect(s.ui.minimapZoom).toBe(4)
    expect(s.ui.names.items).toBe('near')
    expect(s.ui.names.players).toBe(true)
    expect(s.ui.helpHintSessions).toBe(0)
    expect(s.controls.cameraSpeed).toBe(0.5)
    expect(s.controls.cameraMode).toBe('free')
    expect(normalizeSettings({ ui: { scale: 0.1 }, controls: { cameraSpeed: 7 } })).toMatchObject({ ui: { scale: 0.8 }, controls: { cameraSpeed: 2 } })
    expect(normalizeSettings({ ui: { minimapZoom: -1 } }).ui.minimapZoom).toBe(0)
  })

  it('merges patches, saves, and notifies with next and previous', () => {
    const storage = new MapStorage()
    const store = new SettingsStore(storage)
    const seen: [Settings, Settings][] = []
    const off = store.onChange((s, prev) => seen.push([s, prev]))
    store.set({ graphics: { preset: 'low' }, ui: { names: { mobs: false } } })
    expect(seen).toHaveLength(1)
    expect(seen[0]![1].graphics.preset).toBe('medium')
    expect(seen[0]![0].graphics.preset).toBe('low')
    expect(store.get().ui.names).toEqual({ players: true, mobs: false, npcs: true, items: 'near' })
    // Persisted, and a new store reads it back.
    expect(new SettingsStore(storage).get().graphics.preset).toBe('low')
    // No change -> no event; an out-of-range value is clamped before comparing.
    store.set({ graphics: { preset: 'low' } })
    expect(seen).toHaveLength(1)
    store.set({ ui: { scale: 9 } })
    expect(store.get().ui.scale).toBe(1.4)
    off()
    store.reset()
    expect(seen).toHaveLength(2)
    expect(store.get()).toEqual(defaultSettings())
  })

  it('still applies for the page when saving throws', () => {
    const store = new SettingsStore(throwing)
    store.set({ ui: { showFps: true } })
    expect(store.get().ui.showFps).toBe(true)
  })

  it('isolates a throwing listener', () => {
    const store = new SettingsStore(null)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: string[] = []
    store.onChange(() => {
      throw new Error('boom')
    })
    store.onChange(() => calls.push('second'))
    store.set({ ui: { expInChat: true } })
    expect(calls).toEqual(['second'])
    expect(err).toHaveBeenCalled()
  })
})

describe('graphics (R4, R5)', () => {
  it('qualityFor folds the sight range into the preset draw distance', () => {
    const s = normalizeSettings({ graphics: { preset: 'high', sight: 0 } })
    expect(qualityFor(s)).toEqual({ ...QUALITY_PRESETS.high, drawDistance: QUALITY_PRESETS.high.drawDistance * SIGHT_MUL[0]! })
    const broad = normalizeSettings({ graphics: { preset: 'low', sight: 2 } })
    expect(qualityFor(broad)).toEqual(QUALITY_PRESETS.low)
    // An explicit preset (the one the world loaded with) wins over the settings'.
    expect(qualityFor(broad, 'medium').drawDistance).toBe(QUALITY_PRESETS.medium.drawDistance)
    expect(qualityFor(normalizeSettings({ graphics: { sight: 3 } })).drawDistance).toBeCloseTo(1.4)
  })

  it('resolution maps to Babylon hardware scaling, and follows changes', () => {
    expect(scalingLevel(1, 2)).toBe(0.5) // today's adaptToDeviceRatio behaviour
    expect(scalingLevel(0.5, 2)).toBe(1)
    expect(scalingLevel(0.75, 1)).toBeCloseTo(1 / 0.75)
    expect(scalingLevel(1, NaN)).toBe(1)
    const store = new SettingsStore(null)
    const levels: number[] = []
    const engine = { resize() {}, setHardwareScalingLevel: (l: number) => levels.push(l) }
    const off = applyGraphics(engine, store)
    expect(levels).toEqual([1])
    store.set({ graphics: { resolution: 0.5 } })
    store.set({ ui: { showFps: true } }) // not a graphics change
    expect(levels).toEqual([1, 2])
    off()
    store.set({ graphics: { resolution: 1 } })
    expect(levels).toEqual([1, 2])
  })
})

// ---- KeyMap (the UX-A contract; seams.test.ts has the rest) -----------------------------------------

function key(k: string, opts: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: k, type: 'keydown', repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: null, preventDefault() {}, ...opts }
}

describe('KeyMap for the shell keys', () => {
  it('H is case-insensitive; Ctrl+Shift+F only fires with exactly its chord', () => {
    const map = new KeyMap()
    const calls: string[] = []
    map.register({ id: 'window.help', keys: ['h'], label: 'keys.window.help', group: 'windows', run: () => calls.push('h') })
    map.register({ id: 'debug.fps', keys: ['f'], mods: ['ctrl', 'shift'], label: 'keys.debug.fps', group: 'debug', run: () => calls.push('fps') })
    map.handle(key('H', { shiftKey: true }))
    map.handle(key('h', { ctrlKey: true }))
    map.handle(key('F'))
    map.handle(key('F', { ctrlKey: true }))
    map.handle(key('F', { ctrlKey: true, shiftKey: true }))
    map.handle(key('F', { ctrlKey: true, shiftKey: true, altKey: true }))
    map.handle(key('h', { target: { tagName: 'INPUT' } as unknown as EventTarget }))
    map.handle(key('h', { repeat: true }))
    expect(calls).toEqual(['h', 'fps'])
  })

  it('gates GM keys with when() and unregisters', () => {
    const map = new KeyMap()
    let staff = false
    const calls: string[] = []
    const off = map.register({ id: 'gm.window', keys: ['f9'], label: 'keys.gm.window', group: 'gm', when: () => staff, run: () => calls.push('f9') })
    map.handle(key('F9'))
    staff = true
    map.handle(key('F9'))
    off()
    map.handle(key('F9'))
    expect(calls).toEqual(['f9'])
  })

  it('warns on a duplicate key and the later binding wins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = new KeyMap()
    const calls: string[] = []
    map.register({ id: 'a', keys: ['h'], label: 'keys.window.help', group: 'windows', run: () => calls.push('a') })
    map.register({ id: 'b', keys: ['H'], label: 'keys.window.help', group: 'windows', run: () => calls.push('b') })
    map.handle(key('h'))
    expect(calls).toEqual(['b'])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

// ---- resume (L1) -------------------------------------------------------------------------------

describe('refresh resume (L1)', () => {
  const now = 1_700_000_000_000
  const good = { token: 'tok', username: 'dayan', expiresAt: now + 3_600_000 }

  it('round-trips a valid session and keeps mock and real apart', () => {
    const st = new MapStorage()
    saveSession(good, false, st)
    expect(loadSession(false, now, st)).toEqual(good)
    expect(loadSession(true, now, st)).toBeNull()
    expect([...st.data.keys()]).toEqual([sessionKey(false)])
  })

  it('does not use (and drops) an expired or nearly expired token', () => {
    const st = new MapStorage()
    saveSession({ ...good, expiresAt: now + 30_000 }, false, st)
    expect(loadSession(false, now, st)).toBeNull()
    expect(st.data.size).toBe(0)
    saveSession({ ...good, expiresAt: now - 1 }, false, st)
    expect(loadSession(false, now, st)).toBeNull()
  })

  it('never saves a session without a token or expiry, and ignores malformed data', () => {
    const st = new MapStorage()
    saveSession({ ...good, token: '' }, false, st)
    saveSession({ ...good, expiresAt: 0 }, false, st)
    expect(st.data.size).toBe(0)
    st.setItem(sessionKey(false), '{"token":5}')
    expect(loadSession(false, now, st)).toBeNull()
    st.setItem(sessionKey(false), 'nope')
    expect(loadSession(false, now, st)).toBeNull()
  })

  it('clearSession (logout) removes it; blocked storage reads as no session', () => {
    const st = new MapStorage()
    saveSession(good, false, st)
    clearSession(false, st)
    expect(loadSession(false, now, st)).toBeNull()
    expect(loadSession(false, now, throwing)).toBeNull()
    expect(() => saveSession(good, false, throwing)).not.toThrow()
    expect(() => clearSession(false, throwing)).not.toThrow()
    expect(loadSession(false, now, null)).toBeNull()
  })

  it('knows which refusals make the token useless (and which are a server that is down)', () => {
    for (const c of ['unauthorized', 'replaced', 'kicked', 'abuse']) expect(tokenRefused(c), c).toBe(true)
    // A new client version is fixed by the reload itself: keep the login.
    for (const c of ['network', 'timeout', 'lost', 'version_mismatch', undefined]) expect(tokenRefused(c), String(c)).toBe(false)
  })
})

// ---- perf overlay (H1) ---------------------------------------------------------------------------

describe('perf overlay (H1)', () => {
  it('is hidden unless Show FPS is on', () => {
    expect(perfVisible(defaultSettings())).toBe(false)
    expect(perfVisible(normalizeSettings({ ui: { showFps: true } }))).toBe(true)
  })

  it('prints engine, fps, ping, players and draws', () => {
    const text = perfText({ engine: 'WebGPU', fps: 59.7, ping: 23.4, players: 3, draws: 412.2, mock: false })
    expect(text).toContain('WebGPU')
    expect(text).toContain('60 fps')
    expect(text).toContain('23 ms')
    expect(text).toContain('3 online')
    expect(text).toContain('412 draws')
    expect(perfText({ engine: 'WebGL2', fps: 30, ping: null, players: 1, draws: 1, mock: true })).toMatch(/- ms.*mock/)
  })
})

// ---- unusable items (W3) ---------------------------------------------------------------------------

function item(p: Partial<ItemDef>): ItemDef {
  return {
    code: 'ITEM_CH_SWORD_01_A',
    id: 1,
    name: 'Sword',
    typeId: [3, 1, 6, 2],
    category: 'weapon',
    slot: 'weapon',
    degree: 1,
    reqLevel: 0,
    reqGender: 'any',
    race: 'china',
    maxStack: 1,
    price: 10,
    sellPrice: 1,
    model: null,
    icon: null,
    ...p,
  }
}

describe('canUse (W3: the server wearProblem rules)', () => {
  const man = 'CHAR_CH_MAN_ADVENTURER'
  const woman = 'CHAR_CH_WOMAN_ADVENTURER'

  it('blocks gear above the level, of the other gender, or European', () => {
    expect(canUse(item({ reqLevel: 5 }), { level: 1 }, man)).toBe(false)
    expect(canUse(item({ reqLevel: 5 }), { level: 5 }, man)).toBe(true)
    expect(canUse(item({ reqGender: 'female' }), { level: 9 }, man)).toBe(false)
    expect(canUse(item({ reqGender: 'female' }), { level: 9 }, woman)).toBe(true)
    expect(canUse(item({ reqGender: 'male' }), { level: 9 }, woman)).toBe(false)
    expect(canUse(item({ race: 'europe' }), { level: 9 }, man)).toBe(false)
    expect(canUse(item({ race: 'any' }), { level: 9 }, man)).toBe(true)
  })

  it('never blocks consumables, unknown items, or before stats and model are known', () => {
    expect(canUse(item({ slot: undefined, category: 'potion' as ItemDef['category'], reqLevel: 10 }), { level: 1 }, man)).toBe(true)
    expect(canUse(undefined, { level: 1 }, man)).toBe(true)
    expect(canUse(item({ reqLevel: 5, reqGender: 'female' }), null, null)).toBe(true)
  })

  it('the tooltip marks a wrong gender red', () => {
    const cat = new ItemCatalog([item({ reqGender: 'female' })])
    const stack = { code: 'ITEM_CH_SWORD_01_A', count: 1 }
    const line = (model: string | null) => cat.tooltip(stack, { player: { level: 1 }, model }).find(l => /female/i.test(l.text))
    expect(line(man)?.cls).toBe('bad')
    expect(line(woman)?.cls).toBe('req')
    expect(line(null)?.cls).toBe('req')
  })
})

// ---- key help (W2, H2) ---------------------------------------------------------------------------

describe('key help (W2)', () => {
  const b = (p: Partial<KeyBinding> & Pick<KeyBinding, 'id' | 'keys' | 'group'>): KeyBinding => ({ label: 'keys.window.help', run() {}, ...p })

  it('prints keys the way the game shows them', () => {
    expect(keyName('i')).toBe('I')
    expect(keyName('f9')).toBe('F9')
    expect(keyName('arrowleft')).toBe('←')
    expect(keyName('escape')).toBe('Esc')
    expect(keyName(' ')).toBe('Space')
    expect(keyName('1')).toBe('1')
    expect(keyCaption({ keys: ['s', 'k'] })).toBe('S / K')
    expect(keyCaption({ keys: ['f'], mods: ['ctrl', 'shift'] })).toBe('Ctrl+Shift+F')
  })

  it('groups the active bindings in order and leaves gated ones out', () => {
    const groups = keyHelpGroups([
      b({ id: 'debug.fps', keys: ['f'], mods: ['ctrl', 'shift'], group: 'debug' }),
      b({ id: 'window.inventory', keys: ['i'], group: 'windows', label: 'keys.window.inventory' }),
      b({ id: 'gm.window', keys: ['f9'], group: 'gm', when: () => false }),
      b({ id: 'broken', keys: ['x'], group: 'combat', when: () => { throw new Error('x') } }),
      b({ id: 'window.character', keys: ['c'], group: 'windows', label: 'keys.window.character' }),
      b({ id: 'window.inventory', keys: ['i'], group: 'windows', label: 'keys.window.inventory' }),
    ])
    expect(groups.map(g => g.group)).toEqual(['windows', 'debug'])
    expect(groups[0]!.rows).toEqual([
      { keys: 'C', label: 'keys.window.character' },
      { keys: 'I', label: 'keys.window.inventory' },
    ])
    expect(groups[1]!.rows).toEqual([{ keys: 'Ctrl+Shift+F', label: 'keys.window.help' }])
  })

  it('shows the H hint for the first few world visits only', () => {
    const store = new SettingsStore(null)
    const shown = Array.from({ length: HELP_HINT_SESSIONS + 2 }, () => takeHelpHint(store))
    expect(shown).toEqual([...Array(HELP_HINT_SESSIONS).fill(true), false, false])
    expect(store.get().ui.helpHintSessions).toBe(HELP_HINT_SESSIONS)
  })
})

// ---- Options rows (W1) ---------------------------------------------------------------------------

describe('Options rows (W1)', () => {
  const host: OptionsHost = {
    engine: 'WebGPU',
    keyHelp() {},
    toast() {},
    menu: { app: {} as OptionsHost['menu']['app'], close() {}, characterSelect() {}, logout() {} },
  }

  it('every tab has rows, and dead switches stay hidden until their consumer is listed', () => {
    const rows = optionRows(host, undefined, 'preview')
    for (const tab of OPTIONS_TABS) expect(visibleRows(rows[tab]).length, tab).toBeGreaterThan(0)
    const ids = (tab: keyof typeof rows, optional?: ReadonlySet<string>) => visibleRows(rows[tab], optional).map(r => r.id)
    // Wave 9 (GAME): the preview toggle and its hint, the sky style and the Advanced rows (their `when` is pageRows').
    expect(ids('graphics')).toEqual([
      'graphics.modern', 'graphics.recommended', 'graphics.preset', 'graphics.resolution', 'graphics.sight', 'graphics.scatter', 'graphics.wildlife', 'graphics.townLife', 'graphics.trees', 'graphics.hairCloth', 'graphics.bodyPhysics', 'graphics.textures', 'graphics.sky',
      'graphics.classicLook', 'graphics.advanced', 'graphics.advanced.shadows', 'graphics.advanced.reflections', 'graphics.advanced.aa', 'graphics.advanced.toneMap',
      'graphics.bloom', 'graphics.advanced.batching', 'graphics.advanced.lightShafts', 'fullscreen', 'engine',
    ])
    expect(ids('interface', new Set())).toEqual(['ui.scale', 'ui.showFps', 'ui.damageNumbers'])
    expect(ids('interface', new Set(['ui.names.mobs']))).toEqual(['ui.scale', 'ui.showFps', 'ui.damageNumbers', 'ui.names.mobs'])
    expect(ids('controls', new Set())).toEqual(['keyHelp'])
    // Camera modes, shake and the Z key are honoured since UX-R (world/camera-keys.ts, world/features/ux-world.ts).
    expect(ids('controls')).toContain('controls.cameraMode')
    expect(ids('controls')).toContain('controls.nearestTargetKey')
    expect(ids('controls')).toContain('controls.cameraShake')
  })

  it('each control writes a value the store keeps', () => {
    for (const tab of OPTIONS_TABS) {
      for (const r of optionRows(host)[tab]) {
        const store = new SettingsStore(null)
        if (r.kind === 'toggle') {
          const v = !r.get(store.get())
          store.set(r.patch(v))
          expect(r.get(store.get()), r.id).toBe(v)
        } else if (r.kind === 'choice') {
          for (const c of r.choices) {
            store.set(r.patch(c.value))
            expect(r.get(store.get()), r.id).toBe(c.value)
          }
        } else if (r.kind === 'range') {
          store.set(r.patch(r.max))
          expect(r.get(store.get()), r.id).toBeCloseTo(r.max)
          store.set(r.patch(r.min))
          expect(r.get(store.get()), r.id).toBeCloseTo(r.min)
          expect(r.format(r.min), r.id).not.toMatch(/\{/)
        }
      }
    }
  })
})

describe('menu bar order (H3)', () => {
  it('sorts by order, then registration', () => {
    const list = [{ id: 'options', order: 90 }, { id: 'skill' }, { id: 'character', order: 10 }, { id: 'quest' }, { id: 'inventory', order: 20 }]
    expect(sortEntries(list, x => x.order).map(x => x.id)).toEqual(['character', 'inventory', 'skill', 'quest', 'options'])
  })
})

describe('stat points (W7)', () => {
  it('spends 1, Shift 5, Ctrl 10, Alt all, never more than free', () => {
    expect(statStep(30, {})).toBe(1)
    expect(statStep(30, { shiftKey: true })).toBe(5)
    expect(statStep(30, { ctrlKey: true })).toBe(10)
    expect(statStep(30, { metaKey: true })).toBe(10)
    expect(statStep(30, { altKey: true })).toBe(30)
    expect(statStep(3, { ctrlKey: true })).toBe(3)
    expect(statStep(5000, { altKey: true })).toBe(1000)
    expect(statStep(0, {})).toBe(0)
  })
})

/**
 * The wave-4 client seams (docs/WAVE_PLAN.md §5.1 W4-FC): the world-feature and mock lines of the quest, party and
 * editor lanes, their i18n spread files, the placeholder windows behind Q (alias L) and P, the NPC dialog's quest
 * wiring point (decision 1), and the intent builders of every wave-4 request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_REWARD_CHOICES, PARTY_MODES, parseClientMessage, type ClientMessage, type GameplayRequest, type ServerMessage } from '@sro/shared'
import { intent } from '../src/hud/intents.ts'
import { KeyMap, type KeyEventLike } from '../src/hud/keys.ts'
import type { MenuBarEntry } from '../src/hud/menubar.ts'
import { en } from '../src/i18n/en.ts'
import { enEditors } from '../src/i18n/en-editors.ts'
import { enParty } from '../src/i18n/en-party.ts'
import { enQuests } from '../src/i18n/en-quests.ts'
import { MockServer, type KeyValueStore } from '../src/net/mock.ts'
import { DEFAULT_MOCK_EXTENSIONS } from '../src/net/mock/index.ts'
import { partyMock } from '../src/net/mock/party.ts'
import { questsMock } from '../src/net/mock/quests.ts'
import { Session } from '../src/net/session.ts'
import { questIntent } from '../src/quests/intents.ts'
import { WORLD_FEATURES } from '../src/world/features.ts'
import { placeholderFeature, type PanelWindow, type PlaceholderContext, type PlaceholderSpec } from '../src/world/features/placeholder.ts'
import { placeholderQuestPage } from '../src/world/features/quests.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** The message must survive the server's strict frame parser unchanged. */
function valid<T extends ClientMessage>(msg: T | null): T {
  if (msg === null) throw new Error('expected a message, got null')
  const parsed = parseClientMessage(JSON.stringify(msg))
  if (!parsed.ok) throw new Error(`${JSON.stringify(msg)} rejected: ${parsed.error}`)
  expect(parsed.msg).toEqual(msg)
  return msg
}

function key(k: string): KeyEventLike {
  return { key: k, type: 'keydown', repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: null, preventDefault() {} }
}

// ---- lists --------------------------------------------------------------------------------------------

describe('wave-4 lane lines', () => {
  it('appends quests, party and editors to WORLD_FEATURES after the wave-3 lanes', () => {
    expect(WORLD_FEATURES.map(f => f.name).slice(0, 8)).toEqual([
      'skillsFeature',
      'npcFeature',
      'soundFeature',
      'uxWorldFeature',
      'mapFeature',
      'questsFeature',
      'partyFeature',
      'editorsFeature',
    ])
  })

  it('wave 7B (FX-C2) appends the world effects and posture features after them', () => {
    expect(WORLD_FEATURES.map(f => f.name).slice(8, 10)).toEqual(['fxWorldFeature', 'postureFeature'])
  })

  it('appends the quest and party mocks to the default mock extensions', () => {
    expect(DEFAULT_MOCK_EXTENSIONS.slice(4, 6)).toEqual([questsMock, partyMock])
  })

  it('spreads en-quests, en-party and en-editors into en', () => {
    for (const table of [enQuests, enParty, enEditors] as Record<string, string>[]) {
      for (const [k, v] of Object.entries(table)) expect(en[k as keyof typeof en], k).toBe(v)
    }
    // ED-C filled en-editors: its keys stay in the editors' own namespaces.
    for (const k of Object.keys(enEditors)) expect(k, k).toMatch(/^gm\.(editor|qe)\./)
    // The keys the placeholders and the quest page use.
    for (const k of ['quest.log.title', 'quest.placeholder', 'quest.back', 'keys.window.quests', 'party.title', 'party.placeholder', 'keys.window.party', 'npc.noQuest', 'npc.option.end']) {
      expect(en[k as keyof typeof en], k).toBeTruthy()
    }
  })
})

// ---- placeholder windows --------------------------------------------------------------------------------

function fakeWindow() {
  const calls: string[] = []
  const w: PanelWindow & { calls: string[] } = {
    calls,
    isOpen: false,
    toggle() {
      calls.push('toggle')
      w.isOpen = !w.isOpen
    },
    close() {
      calls.push('close')
      w.isOpen = false
    },
    dispose() {
      calls.push('dispose')
    },
  }
  return w
}

function fakeContext() {
  const keys = new KeyMap()
  const entries = new Map<string, MenuBarEntry>()
  const ctx = {
    keys,
    hud: {
      layer: {} as HTMLElement,
      menubar: {
        register(e: MenuBarEntry) {
          entries.set(e.id, e)
          return () => void entries.delete(e.id)
        },
      },
    },
    app: { art: {} },
  } as unknown as PlaceholderContext
  return { ctx, keys, entries }
}

const QUESTS: PlaceholderSpec = {
  id: 'quests',
  title: 'quest.log.title',
  text: 'quest.placeholder',
  art: 'mainpopup/main_sysbutton_quest',
  order: 40,
  keyId: 'window.quests',
  keys: ['q', 'l'],
  keyLabel: 'keys.window.quests',
  hotkey: 'Q',
}

describe('placeholder windows (Q alias L, P)', () => {
  it('binds the keys and the menu-bar button to one window; Esc closes it; dispose removes everything', () => {
    const { ctx, keys, entries } = fakeContext()
    const win = fakeWindow()
    const f = placeholderFeature(ctx, QUESTS, () => win)
    expect(keys.list().map(b => [b.id, b.keys, b.group, b.label])).toEqual([['window.quests', ['q', 'l'], 'windows', 'keys.window.quests']])
    const entry = entries.get('quests')!
    expect(entry).toMatchObject({ id: 'quests', art: 'mainpopup/main_sysbutton_quest', label: 'quest.log.title', hotkey: 'Q', order: 40 })

    keys.handle(key('Q'))
    expect(win.isOpen).toBe(true)
    expect(entry.isOpen()).toBe(true)
    keys.handle(key('l'))
    expect(win.isOpen).toBe(false)
    entry.toggle()
    expect(win.isOpen).toBe(true)
    expect(f.escape?.()).toBe(true)
    expect(win.isOpen).toBe(false)
    expect(f.escape?.()).toBe(false)

    f.dispose?.()
    expect(keys.list()).toEqual([])
    expect(entries.size).toBe(0)
    expect(win.calls.at(-1)).toBe('dispose')
    keys.handle(key('q'))
    expect(win.isOpen).toBe(false)
  })

  it('Q, L and P do not clash with each other or the wave-3 window keys', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, keys } = fakeContext()
    for (const k of ['i', 'c', 's', 'k', 'm', 'h', 'g', 'f']) keys.register({ id: `x.${k}`, keys: [k], label: 'keys.window.inventory', group: 'windows', run: () => {} })
    placeholderFeature(ctx, QUESTS, fakeWindow)
    placeholderFeature(ctx, { ...QUESTS, id: 'party', keyId: 'window.party', keys: ['p'], keyLabel: 'keys.window.party', title: 'party.title', text: 'party.placeholder', hotkey: 'P', order: 50 }, fakeWindow)
    expect(warn).not.toHaveBeenCalled()
  })
})

// ---- NPC dialog quest wiring point (decision 1) ----------------------------------------------------------------

describe('NPC dialog quest option (decision 1)', () => {
  it('the placeholder page draws one line, Back to the services and End conversation', () => {
    const calls: string[] = []
    let content: { text: string; options: readonly { label: string; run(): void; end?: boolean }[] } | null = null
    const dialog = {
      setContent: (text: string, options: readonly { label: string; run(): void; end?: boolean }[]) => void (content = { text, options }),
      showServices: () => void calls.push('services'),
      close: () => void calls.push('close'),
    }
    placeholderQuestPage({ dialog } as never)
    expect(content!.text).toBe(en['npc.noQuest'])
    expect(content!.options.map(o => [o.label, !!o.end])).toEqual([
      [en['quest.back'], false],
      [en['npc.option.end'], true],
    ])
    content!.options[0]!.run()
    content!.options[1]!.run()
    expect(calls).toEqual(['services', 'close'])
  })
})

// ---- intent builders ---------------------------------------------------------------------------------------

describe('wave-4 intent builders pass parseClientMessage', () => {
  it('quest builders (quests/intents.ts)', () => {
    valid(questIntent.questAccept(12, 'JG_001'))
    valid(questIntent.questTurnIn(12, 'JG_001'))
    valid(questIntent.questTurnIn(12, 'JG_001', 0))
    valid(questIntent.questTurnIn(12, 'JG_001', MAX_REWARD_CHOICES - 1))
    valid(questIntent.questAbandon('JG_R01'))
    valid(questIntent.questTalk(0, 'JG_002', 'talk_chief'))
    valid(questIntent.questUseItem('JG_014', 'burn'))
    valid(questIntent.questAccept(Number.MAX_SAFE_INTEGER, `Q${'A'.repeat(63)}`))
  })

  it('quest builders refuse what the server would reject', () => {
    expect(questIntent.questAccept(-1, 'JG_001')).toBeNull()
    expect(questIntent.questAccept(1.5, 'JG_001')).toBeNull()
    expect(questIntent.questAccept(1, 'jg_001')).toBeNull()
    expect(questIntent.questAccept(1, '1JG')).toBeNull()
    expect(questIntent.questAccept(1, `Q${'A'.repeat(64)}`)).toBeNull()
    expect(questIntent.questTurnIn(1, 'JG_001', MAX_REWARD_CHOICES)).toBeNull()
    expect(questIntent.questTurnIn(1, 'JG_001', -1)).toBeNull()
    expect(questIntent.questTurnIn(1, 'JG_001', 0.5)).toBeNull()
    expect(questIntent.questAbandon('')).toBeNull()
    expect(questIntent.questTalk(1, 'JG_001', 'Talk')).toBeNull()
    expect(questIntent.questTalk(1, 'JG_001', 'a'.repeat(25))).toBeNull()
    expect(questIntent.questUseItem('JG_001', '')).toBeNull()
  })

  it('party builders (hud/intents.ts)', () => {
    valid(intent.partyInvite(44))
    for (const m of PARTY_MODES) {
      valid(intent.partyInvite(44, m))
      valid(intent.partyInvite(44, undefined, m))
      valid(intent.partySettings({ exp: m }))
      valid(intent.partySettings({ items: m }))
    }
    valid(intent.partyInvite(44, 'share', 'free'))
    valid(intent.partyRespond(44, true))
    valid(intent.partyRespond(0, false))
    valid(intent.partyLeave())
    valid(intent.partyKick(1))
    valid(intent.partyLeader(Number.MAX_SAFE_INTEGER))
    valid(intent.partySettings({ exp: 'share', items: 'share' }))
    // Extra keys on the settings object are not copied (the server rejects them).
    valid(intent.partySettings({ exp: 'free', leader: 3 } as never))
  })

  it('party builders refuse what the server would reject', () => {
    expect(intent.partyInvite(-1)).toBeNull()
    expect(intent.partyInvite(1.5)).toBeNull()
    expect(intent.partyInvite(1, 'all' as never)).toBeNull()
    expect(intent.partyInvite(1, undefined, 'random' as never)).toBeNull()
    expect(intent.partyRespond(-1, true)).toBeNull()
    expect(intent.partyRespond(1, 'yes' as never)).toBeNull()
    expect(intent.partyKick(0)).toBeNull()
    expect(intent.partyKick(2.5)).toBeNull()
    expect(intent.partyLeader(-3)).toBeNull()
    expect(intent.partySettings({})).toBeNull()
    expect(intent.partySettings({ exp: 'nope' as never })).toBeNull()
    expect(intent.partySettings({ exp: 'free', items: 'nope' as never })).toBeNull()
  })

  it('every wave-4 request has a builder', () => {
    const built: Record<string, ClientMessage | null> = {
      questAccept: questIntent.questAccept(1, 'JG_001'),
      questTurnIn: questIntent.questTurnIn(1, 'JG_001'),
      questAbandon: questIntent.questAbandon('JG_001'),
      questTalk: questIntent.questTalk(1, 'JG_001', 'talk'),
      questUseItem: questIntent.questUseItem('JG_001', 'use'),
      partyInvite: intent.partyInvite(1),
      partyRespond: intent.partyRespond(1, true),
      partyLeave: intent.partyLeave(),
      partyKick: intent.partyKick(1),
      partyLeader: intent.partyLeader(1),
      partySettings: intent.partySettings({ exp: 'free' }),
    }
    const wave4: GameplayRequest[] = ['questAccept', 'questTurnIn', 'questAbandon', 'questTalk', 'questUseItem', 'partyInvite', 'partyRespond', 'partyLeave', 'partyKick', 'partyLeader', 'partySettings']
    expect(Object.keys(built).sort()).toEqual([...wave4].sort())
    for (const [t, m] of Object.entries(built)) expect(valid(m).t).toBe(t)
  })
})

// ---- mock -----------------------------------------------------------------------------------------------------

function memory(): KeyValueStore {
  const m = new Map<string, string>()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0))
}

describe('mock server with the wave-4 stubs', () => {
  it('answers each wave-4 request exactly once with not_implemented', async () => {
    let now = 3_000_000_000
    const server = new MockServer(memory(), 0, () => now)
    await server.register({ username: 'seams4', password: 'secret' })
    const { token } = await server.login({ username: 'seams4', password: 'secret' })
    const s = new Session(() => server.wire(), token)
    const log: ServerMessage[] = []
    s.on(m => void log.push(m))
    await s.connect()
    const { character } = await s.request({ t: 'charCreate', name: 'Seamfour', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' }, ['charCreated'])
    await s.request({ t: 'enterWorld', id: character.id }, ['worldEnter'])
    const frames = [
      questIntent.questAccept(1, 'JG_001'),
      questIntent.questTurnIn(1, 'JG_001', 1),
      questIntent.questAbandon('JG_001'),
      questIntent.questTalk(1, 'JG_001', 'talk'),
      questIntent.questUseItem('JG_001', 'use'),
      intent.partyInvite(1, 'share'),
      intent.partyRespond(1, false),
      intent.partyLeave(),
      intent.partyKick(2),
      intent.partyLeader(2),
      intent.partySettings({ items: 'share' }),
    ].map(valid)
    for (const m of frames) {
      s.send(m)
      now += 1000 // stay inside every rate-limit budget
    }
    await flush()
    const results = log.filter(m => m.t === 'actionResult')
    expect(results).toEqual(frames.map(m => ({ t: 'actionResult', re: m.t, ok: false, reason: 'not_implemented' })))
    s.close()
    server.dropAll()
  })
})

/**
 * Lane QS-C, the quest client (docs/QUESTS.md §2, §7 lane C): the catalog merge, the quest state (marker priority
 * table, availability with prerequisites / level / dailies, NPC topics), objective lines and `{name}` fill, reward
 * expansion, notifications, dialog page selection per state, the dialog flow, NPC marks and minimap markers, with the
 * protocol validators on recorded server frames and every client frame checked by parseClientMessage.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseClientMessage, parseServerMessage, type ClientMessage, type QuestDef, type QuestFile, type QuestProgress, type ServerMessage } from '@sro/shared'
import { en } from '../src/i18n/en.ts'
import { QuestCatalog, QuestIndex, readCatalogBody } from '../src/quests/catalog.ts'
import { QuestDialogController, type QuestDialogPanel } from '../src/quests/dialog-panel.ts'
import { questTopics, type NpcDialogContext, type NpcDialogPage, type NpcDialogPager, type QuestDialogEnv } from '../src/quests/dialog.ts'
import { fillText, formatWait, objectiveLine, objectiveViews, paragraphs, questNotices, rewardsView, type QuestNames, type QuestReader } from '../src/quests/format.ts'
import { MARK_GLYPHS, NpcMarkers, questMapMarkers, type MarkableView } from '../src/quests/markers.ts'
import { nextReset, npcIdentity, objectiveCount, objectiveLocked, QuestState, usableObjective } from '../src/quests/state.ts'
import { readTracked } from '../src/world/features/quests.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---- fixtures ---------------------------------------------------------------------------------------------

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 28, 12)

function quest(id: string, extra: Partial<QuestDef> = {}): QuestDef {
  return {
    id,
    title: `Title ${id}`,
    kind: 'main',
    level: 1,
    giver: 'NPC_GIVER',
    turnIn: 'NPC_GIVER',
    summary: `Summary of ${id}.`,
    objectives: [],
    rewards: { exp: 100, sp: 1, gold: 50 },
    dialog: { offer: 'Hello {name}.\nHelp me.', progress: 'Not yet, {name}.', complete: 'Thank you.' },
    ...extra,
  }
}

function file(quests: QuestDef[], extra: Partial<QuestFile> = {}): QuestFile {
  return {
    schema: 1,
    kind: 'quests',
    id: 'test',
    title: 'Test line',
    world: 'jangan',
    items: [{ code: 'QITEM_HIDE', name: 'Mangyang Hide', description: 'Smelly.', iconItem: 'ITEM_QNO_HIDE' }, { code: 'QITEM_BELL', name: 'Binding Bell' }, { code: 'QITEM_BUN', name: 'Meat Bun' }],
    locations: [
      { id: 'LOC_FIELD', name: 'Millet fields', x: 10, z: 20, radius: 30 },
      { id: 'LOC_SHRINE', name: 'Tiger Shrine', x: -100, z: 600, radius: 25 },
    ],
    quests,
    ...extra,
  }
}

const Q_WELCOME = quest('Q_WELCOME', { giver: 'NPC_GATE', turnIn: 'NPC_CHIEF', chapter: 'Act I' })
const Q_PESTS = quest('Q_PESTS', {
  giver: 'NPC_CHIEF',
  turnIn: 'NPC_CHIEF',
  chapter: 'Act I',
  requires: { quests: ['Q_WELCOME'] },
  objectives: [{ id: 'mangyang', type: 'kill', mobs: ['MOB_MANGYANG'], count: 8, hint: 'LOC_FIELD' }],
})
const Q_HIDES = quest('Q_HIDES', {
  giver: 'NPC_HERBALIST',
  turnIn: 'NPC_HERBALIST',
  level: 2,
  requires: { quests: ['Q_PESTS'] },
  objectives: [{ id: 'hides', type: 'collect', item: 'QITEM_HIDE', count: 6, from: [{ mob: 'MOB_MANGYANG', chance: 0.5 }], hint: 'LOC_FIELD' }],
  rewards: { exp: 200, sp: 1, gold: 150, choice: [{ item: 'ITEM_HP_POTION', count: 10 }, { item: 'ITEM_MP_POTION', count: 10 }] },
})
const Q_BUN = quest('Q_BUN', {
  giver: 'NPC_CHIEF',
  turnIn: 'NPC_CHIEF',
  level: 2,
  requires: { quests: ['Q_PESTS'] },
  giveOnAccept: [{ item: 'QITEM_BUN', count: 1 }],
  objectives: [{ id: 'bun', type: 'deliver', npc: 'NPC_BOY', item: 'QITEM_BUN', count: 1, text: 'A bun? For me, {name}?' }],
  rewards: { exp: 120, sp: 1, gold: 200, items: [{ item: 'ITEM_CH_{G}_{ARMOR}_01_BA', count: 1 }] },
})
const Q_BELL = quest('Q_BELL', {
  giver: 'NPC_PRIEST',
  turnIn: 'NPC_PRIEST',
  level: 5,
  giveOnAccept: [{ item: 'QITEM_BELL', count: 1 }],
  objectives: [
    { id: 'ring', type: 'useItem', item: 'QITEM_BELL', location: 'LOC_SHRINE', text: 'The bell rings, {name}.', encounter: { mob: 'MOB_TIGERWOMAN', count: 1, despawnSec: 600 } },
    { id: 'tiger', type: 'kill', mobs: ['MOB_TIGERWOMAN'], count: 1, after: 'ring', label: 'Defeat the Tiger Girl' },
  ],
})
const Q_DAILY = quest('Q_DAILY', {
  giver: 'NPC_CHIEF',
  turnIn: 'NPC_CHIEF',
  kind: 'repeatable',
  level: 3,
  maxLevel: 20,
  requires: { quests: ['Q_PESTS'] },
  repeat: { reset: 'daily' },
  objectives: [{ id: 'mangyang', type: 'kill', mobs: ['MOB_MANGYANG'], count: 20 }],
  rewards: { exp: 0, expPctOfLevel: 10, sp: 0, gold: 100 },
})

const FILE = file([Q_WELCOME, Q_PESTS, Q_HIDES, Q_BUN, Q_BELL, Q_DAILY])

const names: QuestNames = {
  mob: code => ({ MOB_MANGYANG: 'Mangyang', MOB_TIGERWOMAN: 'Tiger Girl' })[code] ?? code,
  npc: code => ({ NPC_GATE: 'Soldier Fengil', NPC_CHIEF: 'Village Chief Hwangno', NPC_BOY: 'Sochil', NPC_HERBALIST: 'Herbalist Yangyun', NPC_PRIEST: 'Priest Jeonghye' })[code] ?? code,
  item: code => ({ QITEM_HIDE: 'Mangyang Hide', QITEM_BUN: 'Meat Bun', QITEM_BELL: 'Binding Bell', ITEM_HP_POTION: 'HP Potion', ITEM_MP_POTION: 'MP Potion' })[code] ?? code,
  icon: code => `/icons/${code}.png`,
}

function reader(level = 1, extra: Partial<QuestReader> = {}): QuestReader {
  return { name: 'Pixi', level, gender: 'female', armor: 'LIGHT', ...extra }
}

function progress(q: string, counts: Record<string, number> = {}, extra: Partial<QuestProgress> = {}): QuestProgress {
  return { quest: q, rev: 0, status: 'active', counts, items: [], acceptedAt: NOW - 1000, ...extra }
}

/** A frame as the server would send it, through the client's strict parser. */
function recv(msg: ServerMessage): ServerMessage {
  const r = parseServerMessage(JSON.stringify(msg))
  if (!r.ok) throw new Error(`${msg.t} rejected: ${r.error}`)
  return r.msg
}

function stateWith(active: QuestProgress[] = [], done: { quest: string; times?: number; lastAt?: number; availableAt?: number }[] = []): QuestState {
  const s = new QuestState()
  s.apply(recv({ t: 'quests', active, done: done.map(d => ({ quest: d.quest, times: d.times ?? 1, lastAt: d.lastAt ?? NOW - DAY, ...(d.availableAt !== undefined ? { availableAt: d.availableAt } : {}) })), rev: 3 }))
  return s
}

const cat = new QuestIndex([FILE])

// ---- catalog --------------------------------------------------------------------------------------------------

describe('quest catalog', () => {
  it('indexes quests by giver, turn-in and talk NPC; later files override by id', () => {
    expect(cat.size).toBe(6)
    expect(cat.givenBy('NPC_CHIEF').map(q => q.id)).toEqual(['Q_PESTS', 'Q_BUN', 'Q_DAILY'])
    expect(cat.turnedInAt('NPC_CHIEF').map(q => q.id)).toEqual(['Q_WELCOME', 'Q_PESTS', 'Q_BUN', 'Q_DAILY'])
    expect(cat.talkedAt('NPC_BOY').map(q => q.id)).toEqual(['Q_BUN'])
    expect(cat.givenBy('NPC_NOBODY')).toEqual([])
    // A GM override file (one quest) replaces the repo quest and may use the repo line's items and locations.
    const edited = { ...Q_PESTS, title: 'Pests (edited)', objectives: [{ id: 'mangyang', type: 'kill' as const, mobs: ['MOB_MANGYANG'], count: 3, hint: 'LOC_FIELD' }], rev: 2 }
    const merged = new QuestIndex([FILE, { schema: 1, kind: 'quests', id: 'Q_PESTS', title: 'override', world: 'jangan', items: [], locations: [], quests: [edited], rev: 2 }])
    expect(merged.quest('Q_PESTS')!.title).toBe('Pests (edited)')
    expect(merged.size).toBe(6)
    expect(merged.dropped).toEqual([])
  })

  it('drops a broken quest and keeps the rest; junk files are skipped', () => {
    const broken = { ...quest('Q_BAD'), objectives: [{ id: 'x', type: 'kill', mobs: [], count: 0 }] }
    const idx = new QuestIndex([file([Q_WELCOME, broken as QuestDef]), 42, null])
    expect(idx.quest('Q_WELCOME')).toBeDefined()
    expect(idx.quest('Q_BAD')).toBeUndefined()
    expect(idx.dropped.length).toBeGreaterThan(0)
    expect(readCatalogBody({ rev: 4, files: [] })).toEqual({ rev: 4, files: [] })
    expect(readCatalogBody({ files: 'x' })).toBeNull()
    expect(readCatalogBody(null)).toBeNull()
  })

  it('refreshes from its loader, coalesces, retries after a failure and reports changes', async () => {
    vi.useFakeTimers()
    const warn = { warn: vi.fn() }
    let fail = true
    const loader = vi.fn(async () => {
      if (fail) throw new Error('down')
      return { rev: 7, files: [FILE] }
    })
    const c = new QuestCatalog(loader, warn)
    const changed = vi.fn()
    c.onChange(changed)
    await c.refresh()
    expect(c.loaded).toBe(false)
    expect(warn.warn).toHaveBeenCalled()
    fail = false
    await vi.advanceTimersByTimeAsync(2000)
    expect(c.loaded).toBe(true)
    expect(c.rev).toBe(7)
    expect(c.givenBy('NPC_GATE').map(q => q.id)).toEqual(['Q_WELCOME'])
    expect(changed).toHaveBeenCalledTimes(1)
    // Two refreshes at once: one request, then one more for the second ask.
    loader.mockClear()
    await Promise.all([c.refresh(), c.refresh()])
    expect(loader).toHaveBeenCalledTimes(2)
    // A snapshot naming the loaded revision does not refetch; a newer one does.
    loader.mockClear()
    c.ensureRev(7)
    expect(loader).not.toHaveBeenCalled()
    c.ensureRev(8)
    expect(loader).toHaveBeenCalledTimes(1)
    c.dispose()
  })

  it('the repo questline loads without a dropped quest, and Soldier Fengil offers the first quest', () => {
    const json = JSON.parse(readFileSync(fileURLToPath(new URL('../../../content/quests/jangan.json', import.meta.url)), 'utf8')) as unknown
    const idx = new QuestIndex([json])
    expect(idx.dropped).toEqual([])
    expect(idx.size).toBeGreaterThan(20)
    const s = stateWith()
    expect(s.markFor('NPC_CH_SOLDIER_EM2', 1, NOW, idx)).toEqual({ mark: 'available' })
  })
})

// ---- state ------------------------------------------------------------------------------------------------------

describe('quest state', () => {
  it('applies recorded quests / questUpdate frames (full replace per quest, null = gone, done kept)', () => {
    const s = new QuestState()
    const seen: string[] = []
    s.onChange(c => seen.push(`${c.kind}:${c.event ?? ''}`))
    s.apply(recv({ t: 'quests', active: [progress('Q_PESTS', { mangyang: 2 })], done: [{ quest: 'Q_WELCOME', times: 1, lastAt: NOW }], rev: 5 }))
    expect(s.known).toBe(true)
    expect(s.rev).toBe(5)
    expect(s.active.get('Q_PESTS')!.counts).toEqual({ mangyang: 2 })
    const c = s.apply(recv({ t: 'questUpdate', quest: 'Q_PESTS', event: 'progress', progress: progress('Q_PESTS', { mangyang: 3 }) }))!
    expect(c.prev!.counts.mangyang).toBe(2)
    expect(c.next!.counts.mangyang).toBe(3)
    s.apply(recv({ t: 'questUpdate', quest: 'Q_PESTS', event: 'completed', progress: null, done: { quest: 'Q_PESTS', times: 1, lastAt: NOW } }))
    expect(s.active.has('Q_PESTS')).toBe(false)
    expect(s.isDone('Q_PESTS')).toBe(true)
    expect(s.apply(recv({ t: 'contentChanged', kind: 'quests', rev: 6 }))).toBeNull()
    expect(seen).toEqual(['snapshot:', 'update:progress', 'update:completed'])
    s.apply({ t: 'worldEnter' } as ServerMessage)
    expect(s.active.size + s.done.size).toBe(0)
    expect(s.known).toBe(false)
  })

  it('availability: prerequisites, level, max level, active, done, disabled and repeat cooldowns', () => {
    const s = stateWith()
    expect(s.availability(Q_WELCOME, 1, NOW)).toBe('offered')
    expect(s.availability(Q_PESTS, 1, NOW)).toBe('requires')
    expect(s.availability({ ...Q_WELCOME, disabled: true }, 1, NOW)).toBe('disabled')
    const s2 = stateWith([progress('Q_PESTS')], [{ quest: 'Q_WELCOME' }])
    expect(s2.availability(Q_WELCOME, 1, NOW)).toBe('done')
    expect(s2.availability(Q_PESTS, 1, NOW)).toBe('active')
    const s3 = stateWith([], [{ quest: 'Q_WELCOME' }, { quest: 'Q_PESTS' }])
    expect(s3.availability(Q_HIDES, 1, NOW)).toBe('level')
    expect(s3.availability(Q_HIDES, 2, NOW)).toBe('offered')
    expect(s3.availability(Q_DAILY, 21, NOW)).toBe('tooHigh')
    // Daily: the server's availableAt decides; without one, the next 04:00 after lastAt.
    const s4 = stateWith([], [{ quest: 'Q_PESTS' }, { quest: 'Q_DAILY', lastAt: NOW - 1000, availableAt: NOW + 3_600_000 }])
    expect(s4.availability(Q_DAILY, 5, NOW)).toBe('cooldown')
    expect(s4.availability(Q_DAILY, 5, NOW + 3_600_001)).toBe('offered')
    const s5 = stateWith([], [{ quest: 'Q_DAILY', lastAt: NOW - 1000 }])
    expect(s5.availableAt(Q_DAILY)).toBe(nextReset(NOW - 1000))
    const at = new Date(nextReset(NOW))
    expect([at.getHours(), at.getMinutes()]).toEqual([4, 0])
    expect(nextReset(NOW)).toBeGreaterThan(NOW)
    expect(nextReset(NOW) - NOW).toBeLessThanOrEqual(DAY)
    const cd = { ...Q_DAILY, repeat: { cooldownSec: 60 } }
    expect(stateWith([], [{ quest: 'Q_DAILY', lastAt: NOW }]).availableAt(cd)).toBe(NOW + 60_000)
  })

  it('marker priority: ready > talk > available > repeatable > progress > soon', () => {
    // Fresh character: Fengil has the first quest, the Chief nothing yet.
    let s = stateWith()
    expect(s.markFor('NPC_GATE', 1, NOW, cat)).toEqual({ mark: 'available' })
    expect(s.markFor('NPC_CHIEF', 1, NOW, cat)).toBeNull()
    // Welcome accepted (no objectives, ready at once): gold ? over the Chief.
    s = stateWith([progress('Q_WELCOME', {}, { status: 'ready' })])
    expect(s.markFor('NPC_GATE', 1, NOW, cat)).toBeNull()
    expect(s.markFor('NPC_CHIEF', 1, NOW, cat)).toEqual({ mark: 'ready' })
    // Pests in progress: grey ? at the Chief; ready: gold ?.
    s = stateWith([progress('Q_PESTS', { mangyang: 3 })], [{ quest: 'Q_WELCOME' }])
    expect(s.markFor('NPC_CHIEF', 1, NOW, cat)).toEqual({ mark: 'progress' })
    s = stateWith([progress('Q_PESTS', { mangyang: 8 }, { status: 'ready' })], [{ quest: 'Q_WELCOME' }])
    expect(s.markFor('NPC_CHIEF', 1, NOW, cat)).toEqual({ mark: 'ready' })
    // Pests done at level 1: the Chief's next quests are level 2 (soon, grey !), the daily level 3.
    s = stateWith([], [{ quest: 'Q_WELCOME' }, { quest: 'Q_PESTS' }])
    expect(s.markFor('NPC_CHIEF', 1, NOW, cat)).toEqual({ mark: 'soon', level: 2 })
    expect(s.markFor('NPC_CHIEF', 2, NOW, cat)).toEqual({ mark: 'available' })
    // The daily alone (Bun done): blue !.
    s = stateWith([], [{ quest: 'Q_WELCOME' }, { quest: 'Q_PESTS' }, { quest: 'Q_BUN' }])
    expect(s.markFor('NPC_CHIEF', 5, NOW, cat)).toEqual({ mark: 'repeatable' })
    // The bun is carried to the boy: talk (…) over him; the Chief's own turn-in is only in progress.
    s = stateWith([progress('Q_BUN', { bun: 0 })], [{ quest: 'Q_WELCOME' }, { quest: 'Q_PESTS' }])
    expect(s.markFor('NPC_BOY', 2, NOW, cat)).toEqual({ mark: 'talk' })
    expect(s.markFor('NPC_CHIEF', 2, NOW, cat)).toEqual({ mark: 'progress' })
    s = stateWith([progress('Q_BUN', { bun: 1 }, { status: 'ready' })], [{ quest: 'Q_WELCOME' }, { quest: 'Q_PESTS' }])
    expect(s.markFor('NPC_BOY', 2, NOW, cat)).toBeNull()
    // A withdrawn (disabled) quest shows nothing.
    const off = new QuestIndex([file([{ ...Q_WELCOME, disabled: true }])])
    expect(stateWith([progress('Q_WELCOME', {}, { status: 'ready' })]).markFor('NPC_CHIEF', 1, NOW, off)).toBeNull()
    expect(stateWith().markFor('NPC_GATE', 1, NOW, off)).toBeNull()
  })

  it('topics per NPC in dialog order; a quest in progress with a talk here is reached through the talk', () => {
    const s = stateWith([progress('Q_PESTS', { mangyang: 8 }, { status: 'ready' }), progress('Q_BUN')], [{ quest: 'Q_WELCOME' }])
    const topics = s.topicsFor('NPC_CHIEF', 3, NOW, cat).map(t => `${t.kind}:${t.quest.id}`)
    expect(topics).toEqual(['ready:Q_PESTS', 'progress:Q_BUN'])
    expect(s.topicsFor('NPC_BOY', 3, NOW, cat).map(t => `${t.kind}:${t.quest.id}:${t.objective?.id}`)).toEqual(['talk:Q_BUN:bun'])
    const self = new QuestIndex([file([quest('Q_SELF', { giver: 'NPC_X', turnIn: 'NPC_X', objectives: [{ id: 'hi', type: 'talk', npc: 'NPC_X', text: 'Hi.' }] })])])
    expect(stateWith([progress('Q_SELF')]).topicsFor('NPC_X', 1, NOW, self).map(t => t.kind)).toEqual(['talk'])
  })

  it('objective counts, after-gating and the re-usable encounter item', () => {
    const [ring, tiger] = Q_BELL.objectives
    const p = progress('Q_BELL', { ring: 0 }, { items: [{ code: 'QITEM_BELL', count: 1 }] })
    expect(objectiveLocked(tiger!, Q_BELL, p)).toBe(true)
    expect(usableObjective(Q_BELL, p, NOW)?.id).toBe('ring')
    const rung = progress('Q_BELL', { ring: 1, tiger: 0 }, { items: [{ code: 'QITEM_BELL', count: 1 }], encounterUntil: NOW + 60_000 })
    expect(objectiveLocked(tiger!, Q_BELL, rung)).toBe(false)
    // The Tiger Girl lives: no second summon; after she despawned unkilled, the bell works again.
    expect(usableObjective(Q_BELL, rung, NOW)).toBeNull()
    expect(usableObjective(Q_BELL, { ...rung, encounterUntil: undefined }, NOW)?.id).toBe('ring')
    expect(usableObjective(Q_BELL, { ...rung, encounterUntil: undefined, items: [] }, NOW)).toBeNull()
    // Collect counts fall back to the quest items held; counts never pass the goal.
    const hides = Q_HIDES.objectives[0]!
    expect(objectiveCount(hides, progress('Q_HIDES', {}, { items: [{ code: 'QITEM_HIDE', count: 4 }] }))).toBe(4)
    expect(objectiveCount(hides, progress('Q_HIDES', { hides: 9 }))).toBe(6)
    expect(objectiveCount(ring!, null)).toBe(0)
    expect(npcIdentity({ model: 'NPC_CH_CHEF' })).toBe('NPC_CH_CHEF')
    expect(npcIdentity({ model: 'NPC_CH_CHEF', npc: 'NPCX_GUARD' })).toBe('NPCX_GUARD')
  })
})

// ---- format ----------------------------------------------------------------------------------------------

describe('quest text', () => {
  it('objective lines per type, labels with counts, and {name}', () => {
    expect(objectiveLine(Q_PESTS.objectives[0]!, 3, cat, names)).toBe('Mangyang slain 3/8')
    expect(objectiveLine(Q_HIDES.objectives[0]!, 2, cat, names)).toBe('Mangyang Hide 2/6')
    expect(objectiveLine(Q_BUN.objectives[0]!, 0, cat, names)).toBe('Bring Meat Bun to Sochil')
    expect(objectiveLine(Q_BELL.objectives[0]!, 0, cat, names)).toBe('Use Binding Bell at Tiger Shrine')
    expect(objectiveLine(Q_BELL.objectives[1]!, 0, cat, names)).toBe('Defeat the Tiger Girl')
    expect(objectiveLine({ id: 'b', type: 'kill', mobs: ['MOB_A', 'MOB_B'], count: 12, label: 'Beasts slain' }, 7, cat, names)).toBe('Beasts slain 7/12')
    expect(objectiveLine({ id: 'r', type: 'reach', location: 'LOC_FIELD' }, 0, cat, names)).toBe('Go to Millet fields')
    expect(objectiveLine({ id: 't', type: 'talk', npc: 'NPC_CHIEF', text: '' }, 0, cat, names)).toBe('Talk to Village Chief Hwangno')
    expect(objectiveLine({ id: 'h', type: 'have', item: 'ITEM_HP_POTION', count: 5 }, 5, cat, names)).toBe('HP Potion 5/5')
    expect(fillText('Welcome, {name}. {other}', { name: 'Pixi' })).toBe('Welcome, Pixi. {other}')
    expect(paragraphs(Q_WELCOME.dialog.offer, { name: 'Pixi' })).toEqual(['Hello Pixi.', 'Help me.'])
    const views = objectiveViews(Q_WELCOME, progress('Q_WELCOME', {}, { status: 'ready' }), cat, names)
    expect(views).toMatchObject([{ type: 'report', text: 'Report to Village Chief Hwangno', done: true }])
    expect(formatWait(30_000)).toBe(en['quest.time.s'])
    expect(formatWait(12 * 60_000)).toBe('12 min')
    expect(formatWait(200 * 60_000)).toBe('3 h 20 min')
  })

  it('rewards expand {G}/{ARMOR} like the server and EXP percentages use the level', () => {
    const r = rewardsView(Q_BUN, reader(2, { gender: 'female', armor: 'LIGHT' }), () => 0, names)
    expect(r.items).toEqual([{ code: 'ITEM_CH_W_LIGHT_01_BA', name: 'ITEM_CH_W_LIGHT_01_BA', icon: '/icons/ITEM_CH_W_LIGHT_01_BA.png', count: 1 }])
    expect(rewardsView(Q_BUN, reader(2, { gender: 'male', armor: 'HEAVY' }), () => 0, names).items[0]!.code).toBe('ITEM_CH_M_HEAVY_01_BA')
    const d = rewardsView(Q_DAILY, reader(5), lv => (lv === 5 ? 1234 : 0), names)
    expect(d.exp).toBe(123)
    expect(rewardsView(Q_HIDES, reader(2), () => 0, names).choice.map(c => c.code)).toEqual(['ITEM_HP_POTION', 'ITEM_MP_POTION'])
  })

  it('notifications: accepted (+ ready at once), each count, objective done, visions, ready, completed', () => {
    const s = new QuestState()
    s.apply(recv({ t: 'quests', active: [], done: [], rev: 1 }))
    const upd = (m: ServerMessage) => s.apply(recv(m))!
    const who = { name: 'Pixi' }
    let n = questNotices(upd({ t: 'questUpdate', quest: 'Q_WELCOME', event: 'accepted', progress: progress('Q_WELCOME', {}, { status: 'ready' }) }), Q_WELCOME, cat, names, who)
    expect(n.map(x => x.text)).toEqual(['Quest accepted: Title Q_WELCOME', 'Quest complete. Return to Village Chief Hwangno.'])
    expect(n.every(x => x.chat)).toBe(true)
    upd({ t: 'questUpdate', quest: 'Q_HIDES', event: 'accepted', progress: progress('Q_HIDES') })
    n = questNotices(upd({ t: 'questUpdate', quest: 'Q_HIDES', event: 'progress', progress: progress('Q_HIDES', { hides: 3 }, { items: [{ code: 'QITEM_HIDE', count: 3 }] }) }), Q_HIDES, cat, names, who)
    expect(n).toEqual([{ text: 'Mangyang Hide 3/6', kind: 'loot' }])
    n = questNotices(upd({ t: 'questUpdate', quest: 'Q_HIDES', event: 'ready', progress: progress('Q_HIDES', { hides: 6 }, { status: 'ready' }) }), Q_HIDES, cat, names, who)
    expect(n.map(x => x.text)).toEqual(['Mangyang Hide 6/6', 'Quest complete. Return to Herbalist Yangyun.'])
    upd({ t: 'questUpdate', quest: 'Q_BELL', event: 'accepted', progress: progress('Q_BELL') })
    n = questNotices(upd({ t: 'questUpdate', quest: 'Q_BELL', event: 'objective', objective: 'ring', progress: progress('Q_BELL', { ring: 1 }) }), Q_BELL, cat, names, who)
    expect(n).toEqual([
      { text: 'Use Binding Bell at Tiger Shrine (done)', kind: 'info' },
      { text: '', kind: 'info', vision: 'The bell rings, Pixi.' },
    ])
    n = questNotices(upd({ t: 'questUpdate', quest: 'Q_HIDES', event: 'completed', progress: null, done: { quest: 'Q_HIDES', times: 1, lastAt: NOW } }), Q_HIDES, cat, names, who)
    expect(n).toEqual([{ text: 'Quest completed: Title Q_HIDES', kind: 'info', banner: 'Title Q_HIDES', chat: true }])
    // The same update twice (no count rose) says nothing new.
    upd({ t: 'questUpdate', quest: 'Q_PESTS', event: 'accepted', progress: progress('Q_PESTS', { mangyang: 1 }) })
    expect(questNotices(upd({ t: 'questUpdate', quest: 'Q_PESTS', event: 'progress', progress: progress('Q_PESTS', { mangyang: 1 }) }), Q_PESTS, cat, names, who)).toEqual([])
    expect(questNotices({ kind: 'snapshot' }, undefined, cat, names, who)).toEqual([])
  })
})

// ---- dialog ------------------------------------------------------------------------------------------------

function env(s: QuestState, level = 1) {
  const sent: ClientMessage[] = []
  const e: QuestDialogEnv = {
    reader: () => reader(level),
    now: () => NOW,
    names,
    expToNext: () => 1000,
    request: msg => {
      if (!msg) return false
      const parsed = parseClientMessage(JSON.stringify(msg))
      if (!parsed.ok) throw new Error(`${JSON.stringify(msg)} rejected: ${parsed.error}`)
      sent.push(msg)
      return true
    },
  }
  return { e, sent }
}

function pager() {
  const pages: NpcDialogPage[] = []
  const calls: string[] = []
  const p: NpcDialogPager = { show: page => void pages.push(page), back: () => void calls.push('back'), close: () => void calls.push('close') }
  return { p, pages, calls }
}

const CHIEF: NpcDialogContext = { npcId: 41, npcCode: 'NPC_CHIEF', npcName: 'Village Chief Hwangno' }

describe('quest dialog pages', () => {
  it('offer: text with {name}, objectives, rewards; Accept sends questAccept; Decline goes back', () => {
    const s = stateWith()
    const { e, sent } = env(s)
    const topics = questTopics({ npcId: 7, npcCode: 'NPC_GATE', npcName: 'Soldier Fengil' }, s, cat, e)
    expect(topics.map(t => [t.key, t.label, t.icon])).toEqual([['quest:Q_WELCOME', 'Title Q_WELCOME', 'quest-available']])
    const { p, pages, calls } = pager()
    topics[0]!.open(p)
    const page = pages[0]!
    expect(page.paragraphs).toEqual(['Hello Pixi.', 'Help me.'])
    expect(page.objectives).toEqual([{ text: 'Report to Village Chief Hwangno', done: false, locked: false }])
    expect(page.rewards).toMatchObject({ exp: 100, sp: 1, gold: 50 })
    expect(page.buttons.map(b => [b.label, !!b.disabled])).toEqual([
      ['Accept', false],
      ['Decline', false],
    ])
    page.buttons[0]!.onClick()
    expect(sent).toEqual([{ t: 'questAccept', npc: 7, quest: 'Q_WELCOME' }])
    page.buttons[1]!.onClick()
    expect(calls).toEqual(['back'])
  })

  it('offer with a full log disables Accept and says why', () => {
    const active = Array.from({ length: 10 }, (_, i) => progress(`Q_X${i}`))
    const s = stateWith(active)
    const { e } = env(s)
    const { p, pages } = pager()
    questTopics({ npcId: 7, npcCode: 'NPC_GATE', npcName: 'Fengil' }, s, cat, e)[0]!.open(p)
    expect(pages[0]!.buttons[0]!.disabled).toBe(true)
    expect(pages[0]!.notes).toContain('Your quest log is full (10/10).')
  })

  it('complete: Complete waits for a reward choice, then sends questTurnIn with it', () => {
    const s = stateWith([progress('Q_HIDES', { hides: 6 }, { status: 'ready' })], [{ quest: 'Q_WELCOME' }, { quest: 'Q_PESTS' }])
    const { e, sent } = env(s, 2)
    const { p, pages } = pager()
    const topics = questTopics({ npcId: 9, npcCode: 'NPC_HERBALIST', npcName: 'Yangyun' }, s, cat, e)
    expect(topics.map(t => t.kind)).toEqual(['ready'])
    topics[0]!.open(p)
    let page = pages.at(-1)!
    expect(page.paragraphs).toEqual(['Thank you.'])
    expect(page.buttons[0]!.disabled).toBe(true)
    expect(page.notes).toEqual([en['quest.chooseFirst']])
    page.rewards!.choose!(1)
    page = pages.at(-1)!
    expect(page.rewards!.chosen).toBe(1)
    expect(page.buttons[0]!.disabled).toBe(false)
    page.buttons[0]!.onClick()
    expect(sent).toEqual([{ t: 'questTurnIn', npc: 9, quest: 'Q_HIDES', choice: 1 }])
    // Without choices: sent without `choice`.
    const s2 = stateWith([progress('Q_WELCOME', {}, { status: 'ready' })])
    const e2 = env(s2)
    const p2 = pager()
    questTopics(CHIEF, s2, cat, e2.e)[0]!.open(p2.p)
    p2.pages[0]!.buttons[0]!.onClick()
    expect(e2.sent).toEqual([{ t: 'questTurnIn', npc: 41, quest: 'Q_WELCOME' }])
  })

  it('talk/deliver: the objective text, Hand over sends questTalk; progress pages show live counts', () => {
    const s = stateWith([progress('Q_BUN', { bun: 0 }, { items: [{ code: 'QITEM_BUN', count: 1 }] }), progress('Q_PESTS', { mangyang: 5 })], [{ quest: 'Q_WELCOME' }])
    const { e, sent } = env(s, 2)
    const boy = pager()
    const talk = questTopics({ npcId: 3, npcCode: 'NPC_BOY', npcName: 'Sochil' }, s, cat, e)
    expect(talk.map(t => [t.key, t.icon])).toEqual([['quest:Q_BUN:bun', 'quest-talk']])
    talk[0]!.open(boy.p)
    expect(boy.pages[0]!.paragraphs).toEqual(['A bun? For me, Pixi?'])
    expect(boy.pages[0]!.buttons[0]!.label).toBe('Hand over')
    boy.pages[0]!.buttons[0]!.onClick()
    expect(sent).toEqual([{ t: 'questTalk', npc: 3, quest: 'Q_BUN', objective: 'bun' }])
    const chief = pager()
    const topics = questTopics(CHIEF, s, cat, e)
    expect(topics.map(t => `${t.kind}:${t.quest}`)).toEqual(['progress:Q_PESTS', 'progress:Q_BUN'])
    topics[0]!.open(chief.p)
    expect(chief.pages[0]!.paragraphs).toEqual(['Not yet, Pixi.'])
    expect(chief.pages[0]!.objectives).toEqual([{ text: 'Mangyang slain 5/8', done: false, locked: false }])
    expect(chief.pages[0]!.buttons.map(b => b.label)).toEqual(['Close'])
  })
})

// ---- dialog flow (the adapter's controller, with a fake panel and window) ------------------------------------

function fakeDialog() {
  const calls: string[] = []
  let content: { text: string; labels: string[]; run: (() => void)[] } = { text: '', labels: [], run: [] }
  const dialog = {
    isOpen: true,
    talk: null as unknown,
    setContent(text: string, options: readonly { label: string; run(): void }[]) {
      content = { text, labels: options.map(o => o.label), run: options.map(o => o.run) }
    },
    showServices: () => void calls.push('services'),
    close: () => void calls.push('close'),
  }
  const talk = { npc: 41, code: 'NPC_CHIEF', name: 'Village Chief Hwangno', services: ['quest' as const], dialog: dialog as never }
  dialog.talk = talk
  return { talk, calls, content: () => content }
}

function fakePanel() {
  const drawn: { page: NpcDialogPage; waiting: boolean }[] = []
  let attached = false
  const panel = {
    get attached() {
      return attached
    },
    render(page: NpcDialogPage, waiting: boolean) {
      attached = true
      drawn.push({ page, waiting })
    },
    detach() {
      attached = false
    },
  }
  return { panel: panel as unknown as QuestDialogPanel, drawn }
}

describe('quest dialog flow', () => {
  it('one topic opens directly; after the accept the next topic opens; several topics make a list', () => {
    const s = stateWith([progress('Q_WELCOME', {}, { status: 'ready' })])
    const { e } = env(s)
    const { panel, drawn } = fakePanel()
    let clock = 0
    const nothing = vi.fn()
    const ctl: QuestDialogController = new QuestDialogController(panel, c => questTopics(c, s, cat, { ...e, request: (m, q) => (e.request(m, q) ? (ctl.sent(q), true) : false) }), nothing, () => clock)
    const d = fakeDialog()
    ctl.open(d.talk as never)
    expect(drawn.at(-1)!.page.key).toBe('quest:Q_WELCOME')
    // Complete -> waiting (buttons grey) until the server's questUpdate.
    drawn.at(-1)!.page.buttons[0]!.onClick()
    expect(ctl.waiting).toBe(true)
    expect(drawn.at(-1)!.waiting).toBe(true)
    s.apply(recv({ t: 'questUpdate', quest: 'Q_WELCOME', event: 'completed', progress: null, done: { quest: 'Q_WELCOME', times: 1, lastAt: NOW } }))
    ctl.questChanged('Q_WELCOME')
    expect(ctl.waiting).toBe(false)
    // The Chief now offers Pests: its offer opens right away.
    expect(drawn.at(-1)!.page.key).toBe('quest:Q_PESTS')
    drawn.at(-1)!.page.buttons[0]!.onClick()
    // Refused (e.g. log full): the page comes back enabled.
    ctl.refused()
    expect(drawn.at(-1)!.waiting).toBe(false)
    drawn.at(-1)!.page.buttons[0]!.onClick()
    s.apply(recv({ t: 'questUpdate', quest: 'Q_PESTS', event: 'accepted', progress: progress('Q_PESTS') }))
    ctl.questChanged('Q_PESTS')
    // Only "in progress" left: shown directly.
    expect(drawn.at(-1)!.page.key).toBe('quest:Q_PESTS')
    expect(drawn.at(-1)!.page.buttons.map(b => b.label)).toEqual(['Close'])
    // A count change redraws the open page.
    s.apply(recv({ t: 'questUpdate', quest: 'Q_PESTS', event: 'progress', progress: progress('Q_PESTS', { mangyang: 4 }) }))
    ctl.questChanged('Q_PESTS')
    expect(drawn.at(-1)!.page.objectives![0]!.text).toBe('Mangyang slain 4/8')
    // Close goes back to the NPC's services.
    drawn.at(-1)!.page.buttons[0]!.onClick()
    expect(d.calls).toEqual(['services'])
    expect(nothing).not.toHaveBeenCalled()

    // Several topics: a list of option lines, Back and End.
    const s2 = stateWith([progress('Q_BUN'), progress('Q_PESTS', { mangyang: 8 }, { status: 'ready' })], [{ quest: 'Q_WELCOME' }])
    const ctl2 = new QuestDialogController(fakePanel().panel, c => questTopics(c, s2, cat, e), nothing, () => clock)
    const d2 = fakeDialog()
    ctl2.open(d2.talk as never)
    expect(d2.content().text).toBe(en['quest.topics'])
    expect(d2.content().labels).toEqual(['Title Q_PESTS (complete)', 'Title Q_BUN (in progress)', en['quest.back'], en['npc.option.end']])
    clock = 10
    ctl2.tick()
  })

  it('no topics: the "nothing to tell" page; a stale conversation is ignored; waits time out', () => {
    const s = stateWith([], [{ quest: 'Q_WELCOME' }])
    const { e } = env(s)
    const nothing = vi.fn()
    const { panel, drawn } = fakePanel()
    let clock = 0
    const ctl = new QuestDialogController(panel, c => questTopics({ ...c, npcCode: 'NPC_GATE' }, s, cat, e), nothing, () => clock)
    const d = fakeDialog()
    ctl.open(d.talk as never)
    expect(nothing).toHaveBeenCalledTimes(1)
    expect(drawn).toEqual([])
    // Waiting on a page, then 5 s of silence: back to the topics (none -> services).
    const s2 = stateWith()
    const ctl2 = new QuestDialogController(panel, c => questTopics({ ...c, npcCode: 'NPC_GATE' }, s2, cat, e), nothing, () => clock)
    const d2 = fakeDialog()
    ctl2.open(d2.talk as never)
    ctl2.sent('Q_WELCOME')
    expect(ctl2.waiting).toBe(true)
    clock = 5001
    ctl2.tick()
    expect(ctl2.waiting).toBe(false)
    // The dialog moved on to another conversation: nothing is drawn for the old one.
    const count = drawn.length
    ;(d2.talk.dialog as unknown as { talk: unknown }).talk = null
    ctl2.questChanged('Q_WELCOME')
    ctl2.redraw()
    expect(drawn.length).toBe(count)
  })
})

// ---- markers ----------------------------------------------------------------------------------------------

describe('NPC marks and minimap markers', () => {
  it('sets the quest badge on NPC views only when the mark changes', () => {
    const calls: [string, string | null, string | undefined][] = []
    const view = (model: string, kind = 'npc'): MarkableView => ({ kind, state: { model }, setBadge: (k, text, cls) => void calls.push([k, text, cls]) })
    let s = stateWith()
    const m = new NpcMarkers(npc => s.markFor(npc, 1, NOW, cat))
    const gate = view('NPC_GATE')
    const mob = view('MOB_MANGYANG', 'mob')
    m.updateAll([gate, mob, view('NPC_CHIEF')])
    expect(calls).toEqual([['quest', '!', MARK_GLYPHS.available.cls]])
    m.update(gate)
    expect(calls.length).toBe(1)
    s = stateWith([progress('Q_WELCOME', {}, { status: 'ready' })])
    m.update(gate)
    expect(calls.at(-1)).toEqual(['quest', null, undefined])
    m.clear([gate])
    expect(calls.length).toBe(2)
    expect(MARK_GLYPHS.ready.text).toBe('?')
    expect(MARK_GLYPHS.repeatable.cls).toContain('blue')
    expect(MARK_GLYPHS.progress.cls).toContain('grey')
  })

  it('circles for open objectives of tracked quests, pins for ready turn-ins and talks', () => {
    const s = stateWith([progress('Q_PESTS', { mangyang: 2 }), progress('Q_BUN'), progress('Q_WELCOME', {}, { status: 'ready' }), progress('Q_BELL', { ring: 1 })], [])
    const at = (npc: string) => (npc === 'NPC_CHIEF' ? { x: 1, z: 2 } : npc === 'NPC_BOY' ? { x: 3, z: 4 } : null)
    const all = questMapMarkers(['Q_PESTS', 'Q_BUN', 'Q_WELCOME', 'Q_BELL'], s, cat, at)
    expect(all.filter(m => m.radius).map(m => [m.x, m.z, m.radius])).toEqual([[10, 20, 30]])
    expect(all.filter(m => !m.radius).map(m => [m.x, m.z])).toEqual([
      [3, 4],
      [1, 2],
    ])
    // Untracked quests draw nothing.
    expect(questMapMarkers([], s, cat, at)).toEqual([])
  })

  it('tracked ids read back from junk-tolerant storage', () => {
    expect(readTracked(null)).toEqual({})
    expect(readTracked('nope')).toEqual({})
    expect(readTracked('[1,2]')).toEqual({})
    expect(readTracked(JSON.stringify({ Pixi: ['Q_A', 3, 'Q_B'], Bad: 'x' }))).toEqual({ Pixi: ['Q_A', 'Q_B'] })
  })
})

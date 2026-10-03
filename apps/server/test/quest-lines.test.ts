/**
 * Wave 11 lane U-Q (docs/UNIQUES.md §3.10): the quest files' conditional greeting lines. While the field Tiger Girl is
 * alive, Gwakwi and Jeonghye add a rumour line naming her area; never while she is dead, despawned or UNIQUES=off.
 * Covers the validator (`lines`, QUEST_LINE_CONDITIONS), QuestBook's index, QuestEngine.dialogLines with a stub
 * uniques fact, the npcDialog message and its client parse, and the shipped content/quests/jangan.json lines.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_NPC_DIALOG_LINE,
  QUEST_FILE_SCHEMA,
  parseServerMessage,
  questLineText,
  validateQuestFile,
  type NpcDef,
  type QuestDialogLine,
  type QuestRefs,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { QuestBook } from '../src/quests/book.ts'
import type { Uniques } from '../src/uniques.ts'
import { NPC_DEFS, npcHarness, type Msg } from './npc-harness.ts'

const TG = 'MOB_CH_TIGERWOMAN'
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, 'content/quests/jangan.json'), 'utf8')) as Record<string, unknown>

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const line = (over: Partial<QuestDialogLine> & Record<string, unknown> = {}) => ({
  id: 'tiger_rumour', npc: 'NPC_CH_PRIEST', text: 'She was seen near {area}.', textNoArea: 'She was seen in the hills.', when: { uniqueAlive: TG }, ...over,
})
const file = (lines: unknown, quests: unknown[] = []) => ({ schema: QUEST_FILE_SCHEMA, kind: 'quests', id: 'test', title: 'Test', world: 'jangan', items: [], locations: [], quests, lines })
const refs: QuestRefs = {
  mobs: new Set([TG, 'MOB_CH_TIGER']),
  items: new Set(),
  npcs: new Set(['NPC_CH_PRIEST', 'NPC_CH_GENARAL_SW']),
  levelCap: 20,
  mobInfo: (code) => (code === TG ? { level: 20, unique: true } : { level: 14, unique: false }),
}

describe('validateQuestFile: lines', () => {
  it('keeps a good line; a file without lines has none', () => {
    const { file: f, issues } = validateQuestFile(file([line()]), refs)
    expect(issues).toEqual([])
    expect(f!.lines).toEqual([line()])
    expect(validateQuestFile({ ...file([]), lines: undefined }, refs).file!.lines).toBeUndefined()
  })

  it('rejects bad lines one by one, never the quests; warns on unknown tokens and non-unique mobs', () => {
    const bad = [
      line({ id: 'Bad Id' }),
      line({ id: 'no_npc', npc: 'NPC_NOPE' }),
      line({ id: 'no_mob', when: { uniqueAlive: 'MOB_NOPE' } }),
      line({ id: 'two_facts', when: { uniqueAlive: TG, other: 1 } }),
      line({ id: 'no_fact', when: {} }),
      line({ id: 'no_when', when: undefined }),
      line({ id: 'area_fallback', textNoArea: 'near {area}' }),
      line({ id: 'too_long', text: 'x'.repeat(MAX_NPC_DIALOG_LINE + 1) }),
      line(),
      line(),
    ]
    const { file: f, issues } = validateQuestFile(file(bad), refs)
    expect(f!.lines!.map((l) => l.id)).toEqual(['tiger_rumour'])
    const errs = issues.filter((i) => i.severity === 'error' && i.path.startsWith('lines'))
    expect(errs.map((i) => i.path)).toEqual([
      'lines[0].id', 'lines[1].npc', 'lines[2].when.uniqueAlive', 'lines[3].when.other', 'lines[4].when', 'lines[5].when', 'lines[6].textNoArea', 'lines[7].text', 'lines[9].id',
    ])
    const warn = validateQuestFile(file([line({ text: 'Near {place}.' }), line({ id: 'plain', when: { uniqueAlive: 'MOB_CH_TIGER' } })]), refs).issues.filter((i) => i.severity === 'warning')
    expect(warn.map((i) => i.path)).toEqual(['lines[0].text', 'lines[1].when.uniqueAlive'])
    // A broken `lines` drops only the lines.
    const broken = validateQuestFile(file('nope'), refs)
    expect(broken.file).not.toBeNull()
    expect(broken.file!.lines).toBeUndefined()
  })

  it('questLineText fills {area}, falls back to textNoArea, else skips', () => {
    expect(questLineText(line(), 'Tiger Mt.')).toBe('She was seen near Tiger Mt..')
    expect(questLineText(line(), '')).toBe('She was seen in the hills.')
    expect(questLineText({ ...line(), textNoArea: undefined } as QuestDialogLine, ' ')).toBeNull()
    expect(questLineText(line({ text: 'No place here.' }), '')).toBe('No place here.')
  })
})

describe('QuestBook: lines index', () => {
  it('indexes lines by NPC; a later file with the same id wins', () => {
    const book = QuestBook.fromFiles([
      { name: 'a.json', json: file([line(), line({ id: 'hunter', npc: 'NPC_CH_GENARAL_SW' })]) },
      { name: 'b.json', json: { ...file([line({ text: 'Override near {area}.' })]), id: 'b' }, source: 'override' },
    ], { refs })
    expect(book.linesByNpc.get('NPC_CH_PRIEST')!.map((l) => l.text)).toEqual(['Override near {area}.'])
    expect(book.linesByNpc.get('NPC_CH_GENARAL_SW')!.map((l) => l.id)).toEqual(['hunter'])
  })
})

describe('content/quests/jangan.json: the rumour lines', () => {
  it('has Gwakwi and Jeonghye, both on uniqueAlive Tiger Girl, both with {area} and a no-area text', () => {
    const { file: f, issues } = validateQuestFile(REAL)
    expect(issues.filter((i) => i.path.startsWith('lines'))).toEqual([])
    const lines = f!.lines!
    expect(lines.map((l) => l.npc).sort()).toEqual(['NPC_CH_GENARAL_SW', 'NPC_CH_PRIEST'])
    for (const l of lines) {
      expect(l.when).toEqual({ uniqueAlive: TG })
      expect(l.text).toContain('The Daughter of the Mountain was seen near {area}')
      expect(l.textNoArea).toBeDefined()
    }
  })
})

// ---- the engine and the dialog ---------------------------------------------------------------------------------

const PRIEST: NpcDef = { code: 'NPC_CH_PRIEST', name: 'Jeonghye', x: -40, z: -40, yaw: 0, world: 'jangan', model: null, provenance: 'client' }

/** An NPC world with the priest, a quest book holding `lines`, and a stub uniques fact the test controls. */
function boot(lines: unknown[] = [line()]) {
  const h = npcHarness({ npcs: [...NPC_DEFS, PRIEST] })
  cleanups.push(h.close)
  h.gameplay.quests.setContent(QuestBook.fromFiles([{ name: 'test.json', json: file(lines) }]))
  const fact: { alive: { id: number; name: string; area: string } | null } = { alive: null }
  const calls: string[] = []
  const stub = { alive: (code: string) => (calls.push(code), code === TG ? fact.alive : null) } as unknown as Uniques
  ;(h.gameplay as { uniques: Uniques | null }).uniques = stub
  const priest = h.npcByCode('NPC_CH_PRIEST')
  const { p, inbox } = h.enter([-38, 0, -40])
  const talk = (): Msg<'npcDialog'> => {
    const before = inbox.length
    h.req(p, inbox, { t: 'npcTalk', npc: priest.id })
    const d = inbox.slice(before).find((m): m is Msg<'npcDialog'> => m.t === 'npcDialog')
    expect(d).toBeDefined()
    return d!
  }
  return { h, p, fact, calls, talk }
}

describe('npcDialog lines (QuestEngine.dialogLines)', () => {
  it('shows the rumour with the area only while she lives', () => {
    const b = boot()
    expect(b.talk().lines).toBeUndefined()
    b.fact.alive = { id: 77, name: 'Tiger Girl', area: 'North-Tiger Mt.' }
    expect(b.talk().lines).toEqual(['She was seen near North-Tiger Mt..'])
    b.fact.alive = { id: 77, name: 'Tiger Girl', area: '' }
    expect(b.talk().lines).toEqual(['She was seen in the hills.'])
    b.fact.alive = null
    expect(b.talk().lines).toBeUndefined()
    expect(b.calls).toEqual([TG, TG, TG, TG])
  })

  it('other NPCs get nothing; UNIQUES=off (no module) shows nothing; a throwing fact only loses the lines', () => {
    const b = boot([line(), line({ id: 'hunter', npc: 'NPC_CH_GENARAL_SW' })])
    b.fact.alive = { id: 1, name: 'Tiger Girl', area: 'X' }
    expect(b.h.gameplay.quests.dialogLines(b.p, 'NPC_CH_POTION')).toEqual([])
    expect(b.h.gameplay.quests.dialogLines(b.p, 'NPC_CH_GENARAL_SW')).toEqual(['She was seen near X.'])
    ;(b.h.gameplay as { uniques: Uniques | null }).uniques = null
    expect(b.talk().lines).toBeUndefined()
    ;(b.h.gameplay as { uniques: unknown }).uniques = { alive: () => { throw new Error('boom') } }
    const d = b.talk()
    expect(d.lines).toBeUndefined()
    expect(d.services).toBeDefined()
    expect(b.h.logs.some((l) => /dialog lines of NPC_CH_PRIEST failed: boom/.test(l))).toBe(true)
  })

  it('the message survives the client parse (bounded); an over-long area is clipped to the bound', () => {
    const b = boot()
    b.fact.alive = { id: 1, name: 'Tiger Girl', area: 'A'.repeat(400) }
    const d = b.talk()
    expect([...d.lines![0]!].length).toBe(MAX_NPC_DIALOG_LINE)
    expect(parseServerMessage(JSON.stringify(d))).toEqual({ ok: true, msg: d })
    expect(parseServerMessage(JSON.stringify({ ...d, lines: [''] })).ok).toBe(false)
    expect(parseServerMessage(JSON.stringify({ ...d, lines: Array(9).fill('x') })).ok).toBe(false)
  })
})

/**
 * Lane ED-C (docs/QUESTS.md §7 lane F): the GM content editors' pure parts. Command building (every message passes the
 * shared validator), the gmResult readers, the quest form <-> QuestDef mapping (every quest of content/quests/jangan.json
 * round-trips to the same JSON), issue paths -> fields, the quest editor HTTP client, and the ring geometry.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseClientMessage, validateQuestDef, validateQuestFile, type ClientMessage, type QuestDef, type QuestFile } from '@sro/shared'
import type { GmBuild } from '../src/gm/commands.ts'
import { GmQuestApi, readQuestList } from '../src/gm/editors/api.ts'
import {
  cleanNpcName,
  editorCmd,
  fmtRespawn,
  nestFieldValue,
  npcIdentity,
  parseNestId,
  parseRespawn,
  readNestResult,
  readNpcResult,
  upsert,
} from '../src/gm/editors/commands.ts'
import { circlePoints, nestLabel } from '../src/gm/editors/nest-rings.ts'
import {
  cloneForm,
  emptyObjective,
  fieldFor,
  fixAfter,
  formToQuest,
  freeId,
  freeObjectiveId,
  issueKey,
  issueTarget,
  itemOut,
  itemToForm,
  locationOut,
  locationToForm,
  moveObjective,
  newQuestForm,
  numOut,
  objectiveFields,
  questToForm,
  rewardPreview,
  stableJson,
  suggestExp,
  suggestSp,
} from '../src/gm/editors/quest-form.ts'
import { registerGmTab } from '../src/gm/window.ts'

function valid(build: GmBuild): Extract<ClientMessage, { t: 'gm' }> {
  if (!build.ok) throw new Error(`expected a message, got error: ${build.error}`)
  const parsed = parseClientMessage(JSON.stringify(build.msg))
  if (!parsed.ok) throw new Error(`${JSON.stringify(build.msg)} rejected: ${parsed.error}`)
  expect(parsed.msg).toEqual(build.msg)
  return build.msg
}

function invalid(build: GmBuild): string {
  if (build.ok) throw new Error(`expected an error, got ${JSON.stringify(build.msg)}`)
  expect(build.error.trim()).not.toBe('')
  return build.error
}

const JANGAN = fileURLToPath(new URL('../../../content/quests/jangan.json', import.meta.url))
const janganRaw = JSON.parse(readFileSync(JANGAN, 'utf8')) as QuestFile

describe('editor command builders (nest / npc / content)', () => {
  it('builds the spawn editor commands in the server forms', () => {
    expect(valid(editorCmd.nestNear()).args).toEqual(['near'])
    expect(valid(editorCmd.nestNear('80')).args).toEqual(['near', '80'])
    invalid(editorCmd.nestNear('0'))
    invalid(editorCmd.nestNear('5000'))
    expect(valid(editorCmd.nestAdd('mob_ch_mangnyang ', '8', '25', '20-40'))).toEqual({ t: 'gm', cmd: 'nest', args: ['add', 'MOB_CH_MANGNYANG', '8', '25', '20-40'] })
    // Empty fields take the server defaults.
    expect(valid(editorCmd.nestAdd('MOB_CH_GYO', '', '', '')).args).toEqual(['add', 'MOB_CH_GYO', '5', '30', '30'])
    expect(valid(editorCmd.nestAdd('MOB_CH_GYO', 3, 12.5, 60)).args).toEqual(['add', 'MOB_CH_GYO', '3', '12.5', '60'])
    invalid(editorCmd.nestAdd('not a code'))
    invalid(editorCmd.nestAdd('MOB_CH_GYO', '51'))
    invalid(editorCmd.nestAdd('MOB_CH_GYO', '0'))
    invalid(editorCmd.nestAdd('MOB_CH_GYO', '5', '1'))
    invalid(editorCmd.nestAdd('MOB_CH_GYO', '5', '201'))
    invalid(editorCmd.nestAdd('MOB_CH_GYO', '5', '30', '40-20'))
    invalid(editorCmd.nestAdd('MOB_CH_GYO', '5', '30', '0'))
    invalid(editorCmd.nestAdd('MOB_CH_GYO', '5', '30', '86401'))
    expect(valid(editorCmd.nestMove('#1000000')).args).toEqual(['move', '1000000'])
    invalid(editorCmd.nestMove('abc'))
    expect(valid(editorCmd.nestRemove(42)).args).toEqual(['remove', '42'])
    expect(valid(editorCmd.nestRestore(42)).args).toEqual(['restore', '42'])
    invalid(editorCmd.nestRestore(1_000_001))
    expect(valid(editorCmd.nestUndo()).args).toEqual(['undo'])
  })

  it('checks every nest set field before sending', () => {
    expect(valid(editorCmd.nestSet(1000000, 'count', '3')).args).toEqual(['set', '1000000', 'count', '3'])
    expect(valid(editorCmd.nestSet(1000000, 'mob', 'mob_ch_tiger')).args).toEqual(['set', '1000000', 'mob', 'MOB_CH_TIGER'])
    expect(valid(editorCmd.nestSet(7, 'radius', '40')).args).toEqual(['set', '7', 'radius', '40'])
    expect(valid(editorCmd.nestSet(7, 'spawnradius', '0')).args).toEqual(['set', '7', 'spawnradius', '0'])
    expect(valid(editorCmd.nestSet(7, 'respawn', ' 20 - 40 ')).args).toEqual(['set', '7', 'respawn', '20-40'])
    expect(valid(editorCmd.nestSet(7, 'aggressive', true)).args).toEqual(['set', '7', 'aggressive', 'on'])
    expect(valid(editorCmd.nestSet(7, 'enabled', 'off')).args).toEqual(['set', '7', 'enabled', 'off'])
    expect(valid(editorCmd.nestSet(7, 'champion', '12.5')).args).toEqual(['set', '7', 'champion', '12.5'])
    invalid(editorCmd.nestSet(7, 'count', '0'))
    invalid(editorCmd.nestSet(7, 'radius', '1'))
    invalid(editorCmd.nestSet(7, 'champion', '101'))
    invalid(editorCmd.nestSet(7, 'aggressive', 'maybe'))
    expect(nestFieldValue('count', '50')).toBe('50')
    expect(nestFieldValue('count', '51')).toHaveProperty('error')
    expect(parseRespawn('30')).toEqual([30, 30])
    expect(parseRespawn('20-40')).toEqual([20, 40])
    expect(parseRespawn('x')).toBeNull()
    expect(fmtRespawn([20, 40])).toBe('20-40')
    expect(fmtRespawn([30, 30])).toBe('30')
    expect(parseNestId('#12')).toBe(12)
    expect(parseNestId('-1')).toBeNull()
  })

  it('builds the NPC editor commands', () => {
    expect(valid(editorCmd.npcNear()).args).toEqual(['near'])
    expect(valid(editorCmd.npcAdd('npc_ch_smith', '  Old   Smith Bo ')).args).toEqual(['add', 'NPC_CH_SMITH', 'Old Smith Bo'])
    invalid(editorCmd.npcAdd('NPC_CH_SMITH', '   '))
    invalid(editorCmd.npcAdd('NPC_CH_SMITH', 'x'.repeat(33)))
    invalid(editorCmd.npcAdd('bad code!', 'Bo'))
    expect(valid(editorCmd.npcRename('npcx_1', 'Smith Bo')).args).toEqual(['rename', 'NPCX_1', 'Smith Bo'])
    expect(valid(editorCmd.npcMove('NPCX_1')).args).toEqual(['move', 'NPCX_1'])
    expect(valid(editorCmd.npcFace('NPCX_1')).args).toEqual(['face', 'NPCX_1'])
    expect(valid(editorCmd.npcShop('NPCX_1', 'STORE_CH_SMITH')).args).toEqual(['shop', 'NPCX_1', 'STORE_CH_SMITH'])
    expect(valid(editorCmd.npcShop('NPCX_1', null)).args).toEqual(['shop', 'NPCX_1', 'none'])
    expect(valid(editorCmd.npcShop('NPCX_1', '')).args).toEqual(['shop', 'NPCX_1', 'none'])
    invalid(editorCmd.npcShop('NPCX_1', 'a b'))
    expect(valid(editorCmd.npcRemove('NPC_CH_SMITH')).args).toEqual(['remove', 'NPC_CH_SMITH'])
    expect(valid(editorCmd.npcRestore('NPC_CH_SMITH')).args).toEqual(['restore', 'NPC_CH_SMITH'])
    expect(valid(editorCmd.npcUndo()).args).toEqual(['undo'])
    expect(valid(editorCmd.contentStatus()).args).toEqual(['status'])
    expect(valid(editorCmd.contentReload('quests')).args).toEqual(['reload', 'quests'])
    expect(cleanNpcName('Bo‮x')).toBe('Box')
    expect(npcIdentity({ model: 'NPC_CH_SMITH', npc: 'NPCX_3' })).toBe('NPCX_3')
    expect(npcIdentity({ model: 'NPC_CH_SMITH' })).toBe('NPC_CH_SMITH')
  })

  it('reads nest and npc results tolerantly', () => {
    const nest = { id: 1000000, mob: 'MOB_CH_MANGNYANG', mobName: 'Mangyang', level: 1, x: 10, z: 20, radius: 25, spawnRadius: 25, count: 8, alive: 7, respawnSec: [30, 30], aggressive: false, enabled: true, source: 'authored' }
    const near = readNestResult({ nests: [nest, { id: 'x' }, null] })
    expect(near.nests).toHaveLength(1)
    expect(near.nests![0]).toEqual(nest)
    expect(readNestResult({ nest }).nest?.id).toBe(1000000)
    expect(readNestResult({ id: 5 }).removed).toBe(5)
    expect(readNestResult({ rev: 9 }).rev).toBe(9)
    expect(readNestResult('junk')).toEqual({})
    // Missing optional fields get safe defaults.
    expect(readNestResult({ nest: { id: 1, mob: 'M', x: 0, z: 0 } }).nest).toMatchObject({ mobName: 'M', respawnSec: [0, 0], enabled: true, source: 'export' })
    const npc = { code: 'NPCX_1', base: 'NPC_CH_SMITH', name: 'Old Smith Bo', x: 1, z: 2, yaw: 0.5, entity: 44, shop: 'STORE_CH_SMITH', source: 'authored' }
    expect(readNpcResult({ npcs: [npc] }).npcs![0]).toEqual(npc)
    expect(readNpcResult({ npc: { ...npc, entity: null, hidden: true } }).npc).toMatchObject({ entity: null, hidden: true })
    expect(readNpcResult({ code: 'NPCX_1' }).removed).toBe('NPCX_1')
    expect(upsert([{ k: 1 }, { k: 2 }], x => x.k, 2, null)).toEqual([{ k: 1 }])
    expect(upsert([{ k: 1, v: 0 }], x => x.k, 1, { k: 1, v: 5 })).toEqual([{ k: 1, v: 5 }])
    expect(upsert([{ k: 1 }], x => x.k, 3, { k: 3 })).toEqual([{ k: 3 }, { k: 1 }])
  })
})

describe('quest form <-> QuestDef', () => {
  it('round-trips every quest of jangan.json (as authored and as the validated catalog copy) to the same JSON', () => {
    const { file, issues } = validateQuestFile(janganRaw)
    expect(file, JSON.stringify(issues.filter(i => i.severity === 'error'))).not.toBeNull()
    expect(janganRaw.quests.length).toBeGreaterThan(20)
    for (const q of [...janganRaw.quests, ...file!.quests]) {
      const back = formToQuest(questToForm(q))
      expect(back, q.id).toEqual(q)
      expect(stableJson(back), q.id).toBe(stableJson(q))
      // and through a form clone (what the editor keeps)
      expect(stableJson(formToQuest(cloneForm(questToForm(q))))).toBe(stableJson(q))
    }
  })

  it('round-trips the quest items and locations', () => {
    for (const i of janganRaw.items) expect(itemOut(itemToForm(i))).toEqual(i)
    for (const l of janganRaw.locations) expect(locationOut(locationToForm(l))).toEqual(l)
  })

  it('maps edits back to the quest (JG_002 count 8 -> 3)', () => {
    const q = janganRaw.quests.find(x => x.id === 'JG_002')!
    const f = questToForm(q)
    f.objectives[0]!.count = '3'
    const out = formToQuest(f)
    expect(out.objectives[0]).toMatchObject({ type: 'kill', count: 3 })
    expect(out.rewards).toEqual(q.rewards)
  })

  it('sends an unparsable number as typed so the validator names the field', () => {
    const q = janganRaw.quests.find(x => x.id === 'JG_002')!
    const f = questToForm(q)
    f.objectives[0]!.count = 'eight'
    f.level = ''
    const out = formToQuest(f)
    const scope = { items: new Set(janganRaw.items.map(i => i.code)), locations: new Set(janganRaw.locations.map(l => l.id)), quests: new Set(janganRaw.quests.map(x => x.id)) }
    const paths = validateQuestDef(out, scope).filter(i => i.severity === 'error').map(i => i.path)
    expect(paths).toContain('objectives[0].count')
    expect(paths).toContain('level')
    expect(numOut('')).toBeUndefined()
    expect(numOut(' 0.05 ')).toBe(0.05)
    expect(numOut('12x')).toBe('12x')
  })

  it('switching the objective type keeps the typed values; optional parts stay absent', () => {
    const o = emptyObjective('kill', 'kill')
    o.mobs = ['MOB_CH_MANGNYANG']
    o.count = '5'
    o.type = 'talk'
    o.npc = 'NPC_CH_CHEF'
    o.text = 'Hello'
    const talk = formToQuest({ ...newQuestForm('X_1'), objectives: [o] }).objectives[0]
    expect(talk).toEqual({ id: 'kill', type: 'talk', npc: 'NPC_CH_CHEF', text: 'Hello' })
    o.type = 'kill'
    expect(formToQuest({ ...newQuestForm('X_1'), objectives: [o] }).objectives[0]).toEqual({ id: 'kill', type: 'kill', mobs: ['MOB_CH_MANGNYANG'], count: 5 })
    expect(objectiveFields('useItem')).toContain('encounter')
    const fresh = formToQuest(newQuestForm('GM_QUEST', 'NPC_CH_CHEF'))
    expect(fresh).not.toHaveProperty('requires')
    expect(fresh).not.toHaveProperty('giveOnAccept')
    expect(fresh.rewards).toEqual({ exp: 0, sp: 0, gold: 0 })
    expect(fresh.giver).toBe('NPC_CH_CHEF')
  })

  it('reorders objectives and clears an `after` that would point forward', () => {
    const a = { ...emptyObjective('kill', 'a') }
    const b = { ...emptyObjective('kill', 'b'), after: 'a' }
    const moved = moveObjective([a, b], 1, -1)
    expect(moved.map(o => o.id)).toEqual(['b', 'a'])
    expect(moved[0]!.after).toBe('')
    expect(fixAfter([a, b])[1]!.after).toBe('a')
    expect(moveObjective([a, b], 0, -1)).toEqual([a, b])
    expect(freeObjectiveId([a, { ...a, id: 'kill' }], 'kill')).toBe('kill_2')
    expect(freeObjectiveId([], 'useItem')).toBe('use')
    expect(freeId('loc_jg_040', new Set(['LOC_JG_040']))).toBe('LOC_JG_040_2')
  })

  it('suggests rewards and previews {G}/{ARMOR} codes', () => {
    expect(suggestExp(5, l => (l === 5 ? 1000 : 0))).toBe(150)
    expect(suggestSp(1200)).toBe(2)
    expect(suggestSp(100)).toBe(1)
    expect(suggestSp(0)).toBe(0)
    const p = rewardPreview('ITEM_CH_{G}_{ARMOR}_02_BA_A')
    expect(p).toHaveLength(6)
    expect(p.map(x => x.code)).toContain('ITEM_CH_W_HEAVY_02_BA_A')
    expect(rewardPreview('ITEM_ETC_HP_POTION_01')).toEqual([{ who: '', code: 'ITEM_ETC_HP_POTION_01' }])
  })

  it('maps issue paths to form fields', () => {
    expect(issueTarget('quests[0].objectives[1].count')).toEqual({ kind: 'quest', path: 'objectives[1].count' })
    expect(issueTarget('quests[0]')).toEqual({ kind: 'quest', path: '' })
    expect(issueTarget('quests[12].level')).toEqual({ kind: 'quest', path: 'level' })
    expect(issueTarget('quest.id')).toEqual({ kind: 'quest', path: 'id' })
    expect(issueTarget('items[2].name')).toEqual({ kind: 'item', index: 2, path: 'name' })
    expect(issueTarget('locations[0].x')).toEqual({ kind: 'location', index: 0, path: 'x' })
    expect(issueTarget('objectives[0].mobs[1]')).toEqual({ kind: 'quest', path: 'objectives[0].mobs[1]' })
    expect(issueTarget('baseRev').kind).toBe('other')
    expect(issueKey(issueTarget('items[2].name'))).toBe('item:2.name')
    const fields = new Set(['objectives[0].mobs', 'objectives[0]', 'level', 'item:2.name'])
    const has = (k: string) => fields.has(k)
    expect(fieldFor('objectives[0].mobs[1]', has)).toBe('objectives[0].mobs')
    expect(fieldFor('objectives[0].from[0].chance', has)).toBe('objectives[0]')
    expect(fieldFor('level', has)).toBe('level')
    expect(fieldFor('item:2.name', has)).toBe('item:2.name')
    expect(fieldFor('nothing.here', has)).toBeNull()
  })
})

describe('quest editor HTTP client', () => {
  type Call = { url: string; init?: RequestInit }
  const fake = (status: number, body: unknown, calls: Call[] = []) =>
    async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      return new Response(body === undefined ? '' : JSON.stringify(body), { status })
    }

  it('sends the Bearer token and reads the list', async () => {
    const calls: Call[] = []
    const list = { rev: 3, quests: [{ id: 'JG_002', title: 'Pests', file: 'jangan.json', source: 'repo', rev: 0, disabled: false, issues: [] }] }
    const api = new GmQuestApi(() => 'tok', '/api', fake(200, list, calls))
    const res = await api.list()
    expect(res.ok && res.data.quests[0]!.id).toBe('JG_002')
    expect(calls[0]!.url).toBe('/api/gm/quests')
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(readQuestList({ quests: [{ id: 'A' }, 'x'] })!.quests).toHaveLength(1)
  })

  it('PUTs a quest and reports 422 issues, 409 stale and network failures', async () => {
    const calls: Call[] = []
    const q = janganRaw.quests.find(x => x.id === 'JG_002')! as QuestDef
    const ok = new GmQuestApi(() => 'tok', '/api', fake(200, { ok: true, rev: 4, issues: [] }, calls))
    const saved = await ok.save('JG_002', { quest: q, baseRev: 3 })
    expect(saved.ok && saved.data.rev).toBe(4)
    expect(calls[0]!.url).toBe('/api/gm/quests/JG_002')
    expect(calls[0]!.init!.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ baseRev: 3, quest: { id: 'JG_002' } })

    const bad = new GmQuestApi(() => 'tok', '/api', fake(422, { ok: false, rev: 3, issues: [{ path: 'quests[0].objectives[0].mobs[0]', message: 'unknown mob MOB_CH_MANGYANG', severity: 'error' }] }))
    const r422 = await bad.save('JG_002', { quest: q })
    expect(r422.ok).toBe(false)
    if (!r422.ok) {
      expect(r422.status).toBe(422)
      expect(r422.result?.issues[0]?.path).toBe('quests[0].objectives[0].mobs[0]')
    }
    const stale = await new GmQuestApi(() => 'tok', '/api', fake(409, { ok: false, rev: 5, issues: [] })).save('JG_002', { quest: q, baseRev: 3 })
    expect(!stale.ok && stale.status).toBe(409)
    const denied = await new GmQuestApi(() => 'tok', '/api', fake(403, { error: 'forbidden', message: 'Game Master content editors only.' })).list()
    expect(!denied.ok && denied.status).toBe(403)
    const down = await new GmQuestApi(() => 'tok', '/api', async () => {
      throw new Error('ECONNREFUSED')
    }).list()
    expect(!down.ok && down.status).toBe(0)
    const huge = await ok.validate({ quest: { ...q, summary: 'x'.repeat(40_000) } })
    expect(!huge.ok && huge.status).toBe(413)
  })

  it('calls revert, disable and enable on their routes', async () => {
    const calls: Call[] = []
    const api = new GmQuestApi(() => 'tok', '/api', fake(200, { ok: true, rev: 6, issues: [] }, calls))
    await api.revert('JG_002')
    await api.setDisabled('JG_002', true)
    await api.setDisabled('JG_002', false)
    await api.validate({ quest: janganRaw.quests[0]! })
    expect(calls.map(c => `${c.init!.method} ${c.url}`)).toEqual([
      'DELETE /api/gm/quests/JG_002',
      'POST /api/gm/quests/JG_002/disable',
      'POST /api/gm/quests/JG_002/enable',
      'POST /api/gm/quests/validate',
    ])
  })
})

describe('spawn preview and GM window tabs', () => {
  it('draws ground circles that follow the height function', () => {
    const pts = circlePoints(10, 20, 30, (x, z) => x * 0.1 + z * 0.01)
    expect(pts.length).toBeGreaterThanOrEqual(25)
    expect(pts[0]!.x).toBeCloseTo(40)
    expect(pts[0]!.z).toBeCloseTo(20)
    expect(pts[0]!.y).toBeCloseTo(4 + 0.2 + 0.3)
    expect(pts[pts.length - 1]!.x).toBeCloseTo(pts[0]!.x)
    for (const p of pts) expect(Math.hypot(p.x - 10, p.z - 20)).toBeCloseTo(30)
    expect(circlePoints(0, 0, 200, () => 0).length).toBeLessThanOrEqual(161)
    expect(nestLabel({ id: 1, mobName: 'Mangyang', count: 8, alive: 6, enabled: true }, '[off]')).toBe('Mangyang x8 (6)')
    expect(nestLabel({ id: 1, mobName: 'Mangyang', count: 8, alive: 0, enabled: false }, '[off]')).toBe('Mangyang x8 (0) [off]')
  })

  it('registers and unregisters extra GM window tabs without a window open', () => {
    const off = registerGmTab({ id: 'test-tab', label: 'Test', make: () => ({ root: {} as HTMLElement }) })
    expect(typeof off).toBe('function')
    off()
    off()
  })
})

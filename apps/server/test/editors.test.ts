/**
 * GM content editors, units (docs/QUESTS.md §5, §7 lane E; lane ED-S): the override file checks, the layering order
 * (remove, then patch by id, then add), id allocation, the atomic write and the history (keep 100, undo pops), and the
 * spawner's runtime nest bookkeeping. The live commands and the HTTP routes are in editors-e2e.test.ts.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NestDef, NpcDef } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTHORED_NEST_ID_MIN,
  HISTORY_DIR,
  HISTORY_KEEP,
  applyLayers,
  checkAuthoredNest,
  checkNestPatch,
  cleanNpcName,
  contentState,
  editorAllowed,
  emptyNestOverride,
  emptyNpcOverride,
  layerNests,
  layerNpcs,
  listHistory,
  nestSource,
  parseNestOverride,
  parseNpcOverride,
  popHistory,
  saveVersioned,
  writeJsonAtomic,
  type AuthoredNest,
  type NestOverrideFile,
  type OverrideRefs,
} from '../src/editors/overrides.ts'
import { GameData } from '../src/gamedata.ts'
import { Spawner } from '../src/spawner.ts'
import { MANGNYANG, NPCS, SHOPS, TIGER, HIGH, nest, seeded } from './fixtures.ts'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sro-editors-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const MOBS = new Map([MANGNYANG, TIGER, HIGH].map((m) => [m.code, m]))
const BASE: NestDef[] = [nest(1, MANGNYANG.code, 10, -10, { count: 5 }), nest(2, MANGNYANG.code, 20, -20, { count: 2 }), nest(3, TIGER.code, 30, -30)]

function refs(): OverrideRefs {
  return {
    world: 'jangan',
    mob: (c) => MOBS.get(c),
    nests: new Map(BASE.map((n) => [n.id, n])),
    npcs: new Map(NPCS.map((n) => [n.code, n])),
    shop: (id) => SHOPS.some((s) => s.id === id),
  }
}

function authored(id: number, over: Partial<AuthoredNest> = {}): AuthoredNest {
  return {
    id,
    mob: MANGNYANG.code,
    x: 50,
    z: -50,
    radius: 20,
    spawnRadius: 20,
    count: 4,
    respawnSec: [30, 30],
    tactics: { id: 0, aggressive: false, sightRange: 10, leashRange: 50 },
    world: 'jangan',
    provenance: 'authored',
    source: { file: 'nests.override.json', by: 'gm1', at: '2026-01-01T00:00:00.000Z' },
    ...over,
  }
}

describe('override checks', () => {
  it('authored nests: own check (decision 44), ids from 1,000,000, GM bounds', () => {
    expect('nest' in checkAuthoredNest(authored(AUTHORED_NEST_ID_MIN), refs())).toBe(true)
    const bad = (over: Record<string, unknown>) => checkAuthoredNest({ ...authored(AUTHORED_NEST_ID_MIN), ...over }, refs())
    expect(bad({ id: 5 })).toHaveProperty('problems')
    expect(bad({ provenance: 'vsro-server-db via third-party port' })).toHaveProperty('problems')
    expect(bad({ count: 0 })).toHaveProperty('problems')
    expect(bad({ count: 51 })).toHaveProperty('problems')
    expect(bad({ radius: 1 })).toHaveProperty('problems')
    expect(bad({ respawnSec: [40, 20] })).toHaveProperty('problems')
    expect(bad({ respawnSec: [0, 20] })).toHaveProperty('problems')
    expect(bad({ mob: 'MOB_NOPE' })).toHaveProperty('problems')
    expect(bad({ x: Number.NaN })).toHaveProperty('problems')
    expect(bad({ source: { file: 'nests.json', by: 'x', at: 'y' } })).toHaveProperty('problems')
    // the clean copy drops unknown keys
    const r = checkAuthoredNest({ ...authored(AUTHORED_NEST_ID_MIN), junk: 1 }, refs())
    expect('nest' in r && !('junk' in r.nest)).toBe(true)
  })

  it('patches name an exported nest and keep GM bounds', () => {
    expect(checkNestPatch({ id: 1, count: 3, aggressive: true }, refs())).toEqual({ patch: { id: 1, count: 3, aggressive: true } })
    expect(checkNestPatch({ id: 99, count: 3 }, refs())).toHaveProperty('problems')
    expect(checkNestPatch({ id: AUTHORED_NEST_ID_MIN }, refs())).toHaveProperty('problems')
    expect(checkNestPatch({ id: 1, championPct: 101 }, refs())).toHaveProperty('problems')
    expect(checkNestPatch({ id: 1, enabled: 'yes' }, refs())).toHaveProperty('problems')
  })

  it('NPC names are cleaned and at most 32 characters', () => {
    expect(cleanNpcName('  Old ‮ Smith\u0007  Bo ')).toBe('Old Smith Bo')
    expect(cleanNpcName('x'.repeat(32))).toBe('x'.repeat(32))
    expect(cleanNpcName('x'.repeat(33))).toBeNull()
    expect(cleanNpcName('   ')).toBeNull()
  })

  it('the editor role only reads the role (EDITOR_ROLE)', () => {
    expect(editorAllowed('player')).toBe(false)
    expect(editorAllowed('gm')).toBe(true)
    expect(editorAllowed('gm', 'admin')).toBe(false)
    expect(editorAllowed('admin', 'admin')).toBe(true)
  })
})

describe('parsing and layering', () => {
  it('invalid records are skipped with a problem, never fatal; a broken envelope gives an empty file', () => {
    const json = {
      schema: 1,
      kind: 'nests-override',
      world: 'jangan',
      rev: 7,
      updatedAt: 'now',
      add: [authored(AUTHORED_NEST_ID_MIN), authored(AUTHORED_NEST_ID_MIN), authored(3), { nonsense: true }],
      patch: [{ id: 1, count: 2 }, { id: 404, count: 2 }],
      remove: [2, 405, 'x'],
    }
    const { file, problems } = parseNestOverride(json, refs())
    expect(file.rev).toBe(7)
    expect(file.add.map((n) => n.id)).toEqual([AUTHORED_NEST_ID_MIN])
    expect(file.patch).toEqual([{ id: 1, count: 2 }])
    expect(file.remove).toEqual([2])
    expect(problems.length).toBe(6)
    expect(parseNestOverride({ ...json, world: 'donwhang' }, refs()).file).toEqual(emptyNestOverride('jangan'))
    expect(parseNestOverride('garbage', refs()).problems).toHaveLength(1)
  })

  it('nests: remove, then patch by id, then add; sources', () => {
    const o: NestOverrideFile = {
      ...emptyNestOverride('jangan'),
      remove: [2],
      patch: [{ id: 1, count: 1, aggressive: true, mob: TIGER.code }, { id: 2, count: 9 }],
      add: [authored(AUTHORED_NEST_ID_MIN + 1)],
    }
    const out = layerNests(BASE, o, (c) => MOBS.get(c))
    expect(out.map((n) => n.id)).toEqual([1, 3, AUTHORED_NEST_ID_MIN + 1])
    expect(out[0]).toMatchObject({ count: 1, mob: TIGER.code, level: TIGER.level, tactics: { aggressive: true } })
    expect(BASE[0].count).not.toBe(1) // the export is never mutated
    expect(out[1]).toBe(BASE[2])
    expect(out[2]).toMatchObject({ provenance: 'authored', count: 4, source: { file: 'nests.override.json' } })
    expect(nestSource(1, o)).toBe('patched')
    expect(nestSource(3, o)).toBe('export')
    expect(nestSource(AUTHORED_NEST_ID_MIN + 1, o)).toBe('authored')
  })

  it('NPCs: patches, hidden exports, authored NPCX_* with a base model and shops', () => {
    const { file, problems } = parseNpcOverride(
      {
        ...emptyNpcOverride('jangan'),
        add: [
          { code: 'NPCX_1', base: 'NPC_CH_POTION', name: 'Old Smith Bo', x: 1, z: 2, yaw: 0.5, shop: 'STORE_CH_POTION' },
          { code: 'NPCX_2', base: 'NPC_UNKNOWN', name: 'x', x: 1, z: 2, yaw: 0 },
          { code: 'NPC_NOT_AUTHORED', base: 'NPC_CH_POTION', name: 'x', x: 1, z: 2, yaw: 0 },
        ],
        patch: [{ code: 'NPC_CH_POTION', name: 'Renamed', shop: null }, { code: 'NPCX_1', hidden: true }],
      },
      refs(),
    )
    expect(file.add.map((a) => a.code)).toEqual(['NPCX_1'])
    expect(file.patch).toEqual([{ code: 'NPC_CH_POTION', name: 'Renamed', shop: null }])
    expect(problems).toHaveLength(3)
    const layered = layerNpcs(NPCS, file, 'jangan')
    expect(layered.npcs.map((n) => n.code)).toEqual(['NPC_CH_POTION', 'NPC_CH_ELSEWHERE', 'NPCX_1'])
    expect(layered.npcs[0].name).toBe('Renamed')
    expect(layered.npcs[0].shop).toBeUndefined()
    expect(layered.model.get('NPCX_1')).toBe('NPC_CH_POTION')
    expect(layered.shop.get('NPCX_1')).toBe('STORE_CH_POTION')
    expect(layered.shop.get('NPC_CH_POTION')).toBeNull()
    const hidden = layerNpcs(NPCS, { ...file, patch: [{ code: 'NPC_CH_POTION', hidden: true }] }, 'jangan')
    expect(hidden.npcs.map((n) => n.code)).toEqual(['NPC_CH_ELSEWHERE', 'NPCX_1'])
  })

  it('contentState layers the files on disk into GameData (startup) and applyLayers rebuilds it', () => {
    const dataDir = tmp()
    const o = { ...emptyNestOverride('jangan'), rev: 3, remove: [3], add: [authored(AUTHORED_NEST_ID_MIN)] }
    writeJsonAtomic(join(dataDir, 'content', 'nests.override.json'), o)
    writeJsonAtomic(join(dataDir, 'content', 'npcs.override.json'), {
      ...emptyNpcOverride('jangan'),
      add: [{ code: 'NPCX_1', base: 'NPC_CH_POTION', name: 'Bo', x: 1, z: 2, yaw: 0 }],
      patch: [{ code: 'NPC_CH_POTION', shop: null }],
    })
    const data = new GameData({ mobs: [MANGNYANG, TIGER], nests: BASE, npcs: NPCS as NpcDef[], shops: SHOPS })
    expect(data.npcShop.get('NPC_CH_POTION')).toBe('STORE_CH_POTION')
    const logs: string[] = []
    const st = contentState(data, dataDir, 'jangan', (m) => logs.push(m))
    expect(data.nests.map((n) => n.id)).toEqual([1, 2, AUTHORED_NEST_ID_MIN])
    expect(data.npcs.map((n) => n.code)).toContain('NPCX_1')
    expect(data.npcModel.get('NPCX_1')).toBe('NPC_CH_POTION')
    expect(data.npcShop.has('NPC_CH_POTION')).toBe(false)
    expect(logs.join('\n')).toMatch(/nests rev 3/)
    // same object on a second call; back to the export when the files empty out
    expect(contentState(data, dataDir, 'jangan')).toBe(st)
    st.nests = emptyNestOverride('jangan')
    st.npcs = emptyNpcOverride('jangan')
    applyLayers(data, st)
    expect(data.nests.map((n) => n.id)).toEqual([1, 2, 3])
    expect(data.npcShop.get('NPC_CH_POTION')).toBe('STORE_CH_POTION')
    expect(data.npcModel.size).toBe(0)
  })

  it('an unreadable override file is logged and skipped, never fatal', () => {
    const dataDir = tmp()
    writeJsonAtomic(join(dataDir, 'content', 'x.json'), {})
    writeFileSync(join(dataDir, 'content', 'nests.override.json'), '{ not json')
    const data = new GameData({ mobs: [MANGNYANG, TIGER], nests: BASE })
    const logs: string[] = []
    const st = contentState(data, dataDir, 'jangan', (m) => logs.push(m))
    expect(st.problems.nests[0]).toMatch(/not JSON/)
    expect(data.nests).toHaveLength(3)
    expect(logs.some((l) => l.includes('content override nests'))).toBe(true)
  })
})

describe('files: atomic write and history', () => {
  it('writes leave no temp file; history keeps the last 100 per file and undo pops the newest first', () => {
    const root = tmp()
    const rel = 'nests.override.json'
    let prev: unknown = { v: 0 }
    for (let v = 1; v <= HISTORY_KEEP + 5; v++) {
      saveVersioned(root, rel, prev, { v })
      prev = { v }
    }
    expect(JSON.parse(readFileSync(join(root, rel), 'utf8'))).toEqual({ v: HISTORY_KEEP + 5 })
    expect(readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual([])
    const hist = listHistory(root, rel)
    expect(hist).toHaveLength(HISTORY_KEEP)
    // other files' history is separate
    saveVersioned(root, 'quests/JG_002.json', null, { q: 1 })
    expect(listHistory(root, rel)).toHaveLength(HISTORY_KEEP)
    expect(listHistory(root, 'quests/JG_002.json')).toHaveLength(1)
    expect(existsSync(join(root, HISTORY_DIR))).toBe(true)
    expect(popHistory(root, rel)).toEqual({ v: HISTORY_KEEP + 4 })
    expect(popHistory(root, rel)).toEqual({ v: HISTORY_KEEP + 3 })
    expect(listHistory(root, rel)).toHaveLength(HISTORY_KEEP - 2)
    expect(popHistory(root, 'npcs.override.json')).toBeNull()
  })
})

describe('Spawner runtime nests (addNest/updateNest/removeNest bookkeeping)', () => {
  function spawner() {
    const sp = new Spawner(BASE, (c) => MOBS.get(c), { world: 'jangan', mobLevelMax: 25, rng: seeded(3) }, (x) => x < 500)
    let id = 100
    const spawn = () => id++
    sp.fill(spawn)
    return { sp, spawn }
  }

  it('a new nest fills; a refused one reports why', () => {
    const { sp, spawn } = spawner()
    const def = { ...nest(AUTHORED_NEST_ID_MIN, MANGNYANG.code, 40, -40), count: 3 }
    const r = sp.updateNest(def.id, def)
    expect(r.nest).not.toBeNull()
    expect(sp.fillNest(r.nest!, spawn)).toBe(3)
    expect(sp.nest(def.id)!.alive.size).toBe(3)
    expect(sp.updateNest(def.id + 1, { ...def, id: def.id + 1, x: 900 }).reason).toBe('outside the world')
    expect(sp.updateNest(def.id + 2, { ...def, id: def.id + 2, mob: HIGH.code }).reason).toMatch(/^level 90/)
    expect(sp.skipped.some((s) => s.nest === def.id + 1)).toBe(true)
  })

  it('a smaller count despawns the extras (pending first, then the caller order); a new mob or centre despawns all', () => {
    const { sp, spawn } = spawner()
    const n1 = sp.nest(1)!
    const ids = [...n1.alive]
    expect(ids).toHaveLength(5)
    sp.died(ids[0], 1000)
    expect(n1.pending).toHaveLength(1)
    const r = sp.updateNest(1, { ...BASE[0], count: 2 }, (list) => [...list].reverse())
    expect(n1.pending).toHaveLength(0)
    expect(r.despawn).toEqual([ids[4], ids[3]])
    expect(n1.alive.size).toBe(2)
    expect(sp.fillNest(n1, spawn)).toBe(0)
    const grow = sp.updateNest(1, { ...BASE[0], count: 4 })
    expect(grow.despawn).toEqual([])
    expect(sp.fillNest(n1, spawn)).toBe(2)
    const moved = sp.updateNest(1, { ...BASE[0], count: 4, x: 12 })
    expect(moved.despawn).toHaveLength(4)
    expect(n1.alive.size).toBe(0)
    expect(sp.fillNest(n1, spawn)).toBe(4)
    // a despawned id is forgotten: its death schedules nothing
    expect(sp.died(moved.despawn[0], 2000)).toBeNull()
  })

  it('removing a nest hands back its mobs and stops its respawns', () => {
    const { sp, spawn } = spawner()
    const alive = [...sp.nest(2)!.alive]
    const r = sp.updateNest(2, null)
    expect(r.nest).toBeNull()
    expect(r.despawn.sort()).toEqual(alive.sort())
    expect(sp.nest(2)).toBeUndefined()
    expect(sp.died(alive[0], 1)).toBeNull()
    expect(sp.tick(1e12, spawn)).toBe(0)
    // disabling works the same, and re-enabling brings it back
    expect(sp.updateNest(3, { ...BASE[2], enabled: false }).reason).toBe('disabled')
    const back = sp.updateNest(3, BASE[2])
    expect(back.nest).not.toBeNull()
    expect(sp.fillNest(back.nest!, spawn)).toBe(BASE[2].count)
  })
})

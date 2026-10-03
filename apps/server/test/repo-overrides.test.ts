/**
 * Repo content overrides (CONTENT_DIR/{nests,npcs}.override.json, docs/QUESTS.md §5.1; PACE): layerRepoOverrides
 * patches the exported NPCs and nests before the GM's DATA_DIR files are layered, so a GM override still applies on top
 * and the editors see the repo change as part of the export. Authored `add` records are ignored (GM editors only).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NestDef, NpcDef } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { contentState, emptyNestOverride, emptyNpcOverride, layerRepoOverrides, writeJsonAtomic } from '../src/editors/overrides.ts'
import { GameData } from '../src/gamedata.ts'
import { MANGNYANG, NPCS, SHOPS, TIGER, nest } from './fixtures.ts'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sro-repo-overrides-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const base = (): NestDef[] => [nest(1, MANGNYANG.code, 10, -10, { count: 5 }), nest(2, TIGER.code, 30, -30, { tactics: { id: 1, aggressive: true, sightRange: 10, leashRange: 25 } })]
const data = () => new GameData({ mobs: [MANGNYANG, TIGER], nests: base(), npcs: NPCS.map((n) => ({ ...n })) as NpcDef[], shops: SHOPS })

describe('layerRepoOverrides', () => {
  it('patches NPCs and nests from CONTENT_DIR before the GM files, which still apply on top', () => {
    const content = tmp()
    const dataDir = tmp()
    writeJsonAtomic(join(content, 'npcs.override.json'), {
      ...emptyNpcOverride('jangan'),
      add: [{ code: 'NPCX_9', base: 'NPC_CH_POTION', name: 'Nope', x: 0, z: 0, yaw: 0 }],
      patch: [{ code: 'NPC_CH_POTION', x: -410, z: -300, y: 6.7, yaw: 1.571 }, { code: 'NPC_CH_NOBODY', x: 1 }],
    })
    writeJsonAtomic(join(content, 'nests.override.json'), { ...emptyNestOverride('jangan'), patch: [{ id: 2, aggressive: false }], remove: [1] })
    // the GM moves the same NPC again in DATA_DIR
    writeJsonAtomic(join(dataDir, 'content', 'npcs.override.json'), { ...emptyNpcOverride('jangan'), rev: 2, patch: [{ code: 'NPC_CH_POTION', z: -299 }] })
    const d = data()
    const logs: string[] = []
    layerRepoOverrides(d, content, 'jangan', (m) => logs.push(m))
    const potion = d.npcs.find((n) => n.code === 'NPC_CH_POTION')!
    expect(potion).toMatchObject({ x: -410, z: -300, y: 6.7, yaw: 1.571 })
    expect(d.npcs.some((n) => n.code === 'NPCX_9')).toBe(false)
    expect(d.nests.map((n) => n.id)).toEqual([2])
    expect(d.nests[0].tactics.aggressive).toBe(false)
    expect(logs.join('\n')).toMatch(/NPC_CH_NOBODY/)
    expect(logs.join('\n')).toMatch(/1 authored records ignored/)
    // the GM layer captures the repo-patched content as its base and applies its own patch over it
    const st = contentState(d, dataDir, 'jangan')
    expect(st.base.npcs.find((n) => n.code === 'NPC_CH_POTION')).toMatchObject({ x: -410, z: -300 })
    expect(d.npcs.find((n) => n.code === 'NPC_CH_POTION')).toMatchObject({ x: -410, z: -299 })
  })

  it('does nothing without CONTENT_DIR or files, and never throws on a broken file', () => {
    const d = data()
    layerRepoOverrides(d, undefined, 'jangan', () => {})
    layerRepoOverrides(d, tmp(), 'jangan', () => {})
    expect(d.nests).toHaveLength(2)
    const content = tmp()
    writeJsonAtomic(join(content, 'nests.override.json'), { schema: 1, kind: 'nests-override', world: 'donwhang', patch: [{ id: 2, aggressive: false }] })
    const logs: string[] = []
    layerRepoOverrides(d, content, 'jangan', (m) => logs.push(m))
    expect(d.nests.find((n) => n.id === 2)!.tactics.aggressive).toBe(true)
    expect(logs.join('\n')).toMatch(/world is "donwhang"/)
  })
})

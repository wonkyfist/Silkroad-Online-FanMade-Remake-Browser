/**
 * Siege of Jangan, layer 2 sounds (docs/SIEGE.md §9.4): the retail structure, blast, falling-stone and bell files in the
 * export plan, the siege cues, and the real export in work/out/sound (skips without an exported index).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIEGE_CUES, SIEGE_SOUND_FILES, addSiegeSounds, type SoundIndex } from '../../shared/src/sound.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { planSoundIndex } from '../src/sound/build.ts'
import { SoundResolver } from '../src/sound/resolve.ts'

const emptyPlan = () =>
  planSoundIndex({
    scope: 'jangan', rows: [], envAreas: [], regionAreas: [], skillEffectText: '', resolver: new SoundResolver([]),
    models: [], players: [], mobs: [], skillGroups: [], musicKeys: [],
  })

describe('siege sound plan', () => {
  it('lists the retail fortress-war and bomb files the spec found, lower-case and unique', () => {
    for (const id of ['bldg/common/structure_dmg', 'bldg/common/structure_destroy', 'common/explode_bomb1', 'common/explode_bomb2', 'common/stone_bomb', 'env/bell towel 3']) {
      expect(SIEGE_SOUND_FILES).toContain(id)
    }
    expect(new Set(SIEGE_SOUND_FILES).size).toBe(SIEGE_SOUND_FILES.length)
    for (const id of SIEGE_SOUND_FILES) expect(id).toBe(id.toLowerCase())
  })

  it('adds the files and every cue; the bell is ambient, the rest sfx', () => {
    const plan = emptyPlan()
    addSiegeSounds(plan)
    for (const id of SIEGE_SOUND_FILES) expect(plan.files.has(id), id).toBe(true)
    expect(plan.ambient.has('env/bell towel 3')).toBe(true)
    expect(plan.ambient.has('bldg/common/structure_destroy')).toBe(false)
    for (const k of ['siege.wall.chip', 'siege.wall.collapse', 'siege.wall.blast', 'siege.keg.blast', 'siege.stone.fall', 'siege.bell']) {
      expect(plan.index.cues[k], k).toBeDefined()
    }
    expect(plan.index.cues['siege.bell']!.category).toBe('ambient')
    expect(plan.index.cues['siege.wall.collapse']!.category).toBe('sfx')
  })

  it('keeps the repair cue only when the town hammer is in the plan (synthesized, not retail)', () => {
    const without = emptyPlan()
    addSiegeSounds(without)
    expect(without.index.cues['siege.repair']).toBeUndefined()
    const withHammer = emptyPlan()
    withHammer.files.add('town/hammer_1')
    addSiegeSounds(withHammer)
    expect(withHammer.index.cues['siege.repair']!.files).toEqual(['town/hammer_1'])
  })

  it('every cue names only siege files or the town hammer', () => {
    for (const [k, c] of Object.entries(SIEGE_CUES)) {
      expect(k.startsWith('siege.'), k).toBe(true)
      for (const f of c.files) expect(SIEGE_SOUND_FILES.includes(f) || f.startsWith('town/hammer_'), `${k} ${f}`).toBe(true)
    }
  })
})

const indexPath = join(REPO_ROOT, 'work', 'out', 'sound', 'index.json')
describe.skipIf(!existsSync(indexPath))('siege sounds in the real export', () => {
  const index = existsSync(indexPath) ? (JSON.parse(readFileSync(indexPath, 'utf8')) as SoundIndex) : null

  it('has every siege file encoded and every siege cue', () => {
    for (const id of SIEGE_SOUND_FILES) {
      const f = index!.files[id]
      expect(f, id).toBeDefined()
      const p = join(REPO_ROOT, 'work', 'out', ...f!.url.split('/'))
      expect(existsSync(p), p).toBe(true)
      expect(statSync(p).size).toBe(f!.bytes)
      expect(f!.ms).toBeGreaterThan(500)
    }
    for (const k of Object.keys(SIEGE_CUES)) expect(index!.cues[k], k).toBeDefined()
  })
})

/**
 * W11-CV (docs/WAVE_PLAN7.md D12, §4.5): the wave's retail sound cues and export list: the unique notices'
 * `ui.uniqueAppear` / `ui.uniqueDown` (docs/UNIQUES.md §3.3) and the town's bell and animal cues (docs/TOWN_LIFE.md §6).
 * - the plan gets every cue and file (the bell as ambient), a missing file is recorded as unresolved and its cue
 *   dropped, and `finishSoundIndex` keeps the cues whose files were encoded;
 * - the list resolves every new file in work/extracted/Data/prim/snd exactly (skips without the extracted client);
 * - the exported index has the cues once the sound export has been re-run (skips otherwise).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateSoundIndex, type SoundFile, type SoundIndex } from '../../shared/src/sound.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { addUniqueAndTownSounds, finishSoundIndex, planSoundIndex, TOWN_CUES, UNIQUE_CUES, WAVE11_SOUND_FILES } from '../src/sound/build.ts'
import { normalizeSoundPath, soundId, SoundResolver } from '../src/sound/resolve.ts'

const ids = WAVE11_SOUND_FILES.map(f => soundId(normalizeSoundPath(f)))

const plan = (sources: readonly string[]) => {
  const resolver = new SoundResolver(sources)
  const p = planSoundIndex({
    scope: 'jangan', rows: [], envAreas: [], regionAreas: [], skillEffectText: '', resolver,
    models: [], players: [], mobs: [], skillGroups: [], musicKeys: [],
  })
  return { resolver, plan: p }
}
/** The resolver's misses from this list (planSoundIndex's own fixed cues, e.g. Berserk's, are not ours). */
const ours = (r: SoundResolver) => r.unresolved().filter(u => u.from.some(f => f.startsWith('wave 11'))).map(u => u.path).sort()
const fake = (id: string): SoundFile => ({ url: `sound/${id}.ogg`, ms: 1000, channels: 1, bytes: 100 })

describe('wave 11 cue table', () => {
  it('names the two unique cues and the retail town files', () => {
    expect(Object.fromEntries(UNIQUE_CUES)).toEqual({ 'ui.uniqueAppear': 'ui/alarm_sound.wav', 'ui.uniqueDown': 'ui/eventcomplete.wav' })
    expect(ids).toContain('env/bell towel 3')
    for (const animal of ['cos_horse_', 'cos_cat_', 'cos_wolf_01_', 'cos_donkey_', 'cos_cow_']) {
      expect(ids.some(id => id.startsWith('cos/' + animal)), animal).toBe(true)
    }
    expect(new Set(TOWN_CUES.map(([k]) => k)).size).toBe(TOWN_CUES.length)
  })

  it('adds every cue and file to the plan (the bell as ambient)', () => {
    const { resolver, plan: p } = plan(WAVE11_SOUND_FILES)
    const added = addUniqueAndTownSounds(p, resolver)
    expect(added).toEqual([...UNIQUE_CUES.map(([k]) => k), ...TOWN_CUES.map(([k]) => k)])
    for (const id of ids) expect(p.files.has(id), id).toBe(true)
    expect(p.index.cues['ui.uniqueAppear']).toEqual({ files: ['ui/alarm_sound'], gain: 1, category: 'ui' })
    expect(p.index.cues['ui.uniqueDown']).toEqual({ files: ['ui/eventcomplete'], gain: 1, category: 'ui' })
    expect(p.index.cues['town.bell']).toEqual({ files: ['env/bell towel 3'], gain: 1, category: 'ambient' })
    expect(p.ambient.has('env/bell towel 3')).toBe(true)
    expect(p.ambient.has('ui/alarm_sound')).toBe(false)
    expect(p.index.cues['town.dog']!.files).toHaveLength(4)
    expect(ours(resolver)).toEqual([])
  })

  it('records a missing file as unresolved and leaves its cue out; finish keeps encoded cues only', () => {
    const { resolver, plan: p } = plan(WAVE11_SOUND_FILES.filter(f => !/eventcomplete|cos_cat/.test(f)))
    addUniqueAndTownSounds(p, resolver)
    expect(p.index.cues['ui.uniqueDown']).toBeUndefined()
    expect(p.index.cues['town.cat']).toBeUndefined()
    expect(ours(resolver)).toEqual(['cos/cos_cat_stand1.wav', 'ui/eventcomplete.wav'])
    const files: Record<string, SoundFile> = {}
    for (const id of p.files) if (id !== 'ui/alarm_sound') files[id] = fake(id)
    const index = finishSoundIndex(p, files, resolver, { codec: 'opus', wavFallback: false, generatedAt: 'test', sourceFiles: 0, sourceBytes: 0, outBytes: 0, notExported: ['ui/alarm_sound'] })
    expect(index.cues['ui.uniqueAppear']).toBeUndefined()
    expect(index.cues['town.bell']?.files).toEqual(['env/bell towel 3'])
  })
})

const sndDir = join(REPO_ROOT, 'work', 'extracted', 'Data', 'prim', 'snd')
const hasExtracted = existsSync(sndDir)

function listWavs(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listWavs(p))
    else if (/\.wav$/i.test(e.name)) out.push(relative(sndDir, p).replace(/\\/g, '/'))
  }
  return out
}

describe.skipIf(!hasExtracted)('the extracted client (work/extracted/Data/prim/snd)', () => {
  it('resolves every new file exactly (no basename fallback)', () => {
    const resolver = new SoundResolver(listWavs(sndDir))
    for (const id of ids) expect(resolver.has(id), id).toBe(true)
    const { plan: p } = plan([])
    addUniqueAndTownSounds(p, resolver)
    expect(resolver.unresolved()).toEqual([])
    expect(resolver.fixed.size).toBe(0)
  })
})

describe('the exported index (work/out/sound)', () => {
  const path = join(REPO_ROOT, 'work', 'out', 'sound', 'index.json')
  const index = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SoundIndex) : null
  const exported = !!index?.cues['ui.uniqueAppear']
  it.skipIf(!exported)('has the wave 11 cues and their files after the sound export is re-run', () => {
    expect(validateSoundIndex(index)).toEqual([])
    for (const [k] of [...UNIQUE_CUES, ...TOWN_CUES]) {
      expect(index!.cues[k], k).toBeDefined()
      for (const id of index!.cues[k]!.files) expect(index!.files[id], id).toBeDefined()
    }
  })
})

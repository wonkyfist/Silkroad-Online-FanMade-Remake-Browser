/**
 * The coast's sounds (docs/COAST.md §10.1, lane CST-A): the four files in the export plan and the COAST area, and the
 * real export in work/out/sound when it has been re-run (skips otherwise).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SoundFile, SoundIndex } from '../../shared/src/sound.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { finishSoundIndex, planSoundIndex } from '../src/sound/build.ts'
import { COAST_AREA_ID, COAST_AREA_SOURCE, COAST_SOUND_FILES, addCoastSounds } from '../src/sound/coast.ts'
import type { EnvArea } from '../src/sound/envsnd.ts'
import { SoundResolver } from '../src/sound/resolve.ts'

const BEACH: EnvArea = {
  name: COAST_AREA_SOURCE,
  music: 'AsiaMinor_Field.ogg',
  day: [
    { file: 'sea_wave1.wav', min: 0, max: 0 },
    { file: 'seabird2.wav', min: 20, max: 35 },
    { file: 'day_wind02.wav', min: 30, max: 40 },
    { file: 'seabird.wav', min: 35, max: 40 },
  ],
  night: [
    { file: 'sea_wave1.wav', min: 0, max: 0 },
    { file: 'seabird2.wav', min: 10, max: 25 },
  ],
  line: 437,
}
const FIELD: EnvArea = {
  name: '장안필드',
  music: 'Jangan_Field.ogg',
  day: [{ file: 'day_wind.wav', min: 0, max: 0 }, { file: 'day_bird01.wav', min: 15, max: 30 }],
  night: [{ file: 'night_wind.wav', min: 0, max: 0 }],
  line: 1,
}
const SOURCES = ['env/sea_wave1', 'env/seabird', 'env/seabird2', 'env/oceana', 'env/day_wind', 'env/day_wind02', 'env/night_wind', 'env/day_bird01'].map(f => `${f}.wav`)

const plan = (envAreas: EnvArea[]) => {
  const resolver = new SoundResolver(SOURCES)
  const p = planSoundIndex({
    scope: 'jangan', rows: [], envAreas, regionAreas: [], skillEffectText: '', resolver,
    models: [], players: [], mobs: [], skillGroups: [], musicKeys: ['jangan_field'],
  })
  return { resolver, plan: p }
}
const fake = (id: string): SoundFile => ({ url: `sound/${id}.ogg`, ms: 1000, channels: 1, bytes: 100 })

describe('coast sound plan', () => {
  it('adds the four files as ambient, lower-case', () => {
    const { resolver, plan: p } = plan([FIELD, BEACH])
    addCoastSounds(p, [FIELD, BEACH], resolver)
    expect([...COAST_SOUND_FILES].sort()).toEqual(['env/oceana', 'env/sea_wave1', 'env/seabird', 'env/seabird2'])
    for (const id of COAST_SOUND_FILES) {
      expect(p.files.has(id), id).toBe(true)
      expect(p.ambient.has(id), id).toBe(true)
    }
  })

  it("builds COAST from the beach's one-shots over the field's loop bed", () => {
    const { resolver, plan: p } = plan([FIELD, BEACH])
    const area = addCoastSounds(p, [FIELD, BEACH], resolver)
    expect(p.index.areas[COAST_AREA_ID]).toBe(area)
    expect(area.kind).toBe('field')
    expect(area.source).toBe(COAST_AREA_SOURCE)
    // One loop: the field's bed (the beach's sea_wave1 loop is the client's positional surf).
    expect(area.day.filter(l => l.loop)).toEqual([{ file: 'env/day_wind', loop: true, everyS: [0, 0] }])
    expect(area.night.filter(l => l.loop).map(l => l.file)).toEqual(['env/night_wind'])
    expect(area.day.filter(l => !l.loop).map(l => [l.file, ...l.everyS])).toEqual([
      ['env/seabird2', 20, 35], ['env/day_wind02', 30, 40], ['env/seabird', 35, 40],
    ])
    expect([...area.day, ...area.night].some(l => l.file === 'env/sea_wave1')).toBe(false)
    expect(area.music).toBe(p.index.areas.JANGAN_FIELD?.music ?? null)
  })

  it('falls back to the retail file names without the beach area, and finish drops missing files', () => {
    const { resolver, plan: p } = plan([FIELD])
    addCoastSounds(p, [FIELD], resolver)
    const files: Record<string, SoundFile> = {}
    for (const id of p.files) if (id !== 'env/seabird') files[id] = fake(id)
    const index = finishSoundIndex(p, files, resolver, { codec: 'opus', wavFallback: false, generatedAt: 'test', sourceFiles: 0, sourceBytes: 0, outBytes: 0, notExported: ['env/seabird'] })
    const coast = index.areas[COAST_AREA_ID]!
    expect(coast.day.map(l => l.file)).toEqual(['env/day_wind', 'env/seabird2', 'env/day_wind02'])
  })
})

describe('the exported index (work/out/sound)', () => {
  const path = join(REPO_ROOT, 'work', 'out', 'sound', 'index.json')
  const index = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SoundIndex) : null
  const exported = !!index?.areas[COAST_AREA_ID]
  it.skipIf(!exported)('has the COAST area and its files', () => {
    for (const id of COAST_SOUND_FILES) expect(index!.files[id], id).toBeDefined()
    const coast = index!.areas[COAST_AREA_ID]!
    expect(coast.day.some(l => l.file === 'env/seabird')).toBe(true)
    expect(coast.day.find(l => l.loop)?.file).toBe(index!.areas.JANGAN_FIELD?.day.find(l => l.loop)?.file)
  })
})

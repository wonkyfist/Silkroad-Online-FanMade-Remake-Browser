/**
 * Weather sounds (docs/WEATHER.md §7.5, WAVE_PLAN3 §6.4 WX-A, docs/SOUND.md §8): the 12 files in the export plan, the
 * weather cues, and the real export in work/out/sound (skips without sro.config.json or an exported index).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WEATHER_CUES,
  WEATHER_SOUND_FILES,
  addWeatherSounds,
  thunderCue,
  validateSoundIndex,
  type SoundFile,
  type SoundIndex,
} from '../../shared/src/sound.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { finishSoundIndex, planSoundIndex } from '../src/sound/build.ts'
import { SoundResolver } from '../src/sound/resolve.ts'

const TWELVE = [
  'etc/rain1', 'etc/lightning1', 'etc/lightning2', 'etc/lightning3',
  'env/dd_mainwind', 'env/dd_wind_01', 'env/dd_wind_02',
  'env/donhwang_wind01', 'env/donhwang_wind02', 'env/donhwang_wind03', 'env/donhwang_wind04', 'env/donhwang_wind05',
]
const SPEC_CUES = ['weather.rain', 'weather.thunder.near', 'weather.thunder.mid', 'weather.thunder.far', 'weather.wind.strong']

const emptyPlan = () => {
  const resolver = new SoundResolver([])
  const plan = planSoundIndex({
    scope: 'jangan', rows: [], envAreas: [], regionAreas: [], skillEffectText: '', resolver,
    models: [], players: [], mobs: [], skillGroups: [], musicKeys: [],
  })
  return { resolver, plan }
}
const fakeFile = (id: string): SoundFile => ({ url: `sound/${id}.ogg`, ms: 1000, channels: id === 'etc/rain1' ? 2 : 1, bytes: 100 })

describe('weather sound plan', () => {
  it('lists the 12 files, lower-case and unique', () => {
    expect([...WEATHER_SOUND_FILES].sort()).toEqual([...TWELVE].sort())
    expect(new Set(WEATHER_SOUND_FILES).size).toBe(12)
    for (const id of WEATHER_SOUND_FILES) expect(id).toBe(id.toLowerCase())
  })

  it('has the spec cues, on the ambient bus, referencing only the 12 files', () => {
    for (const k of SPEC_CUES) expect(WEATHER_CUES[k], k).toBeDefined()
    expect(WEATHER_CUES['weather.rain']!.files).toEqual(['etc/rain1'])
    // W9F A5: the strong-wind bed is the steady dd_mainwind; donhwang_wind04 (gusts with silent dips) is a gust one-shot.
    expect(WEATHER_CUES['weather.wind.strong']!.files).toEqual(['env/dd_mainwind'])
    expect(['near', 'mid', 'far'].map(d => WEATHER_CUES[`weather.thunder.${d}`]!.files[0])).toEqual(['etc/lightning1', 'etc/lightning2', 'etc/lightning3'])
    for (const [k, c] of Object.entries(WEATHER_CUES)) {
      expect(k.startsWith('weather.'), k).toBe(true)
      expect(c.category, k).toBe('ambient')
      expect(c.files.length, k).toBeGreaterThan(0)
      for (const f of c.files) expect(WEATHER_SOUND_FILES, `${k} ${f}`).toContain(f)
    }
  })

  it('thunderCue splits at 800 and 2000 m', () => {
    expect(thunderCue(0)).toBe('weather.thunder.near')
    expect(thunderCue(799)).toBe('weather.thunder.near')
    expect(thunderCue(800)).toBe('weather.thunder.mid')
    expect(thunderCue(1999)).toBe('weather.thunder.mid')
    expect(thunderCue(2000)).toBe('weather.thunder.far')
  })

  it('addWeatherSounds puts the 12 files (ambient class) and the cues into the plan; the finished index validates', () => {
    const { resolver, plan } = emptyPlan()
    addWeatherSounds(plan)
    for (const id of TWELVE) {
      expect(plan.files.has(id), id).toBe(true)
      expect(plan.ambient.has(id), id).toBe(true)
    }
    for (const k of Object.keys(WEATHER_CUES)) expect(plan.index.cues[k], k).toEqual(WEATHER_CUES[k])
    // The plan's cues are copies: editing them leaves the shared table alone.
    plan.index.cues['weather.rain']!.files.push('x')
    expect(WEATHER_CUES['weather.rain']!.files).toEqual(['etc/rain1'])
    plan.index.cues['weather.rain']!.files.pop()

    // lightning3 missing from the export: its cue is dropped, the rest stay, the index stays valid.
    const files = Object.fromEntries(TWELVE.filter(id => id !== 'etc/lightning3').map(id => [id, fakeFile(id)]))
    const idx = finishSoundIndex(plan, files, resolver, {
      codec: 'opus', wavFallback: false, generatedAt: '2026-09-28T00:00:00Z', sourceFiles: 12, sourceBytes: 1, outBytes: 1, notExported: ['etc/lightning3: no source file'],
    })
    expect(validateSoundIndex(idx)).toEqual([])
    expect(idx.cues['weather.thunder.far']).toBeUndefined()
    expect(idx.cues['weather.thunder.near']!.files).toEqual(['etc/lightning1'])
    expect(idx.cues['weather.rain']!.category).toBe('ambient')
  })
})

const OUT = join(REPO_ROOT, 'work', 'out')
const INDEX = join(OUT, 'sound', 'index.json')
const HAS = existsSync(join(REPO_ROOT, 'sro.config.json')) && existsSync(INDEX)

describe.skipIf(!HAS)('work/out/sound weather files', () => {
  const idx = HAS ? (JSON.parse(readFileSync(INDEX, 'utf8')) as SoundIndex) : (null as unknown as SoundIndex)

  it('the export wrote the 12 files (rain stereo, the rest mono) and the weather cues', () => {
    expect(existsSync(join(OUT, 'sound', 'etc', 'rain1.ogg')) || existsSync(join(OUT, 'sound', 'etc', 'rain1.wav'))).toBe(true)
    for (const id of TWELVE) {
      const f = idx.files[id]
      expect(f, id).toBeDefined()
      const p = join(OUT, ...f!.url.split('/'))
      expect(existsSync(p), f!.url).toBe(true)
      expect(statSync(p).size, f!.url).toBe(f!.bytes)
      expect(f!.channels, id).toBe(id === 'etc/rain1' ? 2 : 1)
    }
    // The client takes WEATHER_CUES over the index's cues whenever the index has their files (apps/game/src/audio
    // index.ts weatherCue, W9F A5), so an export from before a reassignment still plays the code's cues.
    for (const [k, c] of Object.entries(WEATHER_CUES)) {
      expect(idx.cues[k], k).toBeDefined()
      for (const f of c.files) expect(idx.files[f], `${k} ${f}`).toBeDefined()
    }
  })

  it('durations match the retail files (trailing silence trimmed)', () => {
    const ms = (id: string) => idx.files[id]!.ms
    expect(ms('etc/rain1')).toBeGreaterThan(2250)
    expect(ms('etc/rain1')).toBeLessThanOrEqual(2330)
    expect(ms('etc/lightning1')).toBeLessThan(ms('etc/lightning2'))
    expect(ms('etc/lightning2')).toBeLessThan(ms('etc/lightning3'))
    expect(ms('env/donhwang_wind04')).toBeGreaterThan(15000)
    expect(ms('env/donhwang_wind04')).toBeLessThanOrEqual(20730)
    const total = TWELVE.reduce((n, id) => n + ms(id), 0)
    expect(total).toBeGreaterThan(70_000)
    expect(total).toBeLessThan(96_000)
  })
})

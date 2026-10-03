// The viewer's render lab (lane LAB): the query string, the §5.1 rows as data, the lab weather frame and clock, and
// the pure parts of the bench and the DETAIL H8 normal check. The GPU parts run in the browser (the lab report).
import { describe, expect, it } from 'vitest'
import { RENDER_PRESETS, SKY_PRESETS, type RenderQuality } from '@sro/world-render'
import { WEATHER_KINDS, weatherParams } from '../../../packages/shared/src/weather.ts'
import { clockAt, CLOCK_LIMITS } from '../../../packages/shared/src/world-clock.ts'
import {
  PRESETS,
  RENDER_ROW_KEYS,
  SKY_ROW_KEYS,
  autoWeatherLevel,
  fastClockState,
  labFrame,
  parseLabParams,
  renderRowChoices,
  resolveLab,
  skyRowChoices,
  soaked,
  summarize,
  withRows,
} from '../src/world/render-panel.ts'
import { NORMAL_CASES, convertedQuad, expectedLight, formatSuite, minRuns, suiteCases, tiltedNormalMap } from '../src/world/lab-bench.ts'

describe('lab query string', () => {
  it('reads nothing from a plain viewer URL: the Classic viewer stays as it was', () => {
    const p = parseLabParams('?world=jangan&quality=high&time=0.3')
    expect(p).toEqual({
      preset: null, render: null, sky: null, weather: null, weatherLevel: null, clockMin: null, toneMap: null, lut: null, exposure: null,
      ssao: false, taaReprojection: false, fixes: [],
    })
    const lab = resolveLab(p, 'high')
    expect(lab.active).toBe(false)
    expect(lab.quality).toBe('high')
    expect(lab.renderPath).toBe('classic')
    expect(lab.skyStyle).toBe('classic')
    expect(lab.resolvedLevel).toBe('off')
  })

  it('reads every lab parameter', () => {
    const p = parseLabParams('?preset=HIGH&render=pbr&sky=classic&weather=rain:0.6&wxlevel=medium&clock=fast&tonemap=filmic&lut=dusk_rain&exposure=1.5&ssao=1&taaReproj=true')
    expect(p.preset).toBe('high')
    expect(p.render).toBe('pbr')
    expect(p.sky).toBe('classic')
    expect(p.weather).toEqual({ kind: 'rain', intensity: 0.6 })
    expect(p.weatherLevel).toBe('medium')
    expect(p.clockMin).toBe(2)
    expect(p.toneMap).toBe('filmic')
    expect(p.lut).toBe('dusk_rain')
    expect(p.exposure).toBe(1.5)
    expect(p.ssao).toBe(true)
    expect(p.taaReprojection).toBe(true)
    expect(parseLabParams('?fix=sheen,prepass,bogus').fixes).toEqual(['sheen', 'prepass'])
    expect(resolveLab(parseLabParams('?fix=sheen'), 'medium').active).toBe(false)
    expect(parseLabParams('?clock=30').clockMin).toBe(30)
    expect(parseLabParams('?weather=rain:0.1').weather).toEqual({ kind: 'rain', intensity: 0.4 })
    expect(parseLabParams('?weather=storm:0.5').weather).toEqual({ kind: 'storm', intensity: 1 })
  })

  it('ignores unknown values', () => {
    const p = parseLabParams('?preset=epic&render=raytraced&weather=snow&wxlevel=max&tonemap=agx&lut=noon&exposure=-1&clock=-5')
    expect(resolveLab(p, 'medium').active).toBe(false)
  })

  it('defaults a preset to its own path, the modern sky and the auto weather level', () => {
    for (const q of PRESETS) {
      const lab = resolveLab(parseLabParams(`?preset=${q}`), 'medium')
      expect(lab.active).toBe(true)
      expect(lab.renderPath).toBe(RENDER_PRESETS[q].path)
      expect(lab.skyStyle).toBe('modern')
      expect(lab.level).toBe('auto')
      expect(lab.resolvedLevel).toBe(autoWeatherLevel(q))
      expect(lab.weatherState).toEqual({ kind: 'clear', intensity: 1 })
    }
    // The Low guard view: Low + classic sky + weather off.
    const guard = resolveLab(parseLabParams('?preset=low&sky=classic&wxlevel=off'), 'medium')
    expect([guard.renderPath, guard.skyStyle, guard.resolvedLevel]).toEqual(['classic', 'classic', 'off'])
    expect(resolveLab(parseLabParams('?preset=low&render=pbr'), 'medium').renderPath).toBe('pbr')
    expect(resolveLab(parseLabParams('?sky=modern'), 'medium').resolvedLevel).toBe('off')
    expect(resolveLab(parseLabParams('?weather=storm'), 'medium').resolvedLevel).toBe('medium')
  })
})

describe('§5.1 rows', () => {
  it('offers every render row but the material path, and every sky row', () => {
    const keys = Object.keys(RENDER_PRESETS.high).filter(k => k !== 'path').sort()
    expect([...RENDER_ROW_KEYS].sort()).toEqual(keys)
    expect([...SKY_ROW_KEYS].sort()).toEqual(Object.keys(SKY_PRESETS.high).sort())
  })

  it("lists each preset's value once, labelled with the presets that use it", () => {
    for (const key of RENDER_ROW_KEYS) {
      const choices = renderRowChoices(key)
      for (const q of PRESETS) {
        const hits = choices.filter(c => JSON.stringify(c.value) === JSON.stringify(RENDER_PRESETS[q][key]))
        expect(hits, `${key} ${q}`).toHaveLength(1)
        expect(hits[0]!.presets).toContain(q)
      }
      expect(new Set(choices.map(c => JSON.stringify(c.value))).size).toBe(choices.length)
      for (const c of choices) expect(c.label.length).toBeGreaterThan(0)
    }
    for (const key of SKY_ROW_KEYS) {
      const choices = skyRowChoices(key)
      for (const q of PRESETS) expect(choices.some(c => c.presets.includes(q))).toBe(true)
    }
  })

  it('offers the A/B values the presets never pair (SSR always on High, MSAA, cluster 0 at night)', () => {
    expect(renderRowChoices('ssr').map(c => c.value)).toEqual(expect.arrayContaining(['off', 'puddles', 'always']))
    expect(renderRowChoices('aa').map(c => c.value)).toEqual(expect.arrayContaining(['msaa', 'fxaa', 'taa']))
    expect(renderRowChoices('nightLights').map(c => (c.value as RenderQuality['nightLights']).cluster)).toEqual(expect.arrayContaining([0, 8, 32, 64]))
    expect(renderRowChoices('shadows').find(c => c.value === null)?.label).toBe('off (low)')
  })

  it('summarises values', () => {
    expect(summarize(RENDER_PRESETS.high.shadows)).toBe('2048×3 150 m fol 60 +terr')
    expect(summarize(RENDER_PRESETS.medium.ibl)).toBe('32² / 10 s')
    expect(summarize(null)).toBe('off')
    expect(summarize(true)).toBe('on')
    expect(summarize('taa')).toBe('taa')
    expect(summarize(RENDER_PRESETS.low.terrain)).toBe('none')
    expect(summarize(RENDER_PRESETS.medium.terrain)).toBe('detailLayer antiTiling')
  })

  it('replaces only the rows given', () => {
    const base = RENDER_PRESETS.high
    const out = withRows(base as RenderQuality, new Map<keyof RenderQuality, unknown>([['ssr', 'always'], ['shadows', null]]))
    expect(out.ssr).toBe('always')
    expect(out.shadows).toBeNull()
    expect(out.aa).toBe(base.aa)
    expect(base.ssr).toBe('off') // §6.20 cut 4 (wave-9 final gate): High has no SSR; the row is untouched
  })
})

describe('lab weather and clock', () => {
  it('builds frames in range for every state', () => {
    for (const kind of WEATHER_KINDS) {
      const p = weatherParams(kind)
      const f = labFrame(p, soaked(p), 123_456, null)
      for (const k of ['cloud', 'cloudDark', 'cirrus', 'rain', 'fog', 'sun', 'desat', 'wet', 'puddle'] as const) {
        expect(f[k], `${kind} ${k}`).toBeGreaterThanOrEqual(0)
        expect(f[k], `${kind} ${k}`).toBeLessThanOrEqual(1)
      }
      expect(Math.hypot(f.windX, f.windZ)).toBeCloseTo(1, 6)
      expect(f.gustMs).toBeGreaterThanOrEqual(0)
      expect(f.flash).toBe(0)
      expect(f.time).toBeGreaterThanOrEqual(0)
      expect(f.time).toBeLessThan(3600)
    }
  })

  it('soaks a storm and leaves clear weather dry', () => {
    const storm = soaked(weatherParams('storm'))
    expect(storm.wet).toBeGreaterThan(0.9)
    expect(storm.puddle).toBeGreaterThan(0.5)
    expect(soaked(weatherParams('clear'))).toEqual({ wet: 0, puddle: 0 })
  })

  it('flashes after a strike and not before', () => {
    const p = weatherParams('storm')
    const s = soaked(p)
    const peak = Math.max(...[50, 100, 150, 200, 300].map(dt => labFrame(p, s, 10_000 + dt, 10_000).flash))
    expect(peak).toBeGreaterThan(0.5)
    expect(labFrame(p, s, 9_000, 10_000).flash).toBe(0)
  })

  it('starts a fast clock at the current solar time', () => {
    for (const t of [0, 0.25, 0.3, 0.5, 0.7, 0.99]) {
      const c = fastClockState(t, 1_000_000, 2)
      expect(c.running).toBe(true)
      expect(c.dayMs).toBe(120_000)
      expect(clockAt(c, 1_000_000).t).toBeCloseTo(t, 6)
    }
    expect(fastClockState(0.5, 0, 0.1).dayMs).toBe(CLOCK_LIMITS.dayMs[0])
    // Two real minutes later a fast day has passed.
    const c = fastClockState(0.5, 0, 2)
    expect(clockAt(c, 120_000).t).toBeCloseTo(0.5, 6)
    expect(clockAt(c, 120_000).day).toBe(clockAt(c, 0).day + 1)
  })
})

describe('bench and normal check (pure parts)', () => {
  it('keeps the minimum of the runs', () => {
    expect(minRuns([{ wall: 5, cpu: 3 }, { wall: 4, cpu: 3.5 }, { wall: 6, cpu: 2.9 }])).toEqual({ wall: 4, cpu: 2.9 })
    expect(Number.isNaN(minRuns([]).wall)).toBe(true)
  })

  it('has a suite per material path', () => {
    const classic = suiteCases('classic')
    expect(classic.map(c => c.label)).toContain('low noon clear')
    expect(classic.some(c => c.label.startsWith('high'))).toBe(false)
    const pbr = suiteCases('pbr')
    for (const q of ['medium', 'high', 'ultra']) for (const w of ['noon clear', 'noon storm (soaked)', 'night clear']) expect(pbr.map(c => c.label)).toContain(`${q} ${w}`)
    expect(pbr.map(c => c.label)).toEqual(expect.arrayContaining(['high storm, ssr always', 'high night, cluster 0 (low row)', 'high noon, aa msaa x4']))
    expect(suiteCases('pbr', 'presets').every(c => /^(medium|high|ultra) /.test(c.label))).toBe(true)
    const text = formatSuite([{ label: 'x', hd: { label: 'x', width: 1920, height: 1080, wallMs: 5, cpuMs: 4, gpuPassMs: null }, uhd: null, gpuEstMs: null }])
    expect(text.split('\n')).toHaveLength(2)
  })

  it('builds the test quad the way the converter writes geometry (Z mirror, reversed winding, front face +Y)', () => {
    for (const uv of ['plain', 'mirrored'] as const) {
      const q = convertedQuad(uv)
      for (let t = 0; t < q.indices.length; t += 3) {
        const [a, b, c] = [q.indices[t]!, q.indices[t + 1]!, q.indices[t + 2]!].map(i => q.positions.slice(i * 3, i * 3 + 3))
        const e1 = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!]
        const e2 = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!]
        // cross(b − a, c − a) · +Y: counter-clockwise from above, the front face of a right-handed scene.
        expect(e1[2]! * e2[0]! - e1[0]! * e2[2]!).toBeGreaterThan(0)
      }
      // u runs along world +X (plain) or −X (mirrored); v along world −Z (the file's +Z).
      const u = (i: number) => q.uvs[i * 2]!
      const v = (i: number) => q.uvs[i * 2 + 1]!
      const x = (i: number) => q.positions[i * 3]!
      const z = (i: number) => q.positions[i * 3 + 2]!
      expect(Math.sign((u(1) - u(0)) / (x(1) - x(0)))).toBe(uv === 'plain' ? 1 : -1)
      expect(Math.sign((v(2) - v(1)) / (z(2) - z(1)))).toBe(-1)
    }
  })

  it('expects a normal_gl texel to face increasing u (image right) and decreasing v (image up)', () => {
    expect(NORMAL_CASES.map(expectedLight)).toEqual(['+x', '+z', '-x', '+z'])
    const right = tiltedNormalMap('right', 'gl')
    const up = tiltedNormalMap('up', 'gl')
    const upDx = tiltedNormalMap('up', 'dx')
    expect(right[0]).toBeGreaterThan(128)
    expect(right[1]).toBe(128)
    expect(up[1]).toBeGreaterThan(128)
    expect(upDx[1]).toBeLessThan(128)
    expect(up[2]).toBeGreaterThan(200)
  })
})

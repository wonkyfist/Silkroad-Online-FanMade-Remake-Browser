/**
 * content/environment/overrides.json (./world/environment-overrides.ts): hand-tuned float graphs replace retail ones in
 * the export's environment.json. P-DATA (wave 10r polish): retail Lake Forest (profile 18) starts its fog at the camera
 * at noon (graph10 -0.147); the override pushes it out in clear weather and keeps the night, dawn and dusk hazier.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyEnvironmentOverrides, parseEnvironmentOverrides } from '../src/world/environment-overrides.ts'
import { REPO_ROOT } from '../src/node-io.ts'

/** Linear sample of a float graph at time t (world-render environment.ts sampleFloat, without the wrap). */
const sample = (keys: Array<{ time: number; value: number }>, t: number) => {
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!
    const b = keys[i]!
    if (t <= b.time) return a.value + ((b.value - a.value) * (t - a.time)) / (b.time - a.time)
  }
  return keys.at(-1)!.value
}

describe('environment overrides (P-DATA)', () => {
  const file = parseEnvironmentOverrides(readFileSync(join(REPO_ROOT, 'content', 'environment', 'overrides.json'), 'utf8'))

  it('the repo file is valid and only tunes Lake Forest (profile 18)', () => {
    expect(file.profiles.map(p => p.id)).toEqual([18])
    const lake = file.profiles[0]!.graphs
    // clear noon: the fog starts well out (retail -0.147 = at the camera) and ends where every other profile does
    expect(sample(lake.graph10!, 0.5)).toBeGreaterThanOrEqual(0.5)
    expect(sample(lake.graph11!, 0.5)).toBe(1)
    // the mood stays: midnight as retail, dawn and dusk hazier than noon
    expect(sample(lake.graph10!, 0)).toBeCloseTo(0.307, 3)
    expect(sample(lake.graph10!, 0.75)).toBeLessThan(sample(lake.graph10!, 0.5) / 2)
    expect(sample(lake.graph10!, 0.25)).toBeLessThan(sample(lake.graph10!, 0.5) / 2)
    for (const t of [0, 0.25, 0.5, 0.75, 1]) expect(sample(lake.graph10!, t)).toBeLessThan(sample(lake.graph11!, t))
  })

  it('replaces whole graphs of the named profile, leaves the others and reports what it did', () => {
    const retail = [
      { id: 0, graph10: [{ value: 0.76, time: 0 }, { value: 0.76, time: 1 }], graph11: [{ value: 1, time: 0 }, { value: 1, time: 1 }] },
      { id: 18, graph10: [{ value: -0.147, time: 0 }, { value: -0.147, time: 1 }], graph11: [{ value: 0.92, time: 0 }, { value: 0.92, time: 1 }] },
    ]
    const before = structuredClone(retail)
    const { profiles, applied } = applyEnvironmentOverrides(retail, file)
    expect(retail).toEqual(before)
    expect(profiles[0]).toBe(retail[0])
    expect(profiles[1]!.graph10).toEqual(file.profiles[0]!.graphs.graph10)
    expect(profiles[1]!.graph11).toEqual(file.profiles[0]!.graphs.graph11)
    expect(applied).toEqual(['profile 18 (Lake Forest): graph10, graph11'])
    expect(applyEnvironmentOverrides([retail[0]!], file).applied).toEqual(['profile 18: not used by the export, skipped'])
  })

  it('rejects malformed files', () => {
    const base = { format: 'sro-environment-overrides', version: 1 }
    const bad = (profiles: unknown) => () => parseEnvironmentOverrides(JSON.stringify({ ...base, profiles }))
    expect(bad([{ id: 18, fogColor: [{ time: 0, value: 1 }, { time: 1, value: 1 }] }])).toThrow(/not a float graph/)
    expect(bad([{ id: 18, graph10: [{ time: 0.2, value: 1 }, { time: 1, value: 1 }] }])).toThrow(/rise from 0 to 1/)
    expect(bad([{ id: 18, graph10: [{ time: 0, value: 9 }, { time: 1, value: 1 }] }])).toThrow(/value -1..2/)
    expect(bad([{ id: 18 }])).toThrow(/no graph/)
    expect(bad([{ id: 18, graph10: [{ time: 0, value: 0 }, { time: 1, value: 0 }] }, { id: 18, graph11: [{ time: 0, value: 0 }, { time: 1, value: 0 }] }])).toThrow(/duplicate/)
    expect(() => parseEnvironmentOverrides(JSON.stringify({ format: 'x', version: 1, profiles: [] }))).toThrow(/format/)
  })
})

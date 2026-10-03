/**
 * H-11 adversarial hunt (docs/WAVE_PLAN7.md §6.6 lens 10, "hitches"), world-render's side. Read-only: no product code
 * is changed by this file.
 *
 * FINDING (H11-HI-2): building Jangan's town schedule (town/schedule.ts `new TownSchedule(jangan.json)`: a Dijkstra per
 * trip over the street graph) costs ≈ 120–190 ms of main thread on the dev PC (node, measured: the profile puts most of
 * it in `dijkstra`, `walkPoints`, `MinHeap`, `Trip`), in one task. On the character stage it is built TWICE in that
 * task: the stage configures its `noFolk` circle on its first frame (stage/host.ts) while the town file is still
 * loading, so `defaultPlan` builds the plain schedule when town.json arrives and `withPlan` at once builds it again
 * through `plan.replan(noFolk)` (town/index.ts). ≈ 190–380 ms in one task, at whatever frame the fetch lands; the
 * first build is thrown away. (When the file lands first, `configure` replans instead: two builds in two tasks.
 * Everywhere else it is built once. The stage's warm-up usually hides it behind the loading picture: low severity.)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NullEngine, Scene } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TownFile } from '../../shared/src/town.ts'
import type { World } from '../src/world.ts'

const count = vi.hoisted(() => ({ schedules: 0, ms: [] as number[] }))
vi.mock('../src/town/schedule.ts', async orig => {
  const m = await orig<typeof import('../src/town/schedule.ts')>()
  class Counted extends m.TownSchedule {
    constructor(...a: ConstructorParameters<typeof m.TownSchedule>) {
      const t0 = performance.now()
      super(...a)
      count.schedules++
      count.ms.push(performance.now() - t0)
    }
  }
  return { ...m, TownSchedule: Counted }
})

import { stubCrowdAssets } from '../src/town/crowd.ts'
import { TownLife } from '../src/town/index.ts'

const JANGAN = JSON.parse(readFileSync(join(import.meta.dirname, '../../../content/town/jangan.json'), 'utf8')) as TownFile

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
  vi.restoreAllMocks()
})

/** A Jangan world whose export serves town.json (after `delayMs`). */
function janganWorld(scene: Scene, delayMs: number): World {
  return {
    scene, quality: 'medium', manifest: { name: 'jangan-fields' }, heightAt: () => 0, waterLevelAt: () => null, skyState: { t: 0.5 },
    weatherState: { rain: 0 }, life: null, render: { post: null }, materials: null, worldClock: null,
    assets: { json: () => new Promise(r => setTimeout(() => r(structuredClone(JANGAN)), delayMs)) },
  } as unknown as World
}

describe('H11-HI-2: the town schedule on the character stage', () => {
  it('the stage (noFolk set on its first frame, town.json arriving after) builds the schedule once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const town = new TownLife({ scene, world: janganWorld(scene, 30) }, { assets: (s, d) => stubCrowdAssets(s, d) })
    cleanups.push(() => {
      town.dispose()
      scene.dispose()
      engine.dispose()
    })
    count.schedules = 0
    count.ms.length = 0
    // stage/host.ts, the stage's first frame: World.town.configure({ noFolk }) (STAGE_SPOT, STAGE_NO_FOLK_M)
    town.configure({ noFolk: { x: 101, z: -56, r: 12 } })
    for (let i = 0; i < 50 && !town.folk; i++) await new Promise(r => setTimeout(r, 20))
    expect(town.folk, 'the crowd was built').not.toBeNull()
    const total = count.ms.reduce((a, b) => a + b, 0)
    expect(count.schedules, `schedules built: ${count.ms.map(m => m.toFixed(0)).join(' + ')} ms = ${total.toFixed(0)} ms in one task`).toBe(1)
  })
})

/**
 * H-11 lens 7, Low (docs/WAVE_PLAN7.md §6.6; D23 binding): "Low stays as today for the town (no World.town; retail
 * placements only; the bed and the bell still play, **their count from the pure schedule**)", and TOWN_LIFE §6 / F10:
 * "On Low (no World.town) the count comes from the pure schedule's populationNear(x, z, r, nowS, solarT)".
 *
 * The Low guard itself holds at b22f6a9 (seams-classic, release-lowguard, abuse-w9f-lowguard, abuse-w10r-lowguard
 * green; World.town is null on Classic). What fails is the one Low behaviour the plan adds: on Low nothing ever plugs
 * the schedule's count into the town sound. world/features/town.ts `syncCounter` sets the counter only while a crowd is
 * there (`town.folkNear`), so on Low TownAudio falls back to `estimateFolkNear` (the districts' hour-band average): the
 * bed does not follow who is actually out at the player's spot, nor the appear alarm's empty streets.
 */
import { NullEngine, Scene, ArcRotateCamera, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sound = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('../src/world/features/town-sound.ts', async orig => ({
  ...(await orig<typeof import('../src/world/features/town-sound.ts')>()),
  activeTownAudio: () => null,
  setTownFolkCounter: (fn: unknown) => {
    sound.calls.push(fn)
  },
}))
import type { WorldFeatureContext } from '../src/world/features.ts'
import { townFeature } from '../src/world/features/town.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  sound.calls.length = 0
})

describe('H-11 Low: the town bed on Low counts the pure schedule (D23, TOWN_LIFE §6 F10)', () => {
  it('on the Classic path (World.town null) the town feature plugs a folk counter into the town sound', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const camera = new ArcRotateCamera('cam', -Math.PI / 2, 1.2, 10, Vector3.Zero(), scene)
    scene.activeCamera = camera
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const self = { id: 1, kind: 'player', pos: new Vector3(99, 0, -82), isDisposed: false, label: null }
    const ctx = {
      scene,
      camera,
      // Low: a loaded Jangan world on the Classic path has no town part
      world: () => ({ world: { town: null, timeOfDay: 0.5 }, base: '/', folder: 'jangan-fields' }),
      views: () => [self].values(),
      view: (id: number) => (id === 1 ? self : undefined),
      selfId: () => 1,
    } as unknown as WorldFeatureContext
    const feature = townFeature(ctx)
    cleanups.push(() => feature.dispose?.())
    for (let f = 0; f < 10; f++) feature.onFrame?.(f * 100, 0.1)
    // the schedule's populationNear (a function) must reach the town sound on Low; today nothing is ever set
    const last = sound.calls.at(-1)
    expect(typeof last, 'the folk counter set on Low').toBe('function')
  })
})

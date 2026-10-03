/**
 * W12-SB, seam S-NL (docs/WAVE_PLAN8.md §4.3; docs/WORLD_EDITOR.md §4.9, D13, F22): the editor's free light points in
 * `ambient.json` `points` join the night lights' point-light pick and the per-region splat (every preset, Low
 * included); `points` empty or absent = today's lights and splat; `setPoints` replaces them live.
 */
import { NullEngine, Observable, Scene, type BaseTexture } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldPlacement } from '../../convert/src/world/manifest.ts'
import type { AmbientParticle } from '../src/ambient-fx.ts'
import {
  NIGHT_LIGHT_KINDS,
  NIGHT_POINT_OWNER,
  NightLights,
  pointLight,
  readAmbientPoints,
  type NightLightPoint,
  type NightLightsHost,
} from '../src/night-lights.ts'
import type { RegionListener } from '../src/objects.ts'
import { RENDER_PRESETS, type NightLightQuality } from '../src/render/quality.ts'
import { SharedUniforms } from '../src/shader-chunks.ts'
import type { TerrainRegionUpdated } from '../src/terrain.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const flat = (h = 0) => new Float32Array(97 * 97).fill(h)
const lampRow = (efp: string, y = 3): AmbientParticle => ({ kind: 'ambient', efp, bone: null, position: [0, y, 0], night: true })
const plc = (x: number, y: number, z: number) => ({ position: [x, y, z], rotation: [0, 0, 0, 1], models: [3] }) as unknown as WorldPlacement

function rig(q: NightLightQuality, opts: { points?: NightLightPoint[]; json?: unknown } = {}) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  const bound = new Map<number, BaseTexture | null>()
  const listeners: RegionListener[] = []
  const steps: Array<(r: never) => void> = []
  const night = { night: 1 }
  const updated = new Observable<TerrainRegionUpdated>()
  const host: NightLightsHost = {
    scene,
    assets: { json: async <T>() => (opts.json ?? { models: {} }) as T },
    objects: { addRegionListener: l => (listeners.push(l), () => listeners.splice(listeners.indexOf(l), 1)) },
    terrain: {
      sharedUniforms: new SharedUniforms(),
      setRegionTexture: (id, _slot, tex) => (bound.set(id, tex), true),
      setDefine: () => {},
      onRegionDisposed: { add: () => null, remove: () => true },
      onRegionUpdated: updated,
    },
    scatter: { sharedUniforms: new SharedUniforms(), setDefine: () => {} },
    render: { quality: { nightLights: q }, weather: { rain: 0 } },
    skyState: night,
    addCommitStep: (_name, run) => (steps.push(run as (r: never) => void), () => {}),
  }
  return { scene, host, bound, listeners, steps, night, updated }
}

/** Attaches NightLights (from `ambient.json` when `index` is not given), places one lamp at (40, 0, −40), bakes two regions. */
async function scene(q: NightLightQuality, opts: { points?: NightLightPoint[]; json?: unknown; viaJson?: boolean } = {}) {
  const r = rig(q, opts)
  const index = new Map<number, AmbientParticle[]>([[3, [lampRow('map/cj_pal_lamp_orange.efp', 4)]]])
  const nl = new NightLights(r.host, opts.viaJson
    ? { autoUpdate: false, focus: () => ({ x: 40, y: 0, z: -40 }) }
    : { index, points: opts.points, autoUpdate: false, focus: () => ({ x: 40, y: 0, z: -40 }) })
  cleanups.push(() => nl.dispose())
  await nl.ready
  const lamp = { index: 3, source: 'res\\x\\cj_pal_lamp.bsr' } as never
  r.listeners[0]!.placed(-1, lamp, { index: 3, source: 'x', heightM: 4, isFoliage: false, kind: 'static' }, [], [plc(40, 0, -40)])
  r.steps[0]!({ region: { id: 5, origin: [0, 0, 0] }, terrain: { heights: flat() } } as never)
  r.steps[0]!({ region: { id: 6, origin: [192, 0, 0] }, terrain: { heights: flat() } } as never)
  return { ...r, nl }
}

describe('readAmbientPoints / pointLight', () => {
  it('reads the editor\'s rows (WorldEditLight), drops malformed ones; no list = none', () => {
    expect(readAmbientPoints({ format: 'x', models: {} })).toEqual([])
    expect(readAmbientPoints(null)).toEqual([])
    const rows = readAmbientPoints({
      points: [
        { id: 'l1', x: 1, y: 2, z: -3, kind: 'lantern', colour: [1, 0.5, 0.25], intensity: 1.5, radiusM: 9 },
        { x: 4, y: 0, z: 0, kind: 'fire' },
        { x: 'a', y: 0, z: 0 },
        { x: 1, y: 1, z: 1, kind: 'disco', colour: [1, 2] },
        null,
      ],
    })
    expect(rows).toEqual([
      { id: 'l1', x: 1, y: 2, z: -3, kind: 'lantern', colour: [1, 0.5, 0.25], intensity: 1.5, radiusM: 9 },
      { x: 4, y: 0, z: 0, kind: 'fire' },
      { x: 1, y: 1, z: 1 },
    ])
  })

  it('a point takes its kind\'s row with its own colour, intensity and reach (clamped); the point reach keeps the kind\'s ratio', () => {
    const fire = pointLight({ x: 1, y: 2, z: 3, kind: 'fire' })
    expect(fire.kind).toBe(NIGHT_LIGHT_KINDS.find(k => k.id === 'fire'))
    expect(fire.owner).toBe(NIGHT_POINT_OWNER)
    const lantern = pointLight({ x: 0, y: 0, z: 0, kind: 'lantern', colour: [0.2, 0.4, 1], intensity: 99, radiusM: 14 })
    expect(lantern.kind).toMatchObject({ id: 'lampOrange', color: [0.2, 0.4, 1], intensity: 4, radiusM: 14, pointRadiusM: 20, pointGain: 3 })
    expect(pointLight({ x: 0, y: 0, z: 0, radiusM: 500 }).kind.radiusM).toBe(30)
    expect(pointLight({ x: 0, y: 0, z: 0 }).kind.id).toBe('lampLight')
  })
})

describe('NightLights with free points (S-NL)', () => {
  for (const preset of ['low', 'medium'] as const) {
    it(`${preset}: points empty or absent = today's lights and splat`, async () => {
      const q = RENDER_PRESETS[preset].nightLights
      const a = await scene(q)
      const b = await scene(q, { points: [] })
      const c = await scene(q, { viaJson: true, json: { models: { 3: [lampRow('map/cj_pal_lamp_orange.efp', 4)] } } })
      for (const s of [b, c]) {
        expect(s.nl.lights.map(l => [l.x, l.y, l.z, l.kind.id, l.owner])).toEqual(a.nl.lights.map(l => [l.x, l.y, l.z, l.kind.id, l.owner]))
        expect(Buffer.from(s.nl.splatOf(5)!).equals(Buffer.from(a.nl.splatOf(5)!))).toBe(true)
        expect(s.nl.splatOf(6)).toBeNull()
        expect(s.nl.freePoints).toEqual([])
      }
    })
  }

  it('Low: a point from ambient.json lights the ground (the splat) of the region it stands in; no point light on Low', async () => {
    const s = await scene(RENDER_PRESETS.low.nightLights, { viaJson: true, json: { models: { 3: [lampRow('map/cj_pal_lamp_orange.efp', 4)] }, points: [{ id: 'p', x: 300, y: 3, z: -50, kind: 'lamp', colour: [1, 0.8, 0.5], intensity: 1, radiusM: 6 }] } })
    expect(s.nl.freePoints.length).toBe(1)
    expect(s.nl.points).toBeNull()
    const splat = s.nl.splatOf(6)!
    expect(splat).not.toBeNull()
    // region 6 starts at x 192: the point is at its texel (108, 50)
    const o = (50 * 192 + 108) * 4
    expect(splat[o]).toBeGreaterThan(0)
    expect(s.bound.get(6)).toBe(s.nl.textureOf(6))
  })

  it('Medium: a point joins the point-light pick; setPoints replaces the points live and re-bakes the regions they reach', async () => {
    const s = await scene(RENDER_PRESETS.medium.nightLights, { points: [{ x: 45, y: 3, z: -40, kind: 'fire' }] })
    expect(s.nl.lights.length).toBe(2)
    const pick = s.nl.points!
    s.nl.update()
    s.nl.update()
    const lit = pick.lights.filter(l => l.intensity > 0 || l.range > 0.01)
    expect(lit.length).toBeGreaterThanOrEqual(1)
    // the retail lamp 5 m away is not swallowed by the point (no merge with free points)
    expect(s.nl.lights.filter(l => l.owner !== NIGHT_POINT_OWNER).length).toBe(1)
    const before = Uint8Array.from(s.nl.splatOf(5)!)
    // move the point into region 6: both regions bake again (one per frame)
    expect(s.nl.setPoints([{ x: 300, y: 3, z: -50 }])).toBe(1)
    for (let i = 0; i < 3; i++) s.nl.update()
    expect(s.nl.splatOf(6)).not.toBeNull()
    const after = s.nl.splatOf(5)!
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(false)
    // and none: region 5 is back to the lamp alone, region 6 unlit
    s.nl.setPoints([])
    for (let i = 0; i < 3; i++) s.nl.update()
    const lampOnly = await scene(RENDER_PRESETS.medium.nightLights)
    expect(Buffer.from(s.nl.splatOf(5)!).equals(Buffer.from(lampOnly.nl.splatOf(5)!))).toBe(true)
    expect(s.nl.splatOf(6)).toBeNull()
  })

  it('a height edit of a baked region (TerrainRenderer.onRegionUpdated) bakes its splat again from the new ground', async () => {
    const s = await scene(RENDER_PRESETS.low.nightLights)
    const heights = flat()
    s.steps[0]!({ region: { id: 5, origin: [0, 0, 0] }, terrain: { heights } } as never)
    const before = Uint8Array.from(s.nl.splatOf(5)!)
    // a mound under the lamp (the lamp is 4 m up at (40, −40): region texel (40, 40))
    for (let gz = 15; gz <= 25; gz++) for (let gx = 15; gx <= 25; gx++) heights[gz * 97 + gx] = 3
    s.updated.notifyObservers({ id: 5, heights: 121, words: 0, blocks: 0, resized: false, neighbours: [], lightmap: false, ms: 0 })
    // a paint-only update or an unknown region queues nothing
    s.updated.notifyObservers({ id: 77, heights: 5, words: 0, blocks: 0, resized: false, neighbours: [], lightmap: false, ms: 0 })
    s.nl.update()
    expect(Buffer.from(s.nl.splatOf(5)!).equals(Buffer.from(before))).toBe(false)
  })
})

/**
 * WE-R (docs/WORLD_EDITOR.md §4.10, D14, D31; docs/WAVE_PLAN8.md D13, §5.3, lane WE-R): the sound zones at runtime.
 * - the shapes: circle and polygon distance, the edge fade, day / night / always on the town's night hours;
 * - the file: a list or `{ zones }`, invalid rows skipped with one warning;
 * - the voice cap: ≤ 2 zone loops, nearest first; ≤ 1 inside the town box (beside wave 11's town loops); one voice per
 *   sound; a zone left behind fades out; gain changes ramp; the voice is heard from the zone's side at the zone's gain;
 * - ≤ 0.05 ms of main thread a frame;
 * - the GameAudio adapter (a file or a cue of the index, the ambient bus) and the world feature (the export's
 *   `sound-zones.json`, the server clock's night, silent without one);
 * - Low ignores the grass masks (no field, no mask fetch); the light points need no game code (world-render reads them).
 */
import { NullEngine, Scene } from '@babylonjs/core'
import { SOUND_INDEX_FORMAT, type SoundIndex, type WorldEditZone } from '@sro/shared'
import { Assets, WorldScatter, type RegionData } from '@sro/world-render'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudioBackend, SoundBuffer, StartOptions, Vec3Like, VoiceHandle } from '../src/audio/backend.ts'
import { PANNER } from '../src/audio/backend.ts'
import { SoundBank } from '../src/audio/bank.ts'
import { GameAudio } from '../src/audio/index.ts'
import { AudioSettings } from '../src/audio/settings.ts'
import {
  SoundZones, ZONE_FADE_S, ZONE_MAX_IN_TOWN, ZONE_MAX_LOOPS, ZONE_TICK_S, dbToGain, readSoundZones, zoneDistance, zoneSounds, zoneWeight,
  type SoundZonesInput,
} from '../src/audio/zones.ts'
import { effectiveGraphics, grassQualityFor, normalizeSettings } from '../src/settings.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { SOUND_ZONES_FILE, soundZonesFeature, soundZonesOutput } from '../src/world/features/sound-zones.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const NOON = 0.5
const MIDNIGHT = 0

function circle(id: string, x: number, z: number, r: number, o: Partial<WorldEditZone> = {}): WorldEditZone {
  return { id, name: id, shape: { circle: { x, z, r } }, sound: `env/${id}`, gainDb: 0, fadeM: 10, when: 'always', ...o }
}

interface Loop {
  file: string
  pos: Vec3Like
  gain: number
  fadeS: number
  stopped: number | null
  gains: number[]
  moves: number
}

function fakeOut(opts: { refuse?: Set<string> } = {}) {
  const loops: Loop[] = []
  const out = {
    file: (s: string) => (s.startsWith('env/') ? s : null),
    loopAt: (file: string, o: { pos: Vec3Like; gain: number; fadeS: number }): VoiceHandle | null => {
      if (opts.refuse?.has(file)) return null
      const l: Loop = { file, pos: { ...o.pos }, gain: o.gain, fadeS: o.fadeS, stopped: null, gains: [], moves: 0 }
      loops.push(l)
      return {
        stop: s => {
          l.stopped = s ?? 0
        },
        setPosition: p => {
          l.pos = { ...p }
          l.moves++
        },
        setGain: g => {
          l.gain = g
          l.gains.push(g)
        },
      }
    },
  }
  const live = () => loops.filter(l => l.stopped === null)
  return { out, loops, live }
}

function at(x: number, z: number, o: Partial<SoundZonesInput> = {}): SoundZonesInput {
  return { x, y: 0, z, solarT: NOON, inTown: false, dt: ZONE_TICK_S, ...o }
}

describe('the zone shapes', () => {
  it('circle and polygon distance: 0 inside, the nearest outline point outside', () => {
    const c = { circle: { x: 10, z: 0, r: 5 }, poly: null }
    expect(zoneDistance(c, 12, 1).d).toBe(0)
    const o = zoneDistance(c, 25, 0)
    expect(o.d).toBeCloseTo(10)
    expect([o.x, o.z]).toEqual([15, 0])
    // an L-shaped polygon: its notch is outside
    const poly = { circle: null, poly: [0, 0, 20, 0, 20, 10, 10, 10, 10, 20, 0, 20] }
    expect(zoneDistance(poly, 5, 5).d).toBe(0)
    expect(zoneDistance(poly, 5, 15).d).toBe(0)
    const notch = zoneDistance(poly, 15, 15)
    expect(notch.d).toBeCloseTo(5)
    const east = zoneDistance(poly, 30, 5)
    expect(east.d).toBeCloseTo(10)
    expect([east.x, east.z]).toEqual([20, 5])
  })

  it('the edge fade: 1 inside, a smoothstep down to 0 at fadeM, nothing beyond; fade 0 = inside only', () => {
    expect(zoneWeight(0, 10)).toBe(1)
    expect(zoneWeight(5, 10)).toBeCloseTo(0.5)
    expect(zoneWeight(2, 10)).toBeGreaterThan(zoneWeight(4, 10))
    expect(zoneWeight(10, 10)).toBe(0)
    expect(zoneWeight(30, 10)).toBe(0)
    expect(zoneWeight(0, 0)).toBe(1)
    expect(zoneWeight(0.1, 0)).toBe(0)
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3)
  })

  it('day, night, always on the town\'s night hours (20:00–05:00)', () => {
    expect(zoneSounds('always', MIDNIGHT)).toBe(true)
    expect(zoneSounds('day', NOON)).toBe(true)
    expect(zoneSounds('day', MIDNIGHT)).toBe(false)
    expect(zoneSounds('night', MIDNIGHT)).toBe(true)
    expect(zoneSounds('night', 21 / 24)).toBe(true)
    expect(zoneSounds('night', 6 / 24)).toBe(false)
  })
})

describe('the zone file', () => {
  it('reads a list or { zones }; invalid or duplicate rows are skipped with one warning; anything else is none', () => {
    const a = circle('a', 0, 0, 5)
    const b = { id: 'b', name: 'b', shape: { poly: [[0, 0], [1, 0], [0, 1]] }, sound: 'env/b', gainDb: -3, fadeM: 0, when: 'night' }
    expect(readSoundZones([a, b])).toEqual([a, b])
    expect(readSoundZones({ format: 'x', zones: [a] })).toEqual([a])
    const warn = vi.fn()
    expect(readSoundZones([a, { ...a }, { ...b, id: 'c', gainDb: 99 }, { id: 'd' }, b], warn)).toEqual([a, b])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('3 zone(s)')
    for (const bad of [null, 7, 'x', {}, { zones: 3 }]) expect(readSoundZones(bad)).toEqual([])
  })
})

describe('SoundZones: the voice cap and the mix', () => {
  it('≤ 2 zone loops outside town, nearest first; ≤ 1 inside the town box', () => {
    const { out, live } = fakeOut()
    const z = new SoundZones(out, { rng: () => 0 })
    z.setZones([circle('far', 0, 0, 30, { fadeM: 60 }), circle('mid', 20, 0, 12, { fadeM: 30 }), circle('here', 40, 0, 10)])
    z.update(at(40, 0))
    expect(ZONE_MAX_LOOPS).toBe(2)
    expect(ZONE_MAX_IN_TOWN).toBe(1)
    expect(live().map(l => l.file)).toEqual(['env/here', 'env/mid'])
    expect(z.active.map(a => a.id)).toEqual(['here', 'mid'])
    // inside the town box: only the nearest stays, the other fades out
    z.update(at(40, 0, { inTown: true }))
    expect(live().map(l => l.file)).toEqual(['env/here'])
    expect(z.loops).toBe(1)
    // out again: the second comes back
    z.update(at(40, 0))
    expect(live().map(l => l.file).sort()).toEqual(['env/here', 'env/mid'])
  })

  it('the cap holds over a walk through many overlapping zones, in town and out', () => {
    const { out, live } = fakeOut()
    const z = new SoundZones(out)
    z.setZones(Array.from({ length: 12 }, (_, i) => circle(`z${i}`, (i % 4) * 15, Math.floor(i / 4) * 15, 12, { fadeM: 20 })))
    for (let s = 0; s < 400; s++) {
      const inTown = s % 50 < 20
      z.update(at(-20 + s * 0.25, -10 + s * 0.15, { inTown, dt: 1 / 60 }))
      expect(live().length).toBeLessThanOrEqual(inTown ? 1 : 2)
      expect(z.loops).toBe(live().length)
    }
  })

  it('two zones of one sound share one voice at the louder gain', () => {
    const { out, live } = fakeOut()
    const z = new SoundZones(out)
    z.setZones([circle('a', 0, 0, 10, { sound: 'env/birds', gainDb: -12 }), circle('b', 5, 0, 10, { sound: 'env/birds', gainDb: 0 }), circle('c', 0, 5, 10)])
    z.update(at(2, 2))
    expect(live().map(l => l.file).sort()).toEqual(['env/birds', 'env/c'])
    expect(live().find(l => l.file === 'env/birds')!.gain).toBeCloseTo(1)
  })

  it('the gain follows the edge fade with ramps; a zone left behind fades out over ZONE_FADE_S', () => {
    const { out, loops, live } = fakeOut()
    const z = new SoundZones(out)
    z.setZones([circle('a', 0, 0, 10, { gainDb: -6, fadeM: 20 })])
    z.update(at(25, 0))
    expect(loops[0]!.gain).toBeCloseTo(dbToGain(-6) * zoneWeight(15, 20))
    expect(loops[0]!.fadeS).toBe(ZONE_FADE_S)
    z.update(at(15, 0))
    expect(loops[0]!.gains.at(-1)).toBeCloseTo(dbToGain(-6) * zoneWeight(5, 20))
    z.update(at(5, 0))
    expect(loops[0]!.gain).toBeCloseTo(dbToGain(-6))
    // within a tick the choice holds; the voice only moves with the listener
    const n = loops[0]!.gains.length
    z.update(at(6, 0, { dt: 0.01 }))
    expect(loops[0]!.gains.length).toBe(n)
    z.update(at(40, 0))
    expect(live()).toEqual([])
    expect(loops[0]!.stopped).toBe(ZONE_FADE_S)
    expect(loops.length).toBe(1)
  })

  it('the voice is heard from the zone\'s side within the panner\'s reference distance (inside: at the listener)', () => {
    const { out, loops } = fakeOut()
    const z = new SoundZones(out)
    z.setZones([circle('a', 0, 0, 10, { fadeM: 30 })])
    z.update(at(30, 0))
    const p = loops[0]!.pos
    expect(p.x).toBeLessThan(30)
    expect(Math.hypot(p.x - 30, p.z)).toBeLessThanOrEqual(PANNER.refDistance)
    expect(p.y).toBeCloseTo(1.6)
    z.update(at(3, 4))
    expect(loops[0]!.pos).toEqual({ x: 3, y: 1.6, z: 4 })
  })

  it('night zones sound at night only (the server clock wins over the sky\'s frozen noon)', () => {
    const { out, live } = fakeOut()
    const z = new SoundZones(out)
    z.setZones([circle('crickets', 0, 0, 20, { when: 'night' }), circle('birds', 0, 0, 20, { when: 'day' })])
    z.update(at(0, 0, { solarT: NOON }))
    expect(live().map(l => l.file)).toEqual(['env/birds'])
    z.update(at(0, 0, { solarT: NOON, clockT: 22 / 24 }))
    expect(live().map(l => l.file)).toEqual(['env/crickets'])
  })

  it('a voice that cannot start yet is asked again; an unknown sound plays nothing; stop() fades all', () => {
    const refuse = new Set(['env/a'])
    const { out, loops, live } = fakeOut({ refuse })
    const z = new SoundZones(out)
    z.setZones([circle('a', 0, 0, 10), circle('x', 0, 0, 10, { sound: 'nope' })])
    z.update(at(0, 0))
    expect(loops).toEqual([])
    refuse.clear()
    z.update(at(0, 0))
    expect(live().map(l => l.file)).toEqual(['env/a'])
    z.stop()
    expect(live()).toEqual([])
    expect(z.loops).toBe(0)
  })

  it('≤ 0.05 ms of main thread a frame (48 zones, a walk at 60 fps)', () => {
    const { out } = fakeOut()
    const z = new SoundZones(out)
    const zones: WorldEditZone[] = []
    for (let i = 0; i < 48; i++) {
      const x = (i % 8) * 60, zz = Math.floor(i / 8) * 60
      zones.push(i % 2
        ? circle(`c${i}`, x, zz, 20, { fadeM: 25 })
        : { id: `p${i}`, name: '', shape: { poly: Array.from({ length: 12 }, (_, k) => [x + 20 * Math.cos(k / 2), zz + 20 * Math.sin(k / 2)] as [number, number]) }, sound: `env/p${i}`, gainDb: 0, fadeM: 25, when: 'always' })
    }
    z.setZones(zones)
    const frames = 6000
    for (let s = 0; s < 600; s++) z.update(at(s * 0.08, s * 0.05, { dt: 1 / 60 })) // warm up
    const t0 = performance.now()
    for (let s = 0; s < frames; s++) z.update(at(s * 0.08, s * 0.05, { dt: 1 / 60, inTown: s % 900 < 300 }))
    const perFrame = (performance.now() - t0) / frames
    expect(perFrame).toBeLessThan(0.05)
  })
})

// ---- the GameAudio adapter and the world feature ------------------------------------------------------------------

class FakeBackend implements AudioBackend {
  readonly started: StartOptions[] = []
  stopped = 0
  ready = true
  now(): number {
    return 0
  }
  async decode(): Promise<SoundBuffer> {
    return { duration: 2, bytes: 8 }
  }
  start(_b: SoundBuffer, opts: StartOptions) {
    this.started.push(opts)
    return {
      stop: () => {
        this.stopped++
        opts.onEnded?.()
      },
      setPosition: () => {},
      setGain: () => {},
    }
  }
  setBusGain(): void {}
  setListener(): void {}
  suspend(): void {}
  resume(): void {}
}

async function gameAudio() {
  const ids = ['env/stream', 'town/bed_calm']
  const file = (id: string) => ({ url: `sound/${id}.ogg`, ms: 1000, channels: 1 as const, bytes: 10 })
  const index = {
    format: SOUND_INDEX_FORMAT,
    files: Object.fromEntries(ids.map(id => [id, file(id)])),
    cues: { 'town.bed.calm': { files: ['town/missing', 'town/bed_calm'], gain: 1, category: 'ambient' } },
    hits: {}, skills: {}, voices: {}, mobs: {}, models: {}, areas: {}, steps: { walk: {}, run: {} },
  } as unknown as SoundIndex
  const backend = new FakeBackend()
  const audio = new GameAudio({
    backend,
    settings: new AudioSettings(null),
    bank: new SoundBank({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(8) }), decode: async () => ({ duration: 2, bytes: 8 }) }),
    rng: () => 0.5,
  })
  audio.bank.setIndex(index)
  await Promise.all(ids.map(id => audio.bank.load(id)))
  audio.setListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
  return { audio, backend }
}

describe('the GameAudio adapter', () => {
  it('a zone sound is a file of the index or a cue\'s first present file; loops go to the ambient bus at a position', async () => {
    const { audio, backend } = await gameAudio()
    const out = soundZonesOutput(audio)
    expect(out.file('env/stream')).toBe('env/stream')
    expect(out.file('town.bed.calm')).toBe('town/bed_calm')
    expect(out.file('env/none')).toBeNull()
    expect(out.loopAt('env/stream', { pos: { x: 1, y: 1.6, z: 0 }, gain: 0.5, fadeS: ZONE_FADE_S })).not.toBeNull()
    expect(backend.started.map(s => [s.bus, !!s.loop, s.gain, !!s.pos])).toEqual([['ambient', true, 0.5, true]])
  })
})

describe('the world feature', () => {
  it('is silent without sound', () => {
    expect(soundZonesFeature({} as WorldFeatureContext)).toEqual({})
  })

  it('loads the export\'s sound-zones.json beside town.json and plays the zone the player stands in; leaving the world stops it', async () => {
    const { audio, backend } = await gameAudio()
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return { ok: true, json: async () => ({ zones: [circle('stream', 0, 0, 20, { sound: 'env/stream' })] }) }
    })
    let ground: { world: { timeOfDay: number }; base: string; folder: string } | null = { world: { timeOfDay: NOON }, base: '/out-opt/', folder: 'jangan-fields' }
    const self = { root: { position: { x: 3, y: 0, z: 4 } } }
    const f = soundZonesFeature({ app: { audio }, world: () => ground, selfId: () => 1, view: () => self } as unknown as WorldFeatureContext)
    cleanups.push(() => f.dispose?.())
    f.onFrame!(0, 1 / 60)
    expect(urls).toEqual([`/out-opt/world/jangan-fields/${SOUND_ZONES_FILE}`])
    await new Promise(r => setTimeout(r, 0))
    f.onFrame!(16, 1 / 60)
    expect(backend.started.map(s => [s.bus, !!s.loop])).toEqual([['ambient', true]])
    expect(backend.stopped).toBe(0)
    ground = null
    f.onFrame!(32, 1 / 60)
    expect(backend.stopped).toBe(1)
  })

  it('the console preview plays given zones; an empty set stops the voices on the next frame', async () => {
    const { audio, backend } = await gameAudio()
    vi.stubGlobal('fetch', async () => ({ ok: false, json: async () => null }))
    const win: { __sroSoundZones?: { preview(l: WorldEditZone[] | null): void; loops: number } } = {}
    vi.stubGlobal('window', win)
    const f = soundZonesFeature({ app: { audio }, world: () => ({ world: { timeOfDay: NOON }, base: '/out/', folder: 'jangan-fields' }), selfId: () => 1, view: () => ({ root: { position: { x: 0, y: 0, z: 0 } } }) } as unknown as WorldFeatureContext)
    cleanups.push(() => f.dispose?.())
    f.onFrame!(0, 1 / 60)
    await new Promise(r => setTimeout(r, 0))
    win.__sroSoundZones!.preview([circle('p', 0, 0, 30, { sound: 'env/stream' })])
    f.onFrame!(16, 1 / 60)
    expect(win.__sroSoundZones!.loops).toBe(1)
    win.__sroSoundZones!.preview(null)
    f.onFrame!(32, 1 / 60)
    expect(win.__sroSoundZones!.loops).toBe(0)
    expect(backend.stopped).toBe(1)
    f.dispose!()
    expect(win.__sroSoundZones).toBeUndefined()
  })

  it('no file (404) is no zone, quietly', async () => {
    const { audio, backend } = await gameAudio()
    vi.stubGlobal('fetch', async () => ({ ok: false, json: async () => null }))
    const warn = vi.spyOn(console, 'warn')
    const f = soundZonesFeature({ app: { audio }, world: () => ({ world: { timeOfDay: NOON }, base: '/out/', folder: 'jangan-fields' }), selfId: () => 1, view: () => ({ root: { position: { x: 0, y: 0, z: 0 } } }) } as unknown as WorldFeatureContext)
    cleanups.push(() => f.dispose?.())
    f.onFrame!(0, 1 / 60)
    await new Promise(r => setTimeout(r, 0))
    f.onFrame!(16, 1 / 60)
    expect(backend.started).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})

// ---- Low ignores the grass masks ---------------------------------------------------------------------------------

describe('Low ignores the grass masks', () => {
  it('Low draws the retail scatter (no field), and a region that lists a mask fetches nothing', async () => {
    for (const graphics of [{ preset: 'low' }, { preset: 'low', sky: 'classic', weather: 'off' }]) {
      const low = normalizeSettings({ graphics })
      const e = effectiveGraphics(low, { rollout: 'on' })
      expect(e.grassStyle).toBe('retail')
      expect(grassQualityFor(low, e).grassStyle).toBe('retail')
    }
    const GRID = 97
    const n = GRID * GRID
    const normals = new Int8Array(n * 4)
    for (let i = 0; i < n; i++) normals.set([0, 127, 0, 0], i * 4)
    const blocks = Array.from({ length: 36 }, (_, k) => ({ bx: k % 6, bz: Math.floor(k / 6), flag: 0, environmentId: 0, water: null }))
    const id = (97 << 8) | 168
    const region = { id, x: id & 0xff, z: id >> 8, origin: [0, 0, 0], blocks, grassMask: 'world/jangan-fields/grass/168_97.png' }
    const data = { region, terrain: { heights: new Float32Array(n).fill(10), normals, textures: new Uint16Array(n).fill(1) }, navmesh: null } as unknown as RegionData
    const fetched: string[] = []
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const field = vi.fn(() => null)
    const s = new WorldScatter({
      scene,
      assets: new Assets('http://mem.test/', {
        bytes: async (u: string) => {
          fetched.push(u)
          throw new Error('no assets')
        },
        decodeImage: async () => ({ width: 1, height: 1, data: new Uint8Array(4) }),
      }),
      manifest: { tiles: [{ id: 1, typeName: 'Grass', source: 'c_grass_fld_03.ddj', file: 'tiles/g.webp', width: 4, height: 4, category: '' }], models: [] },
    } as unknown as ConstructorParameters<typeof WorldScatter>[0], { level: 'medium', retail: false, now: () => 0, style: 'retail', field })
    cleanups.push(() => {
      s.dispose()
      scene.dispose()
      engine.dispose()
    })
    s.addRegion(data)
    for (let i = 0; i < 20; i++) s.update({ x: 20, y: 15, z: -20 })
    await s.ready()
    expect(s.style).toBe('retail')
    expect(field).not.toHaveBeenCalled()
    expect(fetched.filter(u => u.includes('grass/'))).toEqual([])
  })
})

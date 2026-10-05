/**
 * docs/SOUND.md §10.5 (a user report): with the town crowd off (Options → Graphics → Town life: Off, switched live
 * or at entry, and Low, which has no crowd) the townsfolk could still be heard talking: the bed (granulated voices)
 * followed the pure schedule's count and the built-in stall murmurs played. The folk's voices now follow the drawn
 * crowd; the bell, the fountain, the smith and the animals stay.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SOUND_INDEX_FORMAT, type SoundIndex } from '@sro/shared'
import type { AudioBackend, SoundBuffer, StartOptions, Vec3Like, VoiceHandle } from '../src/audio/backend.ts'
import { SoundBank } from '../src/audio/bank.ts'
import { GameAudio } from '../src/audio/index.ts'
import { AudioSettings } from '../src/audio/settings.ts'
import { JANGAN_SOUND_SPOTS, TownAudio, type TownAudioOutput } from '../src/audio/town.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { activeTownAudio, setTownCrowd, townSoundFeature } from '../src/world/features/town-sound.ts'

const H = 1 / 24

function fakeOut() {
  const loops: { file: string; stopped: boolean }[] = []
  const shots: string[] = []
  const out: TownAudioOutput = {
    files: c => (c === 'town.dog' ? [] : [`file:${c}`]),
    ms: f => (f.includes('bell') ? 10_000 : 1000),
    loopAt: file => {
      const l = { file, stopped: false }
      loops.push(l)
      return { stop: () => void (l.stopped = true), setPosition: () => {}, setGain: () => {} } as VoiceHandle
    },
    oneShot: file => (shots.push(file), true),
  }
  const live = (cue: string) => loops.filter(l => l.file === `file:${cue}` && !l.stopped).length
  return { out, loops, shots, live }
}

/** `sec` seconds at 20 Hz from server second `from` at `p`, the solar time from t0 running `daysPerS` per second. */
function run(town: TownAudio, p: Vec3Like, sec: number, o: { from?: number; t0?: number; daysPerS?: number } = {}) {
  const dt = 0.05
  const from = o.from ?? 1_800_000_000
  for (let i = 0; i <= sec / dt; i++) {
    town.update({ x: p.x, y: 0, z: p.z, nowS: from + i * dt, solarT: ((o.t0 ?? 0.5) + i * dt * (o.daysPerS ?? 0)) % 1, inTown: true, dt })
  }
}

const PLAZA = { x: 97, y: 0, z: -110 }
const STALL = JANGAN_SOUND_SPOTS.stalls[0]!

describe('TownAudio.setCrowd', () => {
  it('without a drawn crowd the plaza at noon has no bed and no vendor murmurs; the bell still rings', () => {
    const f = fakeOut()
    const town = new TownAudio(f.out, { rng: () => 0.5 })
    town.setCrowd(false)
    run(town, PLAZA, 5)
    expect(town.folk).toBeGreaterThan(5) // the schedule still counts the plaza ...
    expect(town.bed).toEqual({ calm: 0, busy: 0 }) // ... but nobody is heard
    expect(f.live('town.bed.calm') + f.live('town.bed.busy')).toBe(0)
    // ten minutes by a stall in trading hours: no murmur; a vendor bubble (none are drawn) would not sound either
    run(town, STALL, 600, { from: 1_800_000_100 })
    expect(f.shots.filter(s => s === 'file:town.murmur')).toEqual([])
    expect(town.vendorCall(STALL)).toBe(false)
    // an hour crossing: the temple bell is not the folk
    run(town, PLAZA, 40, { from: 1_800_001_000, t0: 12.99 * H, daysPerS: H / 20 })
    expect(f.shots.filter(s => s === 'file:town.bell').length).toBeGreaterThan(0)
  })

  it('with the crowd drawn the same plaza talks; switching it off live fades the bed out', () => {
    const f = fakeOut()
    const town = new TownAudio(f.out, { rng: () => 0.5 })
    town.setCrowd(true)
    run(town, PLAZA, 5)
    expect(f.live('town.bed.calm') + f.live('town.bed.busy')).toBeGreaterThan(0)
    run(town, STALL, 600, { from: 1_800_000_100 })
    expect(f.shots.filter(s => s === 'file:town.murmur').length).toBeGreaterThan(0)
    town.setCrowd(false)
    run(town, PLAZA, 2, { from: 1_800_001_000 })
    expect(f.live('town.bed.calm') + f.live('town.bed.busy')).toBe(0)
    expect(town.bed).toEqual({ calm: 0, busy: 0 })
  })
})

// ---- the world feature: Low (no town feature), and the town feature's live switch -----------------------------

class FakeBackend implements AudioBackend {
  readonly started: (StartOptions & { stopped?: boolean })[] = []
  ready = true
  now(): number {
    return 0
  }
  async decode(): Promise<SoundBuffer> {
    return { duration: 20, bytes: 8 }
  }
  start(_b: SoundBuffer, opts: StartOptions) {
    const v: StartOptions & { stopped?: boolean } = { ...opts }
    this.started.push(v)
    return { stop: () => ((v.stopped = true), opts.onEnded?.()), setPosition: () => {}, setGain: () => {} }
  }
  setBusGain(): void {}
  setListener(): void {}
  suspend(): void {}
  resume(): void {}
}

const FILES = ['town/bed_calm', 'town/bed_busy', 'town/murmur_1']
function index(): SoundIndex {
  return {
    format: SOUND_INDEX_FORMAT,
    files: Object.fromEntries(FILES.map(id => [id, { url: `sound/${id}.ogg`, ms: 20_000, channels: 1, bytes: 10 }])),
    cues: {
      'town.bed.calm': { files: ['town/bed_calm'], gain: 1, category: 'ambient' },
      'town.bed.busy': { files: ['town/bed_busy'], gain: 1, category: 'ambient' },
      'town.murmur': { files: ['town/murmur_1'], gain: 1, category: 'ambient' },
    },
    hits: {}, skills: {}, voices: {}, mobs: {}, models: {}, areas: {}, steps: { walk: {}, run: {} },
  } as unknown as SoundIndex
}

async function feature() {
  const backend = new FakeBackend()
  const audio = new GameAudio({
    backend,
    settings: new AudioSettings(null),
    bank: new SoundBank({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(8) }), decode: async () => ({ duration: 20, bytes: 8 }) }),
    rng: () => 0.5,
  })
  audio.bank.setIndex(index())
  await Promise.all(FILES.map(id => audio.bank.load(id)))
  const ctx = {
    app: { audio },
    world: () => ({ world: { timeOfDay: 0.5, life: null }, base: null, folder: null }),
    selfId: () => 1,
    view: () => ({ root: { position: PLAZA } }),
  } as unknown as WorldFeatureContext
  const f = townSoundFeature(ctx)
  f.onTownChange?.(true)
  let nowS = 1_800_000_000
  const frames = (sec: number) => {
    for (let i = 0; i < sec * 10; i++) f.onFrame?.((nowS += 0.1) * 1000, 0.1)
  }
  const bedVoices = () => backend.started.filter(s => s.loop && !s.stopped).length
  return { f, frames, bedVoices }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
  setTownCrowd(false)
})

describe('the town sound feature', () => {
  it('on Low (no crowd ever reports) the plaza is without talk', async () => {
    const { f, frames, bedVoices } = await feature()
    cleanups.push(() => f.dispose?.())
    frames(5)
    expect(activeTownAudio()!.folk).toBeGreaterThan(0)
    expect(bedVoices()).toBe(0)
  })

  it('the crowd drawn: the bed plays; Town life Off live: it fades out, and stays out', async () => {
    const { f, frames, bedVoices } = await feature()
    cleanups.push(() => f.dispose?.())
    setTownCrowd(true)
    frames(5)
    expect(bedVoices()).toBeGreaterThan(0)
    setTownCrowd(false)
    frames(5)
    expect(bedVoices()).toBe(0)
  })

  it('a crowd reported before the town sound starts is kept (the features start in either order)', async () => {
    setTownCrowd(true)
    const { f, frames, bedVoices } = await feature()
    cleanups.push(() => f.dispose?.())
    frames(5)
    expect(bedVoices()).toBeGreaterThan(0)
  })
})

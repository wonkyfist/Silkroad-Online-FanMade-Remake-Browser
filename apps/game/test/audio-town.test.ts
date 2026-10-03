/**
 * TL-S (docs/TOWN_LIFE.md §6; docs/WAVE_PLAN7.md §6.1): the town's sound.
 * - the bell strikes once per game hour, three strokes at 06:00 and 18:00, never on a clock jump; heard town-wide
 *   from the tower's direction;
 * - the bed's gain is monotone in the folk near, silent at night below 5, cross-faded; on Low (no town part) it follows
 *   the schedule's hour curve through the district estimate or a plugged counter;
 * - voice limits: ≤ 3 town one-shots at a time (the bell may add one), ≤ 3 loops; culls per sound;
 * - the built-in spots are a pure function of the server clock (two clients hear the same hammer);
 * - night in town mutes the day one-shots and plays the night layers; the GameAudio adapter routes everything to the
 *   ambient bus.
 */
import { describe, expect, it } from 'vitest'
import { SOUND_INDEX_FORMAT, type AmbientLayer, type SoundIndex } from '@sro/shared'
import type { AudioBackend, SoundBuffer, StartOptions, Vec3Like, VoiceHandle } from '../src/audio/backend.ts'
import { SoundBank } from '../src/audio/bank.ts'
import { GameAudio } from '../src/audio/index.ts'
import { AudioSettings } from '../src/audio/settings.ts'
import {
  BED_FULL_FOLK, BED_GAIN, BELL_RANGE_M, BELL_STROKE_S, JANGAN_POPULATION, JANGAN_SOUND_SPOTS, TOWN_ONESHOT_CAP, TownAudio, bedGains,
  bellGain, bellStrokes, circleOverlap, estimateFolkNear, hammerEvents, hourStruck, pannerDistanceFor, populationShare, spotEvents,
  townSoundFromFile, type TownAudioInput, type TownAudioOutput,
} from '../src/audio/town.ts'
import { townAudioOutput } from '../src/world/features/town-sound.ts'

const H = 1 / 24

interface Loop {
  file: string
  pos: Vec3Like
  gain: number
  stopped: boolean
  gains: number[]
}
interface Shot {
  file: string
  pos: Vec3Like
  gain: number
  unculled: boolean
  t: number
}

/** Every cue has files; one-shots last 1 s (the bell 10 s). */
function fakeOut(opts: { cues?: Record<string, string[]>; night?: AmbientLayer[] } = {}) {
  const cues: Record<string, string[]> = opts.cues ?? {
    'town.bell': ['env/bell towel 3'],
    'town.bed.calm': ['town/bed_calm'],
    'town.bed.busy': ['town/bed_busy'],
    'town.fountain': ['town/fountain'],
    'town.murmur': ['town/murmur_1'],
    'town.hammer': ['town/hammer_1'],
    'town.horse.snort': ['cos/cos_horse_stand'],
    'town.chicken': ['town/chicken_1'],
    'town.dog.pitched': ['town/dog_1'],
    'town.dog': ['cos/cos_wolf_01_stand1'],
    'town.cat': ['cos/cos_cat_stand1'],
    'town.wings': ['town/wings_1'],
  }
  const loops: Loop[] = []
  const shots: Shot[] = []
  const muted: boolean[] = []
  let now = 0
  const out: TownAudioOutput = {
    files: c => cues[c] ?? [],
    ms: f => (f.startsWith('env/bell') ? 10_000 : 1000),
    loopAt: (file, o) => {
      const l: Loop = { file, pos: o.pos, gain: o.gain, stopped: false, gains: [o.gain] }
      loops.push(l)
      const h: VoiceHandle = { stop: () => void (l.stopped = true), setPosition: () => {}, setGain: g => void l.gains.push(g) }
      return h
    },
    oneShot: (file, o) => {
      shots.push({ file, pos: o.pos, gain: o.gain, unculled: !!o.unculled, t: now })
      return true
    },
    nightLayers: () => opts.night ?? [],
    muteDayLayers: on => void muted.push(on),
  }
  return { out, loops, shots, muted, setNow: (t: number) => void (now = t) }
}

/** Runs `town` from server second `from` for `sec` seconds at 20 Hz, the solar time running `daysPerS` per second. */
function run(town: TownAudio, f: ReturnType<typeof fakeOut>, at: Partial<TownAudioInput> & { from?: number; sec: number; t0?: number; daysPerS?: number }) {
  const dt = 0.05
  const from = at.from ?? 1_800_000_000
  for (let i = 0; i <= at.sec / dt; i++) {
    const nowS = from + i * dt
    f.setNow(nowS)
    town.update({ x: at.x ?? 97, y: at.y ?? 0, z: at.z ?? -110, nowS, solarT: ((at.t0 ?? 0.5) + i * dt * (at.daysPerS ?? 0)) % 1, inTown: at.inTown ?? true, dt })
  }
}

describe('the hourly bell', () => {
  it('strikes once per game hour and three times at 06:00 and 18:00, never on a jump', () => {
    expect(hourStruck(5.99 * H, 6.01 * H)).toBe(6)
    expect(hourStruck(23.99 * H, 0.01 * H)).toBe(0)
    expect(hourStruck(6.01 * H, 6.02 * H)).toBeNull()
    expect(hourStruck(6.5 * H, 5.5 * H)).toBeNull() // backwards
    expect(hourStruck(2 * H, 9 * H)).toBeNull() // a GM /time jump
    expect([...Array(24).keys()].map(bellStrokes)).toEqual([...Array(24).keys()].map(h => (h === 6 || h === 18 ? 3 : 1)))
  })

  it('rings 24 times plus 4 extra strokes over a whole day', () => {
    const f = fakeOut()
    const town = new TownAudio(f.out, { rng: () => 0.5 })
    // A day in 2,400 s (an hour every 100 s), far from every other spot so only the bell sounds.
    run(town, f, { x: 200, z: -420, sec: 2_400, t0: 0.001, daysPerS: 1 / 2_400, inTown: false })
    const bells = f.shots.filter(s => s.file === 'env/bell towel 3')
    expect(bells).toHaveLength(28)
    expect(town.stats().bell).toBe(28)
    // the three 06:00 strokes BELL_STROKE_S apart
    const six = bells.filter(b => Math.abs(b.t - bells[6]!.t) < 10)
    expect(six).toHaveLength(3)
    expect(six[1]!.t - six[0]!.t).toBeCloseTo(BELL_STROKE_S, 0)
    expect(bells.every(b => b.unculled)).toBe(true)
  })

  it('is heard over the town from the tower, with a long roll-off, and not beyond its range', () => {
    expect(bellGain(0)).toBe(1)
    expect(bellGain(250)).toBeGreaterThan(0.15)
    expect(bellGain(BELL_RANGE_M + 1)).toBe(0)
    // the voice sits on the line to the tower at the distance where the panner gives that gain
    const town = new TownAudio(fakeOut().out)
    const head = { x: 97, y: 1.6, z: -110 }
    const p = town.bellVoicePos(head)!
    const b = JANGAN_SOUND_SPOTS.bell
    const d = Math.hypot(b.x - head.x, b.y - head.y, b.z - head.z)
    const dv = Math.hypot(p.x - head.x, p.y - head.y, p.z - head.z)
    expect(dv).toBeCloseTo(pannerDistanceFor(bellGain(d), d), 3)
    expect(3 / (3 + 1.2 * (dv - 3))).toBeCloseTo(bellGain(d), 3)
    const dir = (q: Vec3Like) => Math.atan2(q.z - head.z, q.x - head.x)
    expect(dir(p)).toBeCloseTo(dir(b), 6)
    expect(town.bellVoicePos({ x: 2000, y: 0, z: 2000 })).toBeNull()
  })
})

describe('the bed', () => {
  it('its gain is monotone in the count, full at 25, the calm loop handing over to the busy one', () => {
    let last = -1
    for (let n = 0; n <= 40; n += 0.5) {
      const g = bedGains(n, false)
      const sum = g.calm + g.busy
      expect(sum).toBeGreaterThanOrEqual(last - 1e-9)
      last = sum
    }
    expect(bedGains(BED_FULL_FOLK, false).calm + bedGains(BED_FULL_FOLK, false).busy).toBeCloseTo(1)
    expect(bedGains(3, false).busy).toBe(0)
    expect(bedGains(30, false).calm).toBe(0)
    expect(bedGains(0, false)).toEqual({ calm: 0, busy: 0 })
  })

  it('is silent at night below 5 folk', () => {
    expect(bedGains(4.9, true)).toEqual({ calm: 0, busy: 0 })
    expect(bedGains(4.9, false).calm).toBeGreaterThan(0)
    expect(bedGains(6, true).calm).toBeGreaterThan(0)
  })

  it('on Low (no town part) it follows the schedule: busy at noon in the plaza, empty at 02:00, quiet in the fields', () => {
    expect(populationShare(JANGAN_POPULATION.bands, 0.5)).toBe(1)
    expect(populationShare(JANGAN_POPULATION.bands, 2 * H)).toBe(0.08)
    expect(circleOverlap(0, 60, 30)).toBeCloseTo(Math.PI * 900)
    expect(circleOverlap(100, 60, 30)).toBe(0)
    const noon = estimateFolkNear(JANGAN_POPULATION, 97, -110, 30, 0.5)
    const night = estimateFolkNear(JANGAN_POPULATION, 97, -110, 30, 2 * H)
    expect(noon).toBeGreaterThan(15)
    expect(night).toBeLessThan(5)
    expect(estimateFolkNear(JANGAN_POPULATION, 900, 400, 30, 0.5)).toBe(0)

    const f = fakeOut()
    const town = new TownAudio(f.out, { rng: () => 0.5 })
    run(town, f, { sec: 2, t0: 0.5 })
    const bed = f.loops.filter(l => l.file.startsWith('town/bed'))
    expect(bed.length).toBeGreaterThan(0)
    expect(town.folk).toBeCloseTo(noon, 6)
    const g = bedGains(noon, false)
    expect(town.bed.calm + town.bed.busy).toBeCloseTo(g.calm + g.busy, 6)
    // the night: the bed fades out
    run(town, f, { sec: 2, t0: 2 * H, from: 1_800_000_010 })
    expect(bed.every(l => l.stopped)).toBe(true)
    expect(town.loops).toBe(0)
  })

  it('a plugged counter (the pure schedule) drives it, and a gain change ramps instead of restarting', () => {
    const f = fakeOut()
    const town = new TownAudio(f.out, { rng: () => 0.5 })
    let n = 10
    const calls: number[][] = []
    town.setFolkCounter((x, z, r, nowS, t) => (calls.push([x, z, r, nowS, t]), n))
    run(town, f, { sec: 1 })
    expect(town.folk).toBe(10)
    expect(calls[0]!.slice(0, 3)).toEqual([97, -110, 30])
    const calm = f.loops.find(l => l.file === 'town/bed_calm')!
    n = 20
    run(town, f, { sec: 1, from: 1_800_000_002 })
    expect(f.loops.filter(l => l.file === 'town/bed_calm')).toHaveLength(1)
    expect(calm.gains.at(-1)).toBeCloseTo((bedGains(20, false).calm) * BED_GAIN, 6)
  })
})

describe('voices', () => {
  it('never more than TOWN_ONESHOT_CAP town one-shots at a time, the bell aside; at most 3 loops', () => {
    const f = fakeOut()
    const town = new TownAudio(f.out, { rng: () => 0.5 })
    // Everything near at once: the stall, the stable, the anvil and the fountain stacked on the listener.
    const p = { x: 0, y: 0, z: 0 }
    town.configure({ spots: { ...JANGAN_SOUND_SPOTS, stalls: [p, p, p], stables: [p], coops: [p], dogs: [p], cats: [p], anvils: [p], fountain: p } })
    let maxShots = 0
    for (let i = 0; i < 4000; i++) {
      const nowS = 1_800_000_000 + i * 0.05
      f.setNow(nowS)
      // the crowd's events on top of the spots' own
      if (i % 7 === 0) town.vendorCall(p)
      if (i % 11 === 0) town.animal('cow', p)
      town.update({ x: 0, y: 0, z: 0, nowS, solarT: 0.5 + (i % 2000) * 1e-6, inTown: true, dt: 0.05 })
      maxShots = Math.max(maxShots, town.oneShots)
      expect(town.loops).toBeLessThanOrEqual(3)
    }
    expect(maxShots).toBe(TOWN_ONESHOT_CAP)
    expect(town.stats().dropped).toBeGreaterThan(0)
    // within any 1 s window (the one-shots' length; the crowd's events land a frame before the clock moves) no more
    // than the cap started
    const starts = f.shots.filter(s => !s.unculled).map(s => s.t).sort((a, b) => a - b)
    for (let i = TOWN_ONESHOT_CAP; i < starts.length; i++) expect(starts[i]! - starts[i - TOWN_ONESHOT_CAP]!).toBeGreaterThanOrEqual(0.9)
  })

  it('culls: murmurs beyond 20 m, the hammer beyond 30 m, the fountain loop beyond 32 m', () => {
    const f = fakeOut()
    const town = new TownAudio(f.out, { rng: () => 0.5 })
    run(town, f, { x: 0, z: 0, sec: 0.1, inTown: false })
    expect(town.vendorCall({ x: 21, y: 1.6, z: 0 })).toBe(false)
    expect(town.vendorCall({ x: 19, y: 1.6, z: 0 })).toBe(true)
    expect(town.hammerHit({ x: 31, y: 1.6, z: 0 })).toBe(false)
    expect(town.hammerHit({ x: 29, y: 1.6, z: 0 })).toBe(true)
    const g = fakeOut()
    const t2 = new TownAudio(g.out, { rng: () => 0.5 })
    const fo = JANGAN_SOUND_SPOTS.fountain!
    run(t2, g, { x: fo.x + 20, z: fo.z, sec: 0.2, t0: 2 * H })
    expect(t2.loops).toBe(1)
    run(t2, g, { x: fo.x + 40, z: fo.z, sec: 0.2, t0: 2 * H, from: 1_800_000_001 })
    expect(t2.loops).toBe(0)
  })

  it('without the files (an older export) it stays silent and never throws', () => {
    const f = fakeOut({ cues: {} })
    const town = new TownAudio(f.out)
    run(town, f, { sec: 200, t0: 0.001, daysPerS: 1 / 200 })
    expect(f.shots).toHaveLength(0)
    expect(f.loops).toHaveLength(0)
  })
})

describe('the built-in spots', () => {
  it('are a pure function of the server clock: two clients hear the same hammer and calls', () => {
    const a = spotEvents('stall0', [12, 25], 1000, 2000)
    expect(a).toEqual(spotEvents('stall0', [12, 25], 1000, 2000))
    // split windows give the same events (frame rate independent)
    const parts = [...spotEvents('stall0', [12, 25], 1000, 1400), ...spotEvents('stall0', [12, 25], 1400, 2000)]
    expect(parts).toEqual(a)
    // the mean period
    expect(a.length).toBeGreaterThan(1000 / 25)
    expect(a.length).toBeLessThan(1000 / 12 + 1)
    const h = hammerEvents('anvil0', 0, 140)
    expect(h.length).toBeGreaterThanOrEqual(30)
    expect(h.length).toBeLessThanOrEqual(60)
    const fa = fakeOut(), fb = fakeOut()
    const ta = new TownAudio(fa.out, { rng: () => 0.3 }), tb = new TownAudio(fb.out, { rng: () => 0.7 })
    const anvil = JANGAN_SOUND_SPOTS.anvils[0]!
    run(ta, fa, { x: anvil.x + 5, z: anvil.z, sec: 60 })
    run(tb, fb, { x: anvil.x + 5, z: anvil.z, sec: 60 })
    const hits = (f: ReturnType<typeof fakeOut>) => f.shots.filter(s => s.file === 'town/hammer_1').map(s => s.t)
    expect(hits(fa).length).toBeGreaterThan(5)
    expect(hits(fa)).toEqual(hits(fb))
  })

  it('the smith rests at night, the vendors pack up, the crowd’s events replace the spots', () => {
    const anvil = JANGAN_SOUND_SPOTS.anvils[0]!
    const f = fakeOut()
    run(new TownAudio(f.out), f, { x: anvil.x, z: anvil.z, sec: 60, t0: 2 * H })
    expect(f.shots.filter(s => s.file === 'town/hammer_1')).toHaveLength(0)
    const g = fakeOut()
    const town = new TownAudio(g.out)
    town.setExternal({ hammer: true })
    run(town, g, { x: anvil.x, z: anvil.z, sec: 60 })
    expect(g.shots.filter(s => s.file === 'town/hammer_1')).toHaveLength(0)
  })

  it('the dog prefers the pitched-up synthesized file, else the retail wolf', () => {
    const f = fakeOut()
    const town = new TownAudio(f.out)
    run(town, f, { x: 0, z: 0, sec: 0.1 })
    town.animal('dog', { x: 1, y: 1.6, z: 0 })
    expect(f.shots.at(-1)!.file).toBe('town/dog_1')
    const g = fakeOut({ cues: { 'town.dog': ['cos/cos_wolf_01_stand1'] } })
    const t2 = new TownAudio(g.out)
    run(t2, g, { x: 0, z: 0, sec: 0.1 })
    t2.animal('dog', { x: 1, y: 1.6, z: 0 })
    expect(g.shots.at(-1)!.file).toBe('cos/cos_wolf_01_stand1')
  })

  it('takes the stalls, anvils, stables, fountain and population from a town file', () => {
    const { spots, pop } = townSoundFromFile({
      places: [{ kind: 'stall', x: 1, z: 2 }, { kind: 'smithAnvil', x: 3, z: 4 }, { kind: 'fountainRim', x: 10, z: 0 }, { kind: 'fountainRim', x: 20, z: 0 }],
      folk: { population: 90 },
      schedule: { bands: [{ from: 0, to: 24, share: 0.5 }] },
    })
    expect(spots.stalls).toEqual([{ x: 1, y: 2, z: 2 }])
    expect(spots.anvils).toEqual([{ x: 3, y: 1, z: 4 }])
    expect(spots.stables).toBe(JANGAN_SOUND_SPOTS.stables)
    expect(spots.fountain).toEqual({ x: 15, y: 2, z: 0 })
    expect(pop.population).toBe(90)
    expect(pop.districts).toBe(JANGAN_POPULATION.districts)
  })
})

describe('night in town', () => {
  const night: AmbientLayer[] = [{ file: 'env/night_insect01', loop: false, everyS: [3, 5] }, { file: 'env/night_wind', loop: true, everyS: [0, 0] }]

  it('mutes the day one-shots and plays the night layers (not the loop); back by day and out of town', () => {
    const f = fakeOut({ night })
    const town = new TownAudio(f.out, { rng: () => 0.5 })
    run(town, f, { x: 400, z: 400, sec: 30, t0: 22 * H })
    expect(town.isNight).toBe(true)
    expect(f.muted).toEqual([true])
    const insects = f.shots.filter(s => s.file === 'env/night_insect01')
    expect(insects.length).toBeGreaterThanOrEqual(5)
    expect(f.shots.some(s => s.file === 'env/night_wind')).toBe(false)
    run(town, f, { x: 400, z: 400, sec: 1, t0: 22 * H, inTown: false, from: 1_800_000_100 })
    expect(f.muted).toEqual([true, false])
    run(town, f, { x: 400, z: 400, sec: 1, t0: 22 * H, inTown: true, from: 1_800_000_200 })
    run(town, f, { x: 400, z: 400, sec: 1, t0: 0.5, inTown: true, from: 1_800_000_300 })
    expect(f.muted).toEqual([true, false, true, false])
    town.stop()
  })

  it('the Low guard’s frozen noon: never night, no mute, no bell', () => {
    const f = fakeOut({ night })
    const town = new TownAudio(f.out, { rng: () => 0.5 })
    run(town, f, { x: 400, z: 400, sec: 120, t0: 0.5 })
    expect(f.muted).toEqual([])
    expect(town.stats().bell).toBe(0)
  })
})

// ---- the GameAudio adapter ---------------------------------------------------------------------------------------

class FakeBackend implements AudioBackend {
  readonly started: StartOptions[] = []
  ready = true
  now(): number {
    return 0
  }
  async decode(): Promise<SoundBuffer> {
    return { duration: 2, bytes: 8 }
  }
  start(_b: SoundBuffer, opts: StartOptions) {
    this.started.push(opts)
    return { stop: () => opts.onEnded?.(), setPosition: () => {}, setGain: () => {} }
  }
  setBusGain(): void {}
  setListener(): void {}
  suspend(): void {}
  resume(): void {}
}

describe('the GameAudio adapter', () => {
  it('routes the bed, the bell and the one-shots to the ambient bus, the bell past the distance cull', async () => {
    const ids = ['env/bell towel 3', 'town/bed_calm', 'town/murmur_1', 'env/night_insect01']
    const file = (id: string) => ({ url: `sound/${id}.ogg`, ms: 1000, channels: 1 as const, bytes: 10 })
    const index = {
      format: SOUND_INDEX_FORMAT,
      files: Object.fromEntries(ids.map(id => [id, file(id)])),
      cues: { 'town.bell': { files: ['env/bell towel 3'], gain: 1, category: 'ambient' }, 'town.bed.calm': { files: ['town/bed_calm', 'town/missing'], gain: 1, category: 'ambient' }, 'town.murmur': { files: ['town/murmur_1'], gain: 1, category: 'sfx' } },
      hits: {}, skills: {}, voices: {}, mobs: {}, models: {},
      areas: { JANGAN_TOWN: { source: 'x', kind: 'town', music: null, regions: [], day: [], night: [{ file: 'env/night_insect01', loop: false, everyS: [5, 9] }, { file: 'env/gone', loop: false, everyS: [5, 9] }] } },
      steps: { walk: {}, run: {} },
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
    const out = townAudioOutput(audio)
    expect(out.files('town.bed.calm')).toEqual(['town/bed_calm'])
    expect(out.files('town.nothing')).toEqual([])
    expect(out.ms('town/murmur_1')).toBe(1000)
    expect(out.nightLayers!().map(l => l.file)).toEqual(['env/night_insect01'])
    expect(out.loopAt('town/bed_calm', { pos: { x: 0, y: 1.6, z: 0 }, gain: 0.5, fadeS: 1.5 })).not.toBeNull()
    expect(out.oneShot('town/murmur_1', { pos: { x: 5, y: 0, z: 0 }, gain: 0.7 })).toBe(true)
    expect(out.oneShot('env/bell towel 3', { pos: { x: 200, y: 0, z: 0 }, gain: 1, unculled: true })).toBe(true)
    expect(out.oneShot('town/murmur_1', { pos: { x: 200, y: 0, z: 0 }, gain: 1 })).toBe(true) // asked, but culled
    expect(out.oneShot('town/none', { pos: { x: 1, y: 0, z: 0 }, gain: 1 })).toBe(false)
    expect(backend.started.map(s => [s.bus, !!s.loop])).toEqual([['ambient', true], ['ambient', false], ['ambient', false]])
    out.muteDayLayers!(true)
    expect(audio.ambient.oneShotsMuted).toBe(true)
    out.muteDayLayers!(false)
    expect(audio.ambient.oneShotsMuted).toBe(false)
  })
})

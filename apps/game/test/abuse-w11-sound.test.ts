/**
 * H-11 lens 14 (docs/WAVE_PLAN7.md §6.6): the town's sound and the unique cues. Each `it` is one finding; they fail
 * until F-11 fixes them.
 *
 * - S1: on Low (Classic) the hourly bell never rings: the town sound reads the sky's frozen noon (`World.timeOfDay`),
 *   not the server clock, though WAVE_PLAN7 D23 / §5.1 and TOWN_LIFE §8.2 keep the bell on Low (Classic).
 * - S2: on Low (no town part) the bed counts the district estimate, not the pure schedule's `populationNear`
 *   (D23: "their count from the pure schedule"): the tea house at 21:00 is silent though the schedule fills it, the
 *   plaza at noon is at about half the gain.
 * - S3: Town life Off on Medium/High silences the bed (and the vendors' murmurs): the counter is wired whenever the
 *   town part exists, and a disabled part answers 0 folk. Low keeps its bed, so Off is quieter than Low. (Reversed
 *   by docs/SOUND.md §10.5 after a user report: no drawn townsfolk, no townsfolk voices, on Off and on Low alike.)
 * - S4: the unique cues are never preloaded and a UI cue waits only 150 ms: on a real link the first (often the only)
 *   appear notice of a session plays no sound.
 * - S5: the animal sounds come from spots where no animal is drawn: the cat meows at the tea house while the drawn cat
 *   walks the plaza; the resting dog at (130, −82) has no bark spot within its 20 m cull.
 * - S6: the smith's apprentice hammers 06:00–20:00 (content/town/jangan.json) but the hammer sounds only to 19:00.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ArcRotateCamera, Vector3 } from '@babylonjs/core'
import { DEFAULT_CLOCK, SOUND_INDEX_FORMAT, phaseForSolarTime, type SoundIndex, type TownFile, type WorldClockState } from '@sro/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudioBackend, SoundBuffer, StartOptions } from '../src/audio/backend.ts'
import { SoundBank } from '../src/audio/bank.ts'
import { GameAudio } from '../src/audio/index.ts'
import { AudioSettings } from '../src/audio/settings.ts'
import { HAMMER, JANGAN_SOUND_SPOTS, SPOT_RULES, bedGains, inHours, isNight } from '../src/audio/town.ts'
import { UNIQUE_CUES } from '../src/hud/unique-notice.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { townFeature } from '../src/world/features/town.ts'
import { activeTownAudio, setTownFolkCounter, townSoundFeature } from '../src/world/features/town-sound.ts'
import { stubCrowdAssets } from '../../../packages/world-render/src/town/crowd.ts'
import { TownLife, plazaStandIn, schedulePlan, townPartWith } from '../../../packages/world-render/src/town/index.ts'
import { TownSchedule } from '../../../packages/world-render/src/town/schedule.ts'
import { w10World } from '../../../packages/world-render/test/w10-fixture.ts'

const ROOT = join(import.meta.dirname, '../../..')
const JANGAN = JSON.parse(readFileSync(join(ROOT, 'content/town/jangan.json'), 'utf8')) as TownFile
const NOON_2026 = 1_790_000_000 + 4 * 3600

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

const TOWN_FILES = ['env/bell towel 3', 'town/bed_calm', 'town/bed_busy', 'town/murmur_1', 'town/hammer_1']
function townIndex(extra: Record<string, { files: string[]; category: string }> = {}): SoundIndex {
  const ids = [...TOWN_FILES, ...Object.values(extra).flatMap(c => c.files)]
  return {
    format: SOUND_INDEX_FORMAT,
    files: Object.fromEntries(ids.map(id => [id, { url: `sound/${id}.ogg`, ms: id.startsWith('env/bell') ? 10_000 : 1000, channels: 1, bytes: 10 }])),
    cues: {
      'town.bell': { files: ['env/bell towel 3'], gain: 1, category: 'ambient' },
      'town.bed.calm': { files: ['town/bed_calm'], gain: 1, category: 'ambient' },
      'town.bed.busy': { files: ['town/bed_busy'], gain: 1, category: 'ambient' },
      'town.murmur': { files: ['town/murmur_1'], gain: 1, category: 'ambient' },
      'town.hammer': { files: ['town/hammer_1'], gain: 1, category: 'ambient' },
      ...Object.fromEntries(Object.entries(extra).map(([k, c]) => [k, { ...c, gain: 1 }])),
    },
    hits: {}, skills: {}, voices: {}, mobs: {}, models: {}, areas: {}, steps: { walk: {}, run: {} },
  } as unknown as SoundIndex
}

/** A GameAudio on a fake backend with the town's files decoded. */
async function loadedAudio() {
  const backend = new FakeBackend()
  const audio = new GameAudio({
    backend,
    settings: new AudioSettings(null),
    bank: new SoundBank({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(8) }), decode: async () => ({ duration: 2, bytes: 8 }) }),
    rng: () => 0.5,
  })
  audio.bank.setIndex(townIndex())
  await Promise.all(TOWN_FILES.map(id => audio.bank.load(id)))
  return { audio, backend }
}

/** The world screen's context as the town sound feature reads it: the listener at `at`, `world` as given. */
function soundCtx(audio: GameAudio, world: unknown, at: { x: number; y: number; z: number }, base: string | null = null): WorldFeatureContext {
  return {
    app: { audio },
    world: () => ({ world, base, folder: base ? 'jangan-fields' : null }),
    selfId: () => 1,
    view: () => ({ root: { position: at } }),
  } as unknown as WorldFeatureContext
}

/** A running server clock whose solar time is `hour` at server second `nowS` (the 2 h day, night speed-up 0.4). */
const clockAt = (hour: number, nowS: number): WorldClockState => ({
  ...DEFAULT_CLOCK, anchorMs: nowS * 1000, anchorDays: 3277 + phaseForSolarTime(hour / 24, DEFAULT_CLOCK.nightSpeedup), running: true,
})

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
  vi.restoreAllMocks()
})

describe('S1: the bell on Low (Classic)', () => {
  it('rings on the server clock\'s game hours while the sky shows its frozen noon', async () => {
    const { audio } = await loadedAudio()
    const play = vi.spyOn(audio, 'playFile')
    // The Low guard state: the classic sky at a frozen noon, no world clock handed to the world (sky-clock.ts).
    const world = { timeOfDay: 0.5, worldClock: null, skyState: { t: 0.5 }, life: null }
    const f = townSoundFeature(soundCtx(audio, world, { x: 97, y: 0, z: -110 }))
    cleanups.push(() => f.dispose?.())
    let nowS = NOON_2026
    f.onMessage?.({ t: 'worldEnter', world: { clock: clockAt(12, nowS) } } as never)
    f.onTownChange?.(true)
    // one whole game day of server time (120 min), a frame a second
    for (let i = 0; i < 7200; i++) {
      nowS += 1
      f.onFrame?.(nowS * 1000, 1)
    }
    const bells = play.mock.calls.filter(c => c[0] === 'env/bell towel 3').length
    // 24 game hours, three strokes at 06:00 and 18:00: 28 strokes (found: 0)
    expect(bells).toBeGreaterThanOrEqual(24)
  })
})

describe('S2: the bed on Low follows the pure schedule (WAVE_PLAN7 D23)', () => {
  it('counts what the schedule puts near the listener: the tea house at 21:00, the plaza at noon', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string) => (String(url).endsWith('town.json') ? { ok: true, json: async () => JANGAN } : { ok: false, json: async () => null })) as never
    cleanups.push(() => void (globalThis.fetch = realFetch))
    const schedule = new TownSchedule(JANGAN)
    const results: string[] = []
    for (const [name, x, z, hour] of [['tea 21:00', -75, -80, 21], ['plaza 12:00', 97, -110, 12]] as const) {
      const { audio } = await loadedAudio()
      // Low: the Classic path has no town part; a running sky (Low + Modern sky) gives the hour
      const world = { timeOfDay: hour / 24, worldClock: null, skyState: { t: hour / 24 }, life: null }
      const f = townSoundFeature(soundCtx(audio, world, { x, y: 0, z }, '/out/'))
      f.onTownChange?.(true)
      let nowS = NOON_2026
      f.onFrame?.(nowS * 1000, 0.1)
      await new Promise(r => setTimeout(r, 20)) // the town file arrives
      let heard = 0
      let truth = 0
      let n = 0
      for (let i = 1; i <= 600; i++) {
        nowS += 1
        f.onFrame?.(nowS * 1000, 1)
        heard += activeTownAudio()!.folk
        truth += schedule.populationNear(x, z, 30, nowS, hour / 24)
        n++
      }
      f.dispose?.()
      heard /= n
      truth /= n
      const gHeard = bedGains(heard, isNight(hour / 24))
      const gTruth = bedGains(truth, isNight(hour / 24))
      if (Math.abs(heard - truth) > Math.max(1.5, 0.3 * truth) || Math.abs(gHeard.calm + gHeard.busy - gTruth.calm - gTruth.busy) > 0.15) {
        results.push(`${name}: the bed hears ${heard.toFixed(1)} folk (gain ${(gHeard.calm + gHeard.busy).toFixed(2)}), the schedule has ${truth.toFixed(1)} (gain ${(gTruth.calm + gTruth.busy).toFixed(2)})`)
      }
    }
    // found: tea 21:00 hears ~1.2 (silent) vs ~7 (0.2); plaza noon ~13.6 (0.57) vs ~22 (0.97)
    expect(results).toEqual([])
  })
})

// docs/SOUND.md §10.5 (a later user report) reverses S3's rule: with Town life Off the user heard the townsfolk talk
// though none were drawn. The count stays (the pure schedule), the folk's voices (the bed) go.
describe('S3: Town life Off silences the townsfolk\'s voices (docs/SOUND.md §10.5)', () => {
  it('the bed hears the plaza with Town life Full, and fades out after Options → Town life: Off on Medium', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const s = await w10World({
      render: 'pbr', quality: 'medium',
      parts: { batch: null, ocean: null, town: townPartWith({ plan: (w, noFolk) => schedulePlan(JANGAN, w, noFolk), assets: (sc, d) => stubCrowdAssets(sc, d) }) },
    })
    cleanups.push(s.dispose)
    const plaza = new Vector3(99, 0, -82)
    const cam = new ArcRotateCamera('cam', -Math.PI / 2, 1.2, 12, plaza.clone(), s.scene)
    cam.minZ = 0.2
    cam.maxZ = 2000
    s.scene.activeCamera = cam
    const town = s.world.town as TownLife
    expect(town).toBeInstanceOf(TownLife)
    let nowS = NOON_2026
    town.setClock(() => nowS)
    const { audio } = await loadedAudio()
    const ctx = {
      ...soundCtx(audio, s.world, { x: plaza.x, y: 0, z: plaza.z }),
      scene: s.scene,
      camera: cam,
      views: () => [][Symbol.iterator](),
    } as unknown as WorldFeatureContext
    const sound = townSoundFeature(ctx)
    const folkFeature = townFeature(ctx)
    cleanups.push(() => sound.dispose?.())
    cleanups.push(() => folkFeature.dispose?.())
    cleanups.push(() => setTownFolkCounter(null))
    vi.spyOn(s.engine, 'getRenderingCanvas').mockReturnValue({ clientWidth: s.engine.getRenderWidth(), clientHeight: s.engine.getRenderHeight() } as never)
    const frames = (k: number) => {
      for (let i = 0; i < k; i++) {
        nowS += 0.1
        s.world.update(cam)
        folkFeature.onFrame?.(nowS * 1000, 0.1)
        sound.onFrame?.(nowS * 1000, 0.1)
      }
    }
    frames(30)
    const full = activeTownAudio()!
    expect(full.folk, 'Town life Full: the bed hears the plaza').toBeGreaterThan(0)
    expect(full.bed.calm + full.bed.busy, 'Town life Full: the plaza talks').toBeGreaterThan(0)
    s.world.setTownLife('off')
    frames(30)
    const off = activeTownAudio()!
    expect(off.folk, 'Town life Off: the schedule still counts the plaza').toBeGreaterThan(0)
    expect(off.bed.calm + off.bed.busy, 'Town life Off: nobody drawn, nobody heard').toBe(0)
  }, 60_000)
})

describe('S4: the unique cues on a real link', () => {
  it('the appear cue plays at once on a client that entered the world (no 150 ms fetch race)', async () => {
    const index = townIndex({
      'ui.click': { files: ['ui/click'], category: 'ui' },
      [UNIQUE_CUES.appeared]: { files: ['ui/alarm_sound'], category: 'ui' },
      [UNIQUE_CUES.defeated]: { files: ['ui/eventcomplete'], category: 'ui' },
    })
    const backend = new FakeBackend()
    // every sound file takes 300 ms to arrive (a 29 KB ogg over the friends' link to the mini PC)
    const fetch = async (url: string) => {
      if (url.endsWith('index.json')) return { ok: true, status: 200, json: async () => index, arrayBuffer: async () => new ArrayBuffer(0) }
      await new Promise(r => setTimeout(r, 300))
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(8) }
    }
    const audio = new GameAudio({ backend, settings: new AudioSettings(null), bank: new SoundBank({ fetch, decode: async () => ({ duration: 4.8, bytes: 8 }) }), rng: () => 0.5 })
    // the world-enter preload (world/features/sound.ts), then minutes in the world before she appears
    audio.preloadWorld(['PUNCH'])
    await new Promise(r => setTimeout(r, 1500))
    const before = backend.started.length
    audio.ui(UNIQUE_CUES.appeared) // what showUniqueNotice's onShow does
    await new Promise(r => setTimeout(r, 700))
    // found: nothing started ("ui/alarm_sound: too late"): the cue is not in PRELOAD_CUES and UI_WAIT_MS is 150
    expect(backend.started.slice(before).filter(s => s.bus === 'ui')).toHaveLength(1)
  })
})

describe('S5: the animal sounds come from the drawn animals', () => {
  const plan = plazaStandIn({ manifest: { name: 'jangan-fields' } } as never)!.animals!
  it('the cat\'s meow spot is within its cull of the drawn cat\'s spots', () => {
    const near = JANGAN_SOUND_SPOTS.cats.map(c => Math.min(...plan.catSpots.map(([x, z]) => Math.hypot(c.x - x, c.z - z))))
    // found: (−44, −52) by the tea tables is ~120 m from the cat, which walks the plaza
    expect(near.every(d => d <= SPOT_RULES.cat.cullM), `meow spot to cat: ${near.map(d => d.toFixed(0)).join(', ')} m`).toBe(true)
  })
  it('the resting dog has a bark spot within the dog cull', () => {
    const [x, z] = plan.dogRest!
    const d = Math.min(...JANGAN_SOUND_SPOTS.dogs.map(p => Math.hypot(p.x - x, p.z - z)))
    // found: the nearest bark spot (84, −118) is 58 m from the dog at (130, −82)
    expect(d).toBeLessThanOrEqual(SPOT_RULES.dog.cullM)
  })
})

describe('S6: the smith\'s hammer', () => {
  it('sounds every hour the apprentice is drawn hammering', () => {
    const worker = JANGAN.folk.fixed!.find(f => f.clip === 'HAMMER')!
    expect(worker.hours).toBeDefined()
    const [from, to] = worker.hours!
    const silent: number[] = []
    for (let h = from; h < to; h += 0.25) if (!inHours(h, HAMMER.hours[0], HAMMER.hours[1])) silent.push(h)
    // found: 19:00–20:00 the apprentice swings the hammer without a sound
    expect(silent).toEqual([])
  })
})

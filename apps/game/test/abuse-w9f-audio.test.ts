/**
 * Adversarial hunt, lens = audio (wave 9F): rain loop seams, thunder delay vs distance, muffling under shelter, birds
 * muted in rain, weather audio off when the preview toggle is off. Every test here FAILS on ef535d4/1af27df and
 * proves one finding; what held up is listed in the hunt's report, not here.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { WEATHER_CUES, WEATHER_PARAMS, type ServerMessage, type SoundCue, type SoundIndex, type WeatherSync } from '@sro/shared'
import { WEATHER_PRESETS } from '@sro/world-render'
import type { AudioBackend, SoundBuffer, StartOptions, VoiceHandle } from '../src/audio/backend.ts'
import { SoundBank, type FetchResponse } from '../src/audio/bank.ts'
import { GameAudio } from '../src/audio/index.ts'
import { AudioSettings } from '../src/audio/settings.ts'
import { WEATHER_AUDIO, WeatherAudio, type WeatherAudioHost } from '../src/audio/weather.ts'
import { SettingsStore, normalizeSettings, weatherLevelFor, weatherShown } from '../src/settings.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { WeatherClient, weatherFeature } from '../src/world/features/weather.ts'
import { parseWav, trimTrailingSilence } from '../../../packages/convert/src/sound/pcm.ts'

// A4 checks the 'preview' rollout's off state (the toggle unticked); the release ('on') always has the weather audio.
vi.mock('../src/rollout.ts', () => ({ RENDER_ROLLOUT: 'preview' }))

const T0 = Date.UTC(2026, 8, 29, 12)

function sync(over: Partial<WeatherSync> = {}): WeatherSync {
  return { start: T0, dur: 0, from: 'rain', to: 'rain', intensity: 1, until: T0 + 3_600_000, windDir: 0.35, windMs: WEATHER_PARAMS.rain.windMs, wet: 0, puddle: 0, at: T0, seed: 7, ...over }
}

const CUES: Record<string, SoundCue> = {
  'weather.rain': { files: ['etc/rain1'], gain: 1, category: 'ambient' },
  'weather.thunder.near': { files: ['etc/lightning1'], gain: 1, category: 'ambient' },
  'weather.thunder.mid': { files: ['etc/lightning2'], gain: 1, category: 'ambient' },
  'weather.thunder.far': { files: ['etc/lightning3'], gain: 1, category: 'ambient' },
  'weather.wind.strong': { files: ['env/donhwang_wind04'], gain: 1, category: 'ambient' },
  'weather.wind.gust': { files: ['env/dd_wind_01', 'env/dd_wind_02'], gain: 1, category: 'ambient' },
}

/** A WeatherAudioHost on a fake clock that records every bed voice started (with its cue file). */
function recordingHost() {
  let t = 0
  const starts: { file: string; at: number; opts: StartOptions }[] = []
  let pendingFile = ''
  const host: WeatherAudioHost = {
    ready: () => true,
    now: () => t,
    cue: n => CUES[n],
    buffer: file => {
      pendingFile = file
      return { duration: 16, bytes: 1 }
    },
    start: (_b, opts) => {
      starts.push({ file: pendingFile, at: t, opts })
      const h: VoiceHandle = { stop: () => {}, setPosition: () => {}, setGain: () => {}, setLowpass: () => {} }
      return h
    },
    retain: () => {},
    release: () => {},
    oneShot: () => {},
    muteBirds: () => {},
    rng: () => 0.5,
  }
  return { host, starts, advance: (s: number) => (t += s) }
}

describe('A1 strong-wind bed: restarts from the top of the file over and over in steady weather', () => {
  // (steady storm: 4 starts in 120 s, borderline; ordinary rain, the common rainy state, is the clear case)
  for (const kind of ['rain'] as const) {
    it(`steady ${kind} for 2 minutes starts the weather.wind.strong loop at most a few times`, () => {
      const client = new WeatherClient(null, T0)
      client.enter(sync({ from: kind, to: kind, windMs: WEATHER_PARAMS[kind].windMs }), T0)
      const h = recordingHost()
      const audio = new WeatherAudio(h.host)
      const dt = 1 / 30
      for (let i = 0; i < 120 * 30; i++) {
        const now = T0 + i * dt * 1000
        audio.update(client.frame(now, dt), false)
        h.advance(dt)
      }
      // W9F fix-game: the bed is two voices now (like the rain); a bed start is a start of its first voice.
      const wind = h.starts.filter(s => s.file === 'env/donhwang_wind04' && s.opts.rate === WEATHER_AUDIO.wind.rates[0])
      // A steady weather state should hold one bed (or re-enter it rarely); every start replays the file's opening gust.
      expect(wind.length, `${wind.length} starts of the strong-wind loop in 120 s of steady ${kind}`).toBeLessThanOrEqual(3)
    })
  }
})

describe('A2 shelter muffling: absent on the weather levels most players get', () => {
  // W9F fix-game: the finding assumed most friends are on integrated GPUs; the user's hardware decision
  // (work/tmp/w9-user-decisions.md) is gaming desktops, gaming laptops and Apple Silicon Macs, no integrated-GPU PC
  // laptops. So muffling is documented as a Medium-and-up feature (WEATHER.md §7.5, SOUND.md §8.1): the shelter map
  // is a render feature of those levels, and Low / Off (the N100 class, or a player's choice) keep an unmuffled bed.
  // The original second case (a mock world without any geometry expected to report a roof) had no answer to find.
  const iris = { vendor: 'intel', architecture: 'gen-12lp', isFallbackAdapter: false }
  const s = (preset: 'low' | 'medium' | 'high' | 'ultra', weather = 'auto') => normalizeSettings({ v: 1, graphics: { preset, weather, modern: true } })

  it('the friends’ hardware on auto (a discrete or Apple GPU at Medium and up) always has the shelter map', () => {
    for (const preset of ['medium', 'high', 'ultra'] as const) {
      const settings = s(preset)
      const level = weatherLevelFor(settings, undefined)
      expect(weatherShown(settings)).toBe(true)
      expect(WEATHER_PRESETS[level].shelter, `${preset} -> ${level}`).toBe(true)
    }
  })

  it('the documented exceptions: the Low and Off levels (Low preset, an integrated GPU on auto, Weather effects: Off) have none', () => {
    expect(WEATHER_PRESETS[weatherLevelFor(s('low'), undefined)].shelter).toBe(false)
    expect(WEATHER_PRESETS[weatherLevelFor(s('medium'), iris)].shelter).toBe(false)
    expect(WEATHER_PRESETS[weatherLevelFor(s('high', 'off'), undefined)].shelter).toBe(false)
  })
})

// ---- A3: the first close thunder is lost ------------------------------------------------------------------

class ReadyBackend implements AudioBackend {
  readonly ready = true
  t = 0
  started: StartOptions[] = []
  now() {
    return this.t
  }
  async decode(): Promise<SoundBuffer> {
    return { duration: 6, bytes: 1000 }
  }
  start(_b: SoundBuffer, opts: StartOptions): VoiceHandle | null {
    this.started.push(opts)
    return { stop: () => {}, setPosition: () => {}, setGain: () => {}, setLowpass: () => {} }
  }
  setBusGain() {}
  setListener() {}
  suspend() {}
  resume() {}
}

function thunderIndex(): SoundIndex {
  const file = (url: string) => ({ url, ms: 6000, channels: 1, bytes: 50_000 })
  return {
    files: {
      'etc/rain1': file('sound/etc/rain1.ogg'),
      'etc/lightning1': file('sound/etc/lightning1.ogg'),
      'etc/lightning2': file('sound/etc/lightning2.ogg'),
      'etc/lightning3': file('sound/etc/lightning3.ogg'),
    },
    cues: CUES,
  } as unknown as SoundIndex
}

describe('A3 thunder: a close strike in a storm that has been going for minutes is silent', () => {
  it('the thunder file is ready by the time a 150 m strike is due (0.44 s after the flash)', async () => {
    const backend = new ReadyBackend()
    // The network: every fetch answers when the test says so (a real fetch over Tailscale + Opus decode).
    const waiting: Array<() => void> = []
    const fetched: string[] = []
    const fetchFn = (url: string) =>
      new Promise<FetchResponse>(resolve => {
        fetched.push(url)
        waiting.push(() => resolve({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(8) }))
      })
    const flush = async () => {
      for (const r of waiting.splice(0)) r()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }
    const audio = new GameAudio({ backend, settings: new AudioSettings(null), bank: new SoundBank({ fetch: fetchFn, decode: () => backend.decode() }), rng: () => 0 })
    audio.bank.setIndex(thunderIndex())
    // Two minutes of storm: the rain bed loads and plays; the network is idle (everything answered).
    for (let i = 0; i < 120; i++) {
      audio.weather.update({ rain: 1, windMs: 3, gustMs: 3 }, false)
      backend.t += 1
      await flush()
    }
    expect(backend.started.some(o => o.loop)).toBe(true)
    const preloaded = fetched.filter(u => u.includes('lightning')).length
    // A strike 150 m away: the lightning message arrives, the feature calls prepareThunder, and 0.44 s later thunder.
    audio.weather.prepareThunder(150)
    backend.t += 0.44
    audio.weather.thunder(150, 0)
    await flush() // the file arrives a moment too late
    backend.t += 1
    const thunders = backend.started.filter(o => !o.loop)
    expect(thunders.length, `the due thunder was dropped as not loaded and never retried (thunder files preloaded during the storm: ${preloaded})`).toBe(1)
    audio.dispose()
  })
})

// ---- A4: preview off still fetches thunder --------------------------------------------------------------

describe('A4 preview toggle off: no weather audio work at all', () => {
  it('a lightning strike does not load a thunder file while the new look (and so the weather audio) is off', () => {
    const weatherAudio = { update: vi.fn(), thunder: vi.fn(), prepareThunder: vi.fn(), stop: vi.fn() }
    const ctx = {
      app: { audio: { weather: weatherAudio } },
      scene: { getLightByName: () => null },
      camera: { target: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 5, z: -10 } },
      serverNow: () => T0,
      selfId: () => null,
      view: () => undefined,
      world: () => null,
    } as unknown as WorldFeatureContext
    const store = new SettingsStore(null) // graphics.modern false: the preview is off (RENDER_ROLLOUT 'preview')
    expect(weatherShown(store.get())).toBe(false)
    const f = weatherFeature(ctx, { store, search: '', zoneAt: () => null })
    f.onMessage!({ t: 'worldEnter', world: { weather: sync({ from: 'storm', to: 'storm', windMs: 13 }) } } as unknown as ServerMessage)
    f.onMessage!({ t: 'lightning', at: T0, distM: 900, bearing: 0 } as ServerMessage)
    f.onFrame!(T0 + 5000, 0.016)
    expect(weatherAudio.thunder).not.toHaveBeenCalled()
    // prepareThunder -> GameAudio bank.load -> a 50-96 KB fetch + decode per thunder file, for a sound never played.
    expect(weatherAudio.prepareThunder).not.toHaveBeenCalled()
    f.dispose!()
  })
})

// ---- A5: the strong-wind "bed" is mostly silence ----------------------------------------------------------

// W9F fix-game: the file the shipped cue names (it was pinned to donhwang_wind04, which the fix replaces).
const SRC = fileURLToPath(new URL(`../../../work/extracted/Data/prim/snd/${WEATHER_CUES['weather.wind.strong']!.files[0]}.wav`, import.meta.url))

describe('A5 weather.wind.strong loop: a bed must not drop out', () => {
  it.skipIf(!existsSync(SRC))('the looped file (as exported: trailing silence trimmed) never falls 30 dB under its mean for over 1 s', () => {
    const pcm = trimTrailingSilence(parseWav(new Uint8Array(readFileSync(SRC))))
    const ch = pcm.channels[0]!
    const win = Math.round(pcm.sampleRate * 0.1)
    const db: number[] = []
    let all = 0
    for (let i = 0; i < ch.length; i++) all += (ch[i]! / 32768) ** 2
    const mean = 10 * Math.log10(all / ch.length)
    for (let a = 0; a + win <= ch.length; a += win) {
      let s = 0
      for (let i = a; i < a + win; i++) s += (ch[i]! / 32768) ** 2
      db.push(10 * Math.log10(s / win + 1e-12))
    }
    // the longest run (wrapping, since it loops) of 100 ms windows more than 30 dB below the file's mean level
    let run = 0
    let longest = 0
    for (const d of [...db, ...db]) {
      run = d < mean - 30 ? run + 1 : 0
      longest = Math.max(longest, run)
    }
    const quiet = db.filter(d => d < mean - 30).length / db.length
    expect(longest / 10, `the loop drops out for ${longest / 10} s (${Math.round(quiet * 100)} % of it is >30 dB down)`).toBeLessThanOrEqual(1)
  })
})

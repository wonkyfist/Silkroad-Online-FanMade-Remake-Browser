/**
 * The stage prefetch (docs/SCREENS.md §0B.4, §0B.10 `stage-prefetch.test.ts`; lane SCR-R): the file list is the stage
 * regions' files only; at most 4 in flight, `priority: 'low'`, `cache: 'force-cache'`; it stops on logout and when
 * select starts its own load (the host's `enter`). Over world-render's synthetic streamed fixture (7 × 7 regions of
 * 192 m, one placed model per region).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BASE_URL, CX, CZ, ROOT_URL, WORLD_NAME, makeFixture } from '../../../packages/world-render/test/stream-fixture.ts'
import { PREFETCH_IN_FLIGHT, StagePrefetch, prefetchStage, stageFiles, stopStagePrefetch, type PrefetchFetch } from '../src/stage/prefetch.ts'
import { createStageHost, type StageApp } from '../src/stage/host.ts'
import { STAGES } from '../src/stage/stages.ts'

afterEach(() => stopStagePrefetch())

/** The fixture's centre region spans x 0..192, z −192..0; this spot is 20 m inside its south-west corner. */
const SPOT = { x: 20, z: -20 }

interface Call {
  url: string
  init: RequestInit & { priority?: string }
}

/** A fetch over the fixture's files that records the calls and the peak in flight; `hold` keeps requests open. */
function fixtureFetch(opts: { hold?: boolean } = {}) {
  const fx = makeFixture()
  const calls: Call[] = []
  let inFlight = 0
  let peak = 0
  const waiting: Array<() => void> = []
  const fetch: PrefetchFetch = async (url, init) => {
    calls.push({ url, init })
    inFlight++
    peak = Math.max(peak, inFlight)
    try {
      await new Promise<void>((resolve, reject) => {
        const go = () => setTimeout(resolve, 1)
        if (opts.hold) waiting.push(go)
        else go()
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    } finally {
      inFlight--
    }
    const bytes = fx.files.get(url)
    return {
      ok: !!bytes,
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      arrayBuffer: async () => (bytes ?? new Uint8Array()).buffer as ArrayBuffer,
    }
  }
  return { fx, calls, fetch, peak: () => peak, release: () => waiting.splice(0).forEach(f => f()) }
}

describe('the stage prefetch (SCREENS §0B.4)', () => {
  it('lists only the stage regions\' files: terrain, nav, tiles and the placed models, nearest first', () => {
    const { manifest } = makeFixture()
    const files = stageFiles(manifest, SPOT, 150)
    // Within 150 m of (20, −20): the centre region and its west, south and south-west neighbours.
    const regions = new Set(files.filter(f => f.startsWith('terrain/')).map(f => f.slice(8, -4)))
    expect(regions).toEqual(new Set([`${CX}_${CZ}`, `${CX - 1}_${CZ}`, `${CX}_${CZ - 1}`, `${CX - 1}_${CZ - 1}`]))
    expect(files[0]).toBe('environment.json')
    expect(files).toContain('nav-objects.bin')
    expect(files.indexOf(`terrain/${CX}_${CZ}.bin`)).toBeLessThan(files.indexOf(`terrain/${CX - 1}_${CZ - 1}.bin`))
    for (const r of regions) expect(files).toContain(`nav/${r}.bin`)
    // The placed models of those regions (model 0 everywhere, model 1 in the centre), once each.
    expect(files.filter(f => f.startsWith('models/'))).toEqual(['models/m0.glb', 'models/m1.glb'])
    // The tiles those regions use, and no other region's files.
    for (const f of files) {
      const m = /^(?:terrain|nav)\/(\d+)_(\d+)\.bin$/.exec(f)
      if (m) expect(regions.has(`${m[1]}_${m[2]}`), f).toBe(true)
    }
    expect(new Set(files).size).toBe(files.length)
    // A far spot lists other regions.
    expect(stageFiles(manifest, { x: 192 * 2 + 96, z: -96 }, 50).filter(f => f.startsWith('terrain/'))).toEqual([`terrain/${CX + 2}_${CZ}.bin`])
  })

  it('fetches them at most 4 at a time, low priority, from the HTTP cache without revalidating', async () => {
    const f = fixtureFetch()
    const run = new StagePrefetch({ world: WORLD_NAME, roots: [ROOT_URL], spot: SPOT, radiusM: 150, fetch: f.fetch })
    const r = await run.done
    const want = stageFiles(f.fx.manifest, SPOT, 150)
    // The fixture serves no model glbs (its models load through a hook): those two fail, quietly.
    expect(r).toEqual({ base: BASE_URL, files: want.length, fetched: want.length - 2, failed: 2, stopped: false })
    expect(f.calls.map(c => c.url)).toEqual([`${BASE_URL}manifest.json`, ...want.map(p => BASE_URL + p)])
    for (const c of f.calls) {
      expect(c.init.priority).toBe('low')
      expect(c.init.cache).toBe('force-cache')
    }
    expect(f.peak()).toBeLessThanOrEqual(PREFETCH_IN_FLIGHT)
    expect(f.peak()).toBe(PREFETCH_IN_FLIGHT)
  })

  it('probes the roots in order and falls back to jangan-fields for a name that is not a folder', async () => {
    const f = fixtureFetch()
    const r = await new StagePrefetch({ world: WORLD_NAME, roots: ['http://none.test/', ROOT_URL], spot: SPOT, fetch: f.fetch }).done
    expect(r.base).toBe(BASE_URL)
    expect(f.calls[0]!.url).toBe(`http://none.test/world/${WORLD_NAME}/manifest.json`)
    const g = fixtureFetch()
    const none = await new StagePrefetch({ world: '../x', roots: [ROOT_URL], fetch: g.fetch }).done
    expect(g.calls.map(c => c.url)).toEqual([`${ROOT_URL}world/jangan-fields/manifest.json`])
    expect(none).toMatchObject({ base: null, files: 0, fetched: 0 })
  })

  it('stops on logout (stopStagePrefetch): nothing new starts and the requests in flight are aborted', async () => {
    const f = fixtureFetch({ hold: true })
    const run = prefetchStage({ world: WORLD_NAME, roots: [ROOT_URL], spot: SPOT, fetch: f.fetch })
    // The manifest request is held; let it through, then the first four files start and are held.
    await new Promise(r => setTimeout(r, 5))
    f.release()
    await new Promise(r => setTimeout(r, 20))
    const started = f.calls.length
    expect(started).toBe(1 + PREFETCH_IN_FLIGHT)
    stopStagePrefetch()
    const r = await run.done
    expect(r.stopped).toBe(true)
    expect(run.stopped).toBe(true)
    expect(f.calls.length).toBe(started)
    expect(r.fetched).toBe(0)
    expect(r.failed).toBe(0)
  })

  it('a new prefetch stops the old one, and the stage host\'s enter (select starts its own load) stops it', async () => {
    const f = fixtureFetch({ hold: true })
    const first = prefetchStage({ world: WORLD_NAME, roots: [ROOT_URL], spot: SPOT, fetch: f.fetch })
    const second = prefetchStage({ world: WORLD_NAME, roots: [ROOT_URL], spot: SPOT, fetch: f.fetch })
    expect(first.stopped).toBe(true)
    expect(second.stopped).toBe(false)
    // A host without an engine refuses before it starts anything (the prefetch goes on); its release stops it.
    const host = createStageHost({ engine: null } as unknown as StageApp)
    await expect(host.enter(STAGES.select)).rejects.toThrow()
    expect(second.stopped).toBe(false)
    const g = fixtureFetch({ hold: true })
    const third = prefetchStage({ world: WORLD_NAME, roots: [ROOT_URL], spot: SPOT, fetch: g.fetch })
    host.release()
    expect(third.stopped).toBe(true)
    f.release()
    g.release()
    await Promise.all([first.done, second.done, third.done])
  })
})

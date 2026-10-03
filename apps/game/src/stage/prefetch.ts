/**
 * The stage prefetch while the player types the password (docs/SCREENS.md §0B.4, lane SCR-R; scope cut 3): when the
 * login screen opens, fetch the default export's `manifest.json` and then the files of the stage's regions (the
 * regions within the stage stream's 150 m of the spot: terrain, nav chunk, terrain lightmap, the tiles they use and the
 * placed models' glb and sidecar, plus the two world files every load reads), at most 4 at a time.
 *
 * - `fetch(url, { priority: 'low', cache: 'force-cache' })`: production serves these files `no-cache` with an ETag, so a
 *   plain fetch would revalidate every one now and `loadWorld` again a minute later (~1,250 round trips for nothing).
 *   'force-cache' takes any cached copy without asking, so only files the browser does not have touch the network (the
 *   first visit, evictions); `loadWorld`'s own revalidation still picks up a changed file.
 * - It downloads only what the stage loads anyway, and stops on logout and when the select screen starts its own load
 *   (`stopStagePrefetch`; the stage host calls it on `enter`).
 * - The export: the server list's `world` when known (unvalidated there: used only for fetching, §9), else
 *   jangan-fields. One prefetch per page at a time (a new one stops the old).
 */
import { regionInfos, rectDistance, type World } from '@sro/world-render'
import { ASSET_ROOTS } from '../world/jangan/ground.ts'
import { STAGE_DEFAULT_WORLD, STAGE_SPOT, STAGE_STREAM } from './stages.ts'

/** Requests in flight at once (§0B.4). */
export const PREFETCH_IN_FLIGHT = 4

type Manifest = World['manifest']

/** The fetch the prefetch calls (tests pass their own). */
export type PrefetchFetch = (url: string, init: RequestInit & { priority?: 'high' | 'low' | 'auto' }) => Promise<Pick<Response, 'ok' | 'json' | 'arrayBuffer'>>

export interface StagePrefetchOptions {
  /** Export folder (default jangan-fields); a name that is not a folder name falls back to it. */
  world?: string | null
  /** Where the stage stands and its stream radius (default the palace steps, 150 m). */
  spot?: { x: number; z: number }
  radiusM?: number
  /** Asset roots to probe, in order (default the game's: /out-opt/, /out/). */
  roots?: readonly string[]
  maxInFlight?: number
  fetch?: PrefetchFetch
}

export interface PrefetchResult {
  /** The world folder's URL prefix (null: no root served the manifest). */
  base: string | null
  files: number
  fetched: number
  failed: number
  stopped: boolean
}

const WORLD_NAME = /^[a-z0-9-]{1,64}$/

/**
 * The files the stage's regions need, relative to the world folder, nearest region first: per region its terrain, nav
 * chunk (a streamed export), terrain lightmap, then the tiles and the placed models' glb and sidecar; plus the world
 * files every load reads (`environment.json`, `nav-objects.bin`). No other region's files.
 */
export function stageFiles(manifest: Manifest, spot: { x: number; z: number } = STAGE_SPOT, radiusM: number = STAGE_STREAM.loadRadiusM): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (f: string | null | undefined) => {
    if (!f || seen.has(f)) return
    seen.add(f)
    out.push(f)
  }
  add(manifest.environment?.file)
  const stream = manifest.stream
  if (stream) add(stream.navObjects?.file)
  const infos = regionInfos({ manifest })
    .map(info => ({ info, d: rectDistance(spot.x, spot.z, info) }))
    .filter(r => r.d <= radiusM)
    .sort((a, b) => a.d - b.d)
  const tiles = new Map(manifest.tiles.map(t => [t.id, t.file]))
  for (const { info } of infos) {
    const r = info.region
    add(r.terrain.file)
    if (stream?.navRegions?.dir) add(`${stream.navRegions.dir}/${r.x}_${r.z}.bin`)
    add(r.lightmap?.file)
  }
  for (const { info } of infos) for (const id of info.region.terrain.tileIds) add(tiles.get(id))
  for (const { info } of infos) {
    for (const index of info.models.keys()) {
      const model = manifest.models[index]
      add(model?.glb)
      add(model?.sidecar)
    }
  }
  return out
}

const defaultFetch: PrefetchFetch = (url, init) => fetch(url, init)

/** One prefetch run (see the file comment). `done` settles when every file was tried or it was stopped. */
export class StagePrefetch {
  readonly done: Promise<PrefetchResult>
  private readonly abort = new AbortController()
  private stoppedFlag = false

  constructor(opts: StagePrefetchOptions = {}) {
    this.done = this.run(opts)
  }

  get stopped(): boolean {
    return this.stoppedFlag
  }

  /** Stops it: nothing new starts, the requests in flight are aborted. */
  stop(): void {
    if (this.stoppedFlag) return
    this.stoppedFlag = true
    this.abort.abort()
  }

  private async run(opts: StagePrefetchOptions): Promise<PrefetchResult> {
    const doFetch = opts.fetch ?? defaultFetch
    const init = { priority: 'low' as const, cache: 'force-cache' as const, signal: this.abort.signal }
    const world = opts.world && WORLD_NAME.test(opts.world) ? opts.world : STAGE_DEFAULT_WORLD
    const result: PrefetchResult = { base: null, files: 0, fetched: 0, failed: 0, stopped: false }
    let manifest: Manifest | null = null
    for (const root of opts.roots ?? ASSET_ROOTS) {
      if (this.stoppedFlag) break
      const base = `${root}world/${world}/`
      try {
        const res = await doFetch(`${base}manifest.json`, init)
        const m = res.ok ? ((await res.json()) as Manifest & { format?: string }) : null
        if (m && m.format === 'sro-world' && Array.isArray(m.regions)) {
          manifest = m
          result.base = base
          break
        }
      } catch {
        // the next root (a dev server answers a missing path with its index page, which is not JSON)
      }
    }
    if (!manifest || !result.base || this.stoppedFlag) return { ...result, stopped: this.stoppedFlag }
    const files = stageFiles(manifest, opts.spot ?? STAGE_SPOT, opts.radiusM ?? STAGE_STREAM.loadRadiusM)
    result.files = files.length
    const base = result.base
    let next = 0
    const worker = async () => {
      while (!this.stoppedFlag && next < files.length) {
        const file = files[next++]!
        try {
          const res = await doFetch(base + file, init)
          // The body is read so the response lands in the HTTP cache complete.
          if (res.ok) await res.arrayBuffer()
          if (res.ok) result.fetched++
          else result.failed++
        } catch {
          if (!this.stoppedFlag) result.failed++
        }
      }
    }
    const lanes = Math.max(1, Math.min(opts.maxInFlight ?? PREFETCH_IN_FLIGHT, files.length))
    await Promise.all(Array.from({ length: lanes }, worker))
    return { ...result, stopped: this.stoppedFlag }
  }
}

let current: StagePrefetch | null = null

/** Starts the page's stage prefetch (the login screen; a running one is stopped first). */
export function prefetchStage(opts: StagePrefetchOptions = {}): StagePrefetch {
  current?.stop()
  current = new StagePrefetch(opts)
  return current
}

/** Stops the page's stage prefetch (logout; the select screen's own load). Safe when none runs. */
export function stopStagePrefetch(): void {
  current?.stop()
  current = null
}

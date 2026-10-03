/**
 * Sound loading and caching (docs/SOUND.md §5.4): the exported index (/out/sound/index.json), per-model clip tracks
 * (sound/model/<code>.json), and decoded buffers under an LRU budget. One in-flight promise per file, at most six
 * fetches at once; buffers held by a playing voice are never evicted. Anything missing resolves to null: the game
 * plays on without that sound.
 */
import { SOUND_INDEX_FORMAT, SOUND_MODEL_FORMAT, validateSoundIndex, type ModelSounds, type SoundIndex } from '@sro/shared'
import type { SoundBuffer } from './backend.ts'

/** The part of fetch's Response the bank reads (tests pass a fake). */
export interface FetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface BankOptions {
  /** Decodes encoded bytes (the backend; waits for the audio context). */
  decode(bytes: ArrayBuffer): Promise<SoundBuffer>
  fetch?: (url: string) => Promise<FetchResponse>
  /** Asset root that index urls are relative to. */
  root?: string
  /** Decoded-buffer budget in bytes (48 kHz float mono = 192 KB/s). */
  budgetBytes?: number
  maxFetches?: number
  /** Use the `.wav` twin of each file when the index has them (no Opus decoder). */
  preferWav?: boolean
}

export const SOUND_ROOT = '/out/'
export const CACHE_BUDGET_BYTES = 64 * 1024 * 1024
const MAX_FAILURE_LOGS = 3

interface Entry {
  buffer: SoundBuffer
  pins: number
}

/** A structurally usable index (the validator's finer problems, like one missing file, are only reported). */
export function usableIndex(v: unknown): v is SoundIndex {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  if (r.format !== SOUND_INDEX_FORMAT) return false
  const objects = ['files', 'cues', 'hits', 'skills', 'voices', 'mobs', 'models', 'areas']
  if (!objects.every(k => r[k] && typeof r[k] === 'object')) return false
  const steps = r.steps as Record<string, unknown> | undefined
  return !!steps && typeof steps.walk === 'object' && typeof steps.run === 'object' && !!steps.walk && !!steps.run
}

export class SoundBank {
  private indexValue: SoundIndex | null = null
  private indexLoad: Promise<SoundIndex | null> | null = null
  private readonly cache = new Map<string, Entry>()
  private readonly loading = new Map<string, Promise<SoundBuffer | null>>()
  private readonly failed = new Set<string>()
  private readonly models = new Map<string, ModelSounds | null>()
  private readonly modelLoads = new Map<string, Promise<ModelSounds | null>>()
  private readonly queue: Array<() => void> = []
  private active = 0
  private bytesValue = 0
  private failures = 0
  private readonly fetchFn: (url: string) => Promise<FetchResponse>
  private readonly root: string
  private readonly budget: number
  private readonly maxFetches: number

  constructor(private readonly opts: BankOptions) {
    this.fetchFn = opts.fetch ?? (url => fetch(url))
    this.root = opts.root ?? SOUND_ROOT
    this.budget = opts.budgetBytes ?? CACHE_BUDGET_BYTES
    this.maxFetches = Math.max(1, opts.maxFetches ?? 6)
  }

  get index(): SoundIndex | null {
    return this.indexValue
  }

  /** Uses an index directly (tests; or a pre-fetched one). */
  setIndex(index: SoundIndex | null): void {
    this.indexValue = index
    this.indexLoad = Promise.resolve(index)
  }

  /** Fetches sound/index.json once. A missing or unusable index disables sound effects with one warning. */
  loadIndex(): Promise<SoundIndex | null> {
    this.indexLoad ??= (async () => {
      try {
        const res = await this.fetchFn(`${this.root}sound/index.json`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const v = await res.json()
        if (!usableIndex(v)) throw new Error('not a sound index')
        const problems = validateSoundIndex(v)
        if (problems.length) console.warn(`[audio] sound index: ${problems.length} problem(s), e.g. ${problems.slice(0, 3).join('; ')}`)
        this.indexValue = v
        return v
      } catch (err) {
        console.warn('[audio] no sound index (sound/index.json); sound effects are off', err instanceof Error ? err.message : err)
        return null
      }
    })()
    return this.indexLoad
  }

  /** A decoded buffer if it is cached (and marks it recently used); null otherwise. */
  get(id: string): SoundBuffer | null {
    const e = this.cache.get(id)
    if (!e) return null
    this.cache.delete(id)
    this.cache.set(id, e)
    return e.buffer
  }

  /** Fetches and decodes a file (one in-flight load per id). Null when the file is unknown or cannot load. */
  load(id: string): Promise<SoundBuffer | null> {
    const hit = this.get(id)
    if (hit) return Promise.resolve(hit)
    if (this.failed.has(id)) return Promise.resolve(null)
    const pending = this.loading.get(id)
    if (pending) return pending
    const file = this.indexValue?.files[id]
    if (!file) return Promise.resolve(null)
    const url = this.root + (this.opts.preferWav && file.wav ? file.wav : file.url)
    const p = this.limited(async () => {
      const res = await this.fetchFn(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.arrayBuffer()
    })
      .then(bytes => this.opts.decode(bytes))
      .then(
        buffer => {
          this.put(id, buffer)
          return buffer
        },
        err => {
          this.failed.add(id)
          if (this.failures++ < MAX_FAILURE_LOGS) console.warn(`[audio] cannot load ${url}`, err instanceof Error ? err.message : err)
          return null
        },
      )
      .finally(() => this.loading.delete(id))
    this.loading.set(id, p)
    return p
  }

  /** Starts loading every id (fire and forget). */
  preload(ids: Iterable<string | null | undefined>): void {
    for (const id of ids) if (id) void this.load(id)
  }

  /** Clip tracks of a model code (sound/model/<code>.json); null when it has none. */
  model(code: string): Promise<ModelSounds | null> {
    if (this.models.has(code)) return Promise.resolve(this.models.get(code)!)
    let p = this.modelLoads.get(code)
    if (p) return p
    p = (async () => {
      const index = await this.loadIndex()
      const rel = index?.models[code]
      if (!rel) return null
      try {
        const res = await this.fetchFn(this.root + rel)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const v = (await res.json()) as ModelSounds
        if (!v || v.format !== SOUND_MODEL_FORMAT || !v.clips || typeof v.clips !== 'object') throw new Error('not a model sound file')
        return v
      } catch (err) {
        if (this.failures++ < MAX_FAILURE_LOGS) console.warn(`[audio] no clip sounds for ${code}`, err instanceof Error ? err.message : err)
        return null
      }
    })().then(m => {
      this.models.set(code, m)
      this.modelLoads.delete(code)
      return m
    })
    this.modelLoads.set(code, p)
    return p
  }

  /** The model's clip tracks if already loaded (undefined while loading or never asked). */
  modelNow(code: string): ModelSounds | null | undefined {
    return this.models.get(code)
  }

  /** A playing voice holds its buffer (not evicted until released). */
  retain(id: string): void {
    const e = this.cache.get(id)
    if (e) e.pins++
  }

  release(id: string): void {
    const e = this.cache.get(id)
    if (e && e.pins > 0) e.pins--
    this.evict()
  }

  stats(): { cached: number; bytes: number; loading: number; failed: number } {
    return { cached: this.cache.size, bytes: this.bytesValue, loading: this.loading.size, failed: this.failed.size }
  }

  private put(id: string, buffer: SoundBuffer): void {
    const old = this.cache.get(id)
    if (old) this.bytesValue -= old.buffer.bytes
    this.cache.set(id, { buffer, pins: old?.pins ?? 0 })
    this.bytesValue += buffer.bytes
    this.evict()
  }

  /** Drops the least recently used unpinned buffers until the cache fits its budget. */
  private evict(): void {
    if (this.bytesValue <= this.budget) return
    for (const [id, e] of this.cache) {
      if (this.bytesValue <= this.budget) break
      if (e.pins > 0) continue
      this.cache.delete(id)
      this.bytesValue -= e.buffer.bytes
    }
  }

  /** Runs `task` when fewer than maxFetches are running. */
  private limited<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.active++
        task().then(resolve, reject).finally(() => {
          this.active--
          this.queue.shift()?.()
        })
      }
      if (this.active < this.maxFetches) run()
      else this.queue.push(run)
    })
  }
}

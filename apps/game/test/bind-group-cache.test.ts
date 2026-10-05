/**
 * The 2026-10-05 black screen's leak: Babylon's WebGPU bind-group cache (WebGPUCacheBindGroups) is a global tree that
 * keeps an entry for every bind group ever made, so a grinding session's hit and drop effects grew the JS heap by ~65 MB
 * a minute. engine.ts trimBindGroupCache starts it over at BIND_GROUP_CACHE_LIMIT. These pin the Babylon internals it
 * relies on (a Babylon upgrade that renames them fails here instead of silently leaking again).
 */
import { NullEngine } from '@babylonjs/core'
import { WebGPUCacheBindGroups } from '@babylonjs/core/Engines/WebGPU/webgpuCacheBindGroups.js'
import { afterEach, describe, expect, it } from 'vitest'
import { BIND_GROUP_CACHE_LIMIT, trimBindGroupCache } from '../src/engine.ts'

type CacheStatics = { NumBindGroupsCreatedTotal: number; _Cache: { values: Record<number, unknown> } }
const statics = WebGPUCacheBindGroups as unknown as CacheStatics

afterEach(() => WebGPUCacheBindGroups.ResetCache())

/** A NullEngine carrying a real WebGPUCacheBindGroups where the WebGPU engine keeps it. */
function engineWithCache(): NullEngine {
  const engine = new NullEngine()
  ;(engine as unknown as { _cacheBindGroups: WebGPUCacheBindGroups })._cacheBindGroups = new WebGPUCacheBindGroups(null as never, null as never, engine as never)
  return engine
}

describe('trimBindGroupCache', () => {
  it('starts Babylon\'s bind-group cache over once it has made `limit` bind groups, and not before', () => {
    const engine = engineWithCache()
    const off = trimBindGroupCache(engine, 100)
    statics._Cache.values[123] = { values: {} }
    statics.NumBindGroupsCreatedTotal = 99
    engine.onEndFrameObservable.notifyObservers(engine)
    expect(statics._Cache.values[123]).toBeDefined()
    statics.NumBindGroupsCreatedTotal = 100
    engine.onEndFrameObservable.notifyObservers(engine)
    expect(statics._Cache.values[123]).toBeUndefined()
    expect(statics.NumBindGroupsCreatedTotal).toBe(0)
    // Removed: the cache is left alone.
    off()
    statics._Cache.values[7] = { values: {} }
    statics.NumBindGroupsCreatedTotal = 1000
    engine.onEndFrameObservable.notifyObservers(engine)
    expect(statics._Cache.values[7]).toBeDefined()
    engine.dispose()
  })

  it('does nothing on an engine without the WebGPU cache (WebGL2)', () => {
    const engine = new NullEngine()
    const before = engine.onEndFrameObservable.observers.length
    trimBindGroupCache(engine)()
    expect(engine.onEndFrameObservable.observers.length).toBe(before)
    expect(BIND_GROUP_CACHE_LIMIT).toBeGreaterThan(1000)
    engine.dispose()
  })
})

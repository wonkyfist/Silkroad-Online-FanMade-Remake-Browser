/**
 * The 2026-10-05 black screen: a lost graphics device (WebGPU device.lost, a WebGL context that never comes back) must
 * never leave the game silently black. gpu-loss.ts reloads straight back into the world (net/resume.ts), keeps
 * Babylon's broken in-place WebGPU restore off, moves a tab that keeps losing its device to WebGL2 and stops reloading
 * after a loop.
 */
import { NullEngine, Observable, type AbstractEngine } from '@babylonjs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '../src/app.ts'
import {
  GpuLossGuard,
  LOOP_LIMIT,
  LOSSES_KEY,
  RECOVER_KEY,
  RECOVER_TTL_MS,
  RELOAD_DELAY_MS,
  REPEAT_WINDOW_MS,
  WEBGL_KEY,
  WEBGL_RESTORE_MS,
  planRecovery,
  takeGpuRecovery,
  webglAfterLoss,
  type GpuLossDeps,
  type LossStorage,
} from '../src/gpu-loss.ts'
import { MockServer, type KeyValueStore } from '../src/net/mock.ts'
import { resumeSession, saveSession } from '../src/net/resume.ts'
import { Session } from '../src/net/session.ts'

function storage(): LossStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: k => void map.delete(k) }
}

/** A WebGPU engine as the guard sees it: Babylon's device (its `lost` promise) and the restore it turns off. */
function fakeWebGPU() {
  let lose!: (info: { reason: string; message: string }) => void
  const lost = new Promise<{ reason: string; message: string }>(r => (lose = r))
  const restore = vi.fn()
  const engine = {
    isDisposed: false,
    _device: { lost },
    _restoreEngineAfterContextLost: restore,
    onContextLostObservable: new Observable<AbstractEngine>(),
    onContextRestoredObservable: new Observable<AbstractEngine>(),
  }
  return { engine, lose, restore }
}

const TEXT = { restoring: 'restoring', reloading: 'reloading', reloadingWebgl: 'webgl', stopped: 'stopped' }

function deps(engine: unknown, kind: GpuLossDeps['kind'], store: LossStorage, character: number | null = 7) {
  const d = {
    engine: engine as AbstractEngine,
    kind,
    storage: store,
    character: vi.fn(() => character),
    notice: vi.fn<(text: string, reload?: () => void) => void>(),
    hideNotice: vi.fn(),
    reload: vi.fn(),
    text: TEXT,
  }
  return d
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('planRecovery', () => {
  const now = 10_000_000
  it('reloads on a first loss, moves WebGPU to WebGL2 on a repeat, stops after a loop', () => {
    expect(planRecovery([now], now, 'WebGPU')).toBe('reload')
    expect(planRecovery([now - REPEAT_WINDOW_MS + 1000, now], now, 'WebGPU')).toBe('reload-webgl')
    expect(planRecovery([now - REPEAT_WINDOW_MS - 1000, now], now, 'WebGPU')).toBe('reload')
    // WebGL2 has nothing to fall back to: it keeps reloading until the loop guard.
    expect(planRecovery([now - 60_000, now], now, 'WebGL2')).toBe('reload')
    const loop = Array.from({ length: LOOP_LIMIT }, (_, i) => now - i * 60_000)
    expect(planRecovery(loop, now, 'WebGPU')).toBe('stop')
    expect(planRecovery(loop, now, 'WebGL2')).toBe('stop')
  })
})

describe('GpuLossGuard on WebGPU', () => {
  it('a lost device: Babylon\'s restore stays off, the notice shows, the world character is kept and the page reloads once', async () => {
    const store = storage()
    const { engine, lose, restore } = fakeWebGPU()
    const d = deps(engine, 'WebGPU', store)
    const guard = new GpuLossGuard(d)
    // Babylon's own restore (which rebuilds on the dead device) is replaced by a no-op: the render loop stays paused.
    expect(engine._restoreEngineAfterContextLost).not.toBe(restore)
    const init = vi.fn()
    engine._restoreEngineAfterContextLost(init)
    expect(init).not.toHaveBeenCalled()

    lose({ reason: 'unknown', message: 'GPU process crashed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(guard.state).toBe('reloading')
    expect(d.notice).toHaveBeenCalledWith('reloading')
    expect(guard.history[0]).toMatchObject({ kind: 'WebGPU', reason: 'unknown', message: 'GPU process crashed', plan: 'reload' })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unknown: GPU process crashed'))
    expect(JSON.parse(store.map.get(RECOVER_KEY)!)).toMatchObject({ characterId: 7, reason: 'unknown: GPU process crashed' })
    expect(JSON.parse(store.map.get(LOSSES_KEY)!)).toHaveLength(1)
    expect(store.map.has(WEBGL_KEY)).toBe(false)

    // A second event for the same loss (the observable, a console call) does not start another recovery.
    guard.lost({ kind: 'WebGPU', reason: 'unknown', message: 'again' })
    expect(d.reload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS)
    expect(d.reload).toHaveBeenCalledTimes(1)
    expect(d.notice).toHaveBeenCalledTimes(1)
    expect(JSON.parse(store.map.get(LOSSES_KEY)!)).toHaveLength(1)
    guard.dispose()
  })

  it('a second loss in the same tab reloads on WebGL2; a loop stops with a Reload button instead', async () => {
    const store = storage()
    const run = async () => {
      const { engine, lose } = fakeWebGPU()
      const d = deps(engine, 'WebGPU', store)
      const guard = new GpuLossGuard(d)
      lose({ reason: 'unknown', message: '' })
      await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS)
      guard.dispose()
      return { d, guard }
    }
    expect((await run()).guard.history[0]!.plan).toBe('reload')
    expect(webglAfterLoss(store)).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    const second = await run()
    expect(second.guard.history[0]!.plan).toBe('reload-webgl')
    expect(second.d.notice).toHaveBeenCalledWith('webgl')
    expect(second.d.reload).toHaveBeenCalledTimes(1)
    expect(webglAfterLoss(store)).toBe(true)
    for (let i = 2; i < LOOP_LIMIT - 1; i++) await run()
    const last = await run()
    expect(last.guard.state).toBe('stopped')
    expect(last.d.reload).not.toHaveBeenCalled()
    const [text, reload] = last.d.notice.mock.calls[0]!
    expect(text).toBe('stopped')
    reload!()
    expect(last.d.reload).toHaveBeenCalledTimes(1)
  })

  it('off the world screen nothing is kept to re-enter; a disposed engine is ignored', async () => {
    const store = storage()
    const { engine, lose } = fakeWebGPU()
    const d = deps(engine, 'WebGPU', store, null)
    new GpuLossGuard(d)
    lose({ reason: 'unknown', message: '' })
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS)
    expect(store.map.has(RECOVER_KEY)).toBe(false)
    expect(d.reload).toHaveBeenCalledTimes(1)

    const other = fakeWebGPU()
    const d2 = deps(other.engine, 'WebGPU', storage())
    new GpuLossGuard(d2)
    other.engine.isDisposed = true
    other.lose({ reason: 'destroyed', message: '' })
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS)
    expect(d2.notice).not.toHaveBeenCalled()
    expect(d2.reload).not.toHaveBeenCalled()
  })
})

describe('GpuLossGuard on WebGL2', () => {
  it('a context Babylon restores in place: the notice comes and goes, no reload', async () => {
    const engine = new NullEngine()
    const before = [engine.onContextLostObservable.observers.length, engine.onContextRestoredObservable.observers.length]
    const d = deps(engine, 'WebGL2', storage())
    const guard = new GpuLossGuard(d)
    engine.onContextLostObservable.notifyObservers(engine)
    expect(guard.state).toBe('waiting')
    expect(d.notice).toHaveBeenCalledWith('restoring')
    engine.onContextRestoredObservable.notifyObservers(engine)
    expect(guard.state).toBe('ok')
    expect(d.hideNotice).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(WEBGL_RESTORE_MS + RELOAD_DELAY_MS)
    expect(d.reload).not.toHaveBeenCalled()
    guard.dispose()
    expect([engine.onContextLostObservable.observers.length, engine.onContextRestoredObservable.observers.length]).toEqual(before)
    engine.dispose()
  })

  it('a context that never comes back reloads into the world', async () => {
    const engine = new NullEngine()
    const store = storage()
    const d = deps(engine, 'WebGL2', store)
    const guard = new GpuLossGuard(d)
    engine.onContextLostObservable.notifyObservers(engine)
    engine.onContextLostObservable.notifyObservers(engine)
    await vi.advanceTimersByTimeAsync(WEBGL_RESTORE_MS)
    expect(guard.state).toBe('reloading')
    expect(d.notice).toHaveBeenLastCalledWith('reloading')
    expect(JSON.parse(store.map.get(RECOVER_KEY)!).characterId).toBe(7)
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS)
    expect(d.reload).toHaveBeenCalledTimes(1)
    // A late restore after the reload was decided changes nothing.
    engine.onContextRestoredObservable.notifyObservers(engine)
    expect(guard.state).toBe('reloading')
    guard.dispose()
    engine.dispose()
  })
})

describe('takeGpuRecovery', () => {
  it('hands the record out once, and only while it is fresh and well-formed', () => {
    const store = storage()
    const now = 50_000_000
    store.setItem(RECOVER_KEY, JSON.stringify({ characterId: 3, at: now - 1000, reason: 'unknown' }))
    expect(takeGpuRecovery(now, store)).toEqual({ characterId: 3, at: now - 1000, reason: 'unknown' })
    expect(takeGpuRecovery(now, store)).toBeNull()
    store.setItem(RECOVER_KEY, JSON.stringify({ characterId: 3, at: now - RECOVER_TTL_MS - 1 }))
    expect(takeGpuRecovery(now, store)).toBeNull()
    store.setItem(RECOVER_KEY, '{nope')
    expect(takeGpuRecovery(now, store)).toBeNull()
    const blocked: LossStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(takeGpuRecovery(now, blocked)).toBeNull()
    expect(webglAfterLoss(blocked)).toBe(false)
  })
})

describe('the reload after a loss', () => {
  it('resumes the saved session straight into the world with the same character', async () => {
    vi.useRealTimers()
    const store = storage()
    vi.stubGlobal('sessionStorage', store)
    const memory: KeyValueStore = { getItem: k => store.map.get(`db:${k}`) ?? null, setItem: (k, v) => void store.map.set(`db:${k}`, v) }
    const server = new MockServer(memory, 0)
    await server.register({ username: 'carol', password: 'secret' })
    const { token, expiresAt } = await server.login({ username: 'carol', password: 'secret' })
    const setup = new Session(() => server.wire(), token)
    await setup.connect()
    const { character } = await setup.request({ t: 'charCreate', name: 'Grinder', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' }, ['charCreated'])
    setup.close('logout')

    const go = vi.fn(async () => {})
    const toast = vi.fn()
    const app = { transport: { mock: true, api: server, wire: () => server.wire() }, go, toast, setSession: vi.fn(), token: '', username: '', tokenExpiresAt: 0 }
    saveSession({ token, username: 'carol', expiresAt }, true, store)
    store.setItem(RECOVER_KEY, JSON.stringify({ characterId: character.id, at: Date.now(), reason: 'unknown' }))
    expect(await resumeSession(app as unknown as App)).toBe(true)
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith('world', { character: expect.objectContaining({ id: character.id, name: 'Grinder' }) })
    expect(toast).toHaveBeenCalledTimes(1)
    expect(store.map.has(RECOVER_KEY)).toBe(false)

    // Without a record (a plain refresh) the resume lands on character select as before.
    go.mockClear()
    expect(await resumeSession(app as unknown as App)).toBe(true)
    expect(go).toHaveBeenCalledWith('charselect')
  })
})

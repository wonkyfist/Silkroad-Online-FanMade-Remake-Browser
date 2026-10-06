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
  REASON_BLACK,
  REASON_MODE,
  REASON_RELOAD,
  SWITCHED_KEY,
  clearWebglFallback,
  engineChoice,
  graphicsModeRows,
  recoveryToast,
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

const TEXT = { restoring: 'restoring', reloading: 'reloading', reloadingWebgl: 'webgl', stopped: 'stopped', blackWebgl: 'black' }

function deps(engine: unknown, kind: GpuLossDeps['kind'], store: LossStorage, character: number | null = 7) {
  const d = {
    engine: engine as AbstractEngine,
    kind,
    storage: store,
    character: vi.fn(() => character),
    notice: vi.fn<(text: string, reload?: () => void) => void>(),
    hideNotice: vi.fn(),
    help: vi.fn(),
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
  it('moves WebGPU to WebGL2 on the first loss, reloads WebGL2 in place, stops after a loop', () => {
    // After a GPU-process crash Chrome's WebGPU output is often unusable: the first loss already goes to WebGL2.
    expect(planRecovery([now], now, 'WebGPU')).toBe('reload-webgl')
    expect(planRecovery([now - REPEAT_WINDOW_MS + 1000, now], now, 'WebGPU')).toBe('reload-webgl')
    // WebGL2 has nothing to fall back to: it keeps reloading until the loop guard.
    expect(planRecovery([now], now, 'WebGL2')).toBe('reload')
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
    expect(d.notice).toHaveBeenCalledWith('webgl')
    expect(guard.history[0]).toMatchObject({ kind: 'WebGPU', reason: 'unknown', message: 'GPU process crashed', plan: 'reload-webgl' })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unknown: GPU process crashed'))
    expect(JSON.parse(store.map.get(RECOVER_KEY)!)).toMatchObject({ characterId: 7, reason: 'unknown: GPU process crashed' })
    expect(JSON.parse(store.map.get(LOSSES_KEY)!)).toHaveLength(1)
    // The tab boots on WebGL2 from now on (session scoped: sessionStorage).
    expect(webglAfterLoss(store)).toBe(true)

    // A second event for the same loss (the observable, a console call) does not start another recovery.
    guard.lost({ kind: 'WebGPU', reason: 'unknown', message: 'again' })
    expect(d.reload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS)
    expect(d.reload).toHaveBeenCalledTimes(1)
    expect(d.notice).toHaveBeenCalledTimes(1)
    expect(JSON.parse(store.map.get(LOSSES_KEY)!)).toHaveLength(1)
    guard.dispose()
  })

  it('the first loss in a tab reloads on WebGL2; a loop stops with a Reload button instead', async () => {
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
    expect(webglAfterLoss(store)).toBe(false)
    const first = await run()
    expect(first.guard.history[0]!.plan).toBe('reload-webgl')
    expect(first.d.notice).toHaveBeenCalledWith('webgl')
    expect(first.d.reload).toHaveBeenCalledTimes(1)
    expect(webglAfterLoss(store)).toBe(true)
    // Another tab (its own sessionStorage) still starts on WebGPU.
    expect(webglAfterLoss(storage())).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    for (let i = 1; i < LOOP_LIMIT - 1; i++) await run()
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

describe('black output (gpu-watchdog.ts → GpuLossGuard.blackOutput)', () => {
  it('WebGPU: reloads into the world on WebGL2 once per tab session, then only shows the help', async () => {
    const store = storage()
    const { engine } = fakeWebGPU()
    const d = deps(engine, 'WebGPU', store)
    const guard = new GpuLossGuard(d)
    expect(guard.blackOutput('3 empty samples')).toBe('reload-webgl')
    expect(guard.state).toBe('reloading')
    expect(d.notice).toHaveBeenCalledWith('black')
    expect(webglAfterLoss(store)).toBe(true)
    expect(store.map.get(SWITCHED_KEY)).toBe('true')
    const rec = JSON.parse(store.map.get(RECOVER_KEY)!)
    expect(rec).toMatchObject({ characterId: 7 })
    expect(recoveryToast(rec)).toBe('gpu.blackRestored')
    // A second verdict while the reload is pending does nothing.
    expect(guard.blackOutput('again')).toBe('ignored')
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS)
    expect(d.reload).toHaveBeenCalledTimes(1)
    expect(d.help).not.toHaveBeenCalled()
    guard.dispose()

    // The player picks a mode in Options (the tab's fallback is cleared) and WebGPU is black again: no second switch.
    clearWebglFallback(store)
    expect(webglAfterLoss(store)).toBe(false)
    const again = fakeWebGPU()
    const d2 = deps(again.engine, 'WebGPU', store)
    const guard2 = new GpuLossGuard(d2)
    expect(guard2.switched).toBe(true)
    expect(guard2.blackOutput('3 empty samples')).toBe('help')
    expect(d2.help).toHaveBeenCalledTimes(1)
    expect(d2.reload).not.toHaveBeenCalled()
    expect(webglAfterLoss(store)).toBe(false)
    expect(guard2.state).toBe('ok')
    guard2.dispose()
  })

  it('WebGL2 black too: the help, never a reload loop', async () => {
    const engine = new NullEngine()
    const store = storage()
    const d = deps(engine, 'WebGL2', store)
    const guard = new GpuLossGuard(d)
    expect(guard.blackOutput('3 black samples')).toBe('help')
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS * 2)
    expect(d.help).toHaveBeenCalledTimes(1)
    expect(d.reload).not.toHaveBeenCalled()
    expect(store.map.has(RECOVER_KEY)).toBe(false)
    // A lost device still recovers as before.
    expect(guard.state).toBe('ok')
    guard.dispose()
    engine.dispose()
  })

  it('the help\'s compatibility button and Options → Reload now go back into the world', () => {
    const store = storage()
    const { engine } = fakeWebGPU()
    const d = deps(engine, 'WebGPU', store)
    new GpuLossGuard(d).switchToWebgl()
    expect(d.reload).toHaveBeenCalledTimes(1)
    expect(webglAfterLoss(store)).toBe(true)
    // A manual switch is not the automatic one: black output may still switch once later.
    expect(store.map.has(SWITCHED_KEY)).toBe(false)
    expect(recoveryToast(JSON.parse(store.map.get(RECOVER_KEY)!))).toBe('gpu.modeApplied')

    const store2 = storage()
    const d2 = deps(fakeWebGPU().engine, 'WebGPU', store2)
    const g2 = new GpuLossGuard(d2)
    g2.reloadIntoWorld(REASON_RELOAD)
    g2.reloadIntoWorld(REASON_RELOAD)
    expect(d2.reload).toHaveBeenCalledTimes(1)
    expect(webglAfterLoss(store2)).toBe(false)
    expect(recoveryToast(JSON.parse(store2.map.get(RECOVER_KEY)!))).toBe('gpu.reloaded')
    expect(recoveryToast({ reason: 'unknown: GPU process crashed' })).toBe('gpu.restored')
    expect(recoveryToast({ reason: `${REASON_BLACK}: 3 empty samples` })).toBe('gpu.blackRestored')
    expect(recoveryToast({ reason: REASON_MODE })).toBe('gpu.modeApplied')
  })
})

describe('engineChoice (main.ts): ?engine=webgl > Options → Graphics mode WebGL2 > the tab fallback > WebGPU', () => {
  it('picks the engine and says why', () => {
    expect(engineChoice(true, 'webgpu', false)).toEqual({ webgpu: false, avoidSoftware: false, why: 'param' })
    expect(engineChoice(true, 'auto', true)).toMatchObject({ webgpu: false, why: 'param' })
    expect(engineChoice(false, 'webgl2', false)).toEqual({ webgpu: false, avoidSoftware: false, why: 'setting' })
    expect(engineChoice(false, 'webgl2', true)).toMatchObject({ webgpu: false, why: 'setting' })
    expect(engineChoice(false, 'auto', true)).toEqual({ webgpu: false, avoidSoftware: false, why: 'fallback' })
    expect(engineChoice(false, 'webgpu', true)).toMatchObject({ webgpu: false, why: 'fallback' })
    // 'auto' runs WebGL2 on a software WebGPU adapter; a pinned WebGPU is the player's call.
    expect(engineChoice(false, 'auto', false)).toEqual({ webgpu: true, avoidSoftware: true, why: 'auto' })
    expect(engineChoice(false, 'webgpu', false)).toEqual({ webgpu: true, avoidSoftware: false, why: 'setting' })
  })

  it('the fallback lives in the tab\'s storage and survives a blocked one', () => {
    const store = storage()
    store.setItem(WEBGL_KEY, 'true')
    expect(engineChoice(false, 'auto', webglAfterLoss(store)).why).toBe('fallback')
    clearWebglFallback(store)
    expect(engineChoice(false, 'auto', webglAfterLoss(store)).why).toBe('auto')
    const blocked: LossStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => clearWebglFallback(blocked)).not.toThrow()
    expect(webglAfterLoss(blocked)).toBe(false)
  })
})

describe('Options → Graphics → Graphics mode (graphicsModeRows)', () => {
  it('stores the mode, clears the tab fallback, offers a reload; notes the fallback and a pending change', async () => {
    const { defaultSettings, patchedSettings } = await import('../src/settings.ts')
    const store = storage()
    store.setItem(WEBGL_KEY, 'true')
    let booted = { kind: 'WebGL2' as const, backend: 'auto' as const, why: 'fallback' as 'fallback' | 'auto' }
    let answer = true
    const reload = vi.fn()
    const rows = graphicsModeRows({ booted: () => booted, ask: async () => answer, reload, storage: store })
    const [select, fallback, pending] = rows
    expect(select).toMatchObject({ id: 'graphics.backend', kind: 'choice' })
    if (select!.kind !== 'choice') throw new Error('not a choice row')
    expect(select.choices.map(c => c.value)).toEqual(['auto', 'webgpu', 'webgl2'])
    const s = defaultSettings()
    expect(select.get(s)).toBe('auto')
    const next = patchedSettings(s, select.patch('webgl2'))
    expect(next.graphics.backend).toBe('webgl2')
    expect(fallback!.when!(s)).toBe(true)
    select.after!(next)
    await vi.advanceTimersByTimeAsync(0)
    expect(webglAfterLoss(store)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
    answer = false
    select.after!(next)
    await vi.advanceTimersByTimeAsync(0)
    expect(reload).toHaveBeenCalledTimes(1)
    booted = { kind: 'WebGL2', backend: 'auto', why: 'auto' }
    expect(fallback!.when!(s)).toBe(false)
    expect(pending!.when!(s)).toBe(false)
    expect(pending!.when!(next)).toBe(true)
  })
})

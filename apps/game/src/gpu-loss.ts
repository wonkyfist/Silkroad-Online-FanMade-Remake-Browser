/**
 * Graphics device loss (the 2026-10-05 black screen: a long grinding session in Chrome on WebGPU, then the 3D view black
 * for good while the HTML HUD kept working).
 *
 * WebGPU: Chrome loses the device when its GPU process crashes, runs out of memory or the driver resets (TDR). Babylon
 * 9.28 then "restores" it in place, and that restore cannot work: it rebuilds every buffer, texture and pipeline before
 * the new device exists (AbstractEngine._restoreEngineAfterContextLost does not await WebGPU's async initAsync), logs
 * "context successfully restored", and every later frame draws with objects of the dead device. Waiting for the new
 * device first is not enough either (measured: geometry buffers of the old device stay referenced, and the world's raw
 * texture arrays and compute resources have no CPU copy). So on WebGPU the engine stays paused after a loss and the
 * page reloads straight back into the same character (net/resume.ts, screens/charselect.ts: takeGpuRecovery).
 *
 * WebGL2: Babylon restores a lost context in place (the world re-streams on the PBR path, World.onContextRestored), so
 * the guard only waits; a context that has not come back after WEBGL_RESTORE_MS is reloaded the same way.
 *
 * Repeated losses: a second loss within REPEAT_WINDOW_MS reloads on WebGL2 for the rest of the tab (sessionStorage);
 * LOOP_LIMIT losses within LOOP_WINDOW_MS stop the automatic reloads and leave a notice with a Reload button.
 */
import type { AbstractEngine, Observer } from '@babylonjs/core'
import type { App, ScreenParams } from './app.ts'
import type { EngineKind } from './engine.ts'
import { t } from './i18n/index.ts'
import { el } from './ui/dom.ts'
import { button } from './ui/kit/button.ts'

/** The part of Storage used here (tests pass a map, or one that throws). */
export interface LossStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Times (ms since epoch) of this tab's recent losses. */
export const LOSSES_KEY = 'sro.gpu.losses'
/** Set after repeated WebGPU losses: the tab boots on WebGL2 (main.ts). */
export const WEBGL_KEY = 'sro.gpu.webgl'
/** The character to re-enter after the reload ({ characterId, at, reason }). */
export const RECOVER_KEY = 'sro.gpu.recover'

/** Losses this close together count as repeated: the reload goes to WebGL2. */
export const REPEAT_WINDOW_MS = 30 * 60_000
/** This many losses within LOOP_WINDOW_MS stop the automatic reloads. */
export const LOOP_LIMIT = 4
export const LOOP_WINDOW_MS = 10 * 60_000
/** A lost WebGL context Babylon has not restored after this long is reloaded. */
export const WEBGL_RESTORE_MS = 6000
/** The notice shows this long before the reload. */
export const RELOAD_DELAY_MS = 1500
/** A recovery record older than this is ignored (a later manual reload, a restored tab). */
export const RECOVER_TTL_MS = 120_000

export type RecoveryPlan = 'reload' | 'reload-webgl' | 'stop'

export interface GpuLoss {
  kind: EngineKind
  /** GPUDeviceLostInfo.reason ('unknown' for a crash or reset, 'destroyed'), or 'webglcontextlost'. */
  reason: string
  /** GPUDeviceLostInfo.message (Chrome's explanation), '' when none. */
  message: string
}

export interface GpuRecovery {
  characterId: number
  at: number
  reason: string
}

/** What to do about a loss, given this tab's earlier losses (`losses` includes the new one). */
export function planRecovery(losses: readonly number[], now: number, kind: EngineKind): RecoveryPlan {
  if (losses.filter(t => now - t <= LOOP_WINDOW_MS).length >= LOOP_LIMIT) return 'stop'
  if (kind === 'WebGPU' && losses.filter(t => now - t <= REPEAT_WINDOW_MS).length >= 2) return 'reload-webgl'
  return 'reload'
}

function read<T>(storage: LossStorage | null, key: string): T | null {
  try {
    const text = storage?.getItem(key)
    return text ? (JSON.parse(text) as T) : null
  } catch {
    return null
  }
}

function write(storage: LossStorage | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    // storage blocked or full: the reload still happens, it just cannot remember
  }
}

/** sessionStorage, or null when it is blocked. */
export function tabStorage(): LossStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** True when an earlier loss in this tab asked for WebGL2 (main.ts boots on it). */
export function webglAfterLoss(storage: LossStorage | null = tabStorage()): boolean {
  return read<boolean>(storage, WEBGL_KEY) === true
}

/** The character to re-enter after a loss reload, once (the record is removed); null when none or too old. */
export function takeGpuRecovery(now = Date.now(), storage: LossStorage | null = tabStorage()): GpuRecovery | null {
  const r = read<Partial<GpuRecovery>>(storage, RECOVER_KEY)
  try {
    storage?.removeItem(RECOVER_KEY)
  } catch {
    // nothing to remove
  }
  if (!r || typeof r.characterId !== 'number' || typeof r.at !== 'number' || now - r.at > RECOVER_TTL_MS || r.at > now + 5000) return null
  return { characterId: r.characterId, at: r.at, reason: typeof r.reason === 'string' ? r.reason : '' }
}

export interface GpuLossDeps {
  engine: AbstractEngine
  kind: EngineKind
  storage: LossStorage | null
  /** The character in the world now (the reload goes straight back to it); null on the other screens. */
  character(): number | null
  /** Shows (or replaces) the on-screen notice; `reload` adds a button that reloads now. */
  notice(text: string, reload?: () => void): void
  hideNotice(): void
  /** Reloads the page. */
  reload(): void
  /** The notice texts (i18n in the game; tests pass their own). */
  text: { restoring: string; reloading: string; reloadingWebgl: string; stopped: string }
  now?: () => number
}

type Phase = 'ok' | 'waiting' | 'reloading' | 'stopped'

/**
 * Watches the engine for a lost device or context and recovers (see the header). One loss leads to one recovery:
 * repeated lost events (Babylon's observable and the device's promise, a context lost twice) are ignored meanwhile.
 */
export class GpuLossGuard {
  private phase: Phase = 'ok'
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly observers: Observer<AbstractEngine>[] = []
  private readonly now: () => number
  /** Every loss handled, newest last (debugging: `window.__sroGpuLoss`). */
  readonly history: (GpuLoss & { at: number; plan: RecoveryPlan | 'wait' })[] = []

  constructor(private readonly deps: GpuLossDeps) {
    this.now = deps.now ?? Date.now
    const e = deps.engine
    if (deps.kind === 'WebGPU') {
      holdAfterDeviceLoss(e)
      deviceOf(e)?.lost?.then(
        info => this.lost({ kind: 'WebGPU', reason: info?.reason ?? 'unknown', message: info?.message ?? '' }),
        () => {},
      )
    } else {
      this.observers.push(e.onContextLostObservable.add(() => this.lost({ kind: deps.kind, reason: 'webglcontextlost', message: '' })))
      this.observers.push(e.onContextRestoredObservable.add(() => this.restored()))
    }
  }

  get state(): Phase {
    return this.phase
  }

  /** A loss (exposed for the guard's tests and the console: `__sroGpuLoss.lost(...)`). */
  lost(loss: GpuLoss): void {
    if (this.deps.engine.isDisposed || this.phase !== 'ok') return
    const at = this.now()
    const detail = loss.message ? `${loss.reason}: ${loss.message}` : loss.reason
    if (loss.kind !== 'WebGPU') {
      // Babylon restores a WebGL context by itself; reload only if it does not come back.
      this.phase = 'waiting'
      this.history.push({ ...loss, at, plan: 'wait' })
      console.error(`[gpu] ${loss.kind} context lost (${detail}); waiting ${WEBGL_RESTORE_MS} ms for the browser to restore it`)
      this.deps.notice(this.deps.text.restoring)
      this.timer = setTimeout(() => {
        this.timer = null
        if (this.phase !== 'waiting') return
        this.phase = 'ok'
        this.recover({ ...loss, message: loss.message || 'not restored' }, this.now())
      }, WEBGL_RESTORE_MS)
      return
    }
    this.recover(loss, at)
  }

  private recover(loss: GpuLoss, at: number): void {
    const losses = [...(read<number[]>(this.deps.storage, LOSSES_KEY) ?? []).filter(t => typeof t === 'number' && at - t <= REPEAT_WINDOW_MS), at]
    write(this.deps.storage, LOSSES_KEY, losses)
    const plan = planRecovery(losses, at, loss.kind)
    this.history.push({ ...loss, at, plan })
    const detail = loss.message ? `${loss.reason}: ${loss.message}` : loss.reason
    console.error(`[gpu] ${loss.kind} device lost (${detail}); loss ${losses.length} in this tab's last ${REPEAT_WINDOW_MS / 60_000} min; ${plan}`)
    const reloadNow = () => this.deps.reload()
    if (plan === 'stop') {
      this.phase = 'stopped'
      this.deps.notice(this.deps.text.stopped, reloadNow)
      return
    }
    this.phase = 'reloading'
    if (plan === 'reload-webgl') write(this.deps.storage, WEBGL_KEY, true)
    const characterId = this.deps.character()
    if (characterId !== null) write(this.deps.storage, RECOVER_KEY, { characterId, at, reason: detail } satisfies GpuRecovery)
    this.deps.notice(plan === 'reload-webgl' ? this.deps.text.reloadingWebgl : this.deps.text.reloading)
    this.timer = setTimeout(() => {
      this.timer = null
      this.deps.reload()
    }, RELOAD_DELAY_MS)
  }

  private restored(): void {
    if (this.phase !== 'waiting') return
    this.phase = 'ok'
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    console.info(`[gpu] ${this.deps.kind} context restored in place`)
    this.deps.hideNotice()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const o of this.observers) o.remove()
    this.observers.length = 0
  }
}

/** The part of a GPUDevice the guard reads. */
interface DeviceLike {
  lost?: Promise<{ reason?: string; message?: string } | undefined>
}

/** Babylon's GPUDevice (internal field; null on WebGL). */
function deviceOf(engine: AbstractEngine): DeviceLike | null {
  return (engine as unknown as { _device?: DeviceLike })._device ?? null
}

/**
 * Turns off Babylon's in-place WebGPU restore (see the header): the engine keeps `_contextWasLost`, so its render loop
 * stays paused (no frames against the dead device, no validation-error flood) until the page reloads.
 */
export function holdAfterDeviceLoss(engine: AbstractEngine): void {
  ;(engine as unknown as { _restoreEngineAfterContextLost(init: () => unknown): void })._restoreEngineAfterContextLost = () => {}
}

/** The game's guard (main.ts): the notice over the canvas, a page reload, the world screen's character. */
export function installGpuLossGuard(app: App, kind: EngineKind): GpuLossGuard {
  let box: HTMLElement | null = null
  const guard = new GpuLossGuard({
    engine: app.engine,
    kind,
    storage: tabStorage(),
    character: () => (app.current === 'world' ? ((app.currentParams as ScreenParams['world'] | undefined)?.character.id ?? null) : null),
    notice: (text, reload) => {
      box ??= document.body.appendChild(el('div', 'gpu-notice'))
      box.replaceChildren(el('div', '', text))
      if (reload) {
        box.append(button(app.art, { label: t('gpu.reload'), primary: true }, () => reload()))
      }
    },
    hideNotice: () => {
      box?.remove()
      box = null
    },
    reload: () => location.reload(),
    text: { restoring: t('gpu.restoring'), reloading: t('gpu.reloading'), reloadingWebgl: t('gpu.reloadingWebgl'), stopped: t('gpu.stopped') },
  })
  ;(window as unknown as { __sroGpuLoss?: GpuLossGuard }).__sroGpuLoss = guard
  return guard
}

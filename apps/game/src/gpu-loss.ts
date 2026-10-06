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
 * Where the reload goes: the first WebGPU loss already reloads on WebGL2 for the rest of the tab (sessionStorage
 * WEBGL_KEY): after a GPU-process crash Chrome's WebGPU output is often unusable (the 2026-10-05 incident, second
 * part). LOOP_LIMIT losses within LOOP_WINDOW_MS stop the automatic reloads and leave a notice with a Reload button.
 *
 * Black output (gpu-watchdog.ts): a 3D view that renders nothing without any loss event. `blackOutput` moves a WebGPU
 * tab to WebGL2 once per tab session (SWITCHED_KEY); after that, or on WebGL2, it shows the "3D view is black" help
 * (gpu-help.ts: another browser, or ending Chrome's GPU process). The same help is in the Esc menu and on the login
 * screen for the case no page can detect (Chrome's compositor dropping a correctly drawn canvas).
 *
 * Which engine a load starts (`engineChoice`, main.ts): `?engine=webgl` > Options → Graphics mode WebGL2 > this tab's
 * fallback > WebGPU ('auto' also skips a software WebGPU adapter). Changing the Options row clears the tab's fallback.
 */
import type { AbstractEngine, Observer } from '@babylonjs/core'
import type { App, ScreenParams } from './app.ts'
import type { EngineKind } from './engine.ts'
import { showGpuHelp } from './gpu-help.ts'
import { registerMenuItem } from './hud/menu-items.ts'
import { registerOptionRow, type OptionRow } from './hud/options.ts'
import { t, type StringKey } from './i18n/index.ts'
import { GRAPHICS_BACKENDS, type GraphicsBackend } from './settings.ts'
import { el } from './ui/dom.ts'
import { button } from './ui/kit/button.ts'
import { MessageBox } from './ui/kit/dialog.ts'

/** The part of Storage used here (tests pass a map, or one that throws). */
export interface LossStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Times (ms since epoch) of this tab's recent losses. */
export const LOSSES_KEY = 'sro.gpu.losses'
/** Set after a WebGPU loss or black output: the tab boots on WebGL2 (main.ts). */
export const WEBGL_KEY = 'sro.gpu.webgl'
/** Set once black output moved this tab to WebGL2: the watchdog never switches it again (no loops). */
export const SWITCHED_KEY = 'sro.gpu.switched'
/** The character to re-enter after the reload ({ characterId, at, reason }). */
export const RECOVER_KEY = 'sro.gpu.recover'

/** Losses older than this are forgotten. */
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

/** Recovery reasons that are not a device loss (the toast after the reload says what happened: `recoveryToast`). */
export const REASON_BLACK = 'black output'
export const REASON_MODE = 'graphics mode'
export const REASON_RELOAD = 'reload'

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
  // WebGL2 has nothing to fall back to; a lost WebGPU device goes to WebGL2 at once (see the header).
  return kind === 'WebGPU' ? 'reload-webgl' : 'reload'
}

/** Why a load runs the engine it runs (`engineChoice`). */
export type EngineWhy = 'param' | 'setting' | 'fallback' | 'auto'

export interface EngineChoice {
  /** Try WebGPU (createEngine still falls back to WebGL2 when it is missing or fails). */
  webgpu: boolean
  /** Run WebGL2 on a software or fallback WebGPU adapter ('auto' only: a pinned WebGPU is the player's call). */
  avoidSoftware: boolean
  why: EngineWhy
}

/** The engine of this load: `?engine=webgl`, then the Options row's WebGL2, then the tab's fallback, then WebGPU. */
export function engineChoice(webglParam: boolean, backend: GraphicsBackend, tabFallback: boolean): EngineChoice {
  if (webglParam) return { webgpu: false, avoidSoftware: false, why: 'param' }
  if (backend === 'webgl2') return { webgpu: false, avoidSoftware: false, why: 'setting' }
  if (tabFallback) return { webgpu: false, avoidSoftware: false, why: 'fallback' }
  return { webgpu: true, avoidSoftware: backend === 'auto', why: backend === 'auto' ? 'auto' : 'setting' }
}

/** What this load booted (main.ts), for the Options rows. */
export interface BootedEngine {
  kind: EngineKind
  backend: GraphicsBackend
  why: EngineWhy
}

let booted: BootedEngine | null = null

export function setBootedEngine(b: BootedEngine): void {
  booted = b
}

export function bootedEngine(): BootedEngine | null {
  return booted
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

/** True when a loss or black output in this tab asked for WebGL2 (main.ts boots on it). */
export function webglAfterLoss(storage: LossStorage | null = tabStorage()): boolean {
  return read<boolean>(storage, WEBGL_KEY) === true
}

/**
 * Forgets the tab's WebGL2 fallback (the player picked a graphics mode in Options: their choice applies on the next
 * load). SWITCHED_KEY stays: black output never switches this tab automatically again.
 */
export function clearWebglFallback(storage: LossStorage | null = tabStorage()): void {
  try {
    storage?.removeItem(WEBGL_KEY)
  } catch {
    // nothing to remove
  }
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

/** The toast after a recovery reload: a mode change, a black-output switch, the help's Reload, or a lost device. */
export function recoveryToast(r: Pick<GpuRecovery, 'reason'>): StringKey {
  if (r.reason === REASON_MODE) return 'gpu.modeApplied'
  if (r.reason.startsWith(REASON_BLACK)) return 'gpu.blackRestored'
  if (r.reason === REASON_RELOAD) return 'gpu.reloaded'
  return 'gpu.restored'
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
  /** Shows the "3D view is black" help (gpu-help.ts): black output that switching cannot fix. */
  help(): void
  /** Reloads the page. */
  reload(): void
  /** The notice texts (i18n in the game; tests pass their own). */
  text: { restoring: string; reloading: string; reloadingWebgl: string; stopped: string; blackWebgl: string }
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
  readonly history: (GpuLoss & { at: number; plan: RecoveryPlan | 'wait' | 'help' })[] = []

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

  /** True when black output already moved this tab to WebGL2 (it never switches automatically again). */
  get switched(): boolean {
    return read<boolean>(this.deps.storage, SWITCHED_KEY) === true
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

  /**
   * The 3D view renders nothing (gpu-watchdog.ts decided so): on WebGPU, once per tab session, reload into the world on
   * WebGL2 with a short notice; otherwise (WebGL2, or the tab already switched) show the help. Returns what it did.
   */
  blackOutput(detail: string): 'reload-webgl' | 'help' | 'ignored' {
    if (this.deps.engine.isDisposed || this.phase !== 'ok') return 'ignored'
    const at = this.now()
    const loss: GpuLoss = { kind: this.deps.kind, reason: REASON_BLACK, message: detail }
    if (this.deps.kind !== 'WebGPU' || this.switched) {
      this.history.push({ ...loss, at, plan: 'help' })
      console.error(`[gpu] ${this.deps.kind}: the 3D view stays black (${detail}); ${this.switched ? 'already switched once in this tab' : 'nothing to switch to'}; showing the help`)
      this.deps.help()
      return 'help'
    }
    this.history.push({ ...loss, at, plan: 'reload-webgl' })
    console.error(`[gpu] WebGPU: the 3D view stays black (${detail}); reloading on WebGL2 for this tab`)
    write(this.deps.storage, SWITCHED_KEY, true)
    this.reloadWebgl(`${REASON_BLACK}: ${detail}`, this.deps.text.blackWebgl, at)
    return 'reload-webgl'
  }

  /** The help's "compatibility mode" button: WebGL2 for this tab, straight back into the world. */
  switchToWebgl(): void {
    if (this.phase === 'reloading') return
    this.reloadWebgl(REASON_MODE, null, this.now())
  }

  /** Reloads now, back into the world when there (Options → Graphics mode → Reload now). */
  reloadIntoWorld(reason = REASON_MODE): void {
    if (this.phase === 'reloading') return
    this.phase = 'reloading'
    this.keepCharacter(reason, this.now())
    this.deps.reload()
  }

  private reloadWebgl(reason: string, text: string | null, at: number): void {
    this.phase = 'reloading'
    write(this.deps.storage, WEBGL_KEY, true)
    this.keepCharacter(reason, at)
    if (text === null) return this.deps.reload()
    this.deps.notice(text)
    this.timer = setTimeout(() => {
      this.timer = null
      this.deps.reload()
    }, RELOAD_DELAY_MS)
  }

  private keepCharacter(reason: string, at: number): void {
    const characterId = this.deps.character()
    if (characterId !== null) write(this.deps.storage, RECOVER_KEY, { characterId, at, reason } satisfies GpuRecovery)
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
    if (plan === 'reload-webgl') return this.reloadWebgl(detail, this.deps.text.reloadingWebgl, at)
    this.phase = 'reloading'
    this.keepCharacter(detail, at)
    this.deps.notice(this.deps.text.reloading)
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

export interface GraphicsModeRowDeps {
  /** What this load booted (null before main.ts set it). */
  booted(): BootedEngine | null
  /** Asks "Reload now?"; true reloads. */
  ask(): Promise<boolean>
  reload(): void
  storage: LossStorage | null
}

/**
 * Options → Graphics: the Graphics mode select (stored at once; it clears the tab's WebGL2 fallback, so the choice wins
 * on the next load, and offers a reload) and its two notes: this tab fell back to WebGL2, the choice waits for a reload.
 */
export function graphicsModeRows(d: GraphicsModeRowDeps): OptionRow[] {
  return [
    {
      id: 'graphics.backend',
      kind: 'choice',
      style: 'select',
      label: 'options.backend',
      choices: GRAPHICS_BACKENDS.map(v => ({ value: v, label: t(`options.backend.${v}`) })),
      get: s => s.graphics.backend,
      patch: v => ({ graphics: { backend: v as GraphicsBackend } }),
      after: () => {
        clearWebglFallback(d.storage)
        void d.ask().then(ok => {
          if (ok) d.reload()
        })
      },
    },
    { id: 'graphics.backend.fallback', kind: 'info', text: () => t('options.backend.fallback'), when: () => d.booted()?.why === 'fallback' },
    {
      id: 'graphics.backend.pending',
      kind: 'info',
      text: () => t('options.backend.pending'),
      when: s => {
        const b = d.booted()
        return !!b && b.why !== 'param' && b.why !== 'fallback' && s.graphics.backend !== b.backend
      },
    },
  ]
}

let installed: { app: App; guard: GpuLossGuard } | null = null

/** The installed guard (null before main.ts installs it, and in tests). */
export function gpuLossGuard(): GpuLossGuard | null {
  return installed?.guard ?? null
}

/**
 * Opens the "3D view is black" help (gpu-help.ts): `detected` when the watchdog saw it, else the player asked (Esc
 * menu, login screen). On WebGPU it offers the compatibility mode for this tab.
 */
export function openGpuHelp(detected = false): void {
  if (!installed) return
  const { app, guard } = installed
  showGpuHelp(app.art, {
    detected,
    webgpu: app.engineKind === 'WebGPU',
    reload: () => guard.reloadIntoWorld(REASON_RELOAD),
    compatibility: () => guard.switchToWebgl(),
  })
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
    help: () => openGpuHelp(true),
    reload: () => location.reload(),
    text: { restoring: t('gpu.restoring'), reloading: t('gpu.reloading'), reloadingWebgl: t('gpu.reloadingWebgl'), stopped: t('gpu.stopped'), blackWebgl: t('gpu.blackWebgl') },
  })
  installed = { app, guard }
  // Esc → "Screen black?": the help for what no page can detect (Chrome's compositor dropping the 3D canvas).
  registerMenuItem({
    id: 'blackScreen',
    label: 'menu.blackScreen',
    order: 70,
    run: ctx => {
      ctx.close()
      openGpuHelp()
    },
  })
  for (const row of graphicsModeRows({
    booted: bootedEngine,
    ask: () => MessageBox.confirm({ art: app.art, title: t('options.backend'), text: t('options.backend.ask'), ok: t('options.backend.reloadNow'), cancel: t('options.backend.later') }),
    reload: () => guard.reloadIntoWorld(REASON_MODE),
    storage: tabStorage(),
  })) {
    registerOptionRow('graphics', row)
  }
  ;(window as unknown as { __sroGpuLoss?: GpuLossGuard }).__sroGpuLoss = guard
  return guard
}

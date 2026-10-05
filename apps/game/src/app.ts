/**
 * The front-end state machine: one Babylon engine and canvas, one DOM layer (#ui), one screen at a time.
 * Screens are modules that build their DOM/scene on enter and tear everything down in dispose().
 */
import type { AbstractEngine, Scene } from '@babylonjs/core'
import type { CharacterSummary } from '@sro/shared'
import type { Music } from './audio.ts'
import type { GameAudio } from './audio/index.ts'
import type { Catalog } from './content/catalog.ts'
import type { EngineKind } from './engine.ts'
import type { Session, StatusEvent } from './net/session.ts'
import type { Transport } from './net/transport.ts'
import type { Params } from './params.ts'
import type { StageHost } from './stage/types.ts'
import type { Art } from './ui/art.ts'
import { showUniqueNotice } from './hud/unique-notice.ts'
import { t } from './i18n/index.ts'
import { clearSession, tokenRefused } from './net/resume.ts'
import { settings } from './settings.ts'
import { createStageHost } from './stage/host.ts'
import { el, sleep } from './ui/dom.ts'
import { setCursor } from './ui/kit/cursor.ts'
import { setKitArt } from './ui/kit/host.ts'
import { artRendering, uiScale } from './ui/kit/scale.ts'
import { ensureKitStyles } from './ui/kit/tokens.ts'
import { NoticeBanner } from './ui/notice.ts'
import { framePace } from './world/frame-pace.ts'

export interface ScreenParams {
  splash: undefined
  login: { error?: string } | undefined
  servers: undefined
  charselect: { select?: number } | undefined
  charcreate: undefined
  world: { character: CharacterSummary }
}

export type ScreenName = keyof ScreenParams

export interface Screen {
  dispose(): void
}

export type ScreenFactory<K extends ScreenName> = (app: App, params: ScreenParams[K]) => Screen

export interface OwnedScene {
  kind: string
  scene: Scene
  dispose(): void
}

export class App {
  readonly ui: HTMLElement
  readonly overlay: HTMLElement
  private readonly fade: HTMLElement
  private readonly factories = new Map<ScreenName, ScreenFactory<ScreenName>>()
  private screen: Screen | null = null
  private owned: OwnedScene | null = null
  private switching: Promise<void> = Promise.resolve()
  private banner: HTMLElement | null = null
  private sessionOff: (() => void) | null = null
  /** Server-wide GM announcements, shown on every screen. */
  readonly notices = new NoticeBanner()
  current: ScreenName | null = null
  /** The params the current screen was opened with (gpu-loss.ts reads the world's character). */
  currentParams: unknown = undefined
  session: Session | null = null
  /** Account name typed at login (display only; the server's `welcome.account` wins once connected). */
  username = ''
  token = ''
  /** When `token` expires (ms since epoch; ApiLoginResponse.expiresAt): kept for the refresh resume (net/resume.ts). */
  tokenExpiresAt = 0
  /** The stage host (built on first use; see `stage`). */
  private stageHost: StageHost | null = null

  constructor(
    readonly engine: AbstractEngine,
    readonly engineKind: EngineKind,
    readonly params: Params,
    readonly transport: Transport,
    readonly catalog: Catalog,
    readonly art: Art,
    readonly music: Music,
    /** Sound effects, ambience and the sound settings (docs/SOUND.md §5); `music` is its Music. */
    readonly audio: GameAudio,
  ) {
    this.ui = document.getElementById('ui')!
    this.overlay = document.getElementById('overlay')!
    this.fade = document.getElementById('fade')!
    // The UI kit (docs/UI.md §5): its stylesheet, its art, and the retail flame-hand cursor.
    ensureKitStyles()
    setKitArt(art)
    setCursor('normal')
    engine.runRenderLoop(() => {
      // V-12: the display's pace and each frame's CPU work, on every screen, for the frame watchdog
      framePace.begin(performance.now())
      const s = this.owned?.scene
      if (s?.activeCamera) s.render()
      framePace.end(performance.now())
    })
    window.addEventListener('resize', () => {
      engine.resize()
      this.updateScale()
    })
    this.updateScale()
    settings.onChange((s, prev) => {
      // A resize event also re-clamps the open windows into the viewport at the new scale.
      if (s.ui.scaleMode !== prev.ui.scaleMode) window.dispatchEvent(new Event('resize'))
    })
  }

  /**
   * --ui: the zoom of the native-pixel UI layers, a retail step (1, 1.25, 1.5, 2, 2.5, 3) from Options → UI scale
   * (Auto: never below 1 on a desktop-sized viewport; docs/UI.md §4.1); --art-rendering keeps whole-pixel art crisp.
   */
  private updateScale(): void {
    const s = uiScale(settings.get().ui.scaleMode, window.innerWidth, window.innerHeight)
    const root = document.documentElement.style
    root.setProperty('--ui', String(s))
    root.setProperty('--art-rendering', artRendering(s, window.devicePixelRatio))
  }

  register<K extends ScreenName>(name: K, factory: ScreenFactory<K>): void {
    this.factories.set(name, factory as unknown as ScreenFactory<ScreenName>)
  }

  /** Switches screens with a short fade. Calls are serialized. */
  go<K extends ScreenName>(name: K, params?: ScreenParams[K]): Promise<void> {
    this.switching = this.switching.then(async () => {
      const factory = this.factories.get(name)
      if (!factory) throw new Error(`no screen ${name}`)
      if (this.screen) {
        this.fade.classList.add('on')
        await sleep(260)
        try {
          this.screen.dispose()
        } catch (err) {
          console.error('[app] dispose failed', err)
        }
      }
      this.screen = null
      this.ui.replaceChildren()
      this.current = name
      this.currentParams = params
      document.body.dataset.screen = name
      try {
        this.screen = factory(this, params as ScreenParams[ScreenName])
      } catch (err) {
        console.error(`[app] screen ${name} failed`, err)
        this.toast(t('app.screenFailed', { screen: name, error: err instanceof Error ? err.message : String(err) }), 'error')
      }
      requestAnimationFrame(() => this.fade.classList.remove('on'))
    })
    return this.switching
  }

  /**
   * Gives the caller the 3D scene of `kind`, reusing the current one when the kind matches
   * (e.g. login -> server select keep the same backdrop). The previous scene is disposed otherwise.
   */
  useScene<T extends OwnedScene>(kind: string, build: () => T): T {
    if (this.owned?.kind === kind) return this.owned as T
    this.releaseScene()
    const owned = build()
    this.owned = owned
    document.body.classList.add('has-scene')
    return owned
  }

  releaseScene(): void {
    if (!this.owned) return
    const o = this.owned
    this.owned = null
    document.body.classList.remove('has-scene')
    try {
      o.dispose()
    } catch (err) {
      console.error('[app] scene dispose failed', err)
    }
  }

  get scene(): Scene | null {
    return this.owned?.scene ?? null
  }

  /**
   * The character screens' stage host (docs/SCREENS.md §0B, §4.3; stage/types.ts): the one stage `World` on the Jangan
   * palace steps. Built lazily on first use, so a page that never shows the character screens builds nothing.
   */
  get stage(): StageHost {
    return (this.stageHost ??= createStageHost(this))
  }

  // ---- session --------------------------------------------------------------------------------

  setSession(session: Session | null): void {
    this.sessionOff?.()
    this.sessionOff = null
    if (this.session && this.session !== session) this.session.close('logout')
    this.session = session
    this.showBanner(null)
    if (!session) return
    const offStatus = session.onStatus(ev => this.onSessionStatus(ev))
    const offMsg = session.on(msg => {
      if (msg.t === 'notice') this.notices.show(msg.text, msg.from)
      // Wave 11 (UNIQUES §3.3, WAVE_PLAN7 D8): a unique monster appeared or fell (world sockets only): the banner + cue.
      else if (msg.t === 'uniqueNotice') showUniqueNotice(msg, { notices: this.notices, audio: this.audio })
    })
    this.sessionOff = () => {
      offStatus()
      offMsg()
    }
  }

  private onSessionStatus(ev: StatusEvent): void {
    if (ev.status === 'reconnecting') this.showBanner(ev.message ?? t('app.reconnecting'))
    else if (ev.status === 'online') this.showBanner(null)
    else if (ev.status === 'closed' && ev.reason !== 'logout') {
      this.showBanner(null)
      if (tokenRefused(ev.reason)) clearSession(this.transport.mock)
      const msg = ev.reason === 'unauthorized' ? t('app.sessionExpired') : ev.reason === 'version_mismatch' ? t('net.versionMismatch') : ev.message ?? t('app.disconnected')
      this.setSession(null)
      void this.go('login', { error: msg })
    }
  }

  logout(message?: string): Promise<void> {
    this.setSession(null)
    clearSession(this.transport.mock)
    if (this.token) void this.transport.api.logout(this.token)
    this.token = ''
    this.tokenExpiresAt = 0
    return this.go('login', message ? { error: message } : undefined)
  }

  private showBanner(text: string | null): void {
    // While the connection is down the HUD dims and ignores clicks (hud/ux-style.ts `body.net-down`).
    document.body.classList.toggle('net-down', !!text)
    if (!text) {
      this.banner?.remove()
      this.banner = null
      return
    }
    if (!this.banner) {
      this.banner = el('div', 'net-banner')
      document.body.append(this.banner)
    }
    this.banner.textContent = text
  }

  // ---- notifications ---------------------------------------------------------------------------

  toast(text: string, kind: 'info' | 'error' = 'info', ms = 3500): void {
    let host = document.querySelector<HTMLElement>('.toasts')
    if (!host) {
      host = el('div', 'toasts')
      document.body.append(host)
    }
    const node = el('div', `toast ${kind}`, text)
    host.append(node)
    setTimeout(() => {
      node.classList.add('out')
      setTimeout(() => node.remove(), 400)
    }, ms)
  }
}

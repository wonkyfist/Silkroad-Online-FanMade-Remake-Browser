/**
 * Lane UX-A's HUD shell, installed once per HUD (docs/UX_GAPS.md §8 UX-A): the Options and Key help windows, their
 * Esc-menu entries (Options 10, Key help 20, Fullscreen 25), the system menu bar buttons (Character, Inventory,
 * Options) and the shell keys (H: key help, Ctrl+Shift+F: FPS). Everything registered here is removed on dispose.
 */
import type { App } from '../app.ts'
import { t } from '../i18n/index.ts'
import { settings } from '../settings.ts'
import type { Art } from '../ui/art.ts'
import { el, place } from '../ui/dom.ts'
import { button } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { Window } from '../ui/kit/window.ts'
import { KeyHelpWindow } from './keyhelp.ts'
import type { KeyMap } from './keys.ts'
import { registerMenuItem, type MenuContext, type MenuItem } from './menu-items.ts'
import type { MenuBar } from './menubar.ts'
import { OptionsWindow, toggleFullscreen, type OptionsTab } from './options.ts'
import { ensureUxStyles } from './ux-style.ts'

interface Toggleable {
  toggle(): void
  readonly isOpen: boolean
}

export interface UxShellDeps {
  app: App
  /** Parent of the HUD windows. */
  layer: HTMLElement
  keys: KeyMap
  menubar: MenuBar
  inventory: Toggleable
  character: Toggleable
  toast(text: string): void
}

export interface UxShell {
  /** The shell's windows, for the HUD's Esc chain (close the top window). */
  readonly windows: readonly Window[]
  /** The System window (Esc): screens/world.ts opens it with `menuItems()`. */
  readonly system: SystemWindow
  openOptions(tab?: OptionsTab): void
  toggleKeyHelp(): void
  dispose(): void
}

export function createUxShell(d: UxShellDeps): UxShell {
  ensureUxStyles()
  const { app } = d
  const offs: (() => void)[] = []
  /** The Esc menu's context from the last entry it ran (the Options window runs the sound lane's entry with it). */
  let menuCtx: MenuContext = { app, close() {}, characterSelect() {}, logout: () => void app.logout() }

  const keyHelp = new KeyHelpWindow(app.art, d.layer, () => d.keys.list())
  const options = new OptionsWindow(app.art, d.layer, {
    engine: app.transport.mock ? t('corner.engineMock', { engine: app.engineKind }) : app.engineKind,
    keyHelp: () => keyHelp.open(),
    toast: d.toast,
    get menu() {
      return menuCtx
    },
  })
  const system = new SystemWindow(app.art, d.layer)
  const toggleKeyHelp = () => keyHelp.toggle()
  const openOptions = (tab?: OptionsTab) => options.openTab(tab)

  offs.push(
    registerMenuItem({
      id: 'options',
      label: 'menu.options',
      order: 10,
      run: ctx => {
        menuCtx = ctx
        ctx.close()
        openOptions()
      },
    }),
    registerMenuItem({
      id: 'keyHelp',
      label: 'menu.keyHelp',
      order: 20,
      run: ctx => {
        menuCtx = ctx
        ctx.close()
        keyHelp.open()
      },
    }),
    registerMenuItem({
      id: 'fullscreen',
      label: 'menu.fullscreen',
      order: 25,
      when: () => typeof document !== 'undefined' && document.fullscreenEnabled !== false,
      run: ctx => {
        ctx.close()
        toggleFullscreen(() => d.toast(t('options.fullscreenFailed')))
      },
    }),
    d.menubar.register({ id: 'character', art: 'mainpopup/main_sysbutton_character', label: 'keys.window.character', hotkey: 'C', order: 10, toggle: () => d.character.toggle(), isOpen: () => d.character.isOpen }),
    d.menubar.register({ id: 'inventory', art: 'mainpopup/main_sysbutton_inventory', label: 'keys.window.inventory', hotkey: 'I', order: 20, toggle: () => d.inventory.toggle(), isOpen: () => d.inventory.isOpen }),
    d.menubar.register({ id: 'options', art: 'mainpopup/main_sysbutton_option', label: 'menubar.options', hotkey: 'Esc', order: 90, toggle: () => options.toggle(), isOpen: () => options.isOpen }),
    d.keys.register({ id: 'window.help', keys: ['h'], label: 'keys.window.help', group: 'windows', run: toggleKeyHelp }),
    d.keys.register({
      id: 'debug.fps',
      keys: ['f'],
      mods: ['ctrl', 'shift'],
      label: 'keys.debug.fps',
      group: 'debug',
      run: () => settings.set({ ui: { showFps: !settings.get().ui.showFps } }),
    }),
  )

  return {
    windows: [options, keyHelp, system],
    system,
    openOptions,
    toggleKeyHelp,
    dispose() {
      for (const off of offs.splice(0)) {
        try {
          off()
        } catch (err) {
          console.error('[ux-shell] dispose', err)
        }
      }
      options.dispose()
      keyHelp.dispose()
      system.dispose()
    },
  }
}

// ---- the System window (Esc) ----------------------------------------------------------------------------------

/** Retail `GDR_SYSTEM` (`ifsystemwnd.txt`): mframe 214×245, `int_window_` (17,45,180,185), `sys_button` rows at x 31. */
export const SYSTEM_W = 214
export const SYSTEM_H = 245
/** The retail row tops (y 58/92/125/159/192): 33.5 px apart. */
export function systemRowTop(k: number): number {
  return 58 + Math.round(33.5 * k)
}

/** The rows the System window shows: every menu entry but "Back to game", which is the close button. */
export function systemRows(items: readonly MenuItem[]): MenuItem[] {
  return items.filter(i => i.id !== 'resume')
}

/**
 * The System window (Esc; docs/UI.md §4.6): one `sys_button` row per entry of `menuItems()` (Options, Key help,
 * Fullscreen, Sound, Character select, Log out…). More than five rows grow the window by 33 px each.
 */
export class SystemWindow extends Window {
  private readonly inner: Frame
  private readonly rows: HTMLElement

  constructor(art: Art, parent: HTMLElement) {
    super(art, parent, { id: 'system', title: t('menu.title'), width: SYSTEM_W, height: SYSTEM_H, at: [0.5, 0.4], inset: [0, 0, 0, 0], className: 'hud-window hud-window-system' })
    this.titleStrip.classList.add('hud-window-title')
    this.body.style.top = '36px'
    this.inner = new Frame(art, 'inner', { at: [17, 9, 180, 185], className: 'sys-inner' })
    this.rows = el('div', 'sys-rows')
    this.body.append(this.inner.root, this.rows)
  }

  /** Opens with `items` (menuItems()); a row runs its entry with `ctx`. */
  show(items: readonly MenuItem[], ctx: MenuContext): void {
    const rows = systemRows(items)
    const extra = Math.max(0, rows.length - 5) * 33
    this.resize(SYSTEM_W, SYSTEM_H + extra)
    this.inner.root.style.height = `${185 + extra}px`
    this.rows.replaceChildren(
      ...rows.map((item, k) => {
        const b = button(this.art, { label: t(item.label), skin: 'system', width: 152 }, () => {
          try {
            item.run(ctx)
          } catch (err) {
            console.error(`[system] menu ${item.id} failed`, err)
          }
        })
        b.dataset.menu = item.id
        return place(b, [31, systemRowTop(k) - 36, 152, 24])
      }),
    )
    this.open()
    this.raise()
    ;(this.rows.querySelector('button') as HTMLButtonElement | null)?.focus({ preventScroll: true })
  }
}

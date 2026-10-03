/**
 * Placeholder windows for the wave-4 lanes (docs/WAVE_PLAN.md §5.1 W4-FC). A lane's feature opens one of these until
 * it ships its real window: the key binding (KeyMap) and the menu-bar button are registered exactly as the real window
 * will register them, so the lane only swaps the window. Owned by W4-FC; lanes stop importing it, nobody edits it.
 */
import { t, type StringKey } from '../../i18n/index.ts'
import type { Art } from '../../ui/art.ts'
import { el } from '../../ui/dom.ts'
import { Window } from '../../ui/kit/window.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'

export interface PlaceholderSpec {
  /** Window id (remembered position `sro.hud.<id>`) and menu-bar entry id: 'quests', 'party'. */
  id: string
  title: StringKey
  /** The one line the placeholder shows. */
  text: StringKey
  /** Menu-bar button art (`mainpopup/main_sysbutton_*`). */
  art: string
  /** Menu-bar order (hud/menubar.ts: Quest 40, Party 50). */
  order: number
  /** KeyMap binding id and keys ('window.quests', ['q', 'l']). */
  keyId: string
  keys: string[]
  keyLabel: StringKey
  /** Shown in the menu-bar tooltip ('Q'). */
  hotkey: string
}

const WIDTH = 300
const HEIGHT = 150

/** A small mframe window with one centred line of text (kit window, docs/UI.md §4.6). */
export class PlaceholderWindow extends Window {
  constructor(art: Art, parent: HTMLElement, spec: Pick<PlaceholderSpec, 'id' | 'title' | 'text'>) {
    super(art, parent, { id: spec.id, title: t(spec.title), width: WIDTH, height: HEIGHT, at: [0.5, 0.35], className: `hud-window hud-window-${spec.id}` })
    this.root.dataset.placeholder = spec.id
    const line = el('div', 'hud-placeholder-text kit-t-body', t(spec.text))
    Object.assign(line.style, { padding: '8px 4px', textAlign: 'center' })
    this.body.append(line)
  }
}

/** What the feature needs of the window (a HudWindow; tests pass a fake, there is no DOM in vitest). */
export interface PanelWindow {
  readonly isOpen: boolean
  toggle(): void
  close(): void
  dispose(): void
}

export type PlaceholderContext = Pick<WorldFeatureContext, 'keys'> & { readonly hud: Pick<WorldFeatureContext['hud'], 'menubar' | 'layer'>; readonly app: Pick<WorldFeatureContext['app'], 'art'> }

/** The key, the menu-bar button and Esc for one placeholder window; dispose removes all three. */
export function placeholderFeature(
  ctx: PlaceholderContext,
  spec: PlaceholderSpec,
  makeWindow: () => PanelWindow = () => new PlaceholderWindow(ctx.app.art, ctx.hud.layer, spec),
): WorldFeature {
  const win = makeWindow()
  const offs = [
    ctx.keys.register({ id: spec.keyId, keys: spec.keys, label: spec.keyLabel, group: 'windows', run: () => win.toggle() }),
    ctx.hud.menubar.register({ id: spec.id, art: spec.art, label: spec.title, hotkey: spec.hotkey, order: spec.order, toggle: () => win.toggle(), isOpen: () => win.isOpen }),
  ]
  return {
    escape() {
      if (!win.isOpen) return false
      win.close()
      return true
    },
    dispose() {
      for (const off of offs.splice(0)) off()
      win.dispose()
    },
  }
}

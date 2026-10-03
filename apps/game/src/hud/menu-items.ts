/**
 * The Esc menu's entries (docs/WAVE_PLAN.md decision 20). The world screen's `openMenu` renders `menuItems()` in
 * `order`; lanes add theirs with `registerMenuItem` from their own modules: Options 10 and Key help 20 (UX-A),
 * Sound 30 (SND-C). The built-in Character select / Log out / Back to game sit at 80–90.
 * Registering an id again replaces that entry. No DOM.
 */
import type { App } from '../app.ts'
import type { StringKey } from '../i18n/index.ts'

/** What an entry's `run` can do (the world screen provides it while the menu is open). */
export interface MenuContext {
  readonly app: App
  /** Closes the menu. */
  close(): void
  /** Leaves the world for character select. */
  characterSelect(): void
  /** Logs out to the login screen. */
  logout(): void
}

export interface MenuItem {
  id: string
  label: StringKey
  /** Ascending; ties keep registration order. */
  order: number
  run(ctx: MenuContext): void
  /** Shown only while this returns true. */
  when?: () => boolean
}

const items: MenuItem[] = []
let serial = 0
const seq = new WeakMap<MenuItem, number>()

/** Adds (or replaces, by id) a menu entry. Returns an unregister function. */
export function registerMenuItem(item: MenuItem): () => void {
  const i = items.findIndex(x => x.id === item.id)
  if (i >= 0) items.splice(i, 1)
  seq.set(item, serial++)
  items.push(item)
  return () => {
    const j = items.indexOf(item)
    if (j >= 0) items.splice(j, 1)
  }
}

/** The visible entries, in order. */
export function menuItems(): MenuItem[] {
  return items
    .filter(x => {
      try {
        return !x.when || x.when()
      } catch {
        return false
      }
    })
    .sort((a, b) => a.order - b.order || seq.get(a)! - seq.get(b)!)
}

// Built-in entries (their look is the same as before the registry existed).
registerMenuItem({ id: 'characterSelect', label: 'menu.characterSelect', order: 80, run: ctx => ctx.characterSelect() })
registerMenuItem({ id: 'logout', label: 'menu.logout', order: 85, run: ctx => ctx.logout() })
registerMenuItem({ id: 'resume', label: 'menu.resume', order: 90, run: ctx => ctx.close() })

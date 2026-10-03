/**
 * Key help (H; docs/UX_GAPS.md W2): every KeyMap binding that is active right now, grouped, plus the mouse and the
 * fixed Enter / Esc keys that live outside the KeyMap. Built from `keys.list()` each time it opens, so bindings the
 * lanes register later (hotbar, skills, loot...) show up without changes here.
 * Also the "H: key help" hint on the world's help line, shown for the first HELP_HINT_SESSIONS world visits.
 */
import { t, type StringKey } from '../i18n/index.ts'
import { settings, type SettingsStore } from '../settings.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { ScrollArea } from '../ui/kit/scroll.ts'
import { Section } from '../ui/kit/section.ts'
import { Window } from '../ui/kit/window.ts'
import type { KeyBinding, KeyGroup } from './keys.ts'
import { ensureUxStyles } from './ux-style.ts'

export const KEY_GROUP_ORDER: readonly KeyGroup[] = ['windows', 'combat', 'movement', 'camera', 'chat', 'gm', 'debug']
/** The hint shows in this many world visits, then hides (the key help stays in the Esc menu and on H). */
export const HELP_HINT_SESSIONS = 3

const ARROWS: Record<string, string> = { arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓' }

/** One key as printed: 'i' -> 'I', 'f9' -> 'F9', 'arrowleft' -> '←', ' ' -> 'Space', 'escape' -> 'Esc'. */
export function keyName(key: string): string {
  const k = key.toLowerCase()
  if (ARROWS[k]) return ARROWS[k]
  if (k === ' ' || k === 'spacebar') return t('keyhelp.key.space')
  if (k === 'escape') return 'Esc'
  if (/^f\d{1,2}$/.test(k)) return k.toUpperCase()
  if (k.length === 1) return k.toUpperCase()
  return k[0]!.toUpperCase() + k.slice(1)
}

/** A binding's keys as printed, with its modifiers: 'Ctrl+Shift+F', 'S / K'. */
export function keyCaption(b: Pick<KeyBinding, 'keys' | 'mods'>): string {
  const mods = (b.mods ?? []).map(m => t(m === 'ctrl' ? 'keyhelp.key.ctrl' : m === 'shift' ? 'keyhelp.key.shift' : 'keyhelp.key.alt'))
  return b.keys.map(k => [...mods, keyName(k)].join('+')).join(' / ')
}

export interface KeyHelpRow {
  keys: string
  label: StringKey
}

export interface KeyHelpGroup {
  group: KeyGroup
  rows: KeyHelpRow[]
}

/**
 * The active bindings grouped in KEY_GROUP_ORDER, in registration order. A binding whose `when` is false (GM keys for
 * players, mock keys on the real server) is left out; a later binding with the same id replaces an earlier one.
 */
export function keyHelpGroups(bindings: readonly KeyBinding[]): KeyHelpGroup[] {
  const byId = new Map<string, KeyBinding>()
  for (const b of bindings) {
    let active = true
    try {
      active = !b.when || b.when()
    } catch {
      active = false
    }
    if (!active || !b.keys.length) continue
    byId.delete(b.id)
    byId.set(b.id, b)
  }
  const groups: KeyHelpGroup[] = []
  for (const group of KEY_GROUP_ORDER) {
    const rows = [...byId.values()].filter(b => b.group === group).map(b => ({ keys: keyCaption(b), label: b.label }))
    if (rows.length) groups.push({ group, rows })
  }
  return groups
}

/** Whether this world visit shows the hint; counts the visit (once per call: call it once per world screen). */
export function takeHelpHint(store: SettingsStore = settings): boolean {
  const n = store.get().ui.helpHintSessions
  if (n >= HELP_HINT_SESSIONS) return false
  store.set({ ui: { helpHintSessions: n + 1 } })
  return true
}

/** The "H: key help" span for the world's help line (hidden after the first few visits). */
export function helpHint(): HTMLElement {
  ensureUxStyles()
  const span = el('span', 'ux-help-hint', t('ux.help.hint'))
  span.hidden = !takeHelpHint()
  return span
}

const FIXED: [StringKey, StringKey][] = [
  ['keyhelp.mouse.left', 'keyhelp.mouse.leftWhat'],
  ['keyhelp.mouse.right', 'keyhelp.mouse.rightWhat'],
  ['keyhelp.mouse.wheel', 'keyhelp.mouse.wheelWhat'],
  ['keyhelp.mouse.rightItem', 'keyhelp.mouse.rightItemWhat'],
  ['keyhelp.enter', 'keyhelp.enterWhat'],
  ['keyhelp.esc', 'keyhelp.escWhat'],
]

/** docs/UI.md §4.6 Key help: mframe 340×420, one `sframe_wnd_` section per group, rows key / action. */
export const KEYHELP_W = 340
export const KEYHELP_H = 420
const ROW_H = 17

export class KeyHelpWindow extends Window {
  private readonly list: ScrollArea

  constructor(art: Art, parent: HTMLElement, private readonly bindings: () => readonly KeyBinding[]) {
    super(art, parent, { id: 'keyhelp', title: t('keyhelp.title'), width: KEYHELP_W, height: KEYHELP_H, at: [0.5, 0.35], inset: [44, 12, 14, 14], className: 'hud-window hud-window-keyhelp' })
    ensureUxStyles()
    this.titleStrip.classList.add('hud-window-title')
    this.body.classList.add('hud-window-body')
    this.list = new ScrollArea(art, { w: KEYHELP_W - 26, h: KEYHELP_H - 58, className: 'ux-keyhelp' })
    this.body.append(this.list.root)
  }

  protected override onOpen(): void {
    this.render()
  }

  override dispose(): void {
    this.list.dispose()
    super.dispose()
  }

  render(): void {
    const w = KEYHELP_W - 26 - 18
    const group = (caption: string, rows: readonly (readonly [string, string])[]) => {
      const s = new Section(this.art, { caption, w, h: 30 + rows.length * ROW_H + 8, className: 'ux-keyhelp-group' })
      s.root.style.position = 'relative'
      s.body.append(
        ...rows.map(([keys, what]) => el('div', 'ux-keyhelp-row', el('span', 'ux-keyhelp-key kit-t-level', keys), el('span', 'ux-keyhelp-what kit-t-value', what))),
      )
      return s.root
    }
    const parts: HTMLElement[] = [group(t('keyhelp.group.mouse'), FIXED.map(([k, what]) => [t(k), t(what)] as const))]
    for (const g of keyHelpGroups(this.bindings())) parts.push(group(t(`keyhelp.group.${g.group}` as StringKey), g.rows.map(r => [r.keys, t(r.label)] as const)))
    // MV-WASD: how walking works with the Options → Controls → Keyboard movement switch as it is now.
    parts.push(el('div', 'ux-keyhelp-note', t(settings.get().controls.keyboardMove ? 'keyhelp.wasd' : 'keyhelp.noWasd')))
    this.list.view.replaceChildren(...parts)
  }
}

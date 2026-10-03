/**
 * One KeyMap for every game key (docs/UX_GAPS.md §4.1, docs/WAVE_PLAN.md decision 26). Lanes call
 * `hud.keys.register(...)` from their own modules; nobody adds a `keydown` listener of their own.
 * Escape and Enter stay special: the HUD's close-top-window chain and the world's Esc/Enter handling run outside it.
 * No DOM beyond the one `attach(window)` listener, so tests feed plain event objects through `handle()`.
 */
import type { StringKey } from '../i18n/index.ts'

export type KeyGroup = 'windows' | 'combat' | 'movement' | 'camera' | 'chat' | 'gm' | 'debug'

export interface KeyBinding {
  /** Stable id, e.g. 'window.inventory', 'loot.auto', 'hotbar.1'. */
  id: string
  /** Matched against KeyboardEvent.key, lower-cased for letters: 'i', 'g', 'f1', 'arrowleft', 'escape', '1'. */
  keys: string[]
  /** Key-help caption (i18n key). */
  label: StringKey
  group: KeyGroup
  /** Also fires on key repeat (camera keys, hold-G). Default false. */
  repeat?: boolean
  /** Fires on keyup too (hold-to-loot, camera). */
  up?: (ev: KeyboardEvent) => void
  /** Only active when this returns true (e.g. staff for F9, mock for F8). */
  when?: () => boolean
  /** Required modifiers (e.g. ['ctrl', 'shift'] for the FPS toggle). Without it, any Ctrl/Alt/Meta chord is skipped. */
  mods?: ('ctrl' | 'shift' | 'alt')[]
  run(ev: KeyboardEvent): void
}

/** The event fields the KeyMap reads (Node has no KeyboardEvent, so tests pass plain objects). */
export type KeyEventLike = Pick<KeyboardEvent, 'key' | 'repeat' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'target' | 'type' | 'preventDefault'>

export interface KeyMapOptions {
  /** True while an open modal (count dialog, confirm) owns the keyboard: keydowns are skipped. */
  blocked?: () => boolean
}

/** 'I' -> 'i', 'F1' -> 'f1', 'ArrowLeft' -> 'arrowleft'. */
export function normalizeKey(key: string): string {
  return key.toLowerCase()
}

/** INPUT / TEXTAREA / SELECT / contentEditable: typing, not a game key. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const n = target as { tagName?: unknown; isContentEditable?: unknown } | null
  if (!n || typeof n !== 'object') return false
  return n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' || n.isContentEditable === true
}

/** Keys a focused kit input widget (Slider, List, Select popup) uses for itself. */
const WIDGET_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'pageup', 'pagedown'])
const WIDGET_SELECTOR = '[role=slider],[role=listbox],[role=spinbutton],[role=combobox],.kit-slider,.kit-list,.kit-select'

/** A navigation key on a focused kit Slider / List / Select: the widget's key, not a game key (camera). */
export function isWidgetKey(key: string, target: EventTarget | null): boolean {
  if (!WIDGET_KEYS.has(key)) return false
  const n = target as { closest?: unknown } | null
  if (!n || typeof n !== 'object' || typeof n.closest !== 'function') return false
  return (n.closest as (sel: string) => unknown).call(n, WIDGET_SELECTOR) != null
}

function modsMatch(b: KeyBinding, ev: KeyEventLike): boolean {
  if (!b.mods) return !ev.ctrlKey && !ev.altKey && !ev.metaKey
  const ctrl = ev.ctrlKey || ev.metaKey
  return ctrl === b.mods.includes('ctrl') && ev.altKey === b.mods.includes('alt') && ev.shiftKey === b.mods.includes('shift')
}

const modsSig = (b: KeyBinding) => (b.mods ? [...b.mods].sort().join('+') : '')

export class KeyMap {
  private bindings: KeyBinding[] = []
  /** Key -> the binding its keydown fired, so the keyup reaches the same one (even from a typing target). */
  private readonly pressed = new Map<string, KeyBinding>()
  private detach: (() => void) | null = null

  constructor(private readonly opts: KeyMapOptions = {}) {}

  /**
   * Returns an unregister function. A second binding on the same key logs a warning; the later one wins. Two bindings
   * that both declare `when` may share a key without the warning (MV-WASD: the arrows walk while keyboard movement is
   * on and turn the camera while it is off); the later one still wins while both are active.
   */
  register(b: KeyBinding): () => void {
    const keys = b.keys.map(normalizeKey)
    const binding: KeyBinding = { ...b, keys }
    for (const other of this.bindings) {
      const clash = other.keys.find(k => keys.includes(k))
      if (clash !== undefined && modsSig(other) === modsSig(binding) && !(other.when && binding.when)) console.warn(`[keys] '${clash}' is bound by ${other.id} and ${b.id}; ${b.id} wins`)
    }
    this.bindings.push(binding)
    return () => {
      this.bindings = this.bindings.filter(x => x !== binding)
      for (const [k, v] of this.pressed) if (v === binding) this.pressed.delete(k)
    }
  }

  list(): readonly KeyBinding[] {
    return this.bindings
  }

  /** True while an open modal owns the keyboard (KeyMapOptions.blocked): held movement keys let go (MV-WASD). */
  get isBlocked(): boolean {
    try {
      return !!this.opts.blocked?.()
    } catch {
      return false
    }
  }

  /** One capture-phase window listener: skips typing targets (INPUT/TEXTAREA/contentEditable), chords a binding did not declare in `mods`, and open modals. */
  attach(target: Window): void {
    this.detach?.()
    const on = (ev: KeyboardEvent) => this.handle(ev)
    const blur = () => this.releaseAll()
    target.addEventListener('keydown', on, { capture: true })
    target.addEventListener('keyup', on, { capture: true })
    target.addEventListener('blur', blur)
    this.detach = () => {
      target.removeEventListener('keydown', on, { capture: true })
      target.removeEventListener('keyup', on, { capture: true })
      target.removeEventListener('blur', blur)
    }
  }

  /** The listener body, exposed so tests can feed plain `{key, repeat, ctrlKey, …, target}` objects. */
  handle(ev: KeyEventLike): void {
    if (typeof ev.key !== 'string' || !ev.key) return
    const key = normalizeKey(ev.key)
    if (ev.type === 'keyup') {
      const b = this.pressed.get(key)
      this.pressed.delete(key)
      if (b?.up) this.call(() => b.up!(ev as KeyboardEvent), b)
      return
    }
    if (ev.type !== 'keydown') return
    if (isTypingTarget(ev.target) || isWidgetKey(key, ev.target) || this.opts.blocked?.()) return
    const b = this.find(key, ev)
    if (!b) return
    if (ev.repeat && !b.repeat) return
    ev.preventDefault()
    if (b.up) this.pressed.set(key, b)
    this.call(() => b.run(ev as KeyboardEvent), b)
  }

  /** Every held key's `up` runs (window blur: the keyups would never arrive). */
  releaseAll(): void {
    const held = [...this.pressed.values()]
    this.pressed.clear()
    for (const b of held) this.call(() => b.up?.(new KeyUpStub() as unknown as KeyboardEvent), b)
  }

  dispose(): void {
    this.detach?.()
    this.detach = null
    this.pressed.clear()
    this.bindings = []
  }

  /** The latest registered binding on `key` whose `when` and modifiers match. */
  private find(key: string, ev: KeyEventLike): KeyBinding | undefined {
    for (let i = this.bindings.length - 1; i >= 0; i--) {
      const b = this.bindings[i]!
      if (!b.keys.includes(key) || !modsMatch(b, ev)) continue
      if (b.when && !this.safeWhen(b)) continue
      return b
    }
    return undefined
  }

  private safeWhen(b: KeyBinding): boolean {
    try {
      return b.when!()
    } catch (err) {
      console.error(`[keys] ${b.id} when() failed`, err)
      return false
    }
  }

  private call(fn: () => void, b: KeyBinding): void {
    try {
      fn()
    } catch (err) {
      console.error(`[keys] ${b.id} failed`, err)
    }
  }
}

/** Stand-in keyup for releaseAll (window blur). */
class KeyUpStub {
  readonly type = 'keyup'
  readonly key = ''
  readonly repeat = false
  readonly ctrlKey = false
  readonly altKey = false
  readonly metaKey = false
  readonly shiftKey = false
  readonly target = null
  preventDefault(): void {}
}

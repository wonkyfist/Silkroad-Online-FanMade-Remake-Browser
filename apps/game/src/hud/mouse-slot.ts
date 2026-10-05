/**
 * The underbar's mouse quick slot (retail GDR_TMPQS_0, "Mouse quickslot"; docs/UI.md §4.5): one more slot left of
 * key 1 whose skill or potion only the middle mouse button (the wheel) uses in the world. The server keeps it per
 * character as slot MOUSE_SLOT (migration 11). The first client kept it in localStorage['sro.hotbar.mouse'] per
 * character name: MouseSlotStore only reads that once to hand an entry over to the server (world/features/skills.ts),
 * then clears it. Every read and write is guarded; a junk or blocked store reads as empty.
 */
import { CODE_NAME, type ClientMessage, type HotbarEntry } from '@sro/shared'
import { intent } from './intents.ts'

export const MOUSE_SLOT_KEY = 'sro.hotbar.mouse'
/** At most this many characters are remembered (the oldest entries go first). */
export const MOUSE_SLOT_MAX_CHARS = 64

/** The part of Storage this uses (tests pass a map, or one that throws). */
export interface MouseSlotStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const KINDS = new Set(['skill', 'item'])

/** A stored entry, or null when it is not a {kind, code} pair. */
function entryOf(v: unknown): HotbarEntry | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind)) return null
  if (typeof o.code !== 'string' || !CODE_NAME.test(o.code)) return null
  return { kind: o.kind as HotbarEntry['kind'], code: o.code }
}

/** Every character's mouse slot from the stored JSON (empty when missing or junk). */
export function readMouseSlots(raw: string | null): Record<string, HotbarEntry> {
  try {
    const v = JSON.parse(raw ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, HotbarEntry> = {}
    for (const [name, e] of Object.entries(v as Record<string, unknown>)) {
      const entry = entryOf(e)
      if (name && entry) out[name] = entry
    }
    return out
  } catch {
    return {}
  }
}

export class MouseSlotStore {
  constructor(private readonly storage: MouseSlotStorage | null) {}

  /** The mouse slot of character `name` (null: empty, unknown or unreadable). */
  get(name: string): HotbarEntry | null {
    if (!name) return null
    return this.read()[name] ?? null
  }

  /** Stores (or clears, null) the mouse slot of `name`. */
  set(name: string, entry: HotbarEntry | null): void {
    if (!name) return
    const all = this.read()
    delete all[name]
    if (entry) all[name] = { kind: entry.kind, code: entry.code }
    const names = Object.keys(all)
    for (const old of names.slice(0, Math.max(0, names.length - MOUSE_SLOT_MAX_CHARS))) delete all[old]
    try {
      this.storage?.setItem(MOUSE_SLOT_KEY, JSON.stringify(all))
    } catch {
      // storage blocked or full: the slot still works for this visit
    }
  }

  private read(): Record<string, HotbarEntry> {
    try {
      return readMouseSlots(this.storage?.getItem(MOUSE_SLOT_KEY) ?? null)
    } catch {
      return {}
    }
  }
}

/** window.localStorage, or null where reading it throws (sandboxed frames, blocked site data). */
export function browserMouseSlotStorage(): MouseSlotStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** What a drag that involves the mouse slot does: the hotbarSet messages, and the mouse slot's new entry. */
export interface MouseSlotDrop {
  send: ClientMessage[]
  /** The mouse slot's new entry (absent: unchanged). */
  mouse?: HotbarEntry | null
}

/**
 * The rules of a drag from or onto the mouse slot (`from` / `to`: an absolute hotbar slot, 'mouse', or null = the
 * skill window / off the bar); null when the mouse slot is not involved (hotbarDrop's rules apply). Between the mouse
 * slot and a hotbar slot the two entries swap, as between two hotbar slots; the mouse slot dragged off the bar (not
 * onto a window) is cleared.
 */
export function mouseSlotDrop(hotbar: readonly (HotbarEntry | null)[], mouse: HotbarEntry | null, entry: HotbarEntry, from: number | 'mouse' | null, to: number | 'mouse' | null, overUi: boolean): MouseSlotDrop | null {
  if (to === 'mouse') {
    if (from === 'mouse') return { send: [] }
    const send: ClientMessage[] = []
    if (typeof from === 'number') {
      const back = intent.hotbarSet(from, mouse)
      if (back) send.push(back)
    }
    return { send, mouse: entry }
  }
  if (from !== 'mouse') return null
  if (to === null) return overUi ? { send: [] } : { send: [], mouse: null }
  const set = intent.hotbarSet(to, entry)
  return { send: set ? [set] : [], mouse: hotbar[to] ?? null }
}

/**
 * Whether a pointer event on the world canvas is a middle-button press: a `pointerdown` of button 1, or the chorded
 * form (another button already held, e.g. the right button turning the camera), which browsers send as a
 * `pointermove` with `button` 1 and the middle bit (4) of `buttons` set.
 */
export function isMiddlePress(ev: Pick<PointerEvent, 'type' | 'button' | 'buttons'>): boolean {
  if (ev.button !== 1) return false
  if (ev.type === 'pointerdown') return true
  return ev.type === 'pointermove' && (ev.buttons & 4) !== 0
}

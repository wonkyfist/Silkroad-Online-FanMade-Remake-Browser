/**
 * Who says what, and when (docs/TOWN_LIFE.md §3.7, §3.6; docs/WAVE_PLAN7.md §6.1 TL-C). Pure: every client computes
 * the same calls from the server clock and the agent's id, so friends see the same vendor call at the same moment. The
 * DOM bubbles are the app's (apps/game world/features/town.ts: a pool of ≤ 3, laid out with the name tags).
 *
 * - **Vendor calls**: a vendor calls about every 12–25 s (slot k of CALL_SLOT_S starts its call at a hashed offset), a
 *   line of its stall's goods, shown for BUBBLE_S; only vendors drawn within CALL_RANGE_M, nearest first, at most
 *   MAX_BUBBLES on screen.
 * - **A clicked townsperson** says a flavour line of its role, picked by hash(id, minute): local to the clicker (no
 *   server message), BUBBLE_S long.
 * - The lines are the town file's (`TownFile.lines`, TL-R's content); the defaults below stand in until it lands.
 */
import { hash01, hash2 } from './crowd.ts'

/** Seconds a bubble shows. */
export const BUBBLE_S = 4
/** Bubbles on screen at most. */
export const MAX_BUBBLES = 3
/** Vendors call to a player within this (m). */
export const CALL_RANGE_M = 20
/** A clicked townsperson answers within this of the player (m; the speech cursor's range, TOWN_LIFE §3.6). */
export const CLICK_RANGE_M = 25
/** One call per slot; its start is hashed within the slot's first CALL_JITTER_S (intervals ≈ 12–25 s). */
export const CALL_SLOT_S = 18.5
export const CALL_JITTER_S = 6.5

/** The town file's lines (packages/shared town.ts TownLines, structurally). */
export interface TownLinesLite {
  calls: Record<string, readonly string[]>
  flavour: Partial<Record<string, readonly string[]>>
}

/** The lab's calls (TOWN_LIFE §3.7) and a few flavour lines per role, until TL-R's content. English, ≤ 120 characters. */
export const DEFAULT_LINES: Readonly<TownLinesLite> = {
  calls: {
    fruit: ['Fresh peaches! Sweet as honey!', 'Pears from the south hills, crisp and cold!', 'Dates and figs, a copper a handful!'],
    silk: ['Silk from Dunhuang, finest weave!', 'Feel this cloth, traveller. Like water!', 'Brocade for a bride, silk for a lord!'],
    buns: ['Hot buns, still steaming!', 'Pork buns! Bean buns! Hot from the basket!', 'Dumplings, fresh this morning!'],
    tea: ['Tea! Rest your feet, traveller.', 'Green tea, red tea, a cup for the road!', 'Sit, sit. The kettle is on.'],
    iron: ['Good iron, fair price!', 'Blades sharpened while you wait!', 'Nails, hinges, horseshoes!'],
    herbs: ['Herbs for every ailment!', 'Ginseng! Roots from the far mountains!', 'A tonic for the weary, a salve for the bruised!'],
  },
  flavour: {
    walker: ['Busy day at the market.', 'Mind the carts, friend.', 'Have you seen the palace gardens?', 'They say a caravan came in from the west.'],
    chatter: ['…and then the merchant doubled his price!', 'My cousin swears he saw a tiger near the south slopes.', 'Quiet, here comes the guard.'],
    sitter: ['A fine day to sit and watch the town.', 'The fountain sounds like rain.', 'My knees are older than this city.'],
    vendor: ['Look, but do not touch, unless you buy.', 'Best prices in Jangan, ask anyone.', 'Come back tomorrow, more stock arrives.'],
    porter: ['Out of the way, heavy load!', 'One more trip to the south gate.'],
    guard: ['Move along, citizen.', 'Keep the peace in Jangan.', 'All quiet on the avenue.'],
    child: ['Catch me if you can!', 'I am a great general!', 'Have you got a sweet?'],
    elder: ['In my day the walls were taller.', 'Patience, young one.'],
    lanternCarrier: ['Light for the evening, light for the road.'],
    worker: ['The anvil never sleeps.', 'Hot work, honest work.'],
    rider: ['Make way!'],
  },
}

/** The call a vendor makes at `nowS`: the slot it belongs to and when it started; null when silent. Pure. */
export function vendorCallAt(id: number, nowS: number): { slot: number; startS: number } | null {
  if (!Number.isFinite(nowS)) return null
  for (let k = Math.floor(nowS / CALL_SLOT_S); k >= Math.floor(nowS / CALL_SLOT_S) - 1; k--) {
    const startS = k * CALL_SLOT_S + hash01(id, k) * CALL_JITTER_S
    if (nowS >= startS && nowS < startS + BUBBLE_S) return { slot: k, startS }
  }
  return null
}

/** One line of `list` for (id, k); '' when the list is empty. */
export function lineOf(list: readonly string[] | undefined, id: number, k: number): string {
  if (!list || !list.length) return ''
  return list[hash2(id ^ 0x5bd1e995, k) % list.length] ?? ''
}

/** A vendor's call text for slot k (its goods' list, else any). */
export function callText(lines: Readonly<TownLinesLite>, goods: string | undefined, id: number, slot: number): string {
  let list = goods ? lines.calls[goods] : undefined
  if (!list) {
    const keys = Object.keys(lines.calls)
    list = lines.calls[keys[hash2(id, 7) % Math.max(1, keys.length)] ?? '']
  }
  return lineOf(list, id, slot)
}

/** What a clicked townsperson of `role` says at `nowS` (by the minute, TOWN_LIFE §3.6). */
export function clickText(lines: Readonly<TownLinesLite>, role: string, id: number, nowS: number): string {
  const list = lines.flavour[role] ?? lines.flavour.walker ?? DEFAULT_LINES.flavour.walker
  return lineOf(list, id, Math.floor(nowS / 60))
}

/** Merges a town file's lines over the defaults (missing goods or roles keep the defaults). */
export function townLines(file: Partial<TownLinesLite> | null | undefined): TownLinesLite {
  if (!file) return DEFAULT_LINES as TownLinesLite
  return {
    calls: { ...DEFAULT_LINES.calls, ...(file.calls ?? {}) },
    flavour: { ...DEFAULT_LINES.flavour, ...(file.flavour ?? {}) },
  }
}

/** A bubble to show: the agent, its text, where its head is (glTF metres) and how far from the player. */
export interface TownBubble {
  agent: number
  text: string
  x: number
  y: number
  z: number
  dist: number
  /** The clicked townsperson's answer (drawn first). */
  click: boolean
}

export function newBubble(): TownBubble {
  return { agent: -1, text: '', x: 0, y: 0, z: 0, dist: 0, click: false }
}

/**
 * Keeps the nearest `max` of `n` candidates in `list[0..]` (the clicked one first), in place; returns how many stay.
 * Insertion order by distance: n ≤ the vendors in range, a handful.
 */
export function nearestBubbles(list: TownBubble[], n: number, max = MAX_BUBBLES): number {
  for (let i = 1; i < n; i++) {
    const b = list[i]!
    let j = i - 1
    while (j >= 0 && (Number(list[j]!.click) < Number(b.click) || (list[j]!.click === b.click && list[j]!.dist > b.dist))) {
      list[j + 1] = list[j]!
      j--
    }
    list[j + 1] = b
  }
  return Math.min(n, max)
}

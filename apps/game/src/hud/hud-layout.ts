/**
 * The retail world-HUD layout (docs/UI.md §4.2): every HUD piece as a rect in native px of the zoomed layer, for a
 * layer of W × H native px (the viewport divided by --ui). Pure, so ui-layout.test.ts checks it without a DOM.
 *
 * Retail rects come from resinfo at 1024×768 and keep their offset from the edge they hang on (the anchors):
 *   player frame GDR_PLAYER_MINI_INFO (4,7,212,70), buffs GDR_MAGICSTATEBOARD (220,10), party GDR_QUICKPARTYBOARD
 *   (4,137) with 7 slots 44 px apart, target GDR_TARGETWINDOW (442,10) = centre + 48 at 1024, durability
 *   GDR_EQUIP_DUR_ERROR_WND (615,5,277,32) = W − 409, equipment state GDR_EQUIP_STATE_WND (824,74,68,96) = W − 200,
 *   minimap GDR_MINIMAP (892,6,140,184) = W − 132, casting bar GDR_DELAY_GAUGE_BOARD (416,606) = centred, H − 162.
 * The 2009 underbar has no resinfo rect: it sits flush with the bottom, centred (x 112 at 1024 = GDR_UNDERBAR).
 * Mount points for wave 8 (decision D17): `durability` and `equipState` (DR), `pet` on the player frame (MR-C).
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const PLAYER_FRAME: Rect = { x: 4, y: 7, w: 212, h: 70 }
/** Horse / pet mini info on the player frame (GDR_PMI_PET_MINI_INFO), frame-relative. */
export const PET_HOST: Rect = { x: 53, y: 55, w: 154, h: 40 }
/** Berserk orbs, button and glows cover the whole frame plus its glow margin (pmi_jahwan_glow −4,−3,220,80). */
export const BERSERK_HOST: Rect = { x: -4, y: -6, w: 220, h: 83 }
/** The five berserk orb rects (GDR_PMI_CIRCLE0..4), frame-relative. */
export const BERSERK_ORBS: readonly Rect[] = [
  { x: 7, y: 13, w: 8, h: 8 },
  { x: 4, y: 28, w: 8, h: 8 },
  { x: 7, y: 43, w: 8, h: 8 },
  { x: 17, y: 54, w: 8, h: 8 },
  { x: 31, y: 60, w: 8, h: 8 },
]
/** Buff board: 2 rows (blessings y 0, curses y 27) of 9 icons 20 px, 21 px apart (GDR_MSB_BLESS_1..9 at x 0..168); time gauges under each. */
export const BUFFS: Rect = { x: 220, y: 10, w: 188, h: 51 }
export const BUFF_PITCH = 21
export const BUFF_ROW = 27
export const BUFF_MAX = 9
/** Party frames: 7 slots (the other members of 8), 122×40, 44 px apart. */
export const PARTY_SLOT_W = 122
export const PARTY_SLOT_H = 40
export const PARTY_PITCH = 44
export const PARTY_SLOTS = 7
export const PARTY: Rect = { x: 4, y: 137, w: PARTY_SLOT_W, h: PARTY_PITCH * (PARTY_SLOTS - 1) + PARTY_SLOT_H }
/** Target windows (2009): 236 wide; monster 51, special monster 78, player/NPC 35 tall. Buffs 2 px under it. */
export const TARGET_W = 236
export const TARGET_H = 78
export const MINIMAP_W = 140
export const MINIMAP_H = 184
/** The opaque part of mm_window (the plate ends 11 px before the texture's right edge). */
export const MINIMAP_OPAQUE: readonly [number, number] = [129, 172]
export const UNDERBAR_W = 800
export const UNDERBAR_H = 68
export const DECO_W = 76
export const DECO_H = 64
export const CAST_W = 192
export const CAST_H = 36
export const QUEST_W = 200
/** Chat: tabs row 20, box, input row 20 (1-px gaps); widths 400 (retail) or 300 on narrow screens. */
export const CHAT_W = 400
export const CHAT_W_NARROW = 300
export const CHAT_LINE = 15
export const CHAT_SIZES = { small: 4, medium: 8, big: 14 } as const
export type ChatSize = keyof typeof CHAT_SIZES
/** Chat box height for a number of lines (4 px rims top and bottom). */
export function chatBoxHeight(lines: number): number {
  return lines * CHAT_LINE + 8
}
export function chatHeight(lines: number): number {
  return 20 + 1 + chatBoxHeight(lines) + 1 + 20
}

export interface HudAnchors {
  player: Rect
  buffs: Rect
  party: Rect
  target: Rect
  durability: Rect
  equipState: Rect
  minimap: Rect
  quest: Rect
  casting: Rect
  underbar: Rect
  /** Hidden (null) when the viewport is too narrow for them (W < 952). */
  decoLeft: Rect | null
  decoRight: Rect | null
  chat: Rect
  perf: Rect
  notice: Rect
}

export interface HudLayoutOptions {
  /** Chat lines (CHAT_SIZES), default medium. */
  chatLines?: number
}

/** Room the whole underbar needs with both decorations. */
export const DECO_MIN_W = UNDERBAR_W + 2 * DECO_W
/** From this width the chat sits beside the underbar's left decoration instead of above it. */
export const CHAT_BESIDE_W = UNDERBAR_W + 2 * (DECO_W + CHAT_W)

export function hudAnchors(W: number, H: number, opts: HudLayoutOptions = {}): HudAnchors {
  const ux = Math.round((W - UNDERBAR_W) / 2)
  const uy = H - UNDERBAR_H
  const underbar = { x: ux, y: uy, w: UNDERBAR_W, h: UNDERBAR_H }
  const decos = W >= DECO_MIN_W
  // Retail puts the target at centre + 48 (442 at 1024), clear of the buff board; never under it.
  const target = { x: Math.max(Math.round((W - TARGET_W) / 2) + 48, BUFFS.x + BUFFS.w + 4), y: 10, w: TARGET_W, h: TARGET_H }
  const minimap = { x: W - 132, y: 6, w: MINIMAP_W, h: MINIMAP_H }
  // Under the plate (docs/UI.md §4.2: top 196, right edge W − 4).
  const questTop = minimap.y + MINIMAP_H + 6
  const quest = { x: W - 4 - QUEST_W, y: questTop, w: QUEST_W, h: Math.max(0, uy - 8 - questTop) }
  // Chat: bottom-left, above the underbar (or beside it on very wide screens); shortened so it never reaches the
  // party frames.
  const chatW = W < 1180 ? CHAT_W_NARROW : CHAT_W
  const beside = W >= CHAT_BESIDE_W
  const chatBottom = beside ? H - 4 : uy - 4
  const room = chatBottom - (PARTY.y + PARTY.h + 8)
  let lines = opts.chatLines ?? CHAT_SIZES.medium
  while (lines > 2 && chatHeight(lines) > room) lines--
  const ch = chatHeight(lines)
  return {
    player: { ...PLAYER_FRAME },
    buffs: { ...BUFFS },
    party: { ...PARTY },
    target,
    durability: { x: W - 409, y: 5, w: 277, h: 32 },
    equipState: { x: W - 200, y: 74, w: 68, h: 96 },
    minimap,
    quest,
    casting: { x: Math.round((W - CAST_W) / 2), y: H - 162, w: CAST_W, h: CAST_H },
    underbar,
    decoLeft: decos ? { x: ux - DECO_W, y: uy + 4, w: DECO_W, h: DECO_H } : null,
    decoRight: decos ? { x: ux + UNDERBAR_W, y: uy + 4, w: DECO_W, h: DECO_H } : null,
    chat: { x: 0, y: chatBottom - ch, w: chatW, h: ch },
    perf: { x: 4, y: 80, w: 212, h: 16 },
    notice: { x: Math.round((W - 480) / 2), y: 96, w: 480, h: 40 },
  }
}

/** Lines that fit the chat box in this layout (the chat's height decides it). */
export function chatLinesFor(a: HudAnchors): number {
  return Math.round((a.chat.h - 42 - 8) / CHAT_LINE)
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Places an absolutely positioned element at a rect (native px). */
export function placeAt(e: HTMLElement, r: Rect, size = false): void {
  e.style.left = `${r.x}px`
  e.style.top = `${r.y}px`
  if (size) {
    e.style.width = `${r.w}px`
    e.style.height = `${r.h}px`
  }
}

/** Frames between the checks of shown watchers for an element that left the page (W9F LEAK-1). */
export const LAYOUT_SWEEP_FRAMES = 30
/** Watchers whose element has been shown, checked every LAYOUT_SWEEP_FRAMES frames while there are any. */
const shownWatchers = new Set<{ el: HTMLElement; stop: () => void }>()
let sweepFrames = 0
let sweeping = false

function sweepLayouts(): void {
  sweeping = false
  if (++sweepFrames >= LAYOUT_SWEEP_FRAMES) {
    sweepFrames = 0
    for (const w of [...shownWatchers]) if (!w.el.isConnected) w.stop()
  }
  if (shownWatchers.size) {
    sweeping = true
    requestAnimationFrame(sweepLayouts)
  }
}

/**
 * Runs `fn` with the anchors of the layer `el` lives in, now (next frame) and after every window resize (the app
 * sets --ui in its own resize handler first, so this reads the new zoom). Returns the stop function.
 *
 * Once `el` has been shown, it stops by itself when `el` leaves the page: at the next resize, or at the latest
 * LAYOUT_SWEEP_FRAMES frames later (W9F LEAK-1: a dropped stop function kept the resize listener, and through `fn` the
 * owner's whole screen, alive until the player happened to resize the window).
 */
export function watchLayout(el: HTMLElement, fn: (W: number, H: number) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  let raf = 0
  let seen = false
  const run = () => {
    raf = 0
    // Removed from the page after having been shown: stop listening (the owner may not call the stop function).
    if (!el.isConnected) {
      if (seen) stop()
      return
    }
    if (!seen) {
      seen = true
      shownWatchers.add(entry)
      if (!sweeping) {
        sweeping = true
        requestAnimationFrame(sweepLayouts)
      }
    }
    const s = layerScaleOf(el)
    fn(Math.round(window.innerWidth / s), Math.round(window.innerHeight / s))
  }
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(run)
  }
  const stop = () => {
    window.removeEventListener('resize', schedule)
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    shownWatchers.delete(entry)
  }
  const entry = { el, stop }
  window.addEventListener('resize', schedule)
  schedule()
  return stop
}

/** Viewport px per native px inside `e` (Element.currentCSSZoom, else measured; ui/kit/scale.ts layerScale). */
function layerScaleOf(e: HTMLElement): number {
  const z = (e as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom
  if (typeof z === 'number' && z > 0) return z
  const v = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui'))
  return v > 0 ? v : 1
}

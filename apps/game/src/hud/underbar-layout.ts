/**
 * The 2009 underbar `underbar/ub_new_mainbar2` (800×68): where each part sits in the art, measured on the decoded
 * texture (work/tmp/uih/scan.ts: bright rims and dark wells; docs/UI.md §4.5 "measure, don't guess").
 *
 *   quick slots   rims at x 258 + 36·i (y 14..50); the 32×32 icon well starts at (260 + 36·i, 16)
 *   EXP band      10 grooves of 76×8 at x 19 + 78·i, y 58 (dividers at 95/96 … 797)
 *   SP-EXP gauge  the thin well of the left box, x 15..190, y 24..31 (`ub_new_sp_bar` 176×8)
 *   SP text       the lower field of the left box, x 15..190, y 35..51
 *   level box     the small rounded square at the bottom-left, inner (2,52,15,14)
 *   mouse slot    the gold frame at (206,13,42,42), mouse icon baked in
 *   page arrows   `ub_up_arrow` at (625,16) and `ub_down_arrow` at (625,40) over the baked ones; digit well (626,27,17,13)
 *   right panel   inner (656,21,127,30) under the MENU tab; the C / I / S round buttons (32×32) sit in it
 *   MENU tab      `ub_new_menu` (78×24) at (681,1), exactly over the tab baked into the bar
 * Decorations `ub_new_deco_left/right` (76×64) hang at −76 and +800, 4 px down.
 */
import type { Rect } from './hud-layout.ts'

export const SLOT_X0 = 260
export const SLOT_Y = 16
export const SLOT_PITCH = 36
export const SLOT_SIZE = 32
export const SLOT_COUNT = 10

/** The icon well of visible quick slot i (0..9). */
export function slotRect(i: number): Rect {
  return { x: SLOT_X0 + SLOT_PITCH * i, y: SLOT_Y, w: SLOT_SIZE, h: SLOT_SIZE }
}

export const EXP_BAND = { n: 10, x0: 19, pitch: 78, y: 58, w: 76, h: 8 } as const

/** Segment i of the EXP band. */
export function expSegmentRect(i: number): Rect {
  return { x: EXP_BAND.x0 + EXP_BAND.pitch * i, y: EXP_BAND.y, w: EXP_BAND.w, h: EXP_BAND.h }
}

/** The fill of each of the 10 EXP segments for an EXP percentage (0..100): segment i fills clamp(f·10 − i, 0, 1). */
export function expSegments(percent: number): number[] {
  const f = Math.min(1, Math.max(0, Number.isFinite(percent) ? percent / 100 : 0))
  return Array.from({ length: EXP_BAND.n }, (_, i) => Math.min(1, Math.max(0, f * EXP_BAND.n - i)))
}

export const SP_GAUGE: Rect = { x: 15, y: 24, w: 176, h: 8 }
export const SP_TEXT: Rect = { x: 15, y: 35, w: 176, h: 16 }
export const LEVEL_BOX: Rect = { x: 2, y: 52, w: 15, h: 14 }
export const MOUSE_SLOT: Rect = { x: 206, y: 13, w: 42, h: 42 }
export const PAGE_UP: Rect = { x: 625, y: 16, w: 20, h: 12 }
export const PAGE_DOWN: Rect = { x: 625, y: 40, w: 20, h: 12 }
export const PAGE_TEXT: Rect = { x: 626, y: 27, w: 17, h: 13 }
export const MENU_TAB: Rect = { x: 681, y: 1, w: 78, h: 24 }
export const PANEL: Rect = { x: 656, y: 21, w: 127, h: 30 }
/** The round window buttons in the right panel: Character, Inventory, Skill. */
export const PANEL_BUTTONS: readonly Rect[] = [
  { x: 664, y: 19, w: 32, h: 32 },
  { x: 704, y: 19, w: 32, h: 32 },
  { x: 744, y: 19, w: 32, h: 32 },
]
/** Menubar entry ids drawn as the panel's round buttons, in PANEL_BUTTONS order, with their art. */
export const PANEL_ENTRIES: readonly { id: string; art: string }[] = [
  { id: 'character', art: 'underbar/ub_new_character' },
  { id: 'inventory', art: 'underbar/ub_new_inventory' },
  { id: 'skills', art: 'underbar/ub_new_skill' },
]
/** "+120 EXP" rises from above the left box. */
export const GAINS: Rect = { x: 15, y: -40, w: 240, h: 40 }
/** MENU popup rows (`ub_new_menu_button` 124×20) and the ub_new_wnd_ frame inset around them. */
export const MENU_ROW_W = 124
export const MENU_ROW_H = 20
export const MENU_FRAME_INSET = 8

/** The MENU popup's icon for a menubar entry id (UI.md §4.5 rows); unknown ids get the community icon. */
export const MENU_ICONS: Record<string, string> = {
  character: 'underbar/ub_new_character',
  inventory: 'underbar/ub_new_inventory',
  skills: 'underbar/ub_new_skill',
  quests: 'underbar/ub_new_icon_quest',
  party: 'underbar/ub_new_icon_pt',
  guild: 'underbar/ub_new_icon_guild',
  stall: 'underbar/ub_new_icon_stall',
  alchemy: 'underbar/ub_new_icon_alchemy',
  action: 'underbar/ub_new_icon_action',
  options: 'underbar/ub_new_icon_system',
  system: 'underbar/ub_new_icon_system',
  making: 'underbar/ub_new_icon_making',
  collection: 'underbar/ub_new_icon_collection',
  apprenticeship: 'underbar/ub_new_icon_apprenticeship',
  recovery: 'underbar/ub_new_icon_recovery',
}
export const MENU_ICON_DEFAULT = 'underbar/ub_new_icon_commu'

export function menuIcon(id: string, icon?: string): string {
  return icon ?? MENU_ICONS[id] ?? MENU_ICON_DEFAULT
}

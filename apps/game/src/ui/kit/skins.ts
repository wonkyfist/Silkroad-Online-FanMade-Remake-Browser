/**
 * Component skins: the exact retail art per control (docs/UI.md §5.2). Keys are art-manifest keys (paths under
 * Media/interface without extension, see ui/art.ts). Each frame family is exported by UI-X as one nine-slice sheet
 * `<prefix>9` with `UiImage.nine` insets; until then the eight pieces (or the listed fallback family) are used.
 * Nothing here touches the DOM.
 */
import type { Art } from '../art.ts'

export interface FrameSkin {
  /** 8-piece prefix: `<prefix>{left_up,mid_up,…}` and the nine-slice sheet `<prefix>9`. */
  prefix: string
  /** Body tile drawn under the frame (not baked into the sheet). */
  fill?: string
  /** Height of the title / caption strip (native px), when the family has one. */
  title?: number
  /** Default body inset [top, right, bottom, left]. */
  inset: readonly [number, number, number, number]
  /** Families tried, in order, when this one is not exported (degrade gracefully while the export catches up). */
  fallback?: readonly string[]
}

export const FRAMES = {
  main: { prefix: 'frame/mframe_wnd_', fill: 'ifcommon/bg_tile/com_bg_tile_a', title: 36, inset: [44, 16, 16, 16], fallback: ['frame/frameg01_wnd_', 'inventory/int_window_'] },
  section: { prefix: 'frame/sframe_wnd_', fill: 'ifcommon/bg_tile/com_bg_tile_b', title: 22, inset: [30, 10, 10, 10], fallback: ['frame/frame_sub_', 'inventory/int_window_'] },
  inner: { prefix: 'inventory/int_window_', fill: 'ifcommon/bg_tile/com_bg_tile_d', inset: [10, 10, 10, 10] },
  panel: { prefix: 'equipment/equip_window_', fill: 'ifcommon/bg_tile/com_bg_tile_d', inset: [12, 12, 12, 12], fallback: ['inventory/int_window_'] },
  grey: { prefix: 'frame/frameg01_wnd_', inset: [14, 14, 14, 14] },
  dialog: { prefix: 'messagebox/msgbox2_window_', fill: 'ifcommon/bg_tile/com_bg_tile_b', title: 30, inset: [40, 16, 16, 16], fallback: ['frame/frameg01_wnd_'] },
  talk: { prefix: 'npc/npc_conversation_window_', fill: 'ifcommon/bg_tile/com_bg_tile_d', inset: [20, 20, 20, 20], fallback: ['inventory/int_window_'] },
  tooltip: { prefix: 'frame/frame_tooltip_', inset: [8, 8, 8, 8] },
  field: { prefix: 'frame/frame_msg_', fill: 'ifcommon/bg_tile/com_bg_tile_e', inset: [4, 4, 4, 4], fallback: ['ifcommon/com_blacksquare_'] },
  black: { prefix: 'ifcommon/com_blacksquare_', fill: 'ifcommon/bg_tile/com_bg_tile_e', inset: [4, 4, 4, 4] },
  lattice: { prefix: 'ifcommon/lattice_window/com_lattice_outline_', inset: [3, 3, 3, 3] },
  menu: { prefix: 'frame/ub_new_wnd_', inset: [8, 8, 8, 8], fallback: ['frame/frame_tooltip_'] },
} as const satisfies Record<string, FrameSkin>
export type FrameName = keyof typeof FRAMES

export interface ButtonSkin {
  key: string
  w: number
  h: number
  /** border-image slice (px) kept at native size at each end when the button grows. */
  slice: number
}

export const BUTTONS = {
  std: { key: 'ifcommon/com_button', w: 76, h: 24, slice: 6 },
  mid: { key: 'ifcommon/com_mid_button', w: 88, h: 24, slice: 6 },
  small: { key: 'ifcommon/com_m_button', w: 52, h: 20, slice: 5 },
  tiny: { key: 'ifcommon/com_s_button', w: 44, h: 20, slice: 5 },
  system: { key: 'system/sys_button', w: 152, h: 24, slice: 6 },
  red: { key: 'ifcommon/com_red_button', w: 56, h: 24, slice: 6 },
  green: { key: 'ifcommon/com_green_button', w: 56, h: 24, slice: 6 },
} as const satisfies Record<string, ButtonSkin>
export type ButtonName = keyof typeof BUTTONS
/** The state suffixes of a button key (the art has gaps: the kit tolerates any missing one). */
export const BUTTON_STATES = ['', '_focus', '_press', '_disable'] as const

export interface TabSkin {
  on: string
  off: string
  w?: number
  h: number
  /** 3-slice: `${on}{left,mid,right}` with caps of this width. */
  caps?: number
}

export const TABS = {
  tab: { on: 'ifcommon/com_tab_on', off: 'ifcommon/com_tab_off', w: 60, h: 24 },
  long: { on: 'ifcommon/com_long_tab_on', off: 'ifcommon/com_long_tab_off', w: 72, h: 24 },
  short: { on: 'ifcommon/com_short_tab_on', off: 'ifcommon/com_short_tab_off', w: 56, h: 24 },
  sub: { on: 'ifcommon/com_sub_tab02_on', off: 'ifcommon/com_sub_tab02_off', w: 68, h: 28 },
  flex: { on: 'ifcommon/com_new_tab_on_', off: 'ifcommon/com_new_tab_off_', h: 24, caps: 12 },
  chat: { on: 'chattingwnd/chat_tab', off: 'chattingwnd/chat_tab', w: 52, h: 20 },
} as const satisfies Record<string, TabSkin>
export type TabName = keyof typeof TABS | 'icon'

export const GAUGES = {
  hp: 'playerminiinfo/pmi_hp',
  mp: 'playerminiinfo/pmi_mp',
  targetHp: 'targetwindow/tw_hp',
  npcHp: 'targetwindow/tw_hp_npc',
  partyHp: 'party/pt_hp',
  partyMp: 'party/pt_mp',
  quickHp: 'quickparty/qpt_hp',
  quickMp: 'quickparty/qpt_mp',
  exp: 'underbar/ub_new_exp_bar',
  spExp: 'underbar/ub_new_sp_bar',
  cast: 'ifcommon/com_casting_gauge_skill',
  buffTime: 'icon/stateodd/s_stateodd_time_gauge',
  petHp: 'playerminiinfo/pmi_pet_hp',
  petHgp: 'playerminiinfo/pmi_pet_hgp',
} as const
export type GaugeName = keyof typeof GAUGES

/** Single controls (the rest of §2.4). */
export const CONTROLS = {
  close: 'ifcommon/com_windowclose',
  closeDark: 'ifcommon/com_d_windowclose',
  checkOff: 'ifcommon/com_checkbutton_off',
  checkOn: 'ifcommon/com_checkbutton_on',
  radioOff: 'ifcommon/com_radiobutton_off',
  radioOn: 'ifcommon/com_radiobutton_on',
  radioPress: 'ifcommon/com_radiobutton_press',
  scrollUp: 'chattingwnd/chat_arrow_up',
  scrollDown: 'chattingwnd/chat_arrow_down',
  scrollThumb: 'ifcommon/com_scroll_button',
  scrollTrack: 'ifcommon/com_scroll_bar',
  sliderPrev: 'ifcommon/com_left_bigarrow',
  sliderNext: 'ifcommon/com_right_bigarrow',
  spinPrev: 'ifcommon/com_left_arrow',
  spinNext: 'ifcommon/com_right_arrow',
  plus: 'ifcommon/com_plus_button',
  minus: 'ifcommon/com_minus_button',
  money: 'ifcommon/com_moneybutton',
  itemSelect: 'ifcommon/com_item_select',
  signPlus: 'ifcommon/com_itemsign_plus',
  signMagic: 'ifcommon/com_itemsign_magic',
  signRare: 'ifcommon/com_itemsign_rare',
  itemBroken: 'icon/icon_item_broken',
  itemWarning: 'icon/icon_item_warning',
  disable: 'icon/icon_disable',
  redTile: 'ifcommon/com_red_tile',
  grayLine: 'ifcommon/com_grayline',
  bar: 'ifcommon/com_bar01_',
  barSelect: 'ifcommon/com_bar01select_',
  noticeCorner: 'ifcommon/com_notice_corner',
  noticeEdge: 'ifcommon/com_notice_edge',
  noticeEdge2: 'ifcommon/com_notice_edge2',
  mainTabStrip: 'mainpopup/main_systab_02',
  cursor: 'cursor/normal',
} as const

/** `item_number/item_number_{0-9}`: 8×8 stack-count digits. */
export const DIGIT_KEYS: readonly string[] = Array.from({ length: 10 }, (_, i) => `item_number/item_number_${i}`)

export const FRAME_PIECES = ['left_up', 'mid_up', 'right_up', 'left_side', 'right_side', 'left_down', 'mid_down', 'right_down'] as const
export type FramePiece = (typeof FRAME_PIECES)[number]

/** The nine-slice sheet key of a frame prefix (UI.md §5.4: `ui/<prefix>9.png`). */
export function nineKey(prefix: string): string {
  return `${prefix}9`
}

/** Every art key a skin table names (for the manifest check in ui-kit.test.ts). */
export function skinKeys(): string[] {
  const keys = new Set<string>()
  for (const f of Object.values(FRAMES) as FrameSkin[]) {
    keys.add(nineKey(f.prefix))
    if (f.fill) keys.add(f.fill)
  }
  for (const b of Object.values(BUTTONS)) keys.add(b.key)
  for (const tab of Object.values(TABS) as TabSkin[]) {
    if (tab.caps) for (const p of ['left', 'mid', 'right']) keys.add(tab.on + p), keys.add(tab.off + p)
    else keys.add(tab.on), keys.add(tab.off)
  }
  for (const g of Object.values(GAUGES)) keys.add(g)
  return [...keys]
}

/** The first key the art has (textless), or undefined. */
export function pick(art: Art, ...keys: (string | undefined | null)[]): string | undefined {
  for (const k of keys) if (k && art.has(k)) return k
  return undefined
}

/** A state variant of `key` if exported, else the base key (e.g. `com_scroll_button` has only `_press`). */
export function variant(art: Art, key: string, suffix: string): string {
  return art.has(key + suffix) ? key + suffix : key
}

/** The frame prefix actually used for a skin: its own family if exported (sheet or pieces), else a fallback. */
export function resolveFrame(art: Art, skin: FrameSkin): string | undefined {
  for (const prefix of [skin.prefix, ...(skin.fallback ?? [])]) {
    if (art.has(nineKey(prefix)) && art.nine(nineKey(prefix))) return prefix
    if (FRAME_PIECES.every(p => art.has(prefix + p))) return prefix
  }
  return undefined
}

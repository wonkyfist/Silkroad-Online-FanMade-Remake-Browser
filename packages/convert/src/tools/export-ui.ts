/**
 * Exports the original front-end art and music the browser game client uses.
 *   pnpm tsx packages/convert/src/tools/export-ui.ts [--force]
 *
 * - DDJ textures from Media.pk2 (interface/...) -> work/out/ui/<folder>/<name>.png
 * - resinfo layouts (pstitle, pscharacterselect, pscharactercreatechina) -> work/out/ui/layout/<name>.json
 *   (control name, class, DDJ, rect and text key per section; rects are in the client's 1600x1200 space)
 * - music (maintheme_cut, jangan_town, jangan_field) from work/extracted/Music, else Music.pk2 -> work/out/music/
 * - the login/character-select camera data (Map/camera_path.txt, Media/config/cameradata.txt), parsed as-is
 * - the client's fonts (Media/fonts/*.ttf) -> work/out/fonts/{english,basic,chat}.ttf (ASCII names)
 * - textless derivatives of art with baked-in text (DERIVED below), e.g. outer/blackbar_down_notext
 * - the UI kit's art (docs/UI.md §5.4): the in-game interface folders (SELECTION), one nine-slice sheet per
 *   8-piece frame family (NINE_FRAMES -> ui/<prefix>9.png, manifest `nine` insets), crops of the
 *   ifcommon/window_all atlas (ATLAS_CROPS -> ui/ifcommon/wa_*.png), the damage digits (ui/hitcount/*.png)
 *   and the cursor (Media/cursor/cursor_normal1.tga -> ui/cursor/normal.png)
 * - basic.ttf / chat.ttf as Latin subsets (font-subset.ts), which Chrome's font sanitiser accepts
 * Manifest: work/out/ui/index.json. All paths in it are relative to work/out (served at /out/).
 * `bakedText` in the manifest lists the exported images that carry text (Vietnamese or English), so the
 * game client, which draws every caption as live English text, knows not to show them.
 * Nothing is written outside work/out; the game client never bundles this data.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeDds, parseDdj, type Pk2Archive } from '@sro/formats'
import { loadConfig, openArchive, type SroConfig } from '../node-io.ts'
import { encodePng } from '../png.ts'
import { decodeTga } from '../tga.ts'
import { subsetFont } from './font-subset.ts'

const force = process.argv.includes('--force')
// Set by main(), so tests can import the pure helpers below without sro.config.json.
let cfg: SroConfig
let outDir = ''
let uiDir = ''
let musicDir = ''
let fontDir = ''

/** Europe/Islam variants are out of scope; pk2 names with spaces (alcm_window_quick mastery.ddj) are skipped. */
const KIT_EXCLUDE = /eu_|europe|islam|\s/

/** Folder (inside Media.pk2) and which files of it to export. Europe/Islam variants are out of scope. */
const SELECTION: { folder: string; include: RegExp; exclude?: RegExp }[] = [
  { folder: 'interface/outer', include: /\.ddj$/, exclude: /europe|islam|yahoo|intel_centrino|sf_language/ },
  {
    folder: 'interface/loading',
    include: /(gauge_loading|loading_form|nowloading|characterloading|charactercustom|loading_zangan|loading_default|loading_china_\d|start_loading_\d+)\.ddj$/,
    exclude: /europe/,
  },
  {
    folder: 'interface/ifcommon',
    include: /^com_(button|mid_button|m_button|s_button|windowclose|d_windowclose|square_|blacksquare_|[a-z]+_tile|checkbutton_o|radiobutton|scroll|tooltip|notice|warning|left_arrow|right_arrow|bar0|caution)|^window_all/,
    exclude: /\s/, // "com_caution copy.ddj"
  },
  { folder: 'interface/ifcommon/bg_tile', include: /\.ddj$/ },
  { folder: 'interface/ifcommon/lattice_window', include: /\.ddj$/ },
  { folder: 'interface/chattingwnd', include: /^chat_(window|tab|scroll|arrow|lamp_all)/ },
  { folder: 'interface/chat', include: /\.ddj$/ },
  { folder: 'interface/playerminiinfo', include: /^pmi_(window|hp|mp|face|select|bottom_window)\.ddj$/ },
  { folder: 'interface/underbar', include: /^ub_(window_0\d|exp_bar|new_exp_bar|sp_bar|new_sp_bar|new_mainbar\d|deco_(left|right)|number_\d)/ },
  { folder: 'interface/system', include: /\.ddj$/ },
  // ---- UI kit (docs/UI.md §5.4, docs/WAVE_PLAN2.md §5.2) ----
  { folder: 'interface/frame', include: /^(mframe_wnd|sframe_wnd|frameg01_wnd|frameg_wnd|frame_tooltip|frame_msg|frame_sub|ub_new_wnd)_/, exclude: KIT_EXCLUDE },
  { folder: 'interface/messagebox', include: /^(msgbox2_window_|msgbox_window_|msgbox_rebirth|msgbox_quantity)/, exclude: KIT_EXCLUDE },
  { folder: 'interface/npc', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/equipment', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/inventory', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  {
    folder: 'interface/ifcommon',
    include:
      /^com_(tab|tab2|long_tab|short_tab|sub_tab0\d|new_tab)_|^com_(checkbutton|radiobutton|plus|minus|moneybutton|item_select|itemsign|grayline|diamond|pt_leader|casting_|red_button|green_button|blu_button|left_bigarrow|right_bigarrow|re_|kindred_china|job_|redeem_window|red_tile|green_tile)/,
    exclude: KIT_EXCLUDE,
  },
  { folder: 'interface/underbar', include: /^ub_(new_|up_arrow|down_arrow|slot_arrow)/, exclude: KIT_EXCLUDE },
  { folder: 'interface/mainpopup', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/minimap', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/playerminiinfo', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/targetwindow', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/party', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/quickparty', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/skill', include: /^skl_/, exclude: KIT_EXCLUDE },
  { folder: 'interface/quest', include: /^qst_/, exclude: KIT_EXCLUDE },
  { folder: 'interface/store', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/stall', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  // exc_* plus ch_red / ch_line for the social windows (docs/WAVE_PLAN2.md D24)
  { folder: 'interface/exchange', include: /^(exc_|ch_)/, exclude: KIT_EXCLUDE },
  {
    folder: 'interface/alchemy',
    include: /^alcm_(window|button|tab|slot|lamp|menu|effect_(prepare|success|fail_1|stuff)|windowclose)/,
    exclude: KIT_EXCLUDE,
  },
  { folder: 'interface/guild', include: /^gil_/, exclude: KIT_EXCLUDE },
  { folder: 'interface/option', include: /^opt_/, exclude: KIT_EXCLUDE },
  // damage digits and the critical / block / miss / resist tags (docs/WAVE_PLAN2.md D2)
  { folder: 'interface/hitcount', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/item_number', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/durabilityerror', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/animal', include: /^am_/, exclude: KIT_EXCLUDE },
  { folder: 'interface/chattingwnd', include: /\.ddj$/, exclude: KIT_EXCLUDE },
  { folder: 'interface/guide', include: /^gd_paper/, exclude: KIT_EXCLUDE },
  // the job window (docs/JOBS.md §10; the job gauges and the equipment's job slot come with ifcommon / equipment above)
  { folder: 'interface/character', include: /^chr_job(_window)?\.ddj$/ },
  // Media/icon is not under interface/, so these keys keep their icon/ prefix.
  { folder: 'icon', include: /^(icon_disable|icon_item_broken|icon_item_warning|icon_item_select)\.ddj$/ },
  { folder: 'icon/stateodd', include: /^s_stateodd_time(0[12])?_gauge\.ddj$/ },
  // The selection circles (effect/select_0N) are exported by export-fx.ts (docs/WAVE_PLAN2.md D3).
]

/**
 * 8-piece frame families (docs/UI.md §5.2 FRAMES, plus frameg_wnd_) composed into one nine-slice sheet each:
 * ui/<prefix>9.png, key `<prefix>9`, with its slice insets in the manifest (`nine`).
 */
export const NINE_FRAMES: readonly string[] = [
  'frame/mframe_wnd_',
  'frame/sframe_wnd_',
  'inventory/int_window_',
  'equipment/equip_window_',
  'frame/frameg01_wnd_',
  'frame/frameg_wnd_',
  'messagebox/msgbox2_window_',
  'npc/npc_conversation_window_',
  'frame/frame_tooltip_',
  'frame/frame_msg_',
  'ifcommon/com_blacksquare_',
  'ifcommon/lattice_window/com_lattice_outline_',
  'frame/ub_new_wnd_',
]

/**
 * Regions of ifcommon/window_all.ddj (1024x512) used by resinfo controls, as atlas pixels [x, y, w, h]
 * (docs/UI.md §2.7). Each is written as its own image, `derived` from the atlas. The exporter checks that each
 * rect is still one of the atlas UV rects in Media/resinfo (a warning in `failures` otherwise).
 */
export const ATLAS_CROPS: readonly { key: string; rect: [number, number, number, number]; note: string }[] = [
  { key: 'ifcommon/wa_pmi', rect: [741, 0, 212, 70], note: 'player frame GDR_PLAYER_MINI_INFO' },
  { key: 'ifcommon/wa_tw_enemy', rect: [741, 453, 236, 36], note: 'target window, monster (2009)' },
  { key: 'ifcommon/wa_tw_special', rect: [741, 374, 236, 78], note: 'target window, special monster (2009)' },
  { key: 'ifcommon/wa_tw_player', rect: [504, 367, 236, 35], note: 'target window, player (2009)' },
  { key: 'ifcommon/wa_tw_job', rect: [543, 210, 196, 58], note: 'target window, job player' },
  { key: 'ifcommon/wa_party_slot', rect: [741, 71, 122, 40], note: 'party frame slot GDR_QPB_SLOT_n' },
  { key: 'ifcommon/wa_pet', rect: [867, 71, 154, 40], note: 'pet/horse mini info' },
  { key: 'ifcommon/wa_chat_input', rect: [18, 15, 381, 20], note: 'chat input box' },
  { key: 'ifcommon/wa_sysmsg_filter', rect: [401, 0, 141, 153], note: 'system-message filter board' },
  { key: 'ifcommon/wa_whisper_list', rect: [741, 166, 141, 153], note: 'whisper list' },
  { key: 'ifcommon/wa_pmi_stats', rect: [401, 154, 135, 189], note: 'player-frame stat panel GDR_PMI_STA_CINFOBG' },
]

/**
 * Exported images whose art carries English text, audited by eye (docs/UI.md §5.4 item 6). Unlike BAKED_TEXT
 * they stay usable (Art.has() is unchanged); the manifest lists them as `englishText` for the i18n audit.
 */
const ENGLISH_TEXT: Record<string, string> = {
  ...states('underbar/ub_new_menu', ['', '_focus', '_press', '_disable'], '"MENU ▲" tab'),
  'underbar/ub_new_mainbar2': 'slot digits 1-0 and the "MENU ▲" tab (x 686-751, y 1-20)',
  'underbar/ub_new_mainbar3': 'the "MENU ▲" tab (x 686-751, y 1-20)',
  ...states('skill/skl_button_add', ['', '_focus', '_press'], '"ADD"'),
  ...states('skill/skl_button_up', ['', '_focus', '_press'], '"UP"'),
  ...states('skill/skl_levelup', ['', '_focus', '_press', '_disable'], '"LEVEL UP"'),
  ...states('skill/skl_mastery_levelup', ['', '_focus', '_press'], '"LEVEL UP"'),
  ...states('hitcount/critical', ['', '_enemy', '_player', '_shadow'], '"Critical"'),
  ...states('hitcount/blocking', ['', '_enemy', '_player', '_shadow'], '"Block"'),
  ...states('hitcount/miss', ['_enemy', '_player'], '"miss"'),
  ...states('hitcount/resist', ['', '_shadow'], '"Resist"'),
}

function states(key: string, suffixes: string[], text: string): Record<string, string> {
  return Object.fromEntries(suffixes.map(s => [`${key}${s}`, text]))
}

/**
 * Media/fonts, copied under ASCII names. The source names are Korean ("English font", "basic font", "chat font").
 * english: Arial Rounded MT Bold (Monotype 1993), 240 glyphs, Latin-1 only. Titles, buttons, captions, wordmark.
 * basic:   Qnix TaeUtum, a Korean gothic with full ASCII. Labels and body text.
 * chat:    Qnix SeUtum, the light cut of TaeUtum with full ASCII. Chat.
 */
const FONTS: { key: string; src: string; family: string; role: string }[] = [
  { key: 'english', src: 'fonts/영문서체.ttf', family: 'Arial Rounded MT Bold', role: 'titles, buttons, captions, wordmark' },
  { key: 'basic', src: 'fonts/기본서체.ttf', family: 'TaeUtum', role: 'labels and body text' },
  { key: 'chat', src: 'fonts/채팅서체.ttf', family: 'SeUtum', role: 'chat' },
]

/**
 * Exported images with text baked into the art (vSRO 1.188 is the Vietnamese build), audited by eye.
 * The game never shows these; it draws the caption as live text instead. The value says what the text is.
 */
const BAKED_TEXT: Record<string, string> = {
  'outer/logo': 'Vietnamese logo "Con Duong To Lua Online"',
  'outer/logo-big': 'Vietnamese logo "Con Duong To Lua Online"',
  'outer/text-characterselect': '"Chon nhan vat" (Select Character)',
  'outer/text-custom': '"Tao nhan vat moi" (Create New Character)',
  'outer/text-connect': '"Ket noi" (Connect)',
  'outer/text-region': '"Region Select"',
  'outer/server_window': 'header "Danh sach may chu" (Server List); use outer/serverchange_window',
  'outer/blackbar_down': 'copyright line (Joymax / VDC-Net2E); use outer/blackbar_down_notext',
  'outer/blackbar_down_copyright': 'copyright line (Joymax / VDC-Net2E); use outer/blackbar_down_notext',
  'outer/sever_select': '"CHON" (Select)',
  'outer/serverchange_window2': 'Korean server names',
  'outer/serverchange_re_window_02': 'Korean server names',
  'loading/nowloading': '"Dang tai..." (Now loading)',
  'loading/loading_zangan': 'Vietnamese logo at the bottom right of the picture band; crop to x < 752',
  'loading/loading_default': 'Vietnamese logo',
  'loading/charactercustom': 'caption',
  'loading/characterloading': 'caption',
  ...Object.fromEntries([1, 2, 3, 4].map(i => [`loading/loading_china_${i}`, 'Vietnamese logo'])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`loading/start_loading_${String(i + 1).padStart(2, '0')}`, 'Vietnamese logo'])),
}

/**
 * Textless derivatives. Text pixels (bright and unsaturated) inside `rect` (x, y, w, h), grown by 1 px, are
 * replaced with the pixels `dy` rows above. The copyright line sits on black and on the engraved medallion,
 * and the rows just above it are the same black and engraving.
 */
const DERIVED: { key: string; from: string; rect: [number, number, number, number]; dy: number; note: string }[] = [
  { key: 'outer/blackbar_down_notext', from: 'outer/blackbar_down', rect: [396, 132, 786, 26], dy: 24, note: 'copyright line removed' },
]

const LAYOUTS = ['pstitle', 'pscharacterselect', 'pscharactercreatechina']
const MUSIC = ['maintheme_cut.ogg', 'jangan_town.ogg', 'jangan_field.ogg']

interface ImageEntry {
  file: string
  src: string
  width: number
  height: number
  format: string
  /** Bounding box of texels with alpha > 8: [x, y, w, h]. Most UI textures are padded to a power of two. */
  content: [number, number, number, number]
  /** Set on DERIVED images, nine-slice sheets and atlas crops: the source key and what was done. */
  derived?: { from: string; note: string }
  /** Nine-slice sheets: the slice insets in px (CSS border-image-slice order is top right bottom left). */
  nine?: { top: number; right: number; bottom: number; left: number }
}

interface FontEntry {
  file: string
  src: string
  family: string
  role: string
  /** Set when the file is a subset of the source (font-subset.ts). */
  subset?: string
}

interface LayoutControl {
  name: string
  class: string
  ddj: string[]
  rect: [number, number, number, number]
  text: string
  id?: number
}

function contentBox(w: number, h: number, rgba: Uint8Array): [number, number, number, number] {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3]! > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? [0, 0, 0, 0] : [x0, y0, x1 - x0 + 1, y1 - y0 + 1]
}

// ---------------------------------------------------------------- nine-slice sheets and atlas crops (pure)

export interface Raster {
  width: number
  height: number
  rgba: Uint8Array
}

export const NINE_PIECES = ['left_up', 'mid_up', 'right_up', 'left_side', 'right_side', 'left_down', 'mid_down', 'right_down'] as const
export type NinePiece = (typeof NINE_PIECES)[number]

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

/** lcm(a, b), or max(a, b) when the lcm is over `cap` (then the longer tile repeats cleanly, the other not). */
export function tileSpan(a: number, b: number, cap = 256): number {
  const l = (a / gcd(a, b)) * b
  return l <= Math.max(cap, a, b) ? l : Math.max(a, b)
}

/** The raster mirrored across its main diagonal (x, y) -> (y, x). */
export function transpose(r: Raster): Raster {
  const out = new Uint8Array(r.rgba.length)
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) out.set(r.rgba.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4), (x * r.height + y) * 4)
  }
  return { width: r.height, height: r.width, rgba: out }
}

/**
 * Six-piece frames (com_blacksquare_, com_lattice_outline_) have no mid_up / mid_down: the top edge is the
 * left side transposed (its outer column becomes the outer row), the bottom edge the right side transposed.
 * [likely: the client code that draws them is not available]
 */
export function completePieces(p: Partial<Record<NinePiece, Raster>>): { pieces: Record<NinePiece, Raster>; synthesized: NinePiece[] } {
  const out = { ...p }
  const synthesized: NinePiece[] = []
  if (!out.mid_up && out.left_side) {
    out.mid_up = transpose(out.left_side)
    synthesized.push('mid_up')
  }
  if (!out.mid_down && out.right_side) {
    out.mid_down = transpose(out.right_side)
    synthesized.push('mid_down')
  }
  const missing = NINE_PIECES.filter(k => !out[k])
  if (missing.length) throw new Error(`missing frame pieces: ${missing.join(', ')}`)
  return { pieces: out as Record<NinePiece, Raster>, synthesized }
}

/**
 * One nine-slice sheet from the 8 pieces (docs/UI.md §5.4 item 2). Columns are [L | M | R] with
 * L = max(lu, ls, ld).w, R = max(ru, rs, rd).w and M = lcm(mu.w, md.w) (capped); rows are [T | S | B] with
 * T = max(lu, mu, ru).h, B = max(ld, md, rd).h and S = lcm(ls.h, rs.h). Pieces are drawn the way the client
 * draws a frame of that size: corners at the corners, edges tiled from the adjacent corner, with the tile phase
 * fixed at the slice line so the middle band is a whole number of tiles. The centre stays transparent (the kit
 * draws the body fill separately).
 */
export function composeNine(p: Record<NinePiece, Raster>): { image: Raster; nine: { top: number; right: number; bottom: number; left: number } } {
  const L = Math.max(p.left_up.width, p.left_side.width, p.left_down.width)
  const R = Math.max(p.right_up.width, p.right_side.width, p.right_down.width)
  const T = Math.max(p.left_up.height, p.mid_up.height, p.right_up.height)
  const B = Math.max(p.left_down.height, p.mid_down.height, p.right_down.height)
  const M = tileSpan(p.mid_up.width, p.mid_down.width)
  const S = tileSpan(p.left_side.height, p.right_side.height)
  const W = L + M + R
  const H = T + S + B
  const rgba = new Uint8Array(W * H * 4)
  // Copies `src` tiled over [x0, x1) x [y0, y1), the tile origin at (ox, oy).
  const tile = (src: Raster, x0: number, y0: number, x1: number, y1: number, ox: number, oy: number): void => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      const sy = (((y - oy) % src.height) + src.height) % src.height
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        const sx = (((x - ox) % src.width) + src.width) % src.width
        const s = (sy * src.width + sx) * 4
        rgba.set(src.rgba.subarray(s, s + 4), (y * W + x) * 4)
      }
    }
  }
  const at = (src: Raster, x: number, y: number): void => tile(src, x, y, x + src.width, y + src.height, x, y)
  tile(p.mid_up, p.left_up.width, 0, W - p.right_up.width, p.mid_up.height, L, 0)
  tile(p.mid_down, p.left_down.width, H - p.mid_down.height, W - p.right_down.width, H, L, H - p.mid_down.height)
  tile(p.left_side, 0, p.left_up.height, p.left_side.width, H - p.left_down.height, 0, T)
  tile(p.right_side, W - p.right_side.width, p.right_up.height, W, H - p.right_down.height, W - p.right_side.width, T)
  at(p.left_up, 0, 0)
  at(p.right_up, W - p.right_up.width, 0)
  at(p.left_down, 0, H - p.left_down.height)
  at(p.right_down, W - p.right_down.width, H - p.right_down.height)
  return { image: { width: W, height: H, rgba }, nine: { top: T, right: R, bottom: B, left: L } }
}

/** A resinfo UV rect (UV_LT, UV_RB in 0..1 of the atlas) as atlas pixels [x, y, w, h]. */
export function uvToRect(lt: [number, number], rb: [number, number], atlasW: number, atlasH: number): [number, number, number, number] {
  const x = Math.round(lt[0] * atlasW)
  const y = Math.round(lt[1] * atlasH)
  return [x, y, Math.round(rb[0] * atlasW) - x, Math.round(rb[1] * atlasH) - y]
}

/** Every UV rect of a window_all control in a resinfo file (all #ifdef branches). */
export function atlasRectsInResinfo(text: string, atlasW = 1024, atlasH = 512): [number, number, number, number][] {
  const out: [number, number, number, number][] = []
  let ddj = ''
  let lt: [number, number] | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^\w+:\w+$/.test(line)) {
      ddj = ''
      lt = null
      continue
    }
    const m = line.match(/^(DDJ|UV_LT|UV_RB)=\w+,"(.*)"$/)
    if (!m) continue
    if (m[1] === 'DDJ') ddj = m[2]!.toLowerCase()
    else {
      const v = m[2]!.split(',').map(Number) as [number, number]
      if (m[1] === 'UV_LT') lt = v
      else if (lt && /window_all/.test(ddj)) out.push(uvToRect(lt, v, atlasW, atlasH))
    }
  }
  return out
}

/** The [x, y, w, h] region of `src` (clamped; outside texels are transparent). */
export function cropRaster(src: Raster, [x, y, w, h]: [number, number, number, number]): Raster {
  const rgba = new Uint8Array(w * h * 4)
  for (let yy = 0; yy < h; yy++) {
    if (y + yy < 0 || y + yy >= src.height) continue
    for (let xx = 0; xx < w; xx++) {
      if (x + xx < 0 || x + xx >= src.width) continue
      const s = ((y + yy) * src.width + x + xx) * 4
      rgba.set(src.rgba.subarray(s, s + 4), (yy * w + xx) * 4)
    }
  }
  return { width: w, height: h, rgba }
}

/** Text files in the client are ASCII/CP949 or UTF-16LE with a BOM. */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  return new TextDecoder('euc-kr').decode(bytes)
}

/** resinfo format: `Section = Name,...` { CTRL:CLASS { Key=TYPE,"value" ... } } */
function parseResinfo(text: string): Record<string, LayoutControl[]> {
  const sections: Record<string, LayoutControl[]> = {}
  let section: LayoutControl[] | null = null
  let ctrl: LayoutControl | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    let m: RegExpMatchArray | null
    if ((m = line.match(/^Section\s*=\s*([^,]+)/))) {
      section = sections[m[1]!.trim()] = []
      ctrl = null
    } else if ((m = line.match(/^(\w+):(\w+)$/)) && section) {
      ctrl = { name: m[1]!, class: m[2]!, ddj: [], rect: [0, 0, 0, 0], text: '' }
      section.push(ctrl)
    } else if ((m = line.match(/^(\w+)=(\w+),"(.*)"$/)) && ctrl) {
      const [, key, , value] = m as unknown as [string, string, string, string]
      if (key === 'DDJ' && value) ctrl.ddj.push(value.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase())
      else if (key === 'Rect') ctrl.rect = value.split(',').map(Number) as LayoutControl['rect']
      else if (key === 'Text') ctrl.text = value.trim()
      else if (key === 'ID') ctrl.id = Number(value)
    }
  }
  return sections
}

function exportImage(media: Pk2Archive, src: string, images: Record<string, ImageEntry>): void {
  const key = src.replace(/^interface\//, '').replace(/\.ddj$/i, '')
  if (images[key]) return
  const file = `ui/${key}.png`
  const dst = join(outDir, file)
  const bytes = media.read(src)
  const img = decodeDds(parseDdj(bytes).dds)
  images[key] = { file, src, width: img.width, height: img.height, format: img.format, content: contentBox(img.width, img.height, img.rgba) }
  if (!force && existsSync(dst) && statSync(dst).size > 0) return
  mkdirSync(dirname(dst), { recursive: true })
  writeFileSync(dst, encodePng(img.width, img.height, img.rgba))
}

/** Writes one DERIVED image. Always rewritten: it is cheap and must follow the code. */
function exportDerived(media: Pk2Archive, d: (typeof DERIVED)[number], images: Record<string, ImageEntry>): void {
  const src = `interface/${d.from}.ddj`
  const img = decodeDds(parseDdj(media.read(src)).dds)
  const { width: w, height: h } = img
  const rgba = new Uint8Array(img.rgba)
  const [rx, ry, rw, rh] = d.rect
  const mask = new Uint8Array(w * h)
  for (let y = Math.max(1, ry); y < Math.min(h - 1, ry + rh); y++) {
    for (let x = Math.max(1, rx); x < Math.min(w - 1, rx + rw); x++) {
      const o = (y * w + x) * 4
      const mx = Math.max(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!)
      const mn = Math.min(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!)
      if (mx > 40 && (mx - mn) / mx < 0.2) mask[y * w + x] = 1
    }
  }
  const grown = new Uint8Array(mask)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!mask[y * w + x]) continue
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) grown[(y + j) * w + x + i] = 1
    }
  }
  for (let y = Math.max(0, d.dy); y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!grown[y * w + x]) continue
      const o = (y * w + x) * 4
      const s = ((y - d.dy) * w + x) * 4
      for (let c = 0; c < 4; c++) rgba[o + c] = rgba[s + c]!
    }
  }
  const file = `ui/${d.key}.png`
  mkdirSync(dirname(join(outDir, file)), { recursive: true })
  writeFileSync(join(outDir, file), encodePng(w, h, rgba))
  images[d.key] = { file, src, width: w, height: h, format: img.format, content: contentBox(w, h, rgba), derived: { from: d.from, note: d.note } }
}

function decodeDdjRaster(media: Pk2Archive, src: string): Raster & { format: string } {
  const img = decodeDds(parseDdj(media.read(src)).dds)
  return { width: img.width, height: img.height, rgba: img.rgba, format: img.format }
}

/** Writes a generated image (always rewritten: it is cheap and must follow the code). */
function writeGenerated(key: string, r: Raster, entry: Omit<ImageEntry, 'file' | 'width' | 'height' | 'content'>, images: Record<string, ImageEntry>): void {
  const file = `ui/${key}.png`
  mkdirSync(dirname(join(outDir, file)), { recursive: true })
  writeFileSync(join(outDir, file), encodePng(r.width, r.height, r.rgba))
  images[key] = { file, width: r.width, height: r.height, content: contentBox(r.width, r.height, r.rgba), ...entry }
}

/** One nine-slice sheet per NINE_FRAMES family: ui/<prefix>9.png with `nine` insets. */
function exportNine(media: Pk2Archive, prefix: string, images: Record<string, ImageEntry>): void {
  const found: Partial<Record<NinePiece, Raster>> = {}
  let format = ''
  for (const piece of NINE_PIECES) {
    const src = `interface/${prefix}${piece}.ddj`
    if (!media.has(src)) continue
    const r = decodeDdjRaster(media, src)
    found[piece] = r
    format ||= r.format
  }
  const { pieces, synthesized } = completePieces(found)
  const { image, nine } = composeNine(pieces)
  const note = `nine-slice sheet of the 8 pieces; centre transparent${synthesized.length ? `; ${synthesized.join(' and ')} synthesized from the transposed sides (the family has none)` : ''}`
  writeGenerated(`${prefix}9`, image, { src: `interface/${prefix}*.ddj`, format, derived: { from: prefix, note }, nine }, images)
}

/** ATLAS_CROPS from ifcommon/window_all, each checked against the atlas UV rects in Media/resinfo. */
function exportAtlasCrops(media: Pk2Archive, images: Record<string, ImageEntry>, failures: string[]): number {
  const src = 'interface/ifcommon/window_all.ddj'
  const atlas = decodeDdjRaster(media, src)
  const known = new Set<string>()
  for (const f of media.list('resinfo')) {
    if (!f.path.toLowerCase().endsWith('.txt')) continue
    for (const r of atlasRectsInResinfo(decodeText(media.read(f)), atlas.width, atlas.height)) known.add(r.join(','))
  }
  let n = 0
  for (const c of ATLAS_CROPS) {
    if (known.size && !known.has(c.rect.join(','))) failures.push(`${c.key}: atlas rect ${c.rect.join(',')} is not a window_all UV rect in Media/resinfo (exported anyway)`)
    writeGenerated(c.key, cropRaster(atlas, c.rect), { src, format: atlas.format, derived: { from: 'ifcommon/window_all', note: `atlas ${c.rect.join(',')}: ${c.note}` } }, images)
    n++
  }
  return n
}

/** Media/cursor/cursor_normal1.tga (32-bit, bottom-up) -> ui/cursor/normal.png, hotspot about (2,2). */
function exportCursor(media: Pk2Archive, images: Record<string, ImageEntry>): void {
  const src = 'cursor/cursor_normal1.tga'
  const extracted = join(cfg.workDir, 'extracted', 'Media', src)
  const bytes = existsSync(extracted) ? readFileSync(extracted) : media.read(src)
  const img = decodeTga(bytes)
  writeGenerated('cursor/normal', img, { src, format: 'tga' }, images)
}

/**
 * The client fonts under ASCII names, from work/extracted/Media when present, else from Media.pk2.
 * english.ttf is copied; basic and chat are written as Latin subsets (font-subset.ts), since Chrome's font
 * sanitiser rejects the originals (docs/UI.md §2.6).
 */
function exportFonts(media: Pk2Archive, failures: string[]): Record<string, FontEntry> {
  const fonts: Record<string, FontEntry> = {}
  mkdirSync(fontDir, { recursive: true })
  for (const f of FONTS) {
    const file = `fonts/${f.key}.ttf`
    const dst = join(outDir, file)
    try {
      const extracted = join(cfg.workDir, 'extracted', 'Media', f.src)
      if (f.key !== 'english') {
        const r = subsetFont(existsSync(extracted) ? readFileSync(extracted) : media.read(f.src), { family: f.family })
        writeFileSync(dst, r.bytes)
        const subset = `Latin subset (font-subset.ts): ${r.glyphs} glyphs, ${r.mapped.length} code points, no hinting; the source lacks ${r.missing.length} of the kept code points (accented Latin falls back to the next font in the stack)`
        fonts[f.key] = { file, src: `Media/${f.src}`, family: f.family, role: f.role, subset }
        continue
      }
      if (force || !existsSync(dst) || statSync(dst).size === 0) {
        if (existsSync(extracted)) copyFileSync(extracted, dst)
        else writeFileSync(dst, media.read(f.src))
      }
      fonts[f.key] = { file, src: `Media/${f.src}`, family: f.family, role: f.role }
    } catch (err) {
      failures.push(`${f.src}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return fonts
}

function parseCameraPath(text: string): { region: [number, number]; pos: [number, number, number]; rot: [number, number, number]; value: number }[] {
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const n = line.split(/[\s,]+/).filter(Boolean).map(Number)
    if (n.length < 9 || n.some(v => !Number.isFinite(v))) continue
    rows.push({ region: [n[0]!, n[1]!] as [number, number], pos: [n[2]!, n[3]!, n[4]!] as [number, number, number], rot: [n[5]!, n[6]!, n[7]!] as [number, number, number], value: n[8]! })
  }
  return rows
}

function parseCameraData(text: string): number[][] {
  return text.split(/\r?\n/).map(l => l.trim().split(/\s+/).filter(Boolean).map(Number)).filter(r => r.length > 1 && r.every(Number.isFinite))
}

function main(): void {
  cfg = loadConfig()
  outDir = join(cfg.workDir, 'out')
  uiDir = join(outDir, 'ui')
  musicDir = join(outDir, 'music')
  fontDir = join(outDir, 'fonts')
  const media = openArchive('Media', cfg)
  const images: Record<string, ImageEntry> = {}
  const failures: string[] = []

  const sources = new Set<string>()
  for (const sel of SELECTION) {
    for (const f of media.list(sel.folder)) {
      const name = f.path.split('/').pop()!.toLowerCase()
      if (!name.endsWith('.ddj') || !sel.include.test(name) || sel.exclude?.test(name)) continue
      sources.add(`${sel.folder}/${name}`)
    }
  }

  const layouts: Record<string, string> = {}
  for (const name of LAYOUTS) {
    const path = `resinfo/${name}.txt`
    if (!media.has(path)) {
      failures.push(`${path}: missing`)
      continue
    }
    const parsed = parseResinfo(decodeText(media.read(path)))
    for (const controls of Object.values(parsed)) {
      for (const c of controls) for (const d of c.ddj) if (!/europe|islam/.test(d)) sources.add(d)
    }
    const file = `ui/layout/${name}.json`
    mkdirSync(join(uiDir, 'layout'), { recursive: true })
    writeFileSync(join(outDir, file), JSON.stringify({ source: `Media/${path}`, space: [1600, 1200], sections: parsed }, null, 2))
    layouts[name] = file
  }

  let n = 0
  for (const src of [...sources].sort()) {
    try {
      exportImage(media, src, images)
      n++
    } catch (err) {
      failures.push(`${src}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const d of DERIVED) {
    try {
      exportDerived(media, d, images)
      n++
    } catch (err) {
      failures.push(`${d.key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const prefix of NINE_FRAMES) {
    try {
      exportNine(media, prefix, images)
      n++
    } catch (err) {
      failures.push(`${prefix}9: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try {
    n += exportAtlasCrops(media, images, failures)
  } catch (err) {
    failures.push(`ifcommon/window_all crops: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    exportCursor(media, images)
    n++
  } catch (err) {
    failures.push(`cursor/cursor_normal1.tga: ${err instanceof Error ? err.message : String(err)}`)
  }

  const fonts = exportFonts(media, failures)

  const music: Record<string, string> = {}
  mkdirSync(musicDir, { recursive: true })
  for (const name of MUSIC) {
    const dst = join(musicDir, name)
    const file = `music/${name}`
    try {
      if (force || !existsSync(dst)) {
        const extracted = join(cfg.workDir, 'extracted', 'Music', name)
        if (existsSync(extracted)) copyFileSync(extracted, dst)
        else writeFileSync(dst, openArchive('Music', cfg).read(name))
      }
      music[name.replace(/\.ogg$/, '')] = file
    } catch (err) {
      failures.push(`music ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let cameraPath: ReturnType<typeof parseCameraPath> = []
  let cameraData: number[][] = []
  try {
    cameraPath = parseCameraPath(decodeText(openArchive('Map', cfg).read('camera_path.txt')))
  } catch (err) {
    failures.push(`Map/camera_path.txt: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    cameraData = parseCameraData(decodeText(media.read('config/cameradata.txt')))
  } catch (err) {
    failures.push(`Media/config/cameradata.txt: ${err instanceof Error ? err.message : String(err)}`)
  }

  const manifest = {
    version: 1,
    generator: 'packages/convert/src/tools/export-ui.ts',
    generatedAt: new Date().toISOString(),
    images,
    layouts,
    music,
    fonts,
    bakedText: Object.fromEntries(Object.entries(BAKED_TEXT).filter(([k]) => images[k])),
    englishText: Object.fromEntries(Object.entries(ENGLISH_TEXT).filter(([k]) => images[k])),
    backdrop: {
      note: 'Raw values; see apps/game/README.md "Login / character-select backdrop".',
      cameraPath,
      cameraData,
    },
    failures,
  }
  mkdirSync(uiDir, { recursive: true })
  writeFileSync(join(uiDir, 'index.json'), JSON.stringify(manifest, null, 2))
  console.log(`ui: ${n} images, ${Object.keys(layouts).length} layouts, ${Object.keys(music).length} music, ${Object.keys(fonts).length} fonts -> ${outDir}`)
  for (const f of failures) console.warn(`  ! ${f}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

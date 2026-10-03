/**
 * Styles of the GM window (gm/window.ts) and its content editors (lane ED-C: the Spawns / NPCs / Quests tabs and the
 * Quest Editor window), injected once so neither edits the shared style.css. Wave 7B UI-G (docs/UI.md §4.6, §9.1):
 * the retail kit look. The GM window itself is a kit Window (mframe, flex tabs, List, TextInput …); the editors keep
 * their plain DOM (gm-field, gm-list, gm-ed-row, gm-section …) and get the same retail art from here:
 *   - inputs / selects / text areas: `frame_msg_` on `com_bg_tile_e` (the kit field);
 *   - lists: `com_blacksquare_` boxes, rows on the `com_bar01_` bar, the selection on `com_bar01select_`;
 *   - check boxes: `com_checkbutton_{off,on}`; small buttons: `com_s_button`;
 *   - the Quest Editor window: the `mframe_wnd_` frame on `com_bg_tile_a`, drawn by pseudo-elements (the
 *     `outer/unity_window` look goes away) with the kit's title and close-button placement.
 * The art URLs come from the manifest at runtime: `applyGmArt()` sets them as `--gm-*` custom properties (plus the
 * `gm-art` class) on the world root, the common parent of the GM window and the Quest Editor. Without the art the
 * rules below fall back to the kit's CSS stand-ins (dark body, gold rim).
 */
import type { Art } from '../../ui/art.ts'

/** Art keys behind the `--gm-*` custom properties. */
export const GM_ART = {
  '--gm-field': 'frame/frame_msg_9',
  '--gm-black': 'ifcommon/com_blacksquare_9',
  '--gm-mframe': 'frame/mframe_wnd_9',
  '--gm-tile-a': 'ifcommon/bg_tile/com_bg_tile_a',
  '--gm-tile-e': 'ifcommon/bg_tile/com_bg_tile_e',
  '--gm-bar-l': 'ifcommon/com_bar01_left',
  '--gm-bar-m': 'ifcommon/com_bar01_mid',
  '--gm-bar-r': 'ifcommon/com_bar01_right',
  '--gm-sel-l': 'ifcommon/com_bar01select_left',
  '--gm-sel-m': 'ifcommon/com_bar01select_mid',
  '--gm-sel-r': 'ifcommon/com_bar01select_right',
  '--gm-check-off': 'ifcommon/com_checkbutton_off',
  '--gm-check-on': 'ifcommon/com_checkbutton_on',
  '--gm-sbtn': 'ifcommon/com_s_button',
  '--gm-sbtn-focus': 'ifcommon/com_s_button_focus',
  '--gm-sbtn-press': 'ifcommon/com_s_button_press',
  '--gm-grayline': 'ifcommon/com_grayline',
} as const

/** The `--gm-*` properties the art has (a missing key is left out, so the var() fallback applies). */
export function gmArtVars(art: Art): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, key] of Object.entries(GM_ART)) if (art.has(key)) out[name] = art.cssUrl(key)
  return out
}

/**
 * Puts the GM art on `host` (the world root) and returns the undo. The `gm-art` class switches the art rules on
 * only when the core sheets (field, list box, bar, frame) are all there.
 */
export function applyGmArt(host: HTMLElement, art: Art): () => void {
  const vars = gmArtVars(art)
  for (const [k, v] of Object.entries(vars)) host.style.setProperty(k, v)
  const full = ['--gm-field', '--gm-black', '--gm-mframe', '--gm-bar-m', '--gm-sel-m'].every(k => k in vars)
  host.classList.toggle('gm-art', full)
  return () => {
    for (const k of Object.keys(vars)) host.style.removeProperty(k)
    host.classList.remove('gm-art')
  }
}

const CSS = `
/* ---- the GM window (kit Window 'gm') ---- */
.gm-layer { position: absolute; inset: 0; pointer-events: none; zoom: var(--ui); z-index: 3; }
.gm-kit .kit-window-body { display: flex; flex-direction: column; gap: 2px; }
.gm-kit .gm-tabs { flex: none; gap: 1px; padding-left: 4px; }
.gm-kit .gm-tabs-extra { flex: none; }
.gm-kit .gm-tabs-extra[hidden] { display: none; }
.gm-kit .gm-page { position: relative; flex: 1 1 auto; min-height: 0; }
.gm-kit .gm-pane { position: absolute; inset: 10px; }
.gm-kit .gm-pane[hidden] { display: none !important; }
.gm-kit .gm-pane-flex { display: flex; flex-direction: column; gap: 6px; }
.gm-kit .gm-panel-extra { display: flex; flex-direction: column; overflow-x: hidden; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #8a7446 #0b0906; }
.gm-kit .gm-scroll-body { display: flex; flex-direction: column; padding: 2px 4px 4px 2px; }
.gm-kit .gm-status { flex: none; height: 15px; margin-top: 2px; padding: 0 4px; border: 0; font: 11px/15px var(--font-body); color: var(--c-hint);
  text-shadow: var(--t-shadow); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gm-kit .gm-status.bad { color: var(--c-bad); }
.gm-kit .kit-window-close { z-index: 3; }

/* players and log: a list box (com_blacksquare_) holding the kit List / ScrollArea */
.gm-kit .gm-listbox { position: relative; flex: 1 1 auto; min-height: 64px; }
.gm-kit .gm-listbox > .kit-scroll { position: absolute; inset: 4px; }
.gm-kit .gm-listbox > .gm-empty { position: absolute; left: 4px; right: 4px; top: 40%; padding: 0; text-align: center; }
.gm-kit .gm-listbox > .gm-empty[hidden] { display: none; }
.gm-kit .gm-prow, .gm-kit .gm-phead { display: grid; grid-template-columns: minmax(0, 1fr) 22px 132px 156px; align-items: center; gap: 6px; }
.gm-kit .gm-prow { flex: 1 1 auto; min-width: 0; height: 100%; }
.gm-kit .gm-phead { flex: none; padding: 0 29px 0 12px; font: 11px/15px var(--font-title); color: var(--c-label); text-shadow: var(--t-outline); }
.gm-kit .gm-c-lv { text-align: right; color: var(--c-level); }
.gm-kit .gm-c-pos { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gm-kit .gm-c-act { display: flex; gap: 2px; justify-content: flex-end; }
.gm-kit .gm-pname { color: var(--c-text); font-family: var(--font-title); }
.gm-kit .gm-badge { color: var(--c-hint); }
.gm-kit .gm-badge.gm, .gm-kit .gm-badge.admin { color: var(--c-level); background: rgba(255, 217, 83, 0.14); }
.gm-kit .gm-badge.you { color: var(--c-mastery); }
.gm-kit .gm-badge.ghost { color: var(--c-chat-stall); }
.gm-kit .gm-log-body { padding: 2px 0; }
.gm-kit .gm-log-line { padding: 1px 4px; font: 12px/15px var(--font-chat); text-shadow: var(--t-shadow); }
.gm-kit .gm-log-line.sent { color: var(--c-hint); }
.gm-kit .gm-log-line.ok { color: var(--c-chat-gm); }
.gm-kit .gm-log-line.fail { color: var(--c-chat-error); }
.gm-kit .gm-log-time { color: #8a8472; }

/* controls */
.gm-kit .gm-code .kit-input { text-transform: uppercase; }
.gm-kit .gm-area { width: 100%; height: 150px; }
.gm-kit .gm-notice-text { position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box; margin: 0; padding: 4px 6px; border: 0; resize: none;
  background: transparent; color: var(--c-text); font: 12px/16px var(--font-body); outline: none; user-select: text; -webkit-user-select: text; }
.gm-kit .gm-value { min-width: 34px; color: var(--c-level); font: 12px var(--font-title); text-shadow: var(--t-outline); }
.gm-kit .gm-value.changed { color: var(--c-text); }
.gm-kit .gm-cursor { margin-bottom: 6px; color: var(--c-mastery); text-shadow: var(--t-shadow); }
.gm-kit .gm-places { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.gm-kit .gm-place-groups { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.gm-kit .gm-place-head { display: block; margin-bottom: 3px; font-size: 11px; }
.gm-kit .kit-btn-label { padding: 0 2px; }

/* ---- shared by the window, the editor tabs and the Quest Editor ---- */
:is(.gm-kit, .gm-qe) .gm-section { position: relative; padding: 0 0 8px; border: 0; background: none; }
:is(.gm-kit, .gm-qe) .gm-section + .gm-section { padding-top: 8px; background: var(--gm-grayline, linear-gradient(rgba(156, 131, 80, 0.4), rgba(156, 131, 80, 0.4))) no-repeat 0 0 / 100% 1px; }
:is(.gm-kit, .gm-qe) .gm-section-title { margin-bottom: 5px; font: 12px/15px var(--font-title); color: var(--c-heading); text-shadow: var(--t-outline); }
:is(.gm-kit, .gm-qe) .gm-line, :is(.gm-kit, .gm-qe) .gm-bar { gap: 6px; }
:is(.gm-kit, .gm-qe) .gm-label { color: var(--c-label); text-shadow: var(--t-shadow); }
:is(.gm-kit, .gm-qe) .gm-muted, :is(.gm-kit, .gm-qe) .gm-hint, :is(.gm-kit, .gm-qe) .gm-sub, :is(.gm-kit, .gm-qe) .gm-empty { color: var(--c-hint); text-shadow: var(--t-shadow); }
:is(.gm-kit, .gm-qe) .gm-hint { font-size: 11px; line-height: 14px; }
:is(.gm-kit, .gm-qe) .gm-field { box-sizing: border-box; height: 20px; padding: 0 5px; border: 1px solid var(--c-rim); background: #0b0906; color: var(--c-text);
  font: 12px var(--font-body); outline: none; color-scheme: dark; }
:is(.gm-kit, .gm-qe) .gm-field:focus { border-color: var(--c-level); }
:is(.gm-kit, .gm-qe) .gm-field:disabled { color: var(--c-button-off); }
:is(.gm-kit, .gm-qe) select.gm-field, .gm-qe select { padding: 0 2px; }
:is(.gm-kit, .gm-qe) select option { background: #0b0906; color: var(--c-text); }
.gm-art :is(.gm-kit, .gm-qe) .gm-field, .gm-art .gm-qe select {
  border: 1px solid transparent; border-image: var(--gm-field) 4 / 4px / 0 repeat; background: var(--gm-tile-e) repeat; }
.gm-art :is(.gm-kit, .gm-qe) .gm-field:focus { outline: 1px solid var(--c-level); outline-offset: -1px; }
:is(.gm-kit, .gm-qe) .gm-list { border: 1px solid var(--c-rim); background: #0b0906; scrollbar-width: thin; scrollbar-color: #8a7446 #0b0906; }
.gm-art :is(.gm-kit, .gm-qe) .gm-list { border: 4px solid transparent; border-image: var(--gm-black) 4 / 4px / 0 repeat; background: var(--gm-tile-e) repeat; background-clip: padding-box; }
.gm-art :is(.gm-kit, .gm-qe) .gm-ed-checkbox, .gm-art .gm-qe .gm-check input[type='checkbox'] {
  appearance: none; -webkit-appearance: none; flex: none; width: 16px; height: 16px; margin: 0; border: 0; background: var(--gm-check-off) no-repeat 0 0 / 100% 100%; cursor: inherit; }
.gm-art :is(.gm-kit, .gm-qe) .gm-ed-checkbox:checked, .gm-art .gm-qe .gm-check input[type='checkbox']:checked { background-image: var(--gm-check-on); }
:is(.gm-kit, .gm-qe) .gm-ed-checkbox:focus-visible { outline: 1px solid var(--c-level); outline-offset: 1px; }
:is(.gm-kit, .gm-qe) .gm-check { color: var(--c-text); text-shadow: var(--t-shadow); }

/* ---- editor tabs (Spawns, NPCs, Quests) ---- */
.gm-ed { display: flex; flex-direction: column; gap: 5px; height: 100%; min-height: 0; }
.gm-ed .gm-list { flex: 1 1 auto; min-height: 90px; overflow-y: auto; }
.gm-ed-row { display: grid; grid-template-columns: 74px 1fr 64px 44px 62px; align-items: center; gap: 4px; min-height: 22px; padding: 1px 6px;
  border-bottom: 1px solid rgba(156, 131, 80, 0.2); cursor: pointer; white-space: nowrap; color: var(--c-text); text-shadow: var(--t-shadow); }
.gm-ed-row > span { overflow: hidden; text-overflow: ellipsis; }
.gm-ed-row:hover { background: rgba(255, 220, 140, 0.06); }
.gm-ed-row.selected { background: rgba(233, 138, 44, 0.2); box-shadow: inset 0 0 0 1px #e98a2c; }
.gm-ed-row.off { color: var(--c-button-off); }
.gm-ed-row.gm-ed-npc { grid-template-columns: 96px 1fr 44px 62px; }
.gm-ed-head { cursor: default; color: var(--c-label); font: 11px/15px var(--font-title); text-shadow: var(--t-outline); }
.gm-ed-head:hover { background: none; }
.gm-art :is(.gm-kit, .gm-qe) :is(.gm-ed-row:not(.gm-ed-head), .gm-qe-qrow) {
  min-height: 24px; margin-bottom: 1px; border-bottom: 0;
  background: var(--gm-bar-l) left top / 4px 100% no-repeat, var(--gm-bar-r) right top / 4px 100% no-repeat, var(--gm-bar-m) 0 0 / auto 100% repeat-x; }
.gm-art :is(.gm-kit, .gm-qe) :is(.gm-ed-row:not(.gm-ed-head), .gm-qe-qrow):hover { filter: brightness(1.2); }
.gm-art :is(.gm-kit, .gm-qe) :is(.gm-ed-row, .gm-qe-qrow).selected { box-shadow: none; background-image: var(--gm-sel-l), var(--gm-sel-r), var(--gm-sel-m); }
.gm-ed-src { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; text-align: center; border-radius: 2px; padding: 0 3px; text-shadow: none; }
.gm-ed-src.authored { color: var(--c-good); border: 1px solid rgba(124, 255, 107, 0.45); }
.gm-ed-src.patched, .gm-ed-src.override { color: var(--c-level); border: 1px solid rgba(255, 217, 83, 0.45); }
.gm-ed-src.export, .gm-ed-src.repo { color: var(--c-hint); border: 1px solid rgba(176, 176, 176, 0.35); }
.gm-ed-src.hidden, .gm-ed-src.disabled { color: var(--c-chat-error); border: 1px solid rgba(255, 106, 90, 0.45); }
.gm-ed .gm-field.gm-ed-code { width: 170px; text-transform: uppercase; }
.gm-ed .gm-field.gm-ed-short { width: 52px; }
.gm-ed .gm-field.gm-ed-mid { width: 76px; }
.gm-ed .gm-field.gm-ed-name { width: 150px; }
.gm-ed .gm-section { padding-bottom: 6px; }
.gm-ed .gm-section + .gm-section { padding-top: 6px; }
.gm-ed .gm-section-title { margin-bottom: 3px; }
.gm-ed-sel { color: var(--c-level); font-size: 11px; min-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: var(--t-shadow); }
.gm-ed .gm-check { display: inline-flex; align-items: center; gap: 4px; cursor: inherit; }
.gm-ed-checkbox { accent-color: #c9a24a; margin: 0; }
.gm-nest-labels { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.gm-nest-label { position: absolute; left: 0; top: 0; transform: translate(-50%, -100%); white-space: nowrap; font: 11px var(--font-title);
  color: #ffe9a6; text-shadow: 0 0 2px #000, 0 1px 2px #000; padding: 1px 5px; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(201, 162, 74, 0.45); border-radius: 2px; }
.gm-nest-label.selected { color: #fff; border-color: #ffb54a; background: rgba(90, 50, 0, 0.55); }
.gm-nest-label.off { color: #bbb; border-color: rgba(160, 160, 160, 0.45); }
.gm-nest-label.authored { border-color: rgba(120, 200, 110, 0.6); }

/* ---- Quest Editor window ---- */
.gm-window.gm-qe { z-index: 4; }
.gm-art .gm-window.gm-qe { border-style: solid; border-color: transparent; border-width: 36px 16px 16px; border-image: none; background: none; }
.gm-art .gm-window.gm-qe::before, .gm-art .gm-window.gm-qe::after { content: ''; position: absolute; pointer-events: none; }
/* the body tile under the frame edges (the kit draws it 8 px in from the outer rim), then the mframe sheet */
.gm-art .gm-window.gm-qe::after { inset: -28px -8px -8px; z-index: -2; background: var(--gm-tile-a) repeat; image-rendering: var(--art-rendering); }
.gm-art .gm-window.gm-qe::before { inset: -36px -16px -16px; z-index: -1; box-sizing: border-box; border-style: solid; border-color: transparent;
  border-width: 68px 40px 48px; border-image: var(--gm-mframe) 68 40 48 fill / 68px 40px 48px / 0 repeat; image-rendering: var(--art-rendering); }
.gm-art .gm-window.gm-qe .gm-header { top: -36px; left: -16px; right: -16px; height: 36px; padding: 0 32px; justify-content: center; }
.gm-art .gm-window.gm-qe .gm-title { font: 12px/14px var(--font-title); color: var(--c-caption); letter-spacing: 0; text-shadow: var(--t-outline);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gm-art .gm-window.gm-qe .gm-close { right: 12px; top: 10px; }
.gm-qe .gm-status { color: var(--c-hint); border-top: 0; }
.gm-qe .gm-status.bad { color: var(--c-bad); }
.gm-qe-main { flex: 1; min-height: 0; display: grid; grid-template-columns: 232px 1fr; gap: 6px; padding: 6px 8px 4px; }
.gm-qe-left { display: flex; flex-direction: column; gap: 4px; min-height: 0; }
.gm-qe-left .gm-list { flex: 1; }
.gm-qe-filters { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.gm-qe-filters select, .gm-qe select { box-sizing: border-box; height: 20px; border: 1px solid var(--c-rim); background: #0b0906; color: var(--c-text); font: 12px var(--font-body); color-scheme: dark; }
.gm-qe-filters .gm-field { width: 100%; }
.gm-qe-qrow { padding: 2px 6px; border-bottom: 1px solid rgba(156, 131, 80, 0.2); cursor: pointer; color: var(--c-text); text-shadow: var(--t-shadow); }
.gm-qe-qrow:hover { background: rgba(255, 220, 140, 0.06); }
.gm-qe-qrow.selected { background: rgba(233, 138, 44, 0.2); box-shadow: inset 0 0 0 1px #e98a2c; }
.gm-qe-qrow .id { color: var(--c-level); font-size: 11px; margin-right: 4px; }
.gm-qe-qrow .badges { float: right; display: inline-flex; gap: 2px; }
.gm-qe-qrow .title { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gm-qe-qrow.off .title { color: var(--c-button-off); text-decoration: line-through; }
.gm-qe-issues-n { color: var(--c-chat-error); font-size: 10px; }
.gm-qe-warn-n { color: var(--c-level); font-size: 10px; }
.gm-qe-right { display: flex; flex-direction: column; min-height: 0; gap: 4px; }
.gm-qe-form { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #8a7446 #0b0906; display: flex; flex-direction: column; gap: 6px; padding-right: 4px; }
.gm-qe-empty { color: var(--c-hint); padding: 30px 10px; text-align: center; text-shadow: var(--t-shadow); }
.gm-qe-grid { display: grid; grid-template-columns: 88px 1fr 88px 1fr; gap: 4px 6px; align-items: center; }
.gm-qe-grid > label { color: var(--c-label); font-size: 11px; text-align: right; text-shadow: var(--t-shadow); }
.gm-qe-grid .gm-field, .gm-qe-grid select { width: 100%; box-sizing: border-box; }
.gm-qe-wide { grid-column: 2 / span 3; }
.gm-qe-pick { display: flex; gap: 3px; align-items: center; }
.gm-qe-pick .gm-field { flex: 1; min-width: 0; }
.gm-qe textarea.gm-field { height: 54px; width: 100%; box-sizing: border-box; padding: 3px 5px; resize: vertical; font: 12px/1.35 var(--font-body); }
.gm-qe .gm-bad, .gm-qe .gm-field.gm-bad { border-color: var(--c-bad) !important; box-shadow: 0 0 0 1px var(--c-bad); }
.gm-qe .gm-warn { border-color: #e0b03a !important; }
.gm-qe-card { border: 1px solid rgba(156, 131, 80, 0.4); background: rgba(0, 0, 0, 0.3); padding: 4px 6px 6px; display: flex; flex-direction: column; gap: 4px; }
.gm-art .gm-qe-card { border: 4px solid transparent; border-image: var(--gm-black) 4 / 4px / 0 repeat; background: rgba(0, 0, 0, 0.35); background-clip: padding-box; padding: 2px 4px 4px; }
.gm-qe-card-head { display: flex; gap: 4px; align-items: center; }
.gm-qe-card-head .n { color: var(--c-level); min-width: 16px; }
.gm-qe-list { display: flex; flex-direction: column; gap: 3px; }
.gm-qe-line { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.gm-qe-line .gm-field { min-width: 0; }
.gm-qe-chips { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; }
.gm-qe-chip { display: inline-flex; gap: 4px; align-items: center; padding: 0 2px 0 6px; border: 1px solid rgba(201, 162, 74, 0.5); background: rgba(60, 45, 15, 0.5); font-size: 11px; }
.gm-qe-x { border: 0; background: none; color: var(--c-chat-error); cursor: inherit; font: 12px var(--font-body); padding: 0 3px; }
.gm-qe-x:hover { color: #fff; }
.gm-qe-mini { box-sizing: border-box; height: 20px; padding: 0 6px; border: 1px solid #8a7446; background: #2a2112; color: var(--c-button); font: 11px var(--font-body); text-shadow: var(--t-shadow); cursor: inherit; }
.gm-qe-mini:hover { background: #3c2f18; color: #fff; }
.gm-art .gm-qe-mini { min-width: 44px; padding: 0 2px; border-style: solid; border-color: transparent; border-width: 0 5px; background: none;
  border-image: var(--gm-sbtn) 0 5 fill / 0 5px / 0 stretch; }
.gm-art .gm-qe-mini:hover:not(:disabled) { border-image-source: var(--gm-sbtn-focus, var(--gm-sbtn)); background: none; }
.gm-art .gm-qe-mini:active:not(:disabled) { border-image-source: var(--gm-sbtn-press, var(--gm-sbtn)); }
.gm-qe-mini:disabled { opacity: 0.5; cursor: default; }
.gm-qe-list > .gm-qe-mini { align-self: flex-start; }
.gm-qe-preview { font-size: 10px; color: var(--c-hint); }
.gm-qe-dialog { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.gm-qe-npcpage { border: 1px solid #6f5a33; background: linear-gradient(#1c160c, #0d0a05); padding: 6px 8px; color: #e9dfc5; font: 12px/1.45 var(--font-body);
  white-space: pre-wrap; min-height: 54px; max-height: 120px; overflow-y: auto; }
.gm-qe-npcpage .who { display: block; color: var(--c-level); font: 12px var(--font-title); margin-bottom: 3px; }
.gm-qe-tabs3 { display: flex; gap: 3px; }
.gm-qe-issues { max-height: 86px; overflow-y: auto; border: 1px solid #5a5a5a; background: rgba(0, 0, 0, 0.45); scrollbar-width: thin; }
.gm-art .gm-qe-issues { border: 4px solid transparent; border-image: var(--gm-black) 4 / 4px / 0 repeat; background: var(--gm-tile-e) repeat; background-clip: padding-box; }
.gm-qe-issues[hidden] { display: none; }
.gm-qe-issue { padding: 1px 6px; font-size: 11px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gm-qe-issue:hover { background: rgba(255, 220, 140, 0.08); }
.gm-qe-issue.error { color: var(--c-chat-error); }
.gm-qe-issue.warning { color: var(--c-level); }
.gm-qe-issue .p { color: var(--c-hint); margin-right: 6px; }
.gm-qe-actions { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
.gm-qe-actions .spacer { flex: 1; }
.gm-qe-dirty { color: var(--c-level); font-size: 11px; }
`

let injected = false

/** Injects the GM window / editor sheet once (the GM window and the editor tabs both call it). */
export function injectEditorStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.id = 'gm-editors-style'
  style.textContent = CSS
  document.head.append(style)
}

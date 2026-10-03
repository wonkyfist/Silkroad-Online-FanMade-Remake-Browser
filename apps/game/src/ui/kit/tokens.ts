/**
 * Design tokens and the kit's one stylesheet (`#kit-styles`, docs/UI.md §4.3–4.4). Colours, type and outlines are
 * defined once here; lanes use the `--c-*` tokens and the `.kit-t-*` classes and write no colour literals.
 * Sizes in this sheet are native px: in game every kit element lives in a zoomed layer (`.hud-root` / `.world-ui`,
 * zoom: var(--ui)); body-level layers (tooltip, message boxes) zoom themselves.
 */

/** Colour tokens (UI.md §4.4; guild name D19, chat stall). */
export const TOKENS = {
  '--c-text': '#ffffff',
  '--c-label': '#efdaa4',
  '--c-level': '#ffd953',
  '--c-button': '#fefbd8',
  '--c-button-off': '#8a8a8a',
  '--c-caption': '#fff7ca',
  '--c-highlight': '#ffef99',
  '--c-heading': '#ffe27b',
  '--c-mastery': '#97e0ff',
  '--c-party-name': '#ffff94',
  '--c-guild-name': '#8fd18f',
  '--c-warn': '#ffff00',
  '--c-bad': '#ff4a3d',
  '--c-good': '#7cff6b',
  '--c-ink': '#3d2200',
  '--c-magic': '#50cefa',
  '--c-hint': '#b0b0b0',
  '--c-chat-all': '#ffffff',
  '--c-chat-party': '#fff57a',
  '--c-chat-guild': '#ffba4d',
  '--c-chat-whisper': '#ef99ff',
  '--c-chat-system': '#ffd953',
  '--c-chat-notice': '#ffff00',
  '--c-chat-gm': '#7fd3ff',
  '--c-chat-error': '#ff6a5a',
  '--c-chat-stall': '#c6b6ff',
  '--c-hp': '#d8262c',
  '--c-mp': '#2c56d8',
  '--c-rim': '#9c8350',
  '--c-body-bg': 'rgba(12, 10, 8, 0.92)',
} as const

/** Type tokens (UI.md §4.3): font / size / line-height / colour / effect per role. */
export const TYPE = {
  title: { font: '12px/14px var(--font-title)', color: 'var(--c-caption)', effect: 'outline' },
  caption: { font: '11px/13px var(--font-title)', color: 'var(--c-text)', effect: 'outline' },
  label: { font: '12px/15px var(--font-body)', color: 'var(--c-label)', effect: 'shadow' },
  value: { font: '12px/15px var(--font-body)', color: 'var(--c-text)', effect: 'shadow' },
  level: { font: '12px/14px var(--font-title)', color: 'var(--c-level)', effect: 'outline' },
  gauge: { font: 'bold 11px/12px var(--font-body)', color: 'var(--c-text)', effect: 'outline' },
  small: { font: '10px/11px var(--font-body)', color: 'var(--c-text)', effect: 'outline' },
  button: { font: '12px/24px var(--font-body)', color: 'var(--c-button)', effect: 'shadow' },
  chat: { font: '12px/15px var(--font-chat)', color: 'var(--c-chat-all)', effect: 'shadow' },
  body: { font: '12px/16px var(--font-body)', color: 'var(--c-text)', effect: 'shadow' },
  paper: { font: '12px/16px var(--font-body)', color: 'var(--c-ink)', effect: 'none' },
} as const

const OUTLINE = '1px 0 #000, -1px 0 #000, 0 1px #000, 0 -1px #000'
const SHADOW = '0 1px 1px #000'

function typeCss(): string {
  return Object.entries(TYPE)
    .map(([k, v]) => `.kit-t-${k} { font: ${v.font}; color: ${v.color}; text-shadow: ${v.effect === 'outline' ? 'var(--t-outline)' : v.effect === 'shadow' ? 'var(--t-shadow)' : 'none'}; }`)
    .join('\n')
}

export const KIT_CSS = `
:root {
${Object.entries(TOKENS)
  .map(([k, v]) => `  ${k}: ${v};`)
  .join('\n')}
  --t-outline: ${OUTLINE};
  --t-shadow: ${SHADOW};
  --art-rendering: auto;
}

/* ---- type ---- */
${typeCss()}
.kit-num { font-variant-numeric: tabular-nums; }
.kit-fit { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.kit-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; min-width: 0; }
.kit-row > :first-child { flex: 1 1 auto; min-width: 0; }

/* ---- art ---- */
.kit-frame, .kit-frame *, .kit-btn, .kit-tab, .kit-gauge-fill, .kit-slot, .kit-slot *, .kit-toggle-box, .kit-slider-thumb, .kit-slider-track,
.kit-scroll-track, .kit-scroll-thumb, .kit-main-strip, .kit-list-row, .kit-notice-rim, .kit-drag-ghost, .kit-icon { image-rendering: var(--art-rendering); }

/* ---- frames ---- */
.kit-frame { position: absolute; inset: 0; pointer-events: none; }
.kit-frame-fill { position: absolute; background-repeat: repeat; }
.kit-frame-edge { position: absolute; inset: 0; box-sizing: border-box; }
.kit-frame.no-art { background: var(--c-body-bg); border: 1px solid var(--c-rim); box-shadow: inset 0 0 0 1px #000, 0 0 0 1px #000; }
.kit-frame-main.no-art::before, .kit-frame-dialog.no-art::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 34px;
  background: linear-gradient(#3b3326, #16120c); border-bottom: 1px solid var(--c-rim);
}
.kit-frame-dialog.no-art::before { height: 28px; }
.kit-frame-section.no-art::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 20px; background: linear-gradient(#27456e, #10213a); }
.kit-frame-tooltip.no-art { background: none; border-color: #2a4a8a; }
.kit-box { position: relative; box-sizing: border-box; }
.kit-box-body { box-sizing: border-box; }
.kit-section-caption { position: absolute; left: 10px; right: 10px; top: 0; display: flex; align-items: center; justify-content: center; white-space: nowrap; overflow: hidden; }
.kit-section-caption[hidden] { display: none; }

/* ---- windows ---- */
.kit-window { position: absolute; box-sizing: border-box; pointer-events: auto; color: var(--c-text); font: 12px/15px var(--font-body); }
.kit-window[hidden] { display: none; }
.kit-window-title { position: absolute; left: 32px; right: 32px; top: 0; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: move; touch-action: none; }
.kit-btn.kit-window-close { position: absolute; z-index: 2; }
.kit-window-grip { position: absolute; right: 3px; bottom: 3px; width: 12px; height: 12px; z-index: 3; cursor: nwse-resize; touch-action: none;
  background: linear-gradient(135deg, transparent 55%, rgba(201, 168, 96, 0.8) 55%, rgba(201, 168, 96, 0.8) 65%, transparent 65%, transparent 75%, rgba(201, 168, 96, 0.8) 75%); }
.kit-main-strip { position: absolute; left: -42px; top: 55px; width: 48px; height: 326px; background: no-repeat 0 0 / 48px auto; pointer-events: none; }
.kit-main-strip.no-art { background: var(--c-body-bg); border: 1px solid var(--c-rim); border-right: 0; }
.kit-btn.kit-main-tab { position: absolute; z-index: 2; }
.kit-main-tab.on { border-image-source: var(--img-press, none); }
.kit-main-tab.no-art.on { box-shadow: inset 0 0 0 2px var(--c-level); }
.kit-main-page { position: absolute; inset: 0; }
.kit-main-page[hidden] { display: none; }

/* ---- buttons ---- */
.kit-btn {
  position: relative; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; flex: none;
  margin: 0; padding: 0; background: none; border-style: solid; border-color: transparent;
  border-width: 0 calc(var(--slice, 0) * 1px);
  border-image: var(--img) 0 var(--slice, 0) fill / 0 calc(var(--slice, 0) * 1px) / 0 stretch;
  color: var(--c-button); font: 12px/1 var(--font-body); text-shadow: var(--t-shadow); cursor: inherit; vertical-align: middle;
}
.kit-btn:hover:not(.disabled), .kit-btn.is-focus { border-image-source: var(--img-focus); }
.kit-btn:active:not(.disabled), .kit-btn.is-press { border-image-source: var(--img-press); }
.kit-btn:active:not(.disabled) .kit-btn-label, .kit-btn.is-press .kit-btn-label { transform: translateY(1px); }
.kit-btn.disabled { border-image-source: var(--img-disable, var(--img)); color: var(--c-button-off); }
.kit-btn.disabled.kit-no-disable-art { filter: grayscale(0.85) brightness(0.7); }
.kit-btn:focus-visible { outline: 1px solid var(--c-level); outline-offset: -4px; }
.kit-btn.no-art { border: 1px solid #c9a860; border-radius: 2px; background: linear-gradient(#6d5a33, #3a2f1b); }
.kit-btn.no-art:hover:not(.disabled), .kit-btn.no-art.is-focus { background: linear-gradient(#a0612c, #5a3316); }
.kit-btn.no-art:active:not(.disabled), .kit-btn.no-art.is-press { background: linear-gradient(#5a1f16, #3a120c); }
.kit-btn.no-art.disabled { background: linear-gradient(#5a5a5a, #3a3a3a); border-color: #777; }
.kit-btn.primary .kit-btn-label { color: var(--c-highlight); }
.kit-btn-label { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; }
.kit-icon-btn { border-width: 0; }
.kit-icon-btn .kit-btn-label { font-size: 11px; }

/* ---- tabs ---- */
.kit-tabs { display: flex; align-items: flex-end; }
.kit-tabs.vertical { flex-direction: column; align-items: stretch; }
.kit-tab {
  position: relative; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; flex: none;
  margin: 0; padding: 0; background: none; border-style: solid; border-color: transparent; border-width: 0 8px;
  border-image: var(--off) 0 8 fill / 0 8px / 0 stretch;
  color: #c9c1a9; font: 11px/13px var(--font-title); text-shadow: var(--t-outline); cursor: inherit;
}
.kit-tab.on { border-image-source: var(--on); color: var(--c-text); }
.kit-tab:hover:not(.on):not(.disabled) { color: var(--c-highlight); }
.kit-tab.disabled { border-image-source: var(--disable, var(--off)); color: var(--c-button-off); }
.kit-tab[hidden] { display: none; }
.kit-tab:focus-visible { outline: 1px solid var(--c-level); outline-offset: -3px; }
.kit-tab-label { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; }
.kit-tab.kit-tab-3 {
  border: 0; padding: 0 var(--caps);
  background: var(--off-left) left top / var(--caps) 100% no-repeat, var(--off-right) right top / var(--caps) 100% no-repeat, var(--off-mid) 0 0 / auto 100% repeat-x;
  background-origin: border-box, border-box, content-box; background-clip: border-box, border-box, content-box;
}
.kit-tab.kit-tab-3.on { background-image: var(--on-left), var(--on-right), var(--on-mid); }
.kit-tabs-icon .kit-tab { border: 0; background: var(--off) 0 0 / 100% 100% no-repeat; }
.kit-tabs-icon .kit-tab.on { background-image: var(--on); }
.kit-tab.no-art, .kit-tabs-icon .kit-tab.no-art { border: 1px solid #2c4d78; border-bottom: 0; border-radius: 4px 4px 0 0; background: linear-gradient(#2a3d5c, #18243a); padding: 0 8px; }
.kit-tab.no-art.on { background: linear-gradient(#2e9fd0, #1a6e98); }

/* ---- gauges ---- */
.kit-gauge { position: relative; flex: none; }
.kit-gauge-fill { position: absolute; background-repeat: no-repeat; background-position: 0 0; }
.kit-gauge.no-art { background: rgba(0, 0, 0, 0.55); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.8); }
.kit-gauge.no-art .kit-gauge-fill { background: var(--gauge-color, var(--c-hp)); }
.kit-gauge-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; white-space: nowrap; font-variant-numeric: tabular-nums; }

/* ---- slots ---- */
@property --kit-cd { syntax: '<number>'; inherits: false; initial-value: 0; }
@keyframes kit-cd-sweep { from { --kit-cd: 0; } to { --kit-cd: 1; } }
.kit-slot { position: relative; width: 36px; height: 36px; flex: none; }
.kit-slot.cell { background: rgba(0, 0, 0, 0.35); box-shadow: inset 0 0 0 1px rgba(156, 131, 80, 0.35); }
.kit-slot-icon { position: absolute; left: 2px; top: 2px; width: 32px; height: 32px; background: no-repeat 0 0 / 100% 100%; }
.kit-slot-icon.fallback { display: grid; place-items: center; font: bold 11px var(--font-body); color: #fff; text-shadow: var(--t-outline); }
.kit-slot.blocked .kit-slot-icon::before { content: ''; position: absolute; inset: 0; background: var(--blocked, #be1e14); opacity: 0.45; }
.kit-slot.dragging .kit-slot-icon { opacity: 0.4; }
.kit-slot.filled:hover::after, .kit-slot.is-hover::after, .kit-slot.selected::after, .kit-slot.drop-ok::after, .kit-slot.new::after {
  content: ''; position: absolute; left: 2px; top: 2px; width: 32px; height: 32px; pointer-events: none;
  background: var(--select, none) 0 0 / 100% 100%;
}
.kit-slot.drop-ok::after { box-shadow: inset 0 0 0 1px var(--c-level); }
.kit-slot.drop-bad::after { content: ''; position: absolute; left: 2px; top: 2px; width: 32px; height: 32px; background: var(--disable, rgba(120, 0, 0, 0.5)) 0 0 / 100% 100%; }
.kit-slot.new::after { animation: kit-slot-new 1.2s ease-in-out infinite alternate; }
@keyframes kit-slot-new { from { opacity: 0.25; } to { opacity: 1; } }
.kit-slot-cd {
  position: absolute; left: 2px; top: 2px; width: 32px; height: 32px; pointer-events: none;
  background: conic-gradient(transparent 0turn calc(var(--kit-cd) * 1turn), rgba(0, 0, 0, 0.62) calc(var(--kit-cd) * 1turn) 1turn);
  animation-name: kit-cd-sweep; animation-timing-function: linear; animation-fill-mode: forwards;
}
.kit-slot-count { position: absolute; right: 3px; bottom: 3px; display: flex; pointer-events: none; }
.kit-digit { width: 8px; height: 8px; background: no-repeat 0 0 / 100% 100%; }
.kit-slot-count.text { font: 10px/11px var(--font-body); color: #fff; text-shadow: var(--t-outline); }
.kit-slot-sign { position: absolute; left: 2px; top: 2px; width: 12px; height: 12px; background: no-repeat 0 0 / 100% 100%; pointer-events: none; }
.kit-slot-sign.text { width: auto; height: auto; font: 9px/10px var(--font-title); color: var(--c-level); text-shadow: var(--t-outline); }
.kit-slot-sign.magic.text { color: var(--c-magic); }
.kit-slot-sign[hidden], .kit-slot-dur[hidden] { display: none; }
.kit-slot-dur { position: absolute; left: 2px; top: 2px; width: 32px; height: 32px; background: no-repeat 0 0 / 100% 100%; pointer-events: none; }
.kit-slot-dur.broken { box-shadow: inset 0 0 0 2px var(--c-bad); }
.kit-slot-dur.low { box-shadow: inset 0 0 0 2px var(--c-warn); }
.kit-slot.broken .kit-slot-icon { filter: grayscale(0.6) brightness(0.8); }
.kit-slot-grid { display: grid; grid-auto-rows: 36px; }
.kit-slot-grid.has-lattice .q-ul { background: var(--lattice-lu); }
.kit-slot-grid.has-lattice .q-ur { background: var(--lattice-ru); }
.kit-slot-grid.has-lattice .q-dl { background: var(--lattice-ld); }
.kit-slot-grid.has-lattice .q-dr { background: var(--lattice-rd); }
.kit-slot-grid.lattice:not(.has-lattice) .kit-slot { background: rgba(0, 0, 0, 0.3); box-shadow: inset 0 0 0 1px rgba(156, 131, 80, 0.3); }
.kit-drag-ghost, .hud-drag-ghost { position: fixed; left: 0; top: 0; width: 32px; height: 32px; transform: translate(-50%, -50%) scale(var(--ui)); opacity: 0.85; pointer-events: none; z-index: 1000; background: no-repeat 0 0 / 100% 100%; }

/* ---- icons ---- */
.kit-icon { flex: none; background: no-repeat 0 0 / 100% 100%; }
.kit-icon.fallback { display: grid; place-items: center; font: bold 11px var(--font-body); color: #fff; text-shadow: var(--t-outline); }

/* ---- tooltip ---- */
.kit-tooltip { position: fixed; left: 0; top: 0; zoom: var(--ui); box-sizing: border-box; max-width: 260px; min-width: 40px; padding: 8px; z-index: 900; pointer-events: none; background: rgba(0, 0, 0, 0.82); }
.kit-tooltip[hidden] { display: none; }
.kit-tooltip-content { position: relative; display: flex; flex-direction: column; gap: 1px; font: 12px/15px var(--font-body); color: var(--c-text); text-shadow: var(--t-shadow); }
.kit-tt-title { font: 12px/15px var(--font-title); color: var(--c-text); text-shadow: var(--t-outline); }
.kit-tt-title.plus { color: var(--c-level); }
.kit-tt-type, .kit-tt-req { color: var(--c-label); }
.kit-tt-stat { color: var(--c-text); }
.kit-tt-stat.struck { color: #8d8577; text-decoration: line-through; }
.kit-tt-bad { color: var(--c-bad); }
.kit-tt-warn { color: var(--c-warn); }
.kit-tt-magic { color: var(--c-magic); }
.kit-tt-price { color: var(--c-level); }
.kit-tt-next { color: var(--c-mastery); }
.kit-tt-hint { font-size: 10px; line-height: 12px; color: var(--c-hint); }
.kit-tt-desc { color: #ddd6c4; white-space: pre-line; }
.kit-tt-sep { height: 4px; margin: 3px 0; background: rgba(255, 255, 255, 0.14) no-repeat 0 0 / 100% 4px; }
.kit-tt-sep[style*='url'] { background-color: transparent; }

/* ---- scroll area and list ---- */
.kit-scroll { position: relative; box-sizing: border-box; }
.kit-scroll-view { position: absolute; top: 0; left: 0; bottom: 0; right: 17px; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; }
.kit-scroll-view::-webkit-scrollbar { display: none; }
.kit-scroll.fits .kit-scroll-view { right: 0; }
.kit-scroll.fits .kit-scroll-bar { display: none; }
.kit-scroll-bar { position: absolute; top: 0; right: 0; bottom: 0; width: 16px; display: flex; flex-direction: column; }
.kit-scroll-track { position: relative; flex: 1 1 auto; min-height: 16px; background-repeat: repeat-y; }
.kit-scroll-track.no-art { background: rgba(0, 0, 0, 0.45); box-shadow: inset 0 0 0 1px rgba(156, 131, 80, 0.35); }
.kit-scroll-thumb { position: absolute; left: 0; width: 16px; box-sizing: border-box; border-style: solid; border-width: 5px 0; border-image: var(--img) 5 0 fill / 5px 0 / 0 stretch; touch-action: none; }
.kit-scroll-thumb.pressed { border-image-source: var(--img-press); }
.kit-scroll-thumb.no-art { border: 1px solid #c9a860; background: #6d5a33; }
.kit-list { outline: none; }
.kit-list:focus-visible { outline: 1px solid var(--c-level); outline-offset: 1px; }
.kit-list-inner { display: flex; flex-direction: column; }
.kit-list-inner.virtual { display: block; position: relative; }
.kit-list-row {
  display: flex; align-items: center; gap: 6px; box-sizing: border-box; padding: 0 8px; flex: none; overflow: hidden; white-space: nowrap;
  background: var(--bar-l) left top / 4px 100% no-repeat, var(--bar-r) right top / 4px 100% no-repeat, var(--bar-m) 0 0 / auto 100% repeat-x;
}
.kit-list-row.selected { background-image: var(--sel-l), var(--sel-r), var(--sel-m); }
.kit-list-row:hover { filter: brightness(1.2); }
.kit-list.no-bar .kit-list-row { background: rgba(0, 0, 0, 0.3); border-bottom: 1px solid rgba(156, 131, 80, 0.25); }
.kit-list.no-sel .kit-list-row.selected, .kit-list.no-bar .kit-list-row.selected { box-shadow: inset 0 0 0 1px #e98a2c; }
.kit-list.plain .kit-list-row { background: none; }
.kit-list.plain .kit-list-row.selected { background: rgba(233, 138, 44, 0.25); }

/* ---- fields ---- */
.kit-field { position: relative; box-sizing: border-box; height: 20px; flex: none; }
.kit-input { position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box; margin: 0; padding: 0 6px; border: 0; background: transparent; color: var(--c-text); font: 12px/20px var(--font-body); outline: none; user-select: text; -webkit-user-select: text; }
.kit-field:focus-within { outline: 1px solid var(--c-level); outline-offset: -1px; }
.kit-field.invalid, .kit-number.invalid .kit-field { outline: 1px solid var(--c-bad); outline-offset: -1px; }
.kit-number { display: inline-flex; align-items: center; gap: 2px; }
.kit-number .kit-field { flex: 1 1 auto; min-width: 0; }
.kit-number .kit-input { text-align: right; }

/* ---- check boxes, radios ---- */
.kit-toggle { position: relative; display: inline-flex; align-items: center; gap: 6px; cursor: inherit; }
.kit-toggle-input { position: absolute; left: 0; top: 0; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
.kit-toggle-box { width: 16px; height: 16px; flex: none; background: var(--off) no-repeat 0 0 / 100% 100%; }
.kit-toggle-input:checked + .kit-toggle-box { background-image: var(--on); }
.kit-radio:active .kit-toggle-box { background-image: var(--press); }
.kit-toggle-input:focus-visible + .kit-toggle-box { outline: 1px solid var(--c-level); outline-offset: 1px; }
.kit-toggle.disabled { opacity: 0.55; }
.kit-toggle.disabled .kit-toggle-input:checked + .kit-toggle-box { background-image: var(--on-disable, var(--on)); }
.kit-toggle.no-art .kit-toggle-box { background: #120f0a; box-shadow: inset 0 0 0 1px var(--c-rim); }
.kit-radio.no-art .kit-toggle-box { border-radius: 50%; }
.kit-toggle.no-art .kit-toggle-input:checked + .kit-toggle-box { background: radial-gradient(circle, #e0352a 35%, #120f0a 40%); }
.kit-radio-group { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.kit-radio-group.vertical { flex-direction: column; }

/* ---- slider ---- */
.kit-slider { display: flex; align-items: center; gap: 2px; height: 28px; outline: none; }
.kit-slider:focus-visible { outline: 1px solid var(--c-level); outline-offset: 1px; }
.kit-slider-track { position: relative; flex: 1 1 auto; height: 16px; touch-action: none; }
.kit-slider-track::before { content: ''; position: absolute; left: 2px; right: 2px; top: 6px; height: 4px; background: #0b0906; box-shadow: inset 0 1px 1px #000, 0 1px 0 rgba(156, 131, 80, 0.45); }
.kit-slider-thumb { position: absolute; top: 0; width: 16px; height: 16px; background: var(--img) no-repeat 0 0 / 100% 100%; }
.kit-slider-thumb.pressed { background-image: var(--img-press); }
.kit-slider-thumb.no-art { background: #6d5a33; box-shadow: inset 0 0 0 1px #c9a860; }

/* ---- select ---- */
.kit-select { position: relative; height: 20px; flex: none; }
.kit-select-button { position: absolute; inset: 0; display: flex; align-items: center; gap: 4px; margin: 0; padding: 0 6px; border: 0; background: none; color: var(--c-text); font: 12px var(--font-body); cursor: inherit; }
.kit-select-button:focus-visible { outline: 1px solid var(--c-level); outline-offset: -1px; }
.kit-select-text { position: relative; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.kit-select-arrow { position: relative; font-size: 9px; color: var(--c-label); }
.kit-select-pop { position: absolute; left: 0; top: 100%; margin-top: 2px; z-index: 60; padding: 4px; background: rgba(0, 0, 0, 0.9); }
.kit-select-pop.up { top: auto; bottom: 100%; margin: 0 0 2px; }
.kit-select-pop[hidden] { display: none; }

/* ---- message boxes ---- */
.kit-modal { position: fixed; inset: 0; zoom: var(--ui); display: grid; place-items: center; z-index: 950; pointer-events: auto; background: rgba(0, 0, 0, 0.3); }
.kit-msgbox-title { position: absolute; left: 16px; right: 16px; top: 0; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kit-msgbox .kit-box-body { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.kit-msgbox-text { text-align: center; max-width: 260px; overflow-wrap: anywhere; }
.kit-msgbox-count { display: flex; align-items: center; gap: 8px; }
.kit-msgbox-error { min-height: 11px; color: var(--c-bad); }
.kit-msgbox-buttons { margin-top: auto; display: flex; gap: 8px; justify-content: center; }

/* ---- notice ---- */
.kit-notice { position: absolute; left: 50%; top: ${96}px; transform: translateX(-50%); box-sizing: border-box; max-width: 480px; padding: 12px 20px; text-align: center; background: rgba(0, 0, 0, 0.72); pointer-events: none; }
.kit-notice[hidden] { display: none; }
.kit-notice-rim { position: absolute; left: 0; right: 0; height: 8px; background: var(--edge, none) repeat-x 0 0 / 4px 8px; }
.kit-notice-rim.top { top: 0; }
.kit-notice-rim.bottom { bottom: 0; transform: scaleY(-1); }
.kit-notice-rim::before, .kit-notice-rim::after { content: ''; position: absolute; top: 0; width: 40px; height: 8px; background: var(--corner, none) no-repeat 0 0 / 100% 100%; }
.kit-notice-rim::before { left: 0; }
.kit-notice-rim::after { right: 0; transform: scaleX(-1); }
.kit-notice.no-art { border: 1px solid var(--c-rim); }
.kit-notice-title { color: var(--c-heading); }
.kit-notice-title[hidden] { display: none; }
`

let injected = false

/** Injects the kit stylesheet once (idempotent; no-op without a DOM). */
export function ensureKitStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.id = 'kit-styles'
  style.textContent = KIT_CSS
  document.head.append(style)
}

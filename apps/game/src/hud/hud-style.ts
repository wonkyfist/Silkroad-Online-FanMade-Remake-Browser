/**
 * Styles of lane UI-H's HUD pieces (docs/UI.md §4.2, §4.5): the underbar and its MENU popup, the player frame, the
 * target window, the buff board, the quick-party slots and the quick slots inside the underbar. Injected once (the
 * `hud/*-style.ts` pattern), native px inside the zoomed `.hud-root`; colours are the kit tokens. Positions of the
 * pieces themselves come from hud/hud-layout.ts (set inline by hud/index.ts on every resize).
 */

const CSS = `
/* ---- player frame (ifplayerminiinfo.txt) ---- */
.uh-pf { position: absolute; left: 4px; top: 7px; background: no-repeat 0 0 / 100% 100%; pointer-events: auto; image-rendering: var(--art-rendering); }
.uh-pf.no-art { background: rgba(10, 10, 10, 0.7); border-radius: 30px 4px 4px 30px; }
.uh-pf-face { border-radius: 50%; background: #000 no-repeat center / 100% 100%; overflow: hidden; }
.uh-pf-face.portrait { background-size: 118% 118%; background-position: 50% 30%; }
.uh-pf.dead .uh-pf-face { filter: grayscale(1) brightness(0.6); }
.uh-pf-race { background: no-repeat 0 0 / 100% 100%; pointer-events: auto; }
.uh-pf-name { font: 12px/15px var(--font-body); color: var(--c-text); text-shadow: var(--t-outline); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.uh-pf.has-plus .uh-pf-name { width: 77px !important; }
.uh-pf-level { font: 11px/15px var(--font-title); color: var(--c-level); text-shadow: var(--t-outline); white-space: nowrap; }
.uh-bar { position: absolute; overflow: hidden; }
.uh-bar-fill { position: absolute; left: 0; top: 0; width: 100%; height: 100%; background: no-repeat 0 0; transition: clip-path 0.25s ease-out; }
.uh-bar-fill.no-art { background: linear-gradient(#e0493a, #8c1d14); }
.uh-pf-mp .uh-bar-fill.no-art { background: linear-gradient(#4a7ee6, #1d3c8c); }
.uh-bar-text { position: absolute; inset: 0; text-align: center; font: bold 10px/12px var(--font-body); color: var(--c-text); text-shadow: var(--t-outline); white-space: nowrap; font-variant-numeric: tabular-nums; }
.uh-pf.low-hp .uh-pf-hp .uh-bar-fill { animation: uh-pulse 0.9s ease-in-out infinite alternate; }
@keyframes uh-pulse { from { filter: brightness(1); } to { filter: brightness(1.8); } }
.uh-pf-caution { display: none; background: no-repeat 0 0 / 512px 64px; mix-blend-mode: screen; pointer-events: none; }
.uh-pf.low-hp .uh-pf-caution[style*='background-image'] { display: block; animation: uh-caution 0.8s step-end infinite; }
@keyframes uh-caution {
  0% { background-position: 0 0; } 12.5% { background-position: -128px 0; } 25% { background-position: -256px 0; } 37.5% { background-position: -384px 0; }
  50% { background-position: 0 -32px; } 62.5% { background-position: -128px -32px; } 75% { background-position: -256px -32px; } 87.5% { background-position: -384px -32px; }
}
.uh-pf-plus, .uh-pf-info { z-index: 2; }
.uh-pf-plus[hidden] { display: none; }
.uh-pf-berserk { pointer-events: none; }
.uh-pf-berserk:empty { display: none; }
.uh-pf-pet:empty { display: none; }

/* ---- buff board (ifmagicstateboard.txt): 20-px icons, 21 apart, time gauge under each ---- */
.hud-buffs.uh-buffs { position: absolute; left: 220px; top: 10px; width: 188px; height: 51px; display: block; max-width: none; pointer-events: none; }
.uh-buffs .hud-buff { position: absolute; width: 20px; height: 24px; pointer-events: auto; }
.uh-buffs .hud-buff .ico { width: 20px; height: 20px; border-radius: 0; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.8); }
.uh-buffs .hud-buff.bad .ico { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.8), 0 0 0 2px rgba(200, 50, 40, 0.8); }
.uh-buffs .hud-buff .ico.fallback { font: 8px/20px var(--font-title); }
.uh-buffs .uh-buff-gauge { position: absolute; left: 0; top: 20px; width: 20px; height: 4px; background: no-repeat 0 0 / 100% 100%; }
.uh-buffs .uh-buff-gauge.no-art { background: linear-gradient(#ffe38a, #c0901c); }
.uh-buffs .hud-buff .time { display: none; }

/* ---- target window (2009 iftw_*.txt) ---- */
.uh-tw { position: absolute; top: 10px; background: no-repeat 0 0; pointer-events: auto; image-rendering: var(--art-rendering); }
.uh-tw[hidden] { display: none; }
.uh-tw.no-art { background: rgba(10, 10, 10, 0.75); border: 1px solid #555; border-radius: 3px; }
.uh-tw-gem { background: no-repeat center / 100% 100%; }
.uh-tw-strip { display: flex; align-items: center; gap: 3px; }
.uh-tw-name { flex: 1 1 auto; min-width: 0; text-align: center; font: 12px/15px var(--font-body); color: var(--c-text); text-shadow: var(--t-outline); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.uh-tw-level { flex: none; font: 11px/15px var(--font-title); color: var(--c-level); text-shadow: var(--t-outline); white-space: nowrap; }
.uh-tw-level:empty { display: none; }
.uh-tw-actions { flex: none; display: flex; gap: 2px; }
.uh-tw-actions:empty { display: none; }
.uh-tw-action .kit-btn-label { font-size: 11px; }
.uh-tw[data-kind='player'] .uh-tw-name { color: var(--c-mastery); }
.uh-tw[data-kind='npc'] .uh-tw-name { color: #9fe39a; }
.uh-tw.dead .uh-tw-name { color: #9a9a9a; }
.uh-tw-bar { position: absolute; overflow: hidden; }
.uh-tw-bar[hidden] { display: none; }
.uh-tw-fill { width: 100%; height: 100%; background: no-repeat 0 0 / 100% 100%; transition: clip-path 0.2s ease-out; }
.uh-tw-fill.no-art { background: linear-gradient(#ff5a44, #a0180c); }
.uh-tw-slevel { text-align: center; font: 12px/16px var(--font-title); color: var(--c-level); text-shadow: var(--t-outline); }
.uh-tw-sicon { background: no-repeat center / 100% 100%; }
.uh-tw-stext { font: 12px/12px var(--font-body); color: var(--c-label); text-shadow: var(--t-outline); white-space: nowrap; }
.uh-tw-slevel[hidden], .uh-tw-sicon[hidden], .uh-tw-stext[hidden] { display: none; }
.uh-tw-effects.hud-target-effects { left: 0; top: 53px; gap: 1px; }
.uh-tw-effects.hud-target-effects .fx { width: 20px; height: 20px; border-radius: 0; }

/* ---- quick party (ifquickpartyslot.txt) ---- */
.hud-party.uh-party { position: absolute; left: 4px; top: 137px; width: 122px; display: block; gap: 0; pointer-events: none; }
.uh-party-list { position: relative; }
.uh-ps { position: absolute; left: 0; width: 122px; height: 40px; background: no-repeat 0 0 / 100% 100%; pointer-events: auto; cursor: inherit; image-rendering: var(--art-rendering); }
.uh-ps.no-art { background: rgba(10, 10, 10, 0.7); border-radius: 20px 3px 3px 20px; }
.uh-ps-face { border-radius: 50%; background: #000 no-repeat 0 0 / 100% 100%; }
.uh-ps-lv { text-align: center; font: 11px/28px var(--font-title); color: var(--c-level); text-shadow: var(--t-outline); pointer-events: none; }
.uh-ps-crown { background: no-repeat 0 0 / 100% 100%; }
.uh-ps-crown[hidden] { display: none; }
.uh-ps-name { font: 11px/14px var(--font-body); color: var(--c-party-name); text-shadow: var(--t-outline); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.uh-ps-bar { overflow: hidden; }
.uh-ps-fill { width: 100%; height: 100%; background: no-repeat 0 0 / 100% 100%; transition: clip-path 0.2s linear; }
.uh-ps-bar.hp .uh-ps-fill:not([style*='background-image']) { background: linear-gradient(#e0473a, #9c1e16); }
.uh-ps-bar.mp .uh-ps-fill:not([style*='background-image']) { background: linear-gradient(#4a9ef0, #1a4ea8); }
.uh-ps.offline { opacity: 0.5; }
.uh-ps.dead .uh-ps-name { color: #9a9a9a; }
/* qpt_grope_select (GDR_QPS_SELECT at -3,-4) over the plate but under the face, name and gauges. */
.uh-ps.targeted::before { content: ''; position: absolute; left: -3px; top: -4px; width: 132px; height: 48px; background: var(--uh-select) no-repeat 0 0 / 100% 100%; opacity: 0.8; pointer-events: none; }
.uh-ps:hover .uh-ps-name { color: var(--c-highlight); }

/* ---- underbar (ub_new_mainbar2 800x68) ---- */
.uh-ub { position: absolute; width: 800px; height: 68px; background: no-repeat 0 0 / 800px 68px; pointer-events: auto; image-rendering: var(--art-rendering); }
.uh-ub.no-art { background: linear-gradient(#2c2a26, #151412); border-top: 1px solid #6b5a38; }
.uh-ub > * { position: absolute; }
.uh-ub-deco { top: 4px; pointer-events: none; }
.uh-ub-deco.left { left: -76px; }
.uh-ub-deco.right { left: 800px; }
.uh-ub-deco[hidden] { display: none; }
.uh-ub-band { cursor: default; }
.uh-ub-seg { position: absolute; background: no-repeat 0 0 / 76px 8px; transition: clip-path 0.3s ease-out; }
.uh-ub-seg.no-art { background: linear-gradient(#a6e64a, #3f8a12); }
.uh-ub-band-text { position: absolute; left: 0; right: 0; top: -4px; height: 16px; display: none; text-align: center; font: bold 11px/16px var(--font-body); color: var(--c-text); text-shadow: var(--t-outline); pointer-events: none; white-space: nowrap; }
.uh-ub-band:hover .uh-ub-band-text { display: block; }
.uh-ub-sp { overflow: hidden; }
.uh-ub-sp-fill { width: 100%; height: 100%; background: no-repeat 0 0 / 176px 8px; transition: clip-path 0.3s ease-out; }
.uh-ub-sp-fill.no-art { background: linear-gradient(#ffe38a, #b8860b); }
.uh-ub-field { display: flex; align-items: center; gap: 4px; padding: 0 6px; box-sizing: border-box; font: 12px/16px var(--font-body); white-space: nowrap; cursor: default; }
.uh-ub-lbl { color: var(--c-label); text-shadow: var(--t-shadow); }
.uh-ub-spv, .uh-ub-expv { color: var(--c-level); font-family: var(--font-title); font-size: 12px; text-shadow: var(--t-outline); font-variant-numeric: tabular-nums; }
.uh-ub-gap { flex: 1 1 auto; }
.uh-ub-spv.flash { animation: uh-sp-flash 1.2s ease-out; }
@keyframes uh-sp-flash { from { color: #fff; text-shadow: 0 0 6px var(--c-level); } to { color: var(--c-level); } }
.uh-ub-level { text-align: center; font: 11px/14px var(--font-title); color: var(--c-level); text-shadow: var(--t-outline); cursor: default; }
.uh-ub-gains { pointer-events: none; }
.uh-ub-gain {
  position: absolute; left: 0; bottom: 0; white-space: nowrap; font: 13px var(--font-title); color: var(--c-level);
  text-shadow: var(--t-outline); animation: uh-gain 2.2s ease-out forwards;
}
@keyframes uh-gain { from { opacity: 0; bottom: 0; } 15% { opacity: 1; } 70% { opacity: 1; } to { opacity: 0; bottom: 34px; } }
.uh-ub-gain.sp { color: var(--c-mastery); }
.uh-ub-slots { left: 0; top: 0; width: 800px; height: 68px; pointer-events: none; }
.uh-panel { width: 0; height: 0; left: 0; top: 0; }
.uh-panel .uh-round { position: absolute; }
.uh-menu-tab { z-index: 2; }
.uh-menu-tab.no-art { font: 11px var(--font-title); }

/* quick slots inside the underbar (hud/hotbar.ts underbar mode) */
.hud-hotbar.uh-hotbar { position: absolute; left: 0; top: 0; width: 800px; height: 68px; display: block; padding: 0; gap: 0; background: none; border: 0; border-radius: 0; transform: none; pointer-events: none; }
.uh-hotbar .hud-hotbar-pages, .uh-hotbar .hud-hotbar-slots { display: contents; }
.uh-hotbar .hud-hotbar-slot { position: absolute; background: none; pointer-events: auto; }
.uh-hotbar .hud-hotbar-slot.no-art { background: none; box-shadow: none; }
.uh-hotbar .hud-hotbar-slot .ico { left: 0; top: 0; width: 32px; height: 32px; }
.uh-hotbar .hud-hotbar-slot .key { display: none; }
.uh-hotbar .hud-hotbar-slot .cnt { right: 1px; bottom: 0; font: 11px/12px var(--font-body); }
.uh-hotbar .hud-hotbar-slot.filled:hover::after { inset: 0; }
.uh-hotbar .uh-page-up, .uh-hotbar .uh-page-down { position: absolute; pointer-events: auto; }
.uh-hotbar .hud-hotbar-page { position: absolute; text-align: center; font: 11px/13px var(--font-title); color: var(--c-level); text-shadow: var(--t-outline); pointer-events: none; }

/* ---- MENU popup (ub_new_wnd_ frame, ub_new_menu_button rows) ---- */
.uh-menu { position: absolute; left: 657px; bottom: 68px; width: 140px; box-sizing: border-box; padding: 8px; z-index: 5; pointer-events: auto; }
.uh-menu[hidden] { display: none; }
.uh-menu .kit-frame { position: absolute; inset: 0; pointer-events: none; }
.uh-menu-rows { position: relative; display: flex; flex-direction: column; }
.uh-menu-row {
  position: relative; display: flex; align-items: center; gap: 4px; width: 124px; height: 20px; margin: 0; padding: 0 4px 0 0;
  border: 0; background: transparent no-repeat 0 0 / 100% 100%; cursor: inherit; text-align: left;
  font: 12px/20px var(--font-body); color: var(--c-button); text-shadow: var(--t-shadow); image-rendering: var(--art-rendering);
}
.uh-menu-row:hover { background-image: var(--img-focus); }
.uh-menu-row:active { background-image: var(--img-press); }
.uh-menu-row.no-art:hover { background: rgba(160, 97, 44, 0.6); }
.uh-menu-row.on .uh-menu-label { color: var(--c-highlight); }
.uh-menu-row:focus-visible { outline: 1px solid var(--c-level); outline-offset: -1px; }
.uh-menu-icon { flex: none; width: 20px; height: 20px; background: no-repeat 0 0 / 100% 100%; }
.uh-menu-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uh-menu-key { flex: none; color: var(--c-hint, #b0b0b0); font-size: 11px; }

/* ---- quest tracker: under the minimap plate, right edge W-4, 200 wide (docs/UI.md §4.2) ---- */
.hud-root .quest-tracker { right: 4px; width: 200px; }
`

let injected = false

export function ensureHudStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'ui-h'
  style.textContent = CSS
  document.head.append(style)
}

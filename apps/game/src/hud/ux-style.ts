/**
 * Injected CSS of lane UX-A (docs/UX_GAPS.md §6.8: new modules inject their own block instead of editing style.css):
 * the perf overlay, the help hint, the Options and Key help windows, the reconnect dim (`body.net-down`), the
 * unusable-item tint and the small-screen rules (R3).
 */

const CSS = `
/* ---- perf overlay (H1): top-left, under the player frame (docs/UI.md §4.2: (4, 80), above the party frames) ---- */
.ux-perf {
  position: absolute;
  left: 4px;
  top: 80px;
  padding: 1px 6px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.55);
  color: var(--c-text, #e8e2cf);
  font: 11px/14px var(--font-body);
  text-shadow: var(--t-shadow, none);
  white-space: nowrap;
  pointer-events: none;
  z-index: 2;
}
.ux-perf[hidden] { display: none; }

/* ---- world help line: the H hint (H2) ---- */
.ux-help-hint { color: #ffe9a6; }
.ux-help-hint[hidden] { display: none; }
.ux-help-hint + .hud-help-gm:not([hidden]) { margin-left: 14px; }

/* ---- key help (W2; docs/UI.md §4.6: sframe sections per group) ---- */
.ux-keyhelp .kit-scroll-view { display: flex; flex-direction: column; gap: 6px; padding: 2px 2px 6px 0; box-sizing: border-box; }
.ux-keyhelp-group { flex: none; height: auto !important; }
.ux-keyhelp-group .kit-box-body { position: relative !important; inset: auto !important; display: flex; flex-direction: column; gap: 1px; padding: 30px 10px 9px; }
.ux-keyhelp-row { display: flex; gap: 10px; min-height: 16px; align-items: baseline; }
.ux-keyhelp-key { flex: 0 0 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ux-keyhelp-what { flex: 1; min-width: 0; }
.ux-keyhelp-note { color: #a89d82; font: 11px/14px var(--font-body); text-shadow: var(--t-shadow); padding: 2px 4px; }

/* ---- options (W1; retail GDR_OPTION: com_long_tab tabs, int_window_ page, kit controls) ---- */
.opt-tabs .kit-tab { min-width: 72px; }
.opt-panel .kit-scroll-view { padding: 4px 6px 4px 4px; box-sizing: border-box; }
.opt-row { display: flex; align-items: center; gap: 10px; min-height: 30px; padding: 0 4px; border-bottom: 1px solid rgba(156, 131, 80, 0.16); }
.opt-row:last-child { border-bottom: 0; }
.opt-label { flex: 0 0 132px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.opt-control { display: flex; align-items: center; gap: 8px; }
.opt-control .kit-slider { width: 130px; }
.opt-value { min-width: 54px; color: var(--c-level); font-size: 11px; white-space: nowrap; }
.opt-choices { gap: 3px 10px; }
.opt-info, .opt-note { color: #a89d82; font: 11px/14px var(--font-body); text-shadow: var(--t-shadow); }
.opt-toggle .kit-toggle-label { color: var(--c-label); }

/* ---- connection down (R1): the HUD dims and ignores clicks; the world takes no clicks ---- */
body.net-down .hud-root,
body.net-down .screen.world .chat,
body.net-down .hud-minimap {
  filter: grayscale(0.7) brightness(0.6);
  transition: filter 0.3s;
}
body.net-down .hud-root,
body.net-down .hud-root * { pointer-events: none !important; }
body.net-down[data-screen='world'] #canvas { pointer-events: none; }

/* ---- low-HP warning (H7): red screen edges pulse under 25% HP ---- */
.hud-lowhp-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.4s;
  background: radial-gradient(ellipse at center, rgba(120, 0, 0, 0) 58%, rgba(150, 0, 0, 0.38) 88%, rgba(170, 0, 0, 0.55) 100%);
}
.hud-lowhp-vignette.on { opacity: 1; animation: ux-lowhp 1.1s ease-in-out infinite alternate; }
@keyframes ux-lowhp { from { opacity: 0.45; } to { opacity: 1; } }

/* ---- loading-screen tip (L5) ---- */
.loading-tip {
  max-width: 680px;
  min-height: 16px;
  margin-top: 6px;
  color: #e4dac0;
  font: 13px var(--font-body);
  text-align: center;
  text-shadow: 0 1px 2px #000;
}

/* ---- small screens (R3): the HUD is laid out in native px by hud/hud-layout.ts (UI-H); the zoom steps down below
   1024x700, so no per-element shrinking is needed here any more. ---- */
`

let injected = false

export function ensureUxStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'ux-a'
  style.textContent = CSS
  document.head.append(style)
}

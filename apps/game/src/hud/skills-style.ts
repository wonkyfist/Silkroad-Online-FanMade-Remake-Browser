/**
 * Styles of the skills lane's HUD pieces (skill window, hotbar, buff bar, target effects), injected once like
 * slots.ts's sweep so the shared style.css stays untouched. Sizes are native pixels inside the zoomed HUD layer (.hud-root, zoom: var(--ui)).
 */
const CSS = `
.hud-skill-icon {
  position: relative; width: 36px; height: 36px; flex: none;
}
.hud-skill-icon .ico {
  position: absolute; left: 2px; top: 2px; width: 32px; height: 32px;
  background: no-repeat center / 100% 100%; border-radius: 2px; pointer-events: none;
}
.hud-skill-icon .ico.fallback {
  display: grid; place-items: center; background: linear-gradient(#5a4a2c, #2c2416);
  border: 1px solid rgba(255, 255, 255, 0.25); color: #fff; font: 11px var(--font-title); text-shadow: 0 1px 1px #000;
}
.hud-skill-icon.locked .ico { filter: grayscale(1) brightness(0.45); }
.hud-skill-icon.draggable { cursor: grab; }
.hud-skill-icon.draggable:hover::after, .hud-hotbar-slot.filled:hover::after {
  content: ""; position: absolute; inset: 2px; pointer-events: none;
  box-shadow: inset 0 0 0 1px rgba(255, 222, 140, 0.9), inset 0 0 6px rgba(255, 200, 90, 0.45);
}

/* skill tab of the Main window (ifskill.txt) */
.skl-panel, .skl-head, .skl-box { position: absolute; }
.skl-tab { position: absolute; margin: 0; padding: 0; border: 0; background: var(--off) no-repeat 0 0 / 100% 100%; cursor: inherit; }
.skl-mastery-tabs .skl-tab { position: relative; flex: none; }
.skl-tab.on { background-image: var(--on); }
.skl-tab:hover:not(.on) { filter: brightness(1.18); }
.skl-tab:focus-visible { outline: 1px solid var(--c-level); outline-offset: -2px; }
.skl-tab.no-art { background: linear-gradient(#2a3d5c, #18243a); border: 1px solid #2c4d78; color: #c9c1a9; font: 11px var(--font-title); }
.skl-tab.no-art.on { background: linear-gradient(#2e9fd0, #1a6e98); color: #fff; }
.skl-tab-bg { position: absolute; background-repeat: repeat; }
.skl-mastery-tabs { display: flex; align-items: flex-end; gap: 0; }
.skl-head { background: no-repeat 0 0 / 100% 100%; }
.skl-head[hidden] { display: none; }
.skl-head.no-art { background: rgba(0, 0, 0, 0.4); box-shadow: inset 0 0 0 1px var(--c-rim); }
.skl-mastery-icon { background: no-repeat 0 0 / 100% 100%; }
.skl-mastery-name { font: 12px/15px var(--font-title); color: var(--c-caption); text-shadow: var(--t-outline); }
.skl-mastery-level { text-align: right; }
.skl-mastery-cost { font: 11px/14px var(--font-body); color: var(--c-label); text-shadow: var(--t-shadow); }
.skl-grid { display: grid; grid-template-columns: repeat(2, 161px); gap: 4px 6px; padding: 2px 0 2px 2px; }
.skl-line { display: grid; grid-template-columns: 36px 1fr; align-items: center; gap: 4px; height: 40px; padding: 0 3px 0 2px; box-sizing: border-box; background: rgba(0, 0, 0, 0.32); box-shadow: inset 0 0 0 1px rgba(156, 131, 80, 0.28); }
.skl-line.learned { background: rgba(70, 58, 28, 0.42); box-shadow: inset 0 0 0 1px rgba(201, 168, 96, 0.5); }
.skl-line-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.skl-line-foot { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-width: 0; height: 20px; }
.skl-line .name { color: var(--c-text); font: 12px/15px var(--font-body); text-shadow: var(--t-shadow); }
.skl-line .lv { color: var(--c-label); font: 10px/13px var(--font-body); text-shadow: var(--t-shadow); }
.skl-line.learned .lv { color: var(--c-level); }
.skl-line.locked .name { color: var(--c-button-off); }
.skl-add[hidden] { display: none; }
.skl-empty { color: var(--c-label); text-align: center; padding: 40px 8px; }
.skl-box { background: no-repeat 0 0 / 100% 100%; }
.skl-box.no-art { background: rgba(0, 0, 0, 0.45); }
.skl-box > div { position: absolute; font: 12px/13px var(--font-body); text-shadow: var(--t-outline); white-space: nowrap; }
.skl-sp-label, .skl-sp-num { color: var(--c-level); }
.skl-total-label, .skl-total-num { color: var(--c-mastery); }
.skl-sp-num, .skl-total-num { text-align: right; }

/* hotbar */
.hud-hotbar {
  position: absolute; left: 50%; bottom: 82px; display: flex; align-items: center; gap: 4px;
  padding: 4px 6px 4px 4px; transform: translateX(-50%); transform-origin: 50% 100%; pointer-events: auto;
  background: rgba(10, 8, 5, 0.55); border: 1px solid rgba(156, 131, 80, 0.55); border-radius: 4px;
}
/* Narrow screens: the centred bar would sit on the chat (left, 400 px), so it moves to the right edge. */
@media (max-width: 1300px) {
  .hud-hotbar { left: auto; right: 8px; transform: none; transform-origin: 100% 100%; }
}
.hud-hotbar-pages { display: flex; flex-direction: column; align-items: center; width: 22px; gap: 1px; }
.hud-hotbar-pages button {
  width: 16px; height: 12px; padding: 0; border: 0; background: none; color: var(--gold); font: 10px/12px var(--font-title); cursor: pointer;
}
.hud-hotbar-pages button:hover { color: #fff3c4; }
.hud-hotbar-page { color: #fff; font: 12px var(--font-title); text-shadow: 0 1px 1px #000; }
.hud-hotbar-slots { display: flex; gap: 2px; }
.hud-hotbar-slot { position: relative; width: 36px; height: 36px; background: var(--cell, rgba(0, 0, 0, 0.35)) no-repeat 0 0 / 36px 36px; }
.hud-hotbar-slot.no-art { background: rgba(0, 0, 0, 0.4); box-shadow: inset 0 0 0 1px rgba(156, 131, 80, 0.5); }
.hud-hotbar-slot .ico { position: absolute; left: 2px; top: 2px; width: 32px; height: 32px; background: no-repeat center / 100% 100%; pointer-events: none; }
.hud-hotbar-slot .ico.fallback {
  display: grid; place-items: center; background: linear-gradient(#5a4a2c, #2c2416);
  border: 1px solid rgba(255, 255, 255, 0.25); color: #fff; font: 11px var(--font-title);
}
.hud-hotbar-slot .key {
  position: absolute; left: 3px; top: 1px; color: #fff3c4; font: 10px var(--font-title); pointer-events: none;
  text-shadow: -1px 0 #000, 1px 0 #000, 0 -1px #000, 0 1px #000;
}
.hud-hotbar-slot .cnt {
  position: absolute; right: 3px; bottom: 1px; color: #fff; font: 11px var(--font-body); pointer-events: none;
  text-shadow: -1px 0 #000, 1px 0 #000, 0 -1px #000, 0 1px #000;
}
.hud-hotbar-slot.filled { cursor: pointer; }
.hud-hotbar-slot.blocked .ico { filter: grayscale(1) brightness(0.5); }
.hud-hotbar-slot.blocked.mp .ico { filter: grayscale(0.6) brightness(0.55) sepia(0.2) hue-rotate(180deg); }
.hud-hotbar-slot.pressed .ico { transform: scale(0.9); }
.hud-hotbar-slot.drop { box-shadow: inset 0 0 0 2px rgba(255, 222, 140, 0.9); }
.hud-hotbar-slot.dragging .ico { opacity: 0.3; }

/* buff bar: under the player frame (docs/WAVE_PLAN.md decision 27) */
.hud-buffs {
  position: absolute; left: 10px; top: 88px; display: flex; flex-wrap: wrap; gap: 3px; max-width: 360px;
  transform-origin: 0 0; pointer-events: auto;
}
.hud-buffs:empty { display: none; }
.hud-buff { position: relative; width: 26px; height: 38px; cursor: default; }
.hud-buff .ico {
  width: 26px; height: 26px; background: no-repeat center / 100% 100%; border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7), 0 0 0 2px rgba(156, 131, 80, 0.6);
}
.hud-buff.bad .ico { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7), 0 0 0 2px rgba(220, 70, 50, 0.85); }
.hud-buff .ico.fallback { display: grid; place-items: center; background: linear-gradient(#4a3c26, #221b10); color: #fff; font: 9px var(--font-title); }
.hud-buff.bad .ico.fallback { background: linear-gradient(#6a2a20, #2a100c); }
.hud-buff .time {
  position: absolute; left: -4px; right: -4px; top: 27px; text-align: center; color: #fff; font: 10px var(--font-body);
  text-shadow: -1px 0 #000, 1px 0 #000, 0 -1px #000, 0 1px #000;
}
.hud-buff.ending .ico { animation: hud-buff-blink 0.5s steps(2) infinite; }
@keyframes hud-buff-blink { 50% { opacity: 0.35; } }
.hud-buff.cancel { cursor: pointer; }

/* target window effects row */
.hud-target-effects { position: absolute; left: 10px; top: 74px; display: flex; gap: 2px; pointer-events: none; }
.hud-target-effects .fx {
  width: 18px; height: 18px; background: no-repeat center / 100% 100%; border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.8);
}
.hud-target-effects .fx.bad { box-shadow: 0 0 0 1px rgba(220, 70, 50, 0.9); }
.hud-target-effects .fx.fallback { display: grid; place-items: center; background: #3a2e1c; color: #fff; font: 8px var(--font-title); }
.hud-target-effects .fx.bad.fallback { background: #5a241c; }
`

let injected = false

export function ensureSkillStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'hud-skills'
  style.textContent = CSS
  document.head.append(style)
}

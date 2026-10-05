/**
 * Styles of Play the Boss (docs/PLAY_THE_BOSS.md §4.3–§4.5; mockup play-the-boss-preview.png sections 1–3): the pilot's
 * boss frame, the top strip, the kit bar, the steering line, the taunt wheel, the result and offer dialogs, the
 * hunters' banner and the call for volunteers (layer 4). Injected once (the `hud/*-style.ts` pattern); native px
 * inside the zoomed `.hud-root`, the kit's colour tokens. `body.pilot-on` (set while piloting) hides the own player frame, buffs and quick slots and moves the
 * target window under the strip.
 */

const CSS = `
/* ---- while piloting: the own frame, buffs and quick slots make no sense; the target window goes under the strip ---- */
body.pilot-on .uh-pf, body.pilot-on .uh-buffs, body.pilot-on .uh-ub-slots { visibility: hidden !important; }
body.pilot-on .uh-tw { top: 74px !important; }

.pl-panel {
  background: linear-gradient(rgba(22, 18, 11, 0.9), rgba(10, 8, 5, 0.9));
  border: 1px solid rgba(201, 163, 92, 0.78);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.85), 0 2px 8px rgba(0, 0, 0, 0.55);
  border-radius: 3px;
  color: var(--c-text, #efe6cf);
}
.pl-pink { color: #ff9cf0; }

/* ---- boss frame (top left, mockup 2.1) ---- */
.pl-boss { position: absolute; left: 4px; top: 7px; width: 300px; height: 66px; pointer-events: auto; }
.pl-boss[hidden] { display: none; }
.pl-boss-face {
  position: absolute; left: 7px; top: 7px; width: 52px; height: 52px; border-radius: 50%;
  border: 2px solid #c9a35c; box-sizing: border-box; overflow: hidden;
  background: radial-gradient(circle at 50% 35%, #5c6f86, #1b2433 70%);
  display: flex; align-items: center; justify-content: center;
}
.pl-boss-face i { width: 30px; height: 30px; background: no-repeat center / contain; }
.pl-boss-face b { font: 18px/1 var(--font-title); color: #e8f0ff; text-shadow: var(--t-outline, 0 0 2px #000); }
.pl-boss-name { position: absolute; left: 68px; top: 6px; right: 8px; font: 14px/17px var(--font-title); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: var(--t-outline, 0 0 2px #000); }
.pl-boss-name small { font: 11px var(--font-body); color: var(--c-label, #efdaa4); margin-left: 5px; }
.pl-boss-hp { position: absolute; left: 68px; top: 26px; right: 10px; height: 13px; background: rgba(0, 0, 0, 0.75); border: 1px solid #000; overflow: hidden; }
.pl-boss-hp i { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: linear-gradient(#ff5a44, #a0180c); transform-origin: 0 50%; transition: transform 0.2s ease-out; }
.pl-boss-hp span { position: absolute; inset: 0; text-align: center; font: bold 10px/13px var(--font-body); color: #fff; text-shadow: 0 0 2px #000, 0 1px 1px #000; font-variant-numeric: tabular-nums; }
.pl-boss-stats { position: absolute; left: 68px; top: 44px; right: 8px; font: 11px/14px var(--font-body); color: var(--c-level, #ffd953); white-space: nowrap; text-shadow: var(--t-shadow, 0 1px 1px #000); }
.pl-boss-rage { display: none; margin-left: 6px; padding: 0 5px; border-radius: 2px; background: #a0180c; color: #fff3c4; font: bold 10px/14px var(--font-body); text-transform: uppercase; letter-spacing: 0.05em; animation: pl-rage 0.9s ease-in-out infinite alternate; }
.pl-boss.enraged .pl-boss-rage { display: inline-block; }
@keyframes pl-rage { from { filter: brightness(1); } to { filter: brightness(1.5); } }

/* ---- the strip (top centre, mockup 2.2) ---- */
.pl-strip { position: absolute; left: 50%; top: 7px; transform: translateX(-50%); display: flex; pointer-events: auto; }
.pl-strip[hidden] { display: none; }
.pl-strip-cell { min-width: 96px; padding: 4px 12px 5px; text-align: center; }
.pl-strip-cell + .pl-strip-cell { border-left: 1px solid rgba(201, 163, 92, 0.45); }
.pl-strip-cap { font: 9px/12px var(--font-title); letter-spacing: 0.2em; text-transform: uppercase; color: #e9b95a; white-space: nowrap; }
.pl-strip-val { font: 22px/26px var(--font-title); color: #fff3c4; text-shadow: 0 0 6px rgba(0, 0, 0, 0.9); font-variant-numeric: tabular-nums; white-space: nowrap; }
.pl-strip-val small { font-size: 14px; color: var(--c-label, #efdaa4); }
.pl-strip-val.hot { color: #ff7a6a; }
.pl-strip-val.low { color: #ff5a44; animation: pl-rage 0.6s ease-in-out infinite alternate; }

/* ---- the kit bar (bottom centre, above the underbar; mockup 2.4) ---- */
.pl-kit { position: absolute; left: 50%; bottom: 74px; transform: translateX(-50%); display: flex; gap: 4px; padding: 5px 7px 4px; pointer-events: auto; }
.pl-kit[hidden] { display: none; }
.pl-slot { position: relative; width: 58px; display: flex; flex-direction: column; align-items: center; cursor: pointer; }
.pl-slot-box {
  position: relative; width: 36px; height: 36px; box-sizing: border-box; border: 1px solid #000;
  box-shadow: inset 0 0 0 1px rgba(255, 230, 170, 0.35); border-radius: 2px; overflow: hidden;
  background: linear-gradient(160deg, var(--pl-a, #8a2a1c), var(--pl-b, #3a0d08));
}
.pl-slot-glyph { position: absolute; inset: 0; text-align: center; font: bold 17px/34px var(--font-title); color: #fff6dc; text-shadow: 0 0 4px rgba(0, 0, 0, 0.8); letter-spacing: -0.06em; }
.pl-slot-key { position: absolute; left: 3px; top: 1px; font: bold 10px/11px var(--font-body); color: #fff; text-shadow: 0 0 2px #000, 0 1px 1px #000; z-index: 1; }
.pl-slot-name { margin-top: 2px; max-width: 58px; font: 11px/13px var(--font-body); color: var(--c-label, #efdaa4); text-shadow: var(--t-shadow, 0 1px 1px #000); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-slot-sub { font: 9px/11px var(--font-body); color: #a89d82; white-space: nowrap; }
.pl-slot:hover .pl-slot-box { box-shadow: inset 0 0 0 1px #ffef99; }
.pl-slot:active .pl-slot-box { transform: translate(1px, 1px); }
.pl-slot.disabled .pl-slot-glyph { opacity: 0.45; }
.pl-slot.disabled .pl-slot-box { filter: grayscale(0.7) brightness(0.75); }
.pl-slot.empty .pl-slot-sub { color: #ff8a73; }
.pl-slot[data-id='claw'] { --pl-a: #c23a26; --pl-b: #4a0f08; }
.pl-slot[data-id='sweep'] { --pl-a: #d0782a; --pl-b: #4a2208; }
.pl-slot[data-id='curse'] { --pl-a: #8a4ad0; --pl-b: #26104a; }
.pl-slot[data-id='pounce'] { --pl-a: #9a7a52; --pl-b: #3a2a16; }
.pl-slot[data-id='roar'] { --pl-a: #3a7ad0; --pl-b: #0e244a; }
.pl-slot[data-id='pack'] { --pl-a: #c08a4a; --pl-b: #4a2a10; }
.pl-slot[data-id='stalk'] { --pl-a: #4a9a5a; --pl-b: #10361a; }

/* ---- steering line (above the kit bar, mockup 2.6) ---- */
.pl-steer { position: absolute; left: 50%; bottom: 140px; transform: translateX(-50%); padding: 3px 14px; white-space: nowrap; font: 13px/18px var(--font-body); color: #ffe9a6; text-shadow: 0 0 4px #000, 0 1px 1px #000; background: rgba(0, 0, 0, 0.55); border-radius: 3px; pointer-events: none; }
.pl-steer[hidden] { display: none; }
.pl-steer.ai { color: #ff9c8a; }
.pl-stalk { position: absolute; left: 50%; bottom: 164px; transform: translateX(-50%); font: 12px/16px var(--font-body); color: #9fe39a; text-shadow: 0 0 4px #000; white-space: nowrap; pointer-events: none; }
.pl-stalk[hidden] { display: none; }

/* ---- taunt wheel (hold Q; mockup 2.5) ---- */
.pl-wheel { position: absolute; width: 236px; height: 236px; margin: -118px 0 0 -118px; z-index: 40; pointer-events: none; }
.pl-wheel[hidden] { display: none; }
.pl-wheel-disc { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle, rgba(10, 8, 5, 0.25) 0 22%, rgba(10, 8, 5, 0.72) 23% 100%); border: 1px solid rgba(201, 163, 92, 0.7); }
.pl-wheel-hub { position: absolute; left: 50%; top: 50%; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; border: 1px solid #c9a35c; background: rgba(10, 8, 5, 0.85); text-align: center; font: bold 16px/30px var(--font-title); color: #ffd953; }
.pl-wheel-hub small { display: block; margin-top: -10px; font: 9px/10px var(--font-body); color: var(--c-label, #efdaa4); }
.pl-wheel-line { position: absolute; width: 84px; margin-left: -42px; margin-top: -14px; text-align: center; font: 11px/13px var(--font-body); color: #efe6cf; text-shadow: 0 0 3px #000; pointer-events: auto; cursor: pointer; padding: 1px 2px; border-radius: 3px; }
.pl-wheel-line.on { color: #fff; background: rgba(160, 24, 12, 0.85); box-shadow: 0 0 0 1px #ffb27a; }

/* ---- dialogs: the result window and the offer (mockup 1 right) ---- */
.pl-dialog { position: absolute; left: 50%; top: 48%; transform: translate(-50%, -50%); width: 360px; padding: 12px 18px 12px; text-align: center; pointer-events: auto; z-index: 30; }
.pl-dialog[hidden] { display: none; }
.pl-dialog-cap { font: 10px/14px var(--font-title); letter-spacing: 0.22em; text-transform: uppercase; color: #e9b95a; }
.pl-dialog-head { margin: 4px 0 8px; font: 19px/24px var(--font-title); color: #fff3c4; text-shadow: 0 0 6px rgba(0, 0, 0, 0.9); }
.pl-dialog-lines { margin: 0 0 10px; padding: 0; list-style: none; text-align: left; font: 12px/18px var(--font-body); color: var(--c-text, #efe6cf); }
.pl-dialog-lines li { position: relative; padding-left: 12px; }
.pl-dialog-lines li::before { content: '•'; position: absolute; left: 0; color: #c9a35c; }
.pl-dialog-lines.plain li { padding-left: 0; text-align: center; }
.pl-dialog-lines.plain li::before { content: none; }
.pl-dialog-lines b { color: #ffd953; font-weight: normal; }
.pl-dialog-buttons { display: flex; justify-content: center; gap: 10px; }
.pl-dialog-foot { margin-top: 6px; font: 11px/14px var(--font-body); color: var(--c-label, #efdaa4); }
.pl-dialog-foot b { color: #fff3c4; }

/* ---- the hunters' banner (top centre, under the notices; mockup 3) ---- */
.pl-hunt { position: absolute; left: 50%; top: 96px; transform: translateX(-50%); max-width: 520px; padding: 4px 26px 6px; text-align: center; pointer-events: none; transition: top 0.3s ease;
  background: linear-gradient(90deg, transparent, rgba(12, 8, 3, 0.82) 12%, rgba(12, 8, 3, 0.82) 88%, transparent);
  border-style: solid; border-width: 1px 0; border-image: linear-gradient(90deg, transparent, rgba(243, 213, 138, 0.7) 20%, rgba(243, 213, 138, 0.7) 80%, transparent) 1; }
.pl-hunt[hidden] { display: none; }
.pl-hunt.below { top: 168px; }
.pl-hunt-cap { font: 10px/13px var(--font-title); letter-spacing: 0.22em; text-transform: uppercase; color: #e9b95a; }
.pl-hunt-text { font: 15px/20px var(--font-title); color: #fff3c4; text-shadow: 0 0 6px rgba(0, 0, 0, 0.9); white-space: nowrap; }
.pl-hunt-meta { font: 11px/14px var(--font-body); color: var(--c-label, #efdaa4); white-space: nowrap; font-variant-numeric: tabular-nums; }
.pl-hunt-meta b { color: #fff3c4; font-weight: normal; }
.pl-hunt-meta:empty { display: none; }

/* ---- the call for volunteers (the banner's place; mockup 1 left) ---- */
.pl-call { pointer-events: auto; padding-bottom: 8px; }
.pl-call .pl-hunt-text { white-space: normal; }
.pl-call-line { margin-top: 3px; font: 12px/16px var(--font-body); text-shadow: 0 0 3px #000; }
.pl-call-line.on { color: #9fe39a; }
.pl-call-line.why { color: #ff9c8a; }
.pl-call-actions { display: flex; justify-content: center; gap: 10px; margin-top: 6px; }
.pl-call-line[hidden], .pl-call-actions[hidden], .pl-call-actions > [hidden] { display: none !important; }

/* ---- entity label lines ("In a trance", "steered by a player", a title) ---- */
.entity-label .label-line { font: 11px/13px var(--font-body); color: #d8c8a0; text-shadow: 0 0 2px #000, 0 1px 1px #000; white-space: nowrap; }
.entity-label .label-line-piloted { color: #ffb27a; }
.entity-label .label-line-trance { color: #a8d8ff; font-style: italic; }
.entity-label .label-line-honor { color: #ffd953; }
`

let injected = false

/** Injects the Play the Boss styles once (no-op without a document: node tests). */
export function ensurePilotStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'pilot'
  style.textContent = CSS
  document.head.append(style)
}

/**
 * Styles of the quest client (docs/QUESTS.md §2): NPC marks (the 'quest' entity badge, lifted above the name), the
 * quest pages in the NPC dialog, the log window, the tracker, the completion banner and the useItem "vision" line.
 * Injected once, like the other lanes' styles, so style.css stays untouched.
 */
const CSS = `
.entity-label .badge-quest {
  position: absolute; left: 50%; bottom: 100%; transform: translateX(-50%); margin-bottom: 2px;
  font: bold 26px/1 var(--font-title); pointer-events: none; text-shadow: 0 0 2px #000, 0 1px 2px #000, 0 0 1px #000;
}
.entity-label .badge-quest.gold { color: #ffd84a; text-shadow: 0 0 6px rgba(255, 186, 40, 0.85), 0 1px 2px #000, 0 0 2px #000; animation: quest-mark-bob 1.6s ease-in-out infinite; }
.entity-label .badge-quest.blue { color: #6fc6ff; text-shadow: 0 0 6px rgba(70, 160, 255, 0.85), 0 1px 2px #000, 0 0 2px #000; animation: quest-mark-bob 1.6s ease-in-out infinite; }
.entity-label .badge-quest.grey { color: #c4c0b4; font-size: 22px; }
.entity-label .badge-quest.talk { font-size: 24px; letter-spacing: -1px; }
@keyframes quest-mark-bob { 0%, 100% { margin-bottom: 2px; } 50% { margin-bottom: 6px; } }

.hud-window-npc-dialog.quest-mode .npc-greeting, .hud-window-npc-dialog.quest-mode .npc-options { display: none; }
.quest-page { position: absolute; left: 14px; right: 14px; top: 4px; bottom: 12px; display: flex; flex-direction: column; }
.quest-page-scroll, .quest-log-detail {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin; padding: 8px 10px; box-sizing: border-box;
  background: rgba(0, 0, 0, 0.5); border: 1px solid rgba(156, 131, 80, 0.55); color: var(--text); font: 12px/1.5 var(--font-body); user-select: text;
}
.quest-page-buttons, .quest-log-buttons { flex: none; display: flex; gap: 6px; align-items: center; justify-content: center; padding-top: 8px; min-height: 24px; }
.quest-log-buttons { justify-content: flex-end; }
.quest-page-buttons .art-button .label, .quest-log-buttons .art-button .label { font: 12px var(--font-title); }
.quest-page-buttons .art-button.primary .label, .quest-log-buttons .art-button.primary .label { color: #ffe9a6; }
.quest-page-wait { color: var(--dim); font-size: 11px; }
.quest-page-title { font: 14px/1.3 var(--font-title); color: #ffe08a; margin-bottom: 6px; }
.quest-page-text { margin: 0 0 7px; white-space: pre-wrap; }
.quest-page-note { color: #cbbd98; font-size: 11px; font-style: italic; }
.quest-page-note.warn { color: #ff9a7a; }
.quest-section { margin: 9px 0 3px; padding-bottom: 1px; color: #c9a860; font: 11px var(--font-title); letter-spacing: 0.04em; border-bottom: 1px solid rgba(156, 131, 80, 0.4); }
.quest-objective { position: relative; padding-left: 15px; }
.quest-objective::before { content: '\\25C7'; position: absolute; left: 1px; top: 0; color: #c9a860; font-size: 10px; }
.quest-objective.done { color: #a6e6a0; }
.quest-objective.done::before { content: '\\2713'; color: #7ad36b; font-size: 12px; }
.quest-objective.locked { color: #8a8272; }
.quest-reward-line { color: #fff; }
.quest-choose { margin-top: 6px; color: #f3d58a; }
.quest-item-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.quest-item-cell { position: relative; flex: none; width: 34px; height: 34px; padding: 0; margin: 0; border: 1px solid rgba(156, 131, 80, 0.75); border-radius: 2px; background: rgba(0, 0, 0, 0.55); }
button.quest-item-cell { cursor: pointer; }
button.quest-item-cell:hover { border-color: #f3d58a; }
.quest-item-cell.chosen { border-color: #7ad36b; box-shadow: 0 0 0 1px #7ad36b, 0 0 7px rgba(122, 211, 107, 0.8); }
.quest-item-icon { position: absolute; inset: 1px; background: no-repeat center / 100% 100%; pointer-events: none; }
.quest-item-icon.fallback { display: grid; place-items: center; color: #fff; font: 13px var(--font-title); }
.quest-item-count { position: absolute; right: 2px; bottom: 0; color: #fff; font: 10px var(--font-body); text-shadow: 0 0 2px #000, 0 1px 1px #000; pointer-events: none; }
.quest-log-ready { margin-top: 4px; color: #a6e6a0; }

/* Quest tab of the Main window (ifquest.txt, ifquestslotmain.txt) */
.qst-panel .kit-section-caption.full { color: var(--c-bad); }
.qst-list[hidden], .qst-detail[hidden], .qst-panel .kit-toggle[hidden] { display: none; }
.qst-chapter { height: 24px; width: 324px; margin: 2px 0 0 8px; padding: 0 10px; box-sizing: border-box; display: flex; align-items: center; background: no-repeat 0 0 / 100% 100%; color: var(--c-heading); font: 11px/24px var(--font-title); text-shadow: var(--t-outline); }
.qst-row { position: relative; width: 340px; height: 28px; background: rgba(0, 0, 0, 0.35) no-repeat 0 0 / 100% 100%; cursor: pointer; }
.qst-row:hover { filter: brightness(1.15); }
.qst-row.on::after { content: ''; position: absolute; left: 21px; top: 4px; width: 220px; height: 20px; box-shadow: inset 0 0 0 1px var(--c-level); pointer-events: none; }
.qst-bar { background: no-repeat 0 0 / 100% 100%; opacity: 0.85; pointer-events: none; }
.qst-bar.blue:not([style*='url']) { background: linear-gradient(90deg, rgba(40, 90, 170, 0.8), transparent); }
.qst-bar.green:not([style*='url']) { background: linear-gradient(90deg, rgba(40, 150, 60, 0.8), transparent); }
.qst-bar.red:not([style*='url']) { background: linear-gradient(90deg, rgba(170, 40, 40, 0.8), transparent); }
.qst-title { color: var(--c-text); font: 12px/15px var(--font-body); text-shadow: var(--t-outline); pointer-events: none; }
.qst-level { color: var(--c-label); font: 11px/15px var(--font-body); text-align: right; text-shadow: var(--t-outline); pointer-events: none; }
.qst-check { margin: 0; padding: 0; border: 0; background: var(--off) no-repeat 0 0 / 100% 100%; cursor: inherit; }
.qst-check.on { background-image: var(--on); }
.qst-check.no-art { background: #120f0a; box-shadow: inset 0 0 0 1px var(--c-rim); }
.qst-check.no-art.on { background: radial-gradient(circle, #e0352a 35%, #120f0a 40%); }
.qst-sub { width: 340px; box-sizing: border-box; padding: 3px 10px 5px 30px; background: rgba(0, 0, 0, 0.35); border-bottom: 2px solid rgba(156, 131, 80, 0.25); }
.qst-objective { position: relative; padding-left: 14px; color: var(--c-text); font: 11px/15px var(--font-body); text-shadow: var(--t-shadow); }
.qst-objective::before { content: ''; position: absolute; left: 1px; top: 5px; width: 5px; height: 5px; transform: rotate(45deg); background: var(--c-label); }
.qst-objective.done { color: #a6e6a0; }
.qst-objective.done::before { background: #7ad36b; }
.qst-objective.locked { color: var(--c-button-off); }
.qst-objective.ready { color: var(--c-level); }
.qst-line { pointer-events: none; background: rgba(156, 131, 80, 0.3) repeat 0 0; opacity: 0.8; }
.qst-list .kit-scroll-view { padding-left: 4px; box-sizing: border-box; }
.qst-empty { padding: 30px 12px; color: var(--c-label); text-align: center; font: 12px/16px var(--font-body); }
.qst-detail-title { box-sizing: border-box; padding: 0 12px; background: rgba(0, 0, 0, 0.4) no-repeat 0 0 / 100% 100%; color: var(--c-heading); font: 13px/28px var(--font-title); text-shadow: var(--t-outline); }
.qst-detail-scroll .kit-scroll-view { padding: 4px 6px 4px 4px; box-sizing: border-box; color: var(--c-text); font: 12px/16px var(--font-body); text-shadow: var(--t-shadow); user-select: text; }
.qst-buttons { display: flex; align-items: center; justify-content: space-between; }
.qst-buttons-right { display: flex; gap: 4px; }
.quest-log-count { height: 16px; text-align: right; color: #cbbd98; font: 11px var(--font-body); }
.quest-log-count.full { color: #ff8a7a; }
.quest-log-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin; padding: 3px 0; background: rgba(0, 0, 0, 0.5); border: 1px solid rgba(156, 131, 80, 0.55); }
.quest-log-chapter { padding: 5px 8px 2px; color: #c9a860; font: 11px var(--font-title); }
.quest-log-row {
  display: flex; align-items: baseline; gap: 6px; width: 100%; padding: 3px 8px 3px 16px; border: 0; background: transparent; position: relative;
  color: var(--text); font: 12px var(--font-body); text-align: left; cursor: pointer;
}
.quest-log-row:hover { background: rgba(255, 222, 140, 0.1); }
.quest-log-row.on { background: rgba(255, 222, 140, 0.2); color: #fff6d8; }
.quest-log-row.tracked::before { content: ''; position: absolute; left: 7px; top: 9px; width: 4px; height: 4px; border-radius: 50%; background: #ffd84a; }
.quest-log-row.ready .quest-log-row-title { color: #ffd84a; }
.quest-log-row.withdrawn .quest-log-row-title { color: #9a9a9a; text-decoration: line-through; }
.quest-log-row-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quest-log-row-level { flex: none; color: #cbbd98; font-size: 10px; }
.quest-log-empty, .quest-log-pick { padding: 10px; color: #cbbd98; font: 11px/1.5 var(--font-body); text-align: center; }
.quest-log-toggle { display: flex; align-items: center; gap: 6px; margin-top: 6px; color: var(--text); font: 11px var(--font-body); cursor: pointer; }
.quest-log-toggle input { margin: 0; accent-color: #c9a860; }
.quest-log-meta { color: #cbbd98; font-size: 11px; }
.quest-log-route { color: #9df0a8; font-size: 11px; margin-bottom: 6px; }

.quest-tracker {
  position: absolute; right: 10px; top: 262px; width: 230px; pointer-events: auto; text-align: right;
  transform-origin: top right; text-shadow: 0 0 2px #000, 0 1px 2px #000, 0 0 3px rgba(0, 0, 0, 0.8);
}
.quest-tracker[hidden] { display: none; }
.quest-tracker-quest { margin-bottom: 7px; }
.quest-tracker-title {
  max-width: 100%; padding: 0; border: 0; background: transparent; color: #ffd84a; font: 13px var(--font-title); text-align: right;
  text-shadow: inherit; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.quest-tracker-title:hover { color: #fff6d8; text-decoration: underline; }
.quest-tracker-line { display: flex; justify-content: flex-end; align-items: center; gap: 6px; color: #f0ead8; font: 12px/1.4 var(--font-body); }
.quest-tracker-line.ready { color: #a6e6a0; }
.quest-tracker-line.dim { color: #9a9a9a; }
.quest-tracker-use .label { font: 11px var(--font-title); }

.hud-levelup.quest-banner { top: 17%; }
.hud-levelup.quest-banner .hud-levelup-title { font-size: 32px; }
.quest-vision {
  position: absolute; left: 50%; top: 36%; width: min(560px, 80vw); transform: translate(-50%, -50%); pointer-events: none;
  text-align: center; color: #fff6d8; font: italic 16px/1.55 var(--font-title); text-shadow: 0 0 5px #000, 0 1px 2px #000;
  opacity: 0; transition: opacity 0.8s ease;
}
.quest-vision.in { opacity: 1; }

/* Quest pages in the retail NPC window: paper (guide/gd_paper_02) over the talk box, ink text, qst_subwindow_title. */
.hud-window-npc-dialog .quest-page {
  left: 6px; top: 2px; right: auto; bottom: auto; width: 374px; height: 400px; padding: 30px 30px 26px; box-sizing: border-box;
  background: var(--quest-paper, rgba(226, 208, 170, 0.96)) no-repeat 0 0 / 100% 100%;
}
.hud-window-npc-dialog .quest-page-scroll { background: none; border: 0; padding: 0 4px 0 0; color: var(--c-ink); font: 12px/16px var(--font-body); text-shadow: none; scrollbar-color: #8a6a3a transparent; }
.hud-window-npc-dialog .quest-page-title {
  margin: 0 -8px 8px; height: 28px; padding: 0 12px; box-sizing: border-box; background: var(--quest-title, #3a2a14) no-repeat 0 0 / 100% 100%;
  color: var(--c-caption); font: 13px/28px var(--font-title); text-shadow: var(--t-outline); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hud-window-npc-dialog .quest-page-note { color: #6b5334; }
.hud-window-npc-dialog .quest-page-note.warn { color: #a3261a; }
.hud-window-npc-dialog .quest-section { color: #6b3d00; border-bottom-color: rgba(107, 61, 0, 0.35); }
.hud-window-npc-dialog .quest-objective::before { color: #6b3d00; }
.hud-window-npc-dialog .quest-objective.done { color: #1f6b14; }
.hud-window-npc-dialog .quest-objective.locked { color: #7a6e5e; }
.hud-window-npc-dialog .quest-reward-line { color: var(--c-ink); }
.hud-window-npc-dialog .quest-choose { color: #6b3d00; }
.hud-window-npc-dialog .quest-page-wait { color: #6b5334; }
`

let injected = false

export function ensureQuestStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'quests'
  style.textContent = CSS
  document.head.append(style)
}

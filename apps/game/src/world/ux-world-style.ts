/**
 * Styles of the world pieces lane UI-H owns (the retail chat box and the minimap plate), and of UX-B's name-tag
 * layout, pickup fly and chat bubbles, injected once (docs/UX_GAPS.md §6.8: new modules inject their own block
 * instead of editing style.css). Band colours and the [GM] tag live with the other label styles in world/style.ts.
 * Sizes are native px (the chat and minimap live in the zoomed .world-ui layer, docs/UI.md §3.2); colours are the
 * kit tokens. The context cursors are the kit's (ui/kit/cursor.ts setCursor, set from screens/world.ts setHovered).
 */

const CSS = `
/* ---- chat (UI-H): the retail chat viewer (ifchatviewer.txt): top row 20, box, bottom row 20 ---- */
.chat.uh-chat {
  position: absolute; left: 0; bottom: auto; width: 400px; transform: none; pointer-events: auto;
  font: 12px/15px var(--font-chat); color: var(--c-chat-all);
}
.uh-chat .chat-top { position: relative; height: 20px; }
.uh-chat .chat-btn { position: absolute; top: 0; }
.uh-chat .chat-whisper-btn { left: 0; }
.uh-chat .chat-hide-btn { left: 16px; }
.uh-chat .chat-tabs { position: absolute; left: 34px; top: 0; display: flex; gap: 0; margin: 0; }
.uh-chat.tabs-hidden .chat-tabs { visibility: hidden; }
.uh-chat .chat-tab {
  position: relative; flex: none; height: 20px; min-width: 0; margin: 0 -1px 0 0; padding: 0 0 0 11px; border: 0; border-radius: 0;
  background: transparent no-repeat 0 0 / 100% 100%; font: 11px/20px var(--font-body); color: #b9b19a; text-align: left;
  text-shadow: var(--t-outline); cursor: inherit; image-rendering: var(--art-rendering);
}
.uh-chat .chat-tab[hidden] { display: none; }
.uh-chat .chat-tab.no-art { background: rgba(0, 0, 0, 0.55); box-shadow: inset 0 0 0 1px rgba(156, 131, 80, 0.5); }
.uh-chat .chat-tab:hover { color: var(--c-caption); }
.uh-chat .chat-tab.on { color: var(--c-highlight); filter: brightness(1.3); }
.uh-chat .chat-tab-label { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding-right: 4px; pointer-events: none; }
.uh-chat .chat-lamp { position: absolute; left: 4px; top: 6px; width: 4px; height: 8px; background: no-repeat 0 0 / 100% 100%; opacity: 0.2; pointer-events: none; }
.uh-chat .chat-tab.on .chat-lamp { opacity: 1; }
.uh-chat .chat-tab.unread .chat-lamp { opacity: 1; animation: uh-lamp 0.8s steps(2) infinite; }
@keyframes uh-lamp { 50% { opacity: 0.25; } }

.uh-chat .chat-box { position: relative; margin: 1px 0 0 18px; }
.uh-chat .chat-bg { position: absolute; left: 0; right: 0; background-repeat: no-repeat; background-size: 100.8% 300%; pointer-events: none; image-rendering: auto; }
.uh-chat .chat-bg.up { top: 0; height: 4px; background-position: 0 0; }
.uh-chat .chat-bg.mid { top: 4px; bottom: 4px; background-position: 0 50%; }
.uh-chat .chat-bg.down { bottom: 0; height: 4px; background-position: 0 100%; }
.uh-chat .chat-bg.no-art { background: rgba(20, 26, 34, 0.55); }
.uh-chat .chat-bg.up.no-art, .uh-chat .chat-bg.down.no-art { background: rgba(20, 26, 34, 0.7); }
.uh-chat .kit-scroll.chat-scroll { position: absolute; left: -18px; top: 0; right: 0; bottom: 0; }
/* The retail chat always shows its scroll column (the kit hides the bar while the text fits). */
.uh-chat .chat-scroll .kit-scroll-bar,
.uh-chat .chat-scroll.fits .kit-scroll-bar { display: flex; left: 0; right: auto; }
.uh-chat .chat-scroll.fits .kit-scroll-thumb { display: none; }
.uh-chat .chat-scroll .kit-scroll-view,
.uh-chat .chat-scroll.fits .kit-scroll-view { left: 24px; right: 6px; top: 4px; bottom: 4px; }
.uh-chat .chat-log { height: auto; padding: 0; background: none; border: 0; text-shadow: var(--t-shadow); font: 12px/15px var(--font-chat); }
.uh-chat.typing .chat-log { background: none; }

.uh-chat .chat-bottom { position: relative; height: 20px; margin-top: 1px; }
.uh-chat .chat-size-btn { left: 0; }
.uh-chat .chat-mode-btn { left: 18px; }
.uh-chat[data-mode='party'] .chat-mode-btn { filter: sepia(0.6) saturate(2.2) hue-rotate(10deg) brightness(1.15); }
.uh-chat .chat-input-wrap { position: absolute; left: 38px; right: 0; top: 0; height: 20px; background: no-repeat 0 0 / 100% 100%; }
.uh-chat .chat-input-wrap.no-art { background: rgba(0, 0, 0, 0.7); box-shadow: inset 0 0 0 1px rgba(156, 131, 80, 0.5); }
.uh-chat .chat-input {
  display: block; width: 100%; height: 20px; margin: 0; padding: 0 6px; border: 0; background: transparent; outline: none;
  font: 12px/20px var(--font-chat); color: var(--c-text); text-shadow: var(--t-shadow);
}
.uh-chat .chat-input::placeholder { color: #8f8a7c; }
.uh-chat.typing .chat-input { background: transparent; border: 0; }
.uh-chat.typing .chat-input-wrap { box-shadow: 0 0 0 1px var(--c-level); }
.uh-chat .chat-new {
  position: absolute; right: 10px; bottom: 6px; height: 18px; padding: 0 8px; cursor: inherit; z-index: 1;
  font: 11px/16px var(--font-body); color: var(--c-highlight); background: rgba(40, 30, 10, 0.85); border: 1px solid #c9a24a; border-radius: 9px;
}
.chat-new[hidden] { display: none; }

/* C9: after 10 s idle the box fades to its text; hover, typing or a new line bring it back. */
.uh-chat .chat-bg, .uh-chat .chat-top, .uh-chat .chat-bottom, .uh-chat .kit-scroll-bar { transition: opacity 0.8s; }
.uh-chat.idle .chat-bg, .uh-chat.idle .chat-top, .uh-chat.idle .kit-scroll-bar { opacity: 0; }
.uh-chat.idle .chat-bottom { opacity: 0.35; }
.uh-chat.idle .chat-line { opacity: 0.8; }

.chat-line { word-break: break-word; white-space: pre-line; }
.chat-line .from[data-name] { cursor: inherit; }
.chat-line .from[data-name]:hover { text-decoration: underline; }
.uh-chat .chat-line, .uh-chat .chat-line .from { color: var(--c-chat-all); }
.uh-chat .chat-line.self .from { color: var(--c-highlight); }
.uh-chat .chat-line.whisper-in, .uh-chat .chat-line.whisper-in .from,
.uh-chat .chat-line.whisper-out, .uh-chat .chat-line.whisper-out .from { color: var(--c-chat-whisper); }
.uh-chat .chat-line.party, .uh-chat .chat-line.party .from { color: var(--c-chat-party); }
.uh-chat .chat-line.guild, .uh-chat .chat-line.guild .from { color: var(--c-chat-guild); }
.uh-chat .chat-line.stall, .uh-chat .chat-line.stall .from { color: var(--c-chat-stall); }
.uh-chat .chat-line.system { color: var(--c-chat-system); }
.uh-chat .chat-line.notice { color: var(--c-chat-notice); }
.uh-chat .chat-line.gm { color: var(--c-chat-gm); }
.uh-chat .chat-line.error { color: var(--c-chat-error); }
.chat[data-tab='whisper'] .chat-line:not([data-cat='whisper']),
.chat[data-tab='party'] .chat-line:not([data-cat='party']),
.chat[data-tab='guild'] .chat-line:not([data-cat='guild']),
.chat[data-tab='system'] .chat-line:not([data-cat='system']) { display: none; }

/* ---- minimap (UI-H): the retail plate GDR_MINIMAP 140x184 (ifminimap.txt) over the round map ---- */
/* GDR_MINIMAP at x = W - 132 (the texture's last 11 columns are transparent), y = 6. */
.hud-minimap-block.uh-mm { position: absolute; left: auto; right: -8px; top: 6px; width: 140px; height: 184px; pointer-events: none; }
.uh-mm .hud-minimap.uh-mm-map {
  position: absolute; left: 13px; top: 55px; width: 108px; height: 108px; border-radius: 50%; overflow: hidden;
  background: #0b0e0b; box-shadow: none; pointer-events: auto;
}
.uh-mm .uh-mm-map canvas { width: 100%; height: 100%; display: block; }
.uh-mm .uh-mm-plate { position: absolute; left: 0; top: 0; width: 140px; height: 184px; background: no-repeat 0 0 / 100% 100%; pointer-events: none; image-rendering: var(--art-rendering); }
.uh-mm.no-art .uh-mm-map { box-shadow: 0 0 0 2px #7a6440, 0 0 0 4px rgba(0, 0, 0, 0.65); }
.uh-mm.no-art .uh-mm-area, .uh-mm.no-art .uh-mm-coords { background: rgba(0, 0, 0, 0.6); }
.uh-mm .mm-button { position: absolute; width: 20px; height: 20px; padding: 0; border-radius: 50%; pointer-events: auto; cursor: inherit; font: bold 14px/18px var(--font-body); color: var(--c-highlight); background: rgba(20, 16, 8, 0.9); border: 1px solid #c9a24a; }
.uh-mm .mm-button.art { border: none; border-radius: 0; background: var(--img) center / 100% 100% no-repeat; image-rendering: var(--art-rendering); }
.uh-mm .mm-button.art:hover { background-image: var(--img-focus); }
.uh-mm .mm-button.art:active { background-image: var(--img-press); }
.uh-mm .mm-button:disabled { filter: grayscale(1) brightness(0.6); cursor: inherit; }
.uh-mm .mm-button[hidden] { display: none; }
.uh-mm .mm-zoomin { left: 107px; top: 136px; }
.uh-mm .mm-zoomout { left: 90px; top: 152px; }
.uh-mm .mm-map { left: 99px; top: 47px; width: 24px; height: 24px; }
.uh-mm .mm-map:not(.art)::before { content: '\\25A6'; font-size: 13px; }
.uh-mm .uh-mm-area {
  position: absolute; left: 12px; top: 9px; width: 104px; height: 13px; margin: 0; text-align: center;
  font: 11px/13px var(--font-body); color: var(--c-label); text-shadow: var(--t-outline);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: auto;
}
.uh-mm .uh-mm-area[hidden] { display: none; }
.uh-mm .uh-mm-coords { position: absolute; left: 0; top: 31px; width: 130px; height: 12px; margin: 0; font: 10px/12px var(--font-body); color: var(--c-text); text-shadow: var(--t-outline); pointer-events: auto; }
.uh-mm .uh-mm-x, .uh-mm .uh-mm-y { position: absolute; top: 0; width: 56px; text-align: center; font-variant-numeric: tabular-nums; white-space: nowrap; }
.uh-mm .uh-mm-x { left: 8px; }
.uh-mm .uh-mm-y { left: 67px; }

.entity-labels .entity-label { transition: opacity 150ms linear; }
.entity-labels .entity-label.np-hide { opacity: 0; }
.entity-label.np-far .level { display: none; }

/* Pickup feedback (F9): the item's icon flies to the inventory button. */
.ux-pickup-fly {
  position: fixed; width: 32px; height: 32px; margin: -16px 0 0 -16px; z-index: 50; pointer-events: none;
  background: center / 100% 100% no-repeat; border-radius: 3px; box-shadow: 0 0 8px rgba(255, 220, 130, 0.8);
  transition: transform 650ms cubic-bezier(0.5, 0, 0.9, 0.6), opacity 650ms ease-in;
}
.ux-pickup-fly.no-icon { width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #fff4b0, #d9a520 60%, #8a6210); }

/* Chat bubbles (C8): absolutely placed over the name tag, so the tag keeps its size and anchor. */
.entity-label .badge-bubble.chat-bubble {
  position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%);
  width: max-content; max-width: 200px; padding: 3px 8px; white-space: normal; overflow-wrap: anywhere; text-align: center;
  font: 12px/15px var(--font-body); color: #2a2110; text-shadow: none;
  background: rgba(255, 246, 214, 0.94); border: 1px solid #8a6d35; border-radius: 8px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
.entity-label .badge-bubble.chat-bubble::after {
  content: ''; position: absolute; left: 50%; top: 100%; margin-left: -5px;
  border: 5px solid transparent; border-top-color: #8a6d35;
}
`

let injected = false

export function ensureUxWorldStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'ux-world'
  style.textContent = CSS
  document.head.append(style)
}

/** Styles of the world-side labels (mob level bands, the [GM] tag, item labels, mob HP bars), injected once. */
const CSS = `
.entity-label.kind-mob .name { color: #ffe066; }
.entity-label.kind-mob.band-weak2 .name { color: #a0a0a0; }
.entity-label.kind-mob.band-weak1 .name { color: #8fe08a; }
.entity-label.kind-mob.band-normal .name { color: #ffe066; }
.entity-label.kind-mob.band-strong1 .name { color: #ffa04a; }
.entity-label.kind-mob.band-strong2 .name { color: #ff5a48; }
.entity-label.kind-mob.unique .name { color: #ff9cf0; }
.entity-label.kind-mob .level { color: #f3d7a0; }
.entity-label.kind-npc .name { color: #9df0a8; }
.entity-label.kind-item { font: 12px var(--font-body); }
.entity-label.kind-item .name { color: #fff3c4; }
.entity-label.kind-item.owned .name { color: #c9a39c; }
.entity-label.dead .name, .entity-label.dead .level { color: #9a9a9a; }
.entity-label.hover .name { text-decoration: underline; text-underline-offset: 3px; }
.entity-label .badge-gm { color: #7fd3ff; font-weight: bold; margin-right: 4px; }
.entity-label.gm .name { color: #7fd3ff; font-weight: bold; }
.entity-label .hp { width: 56px; height: 4px; margin: 2px auto 0; background: rgba(0,0,0,0.65); border: 1px solid rgba(0,0,0,0.8); }
.entity-label .hp[hidden] { display: none; }
.entity-label .hp i { display: block; height: 100%; background: linear-gradient(#e0473a, #9c1e16); }
body[data-screen='world'] canvas.hover-target { cursor: pointer; }
`

let injected = false

export function ensureWorldStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'world'
  style.textContent = CSS
  document.head.append(style)
}

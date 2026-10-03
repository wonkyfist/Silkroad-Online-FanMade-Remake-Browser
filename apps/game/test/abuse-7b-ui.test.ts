/**
 * H7B adversarial hunt, lens "ui" (docs/WAVE_PLAN2.md §5.15: UI zoom, keyboard, fonts, tabs model).
 * Every test here failed on the tree it was written against; each one proves one finding. There is no DOM in vitest,
 * so the keyboard tests feed plain event objects through KeyMap.handle() (as seams.test.ts does) and the Esc / CSS
 * tests read the sources that decide the behaviour. The browser repros are in the hunt report.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KeyMap, type KeyEventLike } from '../src/hud/keys.ts'
import { MAIN_TAB_ORDER, nextSlot } from '../src/ui/kit/main-window.ts'

const SRC = resolve(__dirname, '../src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|css)$/.test(name)) out.push(p)
  }
  return out
}

/** A focused kit widget that is not an INPUT: a `role` attribute on a DIV (kit Slider / List), with the DOM calls a fix may use. */
function widget(role: 'slider' | 'listbox', className: string) {
  const self: Record<string, unknown> = {
    tagName: 'DIV',
    nodeName: 'DIV',
    isContentEditable: false,
    role,
    className,
    tabIndex: 0,
    getAttribute: (n: string) => (n === 'role' ? role : n === 'tabindex' ? '0' : null),
    hasAttribute: (n: string) => n === 'role' || n === 'tabindex',
    matches: (sel: string) => sel.includes(role) || sel.includes(className),
    closest: (sel: string) => (sel.includes(role) || sel.includes(className) ? self : null),
    classList: { contains: (c: string) => c === className },
  }
  return self
}

const down = (key: string, target: unknown): KeyEventLike => ({
  key,
  type: 'keydown',
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  target: target as EventTarget,
  preventDefault() {},
})

describe('H7B ui: game keys stay off in focused kit input widgets', () => {
  // The kit Slider (Options graphics quality / UI sliders, Sound volumes, GM speed) and List (GM players, Select
  // popups) handle the arrow keys on their own root; the KeyMap listens in the capture phase on window, so it runs
  // first and fires the camera binding too. Browser: Options → Graphics, focus the quality slider, ArrowLeft → the
  // quality drops to Low AND the camera spins left for as long as the key is held.
  for (const [role, cls, key] of [
    ['slider', 'kit-slider', 'ArrowLeft'],
    ['slider', 'kit-slider', 'ArrowRight'],
    ['listbox', 'kit-list', 'ArrowDown'],
    ['listbox', 'kit-list', 'ArrowUp'],
  ] as const) {
    it(`${key} on a focused ${role} does not also run the camera binding`, () => {
      const keys = new KeyMap()
      let camera = 0
      keys.register({ id: `camera.${key}`, keys: [key.toLowerCase()], label: 'keys.camera.left', group: 'camera', repeat: true, run: () => camera++, up: () => {} })
      keys.handle(down(key, widget(role, cls)))
      expect(camera, `${key} reached the camera while a ${role} had focus`).toBe(0)
    })
  }
})

describe('H7B ui: Esc closes the top window only', () => {
  const hud = read('hud/index.ts')

  it('the HUD Esc chain asks the kit for the top window of ALL open windows (not only Main + Options/KeyHelp/System)', () => {
    // hud/index.ts: `openWindows = () => [mainWin, ...shell.windows]` — the Action window, the GM window, the shop /
    // storage / NPC windows, the world map and the placeholders are not in it. Browser: I, then MENU → Action (z 102
    // over Main z 101), Esc → Main closes and Action stays; F9 GM window over the Inventory behaves the same.
    const chain = /const openWindows = \(\) => \[([^\]]*)\]/.exec(hud)
    const usesKitTop = /\btopWindow\(\)/.test(hud)
    expect(usesKitTop || !chain, `Esc chain is a fixed list: [${chain?.[1]}]`).toBe(true)
  })

  it('the Action window (FX-C2) closes on Esc: its feature has an escape hook', () => {
    // posture.ts returns { onMessage, onEntityAdded, dispose } and no escape(); the HUD chain does not know the window.
    // Browser: MENU → Action, Esc → the System menu opens over it (or the target clears); Action never closes on Esc.
    const src = read('world/features/posture.ts')
    const feature = src.slice(src.indexOf('export function postureFeature'))
    expect(/\bescape\s*\(/.test(feature) || /\btopWindow\(\)/.test(hud)).toBe(true)
  })

  it('the GM window closes on Esc (its root handler blurs only; no escape hook, not in the HUD chain)', () => {
    // gm/window.ts root keydown: Escape → blur the focused element and stopPropagation; world.ts has no hook for it.
    // Browser: F9, Esc → nothing / System menu; with the Inventory open under it, Esc closes the Inventory instead.
    const gm = read('gm/window.ts')
    const from = gm.indexOf('Keys typed in the window stay in the window')
    const handler = from >= 0 ? gm.slice(from, from + 400) : ''
    const gmClosesOnEsc = /Escape[^\n]*(close|hide|toggle)\(\)/.test(handler)
    expect(gmClosesOnEsc || /\btopWindow\(\)/.test(hud)).toBe(true)
  })

  it('Esc with a kit Select popup open closes the popup, not the whole window', () => {
    // The Select (Options → Interface → UI scale) closes its popup on Esc in its own root listener, but the HUD Esc
    // listener is registered with { capture: true } on window and calls stopImmediatePropagation after closing the
    // top window, so the Select never sees the key. Browser: Options → Interface → open the UI-scale drop-down, Esc →
    // the Options window closes and the popup is left open (it is still open when Options is reopened).
    const at = hud.indexOf("if (ev.key === 'Escape') {")
    expect(at).toBeGreaterThan(0)
    const block = hud.slice(at, hud.indexOf('{ capture: true }', at))
    expect(/kit-select|Select\b|defaultPrevented|closest\(/.test(block), 'the capture-phase Esc handler never defers to an open popup').toBe(true)
  })
})

describe('H7B ui: drag visuals', () => {
  it('the skill / hotbar drag ghost (.hud-drag-ghost) still has a style', () => {
    // hud/hotbar.ts IconDrag creates el('div', 'hud-drag-ghost') on <body>. The rule lived in style.css until the 7B
    // checkpoint removed it; nothing defines it now, so the ghost is a static, 0-px-high block at the end of <body>:
    // dragging a skill from the Skill tab (or a hotbar slot) shows no icon under the cursor. Browser: a
    // `div.hud-drag-ghost` on <body> computes position: static, 1280×0 px.
    const sources = walk(SRC).map(f => readFileSync(f, 'utf8'))
    const rule = sources.some(s => /\.hud-drag-ghost\s*[,{][^}]*position:\s*fixed/.test(s) || /\.hud-drag-ghost\s*\{[^}]*position:\s*fixed/.test(s))
    expect(rule).toBe(true)
  })
})

describe('H7B ui: Main window placeholder tabs', () => {
  it('a tab registered without a retail slot does not land on a placeholder button (Action / Apprenticeship)', () => {
    // hud/main-window.ts puts disabled placeholder buttons at the retail slots of 'action' (3) and 'apprenticeship'
    // (6) but they are not tabs, so nextSlot() treats slot 3 as free: the next extra tab (wave 8: guild, stall …)
    // is drawn on top of the greyed Action button.
    const taken = ['character', 'inventory', 'skill', 'party', 'quest'].map(id => MAIN_TAB_ORDER.indexOf(id as (typeof MAIN_TAB_ORDER)[number]))
    const placeholders = ['action', 'apprenticeship'].map(id => MAIN_TAB_ORDER.indexOf(id as (typeof MAIN_TAB_ORDER)[number]))
    expect(placeholders).not.toContain(nextSlot('guild', taken))
  })

  it('UI.md §4.6: Action and Apprenticeship stay hidden until they exist (Action now exists as its own window)', () => {
    // The code shows both as visible, disabled "coming soon" buttons (display: flex in the browser), while the
    // MENU → Action row opens FX-C2's separate Action window: the Main window's Action button says "soon" for a
    // window that is already there.
    const src = read('hud/main-window.ts')
    expect(/for \(const id of \[[^\]]*'action'/.test(src), "hud/main-window.ts still adds a disabled 'action' placeholder").toBe(false)
  })
})

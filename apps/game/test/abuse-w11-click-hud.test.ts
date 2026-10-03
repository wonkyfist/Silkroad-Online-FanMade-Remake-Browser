/**
 * H-11 adversarial hunt (docs/WAVE_PLAN7.md §6.6 lens 9, "the click and the HUD"), the game's side. Read-only: no
 * product code is changed by this file. Each `it` below that fails is a finding:
 *
 * - H11-CH-1 the speech cursor never shows: ux-world sets `canvas.dataset.hover = 'npc'` over a townsperson
 *   (world/features/ux-world.ts setCursor), but no stylesheet anywhere reads `data-hover` (the K10 rules it names,
 *   "ux-world-style.ts maps it to a cursor", do not exist; the retail cursors moved to ui/kit/cursor.ts
 *   `body[data-cursor]`, which only world.ts' entity hover sets). TOWN_LIFE §3.6: "the cursor shows the speech cursor".
 * - H11-CH-3 a town bubble covers a name tag: world/features/town.ts lays the bubbles out against a GUESSED tag box
 *   (TAG_W 120 × TAG_H 18 at the tag's `transform` anchor). It ignores the plate layout's nudge (nameplates.ts applies
 *   it as `style.translate`, up to 42 px) and the tag's real width (a long name, a guild line), so the bubble is shown
 *   over a nudged or wide tag (TOWN_LIFE: "a bubble never covers a name tag"; WAVE_PLAN7 D22).
 * - H11-CH-4 Tiger Girl is a plain red monster sign on the minimap: screens/world.ts minimapEntities never passes
 *   `unique`, so jangan/minimap.ts' `mm_sign_unique` branch is dead (UNIQUES §3.7: "the retail unique sign when she is
 *   in minimap range, which the minimap already draws for any unique").
 * - H11-CH-5 the notice banner eats world clicks while invisible: `.notice-banner` is `pointer-events: auto` in every
 *   state, including the 500 ms `out` fade at opacity 0 (and the first frame before `in`), at the top centre where a
 *   click-to-move lands; with wave 11 every unique appear / defeat shows one (8 s).
 * - H11-CH-6 a unique banner already on screen when the player leaves the world (world -> select) stays over the
 *   character screen for the rest of its 8 s, with its cue already played: `live` is only checked when a notice is
 *   queued or its turn comes (UNIQUES §3.3: "nothing shows outside the world"; app.ts never clears the queue).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// The bubble's head projects to a fixed screen point (NullEngine has no canvas, so toScreen would say "not visible").
const proj = vi.hoisted(() => ({ x: 500, y: 300 }))
vi.mock('../src/three/project.ts', () => ({ toScreen: () => ({ x: proj.x, y: proj.y, visible: true }) }))

import type { WorldFeatureContext } from '../src/world/features.ts'
import { townFeature, type TownApp, type TownBubbleLike } from '../src/world/features/town.ts'
import { NUDGE_PX, MAX_NUDGES } from '../src/world/nameplates.ts'
import { showUniqueNotice, type UniqueNoticeMessage } from '../src/hud/unique-notice.ts'
import { NoticeBanner } from '../src/ui/notice.ts'

const SRC = join(import.meta.dirname, '../src')

// ---- a DOM stub (w11-cross.test.ts' shape): the entity-label layer and the bubbles --------------------------------

class StubElement {
  className = ''
  hidden = false
  offsetWidth = 120
  offsetHeight = 20
  readonly style: Record<string, string> = {}
  readonly dataset: Record<string, string> = {}
  readonly children: (StubElement | string)[] = []
  parent: StubElement | null = null
  readonly classList = {
    toggle: (c: string, on?: boolean) => {
      const has = this.className.split(' ').includes(c)
      const want = on ?? !has
      if (want && !has) this.className = `${this.className} ${c}`.trim()
      if (!want && has) this.className = this.className.split(' ').filter(x => x !== c).join(' ')
      return want
    },
    add: (c: string) => void this.classList.toggle(c, true),
    remove: (c: string) => void this.classList.toggle(c, false),
    contains: (c: string) => this.className.split(' ').includes(c),
  }
  setAttribute(): void {}
  addEventListener(): void {}
  append(...c: (StubElement | string)[]): void {
    for (const x of c) {
      if (x instanceof StubElement) x.parent = this
      this.children.push(x)
    }
  }
  remove(): void {
    if (!this.parent) return
    const i = this.parent.children.indexOf(this)
    if (i >= 0) this.parent.children.splice(i, 1)
    this.parent = null
  }
  get textContent(): string {
    return this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join('')
  }
  set textContent(v: string) {
    this.children.length = 0
    this.children.push(v)
  }
  querySelector(sel: string): StubElement | null {
    const cls = sel.replace(/^\./, '')
    for (const c of this.children) {
      if (typeof c === 'string') continue
      if (c.className.split(' ').includes(cls)) return c
      const f = c.querySelector(sel)
      if (f) return f
    }
    return null
  }
}

const g = globalThis as { document?: unknown; requestAnimationFrame?: unknown }
const saved = { document: g.document, had: 'document' in g, raf: g.requestAnimationFrame, hadRaf: 'requestAnimationFrame' in g }
let labels: StubElement
let body: StubElement

beforeAll(() => {
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 16)
  body = new StubElement()
  body.dataset.screen = 'world'
  labels = new StubElement()
  labels.className = 'entity-labels'
  body.append(labels)
  g.document = {
    createElement: () => new StubElement(),
    body,
    head: new StubElement(),
    querySelector: (s: string) => body.querySelector(s),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
})

afterAll(() => {
  if (saved.had) g.document = saved.document
  else delete g.document
  if (saved.hadRaf) g.requestAnimationFrame = saved.raf
  else delete g.requestAnimationFrame
})

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

/** A town part with one vendor call bubble over a townsperson's head. */
class OneBubble implements TownApp {
  readonly range = 60
  readonly enabled = true
  bubbles(out: TownBubbleLike[]): number {
    const b = out[0]!
    b.agent = 5
    b.text = 'Fresh peaches!'
    b.x = 3
    b.y = 1.9
    b.z = 3
    b.dist = 4
    b.click = false
    return 1
  }
  setPlayers(): void {}
}

interface Rect {
  x0: number
  x1: number
  y0: number
  y1: number
}
const overlap = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

/** The rect a name tag is DRAWN at: its anchor (`transform`, translate(-50%, -100%)) plus the plate nudge (`translate`). */
function tagRect(el: StubElement): Rect {
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform!)!
  const ax = Number(m[1])
  const ay = Number(m[2])
  const dy = el.style.translate ? Number(/0 (-?[\d.]+)px/.exec(el.style.translate)![1]) : 0
  return { x0: ax - el.offsetWidth / 2, x1: ax + el.offsetWidth / 2, y0: ay + dy - el.offsetHeight, y1: ay + dy }
}

/** The rect the shown bubble is drawn at, or null when it is hidden. */
function bubbleRect(): Rect | null {
  const el = labels.children.find((c): c is StubElement => c instanceof StubElement && c.classList.contains('town-bubble') && !c.classList.contains('tb-hide'))
  if (!el) return null
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform!)!
  const ax = Number(m[1])
  const ay = Number(m[2])
  return { x0: ax - el.offsetWidth / 2, x1: ax + el.offsetWidth / 2, y0: ay - el.offsetHeight, y1: ay }
}

/** The town feature on one frame, with one player whose name tag is `tag`. */
function frameWithTag(tag: StubElement): void {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.activeCamera = new ArcRotateCamera('cam', -Math.PI / 2, 1.1, 9, Vector3.Zero(), scene)
  const town = new OneBubble()
  labels.append(tag)
  const views = [{ id: 1, kind: 'player', pos: new Vector3(0, 0, 0), isDisposed: false, label: tag }]
  const ctx = {
    scene,
    world: () => ({ world: { town } }),
    views: () => views.values(),
    view: (id: number) => views.find(v => v.id === id),
    selfId: () => 1,
  } as unknown as WorldFeatureContext
  const f = townFeature(ctx)
  cleanups.push(() => {
    f.dispose?.()
    tag.remove()
    scene.dispose()
    engine.dispose()
  })
  f.onFrame?.(0, 0.016)
}

function playerTag(o: { x: number; y: number; w: number; h?: number; nudge?: number }): StubElement {
  const tag = new StubElement()
  tag.className = 'entity-label'
  tag.offsetWidth = o.w
  tag.offsetHeight = o.h ?? 18
  tag.style.transform = `translate(${o.x}px, ${o.y}px) translate(-50%, -100%)`
  // nameplates.ts NameplateLayout.apply: a nudged tag is moved up with `style.translate`
  if (o.nudge) tag.style.translate = `0 ${-o.nudge}px`
  return tag
}

// ---- the tests ------------------------------------------------------------------------------------------------------

function sources(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|css)$/.test(n)) out.push(p)
  }
  return out
}

describe('H11-CH-1: the speech cursor over a townsperson', () => {
  it('ux-world marks the canvas data-hover="npc" over a townsperson (the path the town uses)', () => {
    const ux = readFileSync(join(SRC, 'world/features/ux-world.ts'), 'utf8')
    expect(ux).toMatch(/setCursor\(hoverCursor\(hovered\) \|\| \(townHover \? 'npc' : ''\)\)/)
    expect(ux).toMatch(/canvas\.dataset\.hover = kind/)
  })

  it('some stylesheet maps the canvas\' data-hover kinds to a cursor (else the speech cursor never shows)', () => {
    const files = [...sources(SRC), join(SRC, '../index.html')]
    // A CSS selector that reads the attribute: [data-hover…] in a .css file or a CSS string of a .ts file.
    const rules = files.filter(f => /\[data-hover/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
    expect(rules, 'files with a [data-hover] selector').not.toEqual([])
  })
})

describe('H11-CH-3: a town bubble over a name tag', () => {
  it('control: a tag in its unnudged place, the default width, under the bubble: no overlap', () => {
    const tag = playerTag({ x: 500, y: 342, w: 120 })
    frameWithTag(tag)
    const b = bubbleRect()
    expect(b).not.toBeNull()
    expect(overlap(b!, tagRect(tag))).toBe(false)
  })

  it('a tag the plate layout nudged up (style.translate) is not covered by the bubble', () => {
    // The plates de-clutter a crowded plaza by nudging tags up to MAX_NUDGES × NUDGE_PX.
    const tag = playerTag({ x: 500, y: 342, w: 120, nudge: MAX_NUDGES * NUDGE_PX })
    frameWithTag(tag)
    const b = bubbleRect()
    // either the bubble moved or hid, or it does not sit on the tag where the tag is drawn
    expect(b === null || !overlap(b, tagRect(tag)), `bubble ${JSON.stringify(b)} vs tag ${JSON.stringify(tagRect(tag))}`).toBe(true)
  })

  it('a wide tag (a long name: 220 px) beside the bubble is not covered by it', () => {
    const tag = playerTag({ x: 640, y: 300, w: 220 })
    frameWithTag(tag)
    const b = bubbleRect()
    expect(b === null || !overlap(b, tagRect(tag)), `bubble ${JSON.stringify(b)} vs tag ${JSON.stringify(tagRect(tag))}`).toBe(true)
  })
})

describe('H11-CH-4: Tiger Girl on the minimap', () => {
  it('the minimap draws the retail unique sign for a unique (the branch exists)', () => {
    const mm = readFileSync(join(SRC, 'world/jangan/minimap.ts'), 'utf8')
    expect(mm).toMatch(/e\.kind === 'mob' && e\.unique \? SIGNS\.unique/)
  })

  it('the world screen tells the minimap which mob is a unique', () => {
    const world = readFileSync(join(SRC, 'screens/world.ts'), 'utf8')
    const body = /function\* minimapEntities[\s\S]*?\n {2}\}\n/.exec(world)?.[0] ?? ''
    expect(body).toContain('yield')
    // the label decides it from state.variant / the mob's rarity (world/entities.ts); the minimap gets neither
    expect(body).toMatch(/unique/)
  })
})

describe('H11-CH-5: the notice banner and world clicks', () => {
  it('a fading-out (opacity 0) banner does not take pointer events', () => {
    const css = readFileSync(join(SRC, 'style.css'), 'utf8')
    const out = /\.notice-banner\.out\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const base = /\.notice-banner\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(base).toMatch(/pointer-events:\s*auto/)
    expect(out).toMatch(/opacity:\s*0/)
    expect(out, '.notice-banner.out rule').toMatch(/pointer-events:\s*none/)
  })
})

describe('H11-CH-6: a unique banner and leaving the world', () => {
  it('the unique banner on screen goes when the world screen goes (world -> select)', () => {
    vi.useFakeTimers()
    cleanups.push(() => vi.useRealTimers())
    const notices = new NoticeBanner()
    cleanups.push(() => notices.clear())
    const cues: string[] = []
    const msg: UniqueNoticeMessage = { t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', area: 'North-Tiger Mt.' } as UniqueNoticeMessage
    // in the world: the banner and the cue (app.ts' dispatch; inWorld reads body.dataset.screen)
    showUniqueNotice(msg, { notices, audio: { ui: (c: string) => void cues.push(c) } as never })
    expect(notices.showing).toBe('unique')
    expect(cues).toEqual(['ui.uniqueAppear'])
    // 1 s later the player logs out to the character screen (app.ts sets body.dataset.screen)
    vi.advanceTimersByTime(1000)
    body.dataset.screen = 'select'
    vi.advanceTimersByTime(500)
    try {
      expect(notices.showing, 'a unique banner over the character screen').toBeNull()
    } finally {
      body.dataset.screen = 'world'
    }
  })
})

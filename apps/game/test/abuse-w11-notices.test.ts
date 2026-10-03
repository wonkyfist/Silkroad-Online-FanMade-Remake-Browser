/**
 * H-11 adversarial hunt, lens = announcement abuse and correctness (docs/WAVE_PLAN7.md §6.6 lens 3), the client side:
 * the one notice queue (UNIQUES §3.3: "a unique notice and a GM notice queue behind each other instead of two banners
 * overlapping"), nothing on the lobby or the character stage, and each cue once.
 *
 * Tests named "BUG:" reproduce a real defect and FAIL until it is fixed; their assertions state the correct behaviour.
 * The DOM stub is unique-notice.test.ts' (no DOM library in this repo).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { showUniqueNotice, type UniqueNoticeMessage } from '../src/hud/unique-notice.ts'
import { NoticeBanner, UNIQUE_NOTICE_MS } from '../src/ui/notice.ts'

class StubElement {
  className = ''
  readonly style: Record<string, string> = {}
  readonly dataset: Record<string, string> = {}
  readonly attrs: Record<string, string> = {}
  readonly children: (StubElement | string)[] = []
  parent: StubElement | null = null
  readonly listeners: Record<string, (() => void)[]> = {}
  readonly classList = {
    add: (c: string) => {
      if (!this.className.split(' ').includes(c)) this.className = `${this.className} ${c}`.trim()
    },
    remove: (c: string) => {
      this.className = this.className.split(' ').filter(x => x !== c).join(' ')
    },
    contains: (c: string) => this.className.split(' ').includes(c),
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }
  addEventListener(type: string, fn: () => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
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
  click(): void {
    for (const fn of this.listeners.click ?? []) fn()
  }
}

const g = globalThis as { document?: unknown; requestAnimationFrame?: unknown }
const saved = { document: g.document, raf: g.requestAnimationFrame, hadDocument: 'document' in g, hadRaf: 'requestAnimationFrame' in g }
let body: StubElement

beforeAll(() => {
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 16)
})
afterAll(() => {
  if (saved.hadDocument) g.document = saved.document
  else delete g.document
  if (saved.hadRaf) g.requestAnimationFrame = saved.raf
  else delete g.requestAnimationFrame
})
beforeEach(() => {
  vi.useFakeTimers()
  body = new StubElement()
  body.dataset.screen = 'world'
  g.document = { createElement: () => new StubElement(), body }
})
afterEach(() => {
  vi.useRealTimers()
})

const banners = () => body.children.filter((c): c is StubElement => c instanceof StubElement && c.className.split(' ').includes('notice-banner'))
const appeared: UniqueNoticeMessage = { t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', area: 'North-Tiger Mt.' }
const defeated: UniqueNoticeMessage = { t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', by: 'Mei', party: true }

describe('the one notice queue', () => {
  it('BUG: a notice that arrives during the 0.5 s fade-out jumps the queue; the fade then shows the next one on top, and the first banner never leaves the screen', () => {
    const notices = new NoticeBanner()
    const cues: string[] = []
    const ctx = { notices, audio: { ui: (c: string) => void cues.push(c) } }
    // A GM notice is up; the unique's appear notice waits behind it (the one queue).
    notices.show('Server restart in 10 minutes.', { from: 'GM_Pixi', ms: 6000 })
    showUniqueNotice(appeared, ctx)
    expect(banners()).toHaveLength(1)
    // The GM banner times out and starts its 0.5 s fade...
    vi.advanceTimersByTime(6000 + 100)
    // ...and inside that fade a third notice arrives (e.g. a GM's quick `/unique kill` test, another GM notice).
    showUniqueNotice(defeated, ctx)
    vi.advanceTimersByTime(600)
    // Correct: one banner at a time.
    expect(banners().length, banners().map(b => b.textContent).join(' || ')).toBe(1)
    // Long after every notice's time is up, nothing is left on screen (here the appear banner stays forever: its own
    // timer and a click both hit `this.node !== node`).
    vi.advanceTimersByTime(3 * UNIQUE_NOTICE_MS)
    for (const b of banners()) b.click()
    vi.advanceTimersByTime(1000)
    expect(banners()).toHaveLength(0)
    expect(cues).toEqual(['ui.uniqueAppear', 'ui.uniqueDown'])
  })
})

describe('nothing outside the world (UNIQUES §3.3: "not the lobby, not the character screens")', () => {
  it('BUG: a unique banner up when the player leaves the world stays on the character stage for the rest of its 8 s', () => {
    const notices = new NoticeBanner()
    const ctx = { notices, audio: { ui: () => {} } }
    showUniqueNotice(appeared, ctx)
    expect(banners()).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    // app.go('select'): the screen changes (ui.replaceChildren does not touch the banner, which lives on <body>).
    body.dataset.screen = 'select'
    vi.advanceTimersByTime(1000)
    // Correct: a unique banner whose `live()` no longer holds leaves with the world (the queued ones are dropped already).
    expect(banners()).toHaveLength(0)
  })
})

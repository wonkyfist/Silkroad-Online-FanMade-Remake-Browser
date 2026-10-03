/**
 * Wave 11 lane U-H (docs/UNIQUES.md §3.3, docs/WAVE_PLAN7.md §6.1): the unique-monster notices. The text keys (an area
 * with a trailing "." printed as is, no area, the solo and party forms), the chat line, the one queue a GM notice and a
 * unique notice share (never two banners), the unique style (pink name, own title, 8 s), the cues `ui.uniqueAppear` /
 * `ui.uniqueDown` played when the banner appears, and nothing outside the world (the lobby, the character screens).
 */
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNIQUE_CUES, showUniqueNotice, uniqueChatLine, uniqueNoticeText, type UniqueNoticeMessage } from '../src/hud/unique-notice.ts'
import { en } from '../src/i18n/en.ts'
import { enUnique } from '../src/i18n/en-unique.ts'
import { NoticeBanner, UNIQUE_NOTICE_MS, UNIQUE_PINK } from '../src/ui/notice.ts'

/** Just enough DOM for NoticeBanner (no DOM library in this repo). */
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
  find(cls: string): StubElement | null {
    for (const c of this.children) {
      if (typeof c === 'string') continue
      if (c.className.split(' ').includes(cls)) return c
      const f = c.find(cls)
      if (f) return f
    }
    return null
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

const appeared = (area?: string): UniqueNoticeMessage => ({ t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', ...(area !== undefined ? { area } : {}) })
const defeated = (by?: string, party?: boolean): UniqueNoticeMessage => ({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', ...(by ? { by } : {}), ...(party !== undefined ? { party } : {}) })

function rig() {
  const notices = new NoticeBanner()
  const cues: string[] = []
  const ctx = { notices, audio: { ui: (c: string) => void cues.push(c) } }
  return { notices, cues, ctx }
}

describe('unique notice text', () => {
  it('prints the area as is (its trailing "." is the name\'s own), and drops it when absent', () => {
    expect(uniqueNoticeText(appeared('North-Tiger Mt.'))).toBe('Tiger Girl has appeared! Area: North-Tiger Mt.')
    expect(uniqueNoticeText(appeared('Jangan'))).toBe('Tiger Girl has appeared! Area: Jangan')
    expect(uniqueNoticeText(appeared())).toBe('Tiger Girl has appeared!')
    expect(uniqueNoticeText(appeared('   '))).toBe('Tiger Girl has appeared!')
  })

  it('the solo, party and no-killer defeat forms', () => {
    expect(uniqueNoticeText(defeated('Mei'))).toBe('Mei has defeated Tiger Girl!')
    expect(uniqueNoticeText(defeated('Mei', false))).toBe('Mei has defeated Tiger Girl!')
    expect(uniqueNoticeText(defeated('Mei', true))).toBe('Mei\'s party has defeated Tiger Girl!')
    expect(uniqueNoticeText(defeated())).toBe('Tiger Girl has been defeated!')
  })

  it('the chat line wraps the sentence; every key is registered in en.ts', () => {
    expect(uniqueChatLine(appeared('North-Tiger Mt.'))).toBe('[Unique] Tiger Girl has appeared! Area: North-Tiger Mt.')
    expect(uniqueChatLine(defeated('Mei', true))).toBe('[Unique] Mei\'s party has defeated Tiger Girl!')
    for (const [k, v] of Object.entries(enUnique)) expect((en as Record<string, string>)[k], k).toBe(v)
  })
})

describe('unique notice banner', () => {
  it('the unique style: own title, the name in the unique pink, 8 s, the appear cue when it shows', () => {
    const { notices, cues, ctx } = rig()
    showUniqueNotice(appeared('North-Tiger Mt.'), ctx)
    const [b] = banners()
    expect(banners()).toHaveLength(1)
    expect(b!.className).toContain('unique')
    expect(notices.showing).toBe('unique')
    const title = b!.find('notice-title')!
    expect(title.textContent).toBe('Unique Monster')
    expect(title.style.color).toBe(UNIQUE_PINK)
    expect(UNIQUE_PINK).toBe('#ff9cf0')
    const name = b!.find('notice-name')!
    expect(name.textContent).toBe('Tiger Girl')
    expect(name.style.color).toBe('#ff9cf0')
    expect(b!.find('notice-text')!.textContent).toBe('Tiger Girl has appeared! Area: North-Tiger Mt.')
    expect(cues).toEqual(['ui.uniqueAppear'])
    vi.advanceTimersByTime(UNIQUE_NOTICE_MS - 100)
    expect(notices.showing).toBe('unique')
    vi.advanceTimersByTime(100 + 500)
    expect(banners()).toHaveLength(0)
    expect(UNIQUE_NOTICE_MS).toBe(8000)
  })

  it('the defeat cue is ui.uniqueDown; both cue names are in the converter\'s cue table', () => {
    const { cues, ctx } = rig()
    showUniqueNotice(defeated('Mei', true), ctx)
    expect(cues).toEqual(['ui.uniqueDown'])
    expect(UNIQUE_CUES).toEqual({ appeared: 'ui.uniqueAppear', defeated: 'ui.uniqueDown' })
    const table = readFileSync(new URL('../../../packages/convert/src/sound/build.ts', import.meta.url), 'utf8')
    expect(table).toContain('[\'ui.uniqueAppear\', \'ui/alarm_sound.wav\']')
    expect(table).toContain('[\'ui.uniqueDown\', \'ui/eventcomplete.wav\']')
  })

  it('a GM notice and a unique notice queue on the one banner and never overlap; the cue waits for its banner', () => {
    const { notices, cues, ctx } = rig()
    notices.show('Server restart in 10 minutes', 'Mei')
    showUniqueNotice(appeared('North-Tiger Mt.'), ctx)
    notices.show('Second GM notice')
    expect(banners()).toHaveLength(1)
    expect(notices.showing).toBe('gm')
    expect(notices.pending).toBe(2)
    expect(cues).toEqual([])
    expect(banners()[0]!.find('notice-from')!.textContent).toBe('from Mei')
    const seen: string[] = []
    for (let ms = 0; ms < 60_000; ms += 50) {
      vi.advanceTimersByTime(50)
      expect(banners().length).toBeLessThanOrEqual(1)
      const k = notices.showing
      if (k && seen[seen.length - 1] !== k) seen.push(k)
    }
    expect(seen).toEqual(['gm', 'unique', 'gm'])
    expect(cues).toEqual(['ui.uniqueAppear'])
    expect(notices.pending).toBe(0)
  })

  it('nothing in the lobby or the character screens; a queued unique notice is dropped when the world closes', () => {
    const { notices, cues, ctx } = rig()
    for (const screen of ['login', 'servers', 'charselect', 'charcreate']) {
      body.dataset.screen = screen
      showUniqueNotice(appeared('North-Tiger Mt.'), ctx)
      expect(banners(), screen).toHaveLength(0)
    }
    expect(cues).toEqual([])
    // GM notices still show on every screen.
    notices.show('Maintenance tonight')
    expect(notices.showing).toBe('gm')
    // In the world: a unique notice waits behind the GM one; the player leaves for the character screen meanwhile.
    body.dataset.screen = 'world'
    showUniqueNotice(defeated('Mei'), ctx)
    expect(notices.pending).toBe(1)
    body.dataset.screen = 'charselect'
    vi.advanceTimersByTime(30_000)
    expect(banners()).toHaveLength(0)
    expect(notices.pending).toBe(0)
    expect(cues).toEqual([])
  })

  it('no document (a worker or a test without DOM): nothing shown, nothing thrown', () => {
    delete g.document
    const { cues, ctx } = rig()
    expect(() => showUniqueNotice(appeared(), ctx)).not.toThrow()
    expect(cues).toEqual([])
  })

  it('no audio yet: the banner still shows', () => {
    const notices = new NoticeBanner()
    showUniqueNotice(appeared(), { notices, audio: null })
    expect(notices.showing).toBe('unique')
  })
})

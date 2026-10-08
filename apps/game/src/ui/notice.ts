/**
 * Server-wide announcements: a centred banner near the top of the screen. GM `notice`s show on every screen (lobby
 * included); wave 11's unique-monster notices (docs/UNIQUES.md §3.3, lane U-H) go through the SAME queue with
 * `kind: 'unique'` (their own title, the unique's name in the unique pink, 8 s), so a GM notice and a unique notice
 * wait for each other instead of two banners overlapping at the top centre. Each GM notice stays up for a time that
 * grows with its length.
 */
import { t } from '../i18n/index.ts'
import { el } from './dom.ts'

const MIN_MS = 6000
const MS_PER_CHAR = 60
const MAX_MS = 20000
const FADE_MS = 500
/** A banner with a `live` check is re-checked this often while it shows (it leaves with the world; H11-NL-7). */
const LIVE_POLL_MS = 250
/** A unique notice's time on screen (UNIQUES §3.3). */
export const UNIQUE_NOTICE_MS = 8000
/** The unique pink (the target window's `var(--c-unique, #ff9cf0)`: the variable has no definition, the fallback shows). */
export const UNIQUE_PINK = '#ff9cf0'

export type NoticeKind = 'gm' | 'unique'

export interface NoticeOptions {
  /** The GM's name (GM notices). */
  from?: string
  /** 'gm' (default) or 'unique' (the pink name, its own title, 8 s). */
  kind?: NoticeKind
  /** The head's title; default `notice.title`. */
  title?: string
  /** A substring of the text drawn in the unique pink (the unique's name), or in `color`. */
  name?: string
  /** The title's and the name's colour instead of the unique pink (docs/RARITY.md §4.3: a seal's tier colour). */
  color?: string
  /** Time on screen; default by length (GM) or UNIQUE_NOTICE_MS (unique). */
  ms?: number
  /** Called once when the banner appears (the unique's cue plays with the banner, not when it is queued). */
  onShow?: () => void
  /**
   * Checked when the item's turn comes (false drops it unshown: a unique notice outside the world), and every
   * LIVE_POLL_MS while it shows (false takes it down: the player left the world).
   */
  live?: () => boolean
}

interface Item extends NoticeOptions {
  text: string
}

export class NoticeBanner {
  private readonly queue: Item[] = []
  private node: HTMLElement | null = null
  /** The banner fading out (H11-NL-3: the next one waits for the fade, so two never overlap). */
  private fading: HTMLElement | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private fadeTimer: ReturnType<typeof setTimeout> | undefined
  private liveTimer: ReturnType<typeof setInterval> | undefined

  /** Queues one notice. `opts` as a string is the GM's name (the GM notice's old signature). */
  show(text: string, opts?: string | NoticeOptions): void {
    const o = typeof opts === 'string' ? { from: opts } : opts ?? {}
    this.queue.push({ ...o, text })
    if (!this.node && !this.fading) this.next()
  }

  /** The kind of the banner on screen, null when none (tests, the lobby check). */
  get showing(): NoticeKind | null {
    return this.node ? ((this.node.dataset?.kind as NoticeKind | undefined) ?? 'gm') : null
  }

  /** Notices waiting behind the one on screen. */
  get pending(): number {
    return this.queue.length
  }

  private next(): void {
    let item = this.queue.shift()
    while (item && item.live && !item.live()) item = this.queue.shift()
    if (!item) return
    const unique = item.kind === 'unique'
    const title = el('span', 'notice-title', item.title ?? t('notice.title'))
    if (unique || item.color) title.style.color = item.color ?? UNIQUE_PINK
    const head = el('div', 'notice-head', title, item.from ? el('span', 'notice-from', t('notice.from', { from: item.from })) : null)
    const node = el('div', unique ? 'notice-banner unique' : 'notice-banner', head, textNode(item))
    node.setAttribute('role', 'alert')
    if (unique && node.dataset) node.dataset.kind = 'unique'
    node.addEventListener('click', () => this.dismiss(node))
    document.body.append(node)
    this.node = node
    requestAnimationFrame(() => node.classList.add('in'))
    const ms = item.ms ?? (unique ? UNIQUE_NOTICE_MS : Math.min(MAX_MS, Math.max(MIN_MS, item.text.length * MS_PER_CHAR)))
    this.timer = setTimeout(() => this.dismiss(node), ms)
    const live = item.live
    if (live) {
      this.liveTimer = setInterval(() => {
        if (!live()) this.dismiss(node)
      }, LIVE_POLL_MS)
    }
    try {
      item.onShow?.()
    } catch (err) {
      console.error('[notice] onShow failed', err)
    }
  }

  private dismiss(node: HTMLElement): void {
    if (this.node !== node) return
    clearTimeout(this.timer)
    clearInterval(this.liveTimer)
    this.node = null
    this.fading = node
    node.classList.remove('in')
    node.classList.add('out')
    this.fadeTimer = setTimeout(() => {
      node.remove()
      this.fading = null
      this.next()
    }, FADE_MS)
  }

  clear(): void {
    clearTimeout(this.timer)
    clearTimeout(this.fadeTimer)
    clearInterval(this.liveTimer)
    this.queue.length = 0
    this.node?.remove()
    this.fading?.remove()
    this.node = null
    this.fading = null
  }
}

/** The text line; a unique's name (its first occurrence) in the unique pink. Text nodes only: no markup from the wire. */
function textNode(item: Item): HTMLElement {
  const at = item.name ? item.text.indexOf(item.name) : -1
  if (!item.name || at < 0) return el('div', 'notice-text', item.text)
  const name = el('span', 'notice-name', item.name)
  name.style.color = item.color ?? UNIQUE_PINK
  return el('div', 'notice-text', item.text.slice(0, at), name, item.text.slice(at + item.name.length))
}

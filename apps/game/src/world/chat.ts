/**
 * Chat box, in the retail 2009 chat viewer's look (docs/UI.md §2.5, `ifchatviewer.txt`): `chat_tab` tabs with their
 * channel lamps on top (a lamp lights while its tab has unread lines), the whisper and hide-tabs buttons at the
 * top-left, the translucent `chat_window` box with the retail scroll bar on its left, and the bottom row with the
 * size button (`chat_zoom`: small / medium / big), the send-mode button (`chat_order_button`: All / Party) and the
 * input on the `window_all` input strip. Colours come from the kit tokens (--c-chat-*); lanes write no hex (D38).
 * M4 (decision D19): the channel → kind mapping is a string-keyed table (CHANNEL_KIND, pre-filled with guild and
 * stall), ChatKind has 'guild' | 'stall', and the 'guild' tab exists but stays hidden until setTabVisible('guild').
 *
 * Enter opens the input, Enter again sends, Esc closes, Up/Down recall the last lines sent. Lines starting
 * with '/' are sent as chat too: the server runs them as GM commands (and answers `gmResult`, shown here as 'gm'
 * lines), except the prefixes registered here first (whisper `/w name text`, reply `/r text`: docs/UX_GAPS.md C2;
 * party `#text` in wave 4, docs/WAVE_PLAN.md decision 30).
 *
 * Tabs filter the log (All / Whisper / Party / Guild / System, C3). The log keeps its place while you read back (C5):
 * new lines only scroll it when it was at the bottom, and a "new messages" button jumps down. Clicking a speaker's
 * name starts a whisper to them (C7). After 10 s without a new line, typing or the mouse over it, the box fades to
 * its text (C9); hovering a line shows the time it arrived.
 */
import { CHARACTER_NAME, MAX_CHAT_LENGTH, type ServerMessage } from '@sro/shared'
import { CHAT_SIZES, chatBoxHeight, chatLinesFor, hudAnchors, watchLayout, type ChatSize } from '../hud/hud-layout.ts'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, input } from '../ui/dom.ts'
import { iconButton } from '../ui/kit/button.ts'
import { kitArt } from '../ui/kit/host.ts'
import { textWidth } from '../ui/kit/measure.ts'
import { ScrollArea } from '../ui/kit/scroll.ts'
import { ensureUxWorldStyles } from './ux-world-style.ts'

const MAX_LINES = 120
export const HISTORY_SIZE = 30
/** Idle time before the chat box fades (C9). */
export const CHAT_FADE_MS = 10_000

/** "14:05" for a line's hover title (C9). */
export function chatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export type ChatKind = 'local' | 'system' | 'self' | 'error' | 'gm' | 'notice' | 'whisper-in' | 'whisper-out' | 'party' | 'guild' | 'stall'
/** What a tab filters on. */
export type ChatCategory = 'chat' | 'whisper' | 'party' | 'guild' | 'system'
export type ChatTab = 'all' | 'whisper' | 'party' | 'guild' | 'system'
export const CHAT_TABS: readonly ChatTab[] = ['all', 'whisper', 'party', 'guild', 'system']
/** Tabs that exist but stay hidden until a feature shows them (the guild lane: setTabVisible('guild', true)). */
export const HIDDEN_TABS: readonly ChatTab[] = ['guild']

/**
 * M4: server chat channel → line kind, string-keyed so a wave-8 channel needs no union change here. Channels not in
 * the table are local chat; 'whisper' is special (in or out by sender).
 */
export const CHANNEL_KIND: Record<string, ChatKind> = {
  system: 'system',
  party: 'party',
  guild: 'guild',
  stall: 'stall',
}

/** The label before a line of a table channel ("(Party) Mei: "). */
const CHANNEL_LABEL: Partial<Record<ChatKind, StringKey>> = {
  party: 'chat.partyFrom',
  guild: 'uh.chat.guildFrom',
  stall: 'uh.chat.stallFrom',
}

export function chatCategory(kind: ChatKind): ChatCategory {
  switch (kind) {
    case 'local':
    case 'self':
    case 'stall':
      return 'chat'
    case 'whisper-in':
    case 'whisper-out':
      return 'whisper'
    case 'party':
      return 'party'
    case 'guild':
      return 'guild'
    default:
      return 'system'
  }
}

/** The lamp of a tab (`ifchatviewer.txt` statics: all, party, guild; whisper uses the pink probation lamp). */
export const TAB_LAMPS: Record<ChatTab, string> = {
  all: 'chattingwnd/chat_lamp_all',
  whisper: 'chattingwnd/chat_lamp_probation',
  party: 'chattingwnd/chat_lamp_party',
  guild: 'chattingwnd/chat_lamp_guild',
  system: 'chattingwnd/chat_lamp_commerce',
}

/** The tab art that fits a label: `chat_tab` 52, `chat_re_tab` 72 or `chat_long_tab` 100 px (lamp + pads 18 px). */
export function tabSkin(labelPx: number): { key: string; w: number } {
  const need = labelPx + 18
  if (need <= 52) return { key: 'chattingwnd/chat_tab', w: 52 }
  if (need <= 72) return { key: 'chattingwnd/chat_re_tab', w: 72 }
  return { key: 'chattingwnd/chat_long_tab', w: 100 }
}

/** Send modes of the mode button: what an unprefixed line becomes. */
export type ChatMode = 'all' | 'party'
export const CHAT_MODES: readonly ChatMode[] = ['all', 'party']

/** An unprefixed line in party mode goes to the party ('#' prefix); commands and prefixed lines are unchanged. */
export function applyChatMode(mode: ChatMode, text: string): string {
  if (mode !== 'party' || text.startsWith('/') || text.startsWith('#') || text.startsWith('@')) return text
  return `#${text}`
}

/** A prefix handler gets the rest of the line after the prefix (trimmed). */
export type ChatPrefixHandler = (rest: string, line: string) => void

/**
 * Finds the registered prefix a typed line starts with (longest first, case-insensitive). A prefix ending in a
 * letter or digit is a command word and must be followed by a space or the end ('/w x', not '/who'); any other
 * prefix ('#') matches directly.
 */
export function matchPrefix(prefixes: Iterable<string>, text: string): { prefix: string; rest: string } | null {
  const lower = text.toLowerCase()
  const sorted = [...prefixes].sort((a, b) => b.length - a.length)
  for (const p of sorted) {
    const lp = p.toLowerCase()
    if (!lower.startsWith(lp)) continue
    const next = text.charAt(p.length)
    if (/[a-z0-9]$/i.test(p) && next !== '' && !/\s/.test(next)) continue
    return { prefix: p, rest: text.slice(p.length).trim() }
  }
  return null
}

export type WhisperParse = { ok: true; to: string; text: string } | { ok: false; error: 'usage' | 'bad_name' }

/** `/w name text` → name and text (the rest after the command word). */
export function parseWhisper(rest: string): WhisperParse {
  const m = /^(\S+)\s+([\s\S]*\S)\s*$/.exec(rest)
  if (!m) return { ok: false, error: 'usage' }
  if (!CHARACTER_NAME.test(m[1]!)) return { ok: false, error: 'bad_name' }
  return { ok: true, to: m[1]!, text: m[2]! }
}

/** Up/Down recall of sent lines, newest last, capped (C1). */
export class ChatHistory {
  private readonly lines: string[] = []
  /** lines.length = the empty draft (not browsing). */
  private cursor = 0
  private draft = ''

  constructor(private readonly size = HISTORY_SIZE) {}

  push(line: string): void {
    if (line && this.lines[this.lines.length - 1] !== line) this.lines.push(line)
    while (this.lines.length > this.size) this.lines.shift()
    this.cursor = this.lines.length
    this.draft = ''
  }

  /** Older line (Up); `current` is what the field holds, kept as the draft when browsing starts. */
  up(current: string): string {
    if (this.cursor === this.lines.length) this.draft = current
    if (this.cursor > 0) this.cursor--
    return this.lines[this.cursor] ?? current
  }

  /** Newer line (Down); past the newest returns the draft. */
  down(): string {
    if (this.cursor < this.lines.length) this.cursor++
    return this.cursor >= this.lines.length ? this.draft : this.lines[this.cursor]!
  }

  get length(): number {
    return this.lines.length
  }
}

/** Sent lines survive leaving and re-entering the world within one page session. */
const sessionHistory = new ChatHistory()

export interface ChatLineSpec {
  kind: ChatKind
  text: string
  /** Label before the text (already formatted, e.g. "From Mei: "). */
  label?: string
  /** Name a click on the label whispers. */
  name?: string
}

/** How a server chat line is shown (pure, for tests). `nameOf` resolves a speaker id when `from` is absent. */
export function chatLineFor(msg: Extract<ServerMessage, { t: 'chat' }>, selfId: number, nameOf: (id: number) => string | undefined): ChatLineSpec {
  const speaker = msg.from ?? (msg.fromId !== undefined ? nameOf(msg.fromId) : undefined) ?? t('world.unknownSpeaker')
  switch (msg.channel) {
    case 'system':
      return { kind: 'system', text: msg.text }
    case 'whisper':
      if (msg.fromId === selfId) {
        const to = msg.to ?? '?'
        return { kind: 'whisper-out', text: msg.text, label: t('chat.whisperTo', { name: to }), name: to }
      }
      return { kind: 'whisper-in', text: msg.text, label: t('chat.whisperFrom', { name: speaker }), name: speaker }
    default: {
      const kind = msg.channel ? CHANNEL_KIND[msg.channel as string] : undefined
      const label = kind ? CHANNEL_LABEL[kind] : undefined
      if (kind && label) return { kind, text: msg.text, label: t(label, { name: speaker }), name: speaker }
      return { kind: msg.fromId === selfId ? 'self' : 'local', text: msg.text, label: t('chat.from', { name: speaker }), name: msg.fromId === selfId ? undefined : speaker }
    }
  }
}

const SIZE_KEY = 'sro.chat.size'
const SIZES: readonly ChatSize[] = ['small', 'medium', 'big']
const TAB_FONT = "11px 'SRO Basic', Tahoma, Verdana, sans-serif"

export class ChatBox {
  readonly root: HTMLElement
  readonly field: HTMLInputElement
  private readonly log: HTMLElement
  private readonly scroll: ScrollArea
  private readonly box: HTMLElement
  private readonly tabsEl: HTMLElement
  private readonly tabButtons = new Map<ChatTab, HTMLButtonElement>()
  private readonly hiddenTabs = new Set<ChatTab>(HIDDEN_TABS)
  private readonly unread = new Set<ChatTab>()
  private readonly modeBtn: HTMLButtonElement
  private readonly newBtn: HTMLButtonElement
  private readonly prefixes = new Map<string, ChatPrefixHandler>()
  private readonly history = sessionHistory
  private tab: ChatTab = 'all'
  private mode: ChatMode = 'all'
  private size: ChatSize = 'medium'
  /** Lines the layout allows at most (the HUD shortens the chat on short screens). */
  private maxLines = Infinity
  private fadeTimer: ReturnType<typeof setTimeout> | null = null
  private hovering = false
  /** Last character who whispered us (for /r). */
  lastWhisperFrom: string | null = null
  /** Called after the size button changed the height. */
  onResize: (() => void) | null = null
  private viewport: [number, number] | null = null
  /** Stops the layout watcher (its resize listener holds this box, and through its callbacks the world screen). */
  private readonly stopLayout: () => void

  constructor(private readonly onSend: (text: string) => void, art: Art = kitArt()) {
    ensureUxWorldStyles()
    try {
      const saved = localStorage.getItem(SIZE_KEY) as ChatSize | null
      if (saved && SIZES.includes(saved)) this.size = saved
    } catch {
      // default size
    }
    // Log: a kit ScrollArea (the retail bar), moved to the box's left edge by CSS.
    this.scroll = new ScrollArea(art, { className: 'chat-scroll' })
    this.log = this.scroll.view
    this.log.classList.add('chat-log')
    const bg = (part: string) => {
      const d = el('div', `chat-bg ${part}`)
      if (art.has('chattingwnd/chat_window')) d.style.backgroundImage = art.cssUrl('chattingwnd/chat_window')
      else d.classList.add('no-art')
      return d
    }
    this.newBtn = el('button', 'chat-new', t('chat.newMessages'))
    this.newBtn.type = 'button'
    this.newBtn.hidden = true
    this.newBtn.addEventListener('click', () => this.scrollToEnd())
    this.box = el('div', 'chat-box', bg('up'), bg('mid'), bg('down'), this.scroll.root, this.newBtn)
    // Top row: whisper and hide-tabs buttons, then the tabs.
    const whisperBtn = iconButton(art, 'chattingwnd/chat_whisper_button', { title: t('uh.chat.whisperButton'), fallbackText: 'W', className: 'chat-btn chat-whisper-btn' }, () => {
      if (this.lastWhisperFrom) this.startWhisper(this.lastWhisperFrom)
      else {
        this.setField('/w ')
        this.focus()
      }
    })
    const hideBtn = iconButton(art, 'chattingwnd/chat_hide_button', { title: t('uh.chat.hideTabs'), fallbackText: '-', className: 'chat-btn chat-hide-btn' }, () => this.root.classList.toggle('tabs-hidden'))
    this.tabsEl = el('div', 'chat-tabs')
    for (const tab of CHAT_TABS) {
      const label = t(`chat.tab.${tab}` as StringKey)
      const skin = tabSkin(textWidth(label, TAB_FONT))
      const lamp = el('span', 'chat-lamp')
      if (art.has(TAB_LAMPS[tab])) lamp.style.backgroundImage = art.cssUrl(TAB_LAMPS[tab])
      const b = el('button', `chat-tab${tab === this.tab ? ' on' : ''}`, lamp, el('span', 'chat-tab-label', label)) as HTMLButtonElement
      b.type = 'button'
      b.dataset.tab = tab
      b.style.width = `${skin.w}px`
      if (art.has(skin.key)) b.style.backgroundImage = art.cssUrl(skin.key)
      else b.classList.add('no-art')
      b.hidden = this.hiddenTabs.has(tab)
      b.addEventListener('click', () => this.setTab(tab))
      this.tabButtons.set(tab, b)
      this.tabsEl.append(b)
    }
    const top = el('div', 'chat-top', whisperBtn, hideBtn, this.tabsEl)
    // Bottom row: size, send mode, input.
    const sizeBtn = iconButton(art, 'chattingwnd/chat_zoom', { title: t('uh.chat.size'), fallbackText: '↕', className: 'chat-btn chat-size-btn' }, () => this.cycleSize())
    this.modeBtn = iconButton(art, 'chattingwnd/chat_order_button', { title: t('uh.chat.mode.all'), fallbackText: '≡', className: 'chat-btn chat-mode-btn' }, () => this.cycleMode())
    this.field = input('chat-input', 'text', { maxlength: String(MAX_CHAT_LENGTH), placeholder: t('chat.placeholder'), 'aria-label': t('chat.aria') })
    const inputWrap = el('div', 'chat-input-wrap', this.field)
    if (art.has('ifcommon/wa_chat_input')) inputWrap.style.backgroundImage = art.cssUrl('ifcommon/wa_chat_input')
    else inputWrap.classList.add('no-art')
    const bottom = el('div', 'chat-bottom', sizeBtn, this.modeBtn, inputWrap)
    this.root = el('div', 'chat uh-chat', top, this.box, bottom)
    this.root.dataset.tab = this.tab
    this.root.dataset.mode = this.mode
    // Clicks on the chat never reach the world (click-to-move).
    this.root.addEventListener('pointerdown', ev => ev.stopPropagation())
    this.applySize()
    // Bottom-left above the underbar (beside it on very wide screens), shortened on short screens (hud-layout).
    this.stopLayout = watchLayout(this.root, (W, H) => {
      this.viewport = [W, H]
      this.place()
    })
    this.log.addEventListener('scroll', () => {
      if (this.atEnd()) this.newBtn.hidden = true
    })
    this.log.addEventListener('click', ev => {
      const name = (ev.target as HTMLElement | null)?.closest?.('[data-name]')?.getAttribute('data-name')
      if (name) this.startWhisper(name)
    })
    this.field.addEventListener('keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') {
        const text = this.field.value.trim()
        this.field.value = ''
        this.field.blur()
        if (text) this.submit(applyChatMode(this.mode, text.slice(0, MAX_CHAT_LENGTH)))
      } else if (ev.key === 'Escape') {
        this.field.value = ''
        this.field.blur()
      } else if (ev.key === 'ArrowUp' && this.history.length) {
        ev.preventDefault()
        this.setField(this.history.up(this.field.value))
      } else if (ev.key === 'ArrowDown' && this.history.length) {
        ev.preventDefault()
        this.setField(this.history.down())
      }
    })
    this.field.addEventListener('focus', () => {
      this.root.classList.add('typing')
      this.wake()
    })
    this.field.addEventListener('blur', () => {
      this.root.classList.remove('typing')
      this.wake()
    })
    this.root.addEventListener('pointerenter', () => {
      this.hovering = true
      this.wake()
    })
    this.root.addEventListener('pointerleave', () => {
      this.hovering = false
      this.wake()
    })
    this.wake()
  }

  /** Shows the box fully and restarts the fade timer (it does not fade while typing or hovered). */
  private wake(): void {
    this.root.classList.remove('idle')
    if (this.fadeTimer !== null) clearTimeout(this.fadeTimer)
    this.fadeTimer = null
    if (this.hovering || this.root.classList.contains('typing')) return
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null
      if (this.root.isConnected && !this.hovering && !this.root.classList.contains('typing')) this.root.classList.add('idle')
    }, CHAT_FADE_MS)
  }

  get typing(): boolean {
    return document.activeElement === this.field
  }

  focus(): void {
    this.field.focus()
  }

  /** The box size (small / medium / big: 4 / 8 / 14 lines), remembered per browser. */
  get chatSize(): ChatSize {
    return this.size
  }

  /** Lines the box shows now (the size, capped by the layout). */
  get lines(): number {
    return Math.min(CHAT_SIZES[this.size], this.maxLines)
  }

  /** The HUD layout caps the lines on short screens (hud-layout chatLinesFor). */
  setMaxLines(n: number): void {
    const v = Math.max(2, Math.floor(n))
    if (v === this.maxLines) return
    this.maxLines = v
    this.applySize()
  }

  private cycleSize(): void {
    this.size = SIZES[(SIZES.indexOf(this.size) + 1) % SIZES.length]!
    try {
      localStorage.setItem(SIZE_KEY, this.size)
    } catch {
      // not remembered
    }
    this.maxLines = Infinity
    this.place()
    this.applySize()
    this.onResize?.()
  }

  /** Applies the HUD layout's chat rect for the current size (native px of the zoomed layer). */
  private place(): void {
    if (!this.viewport) return
    const a = hudAnchors(this.viewport[0], this.viewport[1], { chatLines: CHAT_SIZES[this.size] })
    Object.assign(this.root.style, { left: `${a.chat.x}px`, top: `${a.chat.y}px`, width: `${a.chat.w}px` })
    this.root.classList.toggle('narrow', a.chat.w < 400)
    this.setMaxLines(chatLinesFor(a))
  }

  private applySize(): void {
    const stick = this.atEnd()
    this.box.style.height = `${chatBoxHeight(this.lines)}px`
    this.root.dataset.size = this.size
    this.scroll.refresh()
    if (stick) this.scrollToEnd()
  }

  private cycleMode(): void {
    this.mode = CHAT_MODES[(CHAT_MODES.indexOf(this.mode) + 1) % CHAT_MODES.length]!
    this.root.dataset.mode = this.mode
    this.modeBtn.title = t(`uh.chat.mode.${this.mode}` as StringKey)
    this.field.placeholder = this.mode === 'all' ? t('chat.placeholder') : t('uh.chat.partyPlaceholder')
  }

  /** M4: shows or hides a tab (the guild tab is hidden until the guild lane shows it). */
  setTabVisible(tab: ChatTab, on: boolean): void {
    if (on) this.hiddenTabs.delete(tab)
    else this.hiddenTabs.add(tab)
    const b = this.tabButtons.get(tab)
    if (b) b.hidden = !on
    if (!on && this.tab === tab) this.setTab('all')
  }

  isTabVisible(tab: ChatTab): boolean {
    return !this.hiddenTabs.has(tab)
  }

  /**
   * Claims lines that start with `prefix` before the default path (GM command or local chat). Returns the
   * unregister function. Registering the same prefix again replaces the handler.
   */
  registerPrefix(prefix: string, fn: ChatPrefixHandler): () => void {
    this.prefixes.set(prefix, fn)
    return () => {
      if (this.prefixes.get(prefix) === fn) this.prefixes.delete(prefix)
    }
  }

  /** Opens the input with `/w name ` typed (a click on a name, or the reply key). */
  startWhisper(name: string): void {
    this.setField(`/w ${name} `)
    this.focus()
  }

  /** A typed line: history, then a registered prefix, else the default sender. */
  submit(text: string): void {
    this.history.push(text)
    const hit = matchPrefix(this.prefixes.keys(), text)
    if (hit) {
      try {
        this.prefixes.get(hit.prefix)!(hit.rest, text)
      } catch (err) {
        console.error(`[chat] prefix ${hit.prefix} failed`, err)
      }
      return
    }
    this.onSend(text)
  }

  /** Shows a server chat line in its channel's colour; remembers who whispered last. */
  receive(msg: Extract<ServerMessage, { t: 'chat' }>, selfId: number, nameOf: (id: number) => string | undefined): void {
    const spec = chatLineFor(msg, selfId, nameOf)
    if (spec.kind === 'whisper-in' && spec.name) this.lastWhisperFrom = spec.name
    this.line(spec)
  }

  /** 'gm' = a GM command result, 'notice' = a server-wide announcement. Multi-line text keeps its lines. */
  add(kind: ChatKind, text: string, from?: string): void {
    this.line(from ? { kind, text, label: t('chat.from', { name: from }), name: kind === 'self' ? undefined : from } : { kind, text })
  }

  setTab(tab: ChatTab): void {
    this.tab = tab
    this.root.dataset.tab = tab
    this.unread.delete(tab)
    for (const [id, b] of this.tabButtons) {
      b.classList.toggle('on', id === tab)
      b.classList.toggle('unread', this.unread.has(id))
    }
    this.scroll.refresh()
    this.scrollToEnd()
  }

  private line(spec: ChatLineSpec): void {
    const stick = this.atEnd()
    const line = el('div', `chat-line ${spec.kind}`)
    const cat = chatCategory(spec.kind)
    line.dataset.cat = cat
    line.title = chatTime(new Date())
    if (spec.label) {
      const from = el('span', 'from', spec.label)
      if (spec.name && CHARACTER_NAME.test(spec.name)) {
        from.dataset.name = spec.name
        from.title = t('chat.whisperHint', { name: spec.name })
      }
      line.append(from)
    }
    line.append(spec.text)
    this.log.append(line)
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild?.remove()
    // The channel's lamp lights on its tab until that tab is opened.
    const tab = cat === 'chat' ? null : (cat as ChatTab)
    if (tab && tab !== this.tab) {
      this.unread.add(tab)
      this.tabButtons.get(tab)?.classList.add('unread')
    }
    if (stick) this.scrollToEnd()
    else if (this.visibleIn(line)) this.newBtn.hidden = false
    if (this.visibleIn(line)) this.wake()
  }

  private visibleIn(line: HTMLElement): boolean {
    return this.tab === 'all' || line.dataset.cat === this.tab
  }

  private atEnd(): boolean {
    return this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 6
  }

  private scrollToEnd(): void {
    this.log.scrollTop = this.log.scrollHeight
    this.newBtn.hidden = true
  }

  private setField(text: string): void {
    this.field.value = text
    const end = text.length
    this.field.setSelectionRange?.(end, end)
  }

  /** The owner is done with the box (the world screen's dispose): window listeners and timers go (W9F LEAK-1). */
  dispose(): void {
    this.stopLayout()
    if (this.fadeTimer !== null) clearTimeout(this.fadeTimer)
    this.fadeTimer = null
  }
}

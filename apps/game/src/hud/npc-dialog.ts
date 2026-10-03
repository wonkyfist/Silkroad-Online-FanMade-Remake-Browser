/**
 * The NPC dialog window (docs/SHOPS.md §3.2, docs/UI.md §4.6): retail `mframe` 386×451 with the NPC's name as the
 * title and the talk box `npc_conversation_window_` at (11,48,364,391) (`if_npcwindow.txt`) on `com_bg_tile_d`, the
 * text at (23,23) and the scroll bar at (336,27) (`if_npctalk.txt`): the greeting (NpcDef.greeting, or the generic
 * line) and one underlined option line per service the server offered in `npcDialog`, then "End conversation".
 * Choosing an option calls `onShop` / `onStorage` / `onQuest` / a registered service handler / `onEnd`.
 *
 * Quests (docs/WAVE_PLAN.md decision 1): the server lists `'quest'` when the NPC has quest topics (wave 4), and the
 * option calls `onQuest(ctx)`. Wave 4's quest dialog registers its handler with `setNpcQuestHandler` and draws its
 * text and choices in this same window through `setContent`, returning with `showServices`.
 * Wave-8 mount point M7 (decision D14): `registerNpcService(service, fn)` adds an option for a service the server
 * lists (e.g. `'guild'`); `'repair'` is a hidden service (the shop footer carries the repair buttons, D13).
 */
import type { NpcService } from '@sro/shared'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { Frame } from '../ui/kit/frame.ts'
import { ScrollArea } from '../ui/kit/scroll.ts'
import { ensureNpcStyles, NpcWindow } from './npc-ui.ts'
import { dialogOptions, npcServiceHandler, OPTION_KEY, registerNpcServiceHandler } from './shop-logic.ts'

/** What an option handler knows about the conversation. */
export interface NpcTalkContext {
  /** NPC entity id. */
  npc: number
  /** NPC identity code from `npcDialog.code`. */
  code: string
  name: string
  services: readonly NpcService[]
  /** The window, so a handler (wave 4 quests) can draw its own text and choices in it. */
  dialog: NpcDialogWindow
}

/** One clickable line under the text. `end` draws it as the closing line. */
export interface NpcDialogOption {
  label: string
  run(): void
  end?: boolean
}

type QuestHandler = (ctx: NpcTalkContext) => void
/** The services of the conversation shown last (the shop footer's M6 buttons read them). */
let talkServices: readonly string[] = []

/** The services the NPC of the current (or last) conversation offers. */
export function npcTalkServices(): readonly string[] {
  return talkServices
}
let questHandler: QuestHandler | null = null

/** Wave 4: the quest dialog's entry point for the `'quest'` option. Returns an unregister function. */
export function setNpcQuestHandler(fn: QuestHandler): () => void {
  questHandler = fn
  return () => {
    if (questHandler === fn) questHandler = null
  }
}

/** The registered quest handler (null until wave 4 sets one). */
export function npcQuestHandler(): QuestHandler | null {
  return questHandler
}

/**
 * M7: the option for a service the server lists in `npcDialog.services` (after shop, storage and quest, in the
 * server's order). `label` defaults to `npc.option.<service>`. Returns an unregister function.
 */
export function registerNpcService(service: string, fn: (ctx: NpcTalkContext) => void, label?: StringKey): () => void {
  return registerNpcServiceHandler(service, fn as (ctx: unknown) => void, label)
}

export const NPC_DIALOG_W = 386
export const NPC_DIALOG_H = 451
/** The talk box (window px) and its text area (talk-box px). */
const TALK: [number, number, number, number] = [11, 48, 364, 391]

export class NpcDialogWindow extends NpcWindow {
  private readonly text: HTMLElement
  private readonly options: HTMLElement
  private readonly scroll: ScrollArea
  private ctx: NpcTalkContext | null = null
  private greeting = ''
  /** true while the window is being hidden by the feature (not closed by the player). */
  private quiet = false
  onShop: ((ctx: NpcTalkContext) => void) | null = null
  onStorage: ((ctx: NpcTalkContext) => void) | null = null
  onQuest: ((ctx: NpcTalkContext) => void) | null = null
  /** The player ended the conversation (the option, the close button). */
  onEnd: (() => void) | null = null

  constructor(art: Art, parent: HTMLElement) {
    ensureNpcStyles()
    super(art, parent, { id: 'npc-dialog', title: '', width: NPC_DIALOG_W, height: NPC_DIALOG_H, at: [0.04, 0.3] })
    const talk = new Frame(art, 'talk', { className: 'npc-talk', inset: [0, 0, 0, 0] })
    this.at(talk.root, TALK)
    talk.root.style.position = 'absolute'
    this.text = el('div', 'npc-greeting')
    this.options = el('div', 'npc-options')
    if (art.has('ifcommon/com_diamond')) this.options.style.setProperty('--npc-diamond', art.cssUrl('ifcommon/com_diamond'))
    this.scroll = new ScrollArea(art, { w: 331, h: 343, className: 'npc-talk-scroll' })
    Object.assign(this.scroll.root.style, { position: 'absolute', left: '21px', top: '24px' })
    this.scroll.view.append(this.text, this.options)
    talk.body.append(this.scroll.root)
    this.body.append(talk.root)
    this.onClose = () => {
      if (!this.quiet) this.onEnd?.()
    }
  }

  /** The conversation shown (null when hidden). */
  get talk(): NpcTalkContext | null {
    return this.ctx
  }

  /** Opens the dialog of one NPC: greeting (null = the generic line) and its service options. */
  show(talk: Omit<NpcTalkContext, 'dialog'>, greeting: string | null): void {
    this.ctx = { ...talk, dialog: this }
    talkServices = [...talk.services]
    this.greeting = greeting ?? t('npc.greeting.default')
    this.setTitle(talk.name)
    this.showServices()
    this.open()
    this.raise()
  }

  /** Back to the greeting and the service options. */
  showServices(): void {
    const ctx = this.ctx
    if (!ctx) return
    const lines: NpcDialogOption[] = dialogOptions(ctx.services).map(s => ({ label: t(OPTION_KEY[s] ?? (`npc.option.${s}` as StringKey)), run: () => this.choose(s) }))
    lines.push({ label: t('npc.option.end'), run: () => this.close(), end: true })
    this.setContent(this.greeting, lines)
  }

  /** Replaces the text and the option lines (wave 4 quest pages; `showServices` restores the menu). */
  setContent(text: string, options: readonly NpcDialogOption[]): void {
    this.text.textContent = text
    this.scroll.view.scrollTop = 0
    this.options.replaceChildren(
      ...options.map(o => {
        const b = el('button', `npc-option${o.end ? ' end' : ''}`, o.label)
        b.type = 'button'
        b.addEventListener('click', () => {
          try {
            o.run()
          } catch (err) {
            console.error('[npc] dialog option failed', err)
          }
        })
        return b
      }),
    )
  }

  /** Hides without ending the conversation (the shop or storage took over, or the server closed it). */
  hide(): void {
    this.quiet = true
    try {
      this.close()
    } finally {
      this.quiet = false
    }
  }

  /** Forgets the conversation and hides. */
  reset(): void {
    this.hide()
    this.ctx = null
  }

  override dispose(): void {
    this.scroll.dispose()
    super.dispose()
  }

  private choose(s: string): void {
    const ctx = this.ctx
    if (!ctx) return
    if (s === 'shop') this.onShop?.(ctx)
    else if (s === 'storage') this.onStorage?.(ctx)
    else if (s === 'quest') this.onQuest?.(ctx)
    else npcServiceHandler(s)?.(ctx)
  }
}

/**
 * The client side of one NPC conversation (docs/SHOPS.md §3): which NPC the dialog belongs to, which of its panels
 * is showing (the dialog itself, the shop or the storage), and the character's buyback list. The server decides
 * when a conversation opens (`npcDialog`) and may end it on its own (`npcDialogClose`: walked away, died, warped);
 * the windows follow this state. No DOM (test/shop.test.ts).
 */
import type { BuybackEntry, ClientMessage, NpcService, ServerMessage } from '@sro/shared'
import { intent } from './intents.ts'

export type NpcPanel = 'dialog' | 'shop' | 'storage'

/** The open conversation, as the server described it. */
export interface NpcTalk {
  npc: number
  code: string
  services: NpcService[]
}

type Msg<K extends ServerMessage['t']> = Extract<ServerMessage, { t: K }>

export class NpcConversation {
  current: NpcTalk | null = null
  panel: NpcPanel | null = null
  /** The character's recent sales, oldest first (the server sends the whole list). */
  buyback: BuybackEntry[] = []

  get open(): boolean {
    return this.current !== null
  }

  /** `npcDialog`: a new conversation, which replaces any other; it starts on the dialog panel. */
  opened(msg: Msg<'npcDialog'>): NpcTalk {
    this.current = { npc: msg.npc, code: msg.code, services: [...msg.services] }
    this.panel = 'dialog'
    return this.current
  }

  /** `npcDialogClose`: true when it ended the open conversation (a close for an older NPC is ignored). */
  serverClosed(msg: Msg<'npcDialogClose'>): boolean {
    if (!this.current || this.current.npc !== msg.npc) return false
    this.reset()
    return true
  }

  /** The player ends the conversation: the `npcClose` to send, or null when nothing was open. */
  close(): ClientMessage | null {
    if (!this.current) return null
    this.reset()
    return intent.npcClose()
  }

  /** Switches to a service panel the NPC offers (false when it does not, or nothing is open). */
  show(panel: NpcPanel): boolean {
    if (!this.current) return false
    if (panel !== 'dialog' && !this.current.services.includes(panel)) return false
    this.panel = panel
    return true
  }

  /** Whether the conversation with `npc` is open. */
  isWith(npc: number): boolean {
    return this.current?.npc === npc
  }

  private reset(): void {
    this.current = null
    this.panel = null
  }
}

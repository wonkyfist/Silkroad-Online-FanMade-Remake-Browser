/**
 * Every client -> server message the world code sends is built here, so the builders can be checked against
 * the shared validator (test/world.test.ts). Intents only: the server decides every outcome.
 */
import { validateClientMessage, type ChatSendChannel, type ClientMessage } from '@sro/shared'

const MAX_COORD = 1_000_000

function coord(v: number): number {
  const c = Math.max(-MAX_COORD, Math.min(MAX_COORD, Number.isFinite(v) ? v : 0))
  return Math.round(c * 100) / 100
}

function id(v: number): number {
  return Math.max(0, Math.trunc(v))
}

export const intents = {
  moveTo: (x: number, z: number): ClientMessage => ({ t: 'moveTo', x: coord(x), z: coord(z) }),
  attack: (target: number): ClientMessage => ({ t: 'attack', target: id(target) }),
  pickup: (item: number): ClientMessage => ({ t: 'pickup', id: id(item) }),
  stopAction: (): ClientMessage => ({ t: 'stopAction' }),
  respawn: (): ClientMessage => ({ t: 'respawn' }),
  /**
   * `to`: a whisper to that character (it wins over `channel`, which a whisper cannot carry). A malformed `to` is
   * kept, so the validator refuses the frame rather than the whisper going out as local chat.
   */
  chat: (text: string, to?: string, channel?: ChatSendChannel): ClientMessage => {
    const m: Extract<ClientMessage, { t: 'chat' }> = { t: 'chat', text }
    if (to !== undefined) m.to = to
    else if (channel !== undefined) m.channel = channel
    return m
  },
  /** Talk to an NPC: the server walks us there and answers npcDialog (docs/SHOPS.md §3). */
  npcTalk: (npc: number): ClientMessage => ({ t: 'npcTalk', npc: id(npc) }),
  enterWorld: (character: number): ClientMessage => ({ t: 'enterWorld', id: character }),
  leaveWorld: (): ClientMessage => ({ t: 'leaveWorld' }),
  /** Wave 10 (docs/MOVEMENT.md §4, jump only): Space; the server answers with `jump` to every viewer (the jumper too). */
  jump: (): ClientMessage => ({ t: 'jump' }),
}

/** Dev guard: true when the shared validator accepts `msg` (logs why not otherwise). */
export function checkIntent(msg: ClientMessage): boolean {
  const r = validateClientMessage(msg)
  if (!r.ok) console.warn(`[world] refusing to send an invalid ${msg.t}: ${r.error}`)
  return r.ok
}

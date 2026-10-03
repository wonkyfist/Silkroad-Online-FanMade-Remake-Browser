import type { ClientMessage } from '@sro/shared'
import type { Connection } from './connection.ts'

/**
 * Chat routing beyond local chat (docs/WAVE_PLAN.md decisions 28-29; whisper: lane UX-B, docs/UX_GAPS.md §5.1;
 * party: lane PT-S in wave 4). connection.ts calls routeChat after the empty-line check and before the slash-command
 * branch, with the cleaned text. It returns true when it took the line (and answered it); false leaves the line to
 * the default path (slash command or local chat). A routed line pays the chat budget through `conn.takeChat()`.
 *
 * Whisper: `{t:'chat', text, to}` goes to the online character named `to` (case-insensitive) and is echoed to the
 * sender, both as `{channel:'whisper', fromId, from, to, text}`. A whisper is never a command, even when it starts
 * with '/'. Offline, or an invisible GM seen by a non-staff sender → `error not_found`; yourself → `bad_request`.
 * Refusals answer through `error` with `re: 'chat'`, like the rate limit (chat is not a GameplayRequest).
 */
export function routeChat(conn: Connection, msg: Extract<ClientMessage, { t: 'chat' }>, text: string): boolean {
  if (msg.channel === 'party') {
    // Party chat (docs/QUESTS.md §4.4; lane PT-S): to the online members, paying the chat budget.
    const self = conn.player
    if (!self) conn.error('not_in_world', 'not in the world', 'chat')
    else if (!conn.takeChat()) conn.error('rate_limited', 'you are chatting too fast', 'chat')
    else if (!conn.game.gameplay.party.chat(self, text)) conn.error('bad_request', 'You are not in a party.', 'chat')
    return true
  }
  if (msg.channel === 'guild') {
    // Guild chat (docs/SYSTEMS_SOCIAL.md §5.3; lane GU-S): to the guild's online members, paying the chat budget.
    const self = conn.player
    if (!self) conn.error('not_in_world', 'not in the world', 'chat')
    else if (!conn.takeChat()) conn.error('rate_limited', 'you are chatting too fast', 'chat')
    else if (!conn.game.gameplay.guilds.chat(self, text)) conn.error('bad_request', 'You are not in a guild.', 'chat')
    return true
  }
  if (msg.channel === 'stall') {
    // Stall chat (docs/SYSTEMS_SOCIAL.md §4.1 P2; lane ST-S): to the owner and visitors of the sender's stall.
    const self = conn.player
    if (!self) conn.error('not_in_world', 'not in the world', 'chat')
    else if (!conn.takeChat()) conn.error('rate_limited', 'you are chatting too fast', 'chat')
    else if (!conn.game.gameplay.stalls.chat(self, text)) conn.error('bad_request', 'You have no stall open.', 'chat')
    return true
  }
  if (msg.to === undefined) return false
  whisper(conn, msg.to, text)
  return true
}

function whisper(conn: Connection, to: string, text: string): void {
  const self = conn.player
  if (!self) return conn.error('not_in_world', 'not in the world', 'chat')
  if (!conn.takeChat()) return conn.error('rate_limited', 'you are chatting too fast', 'chat')
  if (to.toLowerCase() === self.name.toLowerCase()) return conn.error('bad_request', 'You cannot whisper yourself.', 'chat')
  const world = conn.game.world
  const target = world.byName(to)
  if (!target || !world.canSee(self, target)) return conn.error('not_found', `${to} is not online.`, 'chat')
  const line = { t: 'chat', channel: 'whisper', fromId: self.id, from: self.name, to: target.name, text } as const
  target.send(line)
  self.send(line)
}

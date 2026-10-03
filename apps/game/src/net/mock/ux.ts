/**
 * Mock support of lane UX-B (whispers, GM tag) for ?mock=1 (docs/WAVE_PLAN.md §3.3). Optional and first to cut: the
 * real-server e2e tests are the truth. Only that lane edits this file. Import MockServer types with `import type`.
 *
 * Whispers follow apps/server/src/chat.ts: `to` goes to that character only (echoed to the sender), never a GM
 * command; bots answer with a canned line. The party channel answers "You are not in a party." (wave 3). With
 * ?mock=1&gm=1 the own character carries the [GM] tag.
 */
import { isStaff } from '@sro/shared'
import type { MockExtension } from '../mock.ts'

const BOT_REPLY_MS = 1200

export const uxMock: MockExtension = {
  handle(ctx, conn, msg) {
    if (msg.t !== 'chat' || (msg.to === undefined && msg.channel !== 'party')) return false
    const self = ctx.selfOf(conn)
    if (!self) return false
    const error = (code: 'bad_request' | 'not_found' | 'rate_limited', message: string) => ctx.send(conn, { t: 'error', code, message, re: 'chat' })
    if (msg.channel === 'party' && msg.to === undefined) {
      error('bad_request', 'You are not in a party.')
      return true
    }
    const text = msg.text.trim()
    const to = msg.to!
    if (!text) return true
    if (to.toLowerCase() === self.state.name.toLowerCase()) {
      error('bad_request', 'You cannot whisper yourself.')
      return true
    }
    let target: typeof self | null = null
    for (const e of ctx.entities()) if (e.state.kind === 'player' && e.state.name.toLowerCase() === to.toLowerCase()) target = e
    if (!target) {
      error('not_found', `${to} is not online.`)
      return true
    }
    const line = { t: 'chat', channel: 'whisper', fromId: self.state.id, from: self.state.name, to: target.state.name, text } as const
    ctx.send(conn, line)
    if (target.bot) {
      const bot = target
      setTimeout(() => {
        if (ctx.selfOf(conn) !== self) return
        ctx.send(conn, { t: 'chat', channel: 'whisper', fromId: bot.state.id, from: bot.state.name, to: self.state.name, text: `Hi ${self.state.name}! I'm only a bot, but have fun in Jangan.` })
      }, BOT_REPLY_MS)
    }
    return true
  },

  enter(ctx, conn) {
    const self = ctx.selfOf(conn)
    if (self && isStaff(conn.role ?? 'player')) {
      self.state.gm = true
      ctx.send(conn, { t: 'entityUpdate', id: self.state.id, gm: true })
    }
  },
}

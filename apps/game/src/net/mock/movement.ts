/**
 * Mock support of the jump (docs/MOVEMENT.md §4.2, docs/WAVE_PLAN6.md §3.2, lane W10-P) for ?mock=1, so the client
 * lane (MV-C) can try Space before the server lane (MV-P) lands. It mirrors apps/server/src/movement.ts closely
 * enough for the client's prediction, echo and cooldown gate:
 * - `jump` answers one actionResult and, when accepted, tells every viewer (the jumper too) `jump {id, at}`;
 * - refused `dead`, `mounted` (riding a horse), `stalling` (the owner of a stall), `busy` while reading a return
 *   scroll, and `cooldown` within JUMP_COOLDOWN_MS of the last accepted jump (JUMP_COOLDOWN_SLACK_MS early is fine);
 * - allowed while moving, in combat and in a trade; a sitter stands up first. The position and the move never change.
 * Not simulated: `cant_act` (the mock has no crowd control on players) and `busy` during a skill action (the skills
 * mock keeps that state to itself). Optional and first to cut: the real server is the truth.
 */
import { JUMP_COOLDOWN_KEY, JUMP_COOLDOWN_MS, JUMP_COOLDOWN_SLACK_MS } from '@sro/shared'
import type { MockExtension } from '../mock.ts'
import { standUp } from './fx.ts'

export const movementMock: MockExtension = {
  handle(ctx, conn, msg): boolean {
    if (msg.t !== 'jump') return false
    const self = ctx.selfOf(conn)
    const p = self?.player
    if (!self || !p) return false
    const now = ctx.now()
    const no = (reason: Parameters<typeof ctx.result>[3], message?: string) => {
      ctx.result(conn, 'jump', false, reason, message)
      return true
    }
    if (p.prog.dead) return no('dead')
    if (self.state.mount !== undefined) return no('mounted')
    if (self.state.stall !== undefined) return no('stalling')
    if (p.casting) return no('busy', 'casting')
    const readyAt = p.cooldowns.get(JUMP_COOLDOWN_KEY) ?? 0
    if (now < readyAt - JUMP_COOLDOWN_SLACK_MS) return no('cooldown')
    p.cooldowns.set(JUMP_COOLDOWN_KEY, now + JUMP_COOLDOWN_MS)
    ctx.result(conn, 'jump', true)
    standUp(ctx, self.state.id)
    ctx.broadcast({ t: 'jump', id: self.state.id, at: now })
    return true
  },
}

/**
 * Mock support of lane FX-C2 (posture and emotes, docs/EFFECTS.md §4 P4) for ?mock=1, mirroring apps/server/src/posture.ts
 * closely enough to try N / `/sitdown` / the emote commands offline:
 * - `sit {on: true}` answers ok and tells every viewer `entityUpdate {posture: 'sit'}`; refused with `busy` while
 *   moving, acting (auto-attack or a pickup walk) or reading a return scroll, and with `in_combat` within 5 s of the
 *   last hit (as the server's SIT_COMBAT_MS / SIT_COMBAT_REASON, D30); `dead` when dead. Sitting twice and standing while standing are `ok`.
 * - moving, stopAction, an attack, a skill, a pickup or an NPC talk stands a sitter up (before the request's effects),
 *   and so does a hit dealt or taken while seated (`tick`).
 * - `emote` stands the sender up and plays for everyone; refused with `busy` while moving or reading a scroll.
 * Sitting is per mock server (a WeakMap on its context), never saved: entering the world stands you up.
 * Optional and first to cut: the real server is the truth. I7B extended FX-C2's first version.
 */
import type { ClientMessage } from '@sro/shared'
import { sampleMove } from '../clock.ts'
import type { MockContext, MockConn, MockEntity, MockExtension } from '../mock.ts'

/** Requests that stand a sitter up (posture.ts STAND_UP_REQUESTS plus moveTo and stopAction). */
const STANDS_UP: ReadonlySet<ClientMessage['t']> = new Set(['moveTo', 'stopAction', 'attack', 'useSkill', 'pickup', 'npcTalk'])
/** apps/server/src/posture.ts SIT_COMBAT_MS. */
const SIT_COMBAT_MS = 5000

/** Sitting players of each mock server: entity id -> mock server ms they sat down. */
const sittingBy = new WeakMap<MockContext, Map<number, number>>()

function sittingOf(ctx: MockContext): Map<number, number> {
  let m = sittingBy.get(ctx)
  if (!m) sittingBy.set(ctx, (m = new Map()))
  return m
}

/** Stands entity `id` up when it sits (tells every viewer); used by net/mock/movement.ts for an accepted jump. */
export function standUp(ctx: MockContext, id: number): void {
  if (!sittingOf(ctx).delete(id)) return
  ctx.broadcast({ t: 'entityUpdate', id, posture: 'stand' })
}

function moving(ctx: MockContext, e: MockEntity): boolean {
  const m = e.state.move
  return !!m && !sampleMove(m, ctx.now()).arrived
}

/** Why `e` may not sit now (the server's reasons), or null. */
function sitProblem(ctx: MockContext, e: MockEntity): string | null {
  const p = e.player
  if (moving(ctx, e)) return 'moving'
  if (p?.action) return 'busy'
  if (p?.casting) return 'casting'
  if (p && ctx.now() - p.lastCombat < SIT_COMBAT_MS) return 'in combat'
  return null
}

export const fxMock: MockExtension = {
  handle(ctx: MockContext, conn: MockConn, msg: ClientMessage): boolean {
    const self = ctx.selfOf(conn)
    if (!self) return false
    const id = self.state.id
    if (STANDS_UP.has(msg.t)) {
      standUp(ctx, id)
      return false
    }
    if (msg.t === 'sit') {
      if (self.player?.prog.dead) {
        ctx.result(conn, 'sit', false, 'dead')
        return true
      }
      const sitting = sittingOf(ctx)
      if (!msg.on) {
        ctx.result(conn, 'sit', true)
        standUp(ctx, id)
        return true
      }
      if (sitting.has(id)) {
        ctx.result(conn, 'sit', true)
        return true
      }
      const why = sitProblem(ctx, self)
      if (why) {
        ctx.result(conn, 'sit', false, why === 'in combat' ? 'in_combat' : 'busy', why)
        return true
      }
      ctx.result(conn, 'sit', true)
      sitting.set(id, ctx.now())
      ctx.broadcast({ t: 'entityUpdate', id, posture: 'sit' })
      return true
    }
    if (msg.t === 'emote') {
      if (self.player?.prog.dead) {
        ctx.result(conn, 'emote', false, 'dead')
        return true
      }
      if (moving(ctx, self)) {
        ctx.result(conn, 'emote', false, 'busy', 'moving')
        return true
      }
      if (self.player?.casting) {
        ctx.result(conn, 'emote', false, 'busy', 'casting')
        return true
      }
      ctx.result(conn, 'emote', true)
      standUp(ctx, id)
      ctx.broadcast({ t: 'emote', id, emote: msg.emote })
      return true
    }
    return false
  },

  /** A hit dealt or taken since sitting down, a started move or action, or death stands the sitter up. */
  tick(ctx, _now) {
    const sitting = sittingBy.get(ctx)
    if (!sitting?.size) return
    for (const [id, since] of [...sitting]) {
      const e = ctx.entity(id)
      const p = e?.player
      if (!e || !p) {
        sitting.delete(id)
        continue
      }
      if (p.prog.dead || p.action || p.casting || moving(ctx, e) || p.lastCombat >= since) standUp(ctx, id)
    }
  },

  enter(ctx, conn) {
    const self = ctx.selfOf(conn)
    if (self) sittingOf(ctx).delete(self.state.id)
  },
}

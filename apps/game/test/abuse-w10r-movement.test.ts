/**
 * Adversarial hunt, wave 10r (lens "movement"): the jump's own-echo window under latency (docs/MOVEMENT.md §5, §6.2,
 * §6.3).
 *
 * The own client predicts its jump on the key press and swallows the server's echo only when it arrives within
 * JUMP_ECHO_WINDOW_MS (600 ms, measured on the local clock: a ROUND trip). A viewer, the jumper's own view included,
 * drops a `jump` only when it arrives more than JUMP_LATE_DROP_MS (600 ms) after `at` (a ONE-WAY delay). So for a round
 * trip between 600 and 1200 ms the echo is neither swallowed nor dropped: the jumper sees its own jump play twice (the
 * clip restarts in the landing). A friend on a congested Wi-Fi or a phone hotspot hits that window.
 * Fixed (MV-1): the client matches the echo to its request (JumpEcho is a FIFO of the presses in flight).
 */
import { JUMP_ECHO_WINDOW_MS, JUMP_LATE_DROP_MS, type ServerMessage } from '@sro/shared'
import { describe, expect, it, vi } from 'vitest'
import { KeyMap } from '../src/hud/keys.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { movementFeature } from '../src/world/features/movement.ts'

function harness() {
  const keys = new KeyMap()
  const local = { t: 10_000 }
  /** The server clock as the client estimates it (in sync with the local clock here: no offset, no drift). */
  const server = { t: 10_000 }
  // The real EntityView.jump's late drop (entities.ts): plays unless the jump arrives more than JUMP_LATE_DROP_MS late.
  const self = {
    id: 1,
    kind: 'player',
    dead: false,
    idle: 'stand',
    state: {},
    actor: { skillActing: false, clipGroup: 'default', ensureMovementClips: async () => true },
    jump: vi.fn((at: number, now: number) => now - at <= JUMP_LATE_DROP_MS),
  }
  const ctx = {
    keys,
    hud: { toast() {} },
    send: () => true,
    selfId: () => 1,
    view: (id: number) => (id === 1 ? self : undefined),
    views: () => [self][Symbol.iterator](),
    serverNow: () => server.t,
    addAttachment: () => () => {},
  } as unknown as WorldFeatureContext
  const feature = movementFeature(ctx, () => local.t)
  const space = () => keys.handle({ key: ' ', type: 'keydown', repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: null, preventDefault() {} })
  const msg = (m: ServerMessage) => feature.onMessage?.(m)
  const advance = (ms: number) => {
    local.t += ms
    server.t += ms
  }
  return { self, space, msg, advance, server }
}

describe('abuse w10r movement: the own jump under latency', () => {
  for (const rttMs of [650, 800, 1000, 1150]) {
    it(`a ${rttMs} ms round trip plays the own jump once, not twice`, () => {
      const h = harness()
      const pressedAt = h.server.t
      h.space()
      expect(h.self.jump).toHaveBeenCalledTimes(1) // the prediction
      // The server accepts it half a round trip later and stamps `at` then; the echo lands a full round trip after
      // the press.
      h.advance(rttMs)
      h.msg({ t: 'jump', id: 1, at: pressedAt + rttMs / 2 })
      expect(rttMs).toBeGreaterThanOrEqual(JUMP_ECHO_WINDOW_MS)
      expect(rttMs / 2).toBeLessThanOrEqual(JUMP_LATE_DROP_MS)
      // Played once (the prediction). Before MV-1 the echo is neither swallowed (round trip >= the echo window) nor dropped
      // (one way <= the late drop), so the clip restarts: 2 calls that both played.
      expect(h.self.jump.mock.results.filter(r => r.value === true)).toHaveLength(1)
    })
  }
})

import type { ServerMessage } from '@sro/shared'
import type { Encoded } from '../encode.ts'
import type { Player } from '../world.ts'

/**
 * Commit-then-ack (docs/SERVER_ARCHITECTURE.md §3.8, phase P2): while a transfer's database entry is on its way to the
 * file, everything the server sends to its parties waits, in order, and goes out when the writer has committed it. The
 * player's requests keep running against the (in-memory) state; only their answers wait, so the client never sees a
 * trade's result — or anything after it — before the trade is on disk. Holds nest: the stream flows again when the last
 * one is released.
 */

interface Held {
  send: Player['send']
  queue: [ServerMessage, Encoded | undefined][]
  n: number
}

const held = new WeakMap<Player, Held>()

export const holdStats = { holds: 0, queued: 0 }

/** Starts holding `p`'s outbound messages; the returned function releases this hold (idempotent). */
export function holdOutbound(p: Player): () => void {
  let h = held.get(p)
  if (!h) {
    const queue: Held['queue'] = []
    h = { send: p.send, queue, n: 0 }
    held.set(p, h)
    p.send = (m, enc) => {
      queue.push([m, enc])
      holdStats.queued++
    }
  }
  h.n++
  holdStats.holds++
  const hh = h
  let done = false
  return () => {
    if (done) return
    done = true
    if (--hh.n > 0) return
    if (held.get(p) === hh) held.delete(p)
    p.send = hh.send
    for (const [m, enc] of hh.queue) hh.send(m, enc)
    hh.queue.length = 0
  }
}

/** Whether `p`'s outbound is held right now. */
export function isHeld(p: Player): boolean {
  return held.has(p)
}

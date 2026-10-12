import type { ServerMessage } from '@sro/shared'

/**
 * Encode once (docs/SERVER_ARCHITECTURE.md F2, phase P0): a message sent to many players is turned into JSON and UTF-8
 * bytes once, and the same Buffer is written to every recipient's socket (it used to be stringified once per recipient,
 * and the string copied again into each socket's writev). World's broadcasts hand an Encoded next to the message
 * (Player.send's second argument); a Connection uses it only when it gets the very message object it was made from, so
 * a send wrapper that rewrites the message never sends a stale encoding. Test players ignore it.
 *
 * The message must not change after it is handed out (broadcasts build a fresh object per call, as before).
 */
export class Encoded {
  private b: Buffer | null = null

  constructor(readonly msg: ServerMessage) {}

  /** The UTF-8 JSON of `msg`, made on first use. */
  get buf(): Buffer {
    if (this.b === null) {
      this.b = Buffer.from(JSON.stringify(this.msg))
      encodeStats.n++
    }
    return this.b
  }
}

/** JSON encodes made for sockets (Encoded and Connection.send together): the rate shows encode-once working. */
export const encodeStats = { n: 0 }

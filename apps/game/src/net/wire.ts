import { parseServerMessage, type ClientMessage, type ServerMessage } from '@sro/shared'

/** One connection attempt: JSON messages in both directions. */
export interface Wire {
  send(msg: ClientMessage): void
  close(): void
  onOpen: () => void
  onMessage: (msg: ServerMessage) => void
  /** Fires once, after open failed or the connection ended. `clean` = closed by us. */
  onClose: (info: { clean: boolean; code: number; reason: string }) => void
}

export type WireFactory = () => Wire

function noop(): void {}

/** WebSocket to the game server's /ws (same origin; Vite proxies it in dev). */
export function webSocketWire(url = defaultSocketUrl()): Wire {
  const ws = new WebSocket(url)
  let closedByUs = false
  let done = false
  const wire: Wire = {
    onOpen: noop,
    onMessage: noop,
    onClose: noop,
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    },
    close() {
      closedByUs = true
      ws.close(1000, 'client closed')
    },
  }
  ws.onopen = () => wire.onOpen()
  ws.onmessage = ev => {
    if (typeof ev.data !== 'string') return
    const parsed = parseServerMessage(ev.data)
    if (!parsed.ok) {
      console.warn(`[net] dropped invalid frame (${parsed.error})`, ev.data)
      return
    }
    wire.onMessage(parsed.msg)
  }
  ws.onclose = ev => {
    if (done) return
    done = true
    wire.onClose({ clean: closedByUs, code: ev.code, reason: ev.reason })
  }
  return wire
}

export function defaultSocketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

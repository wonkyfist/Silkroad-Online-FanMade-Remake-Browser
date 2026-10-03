import { HttpApi, type Api } from './api.ts'
import { MockServer } from './mock.ts'
import { Session } from './session.ts'
import { webSocketWire, type WireFactory } from './wire.ts'

/** Where the client talks to: the real server (HTTP /api + WebSocket /ws) or the in-browser mock. */
export interface Transport {
  readonly mock: boolean
  readonly api: Api
  readonly wire: WireFactory
  /** Mock only: simulate a network drop (tests the reconnect path). */
  dropConnection?: () => void
}

/** `gm` (mock only): every mock account gets the admin role (?mock=1&gm=1). */
export function createTransport(mock: boolean, gm = false): Transport {
  if (mock) {
    const server = new MockServer()
    if (gm) server.gmRole = 'admin'
    return { mock: true, api: server, wire: () => server.wire(), dropConnection: () => server.dropAll() }
  }
  return { mock: false, api: new HttpApi(), wire: () => webSocketWire() }
}

export function openSession(transport: Transport, token: string): Session {
  return new Session(transport.wire, token)
}

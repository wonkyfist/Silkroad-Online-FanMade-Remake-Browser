import { loadConfig } from './config.ts'
import { startServer } from './game.ts'

/** Exit code of an admin-panel restart (EX_TEMPFAIL): the systemd unit's Restart=on-failure starts the server again. */
export const RESTART_EXIT_CODE = 75

const config = loadConfig()
const server = await startServer(config)

let stopping = false
async function shutdown(signal: string, code = 0): Promise<void> {
  if (stopping) return
  stopping = true
  config.log(`${signal}: saving and shutting down`)
  const force = setTimeout(() => process.exit(code || 1), 10_000)
  force.unref()
  try {
    await server.close()
  } finally {
    process.exit(code)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

// The admin panel's Restart (docs/ADMIN.md §6) only under systemd, which sets INVOCATION_ID and restarts the unit on a
// non-zero exit (deploy/remote/silkroad.service). Anywhere else nothing would start the server again.
if (process.env.INVOCATION_ID) server.ctx.requestRestart = () => void shutdown('admin restart', RESTART_EXIT_CODE)

import { loadConfig, REPO_ROOT } from './config.ts'
import { startServer } from './game.ts'
import { RESTART_EXIT_CODE } from './updater/state.ts'
import { Updater } from './updater/updater.ts'

/** Exit code of an admin-panel restart (EX_TEMPFAIL): systemd's Restart=on-failure and pnpm serve start the server again. */
export { RESTART_EXIT_CODE }

const config = loadConfig()
const server = await startServer(config)

let stopping = false
async function shutdown(signal: string, code = 0): Promise<void> {
  if (stopping) return
  stopping = true
  config.log(`${signal}: saving and shutting down`)
  server.ctx.updater?.stop()
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

// pnpm serve (docs/UPDATES.md): the update supervisor started this process and starts it again on RESTART_EXIT_CODE.
const supervised = process.env.SRO_SUPERVISOR === '1'

// The admin panel's Restart (docs/ADMIN.md §6) only under a supervisor: systemd (it sets INVOCATION_ID and restarts the
// unit on a non-zero exit, deploy/remote/silkroad.service) or pnpm serve. Anywhere else nothing would start it again.
if (process.env.INVOCATION_ID || supervised) server.ctx.requestRestart = () => void shutdown('admin restart', RESTART_EXIT_CODE)

// Self-updates from the public repository (docs/UPDATES.md). AUTO_UPDATE=off turns them off for this server.
const { ctx } = server
const updater = new Updater({
  root: REPO_ROOT,
  dataDir: config.dataDir,
  supervised,
  disabled: /^(off|0|false|no)$/i.test(process.env.AUTO_UPDATE ?? '') ? 'AUTO_UPDATE=off in the environment turns the updater off for this server.' : null,
  log: config.log,
  online: () => ctx.sockets.size,
  broadcast: (text) => {
    for (const c of ctx.sockets.values()) c.send({ t: 'notice', text, from: 'Server' })
  },
  saveAll: () => ctx.persist([...ctx.world.players.values()]),
  backupDb: async (path) => {
    await ctx.store.db.backup(path)
  },
  schemaVersion: () => ctx.store.schemaVersion,
  // A moment later, so the admin API's answer goes out first.
  requestExit: () => void setTimeout(() => void shutdown('update', RESTART_EXIT_CODE), 500),
})
ctx.updater = updater
await updater.onStarted(server.url).catch((e) => config.log(`updater: start check failed: ${(e as Error).message}`))
updater.start()

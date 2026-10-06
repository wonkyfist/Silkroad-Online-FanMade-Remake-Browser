import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Supervisor } from '../updater/supervisor.ts'

/**
 * pnpm serve: the game server under the update supervisor (docs/UPDATES.md §4), on Windows, macOS and Linux, without
 * systemd. Restarts the server on the admin panel's Restart (exit 75) and after a crash, installs updates the server
 * hands over, rolls back a new version that does not come up healthy. Runs with plain `node` (no packages).
 *
 * The server's environment is this process's (PORT, DATA_DIR, ...). DATA_DIR resolves like config.ts dataDirFrom.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const dataDir = process.env.DATA_DIR ? resolve(process.env.INIT_CWD || process.cwd(), process.env.DATA_DIR) : resolve(ROOT, 'work/server')

const sup = new Supervisor({
  root: ROOT,
  dataDir,
  server: { cmd: process.execPath, args: ['--import', 'tsx', 'src/main.ts'], cwd: resolve(ROOT, 'apps/server') },
})

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  try {
    process.on(sig, () => sup.stop(sig))
  } catch {
    // SIGHUP is not on every platform
  }
}

console.log(`[supervisor] serving ${ROOT} (data ${dataDir}); Ctrl+C stops the server`)
process.exitCode = await sup.run()

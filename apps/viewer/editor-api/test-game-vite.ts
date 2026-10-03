#!/usr/bin/env node
/**
 * The private game Vite of "Test in game" (docs/WORLD_EDITOR.md §2.4, D6): apps/game's own config, on another port
 * with its own dependency cache (the :5180 dev server's node_modules/.vite is never re-optimised under it). Its /api
 * and /ws proxies reach the private server through SRO_SERVER (apps/game/vite.config.ts reads it). Started by
 * ./test-game.ts; prints "ready <url>" once it listens.
 *
 *   SRO_SERVER=http://127.0.0.1:<server port> pnpm tsx apps/viewer/editor-api/test-game-vite.ts <port>
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { EDITOR_FS_DENY } from './plugin.ts'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const port = Number(process.argv[2])
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('usage: test-game-vite.ts <port>')
  process.exit(2)
}
const root = join(REPO_ROOT, 'apps', 'game')
const server = await createServer({
  configFile: join(root, 'vite.config.ts'),
  root,
  cacheDir: join(root, 'node_modules', '.vite-editor-test'),
  clearScreen: false,
  // H12-ER-1: as the editor's own Vite (plugin.ts EDITOR_FS_DENY): no database, no test accounts, no foreign origin
  server: { host: '127.0.0.1', port, strictPort: true, open: false, cors: { origin: `http://127.0.0.1:${port}` }, fs: { deny: EDITOR_FS_DENY } },
})
await server.listen()
console.log(`ready http://127.0.0.1:${port}/`)
const stop = () => {
  void server.close().finally(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

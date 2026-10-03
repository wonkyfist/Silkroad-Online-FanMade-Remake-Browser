// H-12 lens "editor-reach" (docs/WAVE_PLAN8.md §6.7 item 3; docs/WORLD_EDITOR.md §2.2 D3): the editor API itself holds
// (token, Host, Origin, Sec-Fetch-Site, JSON bodies, its folders; checked live on a private `pnpm editor`), but the same
// Vite server answers without any token: `/@fs/<repo>/...` serves every file of the workspace that Vite's default
// fs.deny does not list, work/server/game.db (the accounts and their password hashes) and work/server/test-accounts.txt
// included, and Vite's default CORS reflects any localhost origin (`Access-Control-Allow-Origin: http://localhost:5180`),
// so a page on any other local port reads them cross-origin. Live on 127.0.0.1:5197: GET /@fs/C:/dev/silkroad/work/
// server/game.db -> 200 "SQLite format 3"; with Origin http://localhost:5180 the test-accounts file -> 200 + ACAO.
// Test in game's private game Vite (apps/game's config on another 127.0.0.1 port) has the same defaults.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFileLoadingAllowed, normalizePath, resolveConfig, type ResolvedConfig } from 'vite'
import { describe, expect, it } from 'vitest'

const VIEWER = fileURLToPath(new URL('..', import.meta.url))
const REPO = fileURLToPath(new URL('../../..', import.meta.url))

/** The editor's resolved Vite config (`pnpm editor` = `vite --mode editor`); no server starts, no lock is taken. */
const editorConfig = (): Promise<ResolvedConfig> =>
  resolveConfig({ configFile: join(VIEWER, 'vite.config.ts'), root: VIEWER, mode: 'editor', logLevel: 'silent' }, 'serve')

/** Whether the server's CORS answers a request from `origin` with its own Access-Control-Allow-Origin. */
function corsAllows(cors: ResolvedConfig['server']['cors'], origin: string): boolean {
  if (cors === false || cors === undefined) return false
  if (cors === true) return true
  const o = cors.origin
  if (o === undefined || o === true || o === '*') return true
  if (o === false) return false
  if (typeof o === 'string') return o === origin
  if (o instanceof RegExp) return o.test(origin)
  if (Array.isArray(o)) return o.some(x => (x instanceof RegExp ? x.test(origin) : x === origin))
  return true
}

describe('the editor server outside its API', () => {
  it('does not serve the account database or the test accounts without a token', async () => {
    const cfg = await editorConfig()
    expect(isFileLoadingAllowed(cfg, normalizePath(join(REPO, 'work', 'server', 'game.db')))).toBe(false)
    expect(isFileLoadingAllowed(cfg, normalizePath(join(REPO, 'work', 'server', 'test-accounts.txt')))).toBe(false)
  })

  it('answers cross-origin reads only to its own origin (not to the game dev server or any other local port)', async () => {
    const cfg = await editorConfig()
    expect(corsAllows(cfg.server.cors, 'http://localhost:5180')).toBe(false)
    expect(corsAllows(cfg.server.cors, 'http://127.0.0.1:9999')).toBe(false)
  })
})

/**
 * The editor API as a Vite plugin (docs/WORLD_EDITOR.md §2.2; docs/WAVE_PLAN8.md §6.2 lane WE-A): mounted only by
 * `pnpm editor` (`vite --mode editor` in apps/viewer, see ../vite.config.ts), never by the :5173 viewer and never in a
 * build. It takes `work/editor/editor.lock` when the server starts, prints the page's URL with the session token,
 * and drops the lock when the server closes or the process exits.
 */
import type { Plugin } from 'vite'
import { createEditorApi, type EditorApi, type EditorApiOptions } from './api.ts'
import { LeaseManager } from './lock.ts'

/**
 * Kept for the process: Vite re-loads the config and restarts the server in-process when the config or a file it
 * imports changes; the open tab keeps its token and its lease through that.
 */
const kept = globalThis as typeof globalThis & { __sroEditor?: { token: string; leases: LeaseManager } }

/**
 * What the editor's Vite servers (the editor itself and Test in game's private game Vite) never serve through /@fs
 * (H12-ER-1): Vite's own defaults plus the server's database and the test accounts. Their API is token-guarded; the
 * files next to it must not be readable by any localhost page without one.
 */
export const EDITOR_FS_DENY = ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/work/server/**', '**/*.db', '**/*.db-*', '**/test-account*']

export function editorApiPlugin(opts: EditorApiOptions): { plugin: Plugin; api: () => EditorApi | null; token: string } {
  let api: EditorApi | null = null
  kept.__sroEditor ??= { token: createToken(), leases: new LeaseManager({ ttlMs: opts.leaseTtlMs, now: opts.now }) }
  // The token is made up front so the config can open the page with it (server.open).
  const token = opts.token ?? kept.__sroEditor.token
  const leases = opts.leases ?? kept.__sroEditor.leases
  const plugin: Plugin = {
    name: 'sro-editor-api',
    apply: 'serve',
    configureServer(server) {
      api = createEditorApi({ ...opts, token, leases })
      const a = api
      const release = () => a.close()
      process.once('exit', release)
      server.httpServer?.once('close', () => {
        release()
        process.removeListener('exit', release)
      })
      server.middlewares.use(a.handle)
      const say = (line: string) => server.config.logger.info(line)
      server.httpServer?.once('listening', () => {
        say(`  World Editor: http://127.0.0.1:${a.port}${a.pagePath}`)
        if (!a.lock.held) say(`  Another World Editor holds ${a.lock.file} (${a.lock.owner}): this one is read-only.`)
      })
    },
  }
  return { plugin, api: () => api, token }
}

function createToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

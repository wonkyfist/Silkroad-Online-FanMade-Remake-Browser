import { createReadStream, existsSync, readFileSync, statSync, type Stats } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { createBaseOverlay } from './editor-api/base-overlay.ts'
import { EDITOR_FS_DENY, editorApiPlugin } from './editor-api/plugin.ts'
import { DEFAULT_EDITOR_WORLD, EDITOR_HOST, EDITOR_PORT } from './editor-api/protocol.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The converter's work folder: <workDir from sro.config.json, default "work">. */
function workRootDir(): string {
  let workDir = 'work'
  const cfgPath = join(REPO_ROOT, 'sro.config.json')
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { workDir?: string }
      if (cfg.workDir) workDir = cfg.workDir
    } catch {
      // Malformed config: keep the default, the converter will complain about it.
    }
  }
  return resolve(REPO_ROOT, workDir)
}

/** Converter output: $SRO_OUT_DIR, else <workDir>/out. */
function workOutDir(): string {
  if (process.env.SRO_OUT_DIR) return resolve(process.env.SRO_OUT_DIR)
  return join(workRootDir(), 'out')
}

const MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.dds': 'image/vnd-ms.dds',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Serves the converter output directory at `prefix` (dev and preview servers) straight from disk,
 * so no game data is ever copied into apps/viewer or its build output.
 */
function serveWorkOut(prefix = '/out/'): Plugin {
  const root = workOutDir()
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (!req.url?.startsWith(prefix)) return next()
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.end()
      return
    }
    let rel: string
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(prefix.length))
    } catch {
      res.statusCode = 400
      res.end()
      return
    }
    const file = resolve(root, rel)
    if (!file.startsWith(root + sep)) {
      res.statusCode = 403
      res.end()
      return
    }
    let st: Stats | undefined
    try {
      st = statSync(file)
    } catch {
      st = undefined
    }
    if (!st?.isFile()) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end(`Not found under ${root}: ${rel}\n`)
      return
    }
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Last-Modified', st.mtime.toUTCString())
    const since = req.headers['if-modified-since']
    if (since && Math.floor(st.mtimeMs / 1000) <= Math.floor(Date.parse(since) / 1000)) {
      res.statusCode = 304
      res.end()
      return
    }
    res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
    res.setHeader('Content-Length', String(st.size))
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  }
  return {
    name: 'sro-serve-work-out',
    configureServer(server) {
      server.config.logger.info(`  /out/ -> ${root}`)
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}

const page = (name: string) => fileURLToPath(new URL(`./${name}.html`, import.meta.url))

/**
 * The editor's base (./editor-api/base-overlay.ts): after a kept Publish the live export holds the edits, so for the
 * edited world's files a publish changed the editor reads the export without the layers (else a kept raise would
 * show twice). Mounted before serveWorkOut, in editor mode only.
 */
function editorBase(world: string): Plugin {
  const prefix = `/out/world/${world}/`
  const editorDir = join(workRootDir(), 'editor', world)
  const liveDir = join(workOutDir(), 'world', world)
  return {
    name: 'sro-editor-base',
    configureServer(server) {
      const overlay = createBaseOverlay(editorDir, liveDir, line => server.config.logger.info(line))
      server.middlewares.use((req, res, next) => {
        if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.url?.startsWith(prefix)) return next()
        let rel: string
        try {
          rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(prefix.length))
        } catch {
          return next()
        }
        if (rel.includes('..') || rel.includes('\\') || !overlay.serve(rel, req, res)) next()
      })
    },
  }
}

/**
 * The World Editor (`pnpm editor` = `vite --mode editor`; docs/WORLD_EDITOR.md §2.2, D2, D3; docs/WAVE_PLAN8.md
 * §6.2 lane WE-A): 127.0.0.1:5185 only (strictPort; 5190 is texpipe's review server), its own dependency cache (the
 * :5173 viewer's is never re-optimised under it), and the editor API (./editor-api/), which no other mode mounts.
 * Private checks may move it with SRO_EDITOR_PORT and keep the browser closed with SRO_EDITOR_NO_OPEN=1.
 */
function editorMode() {
  const port = Number(process.env.SRO_EDITOR_PORT) || EDITOR_PORT
  const world = process.env.SRO_EDITOR_WORLD || DEFAULT_EDITOR_WORLD
  const editor = editorApiPlugin({ repoRoot: REPO_ROOT, workRoot: workRootDir(), world, port })
  return {
    plugins: [editorBase(world), serveWorkOut(), editor.plugin],
    cacheDir: 'node_modules/.vite-editor',
    server: {
      host: EDITOR_HOST,
      port,
      strictPort: true,
      open: process.env.SRO_EDITOR_NO_OPEN ? false : `/editor.html?world=${encodeURIComponent(world)}&k=${editor.token}`,
      // H12-ER-1: cross-origin reads only from the editor's own page, and never the database or the test accounts
      cors: { origin: `http://${EDITOR_HOST}:${port}` },
      fs: { deny: EDITOR_FS_DENY },
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [serveWorkOut()],
  server: {
    port: 5173,
  },
  ...(mode === 'editor' ? editorMode() : {}),
  build: {
    target: 'es2022',
    // Babylon.js is imported through its root index; a multi-MB chunk is expected for a dev tool.
    chunkSizeWarningLimit: 10_000,
    rolldownOptions: {
      // Pages: the model viewer, the world viewer (world.html?world=jangan), the effect preview (fx.html) and the
      // World Editor's page (editor.html, WE-U; it needs `pnpm editor`'s API to save, so the build only checks it).
      input: {
        main: page('index'),
        world: page('world'),
        fx: page('fx'),
        ...(existsSync(page('editor')) ? { editor: page('editor') } : {}),
      },
    },
  },
}))

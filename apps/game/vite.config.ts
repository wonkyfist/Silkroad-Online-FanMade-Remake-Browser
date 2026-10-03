import { createReadStream, existsSync, readFileSync, statSync, type Stats } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { createGzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
/** Game server for the /api and /ws proxies: $SRO_SERVER, default http://localhost:7000. */
const SERVER = process.env.SRO_SERVER ?? 'http://localhost:7000'

/** Converter output: $SRO_OUT_DIR, else <workDir from sro.config.json, default "work">/out. */
function workOutDir(): string {
  if (process.env.SRO_OUT_DIR) return resolve(process.env.SRO_OUT_DIR)
  let workDir = 'work'
  const cfgPath = join(REPO_ROOT, 'sro.config.json')
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { workDir?: string }
      if (cfg.workDir) workDir = cfg.workDir
    } catch {
      // Malformed config: keep the default.
    }
  }
  return join(resolve(REPO_ROOT, workDir), 'out')
}

/** Slimmed assets (docs/ASSETS.md): $SRO_OUT_OPT_DIR, else the out-opt sibling of the /out/ directory. */
function workOutOptDir(): string {
  if (process.env.SRO_OUT_OPT_DIR) return resolve(process.env.SRO_OUT_OPT_DIR)
  return join(dirname(workOutDir()), 'out-opt')
}

/** Types sent compressed: a precompressed .br sibling when the client accepts br, else gzip on the fly. */
const COMPRESSIBLE = new Set(['.glb', '.gltf', '.json', '.bin', '.js', '.txt'])

const MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

/**
 * Serves a converter output directory (/out/, and the slimmed /out-opt/) straight from disk, so no game data is
 * ever copied into apps/game or its build output. glb/json/bin/js go out brotli (precompressed .br) or gzip.
 */
function serveWorkOut(prefix = '/out/', root = workOutDir()): Plugin {
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
    const ext = extname(file).toLowerCase()
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
    if (COMPRESSIBLE.has(ext)) {
      res.setHeader('Vary', 'Accept-Encoding')
      const accept = String(req.headers['accept-encoding'] ?? '')
      let br: Stats | undefined
      try {
        br = /\bbr\b/.test(accept) ? statSync(file + '.br') : undefined
      } catch {
        br = undefined
      }
      // A .br older than its file is stale (the file was re-converted after the optimizer ran): ignore it.
      if (br?.isFile() && br.mtimeMs >= st.mtimeMs) {
        res.setHeader('Content-Encoding', 'br')
        res.setHeader('Content-Length', String(br.size))
        if (req.method === 'HEAD') return void res.end()
        createReadStream(file + '.br').on('error', () => res.destroy()).pipe(res)
        return
      }
      if (/\bgzip\b/.test(accept) && st.size > 1024) {
        res.setHeader('Content-Encoding', 'gzip')
        if (req.method === 'HEAD') return void res.end()
        createReadStream(file).on('error', () => res.destroy()).pipe(createGzip({ level: 6 })).pipe(res)
        return
      }
    }
    res.setHeader('Content-Length', String(st.size))
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  }
  return {
    name: `sro-serve-work${prefix.replace(/\//g, '-')}`,
    configureServer(server) {
      server.config.logger.info(`  ${prefix} -> ${root}`)
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}

function logProxy(): Plugin {
  return {
    name: 'sro-log-proxy',
    configureServer(server) {
      server.config.logger.info(`  /api, /ws -> ${SERVER}`)
    },
  }
}

/**
 * THIRD_PARTY_NOTICES.md ships next to the game files (docs/COAST.md §8.12 S-NOTICE, WAVE_PLAN6 D14): minification
 * strips the ported files' licence headers from the bundle, so the build emits the notices file into dist/.
 */
function thirdPartyNotices(): Plugin {
  return {
    name: 'sro-third-party-notices',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.md', source: readFileSync(join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8') })
    },
  }
}

const proxy = {
  '/api': { target: SERVER, changeOrigin: true },
  '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
}

export default defineConfig({
  plugins: [serveWorkOut(), serveWorkOut('/out-opt/', workOutOptDir()), logProxy(), thirdPartyNotices()],
  server: { port: 5180, strictPort: true, proxy },
  preview: { port: 5181, proxy },
  build: {
    target: 'es2022',
    // Babylon.js is imported through its root index; a multi-MB chunk is expected.
    chunkSizeWarningLimit: 10_000,
  },
})

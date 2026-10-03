/**
 * The editor's base overlay (./publish.ts header; docs/WORLD_EDITOR.md D8, §3.1): the World Editor shows the export
 * *before* the edit pass plus the layers. Once a publish is kept, the live export holds the edits, so the editor's
 * /out/ serves, for each file a publish changed, the version the converter writes without the layers:
 * `work/editor/<world>/base/index.json` maps the export's files (`terrain/171_97.bin`) to the SHA-256 of the live file
 * they stand for, `base/files/<rel>` holds them ({ gone } = the base has no such file: 404). An entry whose live file changed
 * since (a full convert) is ignored. Only `pnpm editor` mounts it (../vite.config.ts); the game and the :5173 viewer
 * always read the live export. Node only.
 */
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

interface BaseIndex {
  files: Record<string, { live: string; gone?: true }>
}

export interface BaseOverlay {
  /** Serves `rel` (export-relative) from the overlay; false when the live file should be served. */
  serve(rel: string, req: IncomingMessage, res: ServerResponse): boolean
  /** Entries whose live file changed since they were made (shown as a warning). */
  stale(): string[]
}

export function createBaseOverlay(editorDir: string, liveDir: string, log: (line: string) => void = () => {}): BaseOverlay {
  const indexFile = join(editorDir, 'base', 'index.json')
  let index: { mtime: number; files: BaseIndex['files'] } | null = null
  const shaCache = new Map<string, { key: string; sha: string }>()
  const warned = new Set<string>()
  const read = (): BaseIndex['files'] => {
    let mtime: number
    try {
      mtime = statSync(indexFile).mtimeMs
    } catch {
      index = null
      return {}
    }
    if (index?.mtime === mtime) return index.files
    try {
      const j = JSON.parse(readFileSync(indexFile, 'utf8')) as BaseIndex
      index = { mtime, files: j.files ?? {} }
    } catch {
      index = { mtime, files: {} }
    }
    return index.files
  }
  /** The live file's SHA-256 ('' when absent), cached by size and time. */
  const liveSha = (rel: string): string => {
    const f = join(liveDir, ...rel.split('/'))
    let st
    try {
      st = statSync(f)
    } catch {
      return ''
    }
    const key = `${st.size}:${st.mtimeMs}`
    const c = shaCache.get(rel)
    if (c?.key === key) return c.sha
    const sha = createHash('sha256').update(readFileSync(f)).digest('hex')
    shaCache.set(rel, { key, sha })
    return sha
  }
  const matches = (rel: string, e: { live: string }) => liveSha(rel) === e.live
  return {
    serve(rel, req, res) {
      const e = read()[rel]
      if (!e) return false
      if (!matches(rel, e)) {
        if (!warned.has(rel)) log(`  editor base: ${rel} changed since its publish (a convert ran): the editor shows the live file`)
        warned.add(rel)
        return false
      }
      res.setHeader('Cache-Control', 'no-store')
      if (e.gone) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('Not in the editor base\n')
        return true
      }
      const file = join(editorDir, 'base', 'files', ...rel.split('/'))
      let size: number
      try {
        size = statSync(file).size
      } catch {
        return false
      }
      res.statusCode = 200
      res.setHeader('Content-Length', String(size))
      res.setHeader('Content-Type', rel.endsWith('.json') ? 'application/json; charset=utf-8' : rel.endsWith('.png') ? 'image/png' : 'application/octet-stream')
      if (req.method === 'HEAD') res.end()
      else createReadStream(file).on('error', () => res.destroy()).pipe(res)
      return true
    },
    stale() {
      return Object.entries(read()).filter(([rel, e]) => !matches(rel, e)).map(([rel]) => rel)
    },
  }
}

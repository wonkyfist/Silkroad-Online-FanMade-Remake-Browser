#!/usr/bin/env node
/**
 * The Publish process (./publish.ts): the editor's Vite starts it for each job (./runner.ts), and Claude can run it
 * from a session. It writes `work/editor/<world>/publish-<n>/record.json` as it goes (the editor polls it).
 *
 *   pnpm tsx apps/viewer/editor-api/publish-cli.ts prepare [--world jangan-fields] [--edits <dir>] [--no-tests]
 *       [--no-record] [--lock-wait <minutes>]
 *   pnpm tsx apps/viewer/editor-api/publish-cli.ts keep|discard|undo --n <publish> [--world jangan-fields]
 *   pnpm tsx apps/viewer/editor-api/publish-cli.ts status [--world jangan-fields]
 *
 * `--edits <dir>` reads the layers from another folder (checks on a scratch layer set: the main export is never
 * published by a lane during the wave, docs/WAVE_PLAN8.md D37; prepare writes only the staging exports).
 * Exit codes: 0 done (prepare: ready), 1 stopped or refused, 2 failed.
 */
import { resolve } from 'node:path'
import { loadConfig, REPO_ROOT } from '../../../packages/convert/src/node-io.ts'
import {
  discardPublish, keepPublish, lastKept, preparePublish, publishNumbers, publishPaths, readPublished, readRecord, undoPublish,
} from './publish.ts'

const USAGE = `Usage: pnpm tsx apps/viewer/editor-api/publish-cli.ts <prepare|keep|discard|undo|status> [--world <name>] [--n <publish>]
  [--edits <dir>] [--no-tests] [--no-record] [--lock-wait <minutes>]`

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv
  let world = 'jangan-fields'
  let n: number | undefined
  let edits: string | undefined
  let tests = true
  let noRecord = false
  let lockWaitMs: number | undefined
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === '--world') world = rest[++i] ?? ''
    else if (a === '--n') n = Number(rest[++i])
    else if (a === '--edits') edits = resolve(rest[++i] ?? '')
    else if (a === '--no-tests') tests = false
    else if (a === '--no-record') noRecord = true
    else if (a === '--lock-wait') lockWaitMs = Number(rest[++i]) * 60_000
    else throw new Error(`publish: unexpected argument ${JSON.stringify(a)}\n${USAGE}`)
  }
  const cfg = loadConfig()
  const paths = publishPaths(REPO_ROOT, resolve(cfg.workDir), world, edits ? { layerDir: edits } : {})
  const log = (line: string) => console.log(line)
  const need = () => {
    const k = n ?? publishNumbers(paths).at(-1)
    if (!k || !Number.isInteger(k)) throw new Error('give the publish number (--n)')
    return k
  }
  switch (verb) {
    case 'prepare': {
      const r = await preparePublish({ paths, cfg, log, tests, ...(noRecord ? { record: null } : {}), ...(lockWaitMs !== undefined ? { lockWaitMs } : {}) })
      console.log(`publish ${r.n}: ${r.phase}. ${r.sentence}`)
      return r.phase === 'ready' ? 0 : r.phase === 'failed' ? 2 : 1
    }
    case 'keep': {
      const r = await keepPublish({ paths, n: need(), log, ...(lockWaitMs !== undefined ? { lockWaitMs } : {}) })
      console.log(`publish ${r.n}: ${r.phase}. ${r.sentence}`)
      return r.phase === 'kept' ? 0 : 1
    }
    case 'discard': {
      const r = discardPublish(paths, need())
      console.log(`publish ${r.n}: ${r.sentence}`)
      return 0
    }
    case 'undo': {
      const r = await undoPublish(paths, need(), { log, ...(lockWaitMs !== undefined ? { lockWaitMs } : {}) })
      console.log(`publish ${r.n}: ${r.sentence}`)
      return 0
    }
    case 'status': {
      const last = publishNumbers(paths).at(-1)
      const r = last ? readRecord(paths, last) : null
      const k = lastKept(readPublished(paths.editorDir))
      console.log(r ? `publish ${r.n}: ${r.phase}. ${r.sentence}` : 'no publish yet')
      console.log(k ? `last kept: publish ${k.n} (${k.at}${k.commit ? `, ${k.commit}` : ''})` : 'nothing kept yet')
      return 0
    }
    default:
      console.log(USAGE)
      return verb ? 1 : 0
  }
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code
}, (e: Error) => {
  console.error(`publish: ${e.message}`)
  process.exitCode = 2
})

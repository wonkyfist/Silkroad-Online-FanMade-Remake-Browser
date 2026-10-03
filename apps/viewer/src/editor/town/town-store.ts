/**
 * The editor API's town files (Node side; docs/WORLD_EDITOR.md §2.2 D3, §4.11, D32; WAVE_PLAN8 D12, lane WE-T):
 * `content/town/<town>.json` (with its `manual` overlay) and `<town>-dressing.json`. The API mounts it as
 * `GET town` / `POST town` (apps/viewer/editor-api/api.ts); writes need the tab's lease like every other save.
 *
 * Save takes whole files, checks them with `validateTownFile` (the overlay included), refuses a file that changed on
 * disk since the page loaded it (a `pnpm sro town-graph` rebuild or a Publish in between: the base hash), and
 * writes both atomically (temp + fsync + rename, ../../../editor-api/atomic.ts) inside `content/town/` only.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateTownFile, type TownDressingFile, type TownFile } from '../../../../../packages/shared/src/town.ts'
import { WriteScope, commitFiles, type FileStep } from '../../../editor-api/atomic.ts'
import { SaveError } from '../../../editor-api/store.ts'

export interface TownLoad {
  town: TownFile | null
  dressing: TownDressingFile | null
  /** sha256 of each file as read (absent: no file); a save sends them back. */
  base: { town: string | null; dressing: string | null }
  /** Problems of a file on disk that does not validate (the tool stays off). */
  problems: string[]
}

export interface TownSaveRequest {
  town?: unknown
  dressing?: unknown
  base?: { town?: string | null; dressing?: string | null }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/**
 * The town file as `pnpm sro town-graph` writes it (build-graph.ts `townFileText`: one node, edge or seat per line;
 * the test keeps the two the same), so a save shows as a small diff.
 */
export function townJsonText(file: unknown): string {
  const json = JSON.stringify(file, null, 1)
  const flat = json.replace(/\{\n(\s*"[^"\n]+": (?:-?[\d.e+-]+|"[^"\n]*"|true|false),?\n)+\s*\}/g, m => m.replace(/\n\s*/g, ' ').replace('{ ', '{').replace(' }', '}'))
  return `${flat}\n`
}

export class TownStore {
  readonly townFile: string
  readonly dressingFile: string
  private readonly scope: WriteScope

  /** `dir`: content/town (absolute); `town`: the towns.json code (jangan). */
  constructor(readonly dir: string, readonly town = 'jangan') {
    this.townFile = join(dir, `${town}.json`)
    this.dressingFile = join(dir, `${town}-dressing.json`)
    this.scope = new WriteScope([dir])
  }

  private read(file: string): { text: string; json: unknown } | null {
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8')
    return { text, json: JSON.parse(text) as unknown }
  }

  load(): TownLoad {
    const problems: string[] = []
    const t = this.read(this.townFile)
    const d = this.read(this.dressingFile)
    let town: TownFile | null = null
    let dressing: TownDressingFile | null = null
    if (t) {
      const v = validateTownFile(t.json)
      if (v.ok && v.file.kind === 'town') town = v.file
      else problems.push(...(v.ok ? [`${this.town}.json is not a town file`] : v.problems.slice(0, 5)))
    }
    if (d) {
      const v = validateTownFile(d.json)
      if (v.ok && v.file.kind === 'townDressing') dressing = v.file
      else problems.push(...(v.ok ? [`${this.town}-dressing.json is not a dressing file`] : v.problems.slice(0, 5)))
    }
    return { town, dressing, base: { town: t ? sha256(t.text) : null, dressing: d ? sha256(d.text) : null }, problems }
  }

  save(req: TownSaveRequest): { written: string[]; base: TownLoad['base'] } {
    if (!req || typeof req !== 'object') throw new SaveError('the town save needs {town, dressing, base}')
    const steps: FileStep[] = []
    const now = { town: this.read(this.townFile), dressing: this.read(this.dressingFile) }
    const base = { town: now.town ? sha256(now.town.text) : null, dressing: now.dressing ? sha256(now.dressing.text) : null }
    const stale = (k: 'town' | 'dressing') => req.base && req.base[k] !== undefined && req.base[k] !== base[k]
    if (req.town !== undefined) {
      if (stale('town')) throw new SaveError(`${this.town}.json changed on disk since the editor opened it (a town-graph rebuild or a Publish). Reload the page to edit the new routes; the town edits made since your last save are not saved.`)
      const v = validateTownFile(req.town)
      if (!v.ok || v.file.kind !== 'town') throw new SaveError(`the town file does not validate: ${v.ok ? 'not a town file' : v.problems.slice(0, 3).join('; ')}`)
      if (v.file.town !== this.town) throw new SaveError(`this editor saves the ${this.town} town only`)
      steps.push({ file: this.townFile, data: townJsonText(v.file) })
    }
    if (req.dressing !== undefined && req.dressing !== null) {
      if (stale('dressing')) throw new SaveError(`${this.town}-dressing.json changed on disk since the editor opened it. Reload the page; the town edits made since your last save are not saved.`)
      const v = validateTownFile(req.dressing)
      if (!v.ok || v.file.kind !== 'townDressing') throw new SaveError(`the dressing file does not validate: ${v.ok ? 'not a dressing file' : v.problems.slice(0, 3).join('; ')}`)
      steps.push({ file: this.dressingFile, data: `${JSON.stringify(v.file, null, 1)}\n` })
    }
    const r = commitFiles(this.scope, steps)
    const after = { town: this.read(this.townFile), dressing: this.read(this.dressingFile) }
    return { written: r.written, base: { town: after.town ? sha256(after.town.text) : null, dressing: after.dressing ? sha256(after.dressing.text) : null } }
  }
}

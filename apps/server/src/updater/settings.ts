import { join } from 'node:path'
import { UPDATE_MODES, validTimeZone, type AdminUpdateSettings, type UpdateMode } from '@sro/shared'
import { branchProblem, repoUrlProblem } from './git.ts'
import { HHMM_RE } from './schedule.ts'
import { readJson, updatesDir, writeJsonAtomic } from './state.ts'

/**
 * The Updates page's settings (docs/UPDATES.md §3), in DATA_DIR/updates/settings.json next to the run state: the
 * supervisor and a database restore never touch them. Every change is audited by the admin API (updates.settings).
 */

export const PUBLIC_REPO_URL = 'https://github.com/wonkyfist/Silkroad-Online-FanMade-Remake-Browser'

export const UPDATE_DEFAULTS: AdminUpdateSettings = {
  mode: 'notify',
  intervalMin: 60,
  windowEnabled: false,
  windowStart: '04:00',
  windowEnd: '06:00',
  windowTz: '',
  repoUrl: PUBLIC_REPO_URL,
  branch: 'main',
}

const KEYS = Object.keys(UPDATE_DEFAULTS) as (keyof AdminUpdateSettings)[]

const settingsPath = (dataDir: string) => join(updatesDir(dataDir), 'settings.json')

/** Checks a partial settings object; returns the problems (empty: all good). Unknown keys are problems. */
export function settingsProblems(v: Record<string, unknown>, allowLocal = false): string[] {
  const p: string[] = []
  for (const [k, x] of Object.entries(v)) {
    switch (k) {
      case 'mode':
        if (!UPDATE_MODES.includes(x as UpdateMode)) p.push('mode must be off, notify or auto')
        break
      case 'intervalMin':
        if (!Number.isInteger(x) || (x as number) < 15 || (x as number) > 1440) p.push('intervalMin must be a whole number from 15 to 1440')
        break
      case 'windowEnabled':
        if (typeof x !== 'boolean') p.push('windowEnabled must be true or false')
        break
      case 'windowStart':
      case 'windowEnd':
        if (typeof x !== 'string' || !HHMM_RE.test(x)) p.push(`${k} must be a time like 04:00`)
        break
      case 'windowTz':
        if (typeof x !== 'string' || (x !== '' && !validTimeZone(x))) p.push("windowTz must be an IANA time zone like Europe/Berlin ('' = the server's)")
        break
      case 'repoUrl': {
        const problem = typeof x === 'string' && x.length <= 300 ? repoUrlProblem(x, allowLocal) : 'repoUrl must be a URL'
        if (problem) p.push(problem)
        break
      }
      case 'branch': {
        const problem = typeof x === 'string' ? branchProblem(x) : 'branch must be a string'
        if (problem) p.push(problem)
        break
      }
      default:
        p.push(`unknown setting ${k}`)
    }
  }
  return p
}

/** The saved settings over the defaults; a saved value that no longer validates falls back to its default. */
export function loadUpdateSettings(dataDir: string, allowLocal = false): AdminUpdateSettings {
  const saved = readJson<Record<string, unknown>>(settingsPath(dataDir)) ?? {}
  const out: AdminUpdateSettings = { ...UPDATE_DEFAULTS }
  for (const k of KEYS) {
    if (!(k in saved)) continue
    if (settingsProblems({ [k]: saved[k] }, allowLocal).length === 0) (out as unknown as Record<string, unknown>)[k] = typeof saved[k] === 'string' ? (saved[k] as string).trim() : saved[k]
  }
  return out
}

export function saveUpdateSettings(dataDir: string, s: AdminUpdateSettings): void {
  writeJsonAtomic(settingsPath(dataDir), s)
}

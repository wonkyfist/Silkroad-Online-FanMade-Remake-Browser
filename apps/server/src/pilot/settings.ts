import {
  PILOT_SETTING_PATHS,
  checkPilotEffective,
  checkPilotSettings,
  mergePilotPatch,
  mergePilotSettings,
  prunePilotPatch,
  unsetPilotPaths,
  type PilotSettings,
  type PilotSettingsIssue,
  type PilotSettingsPatch,
} from '@sro/shared'
import type { PilotStore } from './store.ts'
import type { PilotConf } from './types.ts'

/**
 * Play the Boss, the settings store (docs/PLAY_THE_BOSS.md §6.1, §6.2): the effective settings are the content
 * defaults (content/uniques.json `pilot.defaults`) with the admin panel's sparse patch (`pilot_settings`, one row per
 * unique) laid over them. A save carries the `rev` it was based on (409 when stale), is checked field by field
 * (PILOT_BOUNDS) and across fields (the level cap), keeps only what differs from the defaults and applies at once: a
 * running event keeps its timers (call end, hunt end, area), every other number is read live.
 */

export type SettingsResult = { ok: true; effective: PilotSettings; patch: PilotSettingsPatch; rev: number } | { ok: false; status: number; message: string; issues?: PilotSettingsIssue[] }

/** The 'group.field' an issue path names ('schedule.slots[2]' → 'schedule.slots'). */
function fieldOf(path: string): string {
  return path.replace(/\[\d+\]$/, '')
}

/** The stored patch of `code`, its bad fields dropped (bounds tightened since, a hand edit); rev 0 = none stored. */
export function loadPatch(store: PilotStore, conf: Pick<PilotConf, 'code' | 'def'>, levelCap: number, log: (line: string) => void): { patch: PilotSettingsPatch; rev: number } {
  let row
  try {
    row = store.settingsOf(conf.code)
  } catch {
    return { patch: {}, rev: 0 }
  }
  if (!row) return { patch: {}, rev: 0 }
  let patch: PilotSettingsPatch = {}
  try {
    patch = JSON.parse(row.json) as PilotSettingsPatch
  } catch {
    log(`pilot: ${conf.code}: the stored settings are not JSON; using the defaults`)
    return { patch: {}, rev: row.rev }
  }
  const bad = checkPilotSettings(patch).map((i) => fieldOf(i.path))
  if (bad.length) {
    log(`pilot: ${conf.code}: stored settings ${bad.join(', ')} are out of bounds; using the defaults for them`)
    patch = unsetPilotPaths(patch, bad)
  }
  const cross = checkPilotEffective(mergePilotSettings(conf.def.defaults, patch), levelCap).map((i) => i.path)
  if (cross.length) {
    log(`pilot: ${conf.code}: stored settings ${cross.join(', ')} break a rule; using the defaults for them`)
    patch = unsetPilotPaths(patch, cross)
  }
  return { patch, rev: row.rev }
}

/** The conf's settings become defaults ⊕ `patch` at `rev`. */
export function applyPatch(conf: PilotConf, patch: PilotSettingsPatch, rev: number): void {
  conf.patch = patch
  conf.rev = rev
  conf.settings = mergePilotSettings(conf.def.defaults, patch)
}

function saveRow(store: PilotStore, conf: PilotConf, patch: PilotSettingsPatch, by: number | null, now: number, levelCap: number): SettingsResult {
  const effective = mergePilotSettings(conf.def.defaults, patch)
  const cross = checkPilotEffective(effective, levelCap)
  if (cross.length) return { ok: false, status: 422, message: 'Some settings do not fit together.', issues: cross }
  const rev = conf.rev + 1
  store.saveSettings(conf.code, JSON.stringify(patch), rev, now, by)
  applyPatch(conf, patch, rev)
  return { ok: true, effective: structuredClone(conf.settings), patch: structuredClone(patch), rev }
}

/** PUT /api/admin/boss/settings: `delta` over the stored patch, based on `baseRev`. */
export function saveSettings(store: PilotStore, conf: PilotConf, baseRev: unknown, delta: unknown, by: number | null, now: number, levelCap: number): SettingsResult {
  if (!Number.isInteger(baseRev)) return { ok: false, status: 400, message: 'baseRev must be the rev you loaded.' }
  if (baseRev !== conf.rev) return { ok: false, status: 409, message: `The settings were changed since you loaded them (rev ${conf.rev}, yours ${String(baseRev)}). Reload and try again.` }
  const issues = checkPilotSettings(delta)
  if (issues.length) return { ok: false, status: 422, message: 'Some values are out of bounds.', issues }
  return saveRow(store, conf, prunePilotPatch(mergePilotPatch(conf.patch, delta as PilotSettingsPatch), conf.defaults), by, now, levelCap)
}

/** POST /api/admin/boss/settings/reset: `paths` (none = all) back to their defaults. */
export function resetSettings(store: PilotStore, conf: PilotConf, paths: unknown, baseRev: unknown, by: number | null, now: number, levelCap: number): SettingsResult {
  if (baseRev !== undefined && baseRev !== conf.rev) return { ok: false, status: 409, message: `The settings were changed since you loaded them (rev ${conf.rev}). Reload and try again.` }
  let list: string[] | null = null
  if (paths !== undefined) {
    const groups = new Set(PILOT_SETTING_PATHS.map((p) => p.split('.')[0]))
    if (!Array.isArray(paths) || paths.length > 64 || !paths.every((p) => typeof p === 'string' && (PILOT_SETTING_PATHS.includes(p) || groups.has(p)))) {
      return { ok: false, status: 422, message: 'paths must name settings (e.g. "win.surviveMin", or a group: "win").', issues: [{ path: 'paths', message: 'unknown setting' }] }
    }
    list = paths as string[]
  }
  return saveRow(store, conf, list === null ? {} : unsetPilotPaths(conf.patch, list), by, now, levelCap)
}

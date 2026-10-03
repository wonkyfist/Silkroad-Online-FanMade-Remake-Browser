/**
 * H-11 hunt (docs/WAVE_PLAN7.md §6.6, lens 2 "unique state": restart storms, two spawns at once, a camp disabled by
 * /nest mid-wait, the DB row vs the live mob after a crash, clock jumps). Each test here FAILS on b22f6a9 and names
 * the defect; F-11 makes it pass (apps/server/src/uniques.ts, lane U-S).
 *
 * Found: the waiting timer (`uniques.due_at`, an ms epoch from Date.now) is never bounded by the unique's own respawn
 * window. A due time written while the wall clock was ahead (a host that booted with a fast RTC before NTP stepped it
 * back, a VM restored from a snapshot, a hand-edited row) is "kept" by every later restart (`restart()`: due_at > now →
 * 'timer kept'), and a backward clock step after a kill leaves the timer past `respawnMin[1]` with nothing to pull it
 * back: she does not appear for days (a year in the first test) and only a GM who reads `/unique list` notices.
 * Expected (the fix's contract): at the restart and in the tick, a waiting due time more than `respawnMin[1]` minutes
 * ahead of now is re-rolled into the window (or clamped to now + respawnMin[1]), logged once.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type MobDef, type NestDef, type UniquesFile } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { GameData } from '../src/gamedata.ts'
import type { Mob } from '../src/world.ts'
import { mob, nest, seeded } from './fixtures.ts'
import { SAFE_TOWN, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const MIN = 60_000
const DAY = 24 * 60 * MIN
const TG = 'MOB_CH_TIGERWOMAN'
const REAL_FILE = JSON.parse(readFileSync(join(REPO_ROOT, 'content/uniques.json'), 'utf8')) as UniquesFile
/** Her respawn window's upper end (content/uniques.json: 360 min). */
const RESPAWN_MAX_MS = REAL_FILE.uniques[0].respawnMin[1] * MIN

const MOBS: MobDef[] = [mob(TG, { name: 'Tiger Girl', level: 20, rarity: 'unique', hp: 598_720, radius: 2.8, aggressive: true, walkSpeed: 0, runSpeed: 0 })]
const tactics = { id: 9, aggressive: true, sightRange: 14, leashRange: 50 }
const CAMPS: NestDef[] = [5903, 5904].map((id, i) => nest(id, TG, i * 60, -50, { uniqueGroup: TG, respawnSec: [10_800, 21_600], radius: 100, spawnRadius: 60, tactics }))

/** A world with her camps and the shipped uniques.json on `dataDir`'s database, started at `at`. */
function boot(dataDir: string, at: number, seed = 1) {
  const content = mkdtempSync(join(tmpdir(), 'sro-h11-us-content-'))
  cleanups.push(() => rmSync(content, { recursive: true, force: true }))
  // The real file minus its drop table's items (this world has none of them): no drops, same timers.
  const file = structuredClone(REAL_FILE)
  for (const t of Object.values(file.dropTables)) t.groups = []
  writeFileSync(join(content, 'uniques.json'), JSON.stringify(file))
  const data = new GameData({ mobs: MOBS, items: SKILL_ITEMS, levels: SKILL_LEVELS, towns: [SAFE_TOWN], nests: CAMPS.map((n) => ({ ...n })) })
  const h = skillHarness({ data, config: { contentDir: content, dataDir } })
  h.gameplay.uniques!.rng = seeded(seed)
  h.now = at
  h.gameplay.start(at)
  const u = () => h.gameplay.uniques!.uniques[0]
  const her = (): Mob | undefined => [...h.world.mobs.values()].find((m) => m.def.code === TG && m.ai !== 'dead')
  return { h, u, her }
}

const tmpDataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sro-h11-us-db-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('H-11 unique state: clock jumps and the waiting timer', () => {
  it('a restart keeps a due time far beyond her respawn window (written while the clock ran a year ahead)', () => {
    const dataDir = tmpDataDir()
    const T = 1_800_000_000_000 // 2027-01-15, a real epoch
    const a = boot(dataDir, T)
    a.u() // first boot: a fresh row, due 10-30 min after T
    // The host's clock ran a year ahead when she was last killed: the row says "due in a year (of that clock)".
    a.h.store.db.prepare('UPDATE uniques SET phase = ?, due_at = ?, spawns = 1, last_killed_at = ? WHERE code = ?').run('waiting', T + 365 * DAY, T + 365 * DAY - 3 * 60 * MIN, TG)
    a.h.cleanup()
    // The clock is right again; the server restarts.
    const b = boot(dataDir, T + 10 * MIN)
    cleanups.push(b.h.cleanup)
    const wait = b.u().row.due_at - (T + 10 * MIN)
    // Today: 'timer kept', 8,760 hours. Expected: at most her respawn window (360 min) from now.
    expect(b.h.logs.find((l) => /uniques: /.test(l))).not.toMatch(/timer kept/)
    expect(wait).toBeLessThanOrEqual(RESPAWN_MAX_MS)
    // And she does appear within that window.
    b.h.runTo(T + 10 * MIN + RESPAWN_MAX_MS + 1000)
    expect(b.her()).toBeDefined()
  })

  it('a backward wall-clock step after a kill leaves her timer past the window; the tick never pulls it back', () => {
    const dataDir = tmpDataDir()
    const T = 1_800_000_000_000
    const a = boot(dataDir, T)
    cleanups.push(a.h.cleanup)
    expect(a.h.gameplay.uniques!.gm(null, ['timer', 'tiger', 'now'], a.h.now).ok).toBe(true)
    a.h.runTo(a.h.now + 100)
    const m = a.her()!
    expect(m).toBeDefined()
    // A GM kill (silent) rolls the 180-360 min timer from the current clock.
    expect(a.h.gameplay.uniques!.gm(null, ['kill', 'tiger'], a.h.now).ok).toBe(true)
    const due = a.u().row.due_at
    expect(due - a.h.now).toBeLessThanOrEqual(RESPAWN_MAX_MS)
    // NTP steps the clock back a day (it had drifted ahead). The world keeps ticking on the corrected clock.
    a.h.now = a.h.now - DAY
    a.h.runTo(a.h.now + 5000)
    // Today: due_at is unchanged, now ~30 h away (> 6 h). Expected: never more than the window from now.
    expect(a.u().row.due_at - a.h.now).toBeLessThanOrEqual(RESPAWN_MAX_MS)
  })
})

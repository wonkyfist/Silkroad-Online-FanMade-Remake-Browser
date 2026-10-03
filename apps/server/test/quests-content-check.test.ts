/**
 * Lane CT (docs/WAVE_PLAN.md §5.3): "The Tiger's Shadow" (content/quests/jangan.json) is playable on the play export.
 * Runs quests-check.ts: codes, level and EXP rules (QUESTS §3.4), and on the jangan-fields navmesh every LOC_*
 * in the town spawn's walkable component, every quest NPC reachable, and every objective mob with a nest the spawner
 * accepts within 150 m of its hint. Skipped without the exports.
 */
import { describe, expect, it } from 'vitest'
import { checkQuestContent, exportAvailable } from './quests-check.ts'

const READY = exportAvailable()

describe('quest content on jangan-fields', () => {
  it.skipIf(!READY)('jangan.json passes every content check, navmesh included', () => {
    const r = checkQuestContent()
    expect(r.nav).toBe(true)
    expect(r.errors).toEqual([])
    // The EXP table (QUESTS §3.4) and the nest distances are in r.lines; the rules above already fail on them.
    expect(r.lines.some((l) => l.startsWith('total quest EXP'))).toBe(true)
  })
})

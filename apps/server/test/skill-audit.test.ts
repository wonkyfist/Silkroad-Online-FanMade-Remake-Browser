/**
 * The skill audit (skill-audit.ts) on the real export: every learnable row passes every check, except the documented
 * exceptions (skill-audit.exceptions.ts). Skipped when the export is not there.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { formatAudit, runSkillAudit } from './skill-audit.ts'
import { AUDIT_EXCEPTIONS } from './skill-audit.exceptions.ts'

const OUT = join(REPO_ROOT, 'work/out')
const HAVE = ['data/skills.json', 'data/mobs.json', 'fx/skills.json', 'fx/index.json'].every((f) => existsSync(join(OUT, f)))

describe.skipIf(!HAVE)('skill audit (all learnable rows)', () => {
  it('every row: clips, VFX, spawned objects, server effect and hit timing check out', () => {
    const rep = runSkillAudit(OUT)
    expect(rep.total).toBeGreaterThanOrEqual(230) // every learnable row of this build (1,141 at cap 30)
    const unexpected = rep.rows.flatMap((r) => r.fails.filter((f) => !AUDIT_EXCEPTIONS[`${f.cat}:${r.group}`]).map((f) => `${r.code} ${f.cat} ${f.detail}`))
    expect(unexpected, formatAudit(rep, { exceptions: AUDIT_EXCEPTIONS })).toEqual([])
    // every exception whose row is in this build is still needed (some are above the level cap)
    const used = new Set(rep.rows.flatMap((r) => r.fails.map((f) => `${f.cat}:${r.group}`)))
    const groups = new Set(rep.rows.map((r) => r.group))
    expect(Object.keys(AUDIT_EXCEPTIONS).filter((k) => groups.has(k.slice(k.indexOf(':') + 1)) && !used.has(k))).toEqual([])
  })
})

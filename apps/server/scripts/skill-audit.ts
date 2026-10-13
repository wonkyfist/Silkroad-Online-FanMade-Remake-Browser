/**
 * Skill audit CLI (apps/server/test/skill-audit.ts): counts per check and category, then the failing rows grouped
 * by cause, most common skills (lowest mastery level) first.
 *
 *   pnpm exec tsx apps/server/scripts/skill-audit.ts [--static] [--rows] [--json <file>] [--out <work/out>]
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../src/config.ts'
import { formatAudit, runSkillAudit } from '../test/skill-audit.ts'
import { AUDIT_EXCEPTIONS } from '../test/skill-audit.exceptions.ts'

const args = process.argv.slice(2)
const val = (k: string) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : undefined
}
const out = val('--out') ?? join(REPO_ROOT, 'work/out')
const rep = runSkillAudit(out, { server: !args.includes('--static') })
console.log(formatAudit(rep, { exceptions: AUDIT_EXCEPTIONS, rows: args.includes('--rows') }))
const json = val('--json')
if (json) writeFileSync(json, JSON.stringify(rep, null, 1))

/**
 * H-11 adversarial hunt, lens = announcement abuse and correctness (docs/WAVE_PLAN7.md §6.6 lens 3): the defeat
 * notice's name (solo vs party damage), notices on the lobby or the stage, a quiet GM, doubled sounds, and the area's
 * full stop.
 *
 * Tests named "BUG:" reproduce a real defect and FAIL until it is fixed; their assertions state the correct behaviour
 * (docs/UNIQUES.md §3.2, §3.3, §3.10).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { questLineText, type QuestFile, type UniquesFile } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { resolveWorld } from '../src/content.ts'
import { GameData } from '../src/gamedata.ts'

const TG = 'MOB_CH_TIGERWOMAN'
const OUT = join(REPO_ROOT, 'work/out')
const HAVE = existsSync(join(OUT, 'data/nests.json')) && existsSync(join(OUT, 'data/zones.json')) && existsSync(join(OUT, 'world/jangan-fields/manifest.json'))
const JANGAN = JSON.parse(readFileSync(join(REPO_ROOT, 'content/quests/jangan.json'), 'utf8')) as QuestFile & { lines?: { id: string; npc: string; text: string; textNoArea?: string; when: unknown }[] }

describe('the area\'s full stop (UNIQUES §3.2: "North-Tiger Mt." / "South-Tiger Mt." end in a full stop; no sentence may add a second)', () => {
  it.skipIf(!HAVE)('BUG: Priest Jeonghye\'s rumour line (U-Q, §3.10) prints "near South-Tiger Mt.." while she stands at a Tiger Mt. camp', () => {
    // The area the server hands the line: GameData.zoneName at her live position, as for the appear notice.
    const data = GameData.load(OUT)
    const setup = resolveWorld(OUT, 'jangan-fields', null, 'jangan')
    const camps = data.nests.filter((n) => n.mob === TG && n.uniqueGroup)
    expect(camps.length).toBe(11)
    const areas = [...new Set(camps.map((n) => data.zoneName(n.x, n.z, setup.regionOrigin)))]
    const dotted = areas.filter((a) => a.endsWith('.'))
    // Several of her 11 camps lie in the two "...Mt." zones (the spec's dry run: camp 5909 in South-Tiger Mt.).
    expect(dotted.length, areas.join(' | ')).toBeGreaterThan(0)
    const bad: string[] = []
    for (const line of JANGAN.lines ?? []) {
      for (const area of dotted) {
        const text = questLineText(line as Parameters<typeof questLineText>[0], area)
        if (text && /\.\./.test(text.replace(/\.\.\./g, ''))) bad.push(`${line.id}: ${text}`)
      }
    }
    // Correct: no line shows a doubled full stop (word the line so {area} is not followed by ".", as the notice did).
    expect(bad).toEqual([])
  })
})

/** Every .ts file under `dir` (no node_modules). */
function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name === 'test') continue
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('her roar for players near the camp (UNIQUES §3.3: "within 120 m of the camp also hear her own roar ... once at the spawn")', () => {
  it('BUG: `announce.roarRadiusM` (120 in content/uniques.json) is read by nothing: the roar is neither sent nor played, and no cut says so', () => {
    const file = JSON.parse(readFileSync(join(REPO_ROOT, 'content/uniques.json'), 'utf8')) as UniquesFile
    expect(file.uniques[0].announce.roarRadiusM).toBe(120)
    // Where it may legitimately appear without doing anything: the type and the content check.
    const declaredOnly = new Set([join(REPO_ROOT, 'packages/shared/src/content.ts'), join(REPO_ROOT, 'packages/shared/src/content-check.ts')])
    const users = [join(REPO_ROOT, 'apps/server/src'), join(REPO_ROOT, 'apps/game/src'), join(REPO_ROOT, 'packages/shared/src'), join(REPO_ROOT, 'packages/world-render/src')]
      .flatMap(sources)
      .filter((f) => !declaredOnly.has(f) && readFileSync(f, 'utf8').includes('roarRadiusM'))
    // Correct: the server (or the client on the appear notice) uses it; or the plan's cut 12 is applied and logged
    // (then the field and this test go).
    expect(users.map((f) => f.slice(REPO_ROOT.length + 1))).not.toEqual([])
  })
})

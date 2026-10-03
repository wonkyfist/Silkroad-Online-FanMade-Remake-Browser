/**
 * Checks a finished optimizer run (work/out-opt, from `pnpm tsx packages/convert/src/tools/optimize-out.ts run`)
 * against the targets in docs/ASSETS.md. Skips when work/out-opt/slim-report.json is missing.
 * Re-validates a sample of the written files independently of the report the run wrote about itself.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import { validateGlb } from '../src/gltf/validate.ts'
import { gltfIO } from '../src/optimize/io.ts'
import { walkFiles } from '../src/optimize/measure.ts'
import type { Report, SlimManifest } from '../src/optimize/run.ts'

const OPT = join(REPO_ROOT, 'work', 'out-opt')
const REPORT = join(OPT, 'slim-report.json')
const HAS = existsSync(REPORT)
const MB = 1024 * 1024

describe.skipIf(!HAS)('work/out-opt', () => {
  const report = HAS ? (JSON.parse(readFileSync(REPORT, 'utf8')) as Report) : (null as unknown as Report)
  const slim = HAS ? (JSON.parse(readFileSync(join(OPT, 'slim.json'), 'utf8')) as SlimManifest) : (null as unknown as SlimManifest)

  it('has no validator errors, no animation differences and no texture below the gate', () => {
    expect(report.summary.validatorErrors).toBe(0)
    expect(report.animationCheck.failures).toEqual([])
    expect(report.animationCheck.maxDiff).toBe(0)
    expect(report.animationCheck.clips).toBeGreaterThan(0)
    expect(report.texturesForReview).toEqual([])
    for (const g of report.glbs) if (g.geometry) expect(g.geometry.unmatchedPrimitives, g.rel).toEqual([])
    // Per-document bound: 0.5 mm for actors and items, 1 mm for the world (geometry.ts maxPositionErrorMm).
    expect(Number(report.summary.maxPositionErrorMm)).toBeLessThanOrEqual(1)
  })

  it('actor mesh glbs are small and every sidecar points at existing packs', () => {
    const actors = walkFiles(OPT).filter(f => /^(char|mob|npc)\//.test(f) && f.endsWith('.glb') && !f.includes('/_anims/'))
    expect(actors.length).toBeGreaterThan(0)
    for (const rel of actors) {
      if (rel.startsWith('char/')) expect(statSync(join(OPT, rel)).size, rel).toBeLessThan(1.5 * MB)
      const side = JSON.parse(readFileSync(join(OPT, rel.replace(/\.glb$/, '.json')), 'utf8')) as { animations?: { name: string }[]; animationPacks?: { packs: Record<string, string>; clips: Record<string, [string, string]> } }
      if (!side.animationPacks || !side.animations) continue
      for (const a of side.animations.filter(x => x.name)) {
        const ref = side.animationPacks.clips[a.name]
        if (!ref) continue
        expect(existsSync(join(OPT, side.animationPacks.packs[ref[0]]!)), `${rel} ${a.name}`).toBe(true)
      }
    }
  })

  it('the Jangan world is under 35 MB and every renamed image exists', () => {
    // The 3 x 3 'jangan' export loads whole; the streamed exports beside it (jangan-near, jangan-fields; docs/FIELDS.md)
    // download per region and have no whole-world budget.
    const dir = join(OPT, 'world', 'jangan')
    const world = walkFiles(dir).filter(f => !f.endsWith('.br')).reduce((s, f) => s + statSync(join(dir, f)).size, 0)
    expect(world).toBeLessThan(35 * MB)
    for (const to of Object.values(slim.renamed)) expect(existsSync(join(OPT, to)), to).toBe(true)
    expect(existsSync(join(OPT, slim.meshoptDecoder))).toBe(true)
  })

  it('a sample of written glbs re-validates with 0 errors and decodes through meshopt', async () => {
    const io = await gltfIO()
    const all = walkFiles(OPT).filter(f => f.endsWith('.glb'))
    const sample = all.filter((_f, i) => i % Math.max(1, Math.floor(all.length / 25)) === 0)
    for (const rel of sample) {
      const bytes = readFileSync(join(OPT, rel))
      expect((await validateGlb(bytes, rel)).errors, rel).toBe(0)
      const doc = await io.readBinary(bytes)
      for (const acc of doc.getRoot().listAccessors()) expect(acc.getArray(), rel).toBeTruthy()
    }
  })
})

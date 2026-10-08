/**
 * The rare effects sit on each weapon's actual blade or head (docs/RARITY.md §5.9): for every Chinese weapon glb of
 * the equipment set, the effect region (apps/game/src/world/rarity/region.ts) lies inside the model, along its long
 * axis, at the tip end, and (spears, glaives) on the head, not the shaft. Skips without the converted set.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { describe, expect, it } from 'vitest'
import { regionKindOf, weaponRegion, type Vec3 } from '../../../apps/game/src/world/rarity/region.ts'

const DIR = join(__dirname, '../../../work/out/equipment/china/weapon')
const has = existsSync(DIR)
const KIND: Record<string, string> = { sword: 'sword', blade: 'blade', spear: 'spear', tblade: 'glaive', bow: 'bow' }
const TOL = 0.01

async function positions(glb: string): Promise<number[]> {
  const doc = await new NodeIO().read(glb)
  const out: number[] = []
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const m = node.getWorldMatrix()
    for (const prim of mesh.listPrimitives()) {
      const a = prim.getAttribute('POSITION')!.getArray()!
      for (let i = 0; i < a.length; i += 3) {
        const x = a[i]!, y = a[i + 1]!, z = a[i + 2]!
        out.push(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!)
      }
    }
  }
  return out
}

describe.skipIf(!has)('weapon effect regions', () => {
  const files = has ? readdirSync(DIR).filter(f => f.endsWith('.glb')) : []
  it('cover every Chinese weapon model (degrees 1-4 as exported)', () => {
    expect(files.length).toBeGreaterThanOrEqual(20)
  })
  for (const f of files) {
    it(f, async () => {
      const base = f.replace('.glb', '')
      const kind = KIND[base.replace(/_\d+$/, '')]!
      const side = JSON.parse(readFileSync(join(DIR, base + '.json'), 'utf8')) as { dummies?: Record<string, number[]> }
      const d = (n: string): Vec3 | null => {
        const p = side.dummies?.[n]
        return p ? { x: p[0]!, y: p[1]!, z: p[2]! } : null
      }
      const pos = await positions(join(DIR, f))
      const r = weaponRegion(pos, d('ai_start'), d('ai_end'), regionKindOf(kind))!
      expect(r).not.toBeNull()
      // the model's box
      const lo = [Infinity, Infinity, Infinity]
      const hi = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, pos[i + k]!)
        hi[k] = Math.max(hi[k]!, pos[i + k]!)
      }
      const inside = (p: Vec3) => [p.x, p.y, p.z].every((c, k) => c >= lo[k]! - TOL && c <= hi[k]! + TOL)
      // base and tip on the model, the region's box inside it
      expect(inside(r.base), `${f} base`).toBe(true)
      expect(inside(r.tip), `${f} tip`).toBe(true)
      expect(inside(r.min) && inside(r.max), `${f} box`).toBe(true)
      // the region runs along the model's long axis and ends at its tip (span reaches 1, nothing past it)
      expect(r.span[1]).toBeLessThanOrEqual(1.06)
      expect(r.span[1]).toBeGreaterThanOrEqual(0.94)
      // the shell is no wider than the model across
      expect(r.halfWidth * 2).toBeLessThanOrEqual(Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) + TOL)
      if (kind === 'spear' || kind === 'glaive') {
        // the head only: well short of the whole pole, the shaft below it
        expect(r.span[0], `${f} shaft below the head`).toBeLessThan(-0.5)
      }
    })
  }
})

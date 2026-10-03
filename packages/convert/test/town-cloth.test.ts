/**
 * TL-M (docs/TOWN_LIFE.md §5.1; docs/WAVE_PLAN7.md §6.1): the converter's cloth reclass (src/world/town/cloth.ts).
 *
 * - A placed model named in CLOTH_MATERIALS gets its materials' cloth records (kind, and the pin band where the rule
 *   gives one); an unplaced model, a failed one, or a model the list does not name gets none.
 * - Through the pipeline (runWorldPasses, the cloth step) every rule's record is accepted: no warning.
 * - On the real export (skipped without it): every rule for a model the export holds names a material its glb has, and a
 *   pinned rule's band holds vertices of that material (the band is not empty).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import type { WorldManifest, WorldModel, WorldPlacement } from '../src/world/manifest.ts'
import { runWorldPasses, type ClothReclass, type WorldPassContext } from '../src/world/passes.ts'
import { CLOTH_MATERIALS, clothModelBase, createClothPass } from '../src/world/town/cloth.ts'

const model = (index: number, source: string, kind: WorldModel['kind'] = 'static'): WorldModel => ({
  index, source, glb: `models/${index}.glb`, sidecar: `models/${index}.json`, kind,
  animations: [], defaultClip: null, lightmappedMeshes: 0, boundsMin: [-1, 0, -1], boundsMax: [1, 5, 1], bytes: 100, validatorErrors: 0,
})

const placement = (uid: number, models: number[]): WorldPlacement => ({
  objId: 100 + uid, source: `res\\obj${uid}.bsr`, models, compound: false,
  position: [uid, 0, -uid], rotation: [0, 0, 0, 1], yaw: 0,
  flags: { static: true, big: false, struct: false }, staticFlag: 0xffff,
  uid, region: 1, group: 3, inConvertedRegion: true,
})

function fixture() {
  const models = [
    model(0, 'res\\bldg\\china\\jangan01\\cj_streetstall.bsr'),
    model(1, 'res\\bldg\\china\\dunhuang\\milicamp\\W_CD_mc_tent.bsr'),
    model(2, 'res\\bldg\\china\\jangan01\\cj_resta01.bsr'),
    model(3, 'res\\artifact\\china\\dunhuang\\w_etc02.bsr'), // listed, not placed
    model(4, 'res\\bldg\\china\\jangan01\\cj_luxury.bsr'), // not listed
    model(5, 'res\\bldg\\common\\thief-vill\\thief_vill_stent_01.bsr', 'failed'),
  ]
  const placements = [placement(1, [0]), placement(2, [1]), placement(3, [2]), placement(4, [4]), placement(5, [5])]
  return { models, placements }
}

const ctxOf = (models: WorldModel[], placements: WorldPlacement[]): WorldPassContext =>
  ({ outDir: '.', origin: { x: 168, z: 97 }, regions: [], tiles: [], models, placements, warnings: [], log: () => {} })

describe('the cloth reclass list (TL-M)', () => {
  it('reclasses the placed models it names, with the pin band where the rule has one', () => {
    const { models, placements } = fixture()
    const out = createClothPass()(ctxOf(models, placements)) as ClothReclass[]
    const by = new Map(out.map(e => [e.model, e.cloth]))
    expect([...by.keys()].sort()).toEqual([0, 1, 2])
    expect(by.get(0)).toEqual([{ material: 'CJ_StreetStall_02', kind: 'tent', pinY: 1.95, height: 3.4 }])
    expect(by.get(1)).toEqual([{ material: 'W_CD_mc_buil01_flag', kind: 'hanging', pinY: 5.8, height: 0.95 }])
    expect(by.get(2)).toEqual([{ material: 'CJ_resta01_flag', kind: 'hanging' }])
  })

  it('every rule is well formed (a base name, both or neither of pinY / height, height > 0)', () => {
    const seen = new Set<string>()
    for (const r of CLOTH_MATERIALS) {
      expect(r.model).toBe(clothModelBase(r.model))
      expect(r.material.length).toBeGreaterThan(0)
      expect(r.pinY === undefined).toBe(r.height === undefined)
      if (r.height !== undefined) expect(r.height).toBeGreaterThan(0)
      const key = `${r.model}/${r.material.toLowerCase()}`
      expect(seen.has(key), key).toBe(false)
      seen.add(key)
    }
    expect(clothModelBase('res\\Nature\\Tree\\TRE_maple01.bsr#static')).toBe('tre_maple01')
  })

  it('the pipeline accepts every record (no warning) and writes models[].cloth', async () => {
    const { models, placements } = fixture()
    const warnings: string[] = []
    const res = await runWorldPasses({ outDir: '.', origin: { x: 168, z: 97 }, regions: [], tiles: [], models, placements, warnings }, { cloth: createClothPass() })
    expect(warnings).toEqual([])
    expect(res.models.filter(m => m.cloth).map(m => m.index)).toEqual([0, 1, 2])
    expect(res.models[4]!.cloth).toBeUndefined()
  })
})

// ---- the real export -----------------------------------------------------------------------------------------------

const EXPORT = join(REPO_ROOT, 'work', 'out', 'world', 'jangan-fields')
const hasExport = existsSync(join(EXPORT, 'manifest.json'))

/** A glb's materials and, per material, its primitives' vertex heights (model space). */
function glbMaterials(file: string): Map<string, number[]> {
  const b = readFileSync(file)
  const jl = b.readUInt32LE(12)
  const j = JSON.parse(b.subarray(20, 20 + jl).toString('utf8')) as {
    meshes: Array<{ primitives: Array<{ attributes: { POSITION: number }; material?: number }> }>
    materials: Array<{ name: string }>
    accessors: Array<{ bufferView: number; byteOffset?: number; count: number; componentType: number }>
    bufferViews: Array<{ byteOffset?: number; byteStride?: number }>
  }
  const bin = 20 + jl + 8
  const out = new Map<string, number[]>()
  for (const m of j.materials ?? []) out.set(m.name.toLowerCase(), [])
  for (const me of j.meshes) for (const p of me.primitives) {
    if (p.material === undefined) continue
    const a = j.accessors[p.attributes.POSITION]!
    const ys = out.get(j.materials[p.material]!.name.toLowerCase())!
    // Float positions only (a quantized export has no plain heights to read: the material check still runs).
    if (a.componentType !== 5126) continue
    const bv = j.bufferViews[a.bufferView]!
    const stride = bv.byteStride ?? 12
    const off = bin + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
    for (let i = 0; i < a.count; i++) ys.push(b.readFloatLE(off + i * stride + 4))
  }
  return out
}

describe.skipIf(!hasExport)('the cloth list against the real export (work/out/world/jangan-fields)', () => {
  it('every rule for a model in the export names a material its glb has; a pin band holds that material\'s vertices', () => {
    const m = JSON.parse(readFileSync(join(EXPORT, 'manifest.json'), 'utf8')) as WorldManifest
    let checked = 0
    for (const r of CLOTH_MATERIALS) {
      const md = m.models.find(x => x.glb && clothModelBase(x.source) === r.model)
      if (!md) continue
      const file = [join(EXPORT, md.glb!), join(REPO_ROOT, 'work', 'out', md.glb!)].find(existsSync)
      if (!file) continue
      const mats = glbMaterials(file)
      expect(mats.has(r.material.toLowerCase()), `${r.model}: ${r.material}`).toBe(true)
      if (r.pinY !== undefined && r.height !== undefined) {
        const ys = mats.get(r.material.toLowerCase())!
        if (ys.length) {
          const lo = r.kind === 'tent' ? r.pinY : r.pinY - r.height * 1.02
          const hi = r.kind === 'tent' ? r.pinY + r.height : r.pinY
          expect(ys.some(y => y > lo + 0.05 && y < hi - 0.05), `${r.model}: band ${lo}–${hi}`).toBe(true)
        }
      }
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(3)
  })
})

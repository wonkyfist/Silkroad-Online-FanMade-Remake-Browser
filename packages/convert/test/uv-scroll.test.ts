/**
 * Wave 12, UV scroll (gltf/convert.ts `textureScrolls`, `materialScroll`, `SidecarMaterial.uvScroll`): the converter
 * exports the BSR's always-on `texAni` translation rate on the sidecar material (additive: no other field changes),
 * only from the AMBIENT system sets, only on the diffuse stage, validated (finite, |rate| ≤ UV_SCROLL_LIMIT). With the
 * client data: the dragon fountain's five waterfall parts carry their retail rates, a material without a texAni has no
 * field, and the turtle's multi-texture scroll is reported, not exported.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BsrModData, BsrModDataSet, BsrResource } from '@sro/formats'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { UV_SCROLL_LIMIT, convertResource, materialScroll, textureScrolls } from '../src/gltf/convert.ts'

const HAS_CONFIG = existsSync(join(REPO_ROOT, 'sro.config.json'))

function texAni(mtrlIndex: number, u: number, v: number, stage = 0, extra: Partial<Record<number, number>> = {}): BsrModData {
  const matrix = new Array<number>(16).fill(0)
  matrix[8] = u
  matrix[9] = v
  for (const [k, x] of Object.entries(extra)) matrix[Number(k)] = x!
  return {
    kind: 'texAni', tag: 0x10000, offset: 0, float0: 0.5, int0: 2, int1: 0, mtrlIndex, int3: 0, int4: 0, bytes: [0, 0, 0, 0],
    unknown: [stage, 1, 10, 1, 1], matrix,
  }
}

function set(name: string, typeName: string | undefined, mods: BsrModData[]): BsrModDataSet {
  return { type: typeName === 'AMBIENT' ? 2 : 1, typeName, animationType: -1, animationTypeName: undefined, name, mods }
}

const res = (systemSets: BsrModDataSet[], aniSets: BsrModDataSet[] = []): Pick<BsrResource, 'modPalette'> => ({ modPalette: { systemSets, aniSets } })

describe('textureScrolls: the always-on texAni rates of a resource', () => {
  it('reads matrix[8] / matrix[9] of the AMBIENT sets, float32 tidied; other sets and other mods are not scrolls', () => {
    const w: string[] = []
    const out = textureScrolls(res([
      set('ambient', 'AMBIENT', [texAni(-1, 0, Math.fround(-2.78))]),
      set('status_burn', 'SIMPLE', [texAni(0, 1, 0)]),
    ], [set('default', 'SIMPLE', [texAni(0, 0, 1)])]), w)
    expect(out).toEqual([{ mtrlIndex: -1, u: 0, v: -2.78, stage: 'diffuse' }])
    expect(w).toEqual([])
  })

  it('validates: non-finite or out-of-range rates are dropped with a warning, a zero rate is no scroll, a rotation is reported', () => {
    const w: string[] = []
    const out = textureScrolls(res([set('ambient', 'AMBIENT', [
      texAni(0, NaN, 1),
      texAni(0, 0, UV_SCROLL_LIMIT * 2),
      texAni(0, 0, 0),
      texAni(1, 0.5, 0, 0, { 0: 0.1 }),
      texAni(0, 0, 0.17, 1),
    ])]), w)
    expect(out).toEqual([{ mtrlIndex: 1, u: 0.5, v: 0, stage: 'diffuse' }, { mtrlIndex: 0, u: 0, v: 0.17, stage: 'multiTex' }])
    expect(w).toHaveLength(3)
    expect(w[0]).toMatch(/not a texture scroll/)
    expect(w[1]).toMatch(/not a texture scroll/)
    expect(w[2]).toMatch(/only the transform's translation/)
  })

  it('materialScroll: -1 drives every material, k only the k-th; a multi-texture stage never; the first of two wins', () => {
    const all = [{ mtrlIndex: -1, u: 0, v: -1, stage: 'diffuse' as const }]
    expect(materialScroll(all, 0)).toEqual([0, -1])
    expect(materialScroll(all, 3)).toEqual([0, -1])
    const one = [{ mtrlIndex: 1, u: 0.5, v: 0, stage: 'diffuse' as const }, { mtrlIndex: 0, u: 0, v: 0.17, stage: 'multiTex' as const }]
    expect(materialScroll(one, 0)).toBeNull()
    expect(materialScroll(one, 1)).toEqual([0.5, 0])
    const w: string[] = []
    expect(materialScroll([...all, { mtrlIndex: 0, u: 1, v: 1, stage: 'diffuse' }], 0, w)).toEqual([0, -1])
    expect(w).toHaveLength(1)
  })
})

describe.skipIf(!HAS_CONFIG)('the export carries the scroll (client data)', () => {
  const data = HAS_CONFIG ? openArchive('Data') : null
  const convert = (path: string) => convertResource(path, { read: p => data!.read(p) }).sidecar

  it('the dragon fountain waterfall (cj_wf_dr.cpd parts 01..05) flows at its retail rates', () => {
    const rates: Record<string, [number, number]> = {
      cj_wf_dr_01: [0, -2.78], cj_wf_dr_02: [0, -2.3], cj_wf_dr_03: [0, -2], cj_wf_dr_04: [0, -2.29], cj_wf_dr_05: [0, -2],
    }
    for (const [name, rate] of Object.entries(rates)) {
      const side = convert(`res\\nature\\particle\\${name}.bsr`)
      expect(side.materials.map(m => m.uvScroll), name).toEqual([rate])
      expect(side.warnings, name).toEqual([])
    }
  })

  it('additive: a material without a texAni has no uvScroll field; the multi-texture scroll is reported, not exported', () => {
    const plain = convert('res\\bldg\\china\\dunhuang\\ferry\\naruter_buil.bsr')
    for (const m of plain.materials) expect('uvScroll' in m).toBe(false)
    const turtle = convert('res\\nature\\particle\\waterfall-turtle01-3.bsr')
    expect(turtle.materials.map(m => m.uvScroll)).toEqual([undefined])
    expect(turtle.warnings.some(x => /multi-texture stage/.test(x))).toBe(true)
  })
})

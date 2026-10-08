// Equipment export against the real client (skips without sro.config.json): every glb validates, skinned items
// bind to the character skeleton by joint name, and the starter sets hide exactly what they replace with no gaps.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NodeIO, type Document } from '@gltf-transform/core'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { convertResource } from '../src/gltf/convert.ts'
import { composeEquipment, missingJoints } from '../src/equipment/compose.ts'
import { gapReport, pokeReport, triangles, type MeshGeometry } from '../src/equipment/coverage.ts'
import { bodyGaps, exportEquipment, type ExportResult } from '../src/equipment/export.ts'
import type { EquipmentItem } from '../src/equipment/manifest.ts'

const HAS_CONFIG = existsSync(join(REPO_ROOT, 'sro.config.json'))
const CHARS = { male: 'CHAR_CH_MAN_ADVENTURER', female: 'CHAR_CH_WOMAN_ADVENTURER' } as const

/** Research result: the base meshes each creation-default set hides (REPLACE slots of its BA/LA/FA resources). */
const STARTER_HIDES: Record<string, string[]> = {
  M_CLOTHES: ['man_calf', 'man_pelvis', 'man_thigh', 'man_torso_lower', 'man_torso_upper'],
  M_LIGHT: ['man_calf', 'man_pelvis', 'man_thigh', 'man_torso_lower', 'man_torso_upper'],
  M_HEAVY: ['man_arm_upper', 'man_calf', 'man_pelvis', 'man_thigh', 'man_torso_lower', 'man_torso_upper'],
  W_CLOTHES: ['woman_calf', 'woman_pelvis', 'woman_torso_lower', 'woman_torso_upper'],
  W_LIGHT: ['woman_calf', 'woman_pelvis', 'woman_torso_upper'],
  W_HEAVY: ['woman_arm_upper', 'woman_calf', 'woman_pelvis', 'woman_thigh', 'woman_torso_upper'],
}

function geometry(doc: Document, name: string): MeshGeometry {
  const node = doc.getRoot().listNodes().find(n => n.getName() === name && n.getMesh())
  if (!node) throw new Error(`no mesh node ${name}`)
  const prim = node.getMesh()!.listPrimitives()[0]!
  return {
    name,
    positions: prim.getAttribute('POSITION')!.getArray()!,
    normals: prim.getAttribute('NORMAL')!.getArray()!,
    indices: prim.getIndices()!.getArray()!,
  }
}

describe.skipIf(!HAS_CONFIG)('equipment export (real client)', () => {
  let out: string
  let result: ExportResult
  const io = new NodeIO()
  const characters = new Map<string, Document>()
  const glbs = new Map<string, Document>()
  const docFor = async (url: string) => {
    let doc = glbs.get(url)
    if (!doc) {
      doc = await io.readBinary(new Uint8Array(readFileSync(join(out, ...url.replace(/^\/out\//, '').split('/')))))
      glbs.set(url, doc)
    }
    return doc
  }

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'sro-equipment-'))
    const data = openArchive('Data')
    result = await exportEquipment({ data, media: openArchive('Media'), outRoot: out, noIndex: true })
    for (const code of Object.values(CHARS)) {
      const c = result.manifest.characters.find(ch => ch.code === code)!
      characters.set(code, convertResource(c.bsr, { read: p => data.read(p) }).document)
    }
  }, 60_000) // degree 4 (CLIMB §4.1.2) adds 42 models: about 4 s alone, past 10 s under the full suite
  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true })
  })

  it('selects both genders, all six armour parts, shields and weapons of degrees 1-4 (4: CLIMB §4.1.2)', () => {
    const { items, characters: chars } = result.manifest
    expect(chars).toHaveLength(26)
    const armour = items.filter(i => i.armorClass)
    // 2 genders x 3 classes x 4 degrees x 7 parts (HA CA SA BA LA AA FA) x A/B/C + 18 creation defaults.
    expect(armour).toHaveLength(2 * 3 * 4 * 7 * 3 + 18)
    // 12 plus the creation-default shield.
    expect(items.filter(i => i.slot === 'shield')).toHaveLength(12 + 1)
    expect(items.filter(i => i.slot === 'weapon')).toHaveLength(5 * 12 + 5)
    // CA head items ("crown") have no model; every other item has one.
    expect(items.filter(i => !i.model).every(i => /_CA_/.test(i.code))).toBe(true)
    expect(items.filter(i => /_CA_/.test(i.code)).every(i => !i.model)).toBe(true)
    // All men share one body and skeleton, all women another.
    for (const g of ['male', 'female'] as const) {
      const bodies = chars.filter(c => c.gender === g)
      expect(bodies).toHaveLength(13)
      expect(new Set(bodies.map(c => c.skeleton)).size).toBe(1)
      const parts = (c: (typeof bodies)[number]) => JSON.stringify(Object.entries(c.slots).filter(([s]) => s !== 'HAIR' && s !== 'FACE').sort())
      expect(new Set(bodies.map(parts)).size).toBe(1)
    }
  })

  it('every converted glb validates with 0 errors', () => {
    expect(result.assets.length).toBeGreaterThan(100)
    for (const a of result.assets) expect(a.errors, `${a.bsr}: ${a.issues.join(', ')}`).toBe(0)
  })

  it('skinned items bind to the character skeleton by joint name, with the same inverse binds', async () => {
    const models = new Map<string, { item: EquipmentItem }>()
    for (const item of result.manifest.items) if (item.model?.kind === 'skinned') models.set(item.model.glb, { item })
    expect(models.size).toBeGreaterThan(90)
    for (const [url, { item }] of models) {
      const character = characters.get(CHARS[item.gender!])!
      const charSkin = character.getRoot().listSkins()[0]!
      const charJoints = charSkin.listJoints().map(j => j.getName())
      const charIbm = charSkin.getInverseBindMatrices()!.getArray()!
      const doc = await docFor(url)
      const skins = doc.getRoot().listSkins()
      expect(skins, url).toHaveLength(1)
      const joints = skins[0]!.listJoints().map(j => j.getName())
      expect(missingJoints(joints, charJoints), url).toEqual([])
      expect(joints, url).toEqual(charJoints)
      expect(item.model!.joints).toEqual(charJoints)
      const ibm = skins[0]!.getInverseBindMatrices()!.getArray()!
      let maxDiff = 0
      for (let i = 0; i < ibm.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ibm[i]! - charIbm[i]!))
      expect(maxDiff, url).toBeLessThan(1e-5)
      // Every mesh is skinned, at the scene root, and its influences reference existing joints with weight 1.
      for (const name of item.model!.meshes) {
        const node = doc.getRoot().listNodes().find(n => n.getName() === name && n.getMesh())!
        expect(node.getSkin(), `${url} ${name}`).toBe(skins[0])
        expect(node.getParentNode(), `${url} ${name}`).toBeNull()
        const prim = node.getMesh()!.listPrimitives()[0]!
        const j = prim.getAttribute('JOINTS_0')!.getArray()!
        const w = prim.getAttribute('WEIGHTS_0')!.getArray()!
        for (let v = 0; v < j.length; v += 4) {
          expect(w[v]! + w[v + 1]! + w[v + 2]! + w[v + 3]!).toBeCloseTo(1, 5)
          for (let k = 0; k < 4; k++) expect(j[v + k]!).toBeLessThan(joints.length)
        }
      }
    }
  })

  it('rigid items name an attach bone that both skeletons have', () => {
    const rigid = result.manifest.items.filter(i => i.model?.kind === 'socket')
    expect(rigid.length).toBeGreaterThan(50)
    for (const item of rigid) {
      for (const [gender, code] of Object.entries(CHARS)) {
        if (item.gender && item.gender !== gender) continue
        const names = characters.get(code)!.getRoot().listSkins()[0]!.listJoints().map(j => j.getName())
        expect(names, item.code).toContain(item.model!.attachBone)
      }
    }
    expect(result.manifest.items.find(i => i.code === 'ITEM_CH_SHIELD_01_A')!.model!.attachBone).toBe('Bip01 L Hand')
  })

  it('equipment materials: alpha test or opaque (never BLEND), emissive modulated by the texture', async () => {
    // Heavy armour alpha is a mask: most of the surface is below the 128 reference, so it must stay opaque.
    const masks = result.alpha.filter(d => d.mode === 'OPAQUE')
    expect(masks.length).toBeGreaterThan(20)
    for (const d of masks) expect(d.below, `${d.bsr} ${d.material}`).toBeGreaterThan(0.5)
    for (const d of result.alpha.filter(a => a.mode === 'MASK')) expect(d.below, `${d.bsr} ${d.material}`).toBeLessThanOrEqual(0.5)
    for (const item of result.manifest.items) {
      if (!item.model) continue
      const doc = await docFor(item.model.glb)
      for (const m of doc.getRoot().listMaterials()) {
        expect(m.getAlphaMode(), `${item.model.glb} ${m.getName()}`).not.toBe('BLEND')
        if (m.getEmissiveFactor().some(c => c > 0) && m.getBaseColorTexture()) expect(m.getEmissiveTexture()).toBe(m.getBaseColorTexture())
      }
    }
    const heavy = await docFor(result.manifest.items.find(i => i.code === 'ITEM_CH_M_HEAVY_01_BA_A_DEF')!.model!.glb)
    expect(heavy.getRoot().listMaterials().map(m => m.getAlphaMode())).toEqual(['OPAQUE'])
  })

  it('every REPLACE model covers the body parts it hides (no gaps outside the hair)', () => {
    expect(result.coverage.length).toBeGreaterThan(70)
    // retail's own gap (CLIMB §4.1.2): woman clothes_04_la leaves 1 pelvis vertex of 73 uncovered by 7 cm; kept as shipped
    const KNOWN: Record<string, number> = { 'res/item/china/woman_item/clothes_04_la.bsr': 1 }
    for (const c of result.coverage) expect(bodyGaps(c.reports), `${c.bsr} ${JSON.stringify(c.reports)}`).toBe(KNOWN[c.bsr] ?? 0)
  })

  for (const [set, expected] of Object.entries(STARTER_HIDES)) {
    it(`starter set ${set}: hides exactly ${expected.length} parts, no gaps, little poke-through (measured on the glbs)`, async () => {
      const [g, cls] = set.split('_') as ['M' | 'W', string]
      const code = g === 'M' ? CHARS.male : CHARS.female
      const items = ['BA', 'LA', 'FA'].map(p => `ITEM_CH_${g}_${cls}_01_${p}_A_DEF`)
      const comp = composeEquipment(result.manifest, code, items)
      expect(comp.rejected).toEqual([])
      expect([...comp.hide].sort()).toEqual(expected)
      expect(comp.bind.map(b => b.code)).toEqual(items)
      const character = characters.get(code)!
      const itemGeometry: MeshGeometry[] = []
      for (const b of comp.bind) for (const m of b.meshes) itemGeometry.push(geometry(await docFor(b.glb), m))
      const visibleBody = comp.show.map(m => geometry(character, m))
      const union = triangles([...itemGeometry, ...visibleBody])
      for (const hidden of comp.hide) {
        const r = gapReport(geometry(character, hidden), union)
        expect(r.gaps, `${hidden} vertices ${r.gapVertices.join(',')}`).toBe(0)
        expect(r.checked).toBeGreaterThan(0.6 * r.vertices)
        expect(r.maxOffset, hidden).toBeLessThan(0.06)
      }
      const armour = triangles(itemGeometry)
      for (const g2 of visibleBody) {
        const r = pokeReport(g2, armour)
        // Measured: at most 27 of 160 upper-arm vertices sit within 2 cm outside a sleeve (protector); garments <= 14.
        expect(r.poke / r.vertices, g2.name).toBeLessThan(cls === 'CLOTHES' ? 0.1 : 0.2)
      }
    })
  }
})

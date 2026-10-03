/**
 * Builds the equipment set: selects the items from itemdata, converts their models (skinned armour through
 * ./skinned-item.ts, rigid shields and weapons through gltf/convert.ts), validates every glb, measures body
 * coverage, and writes <out>/equipment/** plus equipment.json. CLI: tools/export-equipment.ts.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { normalizePk2Path, parseBms, parseBsk, parseBsr, type BmsMesh, type CharacterDataRow, type ItemDataRow, type Pk2Archive } from '@sro/formats'
import type { EquipSlot } from '../../../shared/src/content.ts'
import { convertedPaths, loadGameDataSources, resourcePath, selectCreationCharacters } from '../data/game-data.ts'
import { textdataReader } from '../data/textdata-source.ts'
import { convertResource, type ReadFile, type Sidecar } from '../gltf/convert.ts'
import { toGltfDirections, toGltfIndices, toGltfPositions } from '../gltf/space.ts'
import { summarizeIssues, validateGlb } from '../gltf/validate.ts'
import { mergeIndex, type IndexEntry } from '../tools/make-test-glb.ts'
import { gapReport, triangles, type MeshGeometry } from './coverage.ts'
import {
  EQUIPMENT_DIR,
  EQUIPMENT_MANIFEST,
  EQUIPMENT_MANIFEST_VERSION,
  EQUIPMENT_PROVENANCE,
  MANIFEST_RULES,
  type ArmorClass,
  type AttachMethod,
  type CharacterBody,
  type CoverageReport,
  type EquipmentItem,
  type EquipmentManifest,
  type EquipmentModel,
  type EquipmentSidecar,
  type Gender,
  type VisualSlot,
} from './manifest.ts'
import { fixEquipmentAlpha, fixEquipmentEmissive, type AlphaDecision } from './materials.ts'
import { convertSkinnedItem } from './skinned-item.ts'

export const GENERATOR = 'silkroad-web convert (packages/convert/src/equipment)'

/** Chinese armour (degrees 1-3, parts HA CA SA BA LA AA FA, A/B/C and the creation defaults). */
export const ARMOR_CODE = /^ITEM_CH_([MW])_(CLOTHES|LIGHT|HEAVY)_0([1-3])_(HA|CA|SA|BA|LA|AA|FA)_[ABC](_DEF)?$/
export const SHIELD_CODE = /^ITEM_CH_SHIELD_0([1-3])_[ABC](_DEF)?$/
export const WEAPON_CODE = /^ITEM_CH_(SWORD|BLADE|SPEAR|TBLADE|BOW)_0([1-3])_[ABC](_DEF)?$/

/** itemdata TypeID4 of Chinese armour -> equip slot (openroad textdata-itemdata; checked against the part suffix). */
export const ARMOR_SLOT_BY_TID4: Readonly<Record<number, EquipSlot>> = { 1: 'head', 2: 'shoulders', 3: 'chest', 4: 'legs', 5: 'hands', 6: 'feet' }
const PART_SLOT: Readonly<Record<string, EquipSlot>> = { HA: 'head', CA: 'head', SA: 'shoulders', BA: 'chest', LA: 'legs', AA: 'hands', FA: 'feet' }
/** itemdata TypeID3 of Chinese armour -> class. */
export const ARMOR_CLASS_BY_TID3: Readonly<Record<number, ArmorClass>> = { 1: 'garment', 2: 'protector', 3: 'armor' }
const CLASS_TOKEN: Readonly<Record<string, ArmorClass>> = { CLOTHES: 'garment', LIGHT: 'protector', HEAVY: 'armor' }

const SLOT_NAMES: readonly VisualSlot[] = [
  'HAIR', 'FACE', 'TORSO_UPPER', 'TORSO_LOWER', 'OVERRIDE', 'ARM_UPPER', 'ARM_LOWER',
  'LEFT_HAND', 'RIGHT_HAND', 'SPEAR', 'PELVIS', 'THIGH', 'CALF', 'ATTACH_CAPE',
]
function visualSlots(names: ReadonlyArray<string | undefined>): VisualSlot[] {
  return [...new Set(names.filter((n): n is VisualSlot => !!n && (SLOT_NAMES as readonly string[]).includes(n)))]
}

function fileBase(path: string): string {
  return (path.replace(/\\/g, '/').split('/').pop() ?? path).replace(/\.[^.]*$/, '')
}

/** Mesh node names gltf/convert.ts gives a resource (BMS name, deduplicated against the bone names). */
export function meshNodeNames(meshes: ReadonlyArray<{ path: string; bms: BmsMesh | null }>, boneNames: readonly string[]): Array<string | null> {
  const used = new Set(boneNames)
  return meshes.map(({ path, bms }) => {
    if (!bms) return null
    const base = bms.name || fileBase(path)
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`
    used.add(name)
    return name
  })
}

/** Bind-pose geometry of a BMS in glTF space (the same conversion gltf/convert.ts applies). */
export function bmsGeometry(name: string, bms: BmsMesh): MeshGeometry {
  return { name, positions: toGltfPositions(bms.positions), normals: toGltfDirections(bms.normals), indices: toGltfIndices(bms.indices) }
}

export interface ExportOptions {
  data: Pk2Archive
  media: Pk2Archive
  outRoot: string
  log?: (line: string) => void
  /** Skip index.json (tests). */
  noIndex?: boolean
}

export interface ExportResult {
  manifest: EquipmentManifest
  manifestFile: string
  assets: Array<{ bsr: string; glbFile: string; bytes: number; errors: number; warnings: number; issues: string[] }>
  coverage: Array<{ bsr: string; gender: Gender; reports: CoverageReport[] }>
  /** Alpha mode re-decided per material (equipment/materials.ts). */
  alpha: Array<AlphaDecision & { bsr: string }>
}

interface BodyInfo {
  gender: Gender
  skeleton: string
  boneNames: string[]
  /** Visual slot -> { node name, geometry }. */
  parts: Map<VisualSlot, { name: string; geometry: MeshGeometry }>
}

function genderOfItem(r: ItemDataRow): Gender | null {
  return r.reqGender === 1 ? 'male' : r.reqGender === 0 ? 'female' : null
}

export async function exportEquipment(opts: ExportOptions): Promise<ExportResult> {
  const { data, media, outRoot } = opts
  const log = opts.log ?? (() => {})
  const read: ReadFile = p => data.read(p)
  const src = loadGameDataSources(textdataReader(media))
  const text = (key: string | undefined) => (key ? src.strings.get(key) ?? null : null)

  // ---- characters --------------------------------------------------------------------------------
  const { selected } = selectCreationCharacters(src.characters, src.strings)
  const characters: CharacterBody[] = []
  const bodies = new Map<Gender, BodyInfo>()
  for (const { row } of selected as Array<{ row: CharacterDataRow }>) {
    const bsrPath = resourcePath(row.assocFileObj!)
    const bsr = parseBsr(read(bsrPath))
    if (!bsr.skeleton || !bsr.attachable) throw new Error(`${bsrPath}: no skeleton or attachable section`)
    const skeleton = normalizePk2Path(bsr.skeleton.path)
    const boneNames = parseBsk(read(bsr.skeleton.path)).bones.map(b => b.name)
    const meshes = bsr.meshes.map(m => {
      try {
        return { path: m.path, bms: parseBms(read(m.path)) }
      } catch {
        return { path: m.path, bms: null }
      }
    })
    const names = meshNodeNames(meshes, boneNames)
    const gender: Gender = /^CHAR_CH_MAN_/.test(row.codeName) ? 'male' : 'female'
    const slots: CharacterBody['slots'] = {}
    const parts = new Map<VisualSlot, { name: string; geometry: MeshGeometry }>()
    for (const s of bsr.attachable.slots) {
      const slot = visualSlots([s.slotName])[0]
      const name = names[s.meshIndex]
      const bms = meshes[s.meshIndex]?.bms
      if (!slot || !name || !bms) continue
      slots[slot] = name
      parts.set(slot, { name, geometry: bmsGeometry(name, bms) })
    }
    characters.push({ code: row.codeName, gender, bsr: bsrPath, glb: convertedPaths(bsrPath).glb, skeleton, slots })
    const body = bodies.get(gender)
    if (!body) bodies.set(gender, { gender, skeleton, boneNames, parts })
    else if (body.skeleton !== skeleton) throw new Error(`${row.codeName}: skeleton ${skeleton} differs from ${body.skeleton}`)
  }

  // ---- items -------------------------------------------------------------------------------------
  interface Pending { item: EquipmentItem; bsr: string | null }
  const pending: Pending[] = []
  for (const r of src.items) {
    if (!r.service || r.country !== 0) continue
    const reqLevel = r.reqLevels[0]!.type === -1 ? 0 : r.reqLevels[0]!.level
    const bsr = r.assocFileObj ? resourcePath(r.assocFileObj) : null
    const base = { code: r.codeName, degree: r.degree, reqLevel, name: text(r.nameStrId), model: null }
    let m: RegExpExecArray | null
    if ((m = ARMOR_CODE.exec(r.codeName))) {
      const [t1, t2, t3, t4] = r.typeId
      const slot = ARMOR_SLOT_BY_TID4[t4]
      const armorClass = ARMOR_CLASS_BY_TID3[t3]
      if (t1 !== 3 || t2 !== 1 || !slot || !armorClass) throw new Error(`${r.codeName}: unexpected TypeID ${r.typeId.join('/')}`)
      if (slot !== PART_SLOT[m[4]!] || armorClass !== CLASS_TOKEN[m[2]!]) throw new Error(`${r.codeName}: TypeID ${r.typeId.join('/')} contradicts the code`)
      const gender = genderOfItem(r)
      if (gender !== (m[1] === 'M' ? 'male' : 'female')) throw new Error(`${r.codeName}: ReqGender ${r.reqGender} contradicts the code`)
      pending.push({ item: { ...base, slot, gender, armorClass }, bsr })
    } else if ((m = SHIELD_CODE.exec(r.codeName))) {
      if (!bsr) throw new Error(`${r.codeName}: no model`)
      pending.push({ item: { ...base, slot: 'shield', gender: genderOfItem(r) }, bsr })
    } else if ((m = WEAPON_CODE.exec(r.codeName))) {
      if (!bsr) throw new Error(`${r.codeName}: no model`)
      pending.push({ item: { ...base, slot: 'weapon', gender: genderOfItem(r), weapon: m[1]!, twoHanded: r.twoHanded }, bsr })
    }
  }

  // ---- convert each model once -------------------------------------------------------------------
  const io = new NodeIO()
  const models = new Map<string, EquipmentModel>()
  const assets: ExportResult['assets'] = []
  const coverage: ExportResult['coverage'] = []
  const alphaDecisions: ExportResult['alpha'] = []
  const indexEntries: IndexEntry[] = []
  const codesByBsr = new Map<string, string[]>()
  for (const p of pending) if (p.bsr) codesByBsr.set(p.bsr, [...(codesByBsr.get(p.bsr) ?? []), p.item.code])
  for (const p of pending) {
    if (!p.bsr || models.has(p.bsr)) continue
    const bsr = parseBsr(read(p.bsr))
    const a = bsr.attachable
    if (!a) throw new Error(`${p.bsr}: no attachable section`)
    // Rigid when the resource has its own skeleton with an attach bone (shields, weapons, garment collars on Bip01 Neck1).
    const kind: 'skinned' | 'socket' = bsr.skeleton?.attachBone ? 'socket' : 'skinned'
    const method = (a.attachMethodName ?? 'BASE') as AttachMethod
    const slots = visualSlots(a.slots.map(s => s.slotName))
    const rel = convertedPaths(p.bsr).rel
    const outRel = `${EQUIPMENT_DIR}/${rel.replace(/^item\//, '')}`
    let document
    let sidecar: Sidecar
    let joints: string[] = []
    let meshes: string[]
    let hides: string[] = []
    let reports: CoverageReport[] | undefined
    const gender = p.item.gender
    if (kind === 'skinned') {
      const body = bodies.get(gender!)
      if (!body) throw new Error(`${p.bsr}: no ${gender} character`)
      const res = convertSkinnedItem(p.bsr, body.skeleton, read)
      if (res.missingBones.length) throw new Error(`${p.bsr}: bones missing from ${body.skeleton}: ${res.missingBones.join(', ')}`)
      document = res.document
      sidecar = res.sidecar
      joints = res.joints
      meshes = res.meshes
      if (method === 'REPLACE') hides = slots.map(s => body.parts.get(s)?.name).filter((n): n is string => !!n)
      if (hides.length) {
        const itemGeometry = sidecar.meshes.map(m => bmsGeometry(m.name, parseBms(read(m.bms))))
        const visible = [...body.parts].filter(([s]) => !slots.includes(s)).map(([, part]) => part.geometry)
        const tris = triangles([...itemGeometry, ...visible])
        reports = [...body.parts].filter(([s]) => slots.includes(s)).map(([s, part]) => {
          const g = gapReport(part.geometry, tris)
          return { slot: s, mesh: part.name, vertices: g.vertices, gaps: g.gaps, maxOffsetM: Number(g.maxOffset.toFixed(4)) }
        })
        coverage.push({ bsr: p.bsr, gender: gender!, reports })
      }
    } else {
      const res = convertResource(p.bsr, { read })
      if (!res.sidecar.attachBone) throw new Error(`${p.bsr}: rigid item without an attach bone`)
      document = res.document
      sidecar = res.sidecar
      meshes = sidecar.meshes.map(m => m.name)
    }
    const emissive = fixEquipmentEmissive(document)
    if (emissive.length) sidecar.warnings.push(`equipment: base colour texture reused as the emissive texture of ${emissive.join(', ')} (D3D emissive is modulated by the texture)`)
    const alpha = fixEquipmentAlpha(document, sidecar, read)
    alphaDecisions.push(...alpha.map(d => ({ bsr: p.bsr!, ...d })))
    const glb = await io.writeBinary(document)
    const validation = await validateGlb(glb, `${fileBase(p.bsr)}.glb`)
    sidecar.validation = { errors: validation.errors, warnings: validation.warnings, infos: validation.infos, issues: summarizeIssues(validation.messages, 2) }
    const equipment: EquipmentSidecar = {
      code: codesByBsr.get(p.bsr) ?? [],
      bsr: p.bsr,
      gender,
      kind,
      method,
      attachPoint: a.attachPointName ?? null,
      slots,
      attachBone: sidecar.attachBone,
      hides,
      skeleton: kind === 'skinned' ? bodies.get(gender!)!.skeleton : null,
      joints,
      ...(reports ? { coverage: reports } : {}),
      provenance: EQUIPMENT_PROVENANCE,
    }
    const glbFile = join(outRoot, ...outRel.split('/')) + '.glb'
    mkdirSync(dirname(glbFile), { recursive: true })
    writeFileSync(glbFile, glb)
    writeFileSync(join(outRoot, ...outRel.split('/')) + '.json', JSON.stringify({ ...sidecar, generator: GENERATOR, equipment }, null, 2) + '\n')
    assets.push({ bsr: p.bsr, glbFile, bytes: glb.byteLength, errors: validation.errors, warnings: validation.warnings, issues: summarizeIssues(validation.messages, 1) })
    const category = outRel.split('/').slice(0, -1).join('/')
    indexEntries.push({ id: outRel, name: fileBase(p.bsr), category, glb: `${outRel}.glb`, sidecar: `${outRel}.json` })
    models.set(p.bsr, {
      bsr: p.bsr,
      glb: `/out/${outRel}.glb`,
      sidecar: `/out/${outRel}.json`,
      kind,
      method,
      attachPoint: a.attachPointName ?? null,
      slots,
      attachBone: sidecar.attachBone,
      ...(kind === 'skinned' ? { joints } : {}),
      meshes,
    })
    log(`${outRel.padEnd(44)} ${kind.padEnd(7)} ${method.padEnd(7)} [${slots.join(',')}]` +
      (hides.length ? ` hides ${hides.join(',')}` : '') + (sidecar.attachBone ? ` @ ${sidecar.attachBone}` : '') +
      `  ${(glb.byteLength / 1024).toFixed(0)} KiB  validator ${validation.errors}/${validation.warnings}` +
      (reports ? `  gaps ${bodyGaps(reports)}` : ''))
  }

  const items = pending.map(p => ({ ...p.item, model: p.bsr ? models.get(p.bsr) ?? null : null }))
  const manifest: EquipmentManifest = {
    version: EQUIPMENT_MANIFEST_VERSION,
    generator: GENERATOR,
    provenance: EQUIPMENT_PROVENANCE,
    rules: MANIFEST_RULES,
    characters,
    items,
  }
  const manifestFile = join(outRoot, ...EQUIPMENT_MANIFEST.split('/'))
  mkdirSync(dirname(manifestFile), { recursive: true })
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  if (!opts.noIndex && indexEntries.length) mergeIndex(join(outRoot, 'index.json'), indexEntries)
  return { manifest, manifestFile, assets, coverage, alpha: alphaDecisions }
}

/** Coverage gaps outside the hair (see CoverageReport.gaps). */
export function bodyGaps(reports: readonly CoverageReport[]): number {
  return reports.filter(r => r.slot !== 'HAIR').reduce((s, r) => s + r.gaps, 0)
}

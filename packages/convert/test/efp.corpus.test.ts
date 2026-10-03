/**
 * EFP corpus test: every .efp in Particles.pk2 against the parser, the compiler (packages/convert/src/fx) and the
 * @sro/fx simulation. Skips without sro.config.json.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { describe, expect, it } from 'vitest'
import {
  buildStringMap,
  decodeTextdata,
  efpObjects,
  efpResources,
  efpVersion,
  loadTextdataTable,
  parseBms,
  parseEfp,
  skillDataRow,
  skillDetail,
  type EfpFile,
  type Pk2Archive,
} from '@sro/formats'
import { axisAngleMatrix, commandSchedule, compileEfp, eulerMatrix, fxKey } from '../src/fx/compile.ts'
import { effectMeshDocument } from '../src/fx/mesh.ts'
import { buildSkillIndex } from '../src/fx/skills.ts'
import { textdataReader, TEXTDATA_DIR } from '../src/data/textdata-source.ts'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { readGlbMesh } from '../../fx/src/glb.ts'
import { validateFxEffect } from '../../fx/src/program.ts'
import { FxSimulation } from '../../fx/src/simulation.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

/**
 * Version "0000": an unrelated older serialization; no client file references these (see packages/formats/src/efp.ts).
 */
const LEGACY = 'JMXVEFF 0000: not a JMXVEFF object tree, unreferenced by the client, rejected by the native loader'
const PARSE_ALLOWLIST = new Map<string, string>(
  [
    'skill/china/cold_ganggi_motion_a.efp',
    'skill/china/etc_mirage_sword_normal.efp',
    'skill/china/lightning_ganggi_damage_a.efp',
    'skill/china/lightning_ganggi_keep_a.efp',
    'skill/china/lightning_ganggi_keep_b.efp',
    'skill/china/lightning_ganggi_keep_c.efp',
    'skill/china/lightning_ganggi_motion_a.efp',
  ].map(k => [k, LEGACY]),
)

/** Resources effects name that Particles.pk2 does not ship. */
const MISSING_RESOURCES = new Set([
  '',
  'textures/ak_in_chuk_sal.ddj',
  'textures/oura_21_r.ddj',
  'textures/crash_glow.ddj',
  'textures/flower_test.ddj',
  'meshes/nachal_size_test.bms',
  'meshes/season_circle.bms',
])

let corpus: { archive: Pk2Archive; files: Array<[string, EfpFile]>; failures: Array<[string, string]>; total: number } | undefined
function load() {
  if (corpus) return corpus
  const archive = openArchive('Particles')
  const files: Array<[string, EfpFile]> = []
  const failures: Array<[string, string]> = []
  let total = 0
  for (const [key, entry] of archive.files) {
    if (!key.endsWith('.efp')) continue
    total++
    try {
      files.push([key, parseEfp(archive.read(entry))])
    } catch (e) {
      failures.push([key, (e as Error).message])
    }
  }
  corpus = { archive, files, failures, total }
  return corpus
}

const close = (a: readonly number[], b: readonly number[], eps = 1e-4) => a.every((v, i) => Math.abs(v - b[i]!) < eps)
const upper3 = (m: readonly number[]) => [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!]

describe.skipIf(!hasConfig)('EFP corpus (Particles.pk2)', () => {
  it('parses every JMXVEFF 0010-0013 file byte-exactly', () => {
    const { archive, files, failures, total } = load()
    const versions = new Map<string, number>()
    for (const [key, entry] of archive.files) if (key.endsWith('.efp')) versions.set(efpVersion(archive.read(entry)) ?? '?', (versions.get(efpVersion(archive.read(entry)) ?? '?') ?? 0) + 1)
    const rate = files.length / total
    console.log(`EFP: ${files.length}/${total} parse byte-exact (${(rate * 100).toFixed(2)} %); versions ${JSON.stringify([...versions])}`)
    expect(Object.fromEntries(versions)).toEqual({ '0011': 1812, '0012': 147, '0013': 119, '0000': 7, '0010': 1 })
    expect(failures.filter(([k]) => !PARSE_ALLOWLIST.has(k))).toEqual([])
    expect(failures.map(([k]) => k).sort()).toEqual([...PARSE_ALLOWLIST.keys()].sort())
    expect(files.length).toBe(total - PARSE_ALLOWLIST.size)
  })

  it('confirms the layout findings the parser header documents', () => {
    const { files } = load()
    let nodes = 0
    let linkMode = 0
    let linkAgree = 0
    let controllersProgramOnly = 0
    const blends = new Map<string, number>()
    const culls = new Map<number, number>()
    let tables = 0
    let tablesPerRun = 0
    let axis = 0
    let axisAgree = 0
    let euler = 0
    let eulerAgree = 0
    for (const [, f] of files) {
      for (const { object: o } of efpObjects(f.root)) {
        nodes++
        const lm = o.controllers.find(c => c.name === 'LinkMode')
        if (lm?.name === 'LinkMode') {
          linkMode++
          const l = o.link
          if (lm.value.join() === [l.followDepth, l.positionDepth, l.matrixDepth, l.velocityDepth].join()) linkAgree++
        }
        if (o.preProgram.length || o.postEmitters.length || o.trailing.length) controllersProgramOnly++
        const k = `${o.resource.srcBlend},${o.resource.dstBlend}`
        blends.set(k, (blends.get(k) ?? 0) + 1)
        culls.set(o.resource.cull, (culls.get(o.resource.cull) ?? 0) + 1)
        for (const c of o.program) {
          if (!c) continue
          const k = c.param?.kind
          if (k === 'FrameScale' || k === 'FrameDiffuse' || k === 'FrameTextureSlide' || k === 'FrameBANPosition' || k === 'FrameBANRotation') {
            tables++
            if (c.param!.value.length === commandSchedule(c, o.totalFrames)[2]) tablesPerRun++
          }
          if (c.param?.kind === 'AxisVector4') {
            axis++
            const m = axisAngleMatrix(c.param.left)
            if (m && close(m, upper3(c.param.matrix))) axisAgree++
          }
          if (c.param?.kind === 'RotVector') {
            euler++
            if (close(eulerMatrix(c.param.left), upper3(c.param.matrix))) eulerAgree++
          }
        }
      }
    }
    console.log(`EFP: ${nodes} nodes; blends ${JSON.stringify([...blends].sort((a, b) => b[1] - a[1]))}; cull ${JSON.stringify([...culls])}`)
    console.log(`EFP: LinkMode ${linkAgree}/${linkMode}; AxisVector4 matrices ${axisAgree}/${axis}; RotVector matrices ${eulerAgree}/${euler}`)
    expect(nodes).toBe(25860)
    // The 4 others (system_rarebow_b/c*) store depth 4 in LinkMode where the stored object says 3.
    expect(linkMode - linkAgree).toBe(4)
    expect(controllersProgramOnly).toBe(0)
    expect(eulerAgree).toBe(euler)
    expect(axisAgree / axis).toBeGreaterThan(0.999)
    expect(((blends.get('5,2') ?? 0) + (blends.get('5,6') ?? 0)) / nodes).toBeGreaterThan(0.995)
    expect([...culls.keys()].sort()).toEqual([1, 2, 3])
    // Tables hold one row per scheduled run (program.ts FxTable).
    console.log(`EFP: tables with one row per run ${tablesPerRun}/${tables}`)
    expect(tables).toBe(35909)
    expect(tables - tablesPerRun).toBe(19)
  })

  it('compiles every effect to a valid program whose resources exist (known gaps allowlisted)', () => {
    const { archive, files } = load()
    const missing = new Set<string>()
    for (const [key, f] of files) {
      for (const { object } of efpObjects(f.root)) {
        for (const r of efpResources(object)) for (const m of r.meshes) for (const p of [m.path, ...m.textures]) if (p !== '' && !archive.get(fxKey(p))) missing.add(fxKey(p))
      }
      const { effect } = compileEfp(key, f, { exists: p => !!archive.get(fxKey(p)) })
      expect(validateFxEffect(effect), key).toBeNull()
      for (const w of effect.warnings) if (w.startsWith('missing')) missing.add(fxKey(JSON.parse(w.slice(w.indexOf('"')))))
    }
    expect([...missing].filter(p => !MISSING_RESOURCES.has(p))).toEqual([])
  })

  it('writes effect meshes as glbs that @sro/fx reads back unchanged', async () => {
    const { archive } = load()
    const io = new NodeIO()
    for (const path of ['meshes/levelup01.bms', 'meshes/oura_up.bms', 'meshes/6_circle_pajang.bms']) {
      const bms = parseBms(archive.read(path))
      const { document, info } = effectMeshDocument(bms, path)
      const back = readGlbMesh(await io.writeBinary(document))
      expect(back.positions.length).toBe(bms.vertexCount * 3)
      expect(back.indices.length).toBe(info.triangles * 3)
      // x unchanged apart from the unit scale, z mirrored.
      expect(back.positions[0]).toBeCloseTo(bms.positions[0]! * 0.1, 5)
      expect(back.positions[2]).toBeCloseTo(-bms.positions[2]! * 0.1, 5)
    }
  })

  it('simulates every program at 20 Hz with finite state, and finite effects end within their bound', () => {
    const { archive, files } = load()
    let finiteEffects = 0
    let endedInBound = 0
    let peak = 0
    for (const [key, f] of files) {
      const { effect } = compileEfp(key, f, { exists: p => !!archive.get(fxKey(p)) })
      const sim = new FxSimulation(effect, { maxElements: 5000 })
      const limit = effect.duration === null ? 60 : Math.min(effect.duration + 4, 1200)
      for (let t = 0; t < limit && !sim.finished; t++) {
        sim.step({ position: [0, 0, 0] })
        peak = Math.max(peak, sim.liveCount)
      }
      for (const list of sim.elements) for (const e of list) expect([...e.pos, ...e.vel].every(Number.isFinite), key).toBe(true)
      if (effect.duration !== null) {
        finiteEffects++
        if (sim.finished) endedInBound++
      }
    }
    console.log(`EFP: ${endedInBound}/${finiteEffects} finite effects end within their computed duration; peak ${peak} live elements`)
    expect(endedInBound / finiteEffects).toBeGreaterThan(0.99)
  })

  it('indexes the Chinese masteries: every referenced effect parses', () => {
    const { files } = load()
    const media = openArchive('Media')
    const read = textdataReader(media)
    const rows = loadTextdataTable('skilldata.txt', read).rows.map(r => {
      const row = skillDataRow(r)
      const d = skillDetail(row)
      return { group: row.group, code: row.code, level: row.level, mastery: d.masteries[0], masteryLevel: d.masteryLevels[0], nameKey: d.nameStrId ?? null }
    })
    const strings = buildStringMap(loadTextdataTable('textdataname.txt', read).rows, 'english')
    const text = decodeTextdata(media.read(media.get(`${TEXTDATA_DIR}/skilleffect.txt`)!)).text
    const parsed = new Set(files.map(([k]) => fxKey(k)))
    const index = buildSkillIndex(rows, text, strings, k => parsed.has(k))
    const referenced = Object.entries(index.effects)
    console.log(`EFP: ${index.skills.length} Chinese mastery skills reference ${referenced.length} effects`)
    expect(index.skills.length).toBeGreaterThan(200)
    expect(referenced.filter(([, e]) => !e.url).map(([k]) => k)).toEqual([])
    const cold = index.skills.find(s => s.group === 'SKILL_CH_COLD_GANGGI_A')!
    expect(cold.stages.map(s => s.effect)).toContain('skill/china/cold_ganggi_keep_a.efp')
    expect(cold.stages.find(s => s.phase === 'READY' && s.startBone === 'Bip01 R Hand')?.effect).toBe('skill/china/cold_motion_keep.efp')
    for (const m of index.masteries) expect(index.skills.some(s => s.mastery === m.id), m.name).toBe(true)
  })
})

/**
 * DRAGON-INT (docs/REMASTER.md "World models", work/tmp/dragon/INTEGRATE.md §6): the converter's remaster step.
 * - the table: content/remaster/models.json parses; bad shapes are refused;
 * - a listed source keeps its retail model and gets the staged glb appended as its `remasterVariant` (bytes copied as
 *   they are, the sidecar's bounds / lightmapped meshes, `#remaster` source, `.remaster.glb` path); the entry's lightmap
 *   folder lands under the export; an unlisted model is untouched; the manifest validator accepts the result and refuses
 *   a variant that is not the model's own twin;
 * - the staged files are checked (INTEGRATE §7a): a missing file, a double-sided material, a lightmapped primitive
 *   without TEXCOORD_1, a sidecar naming another model or carrying control characters, a lightmap the export does not
 *   write and a skinned retail model each throw, naming the source; a file of the live export hard-linked into a
 *   staging folder is replaced, never written through;
 * - on the real staged plaza (skipped without work/remaster and the jangan-fields export): both models pass the checks,
 *   the plaza's retail meshes (gate06/07/08) equal the retail glb's, the new basin stays inside the walk line, and the
 *   gold set's key is the variant's glb path with all four maps at 2048 and @1024.
 */
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Document } from '@gltf-transform/core'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import { gltfIO } from '../src/optimize/io.ts'
import { validateWorldManifest, type WorldManifest, type WorldModel } from '../src/world/manifest.ts'
import {
  applyRemasterModels, JANGAN_REMASTER_MODELS, parseRemasterModels, remasterPath, REMASTER_SOURCE_SUFFIX, stageRemasterModel,
  type RemasterModelsFile,
} from '../src/world/remaster-models.ts'
import { WORLD_PRESETS } from '../src/world/convert-world.ts'

const tmps: string[] = []
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true })
})
const tmp = () => {
  const t = mkdtempSync(join(tmpdir(), 'sro-remaster-models-'))
  tmps.push(t)
  return t
}

const PLAZA = 'res\\bldg\\china\\jangan01\\cj_jang_gate.bsr'
const DRAGON = 'res\\bldg\\china\\jangan01\\cj_jang_gate_dragon.bsr'
const RETAIL_LM = 'lightmaps/prim/lightmap/bldg/china/jangan01/cj_jang_gate06lightingmap.png'
const NEW_LM = 'lightmaps/remaster/plaza/fountain_lod0_lightmap.png'

const model = (index: number, source: string, kind: WorldModel['kind'] = 'static'): WorldModel => {
  const stem = source.replace(/\\/g, '/').replace(/^res\//, '').replace(/\.bsr$/, '').toLowerCase()
  return {
    index, source, glb: `models/${stem}.glb`, sidecar: `models/${stem}.json`, kind, animations: kind === 'skinned' ? ['a'] : [],
    defaultClip: kind === 'skinned' ? 'a' : null, lightmappedMeshes: 1, boundsMin: [-1, 0, -1], boundsMax: [1, 1, 1], bytes: 10, validatorErrors: 0,
  }
}

interface FixtureOpts {
  doubleSided?: boolean
  noUv1?: boolean
  lightmap?: string
  sidecarSource?: string
}

/** A staged replacement: a retail-lit piece (RETAIL_LM) and a new piece (`lightmap`, default NEW_LM). */
async function stagedFixture(dir: string, o: FixtureOpts = {}): Promise<{ glb: string; sidecar: string; lightmaps: string }> {
  const doc = new Document()
  const buf = doc.createBuffer()
  const acc = (type: 'SCALAR' | 'VEC2' | 'VEC3', array: Float32Array | Uint16Array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buf)
  const scene = doc.createScene('Scene')
  const root = doc.createNode('cj_jang_gate')
  scene.addChild(root)
  const piece = (name: string, lm: string, x: number) => {
    const material = doc.createMaterial(name).setDoubleSided(!!o.doubleSided && name === 'new')
      .setExtras({ sroLightmap: { path: `x\\${name}`, uri: lm, texCoord: 1 } })
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0])))
      .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array([0, 0, 1, 0, 0, 1])))
      .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2])))
      .setMaterial(material)
    if (!(o.noUv1 && name === 'new')) prim.setAttribute('TEXCOORD_1', acc('VEC2', new Float32Array([0, 0, 1, 0, 0, 1])))
    root.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)))
  }
  piece('cj_jang_gate06', RETAIL_LM, 0)
  piece('new', o.lightmap ?? NEW_LM, 2)
  const glb = await (await gltfIO()).writeBinary(doc)
  mkdirSync(join(dir, 'lightmaps', 'remaster', 'plaza'), { recursive: true })
  writeFileSync(join(dir, 'plaza.glb'), glb)
  writeFileSync(join(dir, 'lightmaps', 'remaster', 'plaza', 'fountain_lod0_lightmap.png'), 'png-bytes')
  const sidecar = {
    source: o.sidecarSource ?? 'res/bldg/china/jangan01/cj_jang_gate.bsr',
    version: 'remaster', generator: 'test', name: 'cj_jang_gate', type: 'BUILDING', skeleton: null, attachBone: null, attachable: null,
    materials: [],
    meshes: [
      { name: 'cj_jang_gate06', material: 'cj_jang_gate06', lightmap: { path: 'p', uri: RETAIL_LM, texCoord: 1 } },
      { name: 'new', material: 'new', lightmap: { path: 'p', uri: o.lightmap ?? NEW_LM, texCoord: 1 } },
    ],
    animations: [],
    stats: { vertices: 6, triangles: 2, joints: 0, meshes: 2, animations: 0, boundsMin: [0, 0, 0], boundsMax: [3, 1, 0] },
    warnings: [],
  }
  writeFileSync(join(dir, 'plaza.json'), JSON.stringify(sidecar, null, 1))
  return { glb: join(dir, 'plaza.glb'), sidecar: join(dir, 'plaza.json'), lightmaps: join(dir, 'lightmaps', 'remaster', 'plaza') }
}

const table = (entry: RemasterModelsFile['models'][string], extra: RemasterModelsFile['models'] = {}): RemasterModelsFile =>
  ({ format: 'sro-model-remaster', version: 1, models: { [PLAZA]: entry, ...extra } })

/** A minimal valid manifest holding `models` (no placements). */
function manifestOf(models: WorldModel[], report: Partial<WorldManifest['report']> = {}): WorldManifest {
  const id = (97 << 8) | 168
  return {
    format: 'sro-world', version: 1, name: 'fixture', generator: 'test', createdAt: '2026-10-02T00:00:00.000Z',
    space: {
      units: 'metre', metresPerUnit: 0.1, handedness: 'right-handed, +Y up (glTF)', axes: { east: [1, 0, 0], north: [0, 0, -1], up: [0, 1, 0] },
      originRegion: { x: 168, z: 97, id }, originCorner: 'south-west', regionSizeM: 192, cellSizeM: 2, regionOffsetRule: 'rule', localToWorldRule: 'rule',
    },
    regions: [], tiles: [], water: { frames: [], frameMs: 100, ice: null, waves: [] }, environment: { file: 'environment.json', profileIds: [] },
    models, placements: [], warnings: [],
    report: {
      regions: 0, regionsSkipped: [], placementRecords: 0, placements: 0, dedupeConflicts: 0, uniqueObjectIds: 0, compoundPlacements: 0,
      uniqueModels: models.length, modelsConverted: models.length, failedModels: [], lightmapTextures: 0, tileTextures: 0, validatorErrors: 0,
      sizes: { totalBytes: 0, byCategory: {} }, timeMs: { total: 0, terrain: 0, navmesh: 0, objects: 0, textures: 0 }, ...report,
    },
  }
}

describe('the table', () => {
  it('content/remaster/models.json parses and the jangan-fields preset names it', () => {
    const f = parseRemasterModels(readFileSync(join(REPO_ROOT, JANGAN_REMASTER_MODELS), 'utf8'))
    expect(Object.keys(f.models).sort()).toEqual([PLAZA, DRAGON].sort())
    expect(f.models[PLAZA]!.lightmaps).toEqual({ 'lightmaps/remaster/plaza/': 'work/remaster/models/jangan-plaza/lightmaps/remaster/plaza/' })
    expect(WORLD_PRESETS['jangan-fields']!.remasterModels).toBe(JANGAN_REMASTER_MODELS)
    // the cut-plan fallback and the town-only export stay retail
    expect(WORLD_PRESETS['jangan-near']!.remasterModels).toBeUndefined()
    expect(WORLD_PRESETS.jangan!.remasterModels).toBeUndefined()
  })

  it('refuses bad shapes', () => {
    const ok = { glb: 'a.glb', sidecar: 'a.json' }
    const text = (models: unknown, format = 'sro-model-remaster') => JSON.stringify({ format, version: 1, models })
    expect(() => parseRemasterModels(text({ [PLAZA]: ok }, 'other'))).toThrow(/expected sro-model-remaster/)
    expect(() => parseRemasterModels(text({ 'res\\a.cpd': ok }))).toThrow(/retail \.bsr/)
    expect(() => parseRemasterModels(text({ [PLAZA]: { glb: 'a.gltf', sidecar: 'a.json' } }))).toThrow(/expected \{glb/)
    expect(() => parseRemasterModels(text({ [PLAZA]: { ...ok, lightmaps: { '../x/': 'y' } } }))).toThrow(/lightmaps\/<path>\//)
    expect(() => parseRemasterModels(text({ [PLAZA]: { ...ok, lightmaps: { 'lightmaps/x': 'y' } } }))).toThrow(/lightmaps\/<path>\//)
    expect(() => parseRemasterModels(text({ [PLAZA]: ok, [PLAZA.replace(/\\/g, '/').toUpperCase()]: ok }))).toThrow(/listed twice/)
    expect(parseRemasterModels(text({ [PLAZA]: { ...ok, lightmaps: { 'lightmaps/remaster/plaza/': 'y' } } })).models[PLAZA]!.glb).toBe('a.glb')
  })

  it('remasterPath puts .remaster before the extension', () => {
    expect(remasterPath('models/bldg/china/jangan01/cj_jang_gate.glb')).toBe('models/bldg/china/jangan01/cj_jang_gate.remaster.glb')
    expect(remasterPath('models/a/b.json')).toBe('models/a/b.remaster.json')
  })
})

describe('applyRemasterModels', () => {
  it('appends the staged glb as the retail model\'s variant and leaves everything else alone', async () => {
    const src = tmp()
    const out = tmp()
    const staged = await stagedFixture(src)
    const models = [model(0, PLAZA), model(1, 'res\\bldg\\house.bsr'), model(2, 'res\\nature\\common\\tree\\tre_x.bsr')]
    const before = JSON.stringify(models)
    const warnings: string[] = []
    const r = await applyRemasterModels(models, table(
      { glb: staged.glb, sidecar: staged.sidecar, lightmaps: { 'lightmaps/remaster/plaza/': staged.lightmaps } },
      { 'res\\bldg\\missing.bsr': { glb: 'x.glb', sidecar: 'x.json' }, 'res\\nature\\common\\tree\\tre_x.bsr': { glb: 'x.glb', sidecar: 'x.json' } },
    ), { outDir: out, root: REPO_ROOT, lightmapUris: new Set([RETAIL_LM]), warnings })
    expect(JSON.stringify(models)).toBe(before)
    expect(r.models).toHaveLength(4)
    expect(r.models[1]).toBe(models[1])
    expect(r.models[2]).toBe(models[2])
    expect(r.models[0]).toEqual({ ...models[0], remasterVariant: 3 })
    const v = r.models[3]!
    expect(v).toMatchObject({
      index: 3, source: PLAZA + REMASTER_SOURCE_SUFFIX, glb: 'models/bldg/china/jangan01/cj_jang_gate.remaster.glb',
      sidecar: 'models/bldg/china/jangan01/cj_jang_gate.remaster.json', kind: 'static', animations: [], defaultClip: null,
      lightmappedMeshes: 2, boundsMin: [0, 0, 0], boundsMax: [3, 1, 0], validatorErrors: 0,
    })
    // the files as they were staged; the retail model's own files are not touched (none were written here)
    expect(readFileSync(join(out, ...v.glb!.split('/'))).equals(readFileSync(staged.glb))).toBe(true)
    expect(v.bytes).toBe(readFileSync(staged.glb).byteLength)
    expect(readFileSync(join(out, ...v.sidecar!.split('/')), 'utf8')).toBe(readFileSync(staged.sidecar, 'utf8'))
    expect(readFileSync(join(out, ...NEW_LM.split('/')), 'utf8')).toBe('png-bytes')
    expect(existsSync(join(out, 'models/bldg/china/jangan01/cj_jang_gate.glb'))).toBe(false)
    expect(r.report).toEqual([{ source: PLAZA, glb: v.glb, bytes: v.bytes }])
    expect(r.bytes.lightmaps).toBe('png-bytes'.length)
    expect(warnings.join('\n')).toContain('res\\bldg\\missing.bsr: not in this export')
    expect(warnings.join('\n')).toContain('tre_x.bsr: a tree or plant')
    // the manifest validator accepts it, and the report row
    expect(validateWorldManifest(manifestOf(r.models, { remasterModels: r.report }))).toEqual([])
  })

  it('the validator refuses a variant that is not the model\'s own static #remaster twin', () => {
    const ok = () => [{ ...model(0, PLAZA), remasterVariant: 1 }, { ...model(1, PLAZA + REMASTER_SOURCE_SUFFIX) }] as WorldModel[]
    const bad = (edit: (ms: WorldModel[]) => void, what: string) => {
      const ms = ok()
      edit(ms)
      expect(validateWorldManifest(manifestOf(ms)).join('\n'), what).toContain(what)
    }
    expect(validateWorldManifest(manifestOf(ok()))).toEqual([])
    bad(ms => { ms[1] = { ...ms[1]!, source: 'res\\bldg\\other.bsr#remaster' } }, "not this model's #remaster variant")
    bad(ms => { ms[1] = { ...ms[1]!, kind: 'failed', glb: null, sidecar: null, error: 'x' } }, 'not a converted static model')
    bad(ms => { ms[0] = { ...ms[0]!, remasterVariant: 0 } }, 'expected the index of another model')
    bad(ms => { ms[0] = { ...ms[0]!, remasterVariant: 7 } }, 'expected the index of another model')
    bad(ms => { ms[0] = { ...ms[0]!, kind: 'skinned', animations: ['a'], defaultClip: 'a' } }, 'only a static model')
    expect(validateWorldManifest(manifestOf(ok(), { remasterModels: [{ source: PLAZA, glb: 3 }] as never })).join('\n')).toContain('report.remasterModels')
  })

  it('checks the staged files and throws naming the source', async () => {
    const run = async (o: FixtureOpts, edit: (e: { glb: string; sidecar: string; lightmaps?: Record<string, string> }) => void = () => {}, m = model(0, PLAZA)) => {
      const src = tmp()
      const s = await stagedFixture(src, o)
      const entry = { glb: s.glb, sidecar: s.sidecar, lightmaps: { 'lightmaps/remaster/plaza/': s.lightmaps } as Record<string, string> }
      edit(entry)
      return stageRemasterModel(m, entry, { outDir: tmp(), root: REPO_ROOT, lightmapUris: new Set([RETAIL_LM]) })
    }
    await expect(run({}, e => { e.glb = join(tmpdir(), 'no-such-dir', 'x.glb') })).rejects.toThrow(/remaster model res\\bldg\\china\\jangan01\\cj_jang_gate\.bsr: missing staged file/)
    await expect(run({ doubleSided: true })).rejects.toThrow(/material new is double-sided/)
    await expect(run({ noUv1: true })).rejects.toThrow(/mesh new names a lightmap but has no TEXCOORD_1/)
    await expect(run({ sidecarSource: 'res/bldg/china/jangan01/cj_jang_gate_dragon.bsr' })).rejects.toThrow(/staged sidecar names/)
    await expect(run({ sidecarSource: 'res/bldg/china/jangan01\bcj_jang_gate.bsr' })).rejects.toThrow(/staged sidecar names/)
    await expect(run({ lightmap: 'lightmaps/remaster/plaza/elsewhere.png' })).rejects.toThrow(/names lightmap lightmaps\/remaster\/plaza\/elsewhere\.png, which the export does not write/)
    await expect(run({}, e => { delete e.lightmaps })).rejects.toThrow(/names lightmap lightmaps\/remaster\/plaza\/fountain_lod0_lightmap\.png/)
    await expect(run({}, () => {}, model(0, PLAZA, 'skinned'))).rejects.toThrow(/only a static retail model/)
    await expect(run({}, () => {}, { ...model(0, PLAZA), kind: 'failed', glb: null, sidecar: null })).rejects.toThrow(/did not convert/)
    await expect(run({})).resolves.toMatchObject({ lightmapBytes: 'png-bytes'.length })
  })

  it('replaces a hard-linked staging file instead of writing through it', async () => {
    const src = tmp()
    const live = tmp()
    const out = tmp()
    const s = await stagedFixture(src)
    const rel = 'models/bldg/china/jangan01/cj_jang_gate.remaster.glb'
    mkdirSync(join(live, 'models/bldg/china/jangan01'), { recursive: true })
    mkdirSync(join(out, 'models/bldg/china/jangan01'), { recursive: true })
    writeFileSync(join(live, ...rel.split('/')), 'live-bytes')
    linkSync(join(live, ...rel.split('/')), join(out, ...rel.split('/')))
    await stageRemasterModel(model(0, PLAZA), { glb: s.glb, sidecar: s.sidecar, lightmaps: { 'lightmaps/remaster/plaza/': s.lightmaps } },
      { outDir: out, root: REPO_ROOT, lightmapUris: new Set([RETAIL_LM]) })
    expect(readFileSync(join(live, ...rel.split('/')), 'utf8')).toBe('live-bytes')
    expect(readFileSync(join(out, ...rel.split('/'))).equals(readFileSync(s.glb))).toBe(true)
  })
})

// ---- the real staged plaza (skipped without it) -------------------------------------------------------------------

const STAGED = join(REPO_ROOT, 'work', 'remaster', 'models', 'jangan-plaza')
const LIVE = join(REPO_ROOT, 'work', 'out', 'world', 'jangan-fields')
const hasReal = existsSync(join(STAGED, 'cj_jang_gate.lod0.glb')) && existsSync(join(LIVE, 'models', 'bldg', 'china', 'jangan01', 'cj_jang_gate.glb'))

/** The basin centre in the gate model's space and the octagon apothem of a point (INTEGRATE §4). */
const CX = 2.99275
const CZ = 0.99425
const apothem = (x: number, z: number) => {
  let best = -Infinity
  for (let k = 0; k < 8; k++) best = Math.max(best, (x - CX) * Math.cos((k * Math.PI) / 4) + (z - CZ) * Math.sin((k * Math.PI) / 4))
  return best
}

/** Width and height of a WebP (VP8, VP8L or VP8X). */
function webpSize(b: Buffer): [number, number] {
  expect(b.toString('ascii', 0, 4)).toBe('RIFF')
  expect(b.toString('ascii', 8, 12)).toBe('WEBP')
  const kind = b.toString('ascii', 12, 16)
  if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)]
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)]
  }
  return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff]
}

describe.skipIf(!hasReal)('the staged Jangan plaza', () => {
  const table = () => parseRemasterModels(readFileSync(join(REPO_ROOT, JANGAN_REMASTER_MODELS), 'utf8'))
  const live = () => JSON.parse(readFileSync(join(LIVE, 'manifest.json'), 'utf8')) as WorldManifest
  const liveModel = (source: string) => live().models.find(m => m.source === source)!

  it('both models pass the hook\'s checks against the export\'s retail lightmaps', async () => {
    const t = table()
    const out = tmp()
    const retailLms = new Set<string>()
    for (const m of live().models) {
      if (!m.sidecar || !/jangan01/.test(m.source)) continue
      const s = JSON.parse(readFileSync(join(LIVE, ...m.sidecar.split('/')), 'utf8')) as { meshes: Array<{ lightmap?: { uri: string } }> }
      for (const me of s.meshes) if (me.lightmap?.uri) retailLms.add(me.lightmap.uri)
    }
    for (const source of [PLAZA, DRAGON]) {
      const r = await stageRemasterModel(liveModel(source), t.models[source]!, { outDir: out, root: REPO_ROOT, lightmapUris: retailLms })
      expect(r.model.validatorErrors).toBe(0)
      expect(r.model.source).toBe(source + REMASTER_SOURCE_SUFFIX)
    }
    // the plaza keeps gate06/07/08's retail lightmaps and brings its own; the pond fence's are no longer named
    const plaza = JSON.parse(readFileSync(join(out, 'models/bldg/china/jangan01/cj_jang_gate.remaster.json'), 'utf8')) as { meshes: Array<{ lightmap?: { uri: string } }> }
    const uris = new Set(plaza.meshes.map(m => m.lightmap?.uri).filter(Boolean))
    expect([...uris].filter(u => u!.includes('pondfen'))).toEqual([])
    expect(uris.has(NEW_LM)).toBe(true)
    expect(existsSync(join(out, ...NEW_LM.split('/')))).toBe(true)
  }, 60_000)

  it('the plaza\'s retail meshes equal the retail glb\'s; the new basin stays inside the walk line', async () => {
    const io = await gltfIO()
    const staged = await io.read(join(STAGED, 'cj_jang_gate.lod0.glb'))
    const retail = await io.read(join(LIVE, 'models', 'bldg', 'china', 'jangan01', 'cj_jang_gate.glb'))
    const meshes = (d: Document) => new Map(d.getRoot().listNodes().filter(n => n.getMesh()).map(n => [n.getMesh()!.getName(), n]))
    const sm = meshes(staged)
    const rm = meshes(retail)
    for (const name of ['cj_jang_gate06', 'cj_jang_gate07', 'cj_jang_gate08']) {
      const a = sm.get(name)
      const b = rm.get(name)
      expect(a, name).toBeDefined()
      expect(b, name).toBeDefined()
      expect([...a!.getWorldMatrix()]).toEqual([...b!.getWorldMatrix()])
      const pa = a!.getMesh()!.listPrimitives()
      const pb = b!.getMesh()!.listPrimitives()
      expect(pa.length).toBe(pb.length)
      pa.forEach((p, i) => {
        const q = pb[i]!
        for (const sem of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1']) {
          expect(Array.from(p.getAttribute(sem)?.getArray() ?? []), `${name} ${sem}`).toEqual(Array.from(q.getAttribute(sem)?.getArray() ?? []))
        }
        expect(Array.from(p.getIndices()!.getArray()!)).toEqual(Array.from(q.getIndices()!.getArray()!))
        expect(p.getMaterial()!.getName()).toBe(q.getMaterial()!.getName())
        expect(p.getMaterial()!.getExtras()).toEqual(q.getMaterial()!.getExtras())
      })
    }
    // the retail pond fence is gone; nothing new above the plaza reaches the gate navmesh's blocked octagon (9.584 m)
    expect(sm.has('cj_jang_pondFen')).toBe(false)
    expect(sm.has('cj_jang_pondFen02')).toBe(false)
    let reach = 0
    for (const [name, node] of sm) {
      if (name.startsWith('cj_jang_gate')) continue
      const M = node.getWorldMatrix()
      for (const p of node.getMesh()!.listPrimitives()) {
        const pos = p.getAttribute('POSITION')!
        const v = [0, 0, 0]
        for (let i = 0; i < pos.getCount(); i++) {
          pos.getElement(i, v)
          const x = M[0] * v[0]! + M[4] * v[1]! + M[8] * v[2]! + M[12]
          const y = M[1] * v[0]! + M[5] * v[1]! + M[9] * v[2]! + M[13]
          const z = M[2] * v[0]! + M[6] * v[1]! + M[10] * v[2]! + M[14]
          if (y > 0.06) reach = Math.max(reach, apothem(x, z))
        }
      }
    }
    expect(reach).toBeGreaterThan(9)
    expect(reach).toBeLessThan(9.56)
  }, 60_000)

  it('the gold set is keyed on the dragon variant\'s glb path, with all four maps at 2048 and @1024', async () => {
    const entry = JSON.parse(readFileSync(join(STAGED, 'remaster-set', 'manifest-entry.json'), 'utf8')) as { textures: Record<string, Record<string, unknown>> }
    const dragon = liveModel(DRAGON)
    const doc = await (await gltfIO()).read(join(STAGED, 'cj_jang_gate_dragon_lod0.glb'))
    const images = doc.getRoot().listTextures().map(t => t.getName())
    expect(images).toEqual(['cj_jang_dragon_m1'])
    const key = `world/jangan-fields/${remasterPath(dragon.glb!).replace(/\.glb$/, '')}#${images[0]}`
    expect(Object.keys(entry.textures)).toEqual([key])
    const e = entry.textures[key]!
    expect(e).toMatchObject({ class: 'metal', normalGreen: 'gl', sizes: [1024] })
    for (const map of ['albedo', 'normal', 'metallic', 'roughness']) {
      expect(e[map]).toBe(`sets/jangan_dragon_m1/${map}.webp`)
      expect(webpSize(readFileSync(join(STAGED, 'remaster-set', `${map}.webp`))), map).toEqual([2048, 2048])
      expect(webpSize(readFileSync(join(STAGED, 'remaster-set', `${map}@1024.webp`))), map).toEqual([1024, 1024])
    }
    // once merged into the served remaster manifest, the entry is the same
    const served = join(REPO_ROOT, 'work', 'out', 'remaster', 'manifest.json')
    const m = existsSync(served) ? (JSON.parse(readFileSync(served, 'utf8')) as { textures: Record<string, unknown> }) : null
    if (m?.textures[key]) expect(m.textures[key]).toEqual(e)
  })
})

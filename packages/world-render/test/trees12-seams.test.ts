/**
 * W12-SA, the trees seams (docs/WAVE_PLAN8.md §4.2 steps 1, 2, 5, D2, D8; docs/TREES.md Part W §W3.2–§W3.3, WF9, WF11):
 * - **the swap source** (`BatchHost.treeSwap`): null on 'retail', null when the manifest swaps nothing, the manifest's
 *   valid `treeSwap` rows otherwise; with no swap source the batch is wave 10's byte for byte (BT-T's fixtures);
 * - **the trees slot** (`World.trees`): made only where the swap applies (PBR, streamed, batched, trees 'new'), before
 *   the batching part, updated after the objects; null on Classic (the Low guard), with 'retail' and with batching off;
 *   PBR → Classic → PBR and every toggle leave nothing behind;
 * - **the foliage define skeletons** (`SRO_FOL_VDATA`, `SRO_FOL_BAND`, `SRO_FOL_PIVOT4`): off, a tree plugin's code is
 *   HEAD's byte for byte in WGSL and GLSL; one `vec4` pivot declaration whenever BAND or PIVOT reads a 4-float tree
 *   pivot, whatever the wind (WF9); the batch's tree groups carry the tree flag.
 */
import { MeshBuilder, NullEngine, PBRMaterial, Scene, Vector4, type Camera, type MaterialDefines } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel } from '../../convert/src/world/manifest.ts'
import {
  StubTrees,
  TREE_FOLIAGE_DEFINES,
  placementKey,
  placementOfKey,
  treeFoliageCode,
  treeSwapSourceOf,
  type TreesHost,
  type TreesPart,
} from '../src/index.ts'
import {
  FOLIAGE_PIVOT_KIND,
  FOLIAGE_TREEW_KIND,
  FoliageShared,
  SroFoliagePlugin,
  foliageCode,
  foliagePluginOf,
  hasTreePivot4,
} from '../src/pbr/foliage-plugin.ts'
import { SroSurfacePlugin, SurfaceShared } from '../src/pbr/surface-plugin.ts'
import {
  HEAD_FOLIAGE_FRAGMENT_GLSL_W10R,
  HEAD_FOLIAGE_FRAGMENT_WGSL_W10R,
  HEAD_FOLIAGE_VERTEX_GLSL_W10R,
  HEAD_FOLIAGE_VERTEX_WGSL_W10R,
} from './golden/head-w10r-plugins.ts'
import { TreesNearField } from '../src/trees/index.ts'
import { batchBytes, isTreeMesh, objectWorld, type ObjectWorld, type ObjectWorldOptions } from './w12-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

async function made(o: ObjectWorldOptions = {}): Promise<ObjectWorld> {
  const w = await objectWorld(o)
  cleanups.push(() => w.dispose())
  return w
}

/** A trees part that records its updates and its disposal. */
class RecordingTrees extends StubTrees {
  updates = 0
  gone = false

  constructor(host: TreesHost, readonly log: string[]) {
    super(host)
  }

  override update(camera: Camera | null, dt: number): void {
    this.updates++
    this.log.push('trees.update')
    super.update(camera, dt)
  }

  override dispose(): void {
    this.gone = true
    super.dispose()
  }
}

/** The recording trees factory (made parts in order). */
function recordingTrees(log: string[]) {
  const made: RecordingTrees[] = []
  const factory = (host: TreesHost): TreesPart => {
    log.push('trees')
    const part = new RecordingTrees(host, log)
    made.push(part)
    return part
  }
  return { made, factory }
}

/** The manifest's species model for the pine (a static model appended like the converter's tree-swap step). */
function withPineSwap(o: { fit?: number[]; tint?: number } = {}): ObjectWorldOptions['edit'] {
  return (fx, ids) => {
    const models = fx.manifest.models
    const species = models.length
    models.push({ ...models[ids.pine]!, index: species, source: 'trees/pine07', glb: 'trees/pine07/far.glb' })
    models[ids.pine]!.treeSwap = { model: species, fit: (o.fit ?? [1.075, 0.667, 1.075]) as [number, number, number], tint: o.tint ?? 0 }
  }
}

// ---- the swap source ------------------------------------------------------------------------------------------------

describe('the tree swap source (BatchHost.treeSwap, TREES §W3.2, WF11)', () => {
  const base = { sidecar: null, animations: [], defaultClip: null, lightmappedMeshes: 0, boundsMin: [0, 0, 0], boundsMax: [1, 1, 1], bytes: 0, validatorErrors: null }
  const m = (index: number, extra: Record<string, unknown> = {}) => ({ ...base, index, source: `m${index}`, glb: `models/m${index}.glb`, kind: 'static', ...extra })

  it('reads the manifest\'s valid treeSwap rows; null when none is usable', () => {
    const models = [
      m(0, { treeSwap: { model: 5, fit: [1.1, 0.9, 1.1], tint: 2 } }),
      m(1, { treeSwap: { model: 1, fit: [1, 1, 1], tint: 0 } }), // itself
      m(2, { treeSwap: { model: 6, fit: [1, 1, 1], tint: 0 } }), // a skinned target
      m(3, { treeSwap: { model: 7, fit: [1, 1, 1], tint: 0 } }), // a failed target
      m(4, { treeSwap: { model: 5, fit: [1, 0, 1], tint: 0 } }), // a zero fit
      m(5),
      m(6, { kind: 'skinned' }),
      m(7, { kind: 'failed', glb: null }),
      m(8, { treeSwap: { model: 5, fit: [1, 1, 1], tint: -1 } }), // a negative tint
      m(9, { treeSwap: { model: 42, fit: [1, 1, 1], tint: 0 } }), // no such model
      m(10, { treeSwap: { model: 5, fit: [1.2, 1.3, 1.4], tint: 0 } }),
    ] as unknown as WorldModel[]
    const src = treeSwapSourceOf(models)!
    expect(src).not.toBeNull()
    expect(src.count).toBe(2)
    expect(src.swapOf(models[0]!)).toEqual({ species: models[5], fit: [1.1, 0.9, 1.1], tint: 2 })
    expect(src.swapOf(models[10]!)?.fit).toEqual([1.2, 1.3, 1.4])
    for (const i of [1, 2, 3, 4, 5, 8, 9]) expect(src.swapOf(models[i]!), `model ${i}`).toBeNull()
    expect(treeSwapSourceOf(models.filter(x => x.index === 5 || x.index === 6))).toBeNull()
    expect(treeSwapSourceOf([])).toBeNull()
  })

  it('World hands the batch none on \'retail\' or with no swap in the manifest, the manifest\'s on \'new\'', async () => {
    const none = await made()
    await none.run()
    expect(none.hosts.length).toBe(1)
    expect(none.hosts[0]!.treeSwap).toBeNull()

    const swapped = await made({ edit: withPineSwap() })
    await swapped.run()
    const src = swapped.hosts[0]!.treeSwap!
    expect(src.count).toBe(1)
    const pine = swapped.fx.manifest.models[swapped.ids.pine]!
    expect(src.swapOf(pine)?.species.source).toBe('trees/pine07')
    expect(src.swapOf(swapped.fx.manifest.models[swapped.ids.variant]!)).toBeNull()

    const retail = await made({ edit: withPineSwap(), trees: 'retail' })
    await retail.run()
    expect(retail.world.treeMode).toBe('retail')
    expect(retail.hosts[0]!.treeSwap).toBeNull()
  })

  it('no swap source = wave 10 byte for byte (BT-T\'s fixtures): \'retail\', \'new\' without swaps and a host without the field', async () => {
    const retail = await made({ trees: 'retail' })
    await retail.run()
    const fresh = await made()
    await fresh.run()
    // A batch made from a host that has no treeSwap field at all (a wave-10 host).
    const bare = await made({ wave10Host: true })
    await bare.run()
    expect('treeSwap' in bare.parts[0]!.host).toBe(false)
    const a = batchBytes(bare.world)
    expect(a.size).toBeGreaterThan(0)
    expect([...a.keys()].some(k => k.includes('tree:'))).toBe(true)
    for (const other of [retail, fresh]) {
      const b = batchBytes(other.world)
      expect([...b.keys()].sort()).toEqual([...a.keys()].sort())
      for (const [k, v] of a) expect(b.get(k), k).toEqual(v)
    }
  })
})

// ---- the trees slot -------------------------------------------------------------------------------------------------

describe('World.trees (D2): only where the swap applies; nothing left behind', () => {
  it('PBR, streamed, batched and \'new\': made before the batching part, updated after the objects, in World.meshes', async () => {
    const log: string[] = []
    const rec = recordingTrees(log)
    const w = await made({ parts: { trees: rec.factory } })
    // The fixture's batch factory records hosts; the trees part came first.
    expect(rec.made.length).toBe(1)
    expect(w.world.trees).toBe(rec.made[0])
    expect(w.hosts.length).toBe(1)
    expect(log[0]).toBe('trees')
    await w.run()
    const before = rec.made[0]!.updates
    w.world.update(null, { x: 0, z: 0 })
    expect(rec.made[0]!.updates).toBe(before + 1)
    // The default part is T12-N's (it keeps the editor's hidden keys and preview; nothing swapped here, nothing drawn).
    const d = await made()
    expect(d.world.trees).toBeInstanceOf(TreesNearField)
    const part = d.world.trees as TreesNearField
    part.setHidden(placementKey(0x6464, 7), true)
    part.preview(null, 'pine07', new Float32Array(16))
    expect(part.stats()).toMatchObject({ hidden: 1, previews: 1 })
    expect(d.world.meshes()).toEqual(expect.arrayContaining(part.meshes()))
  })

  it('Classic (Low): World.trees is null, no part is ever made, no swap reaches anything', async () => {
    const log: string[] = []
    const rec = recordingTrees(log)
    const low = await made({ render: 'classic', edit: withPineSwap(), parts: { trees: rec.factory } })
    await low.run()
    expect(low.world.trees).toBeNull()
    expect(low.world.batch).toBeNull()
    expect(rec.made.length).toBe(0)
    expect(low.hosts.length).toBe(0)
    // The tree mode is only a flag there.
    low.world.setTreeMode('retail')
    low.world.setTreeMode('new')
    expect(rec.made.length).toBe(0)
  })

  it('\'retail\' and batching off: null; setTreeMode rebuilds the batch with or without the swap', async () => {
    const log: string[] = []
    const rec = recordingTrees(log)
    const w = await made({ edit: withPineSwap(), parts: { trees: rec.factory } })
    await w.run()
    expect(w.world.trees).not.toBeNull()
    const firstBatch = w.world.batch
    w.world.setTreeMode('retail')
    expect(w.world.trees).toBeNull()
    expect(rec.made[0]!.gone).toBe(true)
    expect(w.world.batch).not.toBe(firstBatch)
    expect(w.hosts.at(-1)!.treeSwap).toBeNull()
    await w.run()
    expect(w.world.objects.regionBatches.size).toBeGreaterThan(0)
    w.world.setTreeMode('new')
    expect(w.world.trees).toBe(rec.made[1])
    expect(w.hosts.at(-1)!.treeSwap?.count).toBe(1)
    await w.run()
    // Batching off: no trees part either; back on: one again.
    w.world.setBatching(false)
    expect(w.world.trees).toBeNull()
    expect(rec.made[1]!.gone).toBe(true)
    w.world.setBatching(true)
    expect(w.world.trees).toBe(rec.made[2])
    await w.run()
    // Same mode again: nothing happens.
    const batch = w.world.batch
    w.world.setTreeMode('new')
    expect(w.world.batch).toBe(batch)
    expect(rec.made.length).toBe(3)
  })

  it('PBR → Classic → PBR leaves nothing: every part made is disposed but the live one; no tree mesh is left on Classic', async () => {
    const log: string[] = []
    const rec = recordingTrees(log)
    const w = await made({ parts: { trees: rec.factory } })
    await w.run()
    expect(w.scene.meshes.some(m => isTreeMesh(m) && !m.isDisposed())).toBe(true)
    w.world.setRenderMode('classic')
    await w.run()
    expect(w.world.trees).toBeNull()
    expect(rec.made.every(p => p.gone)).toBe(true)
    expect(w.scene.meshes.filter(m => isTreeMesh(m) && !m.isDisposed()).length).toBe(0)
    w.world.setRenderMode('pbr')
    await w.run()
    expect(rec.made.length).toBe(2)
    expect(w.world.trees).toBe(rec.made[1])
    expect(rec.made.filter(p => !p.gone)).toEqual([rec.made[1]])
    w.world.dispose()
    expect(rec.made.every(p => p.gone)).toBe(true)
    expect(w.world.trees).toBeNull()
  })

  it('placement keys: region id and uid, the nav\'s instance-id layout, round trip', () => {
    for (const [region, uid] of [[0, 0], [(97 << 8) | 171, 0xe000], [0x7fff, 0xffff], [25000, 46109]] as const) {
      const k = placementKey(region, uid)
      expect(k).toBe(region * 65536 + uid)
      expect(k).toBeGreaterThanOrEqual(0)
      expect(Number.isSafeInteger(k)).toBe(true)
      expect(placementOfKey(k)).toEqual({ region, uid })
    }
  })
})

// ---- the foliage define skeletons -----------------------------------------------------------------------------------

/** Drops the `#ifdef X … #endif` blocks of the given (off) defines, keeping their `#else` branches (pbr-table's rule). */
function stripDefines(code: string, names: readonly string[]): string {
  const out: string[] = []
  const stack: Array<{ own: boolean; parent: boolean; branch: boolean }> = []
  let keep = true
  for (const line of code.split('\n')) {
    const own = /^#(ifdef|ifndef)\s+(\w+)\s*$/.exec(line)
    if (own && names.includes(own[2]!)) {
      const branch = own[1] === 'ifndef'
      stack.push({ own: true, parent: keep, branch })
      keep = keep && branch
      continue
    }
    if (/^#if/.test(line)) {
      stack.push({ own: false, parent: keep, branch: true })
      if (keep) out.push(line)
      continue
    }
    const top = stack[stack.length - 1]
    if (/^#else\b/.test(line) && top?.own) {
      top.branch = !top.branch
      keep = top.parent && top.branch
      continue
    }
    if (/^#endif\b/.test(line)) {
      stack.pop()
      if (top?.own) {
        keep = top.parent
        continue
      }
    }
    if (keep) out.push(line)
  }
  expect(stack).toEqual([])
  return out.join('\n')
}

const stripAll = (code: Readonly<Record<string, string>>, names: readonly string[]) =>
  Object.fromEntries(Object.entries(code).map(([k, v]) => [k, stripDefines(v, names)]))

/** A tiny preprocessor for the plugin's own directives (#ifdef / #ifndef / #if defined(A) || defined(B) / #else). */
function preprocess(code: string, on: ReadonlySet<string>): string {
  const out: string[] = []
  const stack: Array<{ parent: boolean; cond: boolean }> = []
  let keep = true
  for (const line of code.split('\n')) {
    let m: RegExpExecArray | null
    if ((m = /^#(ifdef|ifndef)\s+(\w+)\s*$/.exec(line))) {
      const cond = (m[1] === 'ifdef') === on.has(m[2]!)
      stack.push({ parent: keep, cond })
      keep = keep && cond
    } else if ((m = /^#if\s+(.*)$/.exec(line))) {
      const cond = m[1]!.split('||').some(t => on.has(/defined\((\w+)\)/.exec(t)?.[1] ?? ''))
      stack.push({ parent: keep, cond })
      keep = keep && cond
    } else if (/^#else\b/.test(line)) {
      const top = stack[stack.length - 1]!
      top.cond = !top.cond
      keep = top.parent && top.cond
    } else if (/^#endif\b/.test(line)) {
      keep = stack.pop()!.parent
    } else if (keep) out.push(line)
  }
  expect(stack).toEqual([])
  return out.join('\n')
}

describe('foliage define skeletons (D8: SRO_FOL_VDATA, SRO_FOL_BAND, SRO_FOL_PIVOT4)', () => {
  it('off = HEAD (wave 10r golden) byte for byte, in both languages; foliageCode itself is unchanged', () => {
    const head = {
      vertex: { wgsl: HEAD_FOLIAGE_VERTEX_WGSL_W10R, glsl: HEAD_FOLIAGE_VERTEX_GLSL_W10R },
      fragment: { wgsl: HEAD_FOLIAGE_FRAGMENT_WGSL_W10R, glsl: HEAD_FOLIAGE_FRAGMENT_GLSL_W10R },
    }
    for (const stage of ['vertex', 'fragment'] as const) {
      for (const lang of ['wgsl', 'glsl'] as const) {
        expect(stripAll(treeFoliageCode(stage, lang), TREE_FOLIAGE_DEFINES), `${stage} ${lang}`).toEqual(head[stage][lang])
        expect(foliageCode(stage, lang), `${stage} ${lang}`).toEqual(head[stage][lang])
        expect(Object.keys(treeFoliageCode(stage, lang)).sort()).toEqual(Object.keys(head[stage][lang]).sort())
      }
    }
    // The slots really are there (and only in the vertex stage).
    const v = treeFoliageCode('vertex', 'wgsl')
    for (const d of TREE_FOLIAGE_DEFINES) expect(Object.values(v).join('\n')).toContain(`#ifdef ${d}`)
    expect(Object.values(treeFoliageCode('fragment', 'glsl')).join('\n')).not.toMatch(/SRO_FOL_(VDATA|BAND|PIVOT4)/)
  })

  it('one vec4 pivot declaration whenever BAND or PIVOT reads the tree pivot, whatever the wind (WF9)', () => {
    const cases: Array<{ on: string[]; decl: string | null; treeW: boolean }> = [
      // Wave 10's merged trees: the vec3 pivot with the wind.
      { on: ['SRO_FOL_WIND', 'SRO_FOL_PIVOT'], decl: 'vec3', treeW: false },
      // Wave 12's: the vec4 pivot with the wind, with the band, and with the band alone (no weather, wind off).
      { on: ['SRO_FOL_WIND', 'SRO_FOL_FLUTTER', 'SRO_FOL_PIVOT', 'SRO_FOL_PIVOT4', 'SRO_FOL_VDATA'], decl: 'vec4', treeW: true },
      { on: ['SRO_FOL_WIND', 'SRO_FOL_PIVOT', 'SRO_FOL_PIVOT4', 'SRO_FOL_BAND'], decl: 'vec4', treeW: false },
      { on: ['SRO_FOL_BAND', 'SRO_FOL_PIVOT4'], decl: 'vec4', treeW: false },
      // Nothing reads a pivot: none declared.
      { on: ['SRO_FOL_WIND'], decl: null, treeW: false },
    ]
    for (const lang of ['wgsl', 'glsl'] as const) {
      for (const c of cases) {
        const code = treeFoliageCode('vertex', lang)
        const on = new Set(c.on)
        const defs = preprocess(code.CUSTOM_VERTEX_DEFINITIONS!, on)
        const pivots = defs.split('\n').filter(l => l.includes(FOLIAGE_PIVOT_KIND) && l.startsWith('attribute'))
        expect(pivots.length, `${lang} ${c.on}`).toBe(c.decl ? 1 : 0)
        if (c.decl) expect(pivots[0]).toContain(lang === 'wgsl' ? `${c.decl}f` : `${c.decl} `)
        expect(defs.includes(`${FOLIAGE_TREEW_KIND}`), `${lang} ${c.on}`).toBe(c.treeW)
        const pos = preprocess(code.CUSTOM_VERTEX_UPDATE_WORLDPOS!, on)
        if (c.on.includes('SRO_FOL_PIVOT')) {
          const roots = pos.split('\n').filter(l => l.includes('folRoot =') && l.includes(FOLIAGE_PIVOT_KIND))
          expect(roots.length).toBe(1)
          expect(roots[0]!.includes(`${FOLIAGE_PIVOT_KIND}.xyz`)).toBe(c.decl === 'vec4')
        }
      }
    }
  })

  it('every added line is a closed statement in its own language', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      const code = treeFoliageCode('vertex', lang)
      for (const [point, src] of Object.entries(code)) {
        const head = new Set(stripDefines(src, TREE_FOLIAGE_DEFINES).split('\n'))
        for (const l of src.split('\n').filter(x => !head.has(x))) {
          if (!l.trim() || l.startsWith('#')) continue
          expect(l, `${lang} ${point}`).toMatch(/[;{}]$/)
          if (lang === 'wgsl') expect(l).not.toMatch(/\b(float|vec[234]|attribute vec)\s/)
          else expect(l).not.toMatch(/\b(let|var|fn)\s|vec[234]f\b|vertexInputs|uniforms\./)
        }
      }
    }
  })

  it('a tree plugin switches the slots by the mesh: the vec4 pivot, the wind data; a wave-10 mesh stays HEAD\'s', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const mat = new PBRMaterial('tree', scene)
    new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'foliage', baked: true })
    const shared = new FoliageShared()
    Object.assign(shared, { active: true, wind: true, translucency: true, u: { wxA: new Vector4(0, 0, 0, 1), wxB: new Vector4(1, 0, 0.5, 1) } })
    const tree = new SroFoliagePlugin(mat, shared, { leaf: true, kind: 'static', tree: true, breeze: 0.15, shadowWrapper: false })
    expect(tree.tree).toBe(true)
    const mesh = (n: number, treeW = false) => {
      const m = MeshBuilder.CreatePlane(`p${n}${treeW}`, { size: 1 }, scene)
      const v = m.getTotalVertices()
      m.setVerticesData(FOLIAGE_PIVOT_KIND, new Float32Array(v * n), false, n)
      if (treeW) m.setVerticesData(FOLIAGE_TREEW_KIND, new Float32Array(v * 4), false, 4)
      return m
    }
    const defs = (p: SroFoliagePlugin, m: ReturnType<typeof mesh>) => {
      const d = {} as Record<string, boolean>
      p.prepareDefines(d as unknown as MaterialDefines, scene, m)
      const attrs: string[] = []
      p.getAttributes(attrs, scene, m)
      return { d, attrs }
    }
    // A wave-10 merged tree (vec3 pivot): HEAD's defines, the new ones off.
    let r = defs(tree, mesh(3))
    expect([r.d.SRO_FOL_PIVOT, r.d.SRO_FOL_PIVOT4, r.d.SRO_FOL_VDATA, r.d.SRO_FOL_BAND]).toEqual([true, false, false, false])
    expect(r.attrs).toEqual([FOLIAGE_PIVOT_KIND])
    // A wave-12 merged tree (vec4 pivot + wind data): the vec4 pivot and the wind data.
    const m4 = mesh(4, true)
    expect(hasTreePivot4(m4)).toBe(true)
    r = defs(tree, m4)
    expect([r.d.SRO_FOL_PIVOT, r.d.SRO_FOL_PIVOT4, r.d.SRO_FOL_VDATA, r.d.SRO_FOL_BAND]).toEqual([true, true, true, false])
    expect(r.attrs.sort()).toEqual([FOLIAGE_PIVOT_KIND, FOLIAGE_TREEW_KIND].sort())
    // Wind off: no pivot read (BAND is off until T12-W), so no declaration and no attribute either.
    shared.wind = false
    r = defs(tree, m4)
    expect([r.d.SRO_FOL_PIVOT, r.d.SRO_FOL_PIVOT4, r.d.SRO_FOL_BAND]).toEqual([false, false, false])
    expect(r.attrs).toEqual([FOLIAGE_TREEW_KIND])
    shared.wind = true
    // Not a tree plugin (the converted foliage, a cloth group): the tree slots never switch on.
    const other = new PBRMaterial('plain', scene)
    new SroSurfacePlugin(other, new SurfaceShared(), { cls: 'foliage', baked: true })
    const plain = new SroFoliagePlugin(other, shared, { leaf: true, kind: 'static' })
    r = defs(plain, m4)
    expect([plain.tree, r.d.SRO_FOL_PIVOT4, r.d.SRO_FOL_VDATA]).toEqual([false, false, false])
    const cloth = new SroFoliagePlugin(new PBRMaterial('cloth', scene), shared, { leaf: false, kind: 'static', cloth: true, tree: true })
    expect(cloth.tree).toBe(false)
    // The code each one injects.
    expect(tree.getCustomCode('vertex')).toEqual(treeFoliageCode('vertex', 'glsl'))
    expect(plain.getCustomCode('vertex')).toEqual(foliageCode('vertex', 'glsl'))
  })

  it('the region batch\'s tree groups carry the tree flag (TreeMaterials)', async () => {
    const w = await made()
    await w.run()
    const mats = new Set(w.scene.meshes.filter(m => isTreeMesh(m) && !m.isDisposed()).map(m => m.material!))
    expect(mats.size).toBe(2)
    for (const mat of mats) expect(foliagePluginOf(mat)?.tree).toBe(true)
  })
})

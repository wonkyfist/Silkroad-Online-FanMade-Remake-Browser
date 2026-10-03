// WE-L, the World Editor's library (docs/WORLD_EDITOR.md §4.5, D24–D26; docs/WAVE_PLAN8.md §6.2 WE-L, D16, D17):
// every model of the export classified (a tab, and why it is not listed on its own); every species of the export
// placeable as its carrier (an add of a source the export places); the swapped retail models folded into their
// species; the thumbnail keys and framing; and a held swapped tree drawn by T12-E's preview (tree-look.ts).
import { existsSync, readFileSync } from 'node:fs'
import { NullEngine, Quaternion, Scene, TargetCamera, TransformNode, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldManifest, WorldModel, WorldPlacement } from '../../../packages/convert/src/world/manifest.ts'
import type { TreeLibraryEntry, TreesPart } from '../../../packages/world-render/src/trees/types.ts'
import { placementKey } from '../../../packages/world-render/src/trees/types.ts'
import { treePreviewMatrix } from '../../../packages/world-render/src/trees/editor.ts'
import { buildLibrary, classifyModels, filterLibrary, frameBox, tabOfSource, thumbKey } from '../src/editor/library/index.ts'
import { TreeLook } from '../src/editor/library/tree-look.ts'
import { LIBRARY_TABS } from '../src/editor/place-list.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const REPO = new URL('../../../', import.meta.url)
const EXPORT = new URL('work/out/world/jangan-fields/manifest.json', REPO)
const realManifest = (): WorldManifest | null => (existsSync(EXPORT) ? JSON.parse(readFileSync(EXPORT, 'utf8')) as WorldManifest : null)
const realLibrary = () => JSON.parse(readFileSync(new URL('content/trees/library.json', REPO), 'utf8')) as unknown

describe('WE-L classification: every model gets a tab', () => {
  it('the retail names land where a builder looks for them', () => {
    const cases: Array<[string, string]> = [
      ['res\\nature\\common\\tree\\tre_pine07_04.bsr', 'Trees'],
      ['res\\bldg\\china\\greenfield\\cj_inn_oldtree.bsr', 'Trees'],
      ['res\\nature\\common\\grass\\grs_weed01.bsr', 'Plants'],
      ['res\\nature\\common\\flower\\flw_g01_wha.bsr', 'Plants'],
      ['res\\nature\\china\\dunhuang\\reed\\fw_cd_reeds_l.bsr', 'Plants'],
      ['res\\nature\\common\\cj_ricestraw.bsr', 'Plants'],
      ['town\\props\\tuft_a', 'Plants'],
      ['res\\nature\\common\\cliff\\stone_cliff01_03.bsr', 'Rocks'],
      ['res\\nature\\china\\dunhuang\\rock\\w_cd_rock_big_01.bsr', 'Rocks'],
      ['res\\artifact\\china\\jangan\\cj_pal_lamp.bsr', 'Lanterns'],
      ['res\\bldg\\china\\jangan02\\cj_pub01_light03.bsr', 'Lanterns'],
      ['res\\bldg\\china\\jangan02\\cj_brazier_etc01.bsr', 'Lanterns'],
      ['res\\bldg\\china\\jangan01\\cj_streetstall.bsr', 'Props'],
      ['res\\artifact\\china\\greenfield\\cj_strawcart.bsr', 'Props'],
      ['town\\props\\bench', 'Props'],
      ['res\\bldg\\china\\jangan01\\cj_jang_gate.bsr', 'Walls and gates'],
      ['res\\bldg\\china\\jangan03\\cj_pal_dam_left.bsr', 'Walls and gates'],
      ['res\\bldg\\china\\dunhuang\\ruins\\w_cd_castle_wall01.bsr', 'Walls and gates'],
      ['res\\bldg\\china\\jangan03\\cj_pal_main_buil.bsr', 'Buildings'],
      ['res\\bldg\\china\\jangan01\\cj_weapon.bsr', 'Buildings'],
    ]
    for (const [src, tab] of cases) expect(tabOfSource(src), src).toBe(tab)
  })

  it('the real export: every model classified; every one not listed on its own says why', () => {
    const m = realManifest()
    if (!m) return
    const species = new Set(buildLibrary({ manifest: m, treeLibrary: realLibrary(), outBase: '/out/' }).species.filter(s => s.placeable).map(s => s.id))
    const classes = classifyModels(m, species)
    expect(classes.length).toBe(m.models.length)
    for (const c of classes) {
      expect(LIBRARY_TABS, c.source).toContain(c.tab)
      const model = m.models[c.index]!
      if (/#species$/.test(model.source)) expect(c.why).toBe('species')
      else if (/#static$/.test(model.source)) expect(c.why).toBe('variant')
      else if (model.treeSwap && species.has(c.species!)) expect(c.why).toBe('swapped')
    }
    // every tab has something to place
    const lib = buildLibrary({ manifest: m, treeLibrary: realLibrary(), outBase: '/out/' })
    for (const t of LIBRARY_TABS) expect(lib.items().filter(i => i.tab === t && i.placeable).length, t).toBeGreaterThan(0)
  })
})

describe('WE-L the library: the species placed as their carriers, every other placed model once', () => {
  const model = (index: number, source: string, extra: Partial<WorldModel> = {}): WorldModel => ({
    index, source, glb: `models/m${index}.glb`, sidecar: null, kind: 'static', animations: [], defaultClip: null, lightmappedMeshes: [],
    boundsMin: [-1, 0, -1], boundsMax: [1, 5, 1], bytes: 100 + index, validatorErrors: 0, ...extra,
  } as unknown as WorldModel)
  const place = (uid: number, source: string, models: number[]): WorldPlacement => ({
    objId: uid, source, models, compound: false, position: [uid, 0, 0], rotation: [0, 0, 0, 1], yaw: 0, flags: 0, staticFlag: 0,
    uid, region: 0x6464, group: 0, inConvertedRegion: true,
  } as unknown as WorldPlacement)

  function fixture() {
    const models = [
      model(0, 'res\\nature\\common\\tree\\tre_pine07_04.bsr', { treeSwap: { model: 4, fit: [1.2, 1.1, 1.2], tint: 0 } }),
      model(1, 'res\\nature\\common\\tree\\tre_pine07_02.bsr', { treeSwap: { model: 4, fit: [1, 1, 1], tint: 0 } }),
      model(2, 'res\\nature\\common\\tree\\tre_maple01.bsr', { kind: 'skinned', staticVariant: 3 }),
      model(3, 'res\\nature\\common\\tree\\tre_maple01.bsr#static', { treeSwap: { model: 5, fit: [1, 1, 1], tint: 0 } }),
      model(4, 'res\\nature\\common\\tree\\w12\\pine07.bsr#species', { glb: 'models/trees/pine07/far.glb' }),
      model(5, 'res\\nature\\common\\tree\\w12\\maple03.bsr#species', { glb: 'models/trees/maple03/far.glb' }),
      model(6, 'res\\nature\\common\\tree\\tre_bamboo04.bsr'),
      model(7, 'res\\bldg\\china\\jangan01\\cj_weapon.bsr'),
      model(8, 'res\\bldg\\china\\jangan01\\cj_unplaced.bsr'),
      model(9, 'res\\bldg\\china\\jangan01\\cj_broken.bsr', { kind: 'failed', glb: null }),
    ]
    const placements = [
      place(1, models[0]!.source, [0]), place(2, models[0]!.source, [0]), place(3, models[1]!.source, [1]),
      place(4, models[2]!.source, [2]), place(5, models[6]!.source, [6]), place(6, models[7]!.source, [7]), place(7, models[9]!.source, [9]),
    ]
    return { models, placements } as Pick<WorldManifest, 'models' | 'placements'>
  }

  it('species first in their tab, placed as their carrier; swapped retail models folded; failed and unplaced left out', () => {
    const m = fixture()
    const lib = buildLibrary({
      manifest: m, outBase: '/out/',
      treeLibrary: {
        format: 'sro-trees-library', version: 1,
        species: [{ id: 'pine07', name: 'Chinese pine', family: 'pine', kind: 'tree', carrier: m.models[0]!.source, heightM: 40, widthM: 30, scaleRange: [0.85, 1.15], tint: 'default', tints: ['default'], thumbnail: 'trees/pine07/thumb.png' }],
      },
    })
    const items = lib.items()
    expect(items.map(i => [i.kind, i.name, i.tab, i.placeable])).toEqual([
      ['species', 'Chinese pine', 'Trees', true],
      // maple03 has no row: derived from the manifest, its carrier the skinned maple (placed as itself)
      ['species', 'maple03', 'Trees', true],
      ['model', 'tre_bamboo04', 'Trees', true],
      ['model', 'cj_weapon', 'Buildings', true],
    ])
    const pine = items[0]!
    expect(pine).toMatchObject({ source: m.models[0]!.source, thumb: '/out/trees/pine07/thumb.png', uses: 3, models: [4] })
    expect(pine.note).toMatch(/Low shows the retail tre_pine07_04/)
    expect(items[1]!.source).toBe(m.models[2]!.source)
    // every placeable item names a source the export places (an add copies that placement)
    const placed = new Set(m.placements.map(p => p.source.toLowerCase()))
    for (const i of items) if (i.placeable) expect(placed.has(i.source.toLowerCase()), i.source).toBe(true)
    // search: the retail name a species replaces finds the species
    expect(filterLibrary(items, 'All', 'tre_pine07_02').map(i => i.name)).toEqual(['Chinese pine'])
    expect(filterLibrary(items, 'Buildings', '').map(i => i.name)).toEqual(['cj_weapon'])
    expect(lib.classes.map(c => c.why)).toEqual(['swapped', 'swapped', 'swapped', 'variant', 'species', 'species', null, null, 'unplaced', 'failed'])
  })

  it('a species whose carrier is not converted is listed greyed with the reason', () => {
    const m = fixture()
    const lib = buildLibrary({
      manifest: m, outBase: '/out/',
      treeLibrary: { format: 'sro-trees-library', version: 1, species: [{ id: 'willow03', name: 'Willow', family: 'willow', kind: 'tree', carrier: 'res\\nature\\common\\tree\\tre_willow03.bsr', heightM: 1, widthM: 1, scaleRange: [0.85, 1.15], tint: 'default', tints: [], thumbnail: 'trees/willow03/thumb.png' }] },
    })
    const w = lib.items().find(i => i.name === 'Willow')!
    expect(w.placeable).toBe(false)
    expect(w.note).toMatch(/not in this export/)
  })

  it('the real export: every species of the export is placeable (D16, D25), its carrier placed by the export', () => {
    const m = realManifest()
    if (!m) return
    const lib = buildLibrary({ manifest: m, treeLibrary: realLibrary(), outBase: '/out/' })
    expect(lib.problems).toEqual([])
    const placed = new Set(m.placements.map(p => p.source.toLowerCase()))
    const speciesModels = m.models.filter(x => /#species$/.test(x.source))
    expect(speciesModels.length).toBeGreaterThan(0)
    for (const sp of speciesModels) {
      const item = lib.items().find(i => i.kind === 'species' && i.models[0] === sp.index)
      expect(item, sp.source).toBeDefined()
      expect(item!.placeable, `${item!.name}: ${item!.note}`).toBe(true)
      expect(placed.has(item!.source.toLowerCase())).toBe(true)
      expect(item!.thumb).toMatch(/^\/out\/trees\/[^/]+\/thumb\.png$/)
      if (existsSync(new URL(`work/out/${item!.thumb!.slice('/out/'.length)}`, REPO))) continue
      throw new Error(`missing thumbnail ${item!.thumb}`)
    }
    // no placeable source listed twice (a species not converted yet is listed greyed beside its retail carrier); no
    // swapped retail tree listed on its own
    const srcs = lib.items().filter(i => i.placeable).map(i => i.source.toLowerCase())
    expect(new Set(srcs).size).toBe(srcs.length)
    const swapped = new Set(lib.classes.filter(c => c.why === 'swapped').map(c => c.source.toLowerCase()))
    for (const i of lib.items()) if (i.kind === 'model') expect(swapped.has(i.source.toLowerCase()), i.source).toBe(false)
  })
})

describe('WE-L thumbnails: keys and framing', () => {
  it('the key changes with the world, the glb and its size; the frame holds the whole box', () => {
    const models = [{ glb: 'models/a.glb', bytes: 10 }, { glb: 'models/b.glb', bytes: 20 }] as unknown as WorldModel[]
    const m = { models }
    expect(thumbKey('w', m, [0])).not.toBe(thumbKey('w', m, [1]))
    expect(thumbKey('w', m, [0])).not.toBe(thumbKey('v', m, [0]))
    const k = thumbKey('w', m, [0])
    ;(models[0] as { bytes: number }).bytes = 11
    expect(thumbKey('w', m, [0])).not.toBe(k)
    const fov = 0.55
    const f = frameBox([-2, 0, -1], [2, 6, 1], fov)
    const r = Math.hypot(4, 6, 2) / 2
    const d = Math.hypot(f.eye[0] - f.target[0], f.eye[1] - f.target[1], f.eye[2] - f.target[2])
    expect(f.target).toEqual([0, 3, 0])
    expect(Math.asin(r / d)).toBeLessThanOrEqual(fov / 2 + 1e-9)
    expect(f.eye[1]).toBeGreaterThan(f.target[1])
  })
})

describe('WE-L tree look: a held swapped tree is drawn by T12-E\'s preview', () => {
  /** A trees part that records the editor's calls. */
  function recorder() {
    const calls: Array<{ key: number | null; species: string | null; m: Float32Array | null }> = []
    const hidden = new Set<number>()
    const part: TreesPart = {
      update() {}, meshes: () => [], library: () => [] as TreeLibraryEntry[], stats: () => ({}), dispose() {},
      preview(key, species, matrix) {
        calls.push({ key, species, m: matrix ? Float32Array.from(matrix) : null })
      },
      setHidden(key, on) {
        if (on) hidden.add(key)
        else hidden.delete(key)
      },
    }
    return { part, calls, hidden }
  }

  it('attach claims one swapped tree, follows the node every frame, detach ends it; retail and a second tree stay clones', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.activeCamera = new TargetCamera('cam', new Vector3(0, 5, -20), scene)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const fit: [number, number, number] = [1.1, 0.9, 1.1]
    const carrier = { index: 0, source: 'res\\nature\\common\\tree\\tre_pine07_04.bsr', treeSwap: { model: 1, fit, tint: 0, offset: [0.5, 0, 0] } } as unknown as WorldModel
    const species = { index: 1, source: 'res\\nature\\common\\tree\\w12\\pine07.bsr#species', glb: 'models/trees/pine07/far.glb' } as unknown as WorldModel
    const retail = { index: 2, source: 'res\\bldg\\wall.bsr' } as unknown as WorldModel
    const r = recorder()
    const host = { manifest: { models: [carrier, species, retail] }, trees: r.part as TreesPart | null }
    const look = new TreeLook(scene, host)
    const node = new TransformNode('proxy', scene)
    node.position.set(10, 2, -4)
    node.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.7, 0, 0)
    node.scaling.setAll(1.1)
    const key = TreeLook.keyOf({ region: 0x6464, uid: 9 })
    expect(key).toBe(placementKey(0x6464, 9))
    expect(look.attach(node, key, [retail])).toBe(false)
    expect(look.attach(node, key, [carrier, retail])).toBe(false)
    expect(look.attach(node, key, [carrier])).toBe(true)
    expect(look.attach(new TransformNode('second', scene), null, [carrier])).toBe(false)
    const want = treePreviewMatrix(carrier, { position: [10, 2, -4], yaw: 0.7, scale: 1.1 })!
    // the preview starts with the next frame (the stand-in placed by then)
    expect(r.calls.length).toBe(0)
    scene.render()
    expect(r.calls.length).toBe(1)
    expect(r.calls.at(-1)!.species).toBe('pine07')
    expect(r.calls.at(-1)!.key).toBe(key)
    for (let i = 0; i < 16; i++) expect(r.calls.at(-1)!.m![i]).toBeCloseTo(want[i]!, 5)
    // a frame without a move sends nothing; a moved node sends its new matrix
    const n = r.calls.length
    scene.render()
    expect(r.calls.length).toBe(n)
    node.position.x += 3
    scene.render()
    expect(r.calls.length).toBe(n + 1)
    expect(r.calls.at(-1)!.m![12]).toBeCloseTo(want[12]! + 3, 5)
    // detach ends the preview (the merged tree is back)
    look.detach(node)
    expect(r.calls.at(-1)).toEqual({ key: null, species: null, m: null })
    scene.render()
    expect(r.calls.length).toBe(n + 2)
    // without a trees part (Low, 'retail'): the clone stays
    host.trees = null
    expect(look.attach(node, key, [carrier])).toBe(false)
    look.dispose()
  })
})

/**
 * TL-B (docs/TOWN_LIFE.md §7, docs/WAVE_PLAN7.md §6.1): the town dressing pass (src/world/town/dressing.ts) and its
 * node side (dressing-io.ts), the props (content/town/props, the Blender builder's output) and the real dressing file.
 *
 * - the footprint rules: yaw convention, overlap, ground (walkable, flat, the lowest sample), keep-outs (NPCs, routes,
 *   retail obstacles, other props);
 * - the pass on a fixture: reuse of an export model, our prop written once per (name, scale, cloth), the banner's cloth
 *   record, crack-band tufts (seeded, inside the band), decals resolved onto the ground (≤ 40 a region), the lilies
 *   floated onto their pond, every placement on ground, uids from TOWN_UID_BASE in the owner region, a bad row skipped
 *   with a warning, the nav never written;
 * - the props: valid meshes, ≤ 300 triangles, textures present; a prop glb passes the glTF validator;
 * - the real `content/town/jangan-dressing.json`: valid, every model resolvable, the lamp a night-light efp, and on the
 *   real export (when work/out has it) every row placed: on the walkable ground, flat, off the NPCs and the town routes,
 *   ≤ 30 emitters within 60 m of the plaza, ≤ 40 decals a region, nav.bin unchanged.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { decodeNavData, NavWorld } from '@sro/nav'
import { TOWN_FILE_SCHEMA, validateTownFile, type TownDressingFile, type TownFile } from '../../shared/src/town.ts'
import { nightKindOf } from '../../world-render/src/night-lights.ts'
import { validateGlb } from '../src/gltf/validate.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import type { WorldModel, WorldPlacement, WorldRegion } from '../src/world/manifest.ts'
import { runWorldPasses, type WorldPassInput } from '../src/world/passes.ts'
import {
  CLEAR_M, DECALS_PER_REGION, FLAT_M, LILY_LIFT_M, NPC_CLEAR_M, ROUTE_CLEAR_M, TOWN_DECALS_FILE, TOWN_PROP_PREFIX, TOWN_UID_BASE,
  TUFT_BLADES, checkFootprint, crackTufts, createTownDressingPass, floatLilies, footprintOf, footprintPoint, footprintsOverlap,
  propCloth, regionOf, segmentDistance, type DressingDeps, type DressingGround, type DressingReport, type TownDecalsFile, type TownPropMesh,
} from '../src/world/town/dressing.ts'
import { navGround, nodeDressingDeps, propGlb, TOWN_PROPS_DIR, validPropMesh } from '../src/world/town/dressing-io.ts'

const OWNER = (97 << 8) | 168
const tmp = mkdtempSync(join(tmpdir(), 'town-dressing-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const region = (x: number, z: number, water: number | null = null): WorldRegion => ({
  x, z, id: (z << 8) | x,
  origin: [192 * (x - 168), 0, 192 * (97 - z)],
  bounds: { min: [192 * (x - 168), 0, 192 * (97 - z) - 192], max: [192 * (x - 168) + 192, 10, 192 * (97 - z)] },
  terrain: { file: `terrain/${x}_${z}.bin`, bytes: 1, heightMinM: 0, heightMaxM: 10, layerCount: 1, tileIds: [1] },
  lightmap: null,
  minimap: null,
  blocks: Array.from({ length: 36 }, (_, k) => ({ bx: k % 6, bz: Math.floor(k / 6), flag: 0, environmentId: 0, water: water === null || k !== 0 ? null : { kind: 'water' as const, type: 0, wave: 0, heightM: water } })),
  navmesh: null,
})

const model = (index: number, source: string, half = 1, height = 5): WorldModel => ({
  index, source, glb: `models/${index}.glb`, sidecar: `models/${index}.json`, kind: 'static', animations: [], defaultClip: null,
  lightmappedMeshes: 0, boundsMin: [-half, 0, -half], boundsMax: [half, height, half], bytes: 100, validatorErrors: 0,
})

const placement = (uid: number, models: number[], x: number, y: number, z: number): WorldPlacement => ({
  objId: 100 + uid, source: `res\\obj${uid}.bsr`, models, compound: false, position: [x, y, z], rotation: [0, 0, 0, 1], yaw: 0,
  flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid, region: OWNER, group: 3, inConvertedRegion: true,
})

const file = (over: Partial<TownDressingFile> = {}): TownDressingFile => ({
  schema: TOWN_FILE_SCHEMA, kind: 'townDressing', world: 'w', town: 'jangan', props: [], banners: [], lamps: [], decals: [], crackBands: [], ...over,
})

/** Flat ground at 0 on x < 100, a 1 m step beyond; nothing walkable in the "house" square around (50, -50). */
const ground: DressingGround = (x, z) => (Math.abs(x - 50) < 4 && Math.abs(z + 50) < 4 ? null : x < 100 ? 0 : 1)

/** Models: 0 a lamp post the export has, 1 a house (an obstacle), 2 the pond lily. */
function input(): WorldPassInput {
  return {
    outDir: tmp, origin: { x: 168, z: 97 }, regions: [region(168, 97, -3)],
    tiles: [],
    models: [model(0, 'res\\artifact\\china\\jangan\\cj_pal_lamp.bsr', 0.5, 2.6), model(1, 'res\\house.bsr', 3), model(2, 'res\\nature\\common\\grass\\c_pondflower.bsr', 0.8, 0.5)],
    placements: [placement(1, [1], 20, 0, -20), placement(2, [2], 10, -3.1, -10), placement(3, [2], 12, -2.0, -10), placement(4, [2], 14, -3.9, -10)],
    warnings: [],
  }
}

const PROP: TownPropMesh = {
  format: 'sro-town-prop', version: 1, name: 'thing', triangles: 2, boundsMin: [-0.5, 0, -0.25], boundsMax: [0.5, 1, 0.25],
  materials: [{ name: 'm', texture: 't.png', alphaMode: 'OPAQUE', doubleSided: false }, { name: 'cloth', texture: 't.png', alphaMode: 'MASK', doubleSided: false, cloth: { kind: 'hanging', pinY: 1, height: 0.8 } }],
  primitives: [{ material: 0, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2] },
    { material: 1, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 2, 1] }],
}

/** Fake node side: our props from PROP, models recorded, JSON writes kept. */
function fakeDeps(over: Partial<DressingDeps> = {}) {
  const writes: Array<{ rel: string; value: unknown }> = []
  const models: string[] = []
  const deps: DressingDeps = {
    ground: () => ground,
    npcs: () => [{ x: 70, z: -70 }],
    routes: () => [[0, -80, 60, -80]],
    prop: name => (name === 'nothing' ? null : PROP),
    writeModel: async (req, _ctx, base) => {
      models.push(req.stem)
      const s = req.scale
      return {
        source: req.from === 'prop' ? `town/props/${req.ref}` : base?.source ?? req.ref, glb: `models/${req.stem}.glb`, sidecar: `models/${req.stem}.json`,
        kind: 'static', animations: [], defaultClip: null, lightmappedMeshes: 0,
        boundsMin: [-0.5 * s, 0, -0.25 * s], boundsMax: [0.5 * s, 1 * s, 0.25 * s], bytes: 10, validatorErrors: 0,
        ...(req.from === 'prop' ? { cloth: propCloth(PROP, s, req.cloth) } : {}),
      }
    },
    writeJson: (_ctx, rel, value) => writes.push({ rel, value }),
    ...over,
  }
  return { deps, writes, models }
}

describe('footprints and the ground rule', () => {
  it('turns +yaw about +Y: local +x at yaw π/2 points to world −z', () => {
    const f = footprintOf({ boundsMin: [-1, 0, -0.5], boundsMax: [1, 1, 0.5] }, 10, -10, Math.PI / 2)
    const [x, z] = footprintPoint(f, 1, 0)
    expect(x).toBeCloseTo(10)
    expect(z).toBeCloseTo(-11)
    // forward (local +z) = (sin yaw, cos yaw): the game's convention
    const [fx, fz] = footprintPoint({ ...f, yaw: 0.7 }, 0, 1)
    expect(fx - 10).toBeCloseTo(Math.sin(0.7))
    expect(fz + 10).toBeCloseTo(Math.cos(0.7))
  })

  it('overlap: apart, touching within the pad, rotated', () => {
    const a = footprintOf({ boundsMin: [-1, 0, -1], boundsMax: [1, 1, 1] }, 0, 0, 0)
    const b = footprintOf({ boundsMin: [-1, 0, -1], boundsMax: [1, 1, 1] }, 2.2, 0, 0)
    expect(footprintsOverlap(a, b)).toBe(false)
    expect(footprintsOverlap(a, b, 0.25)).toBe(true)
    expect(footprintsOverlap(a, { ...b, x: 2.3, yaw: Math.PI / 4 })).toBe(true)
    expect(footprintsOverlap(a, { ...b, x: 3.5, yaw: Math.PI / 4 })).toBe(false)
    expect(segmentDistance(0, 1, -1, 0, 1, 0)).toBeCloseTo(1)
    expect(regionOf({ x: 168, z: 97 }, 97, -110)).toBe(OWNER)
    expect(regionOf({ x: 168, z: 97 }, 228, -222)).toBe((98 << 8) | 169)
  })

  it('stands on the lowest flat sample; refuses no ground, a step, an NPC, a route, an obstacle, another prop', () => {
    const f = footprintOf({ boundsMin: [-0.9, 0, -0.2], boundsMax: [0.9, 0.5, 0.2] }, 30, -30, 0.3)
    expect(checkFootprint(f, ground, {})).toEqual({ y: 0, problem: null })
    const sloped: DressingGround = x => (x - 30) * 0.05
    expect(checkFootprint(f, sloped, {}).y).toBeCloseTo(-0.05 * 0.9 * Math.cos(0.3) - 0.05 * 0.2 * Math.sin(0.3), 2)
    expect(checkFootprint({ ...f, x: 100 }, ground, {}).problem).toMatch(/not flat/)
    expect(checkFootprint({ ...f, x: 50, z: -50 }, ground, {}).problem).toMatch(/no walkable ground/)
    expect(checkFootprint(f, ground, { npcs: [{ x: 31, z: -31 }] }).problem).toMatch(new RegExp(`${NPC_CLEAR_M} m of an NPC`))
    expect(checkFootprint(f, ground, { routes: [[0, -30.5, 60, -30.5]] }).problem).toMatch(/town route/)
    expect(checkFootprint(f, ground, { routes: [[0, -30 - ROUTE_CLEAR_M - 0.6, 60, -30 - ROUTE_CLEAR_M - 0.6]] }).problem).toBeNull()
    const o = footprintOf({ boundsMin: [-1, 0, -1], boundsMax: [1, 3, 1] }, 31.8, -30, 0)
    expect(checkFootprint(f, ground, { obstacles: [o] }).problem).toMatch(/retail object/)
    expect(checkFootprint(f, ground, { placed: [o] }).problem).toMatch(/another dressing prop/)
    expect(checkFootprint(f, ground, { obstacles: [{ ...o, x: 31.8 + 0.9 + CLEAR_M + 0.3 }] }).problem).toBeNull()
  })

  it('crack tufts: seeded, inside the band, about density × area / TUFT_BLADES', () => {
    const band = { points: [[0, 0], [30, 0], [30, -10]] as Array<[number, number]>, width: 0.6, density: 5 }
    const a = crackTufts(band, 3)
    expect(crackTufts(band, 3)).toEqual(a)
    expect(crackTufts(band, 4)).not.toEqual(a)
    expect(a.length).toBe(Math.round((5 * 0.6 * 30) / TUFT_BLADES) + Math.round((5 * 0.6 * 10) / TUFT_BLADES))
    for (const t of a) {
      const d = Math.min(segmentDistance(t.x, t.z, 0, 0, 30, 0), segmentDistance(t.x, t.z, 30, 0, 30, -10))
      expect(d).toBeLessThanOrEqual(0.3 + 1e-9)
      expect(t.model.startsWith(TOWN_PROP_PREFIX + 'tuft_')).toBe(true)
    }
  })
})

describe('the dressing pass (fixture)', () => {
  const run = async (f: TownDressingFile, d = fakeDeps()) => {
    let rep: DressingReport | null = null
    const inp = input()
    const out = await runWorldPasses(inp, { townDressing: createTownDressingPass(f, d.deps, r => (rep = r)) })
    return { out, rep: rep as unknown as DressingReport, warnings: inp.warnings, ...d }
  }

  it('an empty file changes nothing and needs no node work', async () => {
    const d = fakeDeps({ ground: () => { throw new Error('no nav needed') } })
    const { out } = await run(file(), d)
    expect(out.placements).toEqual(input().placements)
    expect(out.models).toEqual(input().models)
    expect(d.writes).toEqual([])
  })

  it('places props, banners and tufts on the ground with town uids; reuses export models; writes each prop once', async () => {
    const f = file({
      props: [
        { id: 'lamp', model: 'cj_pal_lamp', x: 30, z: -30, yaw: 0 },
        { id: 'a', model: 'town/props/thing', x: 34, z: -30, yaw: 1 },
        { id: 'b', model: 'town/props/thing', x: 38, z: -30, yaw: 2 },
        { id: 'big', model: 'town/props/thing', x: 42, z: -30, yaw: 0, scale: 2 },
      ],
      banners: [{ id: 'ban', model: 'town/props/thing', x: 46, z: -30, yaw: 0, height: 1.5, kind: 'awning' }],
      crackBands: [{ points: [[0, -40], [40, -40]], width: 0.5, density: 7 }],
    })
    const { out, rep, models } = await run(f)
    expect(rep.skipped).toEqual([])
    const added = out.placements.filter(p => p.uid >= TOWN_UID_BASE)
    expect(added).toHaveLength(5 + rep.tufts)
    expect(rep.tufts).toBe(20)
    expect(new Set(added.map(p => p.uid)).size).toBe(added.length)
    for (const p of added) {
      expect(p.region).toBe(OWNER)
      expect(p.position[1]).toBe(0)
      expect(p.rotation[1]).toBeCloseTo(Math.sin(p.yaw / 2))
      expect(p.flags.static).toBe(true)
    }
    // the lamp is the export's model 0; our prop written once at scale 1, once at 2, once as the awning banner, + 2 tufts
    expect(added.find(p => p.position[0] === 30)!.models).toEqual([0])
    expect(models.filter(s => s.startsWith('town/props/thing'))).toEqual(['town/props/thing', 'town/props/thing@s200', 'town/props/thing@awning150'])
    const ban = out.models[added.find(p => p.position[0] === 46)!.models[0]!]!
    expect(ban.cloth).toEqual([{ material: 'cloth', kind: 'awning', pinY: 1, height: 1.5 }])
    expect(out.models).toHaveLength(3 + 3 + 2)
  })

  it('skips a row on a step, on no ground, on an obstacle, near an NPC or off the regions, with a warning', async () => {
    const f = file({
      props: [
        { id: 'step', model: 'town/props/thing', x: 100, z: -30, yaw: Math.PI / 2 },
        { id: 'house', model: 'town/props/thing', x: 50, z: -50, yaw: 0 },
        { id: 'wall', model: 'town/props/thing', x: 21, z: -20, yaw: 0 },
        { id: 'npc', model: 'town/props/thing', x: 71, z: -70, yaw: 0 },
        { id: 'route', model: 'town/props/thing', x: 30, z: -80.5, yaw: 0 },
        { id: 'away', model: 'town/props/thing', x: 500, z: -30, yaw: 0 },
        { id: 'missing', model: 'town/props/nothing', x: 30, z: -30, yaw: 0 },
        { id: 'unknown', model: 'nosuchmodel', x: 30, z: -30, yaw: 0 },
      ],
    })
    const { out, rep, warnings } = await run(f)
    expect(rep.skipped.map(s => s.what.replace(/^props\[\d+\] /, ''))).toEqual(['(step)', '(house)', '(wall)', '(npc)', '(away)', '(missing)', '(unknown)'])
    expect(warnings.filter(w => w.includes('town dressing:') && w.includes('skipped'))).toHaveLength(7)
    // a town route crossing is reported, not skipped (TL-R rebuilds its graph around the dressing)
    expect(rep.placed).toBe(1)
    expect(rep.routeCrossings.map(c => c.what)).toEqual(['props[4] (route)'])
    expect(warnings.some(w => w.includes('(route): on a town route'))).toBe(true)
    expect(out.placements).toHaveLength(input().placements.length + 1)
  })

  it('resolves decals onto flat ground, at most DECALS_PER_REGION a region, into town-decals.json', async () => {
    const decals = [
      ...Array.from({ length: DECALS_PER_REGION + 3 }, (_, i) => ({ kind: 'dirt' as const, x: 10 + (i % 20) * 3, z: -10 - Math.floor(i / 20) * 3, yaw: 0, size: [2, 2] as [number, number] })),
      { kind: 'puddle' as const, x: 100, z: -30, yaw: 0, size: [3, 3] as [number, number] },
    ]
    const { writes, rep } = await run(file({ decals }))
    expect(writes).toHaveLength(1)
    expect(writes[0]!.rel).toBe(TOWN_DECALS_FILE)
    const f = writes[0]!.value as TownDecalsFile
    expect(f.decals).toHaveLength(DECALS_PER_REGION)
    expect(f.decals.every(d => d.y === 0 && d.region === OWNER)).toBe(true)
    expect(rep.decalsSkipped).toHaveLength(4)
  })

  it('floats the pond lilies under their water onto it (and leaves the deep and the dry ones)', async () => {
    const pond = { regions: [OWNER], color: [0.1, 0.1, 0.05] as [number, number, number], turbidity: 0.5 }
    expect(floatLilies(pond, input())).toEqual([{ region: OWNER, uid: 2, y: -3 + LILY_LIFT_M }])
    const { out, rep } = await run(file({ pond }))
    expect(rep.lilies).toBe(1)
    expect(out.placements.find(p => p.uid === 2)!.position[1]).toBeCloseTo(-3 + LILY_LIFT_M)
    expect(out.placements.find(p => p.uid === 4)!.position[1]).toBe(-3.9)
    expect(floatLilies({ ...pond, regions: [1] }, input())).toEqual([])
  })
})

describe('our props (content/town/props)', () => {
  const names = readdirSync(TOWN_PROPS_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))

  it('every prop is a valid mesh of ≤ 300 triangles with its textures', () => {
    expect(names).toEqual(expect.arrayContaining(['banner', 'bench', 'planter', 'pot', 'crate', 'tuft_a', 'tuft_b']))
    for (const n of names) {
      const j = JSON.parse(readFileSync(join(TOWN_PROPS_DIR, `${n}.json`), 'utf8')) as TownPropMesh
      expect(validPropMesh(j), n).toBe(true)
      const tris = j.primitives.reduce((s, p) => s + p.indices.length / 3, 0)
      expect(tris, n).toBe(j.triangles)
      expect(tris, n).toBeLessThanOrEqual(300)
      for (const m of j.materials) expect(existsSync(join(TOWN_PROPS_DIR, m.texture)), `${n}: ${m.texture}`).toBe(true)
    }
  })

  it('a prop glb passes the glTF validator; its sidecar names its materials; the banner carries its cloth pin', async () => {
    const banner = JSON.parse(readFileSync(join(TOWN_PROPS_DIR, 'banner.json'), 'utf8')) as TownPropMesh
    const out = await propGlb(banner, 1, png => new Uint8Array(readFileSync(join(TOWN_PROPS_DIR, png))))
    const v = await validateGlb(out.glb, 'banner.glb')
    expect(v.errors).toBe(0)
    expect(out.sidecar.materials.map(m => m.name)).toEqual(banner.materials.map(m => m.name))
    expect(out.boundsMax[1]).toBeGreaterThan(6)
    expect(propCloth(banner, 1, { kind: 'hanging', height: 2.2 })).toEqual([{ material: 'town_banner_cloth', kind: 'hanging', pinY: 5.58, height: 2.2 }])
    const half = await propGlb(banner, 0.5, png => new Uint8Array(readFileSync(join(TOWN_PROPS_DIR, png))))
    expect(half.boundsMax[1]).toBeCloseTo(out.boundsMax[1] / 2, 4)
  })
})

describe('content/town/jangan-dressing.json', () => {
  const path = join(REPO_ROOT, 'content', 'town', 'jangan-dressing.json')
  const res = validateTownFile(JSON.parse(readFileSync(path, 'utf8')))

  it('is a valid dressing file whose models resolve and whose lamps give lights', () => {
    expect(res.ok ? res.file.kind : res.problems).toBe('townDressing')
    const f = (res as { file: TownDressingFile }).file
    expect(f.props.length).toBeGreaterThan(30)
    for (const p of [...f.props, ...f.banners]) {
      if (p.model.startsWith(TOWN_PROP_PREFIX)) expect(existsSync(join(TOWN_PROPS_DIR, `${p.model.slice(TOWN_PROP_PREFIX.length)}.json`)), p.model).toBe(true)
      else expect(/^res\/.+\.bsr$/.test(p.model) || /^[a-z0-9_]+$/.test(p.model), p.model).toBe(true)
    }
    for (const l of f.lamps) expect(nightKindOf(l.efp), l.efp).not.toBeNull()
    expect(f.pond?.regions).toContain((98 << 8) | 169)
  })

  const W = join(REPO_ROOT, 'work', 'out', 'world', 'jangan-fields')
  const hasExport = existsSync(join(W, 'manifest.json')) && existsSync(join(W, 'nav.bin'))
  it.skipIf(!hasExport)('on the real export: every row placed on flat walkable ground, off NPCs and routes; budgets kept; nav unchanged', async () => {
    const f = (res as { file: TownDressingFile }).file
    const m = JSON.parse(readFileSync(join(W, 'manifest.json'), 'utf8')) as { regions: WorldRegion[]; models: WorldModel[]; placements: WorldPlacement[]; tiles: never[] }
    const navBytes = readFileSync(join(W, 'nav.bin'))
    const hash = createHash('sha1').update(navBytes).digest('hex')
    const nav = new NavWorld(decodeNavData(new Uint8Array(navBytes)))
    const g = navGround(nav, { x: 168, z: 97 })
    const npcFile = join(REPO_ROOT, 'work', 'out', 'data', 'npcs.json')
    const npcs = existsSync(npcFile) ? (JSON.parse(readFileSync(npcFile, 'utf8')).entries as Array<{ x: number; z: number }>).map(e => ({ x: e.x, z: e.z })) : []
    const townPath = join(REPO_ROOT, 'content', 'town', 'jangan.json')
    const town = existsSync(townPath) ? validateTownFile(JSON.parse(readFileSync(townPath, 'utf8'))) : null
    const routes: Array<[number, number, number, number]> = []
    if (town?.ok && town.file.kind === 'town') {
      const t = town.file as TownFile
      const at = new Map(t.graph.nodes.map(n => [n.id, n]))
      for (const e of t.graph.edges) {
        const a = at.get(e.a)
        const b = at.get(e.b)
        if (a && b) routes.push([a.x, a.z, b.x, b.z])
      }
    }
    // a dressed export (after X1) already holds this file's placements: they are not retail obstacles
    // models are not written: the export's own are reused, ours and the retail ones are stand-ins with real bounds
    const base = nodeDressingDeps({ validate: false })
    const writes: unknown[] = []
    const deps: DressingDeps = {
      ...base,
      ground: () => g,
      npcs: () => npcs,
      routes: () => routes,
      writeModel: async req => {
        const mesh = req.from === 'prop' ? base.prop(req.ref, []) : null
        const s = req.scale
        const b = req.from === 'export' ? m.models[Number(req.ref)]! : null
        const lo = mesh?.boundsMin ?? b?.boundsMin ?? [-1, 0, -1]
        const hi = mesh?.boundsMax ?? b?.boundsMax ?? [1, 2, 1]
        return {
          source: req.ref, glb: `models/${req.stem}.glb`, sidecar: null, kind: 'static', animations: [], defaultClip: null, lightmappedMeshes: 0,
          boundsMin: lo.map(v => v * s) as [number, number, number], boundsMax: hi.map(v => v * s) as [number, number, number], bytes: 0, validatorErrors: 0,
        }
      },
      writeJson: (_c, _r, v) => writes.push(v),
    }
    let rep: DressingReport | null = null
    const warnings: string[] = []
    const out = await runWorldPasses({ outDir: tmp, origin: { x: 168, z: 97 }, regions: m.regions, tiles: [], models: m.models, placements: m.placements.filter(p => p.uid < TOWN_UID_BASE), warnings }, {
      townDressing: createTownDressingPass(f, deps, r => (rep = r)),
    })
    const r = rep as unknown as DressingReport
    // retail models absent from the export are measured from stand-in bounds; the rule checks run on the real nav
    expect(r.skipped.filter(s => !s.what.includes('tuft'))).toEqual([])
    expect(r.decalsSkipped).toEqual([])
    expect(r.routeCrossings).toEqual([])
    expect(r.placed).toBe(f.props.length + f.banners.length + r.tufts)
    const added = out.placements.filter(p => p.uid >= TOWN_UID_BASE)
    for (const p of added) {
      const h = g(p.position[0], p.position[2])
      expect(h, `${p.source} at ${p.position}`).not.toBeNull()
      expect(Math.abs(h! - p.position[1]), `${p.source} at ${p.position}`).toBeLessThanOrEqual(FLAT_M + 1e-6)
      for (const n of npcs) expect(Math.hypot(n.x - p.position[0], n.z - p.position[2]), p.source).toBeGreaterThan(p.source.includes('tuft') ? 0 : NPC_CLEAR_M - 1e-6)
    }
    // ≤ 30 night emitters within 60 m of the plaza (TOWN_LIFE §1.9: none today): lamp posts with their own emitter +
    // lamp rows × the placements of the models they name
    const near = (p: WorldPlacement) => Math.hypot(p.position[0] - 97, p.position[2] + 110) <= 60
    const named = (p: WorldPlacement, n: string) => p.models.some(i => out.models[i]!.source.toLowerCase().replace(/\\/g, '/').endsWith(`/${n}.bsr`) || out.models[i]!.source === n)
    const emitters = out.placements.filter(p => near(p) && (named(p, 'cj_pal_lamp') || f.lamps.some(l => named(p, l.model)))).length
    expect(emitters).toBeGreaterThanOrEqual(8)
    expect(emitters).toBeLessThanOrEqual(30)
    const per = new Map<number, number>()
    for (const d of (writes[0] as TownDecalsFile).decals) per.set(d.region, (per.get(d.region) ?? 0) + 1)
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(DECALS_PER_REGION)
    expect(createHash('sha1').update(readFileSync(join(W, 'nav.bin'))).digest('hex')).toBe(hash)
  }, 120_000)
})

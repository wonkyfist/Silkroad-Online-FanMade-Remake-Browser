/**
 * The world edits (wave 12, docs/WORLD_EDITOR.md §3.6, §6.2; docs/WAVE_PLAN8.md §6.2 lane WE-D, with WE-N's
 * ./nav-edit.ts and ./checks.ts). The spine (../convert-world.ts) calls `createWorldEdits` and runs the
 * `WorldEditsRun` it returns (../edits-hook.ts is the contract):
 *
 *   read        the layer folder (content/world-edits/<world>/): edits.json, height/paint/grass/walk PNGs (sharp, as
 *               the coast's authored layers), placements/water/lights/zones/probes JSON; every file through the shared
 *               validators (packages/shared/src/world-edits). Any problem: nothing is applied (one warning lists them)
 *               and the export stays as it would be without edits: never a half apply.
 *   terrain     editsSource over the coast's or retail region (./layers.ts applyTerrainEdits): heights, paint, water;
 *               `height` gives the edited lattice to the normals; the base hash in edits.json is checked
 *   navEdit     WE-N's ./nav-edit.ts `createNavEdit` with the layers (the height layer as the global lattice gives it,
 *               walk, water) and the placement edits' footprints (object ids and collision navmeshes from Data.pk2's
 *               navmesh/object.ifo: the same source the nav uses, whatever the export folder holds); a force-open
 *               outside `playable`, in the coast field's sea or under a footprint is ignored with a warning
 *   pass        step 6 (./placements.ts): moves as drop + add, adds by source, props on moved ground snapped or listed;
 *               writes sound-zones.json (the game's zone runtime reads it beside town.json)
 *   lightmap    the touched regions' lightmaps re-baked with object shadows (./shadows.ts)
 *   minimap     the touched regions' minimap tiles redrawn (./minimap.ts)
 *   extras      grass/<x>_<z>.png masks (manifest `grassMask`), per-region light point counts (`lightPoints`)
 *   points      ambient.json `points` from lights.json
 * An empty or missing layer folder (palette.json alone) gives null: the export is byte-identical (docs/WAVE_PLAN8.md
 * G7). Determinism: the same layers and the same base give the same bytes (no clock, no random, fixed orders).
 *
 * The `world-edit` verbs of `pnpm sro` (../../cli.ts) call `validateWorldEdits` and `publishWorldEdits`.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import sharp from 'sharp'
import { parseObjectIfo } from '@sro/formats'
import { createObjectNavMeshResolver, decodeNavData } from '@sro/nav'
import {
  decodeGrassLayer, decodeHeightLayer, decodePaintLayer, decodeWalkLayer, emptyHeightLayer, encodeGrassLayer, lowerPlacementEdits,
  placementNavEdits, regionIdOf, seaTestOfField, validateGrassLayer, validateHeightLayer, validatePaintLayer, validateWalkLayer,
  validateWorldEditLights, validateWorldEditPlacements, validateWorldEditProbes, validateWorldEditsIndex, validateWorldEditWater,
  validateWorldEditZones, waterLevelsForRegion, WE_FROM_TOLERANCE_M, WE_GRASS, WE_GRID, WE_TILES, WE_WALK, yawRotation,
  type WorldEditLight, type WorldEditModelKind, type WorldEditPlacementsFile, type WorldEditProbe, type WorldEditsContext, type WorldEditsIndex,
  type WorldEditWater, type WorldEditZone,
} from '../../../../shared/src/world-edits/index.ts'
import { openArchive } from '../../node-io.ts'
import { encodePng } from '../../png.ts'
import { dropFootprint, type DropFootprint } from '../coast/placements.ts'
import type { EditsImage, RegionTerrain, WorldEditsRun, WorldEditsScene } from '../edits-hook.ts'
import { decodeTerrainBin } from '../format.ts'
import type { TileTexture, WorldCoast, WorldModel, WorldPlacement, WorldRegion, WorldReport } from '../manifest.ts'
import { NAV_OBJECT_IFO } from '../nav.ts'
import type { WorldPassContext } from '../passes.ts'
import { isFoliageModel } from '../static-variants.ts'
import { decodePng } from '../verify.ts'
import { readShadowCaster, type ShadowCaster } from './glb.ts'
import { createNavEdit, type NavEditObjects, type NavEditRegionLayers, type NavEditRun, type NavFootprint } from './nav-edit.ts'
import {
  ambientPointsOf, applyTerrainEdits, baseHeightBytes, EditLattice, emptyWorldEditsLayers, encodeSoundZones, fileUnitsToMetres,
  grassLayerPainted, grassMaskFile, hasEdits, lightPointCounts, placementReach, SOUND_ZONES_FILE, touchedRegions, vertexHolders, type WorldEditsLayers,
} from './layers.ts'
import { redrawMinimap, type MinimapAdd } from './minimap.ts'
import { createEditsPass, type EditsPassOutcome } from './placements.ts'
import { bakeEditedLightmap, casterOf, type CasterInstance, type CasterPart, type LatticeHeight } from './shadows.ts'

/** The jangan-fields edit layers (docs/WAVE_PLAN8.md §3.3; relative to the repo root). */
export const JANGAN_EDITS = 'content/world-edits/jangan-fields'

/** Files of a layer folder that hold no edit (the editor's own palette, docs/WAVE_PLAN8.md D19). */
export const NON_LAYER_FILES: ReadonlySet<string> = new Set(['palette.json'])

export interface WorldEditsOptions {
  /** The layer folder (absolute). */
  dir: string
  /** The export's name (manifest.name). */
  world: string
  /** The export folder (absolute). */
  outDir: string
  origin: { x: number; z: number }
  regions: ReadonlyArray<{ x: number; z: number }>
  warnings: string[]
  log: (line: string) => void
  /**
   * The export's placements and models before the passes (the incremental convert's pre-pass cache), when known before
   * the run: the placement edits' reach (touched) and the nav step's footprints use them. Absent (a full convert): the
   * pass grows `touched` from its own context's placements and models.
   */
  prePass?: {
    placements: readonly WorldPlacement[]; models: readonly WorldModel[]; live?: readonly WorldPlacement[]
    /** The live manifest's report (editsExportContext: which live placements a kept publish's edits put there). */
    liveReport?: LiveExportReport
  }
  /** stream.playable (region units, inclusive): a force-open outside it is ignored (the Walkable brush's limits). */
  playable?: { x0: number; x1: number; z0: number; z1: number }
  /**
   * The coast field (manifest.coast.field and its PNG, absolute), asked for when a walk layer forces a tile open: a
   * force-open in its sea mask is ignored. Null / absent: no sea.
   */
  coastField?: () => { file: string; field: WorldCoast['field'] } | null
}

/** The layer files of a folder (relative, forward slashes), without the non-layer files; [] when it is missing. */
export function layerFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const file = join(d, name)
      if (statSync(file).isDirectory()) walk(file)
      else {
        const rel = relative(dir, file).split('\\').join('/')
        if (!NON_LAYER_FILES.has(rel)) out.push(rel)
      }
    }
  }
  walk(dir)
  return out
}

// --- reading and validating the layers --------------------------------------------------------------------------------

const JSON_FILES = ['edits.json', 'placements.json', 'water.json', 'lights.json', 'zones.json', 'probes.json'] as const
const LAYER_FILE = /^(height|paint|grass|walk)\/(\d+)_(\d+)\.png$/

export interface ReadLayersResult {
  layers: WorldEditsLayers
  /** Format and validation problems (any problem: Publish refuses, the converter applies nothing). */
  problems: string[]
  /** Files the reader does not know (listed, not fatal). */
  unknown: string[]
}

/**
 * Reads and validates a layer folder. `world`: the export's name (a staging export `<world>-edit` reads its world's
 * layers); `exported`: the export's regions (layers may exist only there).
 */
export async function readWorldEditsLayers(dir: string, opts: {
  world: string; origin?: { x: number; z: number }; regions?: ReadonlyArray<{ x: number; z: number }>
  /**
   * The export's placement by key (editsExportContext): moves and drops are matched against it ("unknown placement",
   * "the object changed / moved under the edit"); absent: only the file's own form is checked.
   */
  placement?: WorldEditsContext['placement']
  /** A source's scale class (editsExportContext; undefined: an unknown model). Default: modelKindOf (the path rule). */
  modelKind?: WorldEditsContext['modelKind']
}): Promise<ReadLayersResult> {
  const world = opts.world.replace(/-edit$/, '')
  const layers = emptyWorldEditsLayers(world)
  const problems: string[] = []
  const unknown: string[] = []
  const exported = opts.regions ? new Set(opts.regions.map(r => regionIdOf(r.x, r.z))) : null
  const ctx: WorldEditsContext = {
    world,
    ...(opts.origin ? { originRegion: opts.origin } : {}),
    ...(exported ? { exported: (x: number, z: number) => exported.has(regionIdOf(x, z)) } : {}),
    ...(opts.placement ? { placement: opts.placement } : {}),
    // the scale classes are always enforced (D12, D17; NT4): a tree 0.85-1.15, a building never scaled
    modelKind: opts.modelKind ?? (source => modelKindOf(source)),
  }
  const check = (r: { ok: boolean; problems: string[] }) => {
    if (!r.ok) problems.push(...r.problems)
    return r.ok
  }
  for (const rel of layerFiles(dir)) {
    const file = join(dir, ...rel.split('/'))
    const m = LAYER_FILE.exec(rel)
    if (m) {
      const kind = m[1] as 'height' | 'paint' | 'grass' | 'walk'
      const x = Number(m[2])
      const z = Number(m[3])
      try {
        const px = await readLayerPixels(file, kind)
        const id = regionIdOf(x, z)
        if (kind === 'height') {
          const l = decodeHeightLayer(px)
          if (check(validateHeightLayer(x, z, l, ctx))) layers.height.set(id, l)
        } else if (kind === 'paint') {
          const l = decodePaintLayer(px)
          if (check(validatePaintLayer(x, z, l, ctx))) layers.paint.set(id, l)
        } else if (kind === 'grass') {
          const l = decodeGrassLayer(px)
          if (check(validateGrassLayer(x, z, l, ctx))) layers.grass.set(id, l)
        } else {
          const l = decodeWalkLayer(px)
          if (check(validateWalkLayer(x, z, l, ctx))) layers.walk.set(id, l)
        }
      } catch (e) {
        problems.push(`${rel}: ${(e as Error).message}`)
      }
      continue
    }
    if (!(JSON_FILES as readonly string[]).includes(rel)) {
      unknown.push(rel)
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      problems.push(`${rel}: ${(e as Error).message}`)
      continue
    }
    if (rel === 'edits.json') {
      if (check(validateWorldEditsIndex(json, ctx))) layers.index = json as WorldEditsIndex
    } else if (rel === 'placements.json') {
      if (check(validateWorldEditPlacements(json, ctx))) {
        const p = json as WorldEditPlacementsFile
        layers.placements = { ...p, move: p.move ?? [], drop: p.drop ?? [], add: p.add ?? [] }
      }
    } else if (rel === 'water.json') {
      if (check(validateWorldEditWater(json, ctx))) layers.water = json as WorldEditWater[]
    } else if (rel === 'lights.json') {
      if (check(validateWorldEditLights(json))) layers.lights = json as WorldEditLight[]
    } else if (rel === 'zones.json') {
      if (check(validateWorldEditZones(json, ctx))) layers.zones = json as WorldEditZone[]
    } else if (check(validateWorldEditProbes(json, ctx))) layers.probes = json as WorldEditProbe[]
  }
  return { layers, problems, unknown }
}

/** A layer PNG's raw pixels in the codec's layout (LA16 for heights, RGBA8 for paint and grass, R8 for walk). */
async function readLayerPixels(file: string, kind: 'height' | 'paint' | 'grass' | 'walk'): Promise<ArrayLike<number>> {
  const size = kind === 'grass' ? WE_GRASS : kind === 'walk' ? WE_TILES : WE_GRID
  const meta = await sharp(file).metadata()
  if (meta.width !== size || meta.height !== size) throw new Error(`expected ${size} x ${size}, got ${meta.width} x ${meta.height}`)
  if (kind === 'height') {
    if (meta.channels !== 2 || (meta.bitsPerSample ?? 16) !== 16) throw new Error(`expected 16-bit grey + alpha, got ${meta.channels} channel(s)`)
    // without toColourspace('grey16') sharp reads LA16 as 8-bit RGBA (docs/COAST.md §6.3)
    const { data } = await sharp(file).toColourspace('grey16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true })
    return new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
  }
  const channels = kind === 'walk' ? 1 : 4
  if (meta.channels !== channels || (meta.bitsPerSample ?? 8) !== 8) throw new Error(`expected 8-bit with ${channels} channel(s), got ${meta.channels}`)
  // without toColourspace('b-w') sharp reads a one-channel PNG as RGB, three samples per tile
  const { data } = await (kind === 'walk' ? sharp(file).toColourspace('b-w') : sharp(file)).raw().toBuffer({ resolveWithObject: true })
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

// --- the run ----------------------------------------------------------------------------------------------------------

/**
 * Writes by temp + rename: a hard link at the path (the incremental convert's staging export) is replaced, never written
 * through, so the live export behind it is not touched (H12-INC-1; the header of ../../tools/convert-region.ts).
 */
function writeReplacing(file: string, bytes: Uint8Array | string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, file)
}

/** The run for one convert, or null (no layer, or invalid layers: nothing to apply). */
export async function createWorldEdits(opts: WorldEditsOptions): Promise<WorldEditsRun | null> {
  const files = layerFiles(opts.dir)
  const zonesOut = join(opts.outDir, SOUND_ZONES_FILE)
  if (!files.length) {
    rmSync(zonesOut, { force: true })
    return null
  }
  // the footprints (Data.pk2) are read once, when a placement edit or a height layer needs them
  let objectsRead: ObjectNavMeshes | null | undefined
  const objectsOnce = () => (objectsRead === undefined ? (objectsRead = objectNavMeshes(opts.warnings)) : objectsRead)
  const exp = opts.prePass ? editsExportContext(opts.prePass, objectsOnce) : null
  const read = await readWorldEditsLayers(opts.dir, {
    world: opts.world, origin: opts.origin, regions: opts.regions, ...(exp ? { placement: exp.placement, modelKind: exp.modelKind } : {}),
  })
  if (read.unknown.length) opts.warnings.push(`world edits: ${read.unknown.length} unknown file(s) in ${opts.dir} skipped: ${read.unknown.slice(0, 5).join(', ')}`)
  if (read.problems.length) {
    opts.warnings.push(`world edits: ${read.problems.length} problem(s) in ${opts.dir}, the layers are ignored (nothing applied): ` +
      `${read.problems.slice(0, 5).join('; ')}${read.problems.length > 5 ? '; ...' : ''}`)
    rmSync(zonesOut, { force: true })
    return null
  }
  if (!hasEdits(read.layers)) {
    rmSync(zonesOut, { force: true })
    return null
  }
  const p = read.layers.placements
  // a force-open is checked against the footprints (the Walkable brush's limits), so a walk layer opening a tile needs them
  const forcesOpen = [...read.layers.walk.values()].some(l => l.codes.includes(WE_WALK.open))
  const objects = read.layers.height.size || forcesOpen || (p && (p.move.length || p.drop.length || p.add.length)) ? objectsOnce() : null
  const navObjects = objects ? navObjectEdits(read.layers, opts.origin, objects, exp?.placements) : null
  return buildWorldEditsRun(read.layers, { ...opts, objects, navObjects })
}

interface BuildOptions extends WorldEditsOptions {
  /** Object ids and their collision footprints (null: unknown; the pass then reads the export's nav.bin). */
  objects?: ObjectNavMeshes | null
  /** The footprint part of the placement edits for the nav step (null: no placement edit, or the objects are unknown). */
  navObjects?: NavEditObjects | null
}

/** Shadow-caster geometry read from the export's glbs (cached by model and tier). */
function casterLoader(outDir: string, models: () => readonly WorldModel[], warnings: string[]): (part: CasterPart) => ShadowCaster | null {
  const cache = new Map<string, ShadowCaster | null>()
  const decodeImage = (mime: string, bytes: Uint8Array) => (mime === 'image/png' ? decodePng(bytes) : null)
  return part => {
    const key = `${part.model}:${part.tier ?? ''}`
    if (cache.has(key)) return cache.get(key)!
    const m = models()[part.model]
    let geo: ShadowCaster | null = null
    if (m?.glb) {
      try {
        geo = readShadowCaster(new Uint8Array(readFileSync(join(outDir, ...m.glb.split('/')))), { ...(part.tier !== undefined ? { tier: part.tier } : {}), decodeImage })
      } catch (e) {
        warnings.push(`world edits: shadow of ${m.source}: ${(e as Error).message}`)
      }
    }
    cache.set(key, geo)
    return geo
  }
}

/** Builds the run for decoded, valid layers (exported for the tests and tools). */
export function buildWorldEditsRun(layers: WorldEditsLayers, opts: BuildOptions): WorldEditsRun {
  const { outDir, origin, warnings, log } = opts
  const lattice = new EditLattice(layers.height, layers.paint)
  const touched = touchedRegions(layers, origin, opts.prePass ? placementReach(opts.prePass.placements, opts.prePass.models) : undefined)
  const exportedIds = new Set(opts.regions.map(r => regionIdOf(r.x, r.z)))
  for (const p of lattice.seamProblems((x, z) => exportedIds.has(regionIdOf(x, z)))) warnings.push(`world edits: ${p}`)

  // --- terrain: the overlay, the edited lattice, the base hash
  const baseFu = new Map<number, Float32Array>()
  const baseWords = new Map<number, Uint16Array>()
  const afterFu = new Map<number, Float32Array>()
  const baseIndex = new Map((layers.index?.regions ?? []).map(r => [regionIdOf(r.x, r.z), r.base]))
  const baseChanged: string[] = []
  /** SHA-256 of the base heights of every region with a height or paint layer (what edits.json `base` must hold). */
  const bases: Record<string, string> = {}
  const terrainStats = { regions: 0, heightVertices: 0, paintVertices: 0, waterBlocks: 0 }
  let baseMaxM = -Infinity
  const terrain = (x: number, z: number, base: RegionTerrain | null): RegionTerrain | null => {
    const id = regionIdOf(x, z)
    if (base) {
      baseFu.set(id, base.grid.heights)
      baseWords.set(id, base.grid.textures)
      for (const h of base.grid.heights) baseMaxM = Math.max(baseMaxM, fileUnitsToMetres(h))
      const want = baseIndex.get(id)
      if (want || layers.height.has(id) || layers.paint.has(id)) {
        const got = createHash('sha256').update(baseHeightBytes(base.grid.heights)).digest('hex')
        bases[`${x}_${z}`] = got
        if (want && got !== want) {
          baseChanged.push(`${x}_${z}`)
          warnings.push(`world edits: region ${x}_${z}: the ground under the edit changed since it was made (check it in the editor)`)
        }
      }
    }
    const r = applyTerrainEdits(x, z, base, lattice, layers.water)
    if (r.changed && r.terrain) {
      afterFu.set(id, r.terrain.grid.heights)
      terrainStats.regions++
      terrainStats.heightVertices += r.heightVertices
      terrainStats.paintVertices += r.paintVertices
      terrainStats.waterBlocks += r.waterBlocks
    }
    return r.terrain
  }
  const height = (ggx: number, ggz: number): number | undefined => {
    if (lattice.delta(ggx, ggz) === undefined) return undefined
    for (const h of vertexHolders(ggx, ggz)) {
      const a = afterFu.get(regionIdOf(h.rx, h.rz))
      if (a) return a[h.i]
    }
    return undefined
  }

  // --- the nav (WE-N)
  const needsNav = layers.height.size > 0 || layers.walk.size > 0 || layers.water.length > 0 ||
    !!(layers.placements && (layers.placements.move.length || layers.placements.drop.length || layers.placements.add.length))
  // the Walkable brush's limits: the playable bounds and the coast's sea mask (read once, when a force-open asks)
  let sea: ((x: number, z: number) => boolean) | null | undefined
  const seaAt = opts.coastField
    ? (x: number, z: number) => {
      if (sea === undefined) sea = readSeaTest(opts.coastField!(), warnings)
      return sea ? sea(x, z) : false
    }
    : null
  const navRun: NavEditRun | null = needsNav
    ? createNavEdit({
      regions: navRegionLayers(layers, lattice), objects: opts.navObjects ?? null, footprint: opts.objects?.footprint ?? (() => null),
      walkGuard: { playable: opts.playable ?? null, seaAt, origin }, warn: line => warnings.push(line),
    })
    : null

  // --- the pass, and what the after-pass hooks need of it
  let outcome: EditsPassOutcome | null = null
  let passRegions: readonly WorldRegion[] = []
  let passTiles: readonly TileTexture[] = []
  let footprints: Set<number> | null = null
  const inner = createEditsPass({
    layers, lattice, isVegetation: isFoliageModel,
    footprint: objId => (opts.objects ? opts.objects.footprint(objId) !== null : footprints?.has(objId) ?? false),
    onResult: o => (outcome = o),
  })
  const pass = (ctx: WorldPassContext) => {
    passRegions = ctx.regions
    passTiles = ctx.tiles
    // the placement edits' reach from the models the pass sees (a full convert knows them only now; H12-GH-1)
    if (layers.placements) for (const id of touchedRegions(layers, origin, placementReach(ctx.placements, ctx.models))) touched.add(id)
    footprints = opts.objects ? null : navFootprints(ctx.outDir, warnings)
    const zonesOut = join(ctx.outDir, SOUND_ZONES_FILE)
    if (layers.zones.length) writeReplacing(zonesOut, encodeSoundZones(layers.zones))
    else rmSync(zonesOut, { force: true })
    return inner(ctx)
  }

  // --- heights and words of the export after the edits (the written bins) and before them
  const bins = new Map<number, { heights: Float32Array; textures: Uint16Array } | null>()
  const bin = (id: number) => {
    if (!bins.has(id)) {
      const file = join(outDir, 'terrain', `${id & 0xff}_${id >> 8}.bin`)
      let v: { heights: Float32Array; textures: Uint16Array } | null = null
      if (existsSync(file)) {
        try {
          const t = decodeTerrainBin(new Uint8Array(readFileSync(file)))
          v = { heights: t.heights, textures: t.textures }
        } catch (e) {
          warnings.push(`world edits: ${file}: ${(e as Error).message}`)
        }
      }
      bins.set(id, v)
    }
    return bins.get(id)!
  }
  const beforeMetres = new Map<number, Float32Array>()
  const heightAfter: LatticeHeight = (ggx, ggz) => {
    for (const h of vertexHolders(ggx, ggz)) {
      const b = bin(regionIdOf(h.rx, h.rz))
      if (b) return b.heights[h.i]
    }
    return undefined
  }
  const heightBefore: LatticeHeight = (ggx, ggz) => {
    for (const h of vertexHolders(ggx, ggz)) {
      const id = regionIdOf(h.rx, h.rz)
      const fu = baseFu.get(id)
      if (fu) {
        let m = beforeMetres.get(id)
        if (!m) {
          m = new Float32Array(fu.length)
          for (let i = 0; i < fu.length; i++) m[i] = fileUnitsToMetres(fu[i]!)
          beforeMetres.set(id, m)
        }
        return m[h.i]
      }
      const b = bin(id)
      if (b) return b.heights[h.i]
    }
    return undefined
  }
  const wordAfter = (ggx: number, ggz: number) => {
    for (const h of vertexHolders(ggx, ggz)) {
      const b = bin(regionIdOf(h.rx, h.rz))
      if (b) return b.textures[h.i]
    }
    return undefined
  }
  const wordBefore = (ggx: number, ggz: number) => {
    for (const h of vertexHolders(ggx, ggz)) {
      const id = regionIdOf(h.rx, h.rz)
      const w = baseWords.get(id)
      if (w) return w[h.i]
      const b = bin(id)
      if (b) return b.textures[h.i]
    }
    return undefined
  }

  // --- the casters: what the edits removed and added, and the scene after them
  let sceneCasters: CasterInstance[] | null = null
  let sceneModels: readonly WorldModel[] = []
  const load = casterLoader(outDir, () => sceneModels, warnings)
  const changedCasters = (scene: WorldEditsScene) => {
    const o = outcome
    const gone: CasterInstance[] = []
    const come: CasterInstance[] = []
    if (!o) return { gone, come }
    const before = new Map(o.before.map(p => [`${p.region}:${p.uid}`, p]))
    const after = new Map(scene.placements.map(p => [`${p.region}:${p.uid}`, p]))
    // the retail lightmap holds the retail shapes: the gone shadows are the retail models' (no species)
    const retail = scene.models.map(m => (m.treeSwap ? stripSwap(m) : m))
    for (const key of [...o.dropped, ...o.resnapped].sort()) {
      const p = before.get(key)
      const c = p && casterOf(p, retail)
      if (c) gone.push(c)
    }
    for (const key of [...o.added, ...o.resnapped].sort()) {
      const p = after.get(key)
      const c = p && casterOf(p, scene.models)
      if (c) come.push(c)
    }
    return { gone, come }
  }
  let changed: { gone: CasterInstance[]; come: CasterInstance[] } | null = null
  const lightmapStats = { rebaked: 0, texels: 0, casters: 0, triangles: 0 }
  const lightmap = (region: WorldRegion, current: EditsImage, scene: WorldEditsScene): EditsImage | null => {
    const t0 = performance.now()
    sceneModels = scene.models
    if (!sceneCasters) {
      sceneCasters = []
      for (const p of scene.placements) {
        const c = casterOf(p, scene.models)
        if (c) sceneCasters.push(c)
      }
    }
    changed ??= changedCasters(scene)
    let maxM = baseMaxM
    for (const r of passRegions.length ? passRegions : [region]) maxM = Math.max(maxM, r.terrain.heightMaxM)
    const res = bakeEditedLightmap({
      rx: region.x, rz: region.z, origin: region.origin, image: current, heightBefore, heightAfter,
      terrainChanged: terrainStats.heightVertices > 0, maxHeightM: maxM, gone: changed.gone, come: changed.come, scene: sceneCasters, load,
    })
    if (!res) return null
    lightmapStats.rebaked++
    lightmapStats.texels += res.texels
    lightmapStats.casters += res.casters
    lightmapStats.triangles += res.triangles
    log(`world edits: lightmap ${region.x}_${region.z} re-baked: ${res.texels} texel(s), ${res.casters} caster(s), ` +
      `${res.triangles} triangle(s) in ${Math.round(performance.now() - t0)} ms`)
    return res.image
  }

  // --- the minimap
  const tileColours = new Map<number, readonly [number, number, number] | null>()
  const tileColour = (id: number) => {
    if (!tileColours.has(id)) {
      const t = passTiles.find(x => x.id === id)
      let c: readonly [number, number, number] | null = null
      if (t) {
        try {
          const img = decodePng(new Uint8Array(readFileSync(join(outDir, ...t.file.split('/')))))
          const s = [0, 0, 0]
          const n = img.width * img.height
          for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) s[k] += img.rgba[i * 4 + k]!
          c = [s[0]! / n, s[1]! / n, s[2]! / n]
        } catch {
          c = null
        }
      }
      tileColours.set(id, c)
    }
    return tileColours.get(id)!
  }
  let minimapEdits: { dropped: DropFootprint[]; added: MinimapAdd[] } | null = null
  const toRegion = (gx: number, gz: number) => ({ x: origin.x + gx / 192, z: origin.z - gz / 192 })
  const minimapStats = { redrawn: 0 }
  const minimap = (region: WorldRegion, current: EditsImage | null, scene: WorldEditsScene): EditsImage | null => {
    if (!current) return null
    if (!minimapEdits) {
      minimapEdits = { dropped: [], added: [] }
      const o = outcome as EditsPassOutcome | null
      if (o) {
        const before = new Map(o.before.map(p => [`${p.region}:${p.uid}`, p]))
        const after = new Map(scene.placements.map(p => [`${p.region}:${p.uid}`, p]))
        for (const key of [...o.dropped].sort()) {
          const p = before.get(key)
          if (p) minimapEdits.dropped.push(dropFootprint(p, unionModel(p, scene.models), toRegion))
        }
        for (const key of [...o.added].sort()) {
          const p = after.get(key)
          if (p) minimapEdits.added.push(minimapAdd(p, unionModel(p, scene.models), toRegion))
        }
      }
    }
    const img = redrawMinimap({
      rx: region.x, rz: region.z, current, heightBefore, heightAfter, wordBefore, wordAfter, tileColour,
      dropped: minimapEdits.dropped, added: minimapEdits.added,
    })
    if (img) minimapStats.redrawn++
    return img
  }

  // --- per-region extras: grass masks and light points
  const points = lightPointCounts(layers.lights, origin)
  let grassMasks = 0
  const regionExtras = (region: WorldRegion, _scene: WorldEditsScene): Pick<WorldRegion, 'grassMask' | 'lightPoints'> | null => {
    const out: Pick<WorldRegion, 'grassMask' | 'lightPoints'> = {}
    const g = layers.grass.get(region.id)
    if (g && grassLayerPainted(g)) {
      const rel = grassMaskFile(region.x, region.z)
      const file = join(outDir, ...rel.split('/'))
      mkdirSync(dirname(file), { recursive: true })
      writeReplacing(file, encodePng(WE_GRASS, WE_GRASS, encodeGrassLayer(g)))
      out.grassMask = rel
      grassMasks++
    }
    const n = points.get(region.id)
    if (n) out.lightPoints = n
    return out.grassMask !== undefined || out.lightPoints !== undefined ? out : null
  }

  const run: WorldEditsRun = {
    touched,
    terrain,
    height,
    pass,
    lightmap,
    minimap,
    regionExtras,
    ambientPoints: () => ambientPointsOf(layers.lights),
    report: () => ({
      touchedRegions: touched.size,
      layers: { height: layers.height.size, paint: layers.paint.size, grass: layers.grass.size, walk: layers.walk.size },
      terrain: terrainStats,
      water: layers.water.length,
      lights: layers.lights.length,
      zones: layers.zones.length,
      grassMasks,
      props: { resnapped: (outcome as EditsPassOutcome | null)?.resnapped.size ?? 0, listed: (outcome as EditsPassOutcome | null)?.listed ?? [] },
      lightmaps: lightmapStats,
      minimaps: minimapStats.redrawn,
      problems: (outcome as EditsPassOutcome | null)?.problems ?? [],
      ...(navRun ? { nav: navRun.report() } : {}),
      bases,
      ...(baseChanged.length ? { baseChanged } : {}),
    }),
  }
  if (navRun) run.navEdit = (regionId, nvm) => navRun.navEdit(regionId, nvm)
  log(`world edits: ${touched.size} touched region(s); layers height ${layers.height.size}, paint ${layers.paint.size}, grass ` +
    `${layers.grass.size}, walk ${layers.walk.size}; ${layers.water.length} water, ${layers.lights.length} light(s), ${layers.zones.length} zone(s)`)
  return run
}

/** The coast's sea test from its field PNG (what the client's `World.coast.seaAt` reads), or null with a warning. */
function readSeaTest(f: { file: string; field: WorldCoast['field'] } | null, warnings: string[]): ((x: number, z: number) => boolean) | null {
  if (!f) return null
  try {
    const img = decodePng(new Uint8Array(readFileSync(f.file)))
    if (img.width !== f.field.width || img.height !== f.field.height) throw new Error(`${img.width} x ${img.height}, the manifest says ${f.field.width} x ${f.field.height}`)
    return seaTestOfField(f.field, img.rgba)
  } catch (e) {
    warnings.push(`world edits: the coast field ${f.file} could not be read (${(e as Error).message}): force-open tiles are not checked against the sea`)
    return null
  }
}

/** The nav step's per-region layers: the height layer as the global lattice gives it (seam vertices from any holder,
 *  as the terrain), the walk layer and the edits' water levels. */
function navRegionLayers(layers: WorldEditsLayers, lattice: EditLattice): Map<number, NavEditRegionLayers> {
  const ids = new Set<number>([...layers.walk.keys(), ...layers.water.map(w => w.region)])
  // a height layer's seam vertices also belong to its east, north and north-east neighbours
  for (const id of layers.height.keys()) {
    const x = id & 0xff
    const z = id >> 8
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) if (x + dx <= 255 && z + dz <= 255) ids.add(regionIdOf(x + dx, z + dz))
  }
  const out = new Map<number, NavEditRegionLayers>()
  for (const id of [...ids].sort((a, b) => a - b)) {
    const x = id & 0xff
    const z = id >> 8
    const h = emptyHeightLayer()
    let any = false
    for (let gz = 0; gz < WE_GRID; gz++) {
      for (let gx = 0; gx < WE_GRID; gx++) {
        const d = lattice.delta(x * WE_TILES + gx, z * WE_TILES + gz)
        if (d === undefined) continue
        h.mask[gz * WE_GRID + gx] = 1
        h.delta[gz * WE_GRID + gx] = d
        any = true
      }
    }
    const walk = layers.walk.get(id) ?? null
    const water = layers.water.some(w => w.region === id) ? waterLevelsForRegion(layers.water, id) : null
    if (!any && !walk && !water) continue
    out.set(id, { height: any ? h : null, walk, water })
  }
  return out
}

/** Object ids by source path and their collision footprints, from the source data. */
export interface ObjectNavMeshes {
  /** navmesh/object.ifo's index of a source path (the lowest index of a path), or -1. */
  objIdOf(source: string): number
  /** The collision navmesh's XZ bounds (object-local file units), or null: the object blocks no walking. */
  footprint(objId: number): NavFootprint | null
}

/**
 * Object ids and collision footprints from Data.pk2 (navmesh/object.ifo and the nav package's resolver: what the
 * converter's nav step itself reads), so the nav part of the edits is the same whatever the export folder holds. Null
 * (with a warning) without the archive: the pass then reads the export's nav.bin and the nav keeps the footprints
 * where they were.
 */
export function objectNavMeshes(warnings: string[]): ObjectNavMeshes | null {
  try {
    const data = openArchive('Data')
    const read = (p: string) => (data.has(p) ? data.read(p) : undefined)
    const ifoBytes = read(NAV_OBJECT_IFO)
    if (!ifoBytes) throw new Error(`${NAV_OBJECT_IFO}: missing`)
    const ifo = parseObjectIfo(ifoBytes)
    const norm = (path: string) => path.replace(/\//g, '\\').toLowerCase()
    const bySource = new Map<string, number>()
    for (const e of [...ifo.entries].sort((a, b) => a.index - b.index)) {
      const k = norm(e.path)
      if (!bySource.has(k)) bySource.set(k, e.index)
    }
    const resolver = createObjectNavMeshResolver(ifo, read, [])
    const meshes = new Map<number, NavFootprint | null>()
    return {
      objIdOf: source => bySource.get(norm(source)) ?? -1,
      footprint: objId => {
        if (!meshes.has(objId)) {
          const r = objId >= 0 ? resolver(objId) : null
          let fp: NavFootprint | null = null
          if (r && r.navMesh.vertices.length >= 3) {
            const v = r.navMesh.vertices
            fp = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity }
            for (let i = 0; i < v.length; i += 3) {
              fp.minX = Math.min(fp.minX, v[i]!)
              fp.maxX = Math.max(fp.maxX, v[i]!)
              fp.minZ = Math.min(fp.minZ, v[i + 2]!)
              fp.maxZ = Math.max(fp.maxZ, v[i + 2]!)
            }
          }
          meshes.set(objId, fp)
        }
        return meshes.get(objId)!
      },
    }
  } catch (e) {
    warnings.push(`world edits: object footprints unavailable (${(e as Error).message}): the edited objects' footprints stay where they were in walking`)
    return null
  }
}

/**
 * The placement edits' nav part (ids to remove, instances to put), placements.json lowered by the same shared function
 * the pass uses: the editor uids come out the same (no placement but the edits' own holds one), object ids by source.
 * Null without placement edits.
 */
function navObjectEdits(layers: WorldEditsLayers, origin: { x: number; z: number }, objects: ObjectNavMeshes,
  exportPlacements?: readonly ExportPlacement[]): NavEditObjects | null {
  const file = layers.placements
  if (!file || !(file.move.length || file.drop.length || file.add.length)) return null
  type P = { region: number; uid: number; source: string; position: [number, number, number]; rotation: [number, number, number, number]; yaw: number; scale?: number; objId: number }
  const asP = (e: { region: number; uid: number; source: string; position: readonly number[]; yaw: number }): P => ({
    region: e.region, uid: e.uid, source: e.source, position: [e.position[0]!, e.position[1]!, e.position[2]!],
    rotation: yawRotation(e.yaw), yaw: e.yaw, objId: objects.objIdOf(e.source),
  })
  // lowered against the export's real placements when known (the incremental convert's pre-pass cache): an edit the
  // placements pass refuses (moved or changed under the edit, unknown, no free editor uid) is refused here too, so the
  // nav and the drawn objects agree (H12-PS-3). Without them (a full convert: its nav step runs before its objects
  // step) the file's own `from` (the pass's 'edits:' warnings then name what it skipped).
  const known: P[] = exportPlacements
    ? exportPlacements.map(asP)
    : [...file.move, ...file.drop].map(e => asP({ region: e.region, uid: e.uid, source: e.source, position: e.from.position, yaw: e.from.yaw }))
  const lowered = lowerPlacementEdits<P>(known, file, {
    originRegion: origin,
    create: (a, region, uid) => asP({ region, uid, source: a.source, position: a.position, yaw: a.yaw }),
  })
  return placementNavEdits(known, lowered, { originRegion: origin, footprint: p => objects.footprint(p.objId) !== null })
}

/** The parts of the live manifest's report editsExportContext reads (what the coast, town and edits passes changed). */
export type LiveExportReport = Pick<WorldReport, 'coast' | 'town' | 'edits'>

/** A placement of the export as the edits' checks match it (WorldPlacement's fields). */
export interface ExportPlacement {
  region: number
  uid: number
  source: string
  position: readonly number[]
  yaw: number
}

const TREE_PATH = /[\\/]tree\d*[\\/]/i
const BUILDING_PATH = /^res[\\/]bldg[\\/]/i

/**
 * A model source's scale class (D12, D17; the editor's objects-view.ts kindOf): vegetation and the tree folders are
 * 'tree'; a model with a collision navmesh (`blocksWalking`, when the footprints are known and know the source) or,
 * without that knowledge, a model under res\bldg\ is a 'blocker' (never scaled); anything else is a 'prop'.
 */
export function modelKindOf(source: string, blocksWalking?: (source: string) => boolean | undefined): WorldEditModelKind {
  if (isFoliageModel(source) || TREE_PATH.test(source)) return 'tree'
  return (blocksWalking?.(source) ?? BUILDING_PATH.test(source)) ? 'blocker' : 'prop'
}

/**
 * The export context of the edits' checks (H12-PS-3, NT4) for readWorldEditsLayers (the converter's own read, and the
 * editor's Publish step 1): `placement` from the pre-pass placements (what the placements pass lowers against), with
 * the live manifest's y where the live placement still stands at the same spot (the coast's re-snap: the editor's
 * `from` comes from the export without the layers); `modelKind` for the sources the export knows (pre-pass and live
 * placements; another source is an unknown model), blockers from the collision footprints (`objects`, when known).
 * A placement the live export's own edits put there (`liveReport.edits`: a kept publish's move, drop or re-snap on
 * moved ground) is never the reference of the next publish: it keeps the pre-pass position, with the coast's and the
 * town dressing's re-snapped y from their reports (publish 11: a kept vertical move made every later publish refuse
 * the same move, "the object moved under the edit").
 */
export function editsExportContext(exp: { placements: readonly ExportPlacement[]; live?: readonly ExportPlacement[]; liveReport?: LiveExportReport },
  objects?: () => ObjectNavMeshes | null): {
    placements: ExportPlacement[]
    placement: NonNullable<WorldEditsContext['placement']>
    modelKind: NonNullable<WorldEditsContext['modelKind']>
  } {
  const key = (r: number, u: number) => `${r}:${u}`
  const live = new Map((exp.live ?? []).map(p => [key(p.region, p.uid), p]))
  const ed = exp.liveReport?.edits?.placements
  const edited = new Set([...(ed?.dropped ?? []), ...(ed?.added ?? []), ...(ed?.resnapped ?? [])].map(r => key(r.region, r.uid)))
  // the passes before the edits' (coast, then town dressing) re-snap in this order, each from the previous y
  const resnaps = new Map<string, Array<{ fromY: number; toY: number }>>()
  for (const r of [...(exp.liveReport?.coast?.placements?.resnapped ?? []), ...(exp.liveReport?.town?.placements?.resnapped ?? [])]) {
    const k = key(r.region, r.uid)
    if (!edited.has(k)) continue
    let list = resnaps.get(k)
    if (!list) resnaps.set(k, (list = []))
    list.push(r)
  }
  const placements = exp.placements.map(p => {
    const k = key(p.region, p.uid)
    if (edited.has(k)) {
      let y = p.position[1]!
      for (const r of resnaps.get(k) ?? []) if (Math.abs(r.fromY - y) <= WE_FROM_TOLERANCE_M) y = r.toY
      return y === p.position[1] ? p : { ...p, position: [p.position[0]!, y, p.position[2]!] }
    }
    const l = live.get(k)
    const same = l && l.source.toLowerCase() === p.source.toLowerCase() &&
      Math.abs(l.position[0]! - p.position[0]!) <= WE_FROM_TOLERANCE_M && Math.abs(l.position[2]! - p.position[2]!) <= WE_FROM_TOLERANCE_M
    return same ? { ...p, position: [p.position[0]!, l.position[1]!, p.position[2]!] } : p
  })
  const byKey = new Map(placements.map(p => [key(p.region, p.uid), p]))
  const sources = new Set([...exp.placements, ...(exp.live ?? [])].map(p => p.source.toLowerCase()))
  const kinds = new Map<string, WorldEditModelKind>()
  return {
    placements,
    placement: (region, uid) => {
      const p = byKey.get(key(region, uid))
      return p && { source: p.source, position: [p.position[0]!, p.position[1]!, p.position[2]!], yaw: p.yaw }
    },
    modelKind: source => {
      const k = source.toLowerCase()
      if (!sources.has(k)) return undefined
      let kind = kinds.get(k)
      if (!kind) {
        const o = objects?.() ?? null
        const blocks = o
          ? (src: string) => {
            const id = o.objIdOf(src)
            return id < 0 ? undefined : o.footprint(id) !== null
          }
          : undefined
        kinds.set(k, (kind = modelKindOf(source, blocks)))
      }
      return kind
    },
  }
}

/** A model without its swap (what the retail lightmap baked). */
function stripSwap(m: WorldModel): WorldModel {
  const { treeSwap: _t, ...rest } = m
  return rest
}

/** The objIds that carry a collision navmesh in the export's nav (the nav step wrote nav.bin before the passes). */
function navFootprints(outDir: string, warnings: string[]): Set<number> {
  const file = join(outDir, 'nav.bin')
  if (!existsSync(file)) return new Set()
  try {
    return new Set(decodeNavData(new Uint8Array(readFileSync(file))).instances.map(i => i.objId))
  } catch (e) {
    warnings.push(`world edits: ${file}: ${(e as Error).message} (objects on moved ground are all treated as footprint-free)`)
    return new Set()
  }
}

/**
 * A placement's parts as one model for the minimap footprint: the first part with its bounds grown to the union of
 * every part's (a compound's parts share the placement's transform; H12-GH-3), or undefined when no part has bounds.
 */
function unionModel(p: WorldPlacement, models: readonly WorldModel[]): WorldModel | undefined {
  let out: WorldModel | undefined
  for (const i of p.models) {
    const m = models[i]
    if (!m || m.kind === 'failed' || ![...m.boundsMin, ...m.boundsMax].every(Number.isFinite)) continue
    if (!out) out = { ...m, boundsMin: [m.boundsMin[0], m.boundsMin[1], m.boundsMin[2]], boundsMax: [m.boundsMax[0], m.boundsMax[1], m.boundsMax[2]] }
    else {
      for (let k = 0; k < 3; k++) {
        out.boundsMin[k] = Math.min(out.boundsMin[k]!, m.boundsMin[k]!)
        out.boundsMax[k] = Math.max(out.boundsMax[k]!, m.boundsMax[k]!)
      }
    }
  }
  return out ?? models[p.models[0]!]
}

/** An added placement on the minimap: its footprint quad (model bounds, at least 1.5 m square) and crown. */
function minimapAdd(p: WorldPlacement, model: WorldModel | undefined, toRegion: (gx: number, gz: number) => { x: number; z: number }): MinimapAdd {
  const s = p.scale ?? 1
  const ok = model && model.kind !== 'failed' && [...model.boundsMin, ...model.boundsMax].every(Number.isFinite)
  const ax = (ok ? Math.min(model.boundsMin[0], -0.75) : -0.75) * s
  const az = (ok ? Math.min(model.boundsMin[2], -0.75) : -0.75) * s
  const bx = (ok ? Math.max(model.boundsMax[0], 0.75) : 0.75) * s
  const bz = (ok ? Math.max(model.boundsMax[2], 0.75) : 0.75) * s
  const c = Math.cos(p.yaw)
  const sn = Math.sin(p.yaw)
  const corner = (mx: number, mz: number) => {
    const q = toRegion(p.position[0] + mx * c + mz * sn, p.position[2] - mx * sn + mz * c)
    return [q.x, q.z] as const
  }
  const centre = toRegion(p.position[0], p.position[2])
  return {
    corners: [corner(ax, az), corner(bx, az), corner(bx, bz), corner(ax, bz)],
    centre: [centre.x, centre.z], radiusM: 0.8 * Math.max(bx - ax, bz - az) / 2, vegetation: isFoliageModel(p.source),
  }
}

// --- the verbs ----------------------------------------------------------------------------------------------------------

export interface WorldEditsValidation {
  ok: boolean
  files: string[]
  problems: string[]
}

/** `pnpm sro world-edit validate`: the layers' formats and references (the shared validators; no export context). */
export async function validateWorldEdits(dir: string, world = basename(dir)): Promise<WorldEditsValidation> {
  const files = layerFiles(dir)
  if (!files.length) return { ok: true, files, problems: [] }
  const read = await readWorldEditsLayers(dir, { world })
  const problems = [...read.problems, ...read.unknown.map(f => `${f}: not a layer file`)]
  return { ok: problems.length === 0, files, problems }
}

/**
 * `pnpm sro world-edit publish` (WE-A): the World Editor's Publish from a session (docs/WORLD_EDITOR.md §6.1: "Claude can
 * run the same steps"): prepare (checks, staging convert, report), then Keep unless a check stopped it. The steps live
 * with the editor API (apps/viewer/editor-api/publish.ts), loaded only here.
 */
export async function publishWorldEdits(dir: string, world: string): Promise<{ ok: boolean; message: string }> {
  const pub = await import('../../../../../apps/viewer/editor-api/publish.ts')
  const { loadConfig, REPO_ROOT } = await import('../../node-io.ts')
  const paths = pub.publishPaths(REPO_ROOT, loadConfig().workDir, world, { layerDir: dir })
  const log = (line: string) => console.log(line)
  const r = await pub.preparePublish({ paths, log })
  if (r.phase !== 'ready') return { ok: false, message: `publish ${r.n}: ${r.sentence}` }
  const k = await pub.keepPublish({ paths, n: r.n, log })
  return { ok: k.phase === 'kept', message: `publish ${k.n}: ${k.sentence}` }
}

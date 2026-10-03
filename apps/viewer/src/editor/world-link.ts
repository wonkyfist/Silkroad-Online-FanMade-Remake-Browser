/**
 * The editor session on the live world (docs/WORLD_EDITOR.md §2.3; WAVE_PLAN8 lane WE-U): what an edit changes in
 * memory reaches the renderer through the step-0 seams, without a re-convert.
 *
 * - Heights and paint: S-TERR `TerrainRenderer.updateRegion` (positions, the normals' ring incl. the neighbours'
 *   seam, the layer words through the region build's own `layerData`), at most MAX_UPLOADS regions per frame (§5.3).
 * - Streaming keeps edits: S-FILTER (`World.setRegionFilter`) writes the layers into every region decoded later,
 *   before its mesh is built.
 * - Grass: S-GRASS `GrassField.setMask` (the live 1 m mask) and `invalidate(rect)` after a height stroke.
 * - Objects: S-OBJ `WorldObjects.setEditorOwned` (the selection leaves its batch) and `RegionStreamer.reloadObjects`
 *   (one region re-batched with its new list: the shared lowering's, i.e. the export's).
 * - Walking: the nav rule on the edited regions (heights and the Walkable overrides), swapped into the client nav
 *   (`NavWorld.addRegion` replaces a region), so the walking overlay and "Walk here" see what Publish will build: a
 *   closed tile takes the region's closed cell, a force-opened one an open neighbour's (the converter's
 *   `openNeighbourCell`), and a force-open the hard limits refuse (`walkRefusals`) stays as the rule leaves it.
 */
import {
  FULL_GRID_RECT, bakeNormalAt, grassFieldOf, relayer, renormalRing,
  type RegionData, type World,
} from '@sro/world-render'
import { editNavInstances, type NavData, type NavInstancePut, type NavModel, type NavRegion, type NavWorld } from '@sro/nav'
import {
  NAV_TILE_ACTION, guardWalkCodes, navHeightsAfter, navRuleRegion, placementNavEdits, walkRefusals, type WalkFootprintBox,
} from '../../../../packages/shared/src/world-edits/index.ts'
import type { WorldPlacement } from '../../../../packages/convert/src/world/manifest.ts'
import { footprintBox, openNeighbourCell } from '../../../../packages/convert/src/world/edits/nav-edit.ts'
import { CELLS, GRID, regionIdOf } from './lattice.ts'
import type { EditSession } from './session.ts'

/** Region uploads per frame (§5.3: ≤ 4; a corner stroke touches 4). */
export const MAX_UPLOADS = 4

/** The model cache owner id of the editor's own references (proxies, triangle counts). */
export const EDITOR_OWNER = 900_000_001

const keyOf = (p: { region: number; uid: number }) => `${p.region}:${p.uid}`

export class WorldLink {
  private readonly pendingHeights = new Map<number, { x0: number; z0: number; x1: number; z1: number }>()
  private readonly pendingWords = new Map<number, { x0: number; z0: number; x1: number; z1: number }>()
  private readonly pendingMasks = new Set<number>()
  private readonly navOriginal = new Map<number, NavRegion>()
  private readonly navEdited = new Set<number>()
  private readonly objSig = new Map<number, string>()
  private readonly homeLists = new Map<number, WorldPlacement[]>()
  private readonly homeById = new Map<WorldPlacement, number>()
  private readonly tris = new Map<number, number>()
  private readonly acquiredTiles = new Set<number>()
  /** Owner keys (`region:uid`) the editor draws itself (the selection), and the regions they sit in. */
  private owned = new Set<string>()
  private ownedRegions = new Set<number>()
  private objectsBusy: Promise<void> = Promise.resolve()
  private lastObjectsVersion = -1
  /** Lowering problems of the last object sync (unknown sources, uid range full...). */
  objectProblems: string[] = []
  /** Uploads and their time this frame (the editor's frame budget, §7.1). */
  stats = { uploads: 0, uploadMs: 0, worstUploadMs: 0 }

  constructor(readonly world: World, readonly session: EditSession, private readonly invalidate: () => void) {
    const m = world.manifest
    const exported = new Set(m.regions.map(r => r.id))
    const ox = m.space.originRegion.x, oz = m.space.originRegion.z
    for (const p of m.placements) {
      const own = exported.has(p.region) ? p.region : regionIdOf(ox + Math.floor(p.position[0] / 192), oz + Math.floor(-p.position[2] / 192))
      const home = exported.has(own) ? own : nearestRegion(m.regions, p.position[0], p.position[2])
      this.homeById.set(p, home)
      let list = this.homeLists.get(home)
      if (!list) this.homeLists.set(home, (list = []))
      list.push(p)
    }
  }

  /** The region a placement streams with (stream.ts `regionInfos`' rule). */
  homeOf = (p: WorldPlacement): number => {
    const h = this.homeById.get(p)
    if (h !== undefined) return h
    // an add or a moved copy: its owner (always an exported region: the editor refuses others)
    return p.region
  }

  /** The export's placements streamed with a region. */
  originalList(region: number): WorldPlacement[] {
    return this.homeLists.get(region) ?? []
  }

  install(): void {
    const w = this.world
    w.setRegionFilter((rx, rz, decoded) => this.filter(regionIdOf(rx, rz), decoded))
    w.objects.setEditorOwned(p => this.owned.has(keyOf(p)))
    // a region streamed in again: its nav preview and grass mask follow (the terrain filter already ran)
    w.addCommitStep('editor-region', data => {
      const id = data.region.id
      if (this.navEdited.has(id) || this.session.walk.codesOf(id)) {
        this.navOriginal.delete(id)
        this.refreshNav([id])
      }
      if (this.session.grass.touchedRegions().includes(id)) this.pendingMasks.add(id)
      this.invalidate()
    }, 'terrain')
    this.session.onChange(() => this.invalidate())
  }

  /** S-FILTER: a region decoded (streamed in again): the export's data become the base, the edits go on top. */
  private filter(id: number, decoded: RegionData): void {
    const t = decoded.terrain
    const changed = this.session.heights.captureBase(id, t.heights)
    if (changed.length) {
      const neighbour = (dx: number, dz: number) => this.world.regions.get(regionIdOf((id & 0xff) + dx, (id >> 8) + dz))?.terrain ?? null
      for (const [dx, dz, i] of renormalRing(t, changed, neighbour)) {
        const n = this.world.regions.get(regionIdOf((id & 0xff) + dx, (id >> 8) + dz))
        if (n) bakeNormalAt(n.terrain, i % GRID, Math.floor(i / GRID), (ddx, ddz) => this.world.regions.get(regionIdOf((id & 0xff) + dx + ddx, (id >> 8) + dz + ddz))?.terrain ?? null)
      }
    }
    const words = this.session.paint.captureBase(id, t.textures)
    if (words) relayer(t, words, FULL_GRID_RECT)
  }

  /** Paint needs its tile in the streamer's atlas before the first stroke (S-TERR: else it draws as layer 0). */
  async acquireTile(tile: number): Promise<void> {
    if (this.acquiredTiles.has(tile)) return
    this.acquiredTiles.add(tile)
    await this.world.stream?.atlas.acquire([tile], () => 0)
  }

  /** Per frame: the dirty regions' heights, words and grass masks to the GPU (≤ MAX_UPLOADS regions). */
  flush(): number {
    const t0 = performance.now()
    const s = this.session
    for (const { id, rect } of s.heights.takeDirty()) this.grow(this.pendingHeights, id, rect)
    for (const { id, rect } of s.paint.takeDirty()) this.grow(this.pendingWords, id, rect)
    for (const id of s.grass.takeDirty()) this.pendingMasks.add(id)
    let uploads = 0
    for (const [id, rect] of this.pendingHeights) {
      if (uploads >= MAX_UPLOADS) break
      this.pendingHeights.delete(id)
      const data = this.world.regions.get(id)
      if (!data) continue
      const r = this.world.terrain.updateRegion(id, { heights: data.terrain.heights }, rect)
      if (r?.heights) for (const rid of [id, ...r.neighbours]) this.refreshBounds(rid)
      uploads++
    }
    for (const [id, rect] of this.pendingWords) {
      if (uploads >= MAX_UPLOADS) break
      this.pendingWords.delete(id)
      if (!this.world.regions.get(id)) continue
      const words = s.paint.wordsFor(id)
      if (words) this.world.terrain.updateRegion(id, { words }, rect)
      uploads++
    }
    const field = grassFieldOf(this.world.scatter)
    if (field?.setMask) {
      for (const id of [...this.pendingMasks]) {
        if (!this.world.regions.get(id)) {
          this.pendingMasks.delete(id)
          continue
        }
        if (field.setMask(id, s.grass.mask(id))) this.pendingMasks.delete(id)
      }
    } else this.pendingMasks.clear()
    const ms = performance.now() - t0
    this.stats.uploads = uploads
    this.stats.uploadMs = ms
    if (ms > this.stats.worstUploadMs) this.stats.worstUploadMs = ms
    if (uploads) this.invalidate()
    return uploads
  }

  /**
   * A region's culling box after its vertices changed. S-TERR re-uploads the positions of a mesh whose world matrix is
   * frozen (terrain.ts `setVertices`), which leaves its bounding box in region-local metres: frustum culling then
   * drops the region whenever the camera is not over the export's origin region (the ground vanished under the sea in
   * the user check). Refreshing the bounding info against the frozen world matrix puts it back.
   */
  private refreshBounds(id: number): void {
    const mesh = this.world.terrain.region(id)?.mesh as { refreshBoundingInfo?: () => unknown } | undefined
    mesh?.refreshBoundingInfo?.()
  }

  /** Something is still waiting for the GPU (draw the next frame). */
  get pending(): boolean {
    return this.pendingHeights.size + this.pendingWords.size + this.pendingMasks.size > 0
  }

  /** After a height stroke: the grass re-bakes under it (S-GRASS) and the walking preview follows (nav rule). */
  afterHeights(regions: readonly number[], rect: { x0: number; z0: number; x1: number; z1: number } | null): void {
    grassFieldOf(this.world.scatter)?.invalidate?.(rect)
    this.refreshNav(regions)
  }

  // ---- walking --------------------------------------------------------------------------------------------------------

  private navWorld(): NavWorld | null {
    try {
      return this.world.navWorld
    } catch {
      return null
    }
  }

  /** The client nav's own region (the export's, before the editor's preview replaced it). */
  navRegion(id: number): NavRegion | null {
    const orig = this.navOriginal.get(id)
    if (orig) return orig
    const nw = this.navWorld() as unknown as { regions?: Map<number, NavRegion> } | null
    return nw?.regions?.get(id) ?? null
  }

  /** Per region: the nav rule's result (null: no nav or no base). */
  navRule(id: number): ReturnType<typeof navRuleRegion> | null {
    const nav = this.navRegion(id)
    const base = this.session.heights.baseOf(id)
    const data = this.world.regions.get(id)
    if (!nav || !base || !data) return null
    const open = new Uint8Array(CELLS * CELLS)
    for (let t = 0; t < open.length; t++) {
      const c = nav.tileCells[t]!
      open[t] = c >= 0 && c < nav.openCellCount ? 1 : 0
    }
    return navRuleRegion({ before: base, after: data.terrain.heights, open, walk: this.walkCodes(id) })
  }

  /** The region's Walkable overrides as Publish applies them (a force-open the hard limits refuse is ignored), or null. */
  walkCodes(id: number): Uint8Array | null {
    const codes = this.session.walk.codesOf(id)
    return codes ? guardWalkCodes(codes, this.walkRefusals(id)).codes : null
  }

  private refusalData: NavData | null | undefined = undefined
  private refusalCoast: World['coast'] | undefined = undefined
  private refusalBoxes: WalkFootprintBox[] = []
  private readonly refusalCache = new Map<number, Uint8Array>()
  private readonly modelBoxes = new Map<NavModel, WalkFootprintBox | null>()

  /**
   * The Walkable brush's hard limits of a region (shared `walkRefusals`, the converter's rule): outside
   * `stream.playable`, in the coast's sea mask, under a collision footprint as the walk preview holds it now (moved,
   * deleted and placed objects included). Cached until the nav's instances or the coast field change.
   */
  walkRefusals(id: number): Uint8Array {
    const data = this.navWorld()?.data ?? null
    const coast = this.world.coast
    if (this.refusalData !== data || this.refusalCoast !== coast) {
      this.refusalCache.clear()
      this.refusalData = data
      this.refusalCoast = coast
      this.refusalBoxes = data ? this.footprints(data) : []
    }
    let r = this.refusalCache.get(id)
    if (!r) {
      const m = this.world.manifest
      r = walkRefusals(id & 0xff, id >> 8, {
        playable: m.stream?.playable ?? null, seaAt: coast ? (x, z) => coast.seaAt(x, z) : null, origin: m.space.originRegion,
      }, this.refusalBoxes)
      this.refusalCache.set(id, r)
    }
    return r
  }

  /** Every instance's collision box (world file space), from its navmesh's XZ bounds (the converter's footprint). */
  private footprints(data: NavData): WalkFootprintBox[] {
    const out: WalkFootprintBox[] = []
    for (const inst of data.instances) {
      const model = data.models[inst.model]
      if (!model) continue
      let fp = this.modelBoxes.get(model)
      if (fp === undefined) {
        fp = null
        const v = model.vertices
        if (v.length >= 9) {
          fp = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity }
          for (let i = 0; i < v.length; i += 3) {
            if (v[i]! < fp.minX) fp.minX = v[i]!
            if (v[i]! > fp.maxX) fp.maxX = v[i]!
            if (v[i + 2]! < fp.minZ) fp.minZ = v[i + 2]!
            if (v[i + 2]! > fp.maxZ) fp.maxZ = v[i + 2]!
          }
        }
        this.modelBoxes.set(model, fp)
      }
      out.push(footprintBox(inst, fp))
    }
    return out
  }

  /**
   * Swaps the previewed nav of each region into the client NavWorld: heights moved by the layer (file units = m × 10),
   * tiles the nav rule closes made closed, tiles it opens (the Walkable brush) given an open neighbour's cell, as the
   * converter does (closes first, then opens). A region back to the export gets its own nav back.
   */
  refreshNav(regions: readonly number[]): void {
    const nw = this.navWorld()
    if (!nw) return
    for (const id of regions) {
      const orig = this.navRegion(id)
      if (!orig) continue
      const layer = this.session.heights.layer(id)
      if (!layer && !this.session.walk.codesOf(id)) {
        if (this.navEdited.has(id)) {
          nw.addRegion(orig)
          this.navEdited.delete(id)
          this.navOriginal.delete(id)
        }
        continue
      }
      this.navOriginal.set(id, orig)
      const rule = this.navRule(id)
      const tileCells = Int32Array.from(orig.tileCells)
      if (rule?.closed) {
        let closedCell = orig.openCellCount
        for (const c of orig.tileCells) if (c >= orig.openCellCount) {
          closedCell = c
          break
        }
        for (let t = 0; t < tileCells.length; t++) if (rule.actions[t] === NAV_TILE_ACTION.close) tileCells[t] = closedCell
      }
      if (rule?.opened) {
        for (let t = 0; t < tileCells.length; t++) {
          if (rule.actions[t] !== NAV_TILE_ACTION.open) continue
          const cell = openNeighbourCell(tileCells, orig.openCellCount, t % CELLS, Math.floor(t / CELLS))
          if (cell >= 0) tileCells[t] = cell
        }
      }
      nw.addRegion({ ...orig, heights: layer ? navHeightsAfter(orig.heights, layer) : orig.heights, tileCells })
      this.navEdited.add(id)
    }
  }

  // ---- objects --------------------------------------------------------------------------------------------------------

  /** The editor draws these placements itself (owner keys `region:uid`); their regions re-batch without them. */
  setOwned(keys: ReadonlySet<string>, regions: ReadonlySet<number>): Promise<void> {
    const changed = new Set<number>([...this.ownedRegions, ...regions])
    const same = keys.size === this.owned.size && [...keys].every(k => this.owned.has(k))
    this.owned = new Set(keys)
    this.ownedRegions = new Set(regions)
    return same ? this.objectsBusy : this.syncObjects(changed)
  }

  /**
   * Re-lowers the object edits and re-batches every region whose list changed (or `force`d). Chained: one sync at a
   * time, so the last state always wins.
   */
  syncObjects(force: ReadonlySet<number> = new Set()): Promise<void> {
    this.objectsBusy = this.objectsBusy.then(() => this.doSync(force)).catch(err => {
      console.error('[editor] object sync failed', err)
    })
    return this.objectsBusy
  }

  private lowCache: { version: number; value: ReturnType<EditSession['objects']['lower']> } | null = null

  /** The shared lowering of the object edits (cached until they change). */
  lowered(): ReturnType<EditSession['objects']['lower']> {
    const v = this.session.objects.version
    if (this.lowCache?.version !== v) this.lowCache = { version: v, value: this.session.objects.lower(this.homeOf) }
    return this.lowCache.value
  }

  private async doSync(force: ReadonlySet<number>): Promise<void> {
    const stream = this.world.stream
    if (!stream) return
    const low = this.lowered()
    this.objectProblems = low.problems
    this.lastObjectsVersion = this.session.objects.version
    const jobs: Promise<boolean>[] = []
    const seen = new Set<number>()
    const reload = (id: number, list: readonly WorldPlacement[] | null, sig: string | null) => {
      seen.add(id)
      if (sig !== null && sig === this.objSig.get(id) && !force.has(id)) return
      if (sig === null) this.objSig.delete(id)
      else this.objSig.set(id, sig)
      jobs.push(stream.reloadObjects(id & 0xff, id >> 8, list ? { placements: list } : { placements: this.originalList(id) }))
    }
    for (const [id, list] of low.regions) reload(id, list, signature(list))
    for (const id of [...this.objSig.keys()]) if (!seen.has(id)) reload(id, null, null)
    for (const id of force) if (!seen.has(id)) reload(id, null, null)
    await Promise.all(jobs)
    this.syncNavObjects(low)
    this.invalidate()
  }

  private navData0: NavData | null = null
  private navModelByObj: Map<number, NavModel> | null = null

  /**
   * The walk preview follows moved, dropped and added footprints (S-NAV, D54): the shared `placementNavEdits` on the
   * lowered edits, applied to the client NavWorld as the difference from what it holds now (instances by id
   * regionId << 16 | uid; the footprint keeps its unscaled size, D17).
   */
  private syncNavObjects(low: ReturnType<EditSession['objects']['lower']>): void {
    const nw = this.navWorld()
    if (!nw) return
    try {
      this.navData0 ??= nw.data
      const base = this.navData0
      if (!this.navModelByObj) {
        this.navModelByObj = new Map()
        for (const inst of base.instances) if (!this.navModelByObj.has(inst.objId)) this.navModelByObj.set(inst.objId, base.models[inst.model]!)
      }
      const byObj = this.navModelByObj
      const drop = [...low.regions.values()].length ? lowDrops(this.session, low) : []
      const add = [...low.regions.values()].flat().filter(p => p.uid >= 0xe000 || this.session.objects.edited(`r:${p.region}:${p.uid}`))
      const edits = placementNavEdits(this.world.manifest.placements, { drop, add }, { originRegion: this.world.manifest.space.originRegion, footprint: p => byObj.has(p.objId) })
      const target = editNavInstances(base, {
        remove: edits.remove,
        put: edits.put.map((q): NavInstancePut => ({ id: q.id, objId: q.objId, model: byObj.get(q.objId)!, x: q.x, y: q.y, z: q.z, yaw: q.yaw })),
      }).data
      const want = new Map(target.instances.map(i => [i.id >>> 0, i]))
      const have = new Map(nw.data.instances.map(i => [i.id >>> 0, i]))
      const remove: number[] = []
      const put: NavInstancePut[] = []
      for (const id of have.keys()) if (!want.has(id)) remove.push(id)
      for (const [id, i] of want) {
        const h = have.get(id)
        if (h && h.x === i.x && h.y === i.y && h.z === i.z && h.yaw === i.yaw && h.objId === i.objId) continue
        put.push({ id, objId: i.objId, model: target.models[i.model]!, x: i.x, y: i.y, z: i.z, yaw: i.yaw })
      }
      if (remove.length || put.length) nw.editInstances({ remove, put })
    } catch (err) {
      console.warn('[editor] the walk preview could not follow the objects:', err)
    }
  }

  /** Whether the object edits changed since the last sync. */
  get objectsStale(): boolean {
    return this.session.objects.version !== this.lastObjectsVersion
  }

  /** A model's LOD 0 triangles (once its glb is in the cache), for the budget line. */
  trianglesOf = (model: number): number | undefined => {
    const t = this.tris.get(model)
    if (t !== undefined) return t
    // a skinned model draws (and is cached) as its static variant on the batch path
    const variant = this.world.manifest.models[model]?.staticVariant
    const cached = this.world.stream?.models.peek(model) ?? (variant !== undefined && variant !== null ? this.world.stream?.models.peek(variant) : null)
    if (!cached) return undefined
    let n = 0
    for (const m of cached.container.meshes) n += (m.getTotalIndices?.() ?? 0) / 3
    this.tris.set(model, Math.round(n))
    return this.tris.get(model)
  }

  private grow(map: Map<number, { x0: number; z0: number; x1: number; z1: number }>, id: number, r: { x0: number; z0: number; x1: number; z1: number }): void {
    const cur = map.get(id)
    if (!cur) map.set(id, { ...r })
    else {
      cur.x0 = Math.min(cur.x0, r.x0)
      cur.z0 = Math.min(cur.z0, r.z0)
      cur.x1 = Math.max(cur.x1, r.x1)
      cur.z1 = Math.max(cur.z1, r.z1)
    }
  }
}

function signature(list: readonly WorldPlacement[]): string {
  let s = `${list.length}|`
  for (const p of list) s += `${p.uid}:${p.position[0]},${p.position[1]},${p.position[2]},${p.yaw},${p.scale ?? 1};`
  return s
}

function nearestRegion(regions: ReadonlyArray<{ id: number; origin: number[] }>, x: number, z: number): number {
  let best = regions[0]?.id ?? 0
  let bestD = Infinity
  for (const r of regions) {
    const x0 = r.origin[0]!, z0 = r.origin[2]!
    const dx = x < x0 ? x0 - x : x > x0 + 192 ? x - x0 - 192 : 0
    const dz = z > z0 ? z - z0 : z < z0 - 192 ? z0 - 192 - z : 0
    const d = Math.hypot(dx, dz)
    if (d < bestD) {
      bestD = d
      best = r.id
    }
  }
  return best
}

/** The lowered drops as references (every edited retail placement leaves its old key: moves and deletes). */
function lowDrops(session: EditSession, _low: unknown): Array<{ region: number; uid: number }> {
  const out: Array<{ region: number; uid: number }> = []
  for (const ref of session.objects.editedRefs()) {
    const p = session.objects.placementOf(ref)
    if (p) out.push({ region: p.region, uid: p.uid })
  }
  return out
}

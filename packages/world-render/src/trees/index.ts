/**
 * The trees part (docs/TREES.md Part W §W3.1–§W3.3, §W3.9; docs/WAVE_PLAN8.md §6.2 T12-N, D16, D24, D25). World calls
 * `createTreesPart` only where the swap applies (the PBR path of a streamed world with batching on and trees 'new';
 * World.trees stays null on the Classic path: the Low guard). Owner: T12-N.
 *
 * What it does, per frame after the objects (World.update):
 * - **The slots** (bands.ts `TreeSlots`): a region listener on the objects. Every placement the region batch merges as
 *   a species (`placed` with no meshes, the batch's own `swapOf`) gets a band slot keyed by placementKey(region, uid)
 *   before its region's merge job is built; T12-M's plan reads it through `slotOf` (batch/trees.ts `treeSlotsOf`). A
 *   reload places the key again under a new owner before the old one goes, so the slot stays; the last owner's
 *   `removed` frees it (its byte goes to hidden).
 * - **The bands** (bands.ts): refilled when the camera moved REFILL_STEP_M (4 m), the range scale changed (Options'
 *   sight, the create screen's 0.6), the crowded-plaza rule flipped, a region's batch landed or went, a species' overlay
 *   became ready, or the editor hid or previewed a tree. Each refill writes every slot's byte (3 m hysteresis) and
 *   uploads the R8 texture once when a byte changed; T12-W's SRO_FOL_BAND reads it (`FoliageShared.setBand`, set when the
 *   first slot is handed out).
 * - **The near field** (near-field.ts): the band-0 trees of each species as its LOD0 overlay, drawn only once their
 *   region's batch has landed (the batch part's `batchOf`, checked every frame; `batched`), so no tree shows before
 *   its region and none is missing the frame its region lands.
 * - **The crowded-plaza rule (D24):** on Medium with ≥ 15 players in range the overlay draws within 20 m only. The player
 *   count comes from `setPlayers` when the app calls it, else from the town part's own count (its `stats().players`,
 *   read every PLAYER_POLL_S), which counts the player characters in the crowd's range.
 * - **The editor (T12-E's API, §W3.9):** `setHidden(key, on)` puts a placement in band 3 (its merged copy and its
 *   overlay instance go at once); `preview(key, species, matrix)` hides `key` and draws one overlay instance of `species`
 *   at `matrix`. `library()` is T12-E's (`trees/editor.ts`).
 */
import { Matrix, Vector3, type AbstractMesh, type Camera } from '@babylonjs/core'
import type { WorldModel, WorldPlacement } from '../../../convert/src/world/manifest.ts'
import type { PlacedModelInfo, RegionListener } from '../objects.ts'
import type { TreeLibraryEntry, TreesHost, TreesPart } from './types.ts'
import { placementKey } from './types.ts'
import {
  BAND_FAR,
  BAND_HIDDEN,
  BAND_MID,
  BAND_NEAR,
  BAND_NONE,
  CROWD_NEAR_M,
  CROWD_PLAYERS,
  REFILL_STEP_M,
  TreeBandTexture,
  TreeSlots,
  bandFor,
  bandRule,
  type SlotEntry,
} from './bands.ts'
import { NearField, assetNearLoader, type NearLoader, type SpeciesOverlay } from './near-field.ts'
import { speciesIdOf, swapMatrixTo, swapSphere, treeBatchOf, treeTablesOf } from './swap.ts'
import { treeLibraryOf } from './editor.ts'
import { CrowdLatch } from '../crowd-latch.ts'

export { TREES_MODES, placementKey, placementOfKey } from './types.ts'
export type { TreeLibraryEntry, TreesFactory, TreesHost, TreesMode, TreesPart } from './types.ts'
export * from './bands.ts'
export {
  IDLE_DROP_S,
  NearField,
  SRO_TREE_TINT_PLUGIN,
  SpeciesOverlay,
  SroTreeTintPlugin,
  TREE_TINT_DEFINES,
  TREE_TINT_KIND,
  assetNearLoader,
  hasTreeTint,
  treeTintCode,
  treeTintPluginOf,
  type NearLoader,
  type NearModel,
} from './near-field.ts'
export { nearFilesOf, speciesIdOf, swapMatrixTo, swapSphere, treeBatchOf, treeTablesOf, type TreeBatchLike, type TreeTintsLike } from './swap.ts'

/** The town part's player count is read this often (s) while the app does not call `setPlayers`. */
export const PLAYER_POLL_S = 0.5

/** A trees part that draws nothing (the seam's stand-in; tests). */
export class StubTrees implements TreesPart {
  /** Placement keys the editor hid (band 3 once the bands land). */
  readonly hidden = new Set<number>()
  /** The live preview (null: none). */
  previewing: { key: number | null; species: string; matrix: Float32Array | null } | null = null
  private disposed = false

  constructor(readonly host: TreesHost) {}

  update(_camera: Camera | null, _dt: number): void {}

  meshes(): AbstractMesh[] {
    return []
  }

  library(): readonly TreeLibraryEntry[] {
    return []
  }

  preview(key: number | null, species: string | null, matrix?: ArrayLike<number> | null): void {
    if (this.disposed) return
    this.previewing = species === null ? null : { key, species, matrix: matrix ? Float32Array.from(matrix) : null }
  }

  setHidden(key: number, on: boolean): void {
    if (this.disposed) return
    if (on) this.hidden.add(key)
    else this.hidden.delete(key)
  }

  stats(): Readonly<Record<string, number>> {
    return { hidden: this.hidden.size, previews: this.previewing ? 1 : 0 }
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  dispose(): void {
    this.disposed = true
    this.hidden.clear()
    this.previewing = null
  }
}

/** A species' kind (far.json `trees.kind`): a tree has the LOD0 overlay, a plant two merged tiers only. */
export type SpeciesKind = 'tree' | 'plant'

/** Reads a species' kind (default: its manifest sidecar, `far.json` `trees.kind`). */
export type SpeciesKindLoader = (species: WorldModel) => Promise<SpeciesKind | null>

/** Options of the trees part (tests hand in their own loaders). */
export interface TreesOptions {
  /** The LOD0 loader (default: `near.glb` + `near.json` from the world's assets). */
  load?: NearLoader
  /** The species kind (default: `far.json` `trees.kind` from the world's assets). */
  kindOf?: SpeciesKindLoader
  /** The crowded-plaza rule's near distance (CROWD_NEAR_M; cut item 17: 0). */
  crowdNearM?: number
  /** A clock (ms; default performance.now). */
  now?: () => number
}

interface SpeciesInfo {
  readonly model: WorldModel
  kind: SpeciesKind | null
}

/** The objects' static visibility (WorldObjects.setStaticVisible: the viewer's toggle), duck-typed. */
function staticVisible(objects: unknown): boolean {
  return (objects as { showStatic?: boolean } | null | undefined)?.showStatic !== false
}

/**
 * T12-N's trees part (World.trees): the band slots, the band texture and the LOD0 overlay (see the file comment). Also
 * the band-slot source T12-M's merge reads (`slotOf`).
 */
export class TreesNearField implements TreesPart {
  readonly slots = new TreeSlots()
  readonly bands: TreeBandTexture
  readonly near: NearField
  /** Placement keys the editor hid (band 3). */
  readonly hidden = new Set<number>()
  /** The live preview (null: none). */
  previewing: { key: number | null; species: number; matrix: Float32Array | null } | null = null
  private readonly species = new Map<number, SpeciesInfo>()
  private speciesById: Map<string, WorldModel> | null = null
  /** Region loads whose batch has landed (the overlay draws their trees). */
  private readonly readyOwners = new Set<number>()
  /** Region loads that placed swapped trees and whose batch has not landed yet (checked every frame). */
  private readonly pendingOwners = new Set<number>()
  private readonly offListener: () => void
  private readonly kindOf: SpeciesKindLoader
  private readonly crowdNearM: number
  private readonly now: () => number
  private readonly last = new Vector3(NaN, NaN, NaN)
  private lastScale = NaN
  private lastCrowd = false
  private lastVisible = true
  private dirty = true
  private bandOn = false
  private players = 0
  /** CR-1: on at CROWD_PLAYERS, off only CROWD_OFF_GAP below it (a count on the line never flickers the rule). */
  private readonly crowdLatch = new CrowdLatch(CROWD_PLAYERS)
  private playersSet = false
  private poll = 0
  private disposed = false
  private readonly tmp = new Matrix()
  private readonly sphere = new Float32Array(4)
  private readonly counters = {
    refills: 0, refillMs: 0, refillMaxMs: 0, placed: 0, freed: 0, band0: 0, band1: 0, band2: 0, band3: 0, overlayDraws: 0, overlayInstances: 0,
  }

  constructor(readonly host: TreesHost, opts: TreesOptions = {}) {
    const world = host.world
    this.bands = new TreeBandTexture(host.scene)
    this.near = new NearField({
      scene: host.scene,
      materials: world.materials,
      foliage: world.foliage ?? null,
      load: opts.load ?? assetNearLoader(host.scene, world.assets),
    })
    this.kindOf = opts.kindOf ?? (async species => {
      if (!species.sidecar) return null
      const side = await world.assets.json<{ trees?: { kind?: unknown } }>(species.sidecar)
      const k = side?.trees?.kind
      return k === 'plant' ? 'plant' : k === 'tree' ? 'tree' : null
    })
    this.crowdNearM = opts.crowdNearM ?? CROWD_NEAR_M
    this.now = opts.now ?? (() => performance.now())
    const listener: RegionListener = {
      placed: (owner, model, info, meshes, placements) => this.placed(owner, model, info, meshes, placements),
      removed: owner => this.removed(owner),
      batched: owner => {
        if (this.disposed) return
        this.pendingOwners.delete(owner)
        if (this.readyOwners.has(owner)) return
        this.readyOwners.add(owner)
        this.dirty = true
      },
    }
    this.offListener = world.objects.addRegionListener(listener)
  }

  // ---- the slots ----------------------------------------------------------------------------------------------------

  /** The band slot of a placement key (T12-M's TreeSlotSource), or null (none: its LOD1 draws at every distance). */
  slotOf(key: number): number | null {
    return this.disposed ? null : this.slots.slotOf(key)
  }

  /** The band texture (T12-W's `sroTreeBand`; null until the first slot). */
  get bandTexture() {
    return this.bands.texture
  }

  private placed(owner: number, model: WorldModel, info: PlacedModelInfo, meshes: readonly AbstractMesh[], placements: readonly WorldPlacement[]): void {
    if (this.disposed || owner < 0 || meshes.length || info.kind !== 'static' || !placements.length) return
    const batch = treeBatchOf(this.host.world)
    const swap = batch?.swapOf(model) ?? null
    if (!batch || !swap) return
    const species = swap.species
    this.near.bind(treeTablesOf(batch), batch.tints ?? null, batch.materials?.breeze ?? null)
    const sp = this.speciesInfo(species)
    this.ensureOverlay(sp)
    if (!this.bandOn) this.enableBands()
    if (!this.readyOwners.has(owner)) this.pendingOwners.add(owner)
    const offset = model.treeSwap?.offset
    const known = this.last.x === this.last.x
    for (const p of placements) {
      const got = this.slots.acquire(placementKey(p.region, p.uid), owner)
      if (!got) continue
      const e = got.entry
      e.species = species.index
      e.tint = swap.tint
      swapMatrixTo(p, swap.fit, offset, e.matrix, 0, this.tmp)
      swapSphere(species, e.matrix, this.sphere)
      e.x = this.sphere[0]!
      e.y = this.sphere[1]!
      e.z = this.sphere[2]!
      e.r = this.sphere[3]!
      this.counters.placed++
      if (!got.fresh) continue
      // A new slot's byte before its region's merge is built: its band from the last camera (else mid: LOD1 shows).
      let band = BAND_MID
      if (this.hidden.has(e.key)) band = BAND_HIDDEN
      else if (known) {
        const d = Math.hypot(e.x - this.last.x, e.y - this.last.y, e.z - this.last.z) - e.r
        band = bandFor(d, sp.kind === 'plant', BAND_NONE, bandRule(this.lastScale, this.lastCrowd, this.crowdNearM), this.near.get(e.species)?.state === 'ready')
      }
      e.band = band
      this.bands.set(e.slot, band)
    }
    if (this.slots.refused) this.warnFull()
    this.dirty = true
  }

  private warned = false
  private warnFull(): void {
    if (this.warned) return
    this.warned = true
    console.warn(`[trees] all ${this.slots.capacity} band slots are taken: further trees draw their LOD1 at every distance`)
  }

  private removed(owner: number): void {
    if (this.disposed) return
    this.readyOwners.delete(owner)
    this.pendingOwners.delete(owner)
    const freed = this.slots.releaseOwner(owner)
    for (const e of freed) this.bands.set(e.slot, BAND_HIDDEN)
    this.counters.freed += freed.length
    this.dirty = true
  }

  /** Sets the band texture on the foliage plugins (T12-W: before the first slot is handed out). */
  private enableBands(): void {
    this.bandOn = true
    const tex = this.bands.ensure()
    const shared = (this.host.world.foliage as { shared?: { setBand?: (t: unknown) => void } } | null | undefined)?.shared
    shared?.setBand?.(tex)
  }

  /** A species' info (its kind loads once; a tree's overlay starts loading when its kind is known). */
  private speciesInfo(model: WorldModel): SpeciesInfo {
    let sp = this.species.get(model.index)
    if (sp) return sp
    const made: SpeciesInfo = { model, kind: null }
    sp = made
    this.species.set(model.index, made)
    void this.kindOf(model).catch(() => null).then(kind => {
      if (this.disposed) return
      made.kind = kind ?? 'tree'
      this.ensureOverlay(made)
      this.dirty = true
    })
    return made
  }

  /** A tree species' overlay set (made and loading once the batch's table is bound; plants have none). */
  private ensureOverlay(sp: SpeciesInfo): void {
    if (sp.kind === 'tree') this.near.want(sp.model)
  }

  // ---- the frame ---------------------------------------------------------------------------------------------------

  /** Players in range for the crowded-plaza rule (the app's count; the town part's otherwise). */
  setPlayers(n: number): void {
    this.playersSet = true
    this.players = Math.max(0, Math.floor(n) || 0)
    this.crowdLatch.update(this.players)
  }

  /** The crowded-plaza rule is on (Medium, ≥ CROWD_PLAYERS players in range; off again at CROWD_OFF_GAP fewer). */
  get crowded(): boolean {
    return this.host.world.quality === 'medium' && this.crowdLatch.on
  }

  private pollPlayers(dt: number): void {
    // nothing swapped (an export without treeSwap): no rule to apply, no town stats to read
    if (this.playersSet || !this.slots.used) return
    this.poll -= dt
    if (this.poll > 0) return
    this.poll = PLAYER_POLL_S
    if (this.host.world.quality !== 'medium') {
      this.players = 0
      this.crowdLatch.update(0)
      return
    }
    try {
      const n = (this.host.world.town as { stats?: () => Readonly<Record<string, number>> } | null)?.stats?.().players
      this.players = typeof n === 'number' && n > 0 ? Math.floor(n) : 0
    } catch {
      this.players = 0
    }
    this.crowdLatch.update(this.players)
  }

  update(camera: Camera | null, dt: number): void {
    if (this.disposed) return
    this.near.age(dt)
    this.pollPlayers(dt)
    if (this.near.changed) {
      this.near.changed = false
      this.dirty = true
    }
    if (this.pendingOwners.size) this.checkLanded()
    const cam = camera?.globalPosition
    if (!cam) return
    const scale = this.host.world.objects.drawRangeScale
    const crowd = this.crowded
    const visible = staticVisible(this.host.world.objects)
    const dx = cam.x - this.last.x, dy = cam.y - this.last.y, dz = cam.z - this.last.z
    const moved = !(dx * dx + dy * dy + dz * dz < REFILL_STEP_M * REFILL_STEP_M)
    if (!moved && !this.dirty && scale === this.lastScale && crowd === this.lastCrowd && visible === this.lastVisible) return
    this.refill(cam, scale, crowd, visible)
  }

  /** Writes every slot's band and the overlay's instance lists (see the file comment). */
  private refill(cam: Vector3, scale: number, crowd: boolean, visible: boolean): void {
    const t0 = this.now()
    this.dirty = false
    this.last.copyFrom(cam)
    this.lastScale = scale
    this.lastCrowd = crowd
    this.lastVisible = visible
    const rule = bandRule(scale, crowd, this.crowdNearM)
    // The overlay's minimum breeze follows the merged groups' (the lab's knob).
    const breeze = treeBatchOf(this.host.world)?.materials?.breeze
    if (typeof breeze === 'number') this.near.setBreeze(breeze)
    for (const s of this.near.all()) {
      s.users = 0
      s.begin()
    }
    const c = this.counters
    c.band0 = c.band1 = c.band2 = c.band3 = 0
    const pv = this.previewing
    const hide = this.hidden.size > 0 || pv !== null
    const cx = cam.x, cy = cam.y, cz = cam.z
    // The species of the previous entry (entries come in placement order: runs of one species).
    let lastSpecies = -2
    let plant = false
    let set: SpeciesOverlay | null = null
    let overlay = false
    // H-12 TD-1: a placement the batch merged unbanded (the table refused its species record) keeps its LOD1 near
    const tb = treeBatchOf(this.host.world)
    const unbanded = tb?.unbanded ? (key: number) => tb.unbanded!(key) : null
    for (const e of this.slots.entries()) {
      if (e.species !== lastSpecies) {
        lastSpecies = e.species
        plant = this.species.get(e.species)?.kind === 'plant'
        set = plant ? null : this.near.get(e.species)
        overlay = set?.state === 'ready'
      }
      if (set) set.users++
      let band: number
      if (hide && (this.hidden.has(e.key) || (pv !== null && pv.key === e.key))) band = BAND_HIDDEN
      else {
        const dx = e.x - cx, dy = e.y - cy, dz = e.z - cz
        band = bandFor(Math.sqrt(dx * dx + dy * dy + dz * dz) - e.r, plant, e.band, rule, overlay && !unbanded?.(e.key))
      }
      e.band = band
      this.bands.set(e.slot, band)
      if (band === BAND_NEAR) c.band0++
      else if (band === BAND_MID) c.band1++
      else if (band === BAND_FAR) c.band2++
      else c.band3++
      if (band === BAND_NEAR && set && this.landed(e)) set.push(e.matrix, 0, e.tint)
    }
    if (pv && pv.matrix) {
      const set = this.near.get(pv.species)
      if (set) {
        set.users++
        set.push(pv.matrix, 0, 0)
      }
    }
    let draws = 0
    let instances = 0
    for (const s of this.near.all()) {
      draws += s.commit(visible)
      instances += s.count
    }
    c.overlayDraws = draws
    c.overlayInstances = instances
    this.near.draws = draws
    this.near.instances = instances
    this.bands.upload()
    const ms = this.now() - t0
    c.refills++
    c.refillMs = ms
    if (ms > c.refillMaxMs) c.refillMaxMs = ms
  }

  /**
   * A pending region load's batch has landed: its meshes show from the job that built it, while the `batched` event
   * comes a microtask later (after that frame's render), so the batch part is asked directly (RegionBatchPart.batchOf)
   * and the overlay takes its near trees in the same frame (no frame without the tree).
   */
  private checkLanded(): void {
    const b = this.host.world.batch as { batchOf?: (owner: number) => unknown } | null
    if (typeof b?.batchOf !== 'function') return
    for (const o of this.pendingOwners) {
      if (!b.batchOf(o)) continue
      this.pendingOwners.delete(o)
      this.readyOwners.add(o)
      this.dirty = true
    }
  }

  /** The placement's region batch has landed (any of its region loads). */
  private landed(e: SlotEntry): boolean {
    for (const o of e.owners) if (this.readyOwners.has(o)) return true
    return false
  }

  meshes(): AbstractMesh[] {
    return this.near.meshes()
  }

  // ---- the editor (T12-E's API) ------------------------------------------------------------------------------------

  /** The species the editor lists: T12-E's (`trees/editor.ts`, `content/trees/library.json`). */
  library(): readonly TreeLibraryEntry[] {
    return this.disposed ? [] : treeLibraryOf(this.host.world.manifest)
  }

  /** The species manifest model of an id (`pine07`), or null. */
  speciesModel(id: string): WorldModel | null {
    if (!this.speciesById) {
      this.speciesById = new Map()
      for (const m of this.host.world.manifest.models) {
        const sid = m.kind === 'static' ? speciesIdOf(m) : null
        if (sid && !this.speciesById.has(sid)) this.speciesById.set(sid, m)
      }
    }
    return this.speciesById.get(id) ?? null
  }

  /**
   * The editor's live preview (TREES §W3.9): `key`'s merged copy and overlay instance hidden (band 3), one LOD0 instance
   * of `species` at `matrix` (16 floats, world space: the species matrix, the fit folded in). `species` null ends it.
   */
  preview(key: number | null, species: string | null, matrix?: ArrayLike<number> | null): void {
    if (this.disposed) return
    this.dirty = true
    if (species === null) {
      this.previewing = null
      return
    }
    const model = this.speciesModel(species)
    if (!model) {
      // An unknown species (not in this export): the key is still hidden, nothing draws in its place.
      console.warn('[trees] preview of an unknown species', species)
      this.previewing = { key, species: -1, matrix: null }
      return
    }
    const batch = treeBatchOf(this.host.world)
    this.near.bind(treeTablesOf(batch), batch?.tints ?? null, batch?.materials?.breeze ?? null)
    this.ensureOverlay(this.speciesInfo(model))
    this.previewing = { key, species: model.index, matrix: matrix ? Float32Array.from(matrix) : null }
  }

  /** Hides (band 3) or shows a placement's merged copy and overlay instance. */
  setHidden(key: number, on: boolean): void {
    if (this.disposed) return
    if (on) this.hidden.add(key)
    else this.hidden.delete(key)
    this.dirty = true
  }

  // ---- the rest ------------------------------------------------------------------------------------------------------

  stats(): Readonly<Record<string, number>> {
    const n = this.near.stats()
    return {
      ...this.counters,
      ...n,
      slots: this.slots.used,
      slotsFree: this.slots.capacity - this.slots.used,
      slotsRefused: this.slots.refused,
      bandUploads: this.bands.uploads,
      crowded: this.lastCrowd ? 1 : 0,
      players: this.players,
      hidden: this.hidden.size,
      previews: this.previewing ? 1 : 0,
    }
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offListener()
    this.near.dispose()
    const shared = (this.host.world.foliage as { shared?: { band?: unknown; setBand?: (t: unknown) => void } } | null | undefined)?.shared
    if (shared && this.bands.texture && shared.band === this.bands.texture) shared.setBand?.(null)
    this.bands.dispose()
    this.slots.clear()
    this.readyOwners.clear()
    this.pendingOwners.clear()
    this.hidden.clear()
    this.previewing = null
    this.species.clear()
  }
}

/** World's default trees factory (LoadWorldOptions.parts.trees). */
export function createTreesPart(host: TreesHost): TreesPart | null {
  return new TreesNearField(host)
}

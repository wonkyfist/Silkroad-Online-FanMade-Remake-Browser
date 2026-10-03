/**
 * The wildlife part (docs/GRASS_LIFE.md §5; docs/WAVE_PLAN6.md §6.1 GL-L): `World.life`.
 *
 * Client-only and cosmetic (GRASS_LIFE §5.1): no protocol, no server state, not pickable, no collision. Each client
 * spawns its own animals around its own focus (the player; the stage's spot), in fixed pools with no allocation per
 * frame, seeded by cell and game hour so a spot keeps its animals while the player stays. **Three meshes, one draw
 * each** (GRASS_LIFE §5.1, WAVE_PLAN6 G4: grass ≤ 3 + life ≤ 3):
 *   - the critters (life/butterflies.ts): butterflies by day over the meadow and the placed flowers, 2.2× life size
 *     (X11), and dragonflies over inland water, GPU-procedural flight;
 *   - the birds (life/birds.ts, life/flock.ts): ground flocks (sparrows) that land in open grass and flush when anyone
 *     walks within 9 m, roof perchers (magpies, crows), fly-overs (swallows over the fields, egrets over water) and any
 *     species another lane registers (the coast's gulls, CST-A, through `addSpecies` / `addHabitat`);
 *   - the fireflies (life/fireflies.ts) at night, additive glow on grass near trees and water.
 * Every mesh carries `metadata.sroWorld = 'life'` (never batched), `alwaysSelectAsActiveMesh`, no shadow, and is hidden
 * with `isVisible` at count 0 (never `setEnabled`: no `EnabledMeshCandidates` rebuild; never drawn un-instanced).
 *
 * **Gating** (§5.1's table): `SkyState.night` gives day (< 0.2), dawn / dusk (0.2–0.6) and night (> 0.6); the weather
 * frame's rain and wind use the weather audio's bird-song thresholds (apps/game/src/audio/weather.ts: under cover at
 * rain > 0.25 or wind > 10 m/s, out again below 0.2 / 9), so what the player hears and sees agree. The fireflies keep
 * going in a drizzle below 0.1. Rain sends everything under cover: butterflies and dragonflies fade out over 5 s, the
 * flocks and perchers fly off and do not come back until it clears (the roof perchers "under shelter" of §5.1 need a
 * CPU shelter query the renderer does not have: they leave too).
 *
 * The materials are GL-S's (life/shaders.ts) on the grass skeleton, adopted by `world.scatter` (the shared uniforms,
 * defines, chunk-sampler fallbacks and the CSM depth texture: the sky, weather, night-light and RND-W chunks light the
 * animals with no plumbing). The part keeps its own `scCamera` clock (the scatter only ticks it while the grass draws).
 */
import { Mesh, Observable, Vector3, Vector4, VertexData, type AbstractMesh, type BaseTexture, type Camera, type Scene, type ShaderMaterial } from '@babylonjs/core'
import { LIFE_TAG } from '../grass/types.ts'
import { solidTexture } from '../textures.ts'
import type { World, WorldQuality } from '../world.ts'
import { BUILTIN_BIRDS, LifeBirds, MAX_BIRDS, birdSpeciesOf, type BirdContext } from './birds.ts'
import { BUILTIN_CRITTERS, LifeCritters, MAX_CRITTERS, critterSpeciesOf } from './butterflies.ts'
import { FIREFLY_SIZE_M, LifeFireflies, MAX_FIREFLIES } from './fireflies.ts'
import { BUTTERFLY_SCALE, DRAGONFLY_SCALE, birdGeometry, createLifeMaterial, critterGeometry, fireflyGeometry, type LifeGeometry, type LifeShaderKind } from './shaders.ts'
import { LifeCells, lifePlacesOf, smoothstep, worldGround, type LifeGround, type LifePlaces } from './spawn.ts'
import type { LifeConfig, LifeFlush, LifeHabitat, LifeHost, LifeKind, LifePart, LifeSpecies, LifeThreat, LifeThreats } from './types.ts'

// ---- gating (GRASS_LIFE §5.1) ------------------------------------------------------------------------------------------

export type LifePeriod = 'day' | 'twilight' | 'night'

/** Day below 0.2 of SkyState.night, dawn and dusk to 0.6, night above. */
export function lifePeriod(night: number): LifePeriod {
  return night < 0.2 ? 'day' : night <= 0.6 ? 'twilight' : 'night'
}

/** The weather audio's bird-song thresholds (audio/weather.ts WEATHER_AUDIO.birds) and the fireflies' drizzle limit. */
export const LIFE_WEATHER = { rainOn: 0.25, windOn: 10, rainOff: 0.2, windOff: 9, fireflyRainOn: 0.1, fireflyRainOff: 0.08 } as const

/** Rain and wind send the animals under cover, with the audio's hysteresis. */
export class LifeGate {
  /** Rain > 0.25 or wind > 10 m/s (until below 0.2 and 9): no butterflies, dragonflies or birds. */
  covered = false
  /** Rain > 0.1 or wind > 10 m/s (until below 0.08 and 9): no fireflies. */
  firefliesCovered = false

  update(rain: number, windMs: number): void {
    const w = LIFE_WEATHER
    this.covered = this.covered ? rain > w.rainOff || windMs > w.windOff : rain > w.rainOn || windMs > w.windOn
    this.firefliesCovered = this.firefliesCovered ? rain > w.fireflyRainOff || windMs > w.windOff : rain > w.fireflyRainOn || windMs > w.windOn
  }
}

/** §5.1's counts per preset (Low draws no life: the Classic path). */
export const LIFE_COUNTS = {
  butterflies: { low: 0, medium: 20, high: 40, ultra: 40 },
  dragonflies: { low: 0, medium: 6, high: 12, ultra: 12 },
  /** Roof perchers (birds, in pairs). */
  perchers: { low: 0, medium: 6, high: 10, ultra: 10 },
  fireflies: { low: 0, medium: 60, high: 120, ultra: 120 },
  /** Ground flocks by day and at dawn / dusk; 8–16 birds each. */
  groundFlocks: { day: 2, twilight: 1 },
  flockSize: [8, 16] as const,
  /** A few butterflies and dragonflies at dawn and dusk. */
  twilightShare: 0.25,
  /** Seconds between fly-overs. */
  flyOverS: [30, 90] as const,
} as const

/** What the life aims for this frame. */
export interface LifeTargets {
  butterflies: number
  dragonflies: number
  groundFlocks: number
  perchers: number
  /** 'any': swallows over the fields or egrets over water; 'fields': swallows only (dusk). */
  flyOvers: 'none' | 'fields' | 'any'
  fireflies: number
  /** The fireflies' light 0..1 (fading in from night 0.3). */
  fireflyLight: number
  /** A registered species' habitat flock may fly. */
  habitatFlocks: boolean
}

export interface LifeInputs {
  /** SkyState.night (0 day .. 1 night) and the solar time t (0 = midnight: dusk is t > 0.5). */
  night: number
  t: number
  quality: WorldQuality
  covered: boolean
  firefliesCovered: boolean
  groundFlocks: boolean
}

/** All of them by day, a few (a quarter, at least two) at dawn and dusk. */
function few(n: number, day: boolean): number {
  return day ? n : n > 0 ? Math.max(2, Math.round(n * LIFE_COUNTS.twilightShare)) : 0
}

/** No life at all. */
export function noLife(): LifeTargets {
  return { butterflies: 0, dragonflies: 0, groundFlocks: 0, perchers: 0, flyOvers: 'none', fireflies: 0, fireflyLight: 0, habitatFlocks: false }
}

/** §5.1's table: what each kind does at this time, weather and preset (written into `out`: no allocation per frame). */
export function lifeTargets(q: LifeInputs, out: LifeTargets = noLife()): LifeTargets {
  out.butterflies = out.dragonflies = out.groundFlocks = out.perchers = out.fireflies = out.fireflyLight = 0
  out.flyOvers = 'none'
  out.habitatFlocks = false
  if (q.quality === 'low') return out
  const period = lifePeriod(q.night)
  if (!q.covered && period !== 'night') {
    const day = period === 'day'
    out.butterflies = few(LIFE_COUNTS.butterflies[q.quality], day)
    out.dragonflies = few(LIFE_COUNTS.dragonflies[q.quality], day)
    out.groundFlocks = q.groundFlocks ? LIFE_COUNTS.groundFlocks[period] : 0
    out.perchers = LIFE_COUNTS.perchers[q.quality]
    out.flyOvers = day ? 'any' : q.t > 0.5 ? 'fields' : 'none'
    out.habitatFlocks = true
  }
  const light = q.firefliesCovered ? 0 : smoothstep(0.3, 0.6, q.night)
  if (light > 0) {
    out.fireflyLight = light
    out.fireflies = LIFE_COUNTS.fireflies[q.quality]
  }
  return out
}

// ---- the meshes ---------------------------------------------------------------------------------------------------------

/**
 * One wildlife mesh: one geometry, one material, a thin-instance record buffer of fixed capacity (never reallocated),
 * one draw. Hidden with `isVisible` while empty or while the part is off (never `setEnabled`), never at count 0.
 */
export class LifeMesh {
  readonly mesh: Mesh
  readonly buf: Float32Array
  private countValue = 0
  private shownValue = true

  constructor(scene: Scene, name: string, geo: LifeGeometry, material: ShaderMaterial, readonly capacity: number) {
    const mesh = new Mesh(name, scene)
    const vd = new VertexData()
    vd.positions = geo.positions
    vd.indices = geo.indices
    vd.applyToMesh(mesh, false)
    if (geo.bladeA) mesh.setVerticesData('bladeA', geo.bladeA, false, 4)
    mesh.material = material
    mesh.isPickable = false
    mesh.doNotSyncBoundingInfo = true
    mesh.alwaysSelectAsActiveMesh = true
    mesh.receiveShadows = false
    mesh.metadata = { sroWorld: LIFE_TAG, sroLife: name }
    this.buf = new Float32Array(capacity * 16)
    mesh.thinInstanceSetBuffer('matrix', this.buf, 16, false)
    mesh.thinInstanceCount = 1
    mesh.isVisible = false
    mesh.freezeWorldMatrix()
    this.mesh = mesh
  }

  /** Instances drawn now. */
  get count(): number {
    return this.countValue
  }

  get shown(): boolean {
    return this.shownValue
  }

  /** Shows or hides the mesh whatever its count (the part's enabled flag). */
  setShown(on: boolean): void {
    this.shownValue = on
    this.mesh.isVisible = on && this.countValue > 0
  }

  /** Draws the first `count` records of `buf` (uploading them when `upload`). */
  commit(count: number, upload = true): void {
    const n = Math.max(0, Math.min(this.capacity, Math.floor(count)))
    this.countValue = n
    if (n > 0) {
      this.mesh.thinInstanceCount = n
      if (upload) this.mesh.thinInstanceBufferUpdated('matrix')
    }
    this.mesh.isVisible = this.shownValue && n > 0
  }

  dispose(): void {
    this.mesh.dispose(false, false)
  }
}

// ---- species and habitats ---------------------------------------------------------------------------------------------

/** The built-in habitat ids (a species with any other id needs a registered LifeHabitat). */
export const LIFE_HABITATS = {
  /** Open grass and flower drifts (butterflies, ground flocks). */
  meadow: 'meadow',
  /** Building ridges (perchers). */
  roof: 'roof',
  /** Fly-overs above the fields (swallows). */
  fields: 'fields',
  /** Inland water (dragonflies; egrets fly over it). */
  water: 'water',
} as const

const BUILTIN_HABITAT_IDS: readonly string[] = Object.values(LIFE_HABITATS)
const KINDS: readonly LifeKind[] = ['butterfly', 'dragonfly', 'bird', 'firefly']

// ---- the part -----------------------------------------------------------------------------------------------------------

/** Cells filled per frame (≈ 60 µs each: the CPU budget holds while walking). */
const CELL_FILL_BUDGET = 1
/** The radius the cells are kept filled around the focus (m): the fireflies' 40 m and a margin. */
const CELL_RADIUS_M = 44
/** scRegion is re-centred when the focus leaves the middle of its 256 m window by this much (m). */
const REGION_RECENTRE_M = 32

export class WorldLife implements LifePart {
  readonly onFlush = new Observable<LifeFlush>()
  readonly critters: LifeCritters
  readonly birds: LifeBirds
  readonly fireflies: LifeFireflies
  readonly gate = new LifeGate()
  readonly places: LifePlaces
  readonly ground: LifeGround
  readonly cells: LifeCells
  /** The last frame's targets (tests, the viewer's panel). */
  readonly targets: LifeTargets = noLife()
  private readonly inputs: LifeInputs = { night: 0, t: 0.5, quality: 'low', covered: false, firefliesCovered: false, groundFlocks: true }
  /** CPU time of the last update (ms) and the worst so far (the probe). */
  readonly stats = { updateMs: 0, worstMs: 0 }
  private enabledValue = true
  private groundFlocks = true
  private threatsFn: LifeThreats | null = null
  private focusSet: { x: number; z: number } | null = null
  private readonly focus = { x: 0, y: 0, z: 0 }
  private readonly selfThreat: LifeThreat[] = [this.focus]
  private readonly speciesList: LifeSpecies[] = []
  private readonly habitats = new Map<string, LifeHabitat[]>()
  private readonly uCamera = new Vector4(0, 1e6, 0, 0)
  private readonly uRegion = new Vector4(0, 0, 256, 0)
  private readonly uTint = new Vector4(1, 1, 1, 0.5)
  private readonly crDay = new Vector4(0, BUTTERFLY_SCALE, DRAGONFLY_SCALE, 0)
  private readonly grField = new Vector4(0, 0, 0, 0)
  private readonly ffParams = new Vector4(0, FIREFLY_SIZE_M, 6, 0)
  private readonly white: BaseTexture
  private readonly materials: ShaderMaterial[] = []
  private readonly meshesList: LifeMesh[]
  private readonly adopted: Array<() => void> = []
  private readonly birdCtx: BirdContext
  private readonly clock: () => number
  private regionX = NaN
  private regionZ = NaN
  private disposed = false

  constructor(readonly host: LifeHost, opts: { ground?: LifeGround; now?: () => number } = {}) {
    const { scene, world } = host
    this.clock = opts.now ?? (() => performance.now())
    this.white = solidTexture(scene, [255, 255, 255, 255], 'lifeWhite')
    this.ground = opts.ground ?? worldGround(world)
    this.places = lifePlacesOf(world.manifest)
    this.cells = new LifeCells(this.ground, this.places)
    const critters = new LifeMesh(scene, 'life_critters', critterGeometry(), this.material('critter'), MAX_CRITTERS)
    const birds = new LifeMesh(scene, 'life_birds', birdGeometry(), this.material('bird'), MAX_BIRDS)
    const fireflies = new LifeMesh(scene, 'life_fireflies', fireflyGeometry(), this.material('firefly'), MAX_FIREFLIES)
    this.meshesList = [critters, birds, fireflies]
    this.critters = new LifeCritters(critters, this.crDay)
    this.birds = new LifeBirds(birds, (world.manifest.placements.length * 31 + 7) >>> 0)
    this.fireflies = new LifeFireflies(fireflies, this.ffParams)
    for (const s of BUILTIN_CRITTERS) this.speciesList.push(s)
    for (const s of BUILTIN_BIRDS) this.speciesList.push(s)
    this.birdCtx = {
      ground: this.ground, places: this.places, focus: this.focus, threats: this.selfThreat, targets: this.targets,
      species: [], habitat: id => this.habitatOf(id), flush: f => this.onFlush.notifyObservers(f),
    }
    this.syncSpecies()
  }

  /** A life material on the grass skeleton, adopted by the scatter, with the part's own bindings. */
  private material(kind: LifeShaderKind): ShaderMaterial {
    const mat = createLifeMaterial(this.host.scene, kind, `life_${kind}`)
    this.adopted.push(this.host.world.scatter.adopt(mat))
    mat.setVector4('scCamera', this.uCamera)
    if (kind === 'firefly') mat.setVector4('ffParams', this.ffParams)
    else {
      mat.setTexture('scLightmap', this.white)
      mat.setVector4('scRegion', this.uRegion)
      mat.setVector4('scTint', this.uTint)
    }
    if (kind === 'critter') {
      mat.setVector4('grField', this.grField)
      mat.setVector4('crDay', this.crDay)
      mat.setTexture('grFieldH', this.white)
    }
    this.materials.push(mat)
    return mat
  }

  get enabled(): boolean {
    return this.enabledValue
  }

  setEnabled(on: boolean): void {
    if (this.disposed || on === this.enabledValue) return
    this.enabledValue = on
    for (const m of this.meshesList) m.setShown(on)
    if (!on) {
      // Off: every animal goes (the part stays); they come back around the focus when it is on again.
      this.birds.clear()
      this.critters.clear()
      this.fireflies.clear()
    }
  }

  configure(config: LifeConfig): void {
    if (config.groundFlocks !== undefined && config.groundFlocks !== this.groundFlocks) {
      this.groundFlocks = config.groundFlocks
      if (!config.groundFlocks) this.birds.dropRole('ground')
    }
  }

  setThreats(fn: LifeThreats | null): void {
    this.threatsFn = fn
  }

  addSpecies(def: LifeSpecies): () => void {
    if (this.disposed || !def || !def.id || !KINDS.includes(def.kind)) return () => {}
    this.speciesList.push(def)
    this.syncSpecies()
    return () => {
      const i = this.speciesList.indexOf(def)
      if (i < 0) return
      this.speciesList.splice(i, 1)
      this.birds.dropSpecies(def.id)
      this.syncSpecies()
    }
  }

  addHabitat(rule: LifeHabitat): () => void {
    if (this.disposed || !rule || !rule.id) return () => {}
    let stack = this.habitats.get(rule.id)
    if (!stack) this.habitats.set(rule.id, (stack = []))
    stack.push(rule)
    return () => {
      const s = this.habitats.get(rule.id)
      const i = s?.indexOf(rule) ?? -1
      if (!s || i < 0) return
      s.splice(i, 1)
      if (!s.length) this.habitats.delete(rule.id)
    }
  }

  /** The newest registered habitat of `id` (null: none; the built-in ids are the part's own). */
  habitatOf(id: string): LifeHabitat | null {
    const s = this.habitats.get(id)
    return s?.length ? s[s.length - 1]! : null
  }

  /** The species registered now (built-ins first). */
  species(): readonly LifeSpecies[] {
    return this.speciesList
  }

  private syncSpecies(): void {
    this.critters.setSpecies(this.speciesList.filter(s => s.kind === 'butterfly' || s.kind === 'dragonfly').map(critterSpeciesOf))
    this.birdCtx.species = this.speciesList.filter(s => s.kind === 'bird').map(s => birdSpeciesOf(s, BUILTIN_HABITAT_IDS))
  }

  setFocus(x: number, z: number): void {
    this.focusSet = { x, z }
  }

  update(camera: Camera | null, dt: number): void {
    if (this.disposed || !this.enabledValue) return
    const t0 = performance.now()
    const world = this.host.world
    // The focus: an explicit one (the stage), else the camera's target (World's focus: the player), else the camera.
    if (this.focusSet) {
      this.focus.x = this.focusSet.x
      this.focus.z = this.focusSet.z
    } else if (camera) {
      const target = (camera as Camera & { target?: Vector3 }).target
      const p = target instanceof Vector3 ? target : camera.globalPosition
      this.focus.x = p.x
      this.focus.z = p.z
    }
    this.focus.y = this.ground.heightAt(this.focus.x, this.focus.z) ?? this.focus.y
    const cam = camera?.globalPosition
    this.uCamera.set(cam?.x ?? this.focus.x, cam?.y ?? this.focus.y, cam?.z ?? this.focus.z, (this.clock() / 1000) % 3600)
    if (!(Math.abs(this.focus.x - this.regionX) < REGION_RECENTRE_M && Math.abs(this.focus.z - this.regionZ) < REGION_RECENTRE_M)) {
      this.regionX = this.focus.x
      this.regionZ = this.focus.z
      this.uRegion.set(this.focus.x - 128, 0, this.focus.z + 128, 0)
    }
    // Time and weather → what each kind aims for.
    const sky = world.skyState
    const wx = world.weatherState
    this.gate.update(wx.rain, wx.windMs)
    const q = this.inputs
    q.night = sky.night
    q.t = sky.t
    q.quality = world.quality
    q.covered = this.gate.covered
    q.firefliesCovered = this.gate.firefliesCovered
    q.groundFlocks = this.groundFlocks
    lifeTargets(q, this.targets)
    const hour = Math.floor(sky.t * 24) + (sky.day ?? 0) * 24
    this.cells.fill(this.focus.x, this.focus.z, CELL_RADIUS_M, hour, CELL_FILL_BUDGET)
    this.critters.update(dt, this.targets, this.focus, hour, this.cells)
    this.fireflies.update(dt, this.targets, this.focus, hour, this.cells)
    const ctx = this.birdCtx
    ctx.threats = this.birds.active() ? (this.threatsFn?.() ?? this.selfThreat) : this.selfThreat
    this.birds.update(dt, ctx)
    const ms = performance.now() - t0
    this.stats.updateMs = ms
    if (ms > this.stats.worstMs) this.stats.worstMs = ms
  }

  meshes(): AbstractMesh[] {
    return this.meshesList.map(m => m.mesh)
  }

  /** The three wildlife meshes (tests, the viewer's panel). */
  lifeMeshes(): readonly LifeMesh[] {
    return this.meshesList
  }

  /** Animals drawn now per mesh (tests, the viewer's panel). */
  counts(): { critters: number; birds: number; fireflies: number; flocks: number } {
    return { critters: this.meshesList[0]!.count, birds: this.meshesList[1]!.count, fireflies: this.meshesList[2]!.count, flocks: this.birds.flockCount() }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.adopted) off()
    for (const m of this.meshesList) m.dispose()
    for (const m of this.materials) m.dispose(true, false)
    this.white.dispose()
    this.onFlush.clear()
    this.cells.clear()
    this.birds.clear()
  }
}

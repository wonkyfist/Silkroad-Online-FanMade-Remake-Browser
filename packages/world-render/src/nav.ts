// Navigation for the world viewer: loads the @sro/nav data (docs/NAVIGATION.md §9), walks the player along
// moveStraight legs and ray-picks nav surfaces. No Babylon imports, so the walk logic runs in headless scripts.
import {
  NavGltf,
  NavWorld,
  TERRAIN_SURFACE,
  decodeNavData,
  type NavData,
  type NavLeg,
  type NavMoveResult,
  type NavPosition,
  type NavRegion,
  type NavSurface,
} from '@sro/nav'
import type { WorldManifest } from '../../convert/src/world/manifest.ts'
import type { Assets } from './assets.ts'
import type { WorldRegions } from './regions.ts'

/** Where the nav came from: nav.bin, the terrain-only fallback, or the streamed split (nav-objects.bin + nav/ chunks). */
export type NavSource = 'manifest' | 'fallback' | 'stream'

export interface LoadedNav {
  nav: NavGltf
  source: NavSource
  /** Manifest-relative file the data came from ('' for the fallback). */
  file: string
  bytes: number
  warnings: string[]
}

/** The manifest's nav entry: `nav: { file }` (or a bare path; `navData` is accepted as an alias). */
export function manifestNavFile(manifest: WorldManifest): string | null {
  const m = manifest as unknown as Record<string, unknown>
  for (const key of ['nav', 'navData']) {
    const v = m[key]
    if (typeof v === 'string' && v) return v
    if (v && typeof v === 'object' && typeof (v as { file?: unknown }).file === 'string') return (v as { file: string }).file
  }
  return null
}

/** manifest.spawn in glTF metres: [x, y, z], {x, y?, z} or {position: [x, y, z]}; null when absent or malformed. */
export function manifestSpawn(manifest: WorldManifest): { x: number; y: number | null; z: number } | null {
  const s = (manifest as unknown as { spawn?: unknown }).spawn
  const vec = (v: unknown): { x: number; y: number | null; z: number } | null => {
    if (Array.isArray(v) && v.length >= 2) {
      const n = v.map(Number)
      if (v.length === 2 && n.every(Number.isFinite)) return { x: n[0]!, y: null, z: n[1]! }
      if (n.slice(0, 3).every(Number.isFinite)) return { x: n[0]!, y: n[1]!, z: n[2]! }
      return null
    }
    if (v && typeof v === 'object') {
      const o = v as { x?: unknown; y?: unknown; z?: unknown; position?: unknown }
      if (o.position !== undefined) return vec(o.position)
      if (typeof o.x === 'number' && typeof o.z === 'number' && Number.isFinite(o.x) && Number.isFinite(o.z)) {
        return { x: o.x, y: typeof o.y === 'number' && Number.isFinite(o.y) ? o.y : null, z: o.z }
      }
    }
    return null
  }
  return vec(s)
}

/**
 * Terrain-only NavData from the per-region navmesh bins the viewer already loads (no object navmeshes: the bins do
 * not carry them). Temporary fallback for a manifest written before the converter emitted the nav file.
 */
export function terrainOnlyNavData(world: WorldRegions): NavData {
  const regions: NavRegion[] = []
  for (const { region, navmesh } of world.regions) {
    if (!navmesh) continue
    const heights = new Float32Array(navmesh.heights.length)
    for (let i = 0; i < heights.length; i++) heights[i] = navmesh.heights[i]! * 10
    const planes = region.navmesh?.planes
    regions.push({
      id: region.id,
      rx: region.x,
      rz: region.z,
      openCellCount: navmesh.openCellCount,
      heights,
      tileCells: navmesh.tileCells,
      ...(planes ? {
        planeTypes: Uint8Array.from(planes, p => p.type),
        planeHeights: Float32Array.from(planes, p => p.heightM * 10),
      } : {}),
    })
  }
  return { version: 1, regions, models: [], instances: [] }
}

/** The manifest's nav file when there is one, else the terrain-only fallback (with a warning). */
export async function loadNav(manifest: WorldManifest, assets: Assets, world: WorldRegions): Promise<LoadedNav> {
  const origin = manifest.space.originRegion
  const file = manifestNavFile(manifest)
  const warnings: string[] = []
  if (file) {
    try {
      const bytes = await assets.bytesOf(file)
      const data = decodeNavData(bytes)
      return { nav: new NavGltf(new NavWorld(data), origin), source: 'manifest', file, bytes: bytes.byteLength, warnings }
    } catch (err) {
      warnings.push(`nav file ${file}: ${err instanceof Error ? err.message : String(err)}; terrain-only fallback`)
    }
  } else {
    warnings.push('manifest has no nav file (re-run convert-region); terrain-only fallback without object navmeshes')
  }
  return { nav: new NavGltf(new NavWorld(terrainOnlyNavData(world)), origin), source: 'fallback', file: '', bytes: 0, warnings }
}

/** The manifest's stream block, as far as the nav needs it (convert manifest.ts WorldStream, docs/FIELDS.md §3.9). */
interface StreamNavFields {
  navRegions?: { dir?: unknown }
  navObjects?: { file?: unknown }
}

function streamNav(manifest: WorldManifest): { dir: string; objects: string } | null {
  const s = (manifest as unknown as { stream?: StreamNavFields }).stream
  const dir = s?.navRegions?.dir
  const objects = s?.navObjects?.file
  return typeof dir === 'string' && dir && typeof objects === 'string' && objects ? { dir, objects } : null
}

/** One region's terrain nav for region streaming (null: the region has none). */
export interface NavChunkSource {
  readonly kind: 'files' | 'memory'
  load(region: { id: number; x: number; z: number }, signal?: AbortSignal): Promise<NavRegion | null>
}

export interface LoadedStreamNav extends LoadedNav {
  /** Where the per-region terrain chunks come from. */
  chunks: NavChunkSource
}

/**
 * Streamed nav (docs/FIELDS.md §3.8): a NavWorld with every object model, instance and link but no terrain, plus a
 * source of per-region terrain chunks that the streamer adds and removes (NavWorld.addRegion / removeRegion).
 * With a manifest `stream` block: `nav-objects.bin` and `<navRegions.dir>/<x>_<z>.bin`. Without one (an export
 * written before streaming, e.g. the 3x3 'jangan'), nav.bin is loaded once and split in memory, with a warning.
 */
export async function loadNavStreamed(manifest: WorldManifest, assets: Assets): Promise<LoadedStreamNav> {
  const origin = manifest.space.originRegion
  const warnings: string[] = []
  const split = streamNav(manifest)
  if (split) {
    const bytes = await assets.bytesOf(split.objects)
    const data = decodeNavData(bytes)
    const listed = new Set((manifest.nav?.regions ?? []).map(Number))
    const chunks: NavChunkSource = {
      kind: 'files',
      async load(region, signal) {
        if (manifest.nav && !listed.has(region.id)) return null
        const chunk = decodeNavData(await assets.bytesOf(`${split.dir}/${region.x}_${region.z}.bin`, signal))
        return chunk.regions.find(r => r.id === region.id) ?? chunk.regions[0] ?? null
      },
    }
    return { nav: new NavGltf(new NavWorld({ ...data, regions: [] }), origin), source: 'stream', file: split.objects, bytes: bytes.byteLength, warnings, chunks }
  }
  const file = manifestNavFile(manifest)
  if (!file) throw new Error('streaming needs manifest.stream or a nav file (re-run convert-region)')
  const bytes = await assets.bytesOf(file)
  const full = decodeNavData(bytes)
  warnings.push(`no manifest.stream: ${file} loaded whole and split in memory for streaming`)
  const byId = new Map(full.regions.map(r => [r.id, r]))
  const chunks: NavChunkSource = {
    kind: 'memory',
    load: async region => byId.get(region.id) ?? null,
  }
  return { nav: new NavGltf(new NavWorld({ ...full, regions: [] }), origin), source: 'stream', file, bytes: bytes.byteLength, warnings, chunks }
}

/** Spawn point: the nearest surface to `yHint` (+Infinity = the highest) at (x, z); terrain height when there is none. */
export function spawnAt(nav: NavGltf, x: number, z: number, yHint = Infinity): NavPosition {
  const p = nav.locate(x, z, yHint)
  if (p) return p
  const y = nav.world.terrainHeight(nav.fileX(x), nav.fileZ(z)) * 0.1
  return { x, y: Number.isFinite(y) ? y : 0, z, surface: TERRAIN_SURFACE }
}

export interface NavPick {
  x: number
  y: number
  z: number
  surface: NavSurface
  /** false when the hit is on a closed terrain cell (a cliff): a move there still gives a direction. */
  walkable: boolean
  /** Distance along the (normalised) ray. */
  distance: number
}

/**
 * Surface under a view ray (glTF metres): marches the ray and, at each step, compares its height with the nav
 * surface nearest to it (object floors where the ray passes them, terrain otherwise; closed terrain counts too so
 * clicks on cliffs still give a direction). Returns the first crossing, refined by bisection, or null.
 *
 * The step adapts to the clearance (half the height above the nearest surface, `minStep`..`maxStep`), so a pick
 * costs a few hundred surface queries instead of one per `minStep` over the whole range; surfaces steeper than
 * about 63 degrees can be stepped over near the start of a long ray, which only moves the hit onto the slope beyond.
 */
export function pickNav(
  nav: NavGltf,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist = 600, minStep = 0.25, maxStep = 8,
): NavPick | null {
  const len = Math.hypot(dx, dy, dz)
  if (!(len > 0)) return null
  dx /= len
  dy /= len
  dz /= len
  const surfaceY = (x: number, z: number, y: number): { y: number; surface: NavSurface; walkable: boolean } | null => {
    const p = nav.locate(x, z, y)
    if (p) return { y: p.y, surface: p.surface, walkable: true }
    const t = nav.world.terrainHeight(nav.fileX(x), nav.fileZ(z)) * 0.1
    return Number.isFinite(t) ? { y: t, surface: TERRAIN_SURFACE, walkable: false } : null
  }
  // Height of one surface (the cell plane extended beyond its triangle, or the terrain) along the ray.
  const gap = (surface: NavSurface, t: number): number => {
    const h = nav.heightOn(surface, ox + dx * t, oz + dz * t)
    return Number.isFinite(h) ? oy + dy * t - h : NaN
  }
  let prevT = -1
  let t = 0
  while (t <= maxDist) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t
    const s = surfaceY(x, z, y)
    let step = minStep
    if (s) {
      if (y > s.y) {
        step = Math.min(maxStep, Math.max(minStep, (y - s.y) * 0.5))
      } else if (prevT >= 0) {
        // Candidates: the surface nearest to where the ray came from (the top one when a step passed through two
        // close surfaces, e.g. a plaza 6 cm above the terrain), then the one nearest to the ray now. A real
        // crossing: the ray was above that same surface at the previous sample (a ray passing under a wall
        // walkway is below the walkway's plane on both sides, so the walkway is not hit from beneath).
        const top = surfaceY(x, z, oy + dy * prevT)
        for (const c of top && top.surface !== s.surface ? [top, s] : [s]) {
          if (!(gap(c.surface, t) <= 0) || gap(c.surface, prevT) <= 0) continue
          let a = prevT
          let b = t
          for (let i = 0; i < 24; i++) {
            const m = (a + b) / 2
            if (gap(c.surface, m) <= 0) b = m
            else a = m
          }
          const hx = ox + dx * b, hy = oy + dy * b, hz = oz + dz * b
          const hs = surfaceY(hx, hz, hy) ?? c
          return { x: hx, y: hs.y, z: hz, surface: hs.surface, walkable: hs.walkable, distance: b }
        }
      }
    }
    prevT = t
    t += step
  }
  return null
}

/**
 * Click-to-move with the native semantics (NAVIGATION.md §6.1): a click is one moveStraight chord from the live
 * position (with its retained surface) toward the destination; the walker follows the returned legs at a fixed
 * speed, taking the height from each leg's own surface (heightOn), and stands at result.end. Nothing re-plans or
 * slides. A click while running starts from the live point settled on the leg's surface (§6.5 "settle at the live
 * point and keep the owner").
 */
export class NavWalker {
  /** Live position (glTF metres) with the surface it stands on. */
  pos: NavPosition
  /** The last move (null when standing). */
  move: NavMoveResult | null = null
  /** Unit direction of the current chord (XZ), for the heading. */
  dirX = 0
  dirZ = -1
  private legs: NavLeg[] = []
  private legStart: number[] = []
  private total = 0
  private travelled = 0

  constructor(readonly nav: NavGltf, start: NavPosition) {
    this.pos = { ...start }
  }

  get moving(): boolean {
    return this.move !== null
  }

  /** Starts a move toward glTF (x, z); returns the walk (blocked = it stops short of the click). */
  moveTo(x: number, z: number): NavMoveResult {
    const from = this.livePosition()
    const r = this.nav.moveStraight(from, x, z)
    const cx = x - from.x
    const cz = z - from.z
    const cl = Math.hypot(cx, cz)
    if (cl > 1e-9) {
      this.dirX = cx / cl
      this.dirZ = cz / cl
    }
    this.legs = r.legs
    this.legStart = []
    let s = 0
    for (const l of r.legs) {
      this.legStart.push(s)
      s += Math.hypot(l.x1 - l.x0, l.z1 - l.z0)
    }
    this.total = s
    this.travelled = 0
    this.pos = { ...from }
    this.move = r
    if (s <= 1e-9) this.finish()
    return r
  }

  /** Stops at the live point, keeping its surface. */
  stop(): void {
    if (!this.move) return
    this.pos = this.livePosition()
    this.move = null
    this.legs = []
  }

  /** Places the walker (teleport/spawn): no retained surface, so the surface is located near yHint (§5.2). */
  teleport(x: number, z: number, yHint = Infinity): void {
    this.move = null
    this.legs = []
    this.pos = spawnAt(this.nav, x, z, yHint)
  }

  /** Advances `dist` metres along the legs; returns the distance moved. */
  advance(dist: number): number {
    if (!this.move) return 0
    const before = this.travelled
    this.travelled = Math.min(this.total, this.travelled + dist)
    if (this.travelled >= this.total - 1e-9) {
      this.finish()
      return this.total - before
    }
    let i = this.legs.length - 1
    while (i > 0 && this.legStart[i]! > this.travelled) i--
    const l = this.legs[i]!
    const ll = Math.hypot(l.x1 - l.x0, l.z1 - l.z0)
    const f = ll > 0 ? (this.travelled - this.legStart[i]!) / ll : 1
    const x = l.x0 + (l.x1 - l.x0) * f
    const z = l.z0 + (l.z1 - l.z0) * f
    const y = this.nav.heightOn(l.surface, x, z)
    this.pos = { x, y: Number.isFinite(y) ? y : this.pos.y, z, surface: l.surface }
    return this.travelled - before
  }

  private finish(): void {
    if (this.move) this.pos = { ...this.move.end }
    this.move = null
    this.legs = []
  }

  /** The live point settled on its surface (the retained cell, a neighbour, or clamped into the cell). */
  private livePosition(): NavPosition {
    if (!this.move) return this.pos
    return this.nav.settle(this.pos.surface, this.pos.x, this.pos.z) ?? this.pos
  }
}

/** Short label of a surface for the HUD: 'terrain' or '<model file> #cell'. */
export function surfaceLabel(nav: NavGltf, s: NavSurface): string {
  if (s.kind === 'terrain') return 'terrain'
  const info = nav.world.instanceInfo(s.instance)
  return `${info.model.split('/').pop()} cell ${s.cell}`
}

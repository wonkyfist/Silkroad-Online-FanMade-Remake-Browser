/**
 * Night lights (docs/WAVE_PLAN3.md §6.7, D12, D29; docs/SKY.md §7; docs/RENDER.md §4.5-4.6), lane NL. One module for
 * every preset:
 *
 * - **Sources.** A light is a (placement × ambient particle) pair whose effect is in NIGHT_LIGHT_KINDS (SKY §7.2): the
 *   lamps and fires of the world's `ambient.json` (ambient-fx.ts `readAmbientIndex` / `placeEmitter`) placed through
 *   `WorldObjects.addRegionListener`. Night-only emitters, plus fire and lamp emitters that also play by day (the town
 *   gate braziers `frame2.efp`: they burn at night too). Lights within 0.5 m merge (a flame and its glow).
 *   W12-SB (WORLD_EDITOR §4.9, seam S-NL, D13): plus the editor's free light points, `ambient.json` `points`
 *   (`readAmbientPoints`; `setPoints` live), which join the point-light pick and the splat like any other light and are
 *   never merged away. No points (an export without the list): today's lights and splats exactly.
 * - **Splat** (terrain and grass; SKY §7.3.1). Per terrain region a 192 × 192 CPU bake at 1 m per texel,
 *   `rgb = Σ colour · I · N·L · window(d, r)`, `window = (1 − (d/r)⁴)² / (1 + (d/NIGHT_SPLAT_REF_M)²)`, N from the
 *   region heights, no occlusion. It runs as the commit step 'nightSplat' after the region's objects, and again when a
 *   neighbour's lights arrive (one region per frame). Low and Medium bind it on the terrain
 *   (`setRegionTexture(region, 'nightSplat', tex)`, define SRO_NIGHT_SPLAT); every preset copies the region splats
 *   into one 256 m window around the camera for the grass (define SRO_NIGHT_GRASS). Regions without light bind nothing
 *   (the terrain's 1 × 1 black fallback).
 * - **Point lights** (Medium+; D12). A ClusteredLightContainer of the preset's count (8 / 32 / 64) when the engine
 *   supports clusters, else a pool of 2 plain PointLights. The lights are made once per preset and never added,
 *   removed, enabled or disabled afterwards: every 250 ms (or 2 m of focus movement) the nearest lights are reassigned
 *   to them, fading over 0.3 s, and by day they sit at intensity 0 with a tiny range (the cluster's tile pass then
 *   draws nothing). So the material light count never changes at dusk (no recompile hitch; RENDER §4.6). Low makes no
 *   point light: object and character light counts stay as today.
 * - **Emissive** (SKY §7.3.3). Lamp materials glow at night: `emissive = base + kindColour × 0.8 × night` on every lit
 *   material of a model named /lamp|_light/, and on materials named /light/ of any model owning a night emitter.
 *   NL is the one lamp-glow owner on both paths (gate 1). On a PBR material the add is display-referred like Classic's:
 *   divided by the exposure the post stack applies (SkyState.exposure × its trim, render/display.ts sceneDisplay), which
 *   multiplies it back, so a lamp neither blows out nor vanishes. The rule is materials.ts `lampRule` (one function,
 *   shared with the batcher's `batchClass`). W10-S (BATCHING §3.10, F9): a lamp merged into a region batch hears no
 *   mesh through `placed`; its slot comes with the `batched` event and its glow goes to the batch's table (texel 5).
 *
 * Everything ramps with `SkyState.night` (`smoothstep(+2°, −6°, sunEl)`); fires dim by 30 % × rain. Night never
 * changes a define: only a preset change (World.setQuality → render.quality) does.
 *
 * `attachNightLights(world)` wires it to a World and returns the handle (dispose it before the world). The game's
 * fx-world feature attaches it and drives the ambient-effect night switch from `ambientNightSwitch`.
 */
import {
  ClusteredLightContainer,
  Color3,
  PBRBaseMaterial,
  PointLight,
  RawTexture,
  Texture,
  Vector3,
  Vector4,
  type AbstractMesh,
  type Camera,
  type Light,
  type Material,
  type Observer,
  type Scene,
} from '@babylonjs/core'
import { GRID } from '../../convert/src/world/format.ts'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import { placeEmitter, readAmbientIndex, type AmbientParticle } from './ambient-fx.ts'
import type { Assets } from './assets.ts'
import type { RegionBatch } from './batch/types.ts'
import { isLampModel, lampRule } from './materials.ts'
import {
  NIGHT_GRASS_DEFINE,
  NIGHT_GRASS_SAMPLER,
  NIGHT_GRASS_UNIFORM,
  NIGHT_SPLAT_MAX,
  NIGHT_TERRAIN_DEFINE,
  NIGHT_UNIFORM,
} from './night-chunks.ts'
import type { PlacedModelInfo, RegionListener } from './objects.ts'
import type { RegionData } from './regions.ts'
import { installShaderFixes } from './render/babylon-fixes.ts'
import { sceneDisplay } from './render/display.ts'
import type { NightLightQuality } from './render/quality.ts'
import type { RenderWeather } from './render/weather.ts'
import type { SharedUniforms } from './shader-chunks.ts'
import type { CommitStepAfter } from './stream.ts'
import type { TerrainRegionSlot, TerrainRegionUpdated } from './terrain.ts'

export type RGB3 = readonly [number, number, number]

/** One row of the light table (SKY §7.2 [our rule]); `match` tests the efp file name. */
export interface NightLightKind {
  id: 'lampOrange' | 'lampRed' | 'lampLight' | 'fire'
  match: RegExp
  /** Linear colour. */
  color: RGB3
  radiusM: number
  intensity: number
  /** Flicker amplitude (0..1) and frequency range (Hz). */
  flicker: number
  flickerHz: readonly [number, number]
  /** Fires dim in the rain. */
  fire: boolean
  /**
   * H11-NT-4: the point light's own gain and reach (Medium+; absent: × 1 and `radiusM`). The splat bake keeps
   * `intensity` and `radiusM`, so Low and the terrain's baked glow are unchanged.
   */
  pointGain?: number
  pointRadiusM?: number
}

export const NIGHT_LIGHT_KINDS: readonly NightLightKind[] = [
  // H11-NT-4: the town's lamp posts (the dressing's cj_field_lamp rows, the retail lamps) beat the moonlight only within
  // ≈ 3.6 m at gain 1 (posts are 16–30 m apart): × 3 and a 10 m reach make a warm pool round each post
  { id: 'lampOrange', match: /^cj_pal_lamp_orange/, color: [1, 0.62, 0.28], radiusM: 7, intensity: 1, flicker: 0.03, flickerHz: [0.3, 0.6], fire: false, pointGain: 3, pointRadiusM: 10 },
  { id: 'lampRed', match: /^cj_pal_lamp_red/, color: [1, 0.36, 0.2], radiusM: 6, intensity: 0.9, flicker: 0.03, flickerHz: [0.3, 0.6], fire: false },
  { id: 'lampLight', match: /^(cj_pal_lamp_light|light)\.efp$/, color: [1, 0.78, 0.5], radiusM: 6, intensity: 1, flicker: 0, flickerHz: [0, 0], fire: false, pointGain: 3, pointRadiusM: 10 },
  { id: 'fire', match: /^(frame\d*|red_orange_flame.*)\.efp$/, color: [1, 0.55, 0.22], radiusM: 8, intensity: 1.2, flicker: 0.12, flickerHz: [6, 10], fire: true },
]

/** The light kind of an effect path (`map/cj_pal_lamp_orange_s.efp`), or null (no light). */
export function nightKindOf(efp: string): NightLightKind | null {
  const name = efp.split(/[\\/]/).pop()!.toLowerCase()
  return NIGHT_LIGHT_KINDS.find(k => k.match.test(name)) ?? null
}

/**
 * W12-SB (seam S-NL): one free light point of `ambient.json` `points` (WORLD_EDITOR §3.1 `lights.json`, the shared
 * `WorldEditLight`): glTF metres, a kind (the editor's 'lamp' | 'lantern' | 'fire', or a NIGHT_LIGHT_KINDS id; default
 * 'lampLight') whose colour, intensity and reach it may override.
 */
export interface NightLightPoint {
  id?: string
  x: number
  y: number
  z: number
  kind?: NightLightKind['id'] | 'lamp' | 'lantern' | 'fire'
  /** Linear colour (default the kind's). */
  colour?: RGB3
  intensity?: number
  radiusM?: number
}

/** The editor's light kinds (packages/shared world-edits WE_LIGHT_KINDS) as rows of the light table. */
const POINT_KINDS: Readonly<Record<string, NightLightKind['id']>> = { lamp: 'lampLight', lantern: 'lampOrange', fire: 'fire' }

/** The light-table row of a point's kind (unknown or absent: 'lampLight'). */
function pointKind(kind: string | undefined): NightLightKind {
  const id = (kind && POINT_KINDS[kind]) ?? kind ?? 'lampLight'
  return NIGHT_LIGHT_KINDS.find(k => k.id === id) ?? NIGHT_LIGHT_KINDS.find(k => k.id === 'lampLight')!
}

/** The owner of the free light points (never a streamed region id, never the whole-world load's −1). */
export const NIGHT_POINT_OWNER = -2
/** A free point's reach and intensity are clamped to these (a typo never floods a region with light). */
export const NIGHT_POINT_MAX_RADIUS_M = 30
export const NIGHT_POINT_MAX_INTENSITY = 4

/** The `points` list of an `ambient.json` (absent or malformed rows: none; finite x, y, z required). */
export function readAmbientPoints(json: unknown): NightLightPoint[] {
  const list = (json as { points?: unknown } | null)?.points
  if (!Array.isArray(list)) return []
  const out: NightLightPoint[] = []
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  for (const p of list as Array<Partial<NightLightPoint> | null>) {
    if (!p || !num(p.x) || !num(p.y) || !num(p.z)) continue
    const row: NightLightPoint = { x: p.x!, y: p.y!, z: p.z! }
    if (typeof p.id === 'string') row.id = p.id
    if (typeof p.kind === 'string' && (POINT_KINDS[p.kind] || NIGHT_LIGHT_KINDS.some(k => k.id === p.kind))) row.kind = p.kind
    if (Array.isArray(p.colour) && p.colour.length === 3 && p.colour.every(num)) row.colour = [p.colour[0]!, p.colour[1]!, p.colour[2]!]
    if (num(p.intensity)) row.intensity = p.intensity!
    if (num(p.radiusM)) row.radiusM = p.radiusM!
    out.push(row)
  }
  return out
}

/**
 * A free point as a NightLight (owner NIGHT_POINT_OWNER): its kind's row with the point's colour, intensity and reach
 * (clamped); the point light's own reach keeps the kind's ratio to the splat's (H11-NT-4's lamp boost).
 */
export function pointLight(p: NightLightPoint): NightLight {
  const base = pointKind(p.kind)
  let kind = base
  if (p.colour !== undefined || p.intensity !== undefined || p.radiusM !== undefined) {
    const radiusM = p.radiusM !== undefined ? Math.min(NIGHT_POINT_MAX_RADIUS_M, Math.max(0.5, p.radiusM)) : base.radiusM
    kind = {
      ...base,
      color: p.colour ? [Math.max(0, p.colour[0]), Math.max(0, p.colour[1]), Math.max(0, p.colour[2])] : base.color,
      intensity: p.intensity !== undefined ? Math.min(NIGHT_POINT_MAX_INTENSITY, Math.max(0, p.intensity)) : base.intensity,
      radiusM,
      ...(base.pointRadiusM !== undefined ? { pointRadiusM: (base.pointRadiusM * radiusM) / base.radiusM } : {}),
    }
  }
  return { x: p.x, y: p.y, z: p.z, kind, owner: NIGHT_POINT_OWNER, seed: hash3(p.x, p.y, p.z), fromNight: false }
}

/** One placed light (glTF metres). */
export interface NightLight {
  x: number
  y: number
  z: number
  kind: NightLightKind
  /** The region listener's owner key (a streamed region id, or -1 for the whole-world load). */
  owner: number
  /** 0..1, phases the flicker. */
  seed: number
  /** From a night-only emitter (SKY §7.1's count) rather than a day fire or lamp. */
  fromNight: boolean
}

/** Lights closer than this merge (m). */
export const NIGHT_MERGE_M = 0.5
/** Splat texels per region side (1 m per texel over the 192 m region). */
export const NIGHT_SPLAT_SIZE = 192
/** Distance scale of the splat's inverse-square term (m) [our rule; SKY §7.3 uses 1]. */
export const NIGHT_SPLAT_REF_M = 2
/** Splat gain: light units → albedo multiples (a lamp 3 m up adds ~0.7 × albedo below it at full night) [our rule]. */
export const NIGHT_SPLAT_GAIN = 2.5
/** Point-light intensity per unit of the table's intensity (RENDER §4.5: 3 × night) [our rule; LAB calibrates]. */
export const NIGHT_POINT_GAIN = 3
/** Lamp emissive: kind colour × this × night (SKY §7.3.3). */
export const NIGHT_EMISSIVE = 0.8
/** The grass window (m, 1 m per texel), re-centred when the focus leaves the inner NIGHT_GRASS_RECENTER_M. */
export const NIGHT_GRASS_WINDOW = 256
export const NIGHT_GRASS_RECENTER_M = 32
/** Point-light reassignment: every this many ms or after this much focus movement (m); fade time (s). */
export const NIGHT_REPICK_MS = 250
export const NIGHT_REPICK_M = 2
export const NIGHT_FADE_S = 0.3
/** Point lights only take lights this close to the focus (m). */
export const NIGHT_POINT_RANGE_M = 90
/** Ambient-effect night switch hysteresis (SKY §7.2): on above ON, off below OFF. */
export const AMBIENT_NIGHT_ON = 0.6
export const AMBIENT_NIGHT_OFF = 0.4
/** Range of a parked (day) point light: the cluster's tile pass draws nothing for it. */
const PARKED_RANGE = 0.01
/** The pool lights sort right after the celestial light (1000) and ahead of default-priority lights (hit flashes). */
export const NIGHT_LIGHT_RENDER_PRIORITY = 1

/** The night-only ambient effects (lamps' particles) switch: on at night > 0.6, off at night < 0.4 (SKY §7.2). */
export function ambientNightSwitch(on: boolean, night: number): boolean {
  if (!Number.isFinite(night)) return on
  if (on) return night >= AMBIENT_NIGHT_OFF
  return night > AMBIENT_NIGHT_ON
}

/** The splat falloff: `(1 − (d/r)⁴)² / (1 + (d/ref)²)`, 0 at and beyond r. */
export function splatWindow(d: number, r: number, ref = NIGHT_SPLAT_REF_M): number {
  if (!(d < r) || r <= 0) return 0
  const k = d / r
  const k4 = k * k * k * k
  return ((1 - k4) * (1 - k4)) / (1 + (d * d) / (ref * ref))
}

/** Deterministic 0..1 hash of a position (the flicker phase). */
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
  return s - Math.floor(s)
}

/**
 * The lights of `placements` of one model (its ambient particles with a kind), placed; `into` receives the new ones
 * unless one lies within NIGHT_MERGE_M of a light already in `existing` or added before. Returns the merged count.
 */
export function placeLights(
  rows: readonly AmbientParticle[],
  placements: readonly Pick<WorldPlacement, 'position' | 'rotation'>[],
  owner: number,
  existing: readonly NightLight[],
  into: NightLight[],
): number {
  let merged = 0
  const m2 = NIGHT_MERGE_M * NIGHT_MERGE_M
  const near = (x: number, y: number, z: number, list: readonly NightLight[]) => {
    for (const l of list) {
      const dx = l.x - x, dy = l.y - y, dz = l.z - z
      if (dx * dx + dy * dy + dz * dz < m2) return true
    }
    return false
  }
  for (const p of placements) {
    for (const row of rows) {
      const kind = nightKindOf(row.efp)
      if (!kind) continue
      const [x, y, z] = placeEmitter(p, row.position)
      if (near(x, y, z, existing) || near(x, y, z, into)) {
        merged++
        continue
      }
      into.push({ x, y, z, kind, owner, seed: hash3(x, y, z), fromNight: row.night })
    }
  }
  return merged
}

/** Terrain height (m, relative to the region origin) at region-local metres (east, north), bilinear on the 2 m grid. */
function gridHeight(heights: ArrayLike<number>, east: number, north: number): number {
  const gx = Math.min(GRID - 1.0001, Math.max(0, east / 2))
  const gz = Math.min(GRID - 1.0001, Math.max(0, north / 2))
  const x0 = Math.floor(gx), z0 = Math.floor(gz)
  const fx = gx - x0, fz = gz - z0
  const i = z0 * GRID + x0
  const h00 = heights[i]!, h10 = heights[i + 1]!, h01 = heights[i + GRID]!, h11 = heights[i + GRID + 1]!
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz
}

/** What a splat bake needs of a region (RegionData, or a test's own). */
export interface SplatRegion {
  /** glTF origin of the region's south-west corner (x east, z: the region spans z from origin − 192 to origin). */
  origin: readonly number[]
  /** 97 × 97 terrain heights (m above origin[1]), row gz = north. */
  heights: ArrayLike<number>
}

let bakeAcc: Float32Array | null = null

/**
 * Bakes one region's splat into `out` (NIGHT_SPLAT_SIZE² RGBA8, row j = the j-th metre north of the south edge,
 * column i = the i-th metre east): `rgb = saturate(Σ colour · I · N·L · window(d, r) × GAIN / NIGHT_SPLAT_MAX)`, alpha
 * 255. Returns the number of lit texels (0: nothing to bind).
 */
/**
 * Where splat texel `i` is baked (m from the region's edge): the texel centre, except the edge texels, which hold the
 * region edge itself. The chunk samples `lp / 1920` with clamp-to-edge, so at a region border each side reads its
 * edge texel alone; baking both at the shared border line makes the two sides agree there (W9F S4: a lamp near a
 * border drew a straight step in its pool of light). The edge texels sit half a texel off their centres: invisible.
 */
function splatTexelPos(i: number, size: number, texel: number): number {
  if (i <= 0) return 0
  if (i >= size - 1) return size * texel
  return (i + 0.5) * texel
}

export function bakeSplat(out: Uint8Array, region: SplatRegion, lights: readonly NightLight[], size = NIGHT_SPLAT_SIZE): number {
  const n = size * size
  const acc = bakeAcc && bakeAcc.length >= n * 3 ? bakeAcc : (bakeAcc = new Float32Array(n * 3))
  acc.fill(0, 0, n * 3)
  const [ox = 0, oy = 0, oz = 0] = region.origin
  const texel = 192 / size
  const h = region.heights
  let touched = false
  for (const l of lights) {
    const r = l.kind.radiusM
    const east = l.x - ox
    const north = oz - l.z
    const i0 = Math.max(0, Math.floor((east - r) / texel)), i1 = Math.min(size - 1, Math.ceil((east + r) / texel))
    const j0 = Math.max(0, Math.floor((north - r) / texel)), j1 = Math.min(size - 1, Math.ceil((north + r) / texel))
    if (i0 > i1 || j0 > j1) continue
    const [cr, cg, cb] = l.kind.color
    const I = l.kind.intensity
    for (let j = j0; j <= j1; j++) {
      const pn = splatTexelPos(j, size, texel)
      for (let i = i0; i <= i1; i++) {
        const pe = splatTexelPos(i, size, texel)
        const gy = gridHeight(h, pe, pn)
        const lx = east - pe, ly = l.y - (oy + gy), lz = -(north - pn)
        const d = Math.hypot(lx, ly, lz)
        const w = splatWindow(d, r)
        if (w <= 0) continue
        // Ground normal from the height gradient (x east; world z = −north).
        const dhE = gridHeight(h, pe + 1, pn) - gridHeight(h, pe - 1, pn)
        const dhN = gridHeight(h, pe, pn + 1) - gridHeight(h, pe, pn - 1)
        let nx = -dhE / 2, ny = 1, nz = dhN / 2
        const nl = Math.hypot(nx, ny, nz)
        nx /= nl
        ny /= nl
        nz /= nl
        const ndl = d > 1e-6 ? (nx * lx + ny * ly + nz * lz) / d : 1
        if (ndl <= 0) continue
        const v = I * ndl * w
        const o = (j * size + i) * 3
        acc[o] = acc[o]! + cr * v
        acc[o + 1] = acc[o + 1]! + cg * v
        acc[o + 2] = acc[o + 2]! + cb * v
        touched = true
      }
    }
  }
  let lit = 0
  const scale = (NIGHT_SPLAT_GAIN / NIGHT_SPLAT_MAX) * 255
  for (let t = 0; t < n; t++) {
    const r = Math.min(255, Math.round(acc[t * 3]! * scale))
    const g = Math.min(255, Math.round(acc[t * 3 + 1]! * scale))
    const b = Math.min(255, Math.round(acc[t * 3 + 2]! * scale))
    out[t * 4] = r
    out[t * 4 + 1] = g
    out[t * 4 + 2] = b
    out[t * 4 + 3] = 255
    if (touched && (r | g | b)) lit++
  }
  return lit
}

/** What NightLights needs of its world (World has all of it; tests pass their own). */
export interface NightLightsHost {
  readonly scene: Scene
  readonly assets: Pick<Assets, 'json'>
  readonly objects: { addRegionListener(l: RegionListener): () => void }
  readonly terrain: {
    readonly sharedUniforms: SharedUniforms
    setRegionTexture(region: number, slot: TerrainRegionSlot, tex: RawTexture | null): boolean
    setDefine(name: string, on: boolean): void
    readonly onRegionDisposed: { add(fn: (id: number) => void): Observer<number> | null; remove(o: Observer<number> | null): boolean }
    /** W12-SB (S-TERR): a region's heights changed in place (TerrainRenderer.onRegionUpdated): its splat bakes again. */
    readonly onRegionUpdated?: { add(fn: (e: TerrainRegionUpdated) => void): Observer<TerrainRegionUpdated> | null; remove(o: Observer<TerrainRegionUpdated> | null): boolean }
  }
  readonly scatter: { readonly sharedUniforms: SharedUniforms; setDefine(name: string, on: boolean): void }
  readonly render: { readonly quality: { readonly nightLights: Readonly<NightLightQuality> }; readonly weather: Readonly<Pick<RenderWeather, 'rain'>> }
  readonly skyState: { readonly night: number; readonly exposure?: number }
  addCommitStep(name: string, run: (region: RegionData) => void, after: CommitStepAfter, debounceMs?: number): () => void
}

export interface NightLightsOptions {
  /** The point the point lights and the grass window follow (default the active camera's target or position). */
  focus?: () => { x: number; y: number; z: number } | null
  /** Clock (ms; default performance.now). */
  now?: () => number
  /** The ambient index (tests); default read from the world's `ambient.json`. */
  index?: Map<number, AmbientParticle[]>
  /** W12-SB: the free light points (tests; with `index`); default `ambient.json` `points`. */
  points?: readonly NightLightPoint[]
  /** Per-frame hook (default scene.onBeforeRenderObservable); false: the caller runs update() itself. */
  autoUpdate?: boolean
}

export interface NightLightsStats {
  lights: number
  /** Lights from night-only emitters (SKY §7.1: 109 in Jangan before merging). */
  fromNight: number
  merged: number
  /** Regions baked, and those with any light in their splat. */
  regions: number
  litRegions: number
  /** 'cluster' | 'pool' | 'none', and the point lights made. */
  points: 'cluster' | 'pool' | 'none'
  pointLights: number
  lampMaterials: number
  /** W10-S: lamp slots of region batches whose table emissive NL drives (BATCHING §3.10). */
  lampSlots: number
  lastBakeMs: number
}

interface RegionSplat {
  data: SplatRegion
  id: number
  /** CPU texels (null: no light reaches this region). */
  splat: Uint8Array | null
  tex: RawTexture | null
}

interface LampMat {
  mat: Material & { emissiveColor: Color3 }
  base: Color3
  color: RGB3
  /** A PBR material: its glow is divided by the exposure (scene-linear). */
  pbr: boolean
}

/** W10-S (BATCHING §3.10, F9): a lamp material merged into a region batch; its glow goes to the table's texel 5. */
interface LampSlot {
  batch: RegionBatch
  slot: number
  base: Color3
  color: RGB3
}

/**
 * Disposes a ClusteredLightContainer and its proxy ShaderMaterial (LEAK-4): Babylon 9.28's dispose frees the proxy
 * mesh but leaves 'ProxyMaterial' (and its UBO) in scene.materials until the scene goes, one per rebuild.
 */
function disposeContainer(c: ClusteredLightContainer): void {
  const proxy = (c as unknown as { _proxyMaterial?: { dispose(): void } | null })._proxyMaterial
  c.dispose()
  proxy?.dispose()
}

interface Slot {
  light: PointLight
  cur: NightLight | null
  next: NightLight | null | undefined
  w: number
}

/**
 * The point-light driver of one preset: a fixed set of PointLights, inside a ClusteredLightContainer when supported
 * (count = the preset's cluster size), else a pool of `pool` plain lights. Nothing is ever added or removed after the
 * constructor, except addDynamic (hit lights, once at setup).
 */
export class NightPointLights {
  readonly lights: PointLight[] = []
  readonly container: ClusteredLightContainer | null = null
  readonly mode: 'cluster' | 'pool' | 'none'
  private readonly slots: Slot[] = []
  private readonly dynamic: Light[] = []
  private readonly want = new Set<NightLight>()
  private lastPick = -Infinity
  private readonly pickAt = { x: NaN, z: NaN }

  constructor(readonly scene: Scene, q: Readonly<NightLightQuality>) {
    let count = 0
    let mode: 'cluster' | 'pool' | 'none' = 'none'
    if (q.cluster > 0) {
      // Babylon 9.28's clustered include breaks every sheen material (a black frame on WebGPU): patch it first.
      installShaderFixes()
      const c = new ClusteredLightContainer('nl:cluster', [], scene)
      if (c.isSupported) {
        this.container = c
        count = q.cluster
        mode = 'cluster'
      } else disposeContainer(c)
    }
    if (mode === 'none' && q.poolFallback > 0) {
      count = q.poolFallback
      mode = 'pool'
    }
    this.mode = mode
    for (let i = 0; i < count; i++) {
      const light = new PointLight(`nl:light${i}`, new Vector3(0, -1000, 0), scene)
      light.intensity = 0
      light.range = PARKED_RANGE
      light.specular = Color3.Black()
      // Right after the celestial light (CELESTIAL_RENDER_PRIORITY) on every mesh, ahead of the game's hit flashes
      // (priority 0): on a 4-light PBR material (the pool fallback: terrain, water) the flashes are the ones cut (L3).
      light.renderPriority = NIGHT_LIGHT_RENDER_PRIORITY
      this.container?.addLight(light)
      this.lights.push(light)
      this.slots.push({ light, cur: null, next: undefined, w: 0 })
    }
    if (mode === 'pool' && count > 0) {
      // A mesh sorts its light list when a light joins it, not when a priority changes: re-sort the existing meshes.
      scene.sortLightsByPriority()
      for (const m of scene.meshes) m._resyncLightSources()
    }
  }

  /** Puts a caller's light (the game's hit flashes) into the cluster; false without one (it stays a scene light). */
  addDynamic(light: Light): boolean {
    if (!this.container || !ClusteredLightContainer.IsLightSupported(light)) return false
    this.container.addLight(light)
    if (!this.container.lights.includes(light)) return false
    this.dynamic.push(light)
    return true
  }

  /** Takes one caller's light out of the container (it goes back to the scene; the caller disposes it). */
  removeDynamic(light: Light): void {
    const k = this.dynamic.indexOf(light)
    if (k < 0) return
    this.dynamic.splice(k, 1)
    this.container?.removeLight(light)
  }

  /** Whether the caller's light is in this container. */
  hasDynamic(light: Light): boolean {
    return this.dynamic.includes(light)
  }

  /**
   * Takes the caller's lights out of the container (they go back to the scene) and hands them over, so a preset
   * rebuild can put them straight into the next container (W9F L2).
   */
  releaseDynamic(): Light[] {
    const out = this.dynamic.splice(0)
    if (this.container) for (const l of out) this.container.removeLight(l)
    return out
  }

  /** Per frame: re-pick the nearest lights now and then, fade, and write position, colour and intensity. */
  update(all: readonly NightLight[], focus: { x: number; y: number; z: number } | null, night: number, dt: number, nowMs: number, rain: number): void {
    if (!this.slots.length) return
    const dark = !(night > 0.001)
    if (!dark && focus && (nowMs - this.lastPick >= NIGHT_REPICK_MS || !(Math.hypot(focus.x - this.pickAt.x, focus.z - this.pickAt.z) < NIGHT_REPICK_M))) {
      this.lastPick = nowMs
      this.pickAt.x = focus.x
      this.pickAt.z = focus.z
      this.pick(all, focus)
    }
    const step = dt / NIGHT_FADE_S
    const t = nowMs / 1000
    for (const s of this.slots) {
      if (s.next !== undefined && (s.w <= 0 || !s.cur)) {
        s.cur = s.next
        s.next = undefined
        s.w = 0
      }
      const target = s.cur && s.next === undefined && this.want.has(s.cur) ? 1 : 0
      s.w = target > s.w ? Math.min(target, s.w + step) : Math.max(target, s.w - step)
      const l = s.cur
      if (dark || !l || s.w <= 0) {
        if (s.light.intensity !== 0) s.light.intensity = 0
        if (s.light.range !== PARKED_RANGE) s.light.range = PARKED_RANGE
        continue
      }
      const k = l.kind
      let flick = 1
      if (k.flicker > 0) {
        const hz = k.flickerHz[0] + (k.flickerHz[1] - k.flickerHz[0]) * l.seed
        const ph = l.seed * 6.2832
        flick = 1 + k.flicker * (Math.sin(t * hz * 6.2832 + ph) * 0.6 + Math.sin(t * hz * 1.7 * 6.2832 + ph * 3.1) * 0.4)
      }
      const wet = k.fire ? 1 - 0.3 * Math.min(1, Math.max(0, rain)) : 1
      s.light.position.set(l.x, l.y, l.z)
      s.light.diffuse.set(k.color[0], k.color[1], k.color[2])
      s.light.range = k.pointRadiusM ?? k.radiusM
      s.light.intensity = k.intensity * (k.pointGain ?? 1) * NIGHT_POINT_GAIN * night * s.w * flick * wet
    }
  }

  /** The nearest lights within NIGHT_POINT_RANGE_M become the wanted set; free or unwanted slots take the new ones. */
  private pick(all: readonly NightLight[], focus: { x: number; y: number; z: number }): void {
    const n = this.slots.length
    const r2 = NIGHT_POINT_RANGE_M * NIGHT_POINT_RANGE_M
    const near: { l: NightLight; d: number }[] = []
    for (const l of all) {
      const dx = l.x - focus.x, dy = l.y - focus.y, dz = l.z - focus.z
      const d = dx * dx + dy * dy + dz * dz
      if (d <= r2) near.push({ l, d })
    }
    near.sort((a, b) => a.d - b.d)
    this.want.clear()
    for (let i = 0; i < Math.min(n, near.length); i++) this.want.add(near[i]!.l)
    const held = new Set<NightLight>()
    for (const s of this.slots) {
      if (s.next !== undefined && !(s.next && this.want.has(s.next))) s.next = undefined // a swap no longer wanted
      const target = s.next !== undefined ? s.next : s.cur
      if (target && this.want.has(target)) held.add(target)
    }
    const fresh = [...this.want].filter(l => !held.has(l))
    for (const s of this.slots) {
      if (!fresh.length) break
      if (s.next !== undefined || (s.cur && this.want.has(s.cur))) continue
      s.next = fresh.shift()!
    }
  }

  /** Lights currently assigned (with a positive fade), for tests and stats. */
  get active(): number {
    return this.slots.filter(s => s.cur && s.w > 0).length
  }

  dispose(): void {
    // The caller's lights go back to the scene; ours go with the container (or alone).
    if (this.container) for (const l of this.dynamic) this.container.removeLight(l)
    this.dynamic.length = 0
    if (this.container) disposeContainer(this.container)
    else for (const l of this.lights) l.dispose()
    this.lights.length = 0
    this.slots.length = 0
  }
}

/** The night lights of one world. */
export class NightLights {
  /** `nlNight` (x = night × NIGHT_SPLAT_MAX), shared by the terrain and the grass (and the PBR terrain plugin). */
  readonly uniform = new Vector4(0, 0, 0, 0)
  /** `nlGrass`: the grass window (x0, z0, 1 / size, 0). */
  readonly grassUniform = new Vector4(0, 0, 1 / NIGHT_GRASS_WINDOW, 0)
  readonly lights: NightLight[] = []
  points: NightPointLights | null = null
  /** W12-SB: free light points among `lights` (owner NIGHT_POINT_OWNER). */
  private pointCount = 0
  readonly ready: Promise<void>
  private index: Map<number, AmbientParticle[]> | null = null
  private readonly regions = new Map<number, RegionSplat>()
  private readonly rebake = new Set<number>()
  private readonly lamps = new Map<Material, LampMat>()
  /** W10-S: the lamp slots of each region batch, by owner. */
  private readonly lampSlots = new Map<number, LampSlot[]>()
  private quality: NightLightQuality = { cluster: 0, poolFallback: 0, terrainSplat: false, grassSplat: false }
  private applied = false
  private merged = 0
  private lastBakeMs = 0
  private lastEmissive = NaN
  private lastExposure = 1
  private lastNight = NaN
  private grassTex: RawTexture | null = null
  private grassData: Uint8Array | null = null
  private grassDirty = true
  private readonly grassCenter = { x: NaN, z: NaN }
  private lastFrame = NaN
  private disposed = false
  private readonly offs: Array<() => void> = []
  private readonly focus: () => { x: number; y: number; z: number } | null
  private readonly now: () => number

  constructor(readonly host: NightLightsHost, opts: NightLightsOptions = {}) {
    SCENE_NIGHT_LIGHTS.set(host.scene, this)
    this.focus = opts.focus ?? (() => cameraFocus(host.scene.activeCamera))
    this.now = opts.now ?? (() => performance.now())
    host.terrain.sharedUniforms.set(NIGHT_UNIFORM, this.uniform)
    host.scatter.sharedUniforms.set(NIGHT_UNIFORM, this.uniform)
    host.scatter.sharedUniforms.set(NIGHT_GRASS_UNIFORM, this.grassUniform)
    const disposed = host.terrain.onRegionDisposed.add(id => this.dropRegion(id))
    this.offs.push(() => host.terrain.onRegionDisposed.remove(disposed))
    const updated = host.terrain.onRegionUpdated
    if (updated) {
      // the ground under the lights moved: the region's splat (N from the heights) bakes again, one region per frame
      const o = updated.add(e => {
        if (e.heights > 0 && this.regions.has(e.id)) this.rebake.add(e.id)
      })
      this.offs.push(() => updated.remove(o))
    }
    this.applyQuality(host.render.quality.nightLights)
    if (opts.autoUpdate !== false) {
      const o = host.scene.onBeforeRenderObservable.add(() => this.update())
      this.offs.push(() => host.scene.onBeforeRenderObservable.remove(o))
    }
    const start = (index: Map<number, AmbientParticle[]>, points: readonly NightLightPoint[]) => {
      if (this.disposed) return
      this.index = index
      if (points.length) this.setPoints(points)
      this.offs.push(host.objects.addRegionListener({
        placed: (region, model, info, meshes, placements) => this.placed(region, model, info, meshes, placements),
        removed: region => this.removed(region),
        batched: (region, batch) => this.batched(region, batch),
      }))
      this.offs.push(host.addCommitStep('nightSplat', data => this.bakeRegion(data), 'objects'))
    }
    if (opts.index) {
      start(opts.index, opts.points ?? [])
      this.ready = Promise.resolve()
    } else {
      this.ready = host.assets.json<unknown>('ambient.json').then(
        json => ({ index: readAmbientIndex(json), points: readAmbientPoints(json) }),
        () => ({ index: new Map<number, AmbientParticle[]>(), points: [] as NightLightPoint[] }),
      ).then(a => start(a.index, a.points))
    }
  }

  get stats(): NightLightsStats {
    let lit = 0
    for (const r of this.regions.values()) if (r.splat) lit++
    return {
      lights: this.lights.length,
      fromNight: this.lights.filter(l => l.fromNight).length,
      merged: this.merged,
      regions: this.regions.size,
      litRegions: lit,
      points: this.points?.mode ?? 'none',
      pointLights: this.points?.lights.length ?? 0,
      lampMaterials: this.lamps.size,
      lampSlots: [...this.lampSlots.values()].reduce((n, l) => n + l.length, 0),
      lastBakeMs: this.lastBakeMs,
    }
  }

  /** The CPU splat of a baked region (null: not baked or unlit). */
  splatOf(region: number): Uint8Array | null {
    return this.regions.get(region)?.splat ?? null
  }

  /** The GPU splat bound on a region's terrain (null: none). */
  textureOf(region: number): RawTexture | null {
    return this.regions.get(region)?.tex ?? null
  }

  /** The grass window texture (null while the grass splat is off). */
  get grassTexture(): RawTexture | null {
    return this.grassTex
  }

  /** Puts a caller's light (hit flashes) into the cluster (D12); false without a cluster (it stays a scene light). */
  addDynamicLight(light: Light): boolean {
    return this.points?.addDynamic(light) ?? false
  }

  /**
   * W11 (TOWN_LIFE §7.1, H11-NT-3): whether a moving light would join a cluster now. A caller asks this BEFORE it makes
   * a light, so no light is ever made that would stay a scene light (a material light-count change, a recompile).
   */
  canAddDynamicLight(): boolean {
    return !this.disposed && !!this.points?.container
  }

  /** Takes a caller's light out of the cluster (it goes back to the scene: the caller disposes it right after). */
  removeDynamicLight(light: Light): void {
    this.points?.removeDynamic(light)
  }

  /** Whether a caller's light is in the cluster now (false after a preset rebuild without a cluster, or a dispose). */
  hasDynamicLight(light: Light): boolean {
    return !this.disposed && (this.points?.hasDynamic(light) ?? false)
  }

  // ---- sources ----------------------------------------------------------------------------------------------------

  /**
   * W12-SB (seam S-NL): replaces the free light points (the editor's Lights tool, live; at attach, `ambient.json`
   * `points`). They join the point-light pick at its next re-pick and every baked region they reach (and those the old
   * points reached) bakes its splat again, one per frame. Returns the points now lit.
   */
  setPoints(points: readonly NightLightPoint[]): number {
    if (this.disposed) return 0
    const gone: NightLight[] = []
    for (let i = this.lights.length - 1; i >= 0; i--) {
      if (this.lights[i]!.owner !== NIGHT_POINT_OWNER) continue
      gone.push(this.lights[i]!)
      this.lights.splice(i, 1)
    }
    const added = points.map(pointLight)
    this.lights.push(...added)
    this.pointCount = added.length
    if (gone.length || added.length) this.touch([...gone, ...added])
    return added.length
  }

  /** The free light points now lit (NightLights.setPoints). */
  get freePoints(): readonly NightLight[] {
    return this.pointCount ? this.lights.filter(l => l.owner === NIGHT_POINT_OWNER) : []
  }

  private placed(region: number, model: WorldModel, info: PlacedModelInfo, meshes: readonly AbstractMesh[], placements: readonly WorldPlacement[]): void {
    const rows = this.index?.get(model.index) ?? []
    if (rows.length) {
      const added: NightLight[] = []
      // the free points never swallow a retail lamp (a point taken away later would leave it dark)
      const existing = this.pointCount ? this.lights.filter(l => l.owner !== NIGHT_POINT_OWNER) : this.lights
      this.merged += placeLights(rows, placements, region, existing, added)
      if (added.length) {
        this.lights.push(...added)
        this.touch(added)
      }
    }
    this.lampMaterials(info, rows, meshes)
  }

  private removed(region: number): void {
    this.lampSlots.delete(region)
    const gone: NightLight[] = []
    for (let i = this.lights.length - 1; i >= 0; i--) {
      if (this.lights[i]!.owner !== region) continue
      gone.push(this.lights[i]!)
      this.lights.splice(i, 1)
    }
    if (gone.length) this.touch(gone)
  }

  /** Baked regions within reach of `changed` lights bake again (one per frame). */
  private touch(changed: readonly NightLight[]): void {
    for (const r of this.regions.values()) {
      const [ox = 0, , oz = 0] = r.data.origin
      if (changed.some(l => l.x > ox - l.kind.radiusM && l.x < ox + 192 + l.kind.radiusM && l.z < oz + l.kind.radiusM && l.z > oz - 192 - l.kind.radiusM)) this.rebake.add(r.id)
    }
  }

  private lampMaterials(info: PlacedModelInfo, rows: readonly AmbientParticle[], meshes: readonly AbstractMesh[]): void {
    const lampModel = isLampModel(info.source)
    const nightOwner = rows.some(r => r.night && nightKindOf(r.efp))
    if (!lampModel && !nightOwner) return
    const kind = rows.map(r => nightKindOf(r.efp)).find(k => !!k) ?? NIGHT_LIGHT_KINDS[0]!
    for (const mesh of meshes) {
      const mat = mesh.material as (Material & { emissiveColor?: Color3; disableLighting?: boolean; unlit?: boolean }) | null
      if (!mat || this.lamps.has(mat) || !(mat.emissiveColor instanceof Color3)) continue
      if (mat.disableLighting || mat.unlit) continue // self-illuminated already
      if (!lampRule(info.source, mat.name, nightOwner)) continue
      const entry: LampMat = { mat: mat as LampMat['mat'], base: mat.emissiveColor.clone(), color: kind.color, pbr: mat instanceof PBRBaseMaterial }
      this.lamps.set(mat, entry)
      mat.onDisposeObservable.addOnce(() => this.lamps.delete(mat))
      this.setEmissive(entry, Number.isFinite(this.lastEmissive) ? this.lastEmissive : 0)
    }
  }

  /**
   * W10-S (BATCHING §3.10, F9): a region batch's lamp slots take the same rule and kind colour as the separate lamp
   * materials; their glow is written into the batch's material table (texel 5) instead of a material.
   */
  private batched(region: number, batch: RegionBatch): void {
    const slots: LampSlot[] = []
    for (const s of batch.slots) {
      const mat = s.material as Material & { emissiveColor?: Color3; disableLighting?: boolean; unlit?: boolean }
      if (mat.disableLighting || mat.unlit) continue
      const rows = this.index?.get(s.model.index) ?? []
      const nightOwner = rows.some(r => r.night && nightKindOf(r.efp))
      if (!lampRule(s.model.source, mat.name, nightOwner)) continue
      const kind = rows.map(r => nightKindOf(r.efp)).find(k => !!k) ?? NIGHT_LIGHT_KINDS[0]!
      const base = mat.emissiveColor instanceof Color3 ? mat.emissiveColor.clone() : new Color3(0, 0, 0)
      slots.push({ batch, slot: s.slot, base, color: kind.color })
    }
    if (!slots.length) {
      this.lampSlots.delete(region)
      return
    }
    this.lampSlots.set(region, slots)
    const night = Number.isFinite(this.lastEmissive) ? this.lastEmissive : 0
    for (const e of slots) this.setSlotEmissive(e, night)
  }

  private setEmissive(e: LampMat, night: number): void {
    const k = NIGHT_EMISSIVE * night / (e.pbr ? this.lastExposure : 1)
    e.mat.emissiveColor.set(e.base.r + e.color[0] * k, e.base.g + e.color[1] * k, e.base.b + e.color[2] * k)
  }

  /** A batch lamp slot's glow (the batch is on the PBR path: divided by the exposure like a PBR lamp material). */
  private setSlotEmissive(e: LampSlot, night: number): void {
    const k = NIGHT_EMISSIVE * night / this.lastExposure
    e.batch.setEmissive(e.slot, e.base.r + e.color[0] * k, e.base.g + e.color[1] * k, e.base.b + e.color[2] * k)
  }

  // ---- splats -----------------------------------------------------------------------------------------------------

  /** The commit step (and the rebake queue): bakes one region, binds it on the terrain when the preset wants it. */
  bakeRegion(data: RegionData | (SplatRegion & { id: number })): void {
    if (this.disposed) return
    const id = 'region' in data ? data.region.id : data.id
    const src: SplatRegion = 'region' in data ? { origin: data.region.origin, heights: data.terrain.heights } : data
    const t0 = this.now()
    let r = this.regions.get(id)
    if (!r) this.regions.set(id, (r = { data: src, id, splat: null, tex: null }))
    r.data = src
    const [ox = 0, , oz = 0] = src.origin
    const near = this.lights.filter(l => l.x > ox - l.kind.radiusM && l.x < ox + 192 + l.kind.radiusM && l.z < oz + l.kind.radiusM && l.z > oz - 192 - l.kind.radiusM)
    if (near.length) {
      const buf = r.splat ?? new Uint8Array(NIGHT_SPLAT_SIZE * NIGHT_SPLAT_SIZE * 4)
      r.splat = bakeSplat(buf, src, near) > 0 ? buf : null
    } else r.splat = null
    this.bindRegion(r)
    this.rebake.delete(id)
    this.grassDirty = true
    this.lastBakeMs = this.now() - t0
  }

  private bindRegion(r: RegionSplat): void {
    const want = this.quality.terrainSplat && r.splat
    if (!want) {
      if (r.tex) {
        this.host.terrain.setRegionTexture(r.id, 'nightSplat', null)
        r.tex.dispose()
        r.tex = null
      }
      return
    }
    if (r.tex) r.tex.update(r.splat!)
    else {
      r.tex = RawTexture.CreateRGBATexture(r.splat!, NIGHT_SPLAT_SIZE, NIGHT_SPLAT_SIZE, this.host.scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
      r.tex.name = `nightSplat_${r.id}`
      r.tex.wrapU = Texture.CLAMP_ADDRESSMODE
      r.tex.wrapV = Texture.CLAMP_ADDRESSMODE
    }
    if (!this.host.terrain.setRegionTexture(r.id, 'nightSplat', r.tex)) {
      r.tex.dispose()
      r.tex = null
    }
  }

  private dropRegion(id: number): void {
    const r = this.regions.get(id)
    if (!r) return
    r.tex?.dispose() // the terrain already unbound it with the region
    this.regions.delete(id)
    this.rebake.delete(id)
    this.grassDirty = true
  }

  /** Copies the region splats around `focus` into the grass window (black outside, and on its border). */
  private bakeGrass(fx: number, fz: number): void {
    const S = NIGHT_GRASS_WINDOW
    const data = (this.grassData ??= new Uint8Array(S * S * 4))
    data.fill(0)
    const x0 = Math.round(fx / 16) * 16 - S / 2
    const z0 = Math.round(fz / 16) * 16 - S / 2
    for (const r of this.regions.values()) {
      if (!r.splat) continue
      const [ox = 0, , oz = 0] = r.data.origin
      // Window column u ↔ x = x0 + u; region column i = x − ox. Window row v ↔ z = z0 + v; region row j = oz − z − 1.
      const u0 = Math.max(1, Math.ceil(ox - x0)), u1 = Math.min(S - 2, Math.floor(ox + 192 - x0) - 1)
      const v0 = Math.max(1, Math.ceil(oz - 192 - z0)), v1 = Math.min(S - 2, Math.floor(oz - z0) - 1)
      for (let v = v0; v <= v1; v++) {
        const j = Math.floor(oz - (z0 + v + 0.5))
        if (j < 0 || j >= NIGHT_SPLAT_SIZE) continue
        for (let u = u0; u <= u1; u++) {
          const i = Math.floor(x0 + u + 0.5 - ox)
          if (i < 0 || i >= NIGHT_SPLAT_SIZE) continue
          const s = (j * NIGHT_SPLAT_SIZE + i) * 4
          const o = (v * S + u) * 4
          data[o] = r.splat[s]!
          data[o + 1] = r.splat[s + 1]!
          data[o + 2] = r.splat[s + 2]!
          data[o + 3] = 255
        }
      }
    }
    this.grassCenter.x = fx
    this.grassCenter.z = fz
    this.grassUniform.set(x0, z0, 1 / S, 0)
    if (this.grassTex) this.grassTex.update(data)
    else {
      this.grassTex = RawTexture.CreateRGBATexture(data, S, S, this.host.scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
      this.grassTex.name = 'nightGrassSplat'
      this.grassTex.wrapU = Texture.CLAMP_ADDRESSMODE
      this.grassTex.wrapV = Texture.CLAMP_ADDRESSMODE
      this.host.scatter.sharedUniforms.set(NIGHT_GRASS_SAMPLER, this.grassTex)
    }
    this.grassDirty = false
  }

  // ---- preset and frame ---------------------------------------------------------------------------------------------

  /** A preset change (Options): defines, terrain bindings, the point lights. The only place a define changes. */
  applyQuality(q: Readonly<NightLightQuality>): void {
    const prev = this.quality
    if (this.disposed || (this.applied && q.cluster === prev.cluster && q.poolFallback === prev.poolFallback &&
      q.terrainSplat === prev.terrainSplat && q.grassSplat === prev.grassSplat)) return
    this.applied = true
    this.quality = { ...q }
    this.host.terrain.setDefine(NIGHT_TERRAIN_DEFINE, q.terrainSplat)
    this.host.scatter.setDefine(NIGHT_GRASS_DEFINE, q.grassSplat)
    if (q.terrainSplat !== prev.terrainSplat) for (const r of this.regions.values()) this.bindRegion(r)
    if (!q.grassSplat && this.grassTex) {
      this.host.scatter.sharedUniforms.delete(NIGHT_GRASS_SAMPLER)
      this.grassTex.dispose()
      this.grassTex = null
    }
    this.grassDirty = true
    if (q.cluster !== prev.cluster || q.poolFallback !== prev.poolFallback || !this.points) {
      // W9F L2: the hit lights move from the old container into the new one in this call, before any frame renders;
      // otherwise they would be scene lights on every mesh until the pools re-join (a throwaway compile of every
      // material). Without a new cluster they simply stay scene lights.
      const moved = this.points?.releaseDynamic() ?? []
      this.points?.dispose()
      this.points = q.cluster > 0 || q.poolFallback > 0 ? new NightPointLights(this.host.scene, q) : null
      for (const l of moved) if (!l.isDisposed()) this.points?.addDynamic(l)
    }
  }

  /** Per frame (scene.onBeforeRenderObservable unless autoUpdate is false). */
  update(): void {
    if (this.disposed) return
    this.applyQuality(this.host.render.quality.nightLights)
    const now = this.now()
    const dt = Number.isFinite(this.lastFrame) ? Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000)) : 0
    this.lastFrame = now
    const raw = this.host.skyState.night
    const night = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0
    if (night !== this.lastNight) {
      this.lastNight = night
      this.uniform.x = night * NIGHT_SPLAT_MAX
    }
    const ex = this.host.skyState.exposure
    // The exposure the post stack applies (SkyState.exposure × its trim; W9F D6: the trim made lamps 1.4× Classic).
    const exposure = ex !== undefined && ex > 0 && Number.isFinite(ex) ? sceneDisplay(this.host.scene, ex).exposure : 1
    const exMoved = night > 0 && !(Math.abs(exposure - this.lastExposure) < 0.02 * this.lastExposure)
    if (exMoved) this.lastExposure = exposure
    if (exMoved || !(Math.abs(night - this.lastEmissive) < 0.004) || (night === 0 && this.lastEmissive !== 0)) {
      this.lastEmissive = night
      for (const e of this.lamps.values()) this.setEmissive(e, night)
      for (const list of this.lampSlots.values()) for (const e of list) this.setSlotEmissive(e, night)
    }
    if (this.rebake.size) {
      const id = this.rebake.values().next().value!
      const r = this.regions.get(id)
      if (r) this.bakeRegion({ ...r.data, id: r.id })
      else this.rebake.delete(id)
    }
    const focus = this.focus()
    if (this.quality.grassSplat && night > 0 && focus) {
      const moved = !(Math.hypot(focus.x - this.grassCenter.x, focus.z - this.grassCenter.z) < NIGHT_GRASS_RECENTER_M)
      if (moved || this.grassDirty) this.bakeGrass(focus.x, focus.z)
    }
    this.points?.update(this.lights, focus, night, dt, now, this.host.render.weather.rain)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (SCENE_NIGHT_LIGHTS.get(this.host.scene) === this) SCENE_NIGHT_LIGHTS.delete(this.host.scene)
    for (const off of this.offs.splice(0)) {
      try {
        off()
      } catch {
        // the world went first
      }
    }
    for (const e of this.lamps.values()) e.mat.emissiveColor.copyFrom(e.base)
    this.lamps.clear()
    for (const list of this.lampSlots.values()) for (const e of list) e.batch.setEmissive(e.slot, e.base.r, e.base.g, e.base.b)
    this.lampSlots.clear()
    try {
      for (const r of this.regions.values()) if (r.tex) this.host.terrain.setRegionTexture(r.id, 'nightSplat', null)
      this.host.terrain.setDefine(NIGHT_TERRAIN_DEFINE, false)
      this.host.scatter.setDefine(NIGHT_GRASS_DEFINE, false)
      this.host.scatter.sharedUniforms.delete(NIGHT_GRASS_SAMPLER)
    } catch {
      // the world went first
    }
    for (const r of this.regions.values()) r.tex?.dispose()
    this.regions.clear()
    this.grassTex?.dispose()
    this.grassTex = null
    this.points?.dispose()
    this.points = null
    this.uniform.x = 0
  }
}

/** The active camera's target (ArcRotate) or position. */
function cameraFocus(camera: Camera | null): { x: number; y: number; z: number } | null {
  if (!camera) return null
  const t = (camera as Camera & { target?: Vector3 }).target
  return t instanceof Vector3 ? t : camera.globalPosition
}

/** Night lights for a World (or any host): dispose the handle before the world. */
/** The live night lights of each scene (the town's carried lanterns find the cluster through it; H11-NT-3). */
const SCENE_NIGHT_LIGHTS = new WeakMap<Scene, NightLights>()

/** The live NightLights attached to `scene` (null: none, or disposed). */
export function nightLightsOf(scene: Scene): NightLights | null {
  return SCENE_NIGHT_LIGHTS.get(scene) ?? null
}

export function attachNightLights(world: NightLightsHost, opts?: NightLightsOptions): NightLights {
  return new NightLights(world, opts)
}

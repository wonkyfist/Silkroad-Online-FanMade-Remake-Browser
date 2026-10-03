/**
 * Distant ships (docs/COAST.md §10.3, §8.11B; docs/WAVE_PLAN6.md §5.3 and lane CST-A): one to three junks sailing
 * slow straight passes across the view in the haze, riding the CPU wave query (CST-O's
 * `OceanWaveQuery.waveHeightAt`: heave, pitch and roll from five samples).
 *
 * - **The model** is procedural [decision, CST-A]: the retail `w_cd_ani_boat` converts cleanly but is 6 meshes and 5
 *   materials (6 draws a ship, 367 KiB, skinned), over the lane's ≤ 3 draws and ≤ 0.3 MB; deep in the fog only the
 *   outline reads, so a Chinese junk of ≈ 90 flat-shaded triangles in vertex colours (a lofted hull with a
 *   raised stern, a deckhouse, three masts, three red-brown lug sails) stands in. All ships are thin instances of one
 *   mesh: **one draw**, no texture, nothing downloaded. Its PBRMaterial gets the height fog like any PBR material.
 * - **Routes** (`planShipRoute`): a centre 0.72–1.05 × the fog end from the player and a 440 m pass across the view,
 *   so a ship comes out of the haze, crosses as a silhouette (≈ 60–90 % fogged) and goes back into it. COAST §10.3's
 *   "250–400 m offshore" assumed a far fog; Jangan's clear-day fog end measured 226 m in game (wave 9's height fog),
 *   where a ship 250 m out is invisible [decision, CST-A]. Every sample along the pass (each 20 m) must be open sea
 *   deeper than SHIP.deepM (8 m) with no land within SHIP.landClearM (60 m), the lane's hard rule.
 *   A ship grows in over its first and shrinks out over its last 6 s (it comes out of the haze), and is retired at the
 *   end or when the player is far from its route.
 * - **PBR presets only** (the caller disposes it on the Classic path: Low stays as today).
 */
import { Color3, Matrix, Mesh, PBRMaterial, Quaternion, Vector3, VertexData, type Scene } from '@babylonjs/core'
import type { OceanWaveQuery } from '@sro/world-render'
import type { CoastSea } from './critters.ts'

export const SHIP = {
  /** Ships at once, at most (the lane's ≤ 3), and how many the planner keeps. */
  max: 3,
  target: 2,
  /** The route centre's distance from the player, as fractions of the fog end (clamped to rangeM, m); the pass's half length (m). */
  fogFrac: [0.72, 1.05] as const,
  rangeM: [140, 450] as const,
  halfLengthM: 220,
  /** Every route sample: open sea deeper than this (m), no land within this (m), samples this far apart (m). */
  deepM: 8,
  landClearM: 60,
  sampleM: 20,
  /** Sailing speed (m/s; a junk's ≈ 7 knots). */
  speedMs: 3.5,
  /** Grow-in and shrink-out (s). */
  fadeS: 6,
  /** Seconds between plans, and before the next ship after one leaves. */
  planEveryS: 4,
  respawnS: [15, 45] as const,
  /** Retired when the player is this far from the route centre (m). */
  retireM: 900,
  /** Heave/pitch/roll smoothing (s) and clamp (rad). */
  swayS: 0.4,
  maxTilt: 0.14,
} as const

/** The hull's half length and half beam (m): where the sway samples sit. */
const HALF_L = 8
const HALF_B = 2.4

// ---- geometry -------------------------------------------------------------------------------------------------------

function lin(r: number, g: number, b: number): [number, number, number] {
  const f = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return [f(r), f(g), f(b)]
}

const HULL = lin(62, 45, 33)
const DECK = lin(96, 74, 52)
const MAST = lin(44, 34, 26)
const SAIL = lin(128, 64, 42)

/** Flat-shaded triangles: positions, normals, colours (RGBA) and indices. */
export interface ShipGeometry {
  positions: number[]
  normals: number[]
  colors: number[]
  indices: number[]
}

type V3 = [number, number, number]

/**
 * A planar convex polygon facing away from `inside`: the order is flipped when needed, and the normal follows
 * Babylon's convention for that order (VertexData.ComputeNormals: (p1 − p2) × (p3 − p2)).
 */
function addFace(g: ShipGeometry, pts: readonly V3[], c: readonly number[], inside: V3): void {
  const normal = (q: readonly V3[]): V3 => {
    const [a, b, d] = [q[0]!, q[1]!, q[2]!]
    const u = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], v = [d[0] - b[0], d[1] - b[1], d[2] - b[2]]
    return [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
  }
  const centre = pts.reduce<V3>((m, p) => [m[0] + p[0] / pts.length, m[1] + p[1] / pts.length, m[2] + p[2] / pts.length], [0, 0, 0])
  let q = pts
  let n = normal(q)
  if (n[0] * (centre[0] - inside[0]) + n[1] * (centre[1] - inside[1]) + n[2] * (centre[2] - inside[2]) < 0) {
    q = [...pts].reverse()
    n = normal(q)
  }
  const len = Math.hypot(n[0], n[1], n[2]) || 1
  const base = g.positions.length / 3
  for (const p of q) {
    g.positions.push(p[0], p[1], p[2])
    g.normals.push(n[0] / len, n[1] / len, n[2] / len)
    g.colors.push(c[0]!, c[1]!, c[2]!, 1)
  }
  for (let i = 1; i + 1 < q.length; i++) g.indices.push(base, base + i, base + i + 1)
}

/** Both sides of a thin panel in a plane x = const (a sail). */
function addPanel(g: ShipGeometry, pts: readonly V3[], c: readonly number[]): void {
  const x = pts[0]![0]
  addFace(g, pts, c, [x - 1, pts[0]![1], pts[0]![2]])
  addFace(g, pts, c, [x + 1, pts[0]![1], pts[0]![2]])
}

function addBox(g: ShipGeometry, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: readonly number[]): void {
  const p = (x: number, y: number, z: number): V3 => [x, y, z]
  const mid: V3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]
  addFace(g, [p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0)], c, mid)
  addFace(g, [p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)], c, mid)
  addFace(g, [p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)], c, mid)
  addFace(g, [p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), p(x0, y0, z1)], c, mid)
  addFace(g, [p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), p(x0, y0, z0)], c, mid)
  addFace(g, [p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)], c, mid)
}

/**
 * The junk, bow along +z, the waterline at y = 0: a hull lofted through three stations (stern, waist, bow; the stern
 * and bow swept up), a deckhouse aft, a mainmast, a foremast and a mizzen, each with a lug sail.
 */
export function junkGeometry(): ShipGeometry {
  const g: ShipGeometry = { positions: [], normals: [], colors: [], indices: [] }
  // Stations: z, keel y, deck y, half beam at the deck, half beam at the keel.
  const st = [
    { z: -9, keel: -0.4, deck: 3.4, top: 2.2, bot: 1.0 },
    { z: 0, keel: -1.3, deck: 1.6, top: 2.6, bot: 1.2 },
    { z: 9, keel: -0.2, deck: 2.8, top: 1.4, bot: 0.3 },
  ]
  for (let i = 0; i + 1 < st.length; i++) {
    const a = st[i]!, b = st[i + 1]!
    const inside: V3 = [0, (a.keel + a.deck + b.keel + b.deck) / 4, (a.z + b.z) / 2]
    addFace(g, [[-a.top, a.deck, a.z], [-a.bot, a.keel, a.z], [-b.bot, b.keel, b.z], [-b.top, b.deck, b.z]], HULL, inside) // port
    addFace(g, [[a.top, a.deck, a.z], [b.top, b.deck, b.z], [b.bot, b.keel, b.z], [a.bot, a.keel, a.z]], HULL, inside) // starboard
    addFace(g, [[-a.top, a.deck, a.z], [-b.top, b.deck, b.z], [b.top, b.deck, b.z], [a.top, a.deck, a.z]], DECK, inside) // deck
    addFace(g, [[-a.bot, a.keel, a.z], [a.bot, a.keel, a.z], [b.bot, b.keel, b.z], [-b.bot, b.keel, b.z]], HULL, inside) // bottom
  }
  const hullMid: V3 = [0, 0.5, 0]
  const s0 = st[0]!, s2 = st[2]!
  addFace(g, [[-s0.top, s0.deck, s0.z], [s0.top, s0.deck, s0.z], [s0.bot, s0.keel, s0.z], [-s0.bot, s0.keel, s0.z]], HULL, hullMid) // transom
  addFace(g, [[-s2.top, s2.deck, s2.z], [-s2.bot, s2.keel, s2.z], [s2.bot, s2.keel, s2.z], [s2.top, s2.deck, s2.z]], HULL, hullMid) // bow
  addBox(g, -1.8, 2.2, -7.5, 1.8, 4.6, -3.5, HULL) // deckhouse
  // Masts (z, height) and their lug sails (aft-heavy, the top yard raised forward).
  for (const [z, h, foot, head] of [[1, 17, 3.6, 3.2], [6, 13, 2.6, 2.4], [-6, 11.5, 2.2, 2]] as const) {
    const deck = z > 0 ? 1.6 + (2.8 - 1.6) * (z / 9) : 1.6 + (3.4 - 1.6) * (-z / 9)
    addBox(g, -0.18, deck - 0.2, z - 0.18, 0.18, deck + h, z + 0.18, MAST)
    const y0 = deck + 1.8, y1 = deck + h - 0.6
    addPanel(g, [[0.25, y0, z - foot * 1.25], [0.25, y0, z + foot * 0.6], [0.25, y1, z + head * 0.8], [0.25, y1 - 1.6, z - head * 1.4]], SAIL)
  }
  return g
}

// ---- routes ---------------------------------------------------------------------------------------------------------

/** A straight pass from a to b. */
export interface ShipRoute {
  ax: number
  az: number
  bx: number
  bz: number
  lengthM: number
}

/** Open sea deeper than SHIP.deepM with no land within SHIP.landClearM (8 directions at the full and half radius). */
export function offshoreOk(sea: CoastSea, x: number, z: number): boolean {
  if (!((sea.depthAt(x, z) ?? 0) > SHIP.deepM)) return false
  for (const r of [SHIP.landClearM, SHIP.landClearM / 2]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      if (!sea.seaAt(x + Math.cos(a) * r, z + Math.sin(a) * r)) return false
    }
  }
  return true
}

/** Every SHIP.sampleM along the route passes `offshoreOk`. */
export function routeOk(sea: CoastSea, r: ShipRoute): boolean {
  const n = Math.max(1, Math.ceil(r.lengthM / SHIP.sampleM))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    if (!offshoreOk(sea, r.ax + (r.bx - r.ax) * t, r.az + (r.bz - r.az) * t)) return false
  }
  return true
}

/** A pass across the view from (px, pz) with the fog ending at `fogEndM`, or null when no try fits (inland, a lake). */
export function planShipRoute(sea: CoastSea, px: number, pz: number, rnd: () => number, fogEndM = 226, tries = 12): ShipRoute | null {
  const near = clampRange(fogEndM * SHIP.fogFrac[0]), far = clampRange(fogEndM * SHIP.fogFrac[1])
  for (let i = 0; i < tries; i++) {
    const a = rnd() * Math.PI * 2
    const r = near + rnd() * (far - near)
    const cx = px + Math.cos(a) * r, cz = pz + Math.sin(a) * r
    if (!offshoreOk(sea, cx, cz)) continue
    const sign = rnd() < 0.5 ? -1 : 1
    const tx = -Math.sin(a) * sign, tz = Math.cos(a) * sign
    const h = SHIP.halfLengthM
    const route = { ax: cx - tx * h, az: cz - tz * h, bx: cx + tx * h, bz: cz + tz * h, lengthM: 2 * h }
    if (routeOk(sea, route)) return route
  }
  return null
}

// ---- runtime --------------------------------------------------------------------------------------------------------

interface Ship {
  route: ShipRoute
  /** Metres sailed. */
  s: number
  yaw: number
  y: number
  pitch: number
  roll: number
  fresh: boolean
}

export class CoastShips {
  readonly mesh: Mesh
  private readonly material: PBRMaterial
  private readonly ships: Ship[] = []
  private readonly buf = new Float32Array(16 * SHIP.max)
  private planT = 0
  private disposed = false
  private readonly m = new Matrix()
  private readonly q = new Quaternion()
  private readonly scale = new Vector3()
  private readonly pos = new Vector3()

  constructor(
    scene: Scene,
    private readonly sea: CoastSea,
    private readonly waves: OceanWaveQuery | null,
    private readonly rnd: () => number = Math.random,
  ) {
    const g = junkGeometry()
    const vd = new VertexData()
    vd.positions = g.positions
    vd.normals = g.normals
    vd.colors = g.colors
    vd.indices = g.indices
    this.mesh = new Mesh('sroCoastShips', scene)
    vd.applyToMesh(this.mesh, false)
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
    this.mesh.doNotSyncBoundingInfo = true
    this.mesh.receiveShadows = false
    this.mesh.metadata = { sroCoast: 'ships' }
    this.material = new PBRMaterial('sroCoastShip', scene)
    this.material.albedoColor = Color3.White()
    this.material.metallic = 0
    this.material.roughness = 0.9
    this.mesh.material = this.material
    this.mesh.thinInstanceSetBuffer('matrix', this.buf, 16, false)
    this.mesh.thinInstanceCount = 0
    this.mesh.setEnabled(false)
  }

  /** Ships sailing now. */
  get count(): number {
    return this.ships.length
  }

  /** The routes sailed now (tests, the debug panel). */
  routes(): readonly ShipRoute[] {
    return this.ships.map(s => s.route)
  }

  /** Per frame: plans, sails, sways and writes the instances; `fogEndM` is the scene's fog end (scene.fogEnd). */
  update(px: number, pz: number, dt: number, fogEndM = 226): void {
    if (this.disposed) return
    dt = Math.min(0.25, Math.max(0, dt))
    this.planT -= dt
    if (this.planT <= 0 && this.ships.length < Math.min(SHIP.target, SHIP.max)) {
      this.planT = SHIP.planEveryS
      const route = planShipRoute(this.sea, px, pz, this.rnd, fogEndM)
      if (route) {
        const yaw = Math.atan2(route.bx - route.ax, route.bz - route.az)
        this.ships.push({ route, s: 0, yaw, y: this.sea.seaLevelM, pitch: 0, roll: 0, fresh: true })
        if (this.ships.length < SHIP.target) this.planT = SHIP.respawnS[0] + this.rnd() * (SHIP.respawnS[1] - SHIP.respawnS[0])
      }
    }
    for (let i = this.ships.length - 1; i >= 0; i--) {
      const sh = this.ships[i]!
      sh.s += SHIP.speedMs * dt
      const r = sh.route
      const cx = (r.ax + r.bx) / 2, cz = (r.az + r.bz) / 2
      if (sh.s >= r.lengthM || (cx - px) ** 2 + (cz - pz) ** 2 > SHIP.retireM ** 2) {
        this.ships.splice(i, 1)
        this.planT = Math.max(this.planT, SHIP.respawnS[0] + this.rnd() * (SHIP.respawnS[1] - SHIP.respawnS[0]))
      }
    }
    const k = 1 - Math.exp(-dt / SHIP.swayS)
    const fadeM = SHIP.speedMs * SHIP.fadeS
    for (let i = 0; i < this.ships.length; i++) {
      const sh = this.ships[i]!
      const r = sh.route
      const t = sh.s / r.lengthM
      const x = r.ax + (r.bx - r.ax) * t, z = r.az + (r.bz - r.az) * t
      const fx = Math.sin(sh.yaw), fz = Math.cos(sh.yaw)
      const rx = Math.cos(sh.yaw), rz = -Math.sin(sh.yaw)
      const hc = this.heightAt(x, z)
      const pitch = clamp(Math.atan2(this.heightAt(x - fx * HALF_L, z - fz * HALF_L) - this.heightAt(x + fx * HALF_L, z + fz * HALF_L), 2 * HALF_L), SHIP.maxTilt)
      const roll = clamp(Math.atan2(this.heightAt(x + rx * HALF_B, z + rz * HALF_B) - this.heightAt(x - rx * HALF_B, z - rz * HALF_B), 2 * HALF_B), SHIP.maxTilt)
      if (sh.fresh) {
        sh.y = hc
        sh.pitch = pitch
        sh.roll = roll
        sh.fresh = false
      } else {
        sh.y += (hc - sh.y) * k
        sh.pitch += (pitch - sh.pitch) * k
        sh.roll += (roll - sh.roll) * k
      }
      const grow = Math.max(0.001, Math.min(1, sh.s / fadeM, (r.lengthM - sh.s) / fadeM))
      Quaternion.RotationYawPitchRollToRef(sh.yaw, sh.pitch, sh.roll, this.q)
      this.scale.setAll(grow)
      this.pos.set(x, sh.y, z)
      Matrix.ComposeToRef(this.scale, this.q, this.pos, this.m)
      this.m.copyToArray(this.buf, i * 16)
    }
    const n = this.ships.length
    this.mesh.thinInstanceCount = n
    if (n) this.mesh.thinInstanceBufferUpdated('matrix')
    this.mesh.setEnabled(n > 0)
  }

  /** The sea surface height at (x, z): the ocean's waves, or the flat sea level without them. */
  private heightAt(x: number, z: number): number {
    return this.waves?.waveHeightAt(x, z) ?? this.sea.seaLevelM
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ships.length = 0
    this.mesh.dispose()
    this.material.dispose()
  }
}

function clampRange(r: number): number {
  return Math.max(SHIP.rangeM[0], Math.min(SHIP.rangeM[1], Number.isFinite(r) ? r : SHIP.rangeM[1]))
}

function clamp(v: number, m: number): number {
  return Math.max(-m, Math.min(m, v))
}

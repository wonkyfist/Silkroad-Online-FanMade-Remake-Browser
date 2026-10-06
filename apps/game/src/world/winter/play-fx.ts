/**
 * Winter gameplay FX (docs/WINTER.md §13.7): snowballs in flight and their splats, the Ice Yeti's telegraphs and their
 * landings, the frost glints around winter monsters and the winter campfires. Cheap like storm/fx.ts: TWO dynamic quad
 * meshes (an alpha-blended one for snow, telegraphs and logs, an additive one for glows, flames and frost), one 128²
 * texture, rebuilt each frame from what is live (at most CAP quads each); nothing is created per snowball, splat or
 * fire, so nothing can leak, and `dispose` frees the five objects.
 *
 * Times are server ms (the same clock as the messages). Shapes are random where they are only decoration.
 */
import { Color3, Constants, Mesh, RawTexture, StandardMaterial, Texture, VertexBuffer, VertexData, type Camera, type Scene } from '@babylonjs/core'
import { snowballArc, type Vec3, type YetiSkill } from '@sro/shared'

type V3 = [number, number, number]
type RGB = readonly [number, number, number]

/** Quads per mesh. */
export const CAP = 1400
export const MAX_FLIGHTS = 48
export const MAX_SPLATS = 32
export const MAX_TELEGRAPHS = 6
export const SPLAT_MS = 650
/** A telegraph's landing flash lasts this long after `at` (ms). */
export const LAND_MS = 700
/** Fires drawn at most (the nearest), and the distance they show from (m). */
export const MAX_FIRES = 8
export const FIRE_VIEW_M = 140

const SNOW: RGB = [0.97, 0.98, 1]
const ICE: RGB = [0.55, 0.8, 1]
const SHADOW: RGB = [0.16, 0.2, 0.3]
/** A snowball: blue-white, a shade under the snow so it stands out. */
const BALL_TINT: RGB = [0.86, 0.91, 1]
const FROST: RGB = [0.75, 0.9, 1]
const FLAME: RGB = [1, 0.55, 0.18]
const FLAME_CORE: RGB = [1, 0.85, 0.45]
const LOG: RGB = [0.17, 0.1, 0.05]
const STONE: RGB = [0.16, 0.16, 0.18]

/** Texture regions (u0, v0) of the four 64² quadrants: a soft glow, a snowball, a ring, a solid disc. */
const GLOW = [0, 0] as const
const BALL = [0.5, 0] as const
const RING = [0, 0.5] as const
const DISC = [0.5, 0.5] as const

export interface Flight {
  id: number
  from: Vec3
  to: Vec3
  at: number
  ms: number
  peakM: number
  big: boolean
}

export interface Telegraph {
  id: number
  skill: YetiSkill
  pos: Vec3
  yaw: number
  radiusM: number
  angleDeg: number
  /** Server ms the wind-up started and lands. */
  start: number
  at: number
}

export interface FrostBody {
  id: number
  x: number
  y: number
  z: number
  /** Body radius and height (m). */
  r: number
  h: number
  big: boolean
}

interface Splat {
  pos: V3
  at: number
  big: boolean
  /** Flake directions (unit-ish) and speeds, fixed at the splat. */
  flakes: { d: V3; s: number }[]
}

function fxTexture(scene: Scene): RawTexture {
  const w = 128
  const q = 64
  const data = new Uint8Array(w * w * 4)
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const qx = x % q
      const qy = y % q
      const u = ((qx + 0.5) / q) * 2 - 1
      const v = ((qy + 0.5) / q) * 2 - 1
      const d = Math.min(1, Math.hypot(u, v))
      let a = 0
      let shade = 1
      if (x < q && y < q) a = (1 - d) ** 2
      else if (x >= q && y < q) {
        // a snowball: a solid round with a soft rim, lit from the top left
        a = Math.max(0, Math.min(1, (0.92 - d) * 12))
        // a darker rim and lit from the top left, so a snowball reads against white snow
        shade = (0.62 + 0.38 * Math.max(0, Math.min(1, 0.6 - 0.5 * (u + v)))) * (1 - 0.35 * Math.max(0, d - 0.6) / 0.4)
      } else if (x < q) a = Math.max(0, 1 - Math.abs(d - 0.82) * 7) ** 1.5
      else a = Math.max(0, Math.min(1, (0.97 - d) * 20))
      const i = (y * w + x) * 4
      const c = Math.round(255 * shade)
      data[i] = data[i + 1] = data[i + 2] = c
      data[i + 3] = Math.round(255 * a)
    }
  }
  const t = RawTexture.CreateRGBATexture(data, w, w, scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
  t.hasAlpha = true
  t.wrapU = Texture.CLAMP_ADDRESSMODE
  t.wrapV = Texture.CLAMP_ADDRESSMODE
  return t
}

/** One dynamic quad mesh with its material. */
class QuadBatch {
  readonly mesh: Mesh
  readonly mat: StandardMaterial
  private readonly pos = new Float32Array(CAP * 12)
  private readonly col = new Float32Array(CAP * 16)
  private readonly uv = new Float32Array(CAP * 8)
  used = 0
  private last = 0

  constructor(scene: Scene, name: string, tex: Texture, additive: boolean) {
    const m = new StandardMaterial(name, scene)
    m.disableLighting = true
    m.emissiveColor = Color3.White()
    m.diffuseColor = Color3.Black()
    m.specularColor = Color3.Black()
    m.backFaceCulling = false
    m.fogEnabled = !additive
    m.disableDepthWrite = true
    m.alphaMode = additive ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE
    m.diffuseTexture = tex
    m.useAlphaFromDiffuseTexture = true
    this.mat = m
    const idx = new Uint32Array(CAP * 6)
    for (let i = 0; i < CAP; i++) {
      const v = i * 4
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6)
    }
    this.mesh = new Mesh(name, scene)
    const vd = new VertexData()
    vd.positions = this.pos
    vd.colors = this.col
    vd.uvs = this.uv
    vd.indices = idx
    vd.applyToMesh(this.mesh, true)
    this.mesh.material = m
    this.mesh.hasVertexAlpha = true
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
    this.mesh.doNotSyncBoundingInfo = true
    this.mesh.metadata = { sroWinterPlay: true }
    this.mesh.setEnabled(false)
  }

  /** A quad with one colour and alpha per corner (premultiplied for the additive batch by the caller's alpha). */
  quad(a: V3, b: V3, c: V3, d: V3, region: readonly [number, number], rgb: RGB, alphas: readonly [number, number, number, number], premultiply: boolean, uvs?: readonly number[]): void {
    if (this.used >= CAP || alphas.every((x) => !(x > 0.002))) return
    const i = this.used++
    this.pos.set(a, i * 12)
    this.pos.set(b, i * 12 + 3)
    this.pos.set(c, i * 12 + 6)
    this.pos.set(d, i * 12 + 9)
    const [u0, v0] = region
    this.uv.set(uvs ?? [u0, v0, u0 + 0.5, v0, u0 + 0.5, v0 + 0.5, u0, v0 + 0.5], i * 8)
    for (let k = 0; k < 4; k++) {
      const al = Math.min(1, Math.max(0, alphas[k]!))
      const m = premultiply ? al : 1
      this.col.set([rgb[0] * m, rgb[1] * m, rgb[2] * m, al], i * 16 + k * 4)
    }
  }

  upload(): void {
    const n = this.used
    if (n === 0) {
      if (this.last > 0) this.pos.fill(0, 0, this.last * 12)
      this.last = 0
      if (this.mesh.isEnabled()) this.mesh.setEnabled(false)
      return
    }
    this.pos.fill(0, n * 12, Math.max(n, this.last) * 12)
    this.last = n
    this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.pos, false, false)
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, this.col, false, false)
    this.mesh.updateVerticesData(VertexBuffer.UVKind, this.uv, false, false)
    if (!this.mesh.isEnabled()) this.mesh.setEnabled(true)
  }

  dispose(): void {
    this.mesh.dispose(false, false)
    this.mat.dispose(false, false)
  }
}

export class WinterPlayFx {
  private readonly tex: RawTexture
  private readonly soft: QuadBatch
  private readonly glow: QuadBatch
  private readonly flights = new Map<number, Flight>()
  private readonly splats: Splat[] = []
  private readonly telegraphs: Telegraph[] = []
  private disposed = false
  private eye: V3 = [0, 0, 0]

  constructor(scene: Scene) {
    this.tex = fxTexture(scene)
    this.soft = new QuadBatch(scene, 'winterPlay:soft', this.tex, false)
    this.glow = new QuadBatch(scene, 'winterPlay:glow', this.tex, true)
  }

  /** Live counts (debug, tests). */
  stats(): { flights: number; splats: number; telegraphs: number; quads: number } {
    return { flights: this.flights.size, splats: this.splats.length, telegraphs: this.telegraphs.length, quads: this.soft.used + this.glow.used }
  }

  addFlight(f: Flight): void {
    this.flights.set(f.id, f)
    if (this.flights.size > MAX_FLIGHTS) this.flights.delete(this.flights.keys().next().value!)
  }

  /** A snowball landed (its flight ends now). */
  addSplat(id: number, pos: Vec3, at: number): void {
    const big = this.flights.get(id)?.big ?? false
    this.flights.delete(id)
    const flakes: Splat['flakes'] = []
    const n = big ? 16 : 10
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const up = 0.3 + Math.random() * 0.9
      flakes.push({ d: [Math.cos(a), up, Math.sin(a)], s: (big ? 3.2 : 2.2) * (0.5 + Math.random() * 0.7) })
    }
    this.splats.push({ pos: [...pos], at, big, flakes })
    while (this.splats.length > MAX_SPLATS) this.splats.shift()
  }

  addTelegraph(t: Telegraph): void {
    for (let i = this.telegraphs.length - 1; i >= 0; i--) if (this.telegraphs[i]!.id === t.id) this.telegraphs.splice(i, 1)
    this.telegraphs.push(t)
    while (this.telegraphs.length > MAX_TELEGRAPHS) this.telegraphs.shift()
  }

  clear(): void {
    this.flights.clear()
    this.splats.length = 0
    this.telegraphs.length = 0
    this.soft.used = 0
    this.glow.used = 0
    this.soft.upload()
    this.glow.upload()
  }

  /**
   * Draws this frame at server ms `now`: the flights, splats and telegraphs alive, the frost around `bodies` and the
   * `fires` (already the nearest; at most MAX_FIRES are drawn). `ground(x, z, y)` is the height to put things on.
   */
  update(now: number, camera: Camera | null, bodies: readonly FrostBody[], fires: readonly Vec3[], ground: (x: number, z: number, y: number) => number): void {
    if (this.disposed) return
    this.soft.used = 0
    this.glow.used = 0
    const cam = camera?.globalPosition
    if (cam) {
      this.eye = [cam.x, cam.y, cam.z]
      for (const [id, f] of this.flights) {
        if (now > f.at + f.ms + 400) this.flights.delete(id)
        else if (now >= f.at) this.flight(f, now, ground)
      }
      for (let i = this.splats.length - 1; i >= 0; i--) {
        const s = this.splats[i]!
        if (now - s.at > SPLAT_MS) this.splats.splice(i, 1)
        else if (now >= s.at) this.splat(s, now)
      }
      for (let i = this.telegraphs.length - 1; i >= 0; i--) {
        const t = this.telegraphs[i]!
        if (now > t.at + LAND_MS) this.telegraphs.splice(i, 1)
        else this.telegraph(t, now, ground)
      }
      for (const b of bodies) this.frost(b, now)
      for (const f of fires.slice(0, MAX_FIRES)) this.fire(f, now, ground)
    }
    this.soft.upload()
    this.glow.upload()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.flights.clear()
    this.splats.length = 0
    this.telegraphs.length = 0
    this.soft.dispose()
    this.glow.dispose()
    this.tex.dispose()
  }

  // ---- shapes -----------------------------------------------------------------------------------------------------

  private flight(f: Flight, now: number, ground: (x: number, z: number, y: number) => number): void {
    const k = Math.min(1, (now - f.at) / f.ms)
    const p = snowballArc(f.from, f.to, f.peakM, k)
    const size = f.big ? 0.75 : 0.36
    // a short powder trail, then the ball
    for (let j = 1; j <= 3; j++) {
      const q = snowballArc(f.from, f.to, f.peakM, Math.max(0, k - j * 0.035))
      this.sprite(this.soft, q, size * (1 - j * 0.18), SNOW, 0.45 - j * 0.12, GLOW)
    }
    this.sprite(this.soft, p, size, BALL_TINT, 1, BALL)
    if (f.big) this.sprite(this.glow, p, size * 2.2, ICE, 0.25, GLOW)
    // its shadow on the snow: where it is, at a glance
    const gy = ground(p[0], p[2], Math.min(f.from[1], f.to[1]) - 1)
    this.groundDisc([p[0], gy + 0.06, p[2]], size * 0.9, SHADOW, 0.45)
  }

  private splat(s: Splat, now: number): void {
    const t = (now - s.at) / 1000
    const life = 1 - (now - s.at) / SPLAT_MS
    const g = 9.8
    for (const fl of s.flakes) {
      const x = s.pos[0] + fl.d[0] * fl.s * t
      const y = s.pos[1] + fl.d[1] * fl.s * t - 0.5 * g * t * t * 0.6
      const z = s.pos[2] + fl.d[2] * fl.s * t
      this.sprite(this.soft, [x, y, z], s.big ? 0.22 : 0.15, BALL_TINT, life, BALL)
    }
    const puff = (s.big ? 1.6 : 0.9) * (0.4 + 0.6 * (1 - life))
    this.sprite(this.soft, s.pos, puff, SNOW, 0.65 * life, GLOW)
  }

  private telegraph(t: Telegraph, now: number, ground: (x: number, z: number, y: number) => number): void {
    const y = ground(t.pos[0], t.pos[2], t.pos[1]) + 0.08
    const c: V3 = [t.pos[0], y, t.pos[2]]
    if (now < t.at) {
      // the wind-up: the reach fills from the centre, the edge pulses
      const k = Math.max(0, Math.min(1, (now - t.start) / Math.max(1, t.at - t.start)))
      const pulse = 0.65 + 0.35 * Math.sin(now / 70)
      if (t.skill === 'breath') {
        this.fan(c, t.yaw, t.radiusM, t.angleDeg, ICE, 0.16 + 0.1 * k, 0.4 * pulse)
        this.fan(c, t.yaw, t.radiusM * k, t.angleDeg, ICE, 0.22, 0.05)
      } else {
        this.groundRing(c, t.radiusM, 0.18, ICE, 0.75 * pulse)
        this.groundDisc(c, t.radiusM * k, ICE, 0.22)
        if (t.skill === 'roar' || t.skill === 'barrage') this.groundRing(c, t.radiusM * (1 - k), 0.12, FROST, 0.35)
      }
      return
    }
    // the landing: a burst that fades
    const k = (now - t.at) / LAND_MS
    const fade = 1 - k
    if (t.skill === 'slam') {
      this.groundRing(c, t.radiusM * (0.3 + 0.9 * k), 0.6, SNOW, 0.8 * fade)
      this.groundDisc(c, t.radiusM, FROST, 0.25 * fade)
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + t.id
        const r = t.radiusM * (0.2 + 0.8 * k)
        this.sprite(this.soft, [c[0] + Math.cos(a) * r, c[1] + 0.4 + Math.sin(k * Math.PI) * 1.2, c[2] + Math.sin(a) * r], 0.9, SNOW, 0.6 * fade, GLOW)
      }
    } else if (t.skill === 'breath') {
      for (let i = 0; i < 24; i++) {
        const a = t.yaw + ((i % 8) / 7 - 0.5) * ((t.angleDeg * Math.PI) / 180)
        const r = t.radiusM * Math.min(1, k * 1.4 + (i / 24) * 0.3)
        this.sprite(this.glow, [c[0] + Math.sin(a) * r, c[1] + 1 + (i % 3) * 0.3, c[2] + Math.cos(a) * r], 1.1, ICE, 0.5 * fade, GLOW)
      }
      this.fan(c, t.yaw, t.radiusM, t.angleDeg, FROST, 0.3 * fade, 0.1 * fade)
    } else if (t.skill === 'roar') {
      this.groundRing(c, t.radiusM * k, 0.5, FROST, 0.7 * fade)
      this.groundRing(c, t.radiusM * k * 0.7, 0.3, SNOW, 0.5 * fade)
    }
  }

  private frost(b: FrostBody, now: number): void {
    const n = b.big ? 7 : 3
    for (let i = 0; i < n; i++) {
      const a = now / (b.big ? 1400 : 900) + (i / n) * Math.PI * 2 + b.id
      const r = b.r * (b.big ? 1.1 : 1.3)
      const y = b.y + b.h * (0.25 + 0.6 * ((Math.sin(now / 600 + i * 1.7 + b.id) + 1) / 2))
      const tw = 0.5 + 0.5 * Math.sin(now / 90 + i * 2.3 + b.id)
      this.sprite(this.glow, [b.x + Math.cos(a) * r, y, b.z + Math.sin(a) * r], b.big ? 0.5 : 0.28, FROST, 0.55 * tw, GLOW)
    }
    // a cold mist at the feet
    this.sprite(this.glow, [b.x, b.y + b.h * 0.15, b.z], b.r * (b.big ? 4 : 3), ICE, b.big ? 0.12 : 0.08, GLOW)
  }

  private fire(f: Vec3, now: number, ground: (x: number, z: number, y: number) => number): void {
    const [x, , z] = f
    const y = ground(x, z, f[1])
    const seed = x * 0.37 + z * 0.11
    // a ring of dark stones and two crossed logs, set a little into the snow
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + seed
      this.sprite(this.soft, [x + Math.cos(a) * 0.62, y + 0.1, z + Math.sin(a) * 0.62], 0.24, STONE, 1, BALL)
    }
    this.groundQuadRot([x, y + 0.16, z], 1.1, 0.2, seed, LOG, 1)
    this.groundQuadRot([x, y + 0.2, z], 1.1, 0.2, seed + Math.PI / 2, LOG, 1)
    // flames, alpha-blended so they read on white snow: orange tongues, a yellow core
    for (let i = 0; i < 6; i++) {
      const fl = 0.75 + 0.25 * Math.sin(now / (70 + i * 13) + i * 1.9 + seed)
      const h = 0.25 + 0.16 * i * fl
      const off = 0.1 * Math.sin(now / 160 + i + seed)
      this.sprite(this.soft, [x + off, y + h, z + 0.07 * Math.cos(now / 190 + i)], (0.85 - i * 0.1) * fl, FLAME, 0.95 - i * 0.08, GLOW)
    }
    for (let i = 0; i < 3; i++) {
      const fl = 0.8 + 0.2 * Math.sin(now / (55 + i * 17) + i + seed)
      this.sprite(this.soft, [x, y + 0.28 + i * 0.16, z], (0.5 - i * 0.1) * fl, FLAME_CORE, 0.95, GLOW)
    }
    // a warm halo (it shows in the dark more than on snow)
    this.sprite(this.glow, [x, y + 0.6, z], 2.4 + 0.2 * Math.sin(now / 120 + seed), FLAME, 0.18, GLOW)
    // embers rising
    for (let i = 0; i < 4; i++) {
      const t = ((now / 1000 + i * 0.37 + seed) % 1.4) / 1.4
      this.sprite(this.glow, [x + 0.25 * Math.sin(i * 2.1 + t * 3), y + 0.4 + t * 2.2, z + 0.25 * Math.cos(i * 1.3 + t * 3)], 0.09, FLAME_CORE, 0.8 * (1 - t), GLOW)
    }
  }

  // ---- primitives -------------------------------------------------------------------------------------------------

  /** A camera-facing square of side `size` at `c`. */
  private sprite(batch: QuadBatch, c: V3 | Vec3, size: number, rgb: RGB, alpha: number, region: readonly [number, number]): void {
    const eye = this.eye
    const f = norm([eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]])
    let r = cross([0, 1, 0], f)
    if (Math.hypot(r[0], r[1], r[2]) < 1e-4) r = [1, 0, 0]
    r = norm(r)
    const u = cross(f, r)
    const h = size / 2
    const corner = (sr: number, su: number): V3 => [c[0] + (r[0] * sr + u[0] * su) * h, c[1] + (r[1] * sr + u[1] * su) * h, c[2] + (r[2] * sr + u[2] * su) * h]
    batch.quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), region, rgb, [alpha, alpha, alpha, alpha], batch === this.glow)
  }

  /** A flat disc on the ground (a soft-edged round texture). */
  private groundDisc(c: V3, r: number, rgb: RGB, alpha: number): void {
    if (r <= 0.05) return
    this.soft.quad([c[0] - r, c[1], c[2] - r], [c[0] + r, c[1], c[2] - r], [c[0] + r, c[1], c[2] + r], [c[0] - r, c[1], c[2] + r], DISC, rgb, [alpha, alpha, alpha, alpha], false)
  }

  /** A flat ring on the ground, `w` wide (segments with a solid texel; alpha fades to the outside). */
  private groundRing(c: V3, r: number, w: number, rgb: RGB, alpha: number): void {
    if (r <= 0.05) return
    const n = Math.max(16, Math.min(48, Math.round(r * 5)))
    const solid = [0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75]
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2
      const a1 = ((i + 1) / n) * Math.PI * 2
      const ri = Math.max(0, r - w / 2)
      const ro = r + w / 2
      this.soft.quad(
        [c[0] + Math.cos(a0) * ri, c[1], c[2] + Math.sin(a0) * ri],
        [c[0] + Math.cos(a1) * ri, c[1], c[2] + Math.sin(a1) * ri],
        [c[0] + Math.cos(a1) * ro, c[1], c[2] + Math.sin(a1) * ro],
        [c[0] + Math.cos(a0) * ro, c[1], c[2] + Math.sin(a0) * ro],
        DISC,
        rgb,
        [alpha, alpha, alpha * 0.2, alpha * 0.2],
        false,
        solid,
      )
    }
  }

  /** A flat fan (the breath's cone) facing `yaw`: `fill` alpha inside, `edge` at the rim. */
  private fan(c: V3, yaw: number, r: number, angleDeg: number, rgb: RGB, fill: number, edge: number): void {
    if (r <= 0.05) return
    const n = 12
    const half = (angleDeg * Math.PI) / 360
    const solid = [0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75]
    for (let i = 0; i < n; i++) {
      const a0 = yaw - half + (i / n) * 2 * half
      const a1 = yaw - half + ((i + 1) / n) * 2 * half
      this.soft.quad(
        [c[0], c[1], c[2]],
        [c[0], c[1], c[2]],
        [c[0] + Math.sin(a1) * r, c[1], c[2] + Math.cos(a1) * r],
        [c[0] + Math.sin(a0) * r, c[1], c[2] + Math.cos(a0) * r],
        DISC,
        rgb,
        [fill * 0.4, fill * 0.4, fill + edge, fill + edge],
        false,
        solid,
      )
    }
  }

  /** A flat stick on the ground: `len` long, `w` wide, turned `a` (a campfire log). */
  private groundQuadRot(c: V3, len: number, w: number, a: number, rgb: RGB, alpha: number): void {
    const dx = (Math.cos(a) * len) / 2
    const dz = (Math.sin(a) * len) / 2
    const nx = (-Math.sin(a) * w) / 2
    const nz = (Math.cos(a) * w) / 2
    const solid = [0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75]
    this.soft.quad([c[0] - dx - nx, c[1], c[2] - dz - nz], [c[0] + dx - nx, c[1], c[2] + dz - nz], [c[0] + dx + nx, c[1], c[2] + dz + nz], [c[0] - dx + nx, c[1], c[2] - dz + nz], DISC, rgb, [alpha, alpha, alpha, alpha], false, solid)
  }
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** Kept for the ring's region (the ring texture is an alternative look; the solid ring reads better on snow). */
export const REGIONS = { GLOW, BALL, RING, DISC } as const

/**
 * The lightning tornado's funnel on the client (docs/WEATHER.md §13.7). Cheap and leak-proof on purpose, like StormFx:
 * THREE meshes, three materials and three textures, made once per graphics tier and rebuilt in place every frame;
 * nothing is created per bolt, per arc or per piece of debris, and `dispose` frees all nine objects (the feature makes
 * one TornadoFx when a tornado appears and disposes it when it is gone).
 *
 * - **Funnel** (alpha blended): 1-3 nested lathe shells around a snaking axis. Per frame on the CPU: the radius profile
 *   (a narrow rope at the ground flaring into the wall cloud), travelling ripples, the axis' slow bend and its lean
 *   behind the heading, the shells turning at different speeds (their UVs), and a streaky noise texture scrolling up.
 *   During the warning it lowers out of the cloud (presence 0 → 1); after the lift it rises away.
 * - **Debris and dust** (alpha blended, one atlas: a dust puff, a leaf, a twig, grit): leaves, twigs and grit spiral up
 *   around the funnel, tumbling; big dust puffs circle its foot (the ground dust ring).
 * - **Arcs** (additive): jagged electric arcs flicker inside the funnel; a bolt the tornado throws (`strike.source`)
 *   gets an arc from the funnel's side to where it lands.
 * - **Tiers**: low = one shell, a little debris, one arc; medium = two shells, the full debris; high = three shells and
 *   twice the debris. Brightness follows the sky (night) and the lightning flash.
 */
import { Color3, Constants, Mesh, RawTexture, StandardMaterial, Texture, VertexBuffer, VertexData, type Camera, type Scene } from '@babylonjs/core'
import { TORNADO_TABLE, mulberry32 } from '@sro/shared'

type V3 = [number, number, number]

export type TornadoTier = 'low' | 'medium' | 'high'

export interface TierSpec {
  shells: number
  seg: number
  rings: number
  dust: number
  debris: number
  arcs: number
}

export const TORNADO_TIERS: Readonly<Record<TornadoTier, Readonly<TierSpec>>> = {
  low: { shells: 1, seg: 20, rings: 10, dust: 10, debris: 24, arcs: 1 },
  medium: { shells: 2, seg: 32, rings: 18, dust: 22, debris: 110, arcs: 3 },
  high: { shells: 3, seg: 40, rings: 24, dust: 34, debris: 220, arcs: 4 },
}

/** Strike arcs drawn at once (the newest), and how long one shows (ms). */
export const MAX_STRIKE_ARCS = 4
export const STRIKE_ARC_MS = 380
const ARC_SEGMENTS = 9
/** Inner arcs re-shape this often (ms). */
const ARC_SHAPE_MS = 110

/** What the funnel needs each frame. */
export interface TornadoFrame {
  /** The funnel's foot on the ground (glTF metres). */
  pos: V3
  /** 0..1: how much of it there is (lowering, full, lifting). */
  presence: number
  /** The way it walks (atan2(dx, dz)). */
  heading: number
  strength: number
  /** Sky light 0..1 (1 by day) and the lightning flash (0..3). */
  light: number
  flash: number
}

interface Debris {
  cell: number
  /** Orbit radius over the funnel's radius at its height, and an extra (m). */
  rk: number
  rAdd: number
  hMax: number
  period: number
  off: number
  theta: number
  omega: number
  size: number
  spin: number
}

interface Dust {
  theta: number
  omega: number
  r: number
  h: number
  size: number
  spin: number
}

interface StrikeArc {
  to: V3
  at: number
  seed: number
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Tileable value noise on a `w`-periodic lattice. */
function valueNoise(rng: () => number, w: number): (x: number, y: number) => number {
  const g = new Float32Array(w * w)
  for (let i = 0; i < g.length; i++) g[i] = rng()
  const at = (x: number, y: number) => g[(((y % w) + w) % w) * w + (((x % w) + w) % w)]!
  return (x, y) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const fx = x - xi
    const fy = y - yi
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * sx
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * sx
    return a + (b - a) * sy
  }
}

/** The funnel's streaks: noise stretched along the turn (u), tileable both ways; grey in RGB, patchy in alpha. */
function streakTexture(scene: Scene, seed: number): RawTexture {
  const w = 128
  const h = 128
  const data = new Uint8Array(w * h * 4)
  const n1 = valueNoise(mulberry32(seed), 8)
  const n2 = valueNoise(mulberry32(seed ^ 0x9e37), 16)
  const n3 = valueNoise(mulberry32(seed ^ 0x51ed), 32)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // stretched: few cells along u, many along v (the streaks run around the funnel)
      const u = x / w
      const v = y / h
      const f = 0.55 * n1(u * 4, v * 8) + 0.3 * n2(u * 8, v * 16) + 0.15 * n3(u * 16, v * 32)
      const lum = 0.4 + 0.6 * f
      const a = smooth(0.12, 0.7, f) * 0.75 + 0.25
      const i = (y * w + x) * 4
      data[i] = data[i + 1] = data[i + 2] = Math.round(255 * lum)
      data[i + 3] = Math.round(255 * a)
    }
  }
  const t = RawTexture.CreateRGBATexture(data, w, h, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
  t.hasAlpha = true
  t.wrapU = Texture.WRAP_ADDRESSMODE
  t.wrapV = Texture.WRAP_ADDRESSMODE
  return t
}

/** The debris atlas: four 32² cells in a row: a dust puff, a leaf, a twig, grit. */
function debrisTexture(scene: Scene): RawTexture {
  const c = 32
  const w = c * 4
  const data = new Uint8Array(w * c * 4)
  const put = (x: number, y: number, rgb: readonly number[], a: number) => {
    const i = (y * w + x) * 4
    data[i] = rgb[0]!
    data[i + 1] = rgb[1]!
    data[i + 2] = rgb[2]!
    data[i + 3] = Math.round(255 * Math.max(0, Math.min(1, a)))
  }
  const rng = mulberry32(7)
  const puffNoise = valueNoise(rng, 8)
  for (let y = 0; y < c; y++) {
    for (let x = 0; x < c; x++) {
      const u = ((x + 0.5) / c) * 2 - 1
      const v = ((y + 0.5) / c) * 2 - 1
      const d = Math.hypot(u, v)
      // dust puff: soft, lumpy
      put(x, y, [140, 124, 100], (1 - d) ** 1.6 * (0.6 + 0.4 * puffNoise(x / 4, y / 4)))
      // leaf: an ellipse with a midrib
      const le = Math.hypot(u / 0.9, v / 0.45)
      const rib = Math.abs(v) < 0.06 && Math.abs(u) < 0.85 ? 0.75 : 1
      put(x + c, y, [Math.round(110 * rib), Math.round(118 * rib), Math.round(52 * rib)], le < 1 ? 1 - smooth(0.85, 1, le) : 0)
      // twig: a thin dark stroke along the diagonal with a side shoot
      const t1 = Math.abs(u - v) / Math.SQRT2
      const t2 = Math.abs(u + v * 0.3 - 0.35) < 0.05 && u > 0.1 && u < 0.6 ? 1 : 0
      put(x + 2 * c, y, [78, 60, 42], Math.max(d < 0.95 ? 1 - smooth(0.04, 0.09, t1) : 0, t2))
      // grit: a small hard blob
      put(x + 3 * c, y, [120, 104, 84], 1 - smooth(0.35, 0.6, d))
    }
  }
  const t = RawTexture.CreateRGBATexture(data, w, c, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
  t.hasAlpha = true
  t.wrapU = Texture.CLAMP_ADDRESSMODE
  t.wrapV = Texture.CLAMP_ADDRESSMODE
  return t
}

/** The arcs' glow: left half a round glow, right half a line's cross-section (as StormFx). */
function glowTexture(scene: Scene): RawTexture {
  const w = 64
  const data = new Uint8Array(w * w * 4)
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const v = ((y + 0.5) / w) * 2 - 1
      let a: number
      if (x < w / 2) a = (1 - Math.min(1, Math.hypot(((x + 0.5) / (w / 2)) * 2 - 1, v))) ** 2
      else a = Math.max(0, 1 - Math.abs(v)) ** 1.5
      const i = (y * w + x) * 4
      data[i] = data[i + 1] = data[i + 2] = 255
      data[i + 3] = Math.round(255 * a)
    }
  }
  const t = RawTexture.CreateRGBATexture(data, w, w, scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
  t.hasAlpha = true
  t.wrapU = Texture.CLAMP_ADDRESSMODE
  t.wrapV = Texture.CLAMP_ADDRESSMODE
  return t
}

function material(name: string, scene: Scene, tex: RawTexture, additive: boolean): StandardMaterial {
  const m = new StandardMaterial(name, scene)
  m.disableLighting = true
  m.emissiveColor = Color3.White()
  m.diffuseColor = Color3.Black()
  m.specularColor = Color3.Black()
  m.backFaceCulling = false
  m.fogEnabled = false
  m.disableDepthWrite = true
  m.alphaMode = additive ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE
  m.diffuseTexture = tex
  m.useAlphaFromDiffuseTexture = true
  return m
}

/** A mesh of `quads` free quads (4 vertices each) with updatable positions, colours and UVs. */
function quadMesh(name: string, scene: Scene, quads: number, mat: StandardMaterial): { mesh: Mesh; pos: Float32Array; col: Float32Array; uv: Float32Array } {
  const pos = new Float32Array(quads * 12)
  const col = new Float32Array(quads * 16)
  const uv = new Float32Array(quads * 8)
  const idx = new Uint32Array(quads * 6)
  for (let i = 0; i < quads; i++) {
    const v = i * 4
    idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6)
  }
  const mesh = new Mesh(name, scene)
  const vd = new VertexData()
  vd.positions = pos
  vd.colors = col
  vd.uvs = uv
  vd.indices = idx
  vd.applyToMesh(mesh, true)
  prepare(mesh, mat)
  return { mesh, pos, col, uv }
}

function prepare(mesh: Mesh, mat: StandardMaterial): void {
  mesh.material = mat
  mesh.hasVertexAlpha = true
  mesh.isPickable = false
  mesh.alwaysSelectAsActiveMesh = true
  mesh.doNotSyncBoundingInfo = true
  mesh.metadata = { sroTornado: true }
  // always enabled (the world's EnabledMeshCandidates list then always holds it); shown and hidden with isVisible
  mesh.isVisible = false
}

export class TornadoFx {
  readonly tier: TornadoTier
  private readonly spec: TierSpec
  private readonly t = TORNADO_TABLE
  // funnel
  private readonly funnel: Mesh
  private readonly funnelMat: StandardMaterial
  private readonly streaks: RawTexture
  private readonly fPos: Float32Array
  private readonly fUv: Float32Array
  /** The funnel's vertex colours, and each vertex's own alpha before the silhouette term. */
  private readonly fCol: Float32Array
  private readonly fAlpha: Float32Array
  // debris and dust
  private readonly debrisMesh: Mesh
  private readonly debrisMat: StandardMaterial
  private readonly atlas: RawTexture
  private readonly dPos: Float32Array
  private readonly dCol: Float32Array
  private readonly dUv: Float32Array
  private readonly debris: Debris[] = []
  private readonly dust: Dust[] = []
  private dUsed = 0
  private dLast = 0
  // arcs
  private readonly arcMesh: Mesh
  private readonly arcMat: StandardMaterial
  private readonly glow: RawTexture
  private readonly aPos: Float32Array
  private readonly aCol: Float32Array
  private readonly aUv: Float32Array
  private readonly aCap: number
  private aUsed = 0
  private aLast = 0
  private readonly strikeArcs: StrikeArc[] = []
  private inner: { until: number; lines: { h0: number; a0: number; h1: number; a1: number; jag: number[] }[] } = { until: 0, lines: [] }
  private readonly phase: number
  private disposed = false
  /** The last frame's funnel (for strike arcs and the feature's queries). */
  private last: TornadoFrame | null = null
  private lastS = 0

  constructor(
    private readonly scene: Scene,
    seed: number,
    tier: TornadoTier,
  ) {
    this.tier = tier
    const spec = (this.spec = TORNADO_TIERS[tier])
    const rng = mulberry32(seed ^ 0x7042)
    this.phase = rng() * 100
    // ---- funnel
    this.streaks = streakTexture(scene, seed)
    this.funnelMat = material('tornado:funnel', scene, this.streaks, false)
    const ring = spec.seg + 1
    const verts = spec.shells * ring * spec.rings
    this.fPos = new Float32Array(verts * 3)
    this.fUv = new Float32Array(verts * 2)
    const col = (this.fCol = new Float32Array(verts * 4))
    this.fAlpha = new Float32Array(verts)
    const idx: number[] = []
    for (let s = 0; s < spec.shells; s++) {
      const outer = spec.shells > 1 ? s / (spec.shells - 1) : 0
      for (let j = 0; j < spec.rings; j++) {
        const h = j / (spec.rings - 1)
        const a = smooth(0, 0.06, h) * (1 - smooth(0.84, 1, h)) * (0.72 + 0.25 * h) * (1 - 0.3 * outer)
        const dustK = 1 - smooth(0, 0.4, h)
        const r = 0.25 + (0.44 - 0.25) * dustK
        const g = 0.26 + (0.38 - 0.26) * dustK
        const b = 0.29 + (0.3 - 0.29) * dustK
        for (let i = 0; i < ring; i++) {
          const k = (s * spec.rings + j) * ring + i
          col.set([r, g, b, a], k * 4)
          this.fAlpha[k] = a
        }
      }
      for (let j = 0; j + 1 < spec.rings; j++) {
        for (let i = 0; i < spec.seg; i++) {
          const v = (s * spec.rings + j) * ring + i
          idx.push(v, v + ring, v + 1, v + 1, v + ring, v + ring + 1)
        }
      }
    }
    this.funnel = new Mesh('tornado:funnel', scene)
    const vd = new VertexData()
    vd.positions = this.fPos
    vd.uvs = this.fUv
    vd.colors = col
    vd.indices = idx
    vd.applyToMesh(this.funnel, true)
    prepare(this.funnel, this.funnelMat)
    // ---- debris and dust
    this.atlas = debrisTexture(scene)
    this.debrisMat = material('tornado:debris', scene, this.atlas, false)
    const d = quadMesh('tornado:debris', scene, spec.debris + spec.dust, this.debrisMat)
    this.debrisMesh = d.mesh
    this.dPos = d.pos
    this.dCol = d.col
    this.dUv = d.uv
    for (let i = 0; i < spec.debris; i++) {
      const k = rng()
      const cell = k < 0.6 ? 1 : k < 0.85 ? 3 : 2
      this.debris.push({
        cell,
        rk: 0.9 + rng() * 0.9,
        rAdd: 0.8 + rng() * 2.5,
        hMax: 10 + rng() * 38,
        period: 5 + rng() * 9,
        off: rng(),
        theta: rng() * Math.PI * 2,
        omega: 1.3 + rng() * 1.4,
        size: cell === 2 ? 0.8 + rng() * 0.7 : cell === 1 ? 0.3 + rng() * 0.3 : 0.15 + rng() * 0.2,
        spin: (rng() - 0.5) * 12,
      })
    }
    for (let i = 0; i < spec.dust; i++) {
      this.dust.push({ theta: rng() * Math.PI * 2, omega: 0.5 + rng() * 0.6, r: 4 + rng() * 11, h: 0.4 + rng() * 2.5, size: 4 + rng() * 6, spin: (rng() - 0.5) * 0.8 })
    }
    // ---- arcs
    this.glow = glowTexture(scene)
    this.arcMat = material('tornado:arcs', scene, this.glow, true)
    this.aCap = (spec.arcs + MAX_STRIKE_ARCS) * (ARC_SEGMENTS + 2)
    const a = quadMesh('tornado:arcs', scene, this.aCap, this.arcMat)
    this.arcMesh = a.mesh
    this.aPos = a.pos
    this.aCol = a.col
    this.aUv = a.uv
  }

  /** Live counts (debug, tests). */
  stats(): { tier: TornadoTier; funnelVerts: number; quads: number; arcs: number; strikeArcs: number } {
    return { tier: this.tier, funnelVerts: this.fPos.length / 3, quads: this.dLast, arcs: this.aLast, strikeArcs: this.strikeArcs.length }
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** A bolt the tornado threw lands at `to` at `at` (server ms): an arc from the funnel's side to it. */
  strikeArc(to: V3, at: number): void {
    this.strikeArcs.push({ to, at, seed: Math.random() })
    while (this.strikeArcs.length > MAX_STRIKE_ARCS) this.strikeArcs.shift()
  }

  /** The funnel's height and its radius at height share `h` (0 ground .. 1 cloud), for strength `k`. */
  private shape(h: number, strength: number, shell: number): { height: number; r: number } {
    const size = Math.min(1.25, 0.8 + 0.2 * strength)
    const height = this.t.heightM * size
    const rb = 3.2 + shell * 1
    const rt = this.t.topM * size * (1 + 0.12 * shell)
    let r = rb + (rt - rb) * h ** 1.8
    if (h > 0.85) r *= 1 + ((h - 0.85) / 0.15) ** 2 * 0.9
    return { height, r }
  }

  /** The axis' offset at height share `h` (its slow bend, and the lean behind the heading). */
  private axis(h: number, s: number, heading: number): [number, number] {
    const k = h ** 1.3
    const bx = (Math.sin(s * 0.37 + this.phase) * 5 + Math.sin(s * 0.9 + h * 4) * 1.5) * k
    const bz = (Math.cos(s * 0.29 + this.phase * 1.3) * 5 + Math.cos(s * 0.8 + h * 3.5) * 1.5) * k
    return [bx - Math.sin(heading) * 7 * h, bz - Math.cos(heading) * 7 * h]
  }

  /** A point on the inner shell at height share `h`, angle `a`, radius × `rk` (the frame's funnel). */
  private point(f: TornadoFrame, s: number, h: number, a: number, rk: number): V3 {
    const { height, r } = this.shape(h, f.strength, 0)
    const [ox, oz] = this.axis(h, s, f.heading)
    const y = height - (height - h * height) * f.presence
    return [f.pos[0] + ox + Math.cos(a) * r * rk, f.pos[1] + y, f.pos[2] + oz + Math.sin(a) * r * rk]
  }

  /** Draws this frame (`now` server ms). Nothing when presence is 0. */
  update(now: number, f: TornadoFrame, camera: Camera | null): void {
    if (this.disposed) return
    const s = now / 1000
    this.last = f
    this.lastS = s
    const show = f.presence > 0.001 && !!camera
    const bright = Math.min(1.6, Math.max(0.12, f.light) + 0.35 * f.flash)
    this.funnelMat.emissiveColor.set(bright, bright, bright)
    this.debrisMat.emissiveColor.set(bright, bright, bright)
    this.funnelMat.alpha = Math.min(1, f.presence * 1.4)
    if (!show) {
      for (const m of [this.funnel, this.debrisMesh, this.arcMesh]) m.isVisible = false
      return
    }
    this.updateFunnel(f, s, camera!.globalPosition)
    const cam = camera!.globalPosition
    const eye: V3 = [cam.x, cam.y, cam.z]
    this.updateDebris(f, s, eye)
    this.updateArcs(f, s, now, eye)
    this.funnel.isVisible = true
  }

  private updateFunnel(f: TornadoFrame, s: number, eye: { x: number; z: number }): void {
    const spec = this.spec
    const ring = spec.seg + 1
    // the silhouette term: a shell is denser where the eye looks along it (its edges), thinner face-on, so the funnel
    // reads as a volume rather than a flat sheet
    let ex = eye.x - f.pos[0]
    let ez = eye.z - f.pos[2]
    const el = Math.hypot(ex, ez) || 1
    ex /= el
    ez /= el
    for (let sh = 0; sh < spec.shells; sh++) {
      // inner shells turn faster
      const turn = s * (1.6 - 0.35 * sh)
      for (let j = 0; j < spec.rings; j++) {
        const h = j / (spec.rings - 1)
        const { height, r } = this.shape(h, f.strength, sh)
        const [ox, oz] = this.axis(h, s, f.heading)
        const y = f.pos[1] + height - (height - h * height) * f.presence
        // a thin rope while it lowers
        const rr = r * (0.35 + 0.65 * f.presence)
        for (let i = 0; i < ring; i++) {
          const a = (i / spec.seg) * Math.PI * 2
          const ripple = 1 + 0.1 * Math.sin(3 * a + turn * 2 - h * 9 + sh * 1.7) + 0.05 * Math.sin(5 * a - s * 4.3 + h * 13)
          const k = (sh * spec.rings + j) * ring + i
          this.fPos[k * 3] = f.pos[0] + ox + Math.cos(a) * rr * ripple
          this.fPos[k * 3 + 1] = y
          this.fPos[k * 3 + 2] = f.pos[2] + oz + Math.sin(a) * rr * ripple
          this.fUv[k * 2] = (i / spec.seg) * 2 + turn / (Math.PI * 2) + sh * 0.31
          this.fUv[k * 2 + 1] = h * 2.5 - s * (0.12 + 0.05 * sh)
          const c = Math.cos(a) * ex + Math.sin(a) * ez
          this.fCol[k * 4 + 3] = this.fAlpha[k]! * (0.4 + 0.6 * (1 - c * c))
        }
      }
    }
    this.funnel.updateVerticesData(VertexBuffer.PositionKind, this.fPos, false, false)
    this.funnel.updateVerticesData(VertexBuffer.UVKind, this.fUv, false, false)
    this.funnel.updateVerticesData(VertexBuffer.ColorKind, this.fCol, false, false)
  }

  private updateDebris(f: TornadoFrame, s: number, eye: V3): void {
    this.dUsed = 0
    const pres = f.presence
    for (const d of this.debris) {
      const ph = (s / d.period + d.off) % 1
      const fade = smooth(0, 0.1, ph) * (1 - smooth(0.82, 1, ph)) * pres
      if (fade <= 0.01) continue
      const hM = ph * d.hMax
      const { height, r } = this.shape(Math.min(1, hM / (this.t.heightM * 0.9)), f.strength, 0)
      const hShare = hM / height
      const [ox, oz] = this.axis(hShare, s, f.heading)
      const th = d.theta + s * d.omega * (1.6 - 0.5 * hShare) + ph * 4
      const rr = r * d.rk * (0.35 + 0.65 * pres) + d.rAdd
      const c: V3 = [f.pos[0] + ox + Math.cos(th) * rr, f.pos[1] + hM, f.pos[2] + oz + Math.sin(th) * rr]
      this.sprite(c, d.size, d.spin * s, d.cell, eye, [1, 1, 1], fade)
    }
    for (const d of this.dust) {
      const th = d.theta + s * d.omega
      const r = d.r * (0.5 + 0.5 * pres)
      const c: V3 = [f.pos[0] + Math.cos(th) * r, f.pos[1] + d.h + 0.4 * Math.sin(s * 1.3 + d.theta), f.pos[2] + Math.sin(th) * r]
      this.sprite(c, d.size * (0.6 + 0.4 * pres), d.spin * s, 0, eye, [1, 1, 1], 0.32 * pres)
    }
    this.upload(this.debrisMesh, this.dPos, this.dCol, this.dUv, this.dUsed, this.dLast)
    this.dLast = this.dUsed
  }

  private updateArcs(f: TornadoFrame, s: number, now: number, eye: V3): void {
    this.aUsed = 0
    if (f.presence > 0.5) {
      if (now >= this.inner.until) {
        const lines = []
        for (let k = 0; k < this.spec.arcs; k++) {
          if (Math.random() < 0.35) continue
          const h0 = 0.15 + Math.random() * 0.55
          lines.push({ h0, a0: Math.random() * Math.PI * 2, h1: Math.min(0.9, h0 + 0.05 + Math.random() * 0.2), a1: Math.random() * Math.PI * 2, jag: Array.from({ length: ARC_SEGMENTS * 3 }, () => Math.random() - 0.5) })
        }
        this.inner = { until: now + ARC_SHAPE_MS * (0.6 + Math.random()), lines }
      }
      for (const l of this.inner.lines) {
        const a = this.point(f, s, l.h0, l.a0, 0.55)
        const b = this.point(f, s, l.h1, l.a1, 0.55)
        this.bolt(a, b, l.jag, eye, 0.18, 0.75 * f.presence)
      }
    }
    for (let i = this.strikeArcs.length - 1; i >= 0; i--) {
      const st = this.strikeArcs[i]!
      const age = now - st.at
      if (age > STRIKE_ARC_MS || age < -2000) {
        this.strikeArcs.splice(i, 1)
        continue
      }
      if (age < 0) continue
      const from = this.point(f, s, 0.3, Math.atan2(st.to[2] - f.pos[2], st.to[0] - f.pos[0]), 0.9)
      const jag = Array.from({ length: ARC_SEGMENTS * 3 }, () => Math.random() - 0.5)
      this.bolt(from, st.to, jag, eye, 0.35, 1 - age / STRIKE_ARC_MS)
    }
    this.upload(this.arcMesh, this.aPos, this.aCol, this.aUv, this.aUsed, this.aLast)
    this.aLast = this.aUsed
  }

  /** A jagged ribbon from `a` to `b` with its glow at both ends. */
  private bolt(a: V3, b: V3, jag: readonly number[], eye: V3, width: number, alpha: number): void {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    const amp = Math.min(3, 0.14 * len)
    let prev = a
    for (let i = 1; i <= ARC_SEGMENTS; i++) {
      const t = i / ARC_SEGMENTS
      const e = i === ARC_SEGMENTS ? 0 : Math.sin(Math.PI * t) * amp * 2
      const p: V3 = [a[0] + (b[0] - a[0]) * t + jag[i * 3 - 3]! * e, a[1] + (b[1] - a[1]) * t + jag[i * 3 - 2]! * e, a[2] + (b[2] - a[2]) * t + jag[i * 3 - 1]! * e]
      this.ribbon(prev, p, width, eye, alpha)
      prev = p
    }
    this.arcSprite(a, 1.2, eye, alpha * 0.7)
    this.arcSprite(b, 1.6, eye, alpha * 0.8)
  }

  private ribbon(a: V3, b: V3, w: number, eye: V3, alpha: number): void {
    if (this.aUsed >= this.aCap || !(alpha > 0.002)) return
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
    let side = cross(d, [eye[0] - mid[0], eye[1] - mid[1], eye[2] - mid[2]])
    if (Math.hypot(side[0], side[1], side[2]) < 1e-6) return
    side = norm(side)
    const h = w / 2
    const o: V3 = [side[0] * h, side[1] * h, side[2] * h]
    const i = this.aUsed++
    this.aPos.set([a[0] - o[0], a[1] - o[1], a[2] - o[2], a[0] + o[0], a[1] + o[1], a[2] + o[2], b[0] + o[0], b[1] + o[1], b[2] + o[2], b[0] - o[0], b[1] - o[1], b[2] - o[2]], i * 12)
    this.aUv.set([0.75, 0, 0.75, 1, 0.75, 1, 0.75, 0], i * 8)
    this.arcColour(i, alpha)
  }

  private arcSprite(c: V3, size: number, eye: V3, alpha: number): void {
    if (this.aUsed >= this.aCap || !(alpha > 0.002)) return
    const [r, u] = billboard(c, eye, 0)
    const h = size / 2
    const i = this.aUsed++
    for (let k = 0; k < 4; k++) {
      const sr = k === 0 || k === 3 ? -1 : 1
      const su = k < 2 ? -1 : 1
      this.aPos.set([c[0] + (r[0] * sr + u[0] * su) * h, c[1] + (r[1] * sr + u[1] * su) * h, c[2] + (r[2] * sr + u[2] * su) * h], i * 12 + k * 3)
    }
    this.aUv.set([0, 0, 0.5, 0, 0.5, 1, 0, 1], i * 8)
    this.arcColour(i, alpha)
  }

  private arcColour(i: number, alpha: number): void {
    const al = Math.min(1, alpha)
    for (let k = 0; k < 4; k++) this.aCol.set([0.75 * al, 0.88 * al, 1 * al, al], i * 16 + k * 4)
  }

  /** A camera-facing debris quad of side `size`, turned by `angle` in the screen plane, atlas cell `cell`. */
  private sprite(c: V3, size: number, angle: number, cell: number, eye: V3, rgb: readonly number[], alpha: number): void {
    if (this.dUsed >= this.debris.length + this.dust.length || !(alpha > 0.002)) return
    const [r, u] = billboard(c, eye, angle)
    const h = size / 2
    const i = this.dUsed++
    for (let k = 0; k < 4; k++) {
      const sr = k === 0 || k === 3 ? -1 : 1
      const su = k < 2 ? -1 : 1
      this.dPos.set([c[0] + (r[0] * sr + u[0] * su) * h, c[1] + (r[1] * sr + u[1] * su) * h, c[2] + (r[2] * sr + u[2] * su) * h], i * 12 + k * 3)
    }
    const u0 = cell / 4
    const u1 = (cell + 1) / 4
    this.dUv.set([u0, 0, u1, 0, u1, 1, u0, 1], i * 8)
    const al = Math.min(1, alpha)
    for (let k = 0; k < 4; k++) this.dCol.set([rgb[0]!, rgb[1]!, rgb[2]!, al], i * 16 + k * 4)
  }

  private upload(mesh: Mesh, pos: Float32Array, col: Float32Array, uv: Float32Array, n: number, last: number): void {
    if (n === 0) {
      if (last > 0) pos.fill(0, 0, last * 12)
      mesh.isVisible = false
      return
    }
    pos.fill(0, n * 12, Math.max(n, last) * 12)
    mesh.updateVerticesData(VertexBuffer.PositionKind, pos, false, false)
    mesh.updateVerticesData(VertexBuffer.ColorKind, col, false, false)
    mesh.updateVerticesData(VertexBuffer.UVKind, uv, false, false)
    mesh.isVisible = true
  }

  /** Where the funnel's side stands at height share `h` toward `to` (the last frame), or null before the first. */
  sideToward(to: V3, h = 0.3): V3 | null {
    const f = this.last
    return f ? this.point(f, this.lastS, h, Math.atan2(to[2] - f.pos[2], to[0] - f.pos[0]), 0.9) : null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.strikeArcs.length = 0
    for (const m of [this.funnel, this.debrisMesh, this.arcMesh]) m.dispose(false, false)
    for (const m of [this.funnelMat, this.debrisMat, this.arcMat]) m.dispose(false, false)
    for (const t of [this.streaks, this.atlas, this.glow]) t.dispose()
  }
}

/** The camera-facing basis (right, up) at `c`, turned by `angle` in the screen plane. */
function billboard(c: V3, eye: V3, angle: number): [V3, V3] {
  const f = norm([eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]])
  let r = cross([0, 1, 0], f)
  if (Math.hypot(r[0], r[1], r[2]) < 1e-4) r = [1, 0, 0]
  r = norm(r)
  const u = cross(f, r)
  if (angle === 0) return [r, u]
  const ca = Math.cos(angle)
  const sa = Math.sin(angle)
  return [
    [r[0] * ca + u[0] * sa, r[1] * ca + u[1] * sa, r[2] * ca + u[2] * sa],
    [-r[0] * sa + u[0] * ca, -r[1] * sa + u[1] * ca, -r[2] * sa + u[2] * ca],
  ]
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

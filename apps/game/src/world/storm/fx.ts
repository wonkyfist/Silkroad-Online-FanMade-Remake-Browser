/**
 * Storm FX (docs/WEATHER.md §12.7): the blue electric glow of a storm-charged monster and the chain arc of its hits.
 * Cheap on purpose: ONE dynamic additive quad mesh, one material and one 64² texture for everything, rebuilt each frame
 * from what is live (at most CAP quads); nothing is created per monster or per arc, so nothing can leak, and `dispose`
 * frees the three objects.
 *
 * - A charged monster: a pulsing glow sprite at its body centre and three short jagged crackles around it, re-drawn
 *   every CRACKLE_MS (the shape is random, not seeded: it is decoration).
 * - An arc: a jagged channel from the struck player to the one it jumps to, flickering for ARC_MS, with a spark at
 *   both ends.
 */
import { Color3, Constants, Mesh, RawTexture, StandardMaterial, Texture, VertexBuffer, VertexData, type Camera, type Scene } from '@babylonjs/core'

type V3 = [number, number, number]

/** Quads in the mesh: 24 charged monsters × (1 glow + 3 × 4 crackle segments) + 6 arcs × (10 segments + 2 sparks). */
export const CAP = 24 * 13 + 6 * 12
/** Charged monsters drawn at most (the nearest). */
export const MAX_CHARGED = 24
export const MAX_ARCS = 6
/** How long an arc shows (ms). */
export const ARC_MS = 420
/** A crackle's shape holds this long (ms). */
const CRACKLE_MS = 90
const ARC_SEGMENTS = 10

const COLOR: readonly [number, number, number] = [0.45, 0.7, 1]
const CORE: readonly [number, number, number] = [0.85, 0.93, 1]
/** The crackles around a charged body: bluer than an arc's core. */
const CRACKLE: readonly [number, number, number] = [0.55, 0.78, 1]

export interface ChargedBody {
  id: number
  /** Body centre (world metres). */
  x: number
  y: number
  z: number
  /** Body radius (m). */
  r: number
}

interface Arc {
  from: V3
  to: V3
  at: number
  seed: number
}

function glowTexture(scene: Scene): RawTexture {
  const w = 64
  const data = new Uint8Array(w * w * 4)
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const v = ((y + 0.5) / w) * 2 - 1
      let a: number
      if (x < w / 2) {
        // left half: a round glow
        const u = ((x + 0.5) / (w / 2)) * 2 - 1
        const d = Math.min(1, Math.hypot(u, v))
        a = (1 - d) ** 2
      } else {
        // right half: a line's cross-section (bright core, soft edge), the same along its length
        const d = Math.abs(v)
        a = Math.max(0, 1 - d) ** 1.5
      }
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

export class StormFx {
  private readonly mesh: Mesh
  private readonly mat: StandardMaterial
  private readonly tex: RawTexture
  private readonly pos = new Float32Array(CAP * 12)
  private readonly col = new Float32Array(CAP * 16)
  private readonly uv = new Float32Array(CAP * 8)
  private used = 0
  private last = 0
  private readonly arcs: Arc[] = []
  /** Crackle shapes per charged monster (offsets around the centre), refreshed every CRACKLE_MS. */
  private readonly crackles = new Map<number, { until: number; lines: V3[][] }>()
  private disposed = false

  constructor(private readonly scene: Scene) {
    this.tex = glowTexture(scene)
    const m = new StandardMaterial('storm:fx', scene)
    m.disableLighting = true
    m.emissiveColor = Color3.White()
    m.diffuseColor = Color3.Black()
    m.specularColor = Color3.Black()
    m.backFaceCulling = false
    m.fogEnabled = false
    m.disableDepthWrite = true
    m.alphaMode = Constants.ALPHA_ADD
    m.diffuseTexture = this.tex
    m.useAlphaFromDiffuseTexture = true
    this.mat = m
    const idx = new Uint32Array(CAP * 6)
    for (let i = 0; i < CAP; i++) {
      const v = i * 4
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6)
    }
    this.mesh = new Mesh('storm:fx', scene)
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
    this.mesh.metadata = { sroStorm: true }
    this.mesh.setEnabled(false)
  }

  /** Live counts (debug). */
  stats(): { arcs: number; quads: number } {
    return { arcs: this.arcs.length, quads: this.last }
  }

  /** An arc from `from` to `to` (body centres) starting at `at` (page or server ms, the same clock as `update`). */
  arc(from: V3, to: V3, at: number): void {
    this.arcs.push({ from, to, at, seed: Math.random() })
    while (this.arcs.length > MAX_ARCS) this.arcs.shift()
  }

  clear(): void {
    this.arcs.length = 0
    this.crackles.clear()
    this.used = 0
    this.upload()
  }

  /** Draws this frame: the charged bodies (nearest first is the caller's job) and the arcs alive at `now`. */
  update(now: number, bodies: readonly ChargedBody[], camera: Camera | null): void {
    if (this.disposed) return
    this.used = 0
    const cam = camera?.globalPosition
    if (cam) {
      const eye: V3 = [cam.x, cam.y, cam.z]
      const seen = new Set<number>()
      for (const b of bodies.slice(0, MAX_CHARGED)) {
        seen.add(b.id)
        this.body(b, now, eye)
      }
      for (const id of this.crackles.keys()) if (!seen.has(id)) this.crackles.delete(id)
      for (let i = this.arcs.length - 1; i >= 0; i--) {
        const a = this.arcs[i]!
        const age = now - a.at
        if (age > ARC_MS || age < -1000) {
          this.arcs.splice(i, 1)
          continue
        }
        if (age >= 0) this.drawArc(a, age, now, eye)
      }
    }
    this.upload()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.arcs.length = 0
    this.crackles.clear()
    this.mesh.dispose(false, false)
    this.mat.dispose(false, false)
    this.tex.dispose()
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private body(b: ChargedBody, now: number, eye: V3): void {
    const pulse = 0.75 + 0.25 * Math.sin(now / 130 + b.id) + 0.1 * Math.sin(now / 37 + b.id * 3)
    const size = 1.1 * b.r + 0.5
    this.sprite([b.x, b.y, b.z], size * (0.9 + 0.1 * pulse), eye, COLOR, 0.55 * pulse)
    let c = this.crackles.get(b.id)
    if (!c || now >= c.until) {
      const lines: V3[][] = []
      for (let k = 0; k < 3; k++) {
        const a0 = Math.random() * Math.PI * 2
        const pts: V3[] = []
        for (let j = 0; j <= 4; j++) {
          const a = a0 + j * 0.45
          const rr = b.r * (0.6 + 0.4 * Math.random())
          pts.push([Math.cos(a) * rr, (Math.random() - 0.5) * b.r * 1.1, Math.sin(a) * rr])
        }
        lines.push(pts)
      }
      c = { until: now + CRACKLE_MS, lines }
      this.crackles.set(b.id, c)
    }
    for (const pts of c.lines) {
      for (let j = 0; j + 1 < pts.length; j++) {
        const p = pts[j]!
        const q = pts[j + 1]!
        this.ribbon([b.x + p[0], b.y + p[1], b.z + p[2]], [b.x + q[0], b.y + q[1], b.z + q[2]], 0.05, eye, CRACKLE, 0.75)
      }
    }
  }

  private drawArc(a: Arc, age: number, now: number, eye: V3): void {
    const fade = 1 - age / ARC_MS
    const flick = 0.6 + 0.4 * Math.sin(now / 23 + a.seed * 10)
    const len = Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1], a.to[2] - a.from[2])
    const jag = Math.min(0.6, 0.12 * len)
    let prev: V3 = a.from
    for (let i = 1; i <= ARC_SEGMENTS; i++) {
      const t = i / ARC_SEGMENTS
      const edge = i === ARC_SEGMENTS ? 0 : Math.sin(Math.PI * t)
      const p: V3 = [
        a.from[0] + (a.to[0] - a.from[0]) * t + (Math.random() - 0.5) * 2 * jag * edge,
        a.from[1] + (a.to[1] - a.from[1]) * t + (Math.random() - 0.5) * 2 * jag * edge,
        a.from[2] + (a.to[2] - a.from[2]) * t + (Math.random() - 0.5) * 2 * jag * edge,
      ]
      this.ribbon(prev, p, 0.16, eye, CORE, fade * flick)
      prev = p
    }
    this.sprite(a.from, 0.9, eye, COLOR, 0.8 * fade)
    this.sprite(a.to, 1.2, eye, COLOR, 0.9 * fade)
  }

  /** A camera-facing glow square of side `size` at `c`. */
  private sprite(c: V3, size: number, eye: V3, rgb: readonly number[], alpha: number): void {
    const f = norm([eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]])
    let r = cross([0, 1, 0], f)
    if (Math.hypot(r[0], r[1], r[2]) < 1e-4) r = [1, 0, 0]
    r = norm(r)
    const u = cross(f, r)
    const h = size / 2
    const corner = (sr: number, su: number): V3 => [c[0] + (r[0] * sr + u[0] * su) * h, c[1] + (r[1] * sr + u[1] * su) * h, c[2] + (r[2] * sr + u[2] * su) * h]
    this.quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), [0, 0, 0.5, 0, 0.5, 1, 0, 1], rgb, alpha)
  }

  /** A camera-facing ribbon of width `w` from `a` to `b`. */
  private ribbon(a: V3, b: V3, w: number, eye: V3, rgb: readonly number[], alpha: number): void {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
    let s = cross(d, [eye[0] - mid[0], eye[1] - mid[1], eye[2] - mid[2]])
    if (Math.hypot(s[0], s[1], s[2]) < 1e-6) return
    s = norm(s)
    const h = w / 2
    const off: V3 = [s[0] * h, s[1] * h, s[2] * h]
    this.quad(
      [a[0] - off[0], a[1] - off[1], a[2] - off[2]],
      [a[0] + off[0], a[1] + off[1], a[2] + off[2]],
      [b[0] + off[0], b[1] + off[1], b[2] + off[2]],
      [b[0] - off[0], b[1] - off[1], b[2] - off[2]],
      [0.75, 0, 0.75, 1, 0.75, 1, 0.75, 0],
      rgb,
      alpha,
    )
  }

  private quad(a: V3, b: V3, c: V3, d: V3, uv: readonly number[], rgb: readonly number[], alpha: number): void {
    if (this.used >= CAP || !(alpha > 0.002)) return
    const i = this.used++
    this.pos.set(a, i * 12)
    this.pos.set(b, i * 12 + 3)
    this.pos.set(c, i * 12 + 6)
    this.pos.set(d, i * 12 + 9)
    this.uv.set(uv, i * 8)
    const al = Math.min(1, alpha)
    for (let k = 0; k < 4; k++) this.col.set([rgb[0]! * al, rgb[1]! * al, rgb[2]! * al, al], i * 16 + k * 4)
  }

  private upload(): void {
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
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

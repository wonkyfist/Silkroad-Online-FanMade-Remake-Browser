/**
 * Weapon trails, the retail "mirage" (docs/EFFECTS.md §2.1, §2.6, M1): while an attack swings, the weapon leaves a
 * textured afterimage between its `ai_start` (near the hilt) and `ai_end` (the tip) dummies. One ribbon per swinging
 * actor: every frame the two dummy positions are sampled; samples younger than the aniset trail length stay. The
 * ribbon is smoothed with Catmull-Rom between samples (swings are fast; a 30 fps frame would show corners).
 * Texture layout (Particles `textures/mirage_texture_*.ddj`): U = age / length (fresh at u = 0), V = 0 at the tip and
 * 1 at the hilt; the aniset colour (ARGB / 255) multiplies it; `ONE` rows blend additively, `INVSRCALPHA` alpha.
 */
import { Color3, Constants, Material, Mesh, StandardMaterial, VertexBuffer, type Scene, type Texture } from '@babylonjs/core'
import type { V3 } from '@sro/fx'
import { displayEmissive } from '../display-tone.ts'
import type { FxTrail } from './types.ts'

/** Samples kept at most (docs/EFFECTS.md §7: <= 48). */
export const TRAIL_SAMPLES = 48
/** Sub-points drawn between two samples. */
const SUBDIV = 3
/** Points in the drawn strip at most. */
const MAX_POINTS = (TRAIL_SAMPLES - 1) * SUBDIV + 1

export interface TrailSample {
  t: number
  tip: V3
  hilt: V3
}

/** How a trail looks: from the aniset row (FxTrail), resolved. */
export interface TrailStyle {
  lengthMs: number
  /** RGBA 0..1. */
  color: [number, number, number, number]
  blend: 'add' | 'alpha'
  /** Out-root-relative texture URL ('fx/tex/textures/mirage_texture_smash.png'), or null (untextured glow). */
  texture: string | null
}

/** The trail style of an aniset row, or null when it has none (length 0, no texture, or fully transparent). */
export function trailStyle(t: FxTrail | null | undefined): TrailStyle | null {
  if (!t || !(t.lengthMs > 0) || !t.texture || t.argb[0] <= 0) return null
  return {
    lengthMs: t.lengthMs,
    color: [t.argb[1] / 255, t.argb[2] / 255, t.argb[3] / 255, t.argb[0] / 255],
    blend: t.op === 'INVSRCALPHA' ? 'alpha' : 'add',
    texture: 'fx/tex/' + t.texture.replace(/\\/g, '/').toLowerCase().replace(/\.ddj$/, '.png'),
  }
}

/** Keeps samples younger than `lengthMs` at `now` (the newest always stays while emitting), at most TRAIL_SAMPLES. */
export function pruneSamples(samples: TrailSample[], now: number, lengthMs: number): TrailSample[] {
  let out = samples.filter(s => now - s.t <= lengthMs)
  if (out.length > TRAIL_SAMPLES) out = out.slice(out.length - TRAIL_SAMPLES)
  return out
}

function catmull(p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 {
  const t2 = t * t
  const t3 = t2 * t
  const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])]
}

/** The drawn points (newest first), Catmull-Rom between samples: [tip, hilt, age ms]. */
export function stripPoints(samples: readonly TrailSample[], now: number): { tip: V3; hilt: V3; age: number }[] {
  const n = samples.length
  const out: { tip: V3; hilt: V3; age: number }[] = []
  if (n < 2) return out
  // Newest first.
  const s = [...samples].reverse()
  const at = (i: number) => s[Math.max(0, Math.min(n - 1, i))]!
  for (let i = 0; i < n - 1; i++) {
    const a = at(i - 1)
    const b = at(i)
    const c = at(i + 1)
    const d = at(i + 2)
    for (let k = 0; k < SUBDIV; k++) {
      const u = k / SUBDIV
      out.push({ tip: catmull(a.tip, b.tip, c.tip, d.tip, u), hilt: catmull(a.hilt, b.hilt, c.hilt, d.hilt, u), age: now - (b.t + (c.t - b.t) * u) })
    }
  }
  const last = s[n - 1]!
  out.push({ tip: last.tip, hilt: last.hilt, age: now - last.t })
  return out.slice(0, MAX_POINTS)
}

const materials = new WeakMap<Scene, Map<string, StandardMaterial>>()

function trailMaterial(scene: Scene, texture: Texture | null, blend: 'add' | 'alpha', key: string): StandardMaterial {
  let byKey = materials.get(scene)
  if (!byKey) materials.set(scene, (byKey = new Map()))
  let mat = byKey.get(key)
  if (!mat) {
    mat = new StandardMaterial(`fx:trail|${key}`, scene)
    mat.disableLighting = true
    displayEmissive(mat, Color3.White()) // W9F R1: the trail art is a display colour (world/display-tone.ts)
    mat.diffuseColor = Color3.Black()
    mat.specularColor = Color3.Black()
    mat.ambientColor = Color3.Black()
    mat.fogEnabled = false
    if (texture) {
      mat.diffuseTexture = texture
      mat.useAlphaFromDiffuseTexture = true
    }
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND
    mat.alphaMode = blend === 'add' ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE
    mat.disableDepthWrite = true
    mat.backFaceCulling = false
    const created = mat
    const map = byKey
    created.onDisposeObservable.addOnce(() => {
      if (map.get(key) === created) map.delete(key)
    })
    byKey.set(key, mat)
  }
  return mat
}

/** Where the blade is now (world space), or null when the actor has no trail dummies. */
export type BladeSource = () => { tip: V3; hilt: V3 } | null

/**
 * One actor's trail. `arm(style, until)` starts (or extends) emission; `update(now)` samples the blade and rebuilds
 * the strip; after emission stops the strip shrinks away within its length, then `idle` is true.
 */
export class WeaponTrail {
  readonly mesh: Mesh
  private samples: TrailSample[] = []
  private style: TrailStyle | null = null
  private until = -Infinity
  private readonly positions = new Float32Array(MAX_POINTS * 2 * 3)
  private readonly colors = new Float32Array(MAX_POINTS * 2 * 4)
  private readonly uvs = new Float32Array(MAX_POINTS * 2 * 2)
  private disposed = false
  /** Points drawn last frame (tests). */
  drawn = 0

  constructor(private readonly scene: Scene, private readonly blade: BladeSource, private readonly texture: (url: string) => Texture | null, name = 'fx:trail') {
    this.mesh = new Mesh(name, scene)
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
    this.mesh.hasVertexAlpha = true
    this.mesh.isVisible = false
    const idx = new Uint32Array((MAX_POINTS - 1) * 6)
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      const a = i * 2
      idx.set([a, a + 1, a + 3, a, a + 3, a + 2], i * 6)
    }
    this.mesh.setVerticesData(VertexBuffer.PositionKind, this.positions, true, 3)
    this.mesh.setVerticesData(VertexBuffer.ColorKind, this.colors, true, 4)
    this.mesh.setVerticesData(VertexBuffer.UVKind, this.uvs, true, 2)
    this.mesh.setIndices(idx)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Emits with `style` until local ms `until` (a later arm extends it; a new style replaces the old at once). */
  arm(style: TrailStyle, until: number): void {
    if (this.disposed) return
    if (this.style && (this.style.texture !== style.texture || this.style.blend !== style.blend)) this.samples = []
    this.style = style
    this.until = Math.max(this.until, until)
    const key = `${style.texture ?? ''}|${style.blend}`
    const tex = style.texture ? this.texture(style.texture) : null
    this.mesh.material = trailMaterial(this.scene, tex, style.blend, key)
  }

  /** Stops emitting now (the strip still fades out). */
  disarm(now: number): void {
    this.until = Math.min(this.until, now)
  }

  /** Nothing to draw and not emitting. */
  idleAt(now: number): boolean {
    return now > this.until && this.samples.length === 0
  }

  update(now: number): void {
    if (this.disposed || !this.style) return
    const style = this.style
    if (now <= this.until) {
      const b = this.blade()
      if (b) {
        const last = this.samples[this.samples.length - 1]
        if (!last || now > last.t) this.samples.push({ t: now, tip: b.tip, hilt: b.hilt })
      }
    }
    this.samples = pruneSamples(this.samples, now, style.lengthMs)
    const pts = stripPoints(this.samples, now)
    this.drawn = pts.length
    if (pts.length < 2) {
      this.mesh.isVisible = false
      return
    }
    const [r, g, b, a] = style.color
    for (let i = 0; i < MAX_POINTS; i++) {
      const p = pts[Math.min(i, pts.length - 1)]!
      const u = Math.min(1, Math.max(0, p.age / style.lengthMs))
      // Past the strip end: degenerate (all at the last point, transparent).
      const alpha = i < pts.length ? a * (1 - u * 0.15) : 0
      for (let side = 0; side < 2; side++) {
        const v = i * 2 + side
        const q = side === 0 ? p.tip : p.hilt
        this.positions.set(q, v * 3)
        this.colors.set([r, g, b, alpha], v * 4)
        this.uvs.set([u, side], v * 2)
      }
    }
    this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions)
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, this.colors)
    this.mesh.updateVerticesData(VertexBuffer.UVKind, this.uvs)
    this.mesh.isVisible = true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mesh.dispose(false, false)
  }
}

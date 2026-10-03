/**
 * Small world effects: the level-up light column, the retail target circle (TargetDecal), the click marker.
 * All positions come from the caller (ground height via WorldGround.heightAt).
 */
import {
  Color3,
  Constants,
  CreateCylinder,
  CreateTorus,
  DynamicTexture,
  Mesh,
  StandardMaterial,
  Texture,
  TransformNode,
  VertexBuffer,
  VertexData,
  type BaseTexture,
  type Scene,
} from '@babylonjs/core'
import { OUT } from '../content/catalog.ts'
import { displayTexture } from './display-tone.ts'

export interface Effect {
  /** Advances by `dt` seconds; false when finished (the owner then disposes it). */
  update(dt: number): boolean
  dispose(): void
}

export class EffectList {
  private readonly list: Effect[] = []

  add(e: Effect): void {
    this.list.push(e)
  }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i]!
      if (!e.update(dt)) {
        e.dispose()
        this.list.splice(i, 1)
      }
    }
  }

  dispose(): void {
    for (const e of this.list) e.dispose()
    this.list.length = 0
  }
}

/** Vertical gradient (opaque at the bottom, clear at the top) for additive beams. */
function beamTexture(scene: Scene, name: string): DynamicTexture {
  const tex = new DynamicTexture(name, { width: 8, height: 128 }, scene, false)
  const ctx = tex.getContext() as CanvasRenderingContext2D
  const g = ctx.createLinearGradient(0, 0, 0, 128)
  g.addColorStop(0, 'rgba(255,255,255,0)')
  g.addColorStop(0.55, 'rgba(255,255,255,0.35)')
  g.addColorStop(1, 'rgba(255,255,255,1)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 8, 128)
  tex.update()
  tex.hasAlpha = true
  return tex
}

export function additiveMaterial(scene: Scene, name: string, color: Color3, texture?: DynamicTexture): StandardMaterial {
  const m = new StandardMaterial(name, scene)
  m.disableLighting = true
  m.emissiveColor = color
  m.diffuseColor = Color3.Black()
  m.specularColor = Color3.Black()
  m.backFaceCulling = false
  m.alphaMode = Constants.ALPHA_ADD
  m.alpha = 1
  if (texture) {
    m.emissiveTexture = texture
    m.opacityTexture = texture
  }
  return m
}

let serial = 0

/** Golden light column rising around a character that levelled up (about 2.2 s). */
export function levelUpColumn(scene: Scene, x: number, y: number, z: number): Effect {
  const id = ++serial
  const root = new TransformNode(`lvlup${id}`, scene)
  root.position.set(x, y, z)
  const tex = beamTexture(scene, `lvlupTex${id}`)
  const mat = additiveMaterial(scene, `lvlupMat${id}`, new Color3(1, 0.82, 0.35), tex)
  const outer = CreateCylinder(`lvlupOuter${id}`, { height: 7, diameterTop: 1.1, diameterBottom: 1.7, tessellation: 32, cap: Mesh.NO_CAP }, scene)
  outer.position.y = 3.5
  const inner = CreateCylinder(`lvlupInner${id}`, { height: 9, diameterTop: 0.2, diameterBottom: 0.6, tessellation: 16, cap: Mesh.NO_CAP }, scene)
  inner.position.y = 4.5
  const ringMat = additiveMaterial(scene, `lvlupRingMat${id}`, new Color3(1, 0.75, 0.3))
  const ring = CreateTorus(`lvlupRing${id}`, { diameter: 1.4, thickness: 0.08, tessellation: 48 }, scene)
  ring.position.y = 0.05
  for (const m of [outer, inner]) m.material = mat
  ring.material = ringMat
  for (const m of [outer, inner, ring]) {
    m.parent = root
    m.isPickable = false
  }
  const total = 2.2
  let t = 0
  return {
    update(dt) {
      t += dt
      const grow = Math.min(1, t / 0.35)
      const fade = t < 1.3 ? 1 : Math.max(0, 1 - (t - 1.3) / (total - 1.3))
      outer.scaling.set(1, grow, 1)
      inner.scaling.set(1, grow, 1)
      outer.rotation.y += dt * 1.5
      mat.alpha = fade
      ring.scaling.setAll(1 + t * 1.6)
      ringMat.alpha = Math.max(0, 1 - t / 1.2)
      return t < total
    },
    dispose() {
      root.dispose(false, true)
      tex.dispose()
    },
  }
}

// ---- ground decals: the target circle and the click marker (docs/EFFECTS.md §3.13) ---------------------------------

export type RingTone = 'hostile' | 'neutral' | 'friendly' | 'item'

/** The retail selection circles `Media effect/select_0N.ddj` (128x128), exported by export-fx.ts (FX-X). */
export type SelectTexture = 'select_01' | 'select_02' | 'select_03' | 'select_04'

/**
 * Circle per tone [our rule; the retail colour mapping is unknown]: 04 orange hostile mob, 02 green-gold NPC (and
 * party), 03 blue other player, 01 white ground item.
 */
export const DECAL_TEXTURE: Record<RingTone, SelectTexture> = {
  hostile: 'select_04',
  neutral: 'select_02',
  friendly: 'select_03',
  item: 'select_01',
}

/** Stand-in colours when the textures did not export (a plain ring is drawn instead). */
const TONE_RGB: Record<SelectTexture, string> = {
  select_01: '235,240,240',
  select_02: '205,200,70',
  select_03: '80,130,255',
  select_04: '255,110,30',
}

export function selectTextureUrl(key: SelectTexture): string {
  return `${OUT}fx/tex/ui/${key}.png`
}

/** Ground height at (x, z) on the surface nearest `nearY` (screens/world.ts passes WorldGround.heightAt). */
export type GroundSampler = (x: number, z: number, nearY: number) => number

/** Where the circle's ink ends inside the 128-px texture (the outer glow edge at about 120 px of 128). */
const INK_EDGE = 0.9
/** Ground clearance, and how far a sample may leave the centre's height before the decal stays flat (a ledge). */
const LIFT = 0.05
const MAX_STEP = 1.2
/** Rings and segments of the conforming disc: 1 + RINGS * SEGS height samples. */
export const DECAL_RINGS = 3
export const DECAL_SEGS = 16
/** Spin of the target circle (rad/s, the old ring's). */
export const DECAL_SPIN = 0.8

/** Target circle radius (m) for an entity of radius `radius`: its ink edge sits 0.25 m outside the body. */
export function decalRadius(radius: number): number {
  return Math.max(0.35, radius) + 0.25
}

/**
 * The unit disc of a decal (pure; tested): the centre, then `rings` rings of `segs` points, `xz` in [-1, 1]; and the
 * triangle list (a fan in the middle, quads between rings).
 */
export function decalGrid(rings = DECAL_RINGS, segs = DECAL_SEGS): { xz: number[]; indices: number[] } {
  const xz = [0, 0]
  for (let r = 1; r <= rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2
      xz.push((Math.cos(a) * r) / rings, (Math.sin(a) * r) / rings)
    }
  }
  const indices: number[] = []
  const at = (r: number, s: number) => 1 + (r - 1) * segs + (s % segs)
  for (let s = 0; s < segs; s++) indices.push(0, at(1, s + 1), at(1, s))
  for (let r = 1; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      indices.push(at(r, s), at(r, s + 1), at(r + 1, s + 1))
      indices.push(at(r, s), at(r + 1, s + 1), at(r + 1, s))
    }
  }
  return { xz, indices }
}

/** Texture coordinates of the unit disc turned by `angle` (the spin turns the art, not the conformed mesh). */
export function decalUvs(xz: readonly number[], angle: number, out: number[] = []): number[] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  out.length = xz.length
  for (let i = 0; i < xz.length; i += 2) {
    const x = xz[i]!
    const z = xz[i + 1]!
    out[i] = 0.5 + ((c * x - s * z) * 0.5) * INK_EDGE
    out[i + 1] = 0.5 + ((s * x + c * z) * 0.5) * INK_EDGE
  }
  return out
}

/**
 * Local heights of the disc's points for a decal of radius `radius` centred at (x, y, z) (pure; tested): each point
 * follows the ground; a point more than MAX_STEP off the centre's height (a ledge, a bridge edge) stays at the centre's.
 */
export function decalHeights(xz: readonly number[], x: number, y: number, z: number, radius: number, sample?: GroundSampler): number[] {
  const out: number[] = []
  for (let i = 0; i < xz.length; i += 2) {
    const h = sample ? sample(x + xz[i]! * radius, z + xz[i + 1]! * radius, y) : y
    out.push((Number.isFinite(h) && Math.abs(h - y) <= MAX_STEP ? h - y : 0) + LIFT)
  }
  return out
}

/** Click marker (our rule): the green circle at 0.5 m shrinking and fading over 0.6 s. */
export const MARKER_RADIUS = 0.5
export const MARKER_LIFE = 0.6

/** Scale and opacity of the click marker `t` seconds after the click (pure; tested). */
export function markerFrame(t: number): { scale: number; alpha: number } {
  const k = Math.min(1, Math.max(0, t / MARKER_LIFE))
  const ease = 1 - (1 - k) * (1 - k)
  return { scale: 1 - 0.65 * ease, alpha: k < 0.35 ? 1 : 1 - (k - 0.35) / 0.65 }
}

/** Makes one selection texture; tests pass their own (no fetch). */
export type DecalTextureSource = (key: SelectTexture, scene: Scene) => BaseTexture

const cache = new WeakMap<Scene, Map<SelectTexture, BaseTexture>>()

/** A plain ring in the tone's colour, for when the exported texture is missing. */
function fallbackTexture(key: SelectTexture, scene: Scene): DynamicTexture {
  const tex = new DynamicTexture(`${key}Fallback`, { width: 128, height: 128 }, scene, true)
  const ctx = tex.getContext() as CanvasRenderingContext2D
  const rgb = TONE_RGB[key]
  ctx.clearRect(0, 0, 128, 128)
  ctx.lineWidth = 10
  ctx.strokeStyle = `rgba(${rgb},0.35)`
  ctx.beginPath()
  ctx.arc(64, 64, 50, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 4
  ctx.strokeStyle = `rgba(${rgb},1)`
  ctx.stroke()
  tex.update()
  tex.hasAlpha = true
  return tex
}

/** The exported texture, shared per scene; a drawn ring replaces it when it fails to load. */
function loadSelectTexture(key: SelectTexture, scene: Scene, onFallback: (t: BaseTexture) => void): BaseTexture {
  let map = cache.get(scene)
  if (!map) {
    map = new Map()
    cache.set(scene, map)
  }
  const hit = map.get(key)
  if (hit) return hit
  const tex = new Texture(selectTextureUrl(key), scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, null, () => {
    if (scene.isDisposed || typeof document === 'undefined') return
    console.warn(`[fx] ${selectTextureUrl(key)} missing; drawing a plain circle (run export-fx.ts)`)
    const fb = fallbackTexture(key, scene)
    map.set(key, fb)
    onFallback(fb)
  })
  tex.hasAlpha = true
  tex.wrapU = Texture.CLAMP_ADDRESSMODE
  tex.wrapV = Texture.CLAMP_ADDRESSMODE
  map.set(key, tex)
  return tex
}

/** A flat textured disc that follows the ground (the shared body of TargetDecal and ClickMarker). */
class GroundDecal {
  readonly mesh: Mesh
  readonly mat: StandardMaterial
  private readonly xz: number[]
  private readonly positions: number[]
  private readonly uvs: number[] = []
  private key: SelectTexture | null = null
  private placed = { x: NaN, y: NaN, z: NaN, r: NaN }
  /**
   * The art as the emissive: a view of the (shared, cached) select texture with its own level, which follows the
   * exposure on the PBR presets (W9F R1, world/display-tone.ts); the opacity keeps the shared texture at level 1.
   */
  private emissive: BaseTexture | null = null
  private offTone: (() => void) | null = null

  constructor(
    private readonly scene: Scene,
    name: string,
    private readonly sample: GroundSampler | undefined,
    private readonly source: DecalTextureSource | undefined,
  ) {
    const grid = decalGrid()
    this.xz = grid.xz
    this.positions = new Array<number>((this.xz.length / 2) * 3).fill(0)
    const normals: number[] = []
    for (let i = 0; i < this.xz.length; i += 2) normals.push(0, 1, 0)
    this.mesh = new Mesh(name, scene)
    const data = new VertexData()
    data.positions = this.positions
    data.indices = grid.indices
    data.normals = normals
    data.uvs = decalUvs(this.xz, 0, this.uvs)
    data.applyToMesh(this.mesh, true)
    this.mat = new StandardMaterial(`${name}Mat`, scene)
    this.mat.disableLighting = true
    this.mat.diffuseColor = Color3.Black()
    this.mat.specularColor = Color3.Black()
    // The emissive texture adds to emissiveColor, so the colour stays black: the art's own colours show.
    this.mat.emissiveColor = Color3.Black()
    this.mat.backFaceCulling = false
    this.mat.alphaMode = Constants.ALPHA_COMBINE
    this.mat.zOffset = -2
    this.mat.fogEnabled = false
    this.mesh.material = this.mat
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
    this.mesh.setEnabled(false)
  }

  setTexture(key: SelectTexture): void {
    if (this.key === key) return
    this.key = key
    const tex = this.source
      ? this.source(key, this.scene)
      : loadSelectTexture(key, this.scene, fb => {
          if (this.key === key) this.apply(fb)
        })
    this.apply(tex)
  }

  private apply(tex: BaseTexture): void {
    this.releaseEmissive()
    const view = tex.clone()
    if (view) {
      this.emissive = view
      this.offTone = displayTexture(this.scene, view)
    }
    this.mat.emissiveTexture = view ?? tex
    this.mat.opacityTexture = tex
  }

  private releaseEmissive(): void {
    this.offTone?.()
    this.offTone = null
    this.emissive?.dispose()
    this.emissive = null
  }

  /** Places the disc at (x, y, z) with radius `r` and the art turned by `angle`. */
  place(x: number, y: number, z: number, r: number, angle: number): void {
    const p = this.placed
    if (Math.abs(p.x - x) > 0.01 || Math.abs(p.z - z) > 0.01 || Math.abs(p.y - y) > 0.01 || Math.abs(p.r - r) > 0.005 || Number.isNaN(p.x)) {
      this.placed = { x, y, z, r }
      const heights = decalHeights(this.xz, x, y, z, r, this.sample)
      for (let i = 0, v = 0; i < this.xz.length; i += 2, v++) {
        this.positions[v * 3] = this.xz[i]! * r
        this.positions[v * 3 + 1] = heights[v]!
        this.positions[v * 3 + 2] = this.xz[i + 1]! * r
      }
      this.mesh.position.set(x, y, z)
      this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions)
      this.mesh.refreshBoundingInfo()
    }
    this.mesh.updateVerticesData(VertexBuffer.UVKind, decalUvs(this.xz, angle, this.uvs))
  }

  /** Local height of point `i` of the disc (tests). */
  heightOf(i: number): number {
    return this.positions[i * 3 + 1]!
  }

  dispose(): void {
    this.mesh.dispose()
    this.mat.dispose()
    this.releaseEmissive()
  }
}

/**
 * The retail target circle under the selected entity (docs/EFFECTS.md §3.13): the select_0N texture laid on the
 * ground as a disc that follows the ground height, radius = target radius + 0.25 m, slowly turning.
 * Same API as the old TargetRing.
 */
export class TargetDecal {
  private readonly decal: GroundDecal
  private radius = 0.6
  private angle = 0
  private tex: SelectTexture = 'select_04'

  /** `sample` makes the circle follow slopes and steps; without it the circle is flat at the given height. */
  constructor(scene: Scene, sample?: GroundSampler, source?: DecalTextureSource) {
    this.decal = new GroundDecal(scene, 'targetDecal', sample, source)
  }

  get mesh(): Mesh {
    return this.decal.mesh
  }

  get visible(): boolean {
    return this.decal.mesh.isEnabled()
  }

  /** The texture shown and the circle's radius (m) (tests, the fx lab). */
  get state(): { texture: SelectTexture; radius: number } {
    return { texture: this.tex, radius: this.radius }
  }

  /** Local height of disc point `i` above the centre (tests). */
  heightOf(i: number): number {
    return this.decal.heightOf(i)
  }

  show(tone: RingTone, radius: number): void {
    this.tex = DECAL_TEXTURE[tone]
    this.decal.setTexture(this.tex)
    this.radius = decalRadius(radius)
    this.decal.mesh.setEnabled(true)
  }

  hide(): void {
    this.decal.mesh.setEnabled(false)
  }

  update(dt: number, x: number, y: number, z: number): void {
    if (!this.visible) return
    this.angle = (this.angle + dt * DECAL_SPIN) % (Math.PI * 2)
    this.decal.place(x, y, z, this.radius, this.angle)
  }

  dispose(): void {
    this.decal.dispose()
  }
}

/** Where a ground click sends the character: a small green circle that shrinks and fades (our rule, §3.13). */
export class ClickMarker {
  private readonly decal: GroundDecal
  private t = MARKER_LIFE
  private at = { x: 0, y: 0, z: 0 }

  constructor(scene: Scene, sample?: GroundSampler, source?: DecalTextureSource) {
    this.decal = new GroundDecal(scene, 'clickMarker', sample, source)
    this.decal.setTexture('select_02')
  }

  get mesh(): Mesh {
    return this.decal.mesh
  }

  get visible(): boolean {
    return this.decal.mesh.isEnabled()
  }

  get alpha(): number {
    return this.decal.mat.alpha
  }

  show(x: number, y: number, z: number): void {
    this.at = { x, y, z }
    this.t = 0
    this.decal.mesh.setEnabled(true)
    this.update(0)
  }

  hide(): void {
    this.t = MARKER_LIFE
    this.decal.mesh.setEnabled(false)
  }

  update(dt: number): void {
    if (!this.visible) return
    this.t += dt
    if (this.t >= MARKER_LIFE) {
      this.hide()
      return
    }
    const f = markerFrame(this.t)
    this.decal.mat.alpha = f.alpha
    this.decal.place(this.at.x, this.at.y, this.at.z, MARKER_RADIUS * f.scale, this.t * DECAL_SPIN * 2)
  }

  dispose(): void {
    this.decal.dispose()
  }
}

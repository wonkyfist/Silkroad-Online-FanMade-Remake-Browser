/**
 * Lightning on screen (docs/WEATHER.md §7.3b): the telegraph, the bolt and what a strike leaves, drawn with a FIXED set
 * of six dynamic meshes made once (W14 rule, engine.ts trimBindGroupCache: a strike never creates a mesh, a material
 * or a texture, so a long storm cannot grow the bind-group cache or leak GPU memory; the 2026-10-05 black screen):
 *
 * - `ribbonsAdd`: camera-facing quads per line segment, additive: the bolts (core + halo), the telegraph's static
 *   arcs, a struck trunk's glowing split.
 * - `ribbonsAlpha`: the same, alpha-blended: a struck trunk's char.
 * - `spritesAdd` / `spritesAlpha`: CPU particles as camera-facing quads (sparks, fire, embers, the impact flare /
 *   smoke, dirt, steam, stone chips, dust).
 * - `ringDecals` (additive) / `scorchDecals` (alpha): quads lying on the ground: the telegraph's glow ring and the
 *   burnt marks.
 *
 * Every buffer has a fixed capacity; what does not fit is dropped (the oldest scorch is reused). The meshes are disabled
 * while they draw nothing. Textures are three small RawTextures made once (a soft dot, a ring, a scorch). Per frame
 * only the meshes with something to draw are rebuilt (updateVerticesData on preallocated arrays).
 *
 * The scene's flash (the sky and clouds lit from inside, the terrain, water, objects and ambient) is the weather
 * flash (world/features/weather.ts, strike-driven); no point light is added (a light-count change recompiles every
 * material, W9F G1).
 */
import {
  Color3,
  Constants,
  Mesh,
  RawTexture,
  StandardMaterial,
  Texture,
  VertexBuffer,
  VertexData,
  type Camera,
  type Scene,
} from '@babylonjs/core'
import { mulberry32, type LightningStrike } from '@sro/shared'
import { MAX_BOLT_SEGMENTS, generateBolt, staticArcs, type BoltShape, type BoltSegment, type V3 } from './bolt.ts'
import {
  FIRE_MS,
  SMOKE_TAIL_MS,
  SPLIT_GLOW_MS,
  TIER_FEATURES,
  boltDone,
  boltState,
  fireLevels,
  scorchAlpha,
  telegraphLevel,
  type LightningTier,
} from './timeline.ts'

/** Capacities (quads). */
export const CAP = { ribbonsAdd: 2 * (2 * MAX_BOLT_SEGMENTS) + 3 * 64 + 3 * 24, ribbonsAlpha: 12, spritesAdd: 700, spritesAlpha: 600, rings: 6, scorches: 16, trees: 3 } as const

/** Bolt colour: blue-white core, violet halo. */
const CORE: V3 = [0.92, 0.95, 1]
const HALO: V3 = [0.45, 0.5, 1]
const STATIC: V3 = [0.55, 0.75, 1]
/** The telegraph's glow: faint, so it warns without looking like a spell circle. */
const RING: V3 = [0.16, 0.3, 0.55]

export interface LightningFxHost {
  /** Ground height at x/z near yHint (null: unknown). */
  heightAt(x: number, z: number, yHint?: number): number | null
  /** Surface wetness 0..1 (steam rings above 0.3). */
  wetness(): number
}

interface Live {
  s: LightningStrike
  bolt: BoltShape | null
  /** Aftermath spawned. */
  landed: boolean
  /** Next static redraw (ms) and its seed. */
  staticAt: number
  staticSeed: number
  statics: BoltSegment[]
  crown: BoltSegment[]
}

interface Scorch {
  x: number
  y: number
  z: number
  nx: number
  ny: number
  nz: number
  size: number
  rot: number
  born: number
}

interface Tree {
  x: number
  z: number
  ground: number
  top: number
  born: number
  split: BoltSegment[]
  /** Fractional particles carried to the next frame per emitter. */
  carry: [number, number, number]
}

/** A pool of CPU particles (struct of arrays). */
class Particles {
  readonly n: number
  count = 0
  readonly px: Float32Array
  readonly py: Float32Array
  readonly pz: Float32Array
  readonly vx: Float32Array
  readonly vy: Float32Array
  readonly vz: Float32Array
  readonly age: Float32Array
  readonly life: Float32Array
  readonly s0: Float32Array
  readonly s1: Float32Array
  /** rgba at birth and at death. */
  readonly c0: Float32Array
  readonly c1: Float32Array
  readonly grav: Float32Array
  readonly drag: Float32Array
  private readonly scalars: Float32Array[]

  constructor(n: number) {
    this.n = n
    const f = () => new Float32Array(n)
    this.px = f()
    this.py = f()
    this.pz = f()
    this.vx = f()
    this.vy = f()
    this.vz = f()
    this.age = f()
    this.life = f()
    this.s0 = f()
    this.s1 = f()
    this.grav = f()
    this.drag = f()
    this.c0 = new Float32Array(n * 4)
    this.c1 = new Float32Array(n * 4)
    this.scalars = [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.age, this.life, this.s0, this.s1, this.grav, this.drag]
  }

  emit(p: V3, v: V3, life: number, s0: number, s1: number, c0: readonly number[], c1: readonly number[], grav: number, drag: number): void {
    if (this.count >= this.n) return
    const i = this.count++
    this.px[i] = p[0]
    this.py[i] = p[1]
    this.pz[i] = p[2]
    this.vx[i] = v[0]
    this.vy[i] = v[1]
    this.vz[i] = v[2]
    this.age[i] = 0
    this.life[i] = life
    this.s0[i] = s0
    this.s1[i] = s1
    this.grav[i] = grav
    this.drag[i] = drag
    for (let k = 0; k < 4; k++) {
      this.c0[i * 4 + k] = c0[k] ?? 1
      this.c1[i * 4 + k] = c1[k] ?? 1
    }
  }

  step(dt: number): void {
    let i = 0
    while (i < this.count) {
      this.age[i]! += dt
      if (this.age[i]! >= this.life[i]!) {
        this.kill(i)
        continue
      }
      const d = Math.max(0, 1 - this.drag[i]! * dt)
      this.vx[i]! *= d
      this.vz[i]! *= d
      this.vy[i] = this.vy[i]! * d - this.grav[i]! * dt
      this.px[i]! += this.vx[i]! * dt
      this.py[i]! += this.vy[i]! * dt
      this.pz[i]! += this.vz[i]! * dt
      i++
    }
  }

  private kill(i: number): void {
    const j = --this.count
    if (i === j) return
    for (const a of this.scalars) a[i] = a[j]!
    for (let k = 0; k < 4; k++) {
      this.c0[i * 4 + k] = this.c0[j * 4 + k]!
      this.c1[i * 4 + k] = this.c1[j * 4 + k]!
    }
  }

  clear(): void {
    this.count = 0
  }
}

/** One dynamic quad mesh: fixed capacity, rebuilt by the caller each frame it draws. */
class QuadBatch {
  readonly mesh: Mesh
  readonly pos: Float32Array
  readonly col: Float32Array
  readonly uv: Float32Array
  used = 0
  /** Quads drawn by the last upload (the tail beyond the next upload's count is zeroed once). */
  private last = 0

  constructor(
    scene: Scene,
    name: string,
    readonly cap: number,
    readonly mat: StandardMaterial,
  ) {
    this.pos = new Float32Array(cap * 12)
    this.col = new Float32Array(cap * 16)
    this.uv = new Float32Array(cap * 8)
    const idx = new Uint32Array(cap * 6)
    for (let i = 0; i < cap; i++) {
      const v = i * 4
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6)
      this.uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8)
    }
    this.mesh = new Mesh(name, scene)
    const vd = new VertexData()
    vd.positions = this.pos
    vd.colors = this.col
    vd.uvs = this.uv
    vd.indices = idx
    vd.applyToMesh(this.mesh, true)
    this.mesh.material = mat
    this.mesh.hasVertexAlpha = true
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
    this.mesh.doNotSyncBoundingInfo = true
    this.mesh.metadata = { sroLightning: true }
    this.mesh.setEnabled(false)
  }

  begin(): void {
    this.used = 0
  }

  /** One quad from four corners, one colour. */
  quad(a: V3, b: V3, c: V3, d: V3, r: number, g: number, bl: number, al: number): void {
    if (this.used >= this.cap) return
    const i = this.used++
    this.pos.set(a, i * 12)
    this.pos.set(b, i * 12 + 3)
    this.pos.set(c, i * 12 + 6)
    this.pos.set(d, i * 12 + 9)
    for (let k = 0; k < 4; k++) this.col.set([r, g, bl, al], i * 16 + k * 4)
  }

  /** Uploads what was drawn since begin() (or disables the mesh when nothing was). */
  end(): void {
    const n = this.used
    if (n === 0) {
      if (this.mesh.isEnabled()) this.mesh.setEnabled(false)
      return
    }
    // the unused tail collapses to nothing (degenerate quads). The sub-mesh is never narrowed to the used part: a
    // sub-mesh that no longer covers the whole mesh has no bounding info of its own, and the transparent sort reads it.
    this.pos.fill(0, n * 12, this.last * 12)
    this.last = n
    this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.pos, false, false)
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, this.col, false, false)
    if (!this.mesh.isEnabled()) this.mesh.setEnabled(true)
  }

  dispose(): void {
    this.mesh.dispose(false, false)
  }
}

function material(scene: Scene, name: string, tex: Texture | null, additive: boolean, fog: boolean): StandardMaterial {
  const m = new StandardMaterial(name, scene)
  m.disableLighting = true
  m.emissiveColor = Color3.White()
  m.diffuseColor = Color3.Black()
  m.specularColor = Color3.Black()
  m.backFaceCulling = false
  m.fogEnabled = fog
  m.disableDepthWrite = true
  m.alphaMode = additive ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE
  if (tex) {
    m.diffuseTexture = tex
    m.useAlphaFromDiffuseTexture = true
  }
  return m
}

/** A w × w RGBA texture from f(u, v) → [r, g, b, a] in 0..1 (u, v in -1..1). */
function rawTexture(scene: Scene, w: number, f: (u: number, v: number) => readonly number[]): RawTexture {
  const data = new Uint8Array(w * w * 4)
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const c = f(((x + 0.5) / w) * 2 - 1, ((y + 0.5) / w) * 2 - 1)
      for (let k = 0; k < 4; k++) data[(y * w + x) * 4 + k] = Math.round(255 * Math.max(0, Math.min(1, c[k] ?? 0)))
    }
  }
  const t = RawTexture.CreateRGBATexture(data, w, w, scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
  t.hasAlpha = true
  t.wrapU = Texture.CLAMP_ADDRESSMODE
  t.wrapV = Texture.CLAMP_ADDRESSMODE
  return t
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

export class LightningFx {
  private readonly ribbonsAdd: QuadBatch
  private readonly ribbonsAlpha: QuadBatch
  private readonly spritesAdd: QuadBatch
  private readonly spritesAlpha: QuadBatch
  private readonly rings: QuadBatch
  private readonly scorchBatch: QuadBatch
  private readonly textures: RawTexture[]
  private readonly mats: StandardMaterial[]
  private readonly add = new Particles(CAP.spritesAdd)
  private readonly alpha = new Particles(CAP.spritesAlpha)
  private readonly live: Live[] = []
  private readonly scorches: Scorch[] = []
  private readonly trees: Tree[] = []
  private tier: LightningTier = 'off'
  private reduced = false
  private rng = mulberry32(0x11d)
  private disposed = false
  private scorchDirty = false
  private scorchNextFade = 0
  /** Camera basis of this frame. */
  private readonly cam: V3 = [0, 0, 0]
  private readonly right: V3 = [1, 0, 0]
  private readonly up: V3 = [0, 1, 0]

  constructor(
    readonly scene: Scene,
    private readonly host: LightningFxHost,
  ) {
    const dot = rawTexture(scene, 32, (u, v) => {
      const r = Math.hypot(u, v)
      return [1, 1, 1, (1 - smooth(0, 1, r)) ** 1.5]
    })
    const ring = rawTexture(scene, 64, (u, v) => {
      const r = Math.hypot(u, v)
      const edge = Math.exp(-(((r - 0.9) / 0.07) ** 2))
      const fill = 0.1 * (1 - smooth(0.85, 1, r))
      return [1, 1, 1, Math.min(1, edge + fill)]
    })
    const noise = mulberry32(0x5c0)
    const blot = new Float32Array(8).map(() => 0.75 + 0.35 * noise())
    const scorch = rawTexture(scene, 64, (u, v) => {
      const r = Math.hypot(u, v)
      const a = Math.atan2(v, u)
      // an irregular burnt edge (a few lobes), a darker core, streaks thrown outward
      const lobes = blot[Math.floor(((a + Math.PI) / (2 * Math.PI)) * 8) % 8]!
      const edge = 1 - smooth(0.45 * lobes, 0.95 * lobes, r)
      const streak = 0.35 * Math.max(0, Math.sin(a * 11 + 1.7)) * (1 - smooth(0.3, 1, r))
      const core = 1 - smooth(0, 0.35, r)
      const shade = 0.06 + 0.06 * (1 - core)
      return [shade, shade * 0.85, shade * 0.7, Math.min(0.95, edge * 0.85 + streak + core * 0.15)]
    })
    // a soft line across a ribbon's width (u), so channels and their halos have no hard edges
    const line = rawTexture(scene, 32, u => [1, 1, 1, (1 - smooth(0, 1, Math.abs(u))) ** 1.3])
    this.textures = [dot, ring, scorch, line]
    const mAdd = material(scene, 'lightning:ribbonsAdd', line, true, false)
    const mAlpha = material(scene, 'lightning:ribbonsAlpha', line, false, true)
    const mSpAdd = material(scene, 'lightning:spritesAdd', dot, true, true)
    const mSpAlpha = material(scene, 'lightning:spritesAlpha', dot, false, true)
    const mRing = material(scene, 'lightning:rings', ring, true, false)
    const mScorch = material(scene, 'lightning:scorch', scorch, false, true)
    for (const m of [mRing, mScorch]) m.zOffset = -2
    this.mats = [mAdd, mAlpha, mSpAdd, mSpAlpha, mRing, mScorch]
    this.ribbonsAdd = new QuadBatch(scene, 'lightning:ribbonsAdd', CAP.ribbonsAdd, mAdd)
    this.ribbonsAlpha = new QuadBatch(scene, 'lightning:ribbonsAlpha', CAP.ribbonsAlpha, mAlpha)
    this.spritesAdd = new QuadBatch(scene, 'lightning:spritesAdd', CAP.spritesAdd, mSpAdd)
    this.spritesAlpha = new QuadBatch(scene, 'lightning:spritesAlpha', CAP.spritesAlpha, mSpAlpha)
    this.rings = new QuadBatch(scene, 'lightning:rings', CAP.rings, mRing)
    this.scorchBatch = new QuadBatch(scene, 'lightning:scorch', CAP.scorches, mScorch)
  }

  /** Every mesh, material and texture this owns (fixed; tests check nothing else is ever made). */
  get resources(): { meshes: Mesh[]; materials: StandardMaterial[]; textures: RawTexture[] } {
    return { meshes: this.batches().map(b => b.mesh), materials: [...this.mats], textures: [...this.textures] }
  }

  private batches(): QuadBatch[] {
    return [this.ribbonsAdd, this.ribbonsAlpha, this.spritesAdd, this.spritesAlpha, this.rings, this.scorchBatch]
  }

  /** Live counts (the perf overlay, tests). */
  stats(): { strikes: number; scorches: number; trees: number; particles: number; quads: number } {
    return {
      strikes: this.live.length,
      scorches: this.scorches.length,
      trees: this.trees.length,
      particles: this.add.count + this.alpha.count,
      quads: this.batches().reduce((s, b) => s + (b.mesh.isEnabled() ? b.used : 0), 0),
    }
  }

  setTier(t: LightningTier): void {
    if (t === this.tier) return
    this.tier = t
    const f = TIER_FEATURES[t]
    if (!f.scorch) this.scorches.length = 0
    if (!f.fire) this.trees.length = 0
    if (!f.bursts) {
      this.add.clear()
      this.alpha.clear()
    }
    this.scorchDirty = true
  }

  /** `ui.reduceFlashing`: the bolt shows steadily and dim, without the flicker. */
  setReducedFlashing(on: boolean): void {
    this.reduced = on
  }

  /** A `strike` message (the telegraph begins, or a sky flash). A repeat of a known id is ignored. */
  strike(s: LightningStrike): void {
    if (this.disposed || s.kind === 'sky' || this.live.some(l => l.s.id === s.id)) return
    this.live.push({ s, bolt: null, landed: false, staticAt: 0, staticSeed: s.seed, statics: [], crown: [] })
  }

  /** One frame at server time `now` (ms), `dt` seconds after the last. */
  update(now: number, dt: number, camera: Camera | null): void {
    if (this.disposed) return
    if (camera) this.basis(camera)
    const f = TIER_FEATURES[this.tier]
    const step = Math.min(0.1, Math.max(0, dt))
    for (let i = this.live.length - 1; i >= 0; i--) {
      const l = this.live[i]!
      if (!l.landed && now >= l.s.at) {
        l.landed = true
        this.aftermath(l.s, now)
      }
      if (l.landed && boltDone(l.s, now)) this.live.splice(i, 1)
    }
    if (this.live.length > 8) this.live.splice(0, this.live.length - 8)
    this.add.step(step)
    this.alpha.step(step)
    this.emitTrees(now, step)
    // ribbons: bolts, statics, splits
    const ra = this.ribbonsAdd
    ra.begin()
    this.rings.begin()
    for (const l of this.live) {
      const tl = telegraphLevel(l.s, now)
      if (tl > 0) this.telegraph(l, tl, now, f.staticArcs)
      if (f.bolt && now >= l.s.at) this.bolt(l, now)
    }
    for (const t of this.trees) {
      const k = 1 - (now - t.born) / SPLIT_GLOW_MS
      if (k > 0) for (const sgm of t.split) this.ribbon(ra, sgm.a, sgm.b, 0.35, 1 * k, 0.42 * k, 0.1 * k, 1)
    }
    ra.end()
    this.rings.end()
    // the char on struck trunks
    const rb = this.ribbonsAlpha
    rb.begin()
    for (const t of this.trees) {
      const top = t.ground + Math.min(9, 0.35 * (t.top - t.ground))
      const fade = Math.min(1, Math.max(0, 1 - (now - t.born - FIRE_MS) / SMOKE_TAIL_MS))
      this.ribbon(rb, [t.x, t.ground, t.z], [t.x, top, t.z], 1.5, 0.03, 0.025, 0.02, 0.8 * fade)
    }
    rb.end()
    // flares (the impact glowing during its strokes) and particles
    this.sprites(now)
    this.scorchesUpdate(now)
  }

  // ---- parts ---------------------------------------------------------------------------------------------

  private basis(camera: Camera): void {
    const p = camera.globalPosition
    this.cam[0] = p.x
    this.cam[1] = p.y
    this.cam[2] = p.z
    const m = camera.getViewMatrix().m
    const rl = Math.hypot(m[0]!, m[4]!, m[8]!) || 1
    const ul = Math.hypot(m[1]!, m[5]!, m[9]!) || 1
    this.right[0] = m[0]! / rl
    this.right[1] = m[4]! / rl
    this.right[2] = m[8]! / rl
    this.up[0] = m[1]! / ul
    this.up[1] = m[5]! / ul
    this.up[2] = m[9]! / ul
  }

  /** A camera-facing quad along a → b, `width` metres wide. */
  private ribbon(batch: QuadBatch, a: V3, b: V3, width: number, r: number, g: number, bl: number, al: number): void {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const dz = b[2] - a[2]
    const tx = this.cam[0] - a[0]
    const ty = this.cam[1] - a[1]
    const tz = this.cam[2] - a[2]
    let sx = dy * tz - dz * ty
    let sy = dz * tx - dx * tz
    let sz = dx * ty - dy * tx
    const l = Math.hypot(sx, sy, sz)
    if (!(l > 1e-6)) return
    const h = width / 2 / l
    sx *= h
    sy *= h
    sz *= h
    batch.quad([a[0] - sx, a[1] - sy, a[2] - sz], [a[0] + sx, a[1] + sy, a[2] + sz], [b[0] + sx, b[1] + sy, b[2] + sz], [b[0] - sx, b[1] - sy, b[2] - sz], r, g, bl, al)
  }

  /** The width a channel needs at `p` to stay about two pixels wide (m). */
  private pixelWidth(p: V3): number {
    return Math.hypot(p[0] - this.cam[0], p[1] - this.cam[1], p[2] - this.cam[2]) * 0.0022
  }

  private ground(s: LightningStrike): V3 {
    return [s.pos[0], s.groundY ?? s.pos[1], s.pos[2]]
  }

  private telegraph(l: Live, level: number, now: number, arcs: boolean): void {
    const s = l.s
    if (s.radiusM <= 0) return
    const g = this.ground(s)
    const y = s.kind === 'wall' ? s.pos[1] : g[1]
    // the glow ring, breathing faster as the strike nears
    const pulse = 0.75 + 0.25 * Math.sin(now / (60 - 35 * level))
    this.decal(this.rings, s.pos[0], y + 0.08, s.pos[2], s.radiusM + 0.4, 0, RING[0] * level * pulse, RING[1] * level * pulse, RING[2] * level * pulse, 1, s.kind !== 'wall')
    if (!arcs) return
    if (now >= l.staticAt) {
      l.staticAt = now + 70
      l.staticSeed = (Math.imul(l.staticSeed, 1103515245) + 12345) >>> 0
      l.statics = staticArcs(l.staticSeed, [s.pos[0], y, s.pos[2]], s.radiusM * 0.8, 2 + Math.round(4 * level), 0.6 + 0.8 * level)
      // St. Elmo's fire on what will be struck: a tree's crown, a tower's top
      l.crown = s.kind === 'tree' || s.kind === 'tower' ? staticArcs(l.staticSeed ^ 0x55, s.pos, 1.5, 2 + Math.round(3 * level), 1.2) : []
    }
    for (const a of [...l.statics, ...l.crown]) {
      const b = a.glow * level
      this.ribbon(this.ribbonsAdd, a.a, a.b, Math.max(0.05, this.pixelWidth(a.a) * 0.8), STATIC[0] * b, STATIC[1] * b, STATIC[2] * b, 1)
    }
  }

  private bolt(l: Live, now: number): void {
    const st = boltState(l.s, now)
    if (st.glow <= 0) return
    if (!l.bolt) l.bolt = generateBolt(l.s.seed, l.s.pos)
    const glow = this.reduced ? 0.35 : Math.min(1, st.glow)
    const segs = l.bolt.segments
    for (let i = 0; i < segs.length; i++) {
      const sg = segs[i]!
      if (sg.depth > 0 && !st.forks && !this.reduced) continue
      const w = Math.max(0.25, this.pixelWidth(sg.a)) * sg.width
      const b = glow * sg.glow
      this.ribbon(this.ribbonsAdd, sg.a, sg.b, w * 6, HALO[0] * b * 0.22, HALO[1] * b * 0.22, HALO[2] * b * 0.22, 1)
      this.ribbon(this.ribbonsAdd, sg.a, sg.b, w, CORE[0] * b, CORE[1] * b, CORE[2] * b, 1)
    }
  }

  /** A quad lying on the ground at (x, y, z) (tilted to the terrain unless `flat`), `size` metres across. */
  private decal(batch: QuadBatch, x: number, y: number, z: number, size: number, rot: number, r: number, g: number, b: number, a: number, tilt: boolean, n?: V3): void {
    let nx = 0
    let ny = 1
    let nz = 0
    if (n) [nx, ny, nz] = n
    else if (tilt) [nx, ny, nz] = this.normalAt(x, y, z)
    // a tangent frame on the plane
    let tx = Math.cos(rot)
    let tz = Math.sin(rot)
    let ty = -(nx * tx + nz * tz) / (ny || 1)
    const tl = Math.hypot(tx, ty, tz) || 1
    tx /= tl
    ty /= tl
    tz /= tl
    const bx = ny * tz - nz * ty
    const by = nz * tx - nx * tz
    const bz = nx * ty - ny * tx
    const h = size
    const c = (u: number, v: number): V3 => [x + (tx * u + bx * v) * h, y + (ty * u + by * v) * h, z + (tz * u + bz * v) * h]
    batch.quad(c(-1, -1), c(1, -1), c(1, 1), c(-1, 1), r, g, b, a)
  }

  private normalAt(x: number, y: number, z: number): V3 {
    const hx = this.host.heightAt(x + 1, z, y)
    const hz = this.host.heightAt(x, z + 1, y)
    const h0 = this.host.heightAt(x, z, y)
    if (hx === null || hz === null || h0 === null) return [0, 1, 0]
    const nx = -(hx - h0)
    const nz = -(hz - h0)
    const l = Math.hypot(nx, 1, nz)
    return [nx / l, 1 / l, nz / l]
  }

  /** The strike landed: what it leaves, by kind and tier. */
  private aftermath(s: LightningStrike, now: number): void {
    const f = TIER_FEATURES[this.tier]
    const g = this.ground(s)
    const wet = this.host.wetness()
    const n = (k: number) => Math.round(k * f.particles)
    if (f.scorch) {
      if (s.kind === 'wall' || s.kind === 'tower') this.addScorch(s.pos[0], s.pos[1] + 0.05, s.pos[2], 1.8, now, [0, 1, 0])
      else this.addScorch(g[0], g[1] + 0.04, g[2], s.kind === 'tree' ? 1.6 : 2.2, now)
    }
    if (!f.bursts) return
    const r = this.rng
    const sparks = (at: V3, k: number) => {
      for (let i = 0; i < n(k); i++) {
        const a = r() * Math.PI * 2
        const sp = 4 + 10 * r()
        this.add.emit(at, [Math.cos(a) * sp, 2 + 8 * r(), Math.sin(a) * sp], 0.25 + 0.4 * r(), 0.12, 0.04, [0.8, 0.9, 1, 1], [0.4, 0.5, 1, 0], 9.8, 1.5)
      }
    }
    if (s.kind === 'ground' || s.kind === 'entity') {
      sparks(g, 40)
      // thrown dirt and clods
      for (let i = 0; i < n(55); i++) {
        const a = r() * Math.PI * 2
        const sp = 2 + 6 * r()
        const c = 0.18 + 0.12 * r()
        this.alpha.emit([g[0] + Math.cos(a) * 0.4, g[1] + 0.1, g[2] + Math.sin(a) * 0.4], [Math.cos(a) * sp, 4 + 7 * r(), Math.sin(a) * sp], 0.9 + 0.8 * r(), 0.12 + 0.18 * r(), 0.1, [c, c * 0.8, c * 0.6, 1], [c, c * 0.8, c * 0.6, 0.6], 14, 0.4)
      }
      // a puff of dust
      for (let i = 0; i < n(14); i++) {
        const a = r() * Math.PI * 2
        this.alpha.emit([g[0], g[1] + 0.3, g[2]], [Math.cos(a) * 2.5, 1 + r(), Math.sin(a) * 2.5], 1.6 + r(), 0.8, 2.6, [0.42, 0.38, 0.32, 0.45], [0.45, 0.42, 0.38, 0], -0.3, 1.2)
      }
      if (wet > 0.3) this.steam(g, wet, n)
    } else if (s.kind === 'tree') {
      sparks(s.pos, 30)
      this.addTree(s, now)
      if (wet > 0.3) this.steam(g, wet * 0.6, n)
    } else {
      // a wall walk or a tower top: stone chips fly, dust falls down the face
      sparks(s.pos, 35)
      for (let i = 0; i < n(45); i++) {
        const a = r() * Math.PI * 2
        const sp = 3 + 7 * r()
        const c = 0.45 + 0.2 * r()
        this.alpha.emit(s.pos, [Math.cos(a) * sp, 3 + 6 * r(), Math.sin(a) * sp], 1.2 + 0.8 * r(), 0.1 + 0.12 * r(), 0.08, [c, c * 0.97, c * 0.9, 1], [c, c, c, 0.8], 12, 0.2)
      }
      for (let i = 0; i < n(50); i++) {
        const a = r() * Math.PI * 2
        const d = r() * 2.5
        this.alpha.emit([s.pos[0] + Math.cos(a) * d, s.pos[1] - r() * 0.5, s.pos[2] + Math.sin(a) * d], [Math.cos(a) * 0.6, -0.5 - 1.5 * r(), Math.sin(a) * 0.6], 3 + 2 * r(), 0.5, 1.8, [0.55, 0.52, 0.47, 0.5], [0.55, 0.52, 0.47, 0], 1.2, 0.6)
      }
    }
  }

  /** Steam off wet ground: an expanding ring and a white plume. */
  private steam(g: V3, wet: number, n: (k: number) => number): void {
    const r = this.rng
    for (let i = 0; i < n(24); i++) {
      const a = (i / 24) * Math.PI * 2 + r() * 0.2
      // the ring: particles thrown outward along the ground, growing
      this.alpha.emit([g[0], g[1] + 0.15, g[2]], [Math.cos(a) * 5, 0.3, Math.sin(a) * 5], 1.4, 0.4, 1.6, [0.78, 0.8, 0.83, 0.3 * wet], [0.78, 0.8, 0.83, 0], 0, 2.4)
    }
    for (let i = 0; i < n(16); i++) {
      this.alpha.emit([g[0] + (r() - 0.5), g[1] + 0.2, g[2] + (r() - 0.5)], [(r() - 0.5) * 0.6, 1.5 + 1.5 * r(), (r() - 0.5) * 0.6], 2 + r(), 0.6, 2.8, [0.8, 0.82, 0.85, 0.28 * wet], [0.8, 0.82, 0.85, 0], -0.4, 0.8)
    }
  }

  private addScorch(x: number, y: number, z: number, size: number, now: number, n?: V3): void {
    if (this.scorches.length >= CAP.scorches) this.scorches.shift()
    const [nx, ny, nz] = n ?? this.normalAt(x, y, z)
    this.scorches.push({ x, y, z, nx, ny, nz, size: size * (0.85 + 0.3 * this.rng()), rot: this.rng() * Math.PI * 2, born: now })
    this.scorchDirty = true
  }

  private addTree(s: LightningStrike, now: number): void {
    if (this.trees.length >= CAP.trees) this.trees.shift()
    const g = this.ground(s)
    const top = s.pos[1]
    const splitTop = g[1] + Math.min(10, 0.4 * (top - g[1]))
    const rng = mulberry32(s.seed ^ 0x7ee)
    // the split: a jagged line up the trunk, on the side facing the bolt's lean
    const pts: V3[] = []
    for (let i = 0; i <= 8; i++) pts.push([g[0] + (rng() - 0.5) * 0.25, g[1] + 0.3 + ((splitTop - g[1] - 0.3) * i) / 8, g[2] + (rng() - 0.5) * 0.25])
    const split: BoltSegment[] = []
    for (let i = 0; i < 8; i++) split.push({ a: pts[i]!, b: pts[i + 1]!, width: 0.3, glow: 1, depth: 2 })
    this.trees.push({ x: g[0], z: g[2], ground: g[1], top, born: now, split, carry: [0, 0, 0] })
  }

  /** The burning trees' fire, embers and smoke for this frame. */
  private emitTrees(now: number, dt: number): void {
    const f = TIER_FEATURES[this.tier]
    const r = this.rng
    for (let i = this.trees.length - 1; i >= 0; i--) {
      const t = this.trees[i]!
      const age = now - t.born
      if (age > FIRE_MS + SMOKE_TAIL_MS) {
        this.trees.splice(i, 1)
        continue
      }
      const lv = fireLevels(age)
      const span = Math.min(12, 0.45 * (t.top - t.ground))
      const at = (): V3 => [t.x + (r() - 0.5) * 1.2, t.ground + 1 + r() * span, t.z + (r() - 0.5) * 1.2]
      const rates = [45 * lv.fire, 14 * lv.embers, 9 * lv.smoke].map(x => x * f.particles * dt)
      for (let k = 0; k < 3; k++) {
        t.carry[k]! += rates[k]!
        while (t.carry[k]! >= 1) {
          t.carry[k]! -= 1
          if (k === 0) this.add.emit(at(), [(r() - 0.5) * 0.6, 1.5 + 2 * r(), (r() - 0.5) * 0.6], 0.6 + 0.5 * r(), 0.9 + 0.6 * r(), 0.2, [1, 0.55, 0.15, 0.9], [0.9, 0.2, 0.05, 0], -1.5, 0.5)
          else if (k === 1) this.add.emit(at(), [(r() - 0.5) * 1.5, 2 + 3 * r(), (r() - 0.5) * 1.5], 2 + 2 * r(), 0.08, 0.04, [1, 0.6, 0.2, 1], [1, 0.3, 0.05, 0], -0.6, 0.3)
          else {
            const p = at()
            p[1] += span * 0.4
            const c = 0.12 + 0.1 * r()
            this.alpha.emit(p, [(r() - 0.5) * 0.8 + 0.6, 1.8 + r(), (r() - 0.5) * 0.8], 5 + 3 * r(), 1.2, 6, [c, c, c, 0.45], [c + 0.1, c + 0.1, c + 0.1, 0], -0.2, 0.15)
          }
        }
      }
    }
  }

  /** The impact flares during the strokes, then every particle, as camera-facing quads. */
  private sprites(now: number): void {
    const f = TIER_FEATURES[this.tier]
    const sa = this.spritesAdd
    sa.begin()
    if (f.bolt) {
      for (const l of this.live) {
        if (now < l.s.at) continue
        const b = this.reduced ? 0.25 : Math.min(1, boltState(l.s, now).glow)
        if (b <= 0) continue
        const size = 6 + 0.01 * Math.hypot(l.s.pos[0] - this.cam[0], l.s.pos[2] - this.cam[2])
        this.sprite(sa, l.s.pos, size, 0.5 * b, 0.56 * b, 0.7 * b, 1)
      }
    }
    this.particles(sa, this.add)
    sa.end()
    const sb = this.spritesAlpha
    sb.begin()
    this.particles(sb, this.alpha)
    sb.end()
  }

  private particles(batch: QuadBatch, p: Particles): void {
    for (let i = 0; i < p.count; i++) {
      const k = p.age[i]! / p.life[i]!
      const size = p.s0[i]! + (p.s1[i]! - p.s0[i]!) * k
      const c = (j: number) => p.c0[i * 4 + j]! + (p.c1[i * 4 + j]! - p.c0[i * 4 + j]!) * k
      this.sprite(batch, [p.px[i]!, p.py[i]!, p.pz[i]!], size, c(0), c(1), c(2), c(3))
    }
  }

  private sprite(batch: QuadBatch, p: V3, size: number, r: number, g: number, b: number, a: number): void {
    const h = size / 2
    const rx = this.right[0] * h
    const ry = this.right[1] * h
    const rz = this.right[2] * h
    const ux = this.up[0] * h
    const uy = this.up[1] * h
    const uz = this.up[2] * h
    batch.quad([p[0] - rx - ux, p[1] - ry - uy, p[2] - rz - uz], [p[0] + rx - ux, p[1] + ry - uy, p[2] + rz - uz], [p[0] + rx + ux, p[1] + ry + uy, p[2] + rz + uz], [p[0] - rx + ux, p[1] - ry + uy, p[2] - rz + uz], r, g, b, a)
  }

  /** The scorch marks: rebuilt when one is added and about twice a second while any fades. */
  private scorchesUpdate(now: number): void {
    for (let i = this.scorches.length - 1; i >= 0; i--) if (scorchAlpha(now - this.scorches[i]!.born) <= 0) {
      this.scorches.splice(i, 1)
      this.scorchDirty = true
    }
    if (!this.scorchDirty && now < this.scorchNextFade) return
    this.scorchDirty = false
    this.scorchNextFade = now + 500
    const b = this.scorchBatch
    b.begin()
    for (const s of this.scorches) this.decal(b, s.x, s.y, s.z, s.size, s.rot, 1, 1, 1, scorchAlpha(now - s.born), false, [s.nx, s.ny, s.nz])
    b.end()
  }

  /** Drops every strike and effect (a world change); the meshes stay for the next ones. */
  clear(): void {
    this.live.length = 0
    this.scorches.length = 0
    this.trees.length = 0
    this.add.clear()
    this.alpha.clear()
    for (const b of this.batches()) {
      b.begin()
      b.end()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clear()
    for (const b of this.batches()) b.dispose()
    for (const m of this.mats) m.dispose(true, false)
    for (const t of this.textures) t.dispose()
  }
}

/**
 * The lightning tornado's funnel on the client (docs/WEATHER.md §13.7). Menacing but cheap and leak-proof on purpose,
 * like StormFx: FIVE meshes, five materials and four textures, made once per graphics tier and rebuilt in place every
 * frame from fixed typed arrays; nothing is created per frame, per bolt, per arc or per piece of debris, and `dispose`
 * frees all fourteen objects (the feature makes one TornadoFx when a tornado appears and disposes it when it is gone).
 *
 * - **Funnel** (alpha blended): 2-4 nested lathe shells around a snaking axis, from a nearly opaque dark core to ragged
 *   dusty outer shells (turbulent ripples, bulges travelling up, a rim lighter than the face so it reads as a volume),
 *   flaring at the foot and into a rotating **wall cloud** (a wide, lumpy, darker bowl in the same mesh) that fades into
 *   the sky. During the warning the wall cloud lowers and the funnel snakes down out of it; after the lift it rises away.
 *   Lit from inside by its own arcs.
 * - **Debris sprites** (alpha blended, one atlas): a thick churning dust skirt at its foot, rain and dust bands spiralling
 *   in along the ground, and leaves, straw and grit spiralling up, then flung far out on a ballistic arc (stretched along
 *   their motion, a cheap motion blur).
 * - **Chunks** (thin instances of one low-poly box, one draw call): planks, branches, rocks, clods and straw, tumbling up
 *   the funnel and thrown out like the sprites, stretched along their motion. Anything behind the funnel fades out (its
 *   core hides it), since translucent meshes cannot depth-sort against each other.
 * - **Arcs** (additive): jagged arcs flicker inside it and out into the debris; a bolt the tornado throws
 *   (`strike.source`) gets an arc from the funnel's side to where it lands.
 * - **Torn ground** (alpha blended, depth tested): a dark ragged trail along where it walked, fading over TRAIL_MS.
 * - **Tiers**: Low = two shells and a little of everything; Medium = three shells; High = four shells and twice the
 *   debris. Always five draw calls. Brightness follows the sky (night, storm clouds) and the lightning flash.
 */
import { Color3, Constants, Mesh, RawTexture, StandardMaterial, Texture, VertexBuffer, VertexData, type Camera, type Scene } from '@babylonjs/core'
import { TORNADO_TABLE, mulberry32 } from '@sro/shared'

type V3 = [number, number, number]

export type TornadoTier = 'low' | 'medium' | 'high'

export interface TierSpec {
  /** Funnel lathe shells, segments around and rings up; rings of the wall cloud. */
  shells: number
  seg: number
  rings: number
  cloudRings: number
  /** Dust-skirt puffs, spiralling rain/dust bands, small sprite debris, instanced chunks. */
  puffs: number
  bands: number
  bits: number
  chunks: number
  /** Arcs inside it at once; torn-ground trail points. */
  arcs: number
  trail: number
}

export const TORNADO_TIERS: Readonly<Record<TornadoTier, Readonly<TierSpec>>> = {
  low: { shells: 2, seg: 18, rings: 12, cloudRings: 4, puffs: 14, bands: 10, bits: 36, chunks: 14, arcs: 2, trail: 40 },
  medium: { shells: 3, seg: 28, rings: 18, cloudRings: 6, puffs: 30, bands: 26, bits: 110, chunks: 48, arcs: 4, trail: 72 },
  high: { shells: 4, seg: 36, rings: 24, cloudRings: 8, puffs: 48, bands: 44, bits: 200, chunks: 120, arcs: 6, trail: 96 },
}

/** Everything one TornadoFx holds in the scene (tests): nothing else is ever created. */
export const TORNADO_RESOURCES = { meshes: 5, materials: 5, textures: 4 } as const

/** Strike arcs drawn at once (the newest), and how long one shows (ms). */
export const MAX_STRIKE_ARCS = 4
export const STRIKE_ARC_MS = 420
const ARC_SEGMENTS = 10
/** Inner arcs re-shape this often (ms). */
const ARC_SHAPE_MS = 90
/** The torn-ground trail: a point every TRAIL_STEP_M, each fading over TRAIL_MS; half its width (m, strength 1). */
export const TRAIL_STEP_M = 3
export const TRAIL_MS = 80_000
const TRAIL_HALF_M = 6
/** Debris gravity (m/s²). */
const GRAVITY = 9.8
const TAU = Math.PI * 2

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
  /** Ground height near (x, z) (the torn-ground trail hugs it); absent = the foot's height. */
  ground?: (x: number, z: number, y: number) => number
}

/** A piece that spirals up the funnel, then is flung out on a ballistic arc (sprites and chunks alike). */
interface Flung {
  kind: number
  rk: number
  rAdd: number
  hMax: number
  period: number
  off: number
  theta: number
  omega: number
  /** Share of its life spiralling up; the rest it flies (and lies a moment where it lands). */
  rise: number
  /** Release speeds (m/s): outward, along the spin, upward; gravity scale (leaves fall slowly). */
  out: number
  tan: number
  up: number
  grav: number
  size: number
  spin: number
  /** Chunks: tumble axis (unit) and dimensions (m). */
  ax: number
  ay: number
  az: number
  dx: number
  dy: number
  dz: number
  r: number
  g: number
  b: number
}

interface Puff {
  theta: number
  omega: number
  r: number
  grow: number
  rise: number
  size: number
  period: number
  off: number
  spin: number
  tone: number
}

interface Band {
  theta: number
  r0: number
  h0: number
  rise: number
  turns: number
  period: number
  off: number
  len: number
  width: number
  dust: number
}

interface StrikeArc {
  to: V3
  at: number
  live: boolean
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Tileable value noise on a lattice periodic over `wx` cells across and `wy` cells down. */
function valueNoise(rng: () => number, wx: number, wy = wx): (x: number, y: number) => number {
  const g = new Float32Array(wx * wy)
  for (let i = 0; i < g.length; i++) g[i] = rng()
  const at = (x: number, y: number) => g[(((y % wy) + wy) % wy) * wx + (((x % wx) + wx) % wx)]!
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

function rawTexture(scene: Scene, data: Uint8Array, w: number, h: number, mips: boolean, wrap: boolean): RawTexture {
  const t = RawTexture.CreateRGBATexture(data, w, h, scene, mips, false, mips ? Texture.TRILINEAR_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE)
  t.hasAlpha = true
  t.wrapU = wrap ? Texture.WRAP_ADDRESSMODE : Texture.CLAMP_ADDRESSMODE
  t.wrapV = wrap ? Texture.WRAP_ADDRESSMODE : Texture.CLAMP_ADDRESSMODE
  return t
}

/** The funnel's streaks: noise stretched along the turn (u), tileable both ways; contrasty grey, ragged alpha. */
function streakTexture(scene: Scene, seed: number): RawTexture {
  const w = 128
  const h = 128
  const data = new Uint8Array(w * h * 4)
  const n1 = valueNoise(mulberry32(seed), 4, 8)
  const n2 = valueNoise(mulberry32(seed ^ 0x9e37), 8, 16)
  const n3 = valueNoise(mulberry32(seed ^ 0x51ed), 16, 32)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w
      const v = y / h
      const f = 0.5 * n1(u * 4, v * 8) + 0.3 * n2(u * 8, v * 16) + 0.2 * n3(u * 16, v * 32)
      const lum = 0.3 + 0.85 * f
      const a = smooth(0.08, 0.62, f) * 0.6 + 0.4
      const i = (y * w + x) * 4
      data[i] = data[i + 1] = data[i + 2] = Math.min(255, Math.round(255 * lum))
      data[i + 3] = Math.round(255 * a)
    }
  }
  return rawTexture(scene, data, w, h, true, true)
}

/** Atlas cells (32² each, eight in a row). */
const CELL = { puff: 0, leaf: 1, leafDry: 2, straw: 3, grit: 4, streak: 5 } as const
const CELLS = 8

/** The debris atlas: a dust puff, a green leaf, a dry leaf, a straw/twig, grit, a soft streak (bands). */
function debrisTexture(scene: Scene): RawTexture {
  const c = 32
  const w = c * CELLS
  const data = new Uint8Array(w * c * 4)
  const put = (cell: number, x: number, y: number, r: number, g: number, b: number, a: number) => {
    const i = (y * w + x + cell * c) * 4
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = Math.round(255 * Math.max(0, Math.min(1, a)))
  }
  const puffNoise = valueNoise(mulberry32(7), 8)
  for (let y = 0; y < c; y++) {
    for (let x = 0; x < c; x++) {
      const u = ((x + 0.5) / c) * 2 - 1
      const v = ((y + 0.5) / c) * 2 - 1
      const d = Math.hypot(u, v)
      const n = puffNoise(x / 4, y / 4)
      put(CELL.puff, x, y, 150, 134, 112, (1 - d) ** 1.3 * (0.55 + 0.45 * n) * 1.2)
      const le = Math.hypot(u / 0.9, v / 0.42)
      const rib = Math.abs(v) < 0.06 && Math.abs(u) < 0.85 ? 0.7 : 1
      const leafA = le < 1 ? 1 - smooth(0.85, 1, le) : 0
      put(CELL.leaf, x, y, Math.round(104 * rib), Math.round(122 * rib), Math.round(48 * rib), leafA)
      put(CELL.leafDry, x, y, Math.round(170 * rib), Math.round(106 * rib), Math.round(40 * rib), leafA)
      const t1 = Math.abs(u - v) / Math.SQRT2
      const t2 = Math.abs(u + v * 0.3 - 0.35) < 0.05 && u > 0.1 && u < 0.6 ? 1 : 0
      put(CELL.straw, x, y, 150, 124, 70, Math.max(d < 0.95 ? 1 - smooth(0.05, 0.11, t1) : 0, t2))
      put(CELL.grit, x, y, 96, 80, 62, (1 - smooth(0.3, 0.75, d + 0.2 * (n - 0.5))) * 1)
      put(CELL.streak, x, y, 220, 224, 230, Math.exp(-((u / 0.28) ** 2)) * Math.sin(Math.PI * ((v + 1) / 2)) ** 0.8)
    }
  }
  return rawTexture(scene, data, w, c, true, false)
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
  return rawTexture(scene, data, w, w, false, false)
}

/** Torn ground: dark earth with gouges along the length (v, tileable), ragged edges across (u). */
function scarTexture(scene: Scene, seed: number): RawTexture {
  const w = 64
  const data = new Uint8Array(w * w * 4)
  const n1 = valueNoise(mulberry32(seed ^ 0x5ca7), 8)
  const n2 = valueNoise(mulberry32(seed ^ 0x2b1d), 16)
  const n3 = valueNoise(mulberry32(seed ^ 0x6e0f), 16, 2)
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w
      const v = y / w
      const edge = Math.abs(u * 2 - 1) + 0.28 * (n1(2, v * 8) - 0.5) + 0.12 * (n2(u * 16, v * 16) - 0.5)
      const gouge = n3(u * 16, v * 2)
      const lum = 0.45 + 0.55 * gouge
      const i = (y * w + x) * 4
      data[i] = Math.round(78 * lum)
      data[i + 1] = Math.round(60 * lum)
      data[i + 2] = Math.round(44 * lum)
      data[i + 3] = Math.round(255 * (1 - smooth(0.5, 0.95, edge)) * (0.7 + 0.3 * n1(u * 8, v * 8)))
    }
  }
  return rawTexture(scene, data, w, w, true, true)
}

function material(name: string, scene: Scene, tex: RawTexture | null, additive: boolean): StandardMaterial {
  const m = new StandardMaterial(name, scene)
  m.disableLighting = true
  m.emissiveColor = Color3.White()
  m.diffuseColor = Color3.Black()
  m.specularColor = Color3.Black()
  m.backFaceCulling = false
  m.fogEnabled = false
  m.disableDepthWrite = true
  m.alphaMode = additive ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE
  if (tex) {
    m.diffuseTexture = tex
    m.useAlphaFromDiffuseTexture = true
  }
  return m
}

/** A mesh of `quads` free quads (4 vertices each) with updatable positions, colours and UVs. */
function quadMesh(name: string, scene: Scene, quads: number, mat: StandardMaterial, order: number): { mesh: Mesh; pos: Float32Array; col: Float32Array; uv: Float32Array } {
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
  prepare(mesh, mat, order)
  return { mesh, pos, col, uv }
}

function prepare(mesh: Mesh, mat: StandardMaterial, order: number): void {
  mesh.material = mat
  mesh.hasVertexAlpha = true
  mesh.isPickable = false
  mesh.alwaysSelectAsActiveMesh = true
  mesh.doNotSyncBoundingInfo = true
  // the tornado's translucent layers in a fixed order: ground scar, funnel, chunks, sprites, arcs
  mesh.alphaIndex = order
  mesh.metadata = { sroTornado: true }
  // always enabled (the world's EnabledMeshCandidates list then always holds it); shown and hidden with isVisible
  mesh.isVisible = false
}

/** One box (24 vertices, a face shade baked into the vertex colour), the shape every chunk is an instance of. */
function boxGeometry(): VertexData {
  const pos: number[] = []
  const col: number[] = []
  const idx: number[] = []
  // +Y, -Y, +X, -X, +Z, -Z: corners in a winding, and the face's shade
  const faces: [number[], number][] = [
    [[-1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1], 1],
    [[-1, -1, -1, -1, -1, 1, 1, -1, 1, 1, -1, -1], 0.42],
    [[1, -1, -1, 1, -1, 1, 1, 1, 1, 1, 1, -1], 0.78],
    [[-1, -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1], 0.6],
    [[-1, -1, 1, -1, 1, 1, 1, 1, 1, 1, -1, 1], 0.7],
    [[-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1], 0.52],
  ]
  for (const [c, shade] of faces) {
    const b = pos.length / 3
    for (let k = 0; k < 12; k++) pos.push(c[k]! * 0.5)
    for (let k = 0; k < 4; k++) col.push(shade, shade, shade, 1)
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  const vd = new VertexData()
  vd.positions = pos
  vd.colors = col
  vd.indices = idx
  return vd
}

/** Chunk kinds: dimensions (m) and colours. */
const CHUNKS = [
  { name: 'plank', dims: [1.9, 0.1, 0.32], rgb: [0.5, 0.36, 0.22] },
  { name: 'branch', dims: [1.7, 0.12, 0.12], rgb: [0.3, 0.22, 0.15] },
  { name: 'rock', dims: [0.5, 0.42, 0.46], rgb: [0.42, 0.41, 0.39] },
  { name: 'clod', dims: [0.6, 0.45, 0.55], rgb: [0.3, 0.24, 0.17] },
  { name: 'straw', dims: [0.7, 0.32, 0.45], rgb: [0.7, 0.6, 0.32] },
] as const

export class TornadoFx {
  readonly tier: TornadoTier
  private readonly spec: TierSpec
  private readonly t = TORNADO_TABLE
  // funnel and wall cloud
  private readonly funnel: Mesh
  private readonly funnelMat: StandardMaterial
  private readonly streaks: RawTexture
  private readonly fPos: Float32Array
  private readonly fUv: Float32Array
  private readonly fCol: Float32Array
  /** Each vertex's own colour and alpha before the frame's shading and silhouette. */
  private readonly fBase: Float32Array
  private readonly cosA: Float32Array
  private readonly sinA: Float32Array
  /** The inner shell's rings this frame (axis offset, radius, height): occlusion and the arcs use them. */
  private readonly ringOX: Float32Array
  private readonly ringOZ: Float32Array
  private readonly ringR: Float32Array
  // debris sprites
  private readonly spriteMesh: Mesh
  private readonly spriteMat: StandardMaterial
  private readonly atlas: RawTexture
  private readonly sPos: Float32Array
  private readonly sCol: Float32Array
  private readonly sUv: Float32Array
  private readonly sCap: number
  private readonly bits: Flung[] = []
  private readonly puffs: Puff[] = []
  private readonly bands: Band[] = []
  private sUsed = 0
  private sLast = 0
  // chunks (thin instances)
  private readonly chunkMesh: Mesh
  private readonly chunkMat: StandardMaterial
  private readonly cMat: Float32Array
  private readonly cCol: Float32Array
  private readonly chunks: Flung[] = []
  private cUsed = 0
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
  private arcsUntil = 0
  private readonly arcOn: Uint8Array
  private readonly arcLine: Float32Array
  private readonly arcJag: Float32Array
  private readonly strikeJag = new Float32Array(ARC_SEGMENTS * 3)
  private readonly strikeArcs: StrikeArc[] = []
  private arcGlow = 0
  // torn ground
  private readonly trailMesh: Mesh
  private readonly trailMat: StandardMaterial
  private readonly scar: RawTexture
  private readonly tPos: Float32Array
  private readonly tCol: Float32Array
  private readonly tUv: Float32Array
  /** Ring buffer of trail points: x, z, left y, right y, side x, side z, distance along; and their times. */
  private readonly tPt: Float32Array
  private readonly tAt: Float64Array
  private tHead = 0
  private tCount = 0
  private tDist = 0
  // per-frame scratch (no allocation in the frame)
  private readonly p0: V3 = [0, 0, 0]
  private readonly p1: V3 = [0, 0, 0]
  private readonly q0: V3 = [0, 0, 0]
  private readonly q1: V3 = [0, 0, 0]
  private readonly vel: V3 = [0, 0, 0]
  private shH = 0
  private shR = 0
  private axX = 0
  private axZ = 0
  /** Unit XZ from the funnel to the eye, and whether the eye stands inside it. */
  private eyeX = 0
  private eyeZ = 1
  private eyeIn = false
  private height = 0
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
    // ---- funnel and wall cloud
    this.streaks = streakTexture(scene, seed)
    this.funnelMat = material('tornado:funnel', scene, this.streaks, false)
    const ring = spec.seg + 1
    this.cosA = new Float32Array(ring)
    this.sinA = new Float32Array(ring)
    for (let i = 0; i < ring; i++) {
      this.cosA[i] = Math.cos((i / spec.seg) * TAU)
      this.sinA[i] = Math.sin((i / spec.seg) * TAU)
    }
    this.ringOX = new Float32Array(spec.rings)
    this.ringOZ = new Float32Array(spec.rings)
    this.ringR = new Float32Array(spec.rings)
    const verts = (spec.shells * spec.rings + spec.cloudRings) * ring
    this.fPos = new Float32Array(verts * 3)
    this.fUv = new Float32Array(verts * 2)
    this.fCol = new Float32Array(verts * 4)
    const base = (this.fBase = new Float32Array(verts * 4))
    const idx: number[] = []
    const grid = (row0: number, rows: number) => {
      for (let j = 0; j + 1 < rows; j++) {
        for (let i = 0; i < spec.seg; i++) {
          const v = (row0 + j) * ring + i
          idx.push(v, v + ring, v + 1, v + 1, v + ring, v + ring + 1)
        }
      }
    }
    for (let s = 0; s < spec.shells; s++) {
      const outer = spec.shells > 1 ? s / (spec.shells - 1) : 1
      for (let j = 0; j < spec.rings; j++) {
        const h = j / (spec.rings - 1)
        // a dark, nearly opaque core; ragged dusty outer shells; dust brown low down, slate grey up high
        const a = smooth(0, 0.05, h) * (1 - smooth(0.9 - 0.12 * outer, 1, h)) * (0.97 - 0.42 * outer)
        const dustK = (1 - smooth(0, 0.38, h)) * (0.35 + 0.65 * outer)
        const grey = 0.09 + 0.15 * outer + 0.03 * h
        const r = grey + (0.42 - grey) * dustK
        const g = grey + 0.005 + (0.34 - grey) * dustK
        const b = grey + 0.015 + (0.25 - grey) * dustK
        for (let i = 0; i < ring; i++) base.set([r, g, b, a], ((s * spec.rings + j) * ring + i) * 4)
      }
      grid(s * spec.rings, spec.rings)
    }
    const c0 = spec.shells * spec.rings
    for (let j = 0; j < spec.cloudRings; j++) {
      const u = j / (spec.cloudRings - 1)
      const a = (1 - smooth(0.5, 1, u)) * 0.93
      const grey = 0.12 + 0.1 * u
      for (let i = 0; i < ring; i++) base.set([grey, grey + 0.006, grey + 0.02, a], ((c0 + j) * ring + i) * 4)
    }
    grid(c0, spec.cloudRings)
    this.fCol.set(base)
    this.funnel = new Mesh('tornado:funnel', scene)
    const vd = new VertexData()
    vd.positions = this.fPos
    vd.uvs = this.fUv
    vd.colors = this.fCol
    vd.indices = idx
    vd.applyToMesh(this.funnel, true)
    prepare(this.funnel, this.funnelMat, 1)
    // ---- debris sprites: the skirt, the bands, the flung bits
    this.atlas = debrisTexture(scene)
    this.spriteMat = material('tornado:debris', scene, this.atlas, false)
    this.sCap = spec.puffs + spec.bands + spec.bits
    const d = quadMesh('tornado:debris', scene, this.sCap, this.spriteMat, 3)
    this.spriteMesh = d.mesh
    this.sPos = d.pos
    this.sCol = d.col
    this.sUv = d.uv
    for (let i = 0; i < spec.puffs; i++) {
      this.puffs.push({ theta: rng() * TAU, omega: 0.7 + rng() * 0.7, r: 2 + rng() * 9, grow: 4 + rng() * 12, rise: 2 + rng() * 10, size: 5 + rng() * 8, period: 3 + rng() * 4, off: rng(), spin: (rng() - 0.5) * 1.6, tone: 0.75 + rng() * 0.35 })
    }
    for (let i = 0; i < spec.bands; i++) {
      this.bands.push({ theta: rng() * TAU, r0: 20 + rng() * 28, h0: 0.4 + rng() * 2.5, rise: 1 + rng() * 9, turns: 1.6 + rng() * 2.2, period: 2.4 + rng() * 2.6, off: rng(), len: 3 + rng() * 5, width: 0.22 + rng() * 0.25, dust: rng() })
    }
    for (let i = 0; i < spec.bits; i++) {
      const k = rng()
      const kind = k < 0.32 ? CELL.leaf : k < 0.55 ? CELL.leafDry : k < 0.78 ? CELL.grit : CELL.straw
      const light = kind === CELL.leaf || kind === CELL.leafDry
      this.bits.push(this.flung(rng, kind, light ? 0.3 + rng() * 0.35 : kind === CELL.straw ? 0.6 + rng() * 0.6 : 0.18 + rng() * 0.22, light ? 0.35 : 0.8, 46))
    }
    // ---- chunks
    this.chunkMat = material('tornado:chunks', scene, null, false)
    this.chunkMat.disableDepthWrite = false
    this.chunkMesh = new Mesh('tornado:chunks', scene)
    boxGeometry().applyToMesh(this.chunkMesh, false)
    prepare(this.chunkMesh, this.chunkMat, 2)
    this.cMat = new Float32Array(spec.chunks * 16)
    this.cCol = new Float32Array(spec.chunks * 4)
    for (let i = 0; i < spec.chunks; i++) {
      const kind = Math.floor(rng() * CHUNKS.length)
      const c = this.flung(rng, kind, 1, 1, 30)
      const def = CHUNKS[kind]!
      const sc = 0.7 + rng() * 0.6
      c.dx = def.dims[0] * sc
      c.dy = def.dims[1] * sc
      c.dz = def.dims[2] * sc
      const tint = 0.85 + rng() * 0.3
      c.r = def.rgb[0] * tint
      c.g = def.rgb[1] * tint
      c.b = def.rgb[2] * tint
      this.chunks.push(c)
    }
    this.chunkMesh.thinInstanceSetBuffer('matrix', this.cMat, 16, false)
    this.chunkMesh.thinInstanceSetBuffer('color', this.cCol, 4, false)
    this.chunkMesh.thinInstanceCount = 0
    // ---- arcs
    this.glow = glowTexture(scene)
    this.arcMat = material('tornado:arcs', scene, this.glow, true)
    this.aCap = (spec.arcs + MAX_STRIKE_ARCS) * (ARC_SEGMENTS + 3)
    const a = quadMesh('tornado:arcs', scene, this.aCap, this.arcMat, 4)
    this.arcMesh = a.mesh
    this.aPos = a.pos
    this.aCol = a.col
    this.aUv = a.uv
    this.arcOn = new Uint8Array(spec.arcs)
    this.arcLine = new Float32Array(spec.arcs * 5)
    this.arcJag = new Float32Array(spec.arcs * ARC_SEGMENTS * 3)
    for (let i = 0; i < MAX_STRIKE_ARCS; i++) this.strikeArcs.push({ to: [0, 0, 0], at: 0, live: false })
    // ---- torn ground
    this.scar = scarTexture(scene, seed)
    this.trailMat = material('tornado:trail', scene, this.scar, false)
    this.trailMat.zOffset = -4
    const tv = (spec.trail + 1) * 2
    this.tPos = new Float32Array(tv * 3)
    this.tCol = new Float32Array(tv * 4)
    this.tUv = new Float32Array(tv * 2)
    this.tPt = new Float32Array(spec.trail * 7)
    this.tAt = new Float64Array(spec.trail)
    const tIdx: number[] = []
    for (let k = 0; k < spec.trail; k++) tIdx.push(2 * k, 2 * k + 2, 2 * k + 1, 2 * k + 1, 2 * k + 2, 2 * k + 3)
    this.trailMesh = new Mesh('tornado:trail', scene)
    const td = new VertexData()
    td.positions = this.tPos
    td.colors = this.tCol
    td.uvs = this.tUv
    td.indices = tIdx
    td.applyToMesh(this.trailMesh, true)
    prepare(this.trailMesh, this.trailMat, 0)
  }

  private flung(rng: () => number, kind: number, size: number, grav: number, hTop: number): Flung {
    return {
      kind,
      rk: 0.85 + rng() * 0.8,
      rAdd: 0.5 + rng() * 2.5,
      hMax: 6 + rng() * hTop,
      period: 6 + rng() * 6,
      off: rng(),
      theta: rng() * TAU,
      omega: 1.5 + rng() * 1.5,
      rise: 0.5 + rng() * 0.2,
      out: 9 + rng() * 14,
      tan: 6 + rng() * 10,
      up: 2 + rng() * 7,
      grav,
      size,
      spin: (rng() - 0.5) * 14,
      ...unitAxis(rng),
      dx: 0,
      dy: 0,
      dz: 0,
      r: 1,
      g: 1,
      b: 1,
    }
  }

  /** Live counts (debug, tests). */
  stats(): { tier: TornadoTier; funnelVerts: number; quads: number; chunks: number; arcs: number; strikeArcs: number; trail: number } {
    let live = 0
    for (const a of this.strikeArcs) if (a.live) live++
    return { tier: this.tier, funnelVerts: this.fPos.length / 3, quads: this.sLast, chunks: this.cUsed, arcs: this.aLast, strikeArcs: live, trail: this.tCount }
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** A bolt the tornado threw lands at `to` at `at` (server ms): an arc from the funnel's side to it. */
  strikeArc(to: V3, at: number): void {
    let slot = this.strikeArcs[0]!
    for (const a of this.strikeArcs) {
      if (!a.live) {
        slot = a
        break
      }
      if (a.at < slot.at) slot = a
    }
    slot.to[0] = to[0]
    slot.to[1] = to[1]
    slot.to[2] = to[2]
    slot.at = at
    slot.live = true
  }

  /** The funnel's height and radius at height share `h` (0 ground .. 1 cloud), for shell `shell`: this.shH, this.shR. */
  private shape(h: number, strength: number, shell: number): void {
    const size = Math.min(1.25, 0.8 + 0.2 * strength)
    const height = this.t.heightM * size
    const rb = 2.4 + 0.9 * shell
    const rt = this.t.topM * size * (1 + 0.1 * shell)
    let r = rb + (rt - rb) * h ** 1.9
    if (h < 0.08) r += ((0.08 - h) / 0.08) ** 2 * (3 + shell * 1.5)
    if (h > 0.82) r *= 1 + ((h - 0.82) / 0.18) ** 2 * 1.1
    this.shH = height
    this.shR = r
  }

  /** The axis' offset at height share `h` (its slow bend, and the lean behind the heading): this.axX, this.axZ. */
  private axis(h: number, s: number, heading: number): void {
    const k = h ** 1.3
    const bx = (Math.sin(s * 0.37 + this.phase) * 6 + Math.sin(s * 0.9 + h * 4) * 1.8) * k
    const bz = (Math.cos(s * 0.29 + this.phase * 1.3) * 6 + Math.cos(s * 0.8 + h * 3.5) * 1.8) * k
    this.axX = bx - Math.sin(heading) * 8 * h
    this.axZ = bz - Math.cos(heading) * 8 * h
  }

  /** A point on the inner shell at height share `h`, angle `a`, radius × `rk` (the frame's funnel), into `out`. */
  private point(out: V3, f: TornadoFrame, s: number, h: number, a: number, rk: number): V3 {
    this.shape(h, f.strength, 0)
    this.axis(h, s, f.heading)
    const y = this.shH - (this.shH - h * this.shH) * f.presence
    out[0] = f.pos[0] + this.axX + Math.cos(a) * this.shR * rk
    out[1] = f.pos[1] + y
    out[2] = f.pos[2] + this.axZ + Math.sin(a) * this.shR * rk
    return out
  }

  /** Draws this frame (`now` server ms). Nothing when presence is 0. */
  update(now: number, f: TornadoFrame, camera: Camera | null): void {
    if (this.disposed) return
    const s = now / 1000
    this.last = f
    this.lastS = s
    const show = f.presence > 0.001 && !!camera
    const bright = Math.min(1.6, Math.max(0.1, f.light) + 0.35 * f.flash)
    this.funnelMat.alpha = Math.min(1, f.presence * 1.6)
    if (!show) {
      for (const m of [this.funnel, this.spriteMesh, this.chunkMesh, this.arcMesh, this.trailMesh]) m.isVisible = false
      return
    }
    const eye = camera!.globalPosition
    this.updateArcs(f, s, now, eye.x, eye.y, eye.z)
    // its own arcs light it from inside (blue-white)
    const g = this.arcGlow
    this.funnelMat.emissiveColor.set(bright + 0.3 * g, bright + 0.36 * g, bright + 0.5 * g)
    this.spriteMat.emissiveColor.set(bright * 1.15 + 0.2 * g, bright * 1.15 + 0.24 * g, bright * 1.15 + 0.3 * g)
    this.chunkMat.emissiveColor.set(bright * 1.5 + 0.2 * g, bright * 1.5 + 0.22 * g, bright * 1.5 + 0.28 * g)
    this.trailMat.emissiveColor.set(Math.min(1, bright * 1.6), Math.min(1, bright * 1.6), Math.min(1, bright * 1.6))
    this.updateFunnel(f, s, eye.x, eye.z)
    this.updateSprites(f, s, eye.x, eye.y, eye.z)
    this.updateChunks(f, s)
    this.updateTrail(f, now)
    this.funnel.isVisible = true
  }

  private updateFunnel(f: TornadoFrame, s: number, eyeX: number, eyeZ: number): void {
    const spec = this.spec
    const ring = spec.seg + 1
    const pres = f.presence
    let ex = eyeX - f.pos[0]
    let ez = eyeZ - f.pos[2]
    const el = Math.hypot(ex, ez) || 1
    ex /= el
    ez /= el
    this.eyeX = ex
    this.eyeZ = ez
    const fc = this.fCol
    const fb = this.fBase
    for (let sh = 0; sh < spec.shells; sh++) {
      const outer = spec.shells > 1 ? sh / (spec.shells - 1) : 1
      // inner shells turn faster; outer ones churn more
      const turn = s * (1.8 - 0.3 * sh)
      const turb = 1 + 0.7 * outer
      for (let j = 0; j < spec.rings; j++) {
        const h = j / (spec.rings - 1)
        this.shape(h, f.strength, sh)
        this.axis(h, s, f.heading)
        const height = this.shH
        const ox = this.axX
        const oz = this.axZ
        const y = f.pos[1] + height - (height - h * height) * pres
        // a thin rope while it lowers; bulges travelling up
        const rr = this.shR * (0.3 + 0.7 * pres) * (1 + 0.09 * Math.sin(h * 14 - s * 3.4 + sh * 1.3))
        if (sh === 0) {
          this.ringOX[j] = ox
          this.ringOZ[j] = oz
          this.ringR[j] = rr
          this.height = height
        }
        for (let i = 0; i < ring; i++) {
          const ca = this.cosA[i]!
          const sa = this.sinA[i]!
          const a = (i / spec.seg) * TAU
          const ripple = 1 + turb * (0.08 * Math.sin(3 * a + turn * 2 - h * 9 + sh * 1.7) + 0.05 * Math.sin(5 * a - s * 4.3 + h * 13 + sh) + 0.035 * Math.sin(11 * a + s * 7 - h * 25 + sh * 2.3))
          const k = (sh * spec.rings + j) * ring + i
          this.fPos[k * 3] = f.pos[0] + ox + ca * rr * ripple
          this.fPos[k * 3 + 1] = y
          this.fPos[k * 3 + 2] = f.pos[2] + oz + sa * rr * ripple
          this.fUv[k * 2] = (i / spec.seg) * 2 + turn / TAU + sh * 0.31
          this.fUv[k * 2 + 1] = h * 2.5 - s * (0.16 + 0.05 * sh)
          // face-on darker, the rim lighter (light through its thin edge); outer shells denser at the silhouette
          const c = ca * ex + sa * ez
          const rim = 1 - c * c
          const shade = 0.72 + 0.5 * rim
          fc[k * 4] = fb[k * 4]! * shade
          fc[k * 4 + 1] = fb[k * 4 + 1]! * shade
          fc[k * 4 + 2] = fb[k * 4 + 2]! * shade
          fc[k * 4 + 3] = fb[k * 4 + 3]! * (1 - outer * 0.45 * (1 - rim))
        }
      }
    }
    // the wall cloud: a wide lumpy bowl turning over the funnel's top, lowering during the warning
    this.shape(1, f.strength, spec.shells - 1)
    const top = f.pos[1] + this.shH + 14 * (1 - pres)
    const r0 = this.shR * 0.2
    const r1 = this.shR * (1.8 + 1.2 * pres)
    this.axis(1, s, f.heading)
    const cx = f.pos[0] + this.axX
    const cz = f.pos[2] + this.axZ
    const c0 = spec.shells * spec.rings
    const cloudA = Math.min(1, 0.35 + pres)
    for (let j = 0; j < spec.cloudRings; j++) {
      const u = j / (spec.cloudRings - 1)
      const r = r0 + (r1 - r0) * u ** 0.85
      const dip = 16 * (1 - u) ** 2 * (0.35 + 0.65 * pres)
      for (let i = 0; i < ring; i++) {
        const a = (i / spec.seg) * TAU
        const lump = 3 * (0.5 + 0.5 * Math.sin(4 * a + u * 7 - s * 0.6)) * (1 - u * 0.6) + 1.5 * Math.sin(7 * a - s * 0.9 + u * 3)
        const k = (c0 + j) * ring + i
        this.fPos[k * 3] = cx + this.cosA[i]! * r
        this.fPos[k * 3 + 1] = top - dip - lump + u * 4
        this.fPos[k * 3 + 2] = cz + this.sinA[i]! * r
        this.fUv[k * 2] = (i / spec.seg) * 3 + s * 0.06
        this.fUv[k * 2 + 1] = u * 1.4 + s * 0.02
        fc[k * 4 + 3] = fb[k * 4 + 3]! * cloudA
      }
    }
    this.funnel.updateVerticesData(VertexBuffer.PositionKind, this.fPos, false, false)
    this.funnel.updateVerticesData(VertexBuffer.UVKind, this.fUv, false, false)
    this.funnel.updateVerticesData(VertexBuffer.ColorKind, this.fCol, false, false)
    // the eye inside the funnel: nothing is hidden behind its core
    this.eyeIn = el < (this.ringR[0] ?? 0) + 2
  }

  /** How much the funnel's core hides a point behind it from the eye (0..1). */
  private hidden(x: number, y: number, z: number, f: TornadoFrame): number {
    if (this.eyeIn || f.presence < 0.3) return 0
    const n = this.spec.rings
    const j = Math.max(0, Math.min(n - 1, Math.round(((y - f.pos[1]) / Math.max(1, this.height)) * (n - 1))))
    const r = this.ringR[j]!
    const dx = x - f.pos[0] - this.ringOX[j]!
    const dz = z - f.pos[2] - this.ringOZ[j]!
    const along = dx * this.eyeX + dz * this.eyeZ
    if (along >= 0) return 0
    const lat = Math.abs(dz * this.eyeX - dx * this.eyeZ)
    return smooth(0, 0.4 * r, -along) * (1 - smooth(0.55 * r, 1.05 * r, lat)) * 0.92
  }

  /**
   * Where a spiralling-then-flung piece is at `s`, into this.p0 (its velocity into this.vel); its alpha (0 = not shown).
   */
  private flungAt(d: Flung, f: TornadoFrame, s: number): number {
    const ph = (((s / d.period + d.off) % 1) + 1) % 1
    const pres = f.presence
    const spiral = Math.min(ph, d.rise) / d.rise
    const hM = spiral * d.hMax
    const hShare = Math.min(1, hM / Math.max(1, this.height))
    this.shape(hShare, f.strength, 0)
    this.axis(hShare, s, f.heading)
    const rr = this.shR * d.rk * (0.35 + 0.65 * pres) + d.rAdd
    const w = d.omega * (1.6 - 0.5 * hShare)
    const th = d.theta + s * w + spiral * 4
    const ct = Math.cos(th)
    const st = Math.sin(th)
    const px = f.pos[0] + this.axX + ct * rr
    const py = f.pos[1] + hM
    const pz = f.pos[2] + this.axZ + st * rr
    if (ph < d.rise) {
      this.p0[0] = px
      this.p0[1] = py
      this.p0[2] = pz
      const up = d.hMax / (d.rise * d.period)
      this.vel[0] = -st * w * rr
      this.vel[1] = up
      this.vel[2] = ct * w * rr
      return smooth(0, 0.08, ph) * pres
    }
    // flung: out of the spin on a ballistic arc (light pieces fall slowly), lying a moment where they land
    const tau = (ph - d.rise) * d.period
    const vx = ct * d.out - st * d.tan
    const vz = st * d.out + ct * d.tan
    const g = GRAVITY * d.grav
    let y = py + d.up * tau - 0.5 * g * tau * tau
    let vy = d.up - g * tau
    const ground = f.pos[1] + 0.08
    let k = tau
    if (y < ground) {
      // when it came down: the root of the arc
      const land = (d.up + Math.sqrt(d.up * d.up + 2 * g * Math.max(0, py - ground))) / g
      k = Math.min(tau, land)
      y = ground
      vy = 0
    }
    const lying = tau - k
    this.p0[0] = px + vx * k
    this.p0[1] = y
    this.p0[2] = pz + vz * k
    this.vel[0] = lying > 0 ? 0 : vx
    this.vel[1] = vy
    this.vel[2] = lying > 0 ? 0 : vz
    return (1 - smooth(0.88, 1, ph)) * (lying > 0 ? 1 - smooth(0, 0.8, lying) : 1) * Math.max(0.4, pres)
  }

  private updateSprites(f: TornadoFrame, s: number, eyeX: number, eyeY: number, eyeZ: number): void {
    this.sUsed = 0
    const pres = f.presence
    const gx = f.pos[0]
    const gy = f.pos[1]
    const gz = f.pos[2]
    // the dust skirt: big dark puffs churning, rising and swelling around its foot
    for (const p of this.puffs) {
      const ph = (((s / p.period + p.off) % 1) + 1) % 1
      const th = p.theta + s * p.omega
      const r = (p.r + p.grow * ph) * (0.5 + 0.5 * pres)
      const x = gx + Math.cos(th) * r
      const y = gy + 0.6 + p.rise * ph * ph
      const z = gz + Math.sin(th) * r
      const a = Math.sin(Math.PI * ph) ** 0.7 * 0.72 * pres * (1 - this.hidden(x, y, z, f) * 0.6)
      const size = p.size * (0.6 + 0.9 * ph) * (0.6 + 0.4 * pres)
      this.billboard(x, y, z, size, size, p.spin * s + p.theta, CELL.puff, eyeX, eyeY, eyeZ, 0.62 * p.tone, 0.55 * p.tone, 0.46 * p.tone, a)
    }
    // rain and dust bands spiralling in along the ground, stretched along their way
    for (const b of this.bands) {
      const ph = (((s / b.period + b.off) % 1) + 1) % 1
      const p = bandAt(this.q0, b, ph, s, f)
      const back = bandAt(this.q1, b, Math.max(0, ph - 0.03), s, f)
      const a = Math.sin(Math.PI * ph) * (0.25 + 0.3 * b.dust) * pres * (1 - this.hidden(p[0], p[1], p[2], f))
      const tone = 0.55 + 0.2 * b.dust
      this.streak(p[0], p[1], p[2], p[0] - back[0], p[1] - back[1], p[2] - back[2], b.len, b.width, CELL.streak, eyeX, eyeY, eyeZ, tone, tone * (1 - 0.15 * b.dust), tone * (1 - 0.3 * b.dust), a)
    }
    // leaves, straw and grit: up the funnel, then flung far out
    for (const d of this.bits) {
      let a = this.flungAt(d, f, s)
      if (a <= 0.01) continue
      const p = this.p0
      a *= 1 - this.hidden(p[0], p[1], p[2], f)
      const v = this.vel
      const speed = Math.hypot(v[0], v[1], v[2])
      const stretch = 1 + Math.min(2.5, speed * 0.07)
      const flutter = 0.55 + 0.45 * Math.abs(Math.sin(d.spin * s + d.theta))
      if (speed > 0.5) this.streak(p[0], p[1], p[2], v[0], v[1], v[2], d.size * stretch, d.size * flutter, d.kind, eyeX, eyeY, eyeZ, 1, 1, 1, a)
      else this.billboard(p[0], p[1], p[2], d.size, d.size * flutter, d.spin * s, d.kind, eyeX, eyeY, eyeZ, 1, 1, 1, a)
    }
    this.upload(this.spriteMesh, this.sPos, this.sCol, this.sUv, this.sUsed, this.sLast)
    this.sLast = this.sUsed
  }

  private updateChunks(f: TornadoFrame, s: number): void {
    let n = 0
    const m = this.cMat
    for (const c of this.chunks) {
      let a = this.flungAt(c, f, s)
      if (a <= 0.01) continue
      const p = this.p0
      a *= 1 - this.hidden(p[0], p[1], p[2], f)
      if (a <= 0.01) continue
      // tumbling (axis-angle), then stretched along its motion (a cheap motion blur)
      const v = this.vel
      const speed = Math.hypot(v[0], v[1], v[2])
      const lying = speed < 0.01
      const ang = lying ? c.theta : c.spin * s + c.theta
      const co = Math.cos(ang)
      const si = Math.sin(ang)
      const t = 1 - co
      const x = c.ax
      const y = c.ay
      const z = c.az
      const o = n * 16
      // rotation rows (Babylon row-vector convention): row i is the image of axis i
      m[o] = (t * x * x + co) * c.dx
      m[o + 1] = (t * x * y + si * z) * c.dx
      m[o + 2] = (t * x * z - si * y) * c.dx
      m[o + 4] = (t * x * y - si * z) * c.dy
      m[o + 5] = (t * y * y + co) * c.dy
      m[o + 6] = (t * y * z + si * x) * c.dy
      m[o + 8] = (t * x * z + si * y) * c.dz
      m[o + 9] = (t * y * z - si * x) * c.dz
      m[o + 10] = (t * z * z + co) * c.dz
      if (speed > 2) {
        const k = Math.min(1.2, speed * 0.035)
        const ux = v[0] / speed
        const uy = v[1] / speed
        const uz = v[2] / speed
        for (let r = 0; r < 3; r++) {
          const b = o + r * 4
          const d = (m[b]! * ux + m[b + 1]! * uy + m[b + 2]! * uz) * k
          m[b] = m[b]! + ux * d
          m[b + 1] = m[b + 1]! + uy * d
          m[b + 2] = m[b + 2]! + uz * d
        }
      }
      m[o + 3] = m[o + 7] = m[o + 11] = 0
      m[o + 12] = p[0]
      m[o + 13] = p[1] + (lying ? c.dy * 0.4 : 0)
      m[o + 14] = p[2]
      m[o + 15] = 1
      const ci = n * 4
      this.cCol[ci] = c.r
      this.cCol[ci + 1] = c.g
      this.cCol[ci + 2] = c.b
      this.cCol[ci + 3] = Math.min(1, a)
      n++
    }
    this.cUsed = n
    this.chunkMesh.thinInstanceCount = n
    if (n > 0) {
      this.chunkMesh.thinInstanceBufferUpdated('matrix')
      this.chunkMesh.thinInstanceBufferUpdated('color')
    }
    this.chunkMesh.isVisible = n > 0
  }

  private updateArcs(f: TornadoFrame, s: number, now: number, eyeX: number, eyeY: number, eyeZ: number): void {
    this.aUsed = 0
    let glow = 0
    const spec = this.spec
    const L = this.arcLine
    if (f.presence > 0.45) {
      if (now >= this.arcsUntil) {
        for (let k = 0; k < spec.arcs; k++) {
          this.arcOn[k] = Math.random() < 0.6 ? 1 : 0
          const h0 = 0.08 + Math.random() * 0.62
          // two in three inside it; the rest leap out into the debris around it
          const outside = Math.random() < 0.34
          L[k * 5] = h0
          L[k * 5 + 1] = Math.random() * TAU
          L[k * 5 + 2] = outside ? Math.max(0.02, h0 - 0.05 - Math.random() * 0.1) : Math.min(0.92, h0 + 0.05 + Math.random() * 0.22)
          L[k * 5 + 3] = Math.random() * TAU
          L[k * 5 + 4] = outside ? 1.5 + Math.random() * 1.2 : 0.5
          for (let i = 0; i < ARC_SEGMENTS * 3; i++) this.arcJag[k * ARC_SEGMENTS * 3 + i] = Math.random() - 0.5
        }
        this.arcsUntil = now + ARC_SHAPE_MS * (0.5 + Math.random())
      }
      for (let k = 0; k < spec.arcs; k++) {
        if (!this.arcOn[k]) continue
        const a = this.point(this.p0, f, s, L[k * 5]!, L[k * 5 + 1]!, 0.5)
        const b = this.point(this.p1, f, s, L[k * 5 + 2]!, L[k * 5 + 3]!, L[k * 5 + 4]!)
        const al = 0.95 * f.presence
        this.bolt(a, b, this.arcJag, k * ARC_SEGMENTS * 3, eyeX, eyeY, eyeZ, 0.32, al)
        // a soft glow inside the funnel where it flashes
        this.arcSprite((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 9 + this.shR * 0.4, eyeX, eyeY, eyeZ, 0.28 * al)
        glow += 0.35
      }
    }
    for (const st of this.strikeArcs) {
      if (!st.live) continue
      const age = now - st.at
      if (age > STRIKE_ARC_MS || age < -2000) {
        st.live = false
        continue
      }
      if (age < 0) continue
      const from = this.point(this.p0, f, s, 0.3, Math.atan2(st.to[2] - f.pos[2], st.to[0] - f.pos[0]), 0.9)
      for (let i = 0; i < ARC_SEGMENTS * 3; i++) this.strikeJag[i] = Math.random() - 0.5
      const al = 1 - age / STRIKE_ARC_MS
      this.bolt(from, st.to, this.strikeJag, 0, eyeX, eyeY, eyeZ, 0.5, al)
      glow += 0.8 * al
    }
    this.arcGlow = Math.min(1.5, glow)
    this.upload(this.arcMesh, this.aPos, this.aCol, this.aUv, this.aUsed, this.aLast)
    this.aLast = this.aUsed
  }

  /** The torn ground: a point every TRAIL_STEP_M while it touches down; drawn oldest to newest up to its foot. */
  private updateTrail(f: TornadoFrame, now: number): void {
    const cap = this.spec.trail
    const P = this.tPt
    const size = Math.min(1.25, 0.8 + 0.2 * f.strength)
    if (f.presence > 0.6) {
      const lastI = (this.tHead - 1 + cap) % cap
      const moved = this.tCount === 0 ? Infinity : Math.hypot(f.pos[0] - P[lastI * 7]!, f.pos[2] - P[lastI * 7 + 1]!)
      if (moved >= TRAIL_STEP_M) {
        const sx = Math.cos(f.heading)
        const sz = -Math.sin(f.heading)
        const half = TRAIL_HALF_M * size
        const o = this.tHead * 7
        const gr = f.ground
        const lx = f.pos[0] - sx * half
        const lz = f.pos[2] - sz * half
        const rx = f.pos[0] + sx * half
        const rz = f.pos[2] + sz * half
        const yl = gr ? gr(lx, lz, f.pos[1]) : f.pos[1]
        const yr = gr ? gr(rx, rz, f.pos[1]) : f.pos[1]
        if (this.tCount > 0 && Number.isFinite(moved)) this.tDist += moved
        P[o] = f.pos[0]
        P[o + 1] = f.pos[2]
        P[o + 2] = Number.isFinite(yl) ? yl : f.pos[1]
        P[o + 3] = Number.isFinite(yr) ? yr : f.pos[1]
        P[o + 4] = sx
        P[o + 5] = sz
        P[o + 6] = this.tDist
        this.tAt[this.tHead] = now
        this.tHead = (this.tHead + 1) % cap
        this.tCount = Math.min(cap, this.tCount + 1)
      }
    }
    if (this.tCount === 0) {
      this.trailMesh.isVisible = false
      return
    }
    const half = TRAIL_HALF_M * size
    const first = (this.tHead - this.tCount + cap) % cap
    const fade = Math.min(1, f.presence * 1.5)
    for (let n = 0; n < this.tCount; n++) {
      const i = (first + n) % cap
      const o = i * 7
      const age = now - this.tAt[i]!
      this.trailVert(n, half, P[o]!, P[o + 1]!, P[o + 2]!, P[o + 3]!, P[o + 4]!, P[o + 5]!, P[o + 6]!, Math.max(0, 1 - age / TRAIL_MS) ** 1.3 * 0.85 * fade)
    }
    // the live end at its foot (fading in under the funnel)
    const lo = ((this.tHead - 1 + cap) % cap) * 7
    const tail = Math.hypot(f.pos[0] - P[lo]!, f.pos[2] - P[lo + 1]!)
    this.trailVert(this.tCount, half, f.pos[0], f.pos[2], P[lo + 2]!, P[lo + 3]!, P[lo + 4]!, P[lo + 5]!, P[lo + 6]! + tail, 0.3 * fade)
    // the rest collapse onto the last point (zero-area quads)
    const used = this.tCount + 1
    for (let k = used * 2; k < (cap + 1) * 2; k++) {
      this.tPos[k * 3] = this.tPos[(used * 2 - 1) * 3]!
      this.tPos[k * 3 + 1] = this.tPos[(used * 2 - 1) * 3 + 1]!
      this.tPos[k * 3 + 2] = this.tPos[(used * 2 - 1) * 3 + 2]!
      this.tCol[k * 4 + 3] = 0
    }
    this.trailMesh.updateVerticesData(VertexBuffer.PositionKind, this.tPos, false, false)
    this.trailMesh.updateVerticesData(VertexBuffer.ColorKind, this.tCol, false, false)
    this.trailMesh.updateVerticesData(VertexBuffer.UVKind, this.tUv, false, false)
    this.trailMesh.isVisible = true
  }

  /** Trail point `v`: its two edge vertices at (x, z) ± the side × `half`, on the ground there. */
  private trailVert(v: number, half: number, x: number, z: number, yl: number, yr: number, sx: number, sz: number, dist: number, alpha: number): void {
    const o = v * 2
    const P = this.tPos
    P[o * 3] = x - sx * half
    P[o * 3 + 1] = yl + 0.2
    P[o * 3 + 2] = z - sz * half
    P[o * 3 + 3] = x + sx * half
    P[o * 3 + 4] = yr + 0.2
    P[o * 3 + 5] = z + sz * half
    const U = this.tUv
    U[o * 2] = 0
    U[o * 2 + 1] = dist / 14
    U[o * 2 + 2] = 1
    U[o * 2 + 3] = dist / 14
    for (let k = 0; k < 2; k++) {
      const c = (o + k) * 4
      this.tCol[c] = this.tCol[c + 1] = this.tCol[c + 2] = 1
      this.tCol[c + 3] = alpha
    }
  }

  /** A jagged ribbon from `a` to `b` (offsets `jag[j0..]`) with its glow at both ends. */
  private bolt(a: V3, b: V3, jag: Float32Array, j0: number, eyeX: number, eyeY: number, eyeZ: number, width: number, alpha: number): void {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    const amp = Math.min(3.5, 0.15 * len)
    let px = a[0]
    let py = a[1]
    let pz = a[2]
    for (let i = 1; i <= ARC_SEGMENTS; i++) {
      const t = i / ARC_SEGMENTS
      const e = i === ARC_SEGMENTS ? 0 : Math.sin(Math.PI * t) * amp * 2
      const qx = a[0] + (b[0] - a[0]) * t + jag[j0 + i * 3 - 3]! * e
      const qy = a[1] + (b[1] - a[1]) * t + jag[j0 + i * 3 - 2]! * e
      const qz = a[2] + (b[2] - a[2]) * t + jag[j0 + i * 3 - 1]! * e
      this.ribbon(px, py, pz, qx, qy, qz, width, eyeX, eyeY, eyeZ, alpha)
      px = qx
      py = qy
      pz = qz
    }
    this.arcSprite(a[0], a[1], a[2], 1.4, eyeX, eyeY, eyeZ, alpha * 0.7)
    this.arcSprite(b[0], b[1], b[2], 1.9, eyeX, eyeY, eyeZ, alpha * 0.85)
  }

  private ribbon(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, eyeX: number, eyeY: number, eyeZ: number, alpha: number): void {
    if (this.aUsed >= this.aCap || !(alpha > 0.002)) return
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const vx = eyeX - (ax + bx) / 2
    const vy = eyeY - (ay + by) / 2
    const vz = eyeZ - (az + bz) / 2
    let sx = dy * vz - dz * vy
    let sy = dz * vx - dx * vz
    let sz = dx * vy - dy * vx
    const sl = Math.hypot(sx, sy, sz)
    if (sl < 1e-6) return
    const h = w / 2 / sl
    sx *= h
    sy *= h
    sz *= h
    const i = this.aUsed++
    const P = this.aPos
    const o = i * 12
    P[o] = ax - sx
    P[o + 1] = ay - sy
    P[o + 2] = az - sz
    P[o + 3] = ax + sx
    P[o + 4] = ay + sy
    P[o + 5] = az + sz
    P[o + 6] = bx + sx
    P[o + 7] = by + sy
    P[o + 8] = bz + sz
    P[o + 9] = bx - sx
    P[o + 10] = by - sy
    P[o + 11] = bz - sz
    const U = this.aUv
    const u = i * 8
    U[u] = 0.75
    U[u + 1] = 0
    U[u + 2] = 0.75
    U[u + 3] = 1
    U[u + 4] = 0.75
    U[u + 5] = 1
    U[u + 6] = 0.75
    U[u + 7] = 0
    this.arcColour(i, alpha)
  }

  private arcSprite(x: number, y: number, z: number, size: number, eyeX: number, eyeY: number, eyeZ: number, alpha: number): void {
    if (this.aUsed >= this.aCap || !(alpha > 0.002)) return
    const i = this.aUsed++
    quadAt(this.aPos, i, x, y, z, size / 2, size / 2, 0, eyeX, eyeY, eyeZ)
    const U = this.aUv
    const u = i * 8
    U[u] = 0
    U[u + 1] = 0
    U[u + 2] = 0.5
    U[u + 3] = 0
    U[u + 4] = 0.5
    U[u + 5] = 1
    U[u + 6] = 0
    U[u + 7] = 1
    this.arcColour(i, alpha)
  }

  private arcColour(i: number, alpha: number): void {
    const al = Math.min(1, alpha)
    const C = this.aCol
    for (let k = 0; k < 4; k++) {
      const c = i * 16 + k * 4
      C[c] = 0.8 * al
      C[c + 1] = 0.9 * al
      C[c + 2] = al
      C[c + 3] = al
    }
  }

  /** A camera-facing sprite (`w` × `h`, turned by `angle` on screen), atlas cell `cell`. */
  private billboard(x: number, y: number, z: number, w: number, h: number, angle: number, cell: number, eyeX: number, eyeY: number, eyeZ: number, r: number, g: number, b: number, alpha: number): void {
    if (this.sUsed >= this.sCap || !(alpha > 0.002)) return
    const i = this.sUsed++
    quadAt(this.sPos, i, x, y, z, w / 2, h / 2, angle, eyeX, eyeY, eyeZ)
    this.spriteUv(i, cell, r, g, b, alpha)
  }

  /** A sprite stretched along world direction (dx, dy, dz): `len` along it, `width` across, facing the eye. */
  private streak(x: number, y: number, z: number, dx: number, dy: number, dz: number, len: number, width: number, cell: number, eyeX: number, eyeY: number, eyeZ: number, r: number, g: number, b: number, alpha: number): void {
    if (this.sUsed >= this.sCap || !(alpha > 0.002)) return
    let fx = eyeX - x
    let fy = eyeY - y
    let fz = eyeZ - z
    const fl = Math.hypot(fx, fy, fz) || 1
    fx /= fl
    fy /= fl
    fz /= fl
    // the motion across the view (its part along the view is invisible)
    const along = dx * fx + dy * fy + dz * fz
    let ux = dx - along * fx
    let uy = dy - along * fy
    let uz = dz - along * fz
    const ul = Math.hypot(ux, uy, uz)
    if (ul < 1e-5) return this.billboard(x, y, z, width, width, 0, cell, eyeX, eyeY, eyeZ, r, g, b, alpha)
    ux /= ul
    uy /= ul
    uz /= ul
    // across = view × along
    const vx = fy * uz - fz * uy
    const vy = fz * ux - fx * uz
    const vz = fx * uy - fy * ux
    const i = this.sUsed++
    const hl = len / 2
    const hw = width / 2
    const P = this.sPos
    const o = i * 12
    // corners: (-across, -along), (+across, -along), (+across, +along), (-across, +along): the cell's v runs along
    P[o] = x - vx * hw - ux * hl
    P[o + 1] = y - vy * hw - uy * hl
    P[o + 2] = z - vz * hw - uz * hl
    P[o + 3] = x + vx * hw - ux * hl
    P[o + 4] = y + vy * hw - uy * hl
    P[o + 5] = z + vz * hw - uz * hl
    P[o + 6] = x + vx * hw + ux * hl
    P[o + 7] = y + vy * hw + uy * hl
    P[o + 8] = z + vz * hw + uz * hl
    P[o + 9] = x - vx * hw + ux * hl
    P[o + 10] = y - vy * hw + uy * hl
    P[o + 11] = z - vz * hw + uz * hl
    this.spriteUv(i, cell, r, g, b, alpha)
  }

  private spriteUv(i: number, cell: number, r: number, g: number, b: number, alpha: number): void {
    const u0 = cell / CELLS
    const u1 = (cell + 1) / CELLS
    const U = this.sUv
    const u = i * 8
    U[u] = u0
    U[u + 1] = 0
    U[u + 2] = u1
    U[u + 3] = 0
    U[u + 4] = u1
    U[u + 5] = 1
    U[u + 6] = u0
    U[u + 7] = 1
    const al = Math.min(1, alpha)
    const C = this.sCol
    for (let k = 0; k < 4; k++) {
      const c = i * 16 + k * 4
      C[c] = r
      C[c + 1] = g
      C[c + 2] = b
      C[c + 3] = al
    }
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
    return f ? this.point([0, 0, 0], f, this.lastS, h, Math.atan2(to[2] - f.pos[2], to[0] - f.pos[0]), 0.9) : null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const a of this.strikeArcs) a.live = false
    for (const m of [this.funnel, this.spriteMesh, this.chunkMesh, this.arcMesh, this.trailMesh]) m.dispose(false, false)
    for (const m of [this.funnelMat, this.spriteMat, this.chunkMat, this.arcMat, this.trailMat]) m.dispose(false, false)
    for (const t of [this.streaks, this.atlas, this.glow, this.scar]) t.dispose()
  }
}

/** A rain/dust band's point at share `q` of its run in toward the funnel, into `out`. */
function bandAt(out: V3, b: Band, q: number, s: number, f: TornadoFrame): V3 {
  const r = (3 + (b.r0 - 3) * (1 - q) ** 0.9) * (0.5 + 0.5 * f.presence)
  const th = b.theta + q * b.turns + s * 0.2
  out[0] = f.pos[0] + Math.cos(th) * r
  out[1] = f.pos[1] + b.h0 + b.rise * q * q
  out[2] = f.pos[2] + Math.sin(th) * r
  return out
}

/** A random unit axis (a chunk's tumble). */
function unitAxis(rng: () => number): { ax: number; ay: number; az: number } {
  const z = rng() * 2 - 1
  const a = rng() * TAU
  const r = Math.sqrt(1 - z * z)
  return { ax: r * Math.cos(a), ay: z, az: r * Math.sin(a) }
}

/** Writes quad `i` of `pos`: centred at (x, y, z), half sizes `hw` × `hh`, facing the eye, turned by `angle` on screen. */
function quadAt(pos: Float32Array, i: number, x: number, y: number, z: number, hw: number, hh: number, angle: number, eyeX: number, eyeY: number, eyeZ: number): void {
  let fx = eyeX - x
  let fy = eyeY - y
  let fz = eyeZ - z
  const fl = Math.hypot(fx, fy, fz) || 1
  fx /= fl
  fy /= fl
  fz /= fl
  // right = up × forward, up' = forward × right
  let rx = fz
  let rz = -fx
  let rl = Math.hypot(rx, rz)
  if (rl < 1e-4) {
    rx = 1
    rz = 0
    rl = 1
  }
  rx /= rl
  rz /= rl
  const ux = fy * rz
  const uy = fz * rx - fx * rz
  const uz = -fy * rx
  const ca = Math.cos(angle)
  const sa = Math.sin(angle)
  // turned basis
  const Rx = rx * ca + ux * sa
  const Ry = uy * sa
  const Rz = rz * ca + uz * sa
  const Ux = -rx * sa + ux * ca
  const Uy = uy * ca
  const Uz = -rz * sa + uz * ca
  const o = i * 12
  pos[o] = x - Rx * hw - Ux * hh
  pos[o + 1] = y - Ry * hw - Uy * hh
  pos[o + 2] = z - Rz * hw - Uz * hh
  pos[o + 3] = x + Rx * hw - Ux * hh
  pos[o + 4] = y + Ry * hw - Uy * hh
  pos[o + 5] = z + Rz * hw - Uz * hh
  pos[o + 6] = x + Rx * hw + Ux * hh
  pos[o + 7] = y + Ry * hw + Uy * hh
  pos[o + 8] = z + Rz * hw + Uz * hh
  pos[o + 9] = x - Rx * hw + Ux * hh
  pos[o + 10] = y - Ry * hw + Uy * hh
  pos[o + 11] = z - Rz * hw + Uz * hh
}

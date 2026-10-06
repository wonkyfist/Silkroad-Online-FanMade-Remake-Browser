/**
 * Siege of Jangan, layer 2: the walls' look (docs/SIEGE.md §9.2) over the cut retail pieces view.ts loads. Everything
 * here is driven by the segments' looks (look.ts) and drawn with the wall's own materials where it is stone:
 *
 * - **Cracks**: per standing third, decals projected on its brick faces from a painted crack atlas (cracks.ts), multiplied
 *   over the stone (the wall keeps its texture, lightmap and the day's light). Two levels; a broken end is always deep.
 * - **Piles**: per downed third, a mound (stone.ts `moundGeometry`, the wall's brick material) and its chunks of wall
 *   stone (rubble.ts `pileLayout`); per broken end, teeth of stone. Chunks are thin instances of 6 meshes per side (3
 *   shapes × brick/core look) in the side's own wall materials: one buffer per mesh, rebuilt only when a look changes.
 * - **Collapse** (a live change only, not the enter-world snapshot): the third's pieces start in the wall and fall onto
 *   their places in the pile (rubble.ts `fallPose`), the mound rises under a dust cloud, small bits fly and vanish, and
 *   `onFall` is told (camera shake, sound). The pile that stays is the pieces that fell: no swap, no leftovers.
 * - **Bits**: chips from a hit or a crack, a fixed ring of slots after each brick mesh's pile (no allocation per frame).
 * - **Dust**: a small pool of particle systems, reused round-robin.
 * - **Scaffold**: one thin-instanced timber mesh for every scaffold (scaffold.ts), in a painted wood material.
 * Tiers (look.ts WALL_TIERS): Low draws about half the stone and dust and one scaffold face.
 * `stats` and `dispose` are what the leak tests check: after dispose nothing of this is left in the scene.
 */
import {
  Color3,
  Color4,
  Constants,
  CreateDecal,
  DynamicTexture,
  Material,
  Mesh,
  PBRMaterial,
  ParticleSystem,
  StandardMaterial,
  Texture,
  Vector3,
  VertexBuffer,
  VertexData,
  type AbstractMesh,
  type Scene,
} from '@babylonjs/core'
import { mulberry32, type WallsExport, type WallsSegment, type WallsSideInfo } from '@sro/shared'
import { CRACK_VARIANTS, paintCracks, paintWood } from './cracks.ts'
import { COLLAPSE, WALL_TIERS, lookChange, type WallLook, type WallTier, type WallTierTable } from './look.ts'
import {
  PILE_SPREAD,
  acrossAt,
  composeInto,
  depthOf,
  exposedEdges,
  fallDuration,
  fallPose,
  notchShift,
  pileHeight,
  pileLayout,
  seedOf,
  sideXZ,
  teethLayout,
  type Chunk,
  type Edge,
} from './rubble.ts'
import { scaffoldBeams, type Beam } from './scaffold.ts'
import { beamGeometry, capGeometry, chunkGeometry, moundGeometry, type Geometry } from './stone.ts'

/** What the dressing needs of the loaded walls (view.ts gives the real ones, tests stand-ins). */
export interface WallSideSource {
  info: WallsSideInfo
  /** The side's wall materials: brick (cj_wall01) and core (cj_wall02, else the brick). */
  brick: Material | null
  core: Material | null
  /** A UV1 point inside each material's lightmap chart (an outer face). */
  lm: { brick: [number, number]; core: [number, number] }
  /** The meshes of a third's brick faces (decals are projected on them). */
  faces(thirdId: string): readonly AbstractMesh[]
  /** Every mesh of a third (a broken end pulls their end vertices back). */
  meshes(thirdId: string): readonly AbstractMesh[]
}

export interface DressingOptions {
  tier(): WallTier
  /** Ground height (m) at a world point, NaN when unknown. */
  ground(x: number, z: number): number
  /** A live collapse began (world point of the falling stone's middle). */
  onFall?(x: number, y: number, z: number, thirds: number): void
  /** Layer mask bits to add to every mesh (the world's object layer). */
  layerMask?: number
  /** The world's material path (World.materials.mode): the scaffold's timber is drawn to match it. */
  path?(): 'classic' | 'pbr'
}

const POOLS = 6 // shape (3) × look (brick, core): index = look * 3 + shape
/** Dust colour on the Classic path; the PBR path's linear output is lifted by its post-process, so it takes a darker one. */
const DUST_COLOR = new Color4(0.55, 0.5, 0.43, 1)
const DUST_COLOR_PBR = new Color4(0.29, 0.26, 0.22, 1)

interface Pool {
  mesh: Mesh
  mat: Float32Array
  col: Float32Array
  cap: number
  /** Pile and teeth instances (the bits' slots follow). */
  count: number
  bits: number
  dirty: boolean
}

interface SideState {
  src: WallSideSource
  pools: (Pool | null)[]
  bits: Bits | null
  /** The pile/teeth set last built (ids), to skip rebuilds. */
  built: string
}

interface Anim {
  id: string
  side: string
  t: number
  end: number
  chunks: readonly Chunk[]
  /** pool * 65536 + slot per chunk (resolved at each rebuild). */
  slots: Int32Array
}

interface Mound {
  mesh: Mesh
  rise: number
  base: number
}

/** Small stone bits: a ring of slots on the side's brick meshes, simulated without allocation. */
class Bits {
  readonly n: number
  readonly f: Float32Array
  /** Per bit: whether its matrix is not zero (so a dead one is cleared once). */
  readonly live: Uint8Array
  cursor = 0
  alive = 0
  // fields per bit
  static readonly F = 16 // px py pz vx vy vz ex ey ez wx wy wz size age life ground

  constructor(n: number) {
    this.n = n
    this.f = new Float32Array(n * Bits.F)
    this.live = new Uint8Array(n)
    for (let i = 0; i < n; i++) this.f[i * Bits.F + 14] = -1
  }
}

const SCRATCH = { x: 0, y: 0, z: 0 }
const SCRATCH_Q: [number, number, number, number] = [0, 0, 0, 1]

export class WallDressing {
  private readonly sides = new Map<string, SideState>()
  private readonly looks = new Map<string, WallLook>()
  private readonly piles = new Map<string, Chunk[]>()
  private pilesTier: WallTier | null = null
  private readonly teeth = new Map<string, Chunk[]>()
  private edges: Edge[] = []
  private readonly anims = new Map<string, Anim>()
  /** The same anims as a list, and the sides: the per-frame loop walks arrays (no iterator objects). */
  private animList: Anim[] = []
  private readonly sideList: SideState[] = []
  private readonly mounds = new Map<string, Mound>()
  private readonly decals = new Map<string, { level: number; mesh: Mesh | null }>()
  private readonly geometries = new Map<string, Geometry>()
  private crackMats: [StandardMaterial | null, StandardMaterial | null] = [null, null]
  private crackTex: (DynamicTexture | null)[] = [null, null]
  private scaffold: { mesh: Mesh; mat: Float32Array; key: string } | null = null
  private woodMat: Material | null = null
  private woodTex: DynamicTexture | null = null
  private dust: ParticleSystem[] = []
  private dustTex: DynamicTexture | null = null
  private dustNext = 0
  private disposed = false
  private readonly notched = new Map<AbstractMesh, Float32Array>()
  private readonly caps = new Map<string, Mesh>()
  /** Per notched edge: the moved vertices as [height fraction, across fraction, shift], the real broken profile. */
  private readonly profiles = new Map<string, [number, number, number][]>()
  private notchKey = ''
  private readonly segById = new Map<string, WallsSegment>()
  private readonly thirdIndex = new Map<string, { seg: WallsSegment; k: number }>()

  constructor(private readonly scene: Scene, private readonly walls: WallsExport, sources: readonly WallSideSource[], private readonly o: DressingOptions) {
    for (const s of sources) {
      const st: SideState = { src: s, pools: new Array(POOLS).fill(null), bits: null, built: '' }
      this.sides.set(s.info.side, st)
      this.sideList.push(st)
    }
    for (const seg of walls.segments) {
      this.segById.set(seg.id, seg)
      seg.thirds.forEach((t, k) => this.thirdIndex.set(t.id, { seg, k }))
    }
  }

  private get tier(): WallTierTable {
    return WALL_TIERS[this.o.tier()]
  }

  // ---- looks ----------------------------------------------------------------------------------------------------------

  /**
   * Shows the looks (segments missing are intact). `live`: a change happening now (falls animate); false for a
   * snapshot (enter world, a GM reset): everything is placed as it lies.
   */
  apply(looks: ReadonlyMap<string, WallLook>, live: boolean): void {
    if (this.disposed) return
    const tierName = this.o.tier()
    if (this.pilesTier !== tierName) {
      // a tier change: piles and teeth are laid out again
      this.pilesTier = tierName
      this.piles.clear()
      this.teeth.clear()
      for (const s of this.sides.values()) s.built = ''
    }
    let scaffoldChanged = false
    for (const seg of this.walls.segments) {
      const look = looks.get(seg.id)
      const before = this.looks.get(seg.id)
      if (!look && !before) continue
      const now = look ?? { down: [false, false, false], crack: [0, 0, 0], scaffold: [false, false, false], hammer: false } as WallLook
      const ch = lookChange(before, now)
      for (const k of ch.rise) this.raise(seg, k)
      if (ch.fall.length) this.fall(seg, ch.fall, live)
      seg.thirds.forEach((t, k) => this.crack(t.id, now.down[k] ? 0 : now.crack[k]))
      if (!before || before.scaffold.some((v, k) => v !== now.scaffold[k])) scaffoldChanged = true
      if (look) this.looks.set(seg.id, look)
      else this.looks.delete(seg.id)
    }
    this.rebuildPiles()
    if (scaffoldChanged) this.rebuildScaffold()
  }

  /** Is third `id` down now (by the last looks)? */
  private down(id: string): boolean {
    const at = this.thirdIndex.get(id)
    return !!at && !!this.looks.get(at.seg.id)?.down[at.k]
  }

  private pileOf(seg: WallsSegment, k: number): Chunk[] {
    const id = seg.thirds[k]!.id
    let p = this.piles.get(id)
    if (!p) {
      const side = this.sides.get(seg.side)!
      p = pileLayout(seg, k, side.src.info, this.o.ground, this.tier)
      this.piles.set(id, p)
    }
    return p
  }

  private fall(seg: WallsSegment, thirds: readonly number[], live: boolean): void {
    const side = this.sides.get(seg.side)
    if (!side) return
    const info = side.src.info
    let mx = 0, mz = 0
    for (const k of thirds) {
      const t = seg.thirds[k]!
      this.mound(seg, k, live ? 0 : 1)
      const chunks = this.pileOf(seg, k)
      if (live) {
        let end = 0
        for (const c of chunks) end = Math.max(end, c.delay + fallDuration(c))
        const anim: Anim = { id: t.id, side: seg.side, t: 0, end, chunks, slots: new Int32Array(chunks.length).fill(-1) }
        this.dropAnim(t.id)
        this.anims.set(t.id, anim)
        this.animList.push(anim)
        this.fallDust(t.from, t.to, info)
        this.fallBits(t.from, t.to, info)
      }
      const [x, z] = sideXZ(info, (t.from + t.to) / 2, acrossAt(info, depthOf(info) / 2))
      mx += x
      mz += z
    }
    if (live) this.o.onFall?.(mx / thirds.length, info.walkY * 0.5, mz / thirds.length, thirds.length)
  }

  private raise(seg: WallsSegment, k: number): void {
    const id = seg.thirds[k]!.id
    this.dropAnim(id)
    const m = this.mounds.get(id)
    if (m) {
      m.mesh.dispose(false, false)
      this.mounds.delete(id)
    }
    const side = this.sides.get(seg.side)
    if (side) this.puff('repair', seg.thirds[k]!.from, seg.thirds[k]!.to, side.src.info)
  }

  private dropAnim(id: string): void {
    if (!this.anims.delete(id)) return
    this.animList = this.animList.filter((a) => a.id !== id)
  }

  // ---- piles: chunk pools -------------------------------------------------------------------------------------------

  private rebuildPiles(): void {
    this.edges = exposedEdges([...this.sides.values()].map((s) => s.src.info), this.walls.segments, (id) => this.down(id))
    this.applyNotches()
    this.rebuildCaps()
    for (const [name, side] of this.sides) {
      const list: { c: Chunk; anim: Anim | null; i: number }[] = []
      const keys: string[] = []
      for (const seg of this.walls.segments) {
        if (seg.side !== name) continue
        seg.thirds.forEach((t, k) => {
          if (!this.down(t.id)) return
          keys.push(t.id)
          const anim = this.anims.get(t.id) ?? null
          this.pileOf(seg, k).forEach((c, i) => list.push({ c, anim, i }))
        })
      }
      for (const e of this.edges) {
        if (e.side.side !== name) continue
        keys.push(e.id)
        let teeth = this.teeth.get(e.id)
        if (!teeth) {
          const prof = this.profiles.get(e.id)
          teeth = teethLayout(e, this.o.ground, this.tier, prof ? (h, wf) => profileAt(prof, h, wf) : undefined)
          this.teeth.set(e.id, teeth)
        }
        for (const c of teeth) list.push({ c, anim: null, i: 0 })
      }
      const key = keys.join(',')
      if (key === side.built) continue
      side.built = key
      this.fillPools(side, list)
    }
    this.cleanMounds()
  }

  private fillPools(side: SideState, list: { c: Chunk; anim: Anim | null; i: number }[]): void {
    const counts = new Array<number>(POOLS).fill(0)
    for (const e of list) counts[e.c.look * 3 + e.c.shape]!++
    const bitsPer = Math.ceil(this.tier.bitsCap / 3)
    const brick = list.length > 0 || side.bits !== null
    for (let p = 0; p < POOLS; p++) {
      const need = counts[p]! + (p < 3 ? bitsPer : 0)
      if (!side.pools[p] && counts[p] === 0 && !(p < 3 && brick)) continue
      const pool = this.pool(side, p, need)
      pool.count = 0
      pool.bits = p < 3 ? bitsPer : 0
    }
    for (const e of list) {
      const p = e.c.look * 3 + e.c.shape
      const pool = side.pools[p]!
      const slot = pool.count++
      if (e.anim) {
        fallPose(e.c, e.anim.t, SCRATCH, SCRATCH_Q)
        composeInto(pool.mat, slot * 16, SCRATCH.x, SCRATCH.y, SCRATCH.z, SCRATCH_Q, e.c.s[0], e.c.s[1], e.c.s[2])
        e.anim.slots[e.i] = p * 65536 + slot
      } else {
        composeInto(pool.mat, slot * 16, e.c.rest.x, e.c.rest.y, e.c.rest.z, e.c.rest.q, e.c.s[0], e.c.s[1], e.c.s[2])
      }
      pool.col.fill(e.c.tint, slot * 4, slot * 4 + 3)
      pool.col[slot * 4 + 3] = 1
    }
    if (!side.bits && brick) side.bits = new Bits(bitsPer * 3)
    for (let p = 0; p < POOLS; p++) {
      const pool = side.pools[p]
      if (!pool) continue
      // the bits' slots start after the pile: cleared (live bits write themselves again next frame)
      pool.mat.fill(0, pool.count * 16, (pool.count + pool.bits) * 16)
      pool.col.fill(1, pool.count * 4, (pool.count + pool.bits) * 4)
      pool.mesh.thinInstanceCount = pool.count + pool.bits
      pool.mesh.thinInstanceBufferUpdated('matrix')
      pool.mesh.thinInstanceBufferUpdated('color')
      pool.mesh.setEnabled(pool.count > 0 || (side.bits?.alive ?? 0) > 0)
    }
    if (side.bits) side.bits.live.fill(0)
  }

  /** The side's pool mesh `p` with room for `need` instances (made on first use, its buffers grown as needed). */
  private pool(side: SideState, p: number, need: number): Pool {
    let pool = side.pools[p]
    if (pool && pool.cap >= need) return pool
    const cap = Math.max(16, 1 << Math.ceil(Math.log2(Math.max(1, need))))
    if (!pool) {
      const look = p >= 3 ? 'core' : 'brick'
      const shape = p % 3
      const lm = side.src.lm[look]
      const mesh = new Mesh(`siegeStone:${side.src.info.side}:${look}${shape}`, this.scene)
      this.applyGeometry(mesh, `chunk:${look}:${shape}:${lm[0]},${lm[1]}`, () => chunkGeometry(0x5701e + shape * 7919 + (look === 'core' ? 104729 : 0), look, lm))
      mesh.material = (look === 'core' ? side.src.core : null) ?? side.src.brick
      this.decorate(mesh)
      // the pieces fall and fly anywhere around the wall: drawn whenever enabled (enabled only with stone to show)
      mesh.alwaysSelectAsActiveMesh = true
      pool = { mesh, mat: new Float32Array(0), col: new Float32Array(0), cap: 0, count: 0, bits: 0, dirty: false }
      side.pools[p] = pool
    }
    const mat = new Float32Array(cap * 16)
    const col = new Float32Array(cap * 4).fill(1)
    mat.set(pool.mat.subarray(0, Math.min(pool.mat.length, mat.length)))
    col.set(pool.col.subarray(0, Math.min(pool.col.length, col.length)))
    pool.mat = mat
    pool.col = col
    pool.cap = cap
    pool.mesh.thinInstanceSetBuffer('matrix', mat, 16, false)
    pool.mesh.thinInstanceSetBuffer('color', col, 4, false)
    return pool
  }

  private applyGeometry(mesh: Mesh, key: string, make: () => Geometry): void {
    let g = this.geometries.get(key)
    if (!g) {
      g = make()
      this.geometries.set(key, g)
    }
    const vd = new VertexData()
    vd.positions = g.positions
    vd.normals = g.normals
    vd.uvs = g.uvs
    vd.uvs2 = g.uvs2
    vd.colors = g.colors
    vd.indices = g.indices
    vd.applyToMesh(mesh, false)
  }

  private decorate(mesh: Mesh): void {
    // stone.ts winds counter-clockwise from outside, as glTF does: say so (the glTF meshes carry the same override; the
    // world's materials leave the orientation to each mesh)
    mesh.overrideMaterialSideOrientation = Material.CounterClockWiseSideOrientation
    mesh.isPickable = false
    mesh.receiveShadows = true
    mesh.metadata = { sroWorld: 'object' }
    if (this.o.layerMask) mesh.layerMask |= this.o.layerMask
  }

  // ---- broken ends ---------------------------------------------------------------------------------------------------

  /**
   * Pulls the cut-end vertices of every standing third beside a gap back along the axis (rubble.ts notchShift), so a
   * breach opens as a ragged V; a third whose neighbour stands again gets its own positions back. Only on change.
   */
  private applyNotches(): void {
    const want = new Map<string, Edge[]>()
    for (const e of this.edges) {
      const id = e.id.slice(0, -1)
      if (!this.thirdIndex.has(id)) continue
      const list = want.get(id) ?? []
      list.push(e)
      want.set(id, list)
    }
    const key = [...want.keys()].sort().join(',')
    if (key === this.notchKey) return
    this.notchKey = key
    this.restoreNotches()
    // the ends' faces follow the new profile
    for (const m of this.caps.values()) m.dispose(false, false)
    this.caps.clear()
    this.profiles.clear()
    // the teeth sit on the profile: laid out again with it
    for (const e of this.edges) this.teeth.delete(e.id)
    for (const [id, edges] of want) {
      const at = this.thirdIndex.get(id)!
      const side = this.sides.get(at.seg.side)
      if (!side) continue
      const info = side.src.info
      const base = info.placement.position[1]
      const height = Math.max(1, info.walkY - base)
      const depth = depthOf(info)
      for (const m of side.src.meshes(id)) {
        const orig = m.getVerticesData(VertexBuffer.PositionKind)
        if (!orig || this.notched.has(m)) continue
        const copy = Float32Array.from(orig)
        const pos = Float32Array.from(orig)
        const w = m.computeWorldMatrix(true)
        const inv = w.clone().invert()
        const v = new Vector3()
        let moved = false
        for (let i = 0; i < pos.length; i += 3) {
          Vector3.TransformCoordinatesFromFloatsToRef(pos[i]!, pos[i + 1]!, pos[i + 2]!, w, v)
          const along = info.axis === 'x' ? v.x : v.z
          const across = info.axis === 'x' ? v.z : v.x
          for (const e of edges) {
            if (Math.abs(along - e.at) > 0.15) continue
            const hf = (v.y - base) / height
            const wf = Math.max(0, Math.min(1, ((across - info.inner) * info.out) / depth))
            const shift = notchShift(hf, wf, seedOf(e.id, 0x7c4))
            const prof = this.profiles.get(e.id) ?? []
            prof.push([hf, wf, shift])
            this.profiles.set(e.id, prof)
            if (shift <= 0) continue
            if (info.axis === 'x') v.x -= e.dir * shift
            else v.z -= e.dir * shift
            Vector3.TransformCoordinatesToRef(v, inv, v)
            pos[i] = v.x
            pos[i + 1] = v.y
            pos[i + 2] = v.z
            moved = true
            break
          }
        }
        if (!moved) continue
        this.notched.set(m, copy)
        m.setVerticesData(VertexBuffer.PositionKind, pos, true)
        m.refreshBoundingInfo({})
      }
    }
  }

  /**
   * A broken face over every exposed end (stone.ts capGeometry): the cut glbs leave a piece's ends open, so a gap would
   * show the hollow inside of the wall. Built from the end's own (notched) vertices on the two faces.
   */
  private rebuildCaps(): void {
    const want = new Set(this.edges.map((e) => e.id))
    for (const [id, m] of this.caps) {
      if (want.has(id)) continue
      m.dispose(false, false)
      this.caps.delete(id)
    }
    for (const e of this.edges) {
      if (this.caps.has(e.id)) continue
      const side = this.sides.get(e.side.side)
      if (!side?.src.brick) continue
      const info = side.src.info
      const depth = depthOf(info)
      const outer: [number, number, number][] = [], inner: [number, number, number][] = []
      const o = new Vector3(), c = new Vector3()
      for (const m of side.src.meshes(e.id.slice(0, -1))) {
        const cur = m.getVerticesData(VertexBuffer.PositionKind)
        if (!cur) continue
        const orig = this.notched.get(m) ?? cur
        const w = m.computeWorldMatrix(true)
        for (let i = 0; i < cur.length; i += 3) {
          Vector3.TransformCoordinatesFromFloatsToRef(orig[i]!, orig[i + 1]!, orig[i + 2]!, w, o)
          if (Math.abs((info.axis === 'x' ? o.x : o.z) - e.at) > 0.15) continue
          Vector3.TransformCoordinatesFromFloatsToRef(cur[i]!, cur[i + 1]!, cur[i + 2]!, w, c)
          const wf = (((info.axis === 'x' ? c.z : c.x) - info.inner) * info.out) / depth
          if (wf > 0.75) outer.push([c.x, c.y, c.z])
          else if (wf < 0.25) inner.push([c.x, c.y, c.z])
        }
      }
      const tidy = (pts: [number, number, number][]) => pts.sort((a, b) => a[1] - b[1]).filter((p, k, a) => k === 0 || Math.abs(p[1] - a[k - 1]![1]) > 0.05)
      const dir: [number, number] = info.axis === 'x' ? [e.dir, 0] : [0, e.dir]
      const g = capGeometry(tidy(outer), tidy(inner), dir, seedOf(e.id, 0xcab), side.src.lm.brick, this.o.tier() === 'low' ? 5 : 9)
      if (!g) continue
      const mesh = new Mesh(`siegeCap:${e.id}`, this.scene)
      const vd = new VertexData()
      vd.positions = g.positions
      vd.normals = g.normals
      vd.uvs = g.uvs
      vd.uvs2 = g.uvs2
      vd.colors = g.colors
      vd.indices = g.indices
      vd.applyToMesh(mesh, false)
      mesh.material = side.src.brick
      this.decorate(mesh)
      this.caps.set(e.id, mesh)
    }
  }

  private restoreNotches(): void {
    for (const [m, orig] of this.notched) {
      if (m.isDisposed()) continue
      m.setVerticesData(VertexBuffer.PositionKind, orig, true)
      m.refreshBoundingInfo({})
    }
    this.notched.clear()
  }

  // ---- mounds ---------------------------------------------------------------------------------------------------------

  private mound(seg: WallsSegment, k: number, rise: number): void {
    const t = seg.thirds[k]!
    if (this.mounds.has(t.id)) return
    const side = this.sides.get(seg.side)
    if (!side || !side.src.brick) return
    const info = side.src.info
    const depth = depthOf(info)
    const a0 = t.from - PILE_SPREAD.ends, a1 = t.to + PILE_SPREAD.ends
    const w0 = -PILE_SPREAD.inside, w1 = depth + PILE_SPREAD.outside
    const at = (u: number, w: number) => sideXZ(info, a0 + (a1 - a0) * u, acrossAt(info, w0 + (w1 - w0) * w))
    let base = Infinity
    const ground = (x: number, z: number) => {
      const g = this.o.ground(x, z)
      const y = Number.isFinite(g) ? g : info.placement.position[1]
      base = Math.min(base, y)
      return y
    }
    const g = moundGeometry({
      cells: this.tier.mound,
      height: (u, w) => pileHeight((a0 + (a1 - a0) * u - t.from) / (t.to - t.from), w0 + (w1 - w0) * w, depth),
      ground,
      at,
      seed: seedOf(t.id, 0x40d),
      lm: side.src.lm.brick,
    })
    const mesh = new Mesh(`siegeMound:${t.id}`, this.scene)
    const vd = new VertexData()
    vd.positions = g.positions
    vd.normals = g.normals
    vd.uvs = g.uvs
    vd.uvs2 = g.uvs2
    vd.colors = g.colors
    vd.indices = g.indices
    vd.applyToMesh(mesh, false)
    mesh.material = side.src.brick
    this.decorate(mesh)
    const m: Mound = { mesh, rise, base: Number.isFinite(base) ? base : 0 }
    this.setRise(m, rise)
    this.mounds.set(t.id, m)
  }

  private setRise(m: Mound, k: number): void {
    m.rise = Math.min(1, k)
    const s = Math.max(0.02, m.rise)
    m.mesh.scaling.y = s
    m.mesh.position.y = m.base * (1 - s)
  }

  /** Mounds of thirds that stand again are gone (raise disposes them; this catches a snapshot that closes several). */
  private cleanMounds(): void {
    for (const [id, m] of this.mounds) {
      if (this.down(id)) continue
      m.mesh.dispose(false, false)
      this.mounds.delete(id)
    }
  }

  // ---- cracks -----------------------------------------------------------------------------------------------------------

  private crack(thirdId: string, level: number): void {
    const cur = this.decals.get(thirdId)
    if ((cur?.level ?? 0) === level) return
    cur?.mesh?.dispose(false, false)
    this.decals.delete(thirdId)
    if (level === 0) return
    const at = this.thirdIndex.get(thirdId)
    const side = at && this.sides.get(at.seg.side)
    if (!at || !side) return
    const faces = side.src.faces(thirdId)
    if (!faces.length) {
      this.decals.set(thirdId, { level, mesh: null })
      return
    }
    const info = side.src.info
    const t = at.seg.thirds[at.k]!
    const rnd = mulberry32(seedOf(thirdId, 0xc4ac + level))
    const [nOuter, nInner] = this.tier.decals[level - 1]!
    const depth = depthOf(info)
    const top = info.walkY - 1.5
    const base = info.placement.position[1] + 1
    const parts: Mesh[] = []
    for (const m of faces) m.computeWorldMatrix(true)
    for (let i = 0; i < nOuter + nInner; i++) {
      const outer = i < nOuter
      const w = outer ? depth : 0
      const along = t.from + (t.to - t.from) * (0.18 + 0.64 * rnd())
      const size = level === 2 ? 9 + rnd() * 5 : 6 + rnd() * 4
      const y = base + size * 0.45 + rnd() * Math.max(0, top - base - size * 0.9)
      const [x, z] = sideXZ(info, along, acrossAt(info, w))
      const dir = outer ? info.out : -info.out
      const normal = info.axis === 'x' ? new Vector3(0, 0, dir) : new Vector3(dir, 0, 0)
      for (const src of faces) {
        const d = CreateDecal(`siegeCrack:${thirdId}`, src, {
          position: new Vector3(x, y, z),
          normal,
          size: new Vector3(size, size, 3),
          angle: (rnd() - 0.5) * 0.12,
          cullBackFaces: true,
        })
        const n = d.getTotalVertices()
        if (n === 0) {
          d.dispose()
          continue
        }
        // (the decal keeps the glTF face's counter-clockwise winding: decorate() sets that orientation)
        // one variant of the atlas row
        const uvs = d.getVerticesData('uv')
        if (uvs) {
          const v = Math.floor(rnd() * CRACK_VARIANTS)
          for (let j = 0; j < uvs.length; j += 2) uvs[j] = (v + Math.min(1, Math.max(0, uvs[j]!))) / CRACK_VARIANTS
          d.setVerticesData('uv', uvs, false)
        }
        parts.push(d)
      }
    }
    let mesh: Mesh | null = null
    if (parts.length) {
      mesh = parts.length === 1 ? parts[0]! : Mesh.MergeMeshes(parts, true, true)
      if (mesh) {
        mesh.name = `siegeCrack:${thirdId}`
        mesh.material = this.crackMaterial(level as 1 | 2)
        this.decorate(mesh)
        mesh.receiveShadows = false
        mesh.alphaIndex = 1
      }
    }
    this.decals.set(thirdId, { level, mesh })
  }

  private crackMaterial(level: 1 | 2): StandardMaterial {
    const have = this.crackMats[level - 1]
    if (have) return have
    // unlit dark art: a crack is darker than the stone by day and by night, on the Classic and the PBR path alike
    const m = new StandardMaterial(`siegeCrack${level}`, this.scene)
    m.disableLighting = true
    m.diffuseColor = Color3.White()
    m.emissiveColor = Color3.Black()
    m.specularColor = Color3.Black()
    m.alphaMode = Constants.ALPHA_COMBINE
    m.transparencyMode = Material.MATERIAL_ALPHABLEND
    m.disableDepthWrite = true
    // the decal lies on the face: a constant depth bias (the slope bias is ~0 on a wall seen face-on)
    m.zOffset = -2
    m.zOffsetUnits = -8
    const size = level === 2 && this.o.tier() !== 'low' ? 512 : 256
    const tex = canPaint() ? new DynamicTexture(`siegeCrack${level}`, { width: size * CRACK_VARIANTS, height: size }, this.scene, true) : null
    if (tex) {
      paintCracks(tex.getContext() as unknown as CanvasRenderingContext2D, size, level, 0xc7ac + level * 31)
      tex.update(true)
      tex.hasAlpha = true
      m.useAlphaFromDiffuseTexture = true
      tex.wrapU = Texture.CLAMP_ADDRESSMODE
      tex.wrapV = Texture.CLAMP_ADDRESSMODE
      tex.anisotropicFilteringLevel = 4
      m.diffuseTexture = tex
    }
    this.crackTex[level - 1] = tex
    this.crackMats[level - 1] = m
    return m
  }

  // ---- scaffold ---------------------------------------------------------------------------------------------------------

  private rebuildScaffold(): void {
    const beams: Beam[] = []
    const keys: string[] = []
    const both = this.tier.bothFaces
    for (const seg of this.walls.segments) {
      const look = this.looks.get(seg.id)
      const side = this.sides.get(seg.side)
      if (!look || !side) continue
      look.scaffold.forEach((on, k) => {
        if (!on) return
        keys.push(seg.thirds[k]!.id)
        beams.push(...scaffoldBeams(seg, k, side.src.info, true, this.o.ground))
        if (both) beams.push(...scaffoldBeams(seg, k, side.src.info, false, this.o.ground))
      })
    }
    const key = `${both}:${keys.join(',')}`
    if (this.scaffold?.key === key) return
    if (!beams.length) {
      if (this.scaffold) this.scaffold.mesh.setEnabled(false)
      if (this.scaffold) this.scaffold.key = key
      return
    }
    if (!this.scaffold) {
      const mesh = new Mesh('siegeScaffold', this.scene)
      this.applyGeometry(mesh, 'beam', () => beamGeometry())
      mesh.material = this.woodMaterial()
      this.decorate(mesh)
      this.scaffold = { mesh, mat: new Float32Array(0), key: '' }
    }
    const s = this.scaffold
    if (s.mat.length < beams.length * 16) {
      s.mat = new Float32Array(Math.max(64, 1 << Math.ceil(Math.log2(beams.length))) * 16)
      s.mesh.thinInstanceSetBuffer('matrix', s.mat, 16, false)
    }
    beams.forEach((b, i) => composeInto(s.mat, i * 16, b.x, b.y, b.z, b.q, b.s[0], b.s[1], b.s[2]))
    s.mesh.thinInstanceCount = beams.length
    s.mesh.thinInstanceBufferUpdated('matrix')
    s.mesh.thinInstanceRefreshBoundingInfo(false)
    s.mesh.setEnabled(true)
    s.key = key
  }

  private woodMaterial(): Material {
    if (this.woodMat) return this.woodMat
    const tex = canPaint() ? new DynamicTexture('siegeWood', { width: 256, height: 64 }, this.scene, true) : null
    if (tex) {
      paintWood(tex.getContext() as unknown as CanvasRenderingContext2D, 256, 64, 0x3007)
      tex.update(true)
      this.woodTex = tex
    }
    let m: Material
    if (this.o.path?.() === 'pbr') {
      // the PBR path's lights are physical: timber as a rough dielectric (as fx/ships.ts), fogged like every PBR material
      const p = new PBRMaterial('siegeWood', this.scene)
      p.metallic = 0
      p.roughness = 0.92
      p.albedoColor = tex ? Color3.White() : new Color3(0.45, 0.36, 0.26)
      if (tex) p.albedoTexture = tex
      m = p
    } else {
      // lit like the world's Classic objects (materials.ts fromPbr: 2 × texture × light, BMT grey 0.59)
      const st = new StandardMaterial('siegeWood', this.scene)
      st.specularColor = Color3.Black()
      st.diffuseColor = tex ? new Color3(0.59, 0.59, 0.59) : new Color3(0.45, 0.36, 0.26)
      st.ambientColor = new Color3(0.59, 0.59, 0.59)
      if (tex) {
        tex.level = 2
        st.diffuseTexture = tex
      }
      m = st
    }
    this.woodMat = m
    return m
  }

  // ---- moments ----------------------------------------------------------------------------------------------------------

  /** A chip (lightning, a hit) or a crack burst at (x, y, z) of segment `segId`. */
  moment(kind: 'chip' | 'crack' | 'repair' | 'breach' | 'collapse', segId: string, x: number, y: number, z: number): void {
    if (this.disposed) return
    const seg = this.segById.get(segId)
    const side = seg && this.sides.get(seg.side)
    if (!seg || !side) return
    const info = side.src.info
    const tier = this.tier
    if (kind === 'chip') {
      this.burst(x, y, z, info, tier.dust.chip, { along: 1.5, low: y - 2, high: y, life: [1.2, 2.2], size: [1.4, 3] })
      this.bitsAt(side, x, y, z, tier.chipChunks, 1)
    } else if (kind === 'crack') {
      const b = seg.thirds[1]!
      this.puff('crack', seg.from, seg.to, info)
      for (let i = 0; i < tier.crackChunks; i++) {
        const along = b.from + (seg.to - seg.from) * (i / tier.crackChunks - 0.33)
        const [bx, bz] = sideXZ(info, along, info.outer)
        this.bitsAt(side, bx, info.walkY - 1 - (i % 4) * 3, bz, 1, 1)
      }
    } else if (kind === 'repair') {
      this.puff('repair', seg.from, seg.to, info)
    }
    // breach and collapse: the look change animates them (apply, live)
  }

  private puff(kind: 'crack' | 'repair', from: number, to: number, info: WallsSideInfo): void {
    const [x, z] = sideXZ(info, (from + to) / 2, acrossAt(info, depthOf(info) / 2))
    const base = info.placement.position[1]
    const n = kind === 'crack' ? this.tier.dust.crack : Math.ceil(this.tier.dust.crack / 2)
    this.burst(x, base, z, info, n, { along: (to - from) / 2, low: base, high: info.walkY, life: [2, 3.5], size: [3, 6] })
  }

  private fallDust(from: number, to: number, info: WallsSideInfo): void {
    const [x, z] = sideXZ(info, (from + to) / 2, acrossAt(info, depthOf(info) / 2))
    const base = info.placement.position[1]
    this.burst(x, base, z, info, this.tier.dust.fall, { along: (to - from) / 2 + 2, low: base, high: info.walkY * 0.95, life: [4.5, 9], size: [7, 14], across: depthOf(info) / 2 + 4 })
  }

  private fallBits(from: number, to: number, info: WallsSideInfo): void {
    const side = this.sides.get(info.side)
    if (!side) return
    const n = this.tier.collapseBits
    const rnd = mulberry32(seedOf(`${info.side}${from}`, 0xb175))
    for (let i = 0; i < n; i++) {
      const along = from + (to - from) * rnd()
      const [x, z] = sideXZ(info, along, rnd() < 0.5 ? info.outer : info.inner)
      this.bitsAt(side, x, info.placement.position[1] + 3 + rnd() * (info.walkY - 5), z, 1, rnd() < 0.5 ? 1 : -1, 0.4 + rnd() * 1.2)
    }
  }

  /** `n` bits thrown off the face at (x, y, z), outward (`dir` 1) or inward (-1). */
  private bitsAt(side: SideState, x: number, y: number, z: number, n: number, dir: 1 | -1, delay = 0): void {
    const bits = side.bits ?? this.ensureBits(side)
    if (!bits) return
    const info = side.src.info
    const F = Bits.F
    for (let i = 0; i < n; i++) {
      const b = bits.cursor
      bits.cursor = (bits.cursor + 1) % bits.n
      const f = bits.f
      const o = b * F
      const r = (k: number) => Math.sin((b + 1) * 12.9898 + k * 78.233 + x * 0.17 + z * 0.13) * 43758.5453 % 1
      const ra = Math.abs(r(1)), rb = Math.abs(r(2)), rc = Math.abs(r(3))
      const speed = 3 + ra * 5
      const out = info.out * dir
      const side2 = (rb - 0.5) * 2
      const [vx, vz] = info.axis === 'x' ? [side2 * speed * 0.5, out * speed] : [out * speed, side2 * speed * 0.5]
      f[o] = x
      f[o + 1] = y
      f[o + 2] = z
      f[o + 3] = vx
      f[o + 4] = 1.5 + rc * 3
      f[o + 5] = vz
      f[o + 6] = ra * 6
      f[o + 7] = rb * 6
      f[o + 8] = rc * 6
      f[o + 9] = (ra - 0.5) * 12
      f[o + 10] = (rb - 0.5) * 12
      f[o + 11] = (rc - 0.5) * 12
      f[o + 12] = 0.18 + ra * rb * 0.5
      f[o + 13] = -delay
      f[o + 14] = 2.2 + rc * 1.2
      const g = this.o.ground(x + vx * 0.6, z + vz * 0.6)
      f[o + 15] = (Number.isFinite(g) ? g : info.placement.position[1]) + 0.1
    }
  }

  /** Bits need the brick pools (made on the side's first pile, or here with no pile yet). */
  private ensureBits(side: SideState): Bits | null {
    if (!side.src.brick) return null
    const bitsPer = Math.ceil(this.tier.bitsCap / 3)
    for (let p = 0; p < 3; p++) {
      const pool = this.pool(side, p, (side.pools[p]?.count ?? 0) + bitsPer)
      pool.bits = bitsPer
      pool.mesh.thinInstanceCount = pool.count + pool.bits
    }
    side.bits = new Bits(bitsPer * 3)
    return side.bits
  }

  private burst(
    x: number, _y: number, z: number, info: WallsSideInfo, n: number,
    o: { along: number; low: number; high: number; life: [number, number]; size: [number, number]; across?: number },
  ): void {
    if (n <= 0) return
    const ps = this.dustSystem()
    const across = o.across ?? 2
    const [ex, ez] = info.axis === 'x' ? [o.along, across] : [across, o.along]
    ;(ps.emitter as Vector3).set(x, (o.low + o.high) / 2, z)
    const box = ps.particleEmitterType as unknown as { minEmitBox: Vector3; maxEmitBox: Vector3 }
    box.minEmitBox.set(-ex, (o.low - o.high) / 2, -ez)
    box.maxEmitBox.set(ex, (o.high - o.low) / 2, ez)
    ps.minLifeTime = o.life[0]
    ps.maxLifeTime = o.life[1]
    ps.minScaleX = ps.minScaleY = o.size[0]
    ps.maxScaleX = ps.maxScaleY = o.size[1]
    ps.manualEmitCount = Math.min(n, ps.getCapacity())
    if (!ps.isStarted()) ps.start()
  }

  private dustSystem(): ParticleSystem {
    const want = this.o.tier() === 'low' ? 2 : 4
    if (this.dust.length < want) {
      const cap = this.o.tier() === 'low' ? 110 : 300
      const ps = new ParticleSystem('siegeDust', cap, this.scene)
      ps.particleTexture = this.dustTexture()
      ps.emitter = new Vector3()
      ps.createBoxEmitter(new Vector3(-0.3, 0.6, -0.3), new Vector3(0.3, 1, 0.3), new Vector3(-1, -1, -1), new Vector3(1, 1, 1))
      ps.minEmitPower = 0.2
      ps.maxEmitPower = 0.9
      ps.emitRate = 0
      ps.gravity = new Vector3(0, 0.15, 0)
      ps.blendMode = ParticleSystem.BLENDMODE_STANDARD
      const dc = this.o.path?.() === 'pbr' ? DUST_COLOR_PBR : DUST_COLOR
      ps.addColorGradient(0, new Color4(dc.r, dc.g, dc.b, 0))
      ps.addColorGradient(0.06, new Color4(dc.r, dc.g, dc.b, 0.62))
      ps.addColorGradient(0.6, new Color4(dc.r * 0.95, dc.g * 0.95, dc.b * 0.95, 0.28))
      ps.addColorGradient(1, new Color4(dc.r, dc.g, dc.b, 0))
      ps.addSizeGradient(0, 0.45)
      ps.addSizeGradient(1, 1.6)
      ps.minAngularSpeed = -0.3
      ps.maxAngularSpeed = 0.3
      ps.minInitialRotation = 0
      ps.maxInitialRotation = Math.PI * 2
      if (this.o.layerMask) ps.layerMask |= this.o.layerMask
      this.dust.push(ps)
    }
    const ps = this.dust[this.dustNext % this.dust.length]!
    this.dustNext++
    return ps
  }

  private dustTexture(): DynamicTexture | null {
    if (this.dustTex || !canPaint()) return this.dustTex
    const tex = new DynamicTexture('siegeDustTex', { width: 64, height: 64 }, this.scene, false)
    const c = tex.getContext() as unknown as CanvasRenderingContext2D
    const g = c.createRadialGradient(32, 32, 2, 32, 32, 31)
    g.addColorStop(0, 'rgba(255,255,255,0.85)')
    g.addColorStop(0.45, 'rgba(255,255,255,0.45)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = g
    c.fillRect(0, 0, 64, 64)
    tex.update()
    tex.hasAlpha = true
    this.dustTex = tex
    return tex
  }

  // ---- per frame ---------------------------------------------------------------------------------------------------------

  /** Falls, rising mounds and bits. No allocation. */
  update(dt: number): void {
    if (this.disposed || dt <= 0) return
    for (let ai = this.animList.length - 1; ai >= 0; ai--) {
      const a = this.animList[ai]!
      const id = a.id
      a.t += dt
      const side = this.sides.get(a.side)
      if (!side) continue
      const done = a.t >= a.end
      for (let i = 0; i < a.chunks.length; i++) {
        const slot = a.slots[i]!
        if (slot < 0) continue
        const pool = side.pools[slot >> 16]
        if (!pool) continue
        const c = a.chunks[i]!
        fallPose(c, done ? a.end + 1 : a.t, SCRATCH, SCRATCH_Q)
        composeInto(pool.mat, (slot & 0xffff) * 16, SCRATCH.x, SCRATCH.y, SCRATCH.z, SCRATCH_Q, c.s[0], c.s[1], c.s[2])
        pool.dirty = true
      }
      const m = this.mounds.get(id)
      if (m && m.rise < 1) this.setRise(m, a.t / COLLAPSE.moundRise)
      if (done) {
        if (m) this.setRise(m, 1)
        this.anims.delete(id)
        this.animList.splice(ai, 1)
      }
    }
    for (let si = 0; si < this.sideList.length; si++) {
      const side = this.sideList[si]!
      if (side.bits) this.stepBits(side, side.bits, dt)
      for (let p = 0; p < POOLS; p++) {
        const pool = side.pools[p]
        if (!pool || !pool.dirty) continue
        pool.dirty = false
        pool.mesh.thinInstanceBufferUpdated('matrix')
      }
    }
  }

  private stepBits(side: SideState, bits: Bits, dt: number): void {
    const F = Bits.F
    const f = bits.f
    let alive = 0
    for (let b = 0; b < bits.n; b++) {
      const o = b * F
      const pool = side.pools[b % 3]
      if (!pool) continue
      const slot = pool.count + Math.floor(b / 3)
      const life = f[o + 14]!
      let age = f[o + 13]!
      if (age >= life) {
        if (bits.live[b]) {
          pool.mat.fill(0, slot * 16, slot * 16 + 16)
          pool.dirty = true
          bits.live[b] = 0
        }
        continue
      }
      age += dt
      f[o + 13] = age
      if (age < 0) continue
      alive++
      f[o + 4] = f[o + 4]! - COLLAPSE.gravity * dt
      f[o] = f[o]! + f[o + 3]! * dt
      f[o + 1] = f[o + 1]! + f[o + 4]! * dt
      f[o + 2] = f[o + 2]! + f[o + 5]! * dt
      if (f[o + 1]! < f[o + 15]!) {
        f[o + 1] = f[o + 15]!
        f[o + 3] = f[o + 3]! * 0.35
        f[o + 4] = Math.abs(f[o + 4]!) * 0.25
        f[o + 5] = f[o + 5]! * 0.35
        f[o + 9] = f[o + 9]! * 0.4
        f[o + 10] = f[o + 10]! * 0.4
        f[o + 11] = f[o + 11]! * 0.4
      }
      f[o + 6] = f[o + 6]! + f[o + 9]! * dt
      f[o + 7] = f[o + 7]! + f[o + 10]! * dt
      f[o + 8] = f[o + 8]! + f[o + 11]! * dt
      eulerInto(f[o + 6]!, f[o + 7]!, f[o + 8]!, SCRATCH_Q)
      const fade = Math.max(0, Math.min(1, (life - age) / 0.5))
      const s = f[o + 12]! * fade
      composeInto(pool.mat, slot * 16, f[o]!, f[o + 1]!, f[o + 2]!, SCRATCH_Q, s, s * 0.8, s)
      bits.live[b] = 1
      pool.dirty = true
    }
    if (alive > 0 && bits.alive === 0) for (let p = 0; p < 3; p++) side.pools[p]?.mesh.setEnabled(true)
    if (alive === 0 && bits.alive > 0) for (let p = 0; p < 3; p++) if (side.pools[p] && side.pools[p]!.count === 0) side.pools[p]!.mesh.setEnabled(false)
    bits.alive = alive
  }

  // ---- reads ------------------------------------------------------------------------------------------------------------

  get stats(): { chunks: number; falling: number; bits: number; mounds: number; decals: number; scaffoldBeams: number; meshes: number; dust: number; edges: number } {
    let chunks = 0, bits = 0, meshes = 0
    for (const s of this.sides.values()) {
      for (const p of s.pools) {
        if (!p) continue
        chunks += p.count
        meshes++
      }
      bits += s.bits?.alive ?? 0
    }
    let decals = 0
    for (const d of this.decals.values()) if (d.mesh) decals++
    return {
      chunks,
      falling: this.anims.size,
      bits,
      mounds: this.mounds.size,
      decals,
      scaffoldBeams: this.scaffold?.mesh.isEnabled(false) ? this.scaffold.mesh.thinInstanceCount : 0,
      meshes: meshes + this.mounds.size + decals + this.caps.size + (this.scaffold ? 1 : 0),
      dust: this.dust.length,
      edges: this.edges.length,
    }
  }

  /** Whether a pile chunk is still falling (tests). */
  get animating(): boolean {
    return this.anims.size > 0
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.restoreNotches()
    for (const m of this.caps.values()) m.dispose(false, false)
    this.caps.clear()
    this.anims.clear()
    this.animList = []
    for (const s of this.sides.values()) {
      for (const p of s.pools) p?.mesh.dispose(false, false)
      s.pools.fill(null)
      s.bits = null
    }
    for (const m of this.mounds.values()) m.mesh.dispose(false, false)
    this.mounds.clear()
    for (const d of this.decals.values()) d.mesh?.dispose(false, false)
    this.decals.clear()
    this.scaffold?.mesh.dispose(false, false)
    this.scaffold = null
    for (const ps of this.dust) ps.dispose(false)
    this.dust = []
    for (const m of this.crackMats) m?.dispose(false, true)
    this.crackMats = [null, null]
    for (const t of this.crackTex) t?.dispose()
    this.crackTex = [null, null]
    this.woodMat?.dispose(false, true)
    this.woodMat = null
    this.woodTex?.dispose()
    this.woodTex = null
    this.dustTex?.dispose()
    this.dustTex = null
    this.geometries.clear()
    this.piles.clear()
    this.teeth.clear()
    this.looks.clear()
  }
}

/**
 * How far a notched end stands back at height fraction `h` near across fraction `wf`: the end's moved vertices on the
 * nearer face, interpolated linearly by height (the mesh's own straight edges between them).
 */
export function profileAt(prof: readonly [number, number, number][], h: number, wf: number): number {
  const face = prof.filter((p) => Math.abs(p[1] - (wf < 0.5 ? 0 : 1)) < 0.25)
  const pts = (face.length >= 2 ? face : prof).slice().sort((a, b) => a[0] - b[0])
  if (!pts.length) return 0
  if (h <= pts[0]![0]) return pts[0]![2]
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!
    if (h <= b[0]) return a[2] + ((b[2] - a[2]) * (h - a[0])) / Math.max(1e-6, b[0] - a[0])
  }
  return pts[pts.length - 1]![2]
}

/** Painting textures needs a 2D canvas (absent under NullEngine in tests: the looks are made without art). */
function canPaint(): boolean {
  return typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined'
}

/** euler() of rubble.ts into `out` (yaw · pitch · roll), for the per-frame path. */
function eulerInto(pitch: number, yaw: number, roll: number, out: [number, number, number, number]): void {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2)
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2)
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2)
  out[0] = cy * sp * cr + sy * cp * sr
  out[1] = sy * cp * cr - cy * sp * sr
  out[2] = cy * cp * sr - sy * sp * cr
  out[3] = cy * cp * cr + sy * sp * sr
}


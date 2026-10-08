// Hair, cloth and body springs on the licensed characters (docs/CHARACTERS.md §16.2): the Babylon side of
// spring-bones.ts. After the clips (and the ground clamp) each frame: the animated pose of every spring chain (the
// chain at its rest rotations under its animated anchor), the body capsules, the fixed-step springs, then each chain
// bone's rotation so its child lands on its particle. Only for the nearest characters within PHYSICS_RANGE, at most the
// preset's count (Options → Hair & cloth physics, Body physics).
import { Matrix, Quaternion, Vector3, VertexBuffer, type AbstractMesh, type Observer, type Scene, type Skeleton, type TransformNode } from '@babylonjs/core'
import {
  CHAIN_PRESETS,
  jiggleParams,
  pickPhysics,
  segmentDistance,
  springPresetOf,
  SpringSim,
  type CharPhysicsConfig,
  type SpringChainSpec,
  type SpringKind,
  type SpringParams,
} from './spring-bones.ts'
import type { CharacterActor } from './models.ts'

/** The body capsules (Epic joint names): a → b, or a → a + (a − from) × ext for the head; radius in metres. */
const BODY_COLLIDERS: readonly { name: string; a: string; b?: string; from?: string; ext?: number; r: number }[] = [
  { name: 'pelvis', a: 'pelvis', b: 'spine_02', r: 0.1 },
  { name: 'thigh_l', a: 'thigh_l', b: 'calf_l', r: 0.07 },
  { name: 'thigh_r', a: 'thigh_r', b: 'calf_r', r: 0.07 },
  { name: 'calf_l', a: 'calf_l', b: 'foot_l', r: 0.05 },
  { name: 'calf_r', a: 'calf_r', b: 'foot_r', r: 0.05 },
  { name: 'chest', a: 'spine_03', b: 'spine_05', r: 0.11 },
  { name: 'neck', a: 'neck_01', b: 'head', r: 0.05 },
  { name: 'head', a: 'head', from: 'neck_01', ext: 0.12, r: 0.095 },
]

let config: CharPhysicsConfig = { max: 8, cloth: true, body: true }
const rigs = new Set<CharPhysics>()
/** Debug (the proof strip): the springs hold still. */
export const charPhysicsDebug: { paused: boolean; fixedDt?: number } = { paused: false }

/** Options / preset → the springs (world/graphics.ts). */
export function setCharPhysicsConfig(c: CharPhysicsConfig): void {
  config = { ...c }
}
export function charPhysicsConfig(): Readonly<CharPhysicsConfig> {
  return config
}
/** Characters simulating now (the perf overlay, tests). */
export function activePhysicsCount(): number {
  let n = 0
  for (const r of rigs) if (r.active) n++
  return n
}

interface Chain {
  kind: SpringKind
  spec: SpringChainSpec
  base: SpringParams
  anchor: number
  bones: TransformNode[]
  /** Per bone: rest local rotation (xyzw), local position, the child's offset in the bone's frame. */
  rest: Float64Array
  local: Float64Array
  child: Float64Array
}

/** One character's springs; `attachCharPhysics` makes it. */
export class CharPhysics {
  active = false
  private readonly sims: Record<'cloth' | 'body', SpringSim | null>
  private readonly chains: Record<'cloth' | 'body', Chain[]>
  private readonly anchors: TransformNode[]
  /** Per anchor per frame: world rotation (xyzw), position, uniform scale. */
  private readonly anchorPose: Float64Array
  private readonly order: TransformNode[]
  private readonly caps: Float32Array
  private readonly capNodes: { a: TransformNode; b: TransformNode | null; from: TransformNode | null; ext: number; r: number }[]
  private readonly obs: Observer<Scene>
  private written: Record<'cloth' | 'body', boolean> = { cloth: false, body: false }
  private size = 1
  private armour = 0

  constructor(
    private readonly scene: Scene,
    private readonly root: TransformNode,
    joints: ReadonlyMap<string, TransformNode>,
    used: ReadonlySet<string> | null,
  ) {
    // the colliders
    const capDefs = BODY_COLLIDERS.filter(c => joints.has(c.a) && (!c.b || joints.has(c.b)) && (!c.from || joints.has(c.from)))
    this.capNodes = capDefs.map(c => ({ a: joints.get(c.a)!, b: c.b ? joints.get(c.b)! : null, from: c.from ? joints.get(c.from)! : null, ext: c.ext ?? 0, r: c.r }))
    this.caps = new Float32Array(capDefs.length * 7)
    const capIndex = new Map(capDefs.map((c, i) => [c.name, i]))
    // the chains: a spring joint whose parent is not one starts a chain; a fork starts another at the extra child
    const roots: TransformNode[] = []
    for (const [name, n] of joints) {
      const parent = n.parent as TransformNode | null
      if (springPresetOf(name) && !(parent && springPresetOf(parent.name) && joints.get(parent.name) === parent)) roots.push(n)
    }
    const springKids = (n: TransformNode) => (n.getChildren(undefined, true) as TransformNode[]).filter(c => springPresetOf(c.name) && joints.get(c.name) === c)
    const lists: TransformNode[][] = []
    for (let i = 0; i < roots.length; i++) {
      const list = [roots[i]!]
      for (let n = roots[i]!; ; ) {
        const kids = springKids(n)
        if (!kids.length) break
        roots.push(...kids.slice(1))
        n = kids[0]!
        list.push(n)
      }
      // a chain no visible skin follows is not simulated (each outfit carries every hairstyle's bones)
      if (!used || list.some(b => used.has(b.name))) lists.push(list)
    }
    const anchors: TransformNode[] = []
    const made: Record<'cloth' | 'body', Chain[]> = { cloth: [], body: [] }
    const count = { cloth: 0, body: 0 }
    for (const list of lists) {
      const preset = springPresetOf(list[0]!.name)!
      const anchorNode = list[0]!.parent as TransformNode
      let anchor = anchors.indexOf(anchorNode)
      if (anchor < 0) anchor = anchors.push(anchorNode) - 1
      const k = list.length
      const rest = new Float64Array(k * 4), local = new Float64Array(k * 3), child = new Float64Array(k * 3)
      list.forEach((b, i) => {
        const q = b.rotationQuaternion ?? Quaternion.FromEulerVector(b.rotation)
        rest.set([q.x, q.y, q.z, q.w], i * 4)
        local.set([b.position.x, b.position.y, b.position.z], i * 3)
      })
      for (let i = 0; i < k; i++) {
        if (i + 1 < k) child.set(local.subarray((i + 1) * 3, (i + 2) * 3), i * 3)
        else {
          // the tip: the last bone continued along its incoming segment, in its own frame
          const v = rotate(conj(rest.subarray(i * 4, i * 4 + 4)), local.subarray(i * 3, i * 3 + 3))
          child.set(v, i * 3)
        }
      }
      const group = preset.kind === 'jiggle' ? 'body' : 'cloth'
      const colliders = preset.colliders.map(c => capIndex.get(c)).filter((c): c is number => c !== undefined)
      const params = { ...preset.params }
      made[group].push({ kind: preset.kind, base: preset.params, anchor, bones: list, rest, local, child, spec: { start: count[group], count: k + 1, params, colliders } })
      count[group] += k + 1
    }
    this.anchors = anchors
    this.anchorPose = new Float64Array(anchors.length * 8)
    this.chains = made
    this.sims = { cloth: made.cloth.length ? new SpringSim(made.cloth.map(c => c.spec), count.cloth) : null, body: made.body.length ? new SpringSim(made.body.map(c => c.spec), count.body) : null }
    // every node whose world matrix is read, ancestors first (the entity's root is above the actor's)
    const need = [...anchors, ...this.capNodes.flatMap(c => [c.a, ...(c.b ? [c.b] : []), ...(c.from ? [c.from] : [])])]
    const order: TransformNode[] = []
    const seen = new Set<TransformNode>()
    for (const n of need) {
      const path: TransformNode[] = []
      for (let p: TransformNode | null = n; p && !seen.has(p); p = p.parent as TransformNode | null) path.push(p)
      for (const p of path.reverse()) {
        seen.add(p)
        order.push(p)
      }
    }
    this.order = order
    this.fitColliders()
    this.setBody(1, 0)
    this.obs = scene.onAfterAnimationsObservable.add(() => this.frame())
    rigs.add(this)
    root.onDisposeObservable.addOnce(() => this.dispose())
  }

  /** Chains and particles (debug, tests). */
  get stats(): { cloth: number; body: number; particles: number } {
    return { cloth: this.chains.cloth.length, body: this.chains.body.length, particles: (this.sims.cloth?.n ?? 0) + (this.sims.body?.n ?? 0) }
  }

  /** The creator's size slider (0..2, 1 = as modelled) and the armour's weight (0 cloth .. 1 heavy) on the jiggle. */
  setBody(size: number, armour: number): void {
    this.size = size
    this.armour = armour
    for (const c of this.chains.body) Object.assign(c.spec.params, jiggleParams(c.base, size, armour))
  }

  get body(): { size: number; armour: number } {
    return { size: this.size, armour: this.armour }
  }

  /** Back to the pose on the next frame (a teleport, a debug restart). */
  reset(): void {
    this.sims.cloth?.reset()
    this.sims.body?.reset()
  }

  dispose(): void {
    rigs.delete(this)
    this.scene.onAfterAnimationsObservable.remove(this.obs)
  }

  /** The bind pose may sit inside a capsule (A-pose legs, a hip panel): shrink that capsule for that chain. */
  private fitColliders(): void {
    for (const n of this.order) n.computeWorldMatrix(true)
    if (this.anchors[0]) {
      this.anchors[0].getWorldMatrix().decompose(tmpV)
      this.scale = Math.abs(tmpV.x) || 1
    }
    this.readCaps()
    for (const group of ['cloth', 'body'] as const) {
      for (const c of this.chains[group]) {
        const scale = c.spec.colliders.map(() => 1)
        for (const b of c.bones.slice(1)) {
          b.computeWorldMatrix(true)
          const p = b.getAbsolutePosition()
          c.spec.colliders.forEach((ci, j) => {
            const o = ci * 7, caps = this.caps
            const d = segmentDistance(p.x, p.y, p.z, caps[o]!, caps[o + 1]!, caps[o + 2]!, caps[o + 3]!, caps[o + 4]!, caps[o + 5]!) - c.spec.params.radius
            scale[j] = Math.min(scale[j]!, Math.max(0, d / caps[o + 6]!))
          })
        }
        c.spec.colliderScale = scale
      }
    }
  }

  private readCaps(): void {
    const caps = this.caps
    this.capNodes.forEach((c, i) => {
      const a = c.a.getAbsolutePosition()
      const o = i * 7
      caps[o] = a.x
      caps[o + 1] = a.y
      caps[o + 2] = a.z
      if (c.b) {
        const b = c.b.getAbsolutePosition()
        caps[o + 3] = b.x
        caps[o + 4] = b.y
        caps[o + 5] = b.z
      } else {
        const f = c.from!.getAbsolutePosition()
        const dx = a.x - f.x, dy = a.y - f.y, dz = a.z - f.z
        const s = c.ext / Math.max(1e-6, Math.sqrt(dx * dx + dy * dy + dz * dz)) * this.rootScale()
        caps[o + 3] = a.x + dx * s
        caps[o + 4] = a.y + dy * s
        caps[o + 5] = a.z + dz * s
      }
      caps[o + 6] = c.r * this.rootScale()
    })
  }

  /** The character's uniform scale (height), from the first anchor's world matrix. */
  private scale = 1
  private rootScale(): number {
    return this.scale
  }

  private frame(): void {
    pickFor(this.scene)
    const want = { cloth: this.active && config.cloth && !!this.sims.cloth, body: this.active && config.body && !!this.sims.body }
    for (const g of ['cloth', 'body'] as const) {
      if (!want[g] && this.written[g]) this.restore(g)
      if (!want[g]) this.sims[g]?.reset()
    }
    if ((!want.cloth && !want.body) || charPhysicsDebug.paused || !this.root.isEnabled()) return
    for (const n of this.order) n.computeWorldMatrix(true)
    const m = tmpM, ap = this.anchorPose
    const sc = tmpV, rq = tmpQ, tr = tmpV2
    this.anchors.forEach((a, i) => {
      m.copyFrom(a.getWorldMatrix())
      m.decompose(sc, rq, tr)
      const o = i * 8
      ap[o] = rq.x; ap[o + 1] = rq.y; ap[o + 2] = rq.z; ap[o + 3] = rq.w
      ap[o + 4] = tr.x; ap[o + 5] = tr.y; ap[o + 6] = tr.z; ap[o + 7] = sc.x
    })
    this.scale = Math.abs(this.anchorPose[7] ?? 1) || 1
    this.readCaps()
    const dt = charPhysicsDebug.fixedDt ?? Math.min(1, this.scene.getEngine().getDeltaTime() / 1000)
    for (const g of ['cloth', 'body'] as const) {
      const sim = this.sims[g]
      if (!want[g] || !sim) continue
      for (const c of this.chains[g]) this.pose(c, sim.target)
      sim.update(dt, this.caps)
      for (const c of this.chains[g]) this.write(c, sim.out)
      this.written[g] = true
    }
  }

  /** The chain's animated pose (rest rotations under the animated anchor) into t (no allocation). */
  private pose(c: Chain, t: Float32Array): void {
    const ap = this.anchorPose, o = c.anchor * 8
    const q = SQ, v = SV
    q[0] = ap[o]!; q[1] = ap[o + 1]!; q[2] = ap[o + 2]!; q[3] = ap[o + 3]!
    let px = ap[o + 4]!, py = ap[o + 5]!, pz = ap[o + 6]!
    const s = ap[o + 7]!
    let k = c.spec.start * 3
    for (let i = 0; i < c.bones.length; i++) {
      rotInto(v, q, 0, c.local, i * 3)
      px += v[0]! * s
      py += v[1]! * s
      pz += v[2]! * s
      t[k++] = px
      t[k++] = py
      t[k++] = pz
      mulInto(q, q, 0, c.rest, i * 4)
    }
    rotInto(v, q, 0, c.child, (c.bones.length - 1) * 3)
    t[k++] = px + v[0]! * s
    t[k++] = py + v[1]! * s
    t[k] = pz + v[2]! * s
  }

  /** Each chain bone turned (from its rest) so its child lands on the simulated particle (no allocation). */
  private write(c: Chain, out: Float32Array): void {
    const ap = this.anchorPose, o = c.anchor * 8
    const q = SQ, w = SW, v = SV, d = SD, l = SL
    q[0] = ap[o]!; q[1] = ap[o + 1]!; q[2] = ap[o + 2]!; q[3] = ap[o + 3]!
    let px = ap[o + 4]!, py = ap[o + 5]!, pz = ap[o + 6]!
    const s = ap[o + 7]!
    for (let i = 0; i < c.bones.length; i++) {
      rotInto(v, q, 0, c.local, i * 3)
      px += v[0]! * s
      py += v[1]! * s
      pz += v[2]! * s
      // the bone's world rotation at rest, where that puts its child, where the particle wants it
      w[0] = q[0]!; w[1] = q[1]!; w[2] = q[2]!; w[3] = q[3]!
      mulInto(w, w, 0, c.rest, i * 4)
      rotInto(v, w, 0, c.child, i * 3)
      const k = (c.spec.start + i + 1) * 3
      fromToInto(d, v[0]!, v[1]!, v[2]!, out[k]! - px, out[k + 1]! - py, out[k + 2]! - pz)
      // new world = d × w; local = q⁻¹ × new world
      mulLeft(w, d)
      l[0] = -q[0]!; l[1] = -q[1]!; l[2] = -q[2]!; l[3] = q[3]!
      mulInto(l, l, 0, w, 0)
      const b = c.bones[i]!
      if (!b.rotationQuaternion) b.rotationQuaternion = new Quaternion()
      b.rotationQuaternion.set(l[0]!, l[1]!, l[2]!, l[3]!)
      q[0] = w[0]!; q[1] = w[1]!; q[2] = w[2]!; q[3] = w[3]!
    }
  }

  private restore(g: 'cloth' | 'body'): void {
    for (const c of this.chains[g]) {
      c.bones.forEach((b, i) => {
        const r = c.rest.subarray(i * 4, i * 4 + 4)
        b.rotationQuaternion?.set(r[0]!, r[1]!, r[2]!, r[3]!)
      })
    }
    this.written[g] = false
  }
}

const tmpV = new Vector3(), tmpV2 = new Vector3(), tmpQ = new Quaternion(), tmpM = new Matrix()
const pickedFrame = new WeakMap<Scene, number>()
const camPos = new Vector3()

/** Once a frame: the nearest `config.max` characters within range simulate (pickPhysics). */
function pickFor(scene: Scene): void {
  const f = scene.getFrameId()
  if (pickedFrame.get(scene) === f) return
  pickedFrame.set(scene, f)
  const cam = scene.activeCamera
  const list = [...rigs].filter(r => r['scene'] === scene)
  if (!cam) {
    for (const r of list) r.active = false
    return
  }
  camPos.copyFrom(cam.globalPosition)
  const d = list.map(r => {
    const root = r['root']
    if (!root.isEnabled()) return Infinity
    // this frame's position (a moved node keeps last frame's matrix until it is forced)
    root.computeWorldMatrix(true).getTranslationToRef(tmpV)
    // a 3 m hysteresis keeps the rank steady (as the shadow casters)
    return Vector3.Distance(camPos, tmpV) - (r.active ? 3 : 0)
  })
  const on = pickPhysics(d, config.max)
  list.forEach((r, i) => (r.active = on[i]!))
}

/** The spring joints a visible skin follows (bone weight > 0.01), or null when the meshes do not tell. */
export function weightedJoints(meshes: readonly AbstractMesh[], skeleton: Skeleton | null): Set<string> | null {
  if (!skeleton) return null
  const names = skeleton.bones.map(b => b.getTransformNode()?.name ?? b.name)
  const used = new Set<string>()
  let any = false
  for (const m of meshes) {
    if (!m.isEnabled() || m.skeleton !== skeleton) continue
    for (const [ik, wk] of [[VertexBuffer.MatricesIndicesKind, VertexBuffer.MatricesWeightsKind], [VertexBuffer.MatricesIndicesExtraKind, VertexBuffer.MatricesWeightsExtraKind]] as const) {
      const ix = m.getVerticesData(ik), wt = m.getVerticesData(wk)
      if (!ix || !wt) continue
      any = true
      for (let i = 0; i < ix.length; i++) {
        if (wt[i]! <= 0.01) continue
        const n = names[ix[i]!]
        if (n === undefined) return null
        used.add(n)
      }
    }
  }
  return any ? used : null
}

/** Springs on a licensed body (models.ts, after useRetarget); null when its skeleton has no spring bones. */
export function attachCharPhysics(scene: Scene, root: TransformNode, skeleton: Skeleton | null, meshes: readonly AbstractMesh[]): CharPhysics | null {
  if (!skeleton) return null
  const joints = new Map<string, TransformNode>()
  for (const b of skeleton.bones) {
    const n = b.getTransformNode()
    if (n) joints.set(n.name, n)
  }
  if (![...joints.keys()].some(n => CHAIN_PRESETS.some(([re]) => re.test(n)))) return null
  return new CharPhysics(scene, root, joints, weightedJoints(meshes, skeleton))
}

// --- quaternions as [x, y, z, w] (Hamilton; world = parent × local, as Babylon) ---

type Q = ArrayLike<number>

function mul(a: Q, b: Q): number[] {
  const ax = a[0]!, ay = a[1]!, az = a[2]!, aw = a[3]!, bx = b[0]!, by = b[1]!, bz = b[2]!, bw = b[3]!
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
}

function conj(a: Q): number[] {
  return [-a[0]!, -a[1]!, -a[2]!, a[3]!]
}

function rotate(q: Q, v: Q): number[] {
  const x = q[0]!, y = q[1]!, z = q[2]!, w = q[3]!, vx = v[0]!, vy = v[1]!, vz = v[2]!
  // t = 2 q.xyz × v; v' = v + w t + q.xyz × t
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx)
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)]
}

/** The shortest rotation taking direction a onto direction b. */
function fromTo(a: Q, b: Q): number[] {
  const o = new Float64Array(4)
  fromToInto(o, a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!)
  return [...o]
}

const SQ = new Float64Array(4), SW = new Float64Array(4), SV = new Float64Array(3), SD = new Float64Array(4), SL = new Float64Array(4)

/** out = out × b[bo..] (out may be a). */
function mulInto(out: Float64Array, a: Float64Array, ao: number, b: Float64Array, bo: number): void {
  const ax = a[ao]!, ay = a[ao + 1]!, az = a[ao + 2]!, aw = a[ao + 3]!, bx = b[bo]!, by = b[bo + 1]!, bz = b[bo + 2]!, bw = b[bo + 3]!
  out[0] = aw * bx + ax * bw + ay * bz - az * by
  out[1] = aw * by - ax * bz + ay * bw + az * bx
  out[2] = aw * bz + ax * by - ay * bx + az * bw
  out[3] = aw * bw - ax * bx - ay * by - az * bz
}

/** w = d × w. */
function mulLeft(w: Float64Array, d: Float64Array): void {
  const ax = d[0]!, ay = d[1]!, az = d[2]!, aw = d[3]!, bx = w[0]!, by = w[1]!, bz = w[2]!, bw = w[3]!
  w[0] = aw * bx + ax * bw + ay * bz - az * by
  w[1] = aw * by - ax * bz + ay * bw + az * bx
  w[2] = aw * bz + ax * by - ay * bx + az * bw
  w[3] = aw * bw - ax * bx - ay * by - az * bz
}

function rotInto(out: Float64Array, q: Float64Array, qo: number, v: Float64Array, vo: number): void {
  const x = q[qo]!, y = q[qo + 1]!, z = q[qo + 2]!, w = q[qo + 3]!, vx = v[vo]!, vy = v[vo + 1]!, vz = v[vo + 2]!
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx)
  out[0] = vx + w * tx + (y * tz - z * ty)
  out[1] = vy + w * ty + (z * tx - x * tz)
  out[2] = vz + w * tz + (x * ty - y * tx)
}

function fromToInto(out: Float64Array, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
  const la = Math.sqrt(ax * ax + ay * ay + az * az), lb = Math.sqrt(bx * bx + by * by + bz * bz)
  out[0] = out[1] = out[2] = 0
  out[3] = 1
  if (la < 1e-9 || lb < 1e-9) return
  ax /= la; ay /= la; az /= la; bx /= lb; by /= lb; bz /= lb
  const d = ax * bx + ay * by + az * bz
  if (d < -0.999999) {
    // opposite: half a turn about an axis normal to a
    const ny = Math.abs(ax) < 0.9 ? 0 : 1, nx = 1 - ny
    const cx = -az * ny, cy = az * nx, cz = ax * ny - ay * nx
    const l = Math.sqrt(cx * cx + cy * cy + cz * cz)
    out[0] = cx / l; out[1] = cy / l; out[2] = cz / l; out[3] = 0
    return
  }
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx, w = 1 + d
  const l = Math.sqrt(cx * cx + cy * cy + cz * cz + w * w)
  out[0] = cx / l; out[1] = cy / l; out[2] = cz / l; out[3] = w / l
}

/** Test seam. */
export const charPhysicsMath = { mul, conj, rotate, fromTo }

/**
 * The look check and bench of the springs (`__sroLicensed`, charbench --steps; §16.2): `runStop(at)` runs the own
 * body forwards (warm-up + run), stops it (STAND1) and freezes everything `at` s after the stop (negative: before);
 * `clones(n)` adds n more Waterbenders around it (half running in place); `physicsConfig({...})` switches the springs.
 */
export function physicsDebugApi(actor: CharacterActor, clone: () => Promise<CharacterActor>): Record<string, unknown> {
  const home = actor.root.position.clone()
  const made: CharacterActor[] = []
  const g = globalThis as { __sroLicensed?: unknown }
  return {
    physics: () => ({ config, active: activePhysicsCount(), rigs: rigs.size, stats: actor.physics?.stats ?? null, body: actor.physics?.body ?? null }),
    physicsConfig: (c: Partial<CharPhysicsConfig>) => (setCharPhysicsConfig({ ...config, ...c }), config),
    physicsBody: (size: number, armour: number) => actor.physics?.setBody(size, armour),
    live: (clip: string) => actor.debugLive(clip),
    resume: () => {
      charPhysicsDebug.paused = false
      actor.debugSpeed(1)
    },
    runStop: async (at: number, o: { run?: number; warm?: number; speed?: number; stop?: string } = {}) => {
      const run = o.run ?? 0.6, warm = o.warm ?? 1.2, speed = o.speed ?? 5.5
      charPhysicsDebug.paused = false
      const yaw = actor.root.rotationQuaternion?.toEulerAngles().y ?? 0
      const dx = Math.sin(yaw), dz = Math.cos(yaw)
      const total = warm + run
      const place = (t: number) => {
        const back = speed * (total - Math.min(t, total))
        actor.root.position.set(home.x - dx * back, home.y, home.z - dz * back)
      }
      place(0)
      if (!(await actor.debugLive('RUN'))) return false
      actor.physics?.reset()
      const scene = actor.root.getScene()
      const t0 = performance.now()
      let stopped = false
      return new Promise<boolean>(resolve => {
        const obs = scene.onBeforeAnimationsObservable.add(() => {
          const t = (performance.now() - t0) / 1000
          place(t)
          if (!stopped && t >= total) {
            stopped = true
            void actor.debugLive(o.stop ?? 'STAND1')
          }
          if (t >= total + at) {
            scene.onBeforeAnimationsObservable.remove(obs)
            // this frame still animates and simulates; hold from the next one
            scene.onAfterRenderObservable.addOnce(() => {
              actor.debugSpeed(0)
              charPhysicsDebug.paused = true
              resolve(true)
            })
          }
        })
      })
    },
    clones: async (n: number) => {
      const self = g.__sroLicensed
      const at = actor.root.getAbsolutePosition().clone()
      for (let i = 0; i < n; i++) {
        const a = await clone()
        g.__sroLicensed = self
        made.push(a)
        const col = i % 5, row = Math.floor(i / 5)
        a.root.position.set(at.x + (col - 2) * 1.6, at.y, at.z + 2 + row * 1.8)
        await a.debugLive(i % 2 ? 'RUN' : 'STAND1')
      }
      return made.length
    },
  }
}

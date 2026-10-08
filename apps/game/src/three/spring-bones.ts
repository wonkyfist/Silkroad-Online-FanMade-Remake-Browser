// Hair, cloth and body springs for the licensed characters (docs/CHARACTERS.md §16.2): the engine-free core. Verlet
// particles on the extra bones' chains, a fixed 60 Hz step, pulled towards the animated pose (stiffness), tethered to
// it (never drifts), kept at the bones' lengths (follow-the-leader) and pushed out of the body's capsules. The Babylon
// side (char-physics.ts) fills the targets from the animated skeleton and writes the bone rotations back.

/** One fixed step (s). */
export const SPRING_STEP = 1 / 60
/** At most this many steps a frame (a slower frame drops the rest of its time). */
export const SPRING_MAX_STEPS = 4
/** A frame longer than this (s), or a chain root moving farther than RESET_JUMP (m) in one frame, resets to the pose. */
export const SPRING_RESET_DT = 0.25
export const SPRING_RESET_JUMP = 1.5

export interface SpringParams {
  /** Per-step pull of each particle towards its animated position (0..1). */
  stiffness: number
  /** Per-step loss of the velocity relative to the chain root (0..1): how fast a swing settles. */
  damping: number
  /** Per-step loss of the world velocity (air): what makes hair and robes trail while running. */
  drag: number
  /** Gravity in g (9.81 m/s² down). */
  gravity: number
  /** Farthest a particle may be from its animated position, × its distance along the chain from the root. */
  tether: number
  /** Particle radius against the colliders (m). */
  radius: number
  /** Scale of the written offset from the pose (jiggle size); 1 = as simulated. */
  amplitude: number
}

/** A chain: particles [start, start + count) in the shared arrays (the first is pinned), its params and colliders. */
export interface SpringChainSpec {
  start: number
  count: number
  params: SpringParams
  /** Indices into the capsule list. */
  colliders: readonly number[]
  /** Per collider (same order): a radius scale so the bind pose is never inside it (1 = as defined). */
  colliderScale?: readonly number[]
}

/** Capsules packed 7 floats each: ax ay az bx by bz r (world space, metres). */
export type CapsuleList = Float32Array

const G = 9.81

/** The springs of one character: every chain's particles in one set of arrays. */
export class SpringSim {
  readonly n: number
  /** The animated (posed) particle positions: the caller fills this before `update`. */
  readonly target: Float32Array
  readonly pos: Float32Array
  readonly prev: Float32Array
  /** The written positions (`output`), interpolated between steps. */
  readonly out: Float32Array
  private readonly lastTarget: Float32Array
  private readonly subTarget: Float32Array
  private readonly subPrev: Float32Array
  /** Each particle's offset from its pose after the last two steps (what is drawn is the pose now + this, blended). */
  private readonly devPrev: Float32Array
  private readonly devLast: Float32Array
  private acc = 0
  private fresh = true
  /** Steps run since creation (tests, the perf overlay). */
  steps = 0

  constructor(readonly chains: readonly SpringChainSpec[], particles: number) {
    this.n = particles
    const f = () => new Float32Array(particles * 3)
    this.target = f()
    this.pos = f()
    this.prev = f()
    this.out = f()
    this.lastTarget = f()
    this.subTarget = f()
    this.subPrev = f()
    this.devPrev = f()
    this.devLast = f()
  }

  /** Back to the pose (next `update` starts from the targets). */
  reset(): void {
    this.fresh = true
  }

  /**
   * Advances by `dt` seconds of fixed steps (targets interpolated from the last frame's), then writes `out` (the state
   * between the last two steps at the leftover time). Returns the steps run.
   */
  update(dt: number, caps: CapsuleList): number {
    const t = this.target
    if (!this.fresh && (!(dt >= 0) || dt > SPRING_RESET_DT || this.jumped())) this.fresh = true
    if (this.fresh) {
      this.fresh = false
      this.pos.set(t)
      this.prev.set(t)
      this.lastTarget.set(t)
      this.acc = 0
      this.devPrev.fill(0)
      this.devLast.fill(0)
      this.out.set(t)
      return 0
    }
    this.acc += dt
    let steps = Math.floor(this.acc / SPRING_STEP)
    if (steps > SPRING_MAX_STEPS) {
      steps = SPRING_MAX_STEPS
      this.acc = 0
    } else this.acc -= steps * SPRING_STEP
    const lt = this.lastTarget, st = this.subTarget, sp = this.subPrev
    for (let s = 1; s <= steps; s++) {
      const a = s / steps, b = (s - 1) / steps
      for (let i = 0; i < t.length; i++) {
        st[i] = lt[i]! + (t[i]! - lt[i]!) * a
        sp[i] = lt[i]! + (t[i]! - lt[i]!) * b
      }
      for (const c of this.chains) this.stepChain(c, st, sp, caps)
      this.devPrev.set(this.devLast)
      for (let i = 0; i < st.length; i++) this.devLast[i] = this.pos[i]! - st[i]!
    }
    this.steps += steps
    lt.set(t)
    if (!this.finite()) {
      this.fresh = true
      this.out.set(t)
      return steps
    }
    // the pose now + the offset blended between the last two steps (CLOTH.md §6.4: at 144 Hz nothing shakes, and a
    // running body never leaves its hair a step behind)
    const alpha = Math.min(1, this.acc / SPRING_STEP)
    const o = this.out, p = this.devLast, q = this.devPrev
    for (const c of this.chains) {
      const amp = c.params.amplitude
      for (let k = c.start * 3, e = (c.start + c.count) * 3; k < e; k++) {
        o[k] = t[k]! + (q[k]! + (p[k]! - q[k]!) * alpha) * amp
      }
    }
    return steps
  }

  private jumped(): boolean {
    const t = this.target, l = this.lastTarget
    for (const c of this.chains) {
      const k = c.start * 3
      const dx = t[k]! - l[k]!, dy = t[k + 1]! - l[k + 1]!, dz = t[k + 2]! - l[k + 2]!
      if (dx * dx + dy * dy + dz * dz > SPRING_RESET_JUMP * SPRING_RESET_JUMP) return true
    }
    return false
  }

  private finite(): boolean {
    const p = this.pos
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i]!)) return false
    return true
  }

  private stepChain(c: SpringChainSpec, tg: Float32Array, tp: Float32Array, caps: CapsuleList): void {
    const p = this.pos, q = this.prev, prm = c.params
    const k0 = c.start * 3
    // the root follows the pose; its motion this step is what the damping is relative to
    const ax = tg[k0]! - tp[k0]!, ay = tg[k0 + 1]! - tp[k0 + 1]!, az = tg[k0 + 2]! - tp[k0 + 2]!
    p[k0] = q[k0] = tg[k0]!
    p[k0 + 1] = q[k0 + 1] = tg[k0 + 1]!
    p[k0 + 2] = q[k0 + 2] = tg[k0 + 2]!
    const keep = 1 - prm.damping, air = 1 - prm.drag
    const gy = -prm.gravity * G * SPRING_STEP * SPRING_STEP
    let reach = 0
    for (let j = 1; j < c.count; j++) {
      const k = k0 + j * 3, kp = k - 3
      // bone length from the pose (follows the character's height scale)
      const lx = tg[k]! - tg[kp]!, ly = tg[k + 1]! - tg[kp + 1]!, lz = tg[k + 2]! - tg[kp + 2]!
      const len = Math.sqrt(lx * lx + ly * ly + lz * lz)
      reach += len
      // verlet: velocity relative to the root damped, the world velocity dragged, gravity, pull to the pose
      let vx = p[k]! - q[k]!, vy = p[k + 1]! - q[k + 1]!, vz = p[k + 2]! - q[k + 2]!
      vx = (ax + (vx - ax) * keep) * air
      vy = (ay + (vy - ay) * keep) * air
      vz = (az + (vz - az) * keep) * air
      q[k] = p[k]!
      q[k + 1] = p[k + 1]!
      q[k + 2] = p[k + 2]!
      let x = p[k]! + vx, y = p[k + 1]! + vy + gy, z = p[k + 2]! + vz
      x += (tg[k]! - x) * prm.stiffness
      y += (tg[k + 1]! - y) * prm.stiffness
      z += (tg[k + 2]! - z) * prm.stiffness
      // tether: never farther from the pose than tether × the reach from the root
      const dx = x - tg[k]!, dy = y - tg[k + 1]!, dz = z - tg[k + 2]!
      const max = prm.tether * reach
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 > max * max) {
        const s = max / Math.sqrt(d2)
        x = tg[k]! + dx * s
        y = tg[k + 1]! + dy * s
        z = tg[k + 2]! + dz * s
      }
      // length, collide, length (follow the leader: only this particle moves)
      ;[x, y, z] = keepLength(x, y, z, p[kp]!, p[kp + 1]!, p[kp + 2]!, len)
      const cs = c.colliders
      if (cs.length) {
        let hit = false
        for (let ci = 0; ci < cs.length; ci++) {
          const o = cs[ci]! * 7
          const r = caps[o + 6]! * (c.colliderScale?.[ci] ?? 1) + prm.radius
          const res = pushOut(x, y, z, caps[o]!, caps[o + 1]!, caps[o + 2]!, caps[o + 3]!, caps[o + 4]!, caps[o + 5]!, r)
          if (res) {
            hit = true
            x = res[0]
            y = res[1]
            z = res[2]
          }
        }
        if (hit) {
          // back to the bone length, then out once more (a hair inside the body shows more than one a mm long)
          ;[x, y, z] = keepLength(x, y, z, p[kp]!, p[kp + 1]!, p[kp + 2]!, len)
          for (let ci = 0; ci < cs.length; ci++) {
            const o = cs[ci]! * 7
            const r = caps[o + 6]! * (c.colliderScale?.[ci] ?? 1) + prm.radius
            const res = pushOut(x, y, z, caps[o]!, caps[o + 1]!, caps[o + 2]!, caps[o + 3]!, caps[o + 4]!, caps[o + 5]!, r)
            if (res) [x, y, z] = res
          }
        }
      }
      // the tether once more, last: it is the guarantee (a chain can never wander off its pose); the length it may
      // cost is a few mm of direction only (the bones are turned, never stretched)
      const ex = x - tg[k]!, ey = y - tg[k + 1]!, ez = z - tg[k + 2]!
      const e2 = ex * ex + ey * ey + ez * ez
      if (e2 > max * max) {
        const s = max / Math.sqrt(e2)
        x = tg[k]! + ex * s
        y = tg[k + 1]! + ey * s
        z = tg[k + 2]! + ez * s
      }
      p[k] = x
      p[k + 1] = y
      p[k + 2] = z
    }
  }
}

function keepLength(x: number, y: number, z: number, px: number, py: number, pz: number, len: number): [number, number, number] {
  const dx = x - px, dy = y - py, dz = z - pz
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (d < 1e-9) return [px, py - len, pz]
  const s = len / d
  return [px + dx * s, py + dy * s, pz + dz * s]
}

/** `p` pushed out of the capsule a–b of radius r, or null when outside. */
export function pushOut(x: number, y: number, z: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): [number, number, number] | null {
  const ux = bx - ax, uy = by - ay, uz = bz - az
  const uu = ux * ux + uy * uy + uz * uz
  let t = uu > 1e-12 ? ((x - ax) * ux + (y - ay) * uy + (z - az) * uz) / uu : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = ax + ux * t, cy = ay + uy * t, cz = az + uz * t
  const dx = x - cx, dy = y - cy, dz = z - cz
  const d2 = dx * dx + dy * dy + dz * dz
  if (d2 >= r * r) return null
  const d = Math.sqrt(d2)
  if (d < 1e-6) return [cx, cy, cz + r]
  const s = r / d
  return [cx + dx * s, cy + dy * s, cz + dz * s]
}

/** Distance from p to the capsule's axis segment (the bind-pose clearance check). */
export function segmentDistance(x: number, y: number, z: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const ux = bx - ax, uy = by - ay, uz = bz - az
  const uu = ux * ux + uy * uy + uz * uz
  let t = uu > 1e-12 ? ((x - ax) * ux + (y - ay) * uy + (z - az) * uz) / uu : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = x - (ax + ux * t), dy = y - (ay + uy * t), dz = z - (az + uz * t)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

// --- the chain presets (by joint name; the pack's hair/cloth bones, §16.2) ---

export type SpringKind = 'hair' | 'cloth' | 'jiggle'

export interface ChainPreset {
  kind: SpringKind
  params: SpringParams
  /** Collider names (char-physics.ts BODY_COLLIDERS). */
  colliders: readonly string[]
}

const HAIR: SpringParams = { stiffness: 0.018, damping: 0.08, drag: 0.012, gravity: 1, tether: 0.5, radius: 0.012, amplitude: 1 }
const CLOTH: SpringParams = { stiffness: 0.025, damping: 0.06, drag: 0.008, gravity: 1, tether: 0.5, radius: 0.02, amplitude: 1 }
const SASH: SpringParams = { stiffness: 0.015, damping: 0.05, drag: 0.012, gravity: 1, tether: 0.6, radius: 0.012, amplitude: 1 }
const JIGGLE: SpringParams = { stiffness: 0.16, damping: 0.07, drag: 0, gravity: 0, tether: 0.25, radius: 0, amplitude: 1 }

/** The preset of a chain by its first joint's name, or null (not a spring bone). Order matters: first match wins. */
export const CHAIN_PRESETS: readonly [RegExp, ChainPreset][] = [
  [/^breast_[lr]$/, { kind: 'jiggle', params: JIGGLE, colliders: [] }],
  [/^dk_bun_/, { kind: 'hair', params: { ...HAIR, stiffness: 0.3, damping: 0.2, gravity: 0.3, tether: 0.25 }, colliders: ['head'] }],
  [/^hair_front_/, { kind: 'hair', params: { ...HAIR, stiffness: 0.025 }, colliders: ['head', 'neck', 'chest'] }],
  [/^(hair_back_|riverspirit_ponytail_)/, { kind: 'hair', params: HAIR, colliders: ['head', 'neck', 'chest'] }],
  [/^riverspirit_hair_small_tail_/, { kind: 'hair', params: { ...HAIR, stiffness: 0.05 }, colliders: ['head', 'neck'] }],
  [/^riverspirit_(skirt_|front_cloth_|layering_|tails_)/, { kind: 'cloth', params: CLOTH, colliders: ['pelvis', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r'] }],
  [/^riverspirit_(bow_0|bow_flowers_|rope_)/, { kind: 'cloth', params: SASH, colliders: ['pelvis', 'thigh_l', 'thigh_r'] }],
]

/** Whether a joint is a spring bone (simulated); bow_main etc. stay animated anchors. */
export function springPresetOf(joint: string): ChainPreset | null {
  for (const [re, p] of CHAIN_PRESETS) if (re.test(joint)) return p
  return null
}

/**
 * Jiggle under the creator and the armour (§16.2): `size` the creator's slider (0..2, 1 = the model as made) scales
 * the swing, `armour` (0 cloth .. 1 heavy plate) stiffens it and cuts it to 40 %.
 */
export function jiggleParams(base: SpringParams, size: number, armour: number): SpringParams {
  const s = Math.max(0, Math.min(2, size)), a = Math.max(0, Math.min(1, armour))
  return { ...base, stiffness: Math.min(0.9, base.stiffness * (1 + 2 * a)), amplitude: s * (1 - 0.6 * a) }
}

// --- the budget (§16.2): who simulates ---

/** Farthest a character simulates (m from the camera). */
export const PHYSICS_RANGE = 20

/** What runs: at most `max` characters (0 = none), hair and cloth, body jiggle. */
export interface CharPhysicsConfig {
  max: number
  cloth: boolean
  body: boolean
}

/** Characters with springs per render preset: none on Low / Classic, Medium 8, High and Ultra 12. */
export function physicsMaxFor(path: 'pbr' | 'classic', preset: string): number {
  if (path !== 'pbr') return 0
  return preset === 'medium' ? 8 : preset === 'high' || preset === 'ultra' ? 12 : 0
}

/** Which of the characters at `dists` (m) simulate: the nearest `max` within `range`. */
export function pickPhysics(dists: readonly number[], max: number, range = PHYSICS_RANGE): boolean[] {
  const on = dists.map(() => false)
  if (max <= 0) return on
  const idx = dists.map((d, i) => [d, i] as const).filter(([d]) => d <= range).sort((a, b) => a[0] - b[0])
  for (let k = 0; k < Math.min(max, idx.length); k++) on[idx[k]![1]] = true
  return on
}

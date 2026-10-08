/**
 * Drawing helpers of the rare-weapon effects (docs/RARITY.md §5.2) over the shared quad batch: camera-facing sprites,
 * sprites turned about an axis (beams, streaks, thrusts), flat ground decals and freely oriented emblems; plus the
 * fixed-size particle pool the auras and bursts emit into. Every helper writes straight into the batch from scalars and
 * scratch vectors: nothing is allocated per call.
 */
import { Vector3, type Camera } from '@babylonjs/core'
import type { FxBatch, Rgba } from './batch.ts'
import type { SpriteName } from './atlas.ts'

const tA = new Vector3()
const tB = new Vector3()
const tC = new Vector3()

/** One frame's drawing context: the batch, the camera axes and the eye. */
export class Painter {
  readonly right = new Vector3(1, 0, 0)
  readonly up = new Vector3(0, 1, 0)
  readonly fwd = new Vector3(0, 0, 1)
  readonly eye = new Vector3()
  readonly col: Rgba = { r: 0, g: 0, b: 0, a: 0 }
  /** Global multiplier on every colour this frame (e.g. a fade-in on equip). */
  gain = 1

  constructor(readonly batch: FxBatch) {}

  frame(camera: Camera): void {
    const m = camera.getWorldMatrix().m
    this.right.set(m[0]!, m[1]!, m[2]!).normalize()
    this.up.set(m[4]!, m[5]!, m[6]!).normalize()
    this.fwd.set(m[8]!, m[9]!, m[10]!).normalize()
    this.eye.copyFrom(camera.globalPosition)
  }

  /** Sets the scratch colour: rgb × k (light), a (darkening). */
  rgb(r: number, g: number, b: number, k: number, a = 0): Rgba {
    const c = this.col
    const s = k * this.gain
    c.r = r * s
    c.g = g * s
    c.b = b * s
    c.a = a
    return c
  }

  /** A camera-facing sprite of half-size `h` (m), turned by `spin` (rad). */
  billboard(x: number, y: number, z: number, h: number, spin: number, name: SpriteName, c: Rgba, stretch = 1): void {
    const cs = Math.cos(spin) * h
    const sn = Math.sin(spin) * h
    const r = this.right
    const u = this.up
    this.batch.quad(
      x, y, z,
      (r.x * cs + u.x * sn) * stretch, (r.y * cs + u.y * sn) * stretch, (r.z * cs + u.z * sn) * stretch,
      u.x * cs - r.x * sn, u.y * cs - r.y * sn, u.z * cs - r.z * sn,
      name, c,
    )
  }

  /**
   * A sprite along `axis` (unit): its u spans ±len along the axis, its v ±w across, turned about the axis to face the
   * camera (beams, streaks). `flip` swaps the image's up side.
   */
  alongAxis(x: number, y: number, z: number, ax: number, ay: number, az: number, len: number, w: number, name: SpriteName, c: Rgba, flip = false): void {
    // across = normalize(axis × (eye - centre))
    tA.set(this.eye.x - x, this.eye.y - y, this.eye.z - z)
    tB.set(ay * tA.z - az * tA.y, az * tA.x - ax * tA.z, ax * tA.y - ay * tA.x)
    const l = tB.length()
    if (l < 1e-6) tB.copyFrom(this.up)
    else tB.scaleInPlace(1 / l)
    const s = flip ? -w : w
    this.batch.quad(x, y, z, ax * len, ay * len, az * len, tB.x * s, tB.y * s, tB.z * s, name, c)
  }

  /**
   * A sprite beside an axis, facing the camera: centred `side` × w off the axis (across, in the camera's view), its
   * image top toward the axis (a strip's bright edge on the blade, its flames licking outward).
   */
  besideAxis(x: number, y: number, z: number, ax: number, ay: number, az: number, len: number, w: number, side: number, name: SpriteName, c: Rgba): void {
    tA.set(this.eye.x - x, this.eye.y - y, this.eye.z - z)
    tB.set(ay * tA.z - az * tA.y, az * tA.x - ax * tA.z, ax * tA.y - ay * tA.x)
    const l = tB.length()
    if (l < 1e-6) tB.copyFrom(this.up)
    else tB.scaleInPlace(1 / l)
    const o = side * w
    this.batch.quad(x + tB.x * o, y + tB.y * o, z + tB.z * o, ax * len, ay * len, az * len, -tB.x * o, -tB.y * o, -tB.z * o, name, c)
  }

  /** A flat decal on the ground plane (y up), radius `h`, turned by `spin`. */
  flat(x: number, y: number, z: number, h: number, spin: number, name: SpriteName, c: Rgba): void {
    const cs = Math.cos(spin) * h
    const sn = Math.sin(spin) * h
    this.batch.quad(x, y, z, cs, 0, sn, -sn, 0, cs, name, c)
  }

  /** A sprite in the plane of `rx` (its u) and `ux` (its image up), both pre-scaled half extents. */
  oriented(x: number, y: number, z: number, rx: number, ry: number, rz: number, ux: number, uy: number, uz: number, name: SpriteName, c: Rgba): void {
    this.batch.quad(x, y, z, rx, ry, rz, ux, uy, uz, name, c)
  }

  /** A soft line between two points (an orb stretched along it), `w` wide. */
  line(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, w: number, c: Rgba): void {
    tC.set(x1 - x0, y1 - y0, z1 - z0)
    const len = tC.length()
    if (len < 1e-5) return
    tC.scaleInPlace(1 / len)
    this.alongAxis((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, tC.x, tC.y, tC.z, len / 2 + w, w, 'orb', c)
  }
}

/** Sprites a particle can be (an index into this list). */
export const PARTICLE_SPRITES: readonly SpriteName[] = ['flare', 'orb', 'ember', 'smoke', 'mist', 'flame', 'starburst', 'shooting', 'halo']
export const P_FLARE = 0
export const P_ORB = 1
export const P_EMBER = 2
export const P_SMOKE = 3
export const P_MIST = 4
export const P_FLAME = 5

/**
 * A fixed pool of world-space particles (struct of arrays): emit, step under gravity and drag, draw as camera-facing
 * sprites with a colour ramp from `c0` to `c1` over life and an alpha curve per kind. Full: the oldest is replaced.
 */
export class Particles {
  readonly cap: number
  readonly x: Float32Array
  readonly y: Float32Array
  readonly z: Float32Array
  readonly vx: Float32Array
  readonly vy: Float32Array
  readonly vz: Float32Array
  readonly age: Float32Array
  readonly life: Float32Array
  readonly size: Float32Array
  readonly grow: Float32Array
  readonly spin: Float32Array
  readonly sprite: Uint8Array
  readonly bright: Float32Array
  /** Colour ramp: start (rgb) to end (rgb), per particle (6 floats). */
  readonly ramp: Float32Array
  /** 1 = the sprite stretches along its velocity (sparks, streaks). */
  readonly streak: Uint8Array
  count = 0
  private next = 0

  constructor(cap: number) {
    this.cap = cap
    this.x = new Float32Array(cap)
    this.y = new Float32Array(cap)
    this.z = new Float32Array(cap)
    this.vx = new Float32Array(cap)
    this.vy = new Float32Array(cap)
    this.vz = new Float32Array(cap)
    this.age = new Float32Array(cap)
    this.life = new Float32Array(cap)
    this.size = new Float32Array(cap)
    this.grow = new Float32Array(cap)
    this.spin = new Float32Array(cap)
    this.sprite = new Uint8Array(cap)
    this.bright = new Float32Array(cap)
    this.ramp = new Float32Array(cap * 6)
    this.streak = new Uint8Array(cap)
  }

  clear(): void {
    this.count = 0
    this.next = 0
    this.life.fill(0)
  }

  /** Emits one particle; c0/c1 rgb ramp, `bright` its intensity. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, grow: number, sprite: number, c0: readonly number[], c1: readonly number[], bright: number, spin = 0, streak = false): void {
    let i = -1
    if (this.count < this.cap) {
      // find a dead slot (pool is compact in the first `count` alive ones... use the ring instead)
      i = this.next
    } else i = this.next
    this.next = (this.next + 1) % this.cap
    if (this.life[i]! <= 0 || this.age[i]! >= this.life[i]!) this.count = Math.min(this.cap, this.count + 1)
    this.x[i] = x
    this.y[i] = y
    this.z[i] = z
    this.vx[i] = vx
    this.vy[i] = vy
    this.vz[i] = vz
    this.age[i] = 0
    this.life[i] = life
    this.size[i] = size
    this.grow[i] = grow
    this.spin[i] = spin
    this.sprite[i] = sprite
    this.bright[i] = bright
    this.streak[i] = streak ? 1 : 0
    const k = i * 6
    this.ramp[k] = c0[0]!
    this.ramp[k + 1] = c0[1]!
    this.ramp[k + 2] = c0[2]!
    this.ramp[k + 3] = c1[0]!
    this.ramp[k + 4] = c1[1]!
    this.ramp[k + 5] = c1[2]!
  }

  /** Advances every live particle; `gravity` m/s² (negative = down), `drag` per second. */
  step(dt: number, gravity: number, drag: number): void {
    if (dt <= 0) return
    const kd = Math.max(0, 1 - drag * dt)
    let alive = 0
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i]! <= 0) continue
      this.age[i]! += dt
      if (this.age[i]! >= this.life[i]!) {
        this.life[i] = 0
        continue
      }
      alive++
      this.vy[i]! += gravity * dt
      this.vx[i]! *= kd
      this.vy[i]! *= kd
      this.vz[i]! *= kd
      this.x[i]! += this.vx[i]! * dt
      this.y[i]! += this.vy[i]! * dt
      this.z[i]! += this.vz[i]! * dt
    }
    this.count = alive
  }

  /** Draws every live particle; `fade` × all alphas (LOD / owner fade). */
  draw(p: Painter, fade = 1): void {
    if (!this.count) return
    for (let i = 0; i < this.cap; i++) {
      const life = this.life[i]!
      if (life <= 0) continue
      const u = this.age[i]! / life
      const sp = this.sprite[i]!
      // alpha curve: quick in, smooth out (smoke and mist ease in slower)
      const soft = sp === P_SMOKE || sp === P_MIST
      const inA = Math.min(1, u * (soft ? 4 : 12))
      const outA = (1 - u) * (soft ? 1 - u : 1)
      // stars twinkle
      const tw = sp === P_FLARE || sp === P_ORB ? 0.55 + 0.45 * Math.sin(this.age[i]! * 13 + i * 7.31) : 1
      const a = inA * outA * fade * tw
      if (a <= 0.003) continue
      const k = i * 6
      const r = this.ramp[k]! + (this.ramp[k + 3]! - this.ramp[k]!) * u
      const g = this.ramp[k + 1]! + (this.ramp[k + 4]! - this.ramp[k + 1]!) * u
      const b = this.ramp[k + 2]! + (this.ramp[k + 5]! - this.ramp[k + 2]!) * u
      const size = this.size[i]! * (1 + this.grow[i]! * u)
      const c = p.rgb(r, g, b, this.bright[i]! * a, soft ? 0.12 * a : 0)
      if (this.streak[i]) {
        const vl = Math.hypot(this.vx[i]!, this.vy[i]!, this.vz[i]!)
        if (vl > 0.05) {
          const len = size * (1 + Math.min(4, vl * 0.6))
          p.alongAxis(this.x[i]!, this.y[i]!, this.z[i]!, this.vx[i]! / vl, this.vy[i]! / vl, this.vz[i]! / vl, len, size * 0.5, PARTICLE_SPRITES[sp]!, c)
          continue
        }
      }
      // flames and mist curl as they rise (each its own way)
      const curl = soft || sp === P_FLAME ? u * (1.6 * ((i % 3) - 1) + 0.6) : 0
      p.billboard(this.x[i]!, this.y[i]!, this.z[i]!, size, this.spin[i]! + curl, PARTICLE_SPRITES[sp]!, c)
    }
  }
}

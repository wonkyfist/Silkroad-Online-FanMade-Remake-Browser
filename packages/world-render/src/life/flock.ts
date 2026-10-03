/**
 * Bird flight on the CPU (docs/GRASS_LIFE.md §5.3; lane GL-L), ported from the prototype
 * (work/tmp/grass-life/lab/grass-lab.ts `Flock`) without Babylon types and with no allocation per update: every bird's
 * state lives in typed arrays, and the threats are read in place.
 *
 * `Flock` (ground flocks, roof perchers, a registered species' habitat flock such as the coast's gulls):
 *   - **circle**: each bird on a slot of a ring around a slowly drifting centre, with separation; after 20–40 s it
 *     wants to land (`wantsLanding`) and the owner gives it a spot (`land`);
 *   - **land**: each bird glides to its own slot around the spot, braking with flaps;
 *   - **ground**: wings folded, pecking, 8 cm hops; a threat within `flushM` (9 m) of the spot flushes it;
 *   - **flush**: each bird takes off after its own delay (0–0.35 s + 20 ms per metre from the threat, the bird nearest
 *     the threat at once; every delay ≤ 0.5 s, so the first bird is up within 0.25 s and all within 0.6 s, GRASS_LIFE
 *     X12), up and away at 9 m/s with fast flaps, then circles again with a centre away from the threat;
 *   - **leave**: up and away (rain, night, too far); the owner retires it.
 * Steering: a max acceleration of 14 m/s², a floor 5 cm above the ground, flap vs glide by climb and speed.
 *
 * `FlyOver` (swallows over the fields, egrets over water): a loose group crossing the focus area in a straight line
 * 12–25 m above the ground, gliding in bursts; done once it has crossed.
 *
 * Both write their birds as the bird shader's instance record (life/shaders.ts): world0 (forward, flap phase), world1
 * (bank, fold, scale, flap amplitude), world2 (dark, light: packed colours), world3 (position).
 */

/** The ground under a bird (terrain height at glTF (x, z), or null outside the loaded world). */
export interface FlockGround {
  heightAt(x: number, z: number): number | null
}

export interface FlockThreat {
  readonly x: number
  readonly y: number
  readonly z: number
}

export type FlockState = 'circle' | 'land' | 'ground' | 'flush' | 'leave'

export interface FlockOptions {
  /** The circling ring's radius (m) and height above the ground (m). */
  circleRadiusM?: number
  circleHeightM?: number
  /** Cruise and flush speeds (m/s). */
  speedMs?: number
  flushSpeedMs?: number
  /** A threat this close (m, 3D) to the landing spot flushes the grounded flock (GRASS_LIFE §5.3: 9 m). */
  flushM?: number
  /** The slot spacing on the ground (m). */
  spreadM?: number
  /** Pecking hops on the ground (ground flocks; perchers and loafing gulls sit still). */
  hops?: boolean
  /**
   * Wave 11 (W11-S, TOWN_LIFE §4): landed on water (a habitat's `float`): no hops, and each bird bobs FLOAT_BOB_M on
   * its own slow wave. Default false.
   */
  float?: boolean
  /** Cruise wing beats per second. */
  flapHz?: number
  /** Seconds circling before the flock wants to land. */
  circleS?: readonly [number, number]
}

/** GRASS_LIFE §5.3's numbers. */
export const FLUSH_M = 9
export const FLOCK_MAX_ACCEL = 14
/** The flush: every bird is off the ground within this delay (s); the one nearest the threat within the first. */
export const FLUSH_FIRST_S = 0.2
export const FLUSH_LAST_S = 0.5
/** Floats per bird record (the thin-instance matrix). */
export const BIRD_STRIDE = 16
// No Math.hypot in here: V8 boxes its result (a heap number per call), and the update allocates nothing.

/** A bird's lowest point above its ground (m). */
const FLOOR_M = 0.05
/** W11-S: a floating bird's bob (m, half the swing) and its rate (rad/s). */
export const FLOAT_BOB_M = 0.015
export const FLOAT_BOB_RATE = 1.7
/** A bird higher than this above its last known ground asks for it again only after GROUND_REFRESH_S (m, s). */
const GROUND_NEAR_M = 2.5
const GROUND_REFRESH_S = 0.3

const TAU = Math.PI * 2

/** A seeded uniform random in [0, 1) (mulberry32). */
export function flockRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Flock {
  state: FlockState = 'circle'
  /** The clock (a typed array: a double field is boxed anew on every store): time, seconds in the state, land at. */
  private readonly clk = new Float64Array(3)
  readonly pos: Float32Array
  readonly vel: Float32Array
  /** Heading (x, z) while on the ground. */
  readonly head: Float32Array
  readonly fold: Float32Array
  readonly phase: Float32Array
  readonly delay: Float32Array
  readonly hop: Float32Array
  readonly bank: Float32Array
  /** 1 once the bird has taken off in this flush. */
  readonly up: Uint8Array
  /** Each bird's ground height as last asked (NaN: unknown) and its age (s): asked every frame near the ground only. */
  private readonly gY: Float32Array
  private readonly gAge: Float32Array
  /** Each bird's slot height at the landing spot. */
  private readonly slotY: Float32Array
  /** The circle centre and the landing spot (x, y, z). */
  readonly centre = new Float64Array(3)
  readonly spot = new Float64Array(3)
  /** The flock's mean position (updated each frame). */
  readonly mean = new Float64Array(3)
  private readonly leaveDir = new Float64Array(2)
  private readonly o: Required<FlockOptions>
  private readonly rnd: () => number
  private flushedNow = false

  constructor(readonly n: number, seed: number, opts: FlockOptions = {}) {
    this.o = {
      circleRadiusM: opts.circleRadiusM ?? 14,
      circleHeightM: opts.circleHeightM ?? 15,
      speedMs: opts.speedMs ?? 7,
      flushSpeedMs: opts.flushSpeedMs ?? 9,
      flushM: opts.flushM ?? FLUSH_M,
      spreadM: opts.spreadM ?? 0.7,
      hops: (opts.hops ?? true) && !opts.float,
      float: opts.float ?? false,
      flapHz: opts.flapHz ?? 2.6,
      circleS: opts.circleS ?? [20, 40],
    }
    this.rnd = flockRandom(seed)
    this.speeds[0] = this.o.speedMs
    this.speeds[1] = this.o.flushSpeedMs
    this.pos = new Float32Array(n * 3)
    this.vel = new Float32Array(n * 3)
    this.head = new Float32Array(n * 2)
    this.fold = new Float32Array(n)
    this.phase = new Float32Array(n)
    this.delay = new Float32Array(n)
    this.hop = new Float32Array(n)
    this.bank = new Float32Array(n)
    this.up = new Uint8Array(n)
    this.slotY = new Float32Array(n)
    this.gY = new Float32Array(n).fill(NaN)
    this.gAge = new Float32Array(n)
    this.clk[0] = this.rnd() * 100
    this.clk[2] = 30
    for (let i = 0; i < n; i++) {
      this.phase[i] = this.rnd() * TAU
      const a = this.rnd() * TAU
      this.head[i * 2] = Math.cos(a)
      this.head[i * 2 + 1] = Math.sin(a)
    }
  }

  get options(): Readonly<Required<FlockOptions>> {
    return this.o
  }

  /** Seconds in the current state. */
  get stateT(): number {
    return this.clk[1]!
  }

  /** Starts circling around (x, y, z) (y: the ring's height), the birds scattered around it. */
  spawnCircle(x: number, y: number, z: number): void {
    this.centre[0] = x
    this.centre[1] = y
    this.centre[2] = z
    for (let i = 0; i < this.n; i++) {
      const p = i * 3
      this.pos[p] = x + (this.rnd() - 0.5) * 6
      this.pos[p + 1] = y + (this.rnd() - 0.5) * 3
      this.pos[p + 2] = z + (this.rnd() - 0.5) * 6
      this.vel[p] = (this.rnd() - 0.5) * 4
      this.vel[p + 1] = 0
      this.vel[p + 2] = (this.rnd() - 0.5) * 4
      this.fold[i] = 0
      this.up[i] = 0
    }
    this.enter('circle')
    this.clk[2] = this.o.circleS[0] + this.rnd() * (this.o.circleS[1] - this.o.circleS[0])
    this.updateMean()
  }

  /** Starts on the ground (perched) at the spot, every bird on its slot. */
  spawnGround(x: number, y: number, z: number, ground: FlockGround | null, fixedY = false): void {
    this.setSpot(x, y, z, ground, fixedY)
    for (let i = 0; i < this.n; i++) {
      const p = i * 3
      this.slotAt(i)
      this.pos[p] = this.tgt[0]!
      this.pos[p + 1] = this.slotY[i]!
      this.pos[p + 2] = this.tgt[2]!
      this.vel[p] = this.vel[p + 1] = this.vel[p + 2] = 0
      this.fold[i] = 1
      this.up[i] = 0
    }
    this.centre[0] = x
    this.centre[1] = y + this.o.circleHeightM
    this.centre[2] = z
    this.enter('ground')
    this.updateMean()
  }

  /** The circling flock wants a landing spot (the owner answers with `land` or `postpone`). */
  wantsLanding(): boolean {
    return this.state === 'circle' && this.clk[1]! >= this.clk[2]!
  }

  /** Circles `s` seconds more before asking again. */
  postpone(s: number): void {
    this.clk[2] = this.clk[1]! + s
  }

  /** Moves the circle centre (the owner keeps the flock near the focus). */
  setCentre(x: number, y: number, z: number): void {
    this.centre[0] = x
    this.centre[1] = y
    this.centre[2] = z
  }

  /** Lands at (x, y, z): each bird on its slot, on the ground under the slot (or at y itself: `fixedY`, a roof). */
  land(x: number, y: number, z: number, ground: FlockGround | null, fixedY = false): void {
    this.setSpot(x, y, z, ground, fixedY)
    this.enter('land')
  }

  /** Flies up and away along (dx, dz) (rain, night, too far from the focus). */
  leave(dx: number, dz: number): void {
    if (this.state === 'leave') return
    const l = Math.sqrt(dx * dx + dz * dz) || 1
    this.leaveDir[0] = dx / l
    this.leaveDir[1] = dz / l
    for (let i = 0; i < this.n; i++) this.up[i] = 1
    this.enter('leave')
  }

  /** Whether bird i is off the ground. */
  airborne(i: number): boolean {
    if (this.state === 'flush') return this.up[i] === 1
    return this.fold[i]! < 0.5
  }

  /** Birds on the ground now. */
  grounded(): number {
    let k = 0
    for (let i = 0; i < this.n; i++) if (!this.airborne(i)) k++
    return k
  }

  /** True when the last update flushed the flock (the owner fires onFlush once). */
  get flushed(): boolean {
    return this.flushedNow
  }

  private enter(s: FlockState): void {
    this.state = s
    this.clk[1] = 0
  }

  private setSpot(x: number, y: number, z: number, ground: FlockGround | null, fixedY: boolean): void {
    this.spot[0] = x
    this.spot[1] = y
    this.spot[2] = z
    for (let i = 0; i < this.n; i++) {
      this.slotAt(i)
      const g = fixedY ? null : ground?.heightAt(this.tgt[0]!, this.tgt[2]!) ?? null
      this.slotY[i] = (g ?? y) + 0.02
    }
  }

  /** The scratch target (x, y, z): a typed array, as a double field store would box a new number each time. */
  private readonly tgt = new Float64Array(3)
  /** Cruise and flush speeds as doubles (a local merging a small-integer option with a computed speed is boxed). */
  private readonly speeds = new Float64Array(2)

  /** Bird i's slot around the spot (x, z) into tx, tz (a golden-angle spiral). */
  private slotAt(i: number): void {
    const a = i * 2.39996
    const rr = this.o.spreadM * (0.85 + Math.sqrt(i))
    this.tgt[0] = this.spot[0]! + Math.cos(a) * rr
    this.tgt[2] = this.spot[2]! + Math.sin(a) * rr
  }

  private updateMean(): void {
    let x = 0, y = 0, z = 0
    for (let i = 0; i < this.n; i++) {
      x += this.pos[i * 3]!
      y += this.pos[i * 3 + 1]!
      z += this.pos[i * 3 + 2]!
    }
    this.mean[0] = x / this.n
    this.mean[1] = y / this.n
    this.mean[2] = z / this.n
  }

  /** The nearest threat to the landing spot (3D distance), or Infinity; its index into `nearestT`. */
  private nearestT = -1
  private nearestThreat(threats: readonly FlockThreat[]): number {
    let best = Infinity
    this.nearestT = -1
    for (let k = 0; k < threats.length; k++) {
      const t = threats[k]!
      const ex = t.x - this.spot[0]!, ey = t.y - this.spot[1]!, ez = t.z - this.spot[2]!
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez)
      if (d < best) {
        best = d
        this.nearestT = k
      }
    }
    return best
  }

  /** Where the threat stood when the flock flushed (the birds burst away from it). */
  private threatX = 0
  private threatZ = 0

  private flush(threat: FlockThreat): void {
    this.enter('flush')
    this.flushedNow = true
    this.threatX = threat.x
    this.threatZ = threat.z
    let nearest = -1, nd = Infinity
    for (let i = 0; i < this.n; i++) {
      const ex = threat.x - this.pos[i * 3]!, ez = threat.z - this.pos[i * 3 + 2]!
      const d = Math.sqrt(ex * ex + ez * ez)
      this.delay[i] = Math.min(FLUSH_LAST_S, this.rnd() * 0.35 + d * 0.02)
      this.up[i] = 0
      if (d < nd) {
        nd = d
        nearest = i
      }
    }
    if (nearest >= 0) this.delay[nearest] = Math.min(FLUSH_FIRST_S, nd * 0.02)
    // After the burst the flock circles away from the threat, at its ring height.
    const ax = this.spot[0]! - threat.x, az = this.spot[2]! - threat.z
    const l = Math.sqrt(ax * ax + az * az) || 1
    this.leaveDir[0] = ax / l
    this.leaveDir[1] = az / l
  }

  /**
   * One step: the flock's state, then every bird. `threats` are read in place; returns nothing (see `flushed`).
   */
  update(dt: number, threats: readonly FlockThreat[], ground: FlockGround | null): void {
    this.flushedNow = false
    if (!(dt > 0)) return
    dt = Math.min(dt, 0.1)
    this.clk[0] += dt
    this.clk[1] += dt
    const o = this.o
    // The flock's state.
    if (this.state === 'circle') {
      this.centre[0] += Math.sin(this.clk[0]! * 0.07) * dt * 1.5
      this.centre[2] += Math.cos(this.clk[0]! * 0.05) * dt * 1.5
      const g = ground?.heightAt(this.centre[0]!, this.centre[2]!)
      if (g !== null && g !== undefined) this.centre[1] += (g + o.circleHeightM - this.centre[1]!) * Math.min(1, dt * 0.5)
    } else if (this.state === 'land') {
      if (this.nearestThreat(threats) <= o.flushM + 2) {
        // Somebody walked up to the spot while the flock came in: go round again.
        this.enter('circle')
        this.clk[2] = 8 + this.rnd() * 8
      } else if (this.clk[1]! > 1) {
        let down = 0
        for (let i = 0; i < this.n; i++) if (this.fold[i]! > 0.9) down++
        if (down >= this.n - 1 || this.clk[1]! > 14) this.enter('ground')
      }
    } else if (this.state === 'ground') {
      if (this.nearestThreat(threats) <= o.flushM + 0.01 && this.nearestT >= 0) this.flush(threats[this.nearestT]!)
    } else if (this.state === 'flush' && this.clk[1]! > 2.5) {
      this.centre[0] = this.spot[0]! + this.leaveDir[0]! * 20
      this.centre[2] = this.spot[2]! + this.leaveDir[1]! * 20
      const g = ground?.heightAt(this.centre[0]!, this.centre[2]!)
      this.centre[1] = (g ?? this.spot[1]!) + o.circleHeightM
      for (let i = 0; i < this.n; i++) this.up[i] = 0
      this.enter('circle')
      this.clk[2] = o.circleS[0] + this.rnd() * (o.circleS[1] - o.circleS[0])
    }
    const state = this.state
    const tx0 = this.threatX
    const tz0 = this.threatZ
    for (let i = 0; i < this.n; i++) {
      const p = i * 3
      const px = this.pos[p]!, py = this.pos[p + 1]!, pz = this.pos[p + 2]!
      let speed = this.speeds[0]!
      let grounded = false
      let landing = false
      if (state === 'circle') {
        const ang = this.clk[0]! * 0.35 * (o.speedMs / 7) + (i / this.n) * 0.9 * (14 / o.circleRadiusM)
        this.tgt[0] = this.centre[0]! + Math.cos(ang) * o.circleRadiusM
        this.tgt[1] = this.centre[1]! + Math.sin(this.clk[0]! * 0.6 + i) * 1.5
        this.tgt[2] = this.centre[2]! + Math.sin(ang) * o.circleRadiusM
      } else if (state === 'land' || state === 'ground') {
        this.slotAt(i)
        this.tgt[1] = this.slotY[i]!
        const dx = this.tgt[0]! - px, dy = this.tgt[1]! - py, dz = this.tgt[2]! - pz
        const dd = Math.sqrt(dx * dx + dy * dy + dz * dz)
        speed = Math.min(this.speeds[0]!, 0.6 + dd * 0.7)
        grounded = dd < 0.4 || (state === 'ground' && this.fold[i]! > 0.9)
        landing = dd < 2
      } else if (state === 'flush') {
        if (!this.up[i] && this.clk[1]! < this.delay[i]!) {
          grounded = true
          this.tgt[0] = px
          this.tgt[1] = py
          this.tgt[2] = pz
        } else {
          let ax = px - tx0, az = pz - tz0
          const l = Math.sqrt(ax * ax + az * az) || 1
          ax /= l
          az /= l
          if (!this.up[i]) {
            // Take-off: a jump up and away in this very frame (airborne at once).
            this.up[i] = 1
            this.vel[p] = ax * 3
            this.vel[p + 1] = 4.5
            this.vel[p + 2] = az * 3
            this.fold[i] = Math.min(this.fold[i]!, 0.45)
          }
          this.tgt[0] = px + ax * 6
          this.tgt[1] = py + 5
          this.tgt[2] = pz + az * 6
          speed = this.speeds[1]!
        }
      } else {
        // leave: up and away
        this.tgt[0] = px + this.leaveDir[0]! * 20
        this.tgt[1] = py + 4
        this.tgt[2] = pz + this.leaveDir[1]! * 20
        speed = this.speeds[1]!
      }
      if (grounded && state !== 'flush') {
        // Folded, pecking and hopping; the bird turns now and then.
        this.fold[i] = Math.min(1, this.fold[i]! + dt * 4)
        this.vel[p] *= 0.8
        this.vel[p + 1] = 0
        this.vel[p + 2] *= 0.8
        let hy = 0
        if (o.hops) {
          this.hop[i] = Math.max(0, this.hop[i]! - dt)
          if (this.hop[i]! <= 0 && this.rnd() < dt * 0.6) {
            this.hop[i] = 0.25
            const a = Math.atan2(this.head[i * 2 + 1]!, this.head[i * 2]!) + (this.rnd() - 0.5) * 1.6
            this.head[i * 2] = Math.cos(a)
            this.head[i * 2 + 1] = Math.sin(a)
          }
          hy = this.hop[i]! > 0 ? Math.sin((this.hop[i]! / 0.25) * Math.PI) * 0.08 : 0
        } else if (o.float) {
          // W11-S: afloat, each bird on its own slow wave (a per-bird offset; no random draw).
          hy = Math.sin(this.clk[0]! * FLOAT_BOB_RATE + i * 2.39996) * FLOAT_BOB_M
        }
        this.pos[p] = this.tgt[0]!
        this.pos[p + 1] = this.tgt[1]! + hy
        this.pos[p + 2] = this.tgt[2]!
      } else if (grounded) {
        this.fold[i] = 1
      } else {
        this.fold[i] = Math.max(0, this.fold[i]! - dt * 5)
        let dx = this.tgt[0]! - px, dy = this.tgt[1]! - py, dz = this.tgt[2]! - pz
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (dl > 0.001) {
          dx *= speed / dl
          dy *= speed / dl
          dz *= speed / dl
        }
        if (!landing) {
          for (let k = 0; k < this.n; k++) {
            if (k === i) continue
            const sx = px - this.pos[k * 3]!, sy = py - this.pos[k * 3 + 1]!, sz = pz - this.pos[k * 3 + 2]!
            const d2 = sx * sx + sy * sy + sz * sz
            if (d2 < 1.2 && d2 > 1e-4) {
              dx += (sx * 1.5) / d2
              dy += (sy * 1.5) / d2
              dz += (sz * 1.5) / d2
            }
          }
        }
        let sx = dx - this.vel[p]!, sy = dy - this.vel[p + 1]!, sz = dz - this.vel[p + 2]!
        const sl = Math.sqrt(sx * sx + sy * sy + sz * sz)
        if (sl > FLOCK_MAX_ACCEL) {
          sx *= FLOCK_MAX_ACCEL / sl
          sy *= FLOCK_MAX_ACCEL / sl
          sz *= FLOCK_MAX_ACCEL / sl
        }
        const ox = this.vel[p]!, oz = this.vel[p + 2]!
        this.vel[p] = ox + sx * dt
        this.vel[p + 1] = this.vel[p + 1]! + sy * dt
        this.vel[p + 2] = oz + sz * dt
        this.pos[p] = px + this.vel[p]! * dt
        this.pos[p + 1] = py + this.vel[p + 1]! * dt
        this.pos[p + 2] = pz + this.vel[p + 2]! * dt
        // Bank into the turn (the yaw rate of the horizontal velocity).
        const turn = (oz * this.vel[p]! - ox * this.vel[p + 2]!) / Math.max(1e-3, Math.sqrt((ox * ox + oz * oz) * (this.vel[p]! * this.vel[p]! + this.vel[p + 2]! * this.vel[p + 2]!)))
        const bank = Math.max(-0.7, Math.min(0.7, (turn / dt) * 0.3))
        this.bank[i] = this.bank[i]! + (bank - this.bank[i]!) * Math.min(1, dt * 4)
        const h = Math.sqrt(this.vel[p]! * this.vel[p]! + this.vel[p + 2]! * this.vel[p + 2]!)
        if (h > 0.1) {
          this.head[i * 2] = this.vel[p]! / h
          this.head[i * 2 + 1] = this.vel[p + 2]! / h
        }
      }
      // The floor: never below the ground (a bird on its slot or perch stands where it was put). High birds ask the
      // ground a few times a second, low ones every frame.
      if (!grounded) {
        this.gAge[i] = this.gAge[i]! + dt
        if (ground && (this.gAge[i]! > GROUND_REFRESH_S || !(this.pos[p + 1]! - this.gY[i]! > GROUND_NEAR_M))) {
          this.gY[i] = ground.heightAt(this.pos[p]!, this.pos[p + 2]!) ?? NaN
          this.gAge[i] = 0
        }
        // Read back from the typed array: a double all the way (a local merged with the call's result would be boxed).
        const g = this.gY[i]!
        if (g === g && this.pos[p + 1]! < g + FLOOR_M) {
          this.pos[p + 1] = g + FLOOR_M
          if (this.vel[p + 1]! < 0) this.vel[p + 1] = 0
        }
      } else this.gAge[i] = GROUND_REFRESH_S + 1
      // Wings: fast when climbing or slow, glide bursts in cruise.
      const vx = this.vel[p]!, vy = this.vel[p + 1]!, vz = this.vel[p + 2]!
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz)
      const climbing = vy > 0.5 || sp < 4 || state === 'flush'
      this.phase[i] = this.phase[i]! + dt * TAU * o.flapHz * (climbing ? 1.4 : 1)
      if (this.phase[i]! > 6283.185307) this.phase[i] = this.phase[i]! - 6283.185307
    }
    this.updateMean()
  }

  /**
   * Writes the birds' records at `buf[at]` (BIRD_STRIDE floats each); `scale` the species' size, `dark` / `light` its
   * packed colours, `ampScale` its stroke. Returns the number written (n).
   */
  write(buf: Float32Array, at: number, scale: number, dark: number, light: number, ampScale = 1): number {
    for (let i = 0; i < this.n; i++) {
      const p = i * 3
      const vx = this.vel[p]!, vy = this.vel[p + 1]!, vz = this.vel[p + 2]!
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz)
      const folded = this.fold[i]! > 0.5
      let fx = this.head[i * 2]!, fy = 0, fz = this.head[i * 2 + 1]!
      if (!folded && sp > 0.1) {
        fx = vx / sp
        fy = vy / sp
        fz = vz / sp
      }
      const climbing = vy > 0.5 || sp < 4 || this.state === 'flush'
      const glide = !climbing && Math.sin(this.clk[0]! * 0.9 + i * 1.7) > 0.3
      const amp = folded ? 0 : (glide ? 0.05 : climbing ? 1.0 : 0.75) * ampScale
      // Written in place (a helper taking the doubles as arguments would box each one when V8 does not inline it).
      const o = at + i * BIRD_STRIDE
      buf[o] = fx
      buf[o + 1] = fy
      buf[o + 2] = fz
      buf[o + 3] = this.phase[i]!
      buf[o + 4] = folded ? 0 : this.bank[i]!
      buf[o + 5] = this.fold[i]!
      buf[o + 6] = scale
      buf[o + 7] = amp
      buf[o + 8] = dark
      buf[o + 9] = light
      buf[o + 10] = 0
      buf[o + 11] = 0
      buf[o + 12] = this.pos[p]!
      buf[o + 13] = this.pos[p + 1]!
      buf[o + 14] = this.pos[p + 2]!
      buf[o + 15] = 1
    }
    return this.n
  }
}

export interface FlyOverOptions {
  /** Height above the ground (m). */
  heightM: number
  speedMs: number
  flapHz: number
  /** The path's half length (m): it starts this far before the crossing point and ends this far after. */
  halfLengthM: number
}

/** A group crossing the area in a straight line (swallows over the fields, egrets over water). */
export class FlyOver {
  readonly pos: Float32Array
  private readonly off: Float32Array
  private readonly phase: Float32Array
  private travelled = 0
  private time = 0
  private readonly fx: number
  private readonly fz: number
  private readonly x0: number
  private readonly z0: number
  private readonly o: FlyOverOptions
  private backMax = 0
  private ready = false
  private readonly gY: Float32Array
  private readonly gAge: Float32Array

  /** Crosses (cx, cz) along (dx, dz). */
  constructor(readonly n: number, seed: number, cx: number, cz: number, dx: number, dz: number, opts: FlyOverOptions) {
    const rnd = flockRandom(seed)
    const l = Math.sqrt(dx * dx + dz * dz) || 1
    this.fx = dx / l
    this.fz = dz / l
    this.o = opts
    this.x0 = cx - this.fx * opts.halfLengthM
    this.z0 = cz - this.fz * opts.halfLengthM
    this.pos = new Float32Array(n * 3)
    this.off = new Float32Array(n * 3)
    this.phase = new Float32Array(n)
    this.gY = new Float32Array(n).fill(NaN)
    this.gAge = new Float32Array(n).fill(1)
    for (let i = 0; i < n; i++) {
      // A loose group: lateral, back and height offsets.
      this.off[i * 3] = (rnd() - 0.5) * 2 * (1.5 + i * 0.6)
      this.off[i * 3 + 1] = i * (1.2 + rnd() * 1.5)
      this.off[i * 3 + 2] = (rnd() - 0.5) * 2
      this.phase[i] = rnd() * TAU
      this.backMax = Math.max(this.backMax, this.off[i * 3 + 1]!)
    }
  }

  /** Crossed and gone. */
  get done(): boolean {
    return this.travelled - this.backMax > this.o.halfLengthM * 2
  }

  update(dt: number, ground: FlockGround | null): void {
    if (!(dt > 0)) return
    dt = Math.min(dt, 0.1)
    this.time += dt
    this.travelled += this.o.speedMs * dt
    for (let i = 0; i < this.n; i++) {
      const s = this.travelled - this.off[i * 3 + 1]!
      const lat = this.off[i * 3]! + Math.sin(this.time * 0.8 + i * 1.3) * 0.8
      const x = this.x0 + this.fx * s - this.fz * lat
      const z = this.z0 + this.fz * s + this.fx * lat
      this.gAge[i] = this.gAge[i]! + dt
      if (ground && this.gAge[i]! > GROUND_REFRESH_S) {
        this.gY[i] = ground.heightAt(x, z) ?? NaN
        this.gAge[i] = 0
      }
      const g = this.gY[i]!
      const want = (g === g ? g : 0) + this.o.heightM + this.off[i * 3 + 2]!
      const p = i * 3
      const y = this.ready ? this.pos[p + 1]! + Math.max(-3 * dt, Math.min(3 * dt, want - this.pos[p + 1]!)) : want
      this.pos[p] = x
      this.pos[p + 1] = g === g ? Math.max(y, g + 2) : y
      this.pos[p + 2] = z
      this.phase[i] = (this.phase[i]! + dt * TAU * this.o.flapHz) % 6283.185307
    }
    this.ready = true
  }

  write(buf: Float32Array, at: number, scale: number, dark: number, light: number, ampScale = 1): number {
    for (let i = 0; i < this.n; i++) {
      const p = i * 3
      const glide = Math.sin(this.time * 0.7 + i * 2.1) > 0.2
      const o = at + i * BIRD_STRIDE
      buf[o] = this.fx
      buf[o + 1] = 0
      buf[o + 2] = this.fz
      buf[o + 3] = this.phase[i]!
      buf[o + 4] = 0
      buf[o + 5] = 0
      buf[o + 6] = scale
      buf[o + 7] = (glide ? 0.05 : 0.8) * ampScale
      buf[o + 8] = dark
      buf[o + 9] = light
      buf[o + 10] = 0
      buf[o + 11] = 0
      buf[o + 12] = this.pos[p]!
      buf[o + 13] = this.pos[p + 1]!
      buf[o + 14] = this.pos[p + 2]!
      buf[o + 15] = 1
    }
    return this.n
  }
}

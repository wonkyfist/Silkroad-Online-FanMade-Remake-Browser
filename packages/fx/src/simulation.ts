/**
 * The EFP element simulation at the original 20 Hz timeline. Engine-free (it could run in a worker); the Babylon
 * side is ./renderer.ts.
 *
 * Model (clean-room; the rules come from the format docs and from OpenSRO's notes on the native runtime, read as
 * documentation only):
 * - Every node of an effect is an emitter. The effect instance is the root "element"; a top-level node emits
 *   from it, and every other node emits from each live element of its parent node (one group per parent element).
 * - Emission (StaticEmit): at parent ages start, start + period, ... (while age - start < duration) the group's
 *   float total becomes min(limit, total + rate); the whole-number increase is the number of births. A retiring
 *   element gives one back, so `limit` caps concurrent elements, not the total.
 * - An element is born at its parent's position and orientation (plus the parent's velocity relative to the
 *   followed ancestor), lives `frames` ticks (or loops / never dies), and runs its node's commands at the ages
 *   their schedules name. Each tick it first follows its ancestors (link depths), then moves by its velocity,
 *   applies angular velocity and shape spin, then runs that age's commands and tables.
 * - Dead elements stop emitting and stop being followed; their descendants live on.
 *
 * Coordinates: the program's glTF space in metres, divided by the instance scale (so rootScale and the caller's
 * scale apply to every length); the renderer multiplies back. Velocities are per tick.
 */
import { FX_FPS, scheduleMask, scheduleRuns, type FxCommand, type FxEffect, type FxNode, type FxTable } from './program.ts'
import { apply3, copy3, identity3, mul3, mulTranspose3, random01, type M3, type V3 } from './math.ts'

export interface FxElement {
  readonly node: number
  readonly serial: number
  readonly parent: FxElement | null
  alive: boolean
  age: number
  pos: V3
  /** Position at the start of the current tick (for interpolation and motion deltas). */
  prev: V3
  vel: V3
  orient: M3
  shape: M3
  scale: V3
  color: [number, number, number, number]
  /** Texture window (u, v, width, height) or null for the whole texture. */
  uv: [number, number, number, number] | null
  spin: M3 | null
  angVel: M3 | null
  /** This tick's motion, followed by descendants. */
  dPos: V3
  dRot: M3
  groups: Map<number, FxGroup>
  group: FxGroup | null
}

export interface FxGroup {
  readonly parent: FxElement
  readonly node: number
  total: number
  /** Live members in birth order. */
  members: FxElement[]
}

/** A table with, per age, the run index whose row applies (-1: not scheduled). */
interface TableRuns {
  runs: Int32Array
  t: FxTable
}

interface CompiledNode {
  def: FxNode
  masks: Uint8Array[]
  scale?: TableRuns
  color?: TableRuns
  uv?: TableRuns
  banPosition?: TableRuns
  banRotation?: TableRuns
}

export interface FxRootPose {
  /** World position (glTF space, metres). */
  position: V3
  /** World orientation, column-major 3x3 (rotation only). */
  rotation?: M3
}

export interface FxSimulationOptions {
  /** Multiplies the effect's own root scale. */
  scale?: number
  seed?: number
  /** Restart when the effect has finished (finite effects only). */
  loop?: boolean
  /** Safety cap on live elements. */
  maxElements?: number
}

/** Offset of the row for an age, or -1 when the table does not run then. */
const row = (r: TableRuns | undefined, width: number, age: number): number => {
  const k = r?.runs[age] ?? -1
  return k < 0 ? -1 : Math.min(k, r!.t.values.length / width - 1) * width
}

export class FxSimulation {
  readonly effect: FxEffect
  readonly scale: number
  readonly nodes: CompiledNode[]
  /** Live elements per node, in birth order. */
  readonly elements: FxElement[][]
  /** Completed ticks since start (the root's age). */
  tick = 0
  /** Ticks since the last (re)start. */
  private age = 0
  private root: FxElement
  private serial = 0
  private random: () => number
  private emitting = true
  private stopped = false
  private started = false
  readonly loop: boolean
  readonly maxElements: number
  /** Elements dropped because of maxElements. */
  dropped = 0

  constructor(effect: FxEffect, options: FxSimulationOptions = {}) {
    this.effect = effect
    this.scale = effect.scale * (options.scale ?? 1)
    this.loop = options.loop ?? false
    this.maxElements = options.maxElements ?? 20000
    this.random = random01(options.seed ?? 0x5eed)
    this.nodes = effect.nodes.map(def => {
      const compiled: CompiledNode = { def, masks: def.commands.map(c => scheduleMask(c.at, def.frames)) }
      for (const key of ['scale', 'color', 'uv', 'banPosition', 'banRotation'] as const) {
        const t = def[key]
        if (t) compiled[key] = { runs: scheduleRuns(t.at, def.frames), t }
      }
      return compiled
    })
    this.elements = effect.nodes.map(() => [])
    this.root = this.makeElement(-1, null)
  }

  /** Number of live elements that draw something. */
  get visibleCount(): number {
    let n = 0
    for (let i = 0; i < this.nodes.length; i++) if (this.nodes[i]!.def.render !== 'none') n += this.elements[i]!.length
    return n
  }

  get liveCount(): number {
    let n = 0
    for (const list of this.elements) n += list.length
    return n
  }

  /** True once emission is over (finished or stopped) and nothing is alive. */
  get finished(): boolean {
    return this.started && this.liveCount === 0 && (!this.emitting || this.emissionClosed())
  }

  /** Stops new births; live elements finish their lives. A stopped looping effect does not restart. */
  stop(): void {
    this.emitting = false
    this.stopped = true
  }

  /** True after stop() (until restart()). */
  get isStopped(): boolean {
    return this.stopped
  }

  /** Clears everything and starts again at tick 0. */
  restart(): void {
    for (const list of this.elements) list.length = 0
    this.root = this.makeElement(-1, null)
    this.age = 0
    this.emitting = true
    this.stopped = false
    this.started = false
  }

  /** Advances one 20 Hz tick with the root at `pose`. */
  step(pose: FxRootPose): void {
    if (this.started && this.loop && !this.stopped && this.finished) this.restart()
    this.moveRoot(pose)
    for (let n = 0; n < this.nodes.length; n++) {
      const node = this.nodes[n]!
      const list = this.elements[n]!
      // Existing elements: age, retire, follow, move, commands.
      let w = 0
      for (let i = 0; i < list.length; i++) {
        const e = list[i]!
        if (this.advance(e, node)) list[w++] = e
        else this.retire(e)
      }
      list.length = w
      // Births from every live parent element (the root for top-level nodes).
      if (!this.emitting || !node.def.emit) continue
      const parents = node.def.parent < 0 ? [this.root] : this.elements[node.def.parent]!
      for (const p of parents) this.emitFrom(p, n, node)
    }
    this.started = true
    this.age++
    this.tick++
  }

  /** Seconds of simulated time per tick. */
  static readonly TICK = 1 / FX_FPS

  private emissionClosed(): boolean {
    // Top-level emitters are driven by the root's age; once every one is past its window nothing new can start.
    for (const node of this.nodes) {
      const e = node.def.emit
      if (node.def.parent >= 0 || !e || e.period <= 0 || e.rate <= 0) continue
      if (this.age - e.start < e.duration) return false
    }
    return true
  }

  private makeElement(node: number, parent: FxElement | null): FxElement {
    return {
      node,
      serial: this.serial++,
      parent,
      alive: true,
      age: 0,
      pos: parent ? [...parent.pos] : [0, 0, 0],
      prev: parent ? [...parent.pos] : [0, 0, 0],
      vel: [0, 0, 0],
      orient: parent ? copy3(parent.orient) : identity3(),
      shape: identity3(),
      scale: [1, 1, 1],
      color: [1, 1, 1, 1],
      uv: null,
      spin: null,
      angVel: null,
      dPos: [0, 0, 0],
      dRot: identity3(),
      groups: new Map(),
      group: null,
    }
  }

  private moveRoot(pose: FxRootPose): void {
    const r = this.root
    const inv = 1 / this.scale
    const pos: V3 = [pose.position[0] * inv, pose.position[1] * inv, pose.position[2] * inv]
    const rot = pose.rotation ? copy3(pose.rotation) : identity3()
    if (!this.started) {
      r.pos = pos
      r.prev = [...pos]
      r.orient = rot
      r.dPos = [0, 0, 0]
      r.dRot = identity3()
    } else {
      r.prev = r.pos
      r.pos = pos
      r.dPos = [pos[0] - r.prev[0], pos[1] - r.prev[1], pos[2] - r.prev[2]]
      r.dRot = mulTranspose3(rot, r.orient)
      r.orient = rot
    }
    r.age = this.age
  }

  private ancestor(e: FxElement, depth: number): FxElement | null {
    if (depth <= 0) return null
    let a = e.parent
    for (let d = 1; d < depth && a?.parent; d++) a = a.parent
    return a && a.alive ? a : null
  }

  /** One tick of an existing element; false when it retires. */
  private advance(e: FxElement, node: CompiledNode): boolean {
    const def = node.def
    let age = e.age + 1
    if (age >= def.frames) {
      if (def.life === 'extinct') return false
      if (def.life === 'loop') age = 0
    }
    e.age = age
    const prevPos: V3 = [...e.pos]
    const prevOrient = copy3(e.orient)
    e.prev = prevPos
    const link = def.link
    const pa = this.ancestor(e, link.positionDepth)
    if (pa) {
      const rel = apply3(pa.dRot, [e.pos[0] - pa.prev[0], e.pos[1] - pa.prev[1], e.pos[2] - pa.prev[2]])
      e.pos = [pa.prev[0] + rel[0], pa.prev[1] + rel[1], pa.prev[2] + rel[2]]
    }
    const fa = this.ancestor(e, link.followDepth)
    if (fa) {
      e.pos[0] += fa.dPos[0]
      e.pos[1] += fa.dPos[1]
      e.pos[2] += fa.dPos[2]
    }
    const ma = this.ancestor(e, link.matrixDepth)
    if (ma) mul3(ma.dRot, e.orient, e.orient)
    const va = this.ancestor(e, link.velocityDepth)
    if (va) e.vel = apply3(va.dRot, e.vel)
    e.pos[0] += e.vel[0]
    e.pos[1] += e.vel[1]
    e.pos[2] += e.vel[2]
    if (link.localMotion && e.angVel) mul3(e.orient, e.angVel, e.orient)
    if (link.shapeMotion && e.spin) mul3(e.shape, e.spin, e.shape)
    this.run(e, node, age)
    e.dPos = [e.pos[0] - prevPos[0], e.pos[1] - prevPos[1], e.pos[2] - prevPos[2]]
    e.dRot = mulTranspose3(e.orient, prevOrient)
    return true
  }

  private retire(e: FxElement): void {
    e.alive = false
    const g = e.group
    if (g) {
      g.total = Math.fround(g.total - 1)
      const i = g.members.indexOf(e)
      if (i >= 0) g.members.splice(i, 1)
    }
  }

  private emitFrom(p: FxElement, n: number, node: CompiledNode): void {
    if (!p.alive) return
    const emit = node.def.emit!
    let group = p.groups.get(n)
    if (!group) {
      group = { parent: p, node: n, total: 0, members: [] }
      p.groups.set(n, group)
    }
    const age = p.age - emit.start
    if (age < 0 || age >= emit.duration || emit.period <= 0 || age % emit.period !== 0) return
    const next = Math.fround(Math.min(emit.limit, group.total + emit.rate))
    const births = Math.trunc(next) - Math.trunc(group.total)
    group.total = next
    for (let b = 0; b < births; b++) {
      if (this.liveCount >= this.maxElements) {
        this.dropped++
        group.total = Math.fround(group.total - 1)
        continue
      }
      this.birth(p, n, node, group)
    }
  }

  private birth(p: FxElement, n: number, node: CompiledNode, group: FxGroup): void {
    const def = node.def
    const e = this.makeElement(n, p)
    e.group = group
    if (def.link.matrixDepth < 0) e.orient = identity3()
    const follow = this.ancestor(e, def.link.followDepth)
    const inherited: V3 = [p.vel[0] - (follow?.vel[0] ?? 0), p.vel[1] - (follow?.vel[1] ?? 0), p.vel[2] - (follow?.vel[2] ?? 0)]
    for (let i = 0; i < 3; i++) {
      e.pos[i]! += inherited[i]!
      e.vel[i]! += inherited[i]!
    }
    group.members.push(e)
    this.elements[n]!.push(e)
    this.run(e, node, 0)
    e.prev = [...e.pos]
  }

  private sibling(e: FxElement): FxElement | null {
    const m = e.group?.members
    if (!m) return null
    const i = m.indexOf(e)
    return i > 0 ? m[i - 1]! : null
  }

  private basis(e: FxElement, which: string): M3 | null {
    if (which === 'world') return identity3()
    if (which === 'self') return e.orient
    if (which === 'parent') return e.parent?.orient ?? identity3()
    return this.sibling(e)?.orient ?? null
  }

  private cone(min: number, max: number, angle: number): V3 {
    const r = this.random
    const len = r() * (max - min) + min
    const polar = r() * angle
    const az = r() * Math.PI * 2
    const s = -Math.sin(polar) * len
    return [s * Math.cos(az), Math.cos(polar) * len, s * Math.sin(az)]
  }

  private runCommand(e: FxElement, def: FxNode, c: FxCommand): void {
    const p = e.parent
    switch (c.op) {
      case 'position': {
        const base = c.base === 'self' ? e.pos : c.base === 'parent' ? p?.pos : this.sibling(e)?.pos
        const b = this.basis(e, c.basis)
        if (!base || !b) return
        const v = apply3(b, c.v)
        e.pos = [base[0] + v[0], base[1] + v[1], base[2] + v[2]]
        return
      }
      case 'velocity':
      case 'force': {
        const b = this.basis(e, c.basis)
        if (!b) return
        const v = apply3(b, c.v)
        if (c.op === 'velocity') e.vel = v
        else e.vel = [e.vel[0] + v[0], e.vel[1] + v[1], e.vel[2] + v[2]]
        return
      }
      case 'sphere': {
        const r = this.random
        let x = 0
        let y = 0
        let z = 0
        for (let tries = 0; tries < 64; tries++) {
          x = r() * 2 - 1
          y = r() * 2 - 1
          z = r() * 2 - 1
          if (x * x + y * y + z * z <= 1) break
        }
        const base = c.base === 'parent' && p ? p.pos : e.pos
        e.pos = [base[0] + x * c.r[0], base[1] + y * c.r[1], base[2] + z * c.r[2]]
        return
      }
      case 'conePos':
      case 'coneVel':
      case 'coneForce': {
        const b = this.basis(e, c.basis)
        if (!b) return
        const v = apply3(b, this.cone(c.min, c.max, c.angle))
        if (c.op === 'coneVel') e.vel = v
        else if (c.op === 'coneForce') e.vel = [e.vel[0] + v[0], e.vel[1] + v[1], e.vel[2] + v[2]]
        else e.pos = [e.pos[0] + v[0], e.pos[1] + v[1], e.pos[2] + v[2]]
        return
      }
      case 'attraction': {
        if (!p) return
        const d: V3 = [e.pos[0] - p.pos[0], e.pos[1] - p.pos[1], e.pos[2] - p.pos[2]]
        const len = Math.hypot(d[0], d[1], d[2])
        if (len > 1e-9) for (let i = 0; i < 3; i++) e.vel[i]! += (d[i]! * c.k) / len
        return
      }
      case 'rotation': {
        const b = this.basis(e, c.basis)
        if (!b) return
        e.orient = mul3(b, c.m)
        return
      }
      case 'angularVelocity':
        e.angVel = copy3(c.m)
        return
      case 'shapeRotation':
        e.shape = copy3(c.m)
        return
      case 'shapeSpin':
        e.spin = copy3(c.m)
        return
      case 'randomScale': {
        const knots = def.randomScale
        if (!knots?.length) return
        const t = this.random()
        let i = knots.findIndex(k => k[0]! >= t)
        if (i < 0) i = knots.length - 1
        const a = knots[Math.max(0, i - 1)]!
        const b = knots[i]!
        const f = a === b || b[0]! === a[0]! ? 0 : Math.min(1, Math.max(0, (t - a[0]!) / (b[0]! - a[0]!)))
        e.scale = [a[1]! + (b[1]! - a[1]!) * f, a[2]! + (b[2]! - a[2]!) * f, a[3]! + (b[3]! - a[3]!) * f]
        return
      }
    }
  }

  private run(e: FxElement, node: CompiledNode, age: number): void {
    const def = node.def
    for (let i = 0; i < def.commands.length; i++) if (node.masks[i]![age]) this.runCommand(e, def, def.commands[i]!)
    let o = row(node.scale, 3, age)
    if (o >= 0) {
      const v = node.scale!.t.values
      e.scale = [v[o]!, v[o + 1]!, v[o + 2]!]
    }
    o = row(node.color, 4, age)
    if (o >= 0) {
      const v = node.color!.t.values
      e.color = [v[o]!, v[o + 1]!, v[o + 2]!, v[o + 3]!]
    }
    o = row(node.uv, 4, age)
    if (o >= 0) {
      const v = node.uv!.t.values
      e.uv = [v[o]!, v[o + 1]!, v[o + 2]!, v[o + 3]!]
    }
    const p = e.parent
    o = row(node.banPosition, 3, age)
    if (o >= 0 && p) {
      const v = node.banPosition!.t.values
      const w = apply3(p.orient, [v[o]!, v[o + 1]!, v[o + 2]!])
      e.pos = [p.pos[0] + w[0], p.pos[1] + w[1], p.pos[2] + w[2]]
    }
    o = row(node.banRotation, 9, age)
    if (o >= 0) {
      const m = node.banRotation!.t.values.slice(o, o + 9) as M3
      e.orient = p ? mul3(p.orient, m) : m
    }
  }
}

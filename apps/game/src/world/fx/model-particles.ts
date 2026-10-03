/**
 * Model particles (docs/EFFECTS.md §1.1 path 2, §3.6, §3.11; sidecar `particles`, packages/convert/src/fx/model-fx.ts):
 * the effects a BSR binds to its model, played on that model with the shared FxRunner.
 *  - 'ambient': loop for as long as the model is shown (a drop's sparkle, a mob's glow, a torch); `night` ones only
 *    when it is night (the world renders noon today, so they stay off);
 *  - 'clip': play once, `birthMs` after their clip starts (the shaman's pipe smoke 3.2 s into STAND2); a clip set
 *    matches the actor's clip of that TYPE (`STAND2`, or a family variant `STAND2_*`);
 *  - 'status': looped by `status(set, on)` (e.g. `status_bad_burn`), when a lane wants the model's own status visual.
 * Positions are glTF metres in the model's space (already converted by the exporter), relative to the bone when one
 * is named; they turn and scale with the model's root.
 */
import type { TransformNode } from '@babylonjs/core'
import type { FxRootPose, M3, V3 } from '@sro/fx'
import { optUrl, slimAvailable } from '../../three/slim.ts'
import type { FxHandle, FxRunner } from './system-fx.ts'

export interface ModelParticle {
  set: string
  kind: 'ambient' | 'status' | 'clip'
  /** Clip type of a clip-bound set ('STAND2'). */
  clip?: string
  /** Particles.pk2 key ('system/item_drop_money.efp'). */
  efp: string
  /** Bone name; null = the model origin. */
  bone: string | null
  /** glTF metres (model space, or bone space when `bone` is set). */
  position: V3
  birthMs: number
  night: boolean
}

const isVec3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n))

/** The `particles` of a model sidecar (tolerant: malformed rows are skipped). */
export function readParticles(sidecar: unknown): ModelParticle[] {
  const list = (sidecar as { particles?: unknown } | null)?.particles
  if (!Array.isArray(list)) return []
  const out: ModelParticle[] = []
  for (const p of list as Partial<ModelParticle>[]) {
    if (!p || typeof p.efp !== 'string' || !p.efp) continue
    const kind = p.kind === 'status' || p.kind === 'clip' ? p.kind : 'ambient'
    out.push({
      set: typeof p.set === 'string' ? p.set : kind,
      kind,
      ...(typeof p.clip === 'string' ? { clip: p.clip } : {}),
      efp: p.efp,
      bone: typeof p.bone === 'string' && p.bone ? p.bone : null,
      position: isVec3(p.position) ? [p.position[0], p.position[1], p.position[2]] : [0, 0, 0],
      birthMs: typeof p.birthMs === 'number' && p.birthMs > 0 ? p.birthMs : 0,
      night: p.night === true,
    })
  }
  return out
}

/** Does clip `name` ('STAND2', 'STAND2_spear_stand_city02') belong to the clip type `type`? */
export function clipMatches(type: string, name: string): boolean {
  return name === type || name.startsWith(`${type}_`)
}

const sidecars = new Map<string, Promise<Record<string, unknown> | null>>()

/** A model sidecar (from /out-opt/ when the slim tree is served; cached; null when unavailable). */
export function fetchSidecar(url: string): Promise<Record<string, unknown> | null> {
  let p = sidecars.get(url)
  if (!p) {
    p = (async () => {
      const urls = (await slimAvailable()) && optUrl(url) ? [optUrl(url)!, url] : [url]
      for (const u of urls) {
        try {
          const res = await fetch(u)
          if (res.ok) return (await res.json()) as Record<string, unknown>
        } catch {
          // next
        }
      }
      return null
    })()
    sidecars.set(url, p)
  }
  return p
}

/** What model particles hang on: the model root (position, yaw, scale) and its bones. */
export interface ParticleCarrier {
  root: TransformNode
  joint(name: string): TransformNode | undefined
}


/** The pose of a particle on `carrier`: its bone (or the root) plus the offset, turned and scaled with the root. */
export function particlePose(carrier: ParticleCarrier, p: Pick<ModelParticle, 'bone' | 'position'>): () => FxRootPose {
  return () => {
    const root = carrier.root
    const w = root.computeWorldMatrix(true).m
    // Row-major world matrix: rows 0-2 are the scaled axes.
    const sx = Math.hypot(w[0]!, w[1]!, w[2]!) || 1
    const sy = Math.hypot(w[4]!, w[5]!, w[6]!) || 1
    const sz = Math.hypot(w[8]!, w[9]!, w[10]!) || 1
    const rot: M3 = [w[0]! / sx, w[1]! / sx, w[2]! / sx, w[4]! / sy, w[5]! / sy, w[6]! / sy, w[8]! / sz, w[9]! / sz, w[10]! / sz]
    const [x, y, z] = p.position
    const joint = p.bone ? carrier.joint(p.bone) : undefined
    let base: V3
    if (joint && !joint.isDisposed()) {
      joint.computeWorldMatrix(true)
      const j = joint.getAbsolutePosition()
      base = [j.x, j.y, j.z]
    } else {
      const r = root.getAbsolutePosition()
      base = [r.x, r.y, r.z]
    }
    return {
      position: [base[0] + (rot[0] * x) * sx + (rot[3] * y) * sy + (rot[6] * z) * sz, base[1] + (rot[1] * x) * sx + (rot[4] * y) * sy + (rot[7] * z) * sz, base[2] + (rot[2] * x) * sx + (rot[5] * y) * sy + (rot[8] * z) * sz],
      rotation: rot,
    }
  }
}

export interface ModelParticlesOptions {
  /** Night-only particles play (default false: the world renders noon). */
  night?: boolean
  /** Ambient particles start with the model (default true). Drops start theirs when they have landed. */
  ambient?: boolean
  /** Scale of the effects (default: the root's scale). */
  scale?: () => number
}

/** The particles of one shown model. update(dtMs) runs the clip-bound schedule; dispose() ends everything. */
export class ModelParticles {
  private readonly loops: FxHandle[] = []
  private readonly statuses = new Map<string, FxHandle[]>()
  private pending: { at: number; p: ModelParticle }[] = []
  private clock = 0
  private ambientOn = false
  private disposed = false

  constructor(
    private readonly runner: FxRunner,
    readonly particles: readonly ModelParticle[],
    private readonly carrier: ParticleCarrier,
    private readonly opts: ModelParticlesOptions = {},
  ) {
    if (opts.ambient !== false) this.startAmbient()
  }

  get hasAmbient(): boolean {
    return this.particles.some(p => p.kind === 'ambient' && (!p.night || !!this.opts.night))
  }

  private scale(): number {
    return this.opts.scale?.() ?? (Math.abs(this.carrier.root.scaling.y) || 1)
  }

  /** Starts the looping ambient particles (once). */
  startAmbient(): void {
    if (this.ambientOn || this.disposed) return
    this.ambientOn = true
    for (const p of this.particles) {
      if (p.kind !== 'ambient' || (p.night && !this.opts.night)) continue
      this.loops.push(this.runner.play(p.efp, { pose: particlePose(this.carrier, p), loop: true, scale: this.scale() }))
    }
  }

  /** Stops the ambient loops (they fade out). */
  stopAmbient(): void {
    this.ambientOn = false
    for (const h of this.loops.splice(0)) h.stop()
  }

  /** A clip started on the model: schedules its clip-bound particles (birthMs after now). */
  onClip(name: string): void {
    if (this.disposed) return
    for (const p of this.particles) {
      if (p.kind === 'clip' && p.clip && clipMatches(p.clip, name)) this.pending.push({ at: this.clock + p.birthMs, p })
    }
  }

  /** Loops the status set `set` (e.g. 'status_bad_burn') while on. */
  status(set: string, on: boolean): void {
    const live = this.statuses.get(set)
    if (!on) {
      live?.forEach(h => h.stop())
      this.statuses.delete(set)
      return
    }
    if (live || this.disposed) return
    const rows = this.particles.filter(p => p.kind === 'status' && p.set === set)
    this.statuses.set(set, rows.map(p => this.runner.play(p.efp, { pose: particlePose(this.carrier, p), loop: true, scale: this.scale() })))
  }

  /** Model sets of kind 'status' this model has. */
  statusSets(): string[] {
    return [...new Set(this.particles.filter(p => p.kind === 'status').map(p => p.set))]
  }

  /** Advances the clip-bound schedule by dtMs. */
  update(dtMs: number): void {
    if (this.disposed) return
    this.clock += Math.max(0, dtMs)
    if (!this.pending.length) return
    const due = this.pending.filter(x => x.at <= this.clock)
    if (!due.length) return
    this.pending = this.pending.filter(x => x.at > this.clock)
    for (const { p } of due) this.runner.play(p.efp, { pose: particlePose(this.carrier, p), loop: false, scale: this.scale() })
  }

  /** Clip-bound particles waiting for their time. */
  get waiting(): number {
    return this.pending.length
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopAmbient()
    for (const hs of this.statuses.values()) hs.forEach(h => h.stop())
    this.statuses.clear()
    this.pending = []
  }
}

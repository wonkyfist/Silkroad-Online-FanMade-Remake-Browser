/**
 * System effects (docs/EFFECTS.md §3.5-§3.9, §3.16; docs/WAVE_PLAN2.md M15): the retail SYSTEM_* rows of fx index v2
 * (`/out/fx/skills.json`, kind 'system') played on an entity with @sro/fx, plus the small effect runner the world
 * effects share (drop sparkles, model particles, ambient). Level-up, appear, potions, the return scroll and the
 * Berserk (hwan) rows all go through `SystemFx.play(key, phase, view)`:
 *  - 'start' plays the group's ACT_S rows (an AT_LOOP row there, e.g. the return scroll's reading, loops until the
 *    handle is stopped; AT_ONE_FOLLOW rows play once, capped at their program's own length);
 *  - 'loop' plays the ACT_L rows (looping on their bones until stopped: Berserk's keep effects);
 *  - 'end' plays the DEACT rows once.
 * Rows follow their carrier (bone, or the root) and turn with it; CHAR_BASE rows scale with the carrier's root scale.
 * Programs load lazily; a missing one is skipped (warned once). One SystemFx per scene (`systemFxFor`), updated by
 * the scene's render loop and disposed with it, so a lane (wave 8 BZ, MR-C) only calls `play`.
 */
import type { Scene, TransformNode } from '@babylonjs/core'
import { FxInstance, FxLibrary, type FxEffect, type FxRootPose, type M3, type V3 } from '@sro/fx'
import { OUT } from '../../content/catalog.ts'
import type { EntityView } from '../entities.ts'
import type { FxCharacterInfo, FxSkillV2, FxStageV2, SystemFxKey, SystemFxPhase } from './types.ts'

/** A playing effect (or a group of them): stop() ends emission, what is alive fades out; `done` once disposed. */
export interface FxHandle {
  stop(): void
  readonly done: boolean
}

/** A handle that is already over (unknown key, nothing to play). */
export const NO_FX: FxHandle = { stop() {}, done: true }

export interface FxPlayOptions {
  /** Root pose source (sampled at 20 Hz). */
  pose: () => FxRootPose
  /** Repeat until stopped. */
  loop?: boolean
  /** Scale of the effect (1 = as authored). */
  scale?: number
  /** One-shots: disposed after this at the latest (ms); default: the program's own length + 1 s. */
  capMs?: number
}

export interface FxRunnerStats {
  live: number
  started: number
  disposed: number
}

/** A stopped loop (or an over-long one-shot) fades out within this (ms). */
const FADE_MS = 2500
/** Instances one runner keeps at most (older one-shots are dropped first). */
const MAX_LIVE = 120

interface Live {
  fx: FxInstance
  loop: boolean
  stopped: boolean
  /** Runner time (ms) when emission stops (one-shots: their length). */
  stopAt: number
  disposeAt: number
  handle: LiveHandle
}

class LiveHandle implements FxHandle {
  live: Live | null = null
  stopped = false
  over = false

  constructor(private readonly runner: FxRunner) {}

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.live) this.runner.halt(this.live)
  }

  get done(): boolean {
    return this.over
  }
}

/** Several handles as one (a group's rows). */
export function groupHandle(parts: FxHandle[]): FxHandle {
  if (!parts.length) return NO_FX
  return {
    stop: () => parts.forEach(p => p.stop()),
    get done() {
      return parts.every(p => p.done)
    },
  }
}

/**
 * Loads programs once and plays FxInstances until they finish, are stopped or reach their cap. `update(dt)` advances
 * every instance; the owner calls it once a frame (SystemFx hooks the scene's render loop itself).
 */
export class FxRunner {
  readonly lib: FxLibrary
  private readonly ownsLib: boolean
  private live: Live[] = []
  private readonly programs = new Map<string, FxEffect>()
  private readonly loading = new Map<string, Promise<FxEffect | null>>()
  private readonly failed = new Set<string>()
  private clock = 0
  private started = 0
  private ended = 0
  private disposed = false

  constructor(readonly scene: Scene, opts: { library?: FxLibrary } = {}) {
    this.lib = opts.library ?? new FxLibrary(scene, OUT)
    this.ownsLib = !opts.library
  }

  get stats(): FxRunnerStats {
    return { live: this.live.length, started: this.started, disposed: this.ended }
  }

  /** Runner time in ms (advanced by update). */
  get now(): number {
    return this.clock
  }

  /** Loads (once) a program; null when it is missing. */
  program(key: string): Promise<FxEffect | null> {
    let p = this.loading.get(key)
    if (!p) {
      p = this.lib.load(key).then(
        e => {
          this.programs.set(key, e)
          return e
        },
        err => {
          if (!this.failed.has(key)) console.warn('[fx] effect unavailable', key, err)
          this.failed.add(key)
          return null
        },
      )
      this.loading.set(key, p)
    }
    return p
  }

  /** Plays `key` as soon as its program is loaded (synchronously when it already is). */
  play(key: string, o: FxPlayOptions): FxHandle {
    if (this.disposed || this.failed.has(key)) return NO_FX
    const handle = new LiveHandle(this)
    const ready = this.programs.get(key)
    if (ready) {
      this.start(ready, o, handle)
    } else {
      void this.program(key).then(effect => {
        if (!effect || handle.stopped) {
          handle.over = true
          return
        }
        this.start(effect, o, handle)
      })
    }
    return handle
  }

  private start(effect: FxEffect, o: FxPlayOptions, handle: LiveHandle): void {
    if (this.disposed) {
      handle.over = true
      return
    }
    while (this.live.length >= MAX_LIVE) {
      const i = this.live.findIndex(l => !l.loop)
      const old = this.live.splice(i >= 0 ? i : 0, 1)[0]
      if (old) this.drop(old)
    }
    const fx = new FxInstance(this.lib, effect, { pose: o.pose, loop: !!o.loop, camera: this.scene.activeCamera, ...(o.scale && o.scale !== 1 ? { scale: o.scale } : {}) })
    const lengthMs = ((effect.duration ?? 0) / (effect.fps || 20)) * 1000
    const cap = o.capMs ?? Math.max(1500, lengthMs + 1000)
    const l: Live = {
      fx,
      loop: !!o.loop,
      stopped: false,
      stopAt: o.loop ? Infinity : this.clock + cap,
      disposeAt: o.loop ? Infinity : this.clock + cap + FADE_MS,
      handle,
    }
    handle.live = l
    this.live.push(l)
    this.started++
  }

  /** Stops emission of `l`; it is disposed once its elements are gone (FADE_MS at most). */
  halt(l: Live): void {
    if (l.stopped) return
    l.stopped = true
    l.fx.stop()
    l.disposeAt = Math.min(l.disposeAt, this.clock + FADE_MS)
  }

  update(dt: number): void {
    if (this.disposed) return
    this.clock += Math.max(0, dt) * 1000
    if (!this.live.length) return
    const keep: Live[] = []
    for (const l of this.live) {
      if (!l.stopped && this.clock >= l.stopAt) this.halt(l)
      try {
        l.fx.update(dt)
      } catch (err) {
        console.warn('[fx] effect failed', err)
        this.drop(l)
        continue
      }
      const over = (l.fx.finished && (l.stopped || !l.loop)) || this.clock >= l.disposeAt
      if (over) this.drop(l)
      else keep.push(l)
    }
    this.live = keep
  }

  private drop(l: Live): void {
    l.fx.dispose()
    l.handle.over = true
    l.handle.live = null
    this.ended++
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const l of this.live) this.drop(l)
    this.live = []
    if (this.ownsLib) this.lib.dispose()
  }
}

/** "0,10,-13" (dm, file space) -> glTF metres (x, y, -z) x 0.1 (the skilleffect offset rule, docs/EFFECTS.md §1.3). */
export function parseOffset(s: string | null | undefined): V3 {
  const [x = 0, y = 0, z = 0] = (s ?? '').split(',').map(Number).map(n => (Number.isFinite(n) ? n : 0))
  return [x * 0.1, y * 0.1, z ? -z * 0.1 : 0]
}

// ---- poses ----------------------------------------------------------------------------------------------------------

/** Column-major rotation of a yaw (glTF: +Z forward). */
export function yawMatrix(yaw: number): M3 {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [c, 0, -s, 0, 1, 0, s, 0, c]
}


/** World position of a node plus `offset` turned by `rot`. */
function nodePoint(node: TransformNode, offset: V3, rot: M3): V3 {
  node.computeWorldMatrix(true)
  const p = node.getAbsolutePosition()
  return [p.x + rot[0] * offset[0] + rot[3] * offset[1] + rot[6] * offset[2], p.y + rot[1] * offset[0] + rot[4] * offset[1] + rot[7] * offset[2], p.z + rot[2] * offset[0] + rot[5] * offset[1] + rot[8] * offset[2]]
}

/**
 * A pose that follows an entity: its bone `bone` (when the model has it) or its root, plus `offset` (glTF metres in the
 * entity's frame, scaled with it), turned with the entity's yaw.
 */
export function viewPose(view: EntityView, bone: string | null, offset: V3 = [0, 0, 0]): () => FxRootPose {
  return () => {
    const rot = yawMatrix(view.yaw)
    const s = view.scale || 1
    const o: V3 = [offset[0] * s, offset[1] * s, offset[2] * s]
    const joint = bone ? view.actor?.joint(bone) : undefined
    if (joint && !joint.isDisposed()) return { position: nodePoint(joint, o, rot), rotation: rot }
    view.root.computeWorldMatrix(true)
    const r = view.root.getAbsolutePosition()
    return { position: [r.x + rot[0] * o[0] + rot[6] * o[2], r.y + o[1], r.z + rot[2] * o[0] + rot[8] * o[2]], rotation: rot }
  }
}

/** A fixed pose at `pos` (world metres), turned by `yaw`. */
export function fixedPose(pos: V3, yaw = 0): () => FxRootPose {
  const rotation = yawMatrix(yaw)
  const position: V3 = [pos[0], pos[1], pos[2]]
  return () => ({ position, rotation })
}

// ---- system rows ----------------------------------------------------------------------------------------------------

const PHASE_ROWS: Record<SystemFxPhase, string> = { start: 'ACT_S', loop: 'ACT_L', end: 'DEACT' }

/** The SYSTEM_* groups of an fx index (v2 `kind: 'system'`, or any `SYSTEM_` group of an older export). */
export function readSystemGroups(json: unknown): Map<string, FxSkillV2> {
  const out = new Map<string, FxSkillV2>()
  const list = (json as { skills?: unknown } | null)?.skills
  if (!Array.isArray(list)) return out
  for (const s of list as FxSkillV2[]) {
    if (!s || typeof s.group !== 'string' || !Array.isArray(s.stages)) continue
    if (s.kind === 'system' || s.group.startsWith('SYSTEM_')) out.set(s.group, s)
  }
  return out
}

/** The rows of `phase` of a group. */
export function phaseRows(group: FxSkillV2 | undefined, phase: SystemFxPhase): FxStageV2[] {
  if (!group) return []
  const want = PHASE_ROWS[phase]
  return group.stages.filter(st => st.phase === want && !!st.effect)
}

export interface SystemPlayOptions {
  /** Play looping rows once (one program cycle): for AT_LOOP rows nobody stops, e.g. SYSTEM_RETURNSCROLLRESULT. */
  once?: boolean
}

/** Where the carrier is when there is no view (the return scroll's flash at the old spot). */
export interface FxSpot {
  pos: V3
  yaw?: number
}

export class SystemFx {
  readonly runner: FxRunner
  private groups = new Map<string, FxSkillV2>()
  private characters: Record<string, FxCharacterInfo> = {}
  private loaded: Promise<void> | null = null

  constructor(scene: Scene, opts: { runner?: FxRunner; groups?: Map<string, FxSkillV2> } = {}) {
    this.runner = opts.runner ?? new FxRunner(scene)
    if (opts.groups) {
      this.groups = opts.groups
      this.loaded = Promise.resolve()
    }
  }

  /** Reads the SYSTEM_* groups of the fx index (once) and preloads the common programs. */
  load(url = `${OUT}fx/skills.json`): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as { characters?: unknown }
        this.groups = readSystemGroups(json)
        if (json.characters && typeof json.characters === 'object') this.characters = json.characters as Record<string, FxCharacterInfo>
        for (const key of ['SYSTEM_LEVELUP', 'SYSTEM_HPPOTION', 'SYSTEM_APPEAR'] as const) {
          for (const st of phaseRows(this.groups.get(key), 'start')) void this.runner.program(st.effect!)
        }
      } catch (err) {
        console.warn('[fx] system effects unavailable', err)
      }
    })()
    return this.loaded
  }

  /** characterInfo of a CodeName128 (size, blood, the Die Bsr model); null until loaded or unknown. */
  character(code: string): FxCharacterInfo | null {
    return this.characters[code] ?? null
  }

  /** Resolves once the index is read (or failed). */
  ready(): Promise<void> {
    return this.load()
  }

  /** The group of `key` (null until loaded or when the export lacks it). */
  group(key: SystemFxKey | string): FxSkillV2 | null {
    return this.groups.get(key) ?? null
  }

  /**
   * Plays phase `phase` of the system row `key` on `view` (docs/WAVE_PLAN2.md M15). Returns a handle: stop() ends the
   * loops ('loop' rows, AT_LOOP 'start' rows); one-shots end by themselves. Before the index is loaded the call waits
   * for it (a stop() meanwhile cancels). `once`: AT_LOOP rows play one cycle instead (nobody will stop them).
   */
  play(key: SystemFxKey | string, phase: SystemFxPhase, view: EntityView, opts: SystemPlayOptions = {}): FxHandle {
    return this.playWith(key, phase, (st, off) => viewPose(view, st.startBone, off), st => (st.scale === 'CHAR_BASE' ? view.scale || 1 : 1), opts)
  }

  /** Like play, at a fixed spot (e.g. SYSTEM_RETURNSCROLLRESULT where the reader stood before the warp). */
  playAt(key: SystemFxKey | string, phase: SystemFxPhase, spot: FxSpot, opts: SystemPlayOptions = {}): FxHandle {
    return this.playWith(key, phase, (_st, off) => {
      const rot = yawMatrix(spot.yaw ?? 0)
      return fixedPose([spot.pos[0] + rot[0] * off[0] + rot[6] * off[2], spot.pos[1] + off[1], spot.pos[2] + rot[2] * off[0] + rot[8] * off[2]], spot.yaw ?? 0)
    }, () => 1, opts)
  }

  private playWith(key: string, phase: SystemFxPhase, pose: (st: FxStageV2, offset: V3) => () => FxRootPose, scale: (st: FxStageV2) => number, opts: SystemPlayOptions): FxHandle {
    const run = (): FxHandle => {
      const rows = phaseRows(this.groups.get(key), phase)
      return groupHandle(rows.map(st => {
        const loop = !opts.once && (phase === 'loop' || st.actType === 'AT_LOOP')
        return this.runner.play(st.effect!, { pose: pose(st, parseOffset(st.startOffset)), loop, scale: scale(st) })
      }))
    }
    if (this.groups.size) return run()
    // Not loaded yet: start once the index arrives, unless stopped first.
    let inner: FxHandle | null = null
    let stopped = false
    void this.load().then(() => {
      if (!stopped) inner = run()
    })
    return {
      stop() {
        stopped = true
        inner?.stop()
      },
      get done() {
        return stopped ? (inner?.done ?? true) : (inner?.done ?? false)
      },
    }
  }

  update(dt: number): void {
    this.runner.update(dt)
  }

  dispose(): void {
    this.runner.dispose()
  }
}

const perScene = new WeakMap<Scene, SystemFx>()

/**
 * The scene's SystemFx: created (and its index loaded) on first use, advanced by the scene's render loop and disposed
 * with the scene. Wave-8 lanes (Berserk, horses) call `systemFxFor(ctx.scene).play(key, phase, view)`.
 */
export function systemFxFor(scene: Scene): SystemFx {
  let fx = perScene.get(scene)
  if (!fx) {
    const made = new SystemFx(scene)
    fx = made
    perScene.set(scene, made)
    void made.load()
    const obs = scene.onBeforeRenderObservable.add(() => made.update(scene.getEngine().getDeltaTime() / 1000))
    scene.onDisposeObservable.addOnce(() => {
      scene.onBeforeRenderObservable.remove(obs)
      made.dispose()
      perScene.delete(scene)
    })
  }
  return fx
}

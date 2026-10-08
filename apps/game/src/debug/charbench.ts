/**
 * The character bench, client side (docs/CHARACTERS.md §9): `?charbench=1` on a page served by the bench server
 * (apps/server/src/cli/charbench.ts), or any world. It exposes `window.__sroCharBench` and measures the frame with
 * the crowd in it, nothing else changed:
 *
 * - `measure(label, { frames })`: uncapped frames (a MessageChannel pump instead of the display's rAF, so the frame
 *   time is the work, not the vsync); the frame-to-frame time p50/p95/p99, the CPU part of each frame (engine begin
 *   to end), segments (animations, game logic, active-mesh evaluation, render targets = shadows, main draw, post), draw
 *   calls, the GPU frame time where the engine can time it (WebGPU timestamp-query, WebGL2 timer query), the actors
 *   whose pose updated per frame, and the census below at the end.
 * - `census()`: entities by kind, active meshes, the skinned ones and their vertices, skeletons and bones drawn,
 *   animation groups playing, labels shown, the crowd budget's stats.
 * - `view(name)`: the fixed camera views ('close', 'mid', 'far') on the bench character.
 * - `knobs(o)`: the LAB switches of the crowd rules (world/char-lod.ts CHAR_LOD, the G1 crowd budget) for interleaved
 *   before/after runs on one page.
 *
 * The frame-time watchdog never drops the preset while the bench page is open (a 100-player frame over 33 ms would
 * otherwise send the page to Low in the middle of a run).
 */
import { EngineInstrumentation, SceneInstrumentation, type AbstractMesh, type Scene, type Skeleton } from '@babylonjs/core'
import { LIGHT_LOOK, applyLightLook, renderPostOf } from '@sro/world-render'
import type { App } from '../app.ts'
import { FrameWatchdog, settings } from '../settings.ts'
import type { ModelLibrary } from '../three/models.ts'
import { CHAR_LOD, type CharLodSwitches } from '../world/char-lod.ts'
import type { CrowdBudget } from '../world/crowd-budget.ts'
import { PERF } from '../world/perf.ts'
import { WORLD_FEATURES, type WorldFeature, type WorldFeatureContext, type WorldFeatureFactory } from '../world/features.ts'

export interface BenchView {
  /** Camera orbit around the bench character: alpha (rad), beta (rad), radius (m). */
  alpha: number
  beta: number
  radius: number
}

/** The bench character stands at the south edge of the plaza crowd looking north (−z) into it. */
export const BENCH_SPOT = { x: 101, z: -56 } as const
export const BENCH_VIEWS: Readonly<Record<string, BenchView>> = {
  close: { alpha: Math.PI / 2, beta: 1.3, radius: 6 },
  mid: { alpha: Math.PI / 2, beta: 1.2, radius: 16 },
  far: { alpha: Math.PI / 2, beta: 0.95, radius: 40 },
}

/** The perf audit's scenes (docs/PERF_AUDIT.md): where (a GM place, or the bench spot) and the weather. */
export const SCENES: Readonly<Record<string, { place?: string; weather: string }>> = {
  plaza: { weather: 'clear' },
  fields: { place: 'grassland', weather: 'clear' },
  storm: { weather: 'storm' },
  crowd: { weather: 'clear' },
}

/** A measurement ends after this long whatever its frame count (ms). */
export const MEASURE_LIMIT_MS = 90_000

const q = (a: readonly number[], p: number): number => {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!
}
const mean = (a: readonly number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)

export interface Census {
  players: number
  mobs: number
  npcs: number
  actors: number
  activeMeshes: number
  activeSkinned: number
  skinnedVertices: number
  skeletonsDrawn: number
  bonesDrawn: number
  groupsPlaying: number
  labelsShown: number
  /** Active meshes by what they are: crowd batches, outfit merges, other character meshes (parts, weapons, merged G1 parts), the rest. */
  activeBy: { crowd: number; outfit: number; character: number; world: number }
  crowd: unknown
  /** The outfit merge's atlases alive now and built since the page loaded. */
  outfitAtlases: { live: number; built: number; merges: number } | null
  /** P1a: the crowd tier (VATs, batches, members, instances drawn, bakes). */
  crowdTier: unknown
}

export class CharBench {
  private ctx: WorldFeatureContext | null = null
  private sceneInst: SceneInstrumentation | null = null
  private engineInst: EngineInstrumentation | null = null
  /** Set while a measurement samples (the per-frame records). */
  private rec: { t0: number; cpu: number; seg: Record<string, number>; open: Record<string, number>; draws: number; posed: number } | null = null
  private recs: NonNullable<CharBench['rec']>[] = []
  private hooked = false
  readonly results: unknown[] = []

  constructor(private readonly app: App) {}

  install(): void {
    // The watchdog judges the frames of a bench page as slowness: never let it drop the preset here.
    ;(FrameWatchdog.prototype as unknown as { sample: () => boolean }).sample = () => false
    const list = WORLD_FEATURES as WorldFeatureFactory[]
    const bench = this
    const charBenchFeature: WorldFeatureFactory = ctx => bench.attach(ctx)
    if (!list.some(f => f.name === 'charBenchFeature')) list.push(charBenchFeature)
    ;(window as unknown as { __sroCharBench?: CharBench }).__sroCharBench = this
    // the perf audit's A/B switches (docs/PERF_AUDIT.md; the driver's --ab <name>)
    ;(window as unknown as { __sroPerf?: typeof PERF }).__sroPerf = PERF
    console.info('[charbench] ready: await __sroCharBench.measure("x"); __sroCharBench.census(); __sroCharBench.view("mid")')
  }

  private attach(ctx: WorldFeatureContext): WorldFeature {
    this.ctx = ctx
    this.hooked = false
    return {
      dispose: () => {
        if (this.ctx === ctx) this.ctx = null
        this.sceneInst?.dispose()
        this.engineInst?.dispose()
        this.sceneInst = null
        this.engineInst = null
      },
    }
  }

  private get scene(): Scene {
    if (!this.ctx) throw new Error('not in the world')
    return this.ctx.scene
  }

  private get models(): ModelLibrary | null {
    return (window as unknown as { __sroModels?: ModelLibrary }).__sroModels ?? null
  }

  private get crowd(): CrowdBudget | null {
    return ((window as unknown as { __sroCrowd?: CrowdBudget }).__sroCrowd ?? null) as CrowdBudget | null
  }

  /** In the world, and how much of the crowd has its model. */
  status(): { inWorld: boolean; worldReady: boolean; engine: string; preset: string | null; players: number; loaded: number; mobs: number } {
    const ctx = this.ctx
    if (!ctx || ctx.selfId() === null) return { inWorld: false, worldReady: false, engine: this.app.engineKind, preset: null, players: 0, loaded: 0, mobs: 0 }
    let players = 0
    let loaded = 0
    let mobs = 0
    for (const v of ctx.views()) {
      if (v.kind === 'player') {
        players++
        if (v.actor) loaded++
      } else if (v.kind === 'mob') mobs++
    }
    const preset = settings.get().graphics.preset
    // the ground and its graphics (the crowd budget comes with them) are in, and nothing streams
    const ground = ctx.world() as unknown as { world?: { stream?: { busy?: boolean } | null } } | null
    const worldReady = !!ground && !!this.crowd && !ground.world?.stream?.busy
    return { inWorld: true, worldReady, engine: this.app.engineKind, preset, players, loaded, mobs }
  }

  /** Chat-free GM command from the bench character (the bench server makes it an admin). */
  gm(cmd: string, ...args: string[]): boolean {
    return this.ctx?.send({ t: 'gm', cmd, args }) ?? false
  }

  /**
   * The lighting look lab (docs/LIGHTING.md): sets LIGHT_LOOK switches and re-applies the render; returns the switches.
   * `look()` alone reads them.
   */
  look(next: Partial<typeof LIGHT_LOOK> = {}): typeof LIGHT_LOOK {
    return Object.keys(next).length ? applyLightLook(this.scene, next) : { ...LIGHT_LOOK }
  }

  /**
   * The lighting lab's render A/B (docs/LIGHTING.md): the world render's quality block with `patch` over the preset's
   * (null: back to the block it had before the first patch). Returns the keys now patched.
   */
  renderPatch(patch: Record<string, unknown> | null): string {
    const render = renderPostOf(this.scene)?.render
    if (!render) return 'no render'
    this.baseQuality ??= render.quality
    render.setQuality(patch ? { ...this.baseQuality, ...patch } as typeof render.quality : this.baseQuality)
    if (!patch) this.baseQuality = null
    return Object.keys(patch ?? {}).join(',') || 'base'
  }

  private baseQuality: ReturnType<typeof renderPostOf> extends infer P ? (P extends { render: { quality: infer Q } } ? Q | null : null) : null = null

  /** The eye adaptation's last state (ev, mean log2 exposed luminance, target), or null without one. */
  async adaptState(): Promise<unknown> {
    const a = renderPostOf(this.scene)?.adaptation
    return a ? await a.readState() : null
  }

  /** Puts the camera on a fixed view around the bench character. */
  view(name: string): BenchView {
    const v = BENCH_VIEWS[name]
    if (!v || !this.ctx) throw new Error('no view ' + name)
    const c = this.ctx.camera
    c.alpha = v.alpha
    c.beta = v.beta
    c.radius = v.radius
    c.inertialAlphaOffset = 0
    c.inertialBetaOffset = 0
    c.inertialRadiusOffset = 0
    return v
  }

  /** A free orbit around the bench character (the P1 pilot's portraits, docs/CHARACTERS.md §15). */
  orbit(alpha: number, beta: number, radius: number): void {
    if (!this.ctx) throw new Error('not in the world')
    const c = this.ctx.camera
    c.alpha = alpha
    c.beta = beta
    c.radius = radius
    c.inertialAlphaOffset = 0
    c.inertialBetaOffset = 0
    c.inertialRadiusOffset = 0
  }

  private focusObs: import('@babylonjs/core').Observer<import('@babylonjs/core').Camera> | null = null

  /**
   * Holds the orbit on one joint of the own character (`'head'`: the licensed body's face close-ups, CHARACTERS §16)
   * at `radius`; null releases it to the follow.
   */
  focus(joint: string | null, alpha = 0, beta = 1.5, radius = 0.8): boolean {
    const scene = this.ctx?.scene
    const c = this.ctx?.camera
    if (!scene || !c) return false
    if (this.focusObs) scene.onBeforeCameraRenderObservable.remove(this.focusObs)
    this.focusObs = null
    if (joint === null) return true
    const id = this.ctx?.selfId()
    const node = id === null || id === undefined ? undefined : this.ctx?.view(id)?.actor?.joint(joint)
    if (!node) return false
    c.lowerRadiusLimit = Math.min(c.lowerRadiusLimit ?? radius, radius)
    c.minZ = Math.min(c.minZ, 0.05)
    this.focusObs = scene.onBeforeCameraRenderObservable.add(() => {
      c.targetScreenOffset.set(0, 0)
      c.target.copyFrom(node.getAbsolutePosition())
      c.alpha = alpha
      c.beta = beta
      c.radius = radius
      c.getViewMatrix(true)
    })
    return true
  }

  /** The LAB switches (`CHAR_LOD` and the G1 crowd budget); returns them all as they are now. */
  knobs(o: Partial<CharLodSwitches> & { crowd?: boolean; __all?: boolean; hideOthers?: boolean } = {}): CharLodSwitches & { crowd: boolean | null; hideOthers: boolean } {
    if (o.hideOthers !== undefined) this.hideOthers(o.hideOthers)
    if (o.__all !== undefined) for (const k of Object.keys(CHAR_LOD)) if (k !== 'outfitNear') (CHAR_LOD as unknown as Record<string, unknown>)[k] = o.__all
    for (const [k, v] of Object.entries(o)) if (k !== 'crowd' && k !== '__all' && k in CHAR_LOD) (CHAR_LOD as unknown as Record<string, unknown>)[k] = v
    const c = this.crowd
    if (c && o.crowd !== undefined) c.enabled = o.crowd
    return { ...CHAR_LOD, crowd: c ? c.enabled : null, hideOthers: this.hidden.size > 0 }
  }

  /** The floor: every other character neither drawn nor animated (the frame without the crowd). */
  private readonly hidden = new Set<import('../three/models.ts').CharacterActor>()
  private hideOthers(on: boolean): void {
    if (!on) {
      for (const a of this.hidden) if (!a.isDisposed) {
        a.root.setEnabled(true)
        for (const g of a.groups) if (g.isStarted) g.play(g.loopAnimation)
      }
      this.hidden.clear()
      return
    }
    const id = this.ctx?.selfId()
    const self = id === null || id === undefined ? null : this.ctx?.view(id)?.actor ?? null
    for (const a of this.models?.liveActors ?? []) {
      if (a === self || a.isDisposed || this.hidden.has(a)) continue
      a.root.setEnabled(false)
      for (const g of a.groups) if (g.isPlaying) g.pause()
      this.hidden.add(a)
    }
  }

  census(): Census {
    const s = this.scene
    const ctx = this.ctx!
    let players = 0
    let mobs = 0
    let npcs = 0
    for (const v of ctx.views()) {
      if (v.kind === 'player') players++
      else if (v.kind === 'mob') mobs++
      else if (v.kind === 'npc') npcs++
    }
    const active = s.getActiveMeshes()
    let skinned = 0
    let verts = 0
    const skels = new Set<Skeleton>()
    const activeBy = { crowd: 0, outfit: 0, character: 0, world: 0 }
    for (let i = 0; i < active.length; i++) {
      const m = active.data[i] as AbstractMesh
      let p: import('@babylonjs/core').Node | null = m
      while (p && !/^actor\d+:/.test(p.name)) p = p.parent
      if (/^crowd\d+:/.test(m.name)) activeBy.crowd++
      else if (m.name.endsWith(':outfit')) activeBy.outfit++
      else if (p) activeBy.character++
      else activeBy.world++
      if (!m.skeleton) continue
      skinned++
      verts += m.getTotalVertices()
      skels.add(m.skeleton)
    }
    let bones = 0
    for (const k of skels) bones += k.bones.length
    let labels = 0
    for (const e of document.querySelectorAll<HTMLElement>('.entity-label')) if (!e.hidden && !e.classList.contains('np-hide')) labels++
    return {
      players,
      mobs,
      npcs,
      actors: this.models?.liveActors.size ?? 0,
      activeMeshes: active.length,
      activeSkinned: skinned,
      skinnedVertices: verts,
      skeletonsDrawn: skels.size,
      bonesDrawn: bones,
      groupsPlaying: s.animationGroups.filter(g => g.isPlaying).length,
      labelsShown: labels,
      activeBy,
      crowd: this.crowd?.stats() ?? null,
      outfitAtlases: this.models ? { live: this.models.outfitAtlases.size, built: this.models.outfitAtlases.built, merges: this.models.outfitAtlases.acquired } : null,
      crowdTier: this.models?.crowdTierIfAny?.stats() ?? null,
    }
  }

  private hook(): void {
    if (this.hooked) return
    this.hooked = true
    const s = this.scene
    const eng = s.getEngine()
    this.sceneInst = new SceneInstrumentation(s)
    try {
      this.engineInst = new EngineInstrumentation(eng)
      this.engineInst.captureGPUFrameTime = true
    } catch {
      this.engineInst = null
    }
    const now = () => performance.now()
    const open = (k: string) => () => {
      if (this.rec) this.rec.open[k] = now()
    }
    const close = (k: string, from: string) => () => {
      const r = this.rec
      if (!r || r.open[from] === undefined) return
      r.seg[k] = (r.seg[k] ?? 0) + now() - r.open[from]!
      delete r.open[from]
    }
    eng.onBeginFrameObservable.add(() => {
      if (!this.sampling) return
      this.rec = { t0: now(), cpu: 0, seg: {}, open: {}, draws: 0, posed: 0 }
    })
    s.onBeforeAnimationsObservable.add(open('anim'), -1, true)
    s.onBeforeRenderObservable.add(() => {
      close('animations', 'anim')()
      open('logic')()
    }, -1, true)
    s.onBeforeRenderObservable.add(close('game logic', 'logic'))
    s.onBeforeActiveMeshesEvaluationObservable.add(open('eval'), -1, true)
    s.onAfterActiveMeshesEvaluationObservable.add(close('active mesh eval', 'eval'))
    s.onBeforeRenderTargetsRenderObservable.add(open('rtt'), -1, true)
    s.onAfterRenderTargetsRenderObservable.add(close('render targets (shadows)', 'rtt'))
    s.onBeforeDrawPhaseObservable.add(open('draw'), -1, true)
    s.onAfterDrawPhaseObservable.add(() => {
      close('main draw', 'draw')()
      open('post')()
    })
    s.onAfterRenderObservable.add(() => {
      close('post + after', 'post')()
      const r = this.rec
      if (!r) return
      r.draws = this.sceneInst?.drawCallsCounter.current ?? 0
      let posed = 0
      for (const a of this.models?.liveActors ?? []) if (!a.lodSkipping) posed++
      r.posed = posed
    })
    eng.onEndFrameObservable.add(() => {
      const r = this.rec
      if (!r) return
      r.cpu = now() - r.t0
      this.recs.push(r)
      this.rec = null
    })
  }

  private sampling = false

  /** Uncapped frames for `frames` frames after `warm`; the summary (also kept in `results`). */
  async measure(label: string, o: { frames?: number; warm?: number } = {}): Promise<Record<string, unknown>> {
    const frames = o.frames ?? 300
    const warm = o.warm ?? 30
    this.hook()
    const eng = this.scene.getEngine()
    const ch = new MessageChannel()
    const queue: FrameRequestCallback[] = []
    ch.port1.onmessage = () => queue.shift()?.(performance.now())
    let id = 0
    eng.customAnimationFrameRequester = {
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        queue.push(cb)
        ch.port2.postMessage(0)
        return ++id
      },
      cancelAnimationFrame: () => {},
    } as never
    const gpu: number[] = []
    try {
      await new Promise<void>(res => {
        let n = 0
        const o2 = eng.onEndFrameObservable.add(() => {
          if (++n >= warm) {
            eng.onEndFrameObservable.remove(o2)
            res()
          }
        })
      })
      this.recs = []
      this.sampling = true
      const gpuObs = eng.onEndFrameObservable.add(() => {
        const ns = this.engineInst?.gpuFrameTimeCounter.current ?? 0
        if (ns > 0) gpu.push(ns / 1e6)
      })
      // a run that cannot reach `frames` in MEASURE_LIMIT_MS ends with what it has (and says so)
      const t0 = performance.now()
      await new Promise<void>(res => {
        const poll = () => (this.recs.length >= frames || performance.now() - t0 > MEASURE_LIMIT_MS ? res() : setTimeout(poll, 20))
        poll()
      })
      eng.onEndFrameObservable.remove(gpuObs)
    } finally {
      this.sampling = false
      eng.customAnimationFrameRequester = null
    }
    const R = this.recs.slice(0, frames)
    const wall: number[] = []
    for (let i = 1; i < R.length; i++) wall.push(R[i]!.t0 - R[i - 1]!.t0)
    const cpu = R.map(r => r.cpu)
    const segs: Record<string, number> = {}
    for (const r of R) for (const [k, v] of Object.entries(r.seg)) segs[k] = (segs[k] ?? 0) + v
    for (const k of Object.keys(segs)) segs[k] = r2(segs[k]! / R.length)!
    const out = {
      label,
      engine: this.app.engineKind,
      preset: this.status().preset,
      at: new Date().toISOString(),
      frames: R.length,
      fps: r2(1000 / mean(wall)),
      frameMs: { p50: r2(q(wall, 0.5)), p95: r2(q(wall, 0.95)), p99: r2(q(wall, 0.99)), max: r2(Math.max(...wall)), mean: r2(mean(wall)) },
      cpuMs: { p50: r2(q(cpu, 0.5)), p95: r2(q(cpu, 0.95)), mean: r2(mean(cpu)) },
      over16_7: wall.filter(w => w > 16.7).length,
      gpuMs: gpu.length ? { p50: r2(q(gpu, 0.5)), p95: r2(q(gpu, 0.95)), samples: gpu.length } : null,
      segments: segs,
      draws: r2(mean(R.map(r => r.draws))),
      posedPerFrame: r2(mean(R.map(r => r.posed))),
      knobs: this.knobs(),
      census: this.census(),
      canvas: [eng.getRenderWidth(), eng.getRenderHeight()],
    }
    this.results.push(out)
    return out
  }

  /**
   * The bench scene: noon, clear sky, the bench character at BENCH_SPOT; then waits until `minPlayers` players have
   * their models (and the count has held for 5 s) or `timeoutMs` passed.
   */
  async prepare(o: { minPlayers?: number; timeoutMs?: number } = {}): Promise<ReturnType<CharBench['status']>> {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    for (let i = 0; i < 600 && !this.status().inWorld; i++) await sleep(500)
    this.gm('time', '12:00')
    this.gm('weather', 'clear')
    this.gm('tp', String(BENCH_SPOT.x), String(BENCH_SPOT.z))
    const end = performance.now() + (o.timeoutMs ?? 240_000)
    let last = -1
    let since = performance.now()
    for (;;) {
      const s = this.status()
      if (s.loaded !== last) {
        last = s.loaded
        since = performance.now()
      }
      if (s.worldReady && s.loaded >= (o.minPlayers ?? 1) && performance.now() - since > 5000) break
      if (performance.now() > end) break
      await sleep(500)
    }
    this.view('mid')
    // the last models' first draws compile their shaders; the streaming settles
    await sleep(15000)
    return this.status()
  }

  /**
   * The perf audit's scenes (docs/PERF_AUDIT.md): noon, the bench camera's `mid` orbit, and
   * `plaza` (the bench spot, clear), `fields` (GM place `grassland`, dense grass, clear), `storm` (the plaza in a GM
   * storm: rain + lightning), `crowd` (the plaza; the crowd is whatever bots the server has). Waits for the streaming
   * to settle and `settleMs` more.
   */
  async setScene(name: string, o: { settleMs?: number; timeoutMs?: number } = {}): Promise<ReturnType<CharBench['status']>> {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const spot = SCENES[name]
    if (!spot) throw new Error('no scene ' + name)
    this.gm('time', '12:00')
    // held 30 min, no transition (the default 60 s blend would measure half a storm)
    this.gm('weather', spot.weather, '30', '0')
    if (spot.place) this.gm('tp', spot.place)
    else this.gm('tp', String(BENCH_SPOT.x), String(BENCH_SPOT.z))
    await sleep(3000)
    const end = performance.now() + (o.timeoutMs ?? 120_000)
    while (!this.status().worldReady && performance.now() < end) await sleep(500)
    this.view('mid')
    await sleep(o.settleMs ?? 12_000)
    return this.status()
  }

  /**
   * The bench plan on this page: for each round, each view, each variant (interleaved, the variant order reversed
   * every other round) one measurement. `variants` maps a name to its knobs (default: `before` = every CHAR_LOD rule
   * off, `after` = every rule on).
   */
  async run(o: { rounds?: number; frames?: number; views?: string[]; variants?: Record<string, Partial<CharLodSwitches> & { crowd?: boolean; __all?: boolean; hideOthers?: boolean }>; settleMs?: number; tag?: string } = {}): Promise<unknown[]> {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const variants = o.variants ?? { before: { __all: false }, after: { __all: true } }
    const names = Object.keys(variants)
    const out: unknown[] = []
    this.runLog = []
    for (let r = 0; r < (o.rounds ?? 3); r++) {
      for (const v of o.views ?? ['close', 'mid', 'far']) {
        this.view(v)
        for (const name of r % 2 ? [...names].reverse() : names) {
          this.knobs({ __all: true, crowd: true, hideOthers: false, ...variants[name] })
          await sleep(o.settleMs ?? 2000)
          const m = await this.measure(`${o.tag ? o.tag + '-' : ''}${v}-${name}-r${r + 1}`, { frames: o.frames })
          Object.assign(m, { view: v, variant: name, round: r + 1 })
          out.push(m)
          const f = m.frameMs as { p50: number; p95: number }
          this.runLog.push(`${m.label} p50 ${f.p50} p95 ${f.p95} draws ${m.draws}`)
          console.info(`[charbench] ${this.runLog.at(-1)}`)
        }
      }
    }
    this.knobs({ __all: true, crowd: true, hideOthers: false })
    return out
  }

  /** Progress lines of the last run(). */
  runLog: string[] = []

  /** Saves `results` as a JSON file through the browser (a person's own run). */
  download(name = 'charbench.json'): void {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([JSON.stringify(this.results, null, 1)], { type: 'application/json' }))
    a.download = name
    a.click()
  }

  /** The look check of the outfit merge: per merged actor, its mesh and its atlas's coverage (texels with alpha > 0.5). */
  async outfitDebug(n = 8): Promise<unknown[]> {
    const out: unknown[] = []
    for (const a of this.models?.liveActors ?? []) {
      const o = a.outfitInfo
      if (!o || out.length >= n) continue
      const mat = o.mesh.material as { albedoTexture?: { readPixels(): Promise<ArrayBufferView> | null } | null; transparencyMode?: number; alphaCutOff?: number } | null
      let cover = -1
      try {
        const px = await mat?.albedoTexture?.readPixels()
        if (px) {
          const b = new Uint8Array(px.buffer, px.byteOffset, px.byteLength)
          let c = 0
          for (let i = 3; i < b.length; i += 4) if (b[i]! > 127) c++
          cover = Math.round((1000 * c) / (b.length / 4)) / 10
        }
      } catch {}
      out.push({
        actor: a.root.name,
        enabled: o.mesh.isEnabled(),
        visible: o.mesh.isVisible,
        visibility: o.mesh.visibility,
        verts: o.mesh.getTotalVertices(),
        parts: o.parts.map(p => `${p.name}:${p.isEnabled()}`),
        mode: mat?.transparencyMode,
        cut: mat?.alphaCutOff,
        coverPct: cover,
        active: this.scene.getActiveMeshes().data.includes(o.mesh),
      })
    }
    return out
  }

  /** What the page runs on (the adapter: a real GPU or a software one). */
  async adapter(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { engine: this.app.engineKind, ua: navigator.userAgent, cores: navigator.hardwareConcurrency, dpr: devicePixelRatio }
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ info?: Record<string, string> } | null> } }).gpu
      const a = await gpu?.requestAdapter()
      if (a?.info) out.webgpu = { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description }
    } catch {}
    try {
      const c = document.createElement('canvas').getContext('webgl2')
      const ext = c?.getExtension('WEBGL_debug_renderer_info')
      if (c && ext) out.webgl2 = c.getParameter(ext.UNMASKED_RENDERER_WEBGL)
    } catch {}
    return out
  }
}

/**
 * Installs the bench. On a page served by the bench driver (`pnpm charbench --serve`) with no session yet, the bench
 * character's session comes from the driver (`/charbench/tab`), so the page goes straight to character select.
 */
export async function installCharBench(app: App): Promise<void> {
  new CharBench(app).install()
  try {
    if (!sessionStorage.getItem('sro.session')) {
      const r = await fetch('/charbench/tab')
      if (r.ok) {
        const t = (await r.json()) as { token: string; username: string; expiresAt: number }
        sessionStorage.setItem('sro.session', JSON.stringify({ token: t.token, username: t.username, expiresAt: t.expiresAt }))
      }
    }
  } catch {
    // not a bench page: log in as usual
  }
}

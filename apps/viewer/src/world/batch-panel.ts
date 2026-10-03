// The viewer's batching lab (docs/BATCHING.md §4.4, §5, BT-L; docs/WAVE_PLAN6.md §6.1): a "Batching" section in the
// render lab panel with
// - the toggle: World.setBatching (the Options → Advanced → World batching row's call), which releases every region
//   batch and rebuilds the streamed regions; after it the panel checks for leftovers (batch meshes, group materials,
//   region batches or table slots that outlived the switch, and scene counts that grew over an off → on cycle);
// - the counters: draws, active meshes, the batch part's stats (regions, meshes, table / material groups, slots,
//   triangles, geometry bytes, builds in flight, the slowest jobs) and the material table's (atlas pages and cells,
//   lightmap layers, VRAM);
// - the A/B (F14, Q13): today's chunks against the batch on the same page, with the IBL cube refresh frozen and SSAO
//   reported, so an ambient shift shows as a signed difference over the lower part of the frame (the pavement) above
//   the noise floor (two frames of the same state);
// - the bench spots: the prototype's views (work/tmp/batching/lab), each with its time and weather (plaza noon, gate in
//   a storm, fields at night, the grove), and an A/B with the frame cost (lab-bench.ts's method) at every spot.
// The frames are driven by the panel itself (the page's render loop is paused), so it works in a hidden pane too.
// LAB-10R's game bench (prof.js once per page, segments asserted) is the budget gate; this is the lab view of it.
import { type AbstractEngine, type AbstractMesh, type Scene } from '@babylonjs/core'
import type { World } from '@sro/world-render'
import { benchFrames, gpuSync, yieldTask, type BenchSample, type LabControls } from './lab-bench.ts'

// ---- the bench spots -------------------------------------------------------------------------------------------

/** One bench view: the player at (x, z) (glTF metres), the orbit camera around it, the time and the weather. */
export interface BenchSpot {
  name: string
  label: string
  x: number
  z: number
  /** Orbit angles (rad) and distance (m) around the player's eye. */
  alpha: number
  beta: number
  radius: number
  /** Time of day (0..1). */
  time: number
  weather: 'clear' | 'storm' | 'rain'
}

/**
 * The prototype's views (work/tmp/batching/lab/batching-lab.ts VIEWS) with BATCHING §5's scenes: the plaza at noon
 * (the F14 pair), the plaza toward the palace gate, the town gate in a storm, the fields at night, the grove (trees).
 */
export const BENCH_SPOTS: readonly BenchSpot[] = [
  { name: 'plaza', label: 'Plaza, noon', x: 101, z: -70, alpha: Math.PI / 2, beta: 1.42, radius: 14, time: 0.5, weather: 'clear' },
  { name: 'plazaGate', label: 'Plaza → palace gate, noon', x: 101, z: -70, alpha: Math.PI / 2, beta: 1.2, radius: 12, time: 0.5, weather: 'clear' },
  { name: 'gate', label: 'Town gate, storm', x: 101, z: 55, alpha: Math.PI / 2, beta: 1.2, radius: 12, time: 0.5, weather: 'storm' },
  { name: 'fields', label: 'Fields, night', x: 109, z: 132, alpha: -Math.PI / 2, beta: 1.2, radius: 12, time: 0.95, weather: 'clear' },
  { name: 'grove', label: 'Grove, noon', x: 52, z: -47, alpha: -1.25, beta: 1.36, radius: 34, time: 0.5, weather: 'clear' },
]

export function spotByName(name: string): BenchSpot | undefined {
  return BENCH_SPOTS.find(s => s.name === name)
}

// ---- counters --------------------------------------------------------------------------------------------------

/** The material table behind a RegionBatchPart (private there; the lab reads its counters only). */
interface TableView {
  tables?: { stats?: Record<string, number> } | null
}

/** The batch part's stats and its table's (empty when the part is off or has no table). */
export function batchStats(world: World): { part: Readonly<Record<string, number>>; table: Readonly<Record<string, number>> } {
  const part = world.batch
  if (!part) return { part: {}, table: {} }
  const table = (part as unknown as TableView).tables?.stats ?? {}
  return { part: part.stats, table }
}

/** The table's VRAM in bytes (atlas pages + NRAO pages + lightmap layers). */
export function tableBytes(table: Readonly<Record<string, number>>): number {
  return (table.albedoBytes ?? 0) + (table.nraoBytes ?? 0) + (table.lightmapBytes ?? 0)
}

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`

/** The counter lines the panel shows (and `sroWorld.batch.counters()` returns). */
export function formatCounters(world: World, draws: number, activeMeshes: number): string[] {
  const { part: p, table: t } = batchStats(world)
  const lines = [
    `batching  ${world.batching ? 'on' : 'off'} · ${world.batch ? 'part live' : world.render.mode === 'pbr' ? 'no part' : 'Classic (never batches)'}`,
    `draws     ${draws} · active meshes ${activeMeshes}`,
  ]
  if (!world.batch) return lines
  lines.push(
    `regions   ${p.regions ?? 0} batched · ${p.pending ?? 0} building · ${p.builds ?? 0} builds · ${p.dropped ?? 0} dropped`,
    `meshes    ${p.meshes ?? 0} · groups ${p.groups ?? 0} (table ${p.tableGroups ?? 0}, material ${p.materialGroups ?? 0}) · group materials ${p.groupMaterials ?? 0}`,
    `geometry  ${((p.triangles ?? 0) / 1e6).toFixed(2)} M tris · ${mb(p.bytes ?? 0)} · proxies ${p.proxies ?? 0}`,
    `claims    ${p.claims ?? 0} · refused ${p.refused ?? 0} · worker ${p.worker ? 'yes' : 'no'} · cached models ${p.cachedModels ?? 0}`,
    `jobs      main ${(p.mainMs ?? 0).toFixed(0)} ms (max ${(p.mainMaxMs ?? 0).toFixed(1)}) · worker max ${(p.workerMaxMs ?? 0).toFixed(1)} ms · slow ${p.slowJobs ?? 0}`,
  )
  if (Object.keys(t).length) {
    lines.push(
      `slots     ${t.slots ?? 0} · rows ${t.tableRows ?? 0} · refused ${t.refused ?? 0}`,
      `atlas     albedo ${t.albedoCells ?? 0} cells / ${t.albedoPages ?? 0} pages (fill ${t.albedoFill ?? 0}) · nrao ${t.nraoCells ?? 0} / ${t.nraoPages ?? 0} · lightmaps ${t.lightmaps ?? 0} / ${t.lightmapLayers ?? 0} layers`,
      `VRAM      ${mb(tableBytes(t))} (albedo ${mb(t.albedoBytes ?? 0)}, nrao ${mb(t.nraoBytes ?? 0)}, lightmaps ${mb(t.lightmapBytes ?? 0)}) · uploads ${t.cellUploads ?? 0} (max ${t.cellUploadMaxMs ?? 0} ms) · failures ${t.cellFailures ?? 0}`,
    )
  }
  return lines
}

// ---- leftovers -------------------------------------------------------------------------------------------------

export interface SceneCounts {
  meshes: number
  materials: number
  textures: number
  geometries: number
}

export function sceneCounts(scene: Scene): SceneCounts {
  return { meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length, geometries: scene.geometries.length }
}

/** What a batching switch may leave behind (BATCHING H-BT lens 2 and 17). */
export interface Leftovers {
  /** Live meshes tagged `sroBatch` (merged groups and proxies). */
  batchMeshes: number
  /** Of those, the ones no live region batch owns. */
  strayMeshes: number
  /** Live group materials (`metadata.sroBatchGroup`). */
  groupMaterials: number
  /** Region batches the objects still hold. */
  regionBatches: number
  /** Table slots still held (0 without a part). */
  slots: number
  /** The objects' batcher is set. */
  batcher: boolean
}

const isBatchMesh = (m: AbstractMesh) => !m.isDisposed() && !!(m.metadata as { sroBatch?: unknown } | null)?.sroBatch

export function findLeftovers(scene: Scene, world: World): Leftovers {
  const owned = new Set<AbstractMesh>()
  for (const b of world.objects.regionBatches.values()) {
    for (const m of b.meshes) owned.add(m)
    for (const m of b.cutoutCasters) owned.add(m)
    if (b.shadowProxy) owned.add(b.shadowProxy)
  }
  const batch = scene.meshes.filter(isBatchMesh)
  // Meshes made for a region batch by another part (BT-S's shadow-only cut-out casters, `cutoutCaster:<owner>:<n>`)
  // name the batch's owner key: they are owned while that region batch lives.
  const ownerOf = (m: AbstractMesh) => Number(/^[A-Za-z]+:(\d+)/.exec(m.name)?.[1] ?? NaN)
  const isOwned = (m: AbstractMesh) => owned.has(m) || world.objects.regionBatches.has(ownerOf(m))
  return {
    batchMeshes: batch.length,
    strayMeshes: batch.filter(m => !isOwned(m)).length,
    groupMaterials: scene.materials.filter(m => !!(m.metadata as { sroBatchGroup?: unknown } | null)?.sroBatchGroup).length,
    regionBatches: world.objects.regionBatches.size,
    slots: batchStats(world).table.slots ?? 0,
    batcher: world.objects.batcher !== null,
  }
}

/** The problems in `l` for a world whose batching is `on` (empty: clean). */
export function leftoverProblems(l: Readonly<Leftovers>, on: boolean): string[] {
  const out: string[] = []
  if (l.strayMeshes) out.push(`${l.strayMeshes} batch mesh(es) owned by no region batch`)
  if (on) return out
  if (l.batchMeshes) out.push(`${l.batchMeshes} batch mesh(es) left with batching off`)
  if (l.groupMaterials) out.push(`${l.groupMaterials} group material(s) left with batching off`)
  if (l.regionBatches) out.push(`${l.regionBatches} region batch(es) still held`)
  if (l.slots) out.push(`${l.slots} table slot(s) still held`)
  if (l.batcher) out.push('the objects still have a batcher')
  return out
}

/** Scene counts that grew between two visits of the same state (`before` → `after`): a leak per cycle. */
export function countGrowth(before: Readonly<SceneCounts>, after: Readonly<SceneCounts>): string[] {
  return (Object.keys(before) as (keyof SceneCounts)[]).filter(k => after[k] > before[k]).map(k => `${k} ${before[k]} → ${after[k]}`)
}

// ---- image difference ------------------------------------------------------------------------------------------

export interface DiffStats {
  width: number
  height: number
  /** Mean absolute difference over RGB (0..255), the whole frame. */
  mean: number
  /** Share of pixels whose largest channel difference is over 16/255. */
  over16: number
  /** Mean signed difference b − a (0..255): a uniform brightening shows here. */
  signed: number
  /** The same over the lower `lowerFrac` of the frame (the pavement in the plaza views). */
  lowerMean: number
  lowerSigned: number
}

/** Compares two RGBA images of the same size (row 0 at the top). */
export function imageDiff(a: ArrayLike<number>, b: ArrayLike<number>, width: number, height: number, lowerFrac = 0.6): DiffStats {
  if (a.length !== b.length || a.length < width * height * 4) throw new Error('imageDiff: images differ in size')
  const lowerStart = Math.floor(height * (1 - lowerFrac))
  let abs = 0, signed = 0, over = 0, lAbs = 0, lSigned = 0, lN = 0
  for (let y = 0; y < height; y++) {
    const lower = y >= lowerStart
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      let pAbs = 0, pSigned = 0, pMax = 0
      for (let c = 0; c < 3; c++) {
        const d = b[i + c]! - a[i + c]!
        const ad = d < 0 ? -d : d
        pAbs += ad
        pSigned += d
        if (ad > pMax) pMax = ad
      }
      abs += pAbs
      signed += pSigned
      if (pMax > 16) over++
      if (lower) {
        lAbs += pAbs
        lSigned += pSigned
        lN++
      }
    }
  }
  const n = width * height
  const r = (v: number) => Math.round(v * 100) / 100
  return {
    width, height,
    mean: r(abs / (3 * n)), over16: Math.round((over / n) * 10000) / 10000, signed: r(signed / (3 * n)),
    lowerMean: lN ? r(lAbs / (3 * lN)) : 0, lowerSigned: lN ? r(lSigned / (3 * lN)) : 0,
  }
}

/**
 * The A/B verdict on an ambient shift (F14): a signed lower-frame offset beyond the noise floor's and over 1/255, the
 * same way round in `back` (the batch against the later capture of today's chunks) when given.
 */
export function ambientShift(ab: Readonly<DiffStats>, noise: Readonly<DiffStats>, back?: Readonly<DiffStats>): boolean {
  const limit = Math.max(1, 2 * Math.abs(noise.lowerSigned) + noise.lowerMean * 0.25)
  if (Math.abs(ab.lowerSigned) <= limit) return false
  return !back || (Math.abs(back.lowerSigned) > limit && Math.sign(back.lowerSigned) === Math.sign(ab.lowerSigned))
}

// ---- the panel -------------------------------------------------------------------------------------------------

export interface BatchPanelHost {
  readonly engine: AbstractEngine
  readonly scene: Scene
  readonly world: World
  /** Stops / restarts the page's render loop (the panel renders its own frames meanwhile). */
  pause(): void
  resume(): void
  /** Draw calls of the last frame. */
  draws(): number
  /** Puts the player at (x, z) and the orbit camera at the given angles around it. */
  goto(x: number, z: number, alpha: number, beta: number, radius: number): void
  /** The render lab (time, weather). */
  readonly controls: Pick<LabControls, 'setTime' | 'setWeather'>
}

/** The lighting part's sky cube (render/lighting.ts; private there): the A/B freezes its refresh. */
interface SkyCubeView {
  env?: { busy: boolean; refreshes: number; begin(...a: unknown[]): void; step(): boolean; finish(): void } | null
}

export interface ToggleReport {
  on: boolean
  ms: number
  leftovers: Leftovers
  problems: string[]
  counts: SceneCounts
}

export interface AbResult {
  spot: string
  /** Draws per frame: today's chunks, the batch. */
  draws: { off: number; on: number }
  activeMeshes: { off: number; on: number }
  /** today's chunks → the batch. */
  diff: DiffStats
  /** The same with the third capture (today's chunks → the batch again, the other way round in time). */
  back: DiffStats
  /** The page's own state captured before and after the other one (the noise floor: TAA, water, wind, clouds, NPCs). */
  noise: DiffStats
  ambientShift: boolean
  iblFrozen: boolean
  ssao: boolean
  bench: { off: BenchSample | null; on: BenchSample | null }
  problems: string[]
}

const CAPTURE_W = 960

/**
 * The Batching section of the render lab (mounted into `#render-panel` after RenderPanel builds it) and, as
 * `window.sroWorld.batch`, a console handle: toggle(on), ab({ bench }), spot(name), benchSpots(), counters().
 */
export class BatchPanel {
  private readonly out: HTMLPreElement
  private readonly info: HTMLPreElement
  private readonly toggleBox: HTMLInputElement
  private busy = false
  /** The last results (console / the report). */
  readonly results: { toggles: ToggleReport[]; ab: AbResult[] } = { toggles: [], ab: [] }

  constructor(readonly root: HTMLElement, readonly host: BatchPanelHost) {
    const d = document.createElement('details')
    d.className = 'batch-panel'
    const s = document.createElement('summary')
    s.textContent = 'Batching'
    this.info = document.createElement('pre')
    this.info.className = 'lab-out'
    this.out = document.createElement('pre')
    this.out.className = 'lab-out'
    const row = document.createElement('div')
    row.className = 'row'
    const label = document.createElement('label')
    this.toggleBox = document.createElement('input')
    this.toggleBox.type = 'checkbox'
    this.toggleBox.checked = host.world.batching
    this.toggleBox.addEventListener('change', () => void this.toggle(this.toggleBox.checked))
    label.append(this.toggleBox, ' World batching (rebuild)')
    row.appendChild(label)
    const spots = document.createElement('select')
    spots.title = 'Bench spot (the player moves there; time and weather follow)'
    spots.appendChild(new Option('spot…', ''))
    for (const b of BENCH_SPOTS) spots.appendChild(new Option(b.label, b.name))
    spots.addEventListener('change', () => {
      if (spots.value) void this.spot(spots.value)
      spots.value = ''
    })
    const buttons = document.createElement('div')
    buttons.className = 'lab-buttons'
    buttons.append(
      btn('A/B here', () => void this.ab(), 'today\'s chunks vs the batch at this view: draws, image difference, IBL frozen'),
      btn('A/B + bench', () => void this.ab({ bench: true }), 'the A/B with the frame cost of each state (lab-bench.ts method)'),
      btn('All spots', () => void this.benchSpots(), 'the A/B with the bench at every spot'),
    )
    d.append(s, row, spots, buttons, this.info, this.out)
    root.appendChild(d)
    window.setInterval(() => this.renderInfo(), 500)
  }

  get world(): World {
    return this.host.world
  }

  counters(): string[] {
    return formatCounters(this.world, this.host.draws(), this.host.scene.getActiveMeshes().length)
  }

  private renderInfo(): void {
    this.toggleBox.checked = this.world.batching
    this.toggleBox.disabled = this.busy || this.world.render.mode !== 'pbr'
    this.info.textContent = this.counters().join('\n')
  }

  private log(s: string): void {
    console.info('[batch-lab]', s)
    this.out.textContent = `${this.out.textContent ? this.out.textContent + '\n' : ''}${s}`.split('\n').slice(-40).join('\n')
    this.out.scrollTop = this.out.scrollHeight
  }

  private frame(): void {
    const e = this.host.engine
    e.beginFrame()
    this.host.scene.render()
    e.endFrame()
  }

  /** Renders frames until streaming and the batch builds are idle (and at least `min` frames), at most `maxMs`. */
  async settleWorld(min = 30, maxMs = 60_000): Promise<boolean> {
    const t0 = performance.now()
    let calm = 0
    for (let i = 0; performance.now() - t0 < maxMs; i++) {
      this.frame()
      await yieldTask()
      calm = worldIdle(this.world) ? calm + 1 : 0
      if (i >= min && calm >= 10) {
        await gpuSync(this.host.engine)
        return true
      }
    }
    return false
  }

  private async run<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.busy) {
      this.log(`busy: ${what} skipped`)
      return null
    }
    this.busy = true
    this.host.pause()
    try {
      return await fn()
    } catch (err) {
      this.log(`${what} failed: ${String((err as Error)?.stack ?? err)}`)
      return null
    } finally {
      this.host.resume()
      this.busy = false
    }
  }

  /** World.setBatching(on), the rebuild to idle, then the leftover check. */
  toggle(on: boolean): Promise<ToggleReport | null> {
    return this.run('toggle', () => this.toggleNow(on))
  }

  private async toggleNow(on: boolean): Promise<ToggleReport> {
    const t0 = performance.now()
    this.world.setBatching(on)
    const idle = await this.settleWorld()
    const leftovers = findLeftovers(this.host.scene, this.world)
    const problems = leftoverProblems(leftovers, this.world.batching && !!this.world.batch)
    if (!idle) problems.push('the world did not go idle in 60 s')
    const r: ToggleReport = { on, ms: Math.round(performance.now() - t0), leftovers, problems, counts: sceneCounts(this.host.scene) }
    this.results.toggles.push(r)
    this.log(`batching ${on ? 'on' : 'off'} in ${r.ms} ms · ${problems.length ? 'LEFTOVERS: ' + problems.join('; ') : 'no leftovers'} · ` +
      `${r.counts.meshes} meshes, ${r.counts.materials} materials, ${r.counts.textures} textures`)
    return r
  }

  /** Moves to a bench spot (time, weather, camera) and waits until the world is idle. */
  spot(name: string): Promise<BenchSpot | null> {
    return this.run('spot', async () => {
      const s = spotByName(name)
      if (!s) throw new Error(`no bench spot '${name}'`)
      await this.gotoSpot(s)
      return s
    })
  }

  private async gotoSpot(s: BenchSpot): Promise<void> {
    this.host.controls.setTime(s.time)
    this.host.controls.setWeather(s.weather === 'clear' ? null : s.weather)
    this.host.goto(s.x, s.z, s.alpha, s.beta, s.radius)
    await this.settleWorld(60)
    this.log(`spot ${s.label}`)
  }

  /** The A/B at the current view (or `spot`): the page's state, the other one, the page's again (it is left as it was). */
  ab(o: { bench?: boolean; spot?: string } = {}): Promise<AbResult | null> {
    return this.run('A/B', async () => {
      if (o.spot) {
        const s = spotByName(o.spot)
        if (!s) throw new Error(`no bench spot '${o.spot}'`)
        await this.gotoSpot(s)
      }
      return this.abNow(o.spot ?? 'here', !!o.bench)
    })
  }

  /** The A/B with the bench at every spot (BATCHING §5's scenes). */
  benchSpots(): Promise<AbResult[] | null> {
    return this.run('bench', async () => {
      const out: AbResult[] = []
      for (const s of BENCH_SPOTS) {
        await this.gotoSpot(s)
        out.push(await this.abNow(s.name, true))
      }
      this.log(formatAb(out))
      return out
    })
  }

  private async abNow(label: string, bench: boolean): Promise<AbResult> {
    if (this.world.render.mode !== 'pbr') throw new Error('the A/B needs the PBR path (Classic never batches)')
    const was = this.world.batching
    const problems: string[] = []
    const unfreeze = this.freezeIbl()
    try {
      const state = async (on: boolean) => {
        if (this.world.batching !== on) {
          const t = await this.toggleNow(on)
          problems.push(...t.problems.map(p => `${on ? 'on' : 'off'}: ${p}`))
        } else await this.settleWorld()
        const shot = this.capture()
        const draws = this.host.draws()
        const active = this.host.scene.getActiveMeshes().length
        let sample: BenchSample | null = null
        if (bench) sample = await benchFrames(this.benchHost(), `${label}-${on ? 'batched' : 'chunks'}`, { frames: 120, runs: 3 })
        return { shot, draws, active, sample }
      }
      // X, Y, X again (X = the state the page was in): the noise floor spans the same time as the A/B (clouds, rain,
      // wind and TAA drift with it), and a shift that is the batch's shows against both captures of X.
      const x1 = await state(was)
      const y = await state(!was)
      const x2 = await state(was)
      const off = was ? y : x1
      const on = was ? x1 : y
      const { width: w, height: h } = x1.shot
      const diff = imageDiff(off.shot.data, on.shot.data, w, h)
      const back = was ? imageDiff(y.shot.data, x2.shot.data, w, h) : imageDiff(x2.shot.data, y.shot.data, w, h)
      const noise = imageDiff(x1.shot.data, x2.shot.data, w, h)
      const r: AbResult = {
        spot: label,
        draws: { off: off.draws, on: on.draws },
        activeMeshes: { off: off.active, on: on.active },
        diff, back, noise, ambientShift: ambientShift(diff, noise, back),
        iblFrozen: unfreeze !== null,
        ssao: !!(this.world.render.post as { plan?: { ssao?: unknown } } | null)?.plan?.ssao,
        bench: { off: off.sample, on: on.sample },
        problems,
      }
      this.results.ab.push(r)
      this.log(formatAb([r]))
      return r
    } finally {
      unfreeze?.()
      if (this.world.batching !== was) this.world.setBatching(was)
    }
  }

  /** Finishes the sky cube's refresh and holds it (null: no cube on this path). Returns the undo. */
  private freezeIbl(): (() => void) | null {
    const env = (this.world.render.lighting as unknown as SkyCubeView | null)?.env
    if (!env) return null
    if (env.busy) env.finish()
    const { begin, step } = env
    env.begin = () => {}
    env.step = () => false
    return () => {
      env.begin = begin
      env.step = step
    }
  }

  private benchHost() {
    // benchFrames pauses and resumes the page loop itself: the panel already holds it paused.
    return { engine: this.host.engine, scene: this.host.scene, world: this.world, pause() {}, resume() {} }
  }

  /** Renders one frame and copies the canvas (scaled to CAPTURE_W wide) in the same task. */
  private capture(): ImageData {
    this.frame()
    const canvas = this.host.engine.getRenderingCanvas()
    if (!canvas) throw new Error('no canvas')
    const w = Math.min(CAPTURE_W, canvas.width)
    const h = Math.max(1, Math.round((canvas.height * w) / canvas.width))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.drawImage(canvas, 0, 0, w, h)
    return g.getImageData(0, 0, w, h)
  }
}

/** True when the streamer and the batch builds are idle (no streamer: idle). */
export function worldIdle(world: World): boolean {
  const st = world.stream
  if (st) {
    const s = st.stats
    if (s.ready < s.wanted || s.objectsReady < s.ready || s.jobs || s.fetching || st.busy) return false
  }
  return !(world.batch?.stats.pending ?? 0)
}

/** One line per A/B (the panel, the console). */
export function formatAb(rows: readonly AbResult[]): string {
  const ms = (s: BenchSample | null) => (s ? `${s.wallMs.toFixed(2)}/${s.cpuMs.toFixed(2)}${s.gpuPassMs !== null ? `/${s.gpuPassMs.toFixed(2)}` : ''}` : '-')
  return rows.map(r =>
    `${r.spot}: draws ${r.draws.off} → ${r.draws.on} · active ${r.activeMeshes.off} → ${r.activeMeshes.on} · ` +
    `diff ${r.diff.mean}/255 (${(r.diff.over16 * 100).toFixed(2)} % > 16), lower ${r.diff.lowerMean} signed ${r.diff.lowerSigned} · ` +
    `back signed ${r.back.lowerSigned} · noise ${r.noise.mean} lower ${r.noise.lowerMean} signed ${r.noise.lowerSigned} · ambient shift ${r.ambientShift ? 'YES' : 'no'} · ` +
    `IBL ${r.iblFrozen ? 'frozen' : 'n/a'} · SSAO ${r.ssao ? 'on' : 'off'} · wall/cpu/gpu ms ${ms(r.bench.off)} → ${ms(r.bench.on)}` +
    (r.problems.length ? ` · PROBLEMS ${r.problems.join('; ')}` : ''),
  ).join('\n')
}

function btn(text: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = text
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}


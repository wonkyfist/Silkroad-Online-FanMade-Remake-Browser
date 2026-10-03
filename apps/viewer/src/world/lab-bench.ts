// The viewer lab's measurements (docs/WAVE_PLAN3.md §6.16, lane LAB), run on the live world of the viewer page:
// - the bench method of work/tmp/render/bench.ts: N frames rendered back to back in one task, then one wait for the GPU;
//   wall ÷ N is the pipelined frame cost (the max of CPU and GPU), the minimum of R runs (other processes only ever add
//   time). A run at 4K ÷ 4 gives the GPU cost of a 1080p frame where the GPU is the bottleneck (RENDER §11 used 8K ÷ 16);
//   WebGPU timestamps (engine.enableGPUTimingMeasurements) sum every render pass without its own counter, so they are
//   the frame's GPU pass time;
// - the §5.2 suite (presets × noon / storm / night, and the feature deltas: sky, weather, SSR, AA, cluster tile mask);
// - the DETAIL H8 normal-convention check on a lit test mesh built like the converter's output (Z mirror);
// - the D14 probe: the CPU cube refresh slices against Babylon's HDRFiltering.prefilter.
// The GPU is shared: numbers are only valid while nothing else renders or computes on it (the lab report says which).
import {
  Color3,
  Color4,
  Constants,
  DirectionalLight,
  FreeCamera,
  HDRFiltering,
  Material,
  Mesh,
  PBRMaterial,
  RawCubeTexture,
  RawTexture,
  RenderTargetTexture,
  Scene,
  Texture,
  Vector3,
  VertexData,
  type AbstractEngine,
} from '@babylonjs/core'
import { SkyEnvironment, normalInvert, type NormalGreen, type SkyRadianceSource, type World } from '@sro/world-render'

export interface BenchHost {
  readonly engine: AbstractEngine
  readonly scene: Scene
  readonly world: World
  /** Stops / restarts the page's render loop (the bench renders its own frames). */
  pause(): void
  resume(): void
}

export interface BenchOptions {
  /** Frames per run (default 90) and runs (default 3; the minimum is kept). */
  frames?: number
  runs?: number
  /** Drawing-buffer size for this measurement (default the current one; restored afterwards). */
  width?: number
  height?: number
  /** Also read the WebGPU pass timestamps (default true when the device has 'timestamp-query'). */
  timestamps?: boolean
}

export interface BenchSample {
  label: string
  width: number
  height: number
  /** Pipelined frame cost (ms): wall time of the back-to-back frames ÷ frames, minimum over the runs. */
  wallMs: number
  /** JS time per frame (ms): scene.render with World.update and the page's per-frame code, minimum over the runs. */
  cpuMs: number
  /** GPU render-pass time per frame (ms, WebGPU timestamps); null without timestamp-query. */
  gpuPassMs: number | null
}

export interface Run {
  wall: number
  cpu: number
}

/** The bench keeps the minimum wall and the minimum CPU time of its runs (RENDER §16 hygiene). */
export function minRuns(runs: readonly Run[]): Run {
  if (!runs.length) return { wall: NaN, cpu: NaN }
  let wall = Infinity
  let cpu = Infinity
  for (const r of runs) {
    wall = Math.min(wall, r.wall)
    cpu = Math.min(cpu, r.cpu)
  }
  return { wall, cpu }
}

/** A task yield that background tabs do not throttle (setTimeout is clamped to 1 s there). */
export function yieldTask(): Promise<void> {
  return new Promise(resolve => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => {
      ch.port1.close()
      resolve()
    }
    ch.port2.postMessage(0)
  })
}

interface GpuQueueOwner {
  _device?: { queue: { onSubmittedWorkDone(): Promise<unknown> } }
  _gl?: WebGL2RenderingContext
}

const pixel = new Uint8Array(4)

/** Waits until the GPU finished everything submitted so far. */
export async function gpuSync(engine: AbstractEngine): Promise<void> {
  const e = engine as unknown as GpuQueueOwner
  if (e._device) await e._device.queue.onSubmittedWorkDone()
  else if (e._gl) e._gl.readPixels(0, 0, 1, 1, e._gl.RGBA, e._gl.UNSIGNED_BYTE, pixel)
}

interface TimingEngine {
  enableGPUTimingMeasurements?: boolean
  gpuTimeInFrameForMainPass?: { counter: { current: number } }
}

function hasTimestamps(engine: AbstractEngine): boolean {
  if (!engine.isWebGPU) return false
  const features = (engine as unknown as { _device?: { features?: { has(f: string): boolean } } })._device?.features
  return !!features?.has('timestamp-query')
}

function renderFrame(host: BenchHost): void {
  host.engine.beginFrame()
  host.scene.render()
  host.engine.endFrame()
}

/** Renders until the scene's materials are ready (at most `maxMs`) and the GPU is idle. */
export async function settle(host: BenchHost, frames = 30, maxMs = 5000): Promise<void> {
  for (let i = 0; i < frames; i++) {
    renderFrame(host)
    await yieldTask()
  }
  const t0 = performance.now()
  while (performance.now() - t0 < maxMs && !host.scene.isReady(true)) {
    renderFrame(host)
    await gpuSync(host.engine)
    await yieldTask()
  }
  for (let i = 0; i < frames; i++) {
    renderFrame(host)
    await yieldTask()
  }
  await gpuSync(host.engine)
}

/** The GPU render-pass time per frame (ms) over `frames` frames, or null without timestamps. */
async function passTime(host: BenchHost, frames = 16): Promise<number | null> {
  if (!hasTimestamps(host.engine)) return null
  const e = host.engine as unknown as TimingEngine
  e.enableGPUTimingMeasurements = true
  try {
    const vals: number[] = []
    for (let i = 0; i < frames + 4; i++) {
      renderFrame(host)
      await gpuSync(host.engine)
      await yieldTask()
      const ns = e.gpuTimeInFrameForMainPass?.counter.current ?? NaN
      if (i >= 4 && Number.isFinite(ns) && ns > 0) vals.push(ns / 1e6)
    }
    if (!vals.length) return null
    vals.sort((a, b) => a - b)
    return vals[Math.floor(vals.length / 2)]!
  } finally {
    e.enableGPUTimingMeasurements = false
  }
}

/** One bench measurement of whatever the page shows now (the render loop is paused meanwhile). */
export async function benchFrames(host: BenchHost, label: string, o: BenchOptions = {}): Promise<BenchSample> {
  const { engine } = host
  const frames = o.frames ?? 90
  const runs = o.runs ?? 3
  const resize = o.width !== undefined && o.height !== undefined
  host.pause()
  try {
    if (resize) engine.setSize(o.width!, o.height!, true)
    await settle(host)
    const results: Run[] = []
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now()
      let cpu = 0
      for (let i = 0; i < frames; i++) {
        const c = performance.now()
        renderFrame(host)
        cpu += performance.now() - c
      }
      await gpuSync(engine)
      results.push({ wall: (performance.now() - t0) / frames, cpu: cpu / frames })
      await yieldTask()
    }
    const best = minRuns(results)
    const gpuPassMs = o.timestamps === false ? null : await passTime(host)
    return { label, width: engine.getRenderWidth(), height: engine.getRenderHeight(), wallMs: best.wall, cpuMs: best.cpu, gpuPassMs }
  } finally {
    if (resize) engine.resize(true)
    host.resume()
  }
}

/** One suite row: the 1080p sample and the 4K ÷ 4 GPU estimate. */
export interface SuiteRow {
  label: string
  hd: BenchSample
  /** 4K wall ÷ 4: the GPU cost of a 1080p frame while the 4K frame is GPU-bound (null: not measured). */
  gpuEstMs: number | null
  uhd: BenchSample | null
}

const f2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '   -  ' : v.toFixed(2).padStart(6))

export function formatSuite(rows: readonly SuiteRow[]): string {
  const head = `${'case'.padEnd(34)} ${'wall'.padStart(6)} ${'cpu'.padStart(6)} ${'gpu ts'.padStart(6)} │ ${'4K/4'.padStart(6)} ${'4K ts/4'.padStart(7)}  (ms, 1080p)`
  const lines = rows.map(r => {
    const uhdTs = r.uhd && r.uhd.gpuPassMs !== null ? r.uhd.gpuPassMs / 4 : null
    return `${r.label.padEnd(34).slice(0, 34)} ${f2(r.hd.wallMs)} ${f2(r.hd.cpuMs)} ${f2(r.hd.gpuPassMs)} │ ${f2(r.gpuEstMs)} ${f2(uhdTs).padStart(7)}`
  })
  return [head, ...lines].join('\n')
}

/** What the suite changes between cases (the render panel implements it on the live world). */
export interface LabControls {
  readonly path: 'classic' | 'pbr'
  setPreset(q: 'low' | 'medium' | 'high' | 'ultra'): void
  /** A weather state held fully soaked (null: clear and dry); the level follows the preset unless given. */
  setWeather(kind: 'clear' | 'storm' | 'rain' | null, level?: 'off' | 'low' | 'medium' | 'high' | 'ultra'): void
  setTime(t: number): void
  setSkyStyle(s: 'modern' | 'classic'): void
  /** One §5.1 render row forced to the value of another preset (undefined: the preset's own). */
  setRow(key: string, fromPreset: 'low' | 'medium' | 'high' | 'ultra' | undefined, value?: unknown): void
  /** Puts the camera at the bench view. */
  benchView(): void
  /** Waits until streaming is idle. */
  idle(): Promise<void>
}

export interface SuiteCase {
  label: string
  apply(c: LabControls): void
}

/** The §5.2 cases for the page's material path (see the lab report for the method). */
export function suiteCases(path: 'classic' | 'pbr', which: 'presets' | 'features' | 'all' = 'all'): SuiteCase[] {
  const out: SuiteCase[] = []
  const base = (c: LabControls, q: 'low' | 'medium' | 'high' | 'ultra') => {
    c.setPreset(q)
    c.setSkyStyle('modern')
    c.setWeather(null)
    c.setTime(0.5)
  }
  const presets = path === 'classic' ? (['low'] as const) : (['medium', 'high', 'ultra'] as const)
  if (which !== 'features') {
    for (const q of presets) {
      out.push({ label: `${q} noon clear`, apply: c => base(c, q) })
      out.push({ label: `${q} noon storm (soaked)`, apply: c => { base(c, q); c.setWeather('storm') } })
      out.push({ label: `${q} night clear`, apply: c => { base(c, q); c.setTime(0) } })
      out.push({ label: `${q} night storm (soaked)`, apply: c => { base(c, q); c.setTime(0); c.setWeather('storm') } })
    }
  }
  if (which === 'presets') return out
  const q = path === 'classic' ? 'low' : 'high'
  out.push({ label: `${q} noon, sky classic`, apply: c => { base(c, q); c.setSkyStyle('classic') } })
  out.push({ label: `${q} storm, weather off`, apply: c => { base(c, q); c.setWeather('storm', 'off') } })
  if (path === 'pbr') {
    out.push({ label: 'high storm, ssr off', apply: c => { base(c, 'high'); c.setWeather('storm'); c.setRow('ssr', undefined, 'off') } })
    out.push({ label: 'high storm, ssr always', apply: c => { base(c, 'high'); c.setWeather('storm'); c.setRow('ssr', undefined, 'always') } })
    out.push({ label: 'high noon, aa msaa x4', apply: c => { base(c, 'high'); c.setRow('aa', undefined, 'msaa') } })
    out.push({ label: 'high noon, aa fxaa', apply: c => { base(c, 'high'); c.setRow('aa', undefined, 'fxaa') } })
    out.push({ label: 'high night, cluster 0 (low row)', apply: c => { base(c, 'high'); c.setTime(0); c.setRow('nightLights', 'low') } })
    out.push({ label: 'high night, cluster 64 (ultra row)', apply: c => { base(c, 'high'); c.setTime(0); c.setRow('nightLights', 'ultra') } })
    out.push({ label: 'high noon, shadows off', apply: c => { base(c, 'high'); c.setRow('shadows', 'low') } })
    // w12r (GODRAYS): the shafts' cost on High (the Low preset's row is 'off').
    out.push({ label: 'high noon, light shafts off', apply: c => { base(c, 'high'); c.setRow('lightShafts', 'low') } })
  }
  return out
}

/** Runs the cases: each at the page size or 1080p, and (optionally) at 4K for the GPU estimate. */
export async function runSuite(host: BenchHost, controls: LabControls, cases: readonly SuiteCase[], o: { uhd?: boolean; frames?: number; runs?: number; log?: (s: string) => void } = {}): Promise<SuiteRow[]> {
  const rows: SuiteRow[] = []
  for (const k of cases) {
    try {
      k.apply(controls)
      controls.benchView()
      await controls.idle()
      const hd = await benchFrames(host, k.label, { width: 1920, height: 1080, frames: o.frames, runs: o.runs })
      let uhd: BenchSample | null = null
      if (o.uhd) uhd = await benchFrames(host, k.label, { width: 3840, height: 2160, frames: Math.max(30, Math.round((o.frames ?? 90) / 2)), runs: o.runs })
      const row = { label: k.label, hd, uhd, gpuEstMs: uhd ? uhd.wallMs / 4 : null }
      rows.push(row)
      o.log?.(formatSuite([row]).split('\n')[1]!)
    } catch (err) {
      // One broken case (an engine exception every frame) does not end the suite; the next case rebuilds the stack.
      o.log?.(`${k.label.padEnd(34).slice(0, 34)} FAILED: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return rows
}

// ---- DETAIL H8: the normal-map convention on a lit test mesh -------------------------------------------------------

/** One case of the check: which way the UVs run on the converted quad, and which way the map's normal tilts. */
export interface NormalCase {
  /** 'plain': u along file +X (world +X); 'mirrored': u along file −X (a mirrored UV half, as on a torso atlas). */
  uv: 'plain' | 'mirrored'
  /** The tangent-space tilt the map encodes (normal_gl: +X right, +Y up in the image). */
  tilt: 'right' | 'up'
}

export const NORMAL_CASES: readonly NormalCase[] = [
  { uv: 'plain', tilt: 'right' },
  { uv: 'plain', tilt: 'up' },
  { uv: 'mirrored', tilt: 'right' },
  { uv: 'mirrored', tilt: 'up' },
]

/** The four grazing key lights, named by the side they come from (world axes; glTF: +X east, −Z north). */
export const NORMAL_LIGHTS = { '+x': new Vector3(1, 0, 0), '-x': new Vector3(-1, 0, 0), '+z': new Vector3(0, 0, 1), '-z': new Vector3(0, 0, -1) } as const
export type NormalLight = keyof typeof NORMAL_LIGHTS

/**
 * Where a correct renderer must light a tilted texel from. A normal_gl map's +X faces the direction of increasing u on
 * the surface, its +Y the top of the image, i.e. decreasing glTF v (glTF's v runs down the image). On the test quad
 * (world, after the converter's Z mirror) v increases toward world −Z (the file's +Z); u toward +X, or −X when mirrored.
 */
export function expectedLight(c: NormalCase): NormalLight {
  if (c.tilt === 'up') return '+z'
  return c.uv === 'plain' ? '+x' : '-x'
}

/**
 * The quad as the converter writes it (packages/convert/src/gltf/space.ts): authored in the left-handed file space
 * (Y up, normal +Y), then mirrored by diag(1, 1, −1) with the triangle winding reversed.
 */
export function convertedQuad(uv: NormalCase['uv']): { positions: number[]; normals: number[]; uvs: number[]; indices: number[] } {
  // File space: corners at x, z = ±1; v runs along file +Z (image rows go "south" in the file).
  const file = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const
  const positions: number[] = []
  const uvs: number[] = []
  const normals: number[] = []
  for (const [x, z] of file) {
    positions.push(x, 0, -z) // the mirror
    normals.push(0, 1, 0) // n.z → −n.z leaves +Y
    const u = (x + 1) / 2
    uvs.push(uv === 'plain' ? u : 1 - u, (z + 1) / 2)
  }
  // The raw file order has cross(b − a, c − a) along the stored normal (+Y); the mirror turns (a, b, c) into (a, c, b).
  const fileIdx = [0, 2, 1, 0, 3, 2]
  const indices: number[] = []
  for (let i = 0; i < fileIdx.length; i += 3) indices.push(fileIdx[i]!, fileIdx[i + 2]!, fileIdx[i + 1]!)
  return { positions, normals, uvs, indices }
}

/** A 4×4 constant normal map tilted by `deg` toward image +X or +Y (normal_gl), or toward −Y for a 'dx' map. */
export function tiltedNormalMap(tilt: NormalCase['tilt'], green: NormalGreen, deg = 35): Uint8Array {
  const s = Math.sin((deg * Math.PI) / 180)
  const c = Math.cos((deg * Math.PI) / 180)
  let nx = 0
  let ny = 0
  if (tilt === 'right') nx = s
  else ny = green === 'dx' ? -s : s
  const px = [nx, ny, c].map(v => Math.round((v * 0.5 + 0.5) * 255))
  const out = new Uint8Array(4 * 4 * 4)
  for (let i = 0; i < 16; i++) out.set([px[0]!, px[1]!, px[2]!, 255], i * 4)
  return out
}

export interface NormalCheckRow {
  uv: NormalCase['uv']
  tilt: NormalCase['tilt']
  green: NormalGreen
  /** Mean brightness 0..255 per light direction. */
  lit: Record<NormalLight, number>
  brightest: NormalLight
  expected: NormalLight
  pass: boolean
}

/**
 * DETAIL H8: renders the converted quad with each tilted map through the loader's rule (pbr/maps.ts normalInvert for
 * this scene's handedness) under four grazing lights, and reports which light brightens it most. 'gl' rows must
 * all pass; the 'dx' rows are the control (a map with the other green convention bound as 'gl' must fail on 'up').
 */
export async function runNormalCheck(host: BenchHost): Promise<NormalCheckRow[]> {
  const { engine } = host
  const scene = new Scene(engine, { virtual: true })
  scene.useRightHandedSystem = host.scene.useRightHandedSystem
  scene.clearColor = new Color4(0, 0, 0, 1)
  scene.ambientColor = Color3.Black()
  scene.environmentIntensity = 0
  scene.imageProcessingConfiguration.isEnabled = false
  scene.fogEnabled = false
  const camera = new FreeCamera('h8Camera', new Vector3(0, 5, 0), scene)
  camera.mode = FreeCamera.ORTHOGRAPHIC_CAMERA
  camera.orthoLeft = -0.5
  camera.orthoRight = 0.5
  camera.orthoTop = 0.5
  camera.orthoBottom = -0.5
  camera.upVector = new Vector3(0, 0, -1)
  camera.setTarget(Vector3.Zero())
  camera.minZ = 0.1
  camera.maxZ = 20
  const light = new DirectionalLight('h8Key', new Vector3(0, -1, 0), scene)
  light.intensity = 0.6
  const rtt = new RenderTargetTexture('h8Target', 32, scene, false, true, Constants.TEXTURETYPE_UNSIGNED_BYTE)
  rtt.activeCamera = camera
  rtt.clearColor = new Color4(0, 0, 0, 1)
  scene.customRenderTargets.push(rtt)
  const rows: NormalCheckRow[] = []
  host.pause()
  try {
    for (const green of ['gl', 'dx'] as const) {
      for (const c of NORMAL_CASES) {
        const quad = new Mesh(`h8Quad_${c.uv}_${c.tilt}`, scene)
        const g = convertedQuad(c.uv)
        const vd = new VertexData()
        vd.positions = g.positions
        vd.normals = g.normals
        vd.uvs = g.uvs
        vd.indices = g.indices
        vd.applyToMesh(quad)
        // The glTF loader marks every mesh counter-clockwise (glTF's front face); a plain Mesh defaults to clockwise.
        quad.sideOrientation = Material.CounterClockWiseSideOrientation
        const mat = new PBRMaterial(`h8Mat_${green}`, scene)
        mat.albedoColor = Color3.White()
        mat.metallic = 0
        mat.roughness = 1
        mat.environmentIntensity = 0
        mat.specularIntensity = 0
        const tex = RawTexture.CreateRGBATexture(tiltedNormalMap(c.tilt, green), 4, 4, scene, false, false, Texture.NEAREST_SAMPLINGMODE)
        mat.bumpTexture = tex
        // The loader binds every map as 'gl' unless the index says 'dx'; the control binds a dx map as gl.
        const inv = normalInvert(scene.useRightHandedSystem, 'gl')
        mat.invertNormalMapX = inv.x
        mat.invertNormalMapY = inv.y
        quad.material = mat
        rtt.renderList = [quad]
        const lit = {} as Record<NormalLight, number>
        for (const [name, dir] of Object.entries(NORMAL_LIGHTS) as [NormalLight, Vector3][]) {
          // 30° above the horizon, coming from `dir`.
          light.direction = new Vector3(-dir.x * 0.866, -0.5, -dir.z * 0.866)
          // Compile first, then read a frame drawn with the ready material under this light.
          for (let tries = 0; tries < 200 && !mat.isReady(quad); tries++) {
            renderFrameOf(engine, scene)
            await gpuSync(engine)
            await yieldTask()
          }
          renderFrameOf(engine, scene)
          await gpuSync(engine)
          const px = await rtt.readPixels()
          lit[name] = px ? meanRgb(px as Uint8Array) : NaN
        }
        const brightest = (Object.keys(lit) as NormalLight[]).reduce((a, b) => (lit[b] > lit[a] ? b : a))
        const expected = expectedLight(c)
        rows.push({ uv: c.uv, tilt: c.tilt, green, lit, brightest, expected, pass: brightest === expected })
        quad.dispose()
        mat.dispose()
        tex.dispose()
      }
    }
  } finally {
    scene.dispose()
    host.resume()
  }
  return rows
}

function renderFrameOf(engine: AbstractEngine, scene: Scene): void {
  engine.beginFrame()
  scene.render()
  engine.endFrame()
}

function meanRgb(px: Uint8Array): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < px.length; i += 4) {
    sum += px[i]! + px[i + 1]! + px[i + 2]!
    n += 3
  }
  return n ? sum / n : NaN
}

export function formatNormalCheck(rows: readonly NormalCheckRow[]): string {
  const lines = rows.map(r =>
    `${r.green} ${r.uv.padEnd(8)} ${r.tilt.padEnd(5)} ` +
    (Object.keys(r.lit) as NormalLight[]).map(k => `${k} ${r.lit[k].toFixed(0).padStart(3)}`).join('  ') +
    `  → ${r.brightest} (want ${r.expected}) ${r.pass ? 'ok' : 'WRONG'}`)
  const gl = rows.filter(r => r.green === 'gl')
  const verdict = gl.length && gl.every(r => r.pass) ? 'normal_gl through normalInvert: correct on plain and mirrored UVs' : 'normal_gl: WRONG somewhere (see rows)'
  const dxUp = rows.filter(r => r.green === 'dx' && r.tilt === 'up')
  const control = dxUp.length && dxUp.every(r => !r.pass)
    ? 'control: a dx map bound as gl lights "up" from the wrong side, so the check can fail'
    : 'control: the dx map did not flip, so the check is not sensitive'
  return [...lines, verdict, control].join('\n')
}

// ---- D14: CPU-sliced cube vs HDRFiltering.prefilter ----------------------------------------------------------------

export interface CubeProbe {
  size: number
  /** Main-thread ms of each slice: 6 level-0 faces, 6 mip faces, the upload. */
  slices: number[]
  /** HDRFiltering.prefilter of the same level 0 (ms to GPU idle), null when it failed. */
  hdrFilteringMs: number | null
  hdrFilteringError: string | null
}

/** Times one CPU refresh of a `size` sky cube from the world's sky, and Babylon's GPU prefilter of the same faces. */
export async function probeCube(host: BenchHost, size: number): Promise<CubeProbe> {
  const { scene, world, engine } = host
  const src = world.sky as unknown as SkyRadianceSource
  const radiance = typeof src.radiance === 'function'
    ? src.radiance()
    : (_x: number, y: number, _z: number, out: [number, number, number]) => {
      const k = Math.max(0, y)
      out[0] = 0.2 + 0.1 * k
      out[1] = 0.3 + 0.2 * k
      out[2] = 0.45 + 0.4 * k
    }
  const env = new SkyEnvironment(scene, size, scene.useRightHandedSystem)
  const slices: number[] = []
  env.begin(radiance)
  while (env.busy) {
    const t0 = performance.now()
    env.step()
    slices.push(performance.now() - t0)
  }
  let hdrFilteringMs: number | null = null
  let hdrFilteringError: string | null = null
  host.pause()
  try {
    // Twice: the first call compiles the filter effect; the second is the refresh cost.
    for (let run = 0; run < 2; run++) {
      const cube = new RawCubeTexture(scene, env.packed[0]!, size, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_HALF_FLOAT, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE)
      try {
        const filter = new HDRFiltering(engine, { quality: 1024 })
        await gpuSync(engine)
        engine.beginFrame()
        const t0 = performance.now()
        try {
          const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out (a GLSL-only shader on WebGPU?)')), 8000))
          await Promise.race([filter.prefilter(cube), timeout])
        } finally {
          engine.endFrame()
        }
        await gpuSync(engine)
        hdrFilteringMs = performance.now() - t0
      } finally {
        cube.dispose()
      }
    }
  } catch (err) {
    hdrFilteringError = err instanceof Error ? err.message : String(err)
  } finally {
    env.dispose()
    host.resume()
  }
  return { size, slices, hdrFilteringMs, hdrFilteringError }
}

export function formatCubeProbe(p: CubeProbe): string {
  const f = (a: number[]) => a.map(v => v.toFixed(2)).join(' ')
  const max = Math.max(...p.slices)
  return `cube ${p.size}²: faces [${f(p.slices.slice(0, 6))}] mips [${f(p.slices.slice(6, 12))}] upload ${p.slices[12]?.toFixed(2) ?? '-'} ms ` +
    `(worst slice ${max.toFixed(2)} ms, total ${p.slices.reduce((a, b) => a + b, 0).toFixed(1)} ms over ${p.slices.length} frames)\n` +
    `HDRFiltering.prefilter ${p.size}² (1024 samples, new RT cube): ${p.hdrFilteringMs !== null ? `${p.hdrFilteringMs.toFixed(1)} ms to GPU idle` : `failed: ${p.hdrFilteringError}`}`
}

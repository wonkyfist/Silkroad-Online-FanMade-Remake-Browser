/**
 * The 100-player character bench (docs/CHARACTERS.md §9): `pnpm charbench [options]`.
 *
 * 1. A private game server (default :7290, its own DATA_DIR in a temp folder, deleted at the end) with N bots in the
 *    Jangan plaza (charbench-bots.ts: mixed bodies, weapons, gear, +N glows, seals; standing, walking, fighting).
 * 2. A production build of the game (its own Vite cache and output under work/tmp/charbench/) on a private preview
 *    (default :5200) proxied to that server.
 * 3. One headless Chrome per configuration (engine x preset), one after another, on `?charbench=1`: it enters the
 *    world as the bench character, waits for the crowd, runs `__sroCharBench.run()` (views x variants x rounds,
 *    interleaved) and saves the results, then the screenshots.
 *
 * Options:
 *   --configs webgpu-medium,webgl2-medium,webgpu-low   engine-preset pairs (engine: webgpu | webgl2)
 *   --bots 100  --rounds 3  --frames 300  --views close,mid,far  --settle 2000 (ms after a variant switch)
 *   --variants before,after          named knob sets: before = every CHAR_LOD rule off (HEAD before P0), after = all on,
 *                                    p0 = the P0 rules on, the crowd tier (P1a) off,
 *                                    floor = every other character hidden and paused (the frame without the crowd),
 *                                    only-<rule> = that CHAR_LOD rule alone, nocrowd = the G1 crowd budget off too
 *   --profile mid                    a JS CPU profile of those views (unminified build), top functions in <config>-<view>.top.txt
 *   --shots <dir>                    screenshots (close and far, each variant) of the first configuration
 *   --out <dir>                      results (default work/tmp/charbench/<stamp>)
 *   --serve                          no Chrome: server + bots + preview until Ctrl+C; open
 *                                    http://localhost:5200/?charbench=1 and run `await __sroCharBench.prepare({minPlayers: 95});
 *                                    await __sroCharBench.run(); __sroCharBench.download()` in the console
 *   --no-build                       reuse the last build
 *   --debug-port <n>                 Chrome's first CDP port (default 9611; another bench running on this machine)
 *   --headed                         a visible Chrome window (the GPU path a player gets) instead of headless
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, freemem, tmpdir } from 'node:os'
import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startCharBench } from './charbench-bots.ts'

const REPO = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const GAME = join(REPO, 'apps/game')
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const args = process.argv.slice(2)
const opt = (k: string, d: string) => {
  const i = args.indexOf('--' + k)
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1]! : d
}
const flag = (k: string) => args.includes('--' + k)
const SERVER_PORT = Number(opt('port', '7290'))
const PAGE_PORT = Number(opt('page-port', '5200'))
const BOTS = Number(opt('bots', '100'))
const ROUNDS = Number(opt('rounds', '3'))
const FRAMES = Number(opt('frames', '300'))
/** Wait after switching variants before measuring (ms): the P0 merges take ≈ 11 s to come back after the crowd tier. */
const SETTLE_MS = Number(opt('settle', '2000'))
const VIEWS = opt('views', 'close,mid,far').split(',')
const VARIANTS = opt('variants', 'before,after').split(',')
const CONFIGS = opt('configs', 'webgpu-medium,webgl2-medium,webgpu-low').split(',')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT = resolve(opt('out', join(REPO, 'work/tmp/charbench', stamp)))
const SHOTS = opt('shots', '')
/** --shot-near: the shots merge every character, near ones too (the look check of the outfit merge up close). */
const SHOT_NEAR = flag('shot-near')
/** --work <dir>: the build output and Vite cache (default work/tmp/charbench; a second bench on the same tree needs its own). */
const WORK = resolve(opt('work', join(REPO, 'work/tmp/charbench')))
const PROFILE = opt('profile', '')
/** --scenes plaza,fields,storm,crowd: the perf audit (docs/PERF_AUDIT.md) instead of the view x variant plan; with --profile scenes a JS CPU profile per scene. */
const SCENE_LIST = opt('scenes', '')
/** --ab a,b|all: per scene, each `window.__sroPerf` switch (apps/game/src/world/perf.ts) off / on, the others on; `all` = every switch; interleaved, the order reversed every other round. */
const AB = opt('ab', '')
/** --query 'newchar=1': extra page parameters (the P1 pilot body on the bench character, docs/CHARACTERS.md §15). */
const QUERY = opt('query', '')
/** --bench-model CHAR_CH_WOMAN_ADVENTURER: the bench character's body. */
const BENCH_MODEL = opt('bench-model', '')
/** --pilot-shots <dir>: portraits of the P1 pilot (with --query newchar=1) instead of the measurement. */
const PILOT_SHOTS = opt('pilot-shots', '')
/** --licensed-shots <dir>: the licensed body (with --query newchar=1, CHARACTERS §16): front, 3/4, idle, run, sword attack, sit. */
const LICENSED_SHOTS = opt('licensed-shots', '')
/** --material-shots <dir>: the materials + lighting check (CHARACTERS §16.1): face and body close-ups of the own character, then
 *  wide shots of the plaza at day / dusk / night and the fields (with --wide; the bots stay visible there). */
const MATERIAL_SHOTS = opt('material-shots', '')
/** --steps <file.json>: a look lab, [{ js?, shot?, wait? }] run in order after the scene is ready (shots into --out). */
const STEPS = opt('steps', '')
const DIST = join(WORK, PROFILE ? 'dist-prof' : 'dist')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** The whole machine's CPU use (%) every 2 s while the bench runs (the bench shares the machine with the server, its bots and whatever else runs). */
const cpuLog: { at: number; pct: number; freeMB: number }[] = []
function cpuSampler(): () => void {
  const total = () => cpus().reduce((a, c) => { const t = c.times; return { idle: a.idle + t.idle, all: a.all + t.idle + t.user + t.sys + t.irq + t.nice } }, { idle: 0, all: 0 })
  let last = total()
  const t = setInterval(() => {
    const now = total()
    const all = now.all - last.all
    cpuLog.push({ at: Date.now(), pct: all > 0 ? Math.round((1000 * (all - (now.idle - last.idle))) / all) / 10 : 0, freeMB: Math.round(freemem() / 1048576) })
    last = now
  }, 2000)
  return () => clearInterval(t)
}
const cpuDuring = (from: number, to: number) => {
  const s = cpuLog.filter(c => c.at >= from && c.at <= to)
  const m = s.length ? s.reduce((a, c) => a + c.pct, 0) / s.length : NaN
  return { meanPct: Math.round(m * 10) / 10, maxPct: s.length ? Math.max(...s.map(c => c.pct)) : null, minFreeMB: s.length ? Math.min(...s.map(c => c.freeMB)) : null, samples: s.length }
}
const log = (s: string) => console.log(`[charbench ${new Date().toISOString().slice(11, 19)}] ${s}`)

/** The game's Vite (apps/game's dependency, not the server's): only what the bench calls. */
interface ViteApi {
  build(config: object): Promise<unknown>
  preview(config: object): Promise<{ close(): Promise<void> }>
}

async function vite(): Promise<ViteApi> {
  return (await import(pathToFileURL(join(GAME, 'node_modules/vite/dist/node/index.js')).href)) as ViteApi
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const stopCpu = cpuSampler()
  const dataDir = mkdtempSync(join(tmpdir(), 'sro-charbench-'))
  const origins = [`http://localhost:${PAGE_PORT}`, `http://127.0.0.1:${PAGE_PORT}`]
  const serverLog: string[] = []
  log(`server :${SERVER_PORT}, data ${dataDir}, ${BOTS} bots`)
  const bench = await startCharBench({ port: SERVER_PORT, dataDir, bots: BOTS, origins, log: l => serverLog.push(l), progress: log, seed: 1, ...(BENCH_MODEL ? { benchModel: BENCH_MODEL } : {}) })
  writeFileSync(join(OUT, 'bots.json'), JSON.stringify({ status: bench.status(), bots: bench.bots }, null, 1))
  log(`bots in: ${JSON.stringify(bench.status())}`)

  const v = await vite()
  const common = {
    configFile: join(GAME, 'vite.config.ts'),
    root: GAME,
    cacheDir: join(WORK, '.vite'),
    logLevel: 'warn' as const,
    build: { outDir: DIST, emptyOutDir: true, ...(PROFILE ? { minify: false } : {}) },
  }
  if (!flag('no-build') || !existsSync(join(DIST, 'index.html'))) {
    log('building the game (production) into ' + DIST)
    await v.build(common)
  }
  const target = `http://127.0.0.1:${SERVER_PORT}`
  const preview = await v.preview({
    ...common,
    preview: {
      port: PAGE_PORT,
      strictPort: true,
      proxy: {
        '/api': { target, changeOrigin: true },
        '/ws': { target: target.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
        '/charbench': { target: `http://127.0.0.1:${SERVER_PORT + 1}`, rewrite: (p: string) => p.replace(/^\/charbench/, '') },
      },
    },
  })
  log(`page http://localhost:${PAGE_PORT}/?charbench=1`)

  const stop = async () => {
    await preview.close()
    await bench.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
  if (flag('serve')) {
    log('serving until Ctrl+C')
    process.on('SIGINT', () => void stop().then(() => process.exit(0)))
    return
  }

  const summary: string[] = []
  try {
    for (let ci = 0; ci < CONFIGS.length; ci++) {
      const [engine, preset] = CONFIGS[ci]!.split('-') as [string, string]
      const page = await openChrome({ webgl: engine === 'webgl2', preset, headed: flag('headed') })
      try {
        log(`${CONFIGS[ci]}: entering the world (chrome pid ${page.pid})`)
        await page.enterWorld()
        const adapter = await page.ev('__sroCharBench.adapter()')
        const st = await page.ev(`__sroCharBench.prepare({ minPlayers: ${Math.floor(BOTS * 0.95)} })`)
        log(`${CONFIGS[ci]}: ${JSON.stringify(st)}`)
        if (PILOT_SHOTS) {
          await pilotShots(page)
          continue
        }
        if (LICENSED_SHOTS) {
          await licensedShots(page)
          continue
        }
        if (STEPS) {
          const steps = JSON.parse(readFileSync(STEPS, 'utf8')) as { js?: string; shot?: string; wait?: number }[]
          for (const st of steps) {
            if (st.js) {
              const r = String(await page.ev(st.js, 120_000))
              log('step: ' + r.slice(0, 300))
              appendFileSync(join(OUT, 'steps.log'), r + String.fromCharCode(10))
            }
            if (st.wait) await sleep(st.wait)
            if (st.shot) await page.shot(join(OUT, st.shot + '.png'))
          }
          continue
        }
        if (MATERIAL_SHOTS) {
          await materialShots(page)
          continue
        }
        if (SCENE_LIST) {
          await runScenes(page, CONFIGS[ci]!, adapter, summary)
          continue
        }
        const plan = {
          rounds: ROUNDS,
          frames: FRAMES,
          views: VIEWS,
          settleMs: SETTLE_MS,
          tag: CONFIGS[ci],
          variants: buildVariants(VARIANTS),
        }
        const t0 = Date.now()
        const results = (await page.ev(`__sroCharBench.run(${JSON.stringify(plan)})`, 3_600_000)) as Record<string, any>[]
        writeFileSync(join(OUT, `${CONFIGS[ci]}.json`), JSON.stringify({ config: CONFIGS[ci], adapter, status: st, server: bench.status(), machineCpu: cpuDuring(t0, Date.now()), results }, null, 1))
        summary.push(...summarise(CONFIGS[ci]!, results), `machine CPU during the runs: ${JSON.stringify(cpuDuring(t0, Date.now()))}`, '')
        log(`${CONFIGS[ci]}: done`)
        if (PROFILE) {
          // a JS CPU profile of one view (unminified build), with the frames pumped as in a measurement
          for (const view of PROFILE.split(',')) {
            await page.ev(`__sroCharBench.view(${JSON.stringify(view)})`)
            await sleep(2000)
            await page.send('Profiler.enable')
            await page.send('Profiler.setSamplingInterval', { interval: 200 })
            await page.send('Profiler.start')
            await page.ev(`__sroCharBench.measure('profile-${view}', { frames: 300 })`, 600_000)
            const { profile } = await page.send('Profiler.stop')
            writeFileSync(join(OUT, `${CONFIGS[ci]}-${view}.cpuprofile`), JSON.stringify(profile))
            writeFileSync(join(OUT, `${CONFIGS[ci]}-${view}.top.txt`), topSelf(profile).join(String.fromCharCode(10)))
          }
        }
        if (SHOTS && ci === 0) {
          mkdirSync(SHOTS, { recursive: true })
          // the crowd holds still for the shots (each pair shows the same people in the same places)
          bench.setBehaving(false)
          await sleep(4000)
          for (const view of ['close', 'far']) {
            for (const name of VARIANTS) {
              await page.ev(`(__sroCharBench.view(${JSON.stringify(view)}), __sroCharBench.knobs(${JSON.stringify({ hideOthers: false, outfitNear: SHOT_NEAR, ...knobsFor(name) })}), new Promise(r => setTimeout(r, 2500)))`)
              await page.shot(join(SHOTS, `bench-${CONFIGS[ci]}-${view}-${name}.png`))
            }
          }
          await page.ev(`__sroCharBench.knobs(${JSON.stringify({ ...knobsFor('after'), hideOthers: false, outfitNear: false })})`)
          bench.setBehaving(true)
        }
      } finally {
        writeFileSync(join(OUT, `${CONFIGS[ci]}.console.log`), page.logs.join('\n'))
        await page.close()
        log(`chrome pid ${page.pid} closed`)
      }
    }
  } finally {
    stopCpu()
    writeFileSync(join(OUT, 'cpu.json'), JSON.stringify(cpuLog))
    writeFileSync(join(OUT, 'summary.md'), summary.join('\n') + '\n')
    writeFileSync(join(OUT, 'server.log'), serverLog.slice(-2000).join('\n'))
    await stop()
    log('results in ' + OUT)
    console.log(summary.join('\n'))
  }
}

/** The perf audit's scenes on one page: settle, ROUNDS measurements (or --ab pairs), then an optional CPU profile. */
async function runScenes(page: Page, config: string, adapter: unknown, summary: string[]): Promise<void> {
  const out: Record<string, any>[] = []
  for (const scene of SCENE_LIST.split(',')) {
    const st = await page.ev(`__sroCharBench.setScene(${JSON.stringify(scene)})`, 300_000)
    log(`${config} ${scene}: ${JSON.stringify(st)}`)
    const t0 = Date.now()
    // --ab a,b: arms a:off, a:on, b:off, b:on (the others on); `all` switches every one
    const arms = AB ? AB.split(',').flatMap(n => [`${n}:off`, `${n}:on`]) : ['base']
    for (let r = 0; r < ROUNDS; r++) {
      for (const arm of r % 2 ? [...arms].reverse() : arms) {
        if (AB) {
          const [name, state] = arm.split(':') as [string, string]
          await page.ev(
            `(Object.keys(window.__sroPerf).forEach(k => window.__sroPerf[k] = ${JSON.stringify(name)} === 'all' || k !== ${JSON.stringify(name)} ? ${name === 'all' ? state === 'on' : true} : ${state === 'on'}), new Promise(r => setTimeout(r, ${SETTLE_MS})))`,
          )
        }
        const m = (await page.ev(`__sroCharBench.measure(${JSON.stringify(`${config}-${scene}-${arm}-r${r + 1}`)}, { frames: ${FRAMES} })`, 600_000)) as Record<string, any>
        Object.assign(m, { scene, arm, round: r + 1 })
        out.push(m)
        log(`${m.label} p50 ${m.frameMs.p50} p95 ${m.frameMs.p95} cpu ${m.cpuMs.p50} gpu ${m.gpuMs?.p50} draws ${m.draws} active ${m.census.activeMeshes}`)
      }
    }
    if (AB) await page.ev(`Object.keys(window.__sroPerf).forEach(k => window.__sroPerf[k] = true)`)
    const machine = cpuDuring(t0, Date.now())
    for (const m of out) if (m.scene === scene) m.machineCpu = machine
    log(`${config} ${scene}: machine ${JSON.stringify(machine)}`)
    if (PROFILE === 'scenes') {
      await page.send('Profiler.enable')
      await page.send('Profiler.setSamplingInterval', { interval: 200 })
      await page.send('Profiler.start')
      await page.ev(`__sroCharBench.measure('profile-${scene}', { frames: 300 })`, 600_000)
      const { profile } = await page.send('Profiler.stop')
      writeFileSync(join(OUT, `${config}-${scene}.cpuprofile`), JSON.stringify(profile))
      writeFileSync(join(OUT, `${config}-${scene}.top.txt`), topSelf(profile).join(String.fromCharCode(10)))
    }
  }
  writeFileSync(join(OUT, `${config}.json`), JSON.stringify({ config, adapter, results: out }, null, 1))
  const med = (a: number[]) => {
    const s = a.filter(Number.isFinite).sort((x, y) => x - y)
    return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]! * 10) / 10 : NaN
  }
  summary.push(`### ${config}`, '', '| scene | arm | p50 | p95 | cpu p50 | cpu p95 | gpu p50 | draws | active meshes | machine cpu % mean (max) / min free MB |', '|---|---|---|---|---|---|---|---|---|---|')
  for (const k of [...new Set(out.map(m => `${m.scene}|${m.arm}`))]) {
    const rs = out.filter(m => `${m.scene}|${m.arm}` === k)
    const f = (g: (m: any) => number) => med(rs.map(g))
    const mc = rs[0]!.machineCpu
    summary.push(`| ${k.replace('|', ' | ')} | ${f(m => m.frameMs.p50)} | ${f(m => m.frameMs.p95)} | ${f(m => m.cpuMs.p50)} | ${f(m => m.cpuMs.p95)} | ${f(m => m.gpuMs?.p50)} | ${f(m => m.draws)} | ${f(m => m.census.activeMeshes)} | ${mc.meanPct} (${mc.maxPct}) / ${mc.minFreeMB} |`)
  }
  summary.push('')
}

/** The knob set of a variant name as the page's `knobs()` takes it (every CHAR_LOD switch named by the page). */
function knobsFor(name: string): Record<string, boolean> {
  if (name === 'before') return { __all: false }
  if (name === 'nocrowd') return { __all: false, crowd: false }
  if (name === 'after' || name === 'base') return { __all: true }
  // P1a: every P0 rule on, the crowd tier off (the state P1a starts from)
  if (name === 'p0') return { __all: true, crowdTier: false }
  if (name === 'floor') return { __all: false, hideOthers: true }
  // only-<rule>: that one CHAR_LOD rule on, the rest off (each rule's own share)
  if (name.startsWith('only-')) return { __all: false, [name.slice(5)]: true }
  throw new Error('unknown variant ' + name)
}

function buildVariants(names: string[]): Record<string, Record<string, boolean>> {
  return Object.fromEntries(names.map(n => [n, knobsFor(n)]))
}

/** One table row per (view, variant): the median over rounds of p50 / p95 / p99, CPU, GPU, draws. */
function summarise(config: string, results: Record<string, any>[]): string[] {
  const med = (a: number[]) => {
    const s = a.filter(Number.isFinite).sort((x, y) => x - y)
    return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN
  }
  const rows = [`### ${config}`, '', '| view | variant | p50 | p95 | p99 | cpu p50 | gpu p50 | draws | posed/frame | active meshes | skinned verts | over 16.7 |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
  const keys = [...new Set(results.map(r => `${r.view}|${r.variant}`))]
  for (const k of keys) {
    const rs = results.filter(r => `${r.view}|${r.variant}` === k)
    const [view, variant] = k.split('|')
    const f = (g: (r: any) => number) => {
      const m = med(rs.map(g))
      return Number.isFinite(m) ? String(Math.round(m * 10) / 10) : '–'
    }
    rows.push(`| ${view} | ${variant} | ${f(r => r.frameMs.p50)} | ${f(r => r.frameMs.p95)} | ${f(r => r.frameMs.p99)} | ${f(r => r.cpuMs.p50)} | ${f(r => r.gpuMs?.p50)} | ${f(r => r.draws)} | ${f(r => r.posedPerFrame)} | ${f(r => r.census.activeMeshes)} | ${f(r => r.census.skinnedVertices)} | ${f(r => r.over16_7)} |`)
  }
  rows.push('')
  return rows
}

/** The 60 functions with the most self time in a CDP profile (name, file:line, ms, share). */
function topSelf(p: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }[]; samples: number[]; timeDeltas: number[] }): string[] {
  const self = new Map<number, number>()
  for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i]!, (self.get(p.samples[i]!) ?? 0) + (p.timeDeltas[i] ?? 0))
  const byFn = new Map<string, number>()
  let total = 0
  for (const n of p.nodes) {
    const t = self.get(n.id) ?? 0
    total += t
    const cf = n.callFrame
    const k = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`
    byFn.set(k, (byFn.get(k) ?? 0) + t)
  }
  return [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k, t]) => `${(t / 1000).toFixed(0).padStart(7)} ms ${((100 * t) / total).toFixed(1).padStart(5)} %  ${k}`)
}

interface Page {
  pid: number | undefined
  send(method: string, params?: object, timeoutMs?: number): Promise<any>
  logs: string[]
  ev(expr: string, timeoutMs?: number): Promise<unknown>
  shot(file: string): Promise<void>
  enterWorld(): Promise<void>
  close(): Promise<void>
}

// `--debug-port`: a second bench on the same machine (another helper's on 9611) needs its own CDP port
let nextDebugPort = Number(opt('debug-port', '9611'))

async function openChrome(o: { webgl: boolean; preset: string; headed: boolean }): Promise<Page> {
  const port = nextDebugPort++
  const dir = mkdtempSync(join(tmpdir(), 'sro-charbench-chrome-'))
  const chrome: ChildProcess = spawn(
    CHROME,
    [
      ...(o.headed ? [] : ['--headless=new']),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      '--window-size=1920,1080',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  type Target = { type: string; webSocketDebuggerUrl: string }
  let list: Target[] | null = null as Target[] | null
  for (let i = 0; i < 80 && !list; i++) {
    try {
      list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[]
    } catch {
      await sleep(250)
    }
  }
  const target = list?.find(t => t.type === 'page')
  if (!target) throw new Error('chrome did not start')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map<number, (m: any) => void>()
  const logs: string[] = []
  const liveLog = join(OUT, `chrome-${port}.log`)
  const note = (line: string) => {
    logs.push(line)
    try {
      appendFileSync(liveLog, line + String.fromCharCode(10))
    } catch {}
  }
  ws.onmessage = ev => {
    const m = JSON.parse(String(ev.data))
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m)
      pending.delete(m.id)
    } else if (m.method === 'Runtime.consoleAPICalled') note(`[${m.params.type}] ` + m.params.args.map((a: any) => a.value ?? a.description ?? '').join(' '))
    else if (m.method === 'Runtime.exceptionThrown') note('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 800))
  }
  const send = (method: string, params: object = {}, timeoutMs = 60_000) =>
    new Promise<any>((res, rej) => {
      const i = ++id
      const t = setTimeout(() => {
        pending.delete(i)
        rej(new Error(`${method} timed out`))
      }, timeoutMs)
      pending.set(i, m => {
        clearTimeout(t)
        m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expression: string, timeoutMs = 120_000) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 900))
    return r.result.value
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  const settings = { graphics: { preset: o.preset, resolution: 1, firstRun: false } }
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('sro.settings', ${JSON.stringify(JSON.stringify(settings))}) } catch (e) {}` })
  await send('Page.navigate', { url: `http://localhost:${PAGE_PORT}/?charbench=1&skip=1&mute=1${o.webgl ? '&engine=webgl' : ''}${QUERY ? '&' + QUERY : ''}` })
  return {
    pid: chrome.pid,
    logs,
    send,
    ev,
    async shot(file: string) {
      const r = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(file, Buffer.from(r.data, 'base64'))
    },
    async enterWorld() {
      for (let i = 0; i < 600; i++) {
        const inWorld = await ev(`!!(window.__sroCharBench && window.__sroCharBench.status().inWorld)`).catch(() => false)
        if (inWorld) return
        // (Keep: the creator's one-time offer to a character made without a look, §16.10)
        if (i % 6 === 0) await ev(`(() => { const leaf = (t) => [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === t && e.offsetParent); const b = leaf('Keep') ?? leaf('Start'); if (b) (b.closest('button,.kit-btn,[role=button]') ?? b).click(); return !!b })()`).catch(() => false)
        await sleep(500)
      }
      throw new Error('never entered the world:\n' + logs.slice(-30).join('\n'))
    },
    async close() {
      try {
        await send('Browser.close', {}, 5000)
      } catch {}
      try {
        ws.close()
      } catch {}
      await sleep(1000)
      try {
        chrome.kill()
      } catch {}
      await sleep(500)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

/** The pilot's portraits: every other character hidden, each look in front and 3/4 (docs/CHARACTERS.md §15). */
async function pilotShots(page: { ev(e: string, t?: number): Promise<any>; shot(f: string): Promise<void> }): Promise<void> {
  mkdirSync(PILOT_SHOTS, { recursive: true })
  await page.ev('__sroCharBench.knobs({ hideOthers: true })')
  const looks: [string, string][] = [['avg', '?newchar=average'], ['slim', '?newchar=slim'], ['curvy', '?newchar=curvy']]
  const az = Number(opt('pilot-alpha', String(-Math.PI / 2)))
  const orbit = (a: number, beta = 1.55, radius = 2.9) => page.ev('(__sroCharBench.orbit(' + a + ', ' + beta + ', ' + radius + '), new Promise(r => setTimeout(r, 1500)))')
  // §15.3 check ladder, rung 2: the bind pose through the game's loader (front + side), no clip playing
  await page.ev('__sroPilot.apply("?newchar=average")')
  // rung 4: the clip the world plays by itself (idle), before any debug hold
  await orbit(az + 0.75)
  await page.shot(join(PILOT_SHOTS, 'pilot-live-34.png'))
  if (await page.ev('__sroPilot.pose ? __sroPilot.pose(null) : false', 30_000)) {
    for (const [view, da] of [['front', 0], ['side', Math.PI / 2]] as const) {
      await orbit(az + da, 1.6, 3.8)
      await page.shot(join(PILOT_SHOTS, 'pilot-bind-' + view + '.png'))
    }
    // action poses (average): run, the sword attack, sit
    for (const [name, clip, frac, beta] of [['run', 'RUN', 0.25, 1.55], ['attack', 'ATTACK1_sword_base_01', 0.35, 1.55], ['sit', 'SIT', 0.3, 1.3]] as const) {
      const ok = await page.ev('__sroPilot.pose(' + JSON.stringify(clip) + ', ' + frac + ')', 30_000)
      if (!ok) log(`pilot pose ${clip}: clip not found`)
      await orbit(az + 0.75, beta, name === 'sit' ? 4.6 : 2.9)
      await page.shot(join(PILOT_SHOTS, 'pilot-pose-' + name + '.png'))
    }
    await page.ev('__sroPilot.pose("STAND1", 0)')
  }
  for (const [name, q] of looks) {
    await page.ev('__sroPilot.apply(' + JSON.stringify(q) + ')')
    for (const [view, da] of [['front', 0], ['34', 0.75]] as const) {
      await orbit(az + da, 1.6, 3.8)
      await page.shot(join(PILOT_SHOTS, 'pilot-' + name + '-' + view + '.png'))
    }
  }
}

/** The licensed body's look check (docs/CHARACTERS.md §16): every other character hidden; live idle front + 3/4, then held poses. */
async function licensedShots(page: { ev(e: string, t?: number): Promise<any>; shot(f: string): Promise<void> }): Promise<void> {
  mkdirSync(LICENSED_SHOTS, { recursive: true })
  await page.ev('__sroCharBench.knobs({ hideOthers: true })')
  const info = await page.ev('JSON.stringify(globalThis.__sroLicensed ? __sroLicensed.info() : null)')
  log('licensed: ' + info)
  const az = Number(opt('pilot-alpha', String(-Math.PI / 2)))
  const orbit = (a: number, beta = 1.55, radius = 2.9) => page.ev('(__sroCharBench.orbit(' + a + ', ' + beta + ', ' + radius + '), new Promise(r => setTimeout(r, 1500)))')
  for (const [view, da] of [['front', 0], ['34', 0.75]] as const) {
    await orbit(az + da, 1.6, 3.6)
    await page.shot(join(LICENSED_SHOTS, 'live-' + view + '.png'))
  }
  if (!info || info === 'null') return
  for (const [name, clip, frac, beta] of [['idle', 'STAND1', 0.3, 1.55], ['run', 'RUN', 0.25, 1.55], ['attack', 'ATTACK1_sword_base_01', 0.55, 1.55], ['sit', 'SIT', 0.6, 1.3]] as const) {
    const ok = await page.ev('__sroLicensed.pose(' + JSON.stringify(clip) + ', ' + frac + ')', 30_000)
    if (!ok) log(`licensed pose ${clip}: clip not found`)
    await orbit(az + (name === 'attack' ? -1.1 : 0.75), beta, name === 'sit' ? 4.2 : 3.2)
    await page.shot(join(LICENSED_SHOTS, 'pose-' + name + '.png'))
  }
}

async function materialShots(page: { ev(e: string, t?: number): Promise<any>; shot(f: string): Promise<void> }): Promise<void> {
  mkdirSync(MATERIAL_SHOTS, { recursive: true })
  const az = Number(opt('pilot-alpha', String(-Math.PI / 2)))
  const wait = (ms: number) => page.ev('new Promise(r => setTimeout(r, ' + ms + '))', ms + 10_000)
  const lic = await page.ev('!!globalThis.__sroLicensed')
  const head = lic ? 'head' : 'Bip01 Head', chest = lic ? 'spine_03' : 'Bip01 Spine1'
  await page.ev('__sroCharBench.knobs({ hideOthers: true })')
  for (const [name, joint, da, beta, radius] of [['face-front', head, 0, 1.52, 0.55], ['face-34', head, 0.65, 1.5, 0.6], ['body-front', chest, 0, 1.55, 2.3], ['body-34', chest, 0.75, 1.5, 2.3], ['eye', lic ? 'riverspirit_eye_l' : head, 0.35, 1.5, 0.2]] as const) {
    const ok = await page.ev('__sroCharBench.focus(' + JSON.stringify(joint) + ', ' + (az + da) + ', ' + beta + ', ' + radius + ')')
    if (!ok) log('material shot ' + name + ': no joint ' + joint)
    await wait(1500)
    await page.shot(join(MATERIAL_SHOTS, name + '.png'))
  }
  await page.ev('__sroCharBench.focus(null)')
  if (!flag('wide')) return
  await page.ev('__sroCharBench.knobs({ hideOthers: false })')
  for (const [name, time, place] of [['plaza-day', '12:00', ''], ['plaza-dusk', '18:40', ''], ['plaza-night', '22:30', ''], ['fields-day', '12:00', 'grassland'], ['fields-dusk', '18:40', 'grassland']] as const) {
    if (place) await page.ev('__sroCharBench.gm("tp", ' + JSON.stringify(place) + ')')
    await page.ev('__sroCharBench.gm("time", ' + JSON.stringify(time) + ')')
    await wait(place ? 14000 : 5000)
    await page.ev('__sroCharBench.view("mid")')
    await page.ev('__sroCharBench.orbit(' + (az + 0.6) + ', 1.25, 9)')
    await wait(2500)
    await page.shot(join(MATERIAL_SHOTS, name + '.png'))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

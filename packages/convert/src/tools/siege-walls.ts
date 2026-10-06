/**
 * `pnpm sro siege-walls [plan | cut | nav | all] [--world jangan-fields] [--replan] [--no-blender] [--no-opt]`
 * (docs/SIEGE.md §3, layer 0). Re-runnable; every step reads the world export and writes only its own files:
 *
 * - **plan**: content/siege/jangan.json, the 33 segments (./../world/siege/plan.ts), measured on the export. Written when
 *   missing or with --replan (it is committed: a re-plan moves every segment end).
 * - **cut**: Blender 5.2 headless (packages/convert/tools/blender/siege_cut_walls.py) cuts the four retail wall glbs
 *   into the plan's pieces -> <world>/siege/models/cj_<side>_cut.glb (never committed: retail meshes), then restores
 *   the retail material names Blender suffixed (CJ_w_roof.001) and checks every piece: union bounds per segment equal
 *   the retail model's over that span (±0.3 m), a third has at most 1,500 triangles, every primitive has UV1.
 *   Skipped (the client then keeps drawing the retail walls) with --no-blender or without Blender.
 * - **nav**: <world>/siege/walls.json and walls-nav.bin (../world/siege/walls.ts): the nav split, the breach tiles, the
 *   probes and the retail-equality sweep; stops with an error when a probe or the sweep fails. The per-third report
 *   (and the cut's job and report) go to work/cache/world/<world>/siege/, not into the shipped export.
 * - **all** (default): plan (if missing), cut, nav; then the new files go through the optimizer into work/out-opt
 *   (optimize/files.ts, as a World Editor publish does), unless --no-opt or there is no out-opt.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { decodeNavData, encodeNavData } from '@sro/nav'
import { blenderPath, runBlender } from '../blender.ts'
import { REPO_ROOT, type SroConfig } from '../node-io.ts'
import { gltfIO } from '../optimize/io.ts'
import { optimizeFiles } from '../optimize/files.ts'
import { checkPlan, planThirds, planWalls, type SiegePlan } from '../world/siege/plan.ts'
import { buildWalls } from '../world/siege/walls.ts'
import type { WallSide } from '../../../shared/src/siege.ts'

export const SIEGE_PLAN_FILE = join(REPO_ROOT, 'content', 'siege', 'jangan.json')
const CUT_SCRIPT = join(REPO_ROOT, 'packages', 'convert', 'tools', 'blender', 'siege_cut_walls.py')
const SIDES: readonly WallSide[] = ['N', 'S', 'W', 'E']
/** A third's cut mesh budget (docs/SIEGE.md §3.1). */
const THIRD_MAX_TRIANGLES = 1500
/** Union of a segment's thirds vs the retail model over the same span (m). */
const BOUNDS_TOLERANCE_M = 0.3

interface Manifest {
  space: { originRegion: { x: number; z: number } }
  placements: { source: string; position: number[]; region: number; uid: number; models: number[] }[]
  models: { index: number; glb: string | null; sidecar: string | null }[]
  nav?: { file?: string }
  stream?: { playable?: { x0: number; x1: number; z0: number; z1: number } }
}

const flagValue = (args: string[], name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

export async function siegeWallsCli(args: string[], cfg: SroConfig): Promise<number> {
  const step = args[0] && !args[0].startsWith('--') ? args[0] : 'all'
  if (!['plan', 'cut', 'nav', 'all'].includes(step)) {
    console.log('usage: pnpm sro siege-walls [plan | cut | nav | all] [--world jangan-fields] [--replan] [--no-blender] [--no-opt]')
    return 1
  }
  const world = flagValue(args, '--world') ?? 'jangan-fields'
  const outDir = join(cfg.workDir, 'out')
  const base = join(outDir, 'world', world)
  const manifestFile = join(base, 'manifest.json')
  if (!existsSync(manifestFile)) {
    console.error(`siege-walls: ${manifestFile} is missing (run convert-region --preset ${world} first)`)
    return 1
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest
  const navFile = join(base, manifest.nav?.file ?? 'nav.bin')
  console.log(`siege-walls: reading ${relative(REPO_ROOT, navFile)}…`)
  const nav = decodeNavData(new Uint8Array(readFileSync(navFile)))
  const log = (s: string) => console.log(s)

  // ---- plan ----
  let plan: SiegePlan
  if (step === 'plan' || args.includes('--replan') || !existsSync(SIEGE_PLAN_FILE)) {
    const meshes = await readWallMeshes(base, manifest)
    plan = planWalls({
      world,
      placements: manifest.placements,
      nav,
      originRegion: manifest.space.originRegion,
      meshes: side => meshes.get(side) ?? [],
    })
    const problems = checkPlan(plan)
    if (problems.length) {
      console.error(`siege-walls: the plan is bad: ${problems.join('; ')}`)
      return 1
    }
    mkdirSync(dirname(SIEGE_PLAN_FILE), { recursive: true })
    writeFileSync(SIEGE_PLAN_FILE, `${JSON.stringify(plan, null, 2)}\n`)
    log(`plan: ${relative(REPO_ROOT, SIEGE_PLAN_FILE)} (texture repeat ${SIDES.map(s => `${s} ${plan.texture[s]?.repeatM ?? '?'}`).join(', ')} m)`)
    for (const s of plan.sides) log(`  ${s.side}: run ${s.run[0]}..${s.run[1]}${s.gate ? `, gate ${s.gate[0]}..${s.gate[1]}` : ''}, ${s.segments.map(g => `${g.id} ${(g.to - g.from).toFixed(1)}`).join(', ')}`)
    if (step === 'plan') return 0
  } else {
    plan = JSON.parse(readFileSync(SIEGE_PLAN_FILE, 'utf8')) as SiegePlan
    const problems = checkPlan(plan)
    if (problems.length) {
      console.error(`siege-walls: ${relative(REPO_ROOT, SIEGE_PLAN_FILE)}: ${problems.join('; ')}`)
      return 1
    }
  }
  const planText = readFileSync(SIEGE_PLAN_FILE, 'utf8')
  const planRef = { file: 'content/siege/jangan.json', hash: createHash('sha1').update(planText.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12) }

  const siegeDir = join(base, 'siege')
  mkdirSync(siegeDir, { recursive: true })
  // the step's diagnostics (the Blender job and report, the per-third report) stay out of the shipped export
  const cacheDir = join(cfg.workDir, 'cache', 'world', world, 'siege')
  mkdirSync(cacheDir, { recursive: true })
  const written: string[] = []

  // ---- cut ----
  const models: Partial<Record<WallSide, { glb: string; sidecar: string }>> = {}
  const cutGlb = (side: WallSide) => join(siegeDir, 'models', `cj_${side.toLowerCase()}_cut.glb`)
  const wantCut = (step === 'cut' || step === 'all') && !args.includes('--no-blender')
  if (wantCut && !existsSync(blenderPath(cfg))) log(`cut: Blender not found at ${blenderPath(cfg)} (set blenderExe in sro.config.json); skipped`)
  else if (wantCut) {
    const ok = await cutWalls(plan, base, manifest, siegeDir, cacheDir, cfg, log)
    if (!ok) return 1
    for (const s of SIDES) written.push(relative(outDir, cutGlb(s)).split('\\').join('/'))
  }
  for (const s of SIDES) {
    if (!existsSync(cutGlb(s))) continue
    const p = manifest.placements.find(q => q.source === plan.sides.find(x => x.side === s)?.source)
    const model = p ? manifest.models[p.models[0]!] : undefined
    models[s] = { glb: `siege/models/cj_${s.toLowerCase()}_cut.glb`, sidecar: model?.sidecar ?? '' }
  }
  if (step === 'cut') return 0

  // ---- nav ----
  const t0 = performance.now()
  const res = buildWalls({ plan, planRef, placements: manifest.placements, originRegion: manifest.space.originRegion, playable: manifest.stream?.playable ?? null, nav, models })
  for (const line of res.report) log(`  ${line}`)
  writeFileSync(join(cacheDir, 'walls-report.txt'), [...res.report, ...res.errors.map(e => `ERROR ${e}`)].join('\n') + '\n')
  log(`nav: ${res.walls.segments.length} segments, ${res.pieces.instances.length} nav pieces in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  if (res.errors.length) {
    console.error(`siege-walls: ${res.errors.length} problem(s), nothing written:\n  ${res.errors.join('\n  ')}`)
    return 1
  }
  const navBytes = encodeNavData(res.pieces)
  writeFileSync(join(siegeDir, 'walls-nav.bin'), navBytes)
  writeFileSync(join(siegeDir, 'walls.json'), `${JSON.stringify(res.walls)}\n`)
  written.push(`world/${world}/siege/walls.json`, `world/${world}/siege/walls-nav.bin`)
  log(`nav: siege/walls.json (${readFileSync(join(siegeDir, 'walls.json')).byteLength} bytes), siege/walls-nav.bin (${navBytes.byteLength} bytes)`)

  // ---- out-opt ----
  const optDir = join(cfg.workDir, 'out-opt')
  if (!args.includes('--no-opt') && existsSync(join(optDir, 'world', world))) {
    const files = [...new Set(written)].filter(f => existsSync(join(outDir, ...f.split('/'))))
    const r = await optimizeFiles({ inDir: outDir, outDir: optDir, files, precompress: true, log })
    log(`out-opt: ${r.written.length} file(s) written`)
  }
  return 0
}

type WallMesh = { name: string; positions: Float32Array; uvs: Float32Array | null; indices: Uint32Array | Uint16Array | null }

/** The retail glb's mesh nodes (positions, TEXCOORD_0, indices; model frame) of every side, for the planner. */
async function readWallMeshes(base: string, manifest: Manifest): Promise<Map<WallSide, WallMesh[]>> {
  const io = await gltfIO()
  const out = new Map<WallSide, WallMesh[]>()
  for (const side of SIDES) {
    const doc = await io.read(wallGlb(base, manifest, side))
    const list: WallMesh[] = []
    for (const node of doc.getRoot().listNodes()) {
      const mesh = node.getMesh()
      if (!mesh) continue
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION')
        if (!pos) continue
        const uv = prim.getAttribute('TEXCOORD_0')
        const idx = prim.getIndices()
        const positions = new Float32Array(pos.getCount() * 3)
        for (let i = 0; i < pos.getCount(); i++) positions.set(pos.getElement(i, [0, 0, 0]), i * 3)
        let uvs: Float32Array | null = null
        if (uv) {
          uvs = new Float32Array(uv.getCount() * 2)
          for (let i = 0; i < uv.getCount(); i++) uvs.set(uv.getElement(i, [0, 0]), i * 2)
        }
        let indices: Uint32Array | null = null
        if (idx) {
          indices = new Uint32Array(idx.getCount())
          for (let i = 0; i < idx.getCount(); i++) indices[i] = idx.getScalar(i)
        }
        list.push({ name: node.getName(), positions, uvs, indices })
      }
    }
    out.set(side, list)
  }
  return out
}

function wallGlb(base: string, manifest: Manifest, side: WallSide): string {
  const re = new RegExp(`\\\\jangan_enter\\\\cj_${side.toLowerCase()}\\.bsr$`, 'i')
  const p = manifest.placements.find(q => re.test(q.source))
  const m = p ? manifest.models[p.models[0]!] : undefined
  if (!m?.glb) throw new Error(`siege-walls: no glb for the ${side} wall`)
  return join(base, ...m.glb.split('/'))
}

/** The Blender cut and its checks (see the header). */
async function cutWalls(plan: SiegePlan, base: string, manifest: Manifest, siegeDir: string, cacheDir: string, cfg: SroConfig, log: (s: string) => void): Promise<boolean> {
  const jobFile = join(cacheDir, 'cut-job.json')
  const reportFile = join(cacheDir, 'cut-report.json')
  const sides = plan.sides.map(ps => {
    const p = manifest.placements.find(q => q.source === ps.source)!
    const off = ps.axis === 'x' ? p.position[0]! : p.position[2]!
    // the pieces in the model's own frame: fixed spans and thirds, ends open
    const spans: { id: string; from: number; to: number }[] = []
    let last = -1e6
    ps.segments.forEach((s, k) => {
      if (s.from > last + 1e-6) spans.push({ id: `${ps.side}-${k === 0 ? 'end0' : 'gate'}`, from: last, to: s.from })
      planThirds(s).forEach(([a, b], t) => spans.push({ id: `${s.id}${'abc'[t]}`, from: a, to: b }))
      last = s.to
    })
    spans.push({ id: `${ps.side}-end1`, from: last, to: 1e6 })
    return {
      side: ps.side,
      glb: wallGlb(base, manifest, ps.side),
      axis: ps.axis,
      pieces: spans.map(s => ({ id: s.id, from: Math.abs(s.from) >= 1e6 ? s.from : s.from - off, to: Math.abs(s.to) >= 1e6 ? s.to : s.to - off })),
      out: join(siegeDir, 'models', `cj_${ps.side.toLowerCase()}_cut.glb`),
    }
  })
  writeFileSync(jobFile, JSON.stringify({ sides, report: reportFile }, null, 1))
  log(`cut: Blender ${blenderPath(cfg)} …`)
  const res = await runBlender(cfg, { script: CUT_SCRIPT, args: [jobFile], timeoutMs: 10 * 60_000, onLine: l => { if (/^siege cut|Error|Traceback/.test(l)) log(`  ${l}`) } })
  log(`cut: done in ${(res.ms / 1000).toFixed(1)} s`)
  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { sides: { side: WallSide; pieces: { id: string; triangles: number; min: number[] | null; max: number[] | null }[] }[] }

  // post: retail material names back, then the checks
  const io = await gltfIO()
  const problems: string[] = []
  for (const s of sides) {
    const doc = await io.read(s.out)
    for (const m of doc.getRoot().listMaterials()) m.setName(m.getName().replace(/\.\d{3}$/, ''))
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) if (!prim.getAttribute('TEXCOORD_1')) problems.push(`${s.side}: mesh ${mesh.getName()} lost its lightmap UV1`)
    }
    await io.write(s.out, doc)
    const retail = await io.read(s.glb)
    const ps = plan.sides.find(p => p.side === s.side)!
    const r = report.sides.find(x => x.side === s.side)!
    const byId = new Map(r.pieces.map(p => [p.id, p]))
    const off = s.axis === 'x' ? 0 : 2
    const placement = manifest.placements.find(q => q.source === ps.source)!
    const shift = s.axis === 'x' ? placement.position[0]! : placement.position[2]!
    for (const seg of ps.segments) {
      let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity, clo = Infinity, chi = -Infinity
      for (const k of ['a', 'b', 'c']) {
        const piece = byId.get(`${seg.id}${k}`)
        if (!piece?.min || !piece.max) {
          problems.push(`${seg.id}${k}: empty piece`)
          continue
        }
        if (piece.triangles > THIRD_MAX_TRIANGLES) problems.push(`${seg.id}${k}: ${piece.triangles} triangles (> ${THIRD_MAX_TRIANGLES})`)
        lo = Math.min(lo, piece.min[off]!); hi = Math.max(hi, piece.max[off]!)
        ylo = Math.min(ylo, piece.min[1]!); yhi = Math.max(yhi, piece.max[1]!)
        clo = Math.min(clo, piece.min[2 - off]!); chi = Math.max(chi, piece.max[2 - off]!)
      }
      const want = retailBounds(retail, off, seg.from - shift, seg.to - shift)
      const got = [lo, hi, ylo, yhi, clo, chi]
      const bad = want.some((w, i) => Math.abs(w - got[i]!) > BOUNDS_TOLERANCE_M)
      if (bad) problems.push(`${seg.id}: cut bounds ${got.map(v => v.toFixed(2)).join(',')} vs retail ${want.map(v => v.toFixed(2)).join(',')}`)
    }
    const tris = r.pieces.filter(p => !p.id.includes('-')).map(p => p.triangles)
    log(`cut ${s.side}: ${r.pieces.length} pieces, thirds ${Math.min(...tris)}..${Math.max(...tris)} triangles, ${readFileSync(s.out).byteLength} bytes`)
  }
  if (problems.length) {
    console.error(`siege-walls: the cut has ${problems.length} problem(s):\n  ${problems.slice(0, 30).join('\n  ')}`)
    return false
  }
  return true
}

/** The retail model's bounds over [a, b] along axis `off` (model frame): [along lo, hi, y lo, hi, across lo, hi]. */
function retailBounds(doc: Awaited<ReturnType<Awaited<ReturnType<typeof gltfIO>>['read']>>, off: number, a: number, b: number): number[] {
  // the exact clip of each triangle to the slab, so the bounds match the cut (vertices of clipped triangles included)
  let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity, clo = Infinity, chi = -Infinity
  const c = 2 - off
  const take = (p: number[]) => {
    lo = Math.min(lo, p[off]!); hi = Math.max(hi, p[off]!)
    ylo = Math.min(ylo, p[1]!); yhi = Math.max(yhi, p[1]!)
    clo = Math.min(clo, p[c]!); chi = Math.max(chi, p[c]!)
  }
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')!
      const idx = prim.getIndices()
      const n = idx ? idx.getCount() : pos.getCount()
      for (let t = 0; t + 2 < n; t += 3) {
        let poly = [0, 1, 2].map(k => pos.getElement(idx ? idx.getScalar(t + k) : t + k, [0, 0, 0]))
        for (const [at, sign] of [[a, 1], [b, -1]] as const) {
          const res: number[][] = []
          for (let i = 0; i < poly.length; i++) {
            const p = poly[i]!, q = poly[(i + 1) % poly.length]!
            const dp = sign * (p[off]! - at), dq = sign * (q[off]! - at)
            if (dp >= 0) res.push(p)
            if ((dp >= 0) !== (dq >= 0)) {
              const u = dp / (dp - dq)
              res.push([0, 1, 2].map(k => p[k]! + (q[k]! - p[k]!) * u))
            }
          }
          poly = res
        }
        if (poly.length >= 3) for (const p of poly) take(p)
      }
    }
  }
  return [lo, hi, ylo, yhi, clo, chi]
}

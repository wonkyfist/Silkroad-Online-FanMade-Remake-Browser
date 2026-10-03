/**
 * The town clips (docs/TOWN_LIFE.md §3.1, WAVE_PLAN7 §6.1 lane TL-A2): SIT_CHAIR, CARRY, TALK and SWEEP for the
 * townsfolk, keyed in Blender on the retail Chinese skeletons with the jump's MV-A pipeline (docs/MOVEMENT.md §3.2):
 *
 *   pnpm sro moves --town [--skel europeman_skel,europewoman_skel] [--no-key] [--out <out root>] [--work <dir>]
 *                         [--render <frames dir>]
 *
 * 1. Keys content/moves/<skel>/town/*.json in Blender 5.2, headless (../blender.ts `runBlender`), with
 *    packages/convert/tools/blender/town/key_town.py. Out, per skeleton, in <work>/<skel>/town/ (default
 *    work/out/moves/; never committed, town.blend holds the retail mesh): town.blend, town_blender.glb and
 *    town_keys.json. `--no-key` re-packs the last keyer output; `--render` also renders the clip GIFs' frames.
 * 2. Re-expresses Blender's export on the retail skeleton (export-moves.ts `retarget` / `reexpressClip`).
 * 3. Writes, next to the keyer's output (the clips are baked into the town's VAT by TL-V, never shipped as a pack):
 *      town_clips.glb    the skeleton's joints (the movement pack's format) and the clips <prefix>_<clip>
 *      town_clips.json   TownClipsIndex: per kind the animation, frames, duration, the base clip, the seat (SIT_CHAIR)
 *                        and the socket (CARRY's crate, SWEEP's broom: the prop's offset in the hand joint's frame)
 *      roundtrip.json    every check below with its numbers
 *
 * The MV-A checks (WAVE_PLAN7 §6.1 row TL-A2); any failure makes the verb exit 1:
 *  - control: the retail STAND1 through the same Blender import/export, re-expressed, within 0.1° and 1e-5 m;
 *  - the pack clip puts every joint within 0.1 mm of Blender's own result;
 *  - contacts: on a "fixed" clip each foot (the lower of its toe joint and the virtual heel) within 1 mm of the
 *    idle's ground on every frame, and no foot moves more than 1 mm between frames; on a layer ("base", CARRY on
 *    WALK) the feet within 1 mm of the base clip's own feet at the same time;
 *  - loops close: the last frame is the first (every joint within 0.1 mm and 0.1°), the seam is as smooth as the
 *    rest of the clip (the joints' acceleration across it ≤ 1.5 × the largest inside + 1 mm/frame², their turn per
 *    frame ≤ 1.5 × the largest inside + 1°), and a layer is exactly as long as its base cycle;
 *  - no flips: no joint turns more than 25° between two frames;
 *  - no root travel on a "fixed" clip: Bip01's XZ excursion ≤ 1 cm.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runBlender } from '../blender.ts'
import { REPO_ROOT, type SroConfig } from '../node-io.ts'
import { gltfIO } from '../optimize/io.ts'
import {
  buildMovementPack, channelsOf, compose, controlCheck, feetDistance, findAnimation, FPS, globalsAt, groundOf, invert,
  jointIndex, keyTimes, LIMITS, measureFrame, MOVE_SKELETONS, mul, packVsExport, quatAngleDeg, reexpressClip,
  retarget, rigOf, rotationOf, runFeetAt, translationOf, type Ground, type Mat4, type MoveSkeleton, type Quat,
  type Rig, type Vec3,
} from './export-moves.ts'

export const TOWN_KINDS = ['SIT_CHAIR', 'CARRY', 'TALK', 'SWEEP'] as const
export type TownKind = typeof TOWN_KINDS[number]

/** WAVE_PLAN7 §6.1 row TL-A2 (the MV-A thresholds) plus the town clips' own: a loop and no root travel. */
export const TOWN_LIMITS = {
  controlDeg: LIMITS.controlDeg,
  controlM: LIMITS.controlM,
  packVsExportM: LIMITS.packVsExportM,
  contactM: 0.001,
  slideM: 0.001,
  baseFeetM: 0.001,
  loopM: 1e-4,
  loopDeg: 0.1,
  seamAccelRatio: 1.5,
  seamAccelSlackM: 0.001,
  rootExcursionM: 0.01,
  /** No joint turns more than this between two frames (a solver flip is tens of degrees; SWEEP's fast stroke ~16°). */
  turnDeg: 25,
  seamTurnSlackDeg: 1,
  /** The keyer's reach solver: a hand within this of its target (a look metric; the woman's shorter arms, §report). */
  reachM: 0.025,
} as const

const SIDES = ['L', 'R'] as const
type Side = typeof SIDES[number]

// ------------------------------------------------------------------------------------------------ the keyer's output

interface TownRow {
  f: number
  contact: Record<Side, number>
  reachErrM?: Partial<Record<Side, number>>
}

export interface TownKeyedClip {
  action: string
  kind: TownKind
  frames: number
  durationMs: number
  fps: number
  loop: boolean
  base: string
  lock: 'fixed' | 'base'
  baseAction?: string
  seat?: { hipZ: number, hipFwd: number, seatZ?: number }
  socket?: TownSocketSpec & { floorM?: number, frame0: { origin: Vec3, rotation: Quat } }
  rows: TownRow[]
}

export interface TownSocketSpec {
  bone: string
  prop: string
  origin: { from: string, at: number[] }
  axis?: [string, string]
  steady?: string
}

export interface TownKeyerOutput {
  prefix: string
  fps: number
  controlAction: string
  sourceGlb: string
  toe0Z: number
  clips: Record<string, TownKeyedClip>
}

/** A town key file (content/moves/<skel>/town/<clip>.json): what the checks read. */
export interface TownSpec {
  clip: string
  kind: TownKind
  fps: number
  lastFrame: number
  loop: boolean
  base: 'STAND1' | 'WALK'
  lock: 'fixed' | 'base'
  seat?: boolean
  socket?: TownSocketSpec
  keys: { f: number, pose: string, arms: Record<Side, unknown>, legs?: Record<Side, number[]> }[]
}

export const townKeysDir = (skel: string) => join(REPO_ROOT, 'content', 'moves', skel, 'town')

export function readTownSpecs(skel: string): TownSpec[] {
  const dir = townKeysDir(skel)
  return readdirSync(dir).filter(f => f.endsWith('.json')).sort()
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as TownSpec)
}

// ------------------------------------------------------------------------------------------------ the index

/** <work>/<skel>/town/town_clips.json: what TL-V's VAT bake and TL-C's crowd read. */
export interface TownClipsIndex {
  format: 'sro-town-clips'
  version: 1
  skeleton: string
  /** The pack, next to this index. */
  pack: string
  fps: number
  clips: Partial<Record<TownKind, TownClipIndex>>
}

export interface TownClipIndex {
  anim: string
  frames: number
  durationMs: number
  loop: true
  /** STAND1 (a pose of its own) or the retail clip it is layered on (CARRY: WALK, the same cycle and contacts). */
  base: string
  /** SIT_CHAIR: the hip joints' and the seat's height above the ground (m), and the hips' forward offset. */
  seat?: { hipZ: number, hipFwd: number, seatZ?: number }
  /**
   * A prop on a joint: prop world = joint world (t) · T(offset) · R(rotation), so on frame 0 it sits where the keyer
   * put it (the crate on the shoulder; the broom along the hands, its grip at the origin, its floor end floorM down
   * the prop's −Y). The prop's +Y is its up (the broom's handle), +Z the character's forward on frame 0.
   */
  socket?: { bone: string, prop: string, offset: Vec3, rotation: Quat, floorM?: number }
}

// ------------------------------------------------------------------------------------------------ the checks

export interface TownClipCheck {
  anim: string
  kind: TownKind
  frames: number
  durationMs: number
  /** Largest |contact| of either foot over the clip ("fixed"), metres. */
  maxContactM: number | null
  /** Largest per-frame horizontal move of either toe ("fixed"). */
  maxSlideM: number | null
  /** Largest feet distance to the base clip at the same time (a layer). */
  maxBaseFeetM: number | null
  baseCycleFrames: number | null
  loopM: number
  loopDeg: number
  seamAccelM: number
  maxInnerAccelM: number
  /** The largest joint turn between consecutive frames across the seam, and inside the clip (degrees). */
  seamTurnDeg: number
  maxTurnDeg: number
  rootExcursionM: number
  maxVsExportM: number
  maxReachErrM: number
}

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]
const len = (a: readonly number[]) => Math.hypot(a[0]!, a[1]!, a[2]!)

/** The joints' world positions per key of a pack clip. */
function positions(pack: Rig, anim: ReturnType<typeof findAnimation>, joints: number[]): { times: number[], g: Mat4[][] } {
  const ch = channelsOf(pack, anim)
  const times = keyTimes(anim)
  return { times, g: times.map(t => globalsAt(pack, ch, t)).map(gs => joints.map(j => gs[j]!)) }
}

export function checkTownClip(
  orig: Rig,
  pack: Rig,
  anim: ReturnType<typeof findAnimation>,
  ground: Ground,
  keyed: TownKeyedClip,
  joints: readonly string[],
): Omit<TownClipCheck, 'maxVsExportM'> {
  const ch = channelsOf(pack, anim)
  const times = keyTimes(anim)
  const m = times.map(t => measureFrame(pack, globalsAt(pack, ch, t), ground))
  let maxContact: number | null = null
  let maxSlide: number | null = null
  let maxBase: number | null = null
  let baseCycleFrames: number | null = null
  if (keyed.lock === 'fixed') {
    maxContact = Math.max(...m.flatMap(x => SIDES.map(s => Math.abs(x.contact[s]))))
    maxSlide = 0
    for (let f = 1; f < m.length; f++) {
      for (const s of SIDES) {
        const a = m[f - 1]!.feet[`${s}Toe0`]
        const b = m[f]!.feet[`${s}Toe0`]
        maxSlide = Math.max(maxSlide, Math.hypot(b[0] - a[0], b[2] - a[2]))
      }
    }
  } else {
    const base = keyed.baseAction!
    const cycle = Math.max(...findAnimation(orig.doc, base).listSamplers().map(s => s.getInput()!.getMax([])[0] ?? 0))
    baseCycleFrames = Math.round(cycle * FPS)
    // the loop frame is frame 0 (the retail cycle's own end may sit a few mm off its start)
    maxBase = Math.max(...times.map((t, f) => feetDistance(m[f]!.feet, runFeetAt(orig, base, f === times.length - 1 ? 0 : t, ground))))
  }
  const idx = joints.map(n => jointIndex(pack, n))
  const { g } = positions(pack, anim, idx)
  const p = g.map(fr => fr.map(translationOf))
  const n = p.length - 1
  let loopM = 0
  let loopDeg = 0
  idx.forEach((_j, k) => {
    loopM = Math.max(loopM, len(sub(p[n]![k]!, p[0]![k]!)))
    loopDeg = Math.max(loopDeg, quatAngleDeg(rotationOf(g[n]![k]!), rotationOf(g[0]![k]!)))
  })
  // acceleration per joint: inside the clip, and across the seam (frame n == frame 0, so n-1 -> 0 -> 1)
  const accel = (a: Vec3[], b: Vec3[], c: Vec3[]) => Math.max(...a.map((_v, k) => len(sub(sub(c[k]!, b[k]!), sub(b[k]!, a[k]!)))))
  let inner = 0
  for (let f = 1; f < n; f++) inner = Math.max(inner, accel(p[f - 1]!, p[f]!, p[f + 1]!))
  const seam = accel(p[n - 1]!, p[0]!, p[1]!)
  // the largest turn of any joint between two frames (a flip shows as tens of degrees), inside and across the seam
  const turn = (a: Mat4[], b: Mat4[]) => Math.max(...a.map((_m, k) => quatAngleDeg(rotationOf(a[k]!), rotationOf(b[k]!))))
  let innerTurn = 0
  for (let f = 1; f < n; f++) innerTurn = Math.max(innerTurn, turn(g[f - 1]!, g[f]!))
  const seamTurn = Math.max(turn(g[n - 1]!, g[0]!), turn(g[0]!, g[1]!))
  const r0 = m[0]!.root
  const reach = keyed.rows.flatMap(r => Object.values(r.reachErrM ?? {}))
  return {
    anim: anim.getName(),
    kind: keyed.kind,
    frames: times.length,
    durationMs: Math.round(times.at(-1)! * 1000),
    maxContactM: maxContact,
    maxSlideM: maxSlide,
    maxBaseFeetM: maxBase,
    baseCycleFrames,
    loopM,
    loopDeg,
    seamAccelM: seam,
    maxInnerAccelM: inner,
    seamTurnDeg: seamTurn,
    maxTurnDeg: innerTurn,
    rootExcursionM: keyed.lock === 'fixed' ? Math.max(...m.map(x => Math.hypot(x.root[0] - r0[0], x.root[2] - r0[2]))) : 0,
    maxReachErrM: reach.length ? Math.max(...reach) : 0,
  }
}

/** The prop's frame-0 world transform (the keyer's, glTF axes) in the socket joint's own frame on the pack's frame 0. */
export function socketOffset(pack: Rig, anim: ReturnType<typeof findAnimation>, bone: string, origin: Vec3, rotation: Quat): { offset: Vec3, rotation: Quat } {
  const g0 = globalsAt(pack, channelsOf(pack, anim), keyTimes(anim)[0]!)[jointIndex(pack, bone)]!
  const local = mul(invert(g0), compose(origin, rotation))
  const r = (v: number) => Math.round(v * 1e6) / 1e6 + 0
  return { offset: translationOf(local).map(r) as Vec3, rotation: rotationOf(local).map(r) as Quat }
}

export interface TownReport {
  skeleton: string
  prefix: string
  packBytes: number
  control: { samples: number, maxRotDeg: number, maxTransM: number }
  clips: Record<string, TownClipCheck>
  failures: string[]
}

export function townFailures(r: Omit<TownReport, 'failures'>, specs: readonly TownSpec[]): string[] {
  const f: string[] = []
  const L = TOWN_LIMITS
  if (!(r.control.maxRotDeg <= L.controlDeg)) f.push(`control STAND1 ${r.control.maxRotDeg.toFixed(4)}° > ${L.controlDeg}°`)
  if (!(r.control.maxTransM <= L.controlM)) f.push(`control STAND1 ${r.control.maxTransM.toExponential(2)} m > ${L.controlM} m`)
  const kinds = Object.values(r.clips).map(c => c.kind).sort()
  const want = specs.map(s => s.kind).sort()
  if (kinds.join() !== want.join()) f.push(`clips ${kinds.join(', ')} != the key files' ${want.join(', ')}`)
  for (const [clip, c] of Object.entries(r.clips)) {
    const spec = specs.find(s => s.clip === clip)
    if (!(c.maxVsExportM <= L.packVsExportM)) f.push(`${clip}: pack vs export ${c.maxVsExportM.toExponential(2)} m`)
    if (c.maxContactM !== null && !(c.maxContactM <= L.contactM)) f.push(`${clip}: contact ${(c.maxContactM * 1000).toFixed(2)} mm > 1 mm`)
    if (c.maxSlideM !== null && !(c.maxSlideM <= L.slideM)) f.push(`${clip}: slide ${(c.maxSlideM * 1000).toFixed(2)} mm/frame > 1 mm`)
    if (c.maxBaseFeetM !== null && !(c.maxBaseFeetM <= L.baseFeetM)) f.push(`${clip}: feet ${(c.maxBaseFeetM * 1000).toFixed(2)} mm off the base clip > 1 mm`)
    if (c.baseCycleFrames !== null && spec && c.baseCycleFrames !== spec.lastFrame) f.push(`${clip}: ${spec.lastFrame} frames, its base cycle ${c.baseCycleFrames}`)
    if (spec && c.frames !== spec.lastFrame + 1) f.push(`${clip}: ${c.frames} keys, expected ${spec.lastFrame + 1}`)
    if (!(c.loopM <= L.loopM) || !(c.loopDeg <= L.loopDeg)) f.push(`${clip}: the loop does not close (${(c.loopM * 1000).toFixed(3)} mm, ${c.loopDeg.toFixed(3)}°)`)
    if (!(c.seamAccelM <= c.maxInnerAccelM * L.seamAccelRatio + L.seamAccelSlackM)) {
      f.push(`${clip}: seam acceleration ${(c.seamAccelM * 1000).toFixed(2)} mm/frame² > 1.5 × ${(c.maxInnerAccelM * 1000).toFixed(2)} + 1`)
    }
    if (!(Math.max(c.maxTurnDeg, c.seamTurnDeg) <= L.turnDeg)) f.push(`${clip}: a joint turns ${Math.max(c.maxTurnDeg, c.seamTurnDeg).toFixed(1)}° in one frame > ${L.turnDeg}°`)
    if (!(c.seamTurnDeg <= c.maxTurnDeg * L.seamAccelRatio + L.seamTurnSlackDeg)) f.push(`${clip}: seam turn ${c.seamTurnDeg.toFixed(1)}° > 1.5 × ${c.maxTurnDeg.toFixed(1)}° + 1°`)
    if (!(c.rootExcursionM <= L.rootExcursionM)) f.push(`${clip}: root XZ excursion ${c.rootExcursionM.toFixed(4)} m > 1 cm`)
    if (!(c.maxReachErrM <= L.reachM)) f.push(`${clip}: a hand ${(c.maxReachErrM * 100).toFixed(1)} cm off its reach target > 2.5 cm`)
  }
  return f
}

// ------------------------------------------------------------------------------------------------ the export

export interface ExportTownOptions {
  /** The out root holding char/china/*.glb (default work/out). */
  outRoot?: string
  /** The keyer's folder root (default <outRoot>/moves); the clips go to <workRoot>/<skel>/town/. */
  workRoot?: string
  /** false: re-pack the last keyer output instead of running Blender. */
  key?: boolean
  /** Also render the GIF frames into this folder (absolute). */
  renderDir?: string
  cfg?: SroConfig
  log?: (line: string) => void
}

const KEY_SCRIPT = join(REPO_ROOT, 'packages', 'convert', 'tools', 'blender', 'town', 'key_town.py')

export async function exportTownClips(skel: MoveSkeleton, opts: ExportTownOptions = {}): Promise<{ index: TownClipsIndex, report: TownReport }> {
  const log = opts.log ?? (() => {})
  const outRoot = resolve(opts.outRoot ?? join(REPO_ROOT, 'work', 'out'))
  const work = join(resolve(opts.workRoot ?? join(outRoot, 'moves')), skel, 'town')
  const { prefix, char } = MOVE_SKELETONS[skel]
  const charGlb = join(outRoot, ...char.split('/'))
  if (!existsSync(charGlb)) throw new Error(`moves --town: ${charGlb} is missing (run the character conversion first)`)
  const specs = readTownSpecs(skel)
  if (opts.key !== false) {
    mkdirSync(work, { recursive: true })
    log(`${skel}: keying the town clips in Blender…`)
    const res = await runBlender(opts.cfg, {
      script: KEY_SCRIPT,
      args: [charGlb, townKeysDir(skel), work, { value: prefix }, { value: '' }, ...(opts.renderDir ? [{ value: '--render' }, resolve(opts.renderDir)] : [])],
      timeoutMs: 15 * 60_000,
    })
    log(`${skel}: keyed in ${(res.ms / 1000).toFixed(1)} s`)
  }
  const keyer = JSON.parse(readFileSync(join(work, 'town_keys.json'), 'utf8')) as TownKeyerOutput
  if (keyer.prefix !== prefix) throw new Error(`moves --town: ${work} was keyed with prefix ${keyer.prefix}, expected ${prefix}`)

  const io = await gltfIO()
  const origDoc = await io.read(charGlb)
  const expDoc = await io.read(join(work, 'town_blender.glb'))
  const orig = rigOf(origDoc)
  const exp = rigOf(expDoc)
  const joints = origDoc.getRoot().listSkins()[0]!.listJoints().map(j => j.getName())
  const r = retarget(orig, exp, joints)
  const control = controlCheck(orig, exp, r, keyer.controlAction)
  log(`${skel}: control STAND1 ${control.maxRotDeg.toFixed(4)}° ${control.maxTransM.toExponential(2)} m over ${control.samples} samples`)

  const clipNames = Object.keys(keyer.clips).sort()
  const packDoc = buildMovementPack(origDoc, `${skel}/town`, joints, clipNames.map(clip => ({
    anim: keyer.clips[clip]!.action,
    clip: reexpressClip(r, exp, findAnimation(expDoc, keyer.clips[clip]!.action)),
  })))
  const glb = await io.writeBinary(packDoc)
  const pack = rigOf(await io.readBinary(glb))
  const ground = groundOf(orig)
  const index: TownClipsIndex = { format: 'sro-town-clips', version: 1, skeleton: skel, pack: 'town_clips.glb', fps: FPS, clips: {} }
  const report: Omit<TownReport, 'failures'> = { skeleton: skel, prefix, packBytes: glb.byteLength, control, clips: {} }
  for (const clip of clipNames) {
    const k = keyer.clips[clip]!
    const anim = findAnimation(pack.doc, k.action)
    const c: TownClipCheck = { ...checkTownClip(orig, pack, anim, ground, k, joints), maxVsExportM: packVsExport(pack, anim, exp, findAnimation(expDoc, k.action), r) }
    report.clips[clip] = c
    const entry: TownClipIndex = { anim: k.action, frames: c.frames, durationMs: c.durationMs, loop: true, base: k.baseAction ?? k.base }
    if (k.seat) entry.seat = k.seat
    if (k.socket) {
      const s = socketOffset(pack, anim, k.socket.bone, k.socket.frame0.origin, k.socket.frame0.rotation)
      entry.socket = { bone: k.socket.bone, prop: k.socket.prop, ...s, ...(k.socket.floorM !== undefined ? { floorM: k.socket.floorM } : {}) }
    }
    index.clips[k.kind] = entry
    const mm = (v: number | null) => (v === null ? '-' : `${(v * 1000).toFixed(2)} mm`)
    log(`${skel}: ${k.kind} ${c.anim} ${c.frames} fr ${c.durationMs} ms, contact ${mm(c.maxContactM)}, slide ${mm(c.maxSlideM)}, `
      + `base feet ${mm(c.maxBaseFeetM)}, loop ${mm(c.loopM)} ${c.loopDeg.toFixed(3)}°, seam ${mm(c.seamAccelM)} (inside ≤ ${mm(c.maxInnerAccelM)}), `
      + `vs export ${c.maxVsExportM.toExponential(2)} m, reach ${mm(c.maxReachErrM)}`)
  }
  const full: TownReport = { ...report, failures: townFailures(report, specs) }
  const write = (file: string, data: Uint8Array | string) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, data)
  }
  write(join(work, 'town_clips.glb'), glb)
  write(join(work, 'town_clips.json'), `${JSON.stringify(index, null, 1)}\n`)
  write(join(work, 'roundtrip.json'), `${JSON.stringify(full, null, 1)}\n`)
  log(`${skel}: wrote ${join(work, 'town_clips.glb')} (${glb.byteLength} B) and town_clips.json; ${full.failures.length} failed checks`)
  for (const f of full.failures) log(`  FAIL ${f}`)
  return { index, report: full }
}

/** `pnpm sro moves --town …` (export-moves.ts hands the flag over): returns the process exit code. */
export async function townClipsCli(args: readonly string[], cfg: SroConfig): Promise<number> {
  const opt = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const abs = (p: string | undefined) => (p === undefined ? undefined : isAbsolute(p) ? p : resolve(REPO_ROOT, p))
  const skels = (opt('--skel')?.split(',') ?? Object.keys(MOVE_SKELETONS)) as MoveSkeleton[]
  for (const s of skels) {
    if (!(s in MOVE_SKELETONS)) {
      console.error(`moves --town: unknown skeleton ${s}; expected ${Object.keys(MOVE_SKELETONS).join(', ')}`)
      return 1
    }
  }
  let failed = 0
  for (const skel of skels) {
    try {
      const { report } = await exportTownClips(skel, {
        outRoot: abs(opt('--out')),
        workRoot: abs(opt('--work')),
        key: !args.includes('--no-key'),
        renderDir: abs(opt('--render')),
        cfg,
        log: line => console.log(line),
      })
      failed += report.failures.length
    } catch (e) {
      console.error(`moves --town: ${skel}: ${(e as Error).message}`)
      failed++
    }
  }
  return failed ? 1 : 0
}


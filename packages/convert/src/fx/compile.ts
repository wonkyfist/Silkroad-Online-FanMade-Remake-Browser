/**
 * EFP (parsed by @sro/formats parseEfp) -> the "sro-fx-program" JSON the @sro/fx runtime interprets.
 *
 * Node-free. Every spatial value goes through ../gltf/space.ts (the one place file space becomes glTF space):
 * lengths are scaled by UNIT_SCALE and mirrored, matrices are conjugated with the mirror.
 *
 * What is used from the stored effect (the "compiled" half of an EFStoredObject; the controllers are the editor's
 * description and are only kept by the parser): totalFrames, the emitter (StaticEmit), the life command, the
 * link scalars, the view and render commands, the resource and the per-element program. The meaning of each
 * command's flags byte is documented per case below; sources are OpenSRO's notes on the native runtime (read as
 * documentation only) and this client's bytes (packages/convert/test/efp.corpus.test.ts).
 */
import { efpObjects, type EfpCommand, type EfpFile, type EfpObject, type EfpResource, type Mat4 } from '@sro/formats'
import {
  FX_FORMAT,
  FX_FPS,
  FX_VERSION,
  type FxBasis,
  type FxBlend,
  type FxCommand,
  type FxEffect,
  type FxMat3,
  type FxMaterial,
  type FxNode,
  type FxRender,
  type FxSchedule,
  type FxStageOp,
  type FxTable,
  type FxVec3,
  type FxView,
} from '../../../fx/src/program.ts'
import { toGltfMatrix, toGltfPosition, type Vec3 } from '../gltf/space.ts'

export const FX_PROVENANCE = 'Particles.pk2 JMXVEFF via @sro/formats parseEfp; compiled by packages/convert/src/fx/compile.ts'

/** Particles.pk2 path as a key: lower case, forward slashes, no leading slash. */
export function fxKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
}

/** Out-root-relative URL of an exported texture (DDJ -> PNG). */
export function fxTextureUrl(path: string): string {
  return 'fx/tex/' + fxKey(path).replace(/\.[^./]*$/, '') + '.png'
}

/** Out-root-relative URL of an exported effect mesh (BMS -> glb). */
export function fxMeshUrl(path: string): string {
  return 'fx/mesh/' + fxKey(path).replace(/\.[^./]*$/, '') + '.glb'
}

/** Out-root-relative URL of an exported effect program. */
export function fxEffectUrl(key: string): string {
  return 'fx/efp/' + fxKey(key).replace(/\.[^./]*$/, '') + '.json'
}

/**
 * The frames (element ages) a command runs at, from its stored mode byte and three floats, following the native
 * rule as described in OpenSRO's notes on B0C290/B143C0 (read as documentation):
 *   mode bit 0: `start` is a percentage of the lifetime; bit 1: `period` is a percentage;
 *   (mode >> 2) % 5 picks how `end` gives the last frame: 0 absolute, 1 percentage, 2 start + end,
 *   3 start + percentage, 4 start + end * period (none when end < 1).
 * Percentages truncate before multiplying (a 50 % start is frame 0). The last frame is clamped to frames - 1.
 */
export function commandSchedule(cmd: Pick<EfpCommand, 'mode' | 'start' | 'period' | 'end'>, frames: number): FxSchedule {
  const { mode, start, end } = cmd
  if (![start, cmd.period, end].every(Number.isFinite) || frames < 1) return [0, 1, 0]
  const first = mode & 1 ? Math.trunc(start / 100) * frames : Math.trunc(start)
  const period = mode & 2 ? Math.fround((frames * cmd.period) / 100) : cmd.period
  let last: number
  switch ((mode >> 2) % 5) {
    case 0:
      last = Math.trunc(end)
      break
    case 1:
      last = Math.trunc(end / 100) * frames
      break
    case 2:
      last = first + Math.trunc(end)
      break
    case 3:
      last = first + Math.trunc(end / 100) * frames
      break
    default:
      if (end < 1) return [0, 1, 0]
      last = first + Math.trunc(end * period)
  }
  last = Math.min(last, frames - 1)
  if (first < 0 || first > last || !(period >= 1e-6)) return [Math.max(0, first), period > 0 ? period : 1, 0]
  const count = Math.min(Math.trunc((last - first) / period) + 1, 100_000)
  return [first, period, count]
}

const DEG = Math.PI / 180

/** Column-major 4x4 (as stored) -> column-major 3x3. */
function upper3(m: readonly number[]): FxMat3 {
  return [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!]
}

function mat3To4(m: FxMat3): number[] {
  return [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1]
}

function mul3(a: FxMat3, b: FxMat3): FxMat3 {
  const o = new Array<number>(9)
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r]! * b[c * 3]! + a[3 + r]! * b[c * 3 + 1]! + a[6 + r]! * b[c * 3 + 2]!
  return o as FxMat3
}

/**
 * AxisVector4 (x, y, z, degrees) -> the matrix the editor stores next to it: Direct3D's rotation about an axis,
 * written as a column-major, column-vector matrix in file space. Null for a zero axis.
 */
export function axisAngleMatrix(left: readonly number[]): FxMat3 | null {
  const len = Math.hypot(left[0]!, left[1]!, left[2]!)
  if (!(len > 1e-12)) return null
  const x = left[0]! / len
  const y = left[1]! / len
  const z = left[2]! / len
  const a = left[3]! * DEG
  const c = Math.cos(a)
  const s = Math.sin(a)
  const t = 1 - c
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, t * x * y - s * z, t * y * y + c, t * y * z + s * x, t * x * z + s * y, t * y * z - s * x, t * z * z + c]
}

/**
 * RotVector (pitch, yaw, roll in degrees) -> the stored matrix: X(pitch) first, then Y(yaw), then Z(roll), with the
 * Y factor rotating +X towards +Z. Matches the stored matrix on every RotVector of this client (efp.corpus.test.ts).
 */
export function eulerMatrix(left: readonly number[]): FxMat3 {
  const rx = (d: number): FxMat3 => {
    const c = Math.cos(d * DEG)
    const s = Math.sin(d * DEG)
    return [1, 0, 0, 0, c, s, 0, -s, c]
  }
  const ry = (d: number): FxMat3 => {
    const c = Math.cos(d * DEG)
    const s = Math.sin(d * DEG)
    return [c, 0, s, 0, 1, 0, -s, 0, c]
  }
  const rz = (d: number): FxMat3 => {
    const c = Math.cos(d * DEG)
    const s = Math.sin(d * DEG)
    return [c, s, 0, -s, c, 0, 0, 0, 1]
  }
  return mul3(rz(left[2]!), mul3(ry(left[1]!), rx(left[0]!)))
}

/** File-space 3x3 -> glTF-space 3x3 (M R M). */
function toGltfMat3(m: FxMat3): FxMat3 {
  return upper3(toGltfMatrix(mat3To4(m), 1))
}

function gltfVec(v: readonly number[]): FxVec3 {
  const g = toGltfPosition(v as Vec3)
  return [g[0] + 0, g[1] + 0, g[2] + 0]
}

function gltfLength(x: number): number {
  return toGltfPosition([x, 0, 0])[0]
}

const round = (x: number): number => (Number.isFinite(x) ? Math.fround(x) : 0)

function basisOf(flags: number): FxBasis {
  return flags === 1 ? 'self' : flags === 2 ? 'parent' : flags === 3 ? 'sibling' : 'world'
}

function blendOf(r: EfpResource): FxBlend {
  // D3DBLEND: 2 ONE, 3 SRCCOLOR, 4 INVSRCCOLOR, 5 SRCALPHA, 6 INVSRCALPHA, 7 DESTALPHA, 12/13 BOTH(INV)SRCALPHA.
  // Only (5, 2) and (5, 6) matter in practice (99.8 % of nodes); the rest map to the nearest preset.
  if (r.srcBlend === 2 && r.dstBlend === 2) return 'oneone'
  if ([2, 3, 4, 7].includes(r.dstBlend)) return 'add'
  return 'alpha'
}

function stageOf(op: number, arg1: number, arg2: number): FxStageOp {
  // D3DTOP: 2 SELECTARG1, 3 SELECTARG2, 4 MODULATE, 5 MODULATE2X, 6 MODULATE4X. D3DTA: 0 DIFFUSE, 2 TEXTURE.
  if (op === 2) return arg1 === 2 ? 'texture' : 'diffuse'
  if (op === 3) return arg2 === 2 ? 'texture' : 'diffuse'
  if (op === 5) return 'modulate2x'
  if (op === 6) return 'modulate4x'
  return 'modulate'
}

const RENDER: Record<string, FxRender> = {
  RenderNone: 'none',
  RenderPlate: 'plate',
  RenderMesh: 'mesh',
  RenderLinkPipe: 'pipe',
  RenderLinkDPipe: 'dpipe',
  RenderLinkObj: 'linkobj',
}

const VIEW: Record<string, FxView> = {
  ViewNone: 'none',
  ViewBillboard: 'billboard',
  ViewVBillboard: 'vbillboard',
  ViewYBillboard: 'ybillboard',
}

interface Resources {
  textures: string[]
  meshes: string[]
  /** Particles.pk2 paths as stored, parallel to the arrays above. */
  texturePaths: string[]
  meshPaths: string[]
}

export interface CompileOptions {
  /** True when a Particles.pk2 path (as stored in the effect) exists; missing resources become '' URLs. */
  exists?: (path: string) => boolean
}

export interface CompiledEffect {
  effect: FxEffect
  /** Particles.pk2 paths (as stored) of the textures and meshes the effect uses and the client has. */
  texturePaths: string[]
  meshPaths: string[]
}

export function compileEfp(key: string, file: EfpFile, options: CompileOptions = {}): CompiledEffect {
  const exists = options.exists ?? (() => true)
  const warnings: string[] = []
  const res: Resources = { textures: [], meshes: [], texturePaths: [], meshPaths: [] }
  const addResource = (kind: 'texture' | 'mesh', path: string): number => {
    const list = kind === 'texture' ? res.texturePaths : res.meshPaths
    const k = fxKey(path)
    const found = list.findIndex(p => fxKey(p) === k)
    if (found >= 0) return found
    const ok = path !== '' && exists(path)
    if (!ok) warnings.push(`missing ${kind} ${JSON.stringify(path)}`)
    list.push(path)
    ;(kind === 'texture' ? res.textures : res.meshes).push(ok ? (kind === 'texture' ? fxTextureUrl(path) : fxMeshUrl(path)) : '')
    return list.length - 1
  }

  const nodes: FxNode[] = []
  const indexOf = new Map<EfpObject, number>()
  for (const { object, parent, depth } of efpObjects(file.root)) {
    const at = nodes.length
    indexOf.set(object, at)
    nodes.push(compileNode(object, depth === 0 ? -1 : indexOf.get(parent!)!, addResource, warnings))
  }
  const effect: FxEffect = {
    format: FX_FORMAT,
    version: FX_VERSION,
    key: fxKey(key),
    fps: FX_FPS,
    scale: round(file.scale) > 0 ? round(file.scale) : 1,
    textures: res.textures,
    meshes: res.meshes,
    nodes,
    duration: effectDuration(nodes),
    provenance: `${FX_PROVENANCE} (JMXVEFF ${file.versionText})`,
    warnings,
  }
  return {
    effect,
    texturePaths: res.texturePaths.filter((_, i) => res.textures[i] !== ''),
    meshPaths: res.meshPaths.filter((_, i) => res.meshes[i] !== ''),
  }
}

function compileNode(o: EfpObject, parent: number, addResource: (kind: 'texture' | 'mesh', path: string) => number,
  warnings: string[]): FxNode {
  const where = `node ${JSON.stringify(o.name)}`
  let frames = o.totalFrames
  if (!(frames >= 1)) {
    warnings.push(`${where}: totalFrames ${frames} -> 1`)
    frames = 1
  }
  const life = o.life?.name === 'NormalTimeLoop' ? 'loop' : o.life?.name === 'NeverExtinct' ? 'never' : 'extinct'
  if (o.life && !['NormalTimeLoop', 'NeverExtinct', 'NormalTimeExtinct'].includes(o.life.name)) warnings.push(`${where}: life ${o.life.name}`)

  let emit: FxNode['emit'] = null
  for (const e of o.emitters) {
    if (e?.param?.kind !== 'EFStaticEmit') continue
    const v = e.param.value
    emit = { start: v.min, duration: v.max, period: v.burstRate, limit: v.minParticles, rate: round(v.spawnRate) }
  }
  if (o.emitters.length !== 1) warnings.push(`${where}: ${o.emitters.length} emitters`)

  const render = RENDER[o.render?.name ?? 'RenderNone'] ?? 'none'
  const view = VIEW[o.view?.name ?? 'ViewNone'] ?? 'none'
  let material: FxMaterial | null = null
  if (render !== 'none') {
    const r = o.resource
    const ref = r.meshes[0]
    const texPath = ref?.textures[0] ?? ''
    const texture = texPath ? addResource('texture', texPath) : -1
    if (texture < 0) warnings.push(`${where}: no texture`)
    let mesh = -1
    if (render === 'mesh') {
      if (ref?.path) mesh = addResource('mesh', ref.path)
      else warnings.push(`${where}: RenderMesh without a mesh; drawn as a plate`)
    }
    material = {
      texture,
      mesh,
      blend: blendOf(r),
      cull: r.cull === 1 ? 'none' : r.cull === 2 ? 'front' : 'back',
      colorOp: stageOf(r.colorOp, r.colorArg1, r.colorArg2),
      alphaOp: stageOf(r.alphaOp, r.alphaArg1, r.alphaArg2),
      d3d: { srcBlend: r.srcBlend, dstBlend: r.dstBlend, cull: r.cull, colorOp: r.colorOp, alphaOp: r.alphaOp },
    }
  }

  const node: FxNode = {
    name: o.name,
    parent,
    frames,
    life,
    emit,
    link: {
      positionDepth: o.link.positionDepth,
      matrixDepth: o.link.matrixDepth,
      velocityDepth: o.link.velocityDepth,
      followDepth: o.link.followDepth,
      localMotion: o.link.localMotion !== 0,
      shapeMotion: o.link.shapeMotion !== 0,
      keepMatrix: o.link.keepMatrix !== 0,
      keepOrigin: o.link.keepOrigin !== 0,
    },
    render,
    view,
    material,
    commands: [],
  }

  const graph = o.globals.find(g => g.name === 'BlendScaleGraph')
  for (const c of o.program) {
    if (!c) continue
    const at = commandSchedule(c, frames)
    const p = c.param
    const f = c.flags
    const table = (values: number[]): FxTable => ({ at, values: values.map(round) })
    const cmd = ((): FxCommand | null => {
      switch (c.name) {
        case 'SetPosition':
          if (p?.kind !== 'Vector') return null
          // flags: base 1/4/7 = parent position, 2/5 = sibling position, else own; vector in own frame for 3-5,
          // in the parent's frame for 6-7 (and the two 11s), raw otherwise.
          return {
            op: 'position',
            base: [1, 4, 7].includes(f) ? 'parent' : [2, 5].includes(f) ? 'sibling' : 'self',
            basis: f >= 3 && f <= 5 ? 'self' : f >= 6 ? 'parent' : 'world',
            v: gltfVec(p.value),
            at,
            flags: f,
          }
        case 'SetVelocity':
        case 'Force':
          if (p?.kind !== 'Vector') return null
          return { op: c.name === 'Force' ? 'force' : 'velocity', basis: basisOf(f), v: gltfVec(p.value), at, flags: f }
        case 'SetSpherePos':
          if (p?.kind !== 'Vector') return null
          return { op: 'sphere', base: f === 1 ? 'parent' : 'self', r: gltfVec(p.value).map(Math.abs) as FxVec3, at, flags: f }
        case 'SetConePos':
        case 'SetConeVel':
        case 'ConeForce': {
          if (p?.kind !== 'AngleVector1') return null
          const op = c.name === 'SetConePos' ? 'conePos' : c.name === 'SetConeVel' ? 'coneVel' : 'coneForce'
          // SetConePos flags are 0, 2 or 7 (7 = in the parent's frame, like 2); the others use the velocity bases.
          const basis = op === 'conePos' ? (f === 2 || f === 7 ? 'parent' : f === 1 ? 'self' : 'world') : basisOf(f)
          return { op, basis, min: round(gltfLength(p.left[0])), max: round(gltfLength(p.left[1])), angle: round(p.left[2] * DEG), at, flags: f }
        }
        case 'Attraction':
          if (p?.kind !== 'float') return null
          return { op: 'attraction', k: round(gltfLength(p.value)), at, flags: f }
        case 'SetRotation':
        case 'SetRotationAxis':
        case 'SetRotationMat':
        case 'SetRVelocity':
        case 'SetRVelocityAxis':
        case 'SetRVelocityMat':
        case 'SetShapeRot':
        case 'SetShapeRotVel': {
          const m = rotationOf(p)
          if (!m) {
            warnings.push(`${where}: ${c.name} with a degenerate rotation`)
            return null
          }
          const g = toGltfMat3(m).map(round) as FxMat3
          if (c.name.startsWith('SetRotation')) return { op: 'rotation', basis: basisOf(f), m: g, at, flags: f }
          if (c.name.startsWith('SetRVelocity')) return { op: 'angularVelocity', m: g, at, flags: f }
          if (c.name === 'SetShapeRot') return { op: 'shapeRotation', m: g, at, flags: f }
          return { op: 'shapeSpin', m: g, at, flags: f }
        }
        case 'SetGraphRandomScale':
          if (graph?.param.kind !== 'BlendScaleGraph' || graph.param.value.points.length === 0) {
            warnings.push(`${where}: SetGraphRandomScale without a BlendScaleGraph`)
            return null
          }
          node.randomScale = graph.param.value.points.map(k => [round(k.time), ...k.value.map(round)])
          return { op: 'randomScale', at, flags: f }
        case 'SetGraphScale':
          if (p?.kind === 'FrameScale' && p.value.length) node.scale = table(p.value.flat())
          return null
        case 'SetGraphDiffuse':
          if (p?.kind === 'FrameDiffuse' && p.value.length) node.color = table(p.value.flatMap(c4 => c4.map(x => x / 255)))
          return null
        case 'TextureSlide':
          if (p?.kind === 'FrameTextureSlide' && p.value.length) node.uv = table(p.value.flat())
          return null
        case 'SetBANPos':
          if (p?.kind === 'FrameBANPosition' && p.value.length) node.banPosition = table(p.value.flatMap(v => gltfVec(v)))
          return null
        case 'SetBANRot':
          if (p?.kind === 'FrameBANRotation' && p.value.length) node.banRotation = table(p.value.flatMap((m: Mat4) => toGltfMat3(upper3(m))))
          return null
        default:
          warnings.push(`${where}: ignored command ${c.name}`)
          return null
      }
    })()
    if (cmd) node.commands.push(cmd)
  }
  return node
}

function rotationOf(p: EfpCommand['param']): FxMat3 | null {
  if (!p) return null
  if (p.kind === 'AxisVector4') return axisAngleMatrix(p.left)
  if (p.kind === 'RotVector') return eulerMatrix(p.left)
  if (p.kind === 'Matrix') return upper3(p.value)
  return null
}

/**
 * Upper bound on the frames until the effect is over, or null when a node loops or never dies. A node's elements
 * are born at most `start + duration - 1` frames into their parent's life (and within it), so the bound is the sum
 * of those along the chain plus the node's own lifetime.
 */
export function effectDuration(nodes: readonly FxNode[]): number | null {
  const lastBirth: number[] = []
  let end = 0
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    if (n.life !== 'extinct') return null
    const parentLast = n.parent < 0 ? 0 : lastBirth[n.parent]!
    const e = n.emit
    const parentFrames = n.parent < 0 ? Infinity : nodes[n.parent]!.frames
    if (!e || e.period <= 0 || e.rate <= 0 || e.limit <= 0 || parentLast < 0) {
      lastBirth.push(-1)
      continue
    }
    const within = Math.min(e.start + e.duration - 1, parentFrames - 1)
    if (within < e.start) {
      lastBirth.push(-1)
      continue
    }
    const last = parentLast + within
    lastBirth.push(last)
    end = Math.max(end, last + n.frames)
  }
  return end
}

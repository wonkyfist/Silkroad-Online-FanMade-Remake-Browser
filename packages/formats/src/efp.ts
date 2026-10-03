/**
 * EFP visual-effect parser (JMXVEFF 0010-0013).
 *
 * Specs: SilkroadDoc wiki JMXVEFF, openroad docs/formats/efp-jmxveff.md (read as documentation), OpenSRO
 * scripts/build/effects/parseJmxVisualEffect.mjs (read as documentation only). Record reading order
 * cross-checked against the Lafa2K importer (MIT, read_efp_object / read_source / read_resource).
 *
 *   header    "JMXVEFF " + 4-char version ("0010" .. "0013")
 *             v12, v13: f32 rootScale;  v13: i32[3] (unknown)
 *   object    EFStoredObject (recursive, see readObject)
 *   EOF       parsers here reject trailing bytes, so every accepted file is byte-exact.
 *
 * EFStoredObject:
 *   u32 dataOffset, lpString name
 *   u32 controllerCount, { lpString controllerName, controller payload (by name) }   editor-side description
 *   globals   i32 totalFrames (element lifetime in 20 Hz frames), u32 n, { lpString name, parameter }
 *   sourceList preProgram, sourceList emitters ("StaticEmit"), sourceList postEmitters
 *   source    life ("NeverExtinct" | "NormalTimeExtinct" | "NormalTimeLoop")
 *   sourceList update ("ProgramUpdate")
 *   u8 link0, u8 link1, i32 link2, i32 link3, i32 link4, u8 link5, i32 link6, u8 link7   (see EfpLink)
 *   source    view ("ViewNone" | "ViewBillboard" | "ViewVBillboard" | "ViewYBillboard")
 *   resource  blend state + meshes/textures
 *   source    render ("RenderNone" | "RenderPlate" | "RenderMesh" | "RenderLinkPipe" | "RenderLinkDPipe" | "RenderLinkObj")
 *   sourceList trailing, sourceList program (the per-element command timeline)
 *   u32 childCount, children
 *
 * source: u8 hasData; if set: lpString command, u8 flags, u8 mode, f32 start, f32 period, f32 end, parameter (by command).
 * The three floats are named after their use in the 20 Hz schedule (OpenSRO's notes on the native B0C290: the second
 * stored float is the spacing between runs, the third the last frame); the wiki calls them start/end/float2.
 *
 * Version "0000" (7 files of 1.188, all skill/china/*ganggi* and etc_mirage_sword_normal) is an unrelated older
 * serialization (byte ramps, identity-matrix blocks, no JMXVEFF object layout). No client file references them
 * (skilleffect.txt, BSRs and the other effects were searched), openroad calls them corrupt and OpenSRO's notes on the
 * native loader accept only 0010-0013, so the original game never shows them. They are rejected here.
 *
 * Corrections to the wiki confirmed on this client's bytes (packages/convert/test/efp.corpus.test.ts):
 * - StaticEmit carries 5 values (u32 min, max, burstRate, minParticles, f32 spawnRate), not 4.
 * - FrameBANRotation / FrameBANPosition / FrameTextureSlide carry a leading value before the count.
 * - DiffuseGraph has no trailing floats (ScaleGraph does).
 * - The resource's first u32 is a D3DCULL value (1 none, 2 cw, 3 ccw), not a bool.
 */
import { BinaryReader, eucKr, latin1 } from './binary.ts'

export type Vec3 = [number, number, number]
export type Vec4 = [number, number, number, number]
/** 16 floats exactly as stored: a Direct3D row-vector matrix, i.e. column-major for column vectors. */
export type Mat4 = number[]
/** Colours are stored as D3DCOLOR (B, G, R, A bytes); returned as [r, g, b, a] in 0..255. */
export type Rgba8 = [number, number, number, number]

export interface EfpStaticEmit {
  /** Parent-age frame at which emission starts. */
  min: number
  /** Number of frames emission lasts, counted from `min`. */
  max: number
  /** Frames between emissions (0: never emits). */
  burstRate: number
  /** Cap on live elements in one parent's group. */
  minParticles: number
  /** Elements added per emission (fractional values accumulate). */
  spawnRate: number
}

export interface EfpBlend<T> {
  begin: number
  end: number
  points: Array<{ time: number; value: T }>
}

export type EfpParam =
  | { kind: 'float'; value: number }
  | { kind: 'Vector'; value: Vec3 }
  | { kind: 'Matrix'; value: Mat4 }
  | { kind: 'EFStaticEmit'; value: EfpStaticEmit }
  /** xyz axis, w angle in degrees; `matrix` is the stored (editor-converted) matrix. */
  | { kind: 'AxisVector4'; left: Vec4; matrix: Mat4 }
  /** pitch, yaw, roll in degrees; `matrix` is the stored matrix. */
  | { kind: 'RotVector'; left: Vec3; matrix: Mat4 }
  /** left: min, max, angle in degrees; right: the same with the angle in radians (as stored). */
  | { kind: 'AngleVector1'; left: Vec3; right: Vec3 }
  | { kind: 'FrameScale'; value: Vec3[] }
  | { kind: 'BlendScaleGraph'; value: EfpBlend<Vec3> }
  /** Stored as 4 bytes that the tools read as f32 (the wiki: a pointer). */
  | { kind: 'BlendScaleGraphPointer'; value: number }
  | { kind: 'FrameDiffuse'; value: Rgba8[] }
  | { kind: 'BlendDiffuseGraph'; value: EfpBlend<Rgba8> }
  | { kind: 'FrameBANRotation'; lead: number; value: Mat4[] }
  | { kind: 'FrameBANPosition'; lead: number; value: Vec3[] }
  | { kind: 'BSAnimation'; value: string[] }
  | { kind: 'FrameTextureSlide'; lead: Vec3; value: Vec4[] }

export type EfpParamKind = EfpParam['kind']

export interface EfpCommand {
  /** File offset of the hasData byte. */
  offset: number
  name: string
  /** First stored byte: command-specific variant (e.g. which basis SetVelocity uses). */
  flags: number
  /** Second stored byte: schedule mode bits (1: start is %, 2: period is %, (>>2)%5: end rule). */
  mode: number
  start: number
  period: number
  end: number
  param: EfpParam | null
}

export interface EfpMeshRef {
  path: string
  textures: string[]
}

export interface EfpResource {
  /** D3DCULL: 1 none (two-sided), 2 clockwise, 3 counter-clockwise. */
  cull: number
  /** D3DBLEND of the source and destination factors (5/2 = additive, 5/6 = alpha blend). */
  srcBlend: number
  dstBlend: number
  /** D3DTA / D3DTOP of the colour stage (arg1, arg2, op) and alpha stage. */
  colorArg1: number
  colorArg2: number
  colorOp: number
  alphaArg1: number
  alphaArg2: number
  alphaOp: number
  meshes: EfpMeshRef[]
}

export type EfpController =
  | { name: 'NormalTimeLife' | 'NormalTimeLoopLife' }
  | { name: 'StaticEmit'; value: EfpStaticEmit }
  | { name: 'Program'; program: EfpCommand[] }
  /** [followDepth, positionDepth, matrixDepth, velocityDepth], see EfpLink. */
  | { name: 'LinkMode'; value: [number, number, number, number] }
  | { name: 'BAN'; animations: string[] }
  | { name: 'ViewMode'; mode: string }
  | { name: 'Shape'; shape: string; resource: EfpResource }
  | { name: 'ScaleGraph'; x: EfpBlend<number>; y: EfpBlend<number>; z: EfpBlend<number>; unknown0: number; unknown1: number }
  | { name: 'DiffuseGraph'; alpha: EfpBlend<number>; color: EfpBlend<Rgba8> }

export type EfpControllerName = EfpController['name']

/**
 * The eight scalars between `update` and `view`. Names follow OpenSRO's reading of the native runtime (read as
 * documentation): the four depths are how many ancestor levels an element follows for its position (rotation about
 * the ancestor), orientation, velocity and translation. The editor's LinkMode controller stores the same four depths
 * as [followDepth, positionDepth, matrixDepth, velocityDepth]: 21,169 of 21,173 LinkMode nodes agree; the other 4
 * (system_rarebow_b/c*) store 4 in LinkMode and 3 in the object.
 */
export interface EfpLink {
  /** Keep the previous orientation and expose its per-frame change to children. */
  keepMatrix: number
  /** Reset the follow origin every frame. */
  keepOrigin: number
  positionDepth: number
  matrixDepth: number
  velocityDepth: number
  /** Apply the element's angular velocity (SetRVelocity*) every frame. */
  localMotion: number
  followDepth: number
  /** Apply the shape spin (SetShapeRotVel) every frame. */
  shapeMotion: number
}

export interface EfpGlobalParam {
  name: string
  param: EfpParam
}

export interface EfpObject {
  /** File offset of this record. */
  offset: number
  dataOffset: number
  name: string
  controllers: EfpController[]
  /** Element lifetime in 20 Hz frames (the wiki's EEGlobalData Int0). */
  totalFrames: number
  globals: EfpGlobalParam[]
  preProgram: Array<EfpCommand | null>
  emitters: Array<EfpCommand | null>
  postEmitters: Array<EfpCommand | null>
  life: EfpCommand | null
  update: Array<EfpCommand | null>
  link: EfpLink
  view: EfpCommand | null
  resource: EfpResource
  render: EfpCommand | null
  trailing: Array<EfpCommand | null>
  program: Array<EfpCommand | null>
  children: EfpObject[]
}

export interface EfpFile {
  /** "0010" .. "0013". */
  versionText: string
  version: number
  /** 1 for versions without the field. */
  scale: number
  v13: [number, number, number] | null
  root: EfpObject
}

export const EFP_SIGNATURE = 'JMXVEFF '

/** The parameter shape each command carries (commands missing here carry none). */
export const EFP_COMMAND_PARAM: Readonly<Record<string, EfpParamKind>> = {
  StaticEmit: 'EFStaticEmit',
  Attraction: 'float',
  SetPosition: 'Vector',
  SetSpherePos: 'Vector',
  SetVelocity: 'Vector',
  Force: 'Vector',
  SetRotationMat: 'Matrix',
  SetRVelocityMat: 'Matrix',
  SetRotation: 'RotVector',
  SetRVelocity: 'RotVector',
  SetRotationAxis: 'AxisVector4',
  SetRVelocityAxis: 'AxisVector4',
  SetShapeRot: 'AxisVector4',
  SetShapeRotVel: 'AxisVector4',
  SetConePos: 'AngleVector1',
  SetConeVel: 'AngleVector1',
  ConeForce: 'AngleVector1',
  SetGraphScale: 'FrameScale',
  SetGraphRandomScale: 'BlendScaleGraphPointer',
  SetGraphDiffuse: 'FrameDiffuse',
  SetBANRot: 'FrameBANRotation',
  SetBANPos: 'FrameBANPosition',
  TextureSlide: 'FrameTextureSlide',
}

/** Commands that carry no parameter. Anything neither here nor in EFP_COMMAND_PARAM is rejected. */
export const EFP_BARE_COMMANDS: ReadonlySet<string> = new Set([
  'NeverExtinct',
  'NormalTimeExtinct',
  'NormalTimeLoop',
  'ProgramUpdate',
  'ViewNone',
  'ViewBillboard',
  'ViewVBillboard',
  'ViewYBillboard',
  'RenderNone',
  'RenderPlate',
  'RenderMesh',
  'RenderLinkPipe',
  'RenderLinkDPipe',
  'RenderLinkObj',
])

const MAX_STRING = 65536
const MAX_COUNT = 1 << 20
const MAX_DEPTH = 64

class EfpReader extends BinaryReader {
  fail(message: string, at = this.offset): never {
    throw new Error(`EFP: ${message} at offset ${at}`)
  }

  need(bytes: number): void {
    if (bytes < 0 || this.offset + bytes > this.length) this.fail(`read of ${bytes} bytes overruns ${this.length}`)
  }

  count(label: string, max = MAX_COUNT): number {
    this.need(4)
    const n = this.i32()
    if (n < 0 || n > max) this.fail(`invalid ${label} count ${n}`, this.offset - 4)
    return n
  }

  str(): string {
    this.need(4)
    const at = this.offset
    const n = this.i32()
    if (n < 0 || n > MAX_STRING) this.fail(`invalid string length ${n}`, at)
    this.need(n)
    return eucKr.decode(this.bytesView(n))
  }

  f(): number {
    this.need(4)
    return this.f32()
  }

  u(): number {
    this.need(4)
    return this.u32()
  }

  s(): number {
    this.need(4)
    return this.i32()
  }

  b(): number {
    this.need(1)
    return this.u8()
  }

  vec3(): Vec3 {
    return [this.f(), this.f(), this.f()]
  }

  vec4(): Vec4 {
    return [this.f(), this.f(), this.f(), this.f()]
  }

  mat4(): Mat4 {
    this.need(64)
    const m = new Array<number>(16)
    for (let i = 0; i < 16; i++) m[i] = this.f32()
    return m
  }

  color(): Rgba8 {
    this.need(4)
    const b = this.u8()
    const g = this.u8()
    const r = this.u8()
    const a = this.u8()
    return [r, g, b, a]
  }

  list<T>(label: string, read: () => T): T[] {
    const n = this.count(label)
    const out = new Array<T>(n)
    for (let i = 0; i < n; i++) out[i] = read()
    return out
  }

  blend<T>(read: () => T): EfpBlend<T> {
    const begin = this.f()
    const end = this.f()
    const points = this.list('blend point', () => ({ time: this.f(), value: read() }))
    return { begin, end, points }
  }

  staticEmit(): EfpStaticEmit {
    return { min: this.u(), max: this.u(), burstRate: this.u(), minParticles: this.u(), spawnRate: this.f() }
  }

  param(kind: string): EfpParam {
    switch (kind) {
      case 'float':
        return { kind, value: this.f() }
      case 'Vector':
        return { kind, value: this.vec3() }
      case 'Matrix':
        return { kind, value: this.mat4() }
      case 'EFStaticEmit':
      case 'SEFStaticEmit':
        return { kind: 'EFStaticEmit', value: this.staticEmit() }
      case 'AxisVector4':
        return { kind, left: this.vec4(), matrix: this.mat4() }
      case 'RotVector':
        return { kind, left: this.vec3(), matrix: this.mat4() }
      case 'AngleVector1':
        return { kind, left: this.vec3(), right: this.vec3() }
      case 'FrameScale':
        return { kind, value: this.list('FrameScale', () => this.vec3()) }
      case 'BlendScaleGraph':
        return { kind, value: this.blend(() => this.vec3()) }
      case 'BlendScaleGraphPointer':
        return { kind, value: this.f() }
      case 'FrameDiffuse':
        return { kind, value: this.list('FrameDiffuse', () => this.color()) }
      case 'BlendDiffuseGraph':
        return { kind, value: this.blend(() => this.color()) }
      case 'FrameBANRotation': {
        const lead = this.f()
        return { kind, lead, value: this.list('FrameBANRotation', () => this.mat4()) }
      }
      case 'FrameBANPosition': {
        const lead = this.f()
        return { kind, lead, value: this.list('FrameBANPosition', () => this.vec3()) }
      }
      case 'BSAnimation':
        return { kind, value: this.list('BSAnimation', () => this.str()) }
      case 'FrameTextureSlide': {
        const lead = this.vec3()
        return { kind, lead, value: this.list('FrameTextureSlide', () => this.vec4()) }
      }
      default:
        return this.fail(`unknown parameter type ${JSON.stringify(kind)}`)
    }
  }

  command(): EfpCommand | null {
    const offset = this.offset
    const has = this.b()
    if (has === 0) return null
    if (has !== 1) this.fail(`source hasData byte ${has}`, offset)
    const nameAt = this.offset
    const name = this.str()
    const flags = this.b()
    const mode = this.b()
    const start = this.f()
    const period = this.f()
    const end = this.f()
    const kind = EFP_COMMAND_PARAM[name]
    if (!kind && !EFP_BARE_COMMANDS.has(name)) this.fail(`unknown command ${JSON.stringify(name)}`, nameAt)
    return { offset, name, flags, mode, start, period, end, param: kind ? this.param(kind) : null }
  }

  commands(label: string): Array<EfpCommand | null> {
    return this.list(label, () => this.command())
  }

  resource(): EfpResource {
    const r: EfpResource = {
      cull: this.u(),
      srcBlend: this.s(),
      dstBlend: this.s(),
      colorArg1: this.s(),
      colorArg2: this.s(),
      colorOp: this.s(),
      alphaArg1: this.s(),
      alphaArg2: this.s(),
      alphaOp: this.s(),
      meshes: [],
    }
    r.meshes = this.list('resource mesh', () => ({ path: this.str(), textures: this.list('mesh texture', () => this.str()) }))
    return r
  }

  controller(name: string, at: number): EfpController {
    switch (name) {
      case 'NormalTimeLife':
      case 'NormalTimeLoopLife':
        return { name }
      case 'StaticEmit':
        return { name, value: this.staticEmit() }
      case 'Program':
        return { name, program: this.commands('controller program').map(c => c ?? this.fail('empty controller command')) }
      case 'LinkMode':
        return { name, value: [this.s(), this.s(), this.s(), this.s()] }
      case 'BAN':
        return { name, animations: this.list('BAN animation', () => this.str()) }
      case 'ViewMode':
        return { name, mode: this.str() }
      case 'Shape':
        return { name, shape: this.str(), resource: this.resource() }
      case 'ScaleGraph':
        return {
          name,
          x: this.blend(() => this.f()),
          y: this.blend(() => this.f()),
          z: this.blend(() => this.f()),
          unknown0: this.f(),
          unknown1: this.f(),
        }
      case 'DiffuseGraph':
        return { name, alpha: this.blend(() => this.b()), color: this.blend(() => this.color()) }
      default:
        return this.fail(`unknown controller ${JSON.stringify(name)}`, at)
    }
  }

  object(depth: number): EfpObject {
    if (depth > MAX_DEPTH) this.fail('object tree too deep')
    const offset = this.offset
    const dataOffset = this.u()
    const name = this.str()
    const controllers = this.list('controller', () => {
      const at = this.offset
      return this.controller(this.str(), at)
    })
    const totalFrames = this.s()
    const globals = this.list('global parameter', () => {
      const pname = this.str()
      return { name: pname, param: this.param(pname) }
    })
    const preProgram = this.commands('pre program')
    const emitters = this.commands('emitter')
    const postEmitters = this.commands('post emitter')
    const life = this.command()
    const update = this.commands('update program')
    const link: EfpLink = {
      keepMatrix: this.b(),
      keepOrigin: this.b(),
      positionDepth: this.s(),
      matrixDepth: this.s(),
      velocityDepth: this.s(),
      localMotion: this.b(),
      followDepth: this.s(),
      shapeMotion: this.b(),
    }
    const view = this.command()
    const resource = this.resource()
    const render = this.command()
    const trailing = this.commands('trailing program')
    const program = this.commands('program')
    const children = this.list('child object', () => this.object(depth + 1))
    return {
      offset,
      dataOffset,
      name,
      controllers,
      totalFrames,
      globals,
      preProgram,
      emitters,
      postEmitters,
      life,
      update,
      link,
      view,
      resource,
      render,
      trailing,
      program,
      children,
    }
  }
}

export function efpVersion(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  if (latin1.decode(bytes.subarray(0, 8)) !== EFP_SIGNATURE) return null
  return latin1.decode(bytes.subarray(8, 12))
}

/**
 * Parses a whole .efp. Version "0010" (one file in 1.188) uses the 0011 layout, as openroad reports.
 * Throws with the file offset on malformed input or trailing bytes.
 */
export function parseEfp(bytes: Uint8Array): EfpFile {
  const r = new EfpReader(bytes)
  if (bytes.length < 12) r.fail(`file of ${bytes.length} bytes is too short`, 0)
  const signature = latin1.decode(r.bytesView(8))
  if (signature !== EFP_SIGNATURE) r.fail(`bad signature ${JSON.stringify(signature)}`, 0)
  const versionText = latin1.decode(r.bytesView(4))
  if (!/^00(1[0-3])$/.test(versionText)) r.fail(`unsupported version ${JSON.stringify(versionText)}`, 8)
  const version = Number(versionText)
  const scale = version >= 12 ? r.f() : 1
  const v13: EfpFile['v13'] = version === 13 ? [r.s(), r.s(), r.s()] : null
  const root = r.object(0)
  if (r.offset !== bytes.length) r.fail(`${bytes.length - r.offset} trailing bytes`)
  return { versionText, version, scale, v13, root }
}

/** Depth-first walk over an effect tree (parents before children). */
export function* efpObjects(root: EfpObject, depth = 0, parent: EfpObject | null = null): Generator<{ object: EfpObject; depth: number; parent: EfpObject | null }> {
  yield { object: root, depth, parent }
  for (const child of root.children) yield* efpObjects(child, depth + 1, root)
}

/** Every resource of an object: its own and those of Shape controllers. */
export function efpResources(object: EfpObject): EfpResource[] {
  const out = [object.resource]
  for (const c of object.controllers) if (c.name === 'Shape') out.push(c.resource)
  return out
}

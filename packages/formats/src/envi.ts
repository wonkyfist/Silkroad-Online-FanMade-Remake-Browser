/**
 * Environment (sky / light / fog) profiles Map/environment.ifo (JMXVENVI1003).
 *
 * Specs: SilkroadDoc wiki JMXVENVI, openroad docs/formats/envi-jmxvenvi.md (read as documentation), checked
 * against the vSRO 1.188 file (packages/convert/test/terrain.corpus.test.ts):
 *
 *   char[12]  "JMXVENVI1003"
 *   i16       profileCount (60)
 *   lpString  setName ("")
 *   profileCount x profile:
 *     u16 id, lpString name, lpString dayBgm, lpString nightBgm (both "", obsolete)
 *     16 graphs in ENV_GRAPHS order. ColorGraph: i32 count, count x (f32 r, g, b, time).
 *                                     FloatGraph: i32 count, count x (f32 value, time).
 *   node tree (editor grouping; the client looks profiles up by id):
 *     u32 childCount, lpString name, u16 profileId, u16 short0, i32 int0, i32 int1, childCount x node
 *   EOF
 *
 * Times are the time of day in 0..1 (0 midnight, 0.5 noon). .m blocks select a profile by environmentId.
 * Graph names follow the wiki; graph4/10/11/12/15 are unnamed there too.
 */
import { BinaryReader, eucKr, latin1 } from './binary.ts'

export const ENVI_SIGNATURE = 'JMXVENVI1003'

export interface EnvColorKey {
  r: number
  g: number
  b: number
  /** Time of day, 0..1. */
  time: number
}

export interface EnvFloatKey {
  value: number
  time: number
}

/** Graph fields in file order, with their kind. */
export const ENV_GRAPHS = [
  ['sunColor', 'color'],
  ['skyTopColor', 'color'],
  ['diffuseColor', 'color'],
  ['objectAmbientColor', 'color'],
  ['graph4', 'color'],
  ['terrainAmbientColor', 'color'],
  ['terrainShadowColor', 'color'],
  ['fogNearPlane', 'float'],
  ['fogFarPlane', 'float'],
  ['fogColor', 'color'],
  ['graph10', 'float'],
  ['graph11', 'float'],
  ['graph12', 'float'],
  ['skyBottomColor', 'color'],
  ['waterColor', 'color'],
  ['graph15', 'float'],
] as const

type GraphSpec = (typeof ENV_GRAPHS)[number]
export type EnvColorGraphName = Extract<GraphSpec, readonly [string, 'color']>[0]
export type EnvFloatGraphName = Extract<GraphSpec, readonly [string, 'float']>[0]

export type EnvProfile = {
  id: number
  name: string
  dayBgm: string
  nightBgm: string
} & { [K in EnvColorGraphName]: EnvColorKey[] } & { [K in EnvFloatGraphName]: EnvFloatKey[] }

export interface EnvNode {
  name: string
  profileId: number
  short0: number
  int0: number
  int1: number
  children: EnvNode[]
}

export interface EnvironmentFile {
  signature: string
  setName: string
  profiles: EnvProfile[]
  byId: Map<number, EnvProfile>
  root: EnvNode
}

const MAX_TREE_DEPTH = 16

export function parseEnvironment(bytes: Uint8Array): EnvironmentFile {
  const r = new BinaryReader(bytes)
  if (bytes.byteLength < 14) throw new Error(`ENVI: file is ${bytes.byteLength} bytes, shorter than the header`)
  const signature = r.fixedString(12, latin1)
  if (signature !== ENVI_SIGNATURE) {
    throw new Error(`ENVI: bad signature ${JSON.stringify(signature)} at offset 0 (expected "${ENVI_SIGNATURE}")`)
  }
  const at = (what: string, fn: () => void) => {
    const offset = r.offset
    try {
      fn()
    } catch (e) {
      throw new Error(`ENVI: ${what} at offset ${offset}: ${(e as Error).message}`)
    }
  }
  const str = () => {
    const len = r.u32()
    if (len > r.remaining) throw new Error(`string length ${len} exceeds the ${r.remaining} bytes left`)
    return eucKr.decode(r.bytesView(len))
  }
  const count = (size: number) => {
    const n = r.i32()
    if (n < 0 || n * size > r.remaining) throw new Error(`key count ${n} does not fit the ${r.remaining} bytes left`)
    return n
  }

  let profileCount = 0
  let setName = ''
  at('header', () => {
    profileCount = r.i16()
    if (profileCount < 0) throw new Error(`negative profile count ${profileCount}`)
    setName = str()
  })
  const profiles: EnvProfile[] = []
  const byId = new Map<number, EnvProfile>()
  for (let p = 0; p < profileCount; p++) {
    at(`profile ${p}`, () => {
      const profile: Record<string, unknown> = { id: r.u16(), name: str(), dayBgm: str(), nightBgm: str() }
      for (const [name, kind] of ENV_GRAPHS) {
        if (kind === 'color') {
          const keys: EnvColorKey[] = []
          for (let i = count(16); i > 0; i--) keys.push({ r: r.f32(), g: r.f32(), b: r.f32(), time: r.f32() })
          profile[name] = keys
        } else {
          const keys: EnvFloatKey[] = []
          for (let i = count(8); i > 0; i--) keys.push({ value: r.f32(), time: r.f32() })
          profile[name] = keys
        }
      }
      const typed = profile as EnvProfile
      if (byId.has(typed.id)) throw new Error(`duplicate profile id ${typed.id}`)
      profiles.push(typed)
      byId.set(typed.id, typed)
    })
  }

  const node = (depth: number): EnvNode => {
    if (depth > MAX_TREE_DEPTH) throw new Error(`node tree deeper than ${MAX_TREE_DEPTH}`)
    const childCount = r.u32()
    // each child needs at least 20 bytes
    if (childCount * 20 > r.remaining) throw new Error(`child count ${childCount} does not fit the ${r.remaining} bytes left`)
    const name = str()
    const profileId = r.u16()
    const short0 = r.u16()
    const int0 = r.i32()
    const int1 = r.i32()
    const children: EnvNode[] = []
    for (let i = 0; i < childCount; i++) children.push(node(depth + 1))
    return { name, profileId, short0, int0, int1, children }
  }
  let root: EnvNode | undefined
  at('node tree', () => {
    root = node(0)
  })
  if (r.remaining !== 0) throw new Error(`ENVI: ${r.remaining} trailing bytes at offset ${r.offset}`)
  return { signature, setName, profiles, byId, root: root! }
}

/**
 * Linear interpolation of a key list at time of day t (wrapped into 0..1). Keys are assumed sorted by time;
 * before the first / after the last key the curve wraps around midnight.
 */
function sample<K extends { time: number }>(keys: readonly K[], t: number, lerp: (a: K, b: K, f: number) => number[]): number[] {
  if (keys.length === 0) throw new Error('ENVI: cannot sample an empty graph')
  const time = t - Math.floor(t)
  if (keys.length === 1) return lerp(keys[0]!, keys[0]!, 0)
  let i = 0
  while (i < keys.length && keys[i]!.time <= time) i++
  const next = keys[i % keys.length]!
  const prev = keys[(i + keys.length - 1) % keys.length]!
  let t0 = prev.time
  let t1 = next.time
  if (i === 0) t0 -= 1
  if (i === keys.length) t1 += 1
  const f = t1 > t0 ? (time - t0) / (t1 - t0) : 0
  return lerp(prev, next, Math.min(1, Math.max(0, f)))
}

export function sampleEnvColor(keys: readonly EnvColorKey[], t: number): [r: number, g: number, b: number] {
  const [r, g, b] = sample(keys, t, (a, c, f) => [a.r + (c.r - a.r) * f, a.g + (c.g - a.g) * f, a.b + (c.b - a.b) * f])
  return [r!, g!, b!]
}

export function sampleEnvFloat(keys: readonly EnvFloatKey[], t: number): number {
  return sample(keys, t, (a, c, f) => [a.value + (c.value - a.value) * f])[0]!
}

export interface EnvLeaf {
  /** Node names below the root, e.g. ['장안', '<leaf name>']. */
  path: string[]
  profileId: number
  node: EnvNode
}

/** Childless nodes of the tree in file order. In 1.188 its 60 leaves name each profile exactly once. */
export function listEnvLeaves(env: EnvironmentFile): EnvLeaf[] {
  const out: EnvLeaf[] = []
  const walk = (node: EnvNode, path: string[]) => {
    if (node.children.length === 0) out.push({ path, profileId: node.profileId, node })
    for (const child of node.children) walk(child, [...path, child.name])
  }
  walk(env.root, [])
  return out
}

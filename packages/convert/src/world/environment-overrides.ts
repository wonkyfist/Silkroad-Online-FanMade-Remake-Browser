/**
 * content/environment/overrides.json: hand-tuned float graphs of Map/environment.ifo profiles, applied to the world
 * export's environment.json (./convert-world.ts). Node-free.
 *
 * Each entry names a profile id and replaces whole float graphs of it (e.g. graph10 / graph11, the fog start / end as
 * fractions of world-render's FOG_RANGE_M). Keys are { time, value } with times 0..1 (0 midnight, 0.5 noon), sorted,
 * the first at 0 and the last at 1, like the retail graphs. A profile the export does not use is skipped (reported).
 */
import type { EnvFloatKey } from '@sro/formats'

export const ENV_OVERRIDES_FORMAT = 'sro-environment-overrides'
export const ENV_OVERRIDES_VERSION = 1

/** The float graphs an override may replace (packages/formats envi.ts ENV_GRAPHS, float kind). */
export const ENV_FLOAT_GRAPHS = ['fogNearPlane', 'fogFarPlane', 'graph10', 'graph11', 'graph12', 'graph15'] as const
export type EnvFloatGraph = (typeof ENV_FLOAT_GRAPHS)[number]

export interface EnvProfileOverride {
  id: number
  name?: string
  graphs: Partial<Record<EnvFloatGraph, EnvFloatKey[]>>
}

export interface EnvironmentOverrides {
  profiles: EnvProfileOverride[]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Parses and validates the file; throws with every problem listed. */
export function parseEnvironmentOverrides(text: string): EnvironmentOverrides {
  const raw = JSON.parse(text) as unknown
  const errors: string[] = []
  if (!isObj(raw)) throw new Error('environment overrides: expected an object')
  if (raw.format !== ENV_OVERRIDES_FORMAT) errors.push(`format: expected '${ENV_OVERRIDES_FORMAT}'`)
  if (raw.version !== ENV_OVERRIDES_VERSION) errors.push(`version: expected ${ENV_OVERRIDES_VERSION}`)
  const profiles: EnvProfileOverride[] = []
  if (!Array.isArray(raw.profiles)) errors.push('profiles: expected an array')
  else {
    raw.profiles.forEach((p: unknown, i) => {
      const at = `profiles[${i}]`
      if (!isObj(p) || !Number.isInteger(p.id) || (p.id as number) < 0) return errors.push(`${at}: expected { id, ... }`)
      if (profiles.some(q => q.id === p.id)) errors.push(`${at}: duplicate profile ${p.id}`)
      const graphs: EnvProfileOverride['graphs'] = {}
      for (const key of Object.keys(p)) {
        if (key === 'id' || key === 'name' || key === 'note') continue
        if (!(ENV_FLOAT_GRAPHS as readonly string[]).includes(key)) {
          errors.push(`${at}.${key}: not a float graph (${ENV_FLOAT_GRAPHS.join(', ')})`)
          continue
        }
        const keys = p[key]
        const ok = Array.isArray(keys) && keys.length >= 2 && keys.every(k => isObj(k) && isNum(k.time) && isNum(k.value) &&
          k.time >= 0 && k.time <= 1 && k.value >= -1 && k.value <= 2)
        if (!ok) {
          errors.push(`${at}.${key}: expected >= 2 keys { time 0..1, value -1..2 }`)
          continue
        }
        const list = (keys as Array<{ time: number; value: number }>).map(k => ({ value: k.value, time: k.time }))
        if (list.some((k, j) => j > 0 && k.time <= list[j - 1]!.time) || list[0]!.time !== 0 || list.at(-1)!.time !== 1) {
          errors.push(`${at}.${key}: times must rise from 0 to 1`)
          continue
        }
        graphs[key as EnvFloatGraph] = list
      }
      if (!Object.keys(graphs).length) errors.push(`${at}: no graph to replace`)
      profiles.push({ id: p.id as number, ...(typeof p.name === 'string' ? { name: p.name } : {}), graphs })
    })
  }
  if (errors.length) throw new Error(`environment overrides:\n  ${errors.join('\n  ')}`)
  return { profiles }
}

/**
 * The profiles with the overrides applied (new objects; the inputs are not changed), and one line per override:
 * what it replaced, or why it was skipped.
 */
export function applyEnvironmentOverrides<P extends { id: number }>(profiles: readonly P[], o: EnvironmentOverrides): { profiles: P[]; applied: string[] } {
  const applied: string[] = []
  const byId = new Map(o.profiles.map(p => [p.id, p]))
  const out = profiles.map(p => {
    const ov = byId.get(p.id)
    if (!ov) return p
    applied.push(`profile ${p.id}${ov.name ? ` (${ov.name})` : ''}: ${Object.keys(ov.graphs).join(', ')}`)
    return { ...p, ...structuredClone(ov.graphs) }
  })
  for (const ov of o.profiles) if (!profiles.some(p => p.id === ov.id)) applied.push(`profile ${ov.id}: not used by the export, skipped`)
  return { profiles: out, applied }
}

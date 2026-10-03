/**
 * The world's `ambient.json` (docs/EFFECTS.md §3.15; read by world-render `readAmbientIndex`, the ambient effects and
 * the night lights): per manifest model index, the model's always-on BSR `ambient` particles (fx/model-fx.ts), plus the
 * town's lamp rows (docs/TOWN_LIFE.md §7.1, docs/WAVE_PLAN7.md D15, lane W11-CV): a `lamps` row of the town dressing
 * file gives every model it names one night-only emitter, so a lamp post with no retail emitter (the plaza's four
 * `cj_field_lamp`) becomes a night light. Lamps are data; `night-lights.ts` is not involved.
 *
 * The index is written by the world export (./convert-world.ts), after the placement passes, so its keys are the
 * manifest's final model indices (an index written for an older model order puts lamps on the wrong buildings).
 *
 * Node-free; the caller reads the BSRs.
 */
import type { TownLamp } from '../../../shared/src/town.ts'
import { fxKey } from '../fx/compile.ts'
import type { ModelParticle } from '../fx/model-fx.ts'
import type { WorldModel } from './manifest.ts'

export const AMBIENT_FILE = 'ambient.json'
export const AMBIENT_FORMAT = 'sro-world-ambient'
export const AMBIENT_VERSION = 1
/** The `set` of a lamp row (retail rows keep their own set name, 'ambient'). */
export const TOWN_LAMP_SET = 'townLamp'

export interface WorldAmbientIndex {
  format: typeof AMBIENT_FORMAT
  version: typeof AMBIENT_VERSION
  source: string
  /** Model index (as a string key) -> its ambient particles, in file order; lamp rows last. */
  models: Record<string, ModelParticle[]>
}

export interface AmbientIndexResult {
  index: WorldAmbientIndex
  /** Retail rows and models. */
  retailRows: number
  /** Lamp rows written, and the models they went to. */
  lampRows: number
  lampModels: number
}

/** A resource path or name as a comparable key: lower case, forward slashes, no `res/` or `/out/` prefix, no extension. */
export function modelKey(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase().replace(/^\/?(out|res)\//, '').replace(/#.*$/, '').replace(/\.(bsr|glb|cpd)$/, '')
}

const baseOf = (key: string) => key.slice(key.lastIndexOf('/') + 1)

/** Does a lamp's `model` (a resource path, or a bare base name such as 'cj_field_lamp') name this model's source? */
export function lampMatches(lampModel: string, source: string): boolean {
  const want = modelKey(lampModel)
  const have = modelKey(source)
  return want.includes('/') ? have === want || have.endsWith('/' + want) : baseOf(have) === want
}

/**
 * Builds the index. `particlesOf` gives a model's particles (every kind; only `ambient` ones are kept) or null when
 * the model has no BSR (a failed model, a static variant, one of our props). A lamp that names no model is a warning.
 * A lamp row equal to an existing row of the model (same efp and position) is not added twice.
 */
export function buildAmbientIndex(
  models: readonly WorldModel[],
  particlesOf: (model: WorldModel) => readonly ModelParticle[] | null,
  lamps: readonly TownLamp[],
  warnings: string[],
): AmbientIndexResult {
  const out: Record<string, ModelParticle[]> = {}
  let retailRows = 0
  for (const m of models) {
    if (m.kind === 'failed') continue
    const rows = (particlesOf(m) ?? []).filter(p => p.kind === 'ambient')
    if (!rows.length) continue
    out[String(m.index)] = rows.map(p => ({ ...p }))
    retailRows += rows.length
  }
  let lampRows = 0
  const lampModels = new Set<number>()
  lamps.forEach((lamp, i) => {
    const targets = models.filter(m => m.kind !== 'failed' && !m.source.includes('#') && lampMatches(lamp.model, m.source))
    if (!targets.length) {
      warnings.push(`ambient: town lamp ${i} (${lamp.model}) names no model of the export`)
      return
    }
    const off = lamp.offset ?? [0, 0, 0]
    const row: ModelParticle = {
      set: TOWN_LAMP_SET,
      kind: 'ambient',
      efp: fxKey(lamp.efp),
      bone: null,
      position: [off[0] + 0, off[1] + 0, off[2] + 0],
      birthMs: 0,
      night: true,
    }
    for (const m of targets) {
      const list = (out[String(m.index)] ??= [])
      if (list.some(p => p.efp === row.efp && p.position.every((v, k) => Math.abs(v - row.position[k]!) < 1e-4))) continue
      list.push({ ...row, position: [...row.position] })
      lampRows++
      lampModels.add(m.index)
    }
  })
  // keys in model order (the JSON's own order)
  const models2: Record<string, ModelParticle[]> = {}
  for (const k of Object.keys(out).map(Number).sort((a, b) => a - b)) models2[String(k)] = out[String(k)]!
  return {
    index: {
      format: AMBIENT_FORMAT,
      version: AMBIENT_VERSION,
      source: lampRows ? 'BSR mod palettes (ambient sets) + town lamps (the dressing file)' : 'BSR mod palettes (ambient sets)',
      models: models2,
    },
    retailRows,
    lampRows,
    lampModels: lampModels.size,
  }
}

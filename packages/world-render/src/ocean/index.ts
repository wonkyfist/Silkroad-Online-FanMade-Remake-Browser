/**
 * The ocean part (docs/COAST.md §8; docs/WAVE_PLAN6.md §6.1 CST-O). World calls `createOceanPart` once the world is
 * made, on every path; a world without `manifest.coast` has no ocean (null), so today's exports, the Low guard and the
 * fixtures are unchanged. The part loads the coast field and draws nothing until it is there.
 */
import type { OceanHost, OceanPart } from '../coast/types.ts'
import { SroOcean, type OceanOptions, type OceanWaveQuery } from './ocean.ts'

export { SroOcean, type OceanOptions, type OceanStats, type OceanWaveQuery } from './ocean.ts'

/** The ocean of a world (null: the world has no coast). */
export function createOceanPart(host: OceanHost, opts?: OceanOptions): OceanPart | null {
  if (!host.world.manifest.coast) return null
  return new SroOcean(host, opts)
}

/** The wave-height query of a world's ocean (CST-A's ships, the spray), or null. */
export function oceanWaveQuery(part: OceanPart | null | undefined): OceanWaveQuery | null {
  return part instanceof SroOcean ? part : null
}

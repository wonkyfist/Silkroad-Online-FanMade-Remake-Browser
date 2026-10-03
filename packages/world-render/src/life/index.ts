/**
 * The wildlife part (docs/GRASS_LIFE.md §5; docs/WAVE_PLAN6.md §6.1 GL-L). World calls `createLifePart` on the PBR
 * path only (World.life stays null on the Classic path: the Low guard); the part is life/life.ts `WorldLife`.
 */
import { WorldLife } from './life.ts'
import type { LifeHost, LifePart } from './types.ts'

export { WorldLife, LifeGate, LifeMesh, LIFE_COUNTS, LIFE_HABITATS, LIFE_WEATHER, lifePeriod, lifeTargets, noLife } from './life.ts'
export type { LifeInputs, LifePeriod, LifeTargets } from './life.ts'

/** The wildlife of a world: butterflies and dragonflies, birds, fireflies (three meshes, one draw each). */
export function createLifePart(host: LifeHost): LifePart | null {
  return new WorldLife(host)
}

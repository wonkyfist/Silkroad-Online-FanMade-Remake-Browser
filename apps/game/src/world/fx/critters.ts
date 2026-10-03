/**
 * Coast life (docs/COAST.md §8.13 S-LIFE, §10.2, §12.6; docs/WAVE_PLAN6.md D23, lane CST-A): the gull, registered as a
 * species of GRASS_LIFE's one bird mesh (`World.life.addSpecies` / `addHabitat`), and `CoastSea`, the view of the
 * coast field the gulls, the ships (fx/ships.ts) and the surf (audio/coast.ts) read.
 *
 * The gull's habitat (S-LIFE, GRASS_LIFE §8.3):
 * - **flight** over the sea where the water is deeper than GULL_DEEP_M (8 m), the whole circle (GULL_CIRCLE_M around
 *   the centre) included: weight 1;
 * - **passes along the shore** over the sea within GULL_SHORE_BAND_M (30 m) of the waterline: weight 0.6, so a flock
 *   circles within reach of a player on the beach (the life director looks ≤ 75 m around its focus, and on Jangan's
 *   beaches the 8 m line is ≈ 175 m out);
 * - **loafing** on dry sand: land within GULL_SAND_BAND_M (40 m) of the waterline, 2–6 m above the sea level (above
 *   the swash band, within the beaches' ≤ 6 m relief): weight 0.1, which the director lands on but never picks as a
 *   circle centre (it needs > 0.2);
 * - nothing else (0): never inland, never over the shallows between the band and the 8 m line.
 * Gull calls are the `COAST` ambience's (`seabird*.wav`), not a flush sound.
 *
 * Herons and crabs (§10.2) stay GRASS_LIFE candidates: the coast lists them and builds none [decision, COAST §10.2].
 */
import { SroOcean, type LifeHabitat, type LifePart, type LifeSpecies, type World } from '@sro/world-render'

/** The gull's habitat and species ids. */
export const GULL_HABITAT = 'coast-gull'
export const GULL_SPECIES = 'gull'
/** Open flight only over water deeper than this (m). */
export const GULL_DEEP_M = 8
/** The habitat flock's circle radius (life/birds.ts HABITAT_FLOCK: 16 m) plus a margin (m). */
export const GULL_CIRCLE_M = 18
/** Shore passes: over the sea within this of the waterline (m). */
export const GULL_SHORE_BAND_M = 30
/** Loafing: land within this of the waterline (m), between these heights above the sea level (m). */
export const GULL_SAND_BAND_M = 40
export const GULL_SAND_MIN_M = 2
export const GULL_SAND_MAX_M = 6
/** The habitat weights. */
export const GULL_WEIGHT = { deep: 1, shore: 0.6, sand: 0.1 } as const

/** Display sRGB (0..255) to linear, as LifeSpecies carries its colours. */
function lin(r: number, g: number, b: number): [number, number, number] {
  const f = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return [f(r), f(g), f(b)]
}

/** The gull: grey back and wings, white belly, a gull's size (the egret is 2.6) and a slow, shallow flap. */
export const GULL: LifeSpecies = {
  id: GULL_SPECIES,
  kind: 'bird',
  habitat: GULL_HABITAT,
  colors: [lin(146, 154, 164), lin(242, 243, 244)],
  scale: 2.3,
  flap: { hz: 1.7, amplitude: 0.75 },
  max: 8,
}

/** The coast field as the coast's client features read it. */
export interface CoastSea {
  readonly seaLevelM: number
  /** Open sea at (x, z) (the field's sea mask). */
  seaAt(x: number, z: number): boolean
  /** The water depth (m, ≥ 0) at sea; null on land. */
  depthAt(x: number, z: number): number | null
  /** Signed distance to the waterline (m): + at sea, − on land; saturates at ±64 m. */
  shoreDistM(x: number, z: number): number
  /** The ground's height above the sea level (m; − at sea). */
  elevationM(x: number, z: number): number
}

/** A coast field sample (ocean/field.ts FieldSample's fields this reads). */
interface Sample {
  sea: number
  distanceM: number
  elevationM: number
  join: number
}

/** A CoastSea over a field that samples like CoastField (ocean/field.ts). */
export function coastSeaOf(field: { readonly seaLevelM: number; seaAt(x: number, z: number): boolean; sample(x: number, z: number, out?: Sample): Sample }): CoastSea {
  const s: Sample = { sea: 0, distanceM: 0, elevationM: 0, join: 0 }
  return {
    seaLevelM: field.seaLevelM,
    seaAt: (x, z) => field.seaAt(x, z),
    depthAt: (x, z) => (field.seaAt(x, z) ? Math.max(0, -field.sample(x, z, s).elevationM) : null),
    shoreDistM: (x, z) => field.sample(x, z, s).distanceM,
    elevationM: (x, z) => field.sample(x, z, s).elevationM,
  }
}

/** The world's coast field once the ocean has loaded it (null: no coast in this export, or not the FFT ocean part). */
export async function loadCoastSea(world: World): Promise<CoastSea | null> {
  const ocean = world.ocean
  if (!(ocean instanceof SroOcean)) return null
  const field = await ocean.loaded
  return field ? coastSeaOf(field) : null
}

/** True when the whole circle around (x, z) is over water deeper than GULL_DEEP_M. */
export function deepCircle(sea: CoastSea, x: number, z: number, r = GULL_CIRCLE_M): boolean {
  if (!((sea.depthAt(x, z) ?? 0) > GULL_DEEP_M)) return false
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    if (!((sea.depthAt(x + Math.cos(a) * r, z + Math.sin(a) * r) ?? 0) > GULL_DEEP_M)) return false
  }
  return true
}

/** Loafing ground: dry sand near the waterline (land, 2–6 m above the sea, within 40 m of it). */
export function drySand(sea: CoastSea, x: number, z: number): boolean {
  if (sea.seaAt(x, z)) return false
  const e = sea.elevationM(x, z)
  return e >= GULL_SAND_MIN_M && e <= GULL_SAND_MAX_M && -sea.shoreDistM(x, z) <= GULL_SAND_BAND_M
}

/** The gull's habitat over a coast field; `groundAt` gives the loafing height (World.heightAt). */
export function gullHabitat(sea: CoastSea, groundAt: (x: number, z: number) => number | null): LifeHabitat {
  return {
    id: GULL_HABITAT,
    weight(x, z) {
      if (sea.seaAt(x, z)) {
        if (deepCircle(sea, x, z)) return GULL_WEIGHT.deep
        return sea.shoreDistM(x, z) <= GULL_SHORE_BAND_M ? GULL_WEIGHT.shore : 0
      }
      return drySand(sea, x, z) ? GULL_WEIGHT.sand : 0
    },
    landing(x, z) {
      if (!drySand(sea, x, z)) return null
      const y = groundAt(x, z)
      return y === null || !Number.isFinite(y) ? null : y
    },
  }
}

/** Registers the gull on a life part; returns the remover (idempotent). */
export function registerGulls(life: LifePart, sea: CoastSea, groundAt: (x: number, z: number) => number | null): () => void {
  const offHabitat = life.addHabitat(gullHabitat(sea, groundAt))
  const offSpecies = life.addSpecies(GULL)
  let done = false
  return () => {
    if (done) return
    done = true
    offSpecies()
    offHabitat()
  }
}

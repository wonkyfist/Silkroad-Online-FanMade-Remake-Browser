/**
 * Wildlife seams (docs/GRASS_LIFE.md §5, §8.3, GL-0; docs/WAVE_PLAN6.md §4.1 step 2, D23, D25). Written by W10-S;
 * the wildlife itself is GL-L's (`life/{life, butterflies, flock, birds, fireflies, spawn, index}.ts`), the gull
 * species CST-A's (registered through `addSpecies` / `addHabitat`), the flush sound GL-O's (`onFlush`).
 *
 * `World.life` is a world-render part (not a world-screen feature), so the character stage gets it too: made on the
 * PBR path (null on the Classic path, the Low guard), updated after the scatter every frame, disposed with the world.
 * Its meshes carry `metadata.sroWorld = 'life'` (grass/types.ts LIFE_TAG): the region batcher never takes them.
 */
import type { AbstractMesh, Camera, Observable, Scene } from '@babylonjs/core'
import type { World } from '../world.ts'

/** The kinds GRASS_LIFE §5 draws (one mesh and one draw each). */
export type LifeKind = 'butterfly' | 'dragonfly' | 'bird' | 'firefly'

/** Something the wildlife flees (an actor's position, glTF metres: GRASS_LIFE §5.1 reads entities, not the camera). */
export interface LifeThreat {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** The app's threat feed (screens/world.ts: every actor the client knows); called at most once per frame. */
export type LifeThreats = () => readonly LifeThreat[]

/**
 * A species of one of the kinds (GRASS_LIFE §8.3): its colours, scale, flap numbers and the habitat it spawns and
 * lands in. The coast's gull is a 'bird' species of the one bird mesh (D23). GL-L may extend it.
 */
export interface LifeSpecies {
  id: string
  kind: LifeKind
  /** Linear RGB colours (body, wings, marks), as the kind's mesh reads them. */
  colors?: readonly (readonly [number, number, number])[]
  /** Size relative to the kind's default (butterflies are shown 2.2× life size, X11). */
  scale?: number
  /** Wing beats per second and the stroke (rad). */
  flap?: { hz: number; amplitude: number }
  /** The habitat id it lives in (addHabitat). */
  habitat?: string
  /** How many at most (the kind's pool shares it). */
  max?: number
}

/** Where a species spawns, flies and lands (GRASS_LIFE §8.3; the gull's: over water deeper than 8 m, dry sand). */
export interface LifeHabitat {
  id: string
  /** 0..1: how welcome the species is at glTF (x, z) (0: never there). */
  weight(x: number, z: number): number
  /** Where it may land at (x, z): the ground or perch height, or null (no landing there). */
  landing?(x: number, z: number): number | null
  /**
   * Wave 11 (W11-S, TOWN_LIFE §4): the landing is a water surface (the town pond's ducks): the landed birds keep the
   * folded-wing pose and bob on the water, with no pecking hops. Default false (today's loafing).
   */
  float?: boolean
}

/** What `configure` changes (the character stage: no ground flocks, nothing walks into them; D25). */
export interface LifeConfig {
  /** Birds that land and feed on the ground, flushing when walked into (default true). */
  groundFlocks?: boolean
}

/** A flock flushed (GL-O plays one retail bird one-shot at it; muted in rain). */
export interface LifeFlush {
  x: number
  y: number
  z: number
  /** Birds that took off. */
  count: number
}

/** GL-L's wildlife part (World.life). */
export interface LifePart {
  /** Options → Wildlife (W10-G): off hides every animal and stops the updates (the part stays). */
  readonly enabled: boolean
  setEnabled(on: boolean): void
  configure(config: LifeConfig): void
  /** The actors the animals flee (null: none). */
  setThreats(fn: LifeThreats | null): void
  /** Registers a species / habitat (CST-A's gull); returns a remover. */
  addSpecies(def: LifeSpecies): () => void
  addHabitat(rule: LifeHabitat): () => void
  /** Where the animals live around (default: World's focus each frame). */
  setFocus(x: number, z: number): void
  /** Per frame, after the scatter (World.update). */
  update(camera: Camera | null, dt: number): void
  /** Every mesh it draws (tagged 'life'). */
  meshes(): AbstractMesh[]
  readonly onFlush: Observable<LifeFlush>
  dispose(): void
}

/** What the wildlife is built from (World passes itself: sky state, weather frame, scatter `adopt`, placements). */
export interface LifeHost {
  readonly scene: Scene
  readonly world: World
}

/** Makes the wildlife part (life/index.ts `createLifePart`; LoadWorldOptions.parts.life in tests). null: none. */
export type LifeFactory = (host: LifeHost) => LifePart | null

/**
 * Town-life seams (docs/TOWN_LIFE.md §2.3, §3.6, §8; docs/WAVE_PLAN7.md §4.3 step 1, D2, D17, D19). Written by W11-S;
 * the crowd itself is TL-C's (`town/{crowd, animals, bubbles, props, index}.ts`), the pure schedule TL-R's
 * (`town/schedule.ts`), the motion layers TL-M's (`town/{cloth-chunk, fx}.ts`).
 *
 * `World.town` is a world-render part like `World.life` (so the character stage and the viewer get townsfolk too):
 * made on the PBR path only (**null on Low/Classic: the Low guard**), updated once per frame after the life part,
 * disposed with the world (before the life part it registers species with), dropped and made again by
 * `World.setRenderMode`. Its meshes carry `metadata.sroWorld = 'town'` (TOWN_TAG), a tag the region batcher refuses
 * (batch/types.ts UNBATCHED_TAGS), and `isPickable = false`, so click-to-move rays pass through the crowd.
 *
 * The app wires it (apps/game world/graphics.ts, screens/world.ts; W11-G): the clock (`serverNow() / 1000`, the server's
 * real seconds, TOWN_LIFE §2.2), the threats (the same feed as `World.life`), the count scale and the alarm. A part made
 * again by a path switch is wired again by the app, as the life part is.
 */
import type { AbstractMesh, Camera, Scene } from '@babylonjs/core'
import type { LifeThreats } from '../life/types.ts'
import type { World } from '../world.ts'

/** The world tag of every town mesh (`mesh.metadata.sroWorld`): the batcher never takes it (UNBATCHED_TAGS). */
export const TOWN_TAG = 'town'

/** Options → Graphics → Town life (TOWN_LIFE §8.2, WAVE_PLAN7 D10): Low halves the preset's counts, Off hides it. */
export type TownLifeLevel = 'off' | 'low' | 'full'

/** The count scale of a Town life level (TOWN_LIFE §8.2): Full 1, Low 0.5, Off 0. */
export function townCountScale(level: TownLifeLevel): number {
  return level === 'full' ? 1 : level === 'low' ? 0.5 : 0
}

/** A circle townsfolk never enter (glTF metres; the character stage's palace steps, D17). */
export interface TownCircle {
  x: number
  z: number
  r: number
}

/** What `configure` changes; absent keys keep their value. */
export interface TownConfig {
  /** The crowd's count scale (townCountScale: Town life Low 0.5, Full 1); the preset's counts × this. */
  counts?: number
  /** Where no townsperson walks or stands (the stage's `noFolk` circle); null: nowhere. */
  noFolk?: TownCircle | readonly TownCircle[] | null
}

/** The shared server clock in seconds (`serverNow() / 1000`, TOWN_LIFE §2.2); the stage and the viewer pass their own. */
export type TownClock = () => number

/** What the townsfolk step aside from and the pigeons flee: the app's actors (the life part's feed, LifeThreats). */
export type TownThreats = LifeThreats

/** TL-C's town part (World.town). */
export interface TownPart {
  /** Off hides every townsperson and animal and stops the updates (the part stays; Town life: Off). */
  readonly enabled: boolean
  setEnabled(on: boolean): void
  /** The server clock in seconds (null: the page's own clock). */
  setClock(fn: TownClock | null): void
  /** The actors the crowd sidesteps and the pigeons flee (null: none). */
  setThreats(fn: TownThreats | null): void
  configure(config: TownConfig): void
  /**
   * The unique's appear notice (UNIQUES §3.3, WAVE_PLAN7 D19): from server second `nowS`, for `sec` seconds, walkers
   * hurry to the nearest door or eave, vendors stay, guard pairs walk to the south gate; then the schedule again.
   */
  alarm(nowS: number, sec: number): void
  /** Per frame, after the life part (World.update). */
  update(camera: Camera | null, dt: number): void
  /** Every mesh it draws (tagged 'town', not pickable). */
  meshes(): AbstractMesh[]
  /** Counters for the lab panel and the bench (folk, animals, draws, …). */
  stats(): Readonly<Record<string, number>>
  /**
   * H11-HI-1: settles once the town's plan and drawables are in (or there is no town, or they failed, or the part was
   * disposed): the world screen's entry warm-up waits for it with the other parts, so the crowd compiles there.
   */
  readonly loaded?: Promise<void>
  dispose(): void
}

/** What the town part is built from (World passes itself: its clock, quality, life part, water, render, focus). */
export interface TownHost {
  readonly scene: Scene
  readonly world: World
}

/** Makes the town part (town/index.ts `createTownPart`; LoadWorldOptions.parts.town in tests). null: none. */
export type TownFactory = (host: TownHost) => TownPart | null

/** True for a mesh tagged 'town'. */
export function isTownMesh(mesh: { metadata?: unknown } | null | undefined): boolean {
  return (mesh?.metadata as { sroWorld?: unknown } | null | undefined)?.sroWorld === TOWN_TAG
}

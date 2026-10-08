/**
 * The high country's notices (docs/CLIMB.md §2.7, D52; build plan §20 layer L2). A GameplayModule named `climbPlaces`,
 * only with CLIMB on. The Ferry Heights (B7: the ferry landing, Jangan Ferry, and the ridge above it) and the Sea
 * Cliffs (B8) are places on the island's own heights (CLIMB_PLACES, by region; B7 also by its area): walking in shows
 * an area line with the band's levels, and a player below the band's first level gets the warning line "The Ferry
 * Heights are no place for the green, traveller." (below 19) or the Sea Cliffs' (below 22), once per visit (a visit
 * ends when the player is out of the place). No ferry, no crossing cost, no new nav component (§2.7).
 */
import { CLIMB_BANDS, climbBandAt, type ClimbBand } from '@sro/shared'
import { regionAt } from '../content.ts'
import type { Gameplay } from '../gameplay.ts'
import type { GameplayModule } from '../modules.ts'
import type { Player } from '../world.ts'

/** How often a player's place is looked at (ms). */
export const CLIMB_PLACE_CHECK_MS = 1000
/** The bands that are the high country. */
const HIGH: ReadonlySet<string> = new Set(['B7', 'B8'])

/** The high-country band at glTF x/z (null elsewhere). */
export function highCountryAt(g: Pick<Gameplay, 'data' | 'setup'>, x: number, z: number): ClimbBand | null {
  const r = regionAt(g.setup.regionOrigin, x, z)
  if (!r) return null
  const band = climbBandAt(g.data.zones.get(r.id)?.name ?? null, r)
  return band && HIGH.has(band.id) ? band : null
}

/** The lines a player of `level` sees on entering `band` (§2.7). */
export function highCountryLines(band: ClimbBand, level: number): string[] {
  const lines = [`You enter ${band.name.replace(/^The /, 'the ')} (levels ${band.levels[0]}–${band.levels[1]}).`]
  if (level < band.levels[0]) lines.push(`${band.name} ${band.name.endsWith('s') ? 'are' : 'is'} no place for the green, traveller.`)
  return lines
}

export class ClimbPlaces implements GameplayModule {
  readonly name = 'climbPlaces'
  readonly handles = [] as const
  /** player entity id -> the band it is in ('' = none) and when it was last looked at. */
  private readonly at = new Map<number, { band: string; next: number }>()

  constructor(readonly g: Gameplay) {}

  tickPlayer(p: Player, now: number): void {
    if (this.g.config.climb !== true || p.dead) return
    const s = this.at.get(p.id)
    if (s && now < s.next) return
    const [x, , z] = this.g.world.positionAt(p, now)
    const band = highCountryAt(this.g, x, z)
    const id = band?.id ?? ''
    if (!s) {
      // the first look after entering the world: no notice for where the player logged in
      this.at.set(p.id, { band: id, next: now + CLIMB_PLACE_CHECK_MS })
      return
    }
    s.next = now + CLIMB_PLACE_CHECK_MS
    if (s.band === id) return
    s.band = id
    if (band) for (const text of highCountryLines(band, p.level)) p.send({ t: 'chat', channel: 'system', text })
  }

  forget(p: Player): void {
    this.at.delete(p.id)
  }
}

/** For tests and the GM: the bands of the high country. */
export const HIGH_COUNTRY_BANDS = CLIMB_BANDS.filter((b) => HIGH.has(b.id))

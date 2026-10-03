/**
 * The character list's location (connection.ts locationOf -> GameData.zoneName) says what the client's HUD and minimap
 * say (apps/game world/map/zones.ts ZoneIndex.nameAt): the region's own name, else the nearest named neighbour, in the
 * majority spelling. P-DATA (wave 10r polish): a character saved on the south beach read "Jangan" in the list while
 * the HUD said "Lake Forest"; zones.json now names the coast regions ('Jangan South Beach') and both sides agree.
 */
import { describe, expect, it } from 'vitest'
import type { ZoneDef } from '@sro/shared'
import { GameData } from '../src/gamedata.ts'

const zone = (rx: number, rz: number, name: string): ZoneDef => ({ region: (rz << 8) | rx, rx, rz, name, area: null, continent: null })
const origin = { ox: 168, oz: 97 }
/** The centre of region (rx, rz) in world metres (x east, z south). */
const centre = (rx: number, rz: number) => ({ x: (rx - origin.ox + 0.5) * 192, z: -(rz - origin.oz + 0.5) * 192 })

describe('zone names on the server match the client (P-DATA)', () => {
  it('names the S1 beach by its coast area, and a nameless region by its nearest named neighbour', () => {
    const data = new GameData({
      zones: [zone(170, 90, 'Jangan South Beach'), zone(170, 91, 'Lake Forest'), zone(171, 91, 'Chinese tomb'), zone(172, 91, 'Chinese Tomb'),
        zone(173, 91, 'Chinese Tomb'), zone(174, 91, ''), zone(174, 92, 'Chinese Tomb')],
    })
    const beach = centre(170, 90)
    expect(data.zoneName(beach.x, beach.z, origin)).toBe('Jangan South Beach')
    // 171_91 is spelled 'Chinese tomb' in the client data; the majority spelling wins, as on the HUD
    const tomb = centre(171, 91)
    expect(data.zoneName(tomb.x, tomb.z, origin)).toBe('Chinese Tomb')
    // nameless 174_91: the nearest named neighbour to the point (173_91 to the west, 174_92 to the north)
    const west = centre(174, 91)
    expect(data.zoneName(west.x - 80, west.z, origin)).toBe('Chinese Tomb')
    // nothing named within one region: ''
    const far = centre(160, 95)
    expect(data.zoneName(far.x, far.z, origin)).toBe('')
    expect(data.zoneName(beach.x, beach.z, null)).toBe('')
  })
})

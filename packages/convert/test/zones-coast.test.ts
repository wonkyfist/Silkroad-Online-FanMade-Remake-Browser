/**
 * The coast's area names in zones.json (data/zones.ts coastAreaNamer, P-DATA wave 10r polish): the regions the coast
 * shapes and the client has no name for read as their coast section's area, so the character list, the HUD and the
 * minimap say 'Jangan South Beach' on the S1 beach instead of the town name or the nearest retail zone.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildZones, coastAreaNamer } from '../src/data/zones.ts'
import { parseCoastConfig } from '../src/world/coast/config.ts'
import { configDrowns } from '../src/world/coast/drown.ts'
import { REPO_ROOT } from '../src/node-io.ts'

const cfg = parseCoastConfig(readFileSync(join(REPO_ROOT, 'content', 'coast', 'coast.json'), 'utf8'))
const play = { x0: 156, x1: 174, z0: 90, z1: 102 }
const name = coastAreaNamer(cfg, play)

describe('coast area names (P-DATA)', () => {
  it('every coast section has a player-facing area name', () => {
    for (const s of cfg.sections) expect(s.area, s.code).toMatch(/^[A-Z]/)
    expect(new Set(cfg.sections.map(s => s.area)).size).toBe(cfg.sections.length)
  })

  it('names the S1 height patch row, the ring and the synthetic sea by their sections; never the playable land or the corridor', () => {
    for (let x = 165; x <= 174; x++) expect(name(x, 90, false), `${x}_90`).toBe('Jangan South Beach')
    expect(name(170, 91, false)).toBeNull() // playable, outside the patches: the client's own name or a neighbour's
    expect(name(160, 95, false)).toBeNull()
    expect(name(170, 89, false)).toBe('Jangan South Beach') // the ring in front of S1
    expect(name(160, 87, true)).toBe('Tiger Beach')
    expect(name(175, 95, false)).toBe('East Shelf Beach')
    expect(name(176, 104, true)).toBe('Qin-Shi Tomb Beach')
    expect(name(166, 104, true)).toBe('Jangan Bay')
    expect(name(155, 99, false)).toBeNull() // Option A's corridor (drowned now: buildZones clears it, below)
    expect(name(154, 93, true)).toBe('Western Strait')
    // the sections whose line lies in the drowned area name nothing (N1, N2, A-S, A-N): the nearest kept section does
    for (const [x, z] of [[158, 104], [162, 104], [153, 95], [150, 104]]) {
      expect(['Western China Beach', 'Spur Cove', 'Canyon Beach', 'Northern Road Beach']).not.toContain(name(x, z, true))
    }
  })

  it('drowns the Western China side and the land bridge toward Donwhang, whole regions, never Jangan land (COAST §4.1)', () => {
    // Donwhang town (153, 102-103), the Entrance, the Western China Ferry, Main Road and Ruins, Earth Ghost Canyon
    for (const [x, z] of [[153, 102], [153, 103], [155, 102], [156, 101], [158, 99], [160, 102], [161, 100], [154, 97], [162, 101]]) {
      expect(configDrowns(cfg, x, z), `${x}_${z}`).toBe(true)
    }
    // Jangan: the town, the ferry shore, North-Tiger Mt., Yeoha's Forest, the bay, the Western Strait coast
    for (const [x, z] of [[168, 97], [158, 96], [161, 97], [157, 95], [162, 98], [163, 99], [165, 103], [155, 93], [154, 91]]) {
      expect(configDrowns(cfg, x, z), `${x}_${z}`).toBe(false)
    }
  })

  it('buildZones gives a drowned region no name, area, continent or town', () => {
    const header = ['//Service', 'CodeName128', 'x', 'x', 'x', 'x', 'x', 'x', 'English']
    const row = (id: number, en: string) => ['1', String(id), 'k', '', '', '', '', '', en]
    const zones = buildZones({
      regions: [{ x: 153, z: 102 }, { x: 158, z: 99 }, { x: 158, z: 96 }],
      zoneNames: [row((102 << 8) | 153, 'Western China Donwhang'), row((99 << 8) | 158, 'Western China Ferry'), row((96 << 8) | 158, 'Jangan Ferry')],
      zoneHeader: header,
      refregion: [[String((102 << 8) | 153), '153', '102', 'West_China', 'Town_Dunhwang'], [String((96 << 8) | 158), '158', '96', 'CHINA', '???']],
      towns: [{ code: 'DUNHWANG', regions: [(102 << 8) | 153] }],
      coastArea: name,
      drowned: (x, z) => configDrowns(cfg, x, z),
    })
    expect(zones.map(z => [z.name, z.area, z.continent, z.town ?? null])).toEqual([
      ['', null, null, null], ['', null, null, null], ['Jangan Ferry', null, 'CHINA', null],
    ])
  })

  it('buildZones keeps the client name and fills only the nameless regions', () => {
    const header = ['//Service', 'CodeName128', 'x', 'x', 'x', 'x', 'x', 'x', 'English']
    const row = (id: number, en: string) => ['1', String(id), 'k', '', '', '', '', '', en]
    const zones = buildZones({
      regions: [{ x: 170, z: 90 }, { x: 170, z: 91 }, { x: 160, z: 87, synthetic: true }, { x: 158, z: 89 }, { x: 171, z: 91 }],
      zoneNames: [row((91 << 8) | 170, 'Lake Forest'), row((89 << 8) | 158, 'South-Tiger Mt.')],
      zoneHeader: header,
      refregion: [],
      coastArea: name,
    })
    expect(zones.map(z => z.name)).toEqual(['Jangan South Beach', 'Lake Forest', 'Tiger Beach', 'South-Tiger Mt.', ''])
  })
})

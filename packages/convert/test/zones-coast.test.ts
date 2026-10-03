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
    expect(name(155, 99, false)).toBeNull() // Option A's corridor is land
    expect(name(154, 93, true)).toBe('Western Strait')
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

/**
 * content/coast/coast.json and its validator (docs/COAST.md §5.2 with the §3B beaches block; WAVE_PLAN6 CST-C port):
 * the shipped file validates, keeps the §3B.1 section table and the §3B.2 kinds, covers every sea side of the
 * playable rectangle exactly once, splits the phases as the plan does, and the validator names what is wrong.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import { parseCoastConfig, validateCoastConfig, type CoastConfig } from '../src/world/coast/config.ts'

const text = readFileSync(join(REPO_ROOT, 'content', 'coast', 'coast.json'), 'utf8')
const cfg = parseCoastConfig(text)
const fresh = () => JSON.parse(text) as CoastConfig

describe('content/coast/coast.json', () => {
  it('validates', () => {
    expect(validateCoastConfig(JSON.parse(text))).toEqual([])
  })
  it('holds the user\'s choices and the plan\'s defaults', () => {
    expect(cfg.seed).toBe(1188)
    expect(cfg.seaLevelM).toBe(5)
    expect(cfg.option).toBe('A')
    expect(cfg.phase).toBe(2)
    expect(cfg.domain).toEqual({ x: [150, 177], z: [86, 105] })
    expect(cfg.holeBelowM).toBe(-100)
    expect(cfg.flank.inSlope).toEqual([-0.9, 0.9])
    expect(cfg.tombKeep).toMatchObject({ x: [171.25, 173.75], beyondCrestM: 24, continueFace: true })
    expect(cfg.paint).toMatchObject({ grassMaxDeg: 38, rockFromDeg: 45 })
    // S2-bank (W10R CST-H2): the dry retail river channel of 166_90 next to S1 joins the river as water (coast/banks.ts)
    expect(cfg.allowHeightPatches).toEqual([
      { name: 'S1', x: [165.35, 175], z: [90, 90.95], maxHeightM: 6, feather: 'inward' },
      { name: 'S2-bank', x: [165.35, 166.5], z: [90.95, 91], maxHeightM: 6, feather: 'inward' },
    ])
    expect(cfg.places).toEqual([{ name: 'beach-south', x: 170.5, z: 90.6 }])
  })
  it('every section is a beach (no cliff kind), with the §3B.2 table', () => {
    expect(Object.keys(cfg.beachKinds).sort()).toEqual(['bay', 'baymouth', 'mountain', 'mouth', 'strait', 'walk', 'wide'])
    expect(cfg.beachKinds.wide).toEqual({ width: 90, dune: 5, dry: 2.4, grade: 0.45, depth: [4, 18, 35] })
    expect(cfg.beachKinds.mountain).toEqual({ width: 48, dune: 4, dry: 2, grade: 0.6, depth: [9, 24, 40] })
    const deg = (g: number) => Math.round((Math.atan(g) * 180) / Math.PI * 10) / 10
    expect([...new Set(Object.values(cfg.beachKinds).map(k => deg(k.grade)))].sort()).toEqual([24.2, 26.6, 31])
    const kinds = Object.fromEntries(cfg.sections.map(s => [s.code, s.kind]))
    expect(kinds).toEqual({
      N1: 'wide', N2: 'mountain', N3: 'baymouth', N4: 'bay', N5: 'wide', E1: 'wide', E2: 'bay', E3: 'wide', S1: 'walk',
      S2: 'mouth', S3: 'mountain', S4: 'mountain', W1: 'mountain', W2: 'strait', 'A-S': 'mountain', 'A-N': 'wide',
    })
  })
  it('covers each side of the playable rectangle (x 156-174, z 90-102) exactly once', () => {
    const cover = (side: string) => cfg.sections.filter(s => s.side === side).flatMap(s => {
      const out: number[] = []
      for (let t = s.from; t <= s.to; t++) out.push(t)
      return out
    }).sort((a, b) => a - b)
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
    expect(cover('north')).toEqual(range(156, 174))
    expect(cover('south')).toEqual(range(156, 174))
    expect(cover('east')).toEqual(range(90, 102))
    expect(cover('west')).toEqual(range(90, 96))
    expect(cover('corridor-south')).toEqual(range(146, 155))
    expect(cover('corridor-north')).toEqual(range(146, 155))
  })
  it('splits the phases as WAVE_PLAN6 §6.0: E, S, NE first; W, NW and the corridor second', () => {
    const phase2 = cfg.sections.filter(s => s.phase === 2).map(s => s.code).sort()
    expect(phase2).toEqual(['A-N', 'A-S', 'N1', 'N2', 'W1', 'W2'])
  })
  it('the paint palette names the sand, wet sand and rock tiles, and no cliff tile', () => {
    const tiles = cfg.paint.palette.map(p => p.tile)
    // X2: the wet sand is the sea bed's tile 154 (the tile-70 remaster read as a grey strip on PBR)
    for (const t of [407, 412, 154, 226]) expect(tiles).toContain(t)
    expect(cfg.paint.palette.find(p => p.name === 'wet-sand')!.tile).toBe(154)
    expect(tiles).not.toContain(278)
    expect(cfg.paint.palette.filter(p => p.typeName === 'Sand').map(p => p.tile)).toEqual([407, 412])
  })
})

describe('validateCoastConfig', () => {
  it('rejects a non-object and a wrong format', () => {
    expect(validateCoastConfig(null)).toEqual(['coast: not an object'])
    const m = fresh() as unknown as Record<string, unknown>
    m.format = 'x'
    expect(validateCoastConfig(m)).toEqual(['format: expected sro-coast'])
  })
  it('names bad sections', () => {
    const m = fresh()
    m.sections[0]!.kind = 'cliff'
    m.sections[1]!.code = m.sections[0]!.code
    m.sections[2]!.from = 170
    ;(m.sections[3] as { side: string }).side = 'up'
    const errs = validateCoastConfig(m)
    expect(errs).toContain('sections[0].kind: expected a key of beachKinds')
    expect(errs).toContain('sections[1].code: duplicate N1')
    expect(errs).toContain('sections[2].from/to: expected integers from <= to')
    expect(errs.some(e => e.startsWith('sections[3].side'))).toBe(true)
  })
  it('names bad kinds, flank, patches, paint and places', () => {
    const m = fresh()
    m.beachKinds.wide!.depth = [18, 4, 35]
    m.beachKinds.bay!.dry = 9
    m.flank.inSlope = [1, -1]
    m.allowHeightPatches[0]!.feather = 'out' as 'inward'
    m.paint.grassMaxDeg = 50
    m.places[0]!.name = 'Beach South'
    m.holeBelowM = 10
    m.corridor = null
    const errs = validateCoastConfig(m)
    for (const e of [
      'beachKinds.wide.depth: expected three non-decreasing depths', 'beachKinds.bay: dry sand above the dune crest',
      'flank.inSlope: expected [min, max]', 'allowHeightPatches[0]: expected {name, x, z, maxHeightM, feather}',
      'paint: expected grassMaxDeg < rockFromDeg', 'places: expected [{name (a tp name), x, z}]',
      'holeBelowM: expected a negative number', 'corridor: option A needs the corridor',
    ]) expect(errs).toContain(e)
  })
  it('names bad area names and placement lists (P-DATA)', () => {
    const m = fresh()
    m.sections[0]!.area = '<b>Beach</b>'
    m.placements.drop = [{ region: 1, uid: 2, note: '' }]
    m.placements.accept = [{ region: 3, uid: 4, note: 'ok' }, { region: 3, uid: 4, note: 'again' }]
    const errs = validateCoastConfig(m)
    expect(errs.some(e => e.startsWith('sections[0].area'))).toBe(true)
    expect(errs).toContain('placements.drop[0]: expected {region, uid, note}')
    expect(errs).toContain('placements.accept[1]: placement 3:4 listed twice')
  })
  it('parseCoastConfig throws with the list', () => {
    expect(() => parseCoastConfig('{"format":"sro-coast"}')).toThrow(/coast.json invalid:\n {2}version/)
  })
})

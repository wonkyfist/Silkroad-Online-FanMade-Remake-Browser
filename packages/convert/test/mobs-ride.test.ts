/**
 * W11-CV (docs/WAVE_PLAN7.md §4.5, docs/UNIQUES.md §2.2): `MobDef.ride` from skilleffect.txt characterInfo's `ride`
 * column, checked against the ride's skeleton.
 * - a row with a ride whose skeleton has `saddle` -> `ride = {model, joint: 'saddle'}` (the ride's BSR is in `models`);
 * - a ride without the joint, without a converted glb or with an unknown skeleton -> a warning and no field;
 * - the real client (skips without sro.config.json / work/out): exactly one exported mob rides, Tiger Girl on
 *   bluetiger.bsr, and its sidecar has the `saddle` joint; a re-converted mobs.json carries that one ride only.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { characterDataRow, loadTextdataTable, type CharacterDataRow, type TextdataRow } from '@sro/formats'
import { CONTENT_FILES, contentEntries, type MobDef } from '../../shared/src/index.ts'
import { buildMobDef, characterRides, RIDE_JOINT, type MobContext } from '../src/data/mobs.ts'
import { textdataReader } from '../src/data/textdata-source.ts'
import { loadConfig, openArchive, REPO_ROOT } from '../src/node-io.ts'

const row = (cells: string[]): TextdataRow => ({ file: 't.txt', line: 1, cells })

function charCells(code: string, id: number, typeId: [number, number, number, number], extra: Record<number, string> = {}): string[] {
  const c = Array.from({ length: 104 }, () => '0')
  Object.assign(c, { 0: '1', 1: String(id), 2: code, 3: 'xxx', 4: 'xxx', 5: 'SN_' + code, 6: 'xxx', 9: String(typeId[0]), 10: String(typeId[1]), 11: String(typeId[2]), 12: String(typeId[3]) })
  for (let i = 32; i <= 38; i += 2) c[i] = '-1'
  Object.assign(c, { 48: '100', 52: 'xxx', 53: 'xxx', 54: 'xxx', 55: 'xxx', 56: 'xxx' })
  return Object.assign(c, extra)
}

/** skilleffect.txt as client-source loads it (raw cells): a characterInfo section with Tiger Girl and one ride-less mob. */
const SKILLEFFECT: string[][] = [
  ['#section', 'characterInfo'],
  ['MOB_CH_TIGERWOMAN', 'TIGERWOMAN', '2', 'none', 'res\\mob\\china\\bluetiger.bsr', 'xxx', 'xxx', 'xxx', '0,15,-30', 'hit_2_redblood', 'xxx', '0', 'xxx'],
  ['MOB_CH_MANGNYANG', 'MANGNYANG', '1', 'none', 'xxx', 'res\\mob\\common\\mangnyang_die.bsr', 'xxx', 'xxx', '0,5,0', 'hit_2_redblood', 'xxx', '0', 'xxx'],
  ['#section', 'skillaniset2'],
  ['1', 'MOB_CH_FAKE', 'MOB_CH_FAKE', '0', 'TRUE', 'res\\mob\\china\\fake_ride.bsr'],
]

const TIGER_JOINTS = ['Bip02', 'Bip02 Pelvis', 'Bip02 Spine', RIDE_JOINT, 'Bip02 Tail']

function ctx(over: Partial<MobContext> = {}): MobContext {
  const tiger = characterDataRow(row(charCells('MOB_CH_TIGERWOMAN', 1954, [1, 2, 1, 1], { 52: 'mob\\china\\tigerwoman.bsr', 57: '20' })))
  const mang = characterDataRow(row(charCells('MOB_CH_MANGNYANG', 1907, [1, 2, 1, 1], { 52: 'mob\\china\\mangnyang.bsr' })))
  const byCode = new Map<string, CharacterDataRow>([[tiger.codeName, tiger], [mang.codeName, mang]])
  return {
    byCode,
    skillsById: new Map(),
    strings: new Map(),
    exists: () => true,
    hasData: () => false,
    nests: [],
    portMobs: [],
    rides: characterRides(SKILLEFFECT),
    jointsOf: url => (url === '/out/mob/china/bluetiger.json' ? TIGER_JOINTS : null),
    ...over,
  }
}

describe('characterRides', () => {
  it('reads the ride column of the characterInfo section only, relative to res/', () => {
    const rides = characterRides(SKILLEFFECT)
    expect([...rides]).toEqual([['MOB_CH_TIGERWOMAN', 'mob/china/bluetiger.bsr']])
  })
})

describe('buildMobDef ride', () => {
  it('a row with a ride whose skeleton has the saddle -> MobDef.ride with joint saddle', () => {
    const b = buildMobDef('MOB_CH_TIGERWOMAN', ctx())
    expect(b.mob.ride).toEqual({
      model: { bsr: 'res/mob/china/bluetiger.bsr', glb: '/out/mob/china/bluetiger.glb', sidecar: '/out/mob/china/bluetiger.json' },
      joint: 'saddle',
    })
    expect(b.models).toContain('res/mob/china/bluetiger.bsr')
    expect(b.warnings).toEqual([])
    expect((b.mob.fieldSources as Record<string, string>).ride).toMatch(/characterInfo ride/)
    // a sibling of championModel: the mob's own model is untouched
    expect(b.mob.model?.bsr).toBe('res/mob/china/tigerwoman.bsr')
  })

  it('a mob without a ride has no field and no warning', () => {
    const b = buildMobDef('MOB_CH_MANGNYANG', ctx())
    expect('ride' in b.mob).toBe(false)
    expect(b.warnings).toEqual([])
  })

  it('a ride without the saddle joint -> a warning and no field', () => {
    const b = buildMobDef('MOB_CH_TIGERWOMAN', ctx({ jointsOf: () => ['Bip02', 'Bip02 Pelvis'] }))
    expect('ride' in b.mob).toBe(false)
    expect(b.warnings).toHaveLength(1)
    expect(b.warnings[0]).toMatch(/no 'saddle' joint/)
    // the ride's model is still listed for conversion
    expect(b.models).toContain('res/mob/china/bluetiger.bsr')
  })

  it('a ride that is not converted, or whose skeleton is unknown -> a warning and no field', () => {
    const notConverted = buildMobDef('MOB_CH_TIGERWOMAN', ctx({ exists: url => !url.includes('bluetiger') }))
    expect('ride' in notConverted.mob).toBe(false)
    expect(notConverted.warnings[0]).toMatch(/not converted/)
    const unknown = buildMobDef('MOB_CH_TIGERWOMAN', ctx({ jointsOf: () => null }))
    expect('ride' in unknown.mob).toBe(false)
    expect(unknown.warnings[0]).toMatch(/skeleton is unknown/)
    const { jointsOf: _drop, ...noProbe } = ctx()
    const absent = buildMobDef('MOB_CH_TIGERWOMAN', noProbe)
    expect('ride' in absent.mob).toBe(false)
    expect(absent.warnings[0]).toMatch(/skeleton is unknown/)
  })

  it('without a rides map nothing changes (older callers)', () => {
    const { rides: _r, ...noRides } = ctx()
    const b = buildMobDef('MOB_CH_TIGERWOMAN', noRides)
    expect('ride' in b.mob).toBe(false)
    expect(b.warnings).toEqual([])
    expect(b.models).toEqual(['res/mob/china/tigerwoman.bsr'])
  })
})

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const workDir = hasConfig ? loadConfig().workDir : ''
const mobsFile = hasConfig ? join(workDir, 'out', 'data', CONTENT_FILES.mobs) : ''
const hasOut = hasConfig && existsSync(mobsFile)

describe.skipIf(!hasOut)('the real export (vSRO 1.188 skilleffect.txt + work/out)', () => {
  it('has exactly one ride among the exported mobs: Tiger Girl on bluetiger.bsr, whose skeleton has the saddle', () => {
    const cfg = loadConfig()
    const skilleffect = loadTextdataTable('skilleffect.txt', textdataReader(openArchive('Media', cfg))).rows.map(r => r.cells)
    const rides = characterRides(skilleffect)
    // other characterInfo rows ride too (Uruchi and three others, UNIQUES F20), but none is an exported mob
    expect(rides.size).toBeGreaterThan(1)
    const mobs = contentEntries<MobDef>(JSON.parse(readFileSync(mobsFile, 'utf8')))
    const exported = mobs.filter(m => rides.has(m.code)).map(m => [m.code, rides.get(m.code)])
    expect(exported).toEqual([['MOB_CH_TIGERWOMAN', 'mob/china/bluetiger.bsr']])
    const sidecar = join(workDir, 'out', 'mob', 'china', 'bluetiger.json')
    const joints = (JSON.parse(readFileSync(sidecar, 'utf8')) as { skeleton: { joints: string[] } }).skeleton.joints
    expect(joints).toContain(RIDE_JOINT)
    // after the X1 data re-convert mobs.json carries the field; before it, none (old exports keep loading)
    const withRide = mobs.filter(m => (m as MobDef & { ride?: unknown }).ride !== undefined)
    expect(withRide.length).toBeLessThanOrEqual(1)
    for (const m of withRide) {
      expect(m.code).toBe('MOB_CH_TIGERWOMAN')
      expect((m as MobDef & { ride?: unknown }).ride).toEqual({
        model: { bsr: 'res/mob/china/bluetiger.bsr', glb: '/out/mob/china/bluetiger.glb', sidecar: '/out/mob/china/bluetiger.json' },
        joint: 'saddle',
      })
    }
  })
})

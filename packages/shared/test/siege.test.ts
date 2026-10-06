/**
 * Siege of Jangan, the walls' shared rules (docs/SIEGE.md §2.2, §2.3, §2.5, §4.2, §11.2, §14 "Unit"): stages and the
 * +5 % hysteresis, the natural-wear floor, the nav of each stage, breach zones, settings bounds and patches, the export
 * check, the nav state that both sides apply, and the wire messages.
 */
import { describe, expect, it } from 'vitest'
import {
  WALL_DEFAULTS,
  WallNavState,
  breachZones,
  checkWallSettings,
  checkWallsExport,
  clampIp,
  crackLevel,
  inBreachZone,
  lightningIp,
  outerFaceDistance,
  parseServerMessage,
  segmentAt,
  thirdsDown,
  wallNav,
  wallPct,
  wallSettings,
  wallStage,
  wearIp,
  type WallStage,
  type WallsExport,
  type WallsSegment,
} from '../src/index.ts'

const S = WALL_DEFAULTS
const ip = (pct: number) => Math.round((pct / 100) * S.maxIp)

/** A West wall of two segments (z 0..48 and 48..96, thirds of 16 m), body x -16..0 (outer at -16). */
function walls(): WallsExport {
  const seg = (id: string, from: number, base: number): WallsSegment => ({
    id, side: 'W', from, to: from + 48,
    thirds: [0, 1, 2].map((k) => ({
      id: `${id}${'abc'[k]}`, from: from + 16 * k, to: from + 16 * (k + 1),
      instances: [base + k], tiles: [[0x6000, base * 10 + k], [0x6000, 7]], assault: [-18, 0, from + 16 * k + 8], rally: [10, 0, from + 16 * k + 8],
    })) as WallsSegment['thirds'],
  })
  return {
    version: 1, world: 'test', plan: { file: 'content/siege/jangan.json', hash: 'x' }, navFile: 'siege/walls-nav.bin',
    sides: [{
      side: 'W', axis: 'z', line: -8, outer: -16, inner: 0, out: -1, walkY: 20,
      placement: { region: 0x6000, uid: 1, source: 'w', position: [-8, 0, 48] }, retailInstance: 99, fixed: [],
    }],
    segments: [seg('W1', 0, 10), seg('W2', 48, 20)],
  }
}

describe('wallStage and the integrity scale', () => {
  it('intact above 70 %, cracked down to 0, breached to -50 %, rubble at the bottom', () => {
    expect(wallStage(ip(100), S)).toBe('intact')
    expect(wallStage(ip(70) + 1, S)).toBe('intact')
    expect(wallStage(ip(70), S)).toBe('cracked')
    expect(wallStage(1, S)).toBe('cracked')
    expect(wallStage(0, S)).toBe('breached')
    expect(wallStage(ip(-49), S)).toBe('breached')
    expect(wallStage(ip(-50), S)).toBe('rubble')
  })

  it('closes only above +5 % (the hysteresis), going down it breaks at 0', () => {
    expect(wallStage(ip(3), S, 'breached')).toBe('breached')
    expect(wallStage(ip(5), S, 'breached')).toBe('breached')
    expect(wallStage(ip(5) + 1, S, 'breached')).toBe('cracked')
    expect(wallStage(ip(3), S, 'rubble')).toBe('breached')
    expect(wallStage(ip(-49), S, 'rubble')).toBe('breached')
    expect(wallStage(ip(3), S, 'cracked')).toBe('cracked')
    expect(wallStage(ip(80), S, 'breached')).toBe('intact')
  })

  it('clamps, shows percentages and crack levels', () => {
    expect(clampIp(ip(150), S)).toBe(S.maxIp)
    expect(clampIp(ip(-80), S)).toBe(ip(-50))
    expect(clampIp(NaN, S)).toBe(S.maxIp)
    expect(wallPct(ip(42.3), S)).toBe(42.3)
    expect([crackLevel(80), crackLevel(70), crackLevel(36), crackLevel(35), crackLevel(1)]).toEqual([0, 1, 1, 2, 2])
  })
})

describe('natural wear (lightning, tornado): never below 35 %, never a breach', () => {
  it('stops at the floor and never touches a segment at or below it', () => {
    expect(wearIp(ip(100), ip(5), S)).toBe(ip(95))
    expect(wearIp(ip(37), ip(5), S)).toBe(ip(35))
    expect(wearIp(ip(35), ip(5), S)).toBe(ip(35))
    expect(wearIp(ip(10), ip(5), S)).toBe(ip(10))
    // a thousand strikes from full: the floor, cracked, never open
    let v = S.maxIp
    for (let i = 0; i < 1000; i++) v = wearIp(v, lightningIp((i * 7919) % 1000 / 1000, S), S)
    expect(v).toBe(ip(35))
    expect(wallStage(v, S)).toBe('cracked')
  })

  it('a strike takes 3-5 % by its seed', () => {
    expect(lightningIp(0, S)).toBe(ip(3))
    expect(lightningIp(0.999999, S)).toBe(ip(5))
    expect(lightningIp(0.5, S)).toBe(ip(4))
  })
})

describe('wallNav: the thirds each stage takes down', () => {
  it('breached the middle, rubble all three; others stand', () => {
    expect(thirdsDown('intact')).toEqual([])
    expect(thirdsDown('cracked')).toEqual([])
    expect(thirdsDown('breached')).toEqual([1])
    expect(thirdsDown('rubble')).toEqual([0, 1, 2])
    const w = walls()
    const nav = wallNav(new Map<string, WallStage>([['W1', 'breached'], ['W2', 'rubble']]), w)
    expect(nav.disabled).toEqual([11, 20, 21, 22])
    // tiles of every downed third, each once
    expect(nav.open).toEqual([[0x6000, 101], [0x6000, 7], [0x6000, 200], [0x6000, 201], [0x6000, 202]])
    expect(wallNav(new Map([['W1', 'cracked' as WallStage]]), w)).toEqual({ disabled: [], open: [] })
  })

  it('WallNavState switches only what changed and undoes a closed gap', () => {
    const calls: string[] = []
    const target = {
      setInstanceEnabled: (i: number, on: boolean) => (calls.push(`${on ? 'on' : 'off'} ${i}`), true),
      setTileOverride: (r: number, t: number, m: string | null) => (calls.push(`tile ${t} ${m}`), true),
    }
    const state = new WallNavState(walls(), new Map([[11, 111], [20, 120], [21, 121], [22, 122]]))
    expect(state.apply(target, new Map([['W1', 'breached']]))).toBe(3)
    expect(calls).toEqual(['off 111', 'tile 101 open', 'tile 7 open'])
    calls.length = 0
    expect(state.apply(target, new Map([['W1', 'breached']]))).toBe(0)
    expect(state.apply(target, new Map([['W1', 'cracked']]))).toBe(3)
    expect(calls).toEqual(['on 111', 'tile 101 null', 'tile 7 null'])
  })
})

describe('breach zones (the safe-area seam)', () => {
  it('a circle of 50 m centred 10 m inside the gap; 80 m in a siege; wider for rubble', () => {
    const w = walls()
    const zones = breachZones(new Map([['W1', 'breached']]), w, S)
    expect(zones).toEqual([{ seg: 'W1', x: 10, z: 24, r: 50 }])
    expect(inBreachZone(zones, 10, 24)).not.toBeNull()
    expect(inBreachZone(zones, 59, 24)).not.toBeNull()
    expect(inBreachZone(zones, 61, 24)).toBeNull()
    expect(breachZones(new Map([['W1', 'breached']]), w, S, true)[0]!.r).toBe(80)
    expect(breachZones(new Map([['W2', 'rubble']]), w, S)).toEqual([{ seg: 'W2', x: 10, z: 72, r: 66 }])
    expect(breachZones(new Map([['W1', 'cracked']]), w, S)).toEqual([])
  })

  it('finds the segment and third under a wall-walk point, and the distance to an outer face', () => {
    const w = walls()
    expect(segmentAt(w, -8, 20)).toMatchObject({ seg: { id: 'W1' }, third: 1 })
    expect(segmentAt(w, -8, 50)).toMatchObject({ seg: { id: 'W2' }, third: 0 })
    expect(segmentAt(w, 30, 20)).toBeNull()
    expect(segmentAt(w, -8, 200)).toBeNull()
    expect(outerFaceDistance(w.sides[0]!, w.segments[0]!, -116, 24)).toBe(100)
    expect(outerFaceDistance(w.sides[0]!, w.segments[0]!, -16, 148)).toBe(100)
  })
})

describe('settings and the export check', () => {
  it('bounds, unknown keys, a patch over the defaults', () => {
    expect(checkWallSettings({})).toEqual([])
    expect(checkWallSettings({ maxIp: 10 })).toEqual(['maxIp must be a number in 1000..200000'])
    expect(checkWallSettings({ lightningPct: [5, 3] })).toEqual(['lightningPct must be [lo, hi] with lo <= hi'])
    expect(checkWallSettings({ nope: 1 })).toEqual(['unknown setting nope'])
    expect(wallSettings({ naturalFloorPct: 50 })).toMatchObject({ naturalFloorPct: 50, maxIp: 20_000 })
    expect(() => wallSettings({ zoneM: -1 })).toThrow(/zoneM/)
  })

  it('accepts a good export and names what is wrong with a bad one', () => {
    expect(checkWallsExport(walls())).toEqual([])
    const bad = walls()
    bad.segments[1]!.id = 'W1'
    bad.segments[0]!.thirds[2]!.id = 'W1x'
    expect(checkWallsExport(bad).join('|')).toMatch(/W1 twice.*|.*third 2 must be W1c/)
    expect(checkWallsExport({ ...walls(), navFile: '../x' })).toContain('navFile must be a relative path')
  })
})

describe('wire messages (protocol v1, additive)', () => {
  it('walls, wallUpdate and wallFx parse; bad ones are refused', () => {
    const ok = (m: unknown) => parseServerMessage(JSON.stringify(m))
    expect(ok({ t: 'walls', segs: [{ id: 'N10', stage: 'cracked', pct: 42.5 }, { id: 'W3', stage: 'rubble', pct: -50, scaffold: true }] }).ok).toBe(true)
    expect(ok({ t: 'wallUpdate', id: 'E7', stage: 'breached', pct: -3, at: 1 }).ok).toBe(true)
    expect(ok({ t: 'wallFx', id: 'S1', kind: 'chip', x: 1, y: 2, z: 3, at: 4 }).ok).toBe(true)
    expect(ok({ t: 'wallUpdate', id: 'X1', stage: 'breached', pct: 0, at: 1 }).ok).toBe(false)
    expect(ok({ t: 'wallUpdate', id: 'W1', stage: 'gone', pct: 0, at: 1 }).ok).toBe(false)
    expect(ok({ t: 'wallUpdate', id: 'W1', stage: 'intact', pct: 120, at: 1 }).ok).toBe(false)
    expect(ok({ t: 'wallFx', id: 'W1', kind: 'boom', x: 0, y: 0, z: 0, at: 0 }).ok).toBe(false)
    expect(ok({ t: 'walls', segs: Array.from({ length: 65 }, () => ({ id: 'W1', stage: 'intact', pct: 100 })) }).ok).toBe(false)
  })
})

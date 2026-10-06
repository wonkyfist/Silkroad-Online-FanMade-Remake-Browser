/**
 * Siege of Jangan, layer 2 (docs/SIEGE.md §9.2-§9.4, §14 "Client"): the stage → look mapping (thirds down, crack
 * levels, scaffold, hammer), what a change sets off, the sound cues of each wall moment and their roll-off, the tiers,
 * WallAudio's scheduling (3D placement, range, missing files, hammer strokes) and the minimap / world-map shapes.
 */
import { SIEGE_CUES, WALL_DEFAULTS, type WallStage, type WallsExport } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { INTACT_LOOK, WALL_SOUND_RANGE, WALL_TIERS, lookChange, nextScaffold, sameLook, wallLook, wallSoundGain, wallSounds, wallTierFor } from '../src/world/walls/look.ts'
import { WALL_MAP_COLORS, wallMapShapes } from '../src/world/walls/map.ts'
import { WallAudio, type WallAudioHost } from '../src/world/walls/sound.ts'
import { walls } from './walls-fixture.ts'

describe('wallLook: stage → look', () => {
  it('intact at 100 % and above crackedPct: nothing down, no cracks, no scaffold', () => {
    expect(wallLook({ stage: 'intact', pct: 100 })).toEqual({ down: [false, false, false], crack: [0, 0, 0], scaffold: [false, false, false], hammer: false })
    expect(wallLook({ stage: 'intact', pct: 71 }).crack).toEqual([0, 0, 0])
  })

  it('cracked: level 1 above half of crackedPct, level 2 at or below it', () => {
    expect(wallLook({ stage: 'cracked', pct: 70 }).crack).toEqual([1, 1, 1])
    expect(wallLook({ stage: 'cracked', pct: 36 }).crack).toEqual([1, 1, 1])
    expect(wallLook({ stage: 'cracked', pct: 35 }).crack).toEqual([2, 2, 2])
    expect(wallLook({ stage: 'cracked', pct: 1 }).down).toEqual([false, false, false])
  })

  it('breached: the middle third down, its neighbours deep-cracked (the broken ends)', () => {
    const l = wallLook({ stage: 'breached', pct: -10 })
    expect(l.down).toEqual([false, true, false])
    expect(l.crack).toEqual([2, 0, 2])
  })

  it('rubble: all three down, no cracks and no scaffold drawn', () => {
    const l = wallLook({ stage: 'rubble', pct: -50, repairing: true })
    expect(l.down).toEqual([true, true, true])
    expect(l.crack).toEqual([0, 0, 0])
    expect(l.scaffold).toEqual([false, false, false])
    // the hammer still sounds: builders work on a rubble segment too
    expect(l.hammer).toBe(true)
  })

  it('scaffold: over a and c of a rubble segment climbing back; over every standing third while repairing', () => {
    expect(wallLook({ stage: 'breached', pct: -20, scaffold: true }).scaffold).toEqual([true, false, true])
    expect(wallLook({ stage: 'breached', pct: -20, scaffold: true }).hammer).toBe(false)
    expect(wallLook({ stage: 'cracked', pct: 40, repairing: true }).scaffold).toEqual([true, true, true])
    expect(wallLook({ stage: 'intact', pct: 90, repairing: true })).toMatchObject({ scaffold: [true, true, true], hammer: true })
    // the flag alone means nothing on a closed segment
    expect(wallLook({ stage: 'cracked', pct: 40, scaffold: true }).scaffold).toEqual([false, false, false])
  })

  it('honours a changed crackedPct', () => {
    expect(wallLook({ stage: 'cracked', pct: 50 }, { crackedPct: 90 }).crack).toEqual([1, 1, 1])
    expect(wallLook({ stage: 'cracked', pct: 44 }, { crackedPct: 90 }).crack).toEqual([2, 2, 2])
  })

  it('sameLook compares every field', () => {
    const a = wallLook({ stage: 'cracked', pct: 50 })
    expect(sameLook(a, wallLook({ stage: 'cracked', pct: 50 }))).toBe(true)
    expect(sameLook(a, wallLook({ stage: 'cracked', pct: 20 }))).toBe(false)
    expect(sameLook(undefined, a)).toBe(false)
  })
})

describe('lookChange and the client scaffold flag', () => {
  it('a breach drops the middle third, a collapse the other two, a repair raises them', () => {
    const breached = wallLook({ stage: 'breached', pct: -10 })
    const rubble = wallLook({ stage: 'rubble', pct: -50 })
    expect(lookChange(INTACT_LOOK, breached)).toEqual({ fall: [1], rise: [] })
    expect(lookChange(undefined, rubble)).toEqual({ fall: [0, 1, 2], rise: [] })
    expect(lookChange(breached, rubble)).toEqual({ fall: [0, 2], rise: [] })
    expect(lookChange(rubble, breached)).toEqual({ fall: [], rise: [0, 2] })
    expect(lookChange(breached, wallLook({ stage: 'cracked', pct: 6 }))).toEqual({ fall: [], rise: [1] })
  })

  it('nextScaffold follows the server rule (set climbing out of rubble, kept while open, cleared on close or fall)', () => {
    const seq: WallStage[] = ['intact', 'rubble', 'breached', 'breached', 'cracked', 'rubble', 'breached', 'rubble']
    let flag = false
    const got: boolean[] = []
    for (let i = 1; i < seq.length; i++) {
      flag = nextScaffold(flag, seq[i - 1], seq[i]!)
      got.push(flag)
    }
    expect(got).toEqual([false, true, true, false, false, true, false])
    expect(nextScaffold(false, 'intact', 'breached')).toBe(false)
  })
})

describe('tiers', () => {
  it('maps presets, Ultra drawing as High', () => {
    expect(['low', 'medium', 'high', 'ultra', 'x'].map(wallTierFor)).toEqual(['low', 'medium', 'high', 'high', 'high'])
  })

  it('Low draws less stone, dust, bits and one scaffold face', () => {
    const { low, medium, high } = WALL_TIERS
    for (const k of ['pileChunks', 'teeth', 'chipChunks', 'crackChunks', 'collapseBits', 'bitsCap'] as const) {
      expect(low[k], k).toBeLessThan(medium[k])
      expect(medium[k], k).toBeLessThanOrEqual(high[k])
    }
    expect(low.dust.fall).toBeLessThan(medium.dust.fall)
    expect(low.bothFaces).toBe(false)
    expect(medium.bothFaces).toBe(true)
  })
})

describe('wall sound cues', () => {
  it('every moment plays cues that exist, in time order, starting at once', () => {
    for (const kind of ['chip', 'crack', 'breach', 'collapse', 'repair'] as const) {
      const steps = wallSounds(kind)
      expect(steps.length, kind).toBeGreaterThan(0)
      expect(steps[0]!.at).toBe(0)
      for (let i = 1; i < steps.length; i++) expect(steps[i]!.at).toBeGreaterThanOrEqual(steps[i - 1]!.at)
      for (const s of steps) {
        expect(SIEGE_CUES[s.cue], s.cue).toBeDefined()
        expect(WALL_SOUND_RANGE[s.cue], s.cue).toBeDefined()
      }
    }
    expect(wallSounds('breach').map((s) => s.cue)).toEqual(expect.arrayContaining(['siege.wall.blast', 'siege.wall.collapse', 'siege.stone.fall', 'siege.bell']))
    expect(wallSounds('collapse').map((s) => s.cue)).toContain('siege.wall.collapse')
    expect(wallSounds('chip').map((s) => s.cue)).toEqual(['siege.wall.chip'])
  })

  it('gain: 1 up close, falling with distance, 0 past the range; a breach carries much further than a chip', () => {
    for (const cue of Object.keys(WALL_SOUND_RANGE)) {
      const r = WALL_SOUND_RANGE[cue]!
      expect(wallSoundGain(cue, 0)).toBe(1)
      expect(wallSoundGain(cue, r.near)).toBe(1)
      let prev = 1
      for (let d = r.near; d <= r.range; d += r.range / 20) {
        const g = wallSoundGain(cue, d)
        expect(g).toBeLessThanOrEqual(prev + 1e-9)
        prev = g
      }
      expect(wallSoundGain(cue, r.range + 1)).toBe(0)
    }
    expect(wallSoundGain('siege.wall.collapse', 300)).toBeGreaterThan(0.05)
    expect(wallSoundGain('siege.wall.chip', 300)).toBe(0)
  })
})

function fakeAudio(files: string[], listener = { x: 0, y: 0, z: 0 }) {
  const played: { file: string; pos: { x: number; y: number; z: number }; gain: number; bus: string }[] = []
  const preloaded: string[] = []
  const host: WallAudioHost = {
    files: () => Object.fromEntries(files.map((f) => [f, {}])),
    listener: () => listener,
    play: (file, o) => played.push({ file, pos: o.pos, gain: o.gain, bus: o.bus }),
    preload: (ids) => preloaded.push(...ids),
    // the backend's inverse roll-off (ref 3 m, factor 1.2), as town.ts
    pannerDistanceFor: (g, d) => (g >= 1 ? Math.min(d, 3) : Math.min(d, 3 + (3 / g - 3) / 1.2)),
    random: () => 0.5,
  }
  return { host, played, preloaded, audio: new WallAudio(host) }
}

const ALL = [...new Set(Object.values(SIEGE_CUES).flatMap((c) => c.files))]

describe('WallAudio', () => {
  it('a breach plays its steps over time, at the moment, placed toward it', () => {
    const { audio, played } = fakeAudio(ALL)
    audio.moment('breach', 100, 20, 0)
    expect(played.map((p) => p.file)).toEqual(['common/explode_bomb2'])
    audio.update(0.2)
    expect(played.map((p) => p.file)).toContain('bldg/common/structure_destroy')
    audio.update(3)
    expect(audio.played['siege.stone.fall']).toBe(2)
    expect(audio.played['siege.bell']).toBe(1)
    expect(audio.pendingCount).toBe(0)
    // every voice on the line to the source, never further than it
    for (const p of played) {
      expect(p.pos.x).toBeGreaterThan(0)
      expect(p.pos.x).toBeLessThanOrEqual(100)
      expect(Math.abs(p.pos.z)).toBeLessThan(1e-9)
    }
    expect(played.find((p) => p.file === 'env/bell towel 3')!.bus).toBe('ambient')
    expect(played.find((p) => p.file === 'common/explode_bomb2')!.bus).toBe('sfx')
  })

  it('distance: a far voice is placed further out (quieter); out of range nothing plays', () => {
    const near = fakeAudio(ALL)
    near.audio.moment('chip', 20, 0, 0)
    const far = fakeAudio(ALL)
    far.audio.moment('chip', 120, 0, 0)
    expect(far.played[0]!.pos.x).toBeGreaterThan(near.played[0]!.pos.x)
    const gone = fakeAudio(ALL)
    gone.audio.moment('chip', 500, 0, 0)
    expect(gone.played).toEqual([])
  })

  it('an export without the files plays nothing (and does not throw)', () => {
    const { audio, played } = fakeAudio([])
    audio.moment('collapse', 10, 0, 0)
    audio.update(5)
    expect(played).toEqual([])
  })

  it('hammer strokes every 2-4 s while repairing, none after it stops', () => {
    const { audio, played } = fakeAudio(ALL)
    audio.setRepairing('S2', { x: 10, y: 5, z: 0 })
    for (let i = 0; i < 100; i++) audio.update(0.1)
    const strokes = played.filter((p) => p.file.startsWith('town/hammer_')).length
    expect(strokes).toBeGreaterThanOrEqual(10 / 4)
    expect(strokes).toBeLessThanOrEqual(10 / 2 + 1)
    audio.setRepairing('S2', null)
    const before = played.length
    for (let i = 0; i < 100; i++) audio.update(0.1)
    expect(played.length).toBe(before)
  })

  it('preloads the exported siege files once', () => {
    const { audio, preloaded } = fakeAudio(['bldg/common/structure_dmg', 'common/explode_bomb2'])
    audio.preload()
    audio.preload()
    expect(preloaded.sort()).toEqual(['bldg/common/structure_dmg', 'common/explode_bomb2'])
  })
})

describe('wallMapShapes (minimap and world map)', () => {
  const W = walls() as WallsExport
  const stages = new Map<string, WallStage>([['S1', 'cracked'], ['S2', 'breached'], ['S3', 'rubble']])
  const looks = new Map([
    ['S1', wallLook({ stage: 'cracked', pct: 60 })],
    ['S2', wallLook({ stage: 'breached', pct: -10, repairing: true })],
    ['S3', wallLook({ stage: 'rubble', pct: -50 })],
  ])
  const shapes = wallMapShapes(W, looks, stages, WALL_DEFAULTS)

  it('a line per damaged third, coloured by its look; intact stone is not drawn', () => {
    const lines = shapes.filter((s) => s.to && s.color !== WALL_MAP_COLORS.repair)
    expect(lines.length).toBe(9)
    const colours = lines.map((s) => s.color)
    expect(colours.slice(0, 3)).toEqual([WALL_MAP_COLORS.crack1, WALL_MAP_COLORS.crack1, WALL_MAP_COLORS.crack1])
    expect(colours.slice(3, 6)).toEqual([WALL_MAP_COLORS.crack2, WALL_MAP_COLORS.down, WALL_MAP_COLORS.crack2])
    expect(colours.slice(6, 9)).toEqual([WALL_MAP_COLORS.rubble, WALL_MAP_COLORS.rubble, WALL_MAP_COLORS.rubble])
    expect(wallMapShapes(W, new Map([['S1', wallLook({ stage: 'intact', pct: 100 })]]), new Map([['S1', 'intact']]), WALL_DEFAULTS)).toEqual([])
  })

  it('a repair line along a segment being repaired, and a red ring per breach zone', () => {
    expect(shapes.filter((s) => s.color === WALL_MAP_COLORS.repair).length).toBe(1)
    const rings = shapes.filter((s) => s.radius)
    expect(rings.length).toBe(2)
    for (const r of rings) expect(r.color).toBe(WALL_MAP_COLORS.zone)
    // the rubble gap is wider
    expect(rings[1]!.radius!).toBeGreaterThan(rings[0]!.radius!)
  })
})

/**
 * G-11 (the wave-11 final gate): the game halves the F-11 render fixer left open.
 *
 * - H11-DET-1: the appear notice carries the server's stamp (`at`, ms; apps/server uniques.ts), and the client starts
 *   the town's alarm on it through `World.townAlarm` (which keeps the window for a town part made later), so two
 *   friends whose notices arrive a few ms apart, across a second's edge, see the same alarm.
 * - H11-HI-1: the town's warm-up hook answers 'loading' while its drawables arrive (the warm-up holds its shader stage
 *   for that; abuse-w11-hitches.test.ts drives it) and only true/false once they are in.
 */
import { validateServerMessage } from '@sro/shared'
import { addWarmupHook, warmupHooksState } from '@sro/world-render'
import { NullEngine, Scene } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { UNIQUE_ALARM_S, uniqueAlarmFromS, worldUniqueNotice, type UniqueNoticeMessage } from '../src/hud/unique-notice.ts'

const appeared: UniqueNoticeMessage = { t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl' }

function alarms(msg: UniqueNoticeMessage, nowS: number, withWorld: boolean) {
  const world: Array<[number, number]> = []
  const town: Array<[number, number]> = []
  worldUniqueNotice(msg, {
    chat: { add: () => {} },
    town: { alarm: (s, sec) => void town.push([s, sec]) },
    world: withWorld ? { townAlarm: (s, sec) => void world.push([s, sec]) } : null,
    nowS,
  })
  return { world, town }
}

describe('H11-DET-1: the alarm starts on the server stamp', () => {
  it('two clients that get the notice 80 ms apart across a second edge start the same alarm', () => {
    const at = 1_790_000_000_960
    const a = alarms({ ...appeared, at }, 1_790_000_000.99, true)
    const b = alarms({ ...appeared, at }, 1_790_000_001.07, true)
    expect(a.world).toEqual([[at / 1000, UNIQUE_ALARM_S]])
    expect(b.world).toEqual(a.world)
    // the world forwards to the part itself: no second alarm
    expect(a.town).toEqual([])
  })

  it('an older server (no stamp) starts it on receipt; a world without townAlarm goes to the part', () => {
    expect(uniqueAlarmFromS(appeared, 1234.5)).toBe(1234.5)
    expect(alarms(appeared, 1234.5, false).town).toEqual([[1234.5, UNIQUE_ALARM_S]])
    expect(alarms({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl' }, 1, true).world).toEqual([])
  })

  it('the wire check takes a finite non-negative stamp', () => {
    expect(validateServerMessage({ ...appeared, at: 1_790_000_000_960 })).toMatchObject({ ok: true, msg: { at: 1_790_000_000_960 } })
    expect(validateServerMessage({ ...appeared, at: -1 })).toMatchObject({ ok: false })
    expect(validateServerMessage({ ...appeared, at: 'soon' })).toMatchObject({ ok: false })
  })
})

describe('H11-HI-1: warm-up hook states', () => {
  it('loading wins over compiling, compiling over ready; a hook that throws counts as ready', () => {
    const scene = new Scene(new NullEngine())
    expect(warmupHooksState(scene)).toBe('ready')
    const offA = addWarmupHook(scene, () => false)
    expect(warmupHooksState(scene)).toBe('compiling')
    const offB = addWarmupHook(scene, () => 'loading')
    const offC = addWarmupHook(scene, () => {
      throw new Error('x')
    })
    expect(warmupHooksState(scene)).toBe('loading')
    offB()
    offA()
    expect(warmupHooksState(scene)).toBe('ready')
    offC()
    scene.getEngine().dispose()
  })
})

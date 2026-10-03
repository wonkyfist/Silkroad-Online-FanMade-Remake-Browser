/**
 * H-11 lens 8, determinism (docs/WAVE_PLAN7.md §6.6; D19; TOWN_LIFE §2.1 option C, §3.2 F5): two clients, different
 * RTTs, a teleport into town, the walk clip's phase. Each test fails on the wave-11 checkpoint (b22f6a9) and states the
 * behaviour the plan promises. Read-only hunt: no product code is changed here.
 *
 * 1. The appear alarm is started at each client's own receipt time (screens/world.ts → worldUniqueNotice →
 *    `town.alarm(serverNow, 60)`; the `uniqueNotice` frame carries no server time). D19 accepts "two clients differ by
 *    their message latency (≈ 0.1 m)", but TownSchedule.planAlarm makes discrete choices at a0 (visible or not, the
 *    anchor node, the door, the rejoin trip): 50 ms of latency difference puts the same townsperson on another street,
 *    up to ≈ 120 m apart, for minutes.
 * 2. A child (scale 0.82) walks with a clip phase that the crowd and the GPU disagree on: the adapter's `distM`
 *    (clipTime × the unscaled nominal speed) advances at speed / scale, while the crowd gives the GPU the rate
 *    speed / natural; the drift check then rewrites the offset (a ≥ 1.5-frame snap of the feet) several times a second.
 * 3. A teleport into town: every agent that was beyond the range is skipped for up to 2 s (`farUntil`, which assumes
 *    only the agent moves, at MAX_SPEED), so the plaza is empty after the teleport and the whole crowd then fades in
 *    on the spot.
 */
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CLOCK, clockAt, type WorldClockState } from '../../shared/src/world-clock.ts'
import type { TownFile } from '../../shared/src/town.ts'
import { REBASE_MIN_S, TownCrowd, stubCrowdAssets, type CrowdAgent, type CrowdAssets, type CrowdPose, type CrowdQuery, type CrowdSchedule } from '../src/town/crowd.ts'
import { ScheduleAdapter } from '../src/town/index.ts'
import { TownSchedule, newTownAgentState, townNominalSpeed, type TownAgentState, type TownSolar } from '../src/town/schedule.ts'

const ROOT = join(import.meta.dirname, '../../..')
const TEXT = readFileSync(join(ROOT, 'content/town/jangan.json'), 'utf8')
/** A 2026 server second. */
const T0 = Date.UTC(2026, 9, 1, 12) / 1000
const CLOCK: WorldClockState = { ...DEFAULT_CLOCK, anchorMs: T0 * 1000, anchorDays: 10.5 / 24 }
const SKY: TownSolar = (s) => clockAt(CLOCK, s * 1000).t

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function rig(): { scene: Scene; assets: CrowdAssets } {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  new ArcRotateCamera('cam', 0, 1, 20, Vector3.Zero(), scene)
  const assets = stubCrowdAssets(scene)
  cleanups.push(() => {
    assets.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { scene, assets }
}

const query = (nowS: number): CrowdQuery => ({ nowS, solarT: 0.5, alarmFromS: 0, alarmUntilS: 0, rain: 0 })

describe('H-11 determinism: the appear alarm on two clients (D19)', () => {
  it('alarm starts 50 ms apart (two RTTs) keep every townsperson within 1 m and agree on who is out', () => {
    const a: TownAgentState = newTownAgentState()
    const b: TownAgentState = newTownAgentState()
    const DELTA = 0.05
    let worst = 0
    let worstAt = ''
    let outDiffers = 0
    for (let k = 0; k < 12; k++) {
      const A0 = T0 + k * 611.7
      // two clients on one server clock: the notice reached the second 50 ms later
      const c1 = new TownSchedule(JSON.parse(TEXT) as TownFile)
      const c2 = new TownSchedule(JSON.parse(TEXT) as TownFile)
      c1.alarm(A0, 60)
      c2.alarm(A0 + DELTA, 60)
      for (const dt of [20, 60, 120, 240]) {
        const t = A0 + DELTA + dt
        for (let i = 0; i < c1.agents.length; i++) {
          c1.stateAt(i, t, SKY, a)
          c2.stateAt(i, t, SKY, b)
          if (Math.abs(a.alpha - b.alpha) > 0.5) {
            outDiffers++
            continue
          }
          if (!a.visible || !b.visible) continue
          const d = Math.hypot(a.x - b.x, a.z - b.z)
          if (d > worst) {
            worst = d
            worstAt = `alarm ${k}, +${dt} s, agent ${i} (${c1.agents[i]!.role})`
          }
        }
      }
    }
    // D19: "two clients differ by their message latency (≈ 0.1 m)"; 1.3 × 1.46 m/s × 0.05 s ≈ 0.1 m, 1 m is generous
    expect(worst, `worst ${worst.toFixed(1)} m at ${worstAt}`).toBeLessThanOrEqual(1)
    expect(outDiffers, 'samples where one client shows the person and the other does not').toBe(0)
    // F-11: 24 schedule builds (0.1-0.2 s each) can pass the default 5 s on a busy machine
  }, 60_000)
})

/** One walker as TL-R's schedule gives it (evalTrip: clipRate = speed / (nominal × scale), clipTime = dt × clipRate). */
function walkerSchedule(scale: number, speed: number): Pick<TownSchedule, 'agents' | 'stateAt'> {
  const agent = {
    index: 0, id: 'w', role: scale < 1 ? 'child' : 'walker', kind: 'person', female: true, scale, look: 1, group: -1, member: 0,
    speed, home: 0, period: 480, phase: 0, place: -1, seat: -1, rank: 0.5, goods: null, presence: { kind: 'always' }, trips: [],
    mode: 'roam', alarm: 'door',
  }
  return {
    agents: [agent] as unknown as TownSchedule['agents'],
    stateAt(_a: unknown, nowS: number, _solar: TownSolar, out: TownAgentState = newTownAgentState()): TownAgentState {
      const dt = nowS - T0
      out.visible = true
      out.alpha = 1
      out.x = 2 + dt * speed
      out.y = 0
      out.z = 0
      out.yaw = Math.PI / 2
      out.clip = 'WALK'
      out.clipRate = speed / (townNominalSpeed('person', 'WALK') * scale)
      out.clipTime = dt * out.clipRate
      out.moving = true
      out.speed = speed
      return out
    },
  }
}

/** Clip offset rewrites (each a snap of the feet) over `sec` seconds at 30 fps, after a 1 s settle. */
function rewrites(scale: number, speed: number, sec: number): number {
  const { assets } = rig()
  const sched = new ScheduleAdapter(walkerSchedule(scale, speed) as unknown as TownSchedule)
  const crowd = new TownCrowd(assets, sched, { kinds: ['folk'], variants: 10 })
  crowd.configure(10, 200)
  const threats = new Float32Array(2)
  const dt = 1 / 30
  let writes = 0
  for (let f = 0; f < (1 + sec) * 30; f++) {
    const t = T0 + f * dt
    const T = REBASE_MIN_S + f * dt
    for (const v of assets.vats) v.manager.time = T
    crowd.update(query(t), T, 0, 0, dt, threats, 0)
    if (f >= 30) writes += crowd.frame.clipWrites
  }
  expect(crowd.frame.drawn).toBe(1)
  return writes
}

describe('H-11 determinism: the walk clip phase (TOWN_LIFE §3.2, "nobody slides")', () => {
  it('a walking child (scale 0.82) keeps one clip offset like an adult: no periodic snap of the feet', () => {
    const adult = rewrites(1, 1.39, 4)
    const child = rewrites(0.82, 1.2, 4)
    expect(adult).toBe(0)
    // the child's GPU rate (speed / natural) and its phase (distM / natural = speed / scale × t / natural) disagree:
    // the drift check snaps the offset many times in 4 s
    expect(child).toBe(0)
  })
})

/** Standing agents on a ring of radius r round the origin. */
class Ring implements CrowdSchedule {
  readonly agents: CrowdAgent[]
  constructor(n: number, private readonly r: number) {
    this.agents = Array.from({ length: n }, (_, i) => ({ id: i + 1, role: 'walker', female: i % 2 === 1, rank: (i + 0.5) / n }))
  }

  pose(i: number, q: Readonly<CrowdQuery>, out: CrowdPose): boolean {
    const a = (i * 2.399) % (Math.PI * 2)
    out.x = Math.cos(a) * this.r
    out.z = Math.sin(a) * this.r
    out.y = 0
    out.yaw = a
    out.alpha = 1
    out.rate = 1
    out.clip = 'STAND1'
    out.clipT = q.nowS + i * 0.37
    out.distM = Number.NaN
    out.speed = 0
    return true
  }
}

describe('H-11 determinism: a teleport into town', () => {
  it('right after a teleport onto the plaza the crowd is there (fading in) as it is for a player who walked in', () => {
    const { assets } = rig()
    const run = (crowd: TownCrowd, from: number, frames: number, fx: number): void => {
      const threats = new Float32Array(2)
      for (let f = 0; f < frames; f++) {
        const t = from + f * 0.1
        const T = REBASE_MIN_S + (t - T0)
        for (const v of assets.vats) v.manager.time = T
        crowd.update(query(t), T, fx, 0, 0.1, threats, 0)
      }
    }
    // a friend already on the plaza
    const there = new TownCrowd(assets, new Ring(40, 20), { kinds: ['folk'], variants: 10 })
    there.configure(60, 60)
    run(there, T0, 3, 0)
    expect(there.frame.drawn).toBe(40)
    // the player 400 m away (outside the town), then a teleport (a GM /tp, a return scroll) onto the plaza
    const tele = new TownCrowd(assets, new Ring(40, 20), { kinds: ['folk'], variants: 10 })
    tele.configure(60, 60)
    run(tele, T0, 10, 400)
    run(tele, T0 + 1, 3, 0)
    // 0.3 s after the teleport: still nobody (farUntil = now + 2 s for everyone), then all 40 fade in where they stand
    expect(tele.frame.drawn).toBe(40)
  })
})

/** Agents standing on a ring of radius r until server second `inFrom`, then indoors (the schedule gives no pose). */
class Doors implements CrowdSchedule {
  readonly agents: CrowdAgent[]
  private readonly ring: Ring
  constructor(n: number, r: number, private readonly inFrom: number) {
    this.ring = new Ring(n, r)
    this.agents = this.ring.agents
  }

  pose(i: number, q: Readonly<CrowdQuery>, out: CrowdPose): boolean {
    if (q.nowS >= this.inFrom) return false
    return this.ring.pose(i, q, out)
  }
}

describe('H-11 determinism: the server-time estimate steps back (W9F F1: the server clock stepped)', () => {
  it('after a 300 s backward step the townsfolk the schedule has out are drawn at once, not 300 s later', () => {
    const { assets } = rig()
    const threats = new Float32Array(2)
    const run = (crowd: TownCrowd, from: number, frames: number): void => {
      for (let f = 0; f < frames; f++) {
        const t = from + f * 0.1
        const T = REBASE_MIN_S + 100 + f * 0.1
        for (const v of assets.vats) v.manager.time = T
        crowd.update(query(t), T, 0, 0, 0.1, threats, 0)
      }
    }
    // the 30 are out until T0 + 200, then indoors
    const crowd = new TownCrowd(assets, new Doors(30, 15, T0 + 200), { kinds: ['folk'], variants: 10 })
    crowd.configure(60, 60)
    // the estimate runs 300 s ahead (the server's wall clock was ahead, then stepped back; ServerClock follows it)
    run(crowd, T0 + 300, 5)
    expect(crowd.frame.drawn).toBe(0)
    // the estimate is corrected to T0 + 1: the schedule has all 30 out, as a friend's client shows them
    run(crowd, T0 + 1, 5)
    // farUntil (= the old estimate + 0.5 s) keeps them hidden until T0 + 300.5
    expect(crowd.frame.drawn).toBe(30)
  })
})

/**
 * TOWN_LIFE.md §3.1 / WAVE_PLAN7 §6.1 lane TL-A2: the town clips SIT_CHAIR, CARRY, TALK and SWEEP.
 *  - the committed key files (content/moves/<skel>/town/*.json), shared by both skeletons;
 *  - town-clips.ts's thresholds on synthetic reports, and the `moves --town` hand-over;
 *  - when `pnpm sro moves --town` has run (work/out/moves/<skel>/town/), the real clips: the MV-A checks (the STAND1
 *    control ≤ 0.1°, contacts ≤ 1 mm, loops close), the index, and the props riding their sockets (the broom along
 *    the hands, the crate on the shoulder).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import { gltfIO } from '../src/optimize/io.ts'
import {
  apply, channelsOf, compose, controlCheck, exportMovesCli, findAnimation, globalsAt, groundOf, invert, jointIndex,
  keyTimes, MOVE_SKELETONS, mul, quatAngleDeg, retarget, rigOf, rotationOf, translationOf, type Mat4,
} from '../src/tools/export-moves.ts'
import {
  checkTownClip, readTownSpecs, TOWN_KINDS, TOWN_LIMITS, townFailures, type TownClipCheck, type TownClipsIndex,
  type TownKeyerOutput, type TownReport, type TownSpec,
} from '../src/tools/town-clips.ts'

const SKELS = Object.keys(MOVE_SKELETONS) as (keyof typeof MOVE_SKELETONS)[]
/** TOWN_LIFE §3.1: the loop lengths (SIT_CHAIR ≤ 3 s; CARRY is the WALK's 1.17 s cycle). */
const LENGTH: Record<string, [number, number]> = { SIT_CHAIR: [30, 90], CARRY: [35, 35], TALK: [90, 90], SWEEP: [60, 60] }

describe('content/moves/<skel>/town key files', () => {
  for (const skel of SKELS) {
    it(`${skel} has exactly the four town clips, well formed`, () => {
      const specs = readTownSpecs(skel)
      expect(specs.map(s => s.kind).sort()).toEqual([...TOWN_KINDS].sort())
      for (const s of specs) {
        expect(s.kind).toBe(s.clip.toUpperCase())
        expect(s.fps).toBe(30)
        expect(s.loop).toBe(true)
        const [lo, hi] = LENGTH[s.kind]!
        expect(s.lastFrame).toBeGreaterThanOrEqual(lo)
        expect(s.lastFrame).toBeLessThanOrEqual(hi)
        const fs = s.keys.map(k => k.f)
        expect(fs[0]).toBe(0)
        expect(fs.at(-1)!).toBeLessThan(s.lastFrame) // the loop frame is key 0 again, never keyed
        expect([...fs].sort((a, b) => a - b)).toEqual(fs)
        expect(new Set(fs).size).toBe(fs.length)
        if (s.base === 'STAND1') {
          expect(s.lock).toBe('fixed')
          // the legs are the same on every key: the feet never slide, the planting only removes the idle's ~2 mm
          for (const k of s.keys) expect(k.legs).toEqual(s.keys[0]!.legs)
        } else {
          expect([s.base, s.lock, s.kind]).toEqual(['WALK', 'base', 'CARRY'])
          for (const k of s.keys) expect(k.legs).toBeUndefined()
        }
        for (const side of ['L', 'R'] as const) {
          const kinds = new Set(s.keys.map(k => {
            const a = k.arms[side]
            return a === null ? 'base' : Array.isArray(a) ? `angles${a.length}` : 'floor' in (a as object) ? 'handle' : 'reach'
          }))
          expect(kinds.size, `${s.clip} ${side}`).toBe(1)
          expect([...kinds][0]).not.toBe('angles4')
        }
        if (s.socket) {
          expect(s.socket.bone).toBe('Bip01 R Hand')
          expect(s.socket.origin.at).toHaveLength(3)
        }
      }
    })
  }

  it('the files are shared by both skeletons (the keyer measures each one\'s limbs)', () => {
    const [a, b] = SKELS.map(s => readTownSpecs(s))
    expect(b).toEqual(a)
  })

  it('SIT_CHAIR measures its seat, CARRY and SWEEP carry a prop on the right hand, TALK opens its hands', () => {
    const by = Object.fromEntries(readTownSpecs('europeman_skel').map(s => [s.kind, s])) as Record<string, TownSpec & { keys: { hands?: Record<string, number[]> }[] }>
    expect(by.SIT_CHAIR!.seat).toBe(true)
    expect(by.CARRY!.socket?.prop).toBe('crate')
    expect(by.SWEEP!.socket?.prop).toBe('broom')
    expect(by.SWEEP!.socket?.axis).toEqual(['Bip01 R Hand', 'Bip01 L Hand'])
    // TOWN_LIFE §3.1: TALK must not read as fighting: every gesture key opens the right hand and turns its palm up
    for (const k of by.TALK!.keys) {
      const [open, palm] = k.hands!.R!
      expect(open).toBeGreaterThanOrEqual(0.8)
      expect(palm).toBeGreaterThanOrEqual(10)
    }
  })
})

// ------------------------------------------------------------------------------------------------ town-clips.ts

const okClip = (over: Partial<TownClipCheck> = {}): TownClipCheck => ({
  anim: 'x', kind: 'TALK', frames: 91, durationMs: 3000, maxContactM: 0, maxSlideM: 0, maxBaseFeetM: null, baseCycleFrames: null,
  loopM: 0, loopDeg: 0, seamAccelM: 0.002, maxInnerAccelM: 0.008, seamTurnDeg: 3, maxTurnDeg: 12, rootExcursionM: 0.004,
  maxVsExportM: 1e-5, maxReachErrM: 0, ...over,
})
const talkSpec = { clip: 'talk', kind: 'TALK', lastFrame: 90 } as TownSpec
const report = (c: TownClipCheck): Omit<TownReport, 'failures'> => ({
  skeleton: 's', prefix: 'p', packBytes: 1, control: { samples: 70, maxRotDeg: 0.001, maxTransM: 1e-7 }, clips: { talk: c },
})

describe('town-clips.ts', () => {
  it('passes a clean report and names every broken threshold', () => {
    expect(townFailures(report(okClip()), [talkSpec])).toEqual([])
    const bad: [Partial<TownClipCheck>, RegExp][] = [
      [{ maxContactM: 0.0011 }, /contact 1\.10 mm/],
      [{ maxSlideM: 0.002 }, /slide/],
      [{ loopM: 2e-4 }, /loop does not close/],
      [{ loopDeg: 0.2 }, /loop does not close/],
      [{ seamAccelM: 0.02 }, /seam acceleration/],
      [{ seamTurnDeg: 20 }, /seam turn/],
      [{ maxTurnDeg: 40 }, /turns 40\.0°/],
      [{ rootExcursionM: 0.02 }, /root XZ/],
      [{ maxVsExportM: 1e-3 }, /pack vs export/],
      [{ maxReachErrM: 0.03 }, /reach target/],
      [{ frames: 90 }, /90 keys, expected 91/],
    ]
    for (const [over, re] of bad) expect(townFailures(report(okClip(over)), [talkSpec]).join('\n'), JSON.stringify(over)).toMatch(re)
    const r = report(okClip())
    r.control.maxRotDeg = 0.2
    expect(townFailures(r, [talkSpec]).join()).toMatch(/control STAND1/)
    expect(townFailures(report(okClip()), [talkSpec, { ...talkSpec, clip: 'sweep', kind: 'SWEEP' }]).join()).toMatch(/key files/)
  })

  it('a layer must meet its base clip and last exactly one base cycle', () => {
    const carry = { clip: 'carry', kind: 'CARRY', lastFrame: 35 } as TownSpec
    const c = okClip({ kind: 'CARRY', frames: 36, maxContactM: null, maxSlideM: null, maxBaseFeetM: 0.0005, baseCycleFrames: 35 })
    const rep = (x: TownClipCheck) => ({ ...report(x), clips: { carry: x } })
    expect(townFailures(rep(c), [carry])).toEqual([])
    expect(townFailures(rep({ ...c, maxBaseFeetM: 0.002 }), [carry]).join()).toMatch(/off the base clip/)
    expect(townFailures(rep({ ...c, baseCycleFrames: 36 }), [carry]).join()).toMatch(/base cycle 36/)
  })

  it('`pnpm sro moves --town` is handed to the town clips (an unknown skeleton exits 1 before Blender)', async () => {
    expect(await exportMovesCli(['--town', '--skel', 'nobody_skel'], {} as never)).toBe(1)
  })

  it('the limits are the MV-A ones (WAVE_PLAN7 §6.1 row TL-A2)', () => {
    expect(TOWN_LIMITS.controlDeg).toBe(0.1)
    expect(TOWN_LIMITS.contactM).toBe(0.001)
  })
})

// ------------------------------------------------------------------------------------------------ the real clips

const OUT_ROOT = join(REPO_ROOT, 'work', 'out')
for (const skel of SKELS) {
  const work = join(OUT_ROOT, 'moves', skel, 'town')
  const charFile = join(OUT_ROOT, ...MOVE_SKELETONS[skel].char.split('/'))
  const ready = ['town_clips.glb', 'town_clips.json', 'town_blender.glb', 'town_keys.json', 'roundtrip.json'].every(f => existsSync(join(work, f))) && existsSync(charFile)
  describe.skipIf(!ready)(`work/out/moves/${skel}/town (pnpm sro moves --town)`, () => {
    const load = async () => {
      const io = await gltfIO()
      const origDoc = await io.read(charFile)
      const packDoc = await io.read(join(work, 'town_clips.glb'))
      const expDoc = await io.read(join(work, 'town_blender.glb'))
      const index = JSON.parse(readFileSync(join(work, 'town_clips.json'), 'utf8')) as TownClipsIndex
      const keyer = JSON.parse(readFileSync(join(work, 'town_keys.json'), 'utf8')) as TownKeyerOutput
      const rt = JSON.parse(readFileSync(join(work, 'roundtrip.json'), 'utf8')) as TownReport
      const joints = origDoc.getRoot().listSkins()[0]!.listJoints().map(j => j.getName())
      const orig = rigOf(origDoc)
      const exp = rigOf(expDoc)
      return { index, keyer, rt, joints, orig, exp, pack: rigOf(packDoc), r: retarget(orig, exp, joints), ground: groundOf(orig) }
    }
    let loading: ReturnType<typeof load> | undefined
    const get = () => (loading ??= load())

    it('the report has no failed check, and the index names the four clips', async () => {
      const { index, rt } = await get()
      expect(rt.failures).toEqual([])
      expect(index).toMatchObject({ format: 'sro-town-clips', version: 1, skeleton: skel, pack: 'town_clips.glb', fps: 30 })
      expect(Object.keys(index.clips).sort()).toEqual([...TOWN_KINDS].sort())
      expect(index.clips.CARRY!.base).toBe('WALK')
      expect(index.clips.SIT_CHAIR!.seat!.seatZ).toBeGreaterThan(0.4)
      expect(index.clips.SIT_CHAIR!.seat!.seatZ).toBeLessThan(0.6)
    }, 120_000)

    it('the STAND1 control round-trips within 0.1° and 1e-5 m', async () => {
      const { orig, exp, r, keyer } = await get()
      const c = controlCheck(orig, exp, r, keyer.controlAction)
      expect(c.maxRotDeg).toBeLessThanOrEqual(TOWN_LIMITS.controlDeg)
      expect(c.maxTransM).toBeLessThanOrEqual(TOWN_LIMITS.controlM)
    }, 120_000)

    it('every clip: contacts ≤ 1 mm, the loop closes smoothly, no flips (re-measured on the pack)', async () => {
      const { orig, pack, keyer, joints, ground } = await get()
      for (const [clip, k] of Object.entries(keyer.clips)) {
        const c = checkTownClip(orig, pack, findAnimation(pack.doc, k.action), ground, k, joints)
        if (k.lock === 'fixed') {
          expect(c.maxContactM!, clip).toBeLessThanOrEqual(TOWN_LIMITS.contactM)
          expect(c.maxSlideM!, clip).toBeLessThanOrEqual(TOWN_LIMITS.slideM)
        } else {
          expect(c.maxBaseFeetM!, clip).toBeLessThanOrEqual(TOWN_LIMITS.baseFeetM)
        }
        expect(c.loopM, clip).toBeLessThanOrEqual(TOWN_LIMITS.loopM)
        expect(c.loopDeg, clip).toBeLessThanOrEqual(TOWN_LIMITS.loopDeg)
        expect(c.seamAccelM, clip).toBeLessThanOrEqual(c.maxInnerAccelM * 1.5 + 0.001)
        expect(Math.max(c.maxTurnDeg, c.seamTurnDeg), clip).toBeLessThanOrEqual(TOWN_LIMITS.turnDeg)
      }
    }, 300_000)

    it('the props ride their sockets: the broom stays along the hands, the crate on the shoulder', async () => {
      const { pack, index } = await get()
      const at = (g: Mat4[], n: string) => g[jointIndex(pack, n)]!
      const worldOf = (g: Mat4[], s: NonNullable<TownClipsIndex['clips']['SWEEP']>['socket']) => mul(at(g, s!.bone), compose(s!.offset, s!.rotation))
      const sweep = index.clips.SWEEP!
      const sa = findAnimation(pack.doc, sweep.anim)
      const sch = channelsOf(pack, sa)
      let worstDeg = 0
      for (const t of keyTimes(sa)) {
        const g = globalsAt(pack, sch, t)
        const w = worldOf(g, sweep.socket)
        const up = [w[4]!, w[5]!, w[6]!] // the prop's +Y (its handle)
        const hands = translationOf(at(g, 'Bip01 L Hand')).map((v, c) => v - translationOf(at(g, 'Bip01 R Hand'))[c]!)
        const cos = (up[0]! * hands[0]! + up[1]! * hands[1]! + up[2]! * hands[2]!) / (Math.hypot(...up) * Math.hypot(...hands))
        worstDeg = Math.max(worstDeg, (Math.acos(Math.min(1, cos)) * 180) / Math.PI)
      }
      expect(worstDeg).toBeLessThanOrEqual(1)
      expect(sweep.socket!.floorM).toBeGreaterThan(0.8)
      expect(sweep.socket!.floorM).toBeLessThan(1.3)

      const carry = index.clips.CARRY!
      const ca = findAnimation(pack.doc, carry.anim)
      const cch = channelsOf(pack, ca)
      const rel = keyTimes(ca).map(t => {
        const g = globalsAt(pack, cch, t)
        const w = worldOf(g, carry.socket)
        // the crate seen from the right shoulder joint, in the neck's turn: it rides the shoulder, so it barely
        // moves there (the walk's own shoulder bob carries it)
        const neck = at(g, 'Bip01 Neck')
        const sh = translationOf(at(g, 'Bip01 R UpperArm'))
        const inNeck = apply(invert(neck), [w[12]!, w[13]!, w[14]!]).map((v, c) => v - apply(invert(neck), sh)[c]!)
        return { p: inNeck, q: rotationOf(w), neckQ: rotationOf(at(g, 'Bip01 Neck')) }
      })
      const drift = Math.max(...rel.map(x => Math.hypot(...x.p.map((v, c) => v - rel[0]!.p[c]!))))
      expect(drift).toBeLessThanOrEqual(0.02)
      // the crate turns with the neck (the hand is steadied against it), within a few degrees
      const turn = Math.max(...rel.map(x => Math.abs(quatAngleDeg(x.q, rel[0]!.q) - quatAngleDeg(x.neckQ, rel[0]!.neckQ))))
      expect(turn).toBeLessThanOrEqual(3)
      // on frame 0 the crate sits above the right shoulder
      const g0 = globalsAt(pack, cch, 0)
      const crate = translationOf(worldOf(g0, carry.socket))
      const shoulder = translationOf(at(g0, 'Bip01 R UpperArm'))
      expect(crate[1] - shoulder[1]).toBeGreaterThan(0.1)
    }, 300_000)
  })
}

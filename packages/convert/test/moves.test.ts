/**
 * MOVEMENT.md §8.2 (MV-A):
 *  - the committed key-pose files (content/moves/<skel>/*.json);
 *  - when the keyer has run (work/out/moves/<skel>/moves_keys.json, from packages/convert/tools/blender/moves/
 *    key_moves.py), the keyed clips' contacts and `air`;
 *  - export-moves.ts: the re-expression maths on a synthetic chain with rotated rest frames, the pack writer, the RUN
 *    phase names, and the optimizer's pass-through of a movement pack (optimize/run.ts);
 *  - when `pnpm sro moves` has run (work/out/char/_anims/<skel>/movement.glb), the real packs of both skeletons: joint
 *    names and rest TRS, the STAND1 control ≤ 0.1°, contacts ≤ 1 mm, slide ≤ 10 mm per frame, `air` ≥ −0.02 m, no net
 *    root travel, ≤ 60 KB per clip, durations and events against the index, and every RUN a player runs mapped to a
 *    JUMP_RUN that meets it within 1 cm at enterPhaseS / exitPhaseS.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Document, type AnimationSampler, type Node } from '@gltf-transform/core'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import { gltfIO } from '../src/optimize/io.ts'
import { MOVEMENT_PACK, optimizeOut } from '../src/optimize/run.ts'
import {
  BLEND_MATCH_M, buildMovementPack, checkClip, clipBytes, compose, controlCheck, findAnimation, groundOf, invert, keyTimes,
  LIMITS, MOVE_SKELETONS, mul, packVsExport, playerRuns, quatAngleDeg, reexpressClip, resolvePhase, retarget, rigOf,
  rotationOf, runMatches, runTrack, translationOf, type KeyerOutput, type Mat4, type MovementIndex, type MoveSpec,
  type Quat, type Vec3,
} from '../src/tools/export-moves.ts'

type Side = 'L' | 'R'
interface Key {
  f: number
  pose: string
  base: string
  lean: number
  head: number
  legs: Record<Side, number[]>
  arms: Record<Side, number[]>
  extra?: Record<string, number[]>
  root?: number[]
}
interface Spec {
  clip: string
  kind: string
  fps: number
  lastFrame: number
  lock: 'fixed' | 'run'
  run?: string
  for?: string[]
  blendFor?: string[]
  air: { takeoff: number, touch: number, apexRiseM: number }
  contacts: { from: number, to: number, feet: string, runPhase?: string }[]
  tail?: { from: number, fadeTo: number }
  events: { f: number, type: string }[]
  keys: Key[]
}
interface Row { f: number, air: number, stance: string, rootFwd: number, pelvisZ: number, skateM?: number }
interface ClipOut {
  action: string
  kind: string
  frames: number
  durationMs: number
  air: number[]
  planted: boolean[]
  run?: string
  enterPhaseS?: number
  exitPhaseS?: number
  for?: string[]
  blendFor?: string[]
  rows: Row[]
}

const SKELS = {
  europeman_skel: { prefix: 'chinaman', clips: ['jump', 'jump_run', 'jump_run_fist'] },
  europewoman_skel: { prefix: 'chinawoman', clips: ['jump', 'jump_run'] },
} as const
const CONTENT = join(REPO_ROOT, 'content', 'moves')
const OUT = join(REPO_ROOT, 'work', 'out', 'moves')
const PHASE = /^(?:([LR])-contact)?\s*([+-]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?)?$/
const readSpec = (skel: string, clip: string) => JSON.parse(readFileSync(join(CONTENT, skel, `${clip}.json`), 'utf8')) as Spec
/** packages/shared JUMP_COOLDOWN_MS and JUMP_MAX_SEEK_MS (@sro/shared is not a dependency of the converter). */
const JUMP_COOLDOWN_MS = 1000
const JUMP_MAX_SEEK_MS = 200
/** The higher jump (P-JUMP 2026-10-01, MOVEMENT.md §3.2): the lift above the take-off/touch-down line, in metres. */
const LIFT_M = { min: 0.55, max: 0.7 }

/** The RUN families each skeleton's players run (MOVEMENT.md §1.1): every one needs a JUMP_RUN. */
const RUNS: Record<string, string[]> = {
  europeman_skel: ['RUN', 'RUN_chinaman_fighter_runforward_sword', 'RUN_spear_run_fighter', 'RUN_bow_run_fighter'],
  europewoman_skel: ['RUN', 'RUN_chinawoman_merchant_runforward_sword', 'RUN_spear_run_merchant', 'RUN_bow_run_merchant'],
}

describe('content/moves key files', () => {
  for (const [skel, { clips }] of Object.entries(SKELS)) {
    it(`${skel} has exactly its clips`, () => {
      const files = readdirSync(join(CONTENT, skel)).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort()
      expect(files).toEqual([...clips].sort())
    })

    for (const clip of clips) {
      it(`${skel}/${clip} is well formed`, () => {
        const s = readSpec(skel, clip)
        expect(s.clip).toBe(clip)
        expect(s.kind).toBe(clip.toUpperCase())
        expect(s.fps).toBe(30)
        const fs = s.keys.map(k => k.f)
        expect(fs[0]).toBe(0)
        expect(fs.at(-1)).toBe(s.lastFrame)
        expect([...fs].sort((a, b) => a - b)).toEqual(fs)
        expect(new Set(fs).size).toBe(fs.length)
        expect(s.air.takeoff).toBeLessThan(s.air.touch)
        expect(s.air.apexRiseM).toBeGreaterThan(0)
        expect(s.events.map(e => [e.type, e.f])).toEqual([['takeoff', s.air.takeoff], ['land', s.air.touch]])
        for (const c of s.contacts) {
          expect(c.from).toBeLessThanOrEqual(c.to)
          expect(c.feet).toMatch(/^(L|R|LR)$/)
          // no planted frame inside the airborne arc
          expect(c.to <= s.air.takeoff || c.from >= s.air.touch, `${clip} contact ${c.from}-${c.to}`).toBe(true)
          if (s.lock === 'run') expect(c.runPhase).toMatch(PHASE)
        }
        for (const k of s.keys) {
          expect(k.base === 'STAND1' || k.base.startsWith('RUN@'), k.base).toBe(true)
          if (k.base.startsWith('RUN@')) expect(k.base.slice(4)).toMatch(PHASE)
          for (const side of ['L', 'R'] as const) {
            expect(k.legs[side]).toHaveLength(4)
            expect(k.arms[side]).toHaveLength(3)
            for (const v of [...k.legs[side], ...k.arms[side]]) expect(Number.isFinite(v)).toBe(true)
          }
          for (const q of Object.values(k.extra ?? {})) expect(Math.hypot(...q)).toBeCloseTo(1, 3)
          if (k.root) expect(k.f > s.air.takeoff && k.f < s.air.touch).toBe(true)
        }
        if (s.lock === 'run') {
          expect(s.run).toBeTruthy()
          expect(s.for).toContain(s.run)
          // a running clip starts and ends on its RUN (the base resumes at exitPhaseS)
          expect(s.keys[0]!.base).toMatch(/^RUN@/)
          expect(s.keys.at(-1)!.base).toMatch(/^RUN@/)
          for (const k of [s.keys[0]!, s.keys.at(-1)!]) {
            expect([k.lean, k.head, ...k.legs.L, ...k.legs.R, ...k.arms.L, ...k.arms.R].every(v => v === 0)).toBe(true)
          }
        } else {
          expect(s.keys[0]!.base).toBe('STAND1')
          expect(s.keys.at(-1)!.base).toBe('STAND1')
        }
      })
    }

    it(`${skel}: every RUN family maps to exactly one JUMP_RUN`, () => {
      const served = new Map<string, string>()
      for (const clip of clips) {
        const s = readSpec(skel, clip)
        for (const r of [...(s.for ?? []), ...(s.blendFor ?? [])]) {
          expect(served.has(r), r).toBe(false)
          served.set(r, s.kind)
        }
      }
      for (const r of RUNS[skel]!) expect(served.get(r), r).toMatch(/^JUMP_RUN/)
    })
  }

  it('the standing JUMP is the same key data on both skeletons', () => {
    const m = readSpec('europeman_skel', 'jump')
    const w = readSpec('europewoman_skel', 'jump')
    expect(w.keys).toEqual(m.keys)
    expect([w.air, w.contacts, w.events, w.lastFrame]).toEqual([m.air, m.contacts, m.events, m.lastFrame])
  })

  it('the higher jump (P-JUMP): every clip lifts ~0.6 m with the air time gravity gives, inside the cooldown', () => {
    for (const [skel, { clips }] of Object.entries(SKELS)) {
      for (const clip of clips) {
        const s = readSpec(skel, clip)
        const label = `${skel}/${clip}`
        expect(s.air.apexRiseM, label).toBeGreaterThanOrEqual(LIFT_M.min)
        expect(s.air.apexRiseM, label).toBeLessThanOrEqual(LIFT_M.max)
        // a ballistic arc that rises H and falls back: t = 2·sqrt(2H/g), on the 30 fps grid
        const airS = (s.air.touch - s.air.takeoff) / 30
        expect(Math.abs(airS - 2 * Math.sqrt((2 * s.air.apexRiseM) / 9.81)), label).toBeLessThanOrEqual(1 / 30)
        // a late viewer's seek never skips the take-off, and the next jump never cuts this one in the air
        expect(s.air.takeoff * 1000 / 30, label).toBeLessThanOrEqual(JUMP_MAX_SEEK_MS)
        expect(s.air.touch * 1000 / 30, label).toBeLessThan(JUMP_COOLDOWN_MS)
      }
    }
  })

  it('the take-off arms do not reach straight forward (touch-up 0): past the horizontal at take-off and rise', () => {
    const s = readSpec('europeman_skel', 'jump')
    const at = (pose: string) => s.keys.find(k => k.pose === pose)!
    for (const pose of ['takeoff', 'rise']) {
      for (const side of ['L', 'R'] as const) {
        const [swing, elbow] = at(pose).arms[side]
        expect(swing, `${pose} ${side}`).toBeGreaterThanOrEqual(130)
        expect(elbow, `${pose} ${side}`).toBeGreaterThanOrEqual(20)
      }
    }
    expect(s.air.takeoff).toBe(6) // 200 ms
    const touch = s.keys.find(k => k.f === s.air.touch)!
    expect(touch.legs.L[2]).toBeLessThan(0) // ball first: toes down at touch-down
    expect(s.keys.find(k => k.f === s.air.touch + 1)!.legs.L[2]).toBe(0) // then the heel
  })
})

for (const [skel, { prefix, clips }] of Object.entries(SKELS)) {
  const file = join(OUT, skel, 'moves_keys.json')
  describe.skipIf(!existsSync(file))(`work/out/moves/${skel} (the keyer's output)`, () => {
    const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { prefix: string, controlAction: string, clips: Record<string, ClipOut> } : null
    it('has every clip, named <prefix>_<clip>, and the STAND1 control', () => {
      expect(doc!.prefix).toBe(prefix)
      expect(doc!.controlAction).toBe(`${prefix}_control_stand1`)
      expect(Object.keys(doc!.clips).sort()).toEqual([...clips].sort())
      for (const [clip, c] of Object.entries(doc!.clips)) expect(c.action).toBe(`${prefix}_${clip}`)
    })
    for (const clip of clips) {
      it(`${clip}: planted contacts ≤ 1 mm, slide ≤ 10 mm/frame, air ≥ −0.02 m, one air value per frame`, () => {
        const c = doc!.clips[clip]!
        const spec = readSpec(skel, clip)
        expect(c.frames).toBe(spec.lastFrame + 1)
        expect(c.durationMs).toBe(Math.round(spec.lastFrame * 1000 / 30))
        expect(c.air).toHaveLength(c.frames)
        for (const a of c.air) expect(a).toBeGreaterThanOrEqual(-0.02)
        c.rows.forEach((r, i) => {
          if (c.planted[i]) expect(Math.abs(r.air), `f${i}`).toBeLessThanOrEqual(0.001)
          expect(r.skateM ?? 0, `f${i}`).toBeLessThanOrEqual(0.01)
        })
        // the higher jump (P-JUMP): the pelvis apex over its first-frame height (standing: the idle, 1.00 m on the man)
        const lift = Math.max(...c.rows.map(r => r.pelvisZ)) - c.rows[0]!.pelvisZ
        expect(lift, 'pelvis lift').toBeGreaterThanOrEqual(spec.lock === 'run' ? 0.5 : 0.58)
        expect(lift, 'pelvis lift').toBeLessThanOrEqual(0.7)
        // no net root travel: the server move carries the body
        const fwd = c.rows.map(r => r.rootFwd)
        expect(Math.max(...fwd) - Math.min(...fwd)).toBeLessThanOrEqual(0.15)
        expect(Math.abs(fwd.at(-1)! - fwd[0]!)).toBeLessThanOrEqual(0.01)
        if (spec.lock === 'run') {
          expect(c.run).toBe(spec.run)
          expect(c.enterPhaseS).toBeTypeOf('number')
          expect(c.exitPhaseS).toBeTypeOf('number')
        }
      })
    }
  })
}

// ------------------------------------------------------------------------------------------------ export-moves.ts

const axisAngle = (ax: readonly number[], deg: number): Quat => {
  const h = (deg * Math.PI) / 360
  const n = Math.hypot(...ax)
  return [(ax[0]! / n) * Math.sin(h), (ax[1]! / n) * Math.sin(h), (ax[2]! / n) * Math.sin(h), Math.cos(h)]
}
const CHAIN = ['Bip01', 'Bip01 Spine', 'Bip01 R Hand']
const REST_T: Vec3[] = [[0, 1, 0], [0, 0.5, 0.1], [0.2, 0.4, 0]]
const REST_Q: Quat[] = [axisAngle([0, 1, 0], 30), axisAngle([1, 0, 0], 10), axisAngle([0, 0, 1], -20)]
const TIMES = [0, 0.5, 1]
/** The original clip: the root moves and turns, the others only turn. */
const origPose = (f: number, k: number) => ({
  t: (k === 0 ? [0.1 * f, 1 + 0.05 * f, 0] : REST_T[k]!) as Vec3,
  q: axisAngle([1, 0.3 * k, 0.2], 15 * (f + 1) * (k + 1)),
})
/** Blender's rest re-orientation per joint (C), and an armature node above the chain. */
const REORIENT = [axisAngle([1, 1, 1], 120), axisAngle([1, 1, 1], 120), axisAngle([0, 0, 1], 90)].map(q => compose([0, 0, 0], q))
const ARMATURE = compose([0, 0, 0], axisAngle([1, 0, 0], -90))

const chainGlobals = (locals: Mat4[]) => locals.reduce<Mat4[]>((g, l, k) => [...g, k ? mul(g[k - 1]!, l) : l], [])
const origLocals = (f: number) => CHAIN.map((_n, k) => compose(origPose(f, k).t, origPose(f, k).q))

/** A skinned chain; `locals(f)` gives its local matrices at TIMES[f]; `top` is an optional parent node's matrix. */
function chainDoc(rest: Mat4[], locals: ((f: number) => Mat4[]) | null, top: Mat4 | null): Document {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const scene = doc.createScene()
  const set = (n: Node, m: Mat4) => n.setTranslation(translationOf(m)).setRotation(rotationOf(m))
  const joints = CHAIN.map((name, k) => set(doc.createNode(name), rest[k]!))
  joints.forEach((j, k) => {
    if (k) joints[k - 1]!.addChild(j)
  })
  if (top) scene.addChild(set(doc.createNode('Armature'), top).addChild(joints[0]!))
  else scene.addChild(joints[0]!)
  const skin = doc.createSkin()
  for (const j of joints) skin.addJoint(j)
  if (locals) {
    const anim = doc.createAnimation('clip')
    const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(TIMES)).setBuffer(buffer)
    joints.forEach((j, k) => {
      for (const path of ['rotation', 'translation'] as const) {
        const vals = TIMES.flatMap((_t, f) => (path === 'rotation' ? rotationOf(locals(f)[k]!) : translationOf(locals(f)[k]!)))
        const out = doc.createAccessor().setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(vals)).setBuffer(buffer)
        const smp = doc.createAnimationSampler().setInput(input).setOutput(out).setInterpolation('LINEAR')
        anim.addSampler(smp).addChannel(doc.createAnimationChannel().setTargetNode(j).setTargetPath(path).setSampler(smp))
      }
    })
  }
  return doc
}

function synthetic() {
  const origRest = CHAIN.map((_n, k) => compose(REST_T[k]!, REST_Q[k]!))
  // Blender's side: the same world pose of every joint, each joint frame rotated by its C, under an armature node
  const expLocalsOf = (orig: Mat4[]) => {
    const ge = chainGlobals(orig).map((g, k) => mul(g, REORIENT[k]!))
    return ge.map((g, k) => (k ? mul(invert(ge[k - 1]!), g) : mul(invert(ARMATURE), g)))
  }
  const orig = chainDoc(origRest, origLocals, null)
  const exp = chainDoc(expLocalsOf(origRest), f => expLocalsOf(origLocals(f)), ARMATURE)
  return { orig, exp }
}

/** Key `f` of a sampler (the test's own read, independent of anim.ts sampling). */
const keyOf = (s: AnimationSampler, f: number) => {
  const size = s.getOutput()!.getElementSize()
  return [...s.getOutput()!.getArray()!.slice(f * size, f * size + size)]
}

describe('export-moves: re-expression and the pack (synthetic 3-joint chain)', () => {
  const { orig, exp } = synthetic()
  const r = retarget(rigOf(orig), rigOf(exp), CHAIN)
  const clip = reexpressClip(r, rigOf(exp), findAnimation(exp, 'clip'))

  it('finds each joint\'s rest re-orientation (C)', () => {
    expect(r.reorientDeg.map(d => Math.round(d))).toEqual([120, 120, 90])
    expect(r.parentJoint).toEqual([-1, 0, 1])
  })

  it('round-trips the original local keys (identity through the re-oriented export)', () => {
    expect(clip.times).toEqual(TIMES)
    clip.poses.forEach((pose, f) => pose.forEach((p, k) => {
      const want = origPose(f, k)
      expect(quatAngleDeg(p.q, want.q), `f${f} ${CHAIN[k]}`).toBeLessThan(0.005)
      for (let c = 0; c < 3; c++) expect(Math.abs(p.t[c]! - want.t[c]!), `f${f} ${CHAIN[k]}`).toBeLessThan(1e-5)
    }))
  })

  it('is the identity on an export with no re-orientation', () => {
    const same = retarget(rigOf(orig), rigOf(orig), CHAIN)
    expect(Math.max(...same.reorientDeg)).toBeLessThan(1e-3)
    const back = reexpressClip(same, rigOf(orig), findAnimation(orig, 'clip'))
    back.poses.forEach((pose, f) => pose.forEach((p, k) => expect(quatAngleDeg(p.q, origPose(f, k).q)).toBeLessThan(0.005)))
  })

  it('writes a pack with exactly the skeleton\'s joints, rest TRS and one LINEAR clip (translation only where it moves)', () => {
    const pack = buildMovementPack(orig, 'test/movement', CHAIN, [{ anim: 'test_jump', clip }])
    const nodes = pack.getRoot().listNodes()
    expect(nodes.map(n => n.getName())).toEqual(CHAIN)
    const src = new Map(orig.getRoot().listNodes().map(n => [n.getName(), n]))
    for (const n of nodes) {
      expect(n.getTranslation()).toEqual(src.get(n.getName())!.getTranslation())
      expect(n.getRotation()).toEqual(src.get(n.getName())!.getRotation())
    }
    const anim = findAnimation(pack, 'test_jump')
    const channel = new Map(anim.listChannels().map(c => [`${c.getTargetNode()!.getName()}|${c.getTargetPath()}`, c.getSampler()!]))
    expect([...channel.keys()].sort()).toEqual(['Bip01 R Hand|rotation', 'Bip01 Spine|rotation', 'Bip01|rotation', 'Bip01|translation'])
    expect(anim.listSamplers().every(smp => smp.getInterpolation() === 'LINEAR')).toBe(true)
    expect(keyTimes(anim)).toEqual(TIMES)
    // one shared time accessor: 3 floats, then 3 × 3 rotations and 3 translations
    expect(clipBytes(anim)).toBe(4 * (3 + 3 * 3 * 4 + 3 * 3))
    // the pack's keys on its rest skeleton give the original clip's joint positions
    TIMES.forEach((_t, f) => {
      const want = chainGlobals(origLocals(f))
      const got = chainGlobals(nodes.map((n, k) => {
        const tr = channel.get(`${CHAIN[k]}|translation`)
        return compose(tr ? keyOf(tr, f) : n.getTranslation(), keyOf(channel.get(`${CHAIN[k]}|rotation`)!, f))
      }))
      want.forEach((m, k) => {
        const a = translationOf(m)
        const b = translationOf(got[k]!)
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), `f${f} ${CHAIN[k]}`).toBeLessThan(1e-5)
      })
    })
  })

  it('resolves RUN phases by contact, on the 30 fps grid (run_contacts.py resolve_phase)', () => {
    const contacts = { R: { startS: 0.3 }, L: { startS: 0.6333 } }
    expect(resolvePhase('R-contact', contacts, 0.6667)).toBeCloseTo(0.3, 6)
    expect(resolvePhase('R-contact+0.033', contacts, 0.6667)).toBeCloseTo(1 / 3, 5)
    expect(resolvePhase('L-contact+0.067', contacts, 0.6667)).toBeCloseTo(1 / 30, 5) // wraps
    expect(resolvePhase('L-contact', contacts, 0.6667)).toBeCloseTo(19 / 30, 5)
    expect(resolvePhase('0.4', contacts, 0.8)).toBeCloseTo(0.4, 6)
    expect(() => resolvePhase('X-contact', contacts, 0.8)).toThrow()
    expect(() => resolvePhase('', contacts, 0.8)).toThrow()
  })

  const tmp = mkdtempSync(join(tmpdir(), 'sro-moves-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('the optimizer finishes a movement pack losslessly, copies its index and never ships the keyer\'s files', async () => {
    expect(MOVEMENT_PACK.test('char/_anims/europeman_skel/movement.glb')).toBe(true)
    expect(MOVEMENT_PACK.test('char/_anims/europeman_skel/default.glb')).toBe(false)
    const io = await gltfIO()
    const inDir = join(tmp, 'out')
    const outDir = join(tmp, 'out-opt')
    const dir = join(inDir, 'char', '_anims', 'europeman_skel')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'movement.glb'), await io.writeBinary(buildMovementPack(orig, 'test/movement', CHAIN, [{ anim: 'test_jump', clip }])))
    const index = JSON.stringify({ format: 'sro-movement', version: 1, clips: { JUMP: { anim: 'test_jump' } } })
    writeFileSync(join(dir, 'movement.json'), index)
    mkdirSync(join(inDir, 'moves', 'europeman_skel'), { recursive: true })
    writeFileSync(join(inDir, 'moves', 'europeman_skel', 'moves.blend'), 'retail mesh')
    writeFileSync(join(inDir, 'moves', 'europeman_skel', 'moves_blender.glb'), await io.writeBinary(orig))

    const report = await optimizeOut({ inDir, outDir, noCensus: true })
    const rel = 'char/_anims/europeman_skel/movement.glb'
    expect(report.packs.map(p => p.rel)).toEqual([rel])
    expect(report.packs[0]!.validator.errors).toBe(0)
    expect(report.glbs).toEqual([])
    expect(report.animationCheck).toMatchObject({ clips: 1, channels: 4, maxDiff: 0, failures: [] })
    const back = await io.read(join(outDir, ...rel.split('/')))
    expect(back.getRoot().listExtensionsUsed().map(e => e.extensionName)).toContain('EXT_meshopt_compression')
    expect(back.getRoot().listNodes().map(n => n.getName())).toEqual(CHAIN)
    expect(readFileSync(join(outDir, 'char', '_anims', 'europeman_skel', 'movement.json'), 'utf8')).toBe(index)
    expect(existsSync(join(outDir, 'moves'))).toBe(false)
    expect(JSON.parse(readFileSync(join(outDir, 'slim.json'), 'utf8')).animationPacks).toEqual([rel])
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------ the real packs

const OUT_ROOT = join(REPO_ROOT, 'work', 'out')
for (const [skel, { prefix, char }] of Object.entries(MOVE_SKELETONS)) {
  const packFile = join(OUT_ROOT, 'char', '_anims', skel, 'movement.glb')
  const charFile = join(OUT_ROOT, ...char.split('/'))
  const ready = existsSync(packFile) && existsSync(charFile) && existsSync(join(OUT, skel, 'moves_blender.glb'))
  describe.skipIf(!ready)(`work/out/char/_anims/${skel}/movement.glb (pnpm sro moves)`, () => {
    const load = async () => {
      const io = await gltfIO()
      const origDoc = await io.read(charFile)
      const packDoc = await io.read(packFile)
      const expDoc = await io.read(join(OUT, skel, 'moves_blender.glb'))
      const index = JSON.parse(readFileSync(join(OUT_ROOT, 'char', '_anims', skel, 'movement.json'), 'utf8')) as MovementIndex
      const keyer = JSON.parse(readFileSync(join(OUT, skel, 'moves_keys.json'), 'utf8')) as KeyerOutput
      const sidecar = JSON.parse(readFileSync(charFile.replace(/\.glb$/, '.json'), 'utf8')) as { animations: { name: string, group: string }[] }
      const joints = origDoc.getRoot().listSkins()[0]!.listJoints().map(j => j.getName())
      const orig = rigOf(origDoc)
      const exp = rigOf(expDoc)
      return { origDoc, packDoc, expDoc, index, keyer, sidecar, orig, exp, pack: rigOf(packDoc), r: retarget(orig, exp, joints), ground: groundOf(orig) }
    }
    let loading: ReturnType<typeof load> | undefined
    const get = () => (loading ??= load())

    it('has exactly the skeleton\'s joint names and rest TRS', async () => {
      const { origDoc, packDoc } = await get()
      const joints = origDoc.getRoot().listSkins()[0]!.listJoints()
      const nodes = new Map(packDoc.getRoot().listNodes().map(n => [n.getName(), n]))
      expect([...nodes.keys()].sort()).toEqual(joints.map(j => j.getName()).sort())
      for (const j of joints) {
        const n = nodes.get(j.getName())!
        expect(n.getTranslation()).toEqual(j.getTranslation())
        expect(n.getRotation()).toEqual(j.getRotation())
        expect(n.getScale()).toEqual(j.getScale())
        expect(n.getParentNode()?.getName()).toBe(j.getParentNode()?.getName())
      }
    }, 120_000)

    it('the STAND1 control round-trips within 0.1° and 1e-5 m', async () => {
      const { orig, exp, r, keyer } = await get()
      expect([...new Set(r.reorientDeg.map(d => Math.round(d)))].sort()).toEqual([120, 90])
      const c = controlCheck(orig, exp, r, keyer.controlAction)
      expect(c.samples).toBeGreaterThan(30)
      expect(c.maxRotDeg).toBeLessThanOrEqual(LIMITS.controlDeg)
      expect(c.maxTransM).toBeLessThanOrEqual(LIMITS.controlM)
    }, 120_000)

    it('the index names every clip with its duration, events and air (one value per frame)', async () => {
      const { packDoc, index, keyer } = await get()
      expect(index).toMatchObject({ format: 'sro-movement', version: 1, skeleton: skel, pack: `char/_anims/${skel}/movement.glb` })
      expect(Object.keys(index.clips).sort()).toEqual(Object.values(keyer.clips).map(c => c.kind).sort())
      expect(packDoc.getRoot().listAnimations().map(a => a.getName()).sort()).toEqual(Object.keys(keyer.clips).map(c => `${prefix}_${c}`).sort())
      for (const k of Object.values(keyer.clips)) {
        const e = index.clips[k.kind]!
        const times = keyTimes(findAnimation(packDoc, e.anim))
        expect(e.anim).toBe(k.action)
        expect(e.fps).toBe(30)
        expect(e.frames).toBe(k.frames)
        expect(times).toHaveLength(k.frames)
        expect(e.durationMs).toBe(k.durationMs)
        expect(Math.round(times.at(-1)! * 1000)).toBe(e.durationMs)
        expect(e.events).toEqual([{ timeMs: k.takeoffMs, type: 2, p1: 'takeoff', p2: 0 }, { timeMs: k.touchMs, type: 2, p1: 'land', p2: 0 }])
        expect(e.air).toHaveLength(k.frames)
        e.air.forEach((a, f) => {
          expect(a, `${k.kind} f${f}`).toBeGreaterThanOrEqual(LIMITS.minAirM)
          if (k.planted[f]) expect(Math.abs(a), `${k.kind} f${f}`).toBeLessThanOrEqual(LIMITS.plantedM)
        })
      }
    }, 120_000)

    it('every clip: planted ≤ 1 mm, slide ≤ 10 mm/frame, air ≥ −0.02 m, no net root travel, ≤ 60 KB, = Blender\'s export', async () => {
      const { orig, pack, exp, packDoc, expDoc, keyer, r, ground } = await get()
      for (const [clip, k] of Object.entries(keyer.clips)) {
        const spec = readSpec(skel, clip) as unknown as MoveSpec
        const anim = findAnimation(packDoc, k.action)
        const c = checkClip(pack, anim, ground, k, spec, k.run ? runTrack(orig, k.run, ground) : null)
        expect(c.maxPlantedM, clip).toBeLessThanOrEqual(LIMITS.plantedM)
        expect(c.maxSlideM, clip).toBeLessThanOrEqual(LIMITS.slideM)
        expect(c.minAirM, clip).toBeGreaterThanOrEqual(LIMITS.minAirM)
        expect(c.rootExcursionM, clip).toBeLessThanOrEqual(LIMITS.rootExcursionM)
        expect(c.rootEndsM, clip).toBeLessThanOrEqual(LIMITS.rootEndsM)
        expect(c.rawBytes, clip).toBeLessThanOrEqual(LIMITS.clipBytes)
        expect(c.maxAirVsKeyerM, clip).toBeLessThanOrEqual(0.001)
        expect(packVsExport(pack, anim, exp, findAnimation(expDoc, k.action), r), clip).toBeLessThanOrEqual(LIMITS.packVsExportM)
      }
    }, 120_000)

    it('every RUN a player runs maps to a JUMP_RUN that meets it at enterPhaseS / exitPhaseS (1 cm; a blend RUN within the blend bound)', async () => {
      const { orig, pack, packDoc, index, keyer, sidecar, ground } = await get()
      const runs = playerRuns(sidecar)
      expect([...runs].sort()).toEqual([...RUNS[skel]!].sort())
      for (const run of runs) {
        const kind = index.runJumps[run]
        expect(kind, run).toMatch(/^JUMP_RUN/)
        expect(index.clips[kind!]!.run, run).toBeTruthy()
      }
      // the mounted and avatar RUNs never map (a mounted jump is refused; the avatar packs are never loaded)
      for (const a of sidecar.animations) if (/^RUN_/.test(a.name) && !runs.includes(a.name)) expect(index.runJumps[a.name], a.name).toBeUndefined()
      if (skel === 'europeman_skel') {
        // an armed man never gets the fist clip, and an unarmed one gets it
        expect(index.runJumps.RUN).toBe('JUMP_RUN_FIST')
        for (const run of runs.filter(x => x !== 'RUN')) expect(index.runJumps[run], run).toBe('JUMP_RUN')
      }
      let checked = 0
      for (const k of Object.values(keyer.clips)) {
        if (!k.run) continue
        const e = index.clips[k.kind]!
        expect([e.enterPhaseS, e.exitPhaseS]).toEqual([k.enterPhaseS, k.exitPhaseS])
        for (const m of runMatches(orig, pack, findAnimation(packDoc, k.action), k, ground)) {
          const lim = m.blend ? BLEND_MATCH_M : LIMITS.runMatchM
          expect(m.enterM, `${m.kind} enter ${m.run}`).toBeLessThanOrEqual(lim)
          expect(m.exitM, `${m.kind} exit ${m.run}`).toBeLessThanOrEqual(lim)
          checked++
        }
      }
      expect(checked).toBe(runs.length)
    }, 120_000)
  })
}

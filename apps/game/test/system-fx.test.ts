/**
 * System effects (docs/EFFECTS.md §3.5-§3.9, §6.5; docs/WAVE_PLAN2.md M15; lane FX-C2): SystemFx.play(key, phase, view)
 * on the SYSTEM_* rows of fx index v2, the shared FxRunner (one-shots end with their program, loops until stopped),
 * the consumable mapping of `itemEffect`, and the real export's system groups. NullEngine; synthetic programs are
 * registered on the FxLibrary (no fetch).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NullEngine, Scene, TransformNode } from '@babylonjs/core'
import { FX_FORMAT, FX_FPS, FX_VERSION, FxLibrary, type FxEffect } from '@sro/fx'
import type { ItemDef } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EntityView } from '../src/world/entities.ts'
import { CURE_EFFECT, itemEffectOf, spawnFade } from '../src/world/features/fx-world.ts'
import { FxRunner, parseOffset, phaseRows, readSystemGroups, SystemFx, viewPose } from '../src/world/fx/system-fx.ts'
import { SYSTEM_FX_KEYS, type FxSkillV2, type FxStageV2 } from '../src/world/fx/types.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const SKILLS = join(ROOT, 'work', 'out', 'fx', 'skills.json')

const LINK = { positionDepth: 1, matrixDepth: 1, velocityDepth: 0, followDepth: 1, localMotion: false, shapeMotion: true, keepMatrix: false, keepOrigin: false }

/** A finite program: a root living `frames` ticks that emits one plate a tick. */
function program(key: string, frames: number): FxEffect {
  return {
    format: FX_FORMAT,
    version: FX_VERSION,
    key,
    fps: FX_FPS,
    scale: 1,
    textures: [],
    meshes: [],
    nodes: [
      { name: 'root', parent: -1, frames, life: 'extinct', emit: { start: 0, duration: 1, period: 1, limit: 1, rate: 1 }, link: { ...LINK }, render: 'none', view: 'none', material: null, commands: [] },
      {
        name: 'plate', parent: 0, frames: 2, life: 'extinct', emit: { start: 0, duration: frames, period: 1, limit: 4, rate: 1 }, link: { ...LINK },
        render: 'plate', view: 'billboard',
        material: { texture: -1, mesh: -1, blend: 'add', cull: 'none', colorOp: 'diffuse', alphaOp: 'diffuse', d3d: { srcBlend: 5, dstBlend: 2, cull: 1, colorOp: 2, alphaOp: 2 } },
        commands: [],
      },
    ],
    duration: frames,
    provenance: 'test',
    warnings: [],
  } as unknown as FxEffect
}

function row(p: Partial<FxStageV2> & Pick<FxStageV2, 'phase' | 'actType' | 'effect'>): FxStageV2 {
  return {
    startEvent: 0, move: 'MOV_NONE,0,0,0', startBone: null, startOffset: '0,0,0', targetBone: null, targetOffset: '0,0,0', effect2: null, rotate: '0',
    script: null, dmg: false, kill: 0, damageTypes: null, scale: null, id: 0, attach: 0, trade: 0, createCount: 1, fade: { inMs: 0, outMs: 0 },
    param: [0, 0, 0], actOption: '', ...p,
  }
}

function group(g: string, stages: FxStageV2[]): FxSkillV2 {
  return { group: g, aniGroup: null, defense: null, damage: null, arrowTail: null, arrowForce: null, stages, priority: 0, hideWeapon: false, trail: null, light: null, twist: null, bleeds: false, kind: 'system' }
}

const GROUPS = new Map<string, FxSkillV2>([
  ['SYSTEM_LEVELUP', group('SYSTEM_LEVELUP', [row({ phase: 'ACT_S', actType: 'AT_ONE_FOLLOW', effect: 'system/system_levelup.efp' })])],
  ['SYSTEM_RETURNSCROLL', group('SYSTEM_RETURNSCROLL', [row({ phase: 'ACT_S', actType: 'AT_LOOP', effect: 'system/item_returnscroll.efp' })])],
  ['SYSTEM_RETURNSCROLLRESULT', group('SYSTEM_RETURNSCROLLRESULT', [row({ phase: 'ACT_S', actType: 'AT_LOOP', effect: 'system/item_returnscroll_use.efp' })])],
  ['SYSTEM_CH_HWANMODE', group('SYSTEM_CH_HWANMODE', [
    row({ phase: 'ACT_S', actType: 'AT_ONE_FOLLOW', effect: 'system/system_hwan_motion.efp', startBone: 'Bip01', scale: 'CHAR_BASE' }),
    row({ phase: 'ACT_L', actType: 'AT_LOOP', effect: 'system/system_hwan_keep.efp', startBone: 'Bip01 Spine', scale: 'CHAR_BASE' }),
    ...['Bip01 L UpperArm', 'Bip01 R UpperArm', 'Bip01 L HandMid', 'Bip01 R Finger2', 'Bip01 L Calf', 'Bip01 R Calf'].map(b =>
      row({ phase: 'ACT_L', actType: 'AT_LOOP', effect: 'system/system_hwan_keep_s.efp', startBone: b, scale: 'CHAR_BASE' })),
    row({ phase: 'DEACT', actType: 'AT_ONE_FOLLOW', effect: 'system/system_hwan_disappear.efp', scale: 'CHAR_BASE' }),
  ])],
])

let engine: NullEngine
let scene: Scene

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterAll(() => {
  scene.dispose()
  engine.dispose()
  vi.restoreAllMocks()
})

function library(): FxLibrary {
  const lib = new FxLibrary(scene, '/out/', () => Promise.reject(new Error('no fetch in tests')))
  lib.addProgram(program('system/system_levelup.efp', 144))
  lib.addProgram(program('system/item_returnscroll.efp', 30))
  lib.addProgram(program('system/item_returnscroll_use.efp', 50))
  for (const k of ['system/system_hwan_motion.efp', 'system/system_hwan_keep.efp', 'system/system_hwan_keep_s.efp', 'system/system_hwan_disappear.efp']) lib.addProgram(program(k, 20))
  return lib
}

/** A view stand-in: a root at (x, 0, z), a yaw, a scale and an actor with a few bones. */
function fakeView(x = 3, z = 4): EntityView {
  const root = new TransformNode('v', scene)
  root.position.set(x, 0, z)
  const bones = new Map<string, TransformNode>()
  for (const [name, y] of [['Bip01', 1], ['Bip01 Spine', 1.2]] as const) {
    const b = new TransformNode(name, scene)
    b.parent = root
    b.position.y = y
    bones.set(name, b)
  }
  return { id: 1, root, yaw: 0, scale: 1, pos: root.position, actor: { joint: (n: string) => bones.get(n) } } as unknown as EntityView
}

/** Runs the runner for `ms` in 50 ms frames. */
async function run(fx: SystemFx | FxRunner, ms: number): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  for (let t = 0; t < ms; t += 50) fx.update(0.05)
}

describe('SystemFx.play (M15)', () => {
  it('level-up plays system/system_levelup.efp on the carrier for its 7.2 s, then disposes', async () => {
    const fx = new SystemFx(scene, { runner: new FxRunner(scene, { library: library() }), groups: GROUPS })
    const h = fx.play('SYSTEM_LEVELUP', 'start', fakeView())
    await run(fx, 100)
    expect(fx.runner.stats).toMatchObject({ live: 1, started: 1 })
    await run(fx, 6500)
    expect(h.done).toBe(false)
    await run(fx, 2000)
    expect(h.done).toBe(true)
    expect(fx.runner.stats).toMatchObject({ live: 0, started: 1, disposed: 1 })
    fx.dispose()
  })

  it('the return scroll (an AT_LOOP start row) loops until stopped, then fades out', async () => {
    const fx = new SystemFx(scene, { runner: new FxRunner(scene, { library: library() }), groups: GROUPS })
    const h = fx.play('SYSTEM_RETURNSCROLL', 'start', fakeView())
    await run(fx, 10_000)
    expect(h.done).toBe(false)
    expect(fx.runner.stats.live).toBe(1)
    h.stop()
    await run(fx, 3000)
    expect(h.done).toBe(true)
    expect(fx.runner.stats.live).toBe(0)
    fx.dispose()
  })

  it('the return flash where the reader stood (an AT_LOOP row nobody stops) plays once with {once}', async () => {
    const fx = new SystemFx(scene, { runner: new FxRunner(scene, { library: library() }), groups: GROUPS })
    const h = fx.playAt('SYSTEM_RETURNSCROLLRESULT', 'start', { pos: [1, 2, 3] }, { once: true })
    await run(fx, 1000)
    expect(h.done).toBe(false)
    await run(fx, 4000)
    expect(h.done).toBe(true)
    fx.dispose()
  })

  it('Berserk: start plays ACT_S, loop the 7 ACT_L rows until stopped, end the DEACT row', async () => {
    const fx = new SystemFx(scene, { runner: new FxRunner(scene, { library: library() }), groups: GROUPS })
    const v = fakeView()
    fx.play('SYSTEM_CH_HWANMODE', 'start', v)
    const loop = fx.play('SYSTEM_CH_HWANMODE', 'loop', v)
    await run(fx, 100)
    expect(fx.runner.stats.live).toBe(8)
    await run(fx, 5000)
    expect(fx.runner.stats.live).toBe(7)
    loop.stop()
    fx.play('SYSTEM_CH_HWANMODE', 'end', v)
    await run(fx, 4000)
    expect(loop.done).toBe(true)
    expect(fx.runner.stats).toMatchObject({ live: 0, started: 9, disposed: 9 })
    fx.dispose()
  })

  it('unknown keys and phases without rows play nothing', () => {
    const fx = new SystemFx(scene, { runner: new FxRunner(scene, { library: library() }), groups: GROUPS })
    expect(fx.play('SYSTEM_NOPE', 'start', fakeView()).done).toBe(true)
    expect(fx.play('SYSTEM_LEVELUP', 'loop', fakeView()).done).toBe(true)
    expect(phaseRows(GROUPS.get('SYSTEM_CH_HWANMODE'), 'loop')).toHaveLength(7)
    fx.dispose()
  })

  it('rows sit on their bone (or the root) and follow the carrier', () => {
    const v = fakeView(3, 4)
    const onSpine = viewPose(v, 'Bip01 Spine')()
    expect(onSpine.position[0]).toBeCloseTo(3)
    expect(onSpine.position[1]).toBeCloseTo(1.2)
    expect(onSpine.position[2]).toBeCloseTo(4)
    const atRoot = viewPose(v, 'Bip01 Missing', parseOffset('0,10,-13'))()
    expect(atRoot.position[1]).toBeCloseTo(1)
    // -z in the file is in front: +z (glTF forward) at yaw 0.
    expect(atRoot.position[2]).toBeCloseTo(4 + 1.3)
    v.root.position.x = 10
    expect(viewPose(v, null)().position[0]).toBeCloseTo(10)
  })
})

describe('consumables (itemEffect -> SYSTEM row)', () => {
  const item = (p: Partial<ItemDef>) => ({ code: 'X', ...p }) as ItemDef
  it('maps by cooldown group; pills play the cure effect; the rest nothing', () => {
    expect(itemEffectOf(item({ use: { hp: 120, cooldownGroup: 'hp' } }))).toEqual({ system: 'SYSTEM_HPPOTION' })
    expect(itemEffectOf(item({ use: { mp: 120, cooldownGroup: 'mp' } }))).toEqual({ system: 'SYSTEM_MPPOTION' })
    expect(itemEffectOf(item({ use: { hpPct: 10, cooldownGroup: 'vigor' } }))).toEqual({ system: 'SYSTEM_LIFE' })
    expect(itemEffectOf(item({ use: { hp: 360, cooldownGroup: 'cos_hp', target: 'mount' } }))).toEqual({ system: 'SYSTEM_COS_HPPOTION' })
    expect(itemEffectOf(item({ use: { cooldownGroup: 'cure' }, cureLevel: 36 }))).toEqual({ efp: CURE_EFFECT })
    expect(itemEffectOf(item({ use: { hp: 50 } }))).toEqual({ system: 'SYSTEM_HPPOTION' })
    expect(itemEffectOf(item({ use: { returnToTown: true, castMs: 30000 } }))).toBeNull()
    expect(itemEffectOf(undefined)).toBeNull()
  })

  it('mobs fade in over 0.4 s', () => {
    expect(spawnFade(0)).toBe(0)
    expect(spawnFade(200)).toBeCloseTo(0.5)
    expect(spawnFade(1000)).toBe(1)
  })
})

describe.runIf(existsSync(SKILLS))('the exported system rows', () => {
  const json = JSON.parse(readFileSync(SKILLS, 'utf8')) as { characters?: Record<string, { dieModel: unknown }> }
  const groups = readSystemGroups(json)

  it('has every key the client plays, each with its effect programs on disk', () => {
    for (const key of SYSTEM_FX_KEYS) {
      const g = groups.get(key)
      expect(g, key).toBeTruthy()
      for (const st of g!.stages) {
        if (!st.effect) continue
        const file = join(ROOT, 'work', 'out', FxLibrary.programPath(st.effect))
        expect(existsSync(file), `${key} ${st.effect}`).toBe(true)
      }
    }
    expect(phaseRows(groups.get('SYSTEM_LEVELUP'), 'start').map(s => s.effect)).toEqual(['system/system_levelup.efp'])
    expect(phaseRows(groups.get('SYSTEM_CH_HWANMODE'), 'loop')).toHaveLength(7)
  })

  it('Mangnyang and Tombstone swap to their Die Bsr model', () => {
    expect(json.characters?.MOB_CH_MANGNYANG?.dieModel).toBeTruthy()
    expect(json.characters?.MOB_CH_TOMBSTONE?.dieModel).toBeTruthy()
  })
})

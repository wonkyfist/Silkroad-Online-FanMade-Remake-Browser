/**
 * The jump on the client (docs/MOVEMENT.md §6, §8.2 client list; lane MV-C; no `jumpLift`, WAVE_PLAN6 D21):
 * the Space binding, the intent, the client cooldown gate, prediction and the echo window, the no-prediction states,
 * the refusal toasts, the focused-button blur (world/features/movement.ts); the clip choice, the one seek budget, the
 * base resume at `exitPhaseS`, the grounded cancels, the arm layer and the blend speeds (three/models.ts,
 * world/entities.ts); the take-off and landing steps (audio/entity.ts). NullEngine, synthetic actors and a synthetic
 * movement pack built in memory (no glb, no fetch); the real pack's index is checked when an export has it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Animation, AnimationGroup, AssetContainer, Bone, Matrix, MeshBuilder, NullEngine, Scene, Skeleton, TransformNode } from '@babylonjs/core'
import type { BoundItem } from '@sro/appearance'
import { JUMP_COOLDOWN_MS, JUMP_ECHO_WINDOW_MS, JUMP_LATE_DROP_MS, JUMP_MAX_SEEK_MS, type ClipTrack, type EntityState, type ServerMessage, type SoundIndex, type SoundSurface } from '@sro/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EntitySound, JUMP_LAND_GAIN, jumpSurface, type EntityPlay, type EntitySoundHost, type SoundView } from '../src/audio/entity.ts'
import { KeyMap, type KeyEventLike } from '../src/hud/keys.ts'
import { keyHelpGroups } from '../src/hud/keyhelp.ts'
import { en } from '../src/i18n/en.ts'
import {
  armLayerSides,
  CharacterActor,
  isArmJoint,
  JUMP_LAND_RAW,
  JUMP_TAKEOFF_RAW,
  jumpSeekS,
  KEEP_CLIPS,
  MOVE_BLEND_IN,
  MOVE_BLEND_OUT,
  moveEventTimes,
  movementPackPaths,
  movementTracksOf,
  parseMovementIndex,
  runEntrySeekS,
  skeletonNameOf,
  type MovementIndex,
  type MovementPack,
} from '../src/three/models.ts'
import { EntityView, type EntityContext } from '../src/world/entities.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { blurFocusedControl, HELD_STATUSES, JUMP_ECHO_EXPIRY_MS, JumpEcho, JumpGate, movementFeature, predictsJump, type JumpSelfState } from '../src/world/features/movement.ts'
import { intents } from '../src/world/intents.ts'
import { validateClientMessage } from '@sro/shared'

// ---- a DOM stub for EntityView's label (the game tests run in node) --------------------------------------------------

class StubElement {
  className = ''
  textContent = ''
  hidden = false
  readonly style: Record<string, string> = {}
  readonly children: StubElement[] = []
  readonly classList = {
    toggle: (c: string, on?: boolean) => {
      const has = this.className.split(' ').includes(c)
      const want = on ?? !has
      if (want && !has) this.className = `${this.className} ${c}`.trim()
      if (!want && has) this.className = this.className.split(' ').filter(x => x !== c).join(' ')
      return want
    },
    add: (c: string) => void this.classList.toggle(c, true),
    remove: (c: string) => void this.classList.toggle(c, false),
    contains: (c: string) => this.className.split(' ').includes(c),
  }
  append(...c: unknown[]): void {
    for (const x of c) if (x instanceof StubElement) this.children.push(x)
  }
  insertBefore(c: StubElement): void {
    this.children.unshift(c)
  }
  remove(): void {}
}

let engine: NullEngine
let scene: Scene
const hadDocument = 'document' in globalThis

/** Built once, before any actor exists: `contain` moves everything in the scene into its container. */
let BODY: AssetContainer
let PACK: MovementPack
let SHIELD: AssetContainer

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  if (!hadDocument) (globalThis as { document?: unknown }).document = { createElement: () => new StubElement(), activeElement: null }
  BODY = bodyContainer()
  PACK = { container: packContainer(), index: INDEX }
  SHIELD = contain(() => MeshBuilder.CreateBox('shield:mesh', { size: 0.1 }, scene))
})

afterAll(() => {
  if (!hadDocument) delete (globalThis as { document?: unknown }).document
  scene.dispose()
  engine.dispose()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- a synthetic skeleton, body clips and movement pack (60 fps key axis, as glTF clips) ------------------------------

const JOINTS = ['Bip01 Pelvis', 'Bip01 L UpperArm', 'Bip01 R UpperArm', 'Bip01 L Hand', 'Bip01 R Hand', 'Bip01 L Thigh']
const FPS = 60
/** Body clips (frames on the 60 fps axis): the fist RUN 0.8 s, the weapon RUNs 0.666 s, stands 1 s. */
const BODY_CLIPS: [string, number][] = [
  ['STAND1', 60], ['ATTREADY', 60], ['RUN', 48], ['WALK', 60], ['SIT', 60], ['STAND_UP', 30], ['DIE1', 30], ['ATTACK1', 40],
  ['RUN_chinaman_fighter_runforward_sword', 40], ['RUN_spear_run_fighter', 40], ['STAND1_spear_stand_city01', 60],
  ['ATTREADY_spear_stand', 60], ['RUN_bow_run_fighter', 40], ['ATTREADY_bow_stand', 60], ['STAND1_cart_stand01', 60],
]

function contain(build: () => void): AssetContainer {
  build()
  const c = new AssetContainer(scene)
  c.moveAllFromScene()
  return c
}

function track(name: string, frames: number): Animation {
  const a = new Animation(name, 'position.y', FPS, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE)
  a.setKeys([{ frame: 0, value: 0 }, { frame: frames, value: frames / 100 }])
  return a
}

function skeletonNodes(rootName: string): TransformNode[] {
  const root = new TransformNode(rootName, scene)
  return JOINTS.map(n => {
    const t = new TransformNode(n, scene)
    t.parent = root
    return t
  })
}

function bodyContainer(): AssetContainer {
  return contain(() => {
    const nodes = skeletonNodes('__root__')
    const body = MeshBuilder.CreateBox('body', { size: 1 }, scene)
    body.parent = nodes[0]!.parent
    // The weapon hand as a skeleton bone: sockets (the shield) hang on it.
    const skel = new Skeleton('skel', 'skel', scene)
    const hand = nodes.find(n => n.name === 'Bip01 R Hand')!
    new Bone('Bip01 R Hand', skel, null, Matrix.Identity()).linkTransformNode(hand)
    body.skeleton = skel
    for (const [name, frames] of BODY_CLIPS) {
      const g = new AnimationGroup(name, scene)
      for (const n of nodes) g.addTargetedAnimation(track(`${name}:${n.name}`, frames), n)
    }
  })
}

const ev = (timeMs: number, p1: string) => ({ timeMs, type: 2, p1, p2: 0 })
const RAW_INDEX = {
  clips: {
    JUMP: { anim: 'man_jump', durationMs: 1100, fps: 30, events: [ev(200, 'takeoff'), ev(633, 'land')], air: new Array(34).fill(0) },
    JUMP_RUN: { anim: 'man_jump_run', durationMs: 867, fps: 30, events: [ev(133, 'takeoff'), ev(533, 'land')], run: 'RUN_chinaman_fighter_runforward_sword', enterPhaseS: 0.3, exitPhaseS: 0.3 },
    JUMP_RUN_FIST: { anim: 'man_jump_run_fist', durationMs: 1000, fps: 30, events: [ev(200, 'takeoff'), ev(600, 'land')], run: 'RUN', enterPhaseS: 0, exitPhaseS: 0 },
  },
  runJumps: { RUN_chinaman_fighter_runforward_sword: 'JUMP_RUN', RUN_spear_run_fighter: 'JUMP_RUN', RUN_bow_run_fighter: 'JUMP_RUN', RUN: 'JUMP_RUN_FIST' },
}
const INDEX = parseMovementIndex(RAW_INDEX)!

function packContainer(): AssetContainer {
  return contain(() => {
    const nodes = skeletonNodes('pack')
    for (const [anim, frames] of [['man_jump', 66], ['man_jump_run', 52], ['man_jump_run_fist', 60]] as const) {
      const g = new AnimationGroup(anim, scene)
      for (const n of nodes) g.addTargetedAnimation(track(`${anim}:${n.name}`, frames), n)
    }
  })
}

const thePack = (): MovementPack => PACK
const SIDECAR = { animationPacks: { format: 'sro-anim-packs', version: 1, skeleton: 'europeman_skel', packs: {}, clips: {} } }

/** A player actor with its body clips; `withPack` retargets the movement pack onto it. */
function makeActor(opts: { withPack?: boolean; family?: 'sword' | 'spear' | 'bow' | null } = {}): CharacterActor {
  const a = new CharacterActor(scene, { code: 'CHAR_CH_MAN_ADVENTURER', glb: '/out/t.glb' }, { container: BODY, sidecar: SIDECAR, packs: null })
  a.family = opts.family ?? null
  if (opts.withPack !== false) a.addMovementClips(thePack())
  a.play('STAND1', true)
  return a
}

const playing = (a: CharacterActor, name: string) => !!a.group(name)?.isPlaying
const frameOf = (g: AnimationGroup | undefined) => g?.animatables[0]?.masterFrame ?? NaN
const socketItem = (code: string, slot: BoundItem['slot']): BoundItem => ({ code, slot, kind: 'socket', glb: `/out/equipment/${code}.glb`, attachBone: 'Bip01 R Hand', joints: [], meshes: [] })

function makeView(actor: CharacterActor | null, now = { t: 0 }): EntityView {
  const state: EntityState = { id: 7, kind: 'player', name: 'Hero_1', model: 'CHAR_CH_MAN_ADVENTURER', level: 5, weapon: 'sword', pos: [0, 0, 0], yaw: 0 }
  const ctx = {
    scene,
    library: null,
    catalog: null,
    labels: new StubElement(),
    drops: null,
    heightAt: () => 0,
    selfId: () => 1,
    selfLevel: () => 5,
    serverNow: () => now.t,
    attachments: [],
  } as unknown as EntityContext
  const v = new EntityView(state, ctx)
  if (actor) {
    v.actor = actor
    actor.root.parent = v.root
  }
  return v
}

const RUN_MOVE = { from: [0, 0, 0] as [number, number, number], to: [1000, 0, 0] as [number, number, number], speed: 5.5, startedAt: 0 }

// ---- the index, the pack path and the pure rules ----------------------------------------------------------------------

describe('movement index and pure rules', () => {
  it('parses MV-A\'s index: clips, events, air, the RUN phases and runJumps; drops what is broken', () => {
    expect(Object.keys(INDEX.clips).sort()).toEqual(['JUMP', 'JUMP_RUN', 'JUMP_RUN_FIST'])
    expect(INDEX.clips.JUMP_RUN).toMatchObject({ anim: 'man_jump_run', durationMs: 867, run: 'RUN_chinaman_fighter_runforward_sword', enterPhaseS: 0.3, exitPhaseS: 0.3 })
    expect(INDEX.clips.JUMP!.air).toHaveLength(34)
    expect(INDEX.runJumps.RUN).toBe('JUMP_RUN_FIST')
    expect(moveEventTimes(INDEX.clips.JUMP!)).toEqual({ takeoffMs: 200, landMs: 633 })
    expect(parseMovementIndex(null)).toBeNull()
    expect(parseMovementIndex({ clips: {} })).toBeNull()
    const bad = parseMovementIndex({
      clips: { JUMP: { anim: 'a', durationMs: 1000, events: [] }, NOPE: { anim: 'b', durationMs: 5 }, JUMP_X: { anim: 3, durationMs: 5 }, JUMP_Y: { anim: 'c', durationMs: NaN } },
      runJumps: { RUN: 'JUMP_MISSING', RUN_x: 'JUMP' },
    })!
    expect(Object.keys(bad.clips)).toEqual(['JUMP'])
    expect(bad.runJumps).toEqual({ RUN_x: 'JUMP' })
  })

  it('finds the pack of a skeleton: the slim sidecar\'s skeleton, else the unslimmed .bsk basename', () => {
    expect(movementPackPaths('europeman_skel')).toEqual({ glb: 'char/_anims/europeman_skel/movement.glb', index: 'char/_anims/europeman_skel/movement.json' })
    expect(skeletonNameOf(SIDECAR)).toBe('europeman_skel')
    expect(skeletonNameOf({ skeleton: { bsk: 'prim\\skel\\char\\europe\\europewoman_skel.bsk' } })).toBe('europewoman_skel')
    expect(skeletonNameOf({ skeleton: { bsk: '../../evil path.bsk' } })).toBeNull()
    expect(skeletonNameOf(null)).toBeNull()
  })

  it('one seek budget: the latency seek (≤ JUMP_MAX_SEEK_MS) plus the phase seek, the phase dropped past the cap', () => {
    expect(jumpSeekS(0)).toBe(0)
    expect(jumpSeekS(-50)).toBe(0)
    expect(jumpSeekS(120)).toBeCloseTo(0.12, 9)
    expect(jumpSeekS(900)).toBeCloseTo(JUMP_MAX_SEEK_MS / 1000, 9)
    expect(jumpSeekS(100, 0.05)).toBeCloseTo(0.15, 9)
    expect(jumpSeekS(180, 0.05)).toBeCloseTo(0.18, 9) // the sum would pass 0.2 s: latency only
    expect(jumpSeekS(0, 0.14)).toBeCloseTo(0.14, 9)
    expect(jumpSeekS(NaN, NaN)).toBe(0)
  })

  it('the JUMP_RUN entry seek: only within the first 0.15 s of its own RUN\'s right stance, across the loop', () => {
    expect(runEntrySeekS(0.35, 0.3, 0.666)).toBeCloseTo(0.05, 9)
    expect(runEntrySeekS(0.29, 0.3, 0.666)).toBe(0)
    expect(runEntrySeekS(0.5, 0.3, 0.666)).toBe(0)
    expect(runEntrySeekS(0.05, 0.6, 0.666)).toBeCloseTo(0.116, 6) // past the wrap
    expect(runEntrySeekS(0.1, 0, 0.8)).toBeCloseTo(0.1, 9)
    expect(runEntrySeekS(0.1, 0, 0)).toBe(0)
  })

  it('the take-off and landing become run steps: one at the take-off, two at the landing 30 ms apart', () => {
    const t = movementTracksOf(INDEX.clips.JUMP!)
    expect(t.map(x => [x.ms, x.handle, x.raw])).toEqual([[200, 'step_run', JUMP_TAKEOFF_RAW], [633, 'step_run', JUMP_LAND_RAW], [663, 'step_run', JUMP_LAND_RAW]])
    expect(t.every(x => /^player\/mv(walk|run)/.test(x.file))).toBe(true)
  })

  it('the weapon-arm joints and which arms each family holds', () => {
    expect(isArmJoint('Bip01 R Clavicle', ['R'])).toBe(true)
    expect(isArmJoint('Bip01 R Finger01', ['R'])).toBe(true)
    expect(isArmJoint('Bip01 L HandMid2', ['L'])).toBe(true)
    expect(isArmJoint('Bip01 L UpperArm', ['R'])).toBe(false)
    expect(isArmJoint('Bip01 R Thigh', ['L', 'R'])).toBe(false)
    expect(isArmJoint('Bip01 Pelvis', ['L', 'R'])).toBe(false)
    expect(armLayerSides(null, false)).toEqual([])
    expect(armLayerSides('sword', false)).toEqual(['R'])
    expect(armLayerSides('blade', true)).toEqual(['L', 'R'])
    for (const f of ['spear', 'glaive', 'bow'] as const) expect(armLayerSides(f, false)).toEqual(['L', 'R'])
  })
})

// ---- the actor: loading, the clip choice, seeks, the base resume, the arm layer -------------------------------------

describe('CharacterActor movement', () => {
  it('KEEP_CLIPS keeps the movement clips', () => {
    for (const name of Object.keys(INDEX.clips)) expect(KEEP_CLIPS.test(name), name).toBe(true)
  })

  it('a missing movement pack plays nothing and throws nothing (an old tree, a failing fetch)', async () => {
    const a = makeActor({ withPack: false })
    expect(a.skeletonName).toBe('europeman_skel')
    expect(await a.ensureMovementClips()).toBe(false) // no loader (not built by a ModelLibrary)
    a.loadMovement = async () => null
    expect(await a.ensureMovementClips()).toBe(false)
    expect(a.hasMovementClips).toBe(false)
    expect(a.playMove('jump', { at: 0, now: 0 })).toBe(false)
    expect(playing(a, 'STAND1')).toBe(true)
    const b = makeActor({ withPack: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    b.loadMovement = () => Promise.reject(new Error('404'))
    expect(await b.ensureMovementClips()).toBe(false)
    expect(warn).toHaveBeenCalled()
    expect(makeView(b).jump(0, 0)).toBe(false)
    a.dispose()
    b.dispose()
  })

  it('loads the pack once per actor and retargets its clips onto the actor\'s joints (blend in 0.25)', async () => {
    const a = makeActor({ withPack: false })
    let loads = 0
    a.loadMovement = async skel => {
      loads++
      expect(skel).toBe('europeman_skel')
      return thePack()
    }
    const [x, y] = await Promise.all([a.ensureMovementClips(), a.ensureMovementClips()])
    expect([x, y, loads]).toEqual([true, true, 1])
    expect(a.hasMovementClips).toBe(true)
    const jump = a.group('JUMP')!
    const joints = new Set(a.root.getDescendants(false))
    for (const ta of jump.targetedAnimations) expect(joints.has(ta.target as TransformNode), (ta.target as TransformNode).name).toBe(true)
    expect(jump.blendingSpeed).toBe(MOVE_BLEND_IN)
    expect(a.clips.get('JUMP')?.durationMs).toBe(1100)
    expect(a.movementTracks('JUMP_RUN')?.length).toBe(3)
    a.dispose()
  })

  it('JUMP vs JUMP_RUN by the base clip; the JUMP_RUN of the RUN it plays (sword man: weapon cycle, unarmed: fist)', async () => {
    const sword = makeActor({ family: 'sword' })
    expect(sword.movementClip('jump')?.name).toBe('JUMP')
    sword.play('ATTREADY')
    expect(sword.movementClip('jump')?.name).toBe('JUMP')
    sword.play('WALK')
    expect(sword.movementClip('jump')?.name).toBe('JUMP')
    sword.play('RUN')
    expect(sword.clipFor('RUN')?.name).toBe('RUN_chinaman_fighter_runforward_sword')
    expect(sword.movementClip('jump')?.name).toBe('JUMP_RUN')
    const fist = makeActor()
    fist.play('RUN')
    expect(fist.movementClip('jump')?.name).toBe('JUMP_RUN_FIST')
    const spear = makeActor({ family: 'spear' })
    spear.play('RUN')
    expect(spear.movementClip('jump')?.name).toBe('JUMP_RUN')
    // Mounted: no jump at all.
    await fist.useClipGroup('cart')
    fist.play('STAND1')
    expect(fist.movementClip('jump')).toBeUndefined()
    expect(fist.playMove('jump')).toBe(false)
    for (const a of [sword, fist, spear]) a.dispose()
  })

  it('after JUMP_RUN the base RUN resumes at exitPhaseS, not at 0; a runner who stopped gets STAND1 from its start', () => {
    const a = makeActor({ family: 'sword' })
    a.play('RUN')
    const run = a.group('RUN_chinaman_fighter_runforward_sword')!
    run.goToFrame(6) // 0.1 s: outside the entry window (0.3 s ..)
    expect(a.playMove('jump')).toBe(true)
    const jr = a.group('JUMP_RUN')!
    expect(playing(a, 'JUMP_RUN')).toBe(true)
    expect(frameOf(jr)).toBeCloseTo(0, 3)
    jr.stop() // the end: the base comes back
    expect(run.isPlaying).toBe(true)
    expect(frameOf(run)).toBeCloseTo(0.3 * FPS, 3)
    // A runner who stopped before the end: STAND1 resumes from its first frame.
    a.playMove('jump')
    a.play('STAND1')
    a.group('JUMP_RUN')!.stop()
    expect(playing(a, 'STAND1')).toBe(true)
    expect(frameOf(a.group('STAND1'))).toBeCloseTo(0, 3)
    a.dispose()
  })

  it('JUMP_RUN seeks into its start within the entry window; the latency seek shares the 200 ms budget', () => {
    const a = makeActor({ family: 'sword' })
    a.play('RUN')
    const run = a.group('RUN_chinaman_fighter_runforward_sword')!
    run.goToFrame(0.35 * FPS) // 0.05 s past the right contact
    a.playMove('jump')
    expect(frameOf(a.group('JUMP_RUN'))).toBeCloseTo(0.05 * FPS, 3)
    a.group('JUMP_RUN')!.stop()
    a.group('RUN_chinaman_fighter_runforward_sword')!.goToFrame(0.35 * FPS)
    a.playMove('jump', { at: 1000, now: 1100 }) // 0.1 + 0.05 ≤ 0.2
    expect(frameOf(a.group('JUMP_RUN'))).toBeCloseTo(0.15 * FPS, 3)
    a.group('JUMP_RUN')!.stop()
    a.group('RUN_chinaman_fighter_runforward_sword')!.goToFrame(0.35 * FPS)
    a.playMove('jump', { at: 1000, now: 1180 }) // 0.18 + 0.05 > 0.2: the phase seek is dropped
    expect(frameOf(a.group('JUMP_RUN'))).toBeCloseTo(0.18 * FPS, 3)
    // A standing jump seen late: the latency seek alone, capped at the take-off.
    a.group('JUMP_RUN')!.stop()
    a.play('STAND1')
    a.playMove('jump', { at: 1000, now: 1500 })
    expect(frameOf(a.group('JUMP'))).toBeCloseTo((JUMP_MAX_SEEK_MS / 1000) * FPS, 3)
    a.dispose()
  })

  it('the base blends back at 0.12 after a movement clip, and gets its own 0.08 back afterwards', () => {
    const a = makeActor()
    a.playMove('jump')
    const stand = a.group('STAND1')!
    a.group('JUMP')!.stop()
    expect(stand.isPlaying).toBe(true)
    expect(stand.blendingSpeed).toBe(MOVE_BLEND_OUT)
    for (let i = 0; i < 12; i++) a.lodTick(i * 16, null)
    expect(stand.blendingSpeed).toBe(0.08)
    // An ordinary action ending leaves the base's speed alone.
    a.playAction(a.group('ATTACK1')!)
    a.group('ATTACK1')!.stop()
    expect(stand.blendingSpeed).toBe(0.08)
    a.dispose()
  })

  it('movePhase: before the take-off, in the air, after the landing; null without a movement clip', () => {
    const a = makeActor()
    expect(a.movePhase()).toBeNull()
    a.playMove('jump')
    const j = a.group('JUMP')!
    expect(a.movePhase()).toBe('before')
    j.goToFrame(0.3 * FPS)
    expect(a.movePhase()).toBe('air')
    j.goToFrame(0.7 * FPS)
    expect(a.movePhase()).toBe('after')
    expect(a.moveClip).toBe('JUMP')
    a.playAction(a.group('ATTACK1')!) // the next swing replaces the jump (accepted, §6.2)
    expect(a.movePhase()).toBeNull()
    expect(a.moveClip).toBeNull()
    a.dispose()
  })

  it('the masked arm layer: none standing with a sword or unarmed; the sword arm running; both arms for a spear', () => {
    const sword = makeActor({ family: 'sword' })
    sword.playMove('jump')
    expect(sword.armLayerName).toBeNull() // the sword stand is the default STAND1 the jump was keyed from
    sword.group('JUMP')!.stop()
    sword.play('RUN')
    const run = sword.group('RUN_chinaman_fighter_runforward_sword')!
    run.goToFrame(6)
    sword.playMove('jump')
    expect(sword.armLayerName).toBe('ARMS:RUN_chinaman_fighter_runforward_sword:R')
    const layer = sword.group('ARMS:RUN_chinaman_fighter_runforward_sword:R')!
    expect(layer.isPlaying).toBe(true)
    expect(layer.targetedAnimations.map(t => (t.target as TransformNode).name).sort()).toEqual(['Bip01 R Hand', 'Bip01 R UpperArm'])
    // In step with the JUMP_RUN's own base cycle: that cycle's entry phase.
    expect(frameOf(layer)).toBeCloseTo(0.3 * FPS, 3)
    const groups = sword.groups.length
    sword.group('JUMP_RUN')!.stop()
    expect(layer.isPlaying).toBe(false) // stopped with the jump, not disposed
    sword.playMove('jump')
    expect(sword.groups.length).toBe(groups) // made once
    const spear = makeActor({ family: 'spear' })
    spear.playMove('jump')
    expect(spear.armLayerName).toBe('ARMS:STAND1_spear_stand_city01:LR')
    spear.play('ATTREADY')
    spear.group('JUMP')!.stop()
    spear.playMove('jump')
    expect(spear.armLayerName).toBe('ARMS:ATTREADY_spear_stand:LR')
    const bow = makeActor({ family: 'bow' })
    bow.playMove('jump')
    expect(bow.armLayerName).toBeNull() // bow outside the combat stance: the default STAND1
    bow.play('ATTREADY')
    bow.group('JUMP')!.stop()
    bow.playMove('jump')
    expect(bow.armLayerName).toBe('ARMS:ATTREADY_bow_stand:LR')
    const fist = makeActor()
    fist.play('RUN')
    fist.playMove('jump')
    expect(fist.armLayerName).toBeNull()
    // Disposed with the actor (no leak across world visits).
    const names = sword.groups.map(g => g.name)
    sword.dispose()
    for (const n of names) expect(scene.animationGroups.some(g => g.name === n && !g.targetedAnimations.length), n).toBe(false)
    for (const a of [spear, bow, fist]) a.dispose()
  })

  it('a sword with a shield holds both arms; a skill or a death stops the layer', () => {
    const a = makeActor({ family: 'sword' })
    a.applyDress({
      comp: null,
      items: [{ item: socketItem('ITEM_CH_SHIELD_01_A', 'shield'), container: SHIELD, sidecar: null }],
      fallback: null,
      family: 'sword',
      gender: 'male',
      volume: undefined,
    })
    a.play('RUN')
    a.playMove('jump')
    expect(a.armLayerName).toBe('ARMS:RUN_chinaman_fighter_runforward_sword:LR')
    a.playSkill([{ clip: a.group('ATTACK1')!, ms: 100 }])
    expect(a.armLayerName).toBeNull()
    expect(a.skillActing).toBe(true)
    a.playMove('jump')
    expect(a.skillActing).toBe(false)
    a.die()
    expect(a.armLayerName).toBeNull()
    expect(a.groups.filter(g => g.name.startsWith('ARMS:')).every(g => !g.isPlaying)).toBe(true)
    a.dispose()
  })
})

// ---- the view: the late drop, the grounded cancels -------------------------------------------------------------------

describe('EntityView jump', () => {
  it('drops a jump that arrives more than JUMP_LATE_DROP_MS late; plays one at the limit', () => {
    const a = makeActor()
    const v = makeView(a)
    expect(v.jump(1000, 1000 + JUMP_LATE_DROP_MS + 1)).toBe(false)
    expect(playing(a, 'JUMP')).toBe(false)
    expect(v.jump(1000, 1000 + JUMP_LATE_DROP_MS)).toBe(true)
    expect(playing(a, 'JUMP')).toBe(true)
    v.dispose()
  })

  it('a moving entity keeps JUMP_RUN (the MOVE_CANCELS rule does not match it)', () => {
    const now = { t: 0 }
    const a = makeActor({ family: 'sword' })
    const v = makeView(a, now)
    v.setMove(RUN_MOVE)
    now.t = 100
    v.update(now.t, 0.016)
    expect(v.jump(now.t, now.t)).toBe(true)
    expect(playing(a, 'JUMP_RUN')).toBe(true)
    for (const t of [120, 400, 800]) {
      a.group('JUMP_RUN')!.goToFrame(((t - 100) / 1000) * FPS)
      v.update(t, 0.016)
      expect(playing(a, 'JUMP_RUN'), `${t}`).toBe(true)
    }
    v.dispose()
  })

  it('a move cancels a standing JUMP before the take-off and after the landing, never in the air', () => {
    const now = { t: 0 }
    const a = makeActor()
    const v = makeView(a, now)
    v.update(0, 0.016)
    // Before the take-off: the move cuts it to RUN at once (no glide in a crouch).
    v.jump(0, 0)
    a.group('JUMP')!.goToFrame(0.1 * FPS)
    v.setMove({ ...RUN_MOVE, startedAt: 0 })
    v.update(10, 0.016)
    expect(playing(a, 'JUMP')).toBe(false)
    expect(playing(a, 'RUN')).toBe(true)
    // In the air: it plays out over the slide; after the landing the move cuts it.
    v.stop([0, 0, 0], 0)
    v.update(20, 0.016)
    v.jump(20, 20)
    const j = a.group('JUMP')!
    j.goToFrame(0.3 * FPS)
    v.setMove({ ...RUN_MOVE, startedAt: 20 })
    v.update(30, 0.016)
    expect(playing(a, 'JUMP')).toBe(true)
    j.goToFrame(0.65 * FPS)
    v.update(40, 0.016)
    expect(playing(a, 'JUMP')).toBe(false)
    expect(playing(a, 'RUN')).toBe(true)
    v.dispose()
  })

  it('a stop after the landing cuts JUMP_RUN to the idle; before the landing the air plays out', () => {
    const now = { t: 0 }
    const a = makeActor({ family: 'sword' })
    const v = makeView(a, now)
    v.setMove(RUN_MOVE)
    v.update(10, 0.016)
    v.jump(10, 10)
    const jr = a.group('JUMP_RUN')!
    jr.goToFrame(0.3 * FPS) // in the air (take-off 133 ms, land 533 ms)
    v.stop([1, 0, 0], 0)
    v.update(20, 0.016)
    expect(playing(a, 'JUMP_RUN')).toBe(true)
    jr.goToFrame(0.6 * FPS)
    v.update(30, 0.016)
    expect(playing(a, 'JUMP_RUN')).toBe(false)
    expect(playing(a, 'STAND1')).toBe(true)
    expect(a.group('STAND1')!.blendingSpeed).toBe(MOVE_BLEND_OUT)
    v.dispose()
  })
})

// ---- the feature: key, gate, prediction, echo, toasts -----------------------------------------------------------------

interface FakeSelf {
  id: number
  kind: 'player'
  dead: boolean
  idle: 'stand' | 'combat' | 'sit' | 'vendor'
  state: Partial<EntityState> & { effects?: { instance: number; status?: string; remainingMs: number }[] }
  actor: { skillActing: boolean; clipGroup: 'default' | 'cart'; ensureMovementClips: () => Promise<boolean> } | null
  jump: ReturnType<typeof vi.fn>
}

function harness(opts: { self?: Partial<FakeSelf> } = {}) {
  const keys = new KeyMap()
  const clock = { t: 10_000 }
  const sent: unknown[] = []
  const toasts: string[] = []
  const ensure = vi.fn(async () => true)
  const self: FakeSelf = {
    id: 1,
    kind: 'player',
    dead: false,
    idle: 'stand',
    state: {},
    actor: { skillActing: false, clipGroup: 'default', ensureMovementClips: ensure },
    jump: vi.fn(() => true),
    ...opts.self,
  }
  const other = { id: 2, kind: 'player', dead: false, jump: vi.fn(() => true), actor: { ensureMovementClips: ensure } }
  const attachments: ((v: unknown) => unknown)[] = []
  const views = new Map<number, unknown>([[1, self], [2, other]])
  const ctx = {
    keys,
    hud: { toast: (text: string) => toasts.push(text) },
    send: (m: unknown) => (sent.push(m), true),
    selfId: () => 1,
    view: (id: number) => views.get(id),
    views: () => views.values(),
    serverNow: () => clock.t,
    addAttachment: (f: (v: unknown) => unknown) => (attachments.push(f), () => {}),
  } as unknown as WorldFeatureContext
  const feature = movementFeature(ctx, () => clock.t)
  const space = (over: Partial<KeyEventLike> = {}) => keys.handle({ key: ' ', type: 'keydown', repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: null, preventDefault() {}, ...over })
  const msg = (m: ServerMessage) => feature.onMessage?.(m)
  return { keys, clock, sent, toasts, self, other, feature, space, msg, ensure, attachments }
}

describe('the movement feature', () => {
  it('binds Space in the movement group (the key help lists it); never while typing, never on key repeat', () => {
    const h = harness()
    const b = h.keys.list().find(x => x.id === 'movement.jump')!
    expect(b.keys).toEqual([' '])
    expect(b.group).toBe('movement')
    expect(en['movement.key.jump']).toBe('Jump')
    expect(keyHelpGroups(h.keys.list()).find(g => g.group === 'movement')?.rows).toEqual([{ keys: 'Space', label: 'movement.key.jump' }])
    h.space({ target: { tagName: 'INPUT' } as unknown as EventTarget })
    h.space({ target: { tagName: 'TEXTAREA' } as unknown as EventTarget })
    h.space({ repeat: true })
    expect(h.sent).toEqual([])
    h.space()
    expect(h.sent).toEqual([{ t: 'jump' }])
    expect(validateClientMessage(intents.jump()).ok).toBe(true)
    h.feature.dispose?.()
    expect(h.keys.list().some(x => x.id === 'movement.jump')).toBe(false)
  })

  it('the client cooldown gate sends nothing within 1 s of the last press (silently), then sends again', () => {
    const h = harness()
    h.space()
    h.clock.t += 400
    h.space()
    h.clock.t += JUMP_COOLDOWN_MS - 401
    h.space()
    expect(h.sent).toHaveLength(1)
    expect(h.toasts).toEqual([])
    h.clock.t += 1
    h.space()
    expect(h.sent).toHaveLength(2)
    const g = new JumpGate()
    expect([g.press(0), g.press(999), g.press(1000)]).toEqual([true, false, true])
  })

  it('predicts the own jump on the key press; its echo within the window does not restart it', () => {
    const h = harness()
    h.space()
    expect(h.self.jump).toHaveBeenCalledTimes(1)
    expect(h.self.jump).toHaveBeenLastCalledWith(10_000, 10_000)
    h.clock.t += 80
    h.msg({ t: 'jump', id: 1, at: 10_030 })
    expect(h.self.jump).toHaveBeenCalledTimes(1)
    // A later echo (a jump the client did not predict) plays.
    h.clock.t += JUMP_ECHO_WINDOW_MS
    h.msg({ t: 'jump', id: 1, at: h.clock.t - 40 })
    expect(h.self.jump).toHaveBeenCalledTimes(2)
    // Other players' jumps play with the server time of the jump and now.
    h.msg({ t: 'jump', id: 2, at: h.clock.t - 90 })
    expect(h.other.jump).toHaveBeenLastCalledWith(h.clock.t - 90, h.clock.t)
    // The echo is matched to its request (FIFO), not to a timer (MV-1).
    const e = new JumpEcho()
    e.sent(100, true)
    e.sent(1100, false)
    expect([e.swallow(150), e.swallow(1200)]).toEqual([true, false]) // a predicted press, then one that was not
    expect(e.swallow(1300)).toBe(false) // one echo per request; an unrequested echo plays
    e.sent(2000, true)
    e.refused(2050) // a refusal: no echo will come for it
    expect([e.size, e.swallow(2100)]).toEqual([0, false])
    e.sent(3000, true) // an answer that never came is forgotten
    expect([e.swallow(3000 + JUMP_ECHO_EXPIRY_MS + 1), e.size]).toEqual([false, 0])
  })

  it('the gate and the echo window run on the local clock: a server clock step does not replay the predicted jump', () => {
    const local = { t: 0 }
    const h = harness()
    h.self.jump.mockClear()
    const keys = new KeyMap()
    const f2 = movementFeature({ keys, hud: { toast() {} }, send: () => true, selfId: () => 1, view: () => h.self, views: () => [][Symbol.iterator](), serverNow: () => h.clock.t, addAttachment: () => () => {} } as unknown as WorldFeatureContext, () => local.t)
    keys.handle({ key: ' ', type: 'keydown', repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: null, preventDefault() {} })
    expect(h.self.jump).toHaveBeenCalledTimes(1)
    h.clock.t += 5_000 // the server clock steps between the press and the echo
    local.t += 150
    f2.onMessage?.({ t: 'jump', id: 1, at: h.clock.t })
    expect(h.self.jump).toHaveBeenCalledTimes(1)
    f2.dispose?.()
  })

  const noPredict: [string, Partial<FakeSelf>][] = [
    ['sitting', { idle: 'sit' }],
    ['a stall owner', { idle: 'vendor', state: { stall: 'Cheap' } }],
    ['mounted', { state: { mount: 99 } }],
    ['during an own skill action', { actor: { skillActing: true, clipGroup: 'default', ensureMovementClips: async () => true } }],
  ]
  for (const [what, self] of noPredict) {
    it(`no prediction ${what}: the request goes out, the echo plays the jump`, () => {
      const h = harness({ self })
      h.space()
      expect(h.sent).toEqual([{ t: 'jump' }])
      expect(h.self.jump).not.toHaveBeenCalled()
      h.clock.t += 60
      h.msg({ t: 'jump', id: 1, at: h.clock.t - 30 })
      expect(h.self.jump).toHaveBeenCalledWith(h.clock.t - 30, h.clock.t)
    })
  }

  it('no prediction while reading a return scroll or held (stun, freeze, knockdown, knockback); dead sends nothing', () => {
    const h = harness()
    h.msg({ t: 'itemCast', id: 1, item: 'ITEM_ETC_SCROLL_RETURN_01', castMs: 5000 })
    h.space()
    expect(h.self.jump).not.toHaveBeenCalled()
    h.msg({ t: 'itemCastEnd', id: 1, item: 'ITEM_ETC_SCROLL_RETURN_01', reason: 'cancelled' })
    h.clock.t += JUMP_COOLDOWN_MS
    h.msg({ t: 'effectAdd', id: 1, effect: { instance: 5, status: 'stun', remainingMs: 3000 } })
    h.msg({ t: 'effectAdd', id: 2, effect: { instance: 6, status: 'freeze', remainingMs: 3000 } })
    h.space()
    expect(h.self.jump).not.toHaveBeenCalled()
    h.msg({ t: 'effectRemove', id: 1, instance: 5 })
    h.clock.t += JUMP_COOLDOWN_MS
    h.space()
    expect(h.self.jump).toHaveBeenCalledTimes(1)
    expect([...HELD_STATUSES].sort()).toEqual(['freeze', 'knockback', 'knockdown', 'stun'])
    const dead = harness({ self: { dead: true } })
    dead.space()
    expect(dead.sent).toEqual([])
    const base: JumpSelfState = { dead: false, seated: false, mounted: false, stallOwner: false, held: false, skillAction: false, scrollCast: false }
    expect(predictsJump(base)).toBe(true)
    for (const k of Object.keys(base) as (keyof JumpSelfState)[]) expect(predictsJump({ ...base, [k]: true }), k).toBe(false)
  })

  it('a held status carried by the own spawn counts too', () => {
    const h = harness({ self: { state: { effects: [{ instance: 3, status: 'knockdown', remainingMs: 1000 }] } } })
    h.feature.onEntityAdded?.(h.self as unknown as EntityView)
    h.space()
    expect(h.self.jump).not.toHaveBeenCalled()
  })

  it('toasts only the mounted and stalling refusals; dead, cant_act, busy and cooldown are silent', () => {
    const h = harness()
    for (const reason of ['dead', 'cant_act', 'busy', 'cooldown', 'rate_limited'] as const) h.msg({ t: 'actionResult', re: 'jump', ok: false, reason })
    expect(h.toasts).toEqual([])
    h.msg({ t: 'actionResult', re: 'jump', ok: false, reason: 'mounted' })
    h.msg({ t: 'actionResult', re: 'jump', ok: false, reason: 'stalling' })
    h.msg({ t: 'actionResult', re: 'jump', ok: true })
    h.msg({ t: 'actionResult', re: 'sit', ok: false, reason: 'mounted' })
    expect(h.toasts).toEqual([en['movement.fail.mounted'], en['movement.fail.stalling']])
  })

  it('Space on a focused button jumps and does not click it (the button is blurred first)', () => {
    const h = harness()
    const blur = vi.fn()
    h.space({ target: { tagName: 'BUTTON', blur } as unknown as EventTarget })
    expect(blur).toHaveBeenCalledTimes(1)
    expect(h.sent).toEqual([{ t: 'jump' }])
    // The body and typing targets are never blurred.
    const bodyBlur = vi.fn()
    const inputBlur = vi.fn()
    blurFocusedControl({ tagName: 'BODY', blur: bodyBlur } as unknown as EventTarget, { tagName: 'INPUT', blur: inputBlur } as unknown as Element)
    expect(bodyBlur).not.toHaveBeenCalled()
    expect(inputBlur).not.toHaveBeenCalled()
  })

  it('loads the movement pack for player views once their model is in (views there already, and new ones)', () => {
    const h = harness()
    expect(h.ensure).toHaveBeenCalledTimes(2) // self and the other player
    const made = h.attachments[0]!({ kind: 'player', actor: { ensureMovementClips: h.ensure } }) as { loaded(): void }
    made.loaded()
    expect(h.ensure).toHaveBeenCalledTimes(3)
    expect(h.attachments[0]!({ kind: 'mob' })).toBeNull()
  })
})

// ---- audio: the take-off and landing steps ----------------------------------------------------------------------------

describe('jump sounds', () => {
  const index = {
    steps: {
      walk: { Dirt: ['player/mvwalkground'] },
      run: { Dirt: ['player/mvrunground'], Grass: ['player/mvrungrass'], Water: ['player/mvrunmud'] },
      objectFloor: 'Stone',
    },
    skills: {},
  } as unknown as SoundIndex

  function soundRig(opts: { surface?: SoundSurface; water?: number | null; y?: number } = {}) {
    const played: { file: string; opts: EntityPlay }[] = []
    let cursor = { name: 'JUMP', ms: 0, durationMs: 1100, run: 1 }
    const tracks = movementTracksOf(INDEX.clips.JUMP!)
    const host: EntitySoundHost = {
      index,
      distance: () => 5,
      surfaceAt: () => opts.surface ?? 'Grass',
      waterLevelAt: () => opts.water ?? null,
      modelTracks: () => ({ format: 'sro-sound-model', version: 1, code: 'CHAR_CH_MAN_ADVENTURER', bsr: '', clips: { RUN: [] } }),
      priorityOf: () => 1,
      playFile: (file, o) => played.push({ file, opts: o }),
      rng: () => 0,
    }
    const view: SoundView = {
      id: 2,
      kind: 'player',
      state: { model: 'CHAR_CH_MAN_ADVENTURER' },
      root: { position: { x: 1, y: opts.y ?? 0, z: 2 } },
      actor: { clipCursors: () => ({ top: cursor, overlay: null }), movementTracks: (clip: string): readonly ClipTrack[] | undefined => (clip === 'JUMP' ? tracks : undefined) },
      dead: false,
      isSelf: false,
    }
    const s = new EntitySound(host, view)
    const at = (ms: number, now: number) => {
      cursor = { ...cursor, ms }
      s.update(now)
    }
    return { played, at }
  }

  it('a run step of the surface at the take-off, and the landing twice at +2 dB', () => {
    const r = soundRig()
    r.at(0, 1000)
    expect(r.played).toEqual([])
    r.at(250, 1250)
    expect(r.played.map(p => [p.file, p.opts.gain])).toEqual([['player/mvrungrass', undefined]])
    r.at(700, 1700)
    expect(r.played.slice(1).map(p => [p.file, p.opts.gain])).toEqual([['player/mvrungrass', JUMP_LAND_GAIN], ['player/mvrungrass', JUMP_LAND_GAIN]])
    expect(JUMP_LAND_GAIN).toBeCloseTo(1.2589, 4)
  })

  it('a landing in water deeper than 0.1 m plays the water step; shallower plays the ground', () => {
    const wet = soundRig({ water: 5.5, y: 5.0 })
    wet.at(0, 0)
    wet.at(700, 700)
    expect(wet.played.every(p => p.file === 'player/mvrunmud')).toBe(true)
    expect(wet.played).toHaveLength(3)
    expect(jumpSurface('Sand', 5.0, 5.05)).toBe('Sand')
    expect(jumpSurface('Sand', 5.0, 5.2)).toBe('Water')
    expect(jumpSurface('Sand', 5.0, null)).toBe('Sand')
  })

  it('the synthetic raw names match the audio side', () => {
    expect([JUMP_TAKEOFF_RAW, JUMP_LAND_RAW]).toEqual(['jump_takeoff', 'jump_land'])
  })
})

// ---- the real pack, when an export has it (skipped otherwise) ---------------------------------------------------------

const ROOTS = ['work/out-opt', 'work/out'].map(r => join(__dirname, '..', '..', '..', r))
const realIndex = (skel: string): string | null => {
  for (const r of ROOTS) {
    const p = join(r, movementPackPaths(skel).index)
    if (existsSync(p)) return p
  }
  return null
}

describe.skipIf(!realIndex('europeman_skel'))('the exported movement index', () => {
  for (const skel of ['europeman_skel', 'europewoman_skel']) {
    it(`${skel}: JUMP and a JUMP_RUN for every RUN of the adventurer's families`, () => {
      const p = realIndex(skel)
      if (!p) return
      const idx: MovementIndex | null = parseMovementIndex(JSON.parse(readFileSync(p, 'utf8')))
      expect(idx).not.toBeNull()
      expect(idx!.clips.JUMP).toBeDefined()
      expect(Object.keys(idx!.runJumps)).toContain('RUN')
      for (const clip of Object.values(idx!.runJumps)) {
        const info = idx!.clips[clip]!
        expect(info.run, clip).toBeTypeOf('string')
        expect(moveEventTimes(info).takeoffMs).toBeLessThan(moveEventTimes(info).landMs)
      }
    })
  }
})

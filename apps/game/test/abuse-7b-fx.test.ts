/**
 * H7B adversarial hunt, lens "fx" (docs/WAVE_PLAN2.md §5.15: effects, drops, posture). Every test here failed on the
 * tree it was written against and pins one real problem (fixed in 7B-fix; the drop and PICK stubs follow the fix's seams):
 *
 *  1. posture: a sitter told to move (moveTo, or an attack that walks) glides along the path in STAND_UP (1.6 s)
 *     instead of running: EntityView.setIdle('stand', 'play') starts STAND_UP as an action and actor.play('RUN') is
 *     ignored while an action plays;
 *  2. posture: a seated player being killed stands up first (STAND_UP on a `dying` view), then falls when the blow shows;
 *  3. drops: loot is tossed (0.45 s arc) and has landed before the killing hit is shown (sword basic 566 ms, bow basic
 *     445 ms + the arrow's flight): the gold flies out of a mob that is still standing;
 *  4. drops: sparkle slots freed by picked-up drops are never handed to the drops that are still lying there;
 *  5. effects: a cast cancelled (castEnd) while its loop program is still loading keeps its READY/WAIT loop emitting on
 *     the caster until the planned phase end (the first cast of each skill in a session);
 *  6. pickup: any item vanishing within 3 m within 20 s of your accepted pickup plays PICK (someone else's loot), and
 *     your own item's PICK is then lost.
 * NullEngine; synthetic actors and programs (no fetch). The DOM stub is the one seams-fx.test.ts uses.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Animation, AnimationGroup, ArcRotateCamera, AssetContainer, Bone, Matrix, MeshBuilder, NullEngine, Scene, Skeleton, TransformNode, Vector3 } from '@babylonjs/core'
import { FX_FORMAT, FX_FPS, FX_VERSION, FxLibrary, type FxEffect } from '@sro/fx'
import type { EntityState, MasteryDef, SkillDef } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SkillCatalog } from '../src/content/skills.ts'
import { CharacterActor, type ModelLibrary } from '../src/three/models.ts'
import { DropAssets, DropVisual, MAX_DROP_SPARKLES, TOSS_MS } from '../src/world/drops.ts'
import { EntityView, type EntityContext } from '../src/world/entities.ts'
import { DROP_HOLD_MAX_MS, fxWorldFeature } from '../src/world/features/fx-world.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { fxBudget } from '../src/world/fx/quality.ts'
import type { FxRunner } from '../src/world/fx/system-fx.ts'
import { IdleDriver } from '../src/world/idle.ts'
import { readFxSkills, SkillFx, type FxSkill, type FxStage } from '../src/world/skill-fx.ts'
import { ActionPlayer, type ActionPort, type ClipFacts, type PhasePlan } from '../src/world/skills-view.ts'

const OUT = join(import.meta.dirname, '..', '..', '..', 'work', 'out')

// ---- scene and a DOM stub for EntityView's label (as seams-fx.test.ts) ----------------------------------------------

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

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  scene.useRightHandedSystem = true
  scene.activeCamera = new ArcRotateCamera('cam', 0.5, 1, 12, Vector3.Zero(), scene)
  if (!hadDocument) (globalThis as { document?: unknown }).document = { createElement: () => new StubElement() }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterAll(() => {
  if (!hadDocument) delete (globalThis as { document?: unknown }).document
  vi.restoreAllMocks()
  scene.dispose()
  engine.dispose()
})

// ---- a synthetic character (as seams-fx.test.ts), with the retail clip facts that matter here --------------------

const HAND = 'Bip01 R HandMid'
const CLIPS = ['STAND1', 'ATTREADY', 'RUN', 'WALK', 'SIT_DOWN', 'SIT', 'STAND_UP', 'ATTACK1', 'DIE1', 'DIE1_RM', 'DAMAGE1']

/** The real chinaman_adventurer facts when the export is there (sword basic ATTACK1, bow ATTACK1, STAND_UP). */
function retailClip(name: string, fallback: { durationMs: number; hits: number[] }): { durationMs: number; hits: number[] } {
  const f = join(OUT, 'char/china/chinaman_adventurer.json')
  if (!existsSync(f)) return fallback
  const anims = (JSON.parse(readFileSync(f, 'utf8')) as { animations: { name: string; durationMs: number; events: { type: number; timeMs: number }[] }[] }).animations
  const a = anims.find(x => x.name === name)
  return a ? { durationMs: a.durationMs, hits: a.events.filter(e => e.type === 1).map(e => e.timeMs) } : fallback
}
const SWORD_BASIC = retailClip('ATTACK1_sword_base_01', { durationMs: 1133, hits: [200, 566] })
const BOW_BASIC = retailClip('ATTACK1_skill_ch_bow_normal', { durationMs: 766, hits: [445] })
const STAND_UP_MS = retailClip('STAND_UP', { durationMs: 1600, hits: [] }).durationMs

function makeActor(): CharacterActor {
  const container = (() => {
    const root = new TransformNode('__root__', scene)
    const body = MeshBuilder.CreateBox('body', { size: 1 }, scene)
    body.parent = root
    const hand = new TransformNode(HAND, scene)
    hand.parent = root
    const skel = new Skeleton('skel', 'skel', scene)
    new Bone(HAND, skel, null, Matrix.Translation(0.3, 1.1, 0)).linkTransformNode(hand)
    body.skeleton = skel
    for (const c of CLIPS) {
      const g = new AnimationGroup(c, scene)
      const a = new Animation(`${c}:y`, 'position.y', 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE)
      a.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: 0.01 }])
      g.addTargetedAnimation(a, root)
    }
    const c = new AssetContainer(scene)
    c.moveAllFromScene()
    return c
  })()
  const sidecar = {
    animations: [
      { name: 'ATTACK1', durationMs: SWORD_BASIC.durationMs, events: SWORD_BASIC.hits.map(timeMs => ({ type: 1, timeMs })) },
      { name: 'STAND_UP', durationMs: STAND_UP_MS, events: [] },
      { name: 'DAMAGE1', durationMs: 500, partial: true, events: [] },
    ],
  }
  return new CharacterActor(scene, { code: 'CHAR_CH_MAN_ADVENTURER', glb: '/out/test.glb' }, { container, sidecar, packs: null })
}

function makeView(actor: CharacterActor, id = 7): EntityView {
  const state: EntityState = { id, kind: 'player', name: `Hero_${id}`, model: 'CHAR_CH_MAN_ADVENTURER', level: 5, weapon: 'sword', pos: [0, 0, 0], yaw: 0 }
  const ctx = {
    scene,
    library: null,
    catalog: null,
    labels: new StubElement(),
    drops: null,
    heightAt: () => 0,
    selfId: () => 1,
    selfLevel: () => 5,
    serverNow: () => 0,
    attachments: [],
  } as unknown as EntityContext
  const v = new EntityView(state, ctx)
  v.actor = actor
  actor.root.parent = v.root
  actor.play('STAND1', true)
  return v
}

const playing = (a: CharacterActor, name: string) => !!a.group(name)?.isPlaying

// ---- 1-2. posture ---------------------------------------------------------------------------------------------------

describe('posture (H7B fx lens)', () => {
  it('a sitter who is told to move runs; it does not glide along the path in STAND_UP', () => {
    const a = makeActor()
    const v = makeView(a)
    v.setIdle('sit')
    expect(playing(a, 'SIT')).toBe(true)
    // The server's order for a sitter's moveTo (gameplay.ts onMoveTo -> posture.moved -> standUp, then the path):
    // entityUpdate {posture: 'stand'} -> postureFeature -> IdleDriver.setReason('sit', false, 'play') -> setIdle('stand', 'play')
    v.setIdle('stand', 'play')
    v.setMove({ from: [0, 0, 0], to: [20, 0, 0], speed: 5.5, startedAt: 0 })
    v.update(100, 0.1)
    v.update(400, 0.3)
    expect(v.moving).toBe(true)
    expect(v.pos.x).toBeGreaterThan(2)
    // It moves at run speed while STAND_UP (STAND_UP_MS, ~1.6 s = ~9 m at 5.5 m/s) holds the pose: RUN never starts.
    expect({ standUp: playing(a, 'STAND_UP'), run: playing(a, 'RUN') }).toEqual({ standUp: false, run: true })
    v.dispose()
  })

  it('a seated player being killed dies from the seat; it does not stand up first (STAND_UP on a dying view)', () => {
    const a = makeActor()
    const v = makeView(a, 8)
    const idle = new IdleDriver(v)
    idle.loaded()
    idle.setReason('sit', true)
    expect(playing(a, 'SIT')).toBe(true)
    // combat {killed} arrives: world.ts onCombat marks the victim `dying` and shows the blow at its clip event later.
    v.dying = true
    // entityUpdate 'dead' (ignored while dying), then posture.playerDied's entityUpdate {posture: 'stand'}:
    // postureFeature -> idleOf(v).setReason('sit', false, 'play').
    idle.setReason('sit', false, 'play')
    expect(playing(a, 'STAND_UP')).toBe(false)
    expect(playing(a, 'SIT')).toBe(true)
    idle.dispose()
    v.dispose()
  })
})

// ---- 3. drops: the toss vs the kill ---------------------------------------------------------------------------------

const LINK = { positionDepth: 1, matrixDepth: 1, velocityDepth: 0, followDepth: 1, localMotion: false, shapeMotion: true, keepMatrix: false, keepOrigin: false }

function program(key: string): FxEffect {
  return {
    format: FX_FORMAT,
    version: FX_VERSION,
    key,
    fps: FX_FPS,
    scale: 1,
    textures: [],
    meshes: [],
    nodes: [
      { name: 'root', parent: -1, frames: 8, life: 'extinct', emit: { start: 0, duration: 1, period: 1, limit: 1, rate: 1 }, link: { ...LINK }, render: 'none', view: 'none', material: null, commands: [] },
      {
        name: 'plate', parent: 0, frames: 4, life: 'extinct', emit: { start: 0, duration: 4, period: 1, limit: 8, rate: 1 }, link: { ...LINK }, render: 'plate', view: 'billboard',
        material: { texture: -1, mesh: -1, blend: 'add', cull: 'none', colorOp: 'diffuse', alphaOp: 'diffuse', d3d: { srcBlend: 5, dstBlend: 2, cull: 1, colorOp: 2, alphaOp: 2 } }, commands: [],
      },
    ],
    duration: null,
    provenance: 'h7b',
    warnings: [],
  }
}

function fakeView(id: number, x: number, z: number): EntityView {
  const root = new TransformNode(`h7b:view${id}`, scene)
  root.position.set(x, 0, z)
  return { id, root, yaw: 0, height: 1.8, isDisposed: false, dead: false, kind: id >= 50 ? 'mob' : 'player', state: { model: 'MOB_CH_MANGNYANG' }, actor: { joint: () => undefined } } as unknown as EntityView
}

/**
 * When a fresh drop thrown from a mob at the origin has landed (ms after its spawn), with the fx-world feature
 * placing it as in the game. `killShownAt` = when world.ts shows the killing blow (killView: `dying` off, `dead` on);
 * null = the victim is not `dying` (a GM kill or DoT death: shown at once); Infinity = the blow is never shown.
 */
function landedAt(killShownAt: number | null): { land: number; heldUntil: number } {
  const factories: ((v: EntityView) => { loaded?(): void } | null)[] = []
  const victim = { id: 50, kind: 'mob', dying: killShownAt !== null, dead: false, isDisposed: false, pos: { x: 0.1, z: -0.2 } }
  const ctx = {
    scene,
    app: { catalog: { item: () => undefined } },
    camera: { target: Vector3.Zero() },
    addAttachment: (f: (typeof factories)[number]) => (factories.push(f), () => {}),
    selfId: () => 1,
    view: () => undefined,
    views: () => [victim][Symbol.iterator](),
    world: () => null,
    serverNow: () => 10_000,
    acceptedPickup: () => null,
  } as unknown as WorldFeatureContext
  const f = fxWorldFeature(ctx)
  const drop = new DropVisual(new DropAssets(scene), true, undefined)
  const item = { id: 4242, kind: 'item', isSelf: false, state: { id: 4242, pos: [1.2, 0, 0.4], droppedAt: 10_000, dropFrom: [0, 0, 0] }, drop } as unknown as EntityView
  for (const make of factories) make(item)?.loaded?.()
  expect(drop.tossing).toBe(true)
  let t = 0
  let heldUntil = 0
  while (drop.tossing && t < 5000) {
    t += 10
    if (killShownAt !== null && t >= killShownAt) {
      victim.dying = false
      victim.dead = true
    }
    f.onFrame?.(t, 0.01)
    if (drop.holding) heldUntil = t
    drop.update(0.01)
  }
  drop.dispose()
  f.dispose?.()
  return { land: t, heldUntil }
}

describe('drops (H7B fx lens)', () => {
  it('the loot toss does not land before the killing blow of a sword basic attack is shown', () => {
    // The server spawns the drops in the kill tick (gameplay.ts mobDied -> spawnGroundItem; the mock's mobDies too), so
    // the spawn arrives with the combat {killed}. world.ts shows that combat's hits at the attack clip's events.
    const a = makeActor()
    const attacker = makeView(a, 9)
    const delays = attacker.attack(undefined, 2, 1000, { clip: 'ATTACK1' })
    const killShownAt = delays[delays.length - 1]!
    const { land, heldUntil } = landedAt(killShownAt)
    // Held (hidden at the corpse) until the mob is hit and falls, then the 0.45 s toss.
    expect(heldUntil).toBeGreaterThanOrEqual(killShownAt - 10)
    expect(land).toBeGreaterThanOrEqual(killShownAt + TOSS_MS - 10)
    expect(land).toBeLessThanOrEqual(killShownAt + TOSS_MS + 20)
    attacker.dispose()
  })

  it('the loot toss does not land before a bow basic attack\'s arrow reaches the mob', () => {
    const lib = new FxLibrary(scene, '/out/')
    for (const k of ['hit/bow_spark.efp', 'fx/bow_tail.efp']) lib.addProgram(program(k))
    const fx = new SkillFx(scene, () => 0, { library: lib, lights: false })
    const bow: FxSkill = { group: 'SKILL_CH_BOW_BASE', aniGroup: 'BOW', defense: null, damage: 'hit/bow_spark.efp', arrowTail: 'fx/bow_tail.efp', arrowForce: null, stages: [] }
    fx.setSkills(readFxSkills({ skills: [bow] }))
    // A bow's reach is 18 m (items.json range); presentBasicArrow shoots at the clip's hit event and shows the hit
    // (number, hurt, the death) when the arrow lands: event + shootBasic's flight time.
    const flight = fx.shootBasic('SKILL_CH_BOW_BASE', fakeView(1, 0, 0), fakeView(50, 0, 18))!
    const killShownAt = BOW_BASIC.hits[0]! + flight
    expect(killShownAt).toBeGreaterThan(700)
    expect(landedAt(killShownAt).land).toBeGreaterThanOrEqual(killShownAt + TOSS_MS - 10)
    fx.dispose()
    lib.dispose()
  })

  it('a drop whose victim is not dying (GM kill, death shown at once) tosses at once; a lost blow waits DROP_HOLD_MAX_MS at most', () => {
    const now = landedAt(null)
    expect(now.heldUntil).toBe(0)
    expect(now.land).toBeLessThanOrEqual(TOSS_MS + 10)
    const lost = landedAt(Infinity)
    expect(lost.land).toBeGreaterThanOrEqual(DROP_HOLD_MAX_MS)
    expect(lost.land).toBeLessThanOrEqual(DROP_HOLD_MAX_MS + TOSS_MS + 20)
  })
})

// ---- 4. drops: sparkle slots ----------------------------------------------------------------------------------------

describe('drop sparkles (H7B fx lens)', () => {
  it('a sparkle slot freed by a picked-up drop goes to a drop still lying there without one', async () => {
    const playingLoops = new Set<object>()
    const runner = {
      play: () => {
        const h = { stop: () => void playingLoops.delete(h), done: false }
        playingLoops.add(h)
        return h
      },
    }
    const lib = {
      load: async () => ({ sidecar: { particles: [{ set: 'ambient', kind: 'ambient', efp: 'system/item_drop_money.efp', bone: null, position: [0, 0, 0] }] } }),
      character: async () => {
        const root = new TransformNode('h7b:dropActor', scene)
        return { root, play() {}, playClip() {}, setHighlight() {}, joint: () => undefined, dispose: () => root.dispose() }
      },
    }
    class Assets extends DropAssets {
      override get library(): ModelLibrary {
        return lib as unknown as ModelLibrary
      }
      override get runner(): FxRunner {
        return runner as unknown as FxRunner
      }
    }
    const assets = new Assets(scene)
    const cap = Math.min(MAX_DROP_SPARKLES, fxBudget().dropSparkles)
    const drops = Array.from({ length: cap + 5 }, () => new DropVisual(assets, true, undefined))
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(assets.sparkles).toBe(cap)
    expect(playingLoops.size).toBe(cap)
    // The first five (all sparkling) are picked up; five drops without a sparkle are still on the ground.
    for (const d of drops.splice(0, 5)) d.dispose()
    for (let f = 0; f < 60; f++) for (const d of drops) d.update(1 / 30)
    // Every drop left fits the budget now, but the five that loaded late never get a sparkle (until they re-enter view).
    expect(drops.length).toBe(cap)
    expect(assets.sparkles).toBe(cap)
    expect(playingLoops.size).toBe(cap)
    for (const d of drops) d.dispose()
  })
})

// ---- 5. effects: a cast cancelled while its programs load --------------------------------------------------------

const stage = (p: Partial<FxStage> & Pick<FxStage, 'phase' | 'actType'>): FxStage => ({
  startEvent: 0, move: 'MOV_NONE,0,0,0', effect: null, startBone: null, startOffset: '0,0,0', targetBone: null, targetOffset: '0,0,0',
  effect2: null, rotate: '0', script: null, dmg: false, kill: 0, sound: { begin: null, end: null }, ...p,
})
const GANGGI_FX: FxSkill = {
  group: 'SKILL_CH_COLD_GANGGI_A', aniGroup: 'DEFAULT', defense: null, damage: null, arrowTail: null, arrowForce: null,
  stages: [stage({ phase: 'READY', actType: 'AT_LOOP', effect: 'fx/ganggi_ready.efp' }), stage({ phase: 'SHOT', actType: 'AT_ONE_FOLLOW', kill: 1 })],
}
const GANGGI: SkillDef = {
  code: 'SKILL_CH_COLD_GANGGI_A_01', id: 93, name: 'Weak Guard of Ice', mastery: 'COLD', masteryLevel: 8, skillLevel: 1, sp: 6, mp: 72, category: 'buff',
  castMs: 1000, actionMs: 1000, cooldownMs: 2000, range: 0, weapons: [], icon: null, group: 'SKILL_CH_COLD_GANGGI_A',
  animation: { ready: 'READY04', wait: 'WAIT04', shot: 'SKILL_4' }, preparingMs: 1000, kind: 'buff', targets: { required: false, groups: [] }, aniGroup: 'DEFAULT', durationMs: 335294,
} as SkillDef
const COLD: MasteryDef = { code: 'COLD', id: 273, name: 'Cold', race: 'china', weapons: [], skills: [], tab: 'force', page: 0, lines: 8 }
const PHASE_CLIPS: Record<string, ClipFacts> = { READY04: { durationMs: 1000, hits: [] }, WAIT04: { durationMs: 2000, hits: [] }, SKILL_4: { durationMs: 1000, hits: [106] } }

class Port implements ActionPort {
  private n = 0
  clip(_g: string | undefined, type: string): ClipFacts | null {
    return PHASE_CLIPS[type] ?? null
  }
  play(_g: string | undefined, _p: readonly PhasePlan[]): number {
    return ++this.n
  }
  stop(): void {}
  playing(): boolean {
    return true
  }
  face(): void {}
}

/** A library whose programs arrive when `release()` is called (a real fetch takes tens to hundreds of ms). */
class SlowLibrary extends FxLibrary {
  private open!: () => void
  private readonly gate = new Promise<void>(res => (this.open = res))
  release(): void {
    this.open()
  }
  override load(key: string): Promise<FxEffect> {
    return this.gate.then(() => super.load(key))
  }
}

async function cancelledCast(lib: FxLibrary, release?: () => void): Promise<number> {
  let now = 0
  lib.addProgram(program('fx/ganggi_ready.efp'))
  const fx = new SkillFx(scene, () => now, { library: lib, lights: false })
  fx.setSkills(readFxSkills({ skills: [GANGGI_FX] }))
  const hero = fakeView(1, 0, 0)
  const player = new ActionPlayer(new SkillCatalog([GANGGI], [COLD], []), {
    onPhase(a, phase, start, clip) {
      const shot = a.phases.find(p => p.plan.phase === 'SHOT')
      fx.stages(a.group, phase.phase, { caster: hero, start, hits: clip?.hits ?? [], loopUntil: phase.phase === 'SHOT' ? start + phase.ms : shot ? shot.start : a.release })
    },
    onEnd() {
      fx.stopCasterLoops(1)
    },
  })
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  const step = async (until: number) => {
    while (now < until) {
      now += 10
      player.tick(now)
      fx.update(0.01)
      await flush()
    }
  }
  player.cast({ t: 'cast', id: 1, skill: GANGGI.code, instance: 1, prepareMs: 1000, castMs: 1000, actionMs: 1000 }, 0, new Port())
  await step(50)
  // The player moves: the server interrupts the cast (castEnd) 50 ms in.
  player.castEnd({ t: 'castEnd', id: 1, instance: 1, reason: 'interrupted' } as Parameters<ActionPlayer['castEnd']>[0], new Port())
  await step(150)
  release?.()
  await step(1500)
  const live = fx.stats.live
  fx.dispose()
  return live
}

describe('effect loops (H7B fx lens)', () => {
  it('a READY loop whose program is still loading when the cast is cancelled does not play on to the planned phase end', async () => {
    // Control: program already loaded -> the loop is halted at castEnd and gone by 1.5 s.
    const warm = new FxLibrary(scene, '/out/')
    await warm.load('fx/ganggi_ready.efp').catch(() => null)
    expect(await cancelledCast(warm)).toBe(0)
    // First cast of the session: the program arrives 100 ms after the castEnd -> the loop starts afterwards and keeps
    // emitting on the caster until its planned READY/WAIT end (2 s), 1.5 s after the player cancelled it.
    const cold = new SlowLibrary(scene, '/out/')
    expect(await cancelledCast(cold, () => cold.release())).toBe(0)
  })
})

// ---- 6. pickup PICK -------------------------------------------------------------------------------------------------

describe('pickup PICK (H7B fx lens)', () => {
  it("another item vanishing near you (someone else's loot) does not play your PICK", () => {
    const face = vi.fn()
    const playOverlay = vi.fn(() => true)
    const self = { id: 1, isSelf: true, kind: 'player', dead: false, moving: false, pos: { x: 0, z: 0 }, face, actor: { playOverlay } } as unknown as EntityView
    const ctx = {
      scene,
      app: { catalog: { item: () => undefined } },
      camera: { target: Vector3.Zero() },
      addAttachment: () => () => {},
      selfId: () => 1,
      view: (id: number) => (id === 1 ? self : undefined),
      world: () => null,
      serverNow: () => 0,
      // world.ts: the item of the pickup its actionResult accepted (the pickup request for item 70).
      acceptedPickup: () => 70,
    } as unknown as WorldFeatureContext
    const f = fxWorldFeature(ctx)
    // You clicked item 70 ten metres away: the pickup is accepted and you start walking to it.
    f.onEntityAdded?.({ id: 70, kind: 'item', state: { pos: [10, 0, 0] } } as unknown as EntityView)
    f.onMessage?.({ t: 'actionResult', re: 'pickup', ok: true } as Parameters<NonNullable<typeof f.onMessage>>[0])
    // A party member picks up item 71, two metres from you.
    f.onEntityAdded?.({ id: 71, kind: 'item', state: { pos: [2, 0, 0] } } as unknown as EntityView)
    f.onMessage?.({ t: 'despawn', id: 71 })
    expect(playOverlay).not.toHaveBeenCalled()
    // Your own item vanishes when you reach it: that one bends down.
    ;(self.pos as { x: number }).x = 9.5
    f.onMessage?.({ t: 'despawn', id: 70 })
    expect(playOverlay).toHaveBeenCalledWith('PICK')
    f.dispose?.()
  })
})

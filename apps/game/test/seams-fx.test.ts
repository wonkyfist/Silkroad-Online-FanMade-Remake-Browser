/**
 * Wave 7B client animation seams (docs/WAVE_PLAN2.md §5.1, docs/EFFECTS.md §6.1): KEEP_CLIPS, CharacterActor
 * (setWeaponVisible, weaponDummy, playOverlay, idleVariants, onClip, die(instant, clip)) and EntityView (attack({clip}),
 * setIdle). NullEngine; a synthetic actor built in memory (no glb, no fetch) and a tiny DOM stub for the view's label.
 */
import {
  Animation,
  AnimationGroup,
  AssetContainer,
  Bone,
  Matrix,
  MeshBuilder,
  NullEngine,
  Scene,
  Skeleton,
  TransformNode,
  type AbstractMesh,
} from '@babylonjs/core'
import type { BoundItem } from '@sro/appearance'
import type { EntityState } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CharacterActor, dummiesFromSidecar, KEEP_CLIPS } from '../src/three/models.ts'
import { EntityView, type EntityContext } from '../src/world/entities.ts'
import { EMOTE_CLIP, IDLE_PRIORITY, pickIdle, SYSTEM_FX_KEYS } from '../src/world/fx/types.ts'

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

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  // After the engine: Babylon looks for a real document when it has one.
  if (!hadDocument) (globalThis as { document?: unknown }).document = { createElement: () => new StubElement() }
})

afterAll(() => {
  if (!hadDocument) delete (globalThis as { document?: unknown }).document
  scene.dispose()
  engine.dispose()
})

// ---- synthetic models ------------------------------------------------------------------------------------------------

const HAND = 'Bip01 R HandMid'
const BASE_CLIPS = ['STAND1', 'ATTREADY', 'RUN', 'WALK', 'SIT_DOWN', 'SIT', 'STAND_UP', 'ATTACK1', 'ATTACK2', 'DIE1', 'DIE1_RM', 'DOWN_DIE', 'DAMAGE1', 'DEFENCE', 'STAND2', 'STAND3', 'STAND3_spear_stand_city02', 'STAND1_cart_stand01', 'EMOTION01']

/** Moves everything built by `build` into a new container (the scene is empty of models between builds). */
function contain(build: () => void): AssetContainer {
  build()
  const c = new AssetContainer(scene)
  c.moveAllFromScene()
  return c
}

function clipGroup(name: string, target: TransformNode): AnimationGroup {
  const g = new AnimationGroup(name, scene)
  const a = new Animation(`${name}:y`, 'position.y', 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE)
  a.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: 0.01 }])
  g.addTargetedAnimation(a, target)
  return g
}

/** A character glb: a root, a body mesh, a hand bone (socket) and the given clips. */
function bodyContainer(clips: readonly string[]): AssetContainer {
  return contain(() => {
    const root = new TransformNode('__root__', scene)
    const body = MeshBuilder.CreateBox('body', { size: 1 }, scene)
    body.parent = root
    const hand = new TransformNode(HAND, scene)
    hand.parent = root
    hand.position.set(0.3, 1.1, 0)
    const skel = new Skeleton('skel', 'skel', scene)
    const bone = new Bone(HAND, skel, null, Matrix.Translation(0.3, 1.1, 0))
    bone.linkTransformNode(hand)
    body.skeleton = skel
    for (const c of clips) clipGroup(c, root)
  })
}

/** A socket item glb (weapon, shield): a root and one mesh. */
function itemContainer(name: string): AssetContainer {
  return contain(() => {
    const root = new TransformNode(`${name}:root`, scene)
    const m = MeshBuilder.CreateBox(`${name}:mesh`, { width: 0.05, height: 0.9, depth: 0.1 }, scene)
    m.parent = root
  })
}

const CLIP_SIDECAR = {
  animations: [
    { name: 'ATTACK1', durationMs: 900, events: [{ type: 1, timeMs: 400 }] },
    { name: 'ATTACK2', durationMs: 1400, events: [{ type: 1, timeMs: 300 }, { type: 1, timeMs: 700 }] },
    { name: 'DAMAGE1', durationMs: 500, partial: true, events: [] },
    { name: 'DEFENCE', durationMs: 500, partial: true, events: [] },
    { name: 'STAND3', durationMs: 2333, partial: true, events: [] },
  ],
}

function makeActor(clips: readonly string[] = BASE_CLIPS): CharacterActor {
  return new CharacterActor(scene, { code: 'CHAR_CH_MAN_ADVENTURER', glb: '/out/test.glb' }, { container: bodyContainer(clips), sidecar: CLIP_SIDECAR, packs: null })
}

function socketItem(code: string, slot: BoundItem['slot']): BoundItem {
  return { code, slot, kind: 'socket', glb: `/out/equipment/${code}.glb`, attachBone: HAND, joints: [], meshes: [] }
}

/** A dressed actor: a weapon (with trail dummies), a shield, a skinned armour and nothing else. */
function dressedActor(): { actor: CharacterActor; weapon: AbstractMesh[]; shield: AbstractMesh[]; armour: AbstractMesh[] } {
  const actor = makeActor()
  const before = new Set(scene.meshes)
  actor.applyDress({
    comp: null,
    items: [
      { item: socketItem('ITEM_CH_SWORD_01_A', 'weapon'), container: itemContainer('sword'), sidecar: { dummies: { ai_start: [0, 0.1, 0], ai_end: [0, 0.9, 0], Bone01: [0, 0, 0], bad: [1, 2] } } },
      { item: socketItem('ITEM_CH_SHIELD_01_A', 'shield'), container: itemContainer('shield'), sidecar: null },
      { item: { ...socketItem('ITEM_CH_M_HEAVY_01_BA_A', 'chest'), kind: 'skinned', attachBone: null }, container: itemContainer('armour') },
    ],
    fallback: null,
    family: 'sword',
    gender: 'male',
    volume: undefined,
  })
  const added = scene.meshes.filter(m => !before.has(m))
  const by = (s: string) => added.filter(m => m.name.includes(`${s}:mesh`))
  return { actor, weapon: by('sword'), shield: by('shield'), armour: by('armour') }
}

const playing = (a: CharacterActor, name: string) => !!a.group(name)?.isPlaying
const finish = (a: CharacterActor, name: string) => a.group(name)!.stop()

// ---- tests -----------------------------------------------------------------------------------------------------------

describe('KEEP_CLIPS (wave 7B additions)', () => {
  it('keeps the idle variants, PICK, DEFENCE, DAMAGE2, REVIVAL, VENDOR01, TURN and the mob HELP/FIND clips', () => {
    for (const name of [
      'PICK', 'DEFENCE', 'DAMAGE2', 'STAND3', 'STAND4', 'STAND3_spear_stand_city02', 'TURN_L', 'TURN_R', 'REVIVAL', 'VENDOR01',
      'HELP', 'FIND', 'HELP_x', 'SIT', 'SIT_DOWN', 'STAND_UP', 'ATTREADY_bow_stand', 'DIE1_RM', 'DOWN_DIE', 'EMOTION07',
    ]) {
      expect(KEEP_CLIPS.test(name), name).toBe(true)
    }
    for (const name of ['STAND5', 'TURN_X', 'VENDOR02', 'OBSOLETE_STAND2', 'EMOTION09', 'DAMAGE3', 'SKILL_8']) {
      expect(KEEP_CLIPS.test(name), name).toBe(false)
    }
  })
})

describe('CharacterActor seams', () => {
  it('setWeaponVisible toggles every worn weapon and shield mesh, not the armour, and survives a re-dress', () => {
    const { actor, weapon, shield, armour } = dressedActor()
    expect(weapon.length).toBeGreaterThan(0)
    expect(shield.length).toBeGreaterThan(0)
    expect(armour.length).toBeGreaterThan(0)
    expect(actor.weaponVisible).toBe(true)
    actor.setWeaponVisible(false)
    expect(actor.weaponVisible).toBe(false)
    for (const m of [...weapon, ...shield]) expect(m.isVisible, m.name).toBe(false)
    for (const m of armour) expect(m.isVisible, m.name).toBe(true)
    actor.setWeaponVisible(true)
    for (const m of [...weapon, ...shield, ...armour]) expect(m.isVisible, m.name).toBe(true)
    // Hidden, then dressed again (a new weapon): the new meshes come hidden too.
    actor.setWeaponVisible(false)
    const before = new Set(scene.meshes)
    actor.applyDress({ comp: null, items: [], fallback: { container: itemContainer('fb'), attachBone: HAND }, family: 'sword', gender: 'male', volume: undefined })
    const fb = scene.meshes.filter(m => !before.has(m) && m.name.includes('fb:mesh'))
    expect(fb.length).toBeGreaterThan(0)
    for (const m of fb) expect(m.isVisible).toBe(false)
    actor.dispose()
  })

  it('weaponDummy returns the sidecar trail points, following the weapon; null when the weapon has none', () => {
    const { actor } = dressedActor()
    const start = actor.weaponDummy('ai_start')
    const end = actor.weaponDummy('ai_end')
    expect(start).not.toBeNull()
    expect(end).not.toBeNull()
    expect(end!.position.y).toBeCloseTo(0.9)
    expect(actor.weaponDummy('bad')).toBeNull()
    expect(actor.weaponDummy('nope')).toBeNull()
    // It hangs under the weapon root, which hangs under the hand bone's node.
    let p = start!.parent
    let underHand = false
    while (p) {
      if (p.name === HAND) underHand = true
      p = p.parent
    }
    expect(underHand).toBe(true)
    actor.dispose()
    expect(start!.isDisposed()).toBe(true)
    expect(dummiesFromSidecar({ dummies: { a: [1, 2, 3], b: 'x', c: [1, Number.NaN, 2] } })).toEqual(new Map([['a', [1, 2, 3]]]))
    expect(dummiesFromSidecar(null).size).toBe(0)
  })

  it('playOverlay plays partial clips on top and full ones only while idle', () => {
    const a = makeActor()
    a.play('STAND1', true)
    expect(a.playOverlay('DEFENCE')).toBe(true)
    expect(playing(a, 'DEFENCE')).toBe(true)
    expect(playing(a, 'STAND1')).toBe(true)
    // STAND2 is a full one-shot: plays as an action while idle, and the base resumes after it.
    expect(a.playOverlay('STAND2')).toBe(true)
    expect(playing(a, 'STAND2')).toBe(true)
    // Not idle any more (an action plays): a second full variant is refused.
    expect(a.playOverlay('STAND2')).toBe(false)
    finish(a, 'STAND2')
    expect(playing(a, 'STAND1')).toBe(true)
    expect(a.playOverlay('NOPE')).toBe(false)
    a.dispose()
  })

  it('idleVariants lists the variants, the weapon family one replacing the plain clip, never mount clips', () => {
    const a = makeActor()
    expect(a.idleVariants().sort()).toEqual(['STAND2', 'STAND3'])
    a.family = 'spear'
    expect(a.idleVariants().sort()).toEqual(['STAND2', 'STAND3_spear_stand_city02'])
    a.dispose()
  })

  it('onClip reports every clip that starts', () => {
    const a = makeActor()
    const seen: string[] = []
    a.onClip = n => seen.push(n)
    a.play('STAND1', true)
    a.playClip('EMOTION01')
    a.playOverlay('DEFENCE')
    expect(seen).toEqual(['STAND1', 'EMOTION01', 'DEFENCE'])
    a.onClip = () => {
      throw new Error('lab broke')
    }
    expect(() => a.playClip('EMOTION01')).not.toThrow()
    a.dispose()
  })

  it('die plays DIE1 (or DOWN_DIE), then the DIE1_RM rest loop; revive ends it', () => {
    const a = makeActor()
    a.play('STAND1', true)
    a.die()
    expect(a.isDead).toBe(true)
    expect(playing(a, 'DIE1')).toBe(true)
    expect(a.clipCursors().top?.name).toBe('DIE1')
    finish(a, 'DIE1')
    expect(playing(a, 'DIE1_RM')).toBe(true)
    expect(a.clipCursors().top).toMatchObject({ name: 'DIE1_RM', silent: true })
    a.revive()
    expect(playing(a, 'DIE1_RM')).toBe(false)
    expect(playing(a, 'STAND1')).toBe(true)

    a.die(false, 'DOWN_DIE')
    expect(playing(a, 'DOWN_DIE')).toBe(true)
    expect(playing(a, 'DIE1')).toBe(false)
    finish(a, 'DOWN_DIE')
    expect(playing(a, 'DIE1_RM')).toBe(true)
    a.dispose()

    // No DOWN_DIE and no rest clip: DIE1, held.
    const b = makeActor(['STAND1', 'DIE1'])
    b.die(true, 'DOWN_DIE')
    expect(playing(b, 'DIE1')).toBe(true)
    finish(b, 'DIE1')
    expect(b.groups.some(g => g.isPlaying)).toBe(false)
    b.dispose()
  })

  it('the idle base clips fall back: VENDOR01 -> SIT -> STAND1, ATTREADY -> STAND1', () => {
    const a = makeActor()
    expect(a.clipFor('VENDOR01')?.name).toBe('SIT')
    expect(a.clipFor('ATTREADY')?.name).toBe('ATTREADY')
    a.dispose()
    const b = makeActor(['STAND1', 'RUN'])
    expect(b.clipFor('VENDOR01')?.name).toBe('STAND1')
    expect(b.clipFor('SIT')?.name).toBe('STAND1')
    expect(b.clipFor('ATTREADY')?.name).toBe('STAND1')
    expect(b.clipFor('WALK')?.name).toBe('RUN')
    b.dispose()
  })
})

// ---- EntityView ------------------------------------------------------------------------------------------------------

function makeView(actor: CharacterActor): EntityView {
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
    serverNow: () => 0,
    attachments: [],
  } as unknown as EntityContext
  const v = new EntityView(state, ctx)
  v.actor = actor
  actor.root.parent = v.root
  actor.play('STAND1', true)
  return v
}

describe('EntityView seams', () => {
  it('attack({clip}) plays that clip and times the hits from its events; unknown clips use the cycle', () => {
    const a = makeActor()
    const v = makeView(a)
    expect(v.attack(undefined, 2, 1000, { clip: 'ATTACK2' })).toEqual([300, 700])
    expect(playing(a, 'ATTACK2')).toBe(true)
    finish(a, 'ATTACK2')
    expect(v.attack(undefined, 1, 5000, { clip: 'NO_SUCH_CLIP' })).toEqual([400])
    expect(playing(a, 'ATTACK1')).toBe(true)
    v.dispose()
  })

  it("setIdle switches the idle clip; 'play' runs SIT_DOWN / STAND_UP", () => {
    const a = makeActor()
    const v = makeView(a)
    expect(v.idle).toBe('stand')
    v.setIdle('combat')
    expect(v.idle).toBe('combat')
    expect(playing(a, 'ATTREADY')).toBe(true)
    v.update(0, 0.016)
    expect(playing(a, 'ATTREADY')).toBe(true)
    expect(playing(a, 'STAND1')).toBe(false)

    v.setIdle('sit', 'play')
    expect(playing(a, 'SIT_DOWN')).toBe(true)
    v.update(0, 0.016)
    expect(playing(a, 'SIT_DOWN')).toBe(true)
    finish(a, 'SIT_DOWN')
    expect(playing(a, 'SIT')).toBe(true)
    v.update(0, 0.016)
    expect(playing(a, 'SIT')).toBe(true)

    v.setIdle('stand', 'play')
    expect(playing(a, 'STAND_UP')).toBe(true)
    finish(a, 'STAND_UP')
    expect(playing(a, 'STAND1')).toBe(true)

    // Without 'play': at once.
    v.setIdle('sit')
    expect(playing(a, 'SIT')).toBe(true)
    expect(playing(a, 'SIT_DOWN')).toBe(false)
    v.dispose()
  })

  it("setIdle('vendor') plays VENDOR01, and falls back to SIT when the actor lacks it", () => {
    const withVendor = makeActor([...BASE_CLIPS, 'VENDOR01'])
    const v1 = makeView(withVendor)
    v1.setIdle('vendor')
    expect(playing(withVendor, 'VENDOR01')).toBe(true)
    v1.dispose()

    const a = makeActor()
    const v = makeView(a)
    v.setIdle('vendor', 'play')
    expect(playing(a, 'SIT_DOWN')).toBe(true)
    finish(a, 'SIT_DOWN')
    expect(playing(a, 'SIT')).toBe(true)
    v.update(0, 0.016)
    expect(playing(a, 'SIT')).toBe(true)
    // vendor -> sit: both seated, no transition.
    v.setIdle('sit', 'play')
    expect(playing(a, 'STAND_UP')).toBe(false)
    expect(playing(a, 'SIT_DOWN')).toBe(false)
    v.dispose()
  })

  it('pickIdle follows the D7 priority; the fx types list the system keys and emote clips', () => {
    expect([...IDLE_PRIORITY]).toEqual(['vendor', 'sit', 'combat', 'stand'])
    expect(pickIdle([])).toBe('stand')
    expect(pickIdle(['combat', 'sit'])).toBe('sit')
    expect(pickIdle(['combat', 'vendor', 'sit'])).toBe('vendor')
    for (const k of ['SYSTEM_CH_HWANMODE', 'SYSTEM_PET_APPEAR', 'SYSTEM_COS_HPPOTION'] as const) expect(SYSTEM_FX_KEYS).toContain(k)
    expect(EMOTE_CLIP).toEqual({ hi: 'EMOTION01', greeting: 'EMOTION02', rush: 'EMOTION03', joy: 'EMOTION04', no: 'EMOTION05', yes: 'EMOTION06', laugh: 'EMOTION07' })
  })
})

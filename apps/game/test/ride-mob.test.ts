/**
 * Wave 11 lane U-RC (docs/UNIQUES.md §2.3–§2.4, docs/WAVE_PLAN7.md §6.1): the ridden-mob composite on the real glbs
 * (work/out/mob/china/tigerwoman.glb on bluetiger.glb's `saddle`), in a NullEngine, through ModelLibrary.character
 * (its `load` reads the files) and EntityView.load (the ride load hook):
 * - the seat: after play('RUN') the rider's pelvis stays within 0.15 m of the saddle and her root's world rotation is
 *   the saddle's within 1e-4; the ride plays RUN; the seat is right on the frame a LOD catch-up moves both poses;
 * - the clips: STUN plays STAND1 on the tiger; ATTACK2 leaves the tiger holding its last frame from 3,333 to 4,000 ms
 *   and both resume the base together; DIE1 throws her to the ground beside the tiger;
 * - `setYaw(1)` turns only the ride's root; the label height is 2.8–3.4 m; the culling sphere covers both;
 * - the animation LOD: 300 far frames skip the same frames on both;
 * - load and dispose: the rider is hidden while the ride loads; no joint or a disposed rider leaves the rider alone;
 *   dispose takes both;
 * - Low (Classic: no animation LOD, the Low guard's settings) builds the same composite.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ArcRotateCamera, LoadAssetContainerAsync, NullEngine, Quaternion, Scene, TransformNode, Vector3, type AnimationGroup } from '@babylonjs/core'
import { GLTFLoaderAnimationStartMode } from '@babylonjs/loaders/glTF/glTFFileLoader.js'
import '@babylonjs/loaders/glTF/2.0/index.js'
import type { EntityState } from '@sro/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { settings } from '../src/settings.ts'
import { CharacterActor, KEEP_CLIPS, ModelLibrary } from '../src/three/models.ts'
import { EntityView, type EntityContext } from '../src/world/entities.ts'
import { characterMeshes } from '../src/world/graphics.ts'
import { FALLBACK_HEIGHT_M, RIDER_REACH_M, loadRide, type RideMob, type RideRef } from '../src/world/ride-mob.ts'

const OUT = join(import.meta.dirname, '../../../work/out')
const RIDER = { code: 'MOB_CH_TIGERWOMAN', glb: '/out/mob/china/tigerwoman.glb', sidecar: '/out/mob/china/tigerwoman.json' }
const RIDE: RideRef = { model: { code: 'MOB_CH_TIGERWOMAN#ride', glb: '/out/mob/china/bluetiger.glb', sidecar: '/out/mob/china/bluetiger.json' }, joint: 'saddle' }
const ready = [RIDER.glb, RIDER.sidecar, RIDE.model.glb, RIDE.model.sidecar!].every(f => existsSync(join(OUT, f.slice('/out/'.length))))

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

// ---- the scene, a library that reads work/out, a fake clock -----------------------------------------------------------

type Loaded = Awaited<ReturnType<ModelLibrary['load']>>

let engine: NullEngine
let scene: Scene
let camera: ArcRotateCamera
let library: ModelLibrary
let clock = 0
const hadDocument = 'document' in globalThis
const cleanups: Array<() => void> = []
const FRAME_MS = 16

/** ModelLibrary.load on the files (the original glbs; the same KEEP_CLIPS filter as loadFrom). */
function fileLoader(lib: ModelLibrary, delay?: (glb: string) => Promise<void>): void {
  const cache = new Map<string, Promise<Loaded>>()
  lib.load = (glb: string, sidecar?: string) => {
    let p = cache.get(glb)
    if (!p) {
      p = (async () => {
        const b = readFileSync(join(OUT, glb.slice('/out/'.length)))
        const container = await LoadAssetContainerAsync(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), scene, {
          pluginExtension: '.glb',
          pluginOptions: { gltf: { animationStartMode: GLTFLoaderAnimationStartMode.NONE } },
        })
        for (const g of [...container.animationGroups]) {
          if (!KEEP_CLIPS.test(g.name)) {
            container.animationGroups.splice(container.animationGroups.indexOf(g), 1)
            g.dispose()
          }
        }
        const side = sidecar ? (JSON.parse(readFileSync(join(OUT, sidecar.slice('/out/'.length)), 'utf8')) as Record<string, unknown>) : null
        return { container, sidecar: side, packs: null }
      })()
      cache.set(glb, p)
    }
    return delay ? delay(glb).then(() => p) : p
  }
}

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  scene.useRightHandedSystem = true // the game's scene (three/backdrop.ts)
  scene.useConstantAnimationDeltaTime = true // 16 ms of animation time per frame
  camera = new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2.5, 14, new Vector3(0, 2, 0), scene)
  camera.minZ = 0.2
  camera.maxZ = 4000
  library = new ModelLibrary(scene)
  library.now = () => clock
  library.animLod = false
  fileLoader(library)
  if (!hadDocument) (globalThis as { document?: unknown }).document = { createElement: () => new StubElement() }
})

afterEach(() => {
  library.animLod = false
  camera.target.set(0, 2, 0)
  camera.alpha = -Math.PI / 2
  camera.beta = Math.PI / 2.5
  camera.radius = 14
  for (const c of cleanups.splice(0).reverse()) c()
})

afterAll(() => {
  if (!hadDocument) delete (globalThis as { document?: unknown }).document
  library?.dispose()
  scene?.dispose()
  engine?.dispose()
})

const frame = (n = 1) => {
  for (let i = 0; i < n; i++) {
    clock += FRAME_MS
    scene.render()
  }
}
const framesFor = (ms: number) => Math.round(ms / FRAME_MS)

/** The rider and her ride, wired by loadRide (the ride's root at the origin, as EntityView parents it). */
async function composite(lib = library): Promise<{ rider: CharacterActor; ride: RideMob; tiger: CharacterActor }> {
  const rider = await lib.character(RIDER)
  const ride = await loadRide({ library: lib }, rider, RIDE)
  if (!ride) throw new Error('no ride')
  cleanups.push(() => {
    rider.dispose()
    ride.dispose()
  })
  rider.play('STAND1')
  return { rider, ride, tiger: ride.actor }
}

const joint = (a: CharacterActor, name: string) => {
  const j = a.joint(name)
  if (!j) throw new Error(`no joint ${name}`)
  return j
}

function worldPos(n: TransformNode): Vector3 {
  n.computeWorldMatrix(true)
  return n.getAbsolutePosition().clone()
}

function worldRot(n: TransformNode): Quaternion {
  n.computeWorldMatrix(true)
  const q = new Quaternion()
  n.getWorldMatrix().decompose(undefined, q, undefined)
  return q
}

/** Largest component difference of two rotations (sign aligned: q and −q are one rotation). */
function rotDiff(a: Quaternion, b: Quaternion): number {
  const s = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1
  return Math.max(Math.abs(a.x - s * b.x), Math.abs(a.y - s * b.y), Math.abs(a.z - s * b.z), Math.abs(a.w - s * b.w))
}

const playing = (a: CharacterActor, name: string) => !!a.group(name)?.isPlaying
const pelvisGap = (rider: CharacterActor, tiger: CharacterActor) => Vector3.Distance(worldPos(joint(rider, 'Bip03 Pelvis')), worldPos(joint(tiger, 'saddle')))

/** The pose a group's track for `node`'s rotation gives at frame `f` (the clip's own data). */
function trackRotation(g: AnimationGroup, node: TransformNode, f: number): Quaternion {
  const ta = g.targetedAnimations.find(t => t.target === node && t.animation.targetProperty === 'rotationQuaternion')
  if (!ta) throw new Error(`no rotation track for ${node.name} in ${g.name}`)
  return (ta.animation.evaluate(f) as Quaternion).clone()
}

// ---- EntityView with the real ride ------------------------------------------------------------------------------------

const MOB_STATE: EntityState = { id: 77, kind: 'mob', name: 'Tiger Girl', model: 'MOB_CH_TIGERWOMAN', level: 20, pos: [0, 0, 0], yaw: 0 }

function entityCtx(lib: ModelLibrary, ride: RideRef | null = RIDE): EntityContext {
  return {
    scene,
    library: lib,
    catalog: {
      mob: () => ({ code: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', level: 20, model: RIDER, scale: 1, radius: 2.8, ...(ride ? { ride } : {}) }),
      content: { mobs: new Map() },
      item: () => undefined,
    },
    labels: new StubElement(),
    drops: null,
    heightAt: () => 0,
    selfId: () => 1,
    selfLevel: () => 20,
    serverNow: () => clock,
    attachments: [],
  } as unknown as EntityContext
}

describe.skipIf(!ready)('the ridden mob on the real glbs (Tiger Girl on her Blue Tiger)', () => {
  it('seats her on the saddle with its full transform: RUN keeps her pelvis within 0.15 m, her root turned as the saddle', async () => {
    const { rider, tiger, ride } = await composite()
    expect(rider.companion).toBe(tiger)
    expect(rider.lodLeader).toBe(tiger)
    expect(rider.root.parent).toBe((ride as unknown as { seat: TransformNode }).seat)
    expect(rider.root.parent?.parent).toBe(tiger.root)
    frame()
    rider.play('RUN')
    frame()
    expect(playing(rider, 'RUN') && playing(tiger, 'RUN')).toBe(true)
    const saddle = joint(tiger, 'saddle')
    let worstGap = 0
    let worstRot = 0
    // One RUN cycle (900 ms) and a bit, every frame: the tiger's back pitches −23° to +11° and rises 2.45–3.18 m.
    for (let i = 0; i < framesFor(1100); i++) {
      frame()
      worstGap = Math.max(worstGap, pelvisGap(rider, tiger))
      worstRot = Math.max(worstRot, rotDiff(worldRot(rider.root), worldRot(saddle)))
    }
    expect(worstGap).toBeLessThan(0.15)
    expect(worstRot).toBeLessThan(1e-4)
    // Position only would leave her upright: the saddle really turns during RUN.
    const tilt = rotDiff(worldRot(saddle), Quaternion.Identity())
    expect(tilt).toBeGreaterThan(0.01)
  })

  it('STUN plays STAND1 on the tiger (its STUN is retail\'s missing file)', async () => {
    const { rider, tiger } = await composite()
    frame(2)
    const stun = rider.group('STUN')
    expect(stun).toBeDefined()
    const token = rider.playSkill([{ clip: stun!, ms: 600, loop: true }])
    frame()
    expect(playing(rider, 'STUN')).toBe(true)
    expect(playing(tiger, 'STAND1')).toBe(true)
    expect(tiger.groups.filter(g => g.isPlaying).map(g => g.name)).toEqual(['STAND1'])
    rider.stopSkill(token)
    frame()
    expect(playing(rider, 'STAND1') && playing(tiger, 'STAND1')).toBe(true)
  })

  it('ATTACK2: the tiger holds its last frame from 3,333 to 4,000 ms, then both resume the base together', async () => {
    const { rider, tiger } = await composite()
    frame(2)
    expect(rider.playClip('ATTACK2')).toBe(true)
    frame()
    expect(playing(rider, 'ATTACK2') && playing(tiger, 'ATTACK2')).toBe(true)
    const g = tiger.group('ATTACK2')!
    const spine = joint(tiger, 'Bip02 Spine')
    frame(framesFor(3450))
    // Her 4,000 ms clip plays on; the tiger's 3,333 ms one has ended and it does not go back to STAND1.
    expect(playing(rider, 'ATTACK2')).toBe(true)
    expect(playing(tiger, 'ATTACK2')).toBe(false)
    expect(playing(tiger, 'STAND1')).toBe(false)
    const held = spine.rotationQuaternion!.clone()
    expect(rotDiff(held, trackRotation(g, spine, g.to))).toBeLessThan(1e-4)
    frame(framesFor(400))
    expect(playing(rider, 'ATTACK2')).toBe(true)
    expect(rotDiff(spine.rotationQuaternion!, held)).toBeLessThan(1e-6)
    // Her end restarts both bases on the same frame.
    let resumed = -1
    for (let i = 0; i < framesFor(600) && resumed < 0; i++) {
      frame()
      const r = playing(rider, 'STAND1')
      expect(playing(tiger, 'STAND1')).toBe(r)
      if (r) resumed = i
    }
    expect(resumed).toBeGreaterThanOrEqual(0)
    expect(playing(rider, 'ATTACK2') || playing(tiger, 'ATTACK2')).toBe(false)
  })

  it('DIE1 throws her to the ground beside the tiger (both play the death, then DIE1_RM)', async () => {
    const { rider, tiger } = await composite()
    frame(2)
    rider.die()
    expect(rider.isDead && tiger.isDead).toBe(true)
    frame()
    expect(playing(rider, 'DIE1') && playing(tiger, 'DIE1')).toBe(true)
    frame(framesFor(5800))
    const pelvis = worldPos(joint(rider, 'Bip03 Pelvis'))
    // On the ground (the seat at the start was 2.6 m up), and off the tiger's back.
    expect(pelvis.y).toBeLessThan(0.8)
    const saddle = worldPos(joint(tiger, 'saddle'))
    expect(Math.hypot(pelvis.x - saddle.x, pelvis.z - saddle.z) + Math.abs(pelvis.y - saddle.y)).toBeGreaterThan(0.5)
  })

  it('EntityView: the ride takes the root, setYaw(1) turns only the ride, the label stands on the composite (2.8–3.4 m)', async () => {
    const v = new EntityView({ ...MOB_STATE, yaw: 0 }, entityCtx(library))
    cleanups.push(() => v.dispose())
    await v.load()
    const rider = v.actor!
    const tiger = v.ride!.actor
    expect(tiger.root.parent).toBe(v.root)
    expect(rider.root.parent?.parent).toBe(tiger.root)
    expect(rider.root.isEnabled(false) && tiger.root.isEnabled(false)).toBe(true)
    expect(v.height).toBeGreaterThanOrEqual(2.8)
    expect(v.height).toBeLessThanOrEqual(3.4)
    expect(v.height).not.toBe(FALLBACK_HEIGHT_M)
    // The pick cylinder stands on it too (sizePick: the mob radius 2.8 m, the composite height).
    expect(v.pick.scaling.y).toBeCloseTo(v.height, 6)
    expect(v.pick.scaling.x).toBeCloseTo(5.6, 6)
    frame(2)
    const before = rider.root.rotationQuaternion!.clone()
    v.yaw = (v as unknown as { targetYaw: number }).targetYaw = 1
    v.update(clock, FRAME_MS / 1000)
    frame()
    const yawOf = (q: Quaternion) => q.toEulerAngles().y
    expect(yawOf(tiger.root.rotationQuaternion!)).toBeCloseTo(1, 5)
    // Her root keeps its rotation relative to the seat; in the world she turns with the saddle.
    expect(rotDiff(rider.root.rotationQuaternion!, before)).toBeLessThan(1e-9)
    expect(rotDiff(worldRot(rider.root), worldRot(joint(tiger, 'saddle')))).toBeLessThan(1e-4)
    // One root carries both for the shadows and the like.
    const meshes = characterMeshes(v)
    expect(tiger.meshes.every(m => meshes.some(x => x === m || m.isDescendantOf(x)))).toBe(true)
    expect(rider.meshes.every(m => meshes.some(x => x === m || m.isDescendantOf(x)))).toBe(true)
    // The ride's culling sphere covers both: its bind top plus the rider's reach.
    const sphere = tiger.cullSphereLocal
    expect(sphere.y + sphere.r).toBeGreaterThan(tiger.footprint.maxY + RIDER_REACH_M)
    v.dispose()
    expect(rider.isDisposed && tiger.isDisposed).toBe(true)
  })

  it('animation LOD: with the camera far away, rider and ride skip exactly the same frames over 300 frames, seated', async () => {
    library.animLod = true
    const { rider, tiger } = await composite()
    tiger.root.position.set(0, 0, 400)
    frame()
    rider.play('RUN')
    frame(5)
    let skipped = 0
    let worst = 0
    for (let i = 0; i < 300; i++) {
      frame()
      expect(rider.lodSkipping, `frame ${i}`).toBe(tiger.lodSkipping)
      expect(rider.isOffscreen).toBe(tiger.isOffscreen)
      if (tiger.lodSkipping) skipped++
      worst = Math.max(worst, pelvisGap(rider, tiger))
    }
    expect(skipped).toBeGreaterThan(100)
    expect(worst).toBeLessThan(0.15)
  })

  it('a LOD catch-up (back in view on a skipped frame) re-seats her on the frame the poses jump', async () => {
    library.animLod = true
    const { rider, tiger } = await composite()
    rider.play('RUN')
    // Behind the camera: off screen, updated at 20 Hz (≤ 50 m).
    camera.target.set(0, 2, 30)
    camera.alpha = -Math.PI / 2
    camera.radius = 10
    frame(10)
    expect(tiger.isOffscreen).toBe(true)
    let turned = -1
    const saddle = joint(tiger, 'saddle')
    const seat = rider.root.parent as TransformNode
    // After the ride's own seat on this frame: turn the camera to the composite on a frame the LOD skips.
    const obs = scene.onBeforeRenderObservable.add(() => {
      if (turned < 0 && tiger.isOffscreen && tiger.lodSkipping) {
        camera.target.set(0, 2, 0)
        camera.alpha = Math.PI / 2
        camera.radius = 14
        turned = clock
      }
    })
    cleanups.push(() => scene.onBeforeRenderObservable.remove(obs))
    for (let i = 0; i < 20 && turned < 0; i++) frame()
    expect(turned).toBeGreaterThan(0)
    expect(tiger.isOffscreen).toBe(false)
    expect(tiger.lodSkipping).toBe(false)
    expect(Vector3.Distance(worldPos(seat), worldPos(saddle))).toBeLessThan(1e-4)
    expect(pelvisGap(rider, tiger)).toBeLessThan(0.15)
  })

  it('the rider is hidden while the ride loads and shows with it; dispose ends the composite', async () => {
    const lib = new ModelLibrary(scene)
    lib.now = () => clock
    lib.animLod = false
    let release: () => void = () => {}
    const gate = new Promise<void>(r => (release = r))
    fileLoader(lib, glb => (glb === RIDE.model.glb ? gate : Promise.resolve()))
    cleanups.push(() => lib.dispose())
    const rider = await lib.character(RIDER)
    expect(rider.root.isEnabled(false)).toBe(true)
    const pending = loadRide({ library: lib }, rider, RIDE)
    await Promise.resolve()
    expect(rider.root.isEnabled(false)).toBe(false)
    release()
    const ride = await pending
    expect(ride).not.toBeNull()
    expect(rider.root.isEnabled(false)).toBe(true)
    const internals = ride as unknown as Record<'beforeRender' | 'afterCull', { _willBeUnregistered: boolean }>
    expect(scene.onBeforeRenderObservable.observers).toContain(internals.beforeRender)
    expect(scene.onBeforeActiveMeshesEvaluationObservable.observers).toContain(internals.afterCull)
    // RideMob.dispose with a live rider: she leaves the composite (hers to dispose), the ride and the seat go.
    const seat = rider.root.parent as TransformNode
    ride!.dispose()
    expect(ride!.actor.isDisposed).toBe(true)
    expect(seat.isDisposed()).toBe(true)
    expect(rider.isDisposed).toBe(false)
    expect(rider.companion).toBeNull()
    expect(rider.lodLeader).toBeNull()
    expect(rider.heightHook).toBeNull()
    expect(rider.root.parent).toBeNull()
    // Both observers are removed (Babylon drops them from its list on its next notification).
    expect(internals.beforeRender._willBeUnregistered && internals.afterCull._willBeUnregistered).toBe(true)
    frame()
    rider.dispose()
  })

  it('a ride without the joint, or a rider disposed meanwhile: no ride, the rider stands alone', async () => {
    const rider = await library.character(RIDER)
    cleanups.push(() => rider.dispose())
    const live = library.liveActors.size
    expect(await loadRide({ library }, rider, { ...RIDE, joint: 'no such joint' })).toBeNull()
    expect(rider.root.isEnabled(false)).toBe(true)
    expect(rider.companion).toBeNull()
    expect(library.liveActors.size).toBe(live)
    const gone = await library.character(RIDER)
    const p = loadRide({ library }, gone, RIDE)
    gone.dispose()
    expect(await p).toBeNull()
    expect(library.liveActors.size).toBe(live)
  })

  it('the rider\'s dispose takes the ride (EntityView order: rider, then RideMob.dispose)', async () => {
    const { rider, tiger, ride } = await composite()
    const seat = rider.root.parent as TransformNode
    rider.dispose()
    expect(tiger.isDisposed).toBe(true)
    ride.dispose()
    expect(seat.isDisposed()).toBe(true)
  })

  it('Low (Classic): no animation LOD, the same composite, seated', async () => {
    const was = settings.get().graphics
    settings.set({ graphics: { preset: 'low', sky: 'classic', weather: 'off' } })
    cleanups.push(() => settings.set({ graphics: { preset: was.preset, sky: was.sky, weather: was.weather } }))
    const lib = new ModelLibrary(scene)
    lib.now = () => clock
    fileLoader(lib)
    cleanups.push(() => lib.dispose())
    expect(lib.animLod).toBe(false)
    const v = new EntityView({ ...MOB_STATE, id: 78 }, entityCtx(lib))
    cleanups.push(() => v.dispose())
    await v.load()
    expect(v.ride).not.toBeNull()
    expect(v.height).toBeGreaterThanOrEqual(2.8)
    expect(v.height).toBeLessThanOrEqual(3.4)
    v.actor!.play('WALK')
    frame(30)
    expect(playing(v.ride!.actor, 'WALK')).toBe(true)
    expect(pelvisGap(v.actor!, v.ride!.actor)).toBeLessThan(0.15)
  })
})

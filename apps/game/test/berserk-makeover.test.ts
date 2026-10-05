/**
 * The Berserk makeover (docs/EFFECTS.md §3.9 "Makeover"): the phase timing (start, active, the last 5 s flicker, the
 * end), the graphics tiers and the own-vs-others split, the camera / hit-stop / flinch helpers that must give back
 * exactly what they took, the synthesized sounds, and on a NullEngine scene the outline shells, afterimages and the
 * shared pool: everything made is disposed on end, despawn, death and warp (no mesh, material, texture, skeleton or
 * particle system left behind).
 */
import { Bone, Matrix, Mesh, NullEngine, Scene, Skeleton, StandardMaterial, TransformNode, ArcRotateCamera, Vector2, Vector3, VertexData } from '@babylonjs/core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BERSERK_SYNTH, boomPcm, exhalePcm, heartbeatPcm, SYNTH_RATE, wavBytes } from '../src/audio/synth.ts'
import { flashOpacity, FLASH_MS } from '../src/hud/berserk-screen.ts'
import { enBerserk } from '../src/i18n/en-berserk.ts'
import { defaultSettings, normalizeSettings } from '../src/settings.ts'
import { BerserkLook, type LookDeps } from '../src/world/features/berserk.ts'
import {
  BERSERK_TIERS,
  EYE_LIFT,
  HIT_BUMP_MS,
  LAST_MS,
  START_MS,
  beatIndex,
  berserkPhase,
  berserkTier,
  eyeFacing,
  fireTrail,
  flicker,
  flinch,
  FLINCH_MS,
  glowLevel,
  heartBpm,
  heartbeat,
  hitBump,
  makeoverParts,
  ringTexture,
  shellWidth,
  sigilTexture,
  softDotTexture,
  startCamera,
  stepTexture,
  type MakeoverParts,
} from '../src/world/fx/berserk-look.ts'
import { BerserkMakeover, BerserkPool, shellable, shellCode, shellGroups, type MakeoverActor, type MakeoverSubject } from '../src/world/fx/berserk-makeover.ts'
import { CameraNudge, Flinches, TimeFreeze } from '../src/world/fx/berserk-own.ts'

const ON = { screen: true, shake: true }

describe('phases', () => {
  it('start → active → last 5 s → end', () => {
    expect(berserkPhase(0, 60_000, false)).toBe('start')
    expect(berserkPhase(START_MS - 1, 60_000, false)).toBe('start')
    expect(berserkPhase(START_MS, 60_000, false)).toBe('active')
    expect(berserkPhase(30_000, LAST_MS + 1, false)).toBe('active')
    expect(berserkPhase(30_000, LAST_MS, false)).toBe('last')
    expect(berserkPhase(30_000, 0, false)).toBe('end')
    expect(berserkPhase(30_000, 20_000, true)).toBe('end')
    // A late viewer's look has no start moment; an unknown timer never reaches the last seconds.
    expect(berserkPhase(0, 60_000, false, false)).toBe('active')
    expect(berserkPhase(10_000, null, false)).toBe('active')
  })

  it('the heart beats faster in the last seconds and stops at the end', () => {
    expect(heartBpm('active')).toBeLessThan(heartBpm('last'))
    expect(heartBpm('end')).toBe(0)
    const beat = 60_000 / heartBpm('active')
    expect(heartbeat(beat * 0.06)).toBeGreaterThan(0.9)
    expect(heartbeat(beat * 0.7)).toBeLessThan(0.05)
    expect(beatIndex(beat * 2.5, heartBpm('active'))).toBe(2)
    expect(beatIndex(1000, 0)).toBe(-1)
  })

  it('the outline swells in at the start, rides the heartbeat, flickers out at the end', () => {
    expect(glowLevel(0, 'start', 60_000)).toBe(0)
    expect(glowLevel(START_MS - 1, 'start', 60_000)).toBeGreaterThan(1.2)
    for (let t = 2000; t < 4000; t += 37) {
      const g = glowLevel(t, 'active', 50_000)
      expect(g).toBeGreaterThanOrEqual(0.72)
      expect(g).toBeLessThanOrEqual(1)
    }
    expect(glowLevel(10_000, 'end', 0)).toBe(0)
    // No flicker before the last 5 s; dropouts in them, more of them towards the end.
    for (let t = 0; t < 5000; t += 70) expect(flicker(t, LAST_MS + 1)).toBe(1)
    const drops = (left: number) => Array.from({ length: 400 }, (_, i) => flicker(i * 70, left, 3)).filter(v => v < 1).length
    expect(drops(4900)).toBeGreaterThan(20)
    expect(drops(200)).toBeGreaterThan(drops(4900))
    for (let i = 0; i < 400; i++) expect(flicker(i * 70, 1000, 3)).toBeGreaterThanOrEqual(0.15)
    expect(shellWidth(1.3)).toBeGreaterThan(shellWidth(0.7))
  })
})

describe('camera, hit-stop and flinch', () => {
  it('the start push-in and shake end at START_MS; an own hit bumps for HIT_BUMP_MS', () => {
    expect(startCamera(0).push).toBe(0)
    expect(startCamera(120).push).toBeGreaterThan(0.1)
    expect(startCamera(START_MS)).toEqual({ push: 0, x: 0, y: 0 })
    expect(Math.abs(startCamera(50).x) + Math.abs(startCamera(50).y)).toBeGreaterThan(0)
    expect(hitBump(30)).toBeGreaterThan(0)
    expect(hitBump(HIT_BUMP_MS)).toBe(0)
    expect(flinch(40)).toBeGreaterThan(0.2)
    expect(flinch(FLINCH_MS)).toBe(0)
  })

  it('CameraNudge gives the camera its exact values back, and keeps what someone else wrote meanwhile', () => {
    const cam = { fov: 0.85, targetScreenOffset: new Vector2(0, 0) }
    const n = new CameraNudge(cam)
    for (let t = 0; t < START_MS; t += 16) {
      const c = startCamera(t)
      n.apply(c.push, c.x, c.y)
    }
    n.apply(0, 0, 0)
    expect(cam.fov).toBe(0.85)
    expect(cam.targetScreenOffset.x).toBe(0)
    expect(cam.targetScreenOffset.y).toBe(0)
    n.apply(0.1, 0.05, 0)
    cam.targetScreenOffset.x = 0.3 // the crit shake (world/camera-keys.ts) writes its own value
    n.apply(0.1, 0.05, 0)
    n.dispose()
    expect(cam.targetScreenOffset.x).toBe(0.3)
    expect(cam.fov).toBe(0.85)
    expect(n.idle).toBe(true)
  })

  it('TimeFreeze restores the animation speed (not over one set by someone else)', () => {
    const scene = { animationTimeScale: 1 }
    const f = new TimeFreeze(scene)
    f.freeze(0, 100, 0)
    expect(scene.animationTimeScale).toBe(0)
    f.freeze(50, 55, 0.05)
    f.update(99)
    expect(scene.animationTimeScale).toBe(0.05)
    f.update(106)
    expect(scene.animationTimeScale).toBe(1)
    f.freeze(200, 50, 0)
    scene.animationTimeScale = 0.5
    f.dispose()
    expect(scene.animationTimeScale).toBe(0.5)
  })

  it('Flinches push a model root back and put it exactly where it was', () => {
    const root = { position: new Vector3(0, 0, 0), isDisposed: () => false } as unknown as TransformNode
    const fl = new Flinches()
    fl.hit(1, root, 0, 3, 4, 0.2)
    fl.update(40)
    expect(Math.hypot(root.position.x, root.position.z)).toBeGreaterThan(0.05)
    fl.update(FLINCH_MS + 1)
    expect(root.position.x).toBeCloseTo(0, 12)
    expect(root.position.z).toBeCloseTo(0, 12)
    expect(fl.size).toBe(0)
    fl.hit(2, root, 0, 1, 0, 0.2)
    fl.update(30)
    fl.forget(2)
    expect(root.position.x).toBeCloseTo(0, 12)
  })
})

describe('tiers and the own-vs-others split', () => {
  it('Low keeps the outline, a few embers, the screen edge and the start ring only', () => {
    const low = makeoverParts(berserkTier('low'), true, 0, ON)
    expect(low).toMatchObject({ outline: true, vignette: true, ring: true, heat: false, afterimages: 0, eyes: false, footsteps: false, aura: false, dust: false, steam: false, flash: false, richColor: false })
    expect(low.embers).toBeGreaterThan(0)
    expect(low.embers).toBeLessThan(makeoverParts(berserkTier('high'), true, 0, ON).embers)
  })

  it('Medium and High get everything; the afterimages of others are capped by distance rank', () => {
    for (const p of ['medium', 'high', 'ultra'] as const) {
      const t = BERSERK_TIERS[p]
      const own = makeoverParts(t, true, 0, ON)
      expect(own).toMatchObject({ outline: true, heat: true, eyes: true, footsteps: true, aura: true, ring: true, dust: true, steam: true, flash: true, vignette: true, richColor: true, camera: true, hitStop: true, heartbeat: true })
      expect(own.afterimages).toBeGreaterThan(0)
      expect(makeoverParts(t, false, t.afterimageOthers - 1, ON).afterimages).toBe(t.afterimages)
      expect(makeoverParts(t, false, t.afterimageOthers, ON).afterimages).toBe(0)
    }
    expect(BERSERK_TIERS.medium.afterimageOthers).toBeLessThan(BERSERK_TIERS.high.afterimageOthers)
    expect(berserkTier('nonsense')).toBe(BERSERK_TIERS.medium)
  })

  it('others never get own-screen parts; the Options switches gate them', () => {
    const other = makeoverParts(BERSERK_TIERS.high, false, 0, ON)
    expect(other).toMatchObject({ flash: false, vignette: false, heartbeat: false, richColor: false, camera: false, hitStop: false, outline: true, ring: true })
    const noScreen = makeoverParts(BERSERK_TIERS.high, true, 0, { screen: false, shake: true })
    expect(noScreen).toMatchObject({ flash: false, vignette: false, heartbeat: false, camera: false, hitStop: false, outline: true })
    const noShake = makeoverParts(BERSERK_TIERS.high, true, 0, { screen: true, shake: false })
    expect(noShake).toMatchObject({ camera: false, vignette: true, flash: true, hitStop: true })
  })

  it('the retail keep cloud is toned down on every tier', () => {
    for (const t of Object.values(BERSERK_TIERS)) {
      expect(t.cloudScale).toBeLessThan(1)
      expect(t.cloudFade).toBeLessThan(1)
    }
  })

  it('the eyes fade as the face turns away; the trail burns orange and longer', () => {
    expect(eyeFacing(1)).toBe(1)
    expect(eyeFacing(0.2)).toBe(0)
    expect(eyeFacing(-1)).toBe(0)
    expect(EYE_LIFT).toBeGreaterThan(0)
    const t = fireTrail({ lengthMs: 160, color: [1, 1, 1, 0.78], blend: 'add', texture: 'x.png' })
    expect(t.lengthMs).toBeGreaterThan(160)
    expect(t.color[2]).toBeLessThan(0.5)
    expect(t.texture).toBe('x.png')
  })
})

describe('own screen, sounds, settings, strings', () => {
  it('the flash peaks early and is over by FLASH_MS', () => {
    expect(flashOpacity(30)).toBeGreaterThan(0.6)
    expect(flashOpacity(FLASH_MS)).toBe(0)
    expect(flashOpacity(30, 0.18)).toBeLessThan(0.2)
  })

  it('the synthesized sounds are deterministic, 16-bit WAVs with sound in them', () => {
    for (const [make, maxS] of [[heartbeatPcm, 1], [boomPcm, 1.5], [exhalePcm, 1.7]] as const) {
      const a = make()
      expect(a.rate).toBe(SYNTH_RATE)
      expect(a.samples.length / a.rate).toBeLessThanOrEqual(maxS)
      expect(Math.max(...a.samples.map(Math.abs))).toBeGreaterThan(0.5)
      expect(Array.from(make().samples)).toEqual(Array.from(a.samples))
      const wav = new DataView(wavBytes(a))
      expect(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3))).toBe('RIFF')
      expect(wav.getUint32(24, true)).toBe(SYNTH_RATE)
      expect(wav.byteLength).toBe(44 + a.samples.length * 2)
    }
    expect(Object.keys(BERSERK_SYNTH).sort()).toEqual(['synth/bz_boom', 'synth/bz_exhale', 'synth/bz_heart'])
  })

  it('Berserk screen effects is on by default and survives a save', () => {
    expect(defaultSettings().ui.berserkScreen).toBe(true)
    expect(normalizeSettings({ v: 1, ui: { berserkScreen: false } }).ui.berserkScreen).toBe(false)
    expect(normalizeSettings({ v: 1 }).ui.berserkScreen).toBe(true)
    expect(enBerserk['bz.option.screen']).toMatch(/Berserk/)
  })

  it('the textures are RGBA with a transparent rim', () => {
    for (const [data, size] of [[softDotTexture(32), 32], [ringTexture(64), 64], [stepTexture(32), 32], [sigilTexture(64), 64]] as const) {
      expect(data.length).toBe(size * size * 4)
      expect(data[3]).toBe(0)
      let alpha = 0
      for (let i = 3; i < data.length; i += 4) alpha = Math.max(alpha, data[i]!)
      expect(alpha).toBeGreaterThan(100)
    }
  })

  it('the shell shader has both languages at the same injection points', () => {
    for (const stage of ['vertex', 'fragment'] as const) {
      expect(Object.keys(shellCode('glsl', stage))).toEqual(Object.keys(shellCode('wgsl', stage)))
    }
    expect(shellCode('wgsl', 'vertex').CUSTOM_VERTEX_UPDATE_POSITION).toContain('uniforms.sroShellA')
    expect(shellCode('glsl', 'fragment').CUSTOM_FRAGMENT_BEFORE_FOG).toContain('sroShellE')
  })
})

// ---- the Babylon side, on a NullEngine ------------------------------------------------------------------------------

let engine: NullEngine
let scene: Scene

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  scene.activeCamera = new ArcRotateCamera('cam', 0.5, 1, 8, Vector3.Zero(), scene)
  // The scene's own default material (made on a first render) exists before any count is taken.
  void scene.defaultMaterial
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterAll(() => {
  vi.restoreAllMocks()
  scene.dispose()
  engine.dispose()
})

/** A small skinned character: two bones (Bip01, Bip01 Head) on joints, a skinned body and a static weapon. */
function makeActor(): MakeoverActor & { body: Mesh; weapon: Mesh; root: TransformNode; dispose(): void } {
  const root = new TransformNode('actor', scene)
  const hips = new TransformNode('Bip01', scene)
  hips.parent = root
  const head = new TransformNode('Bip01 Head', scene)
  head.parent = hips
  head.position.y = 1.5
  const skeleton = new Skeleton('skel', 'skel', scene)
  const b0 = new Bone('Bip01', skeleton, null, Matrix.Identity())
  b0.linkTransformNode(hips)
  new Bone('Bip01 Head', skeleton, b0, Matrix.Translation(0, 1.5, 0)).linkTransformNode(head)
  const body = new Mesh('body', scene)
  const vd = new VertexData()
  vd.positions = [-0.3, 0, 0, 0.3, 0, 0, 0, 1.8, 0, 0, 0.9, 0.3]
  vd.normals = [-1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
  vd.indices = [0, 1, 2, 0, 2, 3, 1, 3, 2]
  vd.matricesIndices = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]
  vd.matricesWeights = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
  vd.applyToMesh(body)
  body.skeleton = skeleton
  body.parent = root
  body.material = new StandardMaterial('bodyMat', scene)
  const weapon = new Mesh('blade', scene)
  VertexData.CreateBox({ size: 0.2 }).applyToMesh(weapon)
  weapon.parent = head
  // A material of its own: a mesh without one makes the scene's default material on the first render.
  weapon.material = new StandardMaterial('bladeMat', scene)
  return {
    body,
    weapon,
    root,
    skeleton,
    isDisposed: false,
    mergeVersion: 0,
    allMeshes: () => [body, weapon],
    joint: (n: string) => (n === 'Bip01 Head' ? head : n === 'Bip01' ? hips : undefined),
    dispose() {
      body.dispose()
      weapon.dispose()
      skeleton.dispose()
      root.dispose()
      ;(body.material as StandardMaterial | null)?.dispose()
      ;(weapon.material as StandardMaterial | null)?.dispose()
    },
  }
}

function subject(actor: MakeoverActor | null, over: Partial<{ moving: boolean; swinging: boolean }> = {}): MakeoverSubject & { moving: boolean } {
  const feet = new Vector3(1, 0, 2)
  return {
    actor,
    feet: () => feet,
    yaw: 0,
    moving: over.moving ?? false,
    swinging: () => over.swinging ?? false,
    height: () => 1.9,
  }
}

const counts = () => ({
  meshes: scene.meshes.length,
  materials: scene.materials.length,
  textures: scene.textures.length,
  skeletons: scene.skeletons.length,
  particles: scene.particleSystems.length,
  geometries: scene.geometries.length,
})

const FULL: MakeoverParts = makeoverParts(BERSERK_TIERS.high, true, 0, ON)

function clock() {
  let t = 1000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('makeover on a NullEngine scene', () => {
  it('an outline shell per drawn mesh, sharing geometry and skeleton, outside the actor tree; all gone after the end', () => {
    const actor = makeActor()
    const before = counts()
    const c = clock()
    const pool = new BerserkPool(scene, c.now)
    const m = new BerserkMakeover(pool, subject(actor), 0.3)
    m.start(FULL)
    pool.beginFrame()
    m.update(c.now(), 1, FULL)
    pool.endFrame()
    expect(m.shellCount).toBe(2)
    const shells = scene.meshes.filter(x => x.name.startsWith('bz:shell')) as Mesh[]
    const bodyShell = shells.find(s => s.name === 'bz:shell:body')!
    expect(bodyShell.geometry).toBe(actor.body.geometry)
    expect(bodyShell.skeleton).toBe(actor.skeleton)
    // Not in the actor's tree (the shadow casters and the renderer's character roots walk it).
    expect(actor.root.getChildMeshes(false).some(x => x.name.startsWith('bz:'))).toBe(false)
    expect(bodyShell.parent).toBeNull()
    expect(bodyShell.getWorldMatrix()).toBe(actor.body.getWorldMatrix())
    expect(pool.stats()).toMatchObject({ users: 1, rings: 1, eyes: 2, sigils: 1 })
    // The end: the steam puff, every look part gone; the pool goes once its rings, steps and particles are over.
    m.end(true)
    expect(m.shellCount).toBe(0)
    pool.beginFrame()
    pool.endFrame()
    expect(pool.idle).toBe(false)
    c.advance(10_000)
    pool.beginFrame()
    pool.endFrame()
    for (let i = 0; i < 400 && !pool.idle; i++) scene.render()
    expect(pool.idle).toBe(true)
    pool.dispose()
    expect(counts()).toEqual(before)
    actor.dispose()
  })

  it('afterimages: ghost rigs on cloned skeletons while moving, disposed with the look', () => {
    const actor = makeActor()
    const before = counts()
    const c = clock()
    const pool = new BerserkPool(scene, c.now)
    const subj = subject(actor, { moving: true })
    const m = new BerserkMakeover(pool, subj, 0.1)
    for (let i = 0; i < 10; i++) {
      pool.beginFrame()
      m.update(c.now(), 1, FULL)
      pool.endFrame()
      c.advance(50)
    }
    expect(m.ghostCount).toBe(FULL.afterimages)
    const ghostSkels = scene.skeletons.filter(s => s.name.startsWith('bz:ghost'))
    expect(ghostSkels).toHaveLength(FULL.afterimages)
    // The ghost bones are not driven by the animated joints.
    for (const s of ghostSkels) for (const b of s.bones) expect(b.getTransformNode()).toBeNull()
    expect(pool.stats().steps).toBeGreaterThan(0)
    // A warp hides what trails behind.
    m.warped()
    expect(scene.meshes.filter(x => x.name.startsWith('bz:ghost') && x.isEnabled()).length).toBe(0)
    // The rank moves past the cap: the afterimages hide at once, the rigs go after a while (ranks of near players flicker).
    const capped = makeoverParts(BERSERK_TIERS.high, false, 99, ON)
    pool.beginFrame()
    m.update(c.now(), 1, capped)
    pool.endFrame()
    expect(m.ghostCount).toBe(FULL.afterimages)
    expect(scene.meshes.filter(x => x.name.startsWith('bz:ghost') && x.isEnabled()).length).toBe(0)
    c.advance(3000)
    m.update(c.now(), 1, capped)
    expect(m.ghostCount).toBe(0)
    expect(scene.skeletons.filter(s => s.name.startsWith('bz:ghost'))).toHaveLength(0)
    m.dispose()
    c.advance(10_000)
    pool.beginFrame()
    pool.endFrame()
    pool.dispose()
    expect(counts()).toEqual(before)
    actor.dispose()
  })

  it('a re-dress: a disposed or hidden source loses its shell; a new one gets one', () => {
    const actor = makeActor()
    const c = clock()
    const pool = new BerserkPool(scene, c.now)
    const m = new BerserkMakeover(pool, subject(actor), 0.5)
    pool.beginFrame()
    m.update(c.now(), 1, FULL)
    expect(m.shellCount).toBe(2)
    actor.weapon.dispose()
    expect(m.shellCount).toBe(1)
    actor.body.isVisible = false
    c.advance(1000)
    m.update(c.now(), 1, FULL)
    expect(m.shellCount).toBe(0)
    expect(shellable(actor.body)).toBe(false)
    actor.body.isVisible = true
    c.advance(1000)
    m.update(c.now(), 1, FULL)
    expect(m.shellCount).toBe(1)
    // The outline off (no tier would, but the parts can say so): the shells go.
    m.update(c.now(), 1, { ...FULL, outline: false })
    expect(m.shellCount).toBe(0)
    m.dispose()
    pool.endFrame()
    pool.dispose()
    actor.dispose()
  })

  it('skinned parts with one layout share one merged shell (one draw); the rest get their own', () => {
    const actor = makeActor()
    const arm = actor.body.clone('arm', actor.root)
    arm.skeleton = actor.skeleton
    arm.makeGeometryUnique()
    const groups = shellGroups([actor.body, arm, actor.weapon], actor.skeleton)
    expect(groups.map(g => g.map(m => m.name))).toEqual([['body', 'arm'], ['blade']])
    const c = clock()
    const pool = new BerserkPool(scene, c.now)
    const m = new BerserkMakeover(pool, { ...subject(actor), actor: { ...actor, allMeshes: () => [actor.body, arm, actor.weapon] } }, 0.2)
    pool.beginFrame()
    m.update(c.now(), 1, FULL)
    pool.endFrame()
    expect(m.shellCount).toBe(2)
    const merged = scene.meshes.find(x => x.name === 'bz:shell:body+1') as Mesh
    expect(merged.getTotalVertices()).toBe(actor.body.getTotalVertices() + arm.getTotalVertices())
    expect(merged.parent).toBeNull()
    // Losing a part re-groups: the merged shell goes with it.
    arm.dispose()
    expect(merged.isDisposed()).toBe(true)
    c.advance(1000)
    m.update(c.now(), 1, FULL)
    expect(m.shellCount).toBe(2)
    m.dispose()
    pool.dispose()
    actor.dispose()
  })

  it('alpha-blended meshes get no outline', () => {
    const mesh = new Mesh('veil', scene)
    VertexData.CreateBox({ size: 1 }).applyToMesh(mesh)
    const mat = new StandardMaterial('veil', scene)
    mat.alpha = 0.5
    mesh.material = mat
    expect(shellable(mesh)).toBe(false)
    mat.alpha = 1
    expect(shellable(mesh)).toBe(true)
    mesh.dispose()
    mat.dispose()
  })
})

describe('BerserkLook (world/features/berserk.ts): end, despawn, death and warp', () => {
  function fakeView(actor: MakeoverActor & { root: TransformNode }) {
    return {
      id: 5,
      actor: { ...actor, root: actor.root, height: 1.8, isDisposed: false, clipCursors: () => ({ top: null, overlay: null }), model: { code: 'MOB_X' } },
      root: new TransformNode('view', scene),
      yaw: 0,
      moving: false,
      dead: false,
      isDisposed: false,
      scale: 1,
    }
  }

  function deps(pool: () => BerserkPool, now: () => number) {
    const played: string[] = []
    const d: LookDeps = {
      fx: { play: (_k: string, phase: string) => (played.push(phase), { stop() {}, done: true }), runner: {} } as unknown as LookDeps['fx'],
      hairFor: async () => null,
      selfId: () => null,
      pool,
      clock: now,
    }
    return { d, played }
  }

  it('start (burst), death drops the makeover, revival brings it back, the end and the despawn leave nothing', async () => {
    const actor = makeActor()
    const before = counts()
    const c = clock()
    let pool: BerserkPool | null = null
    const usePool = () => (pool && !pool.isDisposed ? pool : (pool = new BerserkPool(scene, c.now)))
    const { d, played } = deps(usePool, c.now)
    const view = fakeView(actor)
    const look = new BerserkLook(d, view as never, true, FULL, { scale: 0.5, fade: 0.3 })
    expect(played).toEqual(['start', 'loop'])
    const frame = (left: number | null = 50_000) => {
      pool?.beginFrame()
      const r = look.update(16, { now: c.now(), leftMs: left, parts: FULL })
      pool?.endFrame()
      return r
    }
    frame()
    expect(look.makeover?.shellCount).toBe(2)
    expect(look.phase).toBe('start')
    c.advance(START_MS)
    frame()
    expect(look.phase).toBe('active')
    frame(3000)
    expect(look.phase).toBe('last')
    // Death: the makeover goes (the retail loop waits for the server's end); back alive, it returns.
    view.dead = true
    frame()
    expect(look.makeover).toBeNull()
    expect(scene.meshes.filter(m => m.name.startsWith('bz:shell'))).toHaveLength(0)
    view.dead = false
    frame()
    expect(look.makeover?.shellCount).toBe(2)
    look.warped()
    // The end: DEACT plays, the makeover goes now, the growth shrinks back, then the look is over.
    look.end(true, true)
    expect(played).toContain('end')
    expect(look.makeover).toBeNull()
    let alive = true
    for (let i = 0; i < 200 && alive; i++) alive = frame()
    expect(alive).toBe(false)
    c.advance(10_000)
    for (let i = 0; i < 400 && pool && !(pool as BerserkPool).idle; i++) {
      scene.render()
      frame()
    }
    expect((pool as BerserkPool | null)?.idle).toBe(true)
    ;(pool as BerserkPool | null)?.dispose()
    expect(counts()).toEqual(before)

    // A despawn mid-Berserk: dispose() alone cleans everything.
    pool = null
    const look2 = new BerserkLook(d, view as never, false, FULL, { scale: 0.5, fade: 0.3 })
    ;(pool as unknown as BerserkPool).beginFrame()
    look2.update(16, { now: c.now(), leftMs: 40_000, parts: FULL })
    expect(look2.makeover?.shellCount).toBe(2)
    look2.dispose()
    expect(scene.meshes.filter(m => m.name.startsWith('bz:shell'))).toHaveLength(0)
    ;(pool as unknown as BerserkPool).dispose()
    view.root.dispose()
    expect(counts()).toEqual({ ...before })
    actor.dispose()
  })
})


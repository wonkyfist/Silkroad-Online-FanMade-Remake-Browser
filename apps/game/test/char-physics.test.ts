import { Bone, FreeCamera, Matrix, NullEngine, Quaternion, Scene, Skeleton, TransformNode, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { attachCharPhysics, charPhysicsDebug, charPhysicsMath, setCharPhysicsConfig } from '../src/three/char-physics.ts'
import { defaultSettings, effectiveGraphics } from '../src/settings.ts'
import { jiggleParams, physicsMaxFor, pickPhysics, SPRING_STEP, SpringSim, type SpringParams } from '../src/three/spring-bones.ts'

const P: SpringParams = { stiffness: 0.012, damping: 0.1, drag: 0.02, gravity: 1, tether: 0.7, radius: 0.01, amplitude: 1 }

/** A chain of `n` particles hanging down from (x, y, 0), 0.1 m apart. */
function hang(sim: SpringSim, x: number, y: number, n: number): void {
  for (let i = 0; i < n; i++) sim.target.set([x, y - 0.1 * i, 0], i * 3)
}
const dist = (a: Float32Array, i: number, b: Float32Array, j: number) => Math.hypot(a[i * 3]! - b[j * 3]!, a[i * 3 + 1]! - b[j * 3 + 1]!, a[i * 3 + 2]! - b[j * 3 + 2]!)
const none = new Float32Array(0)

describe('spring bones (CHARACTERS §16.2)', () => {
  it('stays finite and inside its tether under a shaking root and ragged frames', () => {
    const n = 7
    const sim = new SpringSim([{ start: 0, count: n, params: P, colliders: [] }], n)
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let f = 0; f < 3000; f++) {
      const t = f / 60
      hang(sim, Math.sin(t * 9) * 0.4 + (f % 400 < 200 ? 0 : 0.6), 1.5 + Math.cos(t * 13) * 0.2, n)
      const steps = sim.update(0.004 + rnd() * 0.05, none)
      for (let i = 0; i < sim.out.length; i++) expect(Number.isFinite(sim.out[i]!)).toBe(true)
      // (a frame without a step has a moved target and the last step's particles: lag, not drift)
      for (let i = 1; i < n && steps > 0; i++) {
        expect(dist(sim.pos, i, sim.target, i)).toBeLessThanOrEqual(P.tether * 0.1 * i + 1e-5) // the tether, give or take the length pass
      }
    }
  })

  it('trails when the root moves and follows through past the pose when it stops, then settles', () => {
    const n = 6
    const sim = new SpringSim([{ start: 0, count: n, params: P, colliders: [] }], n)
    let x = 0
    for (let f = 0; f < 90; f++) {
      x += 5.5 * SPRING_STEP
      hang(sim, x, 1.5, n)
      sim.update(SPRING_STEP, none)
      for (let i = 1; i < n; i++) expect(Math.abs(dist(sim.pos, i, sim.pos, i - 1) - 0.1)).toBeLessThan(1e-3) // bone lengths kept
    }
    const tip = (n - 1) * 3
    expect(sim.pos[tip]!).toBeLessThan(sim.target[tip]! - 0.05) // running +x: the tip trails behind
    let ahead = -Infinity
    for (let f = 0; f < 60; f++) {
      sim.update(SPRING_STEP, none)
      ahead = Math.max(ahead, sim.pos[tip]! - sim.target[tip]!)
    }
    expect(ahead).toBeGreaterThan(0.02) // swings past the stopped pose
    for (let f = 0; f < 900; f++) sim.update(SPRING_STEP, none)
    expect(dist(sim.pos, n - 1, sim.target, n - 1)).toBeLessThan(0.01)
  })

  it('resets to the pose after a long frame or a teleport', () => {
    const sim = new SpringSim([{ start: 0, count: 3, params: P, colliders: [] }], 3)
    hang(sim, 0, 1, 3)
    sim.update(SPRING_STEP, none)
    hang(sim, 0.3, 1, 3)
    sim.update(SPRING_STEP, none)
    expect(dist(sim.pos, 2, sim.target, 2)).toBeGreaterThan(0.001)
    hang(sim, 40, 1, 3)
    expect(sim.update(SPRING_STEP, none)).toBe(0)
    expect(dist(sim.out, 2, sim.target, 2)).toBe(0)
    hang(sim, 40.3, 1, 3)
    expect(sim.update(1, none)).toBe(0)
    expect(dist(sim.out, 2, sim.target, 2)).toBe(0)
  })

  it('keeps particles out of the body capsules', () => {
    // a horizontal chain falling onto a capsule (a thigh) under its middle
    const n = 6
    const loose = { ...P, stiffness: 0, tether: 10 }
    const sim = new SpringSim([{ start: 0, count: n, params: loose, colliders: [0] }], n)
    const caps = new Float32Array([0.25, 0.9, -0.5, 0.25, 0.9, 0.5, 0.06])
    for (let i = 0; i < n; i++) sim.target.set([0.1 * i, 1, 0], i * 3)
    for (let f = 0; f < 600; f++) {
      sim.update(SPRING_STEP, caps)
      for (let i = 1; i < n; i++) {
        const d = Math.hypot(sim.pos[i * 3]! - 0.25, sim.pos[i * 3 + 1]! - 0.9)
        expect(d).toBeGreaterThanOrEqual(0.06 + loose.radius - 1e-4)
      }
    }
    expect(sim.pos[(n - 1) * 3 + 1]!).toBeLessThan(0.9) // draped over it and down
  })

  it('scales the jiggle by the size slider and stiffens it under armour', () => {
    const base: SpringParams = { stiffness: 0.16, damping: 0.07, drag: 0, gravity: 0, tether: 0.25, radius: 0, amplitude: 1 }
    expect(jiggleParams(base, 1, 0)).toMatchObject({ amplitude: 1, stiffness: 0.16 })
    expect(jiggleParams(base, 0, 0).amplitude).toBe(0)
    expect(jiggleParams(base, 1.5, 0).amplitude).toBeCloseTo(1.5)
    const heavy = jiggleParams(base, 1, 1)
    expect(heavy.stiffness).toBeCloseTo(0.48)
    expect(heavy.amplitude).toBeCloseTo(0.4)
  })

  it('simulates only the nearest characters within range, by preset; the Options rows switch each part', () => {
    expect(pickPhysics([5, 30, 1, 12, 19], 2)).toEqual([true, false, true, false, false])
    expect(pickPhysics([5, 30, 1], 8)).toEqual([true, false, true])
    expect(pickPhysics([1, 2], 0)).toEqual([false, false])
    expect([physicsMaxFor('classic', 'high'), physicsMaxFor('pbr', 'low'), physicsMaxFor('pbr', 'medium'), physicsMaxFor('pbr', 'high'), physicsMaxFor('pbr', 'ultra')]).toEqual([0, 0, 8, 12, 12])
    const s = defaultSettings()
    s.graphics.modern = true
    expect(effectiveGraphics(s, { rollout: 'on', preset: 'medium' }).charPhysics).toEqual({ max: 8, cloth: true, body: true })
    expect(effectiveGraphics(s, { rollout: 'on', preset: 'low' }).charPhysics.max).toBe(0)
    s.graphics.hairCloth = false
    expect(effectiveGraphics(s, { rollout: 'on', preset: 'high' }).charPhysics).toEqual({ max: 12, cloth: false, body: true })
  })

  it('turns a direction onto another (the bone write)', () => {
    const { fromTo, rotate } = charPhysicsMath
    for (const [a, b] of [[[1, 0, 0], [0, 1, 0]], [[0, 0, 1], [0, 0, -1]], [[0.3, -0.2, 0.9], [-0.5, 0.1, 0.2]]] as const) {
      const v = rotate(fromTo(a, b), a)
      const lb = Math.hypot(...b), la = Math.hypot(...a)
      v.forEach((c, i) => expect(c / la).toBeCloseTo(b[i]! / lb, 5))
    }
  })
})

describe('char physics on a skeleton (§16.2)', () => {
  const engine = new NullEngine()
  charPhysicsDebug.fixedDt = 1 / 60
  afterEach(() => setCharPhysicsConfig({ max: 8, cloth: true, body: true }))

  function rig() {
    const scene = new Scene(engine)
    const cam = new FreeCamera('cam', new Vector3(0, 1.6, -4), scene)
    scene.activeCamera = cam
    const root = new TransformNode('actor', scene)
    const sk = new Skeleton('sk', 'sk', scene)
    const node = (name: string, parent: TransformNode, t: [number, number, number]) => {
      const n = new TransformNode(name, scene)
      n.parent = parent
      n.position.set(...t)
      n.rotationQuaternion = Quaternion.Identity()
      const b = new Bone(name, sk, null, Matrix.Translation(...t))
      b.linkTransformNode(n)
      return n
    }
    const pelvis = node('pelvis', root, [0, 1, 0])
    const spine = node('spine_04', pelvis, [0, 0.4, 0])
    const head = node('head', spine, [0, 0.3, 0])
    const h1 = node('hair_back_01_mid', head, [0, 0, -0.1])
    const h2 = node('hair_back_02_mid', h1, [0, -0.1, 0])
    node('hair_back_03_mid', h2, [0, -0.1, 0])
    const breast = node('breast_l', spine, [0.08, -0.1, 0.1])
    const phys = attachCharPhysics(scene, root, sk, [])!
    return { scene, root, phys, h1, breast }
  }

  it('finds the chains, swings the hair when the body moves, and hands the bones back when switched off', () => {
    const { scene, root, phys, h1, breast } = rig()
    expect(phys.stats).toMatchObject({ cloth: 1, body: 1 })
    for (let f = 0; f < 30; f++) {
      root.position.x += 0.1
      scene.render()
    }
    expect(phys.active).toBe(true)
    expect(Math.abs(h1.rotationQuaternion!.w)).toBeLessThan(0.99999)
    setCharPhysicsConfig({ max: 8, cloth: false, body: true })
    scene.render()
    expect(h1.rotationQuaternion!.w).toBe(1)
    setCharPhysicsConfig({ max: 0, cloth: true, body: true })
    scene.render()
    expect(phys.active).toBe(false)
    expect(breast.rotationQuaternion!.w).toBe(1)
    scene.dispose()
  })

  it('drops characters beyond the range', () => {
    const { scene, root, phys } = rig()
    root.position.z = 40
    scene.render()
    expect(phys.active).toBe(false)
    root.position.z = 5
    scene.render()
    expect(phys.active).toBe(true)
    scene.dispose()
  })
})

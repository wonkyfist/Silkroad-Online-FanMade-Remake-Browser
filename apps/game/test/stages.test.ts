/**
 * The stage table (docs/SCREENS.md §0B.2, §0B.10 `stages.test.ts`; lane SCR-R): the fit rule, the slot row and both
 * cameras as pure maths at 4:3, 16:10, 16:9 and 21:9, and on the served export (work/out-opt/world/jangan-fields,
 * skipped when absent): the spot within 0.5 m of the nav, the slots on walkable nav, both cameras at least 0.5 m above
 * the ground with nothing over them (not inside a building), the ocean and the coast nowhere near.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ArcRotateCamera, Matrix, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { loadWorld, type World, type WorldIO } from '@sro/world-render'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { arcPose, barFraction, headingAxes, projectPoint, selectFitDistance, slotPoints, stagePose, type Vec3 } from '../src/stage/slots.ts'
import { SELECT_MAX_PULL_M, SELECT_STEP_M, SLOT_SPACING_M, STAGE_DEFAULT_WORLD, STAGE_SPOT, STAGE_STREAM, STAGES, stageWorld } from '../src/stage/stages.ts'

/** The aspects the screens are framed for (§0B.2; narrower than 4:3 is out of scope). */
const ASPECTS: Array<[string, number, number]> = [
  ['4:3', 1600, 1200],
  ['16:10', 1680, 1050],
  ['16:9', 1920, 1080],
  ['21:9', 2560, 1080],
]
/** A standing character's points (m above its feet): the feet, the head of a tall one, the shoulder half-width. */
const FEET_M = -0.05
const HEAD_M = 1.8
const SHOULDER_M = 0.35

const flat = (x: number, z: number, y = 0): Vec3 => ({ x, y, z })

describe('the stage table (SCREENS §0B.2)', () => {
  it('one spot for both stages; select looks south at the steps, create north at the plaza; create caps the draw range', () => {
    expect(STAGES.select.spot).toEqual(STAGE_SPOT)
    expect(STAGES.create.spot).toEqual(STAGE_SPOT)
    expect(STAGES.select.camera.yaw).toBe(0)
    expect(STAGES.create.camera.yaw).toBeCloseTo(Math.PI, 12)
    expect(headingAxes(0).look).toEqual({ x: 0, y: 0, z: 1 })
    expect(STAGES.select.rangeScaleCap).toBeUndefined()
    expect(STAGES.create.rangeScaleCap).toBe(0.6)
    for (const d of Object.values(STAGES)) {
      expect(d.readyRadiusM).toBe(STAGE_STREAM.loadRadiusM)
      expect(d.time).toEqual({ kind: 'server', fallback: 0.773 })
      expect(d.weather).toBe('server')
    }
    expect(stageWorld(STAGES.select, 'jangan-fields')).toBe('jangan-fields')
    expect(stageWorld(STAGES.select, 'jangan')).toBe('jangan')
    expect(stageWorld(STAGES.select, undefined)).toBe(STAGE_DEFAULT_WORLD)
    expect(stageWorld(STAGES.select, '../etc')).toBe(STAGE_DEFAULT_WORLD)
    expect(stageWorld({ world: 'jangan-near' }, 'jangan')).toBe('jangan-near')
  })

  it('the fit rule: 3.94 m at 16:9, 16:10 and 21:9, 3.86 m at 4:3; the bars are style.css --bar-h', () => {
    const fov = (50 * Math.PI) / 180
    expect(barFraction(1920, 1080)).toBeCloseTo(0.16, 6)
    expect(barFraction(1600, 1200)).toBeCloseTo(172 / 1200, 6)
    const d = (w: number, h: number) => selectFitDistance(fov, w / h, barFraction(w, h))
    expect(d(1920, 1080)).toBeCloseTo(3.94, 2)
    expect(d(1680, 1050)).toBeCloseTo(3.94, 2)
    expect(d(2560, 1080)).toBeCloseTo(3.94, 2)
    expect(d(1600, 1200)).toBeCloseTo(3.86, 2)
    // The 16:9 value is the table's distM.
    expect(STAGES.select.camera.distM).toBeCloseTo(d(1920, 1080), 2)
  })

  it('select: slot 0 is the leftmost on screen, the row is a shallow arc, every slot turns to the camera, the camera never moves with n', () => {
    const pose = stagePose(STAGES.select, { spot: STAGE_SPOT, ground: 0, width: 1920, height: 1080 })
    for (const n of [1, 2, 3, 4]) {
      const again = stagePose(STAGES.select, { spot: STAGE_SPOT, ground: 0, width: 1920, height: 1080 })
      expect(again).toEqual(pose)
      const slots = slotPoints(STAGES.select, STAGE_SPOT, n, pose.position)
      const xs = slots.map(s => projectPoint(pose, 16 / 9, flat(s.x, s.z, 1)).x)
      for (let i = 1; i < n; i++) expect(xs[i]!, `n=${n} slot ${i}`).toBeGreaterThan(xs[i - 1]!)
      // Centred: the row's middle projects at the middle of the screen.
      expect((xs[0]! + xs[n - 1]!) / 2).toBeCloseTo(0.5, 2)
      for (const s of slots) {
        const toCam = Math.atan2(pose.position.x - s.x, pose.position.z - s.z)
        expect(Math.abs(Math.atan2(Math.sin(s.yaw - toCam), Math.cos(s.yaw - toCam)))).toBeLessThan(1e-9)
      }
    }
    // Four slots: 1.3 m apart across the view; the outer two 0.2 m closer to the camera than the arc's middle.
    const four = slotPoints(STAGES.select, STAGE_SPOT, 4, pose.position)
    expect(Math.abs(four[1]!.x - four[2]!.x)).toBeCloseTo(SLOT_SPACING_M, 9)
    expect(STAGE_SPOT.z - four[0]!.z).toBeCloseTo(0.2, 9)
    // The selected one steps 0.3 m toward the camera (−Z: the camera looks +Z); an outer one only to 0.4 m in front of
    // the row's line.
    const sel = slotPoints(STAGES.select, STAGE_SPOT, 4, pose.position, 1)
    expect(four[1]!.z - sel[1]!.z).toBeCloseTo(SELECT_STEP_M, 9)
    expect(sel[0]).toEqual(four[0])
    const outer = slotPoints(STAGES.select, STAGE_SPOT, 4, pose.position, 0)
    expect(STAGE_SPOT.z - outer[0]!.z).toBeCloseTo(SELECT_MAX_PULL_M, 9)
  })

  for (const [label, w, h] of ASPECTS) {
    it(`select at ${label}: every slot's feet and head inside the frame minus the bars (the selected one stepped)`, () => {
      const aspect = w / h
      const bar = barFraction(w, h)
      const pose = stagePose(STAGES.select, { spot: STAGE_SPOT, ground: 0, width: w, height: h })
      for (let selected = -1; selected < 4; selected++) {
        for (const s of slotPoints(STAGES.select, STAGE_SPOT, 4, pose.position, selected)) {
          const feet = projectPoint(pose, aspect, flat(s.x, s.z, FEET_M))
          const head = projectPoint(pose, aspect, flat(s.x, s.z, HEAD_M))
          const at = `${label} slot (${s.x.toFixed(2)}, ${s.z.toFixed(2)}) selected ${selected}`
          expect(feet.y, `${at} feet`).toBeLessThan(1 - bar)
          expect(head.y, `${at} head`).toBeGreaterThan(bar)
          expect(feet.x, at).toBeGreaterThan(0)
          expect(feet.x, at).toBeLessThan(1)
        }
      }
    })

    it(`create at ${label}: the character stands left of centre, clear of the calligraphy panel, the rotate window and the bars`, () => {
      const aspect = w / h
      const bar = barFraction(w, h)
      for (const zoom of [0, 1]) {
        const pose = stagePose(STAGES.create, { spot: STAGE_SPOT, ground: 0, width: w, height: h, zoom })
        const [s] = slotPoints(STAGES.create, STAGE_SPOT, 1, pose.position)
        expect(s!.yaw).toBe(STAGES.create.facing)
        const { right } = headingAxes(STAGES.create.camera.yaw)
        const at = `${label} zoom ${zoom}`
        const centre = projectPoint(pose, aspect, flat(s!.x, s!.z, 1.2))
        const shoulder = projectPoint(pose, aspect, flat(s!.x + right.x * SHOULDER_M, s!.z + right.z * SHOULDER_M, 1.2))
        // Left of centre (the character at ~43 %), its right shoulder left of the panel's edge (60.6 % of the width).
        expect(centre.x, at).toBeGreaterThan(0.3)
        expect(centre.x, at).toBeLessThan(0.5)
        expect(shoulder.x, at).toBeLessThan(0.606)
        if (zoom === 0) {
          // Full body: the feet above the rotate window (its top at ≈ 77 %), the head below the top bar.
          expect(projectPoint(pose, aspect, flat(s!.x, s!.z, FEET_M)).y, at).toBeLessThan(0.77)
          expect(projectPoint(pose, aspect, flat(s!.x, s!.z, HEAD_M)).y, at).toBeGreaterThan(bar)
        } else {
          // The face key: the face (1.5–1.7 m) in the frame between the bars.
          const face = projectPoint(pose, aspect, flat(s!.x, s!.z, 1.6))
          expect(face.y, at).toBeGreaterThan(bar)
          expect(face.y, at).toBeLessThan(1 - bar)
        }
      }
    })
  }

  it('the pose maths match Babylon: an ArcRotateCamera on arcPose projects a point where projectPoint does', () => {
    const engine = new NullEngine({ renderWidth: 1920, renderHeight: 1080, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1 })
    try {
      const scene = new Scene(engine)
      scene.useRightHandedSystem = true
      for (const def of [STAGES.select, STAGES.create]) {
        const pose = stagePose(def, { spot: STAGE_SPOT, ground: -3.26, width: 1920, height: 1080 })
        const a = arcPose(pose.position, pose.target)
        const cam = new ArcRotateCamera('c', a.alpha, a.beta, a.radius, new Vector3(pose.target.x, pose.target.y, pose.target.z), scene)
        cam.fov = pose.fovRad
        cam.minZ = 0.1
        scene.activeCamera = cam
        const view = cam.getViewMatrix(true)
        const proj = cam.getProjectionMatrix(true)
        expect(cam.position.x).toBeCloseTo(pose.position.x, 6)
        expect(cam.position.y).toBeCloseTo(pose.position.y, 6)
        expect(cam.position.z).toBeCloseTo(pose.position.z, 6)
        const p = { x: STAGE_SPOT.x + 0.7, y: -3.26 + 1.2, z: STAGE_SPOT.z - 0.4 }
        const vp = cam.viewport.toGlobal(1920, 1080)
        const s = Vector3.Project(new Vector3(p.x, p.y, p.z), Matrix.Identity(), view.multiply(proj), vp)
        const q = projectPoint(pose, 1920 / 1080, p)
        expect(s.x / 1920).toBeCloseTo(q.x, 4)
        expect(s.y / 1080).toBeCloseTo(q.y, 4)
        cam.dispose()
      }
      scene.dispose()
    } finally {
      engine.dispose()
    }
  })
})

// ---- on the served export ----------------------------------------------------------------------------------------

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const OUT_OPT = join(REPO, 'work', 'out-opt')
const hasFields = existsSync(join(OUT_OPT, 'world', 'jangan-fields', 'manifest.json')) && existsSync(join(OUT_OPT, 'world', 'jangan-fields', 'nav-objects.bin'))

const io: WorldIO = {
  async bytes(url) {
    const buf = await readFile(fileURLToPath(url))
    return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
  },
  async decodeImage(_bytes, _mime, size) {
    const s = size ?? 4
    return { width: s, height: s, data: new Uint8Array(s * s * 4).fill(128) }
  },
}

describe.skipIf(!hasFields)('the stages on the served export (work/out-opt/world/jangan-fields)', () => {
  let engine: NullEngine
  let world: World

  beforeAll(async () => {
    engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    world = await loadWorld(scene, {
      baseUrl: pathToFileURL(OUT_OPT + '/').href, world: 'jangan-fields', io, minimap: false, objects: false, quality: 'medium',
      stream: 'auto', focus: { x: STAGE_SPOT.x, z: STAGE_SPOT.z }, streamSettings: { ...STAGE_STREAM }, readyRadiusM: STAGE_STREAM.loadRadiusM,
    })
  }, 120_000)

  afterAll(() => {
    world?.dispose()
    engine?.dispose()
  })

  const walkable = (x: number, z: number, y: number) => world.pick({ origin: new Vector3(x, y + 3, z), direction: new Vector3(0, -1, 0) }, 10)

  it('the spot is on the nav within 0.5 m of its yHint, and its seven regions stream at 150 m', () => {
    const p = world.locate(STAGE_SPOT.x, STAGE_SPOT.z, STAGE_SPOT.yHint + 1)
    expect(p).not.toBeNull()
    expect(Math.abs(p!.y - STAGE_SPOT.yHint)).toBeLessThan(0.5)
    expect(world.stream!.stats.wanted).toBe(7)
  })

  for (const n of [1, 2, 3, 4]) {
    it(`select with ${n} character(s): every slot (and each stepped forward) stands on walkable nav near the spot's height`, () => {
      const ground = world.heightAt(STAGE_SPOT.x, STAGE_SPOT.z, STAGE_SPOT.yHint + 1)!
      const pose = stagePose(STAGES.select, { spot: STAGE_SPOT, ground, width: 1920, height: 1080 })
      for (let selected = -1; selected < n; selected++) {
        for (const s of slotPoints(STAGES.select, STAGE_SPOT, n, pose.position, selected)) {
          const y = world.heightAt(s.x, s.z, ground + 1)!
          expect(Math.abs(y - ground), `slot (${s.x}, ${s.z})`).toBeLessThan(0.5)
          const hit = walkable(s.x, s.z, y)
          expect(hit?.walkable, `slot (${s.x}, ${s.z}) walkable`).toBe(true)
        }
      }
    })
  }

  for (const def of [STAGES.select, STAGES.create]) {
    for (const zoom of def.camera.zoom ? [0, 1] : [0]) {
      it(`the ${def.id} camera${zoom ? ' (face zoom)' : ''} is ≥ 0.5 m above the ground with nothing over it, at every aspect`, () => {
        const ground = world.heightAt(STAGE_SPOT.x, STAGE_SPOT.z, STAGE_SPOT.yHint + 1)!
        for (const [label, w, h] of ASPECTS) {
          const p = stagePose(def, { spot: STAGE_SPOT, ground, width: w, height: h, zoom }).position
          // The highest surface at the camera's (x, z): a roof, a floor or the ground. Above it: not in a building.
          const top = world.heightAt(p.x, p.z, Infinity)!
          expect(p.y - top, `${def.id} ${label} (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`).toBeGreaterThanOrEqual(0.5)
        }
      })
    }
  }
})

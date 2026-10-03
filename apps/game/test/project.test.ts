/**
 * three/project.ts toScreen (I9A): world points land where the camera sees them, in CSS pixels. The perf pass passed
 * Viewport.toGlobalToRef's return value (the camera's normalised viewport) to the projection, which put every entity
 * label and damage number at the canvas' top-left corner.
 */
import { FreeCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toScreen } from '../src/three/project.ts'

let engine: NullEngine | null = null
afterEach(() => {
  engine?.dispose()
  engine = null
})

function setup(): Scene {
  engine = new NullEngine({ renderWidth: 1600, renderHeight: 1200, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1 })
  const canvas = { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement
  engine.getRenderingCanvas = () => canvas
  const scene = new Scene(engine)
  const cam = new FreeCamera('cam', new Vector3(0, 0, -10), scene)
  cam.setTarget(Vector3.Zero())
  scene.activeCamera = cam
  cam.getViewMatrix(true)
  scene.updateTransformMatrix(true)
  return scene
}

describe('toScreen', () => {
  it('puts the point the camera looks at in the middle of the canvas, in CSS pixels', () => {
    const scene = setup()
    const p = toScreen(scene, new Vector3(0, 0, 0))
    expect(p.visible).toBe(true)
    expect(p.x).toBeCloseTo(400, 3)
    expect(p.y).toBeCloseTo(300, 3)
  })

  it('a point to the right and above lands right of and above the centre; one behind the camera is hidden', () => {
    const scene = setup()
    const p = toScreen(scene, new Vector3(2, 1, 0))
    expect(p.x).toBeGreaterThan(450)
    expect(p.y).toBeLessThan(270)
    expect(toScreen(scene, new Vector3(0, 0, -20)).visible).toBe(false)
  })

  it('G1 rescue: with a ResizeObserver the canvas size is never read in a frame, only when it changed', () => {
    let callback: (() => void) | null = null
    class FakeElement {}
    class FakeObserver {
      constructor(cb: () => void) {
        callback = cb
      }
      observe() {}
    }
    vi.stubGlobal('Element', FakeElement)
    vi.stubGlobal('ResizeObserver', FakeObserver)
    try {
      engine = new NullEngine({ renderWidth: 1600, renderHeight: 1200, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1 })
      let reads = 0
      let w = 800
      const canvas = Object.create(FakeElement.prototype, {
        clientWidth: { get: () => (reads++, w) },
        clientHeight: { get: () => 600 },
      }) as HTMLCanvasElement
      engine.getRenderingCanvas = () => canvas
      const scene = new Scene(engine)
      const cam = new FreeCamera('cam', new Vector3(0, 0, -10), scene)
      cam.setTarget(Vector3.Zero())
      scene.activeCamera = cam
      cam.getViewMatrix(true)
      scene.updateTransformMatrix(true)
      expect(toScreen(scene, Vector3.Zero()).x).toBeCloseTo(400, 3)
      const after = reads
      for (let f = 0; f < 5; f++) {
        ;(engine as unknown as { _frameId: number })._frameId++
        toScreen(scene, Vector3.Zero())
      }
      expect(reads).toBe(after)
      // The observer reports a resize: the next projection uses the new size.
      w = 1000
      callback!()
      expect(toScreen(scene, Vector3.Zero()).x).toBeCloseTo(500, 3)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

import { Matrix, Vector3, Viewport, type Scene } from '@babylonjs/core'

const tmp = new Vector3()
const view = new Vector3()
const viewport = new Viewport(0, 0, 1, 1)

/** The canvas' CSS size as toScreen uses it. */
interface CssSize {
  w: number
  h: number
  /** The engine frame of the last read (without an observer: read once per frame). */
  frame: number
  /** A ResizeObserver keeps `w` and `h` (no read in the frame at all). */
  observed: boolean
}

/**
 * The canvas' CSS size per canvas. W9A perf pass: read once per frame, since the entity labels write a style between
 * two projections and a read per call forced a style recalculation per label. G1 rescue: not even once per frame where
 * the page has a ResizeObserver, which reports the size after the browser's own layout: the first read of a frame
 * still forced the style recalculation of every label written in the frame before (≈ 1–4 % of a 20-player frame).
 */
const sizes = new WeakMap<object, CssSize>()

function cssSize(canvas: HTMLCanvasElement, frame: number): CssSize {
  let s = sizes.get(canvas)
  if (!s) {
    const size: CssSize = { w: canvas.clientWidth, h: canvas.clientHeight, frame, observed: false }
    s = size
    sizes.set(canvas, size)
    if (typeof ResizeObserver !== 'undefined' && typeof Element !== 'undefined' && canvas instanceof Element) {
      try {
        // In the callback the layout is done: reading the client size there costs nothing extra.
        new ResizeObserver(() => {
          size.w = canvas.clientWidth
          size.h = canvas.clientHeight
        }).observe(canvas)
        size.observed = true
      } catch {
        size.observed = false
      }
    }
  }
  if (!s.observed && s.frame !== frame) {
    s.frame = frame
    s.w = canvas.clientWidth
    s.h = canvas.clientHeight
  }
  return s
}

/** World point -> CSS pixels relative to the canvas; `visible` is false behind the camera or far off screen. */
export function toScreen(scene: Scene, p: Vector3): { x: number; y: number; visible: boolean } {
  const engine = scene.getEngine()
  const cam = scene.activeCamera
  const canvas = engine.getRenderingCanvas()
  if (!cam || !canvas) return { x: 0, y: 0, visible: false }
  const css = cssSize(canvas, engine.frameId)
  // In front of the camera? View space looks down -Z in a right-handed scene, +Z in a left-handed one.
  Vector3.TransformCoordinatesToRef(p, cam.getViewMatrix(), view)
  const inFront = scene.useRightHandedSystem ? view.z < -cam.minZ : view.z > cam.minZ
  const w = engine.getRenderWidth()
  const h = engine.getRenderHeight()
  // toGlobalToRef fills `viewport` but returns the camera's own (normalised) viewport, so pass `viewport` itself (I9A:
  // passing its return value put every label and damage number in the top-left corner).
  cam.viewport.toGlobalToRef(w, h, viewport)
  Vector3.ProjectToRef(p, Matrix.IdentityReadOnly, scene.getTransformMatrix(), viewport, tmp)
  const x = tmp.x * (css.w / w)
  const y = tmp.y * (css.h / h)
  const onScreen = x > -100 && y > -100 && x < css.w + 100 && y < css.h + 100
  return { x, y, visible: inFront && onScreen }
}

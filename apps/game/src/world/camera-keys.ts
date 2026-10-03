/**
 * Camera keys (docs/UX_GAPS.md K6): Left/Right turn the camera at 90°/s, Up/Down zoom, Home puts it behind the
 * character. The speed follows Options → Controls → camera speed; invert Y and the speed also apply to the mouse
 * drag. The arrows are free: the world camera has no keyboard input of its own. MV-WASD: while Options → Controls →
 * Keyboard movement is on (the default) the arrows walk instead (world/features/keymove.ts); the right-drag turns the
 * camera and the wheel zooms it, and Home still puts it behind the character.
 *
 * Camera modes (K7, Options → Controls → Camera): Free (as above), Third person (the camera swings back behind the
 * character, 1.5 s after you last turned it yourself) and Quarter view (fixed 45° pitch from the south-east; only the
 * zoom moves). Shake (F11): a short shake when a critical hit lands on you (Options → Controls → Camera shake).
 * Touch (R7): two fingers turn the camera (move sideways) and zoom (pinch); one finger still taps to move.
 */
import type { ArcRotateCamera, ArcRotateCameraPointersInput } from '@babylonjs/core'
import type { KeyMap } from '../hud/keys.ts'
import { settings, type Settings } from '../settings.ts'

export const TURN_RATE = Math.PI / 2
/** Metres per second at the default zoom (scaled with the distance, so it feels the same near and far). */
export const ZOOM_RATE = 1.2
/** The world screen's mouse sensitivity (screens/world.ts buildWorldScene). */
const BASE_SENSIBILITY = 500

/** Camera alpha that looks along a character's facing (yaw 0 faces glTF +z). */
export function behindAlpha(yaw: number): number {
  return Math.atan2(-Math.cos(yaw), -Math.sin(yaw))
}

/** Quarter view: looking north-west from the south-east (glTF z points south), 45° down. */
export const QUARTER_ALPHA = Math.PI / 4
export const QUARTER_BETA = Math.PI / 4
/** Third person: how fast the camera swings back (1/s, exponential) and how long a manual turn holds it. */
export const FOLLOW_RATE = 3
export const FOLLOW_HOLD_S = 1.5
/** Shake on a critical hit taken: duration (s) and amplitude (screen offset units at the default zoom). */
export const SHAKE_S = 0.28
export const SHAKE_AMP = 0.12

const followHolds = new Set<() => boolean>()

/**
 * MV-WASD: Third person does not swing behind the character while `fn` returns true (walking with the keys: a strafe
 * turns the character, and a camera that followed it would turn the walk into a circle). Returns an unregister function.
 */
export function holdCameraFollow(fn: () => boolean): () => void {
  followHolds.add(fn)
  return () => followHolds.delete(fn)
}

/** True while a registered hold (holdCameraFollow) asks Third person to stay where it is. */
export function cameraFollowHeld(): boolean {
  for (const fn of followHolds) {
    try {
      if (fn()) return true
    } catch {
      // a failing hold never pins the camera
    }
  }
  return false
}

/** Two-finger touch: radians per CSS pixel of sideways movement. */
export const TOUCH_TURN = 0.008

/** Camera change for a two-finger move from (a0, b0) to (a1, b1): turn (radians) and zoom factor (radius multiplier). */
export function twoFingerDelta(a0: { x: number; y: number }, b0: { x: number; y: number }, a1: { x: number; y: number }, b1: { x: number; y: number }): { turn: number; zoom: number } {
  const mid0 = (a0.x + b0.x) / 2
  const mid1 = (a1.x + b1.x) / 2
  const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y)
  const d1 = Math.hypot(a1.x - b1.x, a1.y - b1.y)
  return { turn: -(mid1 - mid0) * TOUCH_TURN, zoom: d0 > 10 && d1 > 10 ? d0 / d1 : 1 }
}

/** Shortest signed angle from `a` to `b` (radians, -π..π). */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

/** Screen offset of the shake at `left` seconds remaining (decays to 0; deterministic wobble). */
export function shakeOffset(left: number, amp = SHAKE_AMP): { x: number; y: number } {
  if (left <= 0) return { x: 0, y: 0 }
  const k = (left / SHAKE_S) * amp
  const t = SHAKE_S - left
  return { x: Math.sin(t * 70) * k, y: Math.cos(t * 55) * k * 0.6 }
}

export class CameraKeys {
  private turn = 0
  private zoom = 0
  /** Third person: seconds the camera stays where the player turned it. */
  private hold = 0
  /** The alpha this class set last frame (a different alpha means the player dragged the camera). */
  private lastAlpha: number | null = null
  private shakeLeft = 0
  private readonly held = new Set<string>()
  private readonly offs: (() => void)[] = []

  constructor(private readonly camera: ArcRotateCamera, keys: KeyMap, private readonly selfYaw: () => number | null) {
    const hold = (id: string, key: string, label: Parameters<KeyMap['register']>[0]['label']) =>
      keys.register({
        id,
        keys: [key],
        label,
        group: 'camera',
        repeat: true,
        // MV-WASD: the arrows walk while keyboard movement is on (world/features/keymove.ts); the mouse turns the camera.
        when: () => !settings.get().controls.keyboardMove,
        run: () => {
          this.held.add(key)
          this.sync()
        },
        up: () => {
          this.held.delete(key)
          this.sync()
        },
      })
    this.offs.push(
      hold('camera.left', 'arrowleft', 'keys.camera.left'),
      hold('camera.right', 'arrowright', 'keys.camera.right'),
      hold('camera.zoomIn', 'arrowup', 'keys.camera.zoomIn'),
      hold('camera.zoomOut', 'arrowdown', 'keys.camera.zoomOut'),
      keys.register({ id: 'camera.reset', keys: ['home'], label: 'keys.camera.reset', group: 'camera', run: () => this.reset() }),
      () => window.removeEventListener('blur', this.onBlur),
      settings.onChange(s => this.applyMouse(s)),
    )
    window.addEventListener('blur', this.onBlur)
    this.applyMouse(settings.get())
    const canvas = camera.getScene().getEngine().getRenderingCanvas()
    if (canvas) {
      const opts = { passive: true }
      canvas.addEventListener('pointerdown', this.onTouch, opts)
      canvas.addEventListener('pointermove', this.onTouch, opts)
      for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) canvas.addEventListener(type, this.onTouchEnd, opts)
      this.offs.push(() => {
        canvas.removeEventListener('pointerdown', this.onTouch)
        canvas.removeEventListener('pointermove', this.onTouch)
        for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) canvas.removeEventListener(type, this.onTouchEnd)
      })
    }
  }

  /** Active touch points (R7), by pointer id. */
  private readonly touches = new Map<number, { x: number; y: number }>()

  private readonly onTouch = (ev: PointerEvent) => {
    if (ev.pointerType !== 'touch') return
    const prev = [...this.touches.entries()]
    this.touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
    if (ev.type !== 'pointermove' || this.touches.size !== 2 || prev.length !== 2) return
    const [a, b] = prev
    const a1 = this.touches.get(a![0])!
    const b1 = this.touches.get(b![0])!
    const d = twoFingerDelta(a![1], b![1], a1, b1)
    const c = this.camera
    const speed = settings.get().controls.cameraSpeed
    if (settings.get().controls.cameraMode !== 'quarter') c.alpha += d.turn * speed
    const lo = c.lowerRadiusLimit ?? 1
    const hi = c.upperRadiusLimit ?? 100
    c.radius = Math.max(lo, Math.min(hi, c.radius * d.zoom))
  }

  private readonly onTouchEnd = (ev: PointerEvent) => {
    if (ev.pointerType === 'touch') this.touches.delete(ev.pointerId)
  }

  private readonly onBlur = () => {
    this.held.clear()
    this.sync()
  }

  private sync(): void {
    this.turn = (this.held.has('arrowleft') ? 1 : 0) - (this.held.has('arrowright') ? 1 : 0)
    this.zoom = (this.held.has('arrowdown') ? 1 : 0) - (this.held.has('arrowup') ? 1 : 0)
  }

  /** Behind the character, at its facing. */
  reset(): void {
    const yaw = this.selfYaw()
    if (yaw !== null) this.camera.alpha = behindAlpha(yaw)
  }

  /** A critical hit landed on us (F11): a short shake, unless switched off. */
  shake(): void {
    if (settings.get().controls.cameraShake) this.shakeLeft = SHAKE_S
  }

  /** Per frame (dt in seconds). */
  update(dt: number): void {
    const c = this.camera
    this.updateShake(dt)
    const mode = settings.get().controls.cameraMode
    if (mode === 'quarter') {
      c.alpha = QUARTER_ALPHA
      c.beta = Math.max(c.lowerBetaLimit ?? 0.1, Math.min(c.upperBetaLimit ?? 1.5, QUARTER_BETA))
      this.lastAlpha = null
    } else if (mode === 'third') {
      if (this.turn || cameraFollowHeld() || (this.lastAlpha !== null && Math.abs(angleDelta(this.lastAlpha, c.alpha)) > 1e-4)) this.hold = FOLLOW_HOLD_S
      else this.hold = Math.max(0, this.hold - dt)
      const yaw = this.selfYaw()
      if (!this.hold && yaw !== null) c.alpha += angleDelta(c.alpha, behindAlpha(yaw)) * Math.min(1, FOLLOW_RATE * dt)
    }
    if (!this.turn && !this.zoom) {
      if (mode === 'third') this.lastAlpha = c.alpha
      return
    }
    const speed = settings.get().controls.cameraSpeed
    if (this.turn && mode !== 'quarter') c.alpha += this.turn * TURN_RATE * speed * dt
    if (this.zoom) {
      const lo = c.lowerRadiusLimit ?? 1
      const hi = c.upperRadiusLimit ?? 100
      c.radius = Math.max(lo, Math.min(hi, c.radius * (1 + this.zoom * ZOOM_RATE * speed * dt)))
    }
    if (mode === 'third') this.lastAlpha = c.alpha
  }

  private updateShake(dt: number): void {
    if (this.shakeLeft <= 0) return
    this.shakeLeft = Math.max(0, this.shakeLeft - dt)
    const o = shakeOffset(this.shakeLeft)
    this.camera.targetScreenOffset.set(o.x, o.y)
  }

  /** Mouse drag: camera speed and invert Y (defaults give the world screen's own 500/500). */
  private applyMouse(s: Settings): void {
    const pointers = this.camera.inputs.attached.pointers as ArcRotateCameraPointersInput | undefined
    if (!pointers) return
    const speed = s.controls.cameraSpeed > 0 ? s.controls.cameraSpeed : 1
    pointers.angularSensibilityX = BASE_SENSIBILITY / speed
    pointers.angularSensibilityY = (s.controls.invertY ? -BASE_SENSIBILITY : BASE_SENSIBILITY) / speed
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off()
    this.held.clear()
    if (this.shakeLeft > 0) this.camera.targetScreenOffset.set(0, 0)
    this.shakeLeft = 0
  }
}

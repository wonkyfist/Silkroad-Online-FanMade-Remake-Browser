import { ArcRotateCamera, UniversalCamera, Vector3, type ArcRotateCameraPointersInput, type Camera, type Scene } from '@babylonjs/core'
import type { World } from '@sro/world-render'

export type CameraMode = 'orbit' | 'fly'

const NEAR = 0.2
const FAR = 3000
const FLY_SPEED = 0.6
const FLY_FAST = 3

/**
 * RTS/MMO-style orbit camera that follows a target (left-drag orbits, wheel zooms, no panning) plus a free-fly camera
 * (F toggles; WASD, Q/E down/up, Shift fast). The orbit camera is kept above the ground.
 */
export class CameraRig {
  readonly orbit: ArcRotateCamera
  readonly fly: UniversalCamera
  mode: CameraMode = 'orbit'

  constructor(readonly scene: Scene, readonly canvas: HTMLCanvasElement, readonly world: World, target: Vector3) {
    // alpha = pi/2 puts the camera on +Z (south) of the target, looking north (-Z).
    const orbit = new ArcRotateCamera('orbit', Math.PI / 2, 1.05, 22, target.clone(), scene)
    orbit.minZ = NEAR
    orbit.maxZ = FAR
    orbit.lowerRadiusLimit = 2.5
    orbit.upperRadiusLimit = 250
    orbit.lowerBetaLimit = 0.1
    orbit.upperBetaLimit = 1.55
    orbit.wheelDeltaPercentage = 0.02
    orbit.panningSensibility = 0
    orbit.angularSensibilityX = 700
    orbit.angularSensibilityY = 700
    // SRO-style: right-drag rotates, left click is click-to-move. Babylon 9's input map binds the
    // right button to "pan" by default, which is a no-op with panning disabled — rebind it.
    const orbitPointers = orbit.inputs.attached.pointers as ArcRotateCameraPointersInput | undefined
    if (orbitPointers) orbitPointers.buttons = [2]
    orbit.movement.input.setInteraction('pointer', { button: 2 }, 'rotate')
    orbit.inertia = 0.6
    this.orbit = orbit

    const fly = new UniversalCamera('fly', target.add(new Vector3(0, 30, 40)), scene)
    fly.minZ = NEAR
    fly.maxZ = FAR
    fly.speed = FLY_SPEED
    fly.angularSensibility = 1500
    fly.inertia = 0.7
    fly.keysUp = [87] // W
    fly.keysDown = [83] // S
    fly.keysLeft = [65] // A
    fly.keysRight = [68] // D
    fly.keysUpward = [69] // E
    fly.keysDownward = [81] // Q
    this.fly = fly

    scene.activeCamera = orbit
    orbit.attachControl(true)
    window.addEventListener('keydown', e => {
      if (e.key === 'Shift') this.setFast(true)
    })
    window.addEventListener('keyup', e => {
      if (e.key === 'Shift') this.setFast(false)
    })
  }

  private setFast(on: boolean): void {
    this.fly.speed = on ? FLY_FAST : FLY_SPEED
  }

  get active(): Camera {
    return this.mode === 'orbit' ? this.orbit : this.fly
  }

  toggle(): void {
    if (this.mode === 'orbit') {
      this.orbit.detachControl()
      this.fly.position.copyFrom(this.orbit.position)
      this.fly.setTarget(this.orbit.target.clone())
      this.scene.activeCamera = this.fly
      this.fly.attachControl(true)
      this.mode = 'fly'
    } else {
      this.fly.detachControl()
      this.scene.activeCamera = this.orbit
      this.orbit.attachControl(true)
      this.mode = 'orbit'
    }
    this.canvas.focus()
  }

  /** Called every frame with the follow point (player position + eye height). */
  update(follow: Vector3): void {
    if (this.mode !== 'orbit') return
    const cam = this.orbit
    cam.target.copyFrom(follow)
    // Keep the orbit camera above the terrain: flatten beta until its eye clears the ground by 0.5 m.
    for (let i = 0; i < 40; i++) {
      const p = cam.target.add(new Vector3(
        cam.radius * Math.cos(cam.alpha) * Math.sin(cam.beta),
        cam.radius * Math.cos(cam.beta),
        cam.radius * Math.sin(cam.alpha) * Math.sin(cam.beta),
      ))
      // The surface nearest the follow point's level (not the eye's): passing under a wall walkway keeps the ground.
      const h = this.world.heightAt(p.x, p.z, cam.target.y)
      if (h === null || p.y >= h + 0.5 || cam.beta <= (cam.lowerBetaLimit ?? 0.1)) break
      cam.beta = Math.max(cam.lowerBetaLimit ?? 0.1, cam.beta - 0.02)
    }
  }
}

/**
 * Simple camera ground collision for the MMO orbit camera: when the eye would sink under the ground (hills behind
 * the player, the plaza stairs), the camera is pulled in along its view line until it clears the surface; the
 * player's own zoom is remembered and restored as soon as there is room. Pitch and yaw are never changed.
 */
import type { ArcRotateCamera } from '@babylonjs/core'
import type { WorldGround } from '../ground.ts'

const CLEARANCE = 0.6
const SHRINK = 0.85
const STEPS = 16

export class CameraGround {
  private desired: number
  private lastSet: number

  constructor(private readonly camera: ArcRotateCamera) {
    this.desired = camera.radius
    this.lastSet = camera.radius
  }

  update(ground: WorldGround): void {
    const cam = this.camera
    // A radius we did not set is the player's zoom (wheel): adopt it.
    if (Math.abs(cam.radius - this.lastSet) > 1e-4) this.desired = cam.radius
    const t = cam.target
    const sb = Math.sin(cam.beta)
    const ux = Math.cos(cam.alpha) * sb
    const uy = Math.cos(cam.beta)
    const uz = Math.sin(cam.alpha) * sb
    const min = cam.lowerRadiusLimit ?? 1
    let r = this.desired
    for (let i = 0; i < STEPS && r > min; i++) {
      const ex = t.x + ux * r
      const ez = t.z + uz * r
      // The surface nearest the target's level, so a wall walkway overhead does not count as ground.
      const h = ground.heightAt(ex, ez, t.y)
      if (t.y + uy * r >= h + CLEARANCE) break
      r = Math.max(min, r * SHRINK)
    }
    cam.radius = r
    this.lastSet = r
  }
}

/**
 * Rendering on demand (docs/WORLD_EDITOR.md §7.1, D47, §F27): the editor draws a frame only when something changed
 * (the camera, an edit, the time of day, streaming or a grass bake in progress) or while the user keeps the
 * animation preview on (water, wind, life). An idle editor costs the GPU nothing. While another owner holds
 * `work/tools/gpu.lock` the animation preview is held off and the page shows a banner, so the editor neither skews a
 * lane's bench nor freezes for the hours an SDXL batch may hold the lock.
 */
export class RenderGate {
  private pending = 0
  /** The user's "Animate water and wind" toggle. */
  animate = false
  /** Another owner holds the GPU lock (the editor API's status). */
  lockedByOther = false
  drawn = 0
  skipped = 0

  /** Something changed: draw the next `frames` frames (2: the change and a settle frame). */
  invalidate(frames = 2): void {
    if (frames > this.pending) this.pending = frames
  }

  /** Whether the animation preview runs now. */
  get animating(): boolean {
    return this.animate && !this.lockedByOther
  }

  /** Called once per tick: true = update the world and draw. `busy`: streaming, a bake, a stroke or a drag. */
  tick(busy: boolean): boolean {
    let draw = busy || this.animating
    if (this.pending > 0) {
      this.pending--
      draw = true
    }
    if (draw) this.drawn++
    else this.skipped++
    return draw
  }
}

/** A cheap view-matrix change test (16 floats, an epsilon for the camera's inertia tail). */
export class ViewWatch {
  private last = new Float32Array(16).fill(NaN)

  changed(m: ArrayLike<number>, eps = 1e-6): boolean {
    let moved = false
    for (let i = 0; i < 16; i++) {
      if (!(Math.abs(m[i]! - this.last[i]!) <= eps)) moved = true
      this.last[i] = m[i]!
    }
    return moved
  }
}

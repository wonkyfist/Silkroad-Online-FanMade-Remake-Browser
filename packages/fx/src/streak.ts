/**
 * A camera-facing glowing strip between two points, drawn without a texture: the centre line carries the colour and
 * both edges fade to alpha 0, so additive blending gives a soft glow. Used where the client data has no effect
 * program of its own: arrow shafts in flight (the arrow is a .bsr model in skilleffect.txt) and imbued weapon glows.
 *
 * Geometry: 6 vertices (tail edge, tail centre, tail edge, head edge, head centre, head edge), 4 triangles, rebuilt
 * on the CPU by `set` like FxInstance's batches. One shared material per scene and blend (see `streakMaterial`).
 */
import { Color3, Constants, Material, Mesh, StandardMaterial, VertexBuffer, type Camera, type Scene } from '@babylonjs/core'
import type { V3 } from './math.ts'

export type Rgba = readonly [number, number, number, number]

const IDX = [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4]

const materials = new WeakMap<Scene, Map<string, StandardMaterial>>()

/** The unlit vertex-colour material of streaks ('add' = SRCALPHA/ONE, 'alpha' = SRCALPHA/INVSRCALPHA), one per scene. */
export function streakMaterial(scene: Scene, blend: 'add' | 'alpha' = 'add'): StandardMaterial {
  let byBlend = materials.get(scene)
  if (!byBlend) materials.set(scene, (byBlend = new Map()))
  let mat = byBlend.get(blend)
  if (!mat) {
    mat = new StandardMaterial(`fx:streak|${blend}`, scene)
    mat.disableLighting = true
    mat.emissiveColor = Color3.White()
    mat.diffuseColor = Color3.Black()
    mat.specularColor = Color3.Black()
    mat.ambientColor = Color3.Black()
    mat.fogEnabled = false
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND
    mat.alphaMode = blend === 'add' ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE
    mat.disableDepthWrite = true
    mat.backFaceCulling = false
    const created = mat
    created.onDisposeObservable.addOnce(() => {
      if (byBlend!.get(blend) === created) byBlend!.delete(blend)
    })
    byBlend.set(blend, mat)
  }
  return mat
}

export class FxStreak {
  readonly mesh: Mesh
  private readonly positions = new Float32Array(18)
  private readonly colors = new Float32Array(24)
  private disposed = false

  constructor(readonly scene: Scene, name = 'fx:streak', blend: 'add' | 'alpha' = 'add') {
    this.mesh = new Mesh(name, scene)
    this.mesh.material = streakMaterial(scene, blend)
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
    this.mesh.hasVertexAlpha = true
    this.mesh.isVisible = false
    this.mesh.setVerticesData(VertexBuffer.PositionKind, this.positions, true, 3)
    this.mesh.setVerticesData(VertexBuffer.ColorKind, this.colors, true, 4)
    this.mesh.setIndices(IDX)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Draws the strip from `tail` to `head`, `width` metres across, facing `camera` (default: the scene's active
   * camera). Colours are per end (alpha included); the edges are transparent.
   */
  set(tail: V3, head: V3, width: number, tailColor: Rgba, headColor: Rgba, camera: Camera | null = this.scene.activeCamera): void {
    if (this.disposed) return
    const axis = normalize([head[0] - tail[0], head[1] - tail[1], head[2] - tail[2]])
    const mid: V3 = [(tail[0] + head[0]) / 2, (tail[1] + head[1]) / 2, (tail[2] + head[2]) / 2]
    let to: V3 = [0, 1, 0]
    if (camera) {
      const e = camera.globalPosition
      to = normalize([e.x - mid[0], e.y - mid[1], e.z - mid[2]])
    }
    let side = cross(to, axis)
    if (Math.hypot(side[0], side[1], side[2]) < 1e-6) side = cross([0, 1, 0], axis)
    if (Math.hypot(side[0], side[1], side[2]) < 1e-6) side = [1, 0, 0]
    side = normalize(side)
    const h = width / 2
    const ends: [V3, Rgba][] = [
      [tail, tailColor],
      [head, headColor],
    ]
    ends.forEach(([p, c], k) => {
      for (let j = 0; j < 3; j++) {
        const o = (k * 3 + j) * 3
        const s = (j - 1) * h
        this.positions[o] = p[0] + side[0] * s
        this.positions[o + 1] = p[1] + side[1] * s
        this.positions[o + 2] = p[2] + side[2] * s
        const ci = (k * 3 + j) * 4
        this.colors[ci] = c[0]
        this.colors[ci + 1] = c[1]
        this.colors[ci + 2] = c[2]
        this.colors[ci + 3] = j === 1 ? c[3] : 0
      }
    })
    this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions)
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, this.colors)
    this.mesh.isVisible = true
  }

  hide(): void {
    if (!this.disposed) this.mesh.isVisible = false
  }

  /** Disposes the mesh (the shared material stays). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mesh.dispose(false, false)
  }
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2])
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0]
}

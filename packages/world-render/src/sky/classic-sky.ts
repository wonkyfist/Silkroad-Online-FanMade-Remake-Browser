import { Color3, CreateSphere, Mesh, StandardMaterial, VertexBuffer, type Scene } from '@babylonjs/core'
import type { EnvValues, RGB } from '../environment.ts'
import { saturate } from '../environment.ts'
import { displayToScene, type SceneDisplay } from '../render/display.ts'

/**
 * The retail sky dome (sky style "classic", docs/SKY.md §4.4): camera-centred, per-vertex colours (docs/TERRAIN.md
 * 5.3, simplified: no sun disc, clouds or stars; kept exactly as before wave 9, the Low guard).
 * Evaluated in SRO units on a virtual dome of radius 20000:
 *   base  = lerp(SkyBottom, SkyTop, clamp(y / 5000 * 0.5 * k, 0, 1)),  k = 1 - clamp(G8, -1, 1)
 *   color = lerp(scatter G4, base, min(1, |vertex - sun| / glowR)),       glowR = max(1, (G7 + 1) / 2 * 80000)
 *   below the horizon: the object fog colour.
 * The sun sits at (cos a, sin a, 0) * 20000 with a = (t - 0.25) * 2 pi (rises in the east, +X in both frames).
 *
 * The colours are display colours. On a PBR preset (SkySystem outputMode 1) the dome draws into the scene-linear HDR
 * target like everything else and the post stack exposes, tone maps and gamma-encodes it, so `update` then writes the
 * scene-linear colour that shows the retail one (render/display.ts; W9 finish D2: the retail dome went through a
 * second curve and read pale). Without `display` (outputMode 0, the Low guard) nothing changes.
 */
export class ClassicSky {
  readonly mesh: Mesh
  private readonly dirs: Float32Array
  private readonly colors: Float32Array
  private readonly px: [number, number, number] = [0, 0, 0]

  constructor(scene: Scene, radiusM: number) {
    const mesh = CreateSphere('sky', { diameter: 2 * radiusM, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene)
    mesh.infiniteDistance = true
    mesh.isPickable = false
    mesh.applyFog = false
    const mat = new StandardMaterial('sky', scene)
    mat.disableLighting = true
    mat.emissiveColor = Color3.White()
    mat.diffuseColor = Color3.Black()
    mat.specularColor = Color3.Black()
    mat.backFaceCulling = false
    mat.fogEnabled = false
    mesh.material = mat
    const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!
    this.dirs = new Float32Array(pos.length)
    for (let i = 0; i < pos.length; i += 3) {
      const l = Math.hypot(pos[i]!, pos[i + 1]!, pos[i + 2]!) || 1
      this.dirs[i] = pos[i]! / l
      this.dirs[i + 1] = pos[i + 1]! / l
      this.dirs[i + 2] = pos[i + 2]! / l
    }
    this.colors = new Float32Array((pos.length / 3) * 4).fill(1)
    mesh.setVerticesData(VertexBuffer.ColorKind, this.colors, true, 4)
    this.mesh = mesh
  }

  update(env: EnvValues, t: number, display: SceneDisplay | null = null): void {
    const R = 20000
    const k = 1 - Math.min(1, Math.max(-1, env.g8))
    const glowR = Math.max(1, ((env.g7 + 1) / 2) * 80000)
    const a = (t - 0.25) * 2 * Math.PI
    const sun: RGB = [Math.cos(a) * R, Math.sin(a) * R, 0]
    const fog = saturate(env.fogColor)
    const d = this.dirs
    const c = this.colors
    for (let i = 0, j = 0; i < d.length; i += 3, j += 4) {
      const x = d[i]! * R
      const y = d[i + 1]! * R
      const z = d[i + 2]! * R
      let rgb: RGB
      if (y < 0) {
        rgb = fog
      } else {
        const f = Math.min(1, Math.max(0, (y / 5000) * 0.5 * k))
        const base: RGB = [
          env.skyBottom[0] + (env.skyTop[0] - env.skyBottom[0]) * f,
          env.skyBottom[1] + (env.skyTop[1] - env.skyBottom[1]) * f,
          env.skyBottom[2] + (env.skyTop[2] - env.skyBottom[2]) * f,
        ]
        const g = Math.min(1, Math.hypot(x - sun[0], y - sun[1], z - sun[2]) / glowR)
        rgb = [
          env.scatter[0] + (base[0] - env.scatter[0]) * g,
          env.scatter[1] + (base[1] - env.scatter[1]) * g,
          env.scatter[2] + (base[2] - env.scatter[2]) * g,
        ]
      }
      c[j] = Math.min(1, Math.max(0, rgb[0]))
      c[j + 1] = Math.min(1, Math.max(0, rgb[1]))
      c[j + 2] = Math.min(1, Math.max(0, rgb[2]))
      c[j + 3] = 1
      if (display) {
        displayToScene(c.subarray(j, j + 3), display, this.px)
        c[j] = this.px[0]; c[j + 1] = this.px[1]; c[j + 2] = this.px[2]
      }
    }
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, c)
  }

  dispose(): void {
    this.mesh.material?.dispose()
    this.mesh.dispose()
  }
}

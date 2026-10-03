/**
 * The ground under the world. Gameplay code only uses the `WorldGround` interface: `heightAt(x, z, yHint)` is the
 * one height query (entities, drops, markers, effects), `pick(ray)` finds the walkable point under the cursor.
 * The real ground is Jangan from @sro/world-render (world/jangan/ground.ts: terrain, plaza, stairs and bridges from
 * the navmeshes); the flat plane with a 2 m grid below is the fallback when the world export is missing.
 */
import { Color3, CreateGround, DynamicTexture, StandardMaterial, Texture, type AbstractMesh, type Mesh, type Ray, type Scene } from '@babylonjs/core'

export interface GroundPick {
  x: number
  y: number
  z: number
  /** false on a closed (unwalkable) cell; a move there still walks toward it until blocked. */
  walkable: boolean
}

export interface WorldGround {
  /**
   * Ground height (metres) at world x/z. Where surfaces overlap (a plaza over sunken terrain, a bridge over a river
   * bed) the one nearest to `yHint` wins; without a hint the highest.
   */
  heightAt(x: number, z: number, yHint?: number): number
  /** True for meshes that count as walkable ground for click-to-move picking. */
  isGround(mesh: AbstractMesh): boolean
  /** The walkable surface under a view ray, or null (then the caller may use isGround meshes). */
  pick?(ray: Ray): GroundPick | null
  /** Keeps the ground around the player (the stub re-centres; terrain streams later). */
  follow(x: number, z: number): void
  dispose(): void
}

const SIZE = 2000
const TILE = 10

/** Flat stub ground at height `y`, centred on (cx, cz). */
export function createFlatGround(scene: Scene, cx: number, y: number, cz: number): WorldGround {
  const mesh = createGridMesh(scene, cx, y, cz)
  return {
    heightAt: () => y,
    isGround: m => m === mesh,
    follow(x, z) {
      if (Math.abs(mesh.position.x - x) < 400 && Math.abs(mesh.position.z - z) < 400) return
      mesh.position.x = Math.round(x / TILE) * TILE
      mesh.position.z = Math.round(z / TILE) * TILE
    },
    dispose() {
      mesh.material?.dispose(true, true)
      mesh.dispose()
    },
  }
}

function createGridMesh(scene: Scene, cx: number, y: number, cz: number): Mesh {
  // Snap the centre to the tile so grid lines sit on world multiples of 2 m / 10 m.
  const x0 = Math.round(cx / TILE) * TILE
  const z0 = Math.round(cz / TILE) * TILE
  const ground = CreateGround('ground', { width: SIZE, height: SIZE, subdivisions: 4 }, scene)
  ground.position.set(x0, y, z0)
  const px = 256
  const tex = new DynamicTexture('gridTex', { width: px, height: px }, scene, true)
  const ctx = tex.getContext() as CanvasRenderingContext2D
  ctx.fillStyle = '#7d8069'
  ctx.fillRect(0, 0, px, px)
  ctx.strokeStyle = 'rgba(40,44,32,0.35)'
  ctx.lineWidth = 2
  for (let i = 0; i < 5; i++) {
    const p = (i * px) / 5
    ctx.beginPath()
    ctx.moveTo(p, 0)
    ctx.lineTo(p, px)
    ctx.moveTo(0, p)
    ctx.lineTo(px, p)
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(30,32,22,0.7)'
  ctx.lineWidth = 4
  ctx.strokeRect(0, 0, px, px)
  tex.update()
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE
  tex.uScale = tex.vScale = SIZE / TILE
  tex.anisotropicFilteringLevel = 8
  const mat = new StandardMaterial('groundMat', scene)
  mat.diffuseTexture = tex
  mat.specularColor = Color3.Black()
  ground.material = mat
  return ground
}

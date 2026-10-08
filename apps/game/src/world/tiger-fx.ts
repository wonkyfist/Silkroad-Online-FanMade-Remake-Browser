/**
 * Tiger Girl's ground effects (world/features/tiger-moves.ts): the roar's shockwave (a pale ring racing out over the
 * ground with a dust skirt) and the pounce's landing (a smaller ring and a ring of dust puffs). Each burst is a few
 * meshes sharing two small textures made once; they expand, fade and are disposed when done. Babylon only.
 */
import { Color3, Constants, CreateGround, CreatePlane, DynamicTexture, Mesh, StandardMaterial, type Scene } from '@babylonjs/core'

interface Burst {
  meshes: Mesh[]
  mats: StandardMaterial[]
  age: number
  life: number
  step(k: number, dt: number): void
}

const ringCanvas = (c: CanvasRenderingContext2D, size: number) => {
  const g = c.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,0)')
  g.addColorStop(0.7, 'rgba(255,255,255,0.08)')
  g.addColorStop(0.9, 'rgba(255,255,255,1)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  c.clearRect(0, 0, size, size)
  c.fillStyle = g
  c.fillRect(0, 0, size, size)
}

const puffCanvas = (c: CanvasRenderingContext2D, size: number) => {
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,0.7)')
  g.addColorStop(0.45, 'rgba(255,255,255,0.3)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  c.clearRect(0, 0, size, size)
  c.fillStyle = g
  c.fillRect(0, 0, size, size)
}

/** Dusty tints: the shockwave's pale ring, the dust's earth. */
const RING_TINT = new Color3(0.95, 0.9, 0.78)
const DUST_TINT = new Color3(0.62, 0.53, 0.4)

export class TigerFx {
  private ringTex: DynamicTexture | null = null
  private puffTex: DynamicTexture | null = null
  private readonly bursts: Burst[] = []

  constructor(private readonly scene: Scene) {}

  private tex(kind: 'ring' | 'puff'): DynamicTexture {
    const have = kind === 'ring' ? this.ringTex : this.puffTex
    if (have) return have
    const size = kind === 'ring' ? 128 : 64
    const t = new DynamicTexture(`tigerFx:${kind}`, { width: size, height: size }, this.scene, true)
    ;(kind === 'ring' ? ringCanvas : puffCanvas)(t.getContext() as CanvasRenderingContext2D, size)
    t.update()
    t.hasAlpha = true
    if (kind === 'ring') this.ringTex = t
    else this.puffTex = t
    return t
  }

  private mat(kind: 'ring' | 'puff', tint: Color3): StandardMaterial {
    const m = new StandardMaterial(`tigerFx:${kind}`, this.scene)
    m.diffuseTexture = this.tex(kind)
    m.useAlphaFromDiffuseTexture = true
    m.emissiveColor = tint
    m.diffuseColor = Color3.Black()
    m.specularColor = Color3.Black()
    m.disableLighting = true
    m.backFaceCulling = false
    m.alphaMode = Constants.ALPHA_COMBINE
    m.disableDepthWrite = true
    m.alpha = 0
    return m
  }

  /** A flat ring at (x, y, z) growing from r0 to r1 metres over `life` seconds, fading out. */
  private ring(x: number, y: number, z: number, r0: number, r1: number, life: number, peakAlpha: number, tint: Color3): Burst {
    const m = this.mat('ring', tint)
    const g = CreateGround('tigerFx:ring', { width: 2, height: 2 }, this.scene)
    g.material = m
    g.position.set(x, y + 0.08, z)
    g.isPickable = false
    return {
      meshes: [g],
      mats: [m],
      age: 0,
      life,
      step(k) {
        const e = 1 - (1 - k) ** 3
        g.scaling.setAll(r0 + (r1 - r0) * e)
        m.alpha = peakAlpha * Math.min(1, k * 8) * (1 - k) ** 1.4
      },
    }
  }

  /** `count` dust puffs in a circle of radius `r` around (x, y, z), billowing out and up while they fade. */
  private dust(x: number, y: number, z: number, count: number, r: number, spread: number, life: number, size: number, peakAlpha: number): Burst {
    const meshes: Mesh[] = []
    const mats: StandardMaterial[] = []
    const dirs: [number, number, number][] = []
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (i % 2) * 0.3
      const m = this.mat('puff', DUST_TINT)
      const p = CreatePlane('tigerFx:puff', { size: 1 }, this.scene)
      p.billboardMode = Mesh.BILLBOARDMODE_ALL
      p.material = m
      p.isPickable = false
      p.position.set(x + Math.sin(a) * r, y + 0.3, z + Math.cos(a) * r)
      meshes.push(p)
      mats.push(m)
      dirs.push([Math.sin(a), 0.35 + (i % 3) * 0.12, Math.cos(a)])
    }
    return {
      meshes,
      mats,
      age: 0,
      life,
      step(k, dt) {
        const slow = (1 - k) ** 2
        for (let i = 0; i < meshes.length; i++) {
          const p = meshes[i]!
          const d = dirs[i]!
          p.position.x += d[0] * spread * slow * dt * 3
          p.position.y += d[1] * spread * slow * dt * 2
          p.position.z += d[2] * spread * slow * dt * 3
          p.scaling.setAll(size * (0.6 + 1.2 * Math.sqrt(k)))
          mats[i]!.alpha = peakAlpha * Math.min(1, k * 10) * (1 - k)
        }
      },
    }
  }

  /** The roar's shockwave at her feet: a fast pale ring to `radiusM`, a slower inner one and a dust skirt. */
  roar(x: number, y: number, z: number, radiusM: number): void {
    this.bursts.push(this.ring(x, y, z, 1.5, radiusM, 0.75, 0.55, RING_TINT))
    this.bursts.push(this.ring(x, y, z, 1, radiusM * 0.6, 1.1, 0.3, DUST_TINT))
    this.bursts.push(this.dust(x, y, z, 16, 2.6, 2.6, 1.6, 1.3, 0.45))
  }

  /** The pounce's touchdown: a small ring and a ring of dust kicked up around the paws. */
  land(x: number, y: number, z: number): void {
    this.bursts.push(this.ring(x, y, z, 0.8, 4.5, 0.5, 0.4, RING_TINT))
    this.bursts.push(this.dust(x, y, z, 12, 1.8, 1.8, 1.2, 1.1, 0.5))
  }

  update(dt: number): void {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i]!
      b.age += dt
      const k = Math.min(1, b.age / b.life)
      b.step(k, dt)
      if (k >= 1) {
        for (const m of b.meshes) m.dispose()
        for (const m of b.mats) m.dispose()
        this.bursts.splice(i, 1)
      }
    }
  }

  dispose(): void {
    for (const b of this.bursts) {
      for (const m of b.meshes) m.dispose()
      for (const m of b.mats) m.dispose()
    }
    this.bursts.length = 0
    this.ringTex?.dispose()
    this.puffTex?.dispose()
    this.ringTex = this.puffTex = null
  }
}

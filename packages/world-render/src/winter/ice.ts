/**
 * Frozen water (docs/WINTER.md §7.5): while the frost is past FROST_ICE every inland water mesh (`water_<x>_<z>` of the
 * WaterRenderer, both paths) wears one ice material, sits 2 cm lower (ICE_LIFT_M: never above a floor that hides it) and
 * draws opaque; the fountain's falling water turns to translucent ice; the pond plants that stand out of the water
 * (lotus flowers and lily pads: region batches keep them in groups of their own, materials.ts batchClass) are hidden
 * (layerMask 0, which no LOD switch touches). The ocean stays liquid.
 *
 * The ice is a PBRMaterial on the PBR path and a StandardMaterial on Classic, both tagged `metadata.snowIce` so the snow
 * plugins draw the cracks and the drifts (the drifts follow the cover). Everything is put back on thaw, on a render-
 * path change (the water rebuilds its meshes) and on dispose; the materials are made on the first freeze and disposed
 * with this. The water list is checked once a second (a streamed region's new water freezes within a second).
 */
import { Color3, PBRMaterial, StandardMaterial, type AbstractMesh, type Material, type Scene } from '@babylonjs/core'
import { POND_PLANT_SOURCES } from '../materials.ts'

/** Pond plants that stand out of the water (hidden while frozen; the converter's LILY_MODELS and the w12 species). */
export const POND_PLANTS = POND_PLANT_SOURCES
/** Falling water (the fountain's fall): translucent ice. */
const FALLS = /waterfall|_wf_/i
/**
 * The ice sits this much below the water plane (m): object floors can lie only centimetres above a water plane they
 * hide (the Jangan plaza paving: 4 cm), so opaque ice must never rise above it (the pond plants are hidden instead).
 */
export const ICE_LIFT_M = -0.02
const SCAN_S = 1

interface Saved {
  material: Material | null
  vertexColors: boolean
  vertexAlpha: boolean
  y: number
  kind: 'water' | 'fall' | 'plant'
  layerMask: number
}

/** What the ice needs of the world (World's water and its object meshes). */
export interface IceHost {
  readonly scene: Scene
  /** The water renderer's meshes (`water_*` planes, `ice_*` retail ice blocks). */
  waterMeshes(): readonly AbstractMesh[]
  /** The world object meshes (falls, pond plants); scanned once a second while frozen. */
  objectMeshes(): Iterable<AbstractMesh>
  /** The PBR path is on (the ice is a PBRMaterial). */
  pbr(): boolean
  /** Whether a mesh draws a pond plant (its material's source model; region batches keep them in groups of their own). */
  pondPlant?(mesh: AbstractMesh): boolean
}

export class WinterIce {
  private readonly saved = new Map<AbstractMesh, Saved>()
  private icePbr: PBRMaterial | null = null
  private iceStd: StandardMaterial | null = null
  private fallPbr: PBRMaterial | null = null
  private fallStd: StandardMaterial | null = null
  private frozen = false
  private path: boolean | null = null
  private scanIn = 0

  constructor(private readonly host: IceHost) {}

  get isFrozen(): boolean {
    return this.frozen
  }

  /** Meshes frozen or hidden now (tests, stats). */
  get count(): number {
    return this.saved.size
  }

  /** Per frame: freeze or thaw. `dt` in s. */
  update(frozen: boolean, dt: number): void {
    const pbr = this.host.pbr()
    if (this.path !== null && this.path !== pbr) this.thaw()
    this.path = pbr
    if (!frozen) {
      if (this.frozen) this.thaw()
      return
    }
    this.frozen = true
    this.scanIn -= dt
    if (this.scanIn > 0) return
    this.scanIn = SCAN_S
    this.scan(pbr)
  }

  private scan(pbr: boolean): void {
    for (const m of this.host.waterMeshes()) {
      if (this.saved.has(m) || m.isDisposed() || !/^water_/.test(m.name)) continue
      this.freezeWater(m, pbr)
    }
    for (const m of this.host.objectMeshes()) {
      if (this.saved.has(m) || m.isDisposed()) continue
      const matName = m.material?.name ?? ''
      if (FALLS.test(m.name) || FALLS.test(matName)) this.freezeFall(m, pbr)
      else if (POND_PLANTS.test(m.name) || POND_PLANTS.test(matName) || this.host.pondPlant?.(m)) this.hidePlant(m)
    }
    // meshes the world disposed meanwhile
    for (const m of [...this.saved.keys()]) if (m.isDisposed()) this.saved.delete(m)
  }

  private keep(m: AbstractMesh, kind: Saved['kind']): void {
    this.saved.set(m, { material: m.material, vertexColors: m.useVertexColors, vertexAlpha: m.hasVertexAlpha, y: m.position.y, kind, layerMask: m.layerMask })
  }

  private freezeWater(m: AbstractMesh, pbr: boolean): void {
    this.keep(m, 'water')
    m.material = pbr ? this.ensurePbr() : this.ensureStd()
    m.useVertexColors = false
    m.hasVertexAlpha = false
    const frozenMatrix = m.isWorldMatrixFrozen
    if (frozenMatrix) m.unfreezeWorldMatrix()
    m.position.y += ICE_LIFT_M
    m.computeWorldMatrix(true)
    if (frozenMatrix) m.freezeWorldMatrix()
  }

  private freezeFall(m: AbstractMesh, pbr: boolean): void {
    this.keep(m, 'fall')
    m.material = pbr ? this.ensureFallPbr() : this.ensureFallStd()
  }

  private hidePlant(m: AbstractMesh): void {
    // no camera draws it (the region batch and the trees part switch their meshes on and off by LOD; never the mask)
    this.keep(m, 'plant')
    m.layerMask = 0
  }

  /** Puts every mesh back. */
  thaw(): void {
    for (const [m, s] of this.saved) {
      if (m.isDisposed()) continue
      if (s.kind === 'plant') {
        m.layerMask = s.layerMask
        continue
      }
      m.material = s.material
      m.useVertexColors = s.vertexColors
      m.hasVertexAlpha = s.vertexAlpha
      if (s.kind === 'water') {
        const frozenMatrix = m.isWorldMatrixFrozen
        if (frozenMatrix) m.unfreezeWorldMatrix()
        m.position.y = s.y
        m.computeWorldMatrix(true)
        if (frozenMatrix) m.freezeWorldMatrix()
      }
    }
    this.saved.clear()
    this.frozen = false
    this.scanIn = 0
  }

  private ensurePbr(): PBRMaterial {
    if (this.icePbr) return this.icePbr
    const m = new PBRMaterial('winterIce', this.host.scene)
    m.metadata = { snowIce: true }
    m.albedoColor = new Color3(0.26, 0.38, 0.47)
    m.metallic = 0
    m.roughness = 0.06
    m.environmentIntensity = 0.9
    return (this.icePbr = m)
  }

  private ensureStd(): StandardMaterial {
    if (this.iceStd) return this.iceStd
    const m = new StandardMaterial('winterIceClassic', this.host.scene)
    m.metadata = { snowIce: true }
    m.diffuseColor = new Color3(0.62, 0.72, 0.8)
    m.specularColor = new Color3(0.35, 0.38, 0.4)
    m.specularPower = 96
    return (this.iceStd = m)
  }

  private ensureFallPbr(): PBRMaterial {
    if (this.fallPbr) return this.fallPbr
    const m = new PBRMaterial('winterIceFall', this.host.scene)
    m.metadata = { snowSkip: true }
    m.albedoColor = new Color3(0.62, 0.74, 0.84)
    m.metallic = 0
    m.roughness = 0.12
    m.alpha = 0.82
    m.backFaceCulling = false
    return (this.fallPbr = m)
  }

  private ensureFallStd(): StandardMaterial {
    if (this.fallStd) return this.fallStd
    const m = new StandardMaterial('winterIceFallClassic', this.host.scene)
    m.metadata = { snowSkip: true }
    m.diffuseColor = new Color3(0.72, 0.82, 0.9)
    m.specularColor = new Color3(0.3, 0.32, 0.34)
    m.alpha = 0.82
    m.backFaceCulling = false
    return (this.fallStd = m)
  }

  dispose(): void {
    this.thaw()
    for (const m of [this.icePbr, this.iceStd, this.fallPbr, this.fallStd]) m?.dispose(false, false)
    this.icePbr = this.iceStd = this.fallPbr = this.fallStd = null
  }
}

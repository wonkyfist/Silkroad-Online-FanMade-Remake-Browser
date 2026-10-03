/**
 * Blob shadows under the characters the crowd budget keeps out of the sun's shadow map (G1 rescue, apps/game
 * world/crowd-budget.ts; Medium: past the nearest few other characters). The town's blobs (town/props.ts TownBlobs) are
 * the model: one soft dark disc per character on one thin-instanced quad multiplying the ground (ALPHA_MULTIPLY), **one
 * draw** for all of them; a disc grows in and shrinks out instead of fading (a multiply cannot fade by alpha).
 *
 * Unlit StandardMaterial, no plugins, depth test without depth write, drawn in the transparent pass after the ground.
 * A warm-up hook compiles it behind the loading picture (no compile when the first blob appears in play). Made on the
 * PBR path only (the Classic path, Low, has no sun shadows to replace: the Low guard).
 */
import { BoundingInfo, Color3, Constants, MeshBuilder, RawTexture, StandardMaterial, Texture, Vector3, type Mesh, type Scene } from '@babylonjs/core'
import { addWarmupHook } from '../warmup-hooks.ts'

/** How much a blob darkens the ground at its middle (0..1; the town's BLOB_DARK, a little lighter than a sun shadow). */
export const CHARACTER_BLOB_DARK = 0.6
/** Blobs at most (the crowd budget's characters past the casters). */
export const CHARACTER_BLOB_CAP = 128
/** The disc sits this far over the feet (m): above the ground's own depth, under the soles. */
const LIFT_M = 0.04

/** The blob's texture (64², no mips): white at the rim, CHARACTER_BLOB_DARK darker in the middle, a smooth falloff. */
function blobTexture(scene: Scene): RawTexture {
  const n = 64
  const data = new Uint8Array(n * n * 4)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = ((x + 0.5) / n) * 2 - 1
      const dy = ((y + 0.5) / n) * 2 - 1
      const t = Math.max(0, Math.min(1, (Math.hypot(dx, dy) - 0.2) / 0.8))
      const f = (1 - t * t * (3 - 2 * t)) ** 1.3
      const v = Math.round(255 * (1 - CHARACTER_BLOB_DARK * f))
      const o = (y * n + x) * 4
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  const tex = RawTexture.CreateRGBATexture(data, n, n, scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE)
  tex.name = 'characterBlobs'
  tex.wrapU = Texture.CLAMP_ADDRESSMODE
  tex.wrapV = Texture.CLAMP_ADDRESSMODE
  return tex
}

/** The blob set (one draw). `begin`, `add` per character, `end` once a frame. */
export class CharacterBlobs {
  readonly mesh: Mesh
  private readonly tex: RawTexture
  private readonly mat: StandardMaterial
  private readonly mats: Float32Array
  private readonly min = new Vector3()
  private readonly max = new Vector3()
  private n = 0
  private warmed = false
  private warmOff: (() => void) | null
  private disposed = false

  constructor(scene: Scene, readonly cap = CHARACTER_BLOB_CAP) {
    const mesh = MeshBuilder.CreateGround('characterBlobs', { width: 1, height: 1 }, scene)
    mesh.isPickable = false
    mesh.doNotSyncBoundingInfo = true
    mesh.alwaysSelectAsActiveMesh = false
    mesh.receiveShadows = false
    mesh.isVisible = false
    mesh.freezeWorldMatrix()
    mesh.metadata = { sroWorld: 'characterBlobs' }
    this.mesh = mesh
    this.tex = blobTexture(scene)
    const mat = new StandardMaterial('characterBlobs', scene)
    mat.diffuseTexture = this.tex
    // unlit: with lighting off the diffuse term is 0, so the emissive white carries the texture (out = tex)
    mat.disableLighting = true
    mat.emissiveColor = Color3.White()
    mat.diffuseColor = Color3.Black()
    mat.specularColor = Color3.Black()
    mat.backFaceCulling = false
    mat.fogEnabled = false
    mat.disableDepthWrite = true
    mat.zOffset = -2
    mat.alphaMode = Constants.ALPHA_MULTIPLY
    // the multiply needs the transparent pass (after the ground it darkens); alpha itself is unused by the blend
    mat.needAlphaBlending = () => true
    this.mat = mat
    mesh.material = mat
    this.mats = new Float32Array(Math.max(1, cap) * 16)
    mesh.thinInstanceSetBuffer('matrix', this.mats, 16, false)
    mesh.thinInstanceCount = 0
    mesh.setBoundingInfo(new BoundingInfo(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)))
    this.warmOff = addWarmupHook(scene, () => this.warm())
  }

  begin(): void {
    this.n = 0
    this.min.set(Infinity, Infinity, Infinity)
    this.max.set(-Infinity, -Infinity, -Infinity)
  }

  /** A blob of `radius` (m) under the feet at (x, y, z). */
  add(x: number, y: number, z: number, radius: number): void {
    if (this.n >= this.cap || !(radius > 0)) return
    const o = this.n * 16
    const s = radius * 2
    const m = this.mats
    m.fill(0, o, o + 16)
    m[o] = s
    m[o + 5] = 1
    m[o + 10] = s
    m[o + 12] = x
    m[o + 13] = y + LIFT_M
    m[o + 14] = z
    m[o + 15] = 1
    if (x - radius < this.min.x) this.min.x = x - radius
    if (y - 0.5 < this.min.y) this.min.y = y - 0.5
    if (z - radius < this.min.z) this.min.z = z - radius
    if (x + radius > this.max.x) this.max.x = x + radius
    if (y + 0.5 > this.max.y) this.max.y = y + 0.5
    if (z + radius > this.max.z) this.max.z = z + radius
    this.n++
  }

  end(): void {
    const m = this.mesh
    if (this.disposed) return
    if (m.thinInstanceCount !== this.n) m.thinInstanceCount = this.n
    const vis = this.n > 0
    if (m.isVisible !== vis) m.isVisible = vis
    if (!vis) return
    m.thinInstanceBufferUpdated('matrix')
    m.getBoundingInfo().reConstruct(this.min, this.max)
  }

  /** Blobs drawn this frame. */
  get count(): number {
    return this.n
  }

  /** The warm-up hook: compiles the blob effect (one hidden instance for the check). */
  private warm(): boolean {
    if (this.disposed || this.warmed) return true
    const had = this.mesh.thinInstanceCount
    if (had === 0) this.mesh.thinInstanceCount = 1
    let ready = false
    try {
      ready = this.mesh.isReady(true)
    } finally {
      if (had === 0) this.mesh.thinInstanceCount = 0
    }
    if (ready) this.warmed = true
    return ready
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.warmOff?.()
    this.warmOff = null
    this.mesh.dispose()
    this.mat.dispose()
    this.tex.dispose()
  }
}

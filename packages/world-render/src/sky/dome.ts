/**
 * The modern dome's mesh and material (docs/SKY.md §4.1): one camera-centred sphere (32 segments, radius 1400 m,
 * infiniteDistance, no fog, not pickable) with the sky-shaders.ts ShaderMaterial, WGSL on WebGPU and GLSL on WebGL2.
 * `needAlphaTesting` puts it in the alpha-test queue, after every opaque mesh, so early-Z rejects the pixels the
 * terrain and buildings already cover (the camera mostly looks down). No depth write, no discard.
 *
 * The tiers are defines (sky-shaders.ts); a quality change rebuilds the material (Options only). Textures the sky has
 * not loaded yet are 1 × 1 fallbacks: black noise (no clouds) and a transparent moon.
 */
import {
  Constants,
  CreateSphere,
  Mesh,
  RawTexture,
  ShaderLanguage,
  ShaderMaterial,
  ShaderStore,
  Vector4,
  type BaseTexture,
  type Scene,
} from '@babylonjs/core'
import {
  SKY_DOME_SAMPLERS,
  SKY_DOME_UNIFORMS,
  SKY_DOME_VEC4,
  skyFragmentGLSL,
  skyFragmentWGSL,
  skyVertexGLSL,
  skyVertexWGSL,
} from './sky-shaders.ts'
import type { SkyQuality } from './types.ts'

let registered = false
function registerShaders(): void {
  if (registered) return
  registered = true
  ShaderStore.ShadersStoreWGSL['sroSkyVertexShader'] = skyVertexWGSL
  ShaderStore.ShadersStoreWGSL['sroSkyFragmentShader'] = skyFragmentWGSL
  ShaderStore.ShadersStore['sroSkyVertexShader'] = skyVertexGLSL
  ShaderStore.ShadersStore['sroSkyFragmentShader'] = skyFragmentGLSL
}

/** The preset's dome defines (sky-shaders.ts tiers). */
export function skyDomeDefines(q: Readonly<SkyQuality>): string[] {
  const d: string[] = []
  if (q.clouds.kind === 'retail') d.push('#define SKY_CLOUDS_RETAIL')
  else d.push('#define SKY_CLOUDS_CUMULUS')
  d.push(`#define SKY_LIGHT_TAPS ${Math.min(3, Math.max(1, q.clouds.lightTaps))}`)
  if (q.clouds.cirrus) d.push('#define SKY_CIRRUS')
  if (q.clouds.detailOctave) d.push('#define SKY_DETAIL')
  if (q.stars.twinkle) d.push('#define SKY_TWINKLE')
  if (q.stars.milkyWay) d.push('#define SKY_MILKYWAY')
  return d
}

export class SkyDome {
  readonly mesh: Mesh
  material: ShaderMaterial
  /** The vec4 uniforms, by name (mutate in place; bound by reference every frame by `bind`). */
  readonly u: Record<string, Vector4> = {}
  private readonly textures = new Map<string, BaseTexture>()
  private readonly fallbacks: BaseTexture[] = []
  private defines: string

  constructor(readonly scene: Scene, radiusM: number, quality: Readonly<SkyQuality>) {
    registerShaders()
    const mesh = CreateSphere('skyModern', { diameter: 2 * radiusM, segments: 32, sideOrientation: Mesh.BACKSIDE }, scene)
    mesh.infiniteDistance = true
    mesh.isPickable = false
    mesh.applyFog = false
    mesh.doNotSyncBoundingInfo = true
    mesh.alwaysSelectAsActiveMesh = true
    this.mesh = mesh
    for (const n of SKY_DOME_VEC4) this.u[n] = new Vector4(0, 0, 0, 0)
    const black = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE)
    black.name = 'skyBlack'
    const clear = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 0]), 1, 1, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE)
    clear.name = 'skyClear'
    this.fallbacks.push(black, clear)
    for (const n of SKY_DOME_SAMPLERS) this.textures.set(n, n === 'moonTex' ? clear : black)
    this.defines = skyDomeDefines(quality).join('\n')
    this.material = this.makeMaterial(quality)
    mesh.material = this.material
  }

  private makeMaterial(q: Readonly<SkyQuality>): ShaderMaterial {
    const mat = new ShaderMaterial('skyModern', this.scene, 'sroSky', {
      attributes: ['position'],
      uniforms: [...SKY_DOME_UNIFORMS],
      samplers: [...SKY_DOME_SAMPLERS],
      defines: skyDomeDefines(q),
      needAlphaTesting: true,
      shaderLanguage: this.scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    })
    mat.backFaceCulling = false
    mat.disableDepthWrite = true
    mat.depthFunction = Constants.LEQUAL
    mat.fogEnabled = false
    for (const [n, v] of Object.entries(this.u)) mat.setVector4(n, v)
    for (const [n, t] of this.textures) mat.setTexture(n, t)
    return mat
  }

  /** Rebuilds the material when the preset's tiers changed. */
  setQuality(q: Readonly<SkyQuality>): void {
    const d = skyDomeDefines(q).join('\n')
    if (d === this.defines) return
    this.defines = d
    const old = this.material
    this.material = this.makeMaterial(q)
    this.mesh.material = this.material
    old.dispose(true, false)
  }

  /** A texture slot (null: back to the fallback). The caller keeps ownership of the texture. */
  setTexture(name: string, tex: BaseTexture | null): void {
    const t = tex ?? (name === 'moonTex' ? this.fallbacks[1]! : this.fallbacks[0]!)
    this.textures.set(name, t)
    this.material.setTexture(name, t)
  }

  setEnabled(on: boolean): void {
    this.mesh.setEnabled(on)
  }

  dispose(): void {
    this.material.dispose(true, false)
    this.mesh.dispose()
    for (const t of this.fallbacks) t.dispose()
  }
}

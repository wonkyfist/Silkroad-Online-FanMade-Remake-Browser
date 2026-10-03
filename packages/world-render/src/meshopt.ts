/**
 * EXT_meshopt_compression for the slimmed asset tree (docs/ASSETS.md 5.1) with the LOCAL decoder: the MIT
 * meshoptimizer decoder module from node_modules (a dependency of packages/convert, resolved by Vite through this
 * relative path), never Babylon's CDN copy. Babylon's MeshoptCompression.Default is replaced by an adapter over the
 * imported module, so no script tag is injected and nothing is downloaded; this also works headless (Node).
 * Registers the glTF 2.0 loader extensions (KHR_mesh_quantization, EXT_meshopt_compression, EXT_texture_webp).
 */
import { MeshoptCompression } from '@babylonjs/core/Meshes/Compression/meshoptCompression.js'
import '@babylonjs/loaders/glTF/2.0/index.js'
// meshoptimizer 1.3 (MIT, Arseny Kapoulkine): ESM build of the decoder (inline WebAssembly, no fetches).
// @ts-expect-error -- the package ships meshopt_decoder.d.ts but no .d.mts for this entry; typed as DecoderLike below.
import { MeshoptDecoder } from '../../convert/node_modules/meshoptimizer/meshopt_decoder.mjs'

interface DecoderLike {
  ready: Promise<void>
  supported: boolean
  decodeGltfBufferAsync?(count: number, stride: number, source: Uint8Array, mode: string, filter?: string): Promise<Uint8Array>
  decodeGltfBuffer(target: Uint8Array, count: number, stride: number, source: Uint8Array, mode: string, filter?: string): void
}

let installed = false

/** Idempotent. Call before the first glb load (loadWorld does). */
export function installMeshoptDecoder(): void {
  if (installed) return
  installed = true
  const decoder = MeshoptDecoder as unknown as DecoderLike
  ;(globalThis as { MeshoptDecoder?: unknown }).MeshoptDecoder ??= decoder
  const adapter = {
    async decodeGltfBufferAsync(source: Uint8Array, count: number, stride: number, mode: string, filter?: string): Promise<Uint8Array> {
      await decoder.ready
      if (!decoder.supported) throw new Error('meshopt decoder: WebAssembly unavailable')
      // Synchronous decode on the calling thread: buffers are small (world models average ~100 KB) and this avoids
      // the decoder's blob: worker (CSP worker-src) entirely.
      const target = new Uint8Array(count * stride)
      decoder.decodeGltfBuffer(target, count, stride, source, mode, filter)
      return target
    },
    dispose() {},
  }
  ;(MeshoptCompression as unknown as { _Default: unknown })._Default = adapter
  // Belt and braces: should anything construct a fresh instance, it must not point at the CDN.
  MeshoptCompression.Configuration = { decoder: { url: 'data:text/javascript,' } }
}

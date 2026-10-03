/**
 * glTF I/O for the download-size optimizer: a NodeIO that knows every extension the optimizer writes
 * (KHR_mesh_quantization, EXT_meshopt_compression, EXT_texture_webp) and has the meshopt codec attached.
 */
import { createHash } from 'node:crypto'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'

let ioPromise: Promise<NodeIO> | null = null

export function gltfIO(): Promise<NodeIO> {
  ioPromise ??= (async () => {
    await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready])
    return new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder })
  })()
  return ioPromise
}

export { MeshoptEncoder }

export function sha1(...parts: (Uint8Array | string)[]): string {
  const h = createHash('sha1')
  for (const p of parts) h.update(p)
  return h.digest('hex')
}

export function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

export const MB = 1024 * 1024
export const fmtMB = (n: number): string => `${(n / MB).toFixed(2)} MB`

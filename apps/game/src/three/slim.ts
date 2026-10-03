/**
 * The slimmed asset tree (work/out-opt served at /out-opt/, docs/ASSETS.md): same relative paths as /out/, mesh
 * glbs without animations (clips live in per-skeleton packs named by the sidecar's `animationPacks`), meshopt +
 * quantization + WebP. Used when /out-opt/slim.json answers; `?slim=0` forces the original /out/ tree.
 * The meshopt decoder is the local node_modules/meshoptimizer module (a dependency of packages/convert, bundled by
 * Vite through this relative path, as @sro/world-render does): Babylon's CDN script is never requested.
 */
import { MeshoptCompression } from '@babylonjs/core'
// meshoptimizer 1.3 (MIT, Arseny Kapoulkine): ESM decoder with inline WebAssembly.
// @ts-expect-error -- the package ships meshopt_decoder.d.ts but no .d.mts for this entry; typed as DecoderLike below.
import { MeshoptDecoder } from '../../../../packages/convert/node_modules/meshoptimizer/meshopt_decoder.mjs'

interface DecoderLike {
  ready: Promise<void>
  supported: boolean
  decodeGltfBuffer(target: Uint8Array, count: number, stride: number, source: Uint8Array, mode: string, filter?: string): void
}

let decoderInstalled = false

/** Replaces Babylon's meshopt decoder (a CDN script by default) with the local module. Idempotent. */
export function installLocalMeshopt(): void {
  if (decoderInstalled) return
  decoderInstalled = true
  const decoder = MeshoptDecoder as unknown as DecoderLike
  ;(globalThis as { MeshoptDecoder?: unknown }).MeshoptDecoder ??= decoder
  const adapter = {
    async decodeGltfBufferAsync(source: Uint8Array, count: number, stride: number, mode: string, filter?: string): Promise<Uint8Array> {
      await decoder.ready
      if (!decoder.supported) throw new Error('meshopt decoder: WebAssembly unavailable')
      const target = new Uint8Array(count * stride)
      decoder.decodeGltfBuffer(target, count, stride, source, mode, filter)
      return target
    },
    dispose() {},
  }
  ;(MeshoptCompression as unknown as { _Default: unknown })._Default = adapter
  MeshoptCompression.Configuration = { decoder: { url: 'data:text/javascript,' } }
}

export const OUT_PREFIX = '/out/'
export const OPT_PREFIX = '/out-opt/'

interface SlimInfo {
  format: 'sro-slim'
  version: number
}

let ready: Promise<boolean> | null = null

function slimDisabled(): boolean {
  try {
    const v = new URLSearchParams(globalThis.location?.search ?? '').get('slim')
    return v === '0' || v === 'false'
  } catch {
    return false
  }
}

/** True once /out-opt/slim.json is readable (and the decoder is configured); cached for the page. */
export function slimAvailable(): Promise<boolean> {
  ready ??= (async () => {
    if (slimDisabled()) return false
    try {
      const res = await fetch(`${OPT_PREFIX}slim.json`, { cache: 'no-cache' })
      if (!res.ok) return false
      const info = (await res.json()) as Partial<SlimInfo>
      if (info.format !== 'sro-slim') return false
      installLocalMeshopt()
      console.info('[models] using the slimmed assets under /out-opt/')
      return true
    } catch {
      return false
    }
  })()
  return ready
}

/** '/out/char/x.glb' -> '/out-opt/char/x.glb'; other URLs -> null. */
export function optUrl(url: string): string | null {
  return url.startsWith(OUT_PREFIX) ? OPT_PREFIX + url.slice(OUT_PREFIX.length) : null
}

/** URL of a path relative to the slim root (pack paths in sidecars). */
export function optPath(rel: string): string {
  return OPT_PREFIX + rel.replace(/^\.?\//, '')
}

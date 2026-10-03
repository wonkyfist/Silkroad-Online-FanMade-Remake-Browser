/** Re-encodes every PNG/JPEG texture of a glTF document to WebP (EXT_texture_webp) through the quality ladder. */
import { EXTTextureWebP } from '@gltf-transform/extensions'
import type { Document } from '@gltf-transform/core'
import { toWebp, type QualityGate, type Rung, type WebpResult } from './texture.ts'

export interface TextureRecord {
  name: string
  width: number
  height: number
  inBytes: number
  outBytes: number
  quality: Rung
  psnr: number
  ssim: number
  alphaPsnr: number
}

export function recordOf(name: string, r: WebpResult): TextureRecord {
  return {
    name,
    width: r.width,
    height: r.height,
    inBytes: r.inBytes,
    outBytes: r.outBytes,
    quality: r.quality,
    psnr: round(r.psnr),
    ssim: Math.round(r.ssim * 1e5) / 1e5,
    alphaPsnr: round(r.alphaPsnr),
  }
}

function round(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : x
}

export async function texturesToWebp(doc: Document, gate?: QualityGate): Promise<TextureRecord[]> {
  const records: TextureRecord[] = []
  let any = false
  for (const tex of doc.getRoot().listTextures()) {
    const img = tex.getImage()
    const mime = tex.getMimeType()
    if (!img || (mime !== 'image/png' && mime !== 'image/jpeg')) continue
    const r = await toWebp(img, { gate })
    tex.setImage(r.webp).setMimeType('image/webp')
    const uri = tex.getURI()
    if (uri) tex.setURI(uri.replace(/\.(png|jpe?g)$/i, '.webp'))
    records.push(recordOf(tex.getName() || tex.getURI() || '(texture)', r))
    any = true
  }
  if (any) doc.createExtension(EXTTextureWebP).setRequired(true)
  return records
}

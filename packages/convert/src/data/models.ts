/** Model and icon references of content records: where today's art lives (presentation only, never an id). */
import type { ModelRef } from '../../../shared/src/content.ts'
import { normalizePk2Path } from '@sro/formats'
import { convertedPaths, resourcePath } from './game-data.ts'

/** Is a URL under /out/ present? (The exporter checks work/out; tests pass a set.) */
export type OutExists = (url: string) => boolean

/** AssocFileObj128 (relative to res/) -> ModelRef, or null when the glb has not been converted. */
export function modelRef(assocFileObj: string | undefined, exists: OutExists): ModelRef | null {
  if (!assocFileObj || !/\.bsr$/i.test(assocFileObj)) return null
  const bsr = resourcePath(assocFileObj)
  const { glb, sidecar } = convertedPaths(bsr)
  return exists(glb) ? { bsr, glb, sidecar } : null
}

/** The res/... path a model needs converted from, or undefined when there is none. */
export function modelSource(assocFileObj: string | undefined): string | undefined {
  return assocFileObj && /\.bsr$/i.test(assocFileObj) ? resourcePath(assocFileObj) : undefined
}

/** AssocFileIcon128 (relative to Media icon/, .ddj) -> the PNG the exporter writes, e.g. /out/icon/item/china/weapon/sword_01.png. */
export function iconUrl(assocFileIcon: string | undefined): string | null {
  if (!assocFileIcon || !/\.ddj$/i.test(assocFileIcon)) return null
  return '/out/icon/' + normalizePk2Path(assocFileIcon).toLowerCase().replace(/\.ddj$/, '.png')
}

/** Media.pk2 path of an icon (icon/<AssocFileIcon128>). */
export function iconSource(assocFileIcon: string): string {
  return 'icon/' + normalizePk2Path(assocFileIcon)
}

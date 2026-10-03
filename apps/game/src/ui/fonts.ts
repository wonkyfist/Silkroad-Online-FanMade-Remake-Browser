/**
 * The client's own fonts, exported by packages/convert/src/tools/export-ui.ts to /out/fonts/ (manifest `fonts`):
 *   english.ttf  Media/fonts/영문서체.ttf ("English font"): Arial Rounded MT Bold. Titles, buttons, captions, wordmark.
 *   basic.ttf    Media/fonts/기본서체.ttf ("basic font"): TaeUtum. Labels and body text.
 *   chat.ttf     Media/fonts/채팅서체.ttf ("chat font"): SeUtum, the light cut of TaeUtum. Chat.
 * They are registered with the FontFace API under the families below; style.css uses them through
 * --font-title / --font-body / --font-chat, whose stacks end in a system serif. A font that fails to load
 * is simply not registered, so the browser falls through to that serif.
 */
import { OUT } from '../content/catalog.ts'
import type { UiManifest } from './art.ts'

export const FONT_FAMILY = {
  english: 'SRO English',
  basic: 'SRO Basic',
  chat: 'SRO Chat',
} as const

export type FontKey = keyof typeof FONT_FAMILY

/** Loads and registers the fonts; resolves (never rejects) with which ones loaded, after at most `timeoutMs`. */
export async function loadFonts(manifest: UiManifest | null, timeoutMs = 4000): Promise<Record<FontKey, boolean>> {
  const result: Record<FontKey, boolean> = { english: false, basic: false, chat: false }
  if (typeof FontFace === 'undefined' || !document.fonts) return result
  const jobs = (Object.keys(FONT_FAMILY) as FontKey[]).map(async key => {
    const file = manifest?.fonts?.[key]?.file ?? `fonts/${key}.ttf`
    // Every weight maps to the one face: the English font is a bold cut, and synthetic bold on top of it smears.
    const face = new FontFace(FONT_FAMILY[key], `url("${OUT}${file}")`, { weight: '100 900', style: 'normal', display: 'swap' })
    try {
      await face.load()
      document.fonts.add(face)
      result[key] = true
    } catch (err) {
      console.warn(`[fonts] ${OUT}${file} failed to load; ${FONT_FAMILY[key]} falls back to a system serif`, err)
    }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(r => (timer = setTimeout(r, timeoutMs)))
  await Promise.race([Promise.all(jobs), timeout])
  clearTimeout(timer)
  const missing = (Object.keys(result) as FontKey[]).filter(k => !result[k])
  document.documentElement.classList.toggle('fonts-fallback', missing.length > 0)
  if (missing.length) console.warn(`[fonts] not loaded (yet): ${missing.join(', ')}`)
  return result
}

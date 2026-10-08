// Licensed characters (docs/CHARACTERS.md §16, §16.8): the River Spirit Waterbender (IdaFaber, Fab Standard License) is
// the standard body of every player: each one is drawn with its look (EntityState.look, packages/shared/src/look.ts:
// the body of its gender, its outfit variant with that outfit's hair), or its body's default when the server sends none.
// `?newchar=0` is the debug escape to the retail models; `ncoutfit=01..04` (girl) / `01..03` (boy) overrides the own
// character's outfit (the look checks). The files are built locally by packages/convert/src/tools/licensed-char.ts into
// work/out(-opt)/char/licensed/ and are never in git or the public release: a server without them plays the existing
// characters (licensedAvailable checks the sidecar first, once per file).
import { LOOK_OUTFITS, defaultLook, type CharLook } from '@sro/shared'
import type { ModelSource } from './models.ts'

export type LicensedGender = 'f' | 'm'
export interface LicensedChoice {
  gender: LicensedGender
  outfit: string
}

export const WATERBENDER_OUTFITS: Record<LicensedGender, readonly string[]> = LOOK_OUTFITS

/**
 * Whether players are drawn on the licensed bodies at all on this page: yes, unless `?newchar=0` (the retail models,
 * the debug escape) or `newchar=average|slim|curvy` (the P1 pilot on the own body, §15).
 */
export function licensedEnabled(search: string): boolean {
  const v = new URLSearchParams(search).get('newchar')
  return v === null || v === '' || v === '1' || v === 'true' || v === 'waterbender'
}

/**
 * The licensed body a player is drawn with: its look's body and outfit (the server's), else the default look of its
 * gender seeded by `seed` (an older server sends none); `self` lets `?ncoutfit=` override the outfit. null when the
 * page asks for the retail models or the gender is unknown.
 */
export function licensedChoiceFor(search: string, gender: 'female' | 'male' | string | undefined, look: CharLook | undefined, seed: number, self = false): LicensedChoice | null {
  if (!licensedEnabled(search)) return null
  const g: LicensedGender | null = gender === 'female' ? 'f' : gender === 'male' ? 'm' : null
  if (!g) return null
  const l = look && look.body === g ? look : defaultLook(g, seed)
  let outfit = WATERBENDER_OUTFITS[g].includes(l.outfit) ? l.outfit : '01'
  const o = self ? (new URLSearchParams(search).get('ncoutfit') ?? '').padStart(2, '0') : ''
  if (o && WATERBENDER_OUTFITS[g].includes(o)) outfit = o
  return { gender: g, outfit }
}

/** The own character's choice under the old flag semantics (tests, the look checks): `?newchar=1` with `ncoutfit`. */
export function licensedChoiceOf(search: string, gender: 'female' | 'male' | string | undefined): LicensedChoice | null {
  const v = new URLSearchParams(search).get('newchar')
  if (v !== '1' && v !== 'true' && v !== 'waterbender') return null
  return licensedChoiceFor(search, gender, undefined, 0, true)
}

export function licensedModel(c: LicensedChoice): Omit<ModelSource, 'code'> {
  // `?ncdir=waterbender_old`: another build of the files beside the served one (the bench's A/B, CHARACTERS §16.9)
  const q = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('ncdir')
  const dir = q && /^waterbender[a-z0-9_-]*$/.test(q) ? q : 'waterbender'
  const base = `/out/char/licensed/${dir}/waterbender_${c.gender}_${c.outfit}`
  return { glb: `${base}.glb`, sidecar: `${base}.json` }
}

/**
 * The head's makeup variant a sidecar offers (`licensed.faces`, CHARACTERS §16.3): `want` when it is one of them, else
 * null (the glb's own, `licensed.face`). The map's URL is next to the glb (`faces/<g>_<v>.jpg`).
 */
export function licensedFaceUrl(glb: string, sidecar: Record<string, unknown> | null | undefined, want: string | null): string | null {
  const lic = sidecar?.licensed as { gender?: string; face?: string; faces?: string[] } | undefined
  if (!want || !lic?.faces?.includes(want) || want === lic.face || !lic.gender) return null
  return `${glb.slice(0, glb.lastIndexOf('/'))}/faces/${lic.gender}_${want}.jpg`
}

/** `?ncface=16_04`: the head's makeup variant asked for (null: the built-in one). */
export function licensedFaceOf(search: string): string | null {
  const v = new URLSearchParams(search).get('ncface')
  return v && /^\d\d(_\d\d)?$/.test(v) ? v : null
}

const checked = new Map<string, Promise<boolean>>()

/**
 * Whether the licensed files are served here (their sidecar loads and carries a retarget spec). Self-hosted servers
 * cloned from GitHub do not have them: false, and the character keeps its existing body. Cached per file.
 */
export function licensedAvailable(c: LicensedChoice, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const url = licensedModel(c).sidecar!
  let p = checked.get(url)
  if (!p) {
    p = (async () => {
      try {
        const res = await fetchFn(url)
        if (!res.ok) return false
        const side = (await res.json()) as { retarget?: { version?: number } }
        return side?.retarget?.version === 1
      } catch {
        return false
      }
    })()
    checked.set(url, p)
  }
  return p
}

/** Test hook: forget the availability checks. */
export function resetLicensedCache(): void {
  checked.clear()
}

/**
 * UI strings and game text.
 * - t(key, vars): UI copy from the English table (en.ts). `{name}` placeholders are replaced from `vars`;
 *   unknown placeholders are left as-is so a missing variable is visible instead of silently empty.
 * - gameText(id, fallback): the client's own English textdata by id (UIO_*, SN_*), exported by
 *   packages/convert to /out/data/strings.json. Used for content (race and weapon names) when present.
 */
import { en, type StringKey } from './en.ts'

export type { StringKey }

/** Same as content/catalog.ts OUT. Not imported from there so that this module has no dependencies. */
const OUT = '/out/'
export type Vars = Record<string, string | number>

const table: Record<StringKey, string> = en

export function t(key: StringKey, vars?: Vars): string {
  const s = table[key] ?? key
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

const gameStrings = new Map<string, string>()

/** Accepts `{ id: text }` or `[{ id | key, text | en | value }]`. Returns the number of strings read. */
export function setGameText(data: unknown): number {
  gameStrings.clear()
  const put = (id: unknown, text: unknown) => {
    if (typeof id === 'string' && typeof text === 'string' && text.trim()) gameStrings.set(id, text.trim())
  }
  if (Array.isArray(data)) {
    for (const e of data) if (e && typeof e === 'object') put((e as Record<string, unknown>).id ?? (e as Record<string, unknown>).key, (e as Record<string, unknown>).text ?? (e as Record<string, unknown>).en ?? (e as Record<string, unknown>).value)
  } else if (data && typeof data === 'object') {
    for (const [id, text] of Object.entries(data as Record<string, unknown>)) put(id, text)
  }
  return gameStrings.size
}

export function gameText(id: string, fallback: string): string {
  return gameStrings.get(id) ?? fallback
}

export async function loadGameText(): Promise<number> {
  try {
    const res = await fetch(`${OUT}data/strings.json`, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return setGameText(await res.json())
  } catch (err) {
    console.warn('[i18n] /out/data/strings.json unavailable; using the built-in English names', err)
    return 0
  }
}

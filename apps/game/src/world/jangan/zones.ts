/**
 * Town or field: the town safe areas from /out/data/towns.json (packages/convert data export: an axis-aligned
 * rectangle in glTF metres per town) decide the music, jangan_town inside, jangan_field outside.
 */
export interface TownArea {
  code: string
  name: string
  x: number
  z: number
  halfX: number
  halfZ: number
}

/** Fallback when towns.json is missing: the Jangan safe area of the current export. */
const JANGAN: TownArea = { code: 'JANGAN', name: 'Jangan', x: 82.727, z: -198.833, halfX: 256.007, halfZ: 178.653 }

export async function loadTownAreas(url = '/out/data/towns.json'): Promise<TownArea[]> {
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { entries?: Array<{ code?: string; name?: string; safeArea?: Partial<TownArea> }> }
    const out: TownArea[] = []
    for (const e of json.entries ?? []) {
      const a = e.safeArea
      if (!a || ![a.x, a.z, a.halfX, a.halfZ].every(v => typeof v === 'number' && Number.isFinite(v))) continue
      out.push({ code: e.code ?? '?', name: e.name ?? e.code ?? '?', x: a.x!, z: a.z!, halfX: a.halfX!, halfZ: a.halfZ! })
    }
    return out.length ? out : [JANGAN]
  } catch (err) {
    console.warn('[world] towns.json unavailable; using the built-in Jangan area', err)
    return [JANGAN]
  }
}

/** The town containing (x, z), with `margin` metres of slack (hysteresis for the caller). */
export function townAt(areas: readonly TownArea[], x: number, z: number, margin = 0): TownArea | null {
  for (const a of areas) {
    if (Math.abs(x - a.x) <= a.halfX + margin && Math.abs(z - a.z) <= a.halfZ + margin) return a
  }
  return null
}

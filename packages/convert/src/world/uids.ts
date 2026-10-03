/**
 * S-UID (docs/WAVE_PLAN8.md §2.5, §4.4; docs/WORLD_EDITOR.md §3.2, D11, F4): the authored-uid registry. A placement is
 * keyed by (owner region, uid); every source that adds placements gets its own uid range, so two sources can never
 * name the same object:
 *
 *   retail    0x0000-0xDFFF   the .o2 placements (the largest uid in jangan-fields is 0xB41D)
 *   editor    0xE000-0xEFFF   the World Editor's adds, per owner region (16-bit: a nav instance id is
 *                             regionId << 16 | uid, packages/nav/src/data.ts)
 *   coast     0xF000-0xFFFF   reserved for coast props (docs/COAST.md §10.3; the coast adds none today)
 *   dressing  1,000,000+      the wave-11 town dressing, by row order (./town/dressing.ts TOWN_UID_BASE; edited by
 *                             row id, never by uid, docs/WORLD_EDITOR.md F4)
 *
 * The ranges are disjoint (tested). An editor add outside the editor's range (a move keeps its key), or on a
 * (region, uid) another source holds, is an error (`UidRegistryError`): the converter's usual "content problems are
 * warnings" rule stops here, because a collision moves or hides the wrong object. The wave-10/11 sources keep their
 * contracts (a colliding coast or dressing add is a warning and skipped, ./passes.ts applyPlacementEdits): their
 * applied adds are only recorded (`note`), so an editor add can never take their keys, and one of them landing in the
 * editor's range is an error.
 *
 * Pure: no node:* import (./passes.ts uses it).
 */

import { WE_EDITOR_UID_MAX, WE_EDITOR_UID_MIN } from '../../../shared/src/world-edits/types.ts'

export type UidSource = 'retail' | 'editor' | 'coast' | 'dressing'

export interface UidRange {
  /** Inclusive. */
  lo: number
  /** Inclusive. */
  hi: number
}

/** The town dressing's first uid (equal to ./town/dressing.ts TOWN_UID_BASE; tested). */
export const DRESSING_UID_BASE = 1_000_000
/** The World Editor's per-region uid range (docs/WORLD_EDITOR.md D11; one source: packages/shared world-edits). */
export const EDITOR_UID_MIN = WE_EDITOR_UID_MIN
export const EDITOR_UID_MAX = WE_EDITOR_UID_MAX

export const UID_RANGES: Readonly<Record<UidSource, UidRange>> = {
  retail: { lo: 0, hi: 0xdfff },
  editor: { lo: EDITOR_UID_MIN, hi: EDITOR_UID_MAX },
  coast: { lo: 0xf000, hi: 0xffff },
  dressing: { lo: DRESSING_UID_BASE, hi: DRESSING_UID_BASE + 999_999 },
}

export class UidRegistryError extends Error {
  constructor(message: string) {
    super(`uid registry: ${message}`)
    this.name = 'UidRegistryError'
  }
}

/** The source whose range holds `uid`, or null. */
export function uidSourceOf(uid: number): UidSource | null {
  for (const [source, r] of Object.entries(UID_RANGES) as Array<[UidSource, UidRange]>) if (uid >= r.lo && uid <= r.hi) return source
  return null
}

export const inUidRange = (source: UidSource, uid: number): boolean =>
  Number.isInteger(uid) && uid >= UID_RANGES[source].lo && uid <= UID_RANGES[source].hi

/** The first free editor uid of a region, given the uids it already holds (null: the range is full). */
export function nextEditorUid(taken: Iterable<number>): number | null {
  const used = new Set(taken)
  for (let uid = EDITOR_UID_MIN; uid <= EDITOR_UID_MAX; uid++) if (!used.has(uid)) return uid
  return null
}

const key = (region: number, uid: number) => `${region}:${uid}`

/**
 * One export's registry: who holds each (region, uid). The pass pipeline (./passes.ts) registers the retail
 * placements, then each authored source's adds before they are applied; a drop releases the key (a move is a drop +
 * an add of the same key by the same source).
 */
export class UidRegistry {
  private readonly owner = new Map<string, UidSource>()

  /**
   * Registers the pipeline's input placements (the objects step's: retail; a tool may feed an exported list, so each
   * is held by the source its uid's range names, retail when none does).
   */
  input(placements: ReadonlyArray<{ region: number; uid: number }>): void {
    for (const p of placements) this.owner.set(key(p.region, p.uid), uidSourceOf(p.uid) ?? 'retail')
  }

  /** Who holds (region, uid), or null. */
  holder(region: number, uid: number): UidSource | null {
    return this.owner.get(key(region, uid)) ?? null
  }

  /**
   * Records the applied adds of a wave-10/11 source (coast, dressing; their collisions were warnings and skipped
   * already). Throws when one lies in the editor's range (it would shadow an editor key).
   */
  note(source: 'coast' | 'dressing', adds: ReadonlyArray<{ region: number; uid: number }>): void {
    for (const a of adds) {
      if (inUidRange('editor', a.uid)) throw new UidRegistryError(`${source} add ${key(a.region, a.uid)} lies in the editor's range`)
      this.owner.set(key(a.region, a.uid), source)
    }
  }

  /** Releases dropped keys (any source may drop any placement; the pipeline checks the refs). */
  release(refs: ReadonlyArray<{ region: number; uid: number }>): void {
    for (const r of refs) this.owner.delete(key(r.region, r.uid))
  }

  /**
   * Claims the adds of an authored source. Throws on a uid outside the source's range or a key another source holds
   * (or the same source twice in one batch). A key the same batch dropped (`moved`: a move is a drop + an add of the
   * same key, docs/WORLD_EDITOR.md F3) keeps its uid whatever its range.
   */
  claim(source: Exclude<UidSource, 'retail'>, adds: ReadonlyArray<{ region: number; uid: number }>,
    moved: ReadonlyArray<{ region: number; uid: number }> = []): void {
    const r = UID_RANGES[source]
    const movedKeys = new Set(moved.map(m => key(m.region, m.uid)))
    const batch = new Set<string>()
    for (const a of adds) {
      const k = key(a.region, a.uid)
      if (!Number.isInteger(a.uid) || (!movedKeys.has(k) && !inUidRange(source, a.uid))) {
        throw new UidRegistryError(`${source} add ${k}: uid outside ${source}'s range ${r.lo}-${r.hi}`)
      }
      const held = this.owner.get(k)
      if (held) throw new UidRegistryError(`${source} add ${k} collides with a placement of the ${held} source`)
      if (batch.has(k)) throw new UidRegistryError(`${source} adds ${k} twice`)
      batch.add(k)
    }
    for (const k of batch) this.owner.set(k, source)
  }
}

/** The registry's own invariant: the ranges never overlap (and the editor's and coast's stay 16-bit). */
export function uidRangeOverlaps(ranges: Readonly<Record<string, UidRange>> = UID_RANGES): string[] {
  const list = Object.entries(ranges)
  const out: string[] = []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, ra] = list[i]!
      const [b, rb] = list[j]!
      if (ra.lo <= rb.hi && rb.lo <= ra.hi) out.push(`${a} and ${b} overlap`)
    }
  }
  return out
}

/**
 * Resolves the .wav paths that BSR sound tracks, effectsound.txt and effectenvsnd.txt name to the files that exist
 * under Data.pk2 prim/snd (docs/SOUND.md §2.1):
 *   1. the exact lower-case path (a stray 'sound\' prefix, and the 'prim\snd\' prefix, are stripped);
 *   2. otherwise a known retail path defect (RETAIL_PATH_FIXES: typos and renamed files, docs/SOUND.md §10.2);
 *   3. otherwise the file with the same basename when exactly one exists (fixes wrong folders such as
 *      prim\snd\swing\swordswing1.wav -> common/swordswing1);
 *   4. otherwise unresolved: recorded with who referenced it, and dropped.
 * Ids are the lower-case path under prim/snd without the extension ('player/mvwalkgrass'). Node-free.
 */

/**
 * Paths the retail data names that do not exist, mapped to the file that does (docs/SOUND.md §10.2). Each fix is
 * used only when its target exists. Typos [confirmed]: itQuckicon (ITEM SND_EQUIP QUICKSLOT), mvfrunground. Renamed
 * or merged files [likely, the same sound under the name the folder has]: the bow skill swing (one file, no _a/_b),
 * Hyungno's zombie set (wchina_jombie_* -> wcm_jombie_*), Hyeongcheon's moan, Yeoha's die/shout, Bunwang's shout,
 * Mangnyang's second moan (effectsound plays moan1 for both NORMAL and CRITYCAL).
 */
export const RETAIL_PATH_FIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^ui\/itquckicon$/, 'ui/itquickicon'],
  [/^player\/mvfrunground$/, 'player/mvrunground'],
  [/^skill\/csk_bow_swing_[ab]$/, 'skill/csk_bow_swing'],
  [/^monster\/wchina_jombie_(\w+)$/, 'monster/wcm_jombie_$1'],
  [/^monster\/wcm_hchen_moan1$/, 'monster/wcm_hchen_moan1_a'],
  [/^monster\/cm_yeoha_(die|shout)_a$/, 'monster/cm_yeoha_$1'],
  [/^monster\/cara_bunwang_shout1$/, 'monster/cara_bunwang_shout'],
  [/^monster\/cm_mang_moan2$/, 'monster/cm_mang_moan1'],
]

export interface Unresolved {
  path: string
  from: string[]
}

/** 'prim\snd\Player\mvRunGround.wav' -> 'player/mvrunground.wav' (relative to prim/snd, lower case). */
export function normalizeSoundPath(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '').toLowerCase()
  if (p.startsWith('sound/')) p = p.slice('sound/'.length)
  if (p.startsWith('prim/snd/')) p = p.slice('prim/snd/'.length)
  if (p.startsWith('sound/')) p = p.slice('sound/'.length)
  return p
}

/** 'player/mvwalkgrass.wav' -> 'player/mvwalkgrass'. */
export const soundId = (rel: string): string => rel.replace(/\.wav$/i, '')

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)

export class SoundResolver {
  /** Known ids. */
  private readonly ids = new Set<string>()
  private readonly byBase = new Map<string, string[]>()
  private readonly misses = new Map<string, Set<string>>()
  /** Paths fixed by the basename fallback: normalized path -> id. */
  readonly fixed = new Map<string, string>()

  /** `files`: every sound file, as paths relative to prim/snd (any case, with extension). */
  constructor(files: Iterable<string>) {
    for (const f of files) {
      const rel = normalizeSoundPath(f)
      if (!rel.endsWith('.wav')) continue
      const id = soundId(rel)
      if (this.ids.has(id)) continue
      this.ids.add(id)
      const b = basename(id)
      const list = this.byBase.get(b)
      if (list) list.push(id)
      else this.byBase.set(b, [id])
    }
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  allIds(): string[] {
    return [...this.ids]
  }

  /** The id a stored path resolves to, or null (recorded as unresolved with `from`). */
  resolve(raw: string, from: string): string | null {
    const rel = normalizeSoundPath(raw)
    if (!rel) return null
    const id = soundId(rel)
    if (this.ids.has(id)) return id
    for (const [re, to] of RETAIL_PATH_FIXES) {
      if (!re.test(id)) continue
      const fix = id.replace(re, to)
      if (!this.ids.has(fix)) break
      this.fixed.set(rel, fix)
      return fix
    }
    const cands = this.byBase.get(basename(id))
    if (cands?.length === 1) {
      this.fixed.set(rel, cands[0]!)
      return cands[0]!
    }
    let set = this.misses.get(rel)
    if (!set) this.misses.set(rel, (set = new Set()))
    set.add(from)
    return null
  }

  /** A bare file name (effectenvsnd) looked up in `folder` first, then by unique basename. */
  resolveIn(folder: string, name: string, from: string): string | null {
    const rel = normalizeSoundPath(name)
    if (!rel.includes('/')) {
      const id = soundId(`${folder.toLowerCase()}/${rel}`)
      if (this.ids.has(id)) return id
    }
    return this.resolve(rel, from)
  }

  unresolved(): Unresolved[] {
    return [...this.misses].map(([path, from]) => ({ path, from: [...from].sort() })).sort((a, b) => a.path.localeCompare(b.path))
  }
}

/**
 * effectsound.txt (docs/SOUND.md §2.2): which .wav a handle plays for an object (UI, ITEM, PLAYER, PCM_/PCF_ voice
 * sets, MOB_<NAME>), optionally per skill group and per event1..3 (weapon kind, surface, NORMAL/CRITYCAL, ...).
 *
 * Columns (tab-separated, the first cell is empty): object, handle, skill_ID, event1, event2, event3, blank, folder,
 * filename, volume, description. `-` = none. Rows starting `//` are comments. Two copies exist: Media.pk2
 * server_dep/silkroad/textdata/effectsound.txt (the later revision, preferred) and resinfo/effectsound.txt; both are
 * CP949 (decode with decodeTextdata first). Node-free.
 */

export interface EffectSoundRow {
  object: string
  handle: string
  /** '' for '-'. */
  skill: string
  event1: string
  event2: string
  event3: string
  blank: number
  /** Folder + filename as stored, '/'-separated ('ui/itSword.wav'); relative to Data.pk2 prim/snd. */
  file: string
  /** 0..200 as stored; null for '-'. */
  volume: number | null
  description: string
  /** Which copy the row came from. */
  source: 'textdata' | 'resinfo'
  /** 1-based line number in that copy. */
  line: number
}

const dash = (v: string | undefined): string => {
  const t = (v ?? '').trim()
  return t === '-' ? '' : t
}

/** Parses one copy of effectsound.txt (already decoded text). Comment rows and rows without a .wav are skipped. */
export function parseEffectSound(text: string, source: EffectSoundRow['source'] = 'textdata'): EffectSoundRow[] {
  const out: EffectSoundRow[] = []
  const lines = text.split(/\r\n|\n|\r/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    if (raw.trimStart().startsWith('//') || raw.trim() === '') continue
    const cells = raw.split('\t')
    if (cells[0]!.trim() === '') cells.shift()
    if (cells.length < 10) continue
    const [object, handle, skill, e1, e2, e3, blank, folder, filename, volume, description] = cells
    const name = (filename ?? '').trim()
    if (!/\.wav$/i.test(name)) continue
    const dir = (folder ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const vol = (volume ?? '').trim()
    out.push({
      object: object!.trim().toUpperCase(),
      handle: handle!.trim().toUpperCase(),
      skill: dash(skill).toUpperCase(),
      event1: dash(e1).toUpperCase(),
      event2: dash(e2).toUpperCase(),
      event3: dash(e3).toUpperCase(),
      blank: Number(dash(blank)) || 0,
      file: dir && dir !== '-' ? `${dir}/${name}` : name,
      volume: vol === '' || vol === '-' || !Number.isFinite(Number(vol)) ? null : Number(vol),
      description: (description ?? '').trim(),
      source,
      line: i + 1,
    })
  }
  return out
}

const rowKey = (r: EffectSoundRow) => [r.object, r.handle, r.skill, r.event1, r.event2, r.event3].join('|')

/**
 * The textdata copy wins per (object, handle, skill, event1..3): every textdata row is kept (duplicates with a
 * different file are alternatives), and a resinfo row is added only when textdata has no row with its key.
 */
export function mergeEffectSound(textdata: readonly EffectSoundRow[], resinfo: readonly EffectSoundRow[]): EffectSoundRow[] {
  const keys = new Set(textdata.map(rowKey))
  return [...textdata, ...resinfo.filter(r => !keys.has(rowKey(r)))]
}

/** Cue gain: volume / 100 clamped to 0..1 (`-` = 1). */
export function rowGain(rows: readonly EffectSoundRow[]): number {
  if (!rows.length) return 1
  const g = Math.max(...rows.map(r => (r.volume === null ? 100 : r.volume))) / 100
  return Math.min(1, Math.max(0, g))
}

export interface RowFilter {
  handle?: string | RegExp
  /** '' = generic rows only; undefined = any. */
  skill?: string
  event1?: string
  event2?: string
  event3?: string
}

/** Rows grouped by object for lookups. */
export class EffectSoundTable {
  readonly byObject = new Map<string, EffectSoundRow[]>()

  constructor(readonly rows: readonly EffectSoundRow[]) {
    for (const r of rows) {
      let list = this.byObject.get(r.object)
      if (!list) this.byObject.set(r.object, (list = []))
      list.push(r)
    }
  }

  objects(): string[] {
    return [...this.byObject.keys()]
  }

  find(object: string, f: RowFilter = {}): EffectSoundRow[] {
    return (this.byObject.get(object.toUpperCase()) ?? []).filter(r => {
      if (f.handle !== undefined) {
        if (typeof f.handle === 'string' ? r.handle !== f.handle.toUpperCase() : !f.handle.test(r.handle)) return false
      }
      if (f.skill !== undefined && r.skill !== f.skill.toUpperCase()) return false
      if (f.event1 !== undefined && r.event1 !== f.event1.toUpperCase()) return false
      if (f.event2 !== undefined && r.event2 !== f.event2.toUpperCase()) return false
      if (f.event3 !== undefined && r.event3 !== f.event3.toUpperCase()) return false
      return true
    })
  }

  /** Skill ids that have rows for this object, in table order. */
  skills(object: string): string[] {
    return [...new Set((this.byObject.get(object.toUpperCase()) ?? []).map(r => r.skill).filter(Boolean))]
  }
}

/** SND_DMG strength/class of a hit row: description (약)/(강), (일반)/(대형)/(갑옷), else the file name hit<1|2><n|b|a>. */
export function parseHitRow(r: Pick<EffectSoundRow, 'description' | 'file'>): { strength: 'weak' | 'strong'; cls: 'n' | 'b' | 'a' } | null {
  const d = r.description
  let strength: 'weak' | 'strong' | null = d.includes('(약)') ? 'weak' : d.includes('(강)') ? 'strong' : null
  let cls: 'n' | 'b' | 'a' | null = d.includes('(일반)') ? 'n' : d.includes('(대형)') ? 'b' : d.includes('(갑옷)') ? 'a' : null
  const m = /hit([12])([nba])\.wav$/i.exec(r.file)
  if (m) {
    strength ??= m[1] === '1' ? 'weak' : 'strong'
    cls ??= m[2]!.toLowerCase() as 'n' | 'b' | 'a'
  }
  return strength && cls ? { strength, cls } : null
}

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildStringMap,
  characterDataRow,
  isPlayerCharacter,
  itemDataRow,
  levelDataRow,
  loadTextdataTable,
  normalizePk2Path,
  parseTextdata,
  skillDataRow,
  TEXT_LANGUAGE_COLUMNS,
  type TextdataFile,
} from '@sro/formats'
import { buildGameData, DATA_FILES, loadGameDataSources, selectCreationCharacters, serializeGameData, type GameDataSources } from '../src/data/game-data.ts'
import { listTextdataFiles, textdataReader, TEXTDATA_DIR } from '../src/data/textdata-source.ts'
import { loadConfig, openArchive, REPO_ROOT } from '../src/node-io.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

/** Files that may fail to parse, with the reason (keys: path relative to the textdata folder, lower case). */
const ENCRYPTED = 'Joymax-encrypted SkillData_*ENC.txt (listed by skilldataenc.txt); its plaintext twin SkillData_*.txt parses'
const PARSE_ALLOWLIST = new Map<string, string>(
  [5000, 10000, 15000, 20000, 25000, 30000, 35000].map(n => [`skilldata_${n}enc.txt`, ENCRYPTED]),
)

const INDEX_FILES = {
  'characterdata.txt': 9,
  'itemdata.txt': 9,
  'skilldata.txt': 7,
  'skilldataenc.txt': 7,
  'textdataname.txt': 3,
  'textquest.txt': 3,
}

const nameOf = (path: string) => normalizePk2Path(path).slice(TEXTDATA_DIR.length + 1)

let corpus: { files: Map<string, TextdataFile>; failures: Map<string, string> } | undefined
function load() {
  if (corpus) return corpus
  const media = openArchive('Media')
  const files = new Map<string, TextdataFile>()
  const failures = new Map<string, string>()
  for (const f of listTextdataFiles(media)) {
    const name = nameOf(f.path)
    try {
      files.set(name, parseTextdata(media.read(f), name))
    } catch (e) {
      failures.set(name, (e as Error).message)
    }
  }
  corpus = { files, failures }
  return corpus
}

let sources: GameDataSources | undefined
const gameSources = () => (sources ??= loadGameDataSources(textdataReader(openArchive('Media'))))
const read = (name: string) => textdataReader(openArchive('Media'))(name)

describe.skipIf(!hasConfig)('textdata corpus (vSRO 1.188 Media.pk2)', () => {
  it('parses every textdata .txt without exceptions (allowlist aside)', () => {
    const { files, failures } = load()
    const encodings = new Map<string, number>()
    let rows = 0
    for (const f of files.values()) {
      encodings.set(f.encoding, (encodings.get(f.encoding) ?? 0) + 1)
      rows += f.rows.length
    }
    console.log(`textdata: ${files.size} parsed (${rows} rows), ${failures.size} failed; encodings`, Object.fromEntries(encodings))
    const unexpected = [...failures].filter(([name]) => !PARSE_ALLOWLIST.has(name))
    expect(unexpected).toEqual([])
    expect(new Set(failures.keys())).toEqual(new Set(PARSE_ALLOWLIST.keys()))
    expect(files.size + failures.size).toBe(155)
    expect(Object.fromEntries(encodings)).toEqual({ 'utf-16le': 143, cp949: 5 })
    expect([...files.values()].filter(f => f.encoding === 'cp949').map(f => f.file).sort()).toEqual([
      'dungeoninfo.txt',
      'effectenvsnd.txt',
      'effectsound.txt',
      'regioncode.txt',
      'regioninfo.txt',
    ])
    // No decoded text may contain U+FFFD or C1 controls (a CP949 mis-decode).
    const bad = [...files.values()].flatMap(f => f.rows.filter(r => /[\u0080-\u009f�]/.test(r.cells.join('\t'))).map(r => `${f.file}:${r.line}`))
    expect(bad.slice(0, 10)).toEqual([])
    // Justify the allowlist: each encrypted file is listed by skilldataenc.txt and has a parsed plaintext twin.
    const encIndex = files.get('skilldataenc.txt')?.index?.map(n => n.toLowerCase())
    for (const name of PARSE_ALLOWLIST.keys()) {
      expect(encIndex).toContain(name)
      expect(files.get(name.replace('enc.txt', '.txt'))?.rows.length).toBeGreaterThan(0)
    }
  })

  it('finds the index files and expands them', () => {
    const { files } = load()
    const indexes = Object.fromEntries([...files.values()].filter(f => f.index).map(f => [f.file, f.index!.length]))
    expect(indexes).toEqual(INDEX_FILES)
    for (const name of Object.keys(INDEX_FILES)) {
      if (name === 'skilldataenc.txt') continue
      const table = loadTextdataTable(name, read)
      const parts = files.get(name)!.index!.map(n => files.get(n.toLowerCase())!.rows.length)
      expect(table.rows.length).toBe(parts.reduce((a, b) => a + b, 0))
    }
  })

  it('reads every characterdata, itemdata, leveldata and skilldata row with the typed helpers', () => {
    const counts: Record<string, number> = {}
    const cells: Record<string, number[]> = {}
    for (const [name, fn] of [
      ['characterdata.txt', characterDataRow],
      ['itemdata.txt', itemDataRow],
      ['leveldata.txt', levelDataRow],
      ['skilldata.txt', skillDataRow],
    ] as const) {
      const rows = loadTextdataTable(name, read).rows
      const parsed = rows.map(r => fn(r))
      counts[name] = parsed.length
      cells[name] = [...new Set(rows.map(r => r.cells.length))].sort((a, b) => a - b)
      if ('id' in parsed[0]!) {
        const ids = parsed.map(p => (p as { id: number }).id)
        expect(new Set(ids).size, `${name}: unique IDs`).toBe(ids.length)
      }
    }
    console.log('typed rows', counts, 'cells per row', cells)
    expect(counts['characterdata.txt']).toBe(13713)
    expect(counts['itemdata.txt']).toBe(11923)
    expect(counts['leveldata.txt']).toBe(140)
    expect(cells['characterdata.txt']).toEqual([104])
    expect(cells['itemdata.txt']).toEqual([160])
    expect(cells['leveldata.txt']).toEqual([9])
    expect(cells['skilldata.txt']).toEqual([118])

    const levels = loadTextdataTable('leveldata.txt', read).rows.map(levelDataRow)
    expect(levels.map(l => l.level)).toEqual(Array.from({ length: 140 }, (_, i) => i + 1))
    expect(levels[0]).toMatchObject({ exp: 118, masterySp: 1 })
    for (let i = 1; i < 90; i++) expect(levels[i]!.exp, `level ${i + 1}`).toBeGreaterThan(levels[i - 1]!.exp)
  })

  it('reads the string tables with the documented language columns', () => {
    for (const name of ['textuisystem.txt', 'textdataname.txt']) {
      const table = loadTextdataTable(name, read)
      expect(table.header?.[1]).toBe('CodeName128')
      expect(table.header?.[TEXT_LANGUAGE_COLUMNS.korean]).toBe('Korean')
      expect(table.header?.[TEXT_LANGUAGE_COLUMNS.english]).toBe('English')
      expect(new Set(table.rows.map(r => r.cells.length))).toEqual(new Set([15]))
    }
    const strings = buildStringMap(loadTextdataTable('textuisystem.txt', read).rows)
    expect(strings.get('UIO_NEWCHAR_STT_TBLADE')).toBe('Glaive')
    expect(buildStringMap(loadTextdataTable('textdataname.txt', read).rows).get('SN_ITEM_CH_SWORD_01_A_DEF')).toBe('Copper Sword')
  })

  it('identifies the 26 Chinese creation choices', () => {
    const src = gameSources()
    const { selected, rejected } = selectCreationCharacters(src.characters, src.strings)
    expect(rejected).toEqual([])
    expect(selected.map(s => s.row.id)).toEqual(Array.from({ length: 26 }, (_, i) => 1907 + i))
    expect(selected.filter(s => s.row.gender === 1)).toHaveLength(13)
    // Every Chinese player row is a choice ...
    const chinesePlayers = src.characters.filter(r => r.service && isPlayerCharacter(r) && r.country === 0)
    expect(chinesePlayers.map(r => r.codeName).sort()).toEqual(selected.map(s => s.row.codeName).sort())
    // ... and every character on the creation screen is one of them (both directions).
    const screenKeys = [...src.strings.keys()].filter(k => /^UIO_NEWCHAR_(MAN|FEMALE)_[A-Z]+$/.test(k))
    expect(screenKeys.sort()).toEqual(selected.map(s => s.nameKey).sort())
    for (const s of selected) expect(src.strings.has(`${s.nameKey}_EXPLANATION`)).toBe(true)
    // res/char/china models that are not choices: berserk hair overlays and the unused spidey model.
    const data = openArchive('Data')
    const models = data.list('res/char/china').map(f => normalizePk2Path(f.path)).filter(p => p.endsWith('.bsr'))
    const chosen = new Set(selected.map(s => 'res/' + normalizePk2Path(s.row.assocFileObj!)))
    expect(models.filter(p => !chosen.has(p)).sort()).toEqual([
      'res/char/china/char_cpd.bsr',
      'res/char/china/chinaman_hwan_hair.bsr',
      'res/char/china/chinaman_spidey.bsr',
      'res/char/china/chinawoman_hwan_hair.bsr',
    ])
    expect(src.characters.some(r => /spidey/i.test(r.assocFileObj ?? ''))).toBe(false)
  })

  it('exports consistent game data (work/out/data)', () => {
    const src = gameSources()
    const { data, rejected } = buildGameData(src)
    expect(rejected).toEqual([])
    const characterCodes = new Set(src.characters.map(r => r.codeName))
    const itemCodes = new Set(src.items.map(r => r.codeName))
    const dataPk2 = openArchive('Data')
    const outRoot = join(loadConfig().workDir, 'out')
    const onDisk = (url: string) => existsSync(join(outRoot, ...url.replace(/^\/out\//, '').split('/')))

    expect(data.characters).toHaveLength(26)
    for (const c of data.characters) {
      expect(characterCodes.has(c.code), c.code).toBe(true)
      expect(c.name && c.description, c.code).toBeTruthy()
      expect(dataPk2.has(c.bsr), c.bsr).toBe(true)
      expect(onDisk(c.glb), `${c.glb} missing: run pnpm tsx packages/convert/src/tools/export-data.ts`).toBe(true)
      expect(onDisk(c.sidecar), c.sidecar).toBe(true)
    }

    expect(data.levels.map(l => l.level)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    for (let i = 1; i < data.levels.length; i++) expect(data.levels[i]!.exp).toBeGreaterThan(data.levels[i - 1]!.exp)
    for (let i = 1; i < data.levels.length; i++) expect(data.levels[i]!.masterySp).toBeGreaterThanOrEqual(data.levels[i - 1]!.masterySp)

    expect(data.weapons.map(w => w.family)).toEqual(['sword', 'blade', 'spear', 'glaive', 'bow'])
    expect(data.weapons.map(w => w.code)).toEqual(['SWORD', 'BLADE', 'SPEAR', 'TBLADE', 'BOW'].map(t => `ITEM_CH_${t}_01_A_DEF`))
    expect(data.weapons.map(w => w.baseCode)).toEqual(['SWORD', 'BLADE', 'SPEAR', 'TBLADE', 'BOW'].map(t => `ITEM_CH_${t}_01_A`))
    expect(data.weapons.map(w => w.twoHanded)).toEqual([false, false, true, true, true])
    expect(data.weapons.map(w => w.ammo ?? null)).toEqual([null, null, null, null, 'ITEM_ETC_AMMO_ARROW_01_DEF'])
    for (const w of data.weapons) {
      for (const code of [w.code, w.baseCode, w.ammo].filter(Boolean)) expect(itemCodes.has(code!), code).toBe(true)
      expect(w).toMatchObject({ degree: 1, reqLevel: 1 })
      expect(w.name && w.familyName, w.code).toBeTruthy()
      expect(dataPk2.has(w.bsr), w.bsr).toBe(true)
      expect(onDisk(w.glb), w.glb).toBe(true)
      expect(onDisk(w.sidecar), w.sidecar).toBe(true)
    }

    // Every string referenced by the entries is in strings.json.
    const used = [...data.characters.flatMap(c => [c.nameKey!, `${c.nameKey}_EXPLANATION`])]
    for (const key of used) expect(data.strings[key], key).toBeTypeOf('string')

    // The files on disk are this build (run export-data.ts after changing the export).
    const dir = join(outRoot, 'data')
    for (const [name, contents] of Object.entries(serializeGameData(data))) {
      const file = join(dir, name)
      expect(existsSync(file), `${file} missing: run pnpm tsx packages/convert/src/tools/export-data.ts`).toBe(true)
      expect(readFileSync(file, 'utf8'), `${file} is stale: rerun export-data.ts`).toBe(contents)
    }
    expect(Object.keys(serializeGameData(data)).sort()).toEqual(Object.values(DATA_FILES).sort())
  })
})

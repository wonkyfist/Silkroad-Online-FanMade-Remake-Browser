import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { eucKr, normalizePk2Path, parseBmt, resolveBmtTexturePath, type BmtFile, type BmtMaterial, type Pk2Archive } from '@sro/formats'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

/** Files that may fail to parse, with the reason. None in vSRO 1.188. */
const PARSE_ALLOWLIST = new Map<string, string>()

/**
 * Diffuse maps that do not resolve with the rule (absolute: Data.pk2 path; relative: BMT folder + name).
 * Key: normalized BMT path + ' -> ' + texture path as stored.
 */
const MISSING_IN_CLIENT = 'texture is not shipped anywhere in Data.pk2'
const UNRESOLVED_ALLOWLIST = new Map<string, string>([
  ...[
    ['prim/mtrl/bldg/china/dunhuang/buildings/w_cd_bone01.bmt', '뼈01.ddj'],
    ['prim/mtrl/bldg/china/dunhuang/buildings/w_cd_bone01.bmt', '뼈02.ddj'],
    ['prim/mtrl/bldg/china/earthghost/earthgst_house.bmt', 'w_earthgst_house_wall.ddj'],
    ['prim/mtrl/bldg/china/earthghost/earthgst_house.bmt', 'w_earthgst_house_etc.ddj'],
    ['prim/mtrl/bldg/china/earthghost/earthgst_house.bmt', 'w_earthgst_house_alpha.ddj'],
    ['prim/mtrl/bldg/oasis/hotang/oas_hot_pool.bmt', 'oas_hot_arm_flowerbed.ddj'],
    ['prim/mtrl/bldg/west asia/rock mt/portal/rock_mt_mteleport.bmt', 'rock_mt_teleport_04.ddj'],
    ['prim/mtrl/dd_center.bmt', '돈황벽 copy.ddj'],
    ['prim/mtrl/dun/asiam/r1_cv/field/pha_altar.bmt', 'pha_gateway02.ddj'],
    ['prim/mtrl/dun/asiam/r1_cv/field/pha_dungate.bmt', 'pha_mazecas_door.ddj'],
    ...[1, 2, 3, 4, 5, 6, 7].map(n => ['prim/mtrl/dun/asiam/r1_cv/field/pha_crypt.bmt', `pha_crypt${n}.ddj`]),
    ...[1, 2, 3, 4, 5, 6].map(n => ['prim/mtrl/dun/asiam/r1_cv/field/pha_remains.bmt', `pha_crypt${n}.ddj`]),
    ['prim/mtrl/dun/asiam/r1_cv/field/pha_remains.bmt', 'pha_gateway02.ddj'],
    ['prim/mtrl/nature/china/dunhuang/tree/w_cd_tree01.bmt', '나무01.ddj'],
    ['prim/mtrl/nature/china/dunhuang/tree/w_cd_tree01.bmt', '나무02.ddj'],
  ].map(([bmt, tex]) => [`${bmt} -> ${tex}`, MISSING_IN_CLIENT] as [string, string]),
  [
    'prim/mtrl/mob/khotan/ong_clon2.bmt -> ong.ddj',
    'BMT copied from prim/mtrl/mob/oasis/ without its texture; ong.ddj only exists there',
  ],
])

/** C0 controls or U+FFFD (a CP949 decode failure). */
const BAD_CHARS = /[\u0000-\u001f\ufffd]/

const DUMP_BSRS = ['res/char/china/chinaman_adventurer.bsr', 'res/item/china/weapon/blade_01.bsr', 'res/mob/china/tiger.bsr']

interface Parsed {
  path: string
  file: BmtFile
}

let corpus: { archive: Pk2Archive; parsed: Parsed[]; failures: Array<[string, string]> } | undefined

function load() {
  if (corpus) return corpus
  const archive = openArchive('Data')
  const parsed: Parsed[] = []
  const failures: Array<[string, string]> = []
  for (const [key, entry] of archive.files) {
    if (!key.endsWith('.bmt')) continue
    try {
      parsed.push({ path: entry.path, file: parseBmt(archive.read(entry)) })
    } catch (e) {
      failures.push([key, (e as Error).message])
    }
  }
  corpus = { archive, parsed, failures }
  return corpus
}

function* materials(): Generator<{ path: string; m: BmtMaterial }> {
  for (const { path, file } of load().parsed) for (const m of file.materials) yield { path, m }
}

const hex = (n: number) => '0x' + n.toString(16).padStart(4, '0')
const inc = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1)
const sortedHist = <K>(m: Map<K, number>) => [...m].sort((a, b) => b[1] - a[1])
const fmtColor = (c: readonly number[]) => c.map(x => x.toFixed(3)).join(' ')

/** Paths of the .bmt files a BSR references: every CP949 lpString ending in ".bmt". */
function bmtRefs(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: string[] = []
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] !== 0x2e || (bytes[i + 1] | 0x20) !== 0x62 || (bytes[i + 2] | 0x20) !== 0x6d || (bytes[i + 3] | 0x20) !== 0x74) continue
    const end = i + 4
    for (let s = i - 1; s >= 4 && end - s <= 260; s--) {
      if (view.getUint32(s - 4, true) === end - s) {
        out.push(eucKr.decode(bytes.subarray(s, end)))
        break
      }
    }
  }
  return out
}

describe.skipIf(!hasConfig)('BMT corpus (vSRO 1.188 Data.pk2)', () => {
  it('parses every .bmt without exceptions (allowlist aside)', () => {
    const { parsed, failures } = load()
    const unexpected = failures.filter(([key]) => !PARSE_ALLOWLIST.has(key))
    const versions = new Map<string, number>()
    let count = 0
    for (const { file } of parsed) {
      inc(versions, file.signature)
      count += file.materials.length
    }
    console.log(`BMT: ${parsed.length} files parsed, ${failures.length} failed, ${count} materials; signatures`, Object.fromEntries(versions))
    if (unexpected.length) console.log('unexpected failures', unexpected.slice(0, 20))
    expect(unexpected).toEqual([])
    expect(parsed.length + failures.length).toBe(3133)
    expect([...versions.keys()]).toEqual(['JMXVBMT 0102'])
  })

  it('holds the layout invariants and reports the flag histogram', () => {
    const flagHist = new Map<number, number>()
    const bitHist = new Map<number, number>()
    const byteHist = new Map<string, number>()
    const floatHist = new Map<number, number>()
    const bad: string[] = []
    let materialCount = 0
    let pathWithoutFlag = 0
    let normalMaps = 0
    let absolutePaths = 0
    for (const { path, file } of load().parsed) {
      if (file.materials.length === 0) bad.push(`${path}: no materials`)
      const names = new Set<string>()
      for (const m of file.materials) {
        materialCount++
        const where = `${path} [${m.name}]`
        const floats = [...m.diffuse, ...m.ambient, ...m.specular, ...m.emissive, m.power]
        if (!floats.every(Number.isFinite)) bad.push(`${where}: non-finite colour/power`)
        // Colours are normalized D3DCOLORVALUEs; the only negatives are float noise of about -2e-9.
        const colours = floats.slice(0, 16)
        if (colours.some(x => x < -1e-6 || x > 1)) bad.push(`${where}: colour out of [0,1]: ${fmtColor(colours)}`)
        // Specular exponent: 0..170 on the 19 materials with flag 0x4; 0 on 98% of the rest, but up to 183.
        if (m.power < 0 || m.power > 255) bad.push(`${where}: power ${m.power} flags ${hex(m.flags)}`)
        // euc-kr TextDecoder is not fatal: an undecodable CP949 byte would silently become U+FFFD.
        if (!m.name || BAD_CHARS.test(m.name)) bad.push(`${where}: bad name ${JSON.stringify(m.name)}`)
        if (BAD_CHARS.test(m.diffuseMap.path)) bad.push(`${where}: bad path ${JSON.stringify(m.diffuseMap.path)}`)
        if (m.unknownFlags !== 0) bad.push(`${where}: unknown flag bits ${hex(m.unknownFlags)}`)
        if (names.has(m.name)) bad.push(`${where}: duplicate material name`)
        names.add(m.name)
        const d = m.diffuseMap
        // Relative texture paths are bare file names; absolute ones carry the Data.pk2 folder.
        if (d.path && d.isAbsolute !== /[\\/]/.test(d.path)) bad.push(`${where}: isAbsolute=${d.isAbsolute} path ${d.path}`)
        if (!d.path && d.isAbsolute) bad.push(`${where}: empty absolute path`)
        if (d.path && !(m.flags & 0x100)) pathWithoutFlag++
        if (d.isAbsolute) absolutePaths++
        // Exporter bytes: 24/0 only without the alpha flag, 32/8 only with it, 0/0 with either.
        const pair = `${d.unknownByte0}/${d.unknownByte1}`
        const alpha = (m.flags & 0x200) !== 0
        if (!(pair === '0/0' || (pair === '24/0' && !alpha) || (pair === '32/8' && alpha))) bad.push(`${where}: unknown bytes ${pair} alpha=${alpha}`)
        if (m.normalMap) normalMaps++
        inc(flagHist, m.flags)
        for (let bit = 0; bit < 32; bit++) if (m.flags & (1 << bit)) inc(bitHist, (1 << bit) >>> 0)
        inc(byteHist, `${d.unknownByte0}/${d.unknownByte1} alpha=${(m.flags & 0x200) !== 0}`)
        inc(floatHist, d.unknownFloat)
      }
    }
    console.log('BMT flag values:', sortedHist(flagHist).map(([k, n]) => `${hex(k)}×${n}`).join(' '))
    console.log('BMT flag bits:', sortedHist(bitHist).map(([k, n]) => `${hex(k)}×${n} (${((100 * n) / materialCount).toFixed(1)}%)`).join(' '))
    console.log('BMT unknownByte0/unknownByte1:', Object.fromEntries(sortedHist(byteHist)))
    console.log('BMT unknownFloat:', Object.fromEntries(floatHist), `| path without flag 0x100: ${pathWithoutFlag} | normal maps: ${normalMaps}`)
    expect(bad.slice(0, 20)).toEqual([])
    expect(materialCount).toBe(12227)
    expect(bitHist.get(0x40)).toBe(materialCount)
    expect([...floatHist.keys()]).toEqual([1])
    expect(normalMaps).toBe(0)
    expect(pathWithoutFlag).toBe(36)
    expect(absolutePaths).toBe(340)
  })

  it('resolves diffuse maps: absolute = Data.pk2 path, relative = BMT folder + file name', () => {
    const { archive } = load()
    let total = 0
    let resolved = 0
    let absolute = 0
    const unresolved: string[] = []
    for (const { path, m } of materials()) {
      if (!m.diffuseMap.path) continue
      total++
      if (m.diffuseMap.isAbsolute) absolute++
      if (archive.has(resolveBmtTexturePath(path, m.diffuseMap))) resolved++
      else unresolved.push(`${normalizePk2Path(path)} -> ${m.diffuseMap.path}`)
    }
    const pct = ((100 * resolved) / total).toFixed(2)
    console.log(`BMT diffuse maps: ${resolved}/${total} resolved (${pct}%), ${absolute} absolute; unresolved:\n  ${unresolved.join('\n  ')}`)
    expect(unresolved.filter(u => !UNRESOLVED_ALLOWLIST.has(u))).toEqual([])
    expect(new Set(unresolved)).toEqual(new Set(UNRESOLVED_ALLOWLIST.keys()))
    expect(resolved / total).toBeGreaterThan(0.997)
  })

  it('dumps the materials of the test assets', () => {
    const { archive } = load()
    const seen: string[] = []
    for (const bsr of DUMP_BSRS) {
      const refs = bmtRefs(archive.read(bsr))
      expect(refs.length).toBeGreaterThan(0)
      const lines = [`== ${bsr}`]
      for (const ref of refs) {
        seen.push(normalizePk2Path(ref))
        const file = parseBmt(archive.read(ref))
        lines.push(`  ${ref} (${file.signature}, ${file.materials.length} materials)`)
        for (const m of file.materials) {
          const d = m.diffuseMap
          const tex = resolveBmtTexturePath(ref, d)
          lines.push(
            `    ${m.name}: flags ${hex(m.flags)} [${m.flagNames.join(', ')}] power ${m.power}`,
            `      diffuse  ${fmtColor(m.diffuse)} | ambient ${fmtColor(m.ambient)}`,
            `      specular ${fmtColor(m.specular)} | emissive ${fmtColor(m.emissive)}`,
            `      map "${d.path}" ${d.isAbsolute ? 'absolute' : 'relative'} -> ${tex} ${archive.has(tex) ? '(found)' : '(MISSING)'}` +
              ` | unk ${d.unknownFloat} ${d.unknownByte0} ${d.unknownByte1}` +
              (m.normalMap ? ` | normal "${m.normalMap.path}" ${m.normalMap.unknown}` : ''),
          )
          expect(archive.has(tex)).toBe(true)
        }
      }
      console.log(lines.join('\n'))
    }
    expect(seen).toEqual([
      'prim/mtrl/char/china/man/chinaman_adventurer.bmt',
      'prim/mtrl/item/china/weapon/blade1_5.bmt',
      'prim/mtrl/mob/china/tiger.bmt',
      'prim/mtrl/mob/china/tiger_champ.bmt',
    ])
  })
})

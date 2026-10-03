/**
 * Exports the item and skill icons, and the in-game HUD interface textures, the browser game client uses.
 *   pnpm tsx packages/convert/src/tools/export-icons.ts [--force] [--no-ui] [--no-icons]
 *
 * Icons (Media.pk2 icon/...ddj -> work/out/icons/<path under icon/>.png, index work/out/icons/index.json):
 * - items: every entry of work/out/data/items.json (ItemDef, packages/shared/src/content.ts) with an `icon`.
 *   `icon` is the URL the data exporter chose (e.g. /out/icon/item/china/weapon/sword_01_a.png) or the raw
 *   AssocFileIcon128 (item\china\weapon\sword_01_a.ddj); both name the same DDJ under Media.pk2 icon/.
 *   When items.json does not exist yet, the client's own itemdata (col 54, AssocFileIcon128) is read instead,
 *   limited to what a level 1-20 Chinese character can meet: ITEM_CH_* and ITEM_ETC_* rows of degree 0-3.
 * - quest items: every ITEM_QNO_* row of the client's itemdata (not in items.json), whose icons our quest items borrow.
 * - skills: every entry of work/out/data/skills.json (SkillDef) with an `icon`; skipped while it is missing.
 * - index.json: { items: { CODE: 'icons/...png' }, skills: { CODE: 'icons/...png' } }, paths relative to
 *   work/out (served at /out/). The game client prefers this index over ItemDef.icon.
 *
 * HUD interface textures (Media.pk2 interface/... -> work/out/ui/<folder>/<name>.png, manifest work/out/ui/hud.json):
 * the textless frames, gauges and slot art of the target window, inventory, equipment, character (stats) window,
 * tooltip and message-box frames. Same entry shape as work/out/ui/index.json (export-ui.ts); the game's Art loader
 * merges hud.json into its manifest. `bakedText` lists exported images with text in them, which the client
 * never shows (it draws all text live, in English).
 *
 * Nothing is written outside work/out; the game client never bundles this data.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decodeDds, itemDataRow, loadTextdataTable, normalizePk2Path, parseDdj, type Pk2Archive } from '@sro/formats'
import { loadConfig, openArchive } from '../node-io.ts'
import { encodePng } from '../png.ts'

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const doUi = !argv.includes('--no-ui')
const doIcons = !argv.includes('--no-icons')
const cfg = loadConfig()
const outDir = join(cfg.workDir, 'out')
const dataDir = join(outDir, 'data')
const TEXTDATA_DIR = 'server_dep/silkroad/textdata'

/** HUD textures: folder inside Media.pk2 and which of its DDJs to export. */
const HUD_SELECTION: { folder: string; include: RegExp; exclude?: RegExp }[] = [
  { folder: 'interface/targetwindow', include: /\.ddj$/ },
  { folder: 'interface/inventory', include: /\.ddj$/ },
  { folder: 'interface/equipment', include: /\.ddj$/ },
  { folder: 'interface/character', include: /^(chr_|char_ch_)/ },
  { folder: 'interface/frame', include: /^(frame_tooltip|frameg_wnd|frameg01_wnd|frame_sub|game_window)_/ },
  { folder: 'interface/messagebox', include: /^(msgbox_window|msgbox2_window|msgbox_rebirth|msgbox_gold_icon|msgbox_quantity|msgbox_blackbox)/ },
  { folder: 'interface/playerminiinfo', include: /\.ddj$/ },
  { folder: 'interface/ifcommon', include: /^com_(moneybutton|plus_button|minus_button|pt_leader|gold)/ },
  { folder: 'interface/mainpopup', include: /^main_sysbutton_/ },
  // UX-B: minimap frame, zoom and map buttons, marker signs; world map buttons and icons (the client has a stray
  // 'wmap_button_automatic .ddj' with a space in its name).
  { folder: 'interface/minimap', include: /^mm_/ },
  { folder: 'interface/worldmap', include: /^wmap_(button|direction|icon|monster_icon|name)/, exclude: /\s/ },
]

/**
 * HUD images with text baked in (audited by eye on the exported PNGs). The client never shows these.
 * Everything else exported here is frames, gauges, slot silhouettes and icons without letters.
 */
const HUD_BAKED_TEXT: Record<string, string> = {
  'character/chr_window': 'Korean labels (EXP investment line, job levels, wanted rank, remaining time)',
}

interface ImageEntry {
  file: string
  src: string
  width: number
  height: number
  format: string
  content: [number, number, number, number]
}

function contentBox(w: number, h: number, rgba: Uint8Array): [number, number, number, number] {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3]! > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? [0, 0, 0, 0] : [x0, y0, x1 - x0 + 1, y1 - y0 + 1]
}

/** Decodes one DDJ to `dst` (skipped when it exists, unless --force). Returns its size and format. */
function ddjToPng(media: Pk2Archive, src: string, dst: string): { width: number; height: number; format: string; content: [number, number, number, number] } {
  const img = decodeDds(parseDdj(media.read(src)).dds)
  if (force || !existsSync(dst) || statSync(dst).size === 0) {
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, encodePng(img.width, img.height, img.rgba))
  }
  return { width: img.width, height: img.height, format: img.format, content: contentBox(img.width, img.height, img.rgba) }
}

// ---- HUD textures ---------------------------------------------------------------------------------

function exportHud(media: Pk2Archive): void {
  const images: Record<string, ImageEntry> = {}
  const failures: string[] = []
  const sources: string[] = []
  for (const sel of HUD_SELECTION) {
    for (const f of media.list(sel.folder)) {
      const name = f.path.split('/').pop()!.toLowerCase()
      if (!name.endsWith('.ddj') || !sel.include.test(name) || sel.exclude?.test(name)) continue
      sources.push(`${sel.folder}/${name}`)
    }
  }
  for (const src of sources.sort()) {
    const key = src.replace(/^interface\//, '').replace(/\.ddj$/i, '')
    const file = `ui/${key}.png`
    try {
      images[key] = { file, src, ...ddjToPng(media, src, join(outDir, file)) }
    } catch (err) {
      failures.push(`${src}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const manifest = {
    version: 1,
    generator: 'packages/convert/src/tools/export-icons.ts',
    generatedAt: new Date().toISOString(),
    images,
    bakedText: Object.fromEntries(Object.entries(HUD_BAKED_TEXT).filter(([k]) => images[k])),
    failures,
  }
  mkdirSync(join(outDir, 'ui'), { recursive: true })
  writeFileSync(join(outDir, 'ui', 'hud.json'), JSON.stringify(manifest, null, 2))
  console.log(`hud: ${Object.keys(images).length} images -> ${join(outDir, 'ui', 'hud.json')}`)
  for (const f of failures) console.warn(`  ! ${f}`)
}

// ---- icons ----------------------------------------------------------------------------------------

/** Entries of a content file (ContentFile wrapper or bare array); null when the file is missing or unreadable. */
function readEntries(name: string): Record<string, unknown>[] | null {
  const path = join(dataDir, name)
  if (!existsSync(path)) return null
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const entries = Array.isArray(json) ? json : (json as { entries?: unknown }).entries
    if (!Array.isArray(entries)) throw new Error('no entries')
    return entries.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
  } catch (err) {
    console.warn(`  ! ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * The icon's path under Media.pk2 icon/, lower-case with forward slashes and no extension, from an icon URL
 * (/out/icon/item/x.png, /out/icons/item/x.png), a Data-relative path (icon\item\x.ddj) or a raw
 * AssocFileIcon128 (item\x.ddj). Null for empty values.
 */
function iconRel(value: string): string | null {
  let p = normalizePk2Path(value.trim().replace(/^\/?out\//i, ''))
  if (!p) return null
  p = p.replace(/^(icons?)\//, '').replace(/\.(ddj|png|dds)$/, '')
  return p || null
}

function iconSource(e: Record<string, unknown>): string | null {
  for (const k of ['iconDdj', 'iconSource', 'icon']) {
    const v = e[k]
    if (typeof v === 'string' && v.trim()) return iconRel(v)
  }
  return null
}

/**
 * The client's quest items (ITEM_QNO_*): items.json leaves them out, but our quest items borrow their icons
 * (QuestItemDef.iconItem, docs/QUESTS.md §1.2), so they are always indexed by code from the client's itemdata.
 */
const QUEST_ITEM_ICONS = /^ITEM_QNO_/

/**
 * Fallback while items.json is missing: the client's itemdata, as far as a level 1-20 Chinese character goes.
 * With `only`: every serviced item whose code matches it instead (the quest item icons).
 */
function itemIconsFromTextdata(media: Pk2Archive, only?: RegExp): Map<string, string> {
  const read = (name: string) => {
    const file = media.get(`${TEXTDATA_DIR}/${name}`)
    return file ? media.read(file) : undefined
  }
  const out = new Map<string, string>()
  for (const row of loadTextdataTable('itemdata.txt', read).rows) {
    let item
    try {
      item = itemDataRow(row)
    } catch {
      continue
    }
    if (!item.service || item.typeId[0] !== 3 || !item.assocFileIcon) continue
    if (only && !only.test(item.codeName)) continue
    if (!only && (!/^ITEM_(CH|ETC)_/.test(item.codeName) || item.degree > 3)) continue
    if (!only && item.country !== 0 && item.country !== 3) continue
    const rel = iconRel(item.assocFileIcon)
    if (rel) out.set(item.codeName, rel)
  }
  return out
}

function exportIcons(media: Pk2Archive): void {
  const failures: string[] = []
  const sources: Record<string, string> = {}
  const byKind: Record<'items' | 'skills', Map<string, string>> = { items: new Map(), skills: new Map() }

  const items = readEntries('items.json')
  if (items) {
    sources.items = 'data/items.json'
    for (const e of items) {
      const rel = iconSource(e)
      if (typeof e.code === 'string' && rel) byKind.items.set(e.code, rel)
    }
  } else {
    sources.items = `Media.pk2 ${TEXTDATA_DIR}/itemdata.txt (items.json missing)`
    try {
      byKind.items = itemIconsFromTextdata(media)
    } catch (err) {
      failures.push(`itemdata: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try {
    for (const [code, rel] of itemIconsFromTextdata(media, QUEST_ITEM_ICONS)) if (!byKind.items.has(code)) byKind.items.set(code, rel)
    sources.items += ` + ${TEXTDATA_DIR}/itemdata.txt (ITEM_QNO_* quest items)`
  } catch (err) {
    failures.push(`itemdata (quest items): ${err instanceof Error ? err.message : String(err)}`)
  }
  const skills = readEntries('skills.json')
  if (skills) {
    sources.skills = 'data/skills.json'
    for (const e of skills) {
      const rel = iconSource(e)
      if (typeof e.code === 'string' && rel) byKind.skills.set(e.code, rel)
    }
  } else sources.skills = 'none (skills.json missing)'

  const written = new Map<string, boolean>()
  const index: Record<'items' | 'skills', Record<string, string>> = { items: {}, skills: {} }
  for (const kind of ['items', 'skills'] as const) {
    for (const [code, rel] of [...byKind[kind]].sort((a, b) => a[0].localeCompare(b[0]))) {
      const file = `icons/${rel}.png`
      let ok = written.get(rel)
      if (ok === undefined) {
        const src = `icon/${rel}.ddj`
        try {
          if (!media.has(src)) throw new Error('not in Media.pk2')
          ddjToPng(media, src, join(outDir, file))
          ok = true
        } catch (err) {
          failures.push(`${code}: ${src}: ${err instanceof Error ? err.message : String(err)}`)
          ok = false
        }
        written.set(rel, ok)
      }
      if (ok) index[kind][code] = file
    }
  }
  const manifest = {
    version: 1,
    generator: 'packages/convert/src/tools/export-icons.ts',
    generatedAt: new Date().toISOString(),
    sources,
    items: index.items,
    skills: index.skills,
    failures,
  }
  mkdirSync(join(outDir, 'icons'), { recursive: true })
  writeFileSync(join(outDir, 'icons', 'index.json'), JSON.stringify(manifest, null, 2))
  const files = [...written.values()].filter(Boolean).length
  console.log(`icons: ${Object.keys(index.items).length} items, ${Object.keys(index.skills).length} skills, ${files} files -> ${join(outDir, 'icons')}`)
  console.log(`  items from ${sources.items}; skills from ${sources.skills}`)
  if (failures.length) console.warn(`  ${failures.length} failures (first 10):\n  ! ${failures.slice(0, 10).join('\n  ! ')}`)
}

function main(): void {
  const media = openArchive('Media', cfg)
  if (doUi) exportHud(media)
  if (doIcons) exportIcons(media)
}

main()

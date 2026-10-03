/**
 * Game data export: client textdata (Media.pk2) + the port's server-only data -> JSON for the game server and client.
 *
 *   pnpm tsx packages/convert/src/tools/export-data.ts [--out <dir>] [--port-data <dir>] [--world <name>]
 *                                                     [--zones-world <folder>] [--zones-only]
 *                                                     [--no-icons] [--force-icons] [--check]
 *
 * Writes <out> (default work/out/data/, served at /out/data/); icons go to work/out/icon/ (PNG). The files hold
 * retail data and stay under work/ (gitignored). docs/DATA.md documents every file, source and formula.
 *
 *  characters.json, levels.json, weapons.json, strings.json   the creation data (data/game-data.ts)
 *  mobs.json nests.json items.json skills.json masteries.json npcs.json shops.json drops.json
 *                                                               content files (packages/shared/src/content.ts)
 *  all-nests.json    every province's nests in the same frame; only jangan_province has enabled: true
 *  towns.json        Jangan: spawn (teleport arrival point), safe box, town regions
 *  zones.json        every region of the --zones-world export with its client zone name (data/zones.ts, FIELDS §6.2);
 *                    the coast's area names (content/coast/coast.json) where the client has none and the coast shapes it
 *  export-report.json  frame derivation, terrain evidence, counts, models to convert, skipped drops
 *
 * --zones-world <folder>: the world export whose regions zones.json lists (default: jangan-fields when that export
 * exists, else --world). Never pass --world jangan-fields: --world stamps its manifest name into every nest/NPC/town
 * record, and the server keeps only records of its world id 'jangan' (docs/FIELDS.md §6.2). --zones-only writes
 * zones.json alone (town codes from the existing towns.json) and skips everything else.
 *
 * --port-data: the third-party port's server/data folder (read-only JSON; default: sro.config.json "portDataDir",
 * else <parent of clientDir>/Random SRO Browser Remade/server/data). --world: the world manifest whose frame
 * positions use (default jangan: work/out/world/jangan/manifest.json).
 * Models: every glb the records reference is checked under work/out; missing ones are listed with the
 * `pnpm sro convert` command that produces them; --check makes that an error (exit 1).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { decodeDds, loadTextdataTable, NVM_TILE_SIZE, NVM_TILES, nvmTerrainHeightAt, parseDdj, parseNvm, type NvmFile } from '@sro/formats'
import { loadClientSources } from '../data/client-source.ts'
import { buildContent, serializeContent } from '../data/content.ts'
import { fileRegion, REGION_UNITS, regionXZ, worldFrameFromManifest, type FilePos } from '../data/frame.ts'
import { buildGameData, convertedPaths, loadGameDataSources, serializeGameData } from '../data/game-data.ts'
import { iconSource } from '../data/models.ts'
import { defaultPortDataDir, loadPortData } from '../data/port-source.ts'
import { textdataReader } from '../data/textdata-source.ts'
import { buildZones, checkZones, coastAreaNamer, serializeZones, ZONES_FILE_NAME } from '../data/zones.ts'
import { parseCoastConfig } from '../world/coast/config.ts'
import { loadConfig, openArchive, REPO_ROOT } from '../node-io.ts'
import { encodePng } from '../png.ts'

const args = process.argv.slice(2)
const arg = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const cfg = loadConfig()
const outRoot = join(cfg.workDir, 'out')
const outDir = arg('--out') ? resolve(arg('--out')!) : join(outRoot, 'data')
const check = args.includes('--check')
const worldName = arg('--world') ?? 'jangan'
const rawCfg = JSON.parse(readFileSync(join(REPO_ROOT, 'sro.config.json'), 'utf8')) as { portDataDir?: string }
const portDir = resolve(arg('--port-data') ?? rawCfg.portDataDir ?? defaultPortDataDir(cfg.clientDir))

const t0 = performance.now()
const media = openArchive('Media', cfg)
const data = openArchive('Data', cfg)
const read = textdataReader(media)
mkdirSync(outDir, { recursive: true })
const write = (name: string, contents: string) => {
  writeFileSync(join(outDir, name), contents)
  console.log(`${join(outDir, name)}  ${contents.length} bytes`)
}

// ---- zones (docs/FIELDS.md §6.2): regions of --zones-world with their client names --------------------------
const zonesWorld = arg('--zones-world') ?? (existsSync(join(outRoot, 'world', 'jangan-fields', 'manifest.json')) ? 'jangan-fields' : worldName)
function writeZones(): void {
  const manifestFile = join(outRoot, 'world', zonesWorld, 'manifest.json')
  if (!existsSync(manifestFile)) throw new Error(`${manifestFile} not found; convert the world first (pnpm sro convert-region --preset ${zonesWorld})`)
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    regions: Array<{ x: number; z: number; synthetic?: boolean }>
    coast?: unknown
    stream?: { playable?: { x0: number; x1: number; z0: number; z1: number } }
  }
  const regions = manifest.regions
  // the coast's area names for the regions the client has none for (data/zones.ts coastAreaNamer)
  const coastFile = join(REPO_ROOT, 'content', 'coast', 'coast.json')
  const play = manifest.stream?.playable
  const coastArea = manifest.coast && play && existsSync(coastFile) ? coastAreaNamer(parseCoastConfig(readFileSync(coastFile, 'utf8')), play) : undefined
  const townsFile = join(outDir, 'towns.json')
  const towns = existsSync(townsFile)
    ? (JSON.parse(readFileSync(townsFile, 'utf8')) as { entries?: Array<{ code: string; regions?: number[] }> }).entries ?? []
    : []
  const names = loadTextdataTable('textzonename.txt', read)
  const zones = buildZones({
    regions,
    zoneNames: names.rows.map(r => r.cells),
    ...(names.header ? { zoneHeader: names.header } : {}),
    refregion: loadTextdataTable('refregion.txt', read).rows.map(r => r.cells),
    towns,
    ...(coastArea ? { coastArea } : {}),
  })
  const problems = checkZones(zones)
  if (problems.length) throw new Error(`zones self-check failed:\n  ${problems.slice(0, 20).join('\n  ')}`)
  // Temp file + rename: the running servers may read zones.json at any time.
  const file = join(outDir, ZONES_FILE_NAME)
  const text = serializeZones(zones, zonesWorld, new Date().toISOString(), coastArea ? ['content/coast/coast.json (coast area names)'] : [])
  writeFileSync(file + '.tmp', text)
  renameSync(file + '.tmp', file)
  const named = zones.filter(z => z.name).length
  console.log(`${file}  ${text.length} bytes: ${zones.length} regions of world/${zonesWorld}, ${named} named, ` +
    `${new Set(zones.map(z => z.name.toLowerCase()).filter(Boolean)).size} distinct names, ${zones.filter(z => z.town).length} in towns`)
}
if (args.includes('--zones-only')) {
  writeZones()
  process.exit(0)
}

// ---- creation data (characters, levels, weapons, strings) -------------------------------------------------
const { data: gameData, rejected } = buildGameData(loadGameDataSources(read))
for (const [name, contents] of Object.entries(serializeGameData(gameData))) write(name, contents)
for (const r of rejected) console.log(`not a creation choice: ${r.code}: ${r.reasons.join('; ')}`)

// ---- content -------------------------------------------------------------------------------------------------
const manifestPath = join(outRoot, 'world', worldName, 'manifest.json')
if (!existsSync(manifestPath)) throw new Error(`${manifestPath} not found; convert the world first (pnpm sro convert-region --preset ${worldName})`)
const world = worldFrameFromManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
const outFile = (url: string) => join(outRoot, ...url.replace(/^\/out\//, '').split('/'))
const exists = (url: string) => existsSync(outFile(url))
const hasData = (path: string) => data.get(path) !== undefined

// Terrain probe for the frame evidence: the client's own navmesh (Data.pk2 navmesh/nv_<region hex>.nvm).
const nvms = new Map<number, NvmFile | null>()
const terrain = (p: FilePos) => {
  const id = fileRegion(p)
  if (!nvms.has(id)) {
    const f = data.get(`navmesh/nv_${id.toString(16).padStart(4, '0')}.nvm`)
    nvms.set(id, f ? parseNvm(data.read(f)) : null)
  }
  const nvm = nvms.get(id)
  if (!nvm) return undefined
  const { rx, rz } = regionXZ(id)
  const lx = p.x - rx * REGION_UNITS
  const lz = p.z - rz * REGION_UNITS
  const tile = Math.min(NVM_TILES - 1, Math.floor(lz / NVM_TILE_SIZE)) * NVM_TILES + Math.min(NVM_TILES - 1, Math.floor(lx / NVM_TILE_SIZE))
  const cell = nvm.tileCells[tile]!
  return { open: cell >= 0 && cell < nvm.openCellCount, heightM: nvmTerrainHeightAt(nvm, lx, lz) / 10 }
}

const client = loadClientSources(read)
const port = loadPortData(portDir)
const hasIcon = (assoc: string) => media.get(iconSource(assoc)) !== undefined
/** A converted model's skeleton joints, from its sidecar (W11-CV: the ride's `saddle` check, docs/UNIQUES.md §2.2). */
const jointsOf = (sidecarUrl: string): string[] | null => {
  try {
    const joints = (JSON.parse(readFileSync(outFile(sidecarUrl), 'utf8')) as { skeleton?: { joints?: unknown } }).skeleton?.joints
    return Array.isArray(joints) ? joints.filter((j): j is string => typeof j === 'string') : null
  } catch {
    return null
  }
}
const { files, report } = buildContent({ client, port, world, exists, hasData, hasIcon, jointsOf, terrain, generatedAt: new Date().toISOString() })
for (const [name, contents] of Object.entries(serializeContent(files))) write(name, contents)
writeZones()

// ---- icons ---------------------------------------------------------------------------------------------------
let iconsWritten = 0
const iconsMissing: string[] = []
if (!args.includes('--no-icons')) {
  const force = args.includes('--force-icons')
  for (const icon of report.icons) {
    const out = outFile('/out/icon/' + icon.replace(/\\/g, '/').toLowerCase().replace(/\.ddj$/, '.png'))
    const f = media.get(iconSource(icon))
    if (!f) {
      iconsMissing.push(icon)
      continue
    }
    if (!force && existsSync(out)) continue
    const img = decodeDds(parseDdj(media.read(f)).dds)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, encodePng(img.width, img.height, img.rgba))
    iconsWritten++
  }
}

// ---- models --------------------------------------------------------------------------------------------------
const modelLines: string[] = []
const missing: string[] = []
let total = 0
const referenced = [...report.models.mobs, ...report.models.npcs, ...report.models.items, ...[...gameData.characters, ...gameData.weapons].map(m => m.bsr)]
for (const bsr of [...new Set(referenced)]) {
  const file = outFile(convertedPaths(bsr).glb)
  if (!existsSync(file)) {
    missing.push(bsr)
    continue
  }
  total += statSync(file).size
  modelLines.push(bsr)
}

const reportOut = {
  generatedAt: new Date().toISOString(),
  portDataDir: portDir,
  world: { name: world.name, originRegion: world.originRegion, convertedRegions: [...world.regions] },
  ...report,
  iconsWritten,
  iconsMissing,
  modelsMissing: missing,
}
write('export-report.json', JSON.stringify(reportOut, null, 2) + '\n')

const f = report.frame
console.log(
  `port frame: port = ${f.frame.scale} x game metres + (${f.frame.offsetX}, ${f.frame.offsetZ}); ${f.inliers}/${f.anchors} NPC anchors agree, ` +
    `rms ${f.rmsM.toExponential(2)} m, max ${f.maxM.toExponential(2)} m (${f.worst}); raw fit x ${f.fitX.scale.toFixed(6)}/${f.fitX.offset.toFixed(4)}, z ${f.fitZ.scale.toFixed(6)}/${f.fitZ.offset.toFixed(4)}`,
)
for (const o of f.outliers) console.log(`  outlier anchor (the port moved this NPC): ${o.label} ${o.offM} m`)
for (const t of report.terrain) {
  console.log(`  terrain ${t.zone.padEnd(20)} ${t.probed}/${t.nests} nests on loaded navmesh, ${t.open} on open cells, |dy| median ${t.medianDyM} m, p90 ${t.p90DyM} m, max ${t.maxDyM} m`)
}
console.log(Object.entries(report.counts).map(([k, v]) => `${k} ${v}`).join(', '))
console.log(`jangan nests: ${report.jangan.insideConvertedRegions} inside the ${world.regions.size} converted regions, ${report.jangan.outside} outside; mobs inside: ${report.jangan.mobsInside.join(', ') || 'none'}`)
console.log(`drops: port gold / goldRate = client levelgold for ${report.drops.goldCheck.equal} mobs, ${report.drops.goldCheck.differ.length} differ; entries skipped: ${report.drops.skipped.notExported} not in items.json, ${report.drops.skipped.unmapped} unmapped`)
console.log(`icons: ${iconsWritten} written, ${iconsMissing.length} missing`)
for (const w of report.warnings) console.log(`warning: ${w}`)
console.log(`${modelLines.length}/${modelLines.length + missing.length} referenced models converted (${(total / 1048576).toFixed(1)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
if (missing.length) {
  console.log(`missing glbs; convert them with:\n  pnpm sro convert ${missing.join(' ')}`)
  if (check) process.exit(1)
}

#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ARCHIVES, loadConfig, openArchive, REPO_ROOT, type ArchiveName, type SroConfig } from './node-io.ts'
import { census, formatCensus } from './census.ts'
import { convertMany, PRESETS } from './gltf/output.ts'
import { coastExportCli, coastImportCli } from './tools/coast-blender.ts'
import { exportMovesCli } from './tools/export-moves.ts'
import { siegeWallsCli } from './tools/siege-walls.ts'
import { townGraphCli } from './town/build-graph.ts'
import { exportTownCli } from './town/export-town.ts'
import { convertLockPath, withConvertLock } from './world/convert-lock.ts'
import { convertWorld, parseRegionSpec, regionRange, WORLD_PRESETS, type WorldPreset } from './world/convert-world.ts'
import { publishWorldEdits, validateWorldEdits } from './world/edits/index.ts'

const USAGE = `Usage: pnpm sro <command> [args]

  info                         Header, key check and file counts for every PK2
  ls <Archive> [folder]        List files in a folder of an archive (e.g. ls Data res/char)
  cat <Archive> <path>         Print a small text file (UTF-16LE/UTF-8/CP949 auto-detected)
  extract [Archive...]         Extract archives to work/extracted/<Archive>/ (default: all)
  census                       Count file signatures/versions per extension -> work/census.json
  convert <bsr...> [--out dir] BSR -> <out>/<category>/<name>.glb + .json, validated, merged into index.json
  convert --preset m1|fx       Convert a preset list (default out: work/out)
  convert-region --preset jangan|jangan-fields|jangan-near | --regions <x0>-<x1>,<z0>-<z1>
               [--centre x,z] [--name n] [--out dir] [--spawn <teleportdata code>]
               [--no-objects] [--no-navmesh] [--no-validate]
                               Terrain, navmesh, textures and objects of a region rectangle ->
                               work/out/world/<name>/manifest.json (+ bins, nav.bin, PNGs, models/*.glb);
                               jangan-fields also streams (nav/, nav-objects.bin, worldmap.png, docs/FIELDS.md), applies
                               content/world-edits/jangan-fields/ and the tree swap, and writes the pre-pass cache
                               work/cache/world/<name>/prepass.json. convert and convert-region take the convert lock
                               work/out/.convert.lock (waiting up to --lock-wait <minutes>, default 30)
  coast-export --world <name> --area <x0>-<x1>,<z0>-<z1> [--from procedural|export] [--pass <name> --seed <n>] [--watch]
                               An edge area -> a .blend for sculpting (docs/COAST.md §6.1; Blender: sro.config.json blenderExe)
  coast-import --blend <file> [--dry-run]
                               A sculpted .blend -> content/coast/ layers, validated (docs/COAST.md §6.3)
  moves [--skel <skel,...>] [--no-key] [--out dir] [--work dir]
                               Key the movement clips in Blender and write the movement packs (docs/MOVEMENT.md §2.2)
  town [--in dir] [--out dir] [--only variants|vat|atlas[,...]] [--no-models]
                               The townsfolk's dressed variants, atlases and VATs -> <out>/town/ (in: work/out; out: the
                               input; docs/TOWN_LIFE.md §3.2)
  town-graph [--world name] [--out file] [--dry-run]
                               The town's route graph and places -> content/town/jangan.json (docs/TOWN_LIFE.md §2.4)
  world-edit validate [--world jangan-fields]
                               Check the World Editor's layers in content/world-edits/<world>/ (docs/WORLD_EDITOR.md §6.2)
  world-edit publish [--world jangan-fields]
                               Publish the layers through the checks (docs/WORLD_EDITOR.md §6; built by WE-A)
  trees <command> [args]       The tree tool (docs/TREES.md Part W; not part of the public release)
  siege-walls [plan|cut|nav|all] [--world jangan-fields] [--replan] [--no-blender] [--no-opt]
                               Jangan's destructible walls (docs/SIEGE.md §3): the segment plan (content/siege/jangan.json),
                               the Blender cut, the nav split and breach tiles -> <world>/siege/ (+ out-opt)
`

function asArchive(name: string | undefined): ArchiveName {
  const match = ARCHIVES.find(a => a.toLowerCase() === (name ?? '').toLowerCase().replace(/\.pk2$/, ''))
  if (!match) throw new Error(`Unknown archive ${JSON.stringify(name)}; expected one of ${ARCHIVES.join(', ')}`)
  return match
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(bytes.subarray(3))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('euc-kr').decode(bytes)
  }
}

/** --lock-wait <minutes> (default 30), removed from args. */
function lockWaitMs(args: string[]): number {
  const i = args.indexOf('--lock-wait')
  if (i < 0) return 30 * 60_000
  const min = Number(args[i + 1])
  if (!Number.isFinite(min) || min < 0) throw new Error('--lock-wait expects minutes')
  args.splice(i, 2)
  return min * 60_000
}

/** `pnpm sro world-edit validate|publish [--world <name>]` (docs/WORLD_EDITOR.md §6.2). */
async function worldEditCli(args: string[], cfg: SroConfig): Promise<number> {
  const [verb, ...rest] = args
  let world = 'jangan-fields'
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--world') world = rest[++i] ?? ''
    else throw new Error(`world-edit: unexpected argument ${JSON.stringify(rest[i])}`)
  }
  const preset = WORLD_PRESETS[world]
  if (!preset?.edits) throw new Error(`world-edit: world ${JSON.stringify(world)} has no edit layers; expected one of ` +
    `${Object.entries(WORLD_PRESETS).filter(([, p]) => p.edits).map(([k]) => k).join(', ')}`)
  const dir = resolve(REPO_ROOT, preset.edits)
  if (verb === 'validate') {
    const v = await validateWorldEdits(dir)
    console.log(`world-edit validate ${world}: ${v.files.length} layer file(s) in ${dir}${v.ok ? ', valid' : ''}`)
    for (const p of v.problems) console.log(`  ! ${p}`)
    return v.ok ? 0 : 1
  }
  if (verb === 'publish') {
    const r = await withConvertLock(convertLockPath(cfg.workDir), `world-edit publish ${world}`, () => publishWorldEdits(dir, world),
      { waitMs: 30 * 60_000, log: line => console.log(line) })
    console.log(`world-edit publish ${world}: ${r.message}`)
    return r.ok ? 0 : 1
  }
  console.log(USAGE)
  return 1
}

/**
 * `pnpm sro trees ...`: the tree tool (T12-A's packages/convert/src/trees/cli.ts, also the root script `pnpm trees`).
 * The tool runs as a script on process.argv, so the verb loads it with the argv it would get from `pnpm trees`; a
 * `treesCli(args, cfg)` export, when there is one, is called instead.
 */
async function treesVerb(args: string[], cfg: SroConfig): Promise<number> {
  const spec = './trees/cli.ts'
  const argv = process.argv
  process.argv = [argv[0]!, resolve(import.meta.dirname, spec), ...args]
  let mod: { treesCli?: (args: string[], cfg: SroConfig) => Promise<number> }
  try {
    mod = await import(spec)
  } catch (e) {
    console.log('trees: the tree tool (species authoring with Blender and Meshy) is not part of this release; the converted trees ship in work/out/trees')
    return 1
  } finally {
    process.argv = argv
  }
  if (typeof mod.treesCli === 'function') return mod.treesCli(args, cfg)
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}

const [command, ...args] = process.argv.slice(2)
const cfg = loadConfig()

switch (command) {
  case 'info': {
    for (const name of ARCHIVES) {
      const t0 = performance.now()
      const a = openArchive(name, cfg)
      const bytes = [...a.files.values()].reduce((s, f) => s + f.size, 0)
      console.log(
        `${name.padEnd(10)} v0x${a.header.version.toString(16)} encrypted=${a.header.encrypted} ` +
          `files=${a.files.size} folders=${a.folders.size} data=${(bytes / 2 ** 20).toFixed(0)} MiB ` +
          `index=${(performance.now() - t0).toFixed(0)} ms` +
          (a.warnings.length ? ` warnings=${a.warnings.length}` : ''),
      )
      for (const w of a.warnings.slice(0, 5)) console.log(`  ! ${w}`)
    }
    const media = openArchive('Media', cfg)
    const sv = media.get('SV.T')
    if (sv) console.log(`Media.pk2 SV.T: ${sv.size} bytes (encrypted version stamp)`)
    break
  }
  case 'ls': {
    const a = openArchive(asArchive(args[0]), cfg)
    const folder = args[1] ?? ''
    const prefix = folder.toLowerCase().replace(/\\/g, '/').replace(/^\/|\/$/g, '')
    const sub = [...a.folders].filter(f => f.startsWith(prefix ? prefix + '/' : '') && f !== prefix)
      .filter(f => !f.slice(prefix ? prefix.length + 1 : 0).includes('/'))
    for (const f of sub.sort()) console.log(`[dir]  ${f}`)
    for (const f of a.list(folder).sort((x, y) => x.path.localeCompare(y.path))) {
      console.log(`${String(f.size).padStart(10)}  ${f.path}`)
    }
    break
  }
  case 'cat': {
    const a = openArchive(asArchive(args[0]), cfg)
    process.stdout.write(decodeText(a.read(args[1] ?? '')))
    break
  }
  case 'extract': {
    const names = args.length ? args.map(asArchive) : [...ARCHIVES]
    for (const name of names) {
      const a = openArchive(name, cfg)
      const root = join(cfg.workDir, 'extracted', name)
      let n = 0
      let bytes = 0
      const t0 = performance.now()
      for (const f of a.files.values()) {
        const out = join(root, ...f.path.split('/'))
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, a.read(f))
        n++
        bytes += f.size
        if (n % 5000 === 0) console.log(`  ${name}: ${n}/${a.files.size}`)
      }
      console.log(`${name}: extracted ${n} files, ${(bytes / 2 ** 20).toFixed(0)} MiB in ${((performance.now() - t0) / 1000).toFixed(1)} s -> ${root}`)
    }
    break
  }
  case 'census': {
    const result = census(ARCHIVES.map(n => [n, openArchive(n, cfg)] as const))
    mkdirSync(cfg.workDir, { recursive: true })
    const out = join(cfg.workDir, 'census.json')
    writeFileSync(out, JSON.stringify(result, null, 2))
    console.log(formatCensus(result))
    console.log(`\nwritten ${out}`)
    break
  }
  case 'convert': {
    const lockWait = lockWaitMs(args)
    const paths: string[] = []
    let outDir = join(cfg.workDir, 'out')
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!
      if (a === '--out') outDir = resolve(args[++i] ?? '')
      else if (a === '--preset') {
        const name = args[++i] ?? ''
        const preset = PRESETS[name]
        if (!preset) throw new Error(`Unknown preset ${JSON.stringify(name)}; expected one of ${Object.keys(PRESETS).join(', ')}`)
        paths.push(...preset)
      } else paths.push(a)
    }
    if (!paths.length) {
      console.log(USAGE)
      process.exitCode = 1
      break
    }
    const data = openArchive('Data', cfg)
    const t0 = performance.now()
    const particles = openArchive('Particles', cfg)
    const result = await withConvertLock(convertLockPath(cfg.workDir), `convert ${outDir}`,
      () => convertMany(paths, p => data.read(p), outDir, line => console.log(line), { particleExists: k => !!particles.get(k) }),
      { waitMs: lockWait, log: line => console.log(line) })
    const errors = result.assets.reduce((s, a) => s + a.validation.errors, 0)
    console.log(
      `${result.assets.length}/${paths.length} converted in ${((performance.now() - t0) / 1000).toFixed(1)} s -> ${outDir} ` +
        `(index: ${result.indexFile}); validator errors: ${errors}`,
    )
    if (result.failures.length || errors) process.exitCode = 1
    break
  }
  case 'convert-region': {
    const lockWait = lockWaitMs(args)
    let preset: WorldPreset | undefined
    let name: string | undefined
    let outDir: string | undefined
    let centre: { x: number; z: number } | undefined
    let spawnTeleport: string | undefined
    const flags = new Set<string>()
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!
      if (a === '--preset') {
        const key = args[++i] ?? ''
        preset = WORLD_PRESETS[key]
        if (!preset) throw new Error(`Unknown world preset ${JSON.stringify(key)}; expected one of ${Object.keys(WORLD_PRESETS).join(', ')}`)
        name ??= key
      } else if (a === '--regions') preset = parseRegionSpec(args[++i] ?? '')
      else if (a === '--centre' || a === '--center') {
        const [x, z] = (args[++i] ?? '').split(',').map(Number)
        if (!Number.isInteger(x) || !Number.isInteger(z)) throw new Error('--centre expects x,z')
        centre = { x: x!, z: z! }
      } else if (a === '--spawn') spawnTeleport = args[++i]
      else if (a === '--name') name = args[++i]
      else if (a === '--out') outDir = resolve(args[++i] ?? '')
      else if (a.startsWith('--no-')) flags.add(a)
      else throw new Error(`convert-region: unexpected argument ${JSON.stringify(a)}`)
    }
    if (!preset) {
      console.log(USAGE)
      process.exitCode = 1
      break
    }
    name ??= `r${preset.x0}-${preset.x1}_${preset.z0}-${preset.z1}`
    const objects = !flags.has('--no-objects')
    const label = `convert-region ${name}`
    const { manifest, manifestFile } = await withConvertLock(convertLockPath(cfg.workDir), label, () => convertWorld({
      name,
      regions: regionRange(preset.x0, preset.x1, preset.z0, preset.z1),
      origin: centre ?? preset.centre,
      outDir: outDir ?? join(cfg.workDir, 'out', 'world', name),
      objects,
      navmesh: !flags.has('--no-navmesh'),
      spawnTeleport: spawnTeleport ?? preset.spawnTeleport,
      coast: preset.coast,
      environmentOverrides: preset.environmentOverrides,
      town: preset.town,
      edits: preset.edits,
      trees: preset.trees,
      remasterModels: objects ? preset.remasterModels : undefined,
      prePassCache: preset.edits && objects ? join(cfg.workDir, 'cache', 'world', name, 'prepass.json') : undefined,
      playable: preset.playable,
      stream: preset.stream,
      places: preset.places,
      displayName: preset.displayName,
      validate: !flags.has('--no-validate'),
      cfg,
      log: line => console.log(line),
    }), { waitMs: lockWait, log: line => console.log(line) })
    console.log(`manifest: ${manifestFile}`)
    if (manifest.report.regions === 0) process.exitCode = 1
    break
  }
  case 'coast-export':
    process.exitCode = await coastExportCli(args, cfg)
    break
  case 'coast-import':
    process.exitCode = await coastImportCli(args, cfg)
    break
  case 'moves':
    process.exitCode = await exportMovesCli(args, cfg)
    break
  case 'town':
    process.exitCode = await exportTownCli(args, cfg)
    break
  case 'town-graph':
    process.exitCode = await townGraphCli(args, cfg)
    break
  case 'world-edit':
    process.exitCode = await worldEditCli(args, cfg)
    break
  case 'trees':
    process.exitCode = await treesVerb(args, cfg)
    break
  case 'siege-walls':
    process.exitCode = await siegeWallsCli(args, cfg)
    break
  default:
    console.log(USAGE)
    process.exitCode = command ? 1 : 0
}

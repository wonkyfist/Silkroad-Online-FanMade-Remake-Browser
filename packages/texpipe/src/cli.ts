#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import {
  buildInventory, defaultOutDir, DEFAULT_WORLD, formatInventory, loadOverrides, REPO_ROOT, selectSet, summarize,
  type Inventory, type InventoryEntry, type SetName,
} from './inventory.ts'
import { UpscaleCache, writeAtomic } from './upscale/cache.ts'
import { formatUpscale, loadSource, runUpscale, upscalePaths, type UpIndex } from './upscale/runner.ts'
import { buildSheets, pngOf } from './upscale/sheet.ts'
import { DEFAULT_REVIEW_PORT } from './review.ts'

const USAGE = `Usage: pnpm texpipe <command> [options]

  inventory [--world <name>] [--no-alpha] [--top N] [--json <file>]
                  Every texture in scope (TEXPIPE §1): counts, megapixels, classes, alpha kinds, wrap axes,
                  hero set, texel density. Writes work/texpipe/inventory.json.
  upscale [--set test|hero|all] [--world <name>] [--key <suffix>]... [--force] [--upscaler ai|lanczos] [--batch N] [--sheets]
                  TP-U: x4 with the local Real-ESRGAN (texpipe.realesrgan in sro.config.json), per-axis wrap
                  padding, alpha bleed, AI/Lanczos mix; cached. Writes work/texpipe/up/ (+ index.json).
  ktx2 <in.png> [--role albedo|normal|ormh|emissive] [--out <file.ktx2>] [--levels <l0.png,l1.png,...>] [--check]
                  TP-K: KTX2 (UASTC/ETC1S per role) with basisu (texpipe.basisu in sro.config.json); --check
                  transcodes the result to BC7 and prints the PSNR against the source. 'ktx2 --version' checks the
                  encoder.
  detail [--set test|hero|all] [--key <suffix>]... [--force] [--dry-run] [--any-route] [--keep-server] [--no-lock]
         [--label <text>]
                  DT-2: local SDXL + ControlNet-Tile (ComfyUI, 127.0.0.1 only, started with
                  work/tools/comfyui/start_comfyui.sh) on the TP-U master of every texture whose route is sdxl
                  (content/texpipe/overrides.json 'detail', per set or per class), UV-gated, re-rolled on failure,
                  cached. Holds work/tools/gpu.lock for the batch (polls while another workflow holds it). Writes
                  work/texpipe/detail/ (+ index.json); TP-P then reads it instead of the GAN master.
  pbr [--set test|hero|all] [--key <suffix>]... [--force] [--workers N] [--no-detail] [--no-masks] [--no-sheet]
                  TP-P: de-light, height, normal, AO/roughness/metallic (ORMH), actor material masks and detail,
                  lit and wet previews, from work/texpipe/up/ (Lanczos3 where TP-U has not run). Writes
                  work/texpipe/master/<keyPath>/ and the contact sheet work/texpipe/master/_sheets/pbr-<set>.png.
  encode [--set test|hero|all] [--key <suffix>]... [--force] [--ktx2] [--jobs N]
                  TP-E: the v1 WebP tiers (retail size, 1024, 2048 <= master; albedo q90, normal as nx/ny planes,
                  AO/rough/metal at half size, height) of every TP-P master into work/out/pbr/<keyPath>/, and
                  work/out/pbr/index.json (sro-pbr v1, merged with earlier runs). --ktx2 also writes KTX2
                  albedo/normal/ormh at the set size (TP-K's basisu). Statuses come from content/texpipe/overrides.json.
  review [--set test|hero|all] [--key <suffix>]... [--serve] [--port N]
                  TP-E: work/texpipe/review/index.html, one card per texture (before/after, the stages, tiers and
                  bytes, a status marker). --serve serves it on 127.0.0.1 (default port ${DEFAULT_REVIEW_PORT}) so the
                  status buttons write content/texpipe/overrides.json; Ctrl+C stops it.
  run --set test|hero|all [--world <name>] [--key <suffix>]... [--force] [--upscaler ai|lanczos] [--detail] [--ktx2] [--list]
                  The chain on a batch: inventory -> upscale (TP-U) -> [detail (DT-2, with --detail)] -> pbr (TP-P)
                  -> encode + index (TP-E) -> review page -> comparison sheets in work/texpipe/sheets/. --list prints
                  the batch.
  hero <tile>... on|off [--dry-run] [--json]
                  Flips terrain tiles' hero flag in content/texpipe/overrides.json and, when their sets are encoded, in
                  work/out/pbr/index.json (one validated write each), without a re-encode (every B3 set carries all
                  its maps; WAVE_PLAN8 D7). The world editor's Publish calls it (hero.ts setHero) for a tile painted
                  past 0.1 % cover; --json prints { on, tiles, warnings, files } with the written files for its
                  optimize --files run.
  gates [--set ...] [--from <file>[#group]] [--key <suffix>]...
                  TERRAIN_TEX §3.2's grain and colour gates of every encoded terrain tile of the batch (the 512 tier
                  against retail; the in-game gate from work/texpipe/review/terrain/ingame.json when present).
                  Writes work/texpipe/review/terrain/gates.json (merged with earlier batches).
  spots <tile>... [--synthetic] [--keep N] [--min-share F]
                  The terrain review's spots (terrain-spots.ts): 40 m dry, flat patches nearest town where the tile
                  covers the ground, as /tp x z. Writes work/texpipe/review/terrain/spots.json (merged).
  merge-rows [--file content/trees/texpipe-rows.json] [--replace]
                  Merges a lane's override fragment into content/texpipe/overrides.json, key-disjoint (WAVE_PLAN8 D7).
  extract         Not a separate stage: TP-U reads the lossless decodes in work/out directly.

  --from <file>[#group]
                  Narrows any batch command to the keys of an sro-texpipe-batch file (repo-relative; e.g.
                  content/texpipe/b3-terrain.json#B3a): its 'groups[group]', or 'keys' without a group.
`

const [command, ...args] = process.argv.slice(2)
const NL = '\n'

function option(name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function options(name: string): string[] {
  return args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]!] : []))
}

function setOption(): SetName {
  const set = (option('--set') ?? 'test') as SetName
  if (!['test', 'hero', 'all'].includes(set)) throw new Error(`--set must be test, hero or all (got ${set})`)
  return set
}

/** TP-U over a batch: work/texpipe/up/ and its index. */
async function upscaleStep(entries: InventoryEntry[], outDir: string): Promise<UpIndex> {
  const texpipeDir = join(dirname(outDir), 'texpipe')
  const upscaler = option('--upscaler') ?? 'ai'
  if (upscaler !== 'ai' && upscaler !== 'lanczos') throw new Error(`--upscaler must be ai or lanczos (got ${upscaler})`)
  const t0 = performance.now()
  const { reports, stats, backend, index } = await runUpscale(entries, {
    outDir, texpipeDir, upscaler, overrides: loadOverrides(), force: args.includes('--force'),
    batch: option('--batch') ? Number(option('--batch')) : undefined, log: s => console.log(s),
  })
  console.log(`${NL}upscale (TP-U, ${backend}):`)
  console.log(formatUpscale(reports, stats))
  console.log(`Wrote ${upscalePaths(texpipeDir).up} (index.json) in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  return index
}

/** The comparison sheets of a batch (work/texpipe/sheets/compare_{world,actor}.png). */
async function sheetStep(entries: InventoryEntry[], outDir: string, index: UpIndex): Promise<void> {
  const t0 = performance.now()
  const texpipeDir = join(dirname(outDir), 'texpipe')
  const paths = upscalePaths(texpipeDir)
  const byKey = new Map(entries.map(e => [e.key, e]))
  const cache = new UpscaleCache(paths.cache)
  const files = await buildSheets(entries, {
    index, outDir: join(texpipeDir, 'sheets'), upDir: paths.up, aiFile: h => cache.aiFile(h),
    source: async key => pngOf(await loadSource(outDir, byKey.get(key)!)),
  })
  for (const f of files) console.log(`Wrote ${f}`)
  console.log(`sheets: ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}

/** DT-2 over a batch: the SDXL detail albedos. The ComfyUI/SDXL detail stage is not part of the public release. */
async function detailStep(_entries: InventoryEntry[], _outDir: string): Promise<boolean> {
  console.log('detail (DT-2): the ComfyUI/SDXL detail stage is not part of this release; skipped')
  return false
}

/** TP-P over a batch: work/texpipe/master/ and its contact sheet. */
async function pbrStep(entries: InventoryEntry[], outDir: string, name: string): Promise<boolean> {
  const { runPbr, writeReport } = await import('./pbr/run.ts')
  const texpipeDir = join(dirname(outDir), 'texpipe')
  const res = await runPbr(entries, {
    outDir, texpipeDir, world: option('--world') ?? DEFAULT_WORLD, overrides: loadOverrides(), force: args.includes('--force'),
    workers: option('--workers') !== undefined ? Number(option('--workers')) : undefined,
    options: { detail: !args.includes('--no-detail'), masks: !args.includes('--no-masks') },
    sheet: args.includes('--no-sheet') ? null : name, log: s => console.log(s),
  })
  console.log(`Wrote ${writeReport(res, texpipeDir, name)} (${(res.ms / 1000).toFixed(1)} s)`)
  return res.results.every(r => !r.error)
}

/** TP-E over a batch: the WebP (and optional KTX2) tiers in work/out/pbr/ and the merged index.json. */
async function encodeStep(entries: InventoryEntry[], outDir: string, tiles: readonly InventoryEntry[] = []): Promise<boolean> {
  const { runEncode } = await import('./encode.ts')
  const iw = await import('./index-writer.ts')
  const texpipeDir = join(dirname(outDir), 'texpipe')
  const pbrDir = join(outDir, 'pbr')
  const t0 = performance.now()
  console.log(`encode (TP-E): ${entries.length} set(s) -> ${pbrDir}`)
  const results = await runEncode(entries, {
    texpipeDir, pbrDir, overrides: loadOverrides(), force: args.includes('--force'), ktx2: args.includes('--ktx2'),
    concurrency: option('--jobs') ? Number(option('--jobs')) : undefined, log: s => console.log(s),
  })
  const sets = results.flatMap(r => (r.set ? [r.set] : []))
  const index = iw.mergeIndex(iw.readPbrIndex(pbrDir), sets, { rev: 'unknown', upscaler: 'lanczos3', createdAt: '' })
  index.pipeline = iw.pipelineInfo(texpipeDir, Object.keys(index.sets))
  for (const w of iw.repairIndex(index, pbrDir)) console.log(`  ! ${w}`)
  for (const w of iw.remasterShadows(index, outDir)) console.log(`  ! ${w}`)
  // TERRAIN_TEX §5.2 item 4: every tile set carries its cover (TT-R's reserved range layers read it).
  const covered = iw.applyCover(index, tiles)
  if (covered) console.log(`  cover: ${covered} tile set(s) updated`)
  const file = iw.writePbrIndex(pbrDir, index)
  const t = iw.indexTotals(index, pbrDir)
  const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`
  console.log(`Wrote ${file}: ${t.sets} set(s) (${Object.entries(t.byStatus).map(([s, n]) => `${n} ${s}`).join(', ')}; ${t.hero} hero); `
    + `tiers ${Object.entries(t.bytesByTier).sort((a, b) => Number(a[0]) - Number(b[0])).map(([n, b]) => `${n}: ${mb(b)}`).join(', ')}`
    + `${t.ktx2Bytes ? `; KTX2 ${mb(t.ktx2Bytes)}` : ''} (${((performance.now() - t0) / 1000).toFixed(1)} s)`)
  return results.every(r => !r.error)
}

/** TP-E: the review page of a batch (and the local server with --serve). */
async function reviewStep(entries: InventoryEntry[], outDir: string, name: string): Promise<string> {
  const { buildReview } = await import('./review.ts')
  const { readPbrIndex } = await import('./index-writer.ts')
  const texpipeDir = join(dirname(outDir), 'texpipe')
  const pbrDir = join(outDir, 'pbr')
  const t0 = performance.now()
  const { file, cards } = await buildReview(entries, { outDir, texpipeDir, pbrDir, index: readPbrIndex(pbrDir), overrides: loadOverrides(), title: name })
  const problems = cards.filter(c => c.problems.length).length
  console.log(`Wrote ${file} (${cards.length} card(s)${problems ? `, ${problems} with notes` : ''}; ${((performance.now() - t0) / 1000).toFixed(1)} s)`)
  return file
}

/** The keys of `--from <file>[#group]` (an sro-texpipe-batch file: `groups[group]`, or `keys`), or null. */
function batchKeys(): string[] | null {
  const spec = option('--from')
  if (!spec) return null
  const [file, group] = spec.split('#') as [string, string | undefined]
  const path = isAbsolute(file) ? file : join(REPO_ROOT, file)
  const b = JSON.parse(readFileSync(path, 'utf8')) as { format?: string; keys?: string[]; groups?: Record<string, string[]> }
  if (b.format !== 'sro-texpipe-batch') throw new Error(`--from ${file}: not an sro-texpipe-batch file`)
  const keys = group ? b.groups?.[group] : b.keys
  if (!keys?.length) throw new Error(`--from ${spec}: no keys${group ? ` in group ${group} (groups: ${Object.keys(b.groups ?? {}).join(', ')})` : ''}`)
  return keys
}

/** Narrows a batch to `--from` keys (exact; every key must be in the batch) and `--key` suffixes when given. */
function withKeys(entries: InventoryEntry[]): InventoryEntry[] {
  let out = entries
  const batch = batchKeys()
  if (batch) {
    const by = new Map(entries.map(e => [e.key, e]))
    const missing = batch.filter(k => !by.has(k))
    if (missing.length) throw new Error(`--from: ${missing.length} key(s) not in the inventory: ${missing.slice(0, 5).join(', ')}`)
    out = batch.map(k => by.get(k)!)
  }
  const keys = options('--key').map(k => k.toLowerCase())
  if (!keys.length) return out
  out = out.filter(e => keys.some(k => e.key.endsWith(k)))
  if (!out.length) throw new Error(`--key ${keys.join(', ')}: no texture in the batch matches`)
  return out
}

/** The inventory for a batch command: alpha decoding only when the batch can hold more than terrain tiles. */
async function inventoryFor(): Promise<Inventory> {
  const batch = batchKeys()
  const tilesOnly = !!batch?.length && batch.every(k => k.startsWith('tile2d:'))
  return buildInventory({ outDir: defaultOutDir(), world: option('--world') ?? DEFAULT_WORLD, decodeAlpha: !tilesOnly })
}

async function main(): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  switch (command) {
    case 'inventory': {
      const t0 = performance.now()
      const outDir = defaultOutDir()
      const inv = await buildInventory({ outDir, world: option('--world') ?? DEFAULT_WORLD, decodeAlpha: !args.includes('--no-alpha') })
      const file = option('--json') ?? join(dirname(outDir), 'texpipe', 'inventory.json')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ ...inv, summary: summarize(inv) }, null, 1))
      console.log(formatInventory(inv, Number(option('--top') ?? 12)))
      console.log(`\nWrote ${file} (${((performance.now() - t0) / 1000).toFixed(1)} s)`)
      return 0
    }
    case 'upscale': {
      const set = setOption()
      const outDir = defaultOutDir()
      const inv = await inventoryFor()
      const entries = withKeys(selectSet(inv, set))
      const index = await upscaleStep(entries, outDir)
      if (args.includes('--sheets')) await sheetStep(entries, outDir, index)
      return 0
    }
    case 'run': {
      const set = setOption()
      const t0 = performance.now()
      const outDir = defaultOutDir()
      // decodeAlpha finds the specmask textures (the sword); it reads every OPAQUE alpha-capable image once.
      const inv = await inventoryFor()
      const entries = withKeys(selectSet(inv, set))
      if (args.includes('--list')) {
        for (const e of entries) console.log(`${e.key.padEnd(64)} ${e.size.join('x').padEnd(8)} ${e.class.padEnd(12)} ${e.alpha}`)
        return 0
      }
      console.log(`run --set ${set}: ${entries.length} texture(s) (inventory ${((performance.now() - t0) / 1000).toFixed(1)} s)`)
      // 1. TP-U: upscale.
      const index = await upscaleStep(entries, outDir)
      // 1b. DT-2 (opt-in: GPU-heavy): SDXL detail for the textures routed to sdxl.
      if (args.includes('--detail')) {
        console.log('')
        await detailStep(entries, outDir)
      }
      // 2. TP-P: de-light, height, normal, ORMH from work/texpipe/up/ (or detail/) -> work/texpipe/master/.
      console.log('')
      await pbrStep(entries, outDir, set)
      // 3. TP-E: tiers, WebP planes (+ KTX2 with --ktx2), work/out/pbr/index.json, the review page.
      console.log('')
      const encoded = await encodeStep(entries, outDir, inv.entries.filter(e => e.group === 'tile'))
      await reviewStep(entries, outDir, set)
      // 4. The comparison sheets (TP-U; TP-P adds its columns through buildSheets' extraColumns).
      console.log('')
      await sheetStep(entries, outDir, index)
      console.log(`run --set ${set}: done in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
      return encoded ? 0 : 1
    }
    case 'ktx2': {
      const k = await import('./ktx2.ts')
      if (args.includes('--version')) {
        const v = await k.basisuVersion()
        console.log(v ? `basisu ${v} (${k.basisuPath()}); Node zstd: ${k.zstdAvailable() ? 'yes' : 'no'}` : `basisu not found at ${k.basisuPath()}`)
        return v ? 0 : 1
      }
      const input = args.find((a, i) => !a.startsWith('--') && !['--role', '--out', '--levels'].includes(args[i - 1] ?? ''))
      if (!input) throw new Error('ktx2: give an input PNG')
      const role = (option('--role') ?? 'albedo') as keyof typeof k.KTX2_PROFILES
      if (!(role in k.KTX2_PROFILES)) throw new Error(`--role must be one of ${Object.keys(k.KTX2_PROFILES).join(', ')}`)
      const out = option('--out') ?? input.replace(/\.png$/i, '') + '.ktx2'
      const levels = option('--levels')?.split(',')
      const r = await k.encodeKtx2(input, out, { role, levels })
      console.log(`${r.output}: ${r.width}x${r.height}, ${r.levels} levels, ${r.codec}${r.srgb ? ' sRGB' : ' linear'}, ${r.bytes} bytes, ${r.ms.toFixed(0)} ms`)
      if (args.includes('--check')) {
        const c = await k.checkKtx2(out, levels?.[0] ?? input)
        console.log(`BC7 level 0 vs source: PSNR RGB ${c.psnrRgb.toFixed(2)} dB, alpha ${c.psnrAlpha.toFixed(2)} dB`)
      }
      return 0
    }
    case 'detail': {
      const set = setOption()
      const outDir = defaultOutDir()
      const inv = await inventoryFor()
      return (await detailStep(withKeys(selectSet(inv, set)), outDir)) ? 0 : 1
    }
    case 'pbr': {
      const set = setOption()
      const outDir = defaultOutDir()
      // decodeAlpha finds the specmask textures (the sword); it reads every OPAQUE alpha-capable image once.
      const inv = await inventoryFor()
      return (await pbrStep(withKeys(selectSet(inv, set)), outDir, options('--key').length ? `${set}-keys` : set)) ? 0 : 1
    }
    case 'encode': {
      const set = setOption()
      const outDir = defaultOutDir()
      const inv = await inventoryFor()
      return (await encodeStep(withKeys(selectSet(inv, set)), outDir, inv.entries.filter(e => e.group === 'tile'))) ? 0 : 1
    }
    case 'review': {
      const set = setOption()
      const outDir = defaultOutDir()
      const inv = await inventoryFor()
      const entries = withKeys(selectSet(inv, set))
      await reviewStep(entries, outDir, options('--key').length ? `${set}-keys` : set)
      if (!args.includes('--serve')) return 0
      const { serveReview } = await import('./review.ts')
      const { OVERRIDES_FILE } = await import('./inventory.ts')
      const { url } = await serveReview({
        texpipeDir: join(dirname(outDir), 'texpipe'), overridesFile: OVERRIDES_FILE, keys: entries.map(e => e.key),
        port: option('--port') !== undefined ? Number(option('--port')) : DEFAULT_REVIEW_PORT, log: s => console.log(s),
      })
      console.log(`Review server (this PC only): ${url}  (Ctrl+C to stop; marks save to ${OVERRIDES_FILE})`)
      await new Promise(() => {})
      return 0
    }
    case 'hero': {
      const pos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--file')
      const state = pos.at(-1)
      const tiles = pos.slice(0, -1)
      if (!tiles.length || (state !== 'on' && state !== 'off')) throw new Error('hero: give one or more tiles and on|off (pnpm texpipe hero c_grass_fld_05 on)')
      const { setHero } = await import('./hero.ts')
      const r = setHero({ tiles, on: state === 'on', pbrDir: join(defaultOutDir(), 'pbr'), dryRun: args.includes('--dry-run') })
      if (args.includes('--json')) {
        console.log(JSON.stringify(r))
        return 0
      }
      for (const w of r.warnings) console.log(`  ! ${w}`)
      for (const t of r.tiles) console.log(`${t.key}: hero ${state} (overrides ${t.overrides ? 'changed' : 'unchanged'}, index ${t.index ? 'changed' : 'unchanged'})`)
      console.log(args.includes('--dry-run') ? 'dry run: nothing written' : r.files.length ? `Wrote ${r.files.join(', ')}` : 'nothing to write')
      return 0
    }
    case 'gates': {
      const set = setOption()
      const outDir = defaultOutDir()
      const inv = await inventoryFor()
      const entries = withKeys(selectSet(inv, set)).filter(e => e.group === 'tile')
      const rv = await import('./review.ts')
      const { readPbrIndex } = await import('./index-writer.ts')
      const texpipeDir = join(dirname(outDir), 'texpipe')
      const pbrDir = join(outDir, 'pbr')
      const index = readPbrIndex(pbrDir)
      const shots = rv.readInGame(texpipeDir)
      const tp = rv.terrainReviewPaths(texpipeDir)
      const prev = (existsSync(tp.gates) ? JSON.parse(readFileSync(tp.gates, 'utf8')) : {}) as Record<string, unknown>
      let fails = 0
      for (const e of entries) {
        const file = rv.gateTierFile(index?.sets[e.key], pbrDir)
        if (!file || !existsSync(file)) {
          console.log(`${e.key.padEnd(34)} not encoded`)
          continue
        }
        const s = shots[e.key]
        const g = await rv.terrainGates(e.key, join(outDir, e.source.file), file, s ? rv.inGameGate(s.spot, s.today, s.remaster) : undefined)
        prev[e.key] = g
        if (!g.pass) fails++
        console.log(`${e.key.padEnd(34)} ${rv.formatGates(g)}`)
      }
      mkdirSync(tp.dir, { recursive: true })
      writeAtomic(tp.gates, JSON.stringify(Object.fromEntries(Object.keys(prev).sort().map(k => [k, prev[k]])), null, 1))
      console.log(`${entries.length} tile(s), ${fails} failing a gate; wrote ${tp.gates}`)
      return 0
    }
    case 'spots': {
      const tiles = args.filter((a, i) => !a.startsWith('--') && !['--keep', '--min-share', '--world'].includes(args[i - 1] ?? ''))
      if (!tiles.length) throw new Error('spots: give one or more tiles (stems or tile2d: keys)')
      const { findTerrainSpots } = await import('./terrain-spots.ts')
      const rv = await import('./review.ts')
      const outDir = defaultOutDir()
      const worldDir = join(outDir, 'world', option('--world') ?? DEFAULT_WORLD)
      const found = findTerrainSpots(worldDir, tiles, {
        synthetic: args.includes('--synthetic'), keep: option('--keep') ? Number(option('--keep')) : undefined,
        minShare: option('--min-share') ? Number(option('--min-share')) : undefined,
      })
      const tp = rv.terrainReviewPaths(join(dirname(outDir), 'texpipe'))
      const file = join(tp.dir, 'spots.json')
      const prev = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) as Record<string, unknown>
      for (const [key, spots] of found) {
        prev[key] = spots
        const where = spots.map(s => `/tp ${s.x} ${s.z} (${s.region}, ${Math.round(s.share * 100)}%, ${s.dist} m, relief ${s.relief} m${s.synthetic ? ', coast filler' : ''})`)
        console.log(`${key}: ${where.length ? where.join('; ') : 'no spot'}`)
      }
      mkdirSync(tp.dir, { recursive: true })
      writeAtomic(file, JSON.stringify(prev, null, 1))
      return 0
    }
    case 'merge-rows': {
      const iw = await import('./index-writer.ts')
      const { formatOverrides } = await import('./review.ts')
      const { OVERRIDES_FILE, emptyOverrides } = await import('./inventory.ts')
      const file = option('--file') ?? 'content/trees/texpipe-rows.json'
      const path = isAbsolute(file) ? file : join(REPO_ROOT, file)
      if (!existsSync(path)) {
        console.log(`merge-rows: ${file} does not exist yet; nothing to merge`)
        return 0
      }
      const r = iw.mergeRows(loadOverrides() ?? emptyOverrides(), JSON.parse(readFileSync(path, 'utf8')), { replace: args.includes('--replace') })
      if (r.added.length || r.replaced.length) writeAtomic(OVERRIDES_FILE, formatOverrides(r.overrides))
      console.log(`merge-rows ${file}: ${r.added.length} added, ${r.replaced.length} replaced, ${r.same.length} unchanged`)
      return 0
    }
    case 'extract':
      console.error('extract: not a separate stage (TP-U reads the lossless decodes in work/out directly; see pnpm texpipe upscale)')
      return 2
    default:
      console.log(USAGE)
      return command && command !== 'help' && command !== '--help' ? 1 : 0
  }
}

main().then(code => { process.exitCode = code }, e => {
  console.error((e as Error).message)
  process.exitCode = 1
})

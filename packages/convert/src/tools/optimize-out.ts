#!/usr/bin/env node
// Download-size optimizer for the converter output (docs/ASSETS.md).
//   pnpm tsx packages/convert/src/tools/optimize-out.ts measure [dir]          size census + clip duplication
//   pnpm tsx packages/convert/src/tools/optimize-out.ts run [--in dir] [--out dir] [--only char/,world/] [--precompress] [--no-census]
//   pnpm tsx packages/convert/src/tools/optimize-out.ts run --files <a,b,... | @list.txt> [--in dir] [--out dir] [--prefix world/<name>/]
//        [--slim-from file] [--precompress]
//                                          only the listed files (relative to --in), slim.json merged (optimize/files.ts,
//                                          docs/WORLD_EDITOR.md §6.2 step 4: a World Editor Publish)
// Defaults: --in <workDir>/out, --out <workDir>/out-opt. `run` writes <out>/slim.json and <out>/slim-report.json (--files:
// slim.json only).
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { REPO_ROOT, loadConfig } from '../node-io.ts'
import { optimizeFiles } from '../optimize/files.ts'
import { fmtMB } from '../optimize/io.ts'
import { census, type Census } from '../optimize/measure.ts'
import { optimizeOut } from '../optimize/run.ts'
import { CONVERT_LOCK_DIR, withConvertLock } from '../world/convert-lock.ts'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'help'

function flag(name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function workDir(): string {
  return existsSync(join(REPO_ROOT, 'sro.config.json')) ? loadConfig().workDir : join(REPO_ROOT, 'work')
}

function printCensus(c: Census): void {
  console.log(`${c.root}: ${fmtMB(c.totalBytes)} on disk, ${fmtMB(c.wireBytes)} on the wire (gzip-6 for glb/json/bin)`)
  for (const [k, v] of Object.entries(c.byCategory).sort((a, b) => b[1].bytes - a[1].bytes)) {
    const ext = Object.entries(v.byExt).sort((a, b) => b[1] - a[1]).map(([e, b]) => `${e} ${fmtMB(b)}`).join(', ')
    console.log(`  ${k.padEnd(28)} ${String(v.files).padStart(5)} files ${fmtMB(v.bytes).padStart(10)}  wire ${fmtMB(v.wire).padStart(10)}  (${ext})`)
  }
  for (const [k, v] of Object.entries(c.glb)) {
    console.log(`  glb ${k.padEnd(24)} ${String(v.files).padStart(5)} files: textures ${fmtMB(v.textures)}, animation ${fmtMB(v.animation)}, geometry ${fmtMB(v.geometry)}, other (JSON, padding) ${fmtMB(v.total - v.textures - v.animation - v.geometry)}`)
  }
  if (c.characters) {
    const s = c.characters
    console.log(`  character clips: ${s.clips} in ${s.characters} glbs; ${s.uniqueWithinCharacter} unique per character; ${s.uniqueAcrossAll} unique overall`)
    for (const k of s.skeletons) console.log(`    skeleton ${k.key}: ${k.characters.length} characters, ${k.clips} clips, ${k.unique} unique`)
  }
}

if (cmd === 'measure') {
  const dir = resolve(args[1] ?? join(workDir(), 'out'))
  printCensus(await census(dir, { glbDetail: true, wire: true }))
} else if (cmd === 'run' && flag('--files') !== undefined) {
  const spec = flag('--files')!
  const files = (spec.startsWith('@') ? readFileSync(resolve(spec.slice(1)), 'utf8').split(/\r?\n/) : spec.split(','))
    .map(f => f.trim()).filter(Boolean)
  const t0 = performance.now()
  const inDir = resolve(flag('--in') ?? join(workDir(), 'out'))
  // under the export's convert lock, as the full run (H12-DP-2; Publish calls optimizeFiles under its own lock)
  const report = await withConvertLock(join(inDir, CONVERT_LOCK_DIR), 'optimize-out run --files', () => optimizeFiles({
    inDir,
    outDir: resolve(flag('--out') ?? join(workDir(), 'out-opt')),
    files,
    prefix: flag('--prefix'),
    slimFrom: flag('--slim-from') && resolve(flag('--slim-from')!),
    precompress: args.includes('--precompress'),
    log: m => console.log(m),
  }), { log: m => console.log(m) })
  for (const f of report.written) console.log(`  written ${f}`)
  for (const f of report.removed) console.log(`  removed ${f}`)
  const errors = report.glbs.reduce((n, g) => n + g.validator.errors, 0)
  console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s; ${report.textures.length} texture(s), ${report.glbs.length} glb(s), validator errors ${errors}`)
  process.exitCode = errors ? 1 : 0
} else if (cmd === 'run') {
  const inDir = resolve(flag('--in') ?? join(workDir(), 'out'))
  const outDir = resolve(flag('--out') ?? join(workDir(), 'out-opt'))
  const only = flag('--only')?.split(',').filter(Boolean)
  const t0 = performance.now()
  const report = await optimizeOut({
    inDir,
    outDir,
    only,
    precompress: args.includes('--precompress'),
    noCensus: args.includes('--no-census'),
    log: m => console.log(m),
  })
  if (report.before) printCensus(report.before)
  if (report.after) printCensus(report.after)
  console.log(report.summary)
  if (report.texturesForReview.length) {
    console.log(`textures under the review PSNR (look at these):`)
    for (const t of report.texturesForReview.slice(0, 40)) console.log(`  ${t.file} ${t.name}: q ${t.quality}, PSNR ${t.psnr} dB, SSIM ${t.ssim}`)
  }
  if (report.animationCheck.failures.length) console.log('animation failures:', report.animationCheck.failures.slice(0, 20))
  console.log(`done in ${((performance.now() - t0) / 1000).toFixed(0)} s -> ${outDir}`)
  const bad = Number(report.summary.validatorErrors) > 0 || report.animationCheck.failures.length > 0
  process.exitCode = bad ? 1 : 0
} else {
  console.log('usage: optimize-out.ts measure [dir] | run [--in dir] [--out dir] [--only prefixes] [--precompress] [--no-census]\n' +
    '       optimize-out.ts run --files <a,b | @list> [--in dir] [--out dir] [--prefix world/<name>/] [--slim-from file] [--precompress]')
}

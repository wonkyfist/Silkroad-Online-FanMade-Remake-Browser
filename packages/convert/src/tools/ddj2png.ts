/**
 * Debug helper: decode one DDJ from a PK2 archive to PNG.
 *   pnpm tsx packages/convert/src/tools/ddj2png.ts <Archive> <path> [out.png]
 * <Archive> is Data, Map, Media, Music or Particles. Output defaults to work/out/debug/<name>.png;
 * a relative out.png is resolved against work/out/debug/.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { decodeDds, parseDdj } from '@sro/formats'
import { ARCHIVES, type ArchiveName, loadConfig, openArchive } from '../node-io.ts'
import { encodePng } from '../png.ts'

const [archiveArg, path, outArg] = process.argv.slice(2)
if (!archiveArg || !path) {
  console.error('usage: ddj2png <Archive> <path> [out.png]')
  process.exit(2)
}
const archiveName = ARCHIVES.find(a => a.toLowerCase() === archiveArg.toLowerCase()) as ArchiveName | undefined
if (!archiveName) {
  console.error(`unknown archive ${archiveArg}; expected one of ${ARCHIVES.join(', ')}`)
  process.exit(2)
}

const cfg = loadConfig()
const debugDir = join(cfg.workDir, 'out', 'debug')
const out = resolve(debugDir, outArg ?? basename(path.replace(/\\/g, '/')).replace(/\.[^.]*$/, '') + '.png')

const ddj = parseDdj(openArchive(archiveName, cfg).read(path))
const img = decodeDds(ddj.dds)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, encodePng(img.width, img.height, img.rgba))
const sizeNote = ddj.declaredSize === ddj.dds.length + 8 ? '' : ` (size field ${ddj.declaredSize} != ${ddj.dds.length + 8})`
console.log(`${archiveName}:${path} ${img.format} ${img.width}x${img.height} mips=${img.mipCount}${sizeNote} -> ${out}`)

/**
 * Vendors Babylon's KTX2 transcoder files so the game never loads them from babylonjs.com (docs/TEXPIPE.md §6.7,
 * §9 item 6; docs/WAVE_PLAN3.md §7.1 lane TP-K; approved by the user on 2026-09-28).
 *   pnpm tsx packages/convert/src/tools/vendor-ktx2.ts [--offline] [--work <dir>]
 *
 * Sources (npm registry tarballs, never a CDN), both Apache-2.0 and pinned to the @babylonjs/core version in use:
 *   - babylonjs-ktx2decoder@<ver>    babylon.ktx2Decoder.js (the UMD decoder module the KTX2 worker importScripts)
 *   - @babylonjs/ktx2decoder@<ver>   wasm/*: the UASTC lite transcoders, msc_basis_transcoder.{js,wasm} (ETC1S) and
 *                                    zstddec.wasm; plus NOTICE.md and wasm/license.md (Khronos, zstd BSD-3)
 * The tarballs are cached in work/tools/ktx2decoder/ (so a second run, or --offline, needs no network), checked against
 * the registry's sha512 integrity and a pinned copy of it, and every vendored file is checked against its pinned
 * sha256 below. A version bump of @babylonjs/core therefore fails loudly here until the pins are updated.
 *
 * Output: <work>/out/_decoders/ktx2/ and, when <work>/out-opt exists, <work>/out-opt/_decoders/ktx2/ (next to the
 * meshopt decoder the optimizer writes to out-opt/_decoders/). `optimize-out` also copies out/_decoders/ unchanged.
 * World-render's `installKtx2Decoder` (packages/world-render/src/ktx2.ts) points KhronosTextureContainer2.URLConfig
 * at these names.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const REPO_ROOT = resolve(import.meta.dirname, '../../../..')

/** The Babylon release the files must match (the version of @babylonjs/core in the workspace). */
export const KTX2_DECODER_VERSION = '9.28.0'

/** The folder under the output root (served as <baseUrl>_decoders/ktx2/). */
export const KTX2_DECODER_DIR = '_decoders/ktx2'

export interface NpmSource {
  name: string
  version: string
  tarball: string
  /** The registry's `dist.integrity` for this version (sha512, base64), pinned. */
  integrity: string
}

export const KTX2_SOURCES = {
  umd: {
    name: 'babylonjs-ktx2decoder',
    version: KTX2_DECODER_VERSION,
    tarball: `https://registry.npmjs.org/babylonjs-ktx2decoder/-/babylonjs-ktx2decoder-${KTX2_DECODER_VERSION}.tgz`,
    integrity: 'sha512-7DQ+j/Wc1m2b94DsjNKXMYQCiP9yMIXPTWmSROnuDhhXEWjKII7GnvUHRtpgh6AOIJdCfJq8TwIyGdy+B3N0Qw==',
  },
  es6: {
    name: '@babylonjs/ktx2decoder',
    version: KTX2_DECODER_VERSION,
    tarball: `https://registry.npmjs.org/@babylonjs/ktx2decoder/-/ktx2decoder-${KTX2_DECODER_VERSION}.tgz`,
    integrity: 'sha512-tZ9Unf+PNVmf0tZQtwmZaUOUr6vPEdbFzalwu3mHwVF6SD4QZGKj6Y/99vIEA+zw+3diMOOoSEY9kCPHEheiFw==',
  },
} as const satisfies Record<string, NpmSource>

export interface VendoredFile {
  /** File name in _decoders/ktx2/. */
  name: string
  source: keyof typeof KTX2_SOURCES
  /** Path inside the tarball. */
  path: string
  sha256: string
}

/**
 * Every file the runtime loads (one per KhronosTextureContainer2.URLConfig entry, see world-render ktx2.ts
 * KTX2_DECODER_FILES) plus the licence texts that travel with them.
 */
export const KTX2_VENDORED_FILES: readonly VendoredFile[] = [
  { name: 'babylon.ktx2Decoder.js', source: 'umd', path: 'package/babylon.ktx2Decoder.js', sha256: '3907b73546b65c08a46773a8b130fe2acde9cd1effa89f87d095d8b6f92cfb1d' },
  { name: 'uastc_astc.wasm', source: 'es6', path: 'package/wasm/uastc_astc.wasm', sha256: '6846c972b4a52d938866f43896fd2b2450052da807cdd1285e898be80614d612' },
  { name: 'uastc_bc7.wasm', source: 'es6', path: 'package/wasm/uastc_bc7.wasm', sha256: 'be442ab8c0cbf734ded98e6ad38112aaba23c83bfeecac4213ded54631fc4eef' },
  { name: 'uastc_rgba8_unorm_v2.wasm', source: 'es6', path: 'package/wasm/uastc_rgba8_unorm_v2.wasm', sha256: 'b7470b26a847994cdeb9226eeba1e3711688e378ee438b7dd941e83cb598b694' },
  { name: 'uastc_rgba8_srgb_v2.wasm', source: 'es6', path: 'package/wasm/uastc_rgba8_srgb_v2.wasm', sha256: '1f4d2e8bfef4e31679b23d473e1c410c29f7e485a739e76c5b357628f4190874' },
  { name: 'uastc_r8_unorm.wasm', source: 'es6', path: 'package/wasm/uastc_r8_unorm.wasm', sha256: '0467c98b150a630e5a51f7810843e8b7fd9aad22e3888baf70aad255c55d02bc' },
  { name: 'uastc_rg8_unorm.wasm', source: 'es6', path: 'package/wasm/uastc_rg8_unorm.wasm', sha256: 'fb45a2c103c59cec21c3708a6534d43cd4381669f66d3292dd8a6e4e1956d773' },
  { name: 'msc_basis_transcoder.js', source: 'es6', path: 'package/wasm/msc_basis_transcoder.js', sha256: 'b8906bae7e55606aba070642eb3bce790a2b5aea774874e120e9fd41f7c7d60b' },
  { name: 'msc_basis_transcoder.wasm', source: 'es6', path: 'package/wasm/msc_basis_transcoder.wasm', sha256: '29becbf0eef2ce9f6d72109ad217704ec3799c432da0c26e3893b793ecab6bdc' },
  { name: 'zstddec.wasm', source: 'es6', path: 'package/wasm/zstddec.wasm', sha256: '67d12d34f82ef700ec3a3795a77590252858c70330908a87ed1e73efc268cb4b' },
  { name: 'LICENSE-babylon.md', source: 'umd', path: 'package/license.md', sha256: '9362ea9ea17cb221a20cbbd63f404710834cc273d2a9a7b60314fd68ab702cd6' },
  { name: 'LICENSE-transcoders.md', source: 'es6', path: 'package/wasm/license.md', sha256: 'a5f49089897509e43a03cfb81e1fd689e3b9e00f3381c5ec74a12cb716c7df49' },
  { name: 'NOTICE.md', source: 'es6', path: 'package/NOTICE.md', sha256: 'a08d8fde9948804d9c771da238d5b34e284caca5dc269dcf3c443fbd18fca7db' },
]

/** The manifest written beside the files. */
export interface Ktx2DecoderManifest {
  format: 'sro-ktx2-decoders'
  version: 1
  babylon: string
  sources: { name: string; version: string; tarball: string; integrity: string; license: 'Apache-2.0' }[]
  files: { name: string; bytes: number; sha256: string; from: string }[]
}

export function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** npm's `dist.integrity` form of a buffer (sha512, base64). */
export function npmIntegrity(buf: Uint8Array): string {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`
}

/**
 * The regular files of a (ustar/pax) tar archive, by path. Enough for npm tarballs: long names through the ustar
 * prefix field or a pax `path` record; other entry types are skipped.
 */
export function parseTar(tar: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const text = (at: number, len: number): string => {
    let end = at
    while (end < at + len && tar[end] !== 0) end++
    return Buffer.from(tar.subarray(at, end)).toString('utf8')
  }
  let off = 0
  let paxPath: string | undefined
  while (off + 512 <= tar.length) {
    if (tar.subarray(off, off + 512).every(b => b === 0)) break
    const name = text(off, 100)
    const size = parseInt(text(off + 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(tar[off + 156] || 48)
    const prefix = text(off + 345, 155)
    const dataAt = off + 512
    const data = tar.subarray(dataAt, dataAt + size)
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(Buffer.from(data).toString('utf8'))
      paxPath = m?.[1]
    } else if (type === '0' || type === '\0') {
      out.set(paxPath ?? (prefix ? `${prefix}/${name}` : name), data)
      paxPath = undefined
    } else {
      paxPath = undefined
    }
    off = dataAt + Math.ceil(size / 512) * 512
  }
  return out
}

function workDirOf(explicit?: string): string {
  if (explicit) return resolve(explicit)
  const cfgPath = join(REPO_ROOT, 'sro.config.json')
  let workDir = 'work'
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { workDir?: string }
      if (cfg.workDir) workDir = cfg.workDir
    } catch {
      // A broken config is reported by the converter; fall back to work/.
    }
  }
  return resolve(REPO_ROOT, workDir)
}

/** The tarball, from the cache or the npm registry; its integrity is checked either way. */
async function fetchTarball(src: NpmSource, cacheDir: string, offline: boolean): Promise<Uint8Array> {
  const file = join(cacheDir, `${src.name.replace('@', '').replace('/', '__')}-${src.version}.tgz`)
  let buf: Uint8Array | undefined
  if (existsSync(file)) buf = readFileSync(file)
  if (!buf) {
    if (offline) throw new Error(`${file} is missing and --offline was given`)
    if (!src.tarball.startsWith('https://registry.npmjs.org/')) throw new Error(`refusing a non-registry source: ${src.tarball}`)
    const res = await fetch(src.tarball)
    if (!res.ok) throw new Error(`${src.tarball}: HTTP ${res.status}`)
    buf = new Uint8Array(await res.arrayBuffer())
    if (npmIntegrity(buf) !== src.integrity) throw new Error(`${src.name}@${src.version}: integrity mismatch (download)`)
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(file, buf)
  }
  if (npmIntegrity(buf) !== src.integrity) throw new Error(`${src.name}@${src.version}: integrity mismatch (${file})`)
  return buf
}

/** Checks that @babylonjs/core in the workspace is the version the pins are for. */
export function installedBabylonVersion(): string | undefined {
  const pkg = join(REPO_ROOT, 'packages', 'world-render', 'node_modules', '@babylonjs', 'core', 'package.json')
  if (!existsSync(pkg)) return undefined
  return (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version
}

export interface VendorOptions {
  work?: string
  /** Tarball cache (default <work>/tools/ktx2decoder). */
  cacheDir?: string
  offline?: boolean
  log?: (msg: string) => void
}

/** Downloads (or reuses) the two tarballs and writes the vendored files. Returns the output folders written. */
export async function vendorKtx2(opts: VendorOptions = {}): Promise<{ dirs: string[]; manifest: Ktx2DecoderManifest }> {
  const log = opts.log ?? (() => {})
  const babylon = installedBabylonVersion()
  if (babylon && babylon !== KTX2_DECODER_VERSION) {
    throw new Error(`@babylonjs/core is ${babylon} but the KTX2 decoder pins are for ${KTX2_DECODER_VERSION}: update KTX2_SOURCES and the sha256 pins`)
  }
  const work = workDirOf(opts.work)
  const cacheDir = opts.cacheDir ?? join(work, 'tools', 'ktx2decoder')
  const tars = new Map<string, Map<string, Uint8Array>>()
  for (const [key, src] of Object.entries(KTX2_SOURCES)) {
    const tgz = await fetchTarball(src, cacheDir, opts.offline ?? false)
    tars.set(key, parseTar(gunzipSync(tgz)))
    log(`${src.name}@${src.version}: ok (${tgz.byteLength} bytes)`)
  }
  const files: { name: string; data: Uint8Array; from: string }[] = []
  for (const f of KTX2_VENDORED_FILES) {
    const data = tars.get(f.source)?.get(f.path)
    if (!data) throw new Error(`${KTX2_SOURCES[f.source].name}: ${f.path} not in the tarball`)
    const got = sha256(data)
    if (got !== f.sha256) throw new Error(`${f.name}: sha256 ${got} does not match the pin ${f.sha256}`)
    files.push({ name: f.name, data, from: `${KTX2_SOURCES[f.source].name}@${KTX2_SOURCES[f.source].version}/${f.path.replace(/^package\//, '')}` })
  }
  const manifest: Ktx2DecoderManifest = {
    format: 'sro-ktx2-decoders',
    version: 1,
    babylon: KTX2_DECODER_VERSION,
    sources: Object.values(KTX2_SOURCES).map(s => ({ ...s, license: 'Apache-2.0' as const })),
    files: files.map(f => ({ name: f.name, bytes: f.data.byteLength, sha256: sha256(f.data), from: f.from })),
  }
  const dirs = [join(work, 'out', KTX2_DECODER_DIR)]
  if (existsSync(join(work, 'out-opt'))) dirs.push(join(work, 'out-opt', KTX2_DECODER_DIR))
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
    for (const f of files) writeFileSync(join(dir, f.name), f.data)
    writeFileSync(join(dir, 'ktx2-decoders.json'), JSON.stringify(manifest, null, 2))
    log(`wrote ${files.length} files to ${dir}`)
  }
  return { dirs, manifest }
}

/** Checks a vendored folder against the pins; returns the problems (empty when complete and intact). */
export function checkVendored(dir: string): string[] {
  const problems: string[] = []
  for (const f of KTX2_VENDORED_FILES) {
    const p = join(dir, f.name)
    if (!existsSync(p)) problems.push(`${f.name}: missing`)
    else if (sha256(readFileSync(p)) !== f.sha256) problems.push(`${f.name}: sha256 mismatch`)
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const i = args.indexOf('--work')
  vendorKtx2({ offline: args.includes('--offline'), work: i >= 0 ? args[i + 1] : undefined, log: m => console.log(m) }).then(
    r => console.log(`KTX2 decoder ${r.manifest.babylon}: ${r.manifest.files.length} files in ${r.dirs.length} folder(s)`),
    e => {
      console.error((e as Error).message)
      process.exitCode = 1
    },
  )
}

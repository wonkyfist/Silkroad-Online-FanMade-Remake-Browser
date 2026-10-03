/**
 * TP-K: KTX2 encoding with the Basis Universal encoder (docs/TEXPIPE.md §6.7, docs/WAVE_PLAN3.md §7.1; approved by
 * the user on 2026-09-28). `basisu` 1.16.4 for Windows (Apache-2.0, the last GitHub release that ships a Windows
 * binary) lives in work/tools/basisu/basisu.exe; the path can be overridden with `texpipe.basisu` in sro.config.json
 * or the SRO_BASISU environment variable. Node only; retail pixels never leave this PC.
 *
 * Per map role (PBR_FILES, format.ts; D37/D38):
 *   albedo    UASTC + RDO (λ 1) + Zstandard, sRGB, encoder mips (filtered in linear light)
 *   normal    UASTC, linear, `-normal_map` (linear metrics, no RDO), mips renormalised to unit length
 *   ormh      UASTC + light RDO (λ 0.5), linear; A = height (D37)
 *   emissive  ETC1S (BasisLZ), sRGB: small, soft, rarely large on screen
 * UASTC is the "BC7-friendly" codec: its blocks map onto BC7 modes, so the runtime's UASTC → BC7 transcode (desktop
 * GPUs) is near lossless, and UASTC → ASTC 4×4 (Apple GPUs) is lossless by design. ETC1S → BC7 works but at ETC1S
 * quality; it is only used where that does not show.
 *
 * Explicit mips (`levels`): the `cutout` albedo keeps TP-U's coverage-preserving mip chain instead of the encoder's
 * filter. basisu 1.16 cannot take a user chain, so each level is encoded on its own (UASTC is block-local: no shared
 * codebook), and this module assembles one KTX2 with every level, Zstandard-supercompressed with Node's zlib.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import * as zlib from 'node:zlib'
import sharp from 'sharp'
import type { PbrFileMap } from './format.ts'
import { REPO_ROOT } from './inventory.ts'

// ---------------------------------------------------------------------------------------------------------------
// Profiles

export type Ktx2Codec = 'uastc' | 'etc1s'

export interface Ktx2Profile {
  codec: Ktx2Codec
  /** sRGB transfer (colour) or linear (data). */
  srgb: boolean
  /** UASTC: pack level 0–4 (default 2). */
  uastcLevel?: number
  /** UASTC: RDO λ (smaller files after Zstandard; 0 = off). */
  rdo?: number
  /** UASTC: Zstandard level (basisu default 6). */
  zstd?: number
  /** ETC1S: quality 1–255. */
  quality?: number
  /** basisu `-normal_map` (+ `-mip_renorm`). */
  normalMap?: boolean
}

export const KTX2_PROFILES: Readonly<Record<PbrFileMap, Ktx2Profile>> = {
  albedo: { codec: 'uastc', srgb: true, uastcLevel: 2, rdo: 1, zstd: 18 },
  normal: { codec: 'uastc', srgb: false, uastcLevel: 3, zstd: 18, normalMap: true },
  ormh: { codec: 'uastc', srgb: false, uastcLevel: 2, rdo: 0.5, zstd: 18 },
  emissive: { codec: 'etc1s', srgb: true, quality: 192 },
}

export interface Ktx2EncodeOptions {
  role: PbrFileMap
  /** Overrides of the role's profile. */
  profile?: Partial<Ktx2Profile>
  /** Encoder mip chain (default true). Ignored when `levels` is given. */
  mips?: boolean
  /** Explicit mip chain as PNG files, level 0 first, each half the previous (UASTC only). */
  levels?: readonly string[]
  /** basisu executable (default: basisuPath()). */
  basisu?: string
  /** Threads for basisu (default: all). */
  threads?: number
}

/** The basisu command line (after the executable) for one image. */
export function basisuArgs(
  input: string, output: string,
  opts: Pick<Ktx2EncodeOptions, 'role' | 'profile' | 'mips' | 'threads'> & { zstd?: boolean; alpha?: 'force' | 'none' },
): string[] {
  const p = { ...KTX2_PROFILES[opts.role], ...opts.profile }
  const args = ['-ktx2', '-file', input, '-output_file', output]
  if (p.codec === 'uastc') {
    args.push('-uastc', '-uastc_level', String(p.uastcLevel ?? 2))
    if (p.rdo && !p.normalMap) args.push('-uastc_rdo_l', String(p.rdo))
    if (opts.zstd === false) args.push('-ktx2_no_zstandard')
    else args.push('-ktx2_zstandard_level', String(p.zstd ?? 6))
  } else {
    args.push('-q', String(p.quality ?? 128))
  }
  if (p.normalMap) args.push('-normal_map')
  else if (!p.srgb) args.push('-linear')
  if (opts.mips ?? true) {
    args.push('-mipmap')
    if (p.normalMap) args.push('-mip_renorm')
  }
  if (opts.alpha === 'force') args.push('-force_alpha')
  else if (opts.alpha === 'none') args.push('-no_alpha')
  if (opts.threads) args.push('-max_threads', String(opts.threads))
  return args
}

// ---------------------------------------------------------------------------------------------------------------
// The encoder executable

interface TexpipeConfig {
  workDir?: string
  texpipe?: { basisu?: string }
}

function readConfig(): TexpipeConfig {
  const p = join(REPO_ROOT, 'sro.config.json')
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as TexpipeConfig
  } catch {
    return {}
  }
}

/** basisu: SRO_BASISU, then `texpipe.basisu` in sro.config.json, then <workDir>/tools/basisu/basisu(.exe). */
export function basisuPath(): string {
  const env = process.env.SRO_BASISU
  if (env) return resolve(REPO_ROOT, env)
  const cfg = readConfig()
  if (cfg.texpipe?.basisu) return resolve(REPO_ROOT, cfg.texpipe.basisu)
  const exe = process.platform === 'win32' ? 'basisu.exe' : 'basisu'
  return join(resolve(REPO_ROOT, cfg.workDir ?? 'work'), 'tools', 'basisu', exe)
}

export function hasBasisu(path = basisuPath()): boolean {
  return existsSync(path)
}

interface RunResult {
  code: number
  out: string
}

function run(exe: string, args: readonly string[], cwd?: string): Promise<RunResult> {
  return new Promise((res, rej) => {
    const child = spawn(exe, args, { cwd, windowsHide: true })
    let out = ''
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', d => { out += String(d) })
    child.on('error', rej)
    child.on('close', code => res({ code: code ?? -1, out }))
  })
}

/** "1.16.4" (from `basisu -version`), or undefined without the encoder. */
export async function basisuVersion(exe = basisuPath()): Promise<string | undefined> {
  if (!existsSync(exe)) return undefined
  const r = await run(exe, ['-version'])
  return /Compressor v([\d.]+)/.exec(r.out)?.[1]
}

async function runBasisu(exe: string, args: readonly string[], cwd?: string): Promise<string> {
  const r = await run(exe, args, cwd)
  if (r.code !== 0 || /\bERROR\b|Compression failed/i.test(r.out)) {
    throw new Error(`basisu ${args.join(' ')} failed (${r.code}):\n${r.out.split('\n').slice(-8).join('\n')}`)
  }
  return r.out
}

// ---------------------------------------------------------------------------------------------------------------
// The KTX2 container (enough of the spec for Basis files)

export const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a] as const
/** Khronos data format colour models. */
export const KHR_DF_MODEL_ETC1S = 163
export const KHR_DF_MODEL_UASTC = 166
export const KHR_DF_TRANSFER_LINEAR = 1
export const KHR_DF_TRANSFER_SRGB = 2
export const SUPERCOMPRESSION = { none: 0, basisLZ: 1, zstd: 2 } as const

export interface Ktx2Level {
  /** The bytes as stored (supercompressed when the file is). */
  data: Uint8Array
  uncompressedByteLength: number
}

export interface Ktx2File {
  vkFormat: number
  typeSize: number
  width: number
  height: number
  depth: number
  layers: number
  faces: number
  supercompression: number
  /** Level 0 (largest) first. */
  levels: Ktx2Level[]
  dfd: Uint8Array
  kvd: Uint8Array
  sgd: Uint8Array
  /** From the DFD's first block. */
  colorModel: number
  transfer: number
  /** UASTC/ETC1S channel id of sample 0 (UASTC: 0 RGB, 3 RGBA, 4 RRR, 5 RRRG). */
  channelId: number
  /** Key/value pairs (key → value without the trailing NUL). */
  keyValues: Map<string, string>
}

export function isKtx2File(buf: Uint8Array): boolean {
  return buf.length >= 12 && KTX2_IDENTIFIER.every((b, i) => buf[i] === b)
}

export function parseKtx2(buf: Uint8Array): Ktx2File {
  if (!isKtx2File(buf)) throw new Error('not a KTX2 file')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const u32 = (o: number) => dv.getUint32(o, true)
  const u64 = (o: number) => Number(dv.getBigUint64(o, true))
  const levelCount = Math.max(1, u32(40))
  const dfdOff = u32(48)
  const dfd = buf.subarray(dfdOff, dfdOff + u32(52))
  const kvdOff = u32(56)
  const kvd = buf.subarray(kvdOff, kvdOff + u32(60))
  const sgdOff = u64(64)
  const sgd = buf.subarray(sgdOff, sgdOff + u64(72))
  const levels: Ktx2Level[] = []
  for (let i = 0; i < levelCount; i++) {
    const o = 80 + i * 24
    const off = u64(o)
    const len = u64(o + 8)
    if (off + len > buf.length) throw new Error(`KTX2 level ${i} runs past the end of the file`)
    levels.push({ data: buf.subarray(off, off + len), uncompressedByteLength: u64(o + 16) })
  }
  const keyValues = new Map<string, string>()
  for (let o = 0; o + 4 <= kvd.length;) {
    const len = new DataView(kvd.buffer, kvd.byteOffset + o, 4).getUint32(0, true)
    const kv = kvd.subarray(o + 4, o + 4 + len)
    const nul = kv.indexOf(0)
    if (nul > 0) keyValues.set(Buffer.from(kv.subarray(0, nul)).toString('utf8'), Buffer.from(kv.subarray(nul + 1)).toString('utf8').replace(/\0+$/, ''))
    o += 4 + len + ((4 - (len % 4)) % 4)
  }
  return {
    vkFormat: u32(12),
    typeSize: u32(16),
    width: u32(20),
    height: u32(24),
    depth: u32(28),
    layers: u32(32),
    faces: u32(36),
    supercompression: u32(44),
    levels,
    dfd,
    kvd,
    sgd,
    colorModel: dfd[12] ?? 0,
    transfer: dfd[14] ?? 0,
    channelId: (dfd[31] ?? 0) & 0x0f,
    keyValues,
  }
}

function kvEntry(key: string, value: string): Uint8Array {
  const body = Buffer.concat([Buffer.from(key, 'utf8'), Buffer.from([0]), Buffer.from(value, 'utf8'), Buffer.from([0])])
  const out = Buffer.alloc(4 + body.length + ((4 - (body.length % 4)) % 4))
  out.writeUInt32LE(body.length, 0)
  body.copy(out, 4)
  return out
}

type ZstdZlib = { zstdCompressSync?: (b: Uint8Array, o?: { params?: Record<number, number> }) => Buffer; constants: Record<string, number> }

/** Node's Zstandard (22.15+/23.8+), if this runtime has it. */
export function zstdAvailable(): boolean {
  return typeof (zlib as unknown as ZstdZlib).zstdCompressSync === 'function'
}

function zstd(data: Uint8Array, level: number): Uint8Array {
  const z = zlib as unknown as ZstdZlib
  const key = z.constants.ZSTD_c_compressionLevel
  return z.zstdCompressSync!(data, key !== undefined ? { params: { [key]: level } } : undefined)
}

/**
 * One UASTC KTX2 from single-level UASTC KTX2 files (basisu output with `-ktx2_no_zstandard`), level 0 first, each
 * level half the previous. Zstandard-supercompressed when `zstdLevel` > 0 and this Node has it.
 */
export function assembleUastcLevels(files: readonly Uint8Array[], zstdLevel = 18): Uint8Array {
  if (!files.length) throw new Error('assembleUastcLevels: no levels')
  const parsed = files.map(parseKtx2)
  const base = parsed[0]!
  parsed.forEach((p, i) => {
    if (p.colorModel !== KHR_DF_MODEL_UASTC) throw new Error(`level ${i}: not UASTC (colour model ${p.colorModel})`)
    if (p.supercompression !== SUPERCOMPRESSION.none) throw new Error(`level ${i}: supercompressed (encode with -ktx2_no_zstandard)`)
    if (p.levels.length !== 1 || p.layers > 1 || p.faces !== 1) throw new Error(`level ${i}: expected a single 2D image`)
    const w = Math.max(1, base.width >> i)
    const h = Math.max(1, base.height >> i)
    if (p.width !== w || p.height !== h) throw new Error(`level ${i} is ${p.width}x${p.height}, expected ${w}x${h}`)
    if (p.transfer !== base.transfer || p.channelId !== base.channelId) throw new Error(`level ${i}: colour space or channels differ from level 0`)
  })
  const useZstd = zstdLevel > 0 && zstdAvailable()
  const levels = parsed.map(p => {
    const raw = p.levels[0]!.data
    return { data: useZstd ? zstd(raw, zstdLevel) : raw, uncompressed: raw.byteLength }
  })
  // DFD: copied from level 0, with bytesPlane0 = 0 when supercompressed (as basisu writes it), 16 otherwise.
  const dfd = Uint8Array.from(base.dfd)
  dfd[20] = useZstd ? 0 : 16
  const kvd = kvEntry('KTXwriter', `SRO texpipe (explicit mips, basisu ${base.keyValues.get('KTXwriter') ?? '?'})`)
  const levelCount = levels.length
  const headerEnd = 80 + levelCount * 24
  const dfdOff = headerEnd
  const kvdOff = dfdOff + dfd.length
  let dataOff = kvdOff + kvd.length
  const align = useZstd ? 1 : 16
  // Level data is stored smallest first (KTX2 §3.9.7); the index stays level 0 first.
  const offsets: number[] = new Array(levelCount)
  for (let i = levelCount - 1; i >= 0; i--) {
    dataOff = Math.ceil(dataOff / align) * align
    offsets[i] = dataOff
    dataOff += levels[i]!.data.byteLength
  }
  const out = new Uint8Array(dataOff)
  const dv = new DataView(out.buffer)
  out.set(KTX2_IDENTIFIER, 0)
  const hdr = [0, 1, base.width, base.height, 0, 0, 1, levelCount, useZstd ? SUPERCOMPRESSION.zstd : SUPERCOMPRESSION.none]
  hdr.forEach((v, i) => dv.setUint32(12 + i * 4, v, true))
  dv.setUint32(48, dfdOff, true)
  dv.setUint32(52, dfd.length, true)
  dv.setUint32(56, kvdOff, true)
  dv.setUint32(60, kvd.length, true)
  dv.setBigUint64(64, 0n, true)
  dv.setBigUint64(72, 0n, true)
  levels.forEach((l, i) => {
    dv.setBigUint64(80 + i * 24, BigInt(offsets[i]!), true)
    dv.setBigUint64(88 + i * 24, BigInt(l.data.byteLength), true)
    dv.setBigUint64(96 + i * 24, BigInt(l.uncompressed), true)
    out.set(l.data, offsets[i]!)
  })
  out.set(dfd, dfdOff)
  out.set(kvd, kvdOff)
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Encoding

export interface Ktx2EncodeResult {
  output: string
  bytes: number
  width: number
  height: number
  levels: number
  codec: Ktx2Codec
  srgb: boolean
  supercompression: number
  ms: number
}

/** A PNG's size and whether it has an alpha channel (level-chain checks). */
async function pngInfo(path: string): Promise<{ size: [number, number]; alpha: boolean }> {
  const m = await sharp(path).metadata()
  return { size: [m.width ?? 0, m.height ?? 0], alpha: !!m.hasAlpha }
}

/** Encodes one PNG to KTX2 for its map role (see KTX2_PROFILES). Creates the output folder. */
export async function encodeKtx2(input: string, output: string, opts: Ktx2EncodeOptions): Promise<Ktx2EncodeResult> {
  const t0 = performance.now()
  const exe = opts.basisu ?? basisuPath()
  if (!existsSync(exe)) throw new Error(`basisu not found at ${exe} (set texpipe.basisu in sro.config.json or SRO_BASISU)`)
  const profile = { ...KTX2_PROFILES[opts.role], ...opts.profile }
  mkdirSync(dirname(resolve(output)), { recursive: true })
  if (opts.levels?.length) {
    if (profile.codec !== 'uastc') throw new Error('explicit mip levels need the UASTC codec')
    const tmp = mkdtempSync(join(tmpdir(), 'sro-ktx2-'))
    try {
      let prev: [number, number] | undefined
      let alpha: 'force' | 'none' = 'none'
      const files: Uint8Array[] = []
      for (let i = 0; i < opts.levels.length; i++) {
        const src = resolve(opts.levels[i]!)
        const info = await pngInfo(src)
        const size = info.size
        // Every level must have level 0's channels (basisu drops alpha from a level that happens to be opaque).
        if (i === 0) alpha = info.alpha ? 'force' : 'none'
        if (prev && (size[0] !== Math.max(1, prev[0] >> 1) || size[1] !== Math.max(1, prev[1] >> 1))) {
          throw new Error(`mip level ${i} (${src}) is ${size.join('x')}, expected half of ${prev.join('x')}`)
        }
        prev = size
        const out = join(tmp, `l${i}.ktx2`)
        await runBasisu(exe, basisuArgs(src, out, { role: opts.role, profile: opts.profile, mips: false, threads: opts.threads, zstd: false, alpha }))
        files.push(readFileSync(out))
      }
      writeFileSync(output, assembleUastcLevels(files, profile.zstd ?? 18))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } else {
    await runBasisu(exe, basisuArgs(resolve(input), resolve(output), { role: opts.role, profile: opts.profile, mips: opts.mips, threads: opts.threads }))
  }
  const file = readFileSync(output)
  const k = parseKtx2(file)
  return {
    output,
    bytes: file.byteLength,
    width: k.width,
    height: k.height,
    levels: k.levels.length,
    codec: k.colorModel === KHR_DF_MODEL_UASTC ? 'uastc' : 'etc1s',
    srgb: k.transfer === KHR_DF_TRANSFER_SRGB,
    supercompression: k.supercompression,
    ms: performance.now() - t0,
  }
}

export interface Ktx2Job extends Ktx2EncodeOptions {
  input: string
  output: string
}

/** Encodes jobs `concurrency` at a time (basisu itself is multithreaded; 2 keeps the CPU busy between files). */
export async function encodeKtx2Batch(jobs: readonly Ktx2Job[], concurrency = 2, onDone?: (r: Ktx2EncodeResult, i: number) => void): Promise<Ktx2EncodeResult[]> {
  const results: Ktx2EncodeResult[] = new Array(jobs.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next++
      const j = jobs[i]!
      results[i] = await encodeKtx2(j.input, j.output, j)
      onDone?.(results[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker))
  return results
}

// ---------------------------------------------------------------------------------------------------------------
// Verification: the BC7 the desktop runtime gets, compared with the source

export interface Ktx2Check {
  levels: number
  /** PSNR (dB) of level 0 transcoded to BC7, RGB and alpha, against the source PNG. */
  psnrRgb: number
  psnrAlpha: number
  /** Level 0 BC7 as RGBA (for pictures). */
  bc7: { data: Uint8Array; width: number; height: number }
}

/** PSNR in dB over the given channels of two RGBA8 buffers of one size (Infinity when identical). */
export function psnr(a: Uint8Array, b: Uint8Array, channels: readonly number[] = [0, 1, 2]): number {
  if (a.length !== b.length) throw new Error('psnr: sizes differ')
  let se = 0
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    for (const c of channels) {
      const d = a[i + c]! - b[i + c]!
      se += d * d
      n++
    }
  }
  if (se === 0) return Infinity
  return 10 * Math.log10((255 * 255) / (se / n))
}

/**
 * Transcodes a KTX2 to BC7 with basisu's own transcoder (`-unpack -format_only 6`, the UASTC → BC7 path the desktop
 * runtime uses) and compares level 0 with the source PNG.
 */
export async function checkKtx2(ktx2: string, sourcePng: string, exe = basisuPath()): Promise<Ktx2Check> {
  const tmp = mkdtempSync(join(tmpdir(), 'sro-ktx2-check-'))
  try {
    const local = join(tmp, 'x.ktx2')
    writeFileSync(local, readFileSync(ktx2))
    await runBasisu(exe, ['-unpack', '-file', 'x.ktx2', '-format_only', '6', '-no_ktx'], tmp)
    const png = readdirSync(tmp).find(f => /_unpacked_rgba_BC7_RGBA_0_0000\.png$/.test(f))
    if (!png) throw new Error(`basisu wrote no BC7 level 0 for ${ktx2}`)
    const got = await sharp(join(tmp, png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const want = await sharp(sourcePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    if (got.info.width !== want.info.width || got.info.height !== want.info.height) throw new Error('checkKtx2: size differs from the source')
    const a = new Uint8Array(got.data.buffer, got.data.byteOffset, got.data.byteLength)
    const b = new Uint8Array(want.data.buffer, want.data.byteOffset, want.data.byteLength)
    return {
      levels: parseKtx2(readFileSync(ktx2)).levels.length,
      psnrRgb: psnr(a, b, [0, 1, 2]),
      psnrAlpha: psnr(a, b, [3]),
      bc7: { data: a, width: got.info.width, height: got.info.height },
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

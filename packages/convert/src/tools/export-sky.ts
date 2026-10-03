/**
 * Exports the sky's textures for the browser game (docs/SKY.md §5.2, §10, §11 lane SKY-C; docs/WAVE_PLAN3.md §6.3).
 *   pnpm tsx packages/convert/src/tools/export-sky.ts [--out <dir>]
 *
 * Inputs: Map.pk2 sun/ and skybox/ (work/extracted/Map when the archive is unavailable).
 * Output (served at /out/sky/):
 *   <out>/sky/moon/moon01..30.png   128² photo moon phases: 01 thin waxing crescent … 16 full … 30 thin waning crescent
 *   <out>/sky/lens/lens1..8.png     flare sprites (64–256²); lens2 is the retail sun billboard (Classic sun)
 *   <out>/sky/cloud1.png            512² greyscale tileable clouds (the Low / Classic cloud layer)
 *   <out>/sky/cloud-noise.png       256² RGBA8 cloud noise (our own seeded procedural data, not a retail asset)
 *   <out>/sky/sky.json              SkyManifest: the file list, the moon count, the noise seed, version and hash
 * The optimizer turns sky/**.png into WebP in out-opt, except cloud-noise, which stays lossless (optimize/run.ts):
 * it is data, and lossy WebP breaks the coverage remap. Retail data never leaves work/.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeDds, parseDdj } from '@sro/formats'
import { loadConfig, openArchive } from '../node-io.ts'
import { encodePng } from '../png.ts'

export const MOON_COUNT = 30
/** The full moon's texture number (SKY verify; `moonState` in packages/shared/src/world-clock.ts, D33). */
export const FULL_MOON = 16
export const LENS_COUNT = 8
export const NOISE_SIZE = 256
export const NOISE_SEED = 0
/** Bump whenever the generator's output changes (the test pins the bytes' hash). */
export const NOISE_VERSION = 1

export interface SkyImage {
  file: string
  src: string
  width: number
  height: number
  format: string
}

export interface SkyManifest {
  version: 1
  generator: string
  generatedAt: string
  /** Out-relative folder of every `file` below ('sky/'). */
  root: string
  moonCount: number
  fullMoon: number
  /** moon01..moon30 in phase order, sky-relative. */
  moons: SkyImage[]
  lens: SkyImage[]
  cloud: SkyImage | null
  cloudNoise: {
    file: string
    width: number
    height: number
    seed: number
    version: number
    sha256: string
    channels: { r: string; g: string; b: string; a: string }
    /** Covered fraction of the sky at coverage 0.2 / 0.5 / 0.8, measured on the written texture. */
    coverage: Record<string, number>
  }
  failures: string[]
}

// ---- cloud noise (docs/SKY.md §5.2; ported from work/tmp/sky/cloud-noise-proto.ts: seed 0 gives its R, G and A) ----

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Tileable value noise with period px along x and py along y (smoothstep interpolation of hashed lattice values). */
function valueNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const wx = (a: number) => ((a % px) + px) % px
  const wy = (a: number) => ((a % py) + py) % py
  const a = hash2(wx(xi), wy(yi), seed)
  const b = hash2(wx(xi + 1), wy(yi), seed)
  const c = hash2(wx(xi), wy(yi + 1), seed)
  const d = hash2(wx(xi + 1), wy(yi + 1), seed)
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v
}

/** Tileable Worley (F1), inverted: 1 at the feature points. */
function worley(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  let best = 9
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i
      const cy = yi + j
      const wx = ((cx % p) + p) % p
      const wy = ((cy % p) + p) % p
      const fx = cx + hash2(wx, wy, seed) - x
      const fy = cy + hash2(wx, wy, seed + 17) - y
      best = Math.min(best, fx * fx + fy * fy)
    }
  }
  return 1 - Math.min(1, Math.sqrt(best))
}

/** Tileable fbm over [0, 1)²; `stretch` > 1 lowers the x frequency by that factor (streaks along x). */
function fbm(x: number, y: number, base: number, oct: number, seed: number, stretch = 1): number {
  let s = 0
  let a = 0.5
  let n = 0
  for (let o = 0; o < oct; o++) {
    const f = base << o
    const fx = Math.max(1, f / stretch)
    s += a * valueNoise(x * fx, y * f, fx, f, seed + o)
    n += a
    a *= 0.5
  }
  return s / n
}

/**
 * The cloud noise texture, RGBA8, tileable, deterministic for a seed (docs/SKY.md §5.2):
 * R shape (value-fbm × Worley, histogram-equalised, so coverage c covers a fraction c of the sky),
 * G detail (Worley 16/32/64, edge erosion), B cirrus streaks (fbm stretched 4:1), A low-frequency coverage variation.
 */
export function generateCloudNoise(size = NOISE_SIZE, seed = NOISE_SEED): Uint8Array {
  const n = size
  const tex = new Uint8Array(n * n * 4)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n
      const v = y / n
      const shape = 0.55 * fbm(u, v, 4, 5, seed + 1)
        + 0.45 * (0.625 * worley(u * 4, v * 4, 4, seed + 7) + 0.25 * worley(u * 8, v * 8, 8, seed + 9) + 0.125 * worley(u * 16, v * 16, 16, seed + 11))
      const detail = 0.625 * worley(u * 16, v * 16, 16, seed + 21) + 0.25 * worley(u * 32, v * 32, 32, seed + 23) + 0.125 * worley(u * 64, v * 64, 64, seed + 25)
      // The prototype's `fbm(u, v * 0.25 * 4, …)` cancelled its own stretch; 4:1 lattice periods give real streaks.
      const cirrus = fbm(u, v, 8, 4, seed + 31, 4)
      const low = fbm(u, v, 2, 3, seed + 41)
      const o = (y * n + x) * 4
      tex[o] = Math.round(Math.min(1, shape) * 255)
      tex[o + 1] = Math.round(Math.min(1, detail) * 255)
      tex[o + 2] = Math.round(cirrus * 255)
      tex[o + 3] = Math.round(low * 255)
    }
  }
  // Histogram-equalise R (stable sort, so ties keep pixel order and the result stays deterministic).
  const idx = Array.from({ length: n * n }, (_, i) => i).sort((a, b) => tex[a * 4]! - tex[b * 4]!)
  idx.forEach((pix, rank) => {
    tex[pix * 4] = Math.round((rank / (n * n - 1)) * 255)
  })
  return tex
}

/**
 * Fraction of texels the shader's coverage remap covers at coverage c (docs/SKY.md §5.3: the A variation ±0.15,
 * then `d = saturate((R − (1 − c)) / c)`; a texel counts when d > 0.02).
 */
export function noiseCoverage(rgba: Uint8Array, c: number): number {
  const n = rgba.length / 4
  let covered = 0
  for (let i = 0; i < n; i++) {
    const shape = rgba[i * 4]! / 255
    const cov = Math.min(1, Math.max(0.01, c + (rgba[i * 4 + 3]! / 255 - 0.5) * 0.3))
    if ((shape - (1 - cov)) / cov > 0.02) covered++
  }
  return covered / n
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// ---- export ----

const pad2 = (i: number) => String(i).padStart(2, '0')

/** Sky-relative output path -> Map.pk2 source path. */
export function skySources(): { file: string; src: string; kind: 'moon' | 'lens' | 'cloud' }[] {
  const out: { file: string; src: string; kind: 'moon' | 'lens' | 'cloud' }[] = []
  for (let i = 1; i <= MOON_COUNT; i++) out.push({ file: `moon/moon${pad2(i)}.png`, src: `sun/moon${pad2(i)}.ddj`, kind: 'moon' })
  for (let i = 1; i <= LENS_COUNT; i++) out.push({ file: `lens/lens${i}.png`, src: `sun/lens${i}.ddj`, kind: 'lens' })
  out.push({ file: 'cloud1.png', src: 'skybox/cloud1.ddj', kind: 'cloud' })
  return out
}

function write(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}

function main(): void {
  const args = process.argv.slice(2)
  const i = args.indexOf('--out')
  const cfg = loadConfig()
  const outDir = resolve(i >= 0 && args[i + 1] ? args[i + 1]! : join(cfg.workDir, 'out'))
  const skyDir = join(outDir, 'sky')
  const extracted = join(cfg.workDir, 'extracted', 'Map')

  let read: (src: string) => Uint8Array
  try {
    const map = openArchive('Map', cfg)
    read = src => map.read(src)
  } catch (err) {
    console.warn(`! Map.pk2 unavailable (${err instanceof Error ? err.message : String(err)}); using ${extracted}`)
    read = src => {
      const p = join(extracted, ...src.split('/'))
      if (!existsSync(p)) throw new Error(`not in ${extracted}`)
      return readFileSync(p)
    }
  }

  const failures: string[] = []
  const moons: SkyImage[] = []
  const lens: SkyImage[] = []
  let cloud: SkyImage | null = null
  for (const s of skySources()) {
    try {
      const img = decodeDds(parseDdj(read(s.src)).dds)
      write(join(skyDir, ...s.file.split('/')), encodePng(img.width, img.height, img.rgba))
      const entry: SkyImage = { file: s.file, src: `Map.pk2 ${s.src}`, width: img.width, height: img.height, format: img.format }
      if (s.kind === 'moon') moons.push(entry)
      else if (s.kind === 'lens') lens.push(entry)
      else cloud = entry
    } catch (err) {
      failures.push(`${s.src}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const t0 = performance.now()
  const noise = generateCloudNoise()
  const noiseMs = performance.now() - t0
  write(join(skyDir, 'cloud-noise.png'), encodePng(NOISE_SIZE, NOISE_SIZE, noise))
  const coverage = Object.fromEntries([0.2, 0.5, 0.8].map(c => [String(c), Math.round(noiseCoverage(noise, c) * 1000) / 1000]))

  const manifest: SkyManifest = {
    version: 1,
    generator: 'packages/convert/src/tools/export-sky.ts',
    generatedAt: new Date().toISOString(),
    root: 'sky/',
    moonCount: moons.length,
    fullMoon: FULL_MOON,
    moons,
    lens,
    cloud,
    cloudNoise: {
      file: 'cloud-noise.png',
      width: NOISE_SIZE,
      height: NOISE_SIZE,
      seed: NOISE_SEED,
      version: NOISE_VERSION,
      sha256: sha256(noise),
      channels: { r: 'shape (equalised)', g: 'detail (erosion)', b: 'cirrus streaks', a: 'coverage variation' },
      coverage,
    },
    failures,
  }
  write(join(skyDir, 'sky.json'), JSON.stringify(manifest, null, 2))
  console.log(`sky: ${moons.length} moons, ${lens.length} lens sprites, ${cloud ? 1 : 0} cloud layer, cloud noise ${NOISE_SIZE}² in ${noiseMs.toFixed(0)} ms (coverage ${Object.entries(coverage).map(([c, f]) => `${c}: ${f}`).join(', ')}) -> ${skyDir}`)
  for (const f of failures) console.warn(`  ! ${f}`)
  if (failures.length) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

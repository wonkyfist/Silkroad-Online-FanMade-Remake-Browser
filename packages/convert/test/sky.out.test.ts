/**
 * Checks a finished sky export (work/out/sky, from `pnpm tsx packages/convert/src/tools/export-sky.ts`) and, when it
 * exists, its optimized copy (work/out-opt/sky) against docs/WAVE_PLAN3.md §6.3. Skips when sky.json is missing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/node-io.ts'
import { decodeRgba } from '../src/optimize/texture.ts'
import { FULL_MOON, generateCloudNoise, MOON_COUNT, noiseCoverage, sha256, type SkyManifest } from '../src/tools/export-sky.ts'

const OUT = join(REPO_ROOT, 'work', 'out', 'sky')
const OPT = join(REPO_ROOT, 'work', 'out-opt', 'sky')
const HAS = existsSync(join(OUT, 'sky.json'))
const HAS_OPT = existsSync(join(OPT, 'sky.json'))
const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'sky.json'), 'utf8')) as SkyManifest

/** Lit area of a moon sprite: mean of luminance × alpha. */
async function litArea(file: string): Promise<number> {
  const img = await decodeRgba(readFileSync(file))
  let sum = 0
  for (let p = 0; p < img.data.length; p += 4) sum += ((img.data[p]! + img.data[p + 1]! + img.data[p + 2]!) / 765) * (img.data[p + 3]! / 255)
  return sum / (img.width * img.height)
}

describe.skipIf(!HAS)('work/out/sky', () => {
  const m = HAS ? readManifest(OUT) : (null as unknown as SkyManifest)

  it('has 30 moons at 128², 8 flares and the cloud layer, with no failures', async () => {
    expect(m.failures).toEqual([])
    expect(m.moonCount).toBe(MOON_COUNT)
    expect(m.fullMoon).toBe(FULL_MOON)
    expect(m.moons.map(x => x.file)).toEqual(Array.from({ length: 30 }, (_, i) => `moon/moon${String(i + 1).padStart(2, '0')}.png`))
    for (const x of m.moons) {
      const img = await decodeRgba(readFileSync(join(OUT, x.file)))
      expect([x.width, x.height, img.width, img.height], x.file).toEqual([128, 128, 128, 128])
    }
    expect(m.lens).toHaveLength(8)
    for (const x of m.lens) expect(existsSync(join(OUT, x.file)), x.file).toBe(true)
    expect([m.cloud?.width, m.cloud?.height]).toEqual([512, 512])
  })

  it('the phases wax to a full moon16 and wane after it', async () => {
    const lit = await Promise.all(m.moons.map(x => litArea(join(OUT, x.file))))
    expect(lit.indexOf(Math.max(...lit)) + 1).toBe(FULL_MOON)
    expect(lit[0]!).toBeLessThan(lit[7]!)
    expect(lit[7]!).toBeLessThan(lit[FULL_MOON - 1]!)
    expect(lit[22]!).toBeLessThan(lit[FULL_MOON - 1]!)
    expect(lit[29]!).toBeLessThan(lit[22]!)
  })

  it('cloud-noise.png is the generator output the manifest names', async () => {
    const img = await decodeRgba(readFileSync(join(OUT, m.cloudNoise.file)))
    expect(sha256(img.data)).toBe(m.cloudNoise.sha256)
    expect(m.cloudNoise.sha256).toBe(sha256(generateCloudNoise(m.cloudNoise.width, m.cloudNoise.seed)))
  })
})

describe.skipIf(!HAS_OPT)('work/out-opt/sky', () => {
  const m = HAS_OPT ? readManifest(OPT) : (null as unknown as SkyManifest)

  it('names only WebP files that exist', () => {
    const files = [...m.moons, ...m.lens, ...(m.cloud ? [m.cloud] : [])].map(x => x.file).concat(m.cloudNoise.file)
    expect(files).toHaveLength(40)
    for (const f of files) {
      expect(f, f).toMatch(/\.webp$/)
      expect(existsSync(join(OPT, f)), f).toBe(true)
    }
  })

  it('the cloud noise survived bit-exact: coverage 0.2 / 0.5 / 0.8 ± 0.02', async () => {
    const img = await decodeRgba(readFileSync(join(OPT, m.cloudNoise.file)))
    expect(sha256(img.data)).toBe(m.cloudNoise.sha256)
    for (const c of [0.2, 0.5, 0.8]) expect(Math.abs(noiseCoverage(img.data, c) - c), `coverage ${c}`).toBeLessThanOrEqual(0.02)
  })
})

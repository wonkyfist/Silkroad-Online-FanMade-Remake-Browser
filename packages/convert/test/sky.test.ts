/**
 * Sky assets (packages/convert/src/tools/export-sky.ts, docs/SKY.md §5.2, docs/WAVE_PLAN3.md §6.3): the seeded cloud
 * noise (deterministic bytes, coverage fractions, tiling) and the optimizer's sky rule (sky/**.png -> WebP, the
 * noise lossless), on synthetic inputs only. The real export is checked by sky.out.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { decodeRgba } from '../src/optimize/texture.ts'
import { optimizeOut, webpLadder, webpRename } from '../src/optimize/run.ts'
import { encodePng } from '../src/png.ts'
import { generateCloudNoise, NOISE_SIZE, noiseCoverage, sha256, skySources } from '../src/tools/export-sky.ts'

/** sha256 of generateCloudNoise() at seed 0, NOISE_VERSION 1. Changing the generator means bumping NOISE_VERSION. */
const NOISE_SHA256 = 'c4bacd2cd916f5f0ae3c007ba0046c831f8f3c93a91c84cda56b1b43ed563222'

const noise = generateCloudNoise()

describe('cloud noise', () => {
  it('is deterministic: the same bytes every run, pinned by hash', () => {
    expect(noise.length).toBe(NOISE_SIZE * NOISE_SIZE * 4)
    expect(sha256(generateCloudNoise())).toBe(sha256(noise))
    expect(sha256(noise)).toBe(NOISE_SHA256)
    expect(sha256(generateCloudNoise(NOISE_SIZE, 1))).not.toBe(NOISE_SHA256)
  })

  it('covers 0.2 / 0.5 / 0.8 of the sky at coverage 0.2 / 0.5 / 0.8 (± 0.02)', () => {
    for (const c of [0.2, 0.5, 0.8]) expect(Math.abs(noiseCoverage(noise, c) - c), `coverage ${c}`).toBeLessThanOrEqual(0.02)
  })

  it('tiles: the wrap seam is no rougher than any other neighbouring row or column', () => {
    const n = NOISE_SIZE
    const at = (x: number, y: number, ch: number) => noise[(y * n + x) * 4 + ch]!
    for (let ch = 0; ch < 4; ch++) {
      let inner = 0
      let seamX = 0
      let seamY = 0
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < n - 1; k++) inner += Math.abs(at(k, i, ch) - at(k + 1, i, ch)) + Math.abs(at(i, k, ch) - at(i, k + 1, ch))
        seamX += Math.abs(at(n - 1, i, ch) - at(0, i, ch))
        seamY += Math.abs(at(i, n - 1, ch) - at(i, 0, ch))
      }
      const mean = inner / (2 * n * (n - 1))
      expect(seamX / n, `channel ${ch} x seam`).toBeLessThan(mean * 1.5 + 1)
      expect(seamY / n, `channel ${ch} y seam`).toBeLessThan(mean * 1.5 + 1)
    }
  })
})

describe('export plan', () => {
  it('lists 30 moons in phase order, 8 flares and the retail cloud layer', () => {
    const s = skySources()
    const moons = s.filter(x => x.kind === 'moon')
    expect(moons).toHaveLength(30)
    expect(moons[0]).toEqual({ file: 'moon/moon01.png', src: 'sun/moon01.ddj', kind: 'moon' })
    expect(moons[15]!.file).toBe('moon/moon16.png')
    expect(moons[29]!.file).toBe('moon/moon30.png')
    expect(s.filter(x => x.kind === 'lens').map(x => x.file)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(i => `lens/lens${i}.png`))
    expect(s.filter(x => x.kind === 'cloud')).toEqual([{ file: 'cloud1.png', src: 'skybox/cloud1.ddj', kind: 'cloud' }])
  })
})

describe('optimizer sky rule', () => {
  it('renames world/ and sky/ images, and only the cloud noise skips the lossy ladder', () => {
    expect(webpRename('sky/moon/moon16.png')).toBe('sky/moon/moon16.webp')
    expect(webpRename('sky/cloud-noise.png')).toBe('sky/cloud-noise.webp')
    expect(webpRename('world/jangan/tiles/t.png')).toBe('world/jangan/tiles/t.webp')
    expect(webpRename('world/jangan-fields/coast/field.png')).toBeNull()
    expect(webpRename('ui/frame/a.png')).toBeNull()
    expect(webpRename('sky/sky.json')).toBeNull()
    expect(webpLadder('sky/cloud-noise.png')).toEqual([])
    expect(webpLadder('sky/cloud1.png')).toBeUndefined()
    expect(webpLadder('world/jangan/tiles/t.png')).toBeUndefined()
  })

  const tmp = mkdtempSync(join(tmpdir(), 'sro-sky-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('out-opt keeps the noise bit-exact (coverage still 0.2 / 0.5 / 0.8) and rewrites sky.json', async () => {
    const inDir = join(tmp, 'out')
    const outDir = join(tmp, 'out-opt')
    mkdirSync(join(inDir, 'sky', 'moon'), { recursive: true })
    writeFileSync(join(inDir, 'sky', 'cloud-noise.png'), encodePng(NOISE_SIZE, NOISE_SIZE, noise))
    const w = 32
    const moon = new Uint8Array(w * w * 4)
    for (let i = 0; i < w * w; i++) {
      const x = i % w - w / 2
      const y = Math.floor(i / w) - w / 2
      const v = x * x + y * y < (w / 2 - 2) ** 2 ? 200 + ((x * 7 + y * 3) & 31) : 0
      moon.set([v, v, v, v ? 255 : 0], i * 4)
    }
    writeFileSync(join(inDir, 'sky', 'moon', 'moon01.png'), encodePng(w, w, moon))
    writeFileSync(join(inDir, 'sky', 'sky.json'), JSON.stringify({ moons: [{ file: 'moon/moon01.png' }], cloudNoise: { file: 'cloud-noise.png' } }))

    const report = await optimizeOut({ inDir, outDir, noCensus: true })
    expect(report.renamed).toBe(2)
    expect(report.textures.find(t => t.file === 'sky/cloud-noise.png')?.quality).toBe('lossless')
    expect(existsSync(join(outDir, 'sky', 'cloud-noise.png'))).toBe(false)
    expect(existsSync(join(outDir, 'sky', 'moon', 'moon01.webp'))).toBe(true)
    const back = await decodeRgba(readFileSync(join(outDir, 'sky', 'cloud-noise.webp')))
    expect([back.width, back.height]).toEqual([NOISE_SIZE, NOISE_SIZE])
    expect(sha256(back.data)).toBe(NOISE_SHA256)
    for (const c of [0.2, 0.5, 0.8]) expect(Math.abs(noiseCoverage(back.data, c) - c)).toBeLessThanOrEqual(0.02)
    const sky = JSON.parse(readFileSync(join(outDir, 'sky', 'sky.json'), 'utf8')) as { moons: { file: string }[]; cloudNoise: { file: string } }
    expect(sky.moons[0]!.file).toBe('moon/moon01.webp')
    expect(sky.cloudNoise.file).toBe('cloud-noise.webp')
  }, 60_000)
})

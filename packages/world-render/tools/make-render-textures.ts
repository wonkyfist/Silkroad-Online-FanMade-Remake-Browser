/**
 * Writes the renderer's own textures (docs/RENDER.md §5.2, §7; docs/WAVE_PLAN3.md §6.13; our art, nothing retail) to
 * apps/game/public/render/:
 *
 * - `luts/<time>_<weather>.png`: the twelve grade keys as 32 × 1024 RGBA strips (slice b stacked vertically, pixel
 *   (r, b·32 + g)), made from the colour-balance parameters in src/render/grade.ts. The runtime builds the same keys
 *   in memory, so these files are the editable copies (`loadLutStrips` replaces a key with its file).
 * - `water-normal.png`: a 256² tileable tangent-space normal map (+Z up, OpenGL green-up) from a sum of periodic
 *   waves, for the PBR water (RND-W).
 *
 * Ripples are not made here: the weather's CPU ripple texture is the one ripple source (D21).
 *
 * Run: pnpm tsx packages/world-render/tools/make-render-textures.ts [--out <dir>]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePng } from '../../convert/src/png.ts'
import { LUT_KEYS, LUT_SIZE, builtinLutStrip } from '../src/render/grade.ts'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))

/** A small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A tileable water normal map: height = Σ a·sin(2π(k·p) + φ) with integer wave vectors k (so every wave repeats over
 * the tile), amplitudes falling with frequency; the normal is the analytic gradient.
 */
export function makeWaterNormal(size = 256, seed = 7, waves = 40, strength = 0.8): Uint8Array {
  const rand = rng(seed)
  const list: Array<{ kx: number; ky: number; a: number; ph: number }> = []
  for (let i = 0; i < waves; i++) {
    const f = 1 + Math.floor(Math.pow(rand(), 1.6) * 14)
    const ang = rand() * Math.PI * 2
    const kx = Math.round(Math.cos(ang) * f), ky = Math.round(Math.sin(ang) * f)
    if (kx === 0 && ky === 0) continue
    list.push({ kx, ky, a: 1 / Math.pow(Math.hypot(kx, ky), 1.3), ph: rand() * Math.PI * 2 })
  }
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size
      let gx = 0, gy = 0
      for (const w of list) {
        const c = Math.cos(2 * Math.PI * (w.kx * u + w.ky * v) + w.ph) * w.a * 2 * Math.PI
        gx += c * w.kx
        gy += c * w.ky
      }
      // Scale to a gentle surface (the sum's slope is ~O(10) per tile unit).
      const sx = -gx * strength / size * 8, sy = -gy * strength / size * 8
      const l = Math.hypot(sx, sy, 1)
      const o = (y * size + x) * 4
      out[o] = Math.round((sx / l * 0.5 + 0.5) * 255)
      // Image rows go down; OpenGL green-up normals point +v up the image.
      out[o + 1] = Math.round((-sy / l * 0.5 + 0.5) * 255)
      out[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255)
      out[o + 3] = 255
    }
  }
  return out
}

function main(): void {
  const args = process.argv.slice(2)
  const i = args.indexOf('--out')
  const out = i >= 0 && args[i + 1] ? resolve(args[i + 1]!) : join(REPO, 'apps/game/public/render')
  mkdirSync(join(out, 'luts'), { recursive: true })
  for (const key of LUT_KEYS) {
    writeFileSync(join(out, 'luts', `${key}.png`), encodePng(LUT_SIZE, LUT_SIZE * LUT_SIZE, builtinLutStrip(key)))
  }
  writeFileSync(join(out, 'water-normal.png'), encodePng(256, 256, makeWaterNormal()))
  console.log(`[render-textures] ${LUT_KEYS.length} LUT strips and water-normal.png → ${out}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

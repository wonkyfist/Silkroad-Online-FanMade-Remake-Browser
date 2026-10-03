/**
 * Clouds on the CPU (docs/SKY.md §5): the cloud layer geometry (a curved shell 1.8 km up, 9 km per noise tile), the
 * wind drift, and the same density the dome shader computes, sampled from the decoded cloud-noise PNG, so the key
 * light dims when a cloud crosses the sun (1–3 bilinear samples per frame) and the ground's cloud shadow lines up with
 * the clouds overhead. Pure.
 *
 * cloud-noise.png channels (SKY-C, work/out/sky/sky.json): R shape (histogram-equalised, so the coverage remap covers
 * exactly the fraction c), G detail (erosion), B cirrus streaks, A low-frequency coverage variation.
 */

/** Cumulus shell height (km) and the world size of one noise tile (km). */
export const CLOUD_HEIGHT_KM = 1.8
export const CLOUD_SCALE_KM = 9
/** Cirrus shell and tile (km). */
export const CIRRUS_HEIGHT_KM = 8
export const CIRRUS_SCALE_KM = 25
/** Clouds drift at the wind speed × this (SKY §5.5: the wind at cloud height). */
export const CLOUD_DRIFT = 1.5
/** Earth radius used for the shell's curvature (km). */
const EARTH_KM = 6360

/** RGBA8 noise, row 0 first (DecodedImage). */
export interface CloudNoise {
  width: number
  height: number
  data: Uint8Array
}

/**
 * Horizontal distance (km) from the camera to a shell `heightKm` up along a ray of elevation sine `sinEl`, the shell
 * following the Earth (h(d) = H − d² / 2R), so clouds sink toward the horizon. Stable at the zenith.
 */
export function shellDistance(sinEl: number, heightKm = CLOUD_HEIGHT_KM): number {
  const s = Math.max(0, Math.min(1, sinEl))
  const tan = s / Math.max(Math.sqrt(1 - s * s), 1e-4)
  return (2 * heightKm) / (tan + Math.sqrt(tan * tan + (2 * heightKm) / EARTH_KM))
}

/** Bilinear, wrapped sample of one channel (0..1). */
export function sampleNoise(n: CloudNoise, u: number, v: number, channel: number): number {
  const W = n.width, H = n.height
  const fx = (u - Math.floor(u)) * W - 0.5
  const fy = (v - Math.floor(v)) * H - 0.5
  const x0 = Math.floor(fx), y0 = Math.floor(fy)
  const ax = fx - x0, ay = fy - y0
  const xa = ((x0 % W) + W) % W, xb = (xa + 1) % W
  const ya = ((y0 % H) + H) % H, yb = (ya + 1) % H
  const d = n.data
  const p = (x: number, y: number) => d[(y * W + x) * 4 + channel]! / 255
  return ((p(xa, ya) * (1 - ax) + p(xb, ya) * ax) * (1 - ay) + (p(xa, yb) * (1 - ax) + p(xb, yb) * ax) * ay)
}

/** The coverage remap of SKY §5.2: a fraction `cover` of the sky has density > 0. */
export function coverageRemap(r: number, cover: number): number {
  const c = Math.max(1e-3, Math.min(1, cover))
  return Math.max(0, Math.min(1, (r - (1 - c)) / c))
}

/** Cumulus density at noise uv (u, v) for `cover` (SKY §5.3, the dome shader's formula without the detail octave). */
export function cloudDensity(n: CloudNoise, u: number, v: number, cover: number): number {
  // The patchiness fades out toward a full cover, so an overcast sky closes.
  const cov = Math.max(1e-3, Math.min(1, cover + (sampleNoise(n, u * 0.25, v * 0.25, 3) - 0.5) * 0.3 * (1 - cover)))
  const shape = coverageRemap(sampleNoise(n, u, v, 0), cov)
  const det = sampleNoise(n, u * 6.3, v * 6.3, 1)
  return Math.max(0, Math.min(1, shape - (1 - det) * 0.35 * (1 - shape)))
}

/** Opacity of a cloud of density `dens` and thickness (1 fair .. 2 rain clouds). */
export const cloudAlpha = (dens: number, thickness: number): number => 1 - Math.exp(-dens * 6 * thickness)

/** Cloud thickness from the weather's darkness (rain clouds are thicker). */
export const cloudThickness = (darkness: number): number => 1 + Math.max(0, Math.min(1, darkness))

/**
 * The drifting cloud layer: the noise uv offset (wrapped to 0..1 so it keeps its precision) and the queries that use
 * it. `noise` is null until the PNG is decoded (then nothing occludes).
 */
export class CloudLayer {
  noise: CloudNoise | null = null
  /** uv offset of the cumulus tile (the cirrus uses half of it). */
  offsetU = 0.137
  offsetV = 0.421

  /** Moves the clouds with the wind (m/s, glTF xz) over `dt` seconds. */
  drift(windX: number, windZ: number, dt: number): void {
    const k = (CLOUD_DRIFT * dt) / (CLOUD_SCALE_KM * 1000)
    this.offsetU = frac(this.offsetU + windX * k)
    this.offsetV = frac(this.offsetV + windZ * k)
  }

  /** Noise uv of the cumulus shell point above world (x, z) metres, projected along the light (lx, ly, lz). */
  uvAlong(x: number, y: number, z: number, lx: number, ly: number, lz: number, out: [number, number]): [number, number] {
    const k = (CLOUD_HEIGHT_KM * 1000 - y) / Math.max(ly, 0.1)
    out[0] = (x + lx * k) / (CLOUD_SCALE_KM * 1000) + this.offsetU
    out[1] = (z + lz * k) / (CLOUD_SCALE_KM * 1000) + this.offsetV
    return out
  }

  /**
   * Opacity of the cloud between world point (x, y, z) and a light in direction (lx, ly, lz) (0 = clear): 0 with no
   * noise yet or a light below 2° (the shell projection runs off to the horizon there).
   */
  occlusion(x: number, y: number, z: number, lx: number, ly: number, lz: number, cover: number, darkness: number): number {
    if (!this.noise || !(ly > 0.035) || !(cover > 0)) return 0
    const uv = this.uvAlong(x, y, z, lx, ly, lz, [0, 0])
    const d = cloudDensity(this.noise, uv[0], uv[1], cover)
    return cloudAlpha(d, cloudThickness(darkness))
  }
}

const frac = (v: number) => v - Math.floor(v)

/** Decodes the four channels' coverage fraction at `cover` (tests, SKY-C's sky.json numbers). */
export function coverageFraction(n: CloudNoise, cover: number): number {
  let hit = 0
  const px = n.width * n.height
  for (let i = 0; i < px; i++) if (coverageRemap(n.data[i * 4]! / 255, cover) > 0) hit++
  return hit / px
}

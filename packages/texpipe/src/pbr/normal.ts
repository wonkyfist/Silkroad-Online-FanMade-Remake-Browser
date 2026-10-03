/**
 * TP-P normals (docs/TEXPIPE.md §3.7): tangent space, glTF/OpenGL convention (+X right, +Y up the image, +Z out).
 *
 *   g  = Sobel(H) / 8                     ≈ ∂H/∂x, ∂H/∂y per texel (exact on a quadratic)
 *   gm = Sobel(blur(H, 2s)) / 8           the medium scale
 *   F  = 2 · s · strength                 s = master texels per source texel
 *   n  = normalize(−F (0.5 gx + 1.5 gmx), +F (0.5 gy + 1.5 gmy), 1)       (image y grows down, +Y points up)
 *
 * TEXPIPE's `k = strength · 4 · 512 / w` on the raw Sobel is the same slope on a 4× 2048 master (s = 4) and made a
 * 1024 master (the wall, the bark) twice as steep, which the prototype review called "lumpy"; with F ∝ s the slope
 * per source texel no longer depends on the master size.
 *
 * On atlases the Sobel reads only the texel's own region: a neighbour in another island or the gutter is replaced by
 * the centre value, so an island border is not a cliff. `udn` blends a detail normal over a macro normal (DETAIL L3).
 * Pure.
 */
import { img, regionBlur, type Img, type Regions, type Wrap } from './image.ts'

/** Sobel gradients / 8 of a one-channel image (region- and wrap-aware). Returns [gx, gy] per texel. */
export function sobel(H: Img, wrap: Wrap, regions: Regions | null): [Float32Array, Float32Array] {
  const { w, h } = H
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h)
  const ids = regions?.ids ?? null
  const d = H.d
  const col = (x: number) => (x < 0 || x >= w ? (wrap[0] ? (x + w) % w : x < 0 ? 0 : w - 1) : x)
  const row = (y: number) => (y < 0 || y >= h ? (wrap[1] ? (y + h) % h : y < 0 ? 0 : h - 1) : y) * w
  let own = 0, c = 0
  const at = (q: number): number => (ids && ids[q] !== own ? c : d[q]!)
  for (let y = 0; y < h; y++) {
    const ru = row(y - 1), rc = y * w, rd = row(y + 1)
    for (let x = 0; x < w; x++) {
      const p = rc + x
      c = d[p]!
      own = ids ? ids[p]! : 0
      const xl = col(x - 1), xr = col(x + 1)
      const tl = at(ru + xl), t = at(ru + x), tr = at(ru + xr)
      const l = at(rc + xl), r = at(rc + xr)
      const bl = at(rd + xl), b = at(rd + x), br = at(rd + xr)
      gx[p] = (tr + 2 * r + br - tl - 2 * l - bl) / 8
      gy[p] = (bl + 2 * b + br - tl - 2 * t - tr) / 8
    }
  }
  return [gx, gy]
}

/** The two-scale normal map (3 channels, unit vectors) of a height map. */
export function normalFromHeight(H: Img, strength: number, scale: number, wrap: Wrap, regions: Regions | null): Img {
  const { w, h } = H
  const [fx, fy] = sobel(H, wrap, regions)
  const [mx, my] = sobel(regionBlur(H, 2 * scale, wrap, regions), wrap, regions)
  const F = 2 * scale * strength
  const out = img(w, h, 3)
  for (let p = 0; p < w * h; p++) {
    const nx = -F * (0.5 * fx[p]! + 1.5 * mx[p]!), ny = F * (0.5 * fy[p]! + 1.5 * my[p]!)
    const l = Math.hypot(nx, ny, 1)
    out.d[p * 3] = nx / l
    out.d[p * 3 + 1] = ny / l
    out.d[p * 3 + 2] = 1 / l
  }
  return out
}

/** Whiteout / UDN blend of a detail normal over a base normal: normalize(n1.xy + n2.xy, n1.z · n2.z). */
export function udn(base: Img, detail: Float32Array, only?: (p: number) => boolean): Img {
  const out = img(base.w, base.h, 3)
  out.d.set(base.d)
  for (let p = 0; p < base.w * base.h; p++) {
    if (only && !only(p)) continue
    const x = base.d[p * 3]! + detail[p * 3]!, y = base.d[p * 3 + 1]! + detail[p * 3 + 1]!, z = base.d[p * 3 + 2]! * detail[p * 3 + 2]!
    const l = Math.hypot(x, y, z) || 1
    out.d[p * 3] = x / l
    out.d[p * 3 + 1] = y / l
    out.d[p * 3 + 2] = z / l
  }
  return out
}

/** Angle in degrees between two unit normals stored at texel p of two 3-channel images. */
export function angleDeg(a: Img, b: Img, p: number): number {
  const d = a.d[p * 3]! * b.d[p * 3]! + a.d[p * 3 + 1]! * b.d[p * 3 + 1]! + a.d[p * 3 + 2]! * b.d[p * 3 + 2]!
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI
}

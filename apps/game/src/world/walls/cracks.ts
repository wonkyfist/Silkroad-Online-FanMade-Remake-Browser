/**
 * Siege of Jangan, layer 2: the crack decals' art (docs/SIEGE.md §2.2 "two stages of cracks"), painted once at run time
 * (nothing downloaded or exported). Dark art on a transparent background, alpha-blended over the stone and lit like it
 * (dressing.ts), so only the cracks, stains and broken pockets cover the wall.
 *
 * - `crackPaths(seed, level)`: pure, seeded polylines in a unit square: a main fissure that wanders down the face with
 *   branches; level 2 is wider, longer, with more branches and broken-out pockets (spalls) where bricks fell away.
 * - `paintCracks(ctx, size, level, seed)`: draws them: a soft stain around each fissure, the dark gap tapering along
 *   its length, and the spalls as dark-rimmed hollows. Four variants side by side (an atlas row); a decal picks one.
 */
import { mulberry32 } from '@sro/shared'

export interface CrackLine {
  /** Points in [0, 1]² (y down). */
  pts: [number, number][]
  /** Width at the start, in units of the texture size. */
  width: number
}

export interface Spall {
  /** Polygon in [0, 1]². */
  pts: [number, number][]
}

export interface CrackArt {
  lines: CrackLine[]
  spalls: Spall[]
}

/** Variants per atlas (side by side). */
export const CRACK_VARIANTS = 4

export function crackPaths(seed: number, level: 1 | 2): CrackArt {
  const rnd = mulberry32(seed >>> 0)
  const lines: CrackLine[] = []
  const spalls: Spall[] = []
  // a brick wall cracks along its mortar: down a course, along the bed joint, down again (the stair-step crack); the
  // course and brick sizes are the wall's own at a ≈ 10 m decal (cj_wall01: 0.22 m courses, 1.3 m bricks)
  const course = 0.022, brick = 0.12
  const walk = (x: number, y: number, drift: number, len: number, width: number, depth: number) => {
    const pts: [number, number][] = [[x, y]]
    let travelled = 0
    while (travelled < len) {
      // down one or two courses (a little ragged: the crack breaks through a brick now and then)
      const dy = course * (1 + Math.floor(rnd() * 2))
      const dxDown = (rnd() - 0.5) * course * 0.8
      x += dxDown
      y += dy
      pts.push([x, y])
      // along the bed joint, mostly in the drift's direction
      const dir = rnd() < 0.78 ? drift : -drift
      const dx = dir * brick * (0.15 + rnd() * 0.45)
      x += dx
      y += (rnd() - 0.5) * course * 0.25
      pts.push([x, y])
      travelled += dy + Math.abs(dx) * 0.6
      if (x < 0.03 || x > 0.97 || y > 0.97) break
      if (depth < (level === 2 ? 3 : 2) && rnd() < (level === 2 ? 0.2 : 0.1)) {
        walk(x, y, rnd() < 0.5 ? -1 : 1, len * (0.2 + rnd() * 0.3), width * 0.55, depth + 1)
      }
    }
    if (pts.length > 1) lines.push({ pts, width })
  }
  const mains = level === 2 ? 2 + Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 2)
  for (let m = 0; m < mains; m++) {
    walk(0.2 + rnd() * 0.6, 0.02 + rnd() * 0.2, rnd() < 0.5 ? -1 : 1, level === 2 ? 0.8 + rnd() * 0.15 : 0.45 + rnd() * 0.3, level === 2 ? 0.013 : 0.007, 0)
  }
  if (level === 2) {
    // pockets where a few bricks fell out, on the main fissures: a ragged stack of courses, each a little offset
    const n = 1 + Math.floor(rnd() * 3)
    for (let i = 0; i < n && lines.length; i++) {
      const l = lines[Math.floor(rnd() * Math.min(lines.length, 3))]!
      const [cx, cy] = l.pts[Math.floor(rnd() * l.pts.length)]!
      const rows = 2 + Math.floor(rnd() * 3)
      const left: [number, number][] = []
      const right: [number, number][] = []
      for (let r = 0; r <= rows; r++) {
        const y = cy + (r - rows / 2) * course
        const half = brick * (0.25 + rnd() * 0.4) * (r === 0 || r === rows ? 0.6 : 1)
        const off = (rnd() - 0.5) * brick * 0.3
        left.push([cx + off - half, y])
        right.push([cx + off + half, y])
      }
      spalls.push({ pts: [...left, ...right.reverse()] })
    }
  }
  return { lines, spalls }
}

/**
 * Paints `CRACK_VARIANTS` variants of `level` side by side into a `size·4 × size` canvas context (transparent = the
 * stone shows).
 */
export function paintCracks(c: CanvasRenderingContext2D, size: number, level: 1 | 2, seed: number): void {
  c.clearRect(0, 0, size * CRACK_VARIANTS, size)
  c.lineCap = 'round'
  c.lineJoin = 'round'
  for (let v = 0; v < CRACK_VARIANTS; v++) {
    const art = crackPaths(seed + v * 7919, level)
    const ox = v * size
    const P = (p: [number, number]) => [ox + p[0] * size, p[1] * size] as const
    c.save()
    c.beginPath()
    c.rect(ox, 0, size, size)
    c.clip()
    // stain and dust around the fissures (damp, soot): a soft wide darkening
    c.filter = `blur(${Math.round(size / 96)}px)`
    for (const l of art.lines) {
      c.strokeStyle = level === 2 ? 'rgba(34,28,22,0.26)' : 'rgba(40,34,28,0.16)'
      c.lineWidth = l.width * size * 3.5
      stroke(c, l.pts.map(P))
    }
    for (const s of art.spalls) {
      c.fillStyle = 'rgba(30,26,22,0.4)'
      fill(c, s.pts.map((p) => P([p[0] + (p[0] - centre(s.pts)[0]) * 0.35, p[1] + (p[1] - centre(s.pts)[1]) * 0.35])))
    }
    c.filter = 'none'
    // spalls: a hollow where bricks broke out (the rammed core, brown-grey), darker at the rim
    for (const s of art.spalls) {
      c.fillStyle = 'rgba(46,38,30,0.62)'
      fill(c, s.pts.map(P))
      c.strokeStyle = 'rgba(16,13,10,0.9)'
      c.lineWidth = Math.max(1.2, size / 220)
      stroke(c, [...s.pts, s.pts[0]!].map(P))
    }
    // the fissures: dark, tapering along their length
    for (const l of art.lines) {
      const n = l.pts.length
      for (let i = 0; i + 1 < n; i++) {
        const k = 1 - (i / n) * 0.6
        c.strokeStyle = 'rgba(14,11,9,0.95)'
        c.lineWidth = Math.max(1.2, l.width * size * k)
        stroke(c, [P(l.pts[i]!), P(l.pts[i + 1]!)])
      }
    }
    c.restore()
  }
}

function centre(pts: [number, number][]): [number, number] {
  let x = 0, y = 0
  for (const p of pts) {
    x += p[0]
    y += p[1]
  }
  return [x / pts.length, y / pts.length]
}

function stroke(c: CanvasRenderingContext2D, pts: readonly (readonly [number, number])[]): void {
  c.beginPath()
  c.moveTo(pts[0]![0], pts[0]![1])
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i]![0], pts[i]![1])
  c.stroke()
}

function fill(c: CanvasRenderingContext2D, pts: readonly (readonly [number, number])[]): void {
  c.beginPath()
  c.moveTo(pts[0]![0], pts[0]![1])
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i]![0], pts[i]![1])
  c.closePath()
  c.fill()
}

/** A wood texture for the scaffold timber: planks of warm grey-brown with grain lines and knots (white-ish = lit). */
export function paintWood(c: CanvasRenderingContext2D, w: number, h: number, seed: number): void {
  const rnd = mulberry32(seed >>> 0)
  c.fillStyle = 'rgb(122,98,72)'
  c.fillRect(0, 0, w, h)
  for (let i = 0; i < 70; i++) {
    const y = rnd() * h
    const shade = 80 + Math.floor(rnd() * 70)
    c.strokeStyle = `rgba(${shade},${Math.floor(shade * 0.78)},${Math.floor(shade * 0.55)},0.55)`
    c.lineWidth = 0.6 + rnd() * 1.8
    c.beginPath()
    c.moveTo(0, y)
    for (let x = 0; x <= w; x += w / 8) c.lineTo(x, y + Math.sin(x * 0.05 + i) * 1.5 + (rnd() - 0.5) * 1.2)
    c.stroke()
  }
  for (let i = 0; i < 4; i++) {
    c.fillStyle = 'rgba(60,42,28,0.7)'
    c.beginPath()
    c.ellipse(rnd() * w, rnd() * h, 3 + rnd() * 4, 1.5 + rnd() * 2, 0, 0, Math.PI * 2)
    c.fill()
  }
  // weathered: grey wash in streaks
  for (let i = 0; i < 12; i++) {
    c.fillStyle = 'rgba(150,145,135,0.10)'
    c.fillRect(rnd() * w, 0, 6 + rnd() * 30, h)
  }
}

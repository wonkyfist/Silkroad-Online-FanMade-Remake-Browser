import type { WorldManifest } from '../../convert/src/world/manifest.ts'
import { mapLimit, type Assets } from './assets.ts'

/** Minimap tile: 256 px per region, 7.5 file units (0.75 m) per pixel, north up (TERRAIN.md 7). */
const TILE_PX = 256
const M_PER_PX = 0.75
/** The fill of a region without a tile when the export has no coast, and of a known region whose tile is pending. */
export const MINIMAP_FILL = '#202225'

/**
 * The open sea's tone against manifest.coast.mapColor: the converter's minimap tiles reach mapColor x 0.75 in deep water
 * (convert coast/minimap.ts OPEN_SEA_TONE; test: minimap-tiles.test.ts), and so does its world-map fill.
 */
export const OPEN_SEA_TONE = 0.75

/**
 * The fill of regions the export has no minimap tile for: the open sea beyond the coast pass's emitted regions
 * (manifest.coast.mapColor x OPEN_SEA_TONE, docs/COAST.md §11, so the tiles' deep-water edge meets it without a step),
 * or #202225 without a coast.
 */
export function minimapFill(manifest: { coast?: { mapColor?: unknown } | null }): string {
  const c = manifest.coast?.mapColor
  if (typeof c !== 'string' || !/^#[0-9a-f]{6}$/i.test(c)) return MINIMAP_FILL
  const v = parseInt(c.slice(1), 16)
  const ch = (shift: number) => Math.round(((v >> shift) & 255) * OPEN_SEA_TONE).toString(16).padStart(2, '0')
  return `#${ch(16)}${ch(8)}${ch(0)}`
}

export interface MinimapMarker {
  /** glTF metres. */
  x: number
  z: number
  /** CSS colour. */
  color: string
  /** Dot radius in canvas pixels (default 2.5). */
  size?: number
}

export interface MinimapView {
  /** Pixels per atlas pixel (1 = 0.75 m per canvas pixel). */
  scale?: number
  /** Camera position and a point it looks at (glTF), for the view-direction line. */
  camera?: { x: number; z: number; tx: number; tz: number }
  markers?: readonly MinimapMarker[]
  /** Draw the circular mask (a round minimap). */
  round?: boolean
  /** 'N' label. */
  north?: boolean
}

/** A tile image drawn by the minimap (an ImageBitmap in the browser). */
export type MinimapTile = CanvasImageSource & { close?: () => void }

/**
 * HUD minimap drawn from the client's own minimap tiles (manifest region.minimap, north-up images). It is independent
 * ground truth for the renderer: the dot is placed with the same region origin rule as the terrain, so buildings and
 * roads under the dot should match what the camera shows around the player. Browser only (canvas 2D).
 *
 * Two modes: the atlas (load() draws every region's tile into one canvas; the whole-world load and the viewer) and
 * tiles (docs/FIELDS.md §5.2, region streaming: setTile / removeTile as regions come and go; render() draws the tiles
 * under the view). toPx and render() work the same in both. A region without a tile in the manifest is drawn in
 * `fill` (the sea's mapColor with a coast); in tile mode a known region whose tile is not loaded yet stays #202225, so a
 * pending land tile never flashes as sea.
 */
export class Minimap {
  private readonly atlas: OffscreenCanvas | null
  /** Tile mode: region id -> tile image. */
  private readonly tiles = new Map<number, MinimapTile>()
  /** Region ids with a minimap tile in the manifest. */
  private readonly known = new Set<number>()
  readonly tileMode: boolean
  /** Fill of regions without a tile (minimapFill). */
  readonly fill: string
  private readonly minZ: number
  private readonly minX: number
  private readonly maxZ: number
  private readonly ox: number
  private readonly oz: number
  private ctx: CanvasRenderingContext2D | null = null
  loaded = 0
  scale = 1

  constructor(public canvas: HTMLCanvasElement | null, readonly manifest: WorldManifest, opts: { tiles?: boolean } = {}) {
    const xs = manifest.regions.map(r => r.x)
    const zs = manifest.regions.map(r => r.z)
    this.minX = Math.min(...xs)
    this.maxZ = Math.max(...zs)
    this.minZ = Math.min(...zs)
    this.ox = manifest.space.originRegion.x
    this.oz = manifest.space.originRegion.z
    this.tileMode = opts.tiles ?? false
    this.fill = minimapFill(manifest)
    for (const r of manifest.regions) if (r.minimap) this.known.add((r.z << 8) | r.x)
    const cols = Math.max(...xs) - this.minX + 1
    const rows = this.maxZ - this.minZ + 1
    this.atlas = this.tileMode ? null : new OffscreenCanvas(cols * TILE_PX, rows * TILE_PX)
    if (canvas) this.attach(canvas)
  }

  /** Tile mode: the tile of region (rx, rz) (replaces and closes an older one). */
  setTile(rx: number, rz: number, tile: MinimapTile): void {
    const id = (rz << 8) | rx
    const old = this.tiles.get(id)
    if (old && old !== tile) old.close?.()
    this.tiles.set(id, tile)
    this.loaded = this.tiles.size
  }

  /** Tile mode: drops (and closes) the tile of region (rx, rz). */
  removeTile(rx: number, rz: number): void {
    const id = (rz << 8) | rx
    this.tiles.get(id)?.close?.()
    this.tiles.delete(id)
    this.loaded = this.tiles.size
  }

  /** Tile mode: regions with a tile. */
  get tileCount(): number {
    return this.tiles.size
  }

  /** Draws into another canvas from now on. */
  attach(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    this.canvas = canvas
    this.ctx = ctx
  }

  /** Atlas mode: draws every region's tile into the atlas (tile mode: nothing to do). */
  async load(assets: Assets): Promise<void> {
    if (!this.atlas) return
    const atlas = this.atlas
    const actx = atlas.getContext('2d')
    if (!actx) return
    actx.fillStyle = this.fill
    actx.fillRect(0, 0, atlas.width, atlas.height)
    await mapLimit(this.manifest.regions, 6, async r => {
      if (!r.minimap) return
      try {
        const bmp = await createImageBitmap(await assets.blob(r.minimap))
        actx.drawImage(bmp, (r.x - this.minX) * TILE_PX, (this.maxZ - r.z) * TILE_PX, TILE_PX, TILE_PX)
        bmp.close()
        this.loaded++
      } catch (err) {
        console.warn('[world] minimap', r.minimap, err)
      }
    })
    actx.strokeStyle = 'rgba(255, 230, 60, 0.35)'
    for (const r of this.manifest.regions) actx.strokeRect((r.x - this.minX) * TILE_PX + 0.5, (this.maxZ - r.z) * TILE_PX + 0.5, TILE_PX - 1, TILE_PX - 1)
  }

  /** Tile mode: the tiles within (hw, hh) atlas pixels of atlas pixel (px, py), in the translated/scaled context. */
  private drawTiles(ctx: CanvasRenderingContext2D, px: number, py: number, hw: number, hh: number): void {
    const c0 = Math.floor((px - hw) / TILE_PX)
    const c1 = Math.floor((px + hw) / TILE_PX)
    const r0 = Math.floor((py - hh) / TILE_PX)
    const r1 = Math.floor((py + hh) / TILE_PX)
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const x = col * TILE_PX - px
        const y = row * TILE_PX - py
        const id = ((this.maxZ - row) << 8) | (this.minX + col)
        const tile = this.tiles.get(id)
        if (tile) ctx.drawImage(tile, x, y, TILE_PX, TILE_PX)
        else {
          ctx.fillStyle = this.known.has(id) ? MINIMAP_FILL : this.fill
          ctx.fillRect(x, y, TILE_PX, TILE_PX)
        }
      }
    }
  }

  /** Atlas pixel of glTF (x, z): file x east = 10 x, file z north = -10 z, relative to the origin region's SW corner. */
  toPx(x: number, z: number): [number, number] {
    const px = ((this.ox - this.minX) * 192 + x) / M_PER_PX
    const py = ((this.maxZ - this.oz + 1) * 192 + z) / M_PER_PX
    return [px, py]
  }

  /** Viewer form: centred on the player, with the camera view line. */
  draw(player: { x: number; z: number; heading: number }, cam: { x: number; z: number; tx: number; tz: number }): void {
    this.render(player, { camera: cam, scale: this.scale, north: true })
  }

  /**
   * Centred on `player` (heading h faces glTF (sin h, 0, cos h)), with optional markers (other entities) and the
   * camera's view direction.
   */
  render(player: { x: number; z: number; heading: number }, view: MinimapView = {}): void {
    const ctx = this.ctx
    const canvas = this.canvas
    if (!ctx || !canvas) return
    const w = canvas.width
    const h = canvas.height
    const scale = view.scale ?? this.scale
    const [px, py] = this.toPx(player.x, player.z)
    ctx.save()
    ctx.clearRect(0, 0, w, h)
    if (view.round) {
      ctx.beginPath()
      ctx.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, Math.PI * 2)
      ctx.clip()
    }
    // Beyond the atlas: the open sea with a coast, else the old near-black.
    ctx.fillStyle = this.fill === MINIMAP_FILL ? '#111' : this.fill
    ctx.fillRect(0, 0, w, h)
    ctx.imageSmoothingEnabled = true
    ctx.save()
    ctx.translate(w / 2, h / 2)
    ctx.scale(scale, scale)
    if (this.atlas) ctx.drawImage(this.atlas, -px, -py)
    else this.drawTiles(ctx, px, py, w / 2 / scale, h / 2 / scale)
    ctx.restore()

    for (const m of view.markers ?? []) {
      const [mx, my] = this.toPx(m.x, m.z)
      const sx = w / 2 + (mx - px) * scale
      const sy = h / 2 + (my - py) * scale
      if (sx < -4 || sy < -4 || sx > w + 4 || sy > h + 4) continue
      ctx.fillStyle = m.color
      ctx.beginPath()
      ctx.arc(sx, sy, m.size ?? 2.5, 0, Math.PI * 2)
      ctx.fill()
    }

    const cam = view.camera
    if (cam) {
      const [cx, cy] = this.toPx(cam.x, cam.z)
      const [tx, ty] = this.toPx(cam.tx, cam.tz)
      const vx = tx - cx
      const vy = ty - cy
      const vl = Math.hypot(vx, vy) || 1
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.9)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(w / 2, h / 2)
      ctx.lineTo(w / 2 + (vx / vl) * 40, h / 2 + (vy / vl) * 40)
      ctx.stroke()
    }

    // Player arrow: heading h faces glTF (sin h, 0, cos h); minimap y grows with glTF z (south).
    const dx = Math.sin(player.heading)
    const dy = Math.cos(player.heading)
    ctx.fillStyle = '#ffd23f'
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(w / 2 + dx * 8, h / 2 + dy * 8)
    ctx.lineTo(w / 2 - dx * 5 - dy * 4, h / 2 - dy * 5 + dx * 4)
    ctx.lineTo(w / 2 - dx * 5 + dy * 4, h / 2 - dy * 5 - dx * 4)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    if (view.north) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.font = '10px system-ui'
      ctx.fillText('N', w / 2 - 3, 11)
    }
    ctx.restore()
  }
}

/**
 * The world map window (M; docs/FIELDS.md §5.3, docs/WAVE_PLAN.md decision 22). The image is the export's stitched
 * minimap (`manifest.stream.worldMap`, 64 px per region, north up); an export without one (the 3 x 3 'jangan') gets
 * the same image composed here from its regions' minimap tiles. On top: zone labels (zones.json, one per name at the
 * mean of its regions), the town icon, NPC markers (shop / teleport / storage), hunting labels ("Tiger Lv 14",
 * coloured by level band) and the player arrow (10 Hz while open).
 *
 * Mouse: wheel zooms about the cursor, from the whole image (or 0.5x, whichever is further out) to 4x; left-drag pans,
 * right-click centres on the player again (the view follows the player until it is dragged). The view stays on the
 * image: with a coast the image is the island and a region of sea round it (docs/COAST.md §11), so the map never pans
 * off into empty sea. Hover shows the zone name and region coordinates. No click-to-travel.
 */
import { minimapFill } from '@sro/world-render'
import { t } from '../../i18n/index.ts'
import { iconButton } from '../../ui/kit/button.ts'
import { Window } from '../../ui/kit/window.ts'
import type { Art } from '../../ui/art.ts'
import { el } from '../../ui/dom.ts'
import { huntColor, type HuntCluster } from './hunting.ts'
import { DEFAULT_ORIGIN, REGION_M, regionOf, type OriginRegion, type ZoneIndex, type ZoneLabel } from './zones.ts'

// ---- geometry (pure) ----------------------------------------------------------------------------------------

/** The world map image's region span (inclusive) and pixel size; pixel (0, 0) = north-west corner of (x0, z1). */
export interface WorldMapGeometry {
  /** Image path relative to the world folder (null: compose it from the regions' minimap tiles). */
  file: string | null
  pxPerRegion: number
  x0: number
  x1: number
  z0: number
  z1: number
  width: number
  height: number
}

/** The manifest fields the map reads (a structural subset of the export's WorldManifest). */
export interface MapManifest {
  space?: { originRegion?: { x: number; z: number } }
  regions: readonly { x: number; z: number; minimap?: string | null }[]
  stream?: { worldMap?: { file: string; pxPerRegion: number; x0: number; x1: number; z0: number; z1: number; width: number; height: number } | null } | null
  /** manifest.coast (docs/COAST.md §8.1): only the open sea's map colour is read here. */
  coast?: { mapColor?: unknown } | null
}

export const MAP_PX_PER_REGION = 64

/** The fill around and under the image when the export has no coast. */
export const MAP_FILL = '#202225'

/**
 * The fill of the map where no region tile is: the open sea (world-render `minimapFill`: manifest.coast.mapColor in the
 * deep-water tone the converter's tiles and world-map fill reach, docs/COAST.md §11), so the map reads as sea all round
 * the coast instead of a dark frame; #202225 without a coast.
 */
export function mapFill(m: MapManifest): string {
  return minimapFill(m)
}

/** The export's world map (manifest.stream.worldMap), or the span of its regions at 64 px per region. */
export function mapGeometry(m: MapManifest): WorldMapGeometry {
  const w = m.stream?.worldMap
  if (w && w.pxPerRegion > 0 && w.x1 >= w.x0 && w.z1 >= w.z0) return { ...w }
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (const r of m.regions) {
    x0 = Math.min(x0, r.x)
    x1 = Math.max(x1, r.x)
    z0 = Math.min(z0, r.z)
    z1 = Math.max(z1, r.z)
  }
  if (!Number.isFinite(x0)) x0 = x1 = z0 = z1 = DEFAULT_ORIGIN.x
  const p = MAP_PX_PER_REGION
  return { file: null, pxPerRegion: p, x0, x1, z0, z1, width: (x1 - x0 + 1) * p, height: (z1 - z0 + 1) * p }
}

/** World map pixel <-> glTF metre transform (docs/FIELDS.md §3.9: region (x, z) at column (x − x0)·p, row (z1 − z)·p). */
export class MapTransform {
  /** Metres per map pixel (3 at 64 px per region). */
  readonly mPerPx: number
  private readonly left: number
  private readonly top: number

  constructor(readonly geo: WorldMapGeometry, readonly origin: OriginRegion = DEFAULT_ORIGIN) {
    this.mPerPx = REGION_M / geo.pxPerRegion
    this.left = (geo.x0 - origin.x) * REGION_M
    this.top = -(geo.z1 - origin.z + 1) * REGION_M
  }

  worldToPx(x: number, z: number): { px: number; py: number } {
    return { px: (x - this.left) / this.mPerPx, py: (z - this.top) / this.mPerPx }
  }

  pxToWorld(px: number, py: number): { x: number; z: number } {
    return { x: px * this.mPerPx + this.left, z: py * this.mPerPx + this.top }
  }

  /** The image's glTF rectangle. */
  get bounds(): { minX: number; minZ: number; maxX: number; maxZ: number } {
    return { minX: this.left, minZ: this.top, maxX: this.left + this.geo.width * this.mPerPx, maxZ: this.top + this.geo.height * this.mPerPx }
  }

  /** The region under map pixel (px, py). */
  regionAtPx(px: number, py: number): { rx: number; rz: number } {
    const w = this.pxToWorld(px, py)
    return regionOf(w.x, w.z, this.origin)
  }
}

export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 4

export const clampZoom = (z: number, min = MIN_ZOOM): number => Math.min(MAX_ZOOM, Math.max(min, z))

/** The furthest zoom out: the whole image in a view of viewW x viewH canvas pixels, or MIN_ZOOM if that is further. */
export function minZoomFor(width: number, height: number, viewW: number, viewH: number): number {
  if (!(width > 0 && height > 0)) return MIN_ZOOM
  return Math.min(MIN_ZOOM, viewW / width, viewH / height)
}

/**
 * A view centre (map pixels) kept on the image: the view (`half` map pixels either side) never shows past the image's
 * edge, and an image smaller than the view is centred.
 */
export function clampCentre(v: number, size: number, half: number): number {
  if (size <= 2 * half) return size / 2
  return Math.min(size - half, Math.max(half, v))
}

/**
 * The median colour of an image's outermost open-sea pixels ('#rrggbb'), or null if it cannot be read or has none.
 * With a coast the world map's border is mostly open sea, whose depth shading varies a little along the edge; the
 * median continues it best. Land on the border (the west edge stays retail land until the coast's phase 2) is skipped.
 */
export function borderFill(img: CanvasImageSource, width: number, height: number): string | null {
  try {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx || width < 2 || height < 2) return null
    ctx.drawImage(img, 0, 0, width, height)
    const rows = [ctx.getImageData(0, 0, width, 1), ctx.getImageData(0, height - 1, width, 1), ctx.getImageData(0, 0, 1, height), ctx.getImageData(width - 1, 0, 1, height)]
    return medianHex(rows.map(d => d.data), isOpenSea)
  } catch {
    return null
  }
}

/** Open-sea blue on the map (blue well above red and above green): not land, sand, or the retail teal water. */
export function isOpenSea(r: number, g: number, b: number): boolean {
  return b > g && b > r * 1.8
}

/** The per-channel median of the RGBA pixels that pass `keep` (default all), as '#rrggbb' (null when none do). */
export function medianHex(rows: readonly ArrayLike<number>[], keep: (r: number, g: number, b: number) => boolean = () => true): string | null {
  const ch: number[][] = [[], [], []]
  for (const d of rows) {
    for (let i = 0; i + 3 < d.length; i += 4) {
      if (!keep(d[i]!, d[i + 1]!, d[i + 2]!)) continue
      for (let k = 0; k < 3; k++) ch[k]!.push(d[i + k]!)
    }
  }
  if (!ch[0]!.length) return null
  return '#' + ch.map(v => v.sort((a, b) => a - b)[v.length >> 1]!.toString(16).padStart(2, '0')).join('')
}

// ---- the window --------------------------------------------------------------------------------------------

export interface MapMarker {
  x: number
  z: number
  name: string
  kind: 'shop' | 'teleport' | 'storage' | 'npc'
}

/**
 * Siege of Jangan, layer 2 (docs/SIEGE.md §9.3): shapes another feature draws over the map (glTF metres): a line
 * (`to`, `width` px), a ring (`radius` m) or a dot. Sources are global, so a feature can add one before the window
 * exists; a throwing source is dropped.
 */
export interface MapOverlayShape {
  x: number
  z: number
  color: string
  to?: { x: number; z: number }
  width?: number
  radius?: number
}
export type MapOverlaySource = () => Iterable<MapOverlayShape>
const overlaySources = new Set<MapOverlaySource>()

/** Adds an overlay source drawn on every redraw; returns the remove function. */
export function addWorldMapOverlay(fn: MapOverlaySource): () => void {
  overlaySources.add(fn)
  return () => {
    overlaySources.delete(fn)
  }
}

export interface WorldMapSource {
  transform: MapTransform
  /** Absolute or page-relative URL of the image, or of each region's minimap tile when composing. */
  imageUrl: string | null
  tiles: readonly { rx: number; rz: number; url: string }[]
  /** The fill where no region tile is (mapFill; default #202225). */
  fill?: string
  /** Own position, yaw (protocol: atan2(dx, dz)) and level, or null before worldEnter. */
  self(): { x: number; z: number; yaw: number; level: number } | null
  zones(): ZoneIndex | null
  hunting(): readonly HuntCluster[]
  markers(): readonly MapMarker[]
}

/** Retail `ifworldmap.txt`: mframe 652×424 (docs/UI.md §4.6); the map fills the body under the 36-px title strip. */
const WIDTH = 652
const HEIGHT = 424
const INSET = [40, 12, 12, 12] as const
const CANVAS_W = WIDTH - INSET[1] - INSET[3]
const CANVAS_H = HEIGHT - INSET[0] - INSET[2] - 22
const REDRAW_MS = 100
const MARKER_COLOR: Record<MapMarker['kind'], string> = { shop: '#7cf08a', teleport: '#58b8ff', storage: '#f0c060', npc: '#d8d8d8' }

const CSS = `
.fld-map { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 4px; }
.fld-map canvas { width: ${CANVAS_W}px; height: ${CANVAS_H}px; background: #202225; outline: 1px solid rgba(156, 131, 80, 0.7); cursor: grab; touch-action: none; }
.fld-map canvas.drag { cursor: grabbing; }
.fld-map-foot { display: flex; justify-content: space-between; gap: 8px; height: 18px; font: 11px/18px var(--font-body); color: #e8e2cf; white-space: nowrap; overflow: hidden; }
.fld-map-foot .fld-map-hint { color: #a89f86; }
`
let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'fld-map'
  style.textContent = CSS
  document.head.append(style)
}

/** A CSS font-family variable resolved for canvas text (canvas fonts cannot use var()). */
function cssFont(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  } catch {
    return fallback
  }
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export class WorldMapWindow extends Window {
  private readonly canvas: HTMLCanvasElement
  private readonly info: HTMLElement
  private readonly dpr: number
  private image: CanvasImageSource | null = null
  private imageStarted = false
  /** With a coast: the image's own border colour (borderFill), so the sea runs on past the image without a step. */
  private edgeFill: string | null = null
  /** View centre in map pixels, and canvas pixels per map pixel. */
  private vx = 0
  private vy = 0
  private zoom = 1
  private follow = true
  private timer: ReturnType<typeof setInterval> | undefined
  private drag: { id: number; x: number; y: number; vx: number; vy: number } | null = null
  private hover: { x: number; y: number } | null = null
  private labels: ZoneLabel[] | null = null
  /** Canvas positions of the NPC markers and hunting dots drawn last, for the hover line. */
  private spots: { x: number; y: number; text: string }[] = []
  private readonly titleFont = cssFont('--font-title', 'Georgia, serif')
  private readonly bodyFont = cssFont('--font-body', 'Tahoma, sans-serif')

  constructor(art: Art, parent: HTMLElement, private readonly src: WorldMapSource) {
    super(art, parent, { id: 'worldmap', title: t('map.title'), width: WIDTH, height: HEIGHT, at: [0.5, 0.4], inset: INSET, className: 'hud-window hud-window-worldmap' })
    this.titleStrip.classList.add('hud-window-title')
    // Retail title buttons: the world button (590,10) centres on you; the window-size button (608,10) is not used.
    const world = iconButton(art, 'worldmap/wmap_button_world', { w: 16, h: 16, title: t('map.centre'), fallbackText: '◎' }, () => {
      this.centreOnSelf()
      this.draw()
    })
    Object.assign(world.style, { position: 'absolute', left: '590px', top: '10px', zIndex: '2' })
    this.root.append(world)
    ensureStyles()
    this.dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
    this.canvas = document.createElement('canvas')
    this.canvas.width = Math.round(CANVAS_W * this.dpr)
    this.canvas.height = Math.round(CANVAS_H * this.dpr)
    this.canvas.style.background = this.fill
    this.info = el('div', 'fld-map-foot')
    const wrap = el('div', 'fld-map')
    wrap.append(this.canvas, this.info)
    this.body.append(wrap)
    const c = this.canvas
    this.ls.on(c, 'wheel', ev => {
      ev.preventDefault()
      ev.stopPropagation()
      const p = this.local(ev)
      this.zoomAt(p.x, p.y, ev.deltaY < 0 ? 1.25 : 0.8)
    }, { passive: false })
    this.ls.on(c, 'pointerdown', ev => {
      if (ev.button !== 0) return
      const p = this.local(ev)
      this.drag = { id: ev.pointerId, x: p.x, y: p.y, vx: this.vx, vy: this.vy }
      c.setPointerCapture?.(ev.pointerId)
      c.classList.add('drag')
    })
    this.ls.on(c, 'pointermove', ev => {
      const p = this.local(ev)
      this.hover = p
      const d = this.drag
      if (d && d.id === ev.pointerId) {
        this.vx = d.vx - (p.x - d.x) / this.zoom
        this.vy = d.vy - (p.y - d.y) / this.zoom
        if (Math.abs(p.x - d.x) + Math.abs(p.y - d.y) > 3) this.follow = false
        this.clampView()
      }
      this.draw()
    })
    const endDrag = (ev: PointerEvent) => {
      if (this.drag?.id !== ev.pointerId) return
      this.drag = null
      c.classList.remove('drag')
    }
    this.ls.on(c, 'pointerup', endDrag)
    this.ls.on(c, 'pointercancel', endDrag)
    this.ls.on(c, 'pointerleave', () => {
      this.hover = null
      this.draw()
    })
    this.ls.on(c, 'contextmenu', ev => {
      ev.preventDefault()
      this.centreOnSelf()
      this.draw()
    })
  }

  /** Canvas CSS pixel of a pointer event (the window is scaled by --ui). */
  private local(ev: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    const sx = r.width > 0 ? CANVAS_W / r.width : 1
    const sy = r.height > 0 ? CANVAS_H / r.height : 1
    return { x: (ev.clientX - r.left) * sx, y: (ev.clientY - r.top) * sy }
  }

  protected override onOpen(): void {
    this.loadImage()
    this.centreOnSelf()
    this.draw()
    clearInterval(this.timer)
    this.timer = setInterval(() => this.draw(), REDRAW_MS)
  }

  override close(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.drag = null
    super.close()
  }

  override dispose(): void {
    clearInterval(this.timer)
    this.timer = undefined
    super.dispose()
  }

  private centreOnSelf(): void {
    this.follow = true
    const s = this.src.self()
    const g = this.src.transform.geo
    if (s) {
      const p = this.src.transform.worldToPx(s.x, s.z)
      this.vx = p.px
      this.vy = p.py
    } else {
      this.vx = g.width / 2
      this.vy = g.height / 2
    }
    this.clampView()
  }

  private zoomAt(cx: number, cy: number, factor: number): void {
    const g = this.src.transform.geo
    const z = clampZoom(this.zoom * factor, minZoomFor(g.width, g.height, CANVAS_W, CANVAS_H))
    if (z === this.zoom) return
    // Keep the map pixel under the cursor where it is.
    const mx = this.vx + (cx - CANVAS_W / 2) / this.zoom
    const my = this.vy + (cy - CANVAS_H / 2) / this.zoom
    this.zoom = z
    if (!this.follow) {
      this.vx = mx - (cx - CANVAS_W / 2) / z
      this.vy = my - (cy - CANVAS_H / 2) / z
    }
    this.clampView()
    this.draw()
  }

  private get fill(): string {
    return this.edgeFill ?? this.src.fill ?? MAP_FILL
  }

  private clampView(): void {
    const g = this.src.transform.geo
    this.vx = clampCentre(this.vx, g.width, CANVAS_W / 2 / this.zoom)
    this.vy = clampCentre(this.vy, g.height, CANVAS_H / 2 / this.zoom)
  }

  private loadImage(): void {
    if (this.imageStarted) return
    this.imageStarted = true
    const g = this.src.transform.geo
    if (this.src.imageUrl) {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => {
        this.image = img
        if ((this.src.fill ?? MAP_FILL) !== MAP_FILL) {
          this.edgeFill = borderFill(img, g.width, g.height)
          if (this.edgeFill) this.canvas.style.background = this.edgeFill
        }
        this.draw()
      }
      img.onerror = () => console.warn('[map] world map image failed to load', this.src.imageUrl)
      img.src = this.src.imageUrl
      return
    }
    // Compose from the regions' minimap tiles (non-streamed exports).
    const canvas = document.createElement('canvas')
    canvas.width = g.width
    canvas.height = g.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = this.fill
    ctx.fillRect(0, 0, g.width, g.height)
    this.image = canvas
    const p = g.pxPerRegion
    for (const tile of this.src.tiles) {
      const img = new Image()
      img.onload = () => {
        ctx.drawImage(img, (tile.rx - g.x0) * p, (g.z1 - tile.rz) * p, p, p)
        this.draw()
      }
      img.src = tile.url
    }
  }

  /** Redraws the map (10 Hz while open, and on every interaction). */
  draw(): void {
    if (!this.isOpen) return
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const T = this.src.transform
    const g = T.geo
    const self = this.src.self()
    if (self && this.follow) {
      const p = T.worldToPx(self.x, self.z)
      this.vx = p.px
      this.vy = p.py
      this.clampView()
    }
    const z = this.zoom
    const toCanvas = (x: number, wz: number) => {
      const p = T.worldToPx(x, wz)
      return { x: (p.px - this.vx) * z + CANVAS_W / 2, y: (p.py - this.vy) * z + CANVAS_H / 2 }
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.fillStyle = this.fill
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
    const ox = CANVAS_W / 2 - this.vx * z
    const oy = CANVAS_H / 2 - this.vy * z
    if (this.image) {
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(this.image, ox, oy, g.width * z, g.height * z)
    }
    // Region grid when zoomed in (faint), so the hover coordinates have something to point at.
    if (z >= 2) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 0; i <= g.x1 - g.x0 + 1; i++) {
        const x = Math.round(ox + i * g.pxPerRegion * z) + 0.5
        ctx.moveTo(x, oy)
        ctx.lineTo(x, oy + g.height * z)
      }
      for (let i = 0; i <= g.z1 - g.z0 + 1; i++) {
        const y = Math.round(oy + i * g.pxPerRegion * z) + 0.5
        ctx.moveTo(ox, y)
        ctx.lineTo(ox + g.width * z, y)
      }
      ctx.stroke()
    }

    this.drawOverlays(ctx, toCanvas, T.worldToPx(1, 0).px - T.worldToPx(0, 0).px)

    const placed: Box[] = []
    const free = (b: Box) => !placed.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)
    const label = (text: string, x: number, y: number, color: string, font: string, force = false): boolean => {
      ctx.font = font
      const w = ctx.measureText(text).width
      const b = { x0: x - w / 2 - 2, y0: y - 8, x1: x + w / 2 + 2, y1: y + 8 }
      if (b.x1 < 0 || b.x0 > CANVAS_W || b.y1 < 0 || b.y0 > CANVAS_H) return false
      if (!force && !free(b)) return false
      placed.push(b)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'
      ctx.strokeText(text, x, y)
      ctx.fillStyle = color
      ctx.fillText(text, x, y)
      return true
    }

    // Player arrow first in the collision list, drawn last.
    const me = self ? toCanvas(self.x, self.z) : null
    if (me) placed.push({ x0: me.x - 9, y0: me.y - 9, x1: me.x + 9, y1: me.y + 9 })

    // Zones: the town with its icon first, then the other names.
    this.labels ??= this.src.zones()?.labels() ?? null
    const zones = this.labels ?? []
    for (const l of zones) {
      if (!l.town) continue
      const p = toCanvas(l.x, l.z)
      drawTownIcon(ctx, p.x, p.y - 10)
      placed.push({ x0: p.x - 8, y0: p.y - 19, x1: p.x + 8, y1: p.y - 1 })
      label(l.name, p.x, p.y + 6, '#ffe9a6', `bold 13px ${this.titleFont}`, true)
    }
    for (const l of zones) {
      if (l.town) continue
      const p = toCanvas(l.x, l.z)
      label(l.name, p.x, p.y, '#f3e4b0', `${z >= 1.5 ? 13 : 11}px ${this.titleFont}`)
    }

    this.spots = []
    // NPC markers (town services) when zoomed in enough to tell them apart.
    if (z >= 1) {
      for (const m of this.src.markers()) {
        const p = toCanvas(m.x, m.z)
        if (p.x < -4 || p.y < -4 || p.x > CANVAS_W + 4 || p.y > CANVAS_H + 4) continue
        ctx.beginPath()
        ctx.arc(p.x, p.y, z >= 2 ? 3.5 : 2.5, 0, Math.PI * 2)
        ctx.fillStyle = MARKER_COLOR[m.kind]
        ctx.fill()
        ctx.lineWidth = 1
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'
        ctx.stroke()
        this.spots.push({ x: p.x, y: p.y, text: m.name })
      }
    }

    // Hunting labels: the biggest clusters win the space.
    const level = self?.level ?? 1
    const hunts = [...this.src.hunting()].sort((a, b) => Number(b.unique) - Number(a.unique) || b.mobs - a.mobs)
    for (const h of hunts) {
      const p = toCanvas(h.x, h.z)
      const color = h.unique ? '#ff8cf0' : huntColor(h.level, level)
      const text = h.unique ? t('map.unique', { name: h.name, level: h.level }) : t('map.hunt', { name: h.name, level: h.level })
      this.spots.push({ x: p.x, y: p.y, text })
      if (!label(text, p.x, p.y + 9, color, `11px ${this.bodyFont}`)) continue
      ctx.beginPath()
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    }

    if (me && self) drawArrow(ctx, me.x, me.y, self.yaw)
    this.updateInfo(self)
  }

  /** The overlay sources' shapes (`pxPerM`: map pixels per metre at zoom 1). */
  private drawOverlays(ctx: CanvasRenderingContext2D, toCanvas: (x: number, z: number) => { x: number; y: number }, pxPerM: number): void {
    for (const src of overlaySources) {
      try {
        for (const s of src()) {
          const p = toCanvas(s.x, s.z)
          ctx.beginPath()
          if (s.to) {
            const q = toCanvas(s.to.x, s.to.z)
            ctx.moveTo(p.x, p.y)
            ctx.lineTo(q.x, q.y)
            ctx.strokeStyle = s.color
            ctx.lineWidth = (s.width ?? 2) * Math.max(1, Math.min(2, this.zoom))
            ctx.lineCap = 'round'
            ctx.stroke()
          } else if (s.radius !== undefined && s.radius > 0) {
            ctx.arc(p.x, p.y, Math.max(2, s.radius * pxPerM * this.zoom), 0, Math.PI * 2)
            ctx.globalAlpha = 0.18
            ctx.fillStyle = s.color
            ctx.fill()
            ctx.globalAlpha = 0.9
            ctx.strokeStyle = s.color
            ctx.lineWidth = 1.5
            ctx.stroke()
            ctx.globalAlpha = 1
          } else {
            ctx.arc(p.x, p.y, s.width ?? 2.5, 0, Math.PI * 2)
            ctx.fillStyle = s.color
            ctx.fill()
          }
        }
      } catch (err) {
        console.error('[map] overlay source failed', err)
        overlaySources.delete(src)
      }
    }
  }

  private updateInfo(self: { x: number; z: number } | null): void {
    const T = this.src.transform
    let where: { x: number; z: number } | null = null
    let prefix = ''
    if (this.hover) {
      where = T.pxToWorld(this.vx + (this.hover.x - CANVAS_W / 2) / this.zoom, this.vy + (this.hover.y - CANVAS_H / 2) / this.zoom)
    } else if (self) {
      where = self
      prefix = `${t('map.you')}: `
    }
    let text = ''
    if (where) {
      const r = regionOf(where.x, where.z, T.origin)
      const name = this.src.zones()?.nameAt(where.x, where.z) ?? t('map.zoneUnknown')
      text = `${prefix}${name}  (${t('map.region', { x: r.rx, z: r.rz })})`
      const h = this.hover
      const spot = h && this.spots.find(s => Math.abs(s.x - h.x) <= 6 && Math.abs(s.y - h.y) <= 6)
      if (spot) text = `${spot.text}  -  ${text}`
    }
    const hint = t('map.hint')
    if (this.info.dataset.text === text + hint) return
    this.info.dataset.text = text + hint
    this.info.replaceChildren(el('span', 'fld-map-where', text), el('span', 'fld-map-hint', hint))
  }
}

/** The town icon: a small gold gate. */
function drawTownIcon(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save()
  ctx.translate(Math.round(x), Math.round(y))
  ctx.fillStyle = '#e8c35a'
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(-7, 7)
  ctx.lineTo(-7, -4)
  ctx.lineTo(-5, -4)
  ctx.lineTo(-5, -7)
  ctx.lineTo(-2, -7)
  ctx.lineTo(-2, -4)
  ctx.lineTo(2, -4)
  ctx.lineTo(2, -7)
  ctx.lineTo(5, -7)
  ctx.lineTo(5, -4)
  ctx.lineTo(7, -4)
  ctx.lineTo(7, 7)
  ctx.lineTo(2, 7)
  ctx.lineTo(2, 2)
  ctx.lineTo(-2, 2)
  ctx.lineTo(-2, 7)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

/** The player arrow, pointing along yaw (protocol yaw = atan2(dx, dz); +z is down on the map). */
function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, yaw: number): void {
  ctx.save()
  ctx.translate(x, y)
  // Canvas direction of yaw: (sin yaw, cos yaw); rotating the up arrow (0, −1) by π − yaw lands on it.
  ctx.rotate(Math.PI - yaw)
  ctx.beginPath()
  ctx.moveTo(0, -9)
  ctx.lineTo(6, 7)
  ctx.lineTo(0, 3)
  ctx.lineTo(-6, 7)
  ctx.closePath()
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#c0392b'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fill()
  ctx.restore()
}

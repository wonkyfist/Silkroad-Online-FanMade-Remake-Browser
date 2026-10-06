/**
 * HUD minimap: the client's own minimap tiles (world.minimap atlas, north up) centred on the player, with the SRO
 * minimap signs (mm_sign_*) for monsters, NPCs and other players and dots for ground items. Wheel or the +/- buttons
 * zoom (kept in settings.ui.minimapZoom); the map button opens the world map (FLD-C sets it). Drawn at 15 Hz.
 * The retail plate (docs/UI.md §2.5, `ifminimap.txt`, GDR_MINIMAP 140×184): `mm_window` drawn over the round map
 * (the map shows through its hole, GDR_MINIMAP_ALPHA (14,57,105,105)), the area name (12,9,104,12) in the label
 * colour and the SRO world coordinates X (8,32,56,11) / Y (67,32,56,11) INSIDE the top plate, the world-map button
 * (99,47,24,24), zoom in (107,136) and zoom out (90,152) on the plate's round sockets (docs/UX_GAPS.md M1, M2, M4).
 *
 * Other lanes add markers with addMarkerSource (docs/WAVE_PLAN.md decision 31): a marker is {x, z, color, size?,
 * radius?, icon?}; `radius` in metres draws a circle (quest areas), `icon` is an art key (party pins, quest NPCs).
 */
import type { Minimap, MinimapMarker } from '@sro/world-render'
import { t } from '../../i18n/index.ts'
import { settings } from '../../settings.ts'
import type { Art } from '../../ui/art.ts'
import { ensureUxWorldStyles } from '../ux-world-style.ts'

/** The round map's size in native px (the plate's hole, GDR_MINIMAP_ALPHA 105 plus a pixel of overlap each side). */
const SIZE = 108
const ZOOMS = [0.45, 0.6, 0.85, 1.2, 1.7]
const COLORS = { mob: '#ff4a3d', npc: '#7cf08a', player: '#58b8ff', item: '#ffffff' } as const
/** The SRO minimap signs per entity kind (items stay dots). */
const SIGNS: Partial<Record<keyof typeof COLORS | 'unique', string>> = {
  mob: 'minimap/mm_sign_monster',
  unique: 'minimap/mm_sign_unique',
  npc: 'minimap/mm_sign_npc',
  player: 'minimap/mm_sign_otherplayer',
}

export interface MinimapEntity {
  kind: keyof typeof COLORS
  x: number
  z: number
  /** Unique monster: its own sign. */
  unique?: boolean
}

/** A marker another lane adds (docs/WAVE_PLAN.md decision 31). */
export interface HudMarker {
  /** glTF metres. */
  x: number
  z: number
  /** CSS colour of the dot or circle. */
  color: string
  /** Dot radius in CSS pixels (default 2.5), or the icon size (default: the art's size). */
  size?: number
  /** Metres: draws a circle of this radius (quest areas) instead of a dot. */
  radius?: number
  /** Art key (e.g. 'minimap/mm_sign_party'): drawn instead of a dot when the art exported. */
  icon?: string
  /** Siege of Jangan, layer 2 (the walls' damage): a line from (x, z) to here instead of a dot, `size` px wide. */
  to?: { x: number; z: number }
}

export type MarkerSource = () => Iterable<HudMarker>

/** The region the glTF origin sits in (manifest space.originRegion; Jangan's export: 168, 97). */
export interface OriginRegion {
  x: number
  z: number
}

export const JANGAN_ORIGIN: OriginRegion = { x: 168, z: 97 }

const clampZoom = (z: number) => Math.max(0, Math.min(ZOOMS.length - 1, Math.round(z)))

/**
 * SRO world coordinates as the client shows them (docs/UX_GAPS.md M1): X = (rx − 135)·192 + lx, Y = (rz − 92)·192 + lz.
 * glTF z points south and the origin is the south-west corner of the origin region, so Y = (oz − 92)·192 − z.
 */
export function sroCoords(x: number, z: number, origin: OriginRegion = JANGAN_ORIGIN): { x: number; y: number } {
  return { x: Math.round((origin.x - 135) * 192 + x), y: Math.round((origin.z - 92) * 192 - z) }
}

export class HudMinimap {
  readonly root: HTMLElement
  private readonly circle: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly plate: HTMLElement
  private readonly areaEl: HTMLElement
  private readonly coordsEl: HTMLElement
  private readonly xEl: HTMLElement
  private readonly yEl: HTMLElement
  private readonly zoomIn: HTMLButtonElement
  private readonly zoomOut: HTMLButtonElement
  private readonly mapBtn: HTMLButtonElement
  private zoom = clampZoom(settings.get().ui.minimapZoom)
  private timer = 0
  private readonly markers: MinimapMarker[] = []
  private readonly sources = new Set<MarkerSource>()
  private readonly icons = new Map<string, HTMLImageElement | null>()
  private art: Art | null = null
  private origin: OriginRegion = JANGAN_ORIGIN
  private coordsText = ''
  /** Opens the world map (FLD-C, through hud.openWorldMap); the button hides while this returns false. */
  canOpenMap: () => boolean = () => false
  onMap: () => void = () => {}

  constructor(private readonly map: Minimap) {
    ensureUxWorldStyles()
    this.root = document.createElement('div')
    this.root.className = 'hud-minimap-block uh-mm'
    this.circle = document.createElement('div')
    this.circle.className = 'hud-minimap uh-mm-map'
    this.circle.title = t('world.minimapTitle')
    this.plate = document.createElement('div')
    this.plate.className = 'uh-mm-plate'
    this.canvas = document.createElement('canvas')
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    this.canvas.width = Math.round(SIZE * dpr)
    this.canvas.height = Math.round(SIZE * dpr)
    this.circle.append(this.canvas)
    this.zoomIn = this.button('mm-zoomin', '+', t('minimap.zoomIn'), () => this.setZoom(this.zoom + 1))
    this.zoomOut = this.button('mm-zoomout', '−', t('minimap.zoomOut'), () => this.setZoom(this.zoom - 1))
    this.mapBtn = this.button('mm-map', '', t('minimap.worldMap'), () => this.onMap())
    this.mapBtn.hidden = true
    this.areaEl = document.createElement('div')
    this.areaEl.className = 'hud-minimap-area uh-mm-area'
    this.xEl = document.createElement('span')
    this.xEl.className = 'uh-mm-x'
    this.yEl = document.createElement('span')
    this.yEl.className = 'uh-mm-y'
    this.coordsEl = document.createElement('div')
    this.coordsEl.className = 'hud-minimap-coords uh-mm-coords'
    this.coordsEl.append(this.xEl, this.yEl)
    this.root.append(this.circle, this.plate, this.zoomIn, this.zoomOut, this.mapBtn, this.areaEl, this.coordsEl)
    this.circle.addEventListener('wheel', ev => {
      ev.preventDefault()
      ev.stopPropagation()
      this.setZoom(this.zoom + (ev.deltaY < 0 ? 1 : -1))
    }, { passive: false })
    // Clicks on the minimap must not reach the canvas (click-to-move).
    this.root.addEventListener('pointerdown', ev => ev.stopPropagation())
    this.syncZoomButtons()
    map.attach(this.canvas)
  }

  private button(cls: string, glyph: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `mm-button ${cls}`
    b.title = title
    b.textContent = glyph
    b.addEventListener('click', ev => {
      ev.stopPropagation()
      run()
    })
    return b
  }

  /** The SRO minimap art (zoom and map buttons, signs); plain CSS and dots without it. */
  useArt(art: Art): void {
    this.art = art
    const skin = (b: HTMLButtonElement, key: string) => {
      if (!art.has(key)) return
      b.style.setProperty('--img', art.cssUrl(key))
      b.style.setProperty('--img-focus', art.cssUrl(art.has(`${key}_focus`) ? `${key}_focus` : key))
      b.style.setProperty('--img-press', art.cssUrl(art.has(`${key}_press`) ? `${key}_press` : key))
      b.classList.add('art')
      b.textContent = ''
    }
    if (art.has('minimap/mm_window')) this.plate.style.backgroundImage = art.cssUrl('minimap/mm_window')
    else this.root.classList.add('no-art')
    skin(this.zoomIn, 'minimap/mm_zoomin')
    skin(this.zoomOut, 'minimap/mm_zoomout')
    skin(this.mapBtn, 'minimap/mm_map_button')
    this.timer = 0
  }

  /** The export's origin region, for the coordinates. */
  setOrigin(origin: OriginRegion): void {
    this.origin = origin
    this.coordsText = ''
  }

  /** The area name in the plate's top strip (empty hides it). */
  setArea(name: string): void {
    if (this.areaEl.textContent !== name) {
      this.areaEl.textContent = name
      this.areaEl.title = name
    }
    this.areaEl.hidden = !name
  }

  get zoomLevel(): number {
    return this.zoom
  }

  setZoom(z: number): void {
    const next = Math.max(0, Math.min(ZOOMS.length - 1, z))
    if (next === this.zoom) return
    this.zoom = next
    settings.set({ ui: { minimapZoom: next } })
    this.syncZoomButtons()
    this.timer = 0
  }

  private syncZoomButtons(): void {
    this.zoomIn.disabled = this.zoom >= ZOOMS.length - 1
    this.zoomOut.disabled = this.zoom <= 0
  }

  /** Adds markers drawn on every redraw; returns the remove function. A throwing source is skipped. */
  addMarkerSource(fn: MarkerSource): () => void {
    this.sources.add(fn)
    this.timer = 0
    return () => {
      this.sources.delete(fn)
      this.timer = 0
    }
  }

  /** Call every frame; redraws at most 15 times a second. */
  update(dt: number, self: { x: number; z: number; yaw: number }, entities: Iterable<MinimapEntity>, camera?: { x: number; z: number; tx: number; tz: number }): void {
    this.timer -= dt
    if (this.timer > 0) return
    this.timer = 1 / 15
    const dpr = this.canvas.width / SIZE
    const scale = ZOOMS[this.zoom]! * dpr
    const extra: HudMarker[] = []
    for (const src of this.sources) {
      try {
        for (const m of src()) extra.push(m)
      } catch (err) {
        console.error('[minimap] marker source failed', err)
        this.sources.delete(src)
      }
    }
    const signs: { x: number; z: number; img: HTMLImageElement; size: number }[] = []
    this.markers.length = 0
    for (const e of entities) {
      const img = this.icon(e.kind === 'mob' && e.unique ? SIGNS.unique : SIGNS[e.kind])
      if (img) signs.push({ x: e.x, z: e.z, img, size: img.naturalWidth * dpr })
      else this.markers.push({ x: e.x, z: e.z, color: e.unique ? '#ff9cf0' : COLORS[e.kind], size: (e.kind === 'item' ? 1.8 : 2.6) * dpr })
    }
    const circles: HudMarker[] = []
    for (const m of extra) {
      if (m.to || (m.radius !== undefined && m.radius > 0)) circles.push(m)
      else {
        const img = this.icon(m.icon)
        if (img) signs.push({ x: m.x, z: m.z, img, size: (m.size ?? img.naturalWidth) * dpr })
        else this.markers.push({ x: m.x, z: m.z, color: m.color, size: (m.size ?? 2.5) * dpr })
      }
    }
    this.map.render({ x: self.x, z: self.z, heading: self.yaw }, { scale, markers: this.markers, camera, round: true, north: false })
    if (signs.length || circles.length) this.overlay(self, scale, signs, circles)
    const c = sroCoords(self.x, self.z, this.origin)
    const text = t('minimap.coords', { x: c.x, y: c.y })
    if (text !== this.coordsText) {
      this.coordsText = text
      this.xEl.textContent = t('uh.minimap.x', { x: c.x })
      this.yEl.textContent = t('uh.minimap.y', { y: c.y })
      this.coordsEl.title = text
    }
    const canMap = this.canOpenMap()
    if (this.mapBtn.hidden === canMap) this.mapBtn.hidden = !canMap
  }

  /** Signs, area circles and lines, on top of the map (same centring and scale as Minimap.render). */
  private overlay(self: { x: number; z: number }, scale: number, signs: { x: number; z: number; img: HTMLImageElement; size: number }[], circles: HudMarker[]): void {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const w = this.canvas.width
    const h = this.canvas.height
    const [ox, oy] = this.map.toPx(self.x, self.z)
    const pxPerM = this.map.toPx(self.x + 1, self.z)[0] - ox
    const at = (x: number, z: number): [number, number] => {
      const [mx, my] = this.map.toPx(x, z)
      return [w / 2 + (mx - ox) * scale, h / 2 + (my - oy) * scale]
    }
    ctx.save()
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, Math.PI * 2)
    ctx.clip()
    for (const c of circles) {
      const [sx, sy] = at(c.x, c.z)
      if (c.to) {
        const [tx, ty] = at(c.to.x, c.to.z)
        if (Math.max(sx, tx) < 0 || Math.max(sy, ty) < 0 || Math.min(sx, tx) > w || Math.min(sy, ty) > h) continue
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.lineTo(tx, ty)
        ctx.strokeStyle = c.color
        ctx.lineWidth = (c.size ?? 2) * (w / SIZE)
        ctx.lineCap = 'round'
        ctx.globalAlpha = 0.9
        ctx.stroke()
        ctx.globalAlpha = 1
        continue
      }
      const r = c.radius! * pxPerM * scale
      if (sx + r < 0 || sy + r < 0 || sx - r > w || sy - r > h) continue
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.globalAlpha = 0.18
      ctx.fillStyle = c.color
      ctx.fill()
      ctx.globalAlpha = 0.85
      ctx.strokeStyle = c.color
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    for (const s of signs) {
      const [sx, sy] = at(s.x, s.z)
      if (sx < -s.size || sy < -s.size || sx > w + s.size || sy > h + s.size) continue
      ctx.drawImage(s.img, Math.round(sx - s.size / 2), Math.round(sy - s.size / 2), s.size, s.size)
    }
    ctx.restore()
  }

  /** A loaded art image, or null (not exported, still loading, failed). */
  private icon(key: string | undefined): HTMLImageElement | null {
    if (!key || !this.art) return null
    if (this.icons.has(key)) {
      const img = this.icons.get(key)!
      return img && img.complete && img.naturalWidth > 0 ? img : null
    }
    if (!this.art.has(key)) {
      this.icons.set(key, null)
      return null
    }
    const img = new Image()
    img.src = this.art.url(key)
    img.onerror = () => this.icons.set(key, null)
    this.icons.set(key, img)
    return null
  }

  dispose(): void {
    this.sources.clear()
    this.root.remove()
  }
}

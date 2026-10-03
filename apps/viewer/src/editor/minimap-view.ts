/**
 * The editor's minimap (docs/WORLD_EDITOR.md §5, toggle M): the export's world map (`worldmap.png`, north up, 64 px
 * per region) around the camera, the playable bounds, the regions with edits outlined in gold, the camera and its
 * view. A click flies the camera there; a right-click on a region offers "Revert this region" (§3.4).
 */
export interface MinimapInfo {
  /** manifest.stream.worldMap */
  map: { file: string; pxPerRegion: number; x0: number; x1: number; z0: number; z1: number }
  playable: { x0: number; x1: number; z0: number; z1: number } | null
  originRegion: { x: number; z: number }
  regions: ReadonlySet<number>
}

/** Regions shown across the canvas. */
const SPAN = 7

export class MinimapView {
  private img: HTMLImageElement | null = null
  private centre = { rx: 0, rz: 0 }
  edited = new Set<number>()

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly info: MinimapInfo,
    worldUrl: string,
    private readonly on: { fly(x: number, z: number): void; revertRegion(id: number): void },
  ) {
    const img = new Image()
    img.onload = () => {
      this.img = img
      this.draw(null)
    }
    img.src = `${worldUrl}${info.map.file}`
    canvas.addEventListener('click', e => {
      const p = this.toRegionF(e)
      if (p) on.fly(...this.toGltf(p.rx, p.rz))
    })
    canvas.addEventListener('contextmenu', e => {
      e.preventDefault()
      const p = this.toRegionF(e)
      if (!p) return
      const id = (Math.floor(p.rz) << 8) | Math.floor(p.rx)
      if (this.info.regions.has(id)) on.revertRegion(id)
    })
  }

  private get scale(): number {
    return this.canvas.width / SPAN
  }

  /** Canvas pixel → fractional region coordinates (x east, z north). */
  private toRegionF(e: MouseEvent): { rx: number; rz: number } | null {
    const r = this.canvas.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * this.canvas.width
    const py = ((e.clientY - r.top) / r.height) * this.canvas.height
    return { rx: this.centre.rx - SPAN / 2 + px / this.scale, rz: this.centre.rz + SPAN / 2 - py / this.scale }
  }

  private toGltf(rx: number, rz: number): [number, number] {
    return [(rx - this.info.originRegion.x) * 192, -(rz - this.info.originRegion.z) * 192]
  }

  /** Draws around the camera (glTF x, z) looking along (fx, fz). */
  draw(cam: { x: number; z: number; fx: number; fz: number } | null): void {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const { originRegion: o, map } = this.info
    if (cam) this.centre = { rx: o.x + cam.x / 192, rz: o.z - cam.z / 192 }
    const s = this.scale
    const W = this.canvas.width, H = this.canvas.height
    const x0 = this.centre.rx - SPAN / 2, zTop = this.centre.rz + SPAN / 2
    const px = (rx: number) => (rx - x0) * s
    const py = (rz: number) => (zTop - rz) * s
    ctx.fillStyle = '#0b1622'
    ctx.fillRect(0, 0, W, H)
    if (this.img) {
      // the map image: column (rx - x0map) * ppr, row (z1map + 1 - rz) * ppr
      const ppr = map.pxPerRegion
      const sx = (x0 - map.x0) * ppr, sy = (map.z1 + 1 - zTop) * ppr
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(this.img, sx, sy, SPAN * ppr, SPAN * ppr, 0, 0, W, H)
    }
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    for (let rx = Math.floor(x0); rx <= x0 + SPAN + 1; rx++) {
      ctx.beginPath()
      ctx.moveTo(px(rx), 0)
      ctx.lineTo(px(rx), H)
      ctx.stroke()
    }
    for (let rz = Math.floor(zTop - SPAN); rz <= zTop + 1; rz++) {
      ctx.beginPath()
      ctx.moveTo(0, py(rz))
      ctx.lineTo(W, py(rz))
      ctx.stroke()
    }
    const pl = this.info.playable
    if (pl) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'
      ctx.setLineDash([4, 3])
      ctx.strokeRect(px(pl.x0), py(pl.z1 + 1), (pl.x1 - pl.x0 + 1) * s, (pl.z1 - pl.z0 + 1) * s)
      ctx.setLineDash([])
    }
    ctx.strokeStyle = '#f2c14e'
    ctx.lineWidth = 2
    for (const id of this.edited) {
      const rx = id & 0xff, rz = id >> 8
      ctx.strokeRect(px(rx) + 1, py(rz + 1) + 1, s - 2, s - 2)
    }
    if (cam) {
      const cx = W / 2, cy = H / 2
      const len = Math.hypot(cam.fx, cam.fz) || 1
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + (cam.fx / len) * 18, cy + (cam.fz / len) * 18)
      ctx.stroke()
      ctx.fillStyle = '#ffd36b'
      ctx.beginPath()
      ctx.arc(cx, cy, 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

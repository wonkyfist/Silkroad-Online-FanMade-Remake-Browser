/**
 * Live preview of the Spawns tab (docs/QUESTS.md §5.2; lane ED-C): each nest near the GM is drawn as two ground rings
 * (roam radius, spawn radius) and a centre post, with a floating label "Mangyang x8 (6)". The selected nest is
 * highlighted. The rings follow the ground (heights sampled every few metres) and are rebuilt only when a nest's
 * centre or radii change. Everything is disposed with the tab.
 */
import { Color3, CreateLines, Vector3, type LinesMesh, type Scene } from '@babylonjs/core'
import type { GmNestInfo } from '@sro/shared'
import { toScreen } from '../../three/project.ts'
import { el } from '../../ui/dom.ts'

/** Height above the ground of the ring lines (m). */
const LIFT = 0.3
/** Labels further than this from the camera target are hidden (m). */
const LABEL_RANGE = 260
const POST_HEIGHT = 3

const COLORS = {
  roam: new Color3(0.95, 0.75, 0.3),
  spawn: new Color3(0.45, 0.9, 0.45),
  off: new Color3(0.55, 0.55, 0.55),
  selected: new Color3(1, 0.45, 0.15),
  selectedSpawn: new Color3(1, 0.85, 0.3),
}

/** Points of a ground circle: `segments` (closed: the first point repeats), ~3 m apart, 24..160 of them. */
export function circlePoints(x: number, z: number, r: number, height: (x: number, z: number) => number, lift = LIFT): Vector3[] {
  const segments = Math.min(160, Math.max(24, Math.round((2 * Math.PI * Math.max(0, r)) / 3)))
  const out: Vector3[] = []
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2
    const px = x + Math.cos(a) * r
    const pz = z + Math.sin(a) * r
    out.push(new Vector3(px, height(px, pz) + lift, pz))
  }
  return out
}

/** The label of a nest: "Mangyang x8 (6)". */
export function nestLabel(n: Pick<GmNestInfo, 'mobName' | 'count' | 'alive' | 'enabled' | 'id'>, off: string): string {
  return `${n.mobName} x${n.count} (${n.alive})${n.enabled ? '' : ` ${off}`}`
}

interface Drawn {
  key: string
  info: GmNestInfo
  roam: LinesMesh
  spawn: LinesMesh | null
  post: LinesMesh
  label: HTMLElement
  top: Vector3
}

export class NestRings {
  private readonly drawn = new Map<number, Drawn>()
  private readonly labels: HTMLElement
  private selected: number | null = null
  private visible = true

  constructor(
    private readonly scene: Scene,
    /** Ground height at (x, z) (the world's surface, or the GM's level where nothing is loaded). */
    private readonly height: (x: number, z: number) => number,
    labelParent: HTMLElement,
    private readonly offText: string,
  ) {
    this.labels = el('div', 'gm-nest-labels')
    labelParent.append(this.labels)
  }

  /** Shows exactly these nests (others are removed). */
  set(nests: readonly GmNestInfo[]): void {
    const keep = new Set<number>()
    for (const n of nests) {
      keep.add(n.id)
      const key = `${n.x}|${n.z}|${n.radius}|${n.spawnRadius}`
      const d = this.drawn.get(n.id)
      if (d && d.key === key) {
        d.info = n
        this.styleOne(d)
        continue
      }
      if (d) this.dispose1(n.id)
      this.draw(n, key)
    }
    for (const id of [...this.drawn.keys()]) if (!keep.has(id)) this.dispose1(id)
  }

  select(id: number | null): void {
    this.selected = id
    for (const d of this.drawn.values()) this.styleOne(d)
  }

  setVisible(on: boolean): void {
    this.visible = on
    for (const d of this.drawn.values()) {
      d.roam.setEnabled(on)
      d.spawn?.setEnabled(on)
      d.post.setEnabled(on)
      if (!on) d.label.hidden = true
    }
  }

  /** Every frame: places the labels over the nest centres. */
  frame(): void {
    if (!this.visible || !this.drawn.size) return
    const cam = this.scene.activeCamera
    const focus = cam && 'target' in cam ? (cam as unknown as { target: Vector3 }).target : null
    for (const d of this.drawn.values()) {
      const far = focus ? Math.hypot(d.top.x - focus.x, d.top.z - focus.z) > LABEL_RANGE : false
      const p = far ? null : toScreen(this.scene, d.top)
      if (!p || !p.visible) {
        d.label.hidden = true
        continue
      }
      d.label.hidden = false
      d.label.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`
    }
  }

  private draw(n: GmNestInfo, key: string): void {
    const h = this.height
    const y = h(n.x, n.z)
    const roam = CreateLines(`gmNestRoam${n.id}`, { points: circlePoints(n.x, n.z, n.radius, h) }, this.scene)
    const spawn = n.spawnRadius > 0.5 && Math.abs(n.spawnRadius - n.radius) > 0.5 ? CreateLines(`gmNestSpawn${n.id}`, { points: circlePoints(n.x, n.z, n.spawnRadius, h, LIFT + 0.05) }, this.scene) : null
    const post = CreateLines(`gmNestPost${n.id}`, { points: [new Vector3(n.x, y, n.z), new Vector3(n.x, y + POST_HEIGHT, n.z)] }, this.scene)
    for (const m of [roam, spawn, post]) {
      if (!m) continue
      m.isPickable = false
      m.setEnabled(this.visible)
    }
    const label = el('div', 'gm-nest-label')
    label.hidden = true
    this.labels.append(label)
    const d: Drawn = { key, info: n, roam, spawn, post, label, top: new Vector3(n.x, y + POST_HEIGHT + 0.4, n.z) }
    this.drawn.set(n.id, d)
    this.styleOne(d)
  }

  private styleOne(d: Drawn): void {
    const sel = d.info.id === this.selected
    const off = !d.info.enabled
    d.roam.color = sel ? COLORS.selected : off ? COLORS.off : COLORS.roam
    d.post.color = d.roam.color
    if (d.spawn) d.spawn.color = sel ? COLORS.selectedSpawn : off ? COLORS.off : COLORS.spawn
    d.roam.alpha = sel ? 1 : 0.8
    d.label.textContent = `#${d.info.id} ${nestLabel(d.info, this.offText)}`
    d.label.className = `gm-nest-label${sel ? ' selected' : ''}${off ? ' off' : ''}${d.info.source === 'authored' ? ' authored' : ''}`
  }

  private dispose1(id: number): void {
    const d = this.drawn.get(id)
    if (!d) return
    d.roam.dispose()
    d.spawn?.dispose()
    d.post.dispose()
    d.label.remove()
    this.drawn.delete(id)
  }

  clear(): void {
    for (const id of [...this.drawn.keys()]) this.dispose1(id)
  }

  dispose(): void {
    this.clear()
    this.labels.remove()
  }
}

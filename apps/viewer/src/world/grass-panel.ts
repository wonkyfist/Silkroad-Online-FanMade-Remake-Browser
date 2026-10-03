// The viewer's grass lab (docs/GRASS_LIFE.md §8.3, lane GL-O): a section of the render panel with the A/B of the
// grass style (retail scatter / our field), the Grass level, the retail tufts (a reload: they are a load option), the
// wildlife on/off, a tier colouring of the field's three meshes, and the counters (GrassField.stats, WorldLife.counts).
// Idle until used: without a lab parameter nothing here changes the world.
//
// Query parameters: grass=retail|field (the style at load), tufts=1 (keep the placed retail tufts with the field),
// tiers=1 (start with the tier colouring).
import type { Mesh, Observer } from '@babylonjs/core'
import { Vector4 } from '@babylonjs/core'
import { GrassField, type ScatterLevel, type ScatterStyle, type World } from '@sro/world-render'

const STYLES: readonly ScatterStyle[] = ['retail', 'field']
const LEVELS: readonly ScatterLevel[] = ['off', 'low', 'medium', 'high']
/** The tier colouring: near red, mid green, far blue (multiplies the blade colour through scTint). */
const TIER_TINTS: readonly Vector4[] = [new Vector4(1.6, 0.35, 0.35, 0.5), new Vector4(0.35, 1.6, 0.35, 0.5), new Vector4(0.4, 0.55, 1.9, 0.5)]

export interface GrassLabParams {
  style: ScatterStyle | null
  tufts: boolean
  tiers: boolean
}

/** `?grass=`, `?tufts=1`, `?tiers=1`. */
export function parseGrassParams(search: string): GrassLabParams {
  const p = new URLSearchParams(search)
  const style = p.get('grass')
  return {
    style: STYLES.includes(style as ScatterStyle) ? style as ScatterStyle : null,
    tufts: p.get('tufts') === '1',
    tiers: p.get('tiers') === '1',
  }
}

/** The life part's viewer-facing extras (WorldLife: counts and stats; not on the LifePart interface). */
interface LifeDebug {
  counts?(): { critters: number; birds: number; fireflies: number; flocks: number }
  readonly stats?: { updateMs: number; worstMs: number }
}

export class GrassPanel {
  private tiers: boolean
  private readonly hooked = new Map<Mesh, Observer<Mesh>>()
  private field: GrassField | null = null
  /** The field material's own scTint (restored when the colouring goes off). */
  private baseTint: Vector4 | null = null
  private readonly out: HTMLPreElement

  constructor(parent: HTMLElement, private readonly world: World, private readonly params: GrassLabParams) {
    this.tiers = params.tiers
    if (params.style && params.style !== world.grassStyle) world.setGrassStyle(params.style)
    const d = document.createElement('details')
    const s = document.createElement('summary')
    s.textContent = 'Grass & wildlife (GL-O)'
    d.appendChild(s)
    parent.appendChild(d)
    this.select(d, 'Style', STYLES.map(v => [v, v === 'field' ? 'New (field)' : 'Retail']), world.grassStyle, v => {
      world.setGrassStyle(v as ScatterStyle)
    })
    this.select(d, 'Grass', LEVELS.map(v => [v, v]), world.scatter.level, v => world.scatter.setLevel(v as ScatterLevel))
    const checks = document.createElement('div')
    checks.className = 'lab-checks'
    checks.append(
      check('Retail tufts with the field (reloads)', params.tufts, on => {
        const url = new URL(location.href)
        if (on) url.searchParams.set('tufts', '1')
        else url.searchParams.delete('tufts')
        location.href = url.toString()
      }),
      check('Tier colours (near red, mid green, far blue)', this.tiers, on => {
        this.tiers = on
        this.syncTiers()
      }),
      check('Wildlife', world.life?.enabled ?? false, on => world.life?.setEnabled(on)),
    )
    d.appendChild(checks)
    this.out = document.createElement('pre')
    this.out.className = 'lab-out'
    d.appendChild(this.out)
    world.scene.onBeforeRenderObservable.add(() => this.syncTiers())
    window.setInterval(() => {
      if (d.open) this.render()
    }, 250)
  }

  /** Hooks (or unhooks) the tier tint on the current field's meshes; follows a field made again by a style switch. */
  private syncTiers(): void {
    const g = this.world.scatter.groundCover
    const field = g instanceof GrassField ? g : null
    if (field !== this.field) {
      this.unhook()
      this.field = field
      this.baseTint = null
    }
    if (!field || !this.tiers) {
      this.unhook()
      return
    }
    if (this.hooked.size) return
    const mat = field.material
    this.baseTint ??= (mat as unknown as { _vectors4?: Record<string, Vector4> })._vectors4?.scTint ?? null
    for (const m of field.meshes()) {
      const lod = (m.metadata as { grassLod?: number } | null)?.grassLod ?? 0
      const tint = TIER_TINTS[lod] ?? TIER_TINTS[0]!
      // Before the bind: the three tiers share one material, so each draw sets its own tint and drops the scene's
      // material cache (else the second and third tier skip the uniform bind and keep the first tier's tint).
      this.hooked.set(m, m.onBeforeBindObservable.add(() => {
        mat.setVector4('scTint', tint)
        this.world.scene.resetCachedMaterial()
      }))
    }
  }

  private unhook(): void {
    if (!this.hooked.size) return
    for (const [m, o] of this.hooked) m.onBeforeBindObservable.remove(o)
    this.hooked.clear()
    if (this.field && this.baseTint) this.field.material.setVector4('scTint', this.baseTint)
  }

  private render(): void {
    const w = this.world
    const lines = [
      `style ${w.grassStyle} (drawing ${w.scatter.style})  level ${w.scatter.level}  tufts hidden ${w.retailTuftsHidden}${this.params.tufts ? ' (tufts=1)' : ''}`,
    ]
    const f = this.field
    if (f) {
      const s = f.stats
      const shown = f.meshes().filter(m => m.isVisible).length
      lines.push(
        `regions ${s.regions}  baked ${s.baked}  pending ${s.pending}`,
        `cells near ${s.cells[0]}  mid ${s.cells[1]}  far ${s.cells[2]}  draws ${shown}`,
        `vertices ${s.vertices.toLocaleString('en')}  triangles ${s.triangles.toLocaleString('en')}`,
        `cull ${s.cullMs.toFixed(3)} ms  fill ${s.fillMs.toFixed(2)} ms (${s.fills})  uploads ${s.uploads}`,
        `bake: worst slice ${s.worstSliceMs.toFixed(2)} ms  last region ${s.lastRegionBakeMs.toFixed(1)} ms`,
      )
    } else {
      lines.push('no field (retail style, Grass: Off, or the Classic path)')
    }
    const life = w.life as (LifeDebug & NonNullable<World['life']>) | null
    if (life) {
      const c = life.counts?.()
      lines.push(`wildlife ${life.enabled ? 'on' : 'off'}${c ? `  critters ${c.critters}  birds ${c.birds}  fireflies ${c.fireflies}  flocks ${c.flocks}` : ''}`)
      if (life.stats) lines.push(`life update ${life.stats.updateMs.toFixed(3)} ms  worst ${life.stats.worstMs.toFixed(2)} ms`)
    } else {
      lines.push('no wildlife (the Classic path)')
    }
    this.out.textContent = lines.join('\n')
  }

  private select(parent: HTMLElement, label: string, options: readonly (readonly [string, string])[], value: string, onChange: (v: string) => void): void {
    const row = document.createElement('label')
    row.className = 'row'
    row.textContent = label
    const sel = document.createElement('select')
    for (const [v, text] of options) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = text
      sel.appendChild(o)
    }
    sel.value = value
    sel.addEventListener('change', () => onChange(sel.value))
    row.appendChild(sel)
    parent.appendChild(row)
  }
}

function check(text: string, on: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const l = document.createElement('label')
  const c = document.createElement('input')
  c.type = 'checkbox'
  c.checked = on
  c.addEventListener('change', () => onChange(c.checked))
  l.append(c, ` ${text}`)
  return l
}

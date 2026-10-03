/**
 * The shore part (docs/COAST.md §8.8, §12.5; ocean/shore-seam.ts). The ocean calls `createShorePart` once its coast
 * field is loaded; this part makes the lace (shore/lace.ts, generated in row slices off the load's critical path; the
 * part is `ready`, and the ocean turns `SRO_OCEAN_SHORE` on, once it exists), keeps the swash clock, and sets the
 * shore's uniforms each frame the sea draws (shore/chunks.ts):
 *
 * - the cycle counter advances by dt / T (never from the absolute clock, so a period that follows the sea state never
 *   jumps the phase), wrapping at PHASE_WRAP waves;
 * - the run-up and the shore swell's height follow the sea's Hs (shore/swash.ts `maxRunup`, `shoreSwellHeight`), the
 *   foam gain the storminess;
 * - the preset's row: Low's band (no lace) and vertex swash, or v1 with the lace and the analytic bead.
 *
 * On the PBR path it also drives the terrain's wet band (coast/chunks.ts `sroCoastWet`): the coast field, its uv
 * transform and the swash state go into TerrainRenderer.sharedUniforms and `SRO_COAST_WET` is set on the terrain;
 * on the Classic path (Low) and on dispose they are removed again, so Low's terrain never sees the define.
 */
import { Constants, RawTexture, Texture, Vector4 } from '@babylonjs/core'
import { COAST_WET_DEFINE, COAST_WET_FIELD, COAST_WET_SHORE, COAST_WET_XF } from '../coast/chunks.ts'
import type { ShoreBinder, ShoreFrame, ShoreHost, ShorePart } from '../ocean/shore-seam.ts'
import { LACE_SIZE, makeLaceSliced } from './lace.ts'
import { NOMINAL_SLOPE, PHASE_WRAP, maxRunup, shoreSwellHeight } from './swash.ts'

/**
 * The shore swell's period (s): the sea's peak period, but never shorter than a swell's (Tidewater's ShoreWaves.js
 * uses 9 s; ours 8.5 s calm → 11 s in a storm), within this range. A clear day's peak is the wind sea's ≈ 3 s chop,
 * which would make the swash flicker.
 */
export const SHORE_PERIOD_S: readonly [number, number] = [7, 14]
export function shorePeriod(peakS: number, storm: number): number {
  return Math.min(SHORE_PERIOD_S[1], Math.max(SHORE_PERIOD_S[0], peakS || 0, 8.5 + 2.5 * Math.min(1, Math.max(0, storm))))
}
/** The ocean clock wraps here (s; shore-seam.ts `ShoreFrame.time`). */
const CLOCK_WRAP_S = 3600

export interface ShoreOptions {
  /** Lace texels per side (default LACE_SIZE). */
  laceSize?: number
  /** How a lace slice is scheduled (default a macrotask; tests run it inline). */
  schedule?: (fn: () => void) => void
}

export class Shore implements ShorePart {
  /** `sroShoreA`: cycle counter (waves), period (s), maximum run-up (m), the shore swell's height (m). */
  readonly a = new Vector4(0, 9, maxRunup(0.5), shoreSwellHeight(0.5, 0))
  /** `sroShoreB`: nominal slope (1:n), foam gain, lace on, bead on. */
  readonly b = new Vector4(NOMINAL_SLOPE, 1, 1, 1)
  /** The terrain's `sroCoastXf` and `sroCoastShore` (bound by reference). */
  readonly coastXf = new Vector4(0, 0, 0, 0)
  readonly coastShore = new Vector4(0, 9, 0, 0)
  private lace: RawTexture | null = null
  private lastTime: number | null = null
  private terrainOn = false
  private disposed = false

  constructor(readonly host: ShoreHost, opts: ShoreOptions = {}) {
    const size = opts.laceSize ?? LACE_SIZE
    void makeLaceSliced(size, 32, () => this.disposed, opts.schedule).then(data => {
      if (!data || this.disposed) return
      const t = new RawTexture(data, size, size, Constants.TEXTUREFORMAT_RGBA, host.scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
      t.name = 'sroShoreLace'
      t.wrapU = Texture.WRAP_ADDRESSMODE
      t.wrapV = Texture.WRAP_ADDRESSMODE
      t.anisotropicFilteringLevel = 4
      this.lace = t
    })
  }

  get ready(): boolean {
    return !!this.lace
  }

  /** The lace texture (null until generated). */
  get laceTexture(): RawTexture | null {
    return this.lace
  }

  /** Whether the terrain's wet band is installed. */
  get terrainWet(): boolean {
    return this.terrainOn
  }

  update(frame: Readonly<ShoreFrame>): void {
    let dt = this.lastTime === null ? 0 : frame.time - this.lastTime
    if (dt < -CLOCK_WRAP_S / 2) dt += CLOCK_WRAP_S
    dt = Math.min(0.25, Math.max(0, dt))
    this.lastTime = frame.time
    const storm = Math.min(1, Math.max(0, frame.storm))
    const period = shorePeriod(frame.periodS, storm)
    const phase = (this.a.x + dt / period) % PHASE_WRAP
    const runup = maxRunup(frame.hs)
    this.a.set(phase, period, runup, shoreSwellHeight(frame.hs, storm))
    const v1 = frame.quality.foam !== 'band'
    this.b.set(NOMINAL_SLOPE, 1 + 0.4 * storm, v1 ? 1 : 0, v1 && frame.quality.shore === 'pixel' ? 1 : 0)
    this.syncTerrain(frame.path === 'pbr')
    if (this.terrainOn) {
      this.coastXf.copyFrom(this.host.field.xf)
      this.coastShore.set(phase, period, runup, frame.seaLevelM)
    }
  }

  setPath(path: 'pbr' | 'classic'): void {
    if (!this.disposed) this.syncTerrain(path === 'pbr')
  }

  bind(to: ShoreBinder): void {
    to.vec4('sroShoreA', this.a)
    to.vec4('sroShoreB', this.b)
    if (this.lace) to.texture('sroShoreLace', this.lace)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.syncTerrain(false)
    this.lace?.dispose()
    this.lace = null
  }

  /** Installs or removes the terrain's wet band (PBR only). */
  private syncTerrain(on: boolean): void {
    if (on === this.terrainOn) return
    const t = this.host.world.terrain
    const shared = t.sharedUniforms
    try {
      if (on) {
        // Valid before the first update with a sea node (the sea may be out of view when it installs).
        this.coastXf.copyFrom(this.host.field.xf)
        if (this.lastTime === null) this.coastShore.w = this.host.field.seaLevelM
        shared.set(COAST_WET_FIELD, this.host.field.texture(this.host.scene))
        shared.set(COAST_WET_XF, this.coastXf)
        shared.set(COAST_WET_SHORE, this.coastShore)
        t.setDefine(COAST_WET_DEFINE, true)
      } else {
        t.setDefine(COAST_WET_DEFINE, false)
        shared.delete(COAST_WET_FIELD)
        shared.delete(COAST_WET_XF)
        shared.delete(COAST_WET_SHORE)
      }
    } catch (err) {
      console.warn('[shore] terrain wet band:', err)
    }
    this.terrainOn = on
  }
}

/** The shore of an ocean (null: none). */
export function createShorePart(host: ShoreHost, opts?: ShoreOptions): ShorePart | null {
  return new Shore(host, opts)
}

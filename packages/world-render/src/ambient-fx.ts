/**
 * World ambient effects (docs/EFFECTS.md §3.15, lane FX-C2): the particles world objects carry in their BSR mod
 * palettes (sidecar `particles`, set 'ambient'): torch and brazier fires (`map/frame.efp`), the shop lamps, the
 * blacksmith's chimney smoke (`map/oas_hot_etc_b.efp`), waterfalls and water wheels, portal glows.
 *
 * This module only decides WHICH emitters play: it knows every placed emitter (object placements x their model's
 * particles, from the world's `ambient.json` index of the sidecar particles), keeps at most `max` of them live (the
 * nearest to the focus within `range` metres; the N100 budget is 40 within 60 m), skips night-only ones by day, and asks
 * the app's `AmbientPlay` to start or stop each one. The effect engine lives in the app (world-render does not
 * depend on @sro/fx). WorldObjects reports placements per streamed region (objects.ts `setAmbient`).
 */
import type { WorldPlacement } from '../../convert/src/world/manifest.ts'
import type { Assets } from './assets.ts'
import { placementScale } from './placement-scale.ts'

export type AmbientV3 = [number, number, number]
/** Column-major 3x3 rotation (the @sro/fx root pose convention). */
export type AmbientM3 = [number, number, number, number, number, number, number, number, number]

/** One sidecar particle (packages/convert/src/fx/model-fx.ts ModelParticle), the fields used here. */
export interface AmbientParticle {
  kind: 'ambient' | 'status' | 'clip'
  efp: string
  bone: string | null
  /** glTF metres in the model's frame. */
  position: AmbientV3
  night: boolean
}

/** A placed emitter: one ambient particle of one object placement. */
export interface AmbientEmitter {
  key: string
  position: AmbientV3
  rotation: AmbientM3
  night: boolean
  region: number
  /** The manifest model index of the placement that owns it (wave 9: NL's light table by owner model). */
  model?: number
}

export interface AmbientHandle {
  stop(): void
}

/** Starts one looping effect at a world pose; the handle stops it (it fades out). */
export type AmbientPlay = (key: string, position: AmbientV3, rotation: AmbientM3) => AmbientHandle

export interface AmbientOptions {
  /** Live emitters at most (default 40). */
  max?: number
  /** Only emitters this close to the focus play (m, default 60). */
  range?: number
}

/** Re-pick the live set after the focus moved this far (m). */
const REFOCUS_M = 2

/** Reads a world's `ambient.json` ({ models: { [modelIndex]: particles[] } }); tolerant, ambient rows only. */
export function readAmbientIndex(json: unknown): Map<number, AmbientParticle[]> {
  const out = new Map<number, AmbientParticle[]>()
  const models = (json as { models?: unknown } | null)?.models
  if (!models || typeof models !== 'object') return out
  for (const [k, list] of Object.entries(models as Record<string, unknown>)) {
    const index = Number(k)
    if (!Number.isInteger(index) || !Array.isArray(list)) continue
    const rows: AmbientParticle[] = []
    for (const p of list as Partial<AmbientParticle>[]) {
      if (!p || p.kind !== 'ambient' || typeof p.efp !== 'string') continue
      const pos = Array.isArray(p.position) && p.position.length === 3 && p.position.every(n => typeof n === 'number') ? (p.position as AmbientV3) : ([0, 0, 0] as AmbientV3)
      rows.push({ kind: 'ambient', efp: p.efp, bone: typeof p.bone === 'string' && p.bone ? p.bone : null, position: [pos[0], pos[1], pos[2]], night: p.night === true })
    }
    if (rows.length) out.set(index, rows)
  }
  return out
}

/** Column-major rotation of a quaternion [x, y, z, w]. */
export function quatMatrix(q: readonly number[]): AmbientM3 {
  const [x = 0, y = 0, z = 0, w = 1] = q
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
  ]
}

/**
 * World position of a model-space point under a placement (scale, rotation, then translation; W12-SA S-SCALE: the
 * placement's uniform scale, 1 when absent).
 */
export function placeEmitter(p: Pick<WorldPlacement, 'position' | 'rotation' | 'scale'>, local: readonly number[]): AmbientV3 {
  const r = quatMatrix(p.rotation)
  const s = placementScale(p)
  const [x = 0, y = 0, z = 0] = s === 1 ? local : [(local[0] ?? 0) * s, (local[1] ?? 0) * s, (local[2] ?? 0) * s]
  return [p.position[0] + r[0] * x + r[3] * y + r[6] * z, p.position[1] + r[1] * x + r[4] * y + r[7] * z, p.position[2] + r[2] * x + r[5] * y + r[8] * z]
}

/** The emitters that should play: lit now (night flag), within `range` of `focus`, the nearest `max` first. */
export function pickEmitters(list: Iterable<AmbientEmitter>, focus: { x: number; y: number; z: number }, max: number, range: number, night: boolean): AmbientEmitter[] {
  const near: { e: AmbientEmitter; d: number }[] = []
  const r2 = range * range
  for (const e of list) {
    if (e.night && !night) continue
    const dx = e.position[0] - focus.x
    const dy = e.position[1] - focus.y
    const dz = e.position[2] - focus.z
    const d = dx * dx + dy * dy + dz * dz
    if (d <= r2) near.push({ e, d })
  }
  near.sort((a, b) => a.d - b.d)
  return near.slice(0, Math.max(0, max)).map(n => n.e)
}

export interface AmbientStats {
  emitters: number
  live: number
  models: number
}

export class AmbientFx {
  private index = new Map<number, AmbientParticle[]>()
  private readonly byRegion = new Map<number, AmbientEmitter[]>()
  private readonly live = new Map<AmbientEmitter, AmbientHandle>()
  private play: AmbientPlay | null = null
  private night = false
  private readonly focus = { x: NaN, y: NaN, z: NaN }
  private dirty = true
  readonly max: number
  readonly range: number

  constructor(opts: AmbientOptions = {}) {
    this.max = opts.max ?? 40
    this.range = opts.range ?? 60
  }

  /** Reads the world's `ambient.json` (none = no ambient effects). */
  async load(assets: Pick<Assets, 'json'>, rel = 'ambient.json'): Promise<void> {
    try {
      this.setIndex(readAmbientIndex(await assets.json<unknown>(rel)))
    } catch {
      this.setIndex(new Map())
    }
  }

  setIndex(index: Map<number, AmbientParticle[]>): void {
    this.index = index
  }

  /** Models with ambient particles. */
  hasModel(modelIndex: number): boolean {
    return this.index.has(modelIndex)
  }

  /** Placements of one model in one region (or NO_REGION): their emitters join the pool. */
  add(region: number, modelIndex: number, placements: readonly Pick<WorldPlacement, 'position' | 'rotation' | 'scale'>[]): void {
    const rows = this.index.get(modelIndex)
    if (!rows || !placements.length) return
    let list = this.byRegion.get(region)
    if (!list) this.byRegion.set(region, (list = []))
    for (const p of placements) {
      const rotation = quatMatrix(p.rotation)
      for (const row of rows) list.push({ key: row.efp, position: placeEmitter(p, row.position), rotation, night: row.night, region, model: modelIndex })
    }
    this.dirty = true
  }

  /** A region unloaded: its emitters stop. */
  removeRegion(region: number): void {
    const list = this.byRegion.get(region)
    if (!list) return
    this.byRegion.delete(region)
    for (const e of list) this.stopOne(e)
  }

  /** Who plays the effects (null stops them all). */
  setPlayer(play: AmbientPlay | null): void {
    if (!play) for (const e of [...this.live.keys()]) this.stopOne(e)
    this.play = play
    this.dirty = true
  }

  /** Night-only emitters (most lamps) play at night only. */
  setNight(on: boolean): void {
    if (on === this.night) return
    this.night = on
    this.dirty = true
  }

  /** Re-picks the live set around `focus` (when it moved REFOCUS_M, or something changed). */
  update(focus: { x: number; y: number; z: number }): void {
    const moved = !(Math.hypot(focus.x - this.focus.x, focus.y - this.focus.y, focus.z - this.focus.z) < REFOCUS_M)
    if (!moved && !this.dirty) return
    this.focus.x = focus.x
    this.focus.y = focus.y
    this.focus.z = focus.z
    this.dirty = false
    if (!this.play) return
    const want = new Set(pickEmitters(this.all(), focus, this.max, this.range, this.night))
    for (const e of [...this.live.keys()]) if (!want.has(e)) this.stopOne(e)
    for (const e of want) {
      if (this.live.has(e)) continue
      try {
        this.live.set(e, this.play(e.key, e.position, e.rotation))
      } catch (err) {
        console.warn('[world] ambient effect failed', e.key, err)
      }
    }
  }

  /**
   * The placed emitters (read-only), of one owner region or of all (docs/WAVE_PLAN3.md §4.1: NL builds its light list
   * from them). `key` is the efp path, `night` the night-only flag, `model` the owner model index.
   */
  emitters(region?: number): readonly Readonly<AmbientEmitter>[] {
    if (region !== undefined) return [...(this.byRegion.get(region) ?? [])]
    return [...this.all()]
  }

  /** The ambient particles of one model (from ambient.json), for listeners that place them themselves. */
  particles(modelIndex: number): readonly Readonly<AmbientParticle>[] {
    return this.index.get(modelIndex) ?? []
  }

  private *all(): Iterable<AmbientEmitter> {
    for (const list of this.byRegion.values()) yield* list
  }

  private stopOne(e: AmbientEmitter): void {
    const h = this.live.get(e)
    if (!h) return
    this.live.delete(e)
    try {
      h.stop()
    } catch {
      // the effect is gone already
    }
  }

  get stats(): AmbientStats {
    let emitters = 0
    for (const list of this.byRegion.values()) emitters += list.length
    return { emitters, live: this.live.size, models: this.index.size }
  }

  dispose(): void {
    this.setPlayer(null)
    this.byRegion.clear()
  }
}

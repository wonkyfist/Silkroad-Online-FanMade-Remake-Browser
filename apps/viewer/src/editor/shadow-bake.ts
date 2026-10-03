/**
 * Baked shadows follow the edits in the editor (H-12 GH-2; docs/WORLD_EDITOR.md §4.6, F8, D51): after a move, turn,
 * scale, delete, add or a ground edit (and their undo, redo and revert), the lightmap of every region the old and new
 * shadows touch is baked again in a worker (./shadow-bake-worker.ts, the converter's node-free `bakeEditedLightmap`)
 * from the region's exported lightmap, and swapped into the terrain (S-TERR `updateRegion` with a new lightmap). The
 * bake always starts from the export: every edited object's export state is a shadow that goes, its current state one
 * that comes, so the result never depends on the order of the edits, and a region with nothing edited gets the
 * export's lightmap back. A region that streams in later is baked when it lands (the export's lightmap first).
 *
 * The converter bakes the same way at Publish; this is the preview (WAVE_PLAN8 §7 cut 14 not taken).
 */
import { RawTexture, Texture } from '@babylonjs/core'
import type { World } from '@sro/world-render'
import { casterOf, type CasterInstance } from '../../../../packages/convert/src/world/edits/shadows.ts'
import type { WorldPlacement } from '../../../../packages/convert/src/world/manifest.ts'
import type { ChangeParts } from './history.ts'
import type { ObjState } from './object-edits.ts'
import type { EditSession } from './session.ts'
import type { BakeRequest, BakeResponse } from './shadow-bake-worker.ts'

/** How far an object's baked shadow reaches from its origin (m): a 30 m roof at the baked sun's 38° elevation. */
export const SHADOW_REACH_M = 50
/** Edits are baked this long after the last one (ms): a drag of the gizmo is one bake, not one per frame. */
export const BAKE_DEBOUNCE_MS = 350

const REGION_M = 192
const HALF_DIAGONAL_M = (REGION_M / 2) * Math.SQRT2

export interface ShadowBakerOptions {
  world: World
  session: EditSession
  /** The worker (default: the module worker beside this file; null: no bake, e.g. in tests). */
  worker?: (() => Worker | null) | null
  /** Called after a region's lightmap changed (the editor's render gate). */
  invalidate?: () => void
}

/** The regions (manifest ids) whose rectangle comes within `r` metres of glTF (x, z). */
export function regionsNear(world: Pick<World, 'manifest'>, x: number, z: number, r: number): number[] {
  const out: number[] = []
  for (const g of world.manifest.regions) {
    const x0 = g.origin[0], z1 = g.origin[2]
    const d = Math.hypot(Math.max(x0 - x, 0, x - x0 - REGION_M), Math.max(z1 - REGION_M - z, 0, z - z1))
    if (d <= r) out.push(g.id)
  }
  return out
}

/** A placement as it stands in `state` (position, yaw, scale), for casterOf. */
function placed(p: WorldPlacement, s: ObjState): WorldPlacement {
  return { ...p, position: [s.position[0], s.position[1], s.position[2]], yaw: s.yaw, ...(s.scale !== 1 ? { scale: s.scale } : {}) }
}

export class ShadowBaker {
  private readonly world: World
  private readonly session: EditSession
  private worker: Worker | null = null
  private readonly dirty = new Set<number>()
  /** Regions ever baked or marked: baked again when they stream in. */
  private readonly touched = new Set<number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private seq = 0
  private readonly waits = new Map<number, (r: BakeResponse) => void>()
  private readonly offs: Array<() => void> = []
  private disposed = false
  /** Regions baked, failures, the last bake's worker time (ms). */
  baked = 0
  failures = 0
  lastMs = 0

  constructor(private readonly o: ShadowBakerOptions) {
    this.world = o.world
    this.session = o.session
    const make = o.worker === undefined ? defaultWorker : o.worker
    try {
      this.worker = make ? make() : null
    } catch (err) {
      console.warn('[editor] no shadow bake worker:', err)
      this.worker = null
    }
    if (this.worker) {
      this.worker.onmessage = (ev: MessageEvent<BakeResponse>) => {
        const w = this.waits.get(ev.data.id)
        this.waits.delete(ev.data.id)
        w?.(ev.data)
      }
    }
    this.offs.push(this.session.onChange(parts => this.changed(parts)))
    const built = this.world.terrain.onRegionBuilt.add(g => {
      if (this.touched.has(g.id)) this.mark([g.id])
    })
    this.offs.push(() => this.world.terrain.onRegionBuilt.remove(built))
  }

  /** The regions a change's shadows touch (objects: the old and new spot; ground: its regions and their neighbours). */
  private changed(parts: ChangeParts): void {
    if (this.disposed) return
    const ids: number[] = []
    const near = (s: ObjState | null) => {
      if (s) ids.push(...regionsNear(this.world, s.position[0], s.position[2], SHADOW_REACH_M))
    }
    for (const it of parts.objects?.items ?? []) {
      near(it.before)
      near(it.after)
    }
    if (parts.height) {
      for (const id of parts.height.regions) {
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) ids.push((((id >> 8) + dz) << 8) | ((id & 0xff) + dx))
      }
    }
    // a load (no parts): every region an edit touches
    if (!parts.objects && !parts.height && !parts.paint && !parts.grass) {
      const o = this.session.objects
      for (const ref of o.editedRefs()) {
        near(o.original(ref))
        near(o.current(ref))
      }
      for (const id of this.session.heights.touchedRegions()) ids.push(id)
    }
    if (ids.length) this.mark(ids)
  }

  private mark(ids: readonly number[]): void {
    const known = new Set(this.world.manifest.regions.map(r => r.id))
    for (const id of ids) {
      if (!known.has(id)) continue
      this.dirty.add(id)
      this.touched.add(id)
    }
    if (!this.dirty.size || !this.worker) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, BAKE_DEBOUNCE_MS)
  }

  private async run(): Promise<void> {
    if (this.running || this.disposed) return
    this.running = true
    try {
      while (this.dirty.size && !this.disposed) {
        const id = this.dirty.values().next().value!
        this.dirty.delete(id)
        const req = this.request(id)
        if (!req) continue
        const res = await this.post(req)
        if (this.disposed) return
        if (!res.rgba || res.error) {
          this.failures++
          if (res.error) console.warn(`[editor] lightmap bake ${id & 0xff},${id >> 8}:`, res.error)
          continue
        }
        // an edit since the job was sent: it is baked again (the dirty set has it)
        this.upload(id, res)
        this.baked++
        this.lastMs = res.ms
      }
    } finally {
      this.running = false
    }
  }

  private post(req: BakeRequest): Promise<BakeResponse> {
    return new Promise(resolve => {
      this.waits.set(req.id, resolve)
      this.worker!.postMessage(req)
    })
  }

  /** The job of one resident region (null: not built, or the export has no lightmap for it). */
  request(id: number): BakeRequest | null {
    const w = this.world
    const r = w.manifest.regions.find(g => g.id === id)
    if (!r?.lightmap || !w.regions.get(id)) return null
    const heights: BakeRequest['heights'] = []
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nid = ((r.z + dz) << 8) | (r.x + dx)
        const after = w.regions.get(nid)?.terrain.heights
        if (!after) continue
        const before = this.session.heights.baseOf(nid) ?? after
        heights.push({ rx: r.x + dx, rz: r.z + dz, before: Float32Array.from(before), after: Float32Array.from(after) })
      }
    }
    const models = w.manifest.models
    const objs = this.session.objects
    const cx = r.origin[0] + REGION_M / 2, cz = r.origin[2] - REGION_M / 2
    const reach = HALF_DIAGONAL_M + SHADOW_REACH_M
    const inReach = (s: ObjState) => Math.hypot(s.position[0] - cx, s.position[2] - cz) <= reach
    const scene: CasterInstance[] = []
    for (const n of objs.near(cx, cz, reach)) {
      if (!n.placement) continue
      const c = casterOf(placed(n.placement, n.state), models)
      if (c) scene.push(c)
    }
    const gone: CasterInstance[] = []
    const come: CasterInstance[] = []
    for (const ref of objs.editedRefs()) {
      const before = objs.original(ref)
      const now = objs.current(ref)
      const p = objs.placementOf(ref) ?? objs.templateOf((now ?? before)?.source ?? '')
      if (!p) continue
      if (before && inReach(before)) {
        const c = casterOf(placed(p, before), models)
        if (c) gone.push(c)
      }
      if (now && inReach(now)) {
        const c = casterOf(placed(p, now), models)
        if (c) come.push(c)
      }
    }
    const glbs: Record<number, string> = {}
    for (const c of [...scene, ...gone, ...come]) {
      for (const part of c.parts) {
        const glb = models[part.model]?.glb
        if (glb && !(part.model in glbs)) glbs[part.model] = absolute(w.assets.url(glb))
      }
    }
    return {
      id: ++this.seq, rx: r.x, rz: r.z, origin: [r.origin[0], r.origin[1], r.origin[2]], imageUrl: absolute(w.assets.url(r.lightmap.file)),
      heights, gone, come, scene, glbs,
    }
  }

  private upload(id: number, res: BakeResponse): void {
    const scene = this.world.scene
    const tex = RawTexture.CreateRGBATexture(res.rgba!, res.width, res.height, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
    tex.wrapU = Texture.CLAMP_ADDRESSMODE
    tex.wrapV = Texture.CLAMP_ADDRESSMODE
    tex.name = `editorLightmap:${id & 0xff}_${id >> 8}`
    const done = this.world.terrain.updateRegion(id, { lightmap: tex })
    if (!done?.lightmap) tex.dispose()
    else this.o.invalidate?.()
  }

  stats(): { baked: number; failures: number; lastMs: number; pending: number } {
    return { baked: this.baked, failures: this.failures, lastMs: +this.lastMs.toFixed(1), pending: this.dirty.size }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    for (const off of this.offs.splice(0)) off()
    for (const w of this.waits.values()) w({ id: -1, width: 0, height: 0, rgba: null, ms: 0 })
    this.waits.clear()
    this.worker?.terminate()
    this.worker = null
  }
}

const absolute = (url: string) => new URL(url, globalThis.location?.href ?? 'http://localhost/').href

function defaultWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  return new Worker(new URL('./shadow-bake-worker.ts', import.meta.url), { type: 'module', name: 'sro-editor-shadow-bake' })
}

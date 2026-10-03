/**
 * Hit light flashes (docs/EFFECTS.md M12): skilleffect LIGHT_n is a point light at the hit, 300 ms, fading 1 -> 0.
 * A small pool of PointLights is made once and kept enabled at intensity 0, so starting a flash never changes the
 * light count (no shader recompiles). They light characters only: world objects are excluded by their layer mask
 * (World.isolateLights, packages/world-render). The range is our rule (the file's 1000 is in an unknown unit).
 *
 * Wave 9 (GAME, docs/WAVE_PLAN3.md D12): on the PBR presets the pool joins the night lights' clustered container
 * (NightLights.addDynamicLight), so a flash lights everything near the hit without adding a light to any material.
 * The night lights register themselves with `setHitLightCluster` (world/features/fx-world.ts); the pools try to join
 * about once a second while they are plain scene lights, so they come back after the cluster is rebuilt (a preset
 * change) and simply stay scene lights where there is no cluster (Low, the pool fallback, WebGL without clusters).
 *
 * W9F G1/L1/X2: a join moves light slots under effects already compiled for the old list, and Babylon's shader
 * hot-swap then draws the old program with the new light blocks (WebGL2: 'uniform buffer that is too small'; the
 * blocks it does not bind keep another program's buffers). So `setHitLightCluster` joins every live pool of that scene
 * at once (the frame that creates the cluster renders the final list, no throwaway compile), a newly added cluster
 * (a preset rebuild) is joined on the next update rather than up to a second later, and every join marks the meshes
 * that lost the light as "lights disposed": Babylon then skips their draw until the new program is ready instead of
 * hot-swapping.
 */
import { ClusteredLightContainer, Color3, PointLight, Vector3, type AbstractMesh, type Light, type Observer, type Scene } from '@babylonjs/core'
import type { V3 } from '@sro/fx'
import { WORLD_GROUND_LAYER, WORLD_OBJECT_LAYER } from '@sro/world-render'

/** Lights in the pool: characters already carry the hemisphere and the sun; PBR materials take 4 at most. */
export const HIT_LIGHTS = 2
/** Reach of a flash (metres) [our rule]. */
export const HIT_LIGHT_RANGE = 6
/** Peak intensity. */
const PEAK = 2.2
/** How often a pool outside a cluster tries to join one (ms). */
export const CLUSTER_RETRY_MS = 1000

/** The part of world-render's NightLights the pools use (its `host.scene` tells which scene it lights). */
export interface HitLightCluster {
  readonly host?: { readonly scene: Scene }
  addDynamicLight(light: Light): boolean
}

let cluster: HitLightCluster | null = null
/** Every live pool (setHitLightCluster joins them at once). */
const pools = new Set<HitLights>()

/**
 * The night lights of the current world (null: none), for every hit-light pool of its scene. The pools of that scene
 * join at once, so the cluster and the joined hit lights reach the materials in the same frame (W9F G1).
 */
export function setHitLightCluster(c: HitLightCluster | null): void {
  cluster = c
  if (c) for (const p of pools) p.joinCluster(undefined, true)
}

/** The registered cluster (tests). */
export function hitLightCluster(): HitLightCluster | null {
  return cluster
}

interface Flash {
  light: PointLight
  start: number
  ms: number
}

export class HitLights {
  private readonly pool: Flash[] = []
  private enabled = true
  private disposed = false
  private nextJoin = -Infinity
  private readonly onLight: Observer<Light> | null

  constructor(private readonly scene: Scene, private readonly now: () => number, count = HIT_LIGHTS) {
    for (let i = 0; i < count; i++) {
      const light = new PointLight(`fx:hitlight${i}`, Vector3.Zero(), scene)
      light.intensity = 0
      light.range = HIT_LIGHT_RANGE
      light.specular = Color3.Black()
      // Characters only: never world objects, nor a slot on a 4-light terrain, water or ice material (W9F L3).
      light.excludeWithLayerMask |= WORLD_OBJECT_LAYER | WORLD_GROUND_LAYER
      this.pool.push({ light, start: -Infinity, ms: 0 })
    }
    // A new cluster (a preset rebuild hands the pool back to the scene first): join on the next update, not a second on.
    this.onLight = scene.onNewLightAddedObservable.add(l => {
      if (l instanceof ClusteredLightContainer) this.nextJoin = -Infinity
    })
    pools.add(this)
  }

  /** Off below the "medium" graphics quality: flashes are skipped (the lights stay, dark). */
  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) for (const f of this.pool) f.light.intensity = 0
  }

  get active(): number {
    const t = this.now()
    return this.pool.filter(f => t - f.start < f.ms).length
  }

  /** Pool lights inside a cluster now (a clustered light is no longer one of the scene's lights). */
  get clustered(): number {
    return this.pool.filter(f => !this.scene.lights.includes(f.light)).length
  }

  /** A flash of `color` (0..1) at `at` for `ms`: the oldest light is reused when all are busy. */
  flash(at: V3, color: readonly [number, number, number], ms = 300): void {
    if (this.disposed || !this.enabled || !this.pool.length) return
    const t = this.now()
    const f = this.pool.reduce((a, b) => (b.start < a.start ? b : a))
    f.start = t
    f.ms = Math.max(50, ms)
    f.light.position.set(at[0], at[1], at[2])
    f.light.diffuse.set(color[0], color[1], color[2])
    f.light.intensity = PEAK
  }

  update(): void {
    if (this.disposed) return
    const t = this.now()
    for (const f of this.pool) {
      const k = (t - f.start) / (f.ms || 1)
      f.light.intensity = k >= 1 || k < 0 || !this.enabled ? 0 : PEAK * (1 - k) * (1 - k)
    }
    this.joinCluster(t)
  }

  /**
   * Puts the pool's scene lights into the registered cluster of this scene (rate-limited unless `now`; a no-op without
   * one). The meshes that lose a light are marked "lights disposed" (see the file comment).
   */
  joinCluster(t = this.now(), now = false): void {
    const c = cluster
    if (this.disposed || !c || (!now && t < this.nextJoin) || (c.host && c.host.scene !== this.scene)) return
    this.nextJoin = t + CLUSTER_RETRY_MS
    const lit = new Set<AbstractMesh>()
    try {
      for (const f of this.pool) {
        if (!this.scene.lights.includes(f.light)) continue
        const had = this.scene.meshes.filter(m => m.lightSources.includes(f.light))
        try {
          if (!c.addDynamicLight(f.light)) return // no cluster on this preset: the rest would not join either
        } catch (err) {
          console.warn('[fx] hit light did not join the cluster', err)
          return
        }
        for (const m of had) lit.add(m)
      }
    } finally {
      for (const m of lit) if (!m.isDisposed()) m._markSubMeshesAsLightDirty(true)
    }
  }

  dispose(): void {
    this.disposed = true
    pools.delete(this)
    this.scene.onNewLightAddedObservable.remove(this.onLight)
    for (const f of this.pool) {
      // A clustered light goes back to the scene first: disposing it inside its container would leave it drawn there.
      if (!this.scene.lights.includes(f.light)) {
        for (const l of this.scene.lights) {
          if (l instanceof ClusteredLightContainer && l.lights.includes(f.light)) l.removeLight(f.light)
        }
      }
      f.light.dispose()
    }
    this.pool.length = 0
  }
}

/**
 * Jangan as the game's WorldGround: the @sro/world-render World (terrain, objects, water, sky, fog, minimap tiles)
 * loaded into the world scene, with heights and picks from its navmeshes (docs/NAVIGATION.md). Asset root: the
 * slimmed /out-opt/ when served, else /out/ (docs/ASSETS.md).
 *
 * The export folder comes from the server (welcome.server.world, docs/FIELDS.md §6.1): 'jangan' (3 x 3, loaded whole)
 * or 'jangan-fields' (307 regions, streamed around the focus by world.stream; loadWorld stream: 'auto' decides from
 * the manifest). Terrain meshes come and go while streaming, so isGround checks the mesh tag, not a load-time set.
 */
import type { AbstractMesh, Ray, Scene } from '@babylonjs/core'
import {
  isTerrainMesh,
  loadWorld,
  resolveAssetBase,
  type GpuInfo,
  type RenderPath,
  type SkyStyle,
  type WeatherLevel,
  type World,
  type WorldIO,
  type WorldLoadProgress,
  type WorldQuality,
} from '@sro/world-render'
import { settings } from '../../settings.ts'
import type { GroundPick, WorldGround } from '../ground.ts'

export interface JanganGround extends WorldGround {
  readonly world: World
  /** Asset root the world was loaded from ('/out-opt/' or '/out/'). */
  readonly base: string
  /** The export folder ('jangan', 'jangan-fields'). */
  readonly folder: string
  /**
   * Re-centres a streamed world on (x, z) and resolves once the regions within READY_RADIUS_M are in (or after
   * READY_TIMEOUT_MS: the loading screen never hangs on a slow region). Immediate for a whole-world load.
   */
  ready(x: number, z: number): Promise<void>
}

/** Where the world export lives, in order of preference. */
export const ASSET_ROOTS = ['/out-opt/', '/out/'] as const

/** Streaming: the loading screen waits for the regions within this radius (m) of the player. */
export const READY_RADIUS_M = 200
export const READY_TIMEOUT_MS = 30_000

export interface JanganOptions {
  /** Export folder (default 'jangan'): app.session.server?.world. */
  world?: string
  /** Initial streaming focus, glTF metres (the character's saved position); default the export's spawn. */
  focus?: { x: number; z: number }
  quality?: WorldQuality
  /**
   * Wave 9 (GAME): the material path, sky style and weather level to load with (settings.ts effectiveGraphics; default
   * World's: Classic, classic sky, weather off) and the engine's GPU info. The time of day is left to the sky-clock
   * feature (the world loads at noon).
   */
  render?: RenderPath
  sky?: SkyStyle
  weatherLevel?: WeatherLevel
  gpu?: GpuInfo
  /**
   * Wave 12 (WAVE_PLAN8 D9): the trees to load with (`LoadWorldOptions.trees`; world/graphics.ts worldTreesOption:
   * 'retail' on the Classic path). Absent: World's default.
   */
  trees?: 'new' | 'retail'
  onProgress?: (p: WorldLoadProgress) => void
  /** Tests (headless): asset roots to probe and the file reader. */
  roots?: readonly string[]
  io?: WorldIO
  /** Tests (headless): no minimap canvas. */
  minimap?: boolean
}

export async function loadJangan(scene: Scene, opts: JanganOptions = {}): Promise<JanganGround> {
  const worldName = opts.world ?? 'jangan'
  const roots = opts.roots ?? ASSET_ROOTS
  const base = await resolveAssetBase(roots, worldName, opts.io)
  if (!base) throw new Error(`no world export at ${roots.map(r => `${r}world/${worldName}/`).join(' or ')}`)
  const focus = opts.focus && Number.isFinite(opts.focus.x) && Number.isFinite(opts.focus.z) ? { x: opts.focus.x, z: opts.focus.z } : undefined
  const world = await loadWorld(scene, {
    baseUrl: base,
    world: worldName,
    quality: opts.quality ?? urlQuality() ?? settings.get().graphics.preset,
    ...(opts.render ? { render: opts.render } : {}),
    ...(opts.sky ? { sky: opts.sky } : {}),
    ...(opts.weatherLevel ? { weatherLevel: opts.weatherLevel } : {}),
    ...(opts.gpu ? { gpu: opts.gpu } : {}),
    ...(opts.trees ? { trees: opts.trees } : {}),
    onProgress: opts.onProgress,
    stream: 'auto',
    focus,
    readyRadiusM: READY_RADIUS_M,
    ...(opts.io ? { io: opts.io } : {}),
    ...(opts.minimap !== undefined ? { minimap: opts.minimap } : {}),
  })
  for (const w of world.warnings) console.warn('[world]', w)
  console.info(`[world] ${worldName} from ${base}: ${world.objects.stats.models} models, ${world.assets.files} files, ` +
    `${(world.assets.bytes / 1048576).toFixed(1)} MB, nav ${world.navSource}` +
    (world.stream ? `, streaming ${world.stream.stats.ready}/${world.stream.stats.wanted} regions` : ''))
  return {
    world,
    base,
    folder: worldName,
    ready(x, z) {
      const stream = world.stream
      if (!stream || !Number.isFinite(x) || !Number.isFinite(z)) return Promise.resolve()
      world.setFocus(x, z)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>(resolve => {
        timer = setTimeout(() => {
          console.warn(`[world] regions around (${x.toFixed(0)}, ${z.toFixed(0)}) still loading after ${READY_TIMEOUT_MS / 1000} s; entering anyway`)
          resolve()
        }, READY_TIMEOUT_MS)
      })
      return Promise.race([stream.whenReady(x, z, Math.min(READY_RADIUS_M, stream.settings.loadRadiusM)), timeout]).finally(() => clearTimeout(timer))
    },
    heightAt(x, z, yHint) {
      // Outside the loaded regions (streaming) the server's y is the best height there is.
      return world.heightAt(x, z, yHint ?? Infinity) ?? (yHint !== undefined && Number.isFinite(yHint) ? yHint : 0)
    },
    // Live: streamed terrain meshes carry the tag (a set taken at load would miss every region loaded later).
    isGround: (m: AbstractMesh) => isTerrainMesh(m),
    pick(ray: Ray): GroundPick | null {
      const hit = world.pick(ray)
      return hit && { x: hit.x, y: hit.y, z: hit.z, walkable: hit.walkable }
    },
    // Called every frame: the streamer follows the player through world.update; warps and re-entry re-centre at once
    // through world.setFocus (world/features/map.ts, ready()).
    follow() {},
    dispose() {
      world.dispose()
    },
  }
}

/** ?quality=low|medium|high|ultra (object draw distance: 0.6x / native / 1.4x; low also hides animated objects). */
export function urlQuality(search: string | null = typeof location === 'undefined' ? null : location.search): WorldQuality | null {
  if (search === null) return null
  const q = new URLSearchParams(search).get('quality')
  return q === 'low' || q === 'medium' || q === 'high' || q === 'ultra' ? q : null
}

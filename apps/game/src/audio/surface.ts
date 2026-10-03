/**
 * Footstep surface under a point (docs/SOUND.md §5.8): the terrain tile's tile2d type from the loaded world-render
 * regions, or the index's object-floor surface when the entity stands above the terrain (plaza, bridges, floors).
 * Regions stream in and out (FIELDS §3), so every lookup goes through `regions.locate` again and no region object is
 * kept between calls (WAVE_PLAN decision 51); an unloaded region is Dirt.
 */
import { SOUND_SURFACES, type SoundSurface } from '@sro/shared'

/** Terrain grid: 97 x 97 vertices, 2 m apart, 20 file units per vertex (packages/convert/src/world/format.ts). */
const GRID = 97
const UNITS_PER_VERTEX = 20
/** Standing this far above the terrain means an object floor. */
export const OBJECT_FLOOR_ABOVE_M = 0.25

/** The slice of @sro/world-render's World the probe reads (structural, so tests can pass a synthetic world). */
export interface SurfaceWorld {
  readonly regions: {
    heightAt(x: number, z: number): number | null
    locate(x: number, z: number): { data: { terrain: { textures: ArrayLike<number> } }; lx: number; lz: number } | null
  }
  readonly manifest: { readonly tiles: readonly { id: number; typeName: string | null }[] }
  /** Wave 10 (World.waterLevelAt, WAVE_PLAN6 D22): the water surface over (x, z), null on dry ground. */
  waterLevelAt?(x: number, z: number): number | null
}

const BY_LOWER = new Map(SOUND_SURFACES.map(s => [s.toLowerCase(), s]))

/** tile2d type name (any case) -> SoundSurface; unknown -> null. */
export function surfaceOfType(typeName: string | null | undefined): SoundSurface | null {
  return typeName ? BY_LOWER.get(typeName.toLowerCase()) ?? null : null
}

export class SurfaceProbe {
  private tiles: Map<number, SoundSurface> | null = null
  private tilesOf: SurfaceWorld['manifest'] | null = null

  constructor(private readonly objectFloor: SoundSurface = 'Stone') {}

  /** Surface at glTF (x, y, z) in `world` (null world: the flat fallback ground, all Dirt). */
  surfaceAt(world: SurfaceWorld | null, x: number, y: number, z: number): SoundSurface {
    if (!world) return 'Dirt'
    try {
      const terrainY = world.regions.heightAt(x, z)
      if (terrainY === null) return 'Dirt'
      if (y - terrainY > OBJECT_FLOOR_ABOVE_M) return this.objectFloor
      const hit = world.regions.locate(x, z)
      if (!hit) return 'Dirt'
      const gx = Math.min(GRID - 1, Math.max(0, Math.round(hit.lx / UNITS_PER_VERTEX)))
      const gz = Math.min(GRID - 1, Math.max(0, Math.round(hit.lz / UNITS_PER_VERTEX)))
      const word = hit.data.terrain.textures[gz * GRID + gx]
      if (word === undefined) return 'Dirt'
      return this.tileSurfaces(world.manifest).get(word & 0x3ff) ?? 'Dirt'
    } catch {
      return 'Dirt'
    }
  }

  /** tile2d id -> surface, built once per manifest (the manifest's tile list is fixed for a world). */
  private tileSurfaces(manifest: SurfaceWorld['manifest']): Map<number, SoundSurface> {
    if (this.tiles && this.tilesOf === manifest) return this.tiles
    const map = new Map<number, SoundSurface>()
    for (const t of manifest.tiles ?? []) {
      const s = surfaceOfType(t.typeName)
      if (s) map.set(t.id, s)
    }
    this.tiles = map
    this.tilesOf = manifest
    return map
  }
}

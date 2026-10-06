/**
 * Siege of Jangan, layer 2: the walls on the minimap and the world map (docs/SIEGE.md §9.3). Pure: the shapes from the
 * segments' looks; the feature hands them to HudMinimap.addMarkerSource and worldmap.ts addWorldMapOverlay.
 *
 * - Intact stone is not drawn (the map's own art shows the wall).
 * - A standing third that is cracked: amber (deep cracks: orange). A downed third: red. Rubble thirds a darker red.
 * - Repair under way: a thin blue line along the segment's inner side.
 * - Breach zones (the unsafe ground behind a gap): red rings.
 */
import { breachZones, type WallSettings, type WallStage, type WallsExport } from '@sro/shared'
import type { WallLook } from './look.ts'

export interface WallMapShape {
  x: number
  z: number
  color: string
  /** A line to here. */
  to?: { x: number; z: number }
  /** Line width (CSS px) or the ring's radius (m). */
  width?: number
  radius?: number
}

export const WALL_MAP_COLORS = {
  crack1: '#e8b23a',
  crack2: '#f07a2a',
  down: '#ff3b30',
  rubble: '#b3161a',
  repair: '#5ec8ff',
  zone: '#ff4a3d',
} as const

/** Line widths: the minimap's and the world map's (CSS px). */
export const WALL_MAP_WIDTH = { line: 3, repair: 1.5 } as const

export function wallMapShapes(
  walls: Pick<WallsExport, 'segments' | 'sides'>,
  looks: ReadonlyMap<string, WallLook>,
  stages: ReadonlyMap<string, WallStage>,
  s: Pick<WallSettings, 'zoneM' | 'siegeZoneM'>,
): WallMapShape[] {
  const out: WallMapShape[] = []
  const sides = new Map(walls.sides.map((x) => [x.side, x]))
  for (const seg of walls.segments) {
    const look = looks.get(seg.id)
    const side = sides.get(seg.side)
    if (!look || !side) continue
    const rubble = stages.get(seg.id) === 'rubble'
    const xz = (along: number, across: number) => (side.axis === 'x' ? { x: along, z: across } : { x: across, z: along })
    seg.thirds.forEach((t, k) => {
      const color = look.down[k] ? (rubble ? WALL_MAP_COLORS.rubble : WALL_MAP_COLORS.down) : look.crack[k] === 2 ? WALL_MAP_COLORS.crack2 : look.crack[k] === 1 ? WALL_MAP_COLORS.crack1 : null
      if (!color) return
      const a = xz(t.from, side.line), b = xz(t.to, side.line)
      out.push({ ...a, to: b, color, width: WALL_MAP_WIDTH.line })
    })
    if (look.hammer || look.scaffold.some(Boolean)) {
      const inside = side.line + (side.inner - side.line) * 0.8
      out.push({ ...xz(seg.from, inside), to: xz(seg.to, inside), color: WALL_MAP_COLORS.repair, width: WALL_MAP_WIDTH.repair })
    }
  }
  for (const z of breachZones(stages, walls, s, false)) out.push({ x: z.x, z: z.z, radius: z.r, color: WALL_MAP_COLORS.zone })
  return out
}

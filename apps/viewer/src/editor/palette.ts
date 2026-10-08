/**
 * The paint palette (docs/WORLD_EDITOR.md §4.3, D20; WAVE_PLAN8 D19): `content/world-edits/<world>/palette.json`, one
 * row per terrain tile of the export (65 in jangan-fields), grouped by surface as the user named them (grass, sand,
 * dirt, rock, road...). The swatch is the remastered 512 albedo where texpipe made one (`work/out/pbr/index.json`
 * `tile2d:<stem>`), else the retail tile image. A tile the palette does not list falls back to its `typeName` and
 * grass weight.
 */
import type { TileTexture } from '../../../../packages/convert/src/world/manifest.ts'

export const PALETTE_FORMAT = 'sro-world-edits-palette'

export const SURFACES = ['grass', 'longgrass', 'dirt', 'sand', 'rock', 'road', 'mud', 'other'] as const
export type Surface = (typeof SURFACES)[number]

export interface PaletteRow {
  tile: number
  /** The tile's file stem (c_grass_fld_03). */
  name: string
  surface: Surface
  note?: string
}

export interface PaletteFile {
  format: typeof PALETTE_FORMAT
  version: number
  world: string
  surfaces: Array<{ id: Surface; label: string }>
  tiles: PaletteRow[]
}

export interface PaletteEntry extends PaletteRow {
  label: string
  /** The plain name the panel, the status line and the Changes list use: "Dirt 3" (its surface and number). */
  title: string
  /** Swatch image URL (relative to the asset base), the remastered albedo when there is one. */
  swatch: string
  remastered: boolean
}

/** Checks palette.json against the export's tiles (when given): every row one known tile, once, on a known surface. */
export function validatePalette(json: unknown, tiles?: readonly Pick<TileTexture, 'id' | 'source'>[]): string[] {
  const problems: string[] = []
  const o = json as Partial<PaletteFile> | null
  if (!o || typeof o !== 'object') return ['palette: expected an object']
  if (o.format !== PALETTE_FORMAT) problems.push(`palette.format: expected '${PALETTE_FORMAT}'`)
  if (o.version !== 1) problems.push('palette.version: expected 1')
  if (!Array.isArray(o.surfaces)) problems.push('palette.surfaces: expected a list')
  else for (const s of o.surfaces) if (!SURFACES.includes(s?.id as Surface) || typeof s.label !== 'string') problems.push(`palette.surfaces: bad row ${JSON.stringify(s)}`)
  if (!Array.isArray(o.tiles)) return [...problems, 'palette.tiles: expected a list']
  const byId = tiles ? new Map(tiles.map(t => [t.id, t])) : null
  const seen = new Set<number>()
  o.tiles.forEach((r, i) => {
    const path = `palette.tiles[${i}]`
    if (!Number.isInteger(r?.tile) || r.tile < 0 || r.tile > 0x3ff) return problems.push(`${path}.tile: expected a tile2d id 0..1023`)
    if (seen.has(r.tile)) problems.push(`${path}.tile: tile ${r.tile} listed twice`)
    seen.add(r.tile)
    if (!SURFACES.includes(r.surface)) problems.push(`${path}.surface: '${r.surface}' is not one of ${SURFACES.join(', ')}`)
    if (typeof r.name !== 'string' || !r.name) problems.push(`${path}.name: expected the tile's name`)
    if (byId) {
      const t = byId.get(r.tile)
      if (!t) problems.push(`${path}.tile: tile ${r.tile} is not in the export`)
      else if (stem(t.source) !== r.name) problems.push(`${path}.name: tile ${r.tile} is ${stem(t.source)}, not ${r.name}`)
    }
  })
  if (byId) for (const t of byId.values()) if (!seen.has(t.id)) problems.push(`palette: tile ${t.id} (${stem(t.source)}) has no row`)
  return problems
}

export const stem = (source: string) => source.replace(/\.(ddj|dds|png)$/i, '').split(/[\\/]/).pop()!

/** A tile without a palette row: its typeName and grass weight decide (§4.3's fallback). */
export function fallbackSurface(t: Pick<TileTexture, 'typeName'> & { grass?: { weight: number } }): Surface {
  const w = t.grass?.weight ?? 0
  switch ((t.typeName ?? '').toLowerCase()) {
    case 'grass':
      return w >= 0.9 ? 'grass' : 'longgrass'
    case 'sand':
      return 'sand'
    case 'stone':
      return 'rock'
    case 'mud':
      return 'mud'
    case 'water':
      return 'other'
    case 'dirt':
      return w > 0.3 ? 'longgrass' : 'dirt'
    default:
      return 'other'
  }
}

/** The pbr index's terrain sets (`tile2d:<stem>` → the 512 albedo path under pbr/). */
export interface PbrIndexLike {
  sets?: Record<string, { tiers?: Record<string, { albedo?: string }> }>
}

/**
 * The palette as the Paint panel shows it: every tile of the export, its surface (palette.json, else the fallback),
 * its swatch. `tileBase`: the URL of the world folder (for the retail tile images), `pbrBase`: of `pbr/`.
 */
export function paletteEntries(
  tiles: readonly (TileTexture & { grass?: { weight: number } })[], file: PaletteFile | null, pbr: PbrIndexLike | null,
  urls: { tileBase: string; pbrBase: string },
): PaletteEntry[] {
  const rows = new Map((file?.tiles ?? []).map(r => [r.tile, r]))
  const labels = new Map((file?.surfaces ?? []).map(s => [s.id, s.label]))
  const order = new Map(SURFACES.map((s, i) => [s, i]))
  const out = tiles.map(t => {
    const name = stem(t.source)
    const row = rows.get(t.id)
    const surface = row?.surface ?? fallbackSurface(t)
    const albedo = pbr?.sets?.[`tile2d:${name}`]?.tiers?.['512']?.albedo
    return {
      tile: t.id, name, surface, ...(row?.note ? { note: row.note } : {}),
      label: labels.get(surface) ?? surface,
      title: '',
      swatch: albedo ? `${urls.pbrBase}${albedo}` : `${urls.tileBase}${t.file}`,
      remastered: !!albedo,
    }
  })
  out.sort((a, b) => order.get(a.surface)! - order.get(b.surface)! || a.name.localeCompare(b.name))
  const count = new Map<string, number>()
  for (const e of out) {
    const k = (count.get(e.surface) ?? 0) + 1
    count.set(e.surface, k)
    e.title = `${e.label[0]!.toUpperCase()}${e.label.slice(1)} ${k}`
  }
  return out
}

/**
 * The paving tiles (F-12, TEL-3): one list for the texpipe's three paving rules (pbr/params.ts profileOf, the DT-2
 * prompts in detail/profiles.ts, b3-terrain.test.ts's row check). Paving keeps B1's soft maps (TERRAIN_TEX §3.2 / D3:
 * normal x0.35, AO x0.4, no aiMix, no de-light); the painterly ground rule is for soil and rock.
 *
 * By name: the Jangan marble and anything named paving or plaza. By tile: the palette's other "Road and paving" slabs
 * (content/world-edits/jangan-fields/palette.json surface 'road'), whose names read as stone or dust: alex_stone02's
 * flagstones, ruin_takl_dest_05's crazy paving, wc_dust_don_14 / _15's slabs.
 */

/** Paving by file name. */
export const PAVING_NAME = /marble|pave|plaza/

/** Terrain tiles (tile2d file stems) that are paving whatever their name says. */
export const PAVING_TILES: readonly string[] = ['alex_stone02', 'ruin_takl_dest_05', 'wc_dust_don_14', 'wc_dust_don_15']

/** Whether a texture file stem (no folder, no `tile2d:`, no `.ddj`) is paving. */
export function isPavingFile(file: string): boolean {
  const f = file.toLowerCase().replace(/^tile2d:/, '').replace(/\.ddj$/, '')
  return PAVING_NAME.test(f) || PAVING_TILES.includes(f)
}

/** Whether a texpipe key (`tile2d:<stem>` or a texture path) is a paving tile or texture. */
export function isPavingKey(key: string): boolean {
  const k = key.toLowerCase()
  return isPavingFile(k.slice(Math.max(k.lastIndexOf('/'), k.lastIndexOf(':')) + 1))
}

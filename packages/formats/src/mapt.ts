/**
 * Region lightmap Map/<z>/<x>.t (JMXVMAPT1001).
 *
 * Specs: SilkroadDoc wiki JMXVMAPT, openroad docs/formats/mapt-jmxvmapt.md (read as documentation), the
 * Lafa2K terrain importer (MIT, map_t_to_dds), checked against the vSRO 1.188 bytes
 * (packages/convert/test/terrain.corpus.test.ts):
 *
 *   0     char[12]    "JMXVMAPT1001"
 *   12    u8[96 * 96] lightGrid: per-tile light level, tz outer, tx inner (255 lit; 0, 153, 178, 204, 205, 229 occur)
 *   9228  u32         declaredSize = dds.byteLength + 8 (it counts itself and textureType, exactly like the
 *                     DDJ header; the wiki leaves the +8 unstated). 131,208 in every 1.188 file.
 *   9232  u32         textureType: D3DRESOURCETYPE, 3 (texture) everywhere
 *   9236  ...         a complete DDS file up to EOF: DXT1 512 x 512, one mip, in every 1.188 file
 *
 * So the tail is a JMXVDDJ body without its signature, and decodes with decodeDds().
 *
 * Orientation (measured): lightGrid row tz and lightmap image row y both grow with region +Z, columns with +X.
 * Image row 0 is the region's south edge (gz = 0), so the lightmap is the minimap (north up) flipped
 * vertically. Evidence: border continuity with the neighbouring regions, and both the image and the grid are
 * dark under the .o2 object placements only in this orientation (terrain.corpus.test.ts).
 * The border texels are shared with the neighbour (A's last column matches B's first more closely than A's
 * last two columns match each other), so texel centres, not texel edges, lie on the region border: texel k is
 * at k * 1920 / 511 units, i.e. u = (0.5 + 511 * gx / 96) / 512, and likewise v with gz. Plain u = gx / 96 is
 * off by up to half a texel (1.9 units) and leaves a visible seam between regions.
 */
import { BinaryReader, latin1 } from './binary.ts'
import { decodeDds, type DecodedDds, type DdsDecodeOptions } from './ddj.ts'

export const MAPT_SIGNATURE = 'JMXVMAPT1001'
export const MAPT_LIGHT_GRID_SIZE = 96
export const MAPT_DDS_OFFSET = 12 + MAPT_LIGHT_GRID_SIZE * MAPT_LIGHT_GRID_SIZE + 8

export interface MapTFile {
  signature: string
  /** 96 x 96 bytes (view), index tz * 96 + tx (tile (tx, tz) spans region-local x 20 tx.., z 20 tz..). */
  lightGrid: Uint8Array
  /** Raw u32 at 9228; dds.byteLength + 8 when consistent. Not used to slice the payload. */
  declaredSize: number
  /** Raw D3DRESOURCETYPE (3 = texture). */
  textureType: number
  /** View of the DDS file (bytes 9236..EOF). */
  dds: Uint8Array
}

export function parseMapT(bytes: Uint8Array): MapTFile {
  if (bytes.byteLength < MAPT_DDS_OFFSET) {
    throw new Error(`MAPT: file is ${bytes.byteLength} bytes, shorter than the ${MAPT_DDS_OFFSET}-byte header`)
  }
  const r = new BinaryReader(bytes)
  const signature = r.fixedString(12, latin1)
  if (signature !== MAPT_SIGNATURE) {
    throw new Error(`MAPT: bad signature ${JSON.stringify(signature)} at offset 0 (expected "${MAPT_SIGNATURE}")`)
  }
  const lightGrid = r.bytesView(MAPT_LIGHT_GRID_SIZE * MAPT_LIGHT_GRID_SIZE)
  const declaredSize = r.u32()
  const textureType = r.u32()
  const dds = bytes.subarray(r.offset)
  if (dds.byteLength < 4 || dds[0] !== 0x44 || dds[1] !== 0x44 || dds[2] !== 0x53 || dds[3] !== 0x20) {
    throw new Error(`MAPT: no "DDS " magic at offset ${MAPT_DDS_OFFSET}`)
  }
  return { signature, lightGrid, declaredSize, textureType, dds }
}

/**
 * Decodes the embedded lightmap (RGBA8, rows top-down = region south to north; see the header comment for the
 * texel-centre mapping).
 */
export function decodeMapTLightmap(mapt: MapTFile, options?: DdsDecodeOptions): DecodedDds {
  return decodeDds(mapt.dds, options)
}

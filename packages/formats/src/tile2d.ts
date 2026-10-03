/**
 * Terrain texture catalogue Map/tile2d.ifo (JMXV2DTI1001, text).
 *
 * Specs: SilkroadDoc wiki JMXV2DTI, openroad docs/formats/2dti-jmxv2dti.md (read as documentation), the
 * Lafa2K terrain importer (MIT, _tile2d_entries), checked against the vSRO 1.188 file:
 *
 *   JMXV2DTI1001
 *   603                                     declared record count
 *   00007 0x0000000a "HMfild" "c_grass_hmfld_01.ddj" {757,64}
 *   id    type       category  file                   optional grass: {object.ifo id,density} ...
 *
 * - id: zero-padded decimal. In 1.188 the ids are exactly 0..602 in line order, so "id" and "row" agree.
 * - type: hex surface material, see TILE2D_TYPES (only 0, 1, 3, 6, 7, 9, 10, 11, 12 occur).
 * - category: a region tag; may contain spaces ("Rock Mt").
 * - file: DDJ name inside Map.pk2 folder tile2d/ (all 603 exist).
 * - grass: 3D grass as {model, density} pairs (the model indexes Map/object.ifo).
 *
 * .m vertices store a u16 whose low 10 bits are the id (MAPM_TEXTURE_ID_MASK); the id is the first column
 * (not merely the line position, although the two coincide here). The upper bits are a separate field: bits
 * 10..12 are always 0 in 1.188 and bits 13..15 hold 0..4. With the 10-bit mask every vertex of every 1.188
 * region resolves (512 distinct ids, max 545 of 0..602).
 */
import { eucKr } from './binary.ts'

export const TILE2D_SIGNATURE = 'JMXV2DTI1001'

/** Tile material names by type value (openroad / SilkroadDoc). */
export const TILE2D_TYPES = [
  'Dirt',
  'Sand',
  'Ashfield',
  'Stone',
  'Metal',
  'Wood',
  'Mud',
  'Water',
  'DeepWater',
  'Snow',
  'Grass',
  'LongGrass',
  'Forest',
  'Cloud',
] as const

export interface Tile2dGrass {
  /** object.ifo id of the grass model. */
  objectId: number
  /** Instances per tile. */
  density: number
}

export interface Tile2dEntry {
  id: number
  /** Raw type value (hex column). */
  type: number
  /** TILE2D_TYPES[type], or undefined for values outside the known table. */
  typeName: string | undefined
  category: string
  /** DDJ file name as stored. */
  file: string
  /** Map.pk2 path of the texture: 'tile2d/' + file. */
  path: string
  grass: Tile2dGrass[]
  /** 0-based position among the records (equals id in 1.188). */
  row: number
}

export interface Tile2dFile {
  signature: string
  declaredCount: number
  entries: Tile2dEntry[]
  byId: Map<number, Tile2dEntry>
}

const LINE = /^(\d+)\s+(0x[0-9a-fA-F]+|\d+)\s+"([^"]*)"\s+"([^"]*)"\s*(.*)$/
const GRASS = /^\{\s*(\d+)\s*,\s*(\d+)\s*\}$/

export function parseTile2d(input: Uint8Array | string): Tile2dFile {
  const text = typeof input === 'string' ? input : eucKr.decode(input)
  const lines = text.split(/\r?\n/)
  const signature = (lines[0] ?? '').trim()
  if (signature !== TILE2D_SIGNATURE) {
    throw new Error(`TILE2D: bad signature ${JSON.stringify(signature)} on line 1 (expected "${TILE2D_SIGNATURE}")`)
  }
  const countText = (lines[1] ?? '').trim()
  if (!/^\d+$/.test(countText)) throw new Error(`TILE2D: bad record count ${JSON.stringify(countText)} on line 2`)
  const declaredCount = Number(countText)
  const entries: Tile2dEntry[] = []
  const byId = new Map<number, Tile2dEntry>()
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === '') continue
    const m = LINE.exec(line)
    if (!m) throw new Error(`TILE2D: malformed record on line ${i + 1}: ${JSON.stringify(line)}`)
    const id = Number.parseInt(m[1]!, 10)
    const type = m[2]!.startsWith('0x') ? Number.parseInt(m[2]!.slice(2), 16) : Number.parseInt(m[2]!, 10)
    const grass: Tile2dGrass[] = []
    const rest = m[5]!.trim()
    if (rest !== '') {
      for (const token of rest.split(/\s+/)) {
        const g = GRASS.exec(token)
        if (!g) throw new Error(`TILE2D: malformed grass ${JSON.stringify(token)} on line ${i + 1}`)
        grass.push({ objectId: Number(g[1]), density: Number(g[2]) })
      }
    }
    if (byId.has(id)) throw new Error(`TILE2D: duplicate id ${id} on line ${i + 1}`)
    const file = m[4]!
    const entry: Tile2dEntry = {
      id,
      type,
      typeName: TILE2D_TYPES[type],
      category: m[3]!,
      file,
      path: `tile2d/${file}`,
      grass,
      row: entries.length,
    }
    entries.push(entry)
    byId.set(id, entry)
  }
  if (entries.length !== declaredCount) {
    throw new Error(`TILE2D: line 2 declares ${declaredCount} records, found ${entries.length}`)
  }
  return { signature, declaredCount, entries, byId }
}

/** Looks up the entry for a raw .m texture word (only the low 10 bits are the id). */
export function resolveTile2d(tile2d: Tile2dFile, rawTexture: number): Tile2dEntry | undefined {
  return tile2d.byId.get(rawTexture & 0x3ff)
}

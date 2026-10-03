/**
 * regioninfo.txt (Data.pk2 root, CP949; docs/SOUND.md §2.5): named town/field areas as lists of regions.
 *
 *   #TOWN\t<name>[\t<tag>]      or #FIELD
 *   <x>\t<z>\tALL
 *   <x>\t<z>\tRECT\t<a>\t<b>\t<c>\t<d>     RECT semantics unknown; the arguments are kept raw
 *
 * Node-free; takes decoded text.
 */

export interface RegionRow {
  x: number
  z: number
  mode: 'ALL' | 'RECT'
  args: string[]
  /** Region id, z << 8 | x. */
  id: number
}

export interface RegionArea {
  kind: 'town' | 'field'
  name: string
  /** Third cell of the header ('donwhang'), '' when absent. */
  tag: string
  regions: RegionRow[]
  line: number
}

export function parseRegionInfo(text: string): RegionArea[] {
  const out: RegionArea[] = []
  let area: RegionArea | null = null
  const lines = text.split(/\r\n|\n|\r/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trimStart().startsWith('//') || line.trim() === '') continue
    const cells = line.split('\t').map(c => c.trim())
    const head = /^#(TOWN|FIELD)$/i.exec(cells[0] ?? '')
    if (head) {
      area = { kind: head[1]!.toUpperCase() === 'TOWN' ? 'town' : 'field', name: cells[1] ?? '', tag: cells[2] ?? '', regions: [], line: i + 1 }
      out.push(area)
      continue
    }
    if (!area) continue
    const x = Number(cells[0])
    const z = Number(cells[1])
    const mode = (cells[2] ?? '').toUpperCase()
    if (!Number.isInteger(x) || !Number.isInteger(z) || (mode !== 'ALL' && mode !== 'RECT')) continue
    const args = mode === 'RECT' ? cells.slice(3).filter(c => c !== '') : []
    area.regions.push({ x, z, mode, args, id: (z << 8) | x })
  }
  return out
}

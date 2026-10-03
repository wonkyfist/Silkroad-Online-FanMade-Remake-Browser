/**
 * effectenvsnd.txt (Media.pk2 server_dep/silkroad/textdata, CP949; docs/SOUND.md §2.5): per area, a music file and
 * day/night ambience layers.
 *
 *   <1>\t<area name>
 *   \t"<music>.ogg"
 *   \t<2>\t낮            (day; 밤 = night)
 *   \t\t\t<3>\t"<file>.wav"\t<min>~<max>     0~0 = continuous loop, else a one-shot every min..max seconds
 *
 * Node-free; takes decoded text.
 */

export interface EnvLayer {
  /** File name as stored ('day_wind.wav'); no folder (the files live in prim/snd/env). */
  file: string
  min: number
  max: number
}

export interface EnvArea {
  /** Area name, the join key with regioninfo.txt ('장안'). */
  name: string
  /** Music file as stored ('Jangan_Town.ogg'), or null. */
  music: string | null
  day: EnvLayer[]
  night: EnvLayer[]
  line: number
}

const QUOTED = /"([^"]+)"/

export function parseEffectEnvSnd(text: string): EnvArea[] {
  const out: EnvArea[] = []
  let area: EnvArea | null = null
  let part: 'day' | 'night' | null = null
  const lines = text.split(/\r\n|\n|\r/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trimStart().startsWith('//') || line.trim() === '') continue
    const cells = line.split('\t').map(c => c.trim())
    const tag = cells.find(c => /^<\d>$/.test(c))
    if (tag === '<1>') {
      const name = cells[cells.indexOf('<1>') + 1] ?? ''
      area = { name, music: null, day: [], night: [], line: i + 1 }
      part = null
      out.push(area)
      continue
    }
    if (!area) continue
    if (tag === '<2>') {
      const label = cells[cells.indexOf('<2>') + 1] ?? ''
      part = label.includes('밤') ? 'night' : label.includes('낮') ? 'day' : null
      continue
    }
    const q = QUOTED.exec(line)
    if (tag === '<3>') {
      if (!q || !part) continue
      const range = /(\d+)\s*~\s*(\d+)/.exec(line.slice(q.index + q[0].length))
      const min = range ? Number(range[1]) : 0
      const max = range ? Number(range[2]) : 0
      area[part].push({ file: q[1]!.trim(), min: Math.min(min, max), max: Math.max(min, max) })
      continue
    }
    if (q && !tag && area.music === null) area.music = q[1]!.trim()
  }
  return out
}

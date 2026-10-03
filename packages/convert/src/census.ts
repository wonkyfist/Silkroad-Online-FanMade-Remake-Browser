import type { Pk2Archive } from '@sro/formats'

/**
 * Format census: for every extension, count the leading signature (e.g. "JMXVBMS 0110").
 * First step for any client — tells us which format versions our parsers must handle.
 */
export interface CensusRow {
  extension: string
  archive: string
  files: number
  bytes: number
  signatures: Record<string, number>
  examples: Record<string, string>
}

const PRINTABLE = /^[\x20-\x7e]+$/

function signatureOf(head: Uint8Array): string {
  const ascii = new TextDecoder('latin1').decode(head)
  if (ascii.startsWith('JMXV')) {
    // "JMXVBMS 0110", "JMXVMAPM1000", "JMXVEFF 0013" ... = 12 chars
    const sig = ascii.slice(0, 12)
    return PRINTABLE.test(sig) ? sig : sig.slice(0, 8) + '?'
  }
  if (ascii.startsWith('JoyMax File Manager')) return 'JoyMax PK2'
  if (head[0] === 0xff && head[1] === 0xfe) return 'text UTF-16LE'
  if (ascii.startsWith('DDS ')) return 'DDS'
  if (ascii.startsWith('OggS')) return 'Ogg'
  if (ascii.startsWith('RIFF')) return `RIFF ${ascii.slice(8, 12)}`
  if (ascii.startsWith('ID3') || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0)) return 'MP3'
  if (ascii.startsWith('\x89PNG')) return 'PNG'
  if (head[0] === 0xff && head[1] === 0xd8) return 'JPEG'
  if (ascii.startsWith('BM')) return 'BMP'
  const firstLine = ascii.split(/[\r\n]/)[0] ?? ''
  if (firstLine.length >= 4 && PRINTABLE.test(firstLine.slice(0, 16))) return `text: ${firstLine.slice(0, 16)}`
  return 'binary'
}

export function census(archives: ReadonlyArray<readonly [string, Pk2Archive]>): CensusRow[] {
  const rows = new Map<string, CensusRow>()
  for (const [name, archive] of archives) {
    for (const file of archive.files.values()) {
      const dot = file.path.lastIndexOf('.')
      const slash = file.path.lastIndexOf('/')
      const ext = dot > slash ? file.path.slice(dot).toLowerCase() : '(none)'
      const key = `${name}:${ext}`
      let row = rows.get(key)
      if (!row) {
        row = { extension: ext, archive: name, files: 0, bytes: 0, signatures: {}, examples: {} }
        rows.set(key, row)
      }
      row.files++
      row.bytes += file.size
      const sig = file.size === 0 ? '(empty)' : signatureOf(archive.source.read(file.offset, Math.min(32, file.size)))
      row.signatures[sig] = (row.signatures[sig] ?? 0) + 1
      row.examples[sig] ??= file.path
    }
  }
  return [...rows.values()].sort((a, b) => a.archive.localeCompare(b.archive) || b.files - a.files)
}

export function formatCensus(rows: CensusRow[]): string {
  const lines: string[] = []
  let archive = ''
  for (const row of rows) {
    if (row.archive !== archive) {
      archive = row.archive
      lines.push(`\n== ${archive}.pk2 ==`)
    }
    const sigs = Object.entries(row.signatures)
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s} x${n}`)
      .join(', ')
    lines.push(`${row.extension.padEnd(10)} ${String(row.files).padStart(6)} files ${(row.bytes / 2 ** 20).toFixed(1).padStart(8)} MiB  ${sigs}`)
  }
  return lines.join('\n')
}

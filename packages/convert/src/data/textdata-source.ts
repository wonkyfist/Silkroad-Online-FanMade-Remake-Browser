/** Node access to the textdata tables inside Media.pk2. */
import { loadTextdataTable, normalizePk2Path, type Pk2Archive, type Pk2File, type TextdataReader, type TextdataTable } from '@sro/formats'

export const TEXTDATA_DIR = 'server_dep/silkroad/textdata'

/** Reads `<name>` from the textdata folder of Media.pk2 (case-insensitive); undefined when missing. */
export function textdataReader(media: Pk2Archive): TextdataReader {
  return name => {
    const file = media.get(`${TEXTDATA_DIR}/${name}`)
    return file ? media.read(file) : undefined
  }
}

/** Every file directly in the textdata folder. */
export function listTextdataFiles(media: Pk2Archive): Pk2File[] {
  return media.list(TEXTDATA_DIR).sort((a, b) => normalizePk2Path(a.path).localeCompare(normalizePk2Path(b.path)))
}

export function loadTable(media: Pk2Archive, name: string): TextdataTable {
  return loadTextdataTable(name, textdataReader(media))
}

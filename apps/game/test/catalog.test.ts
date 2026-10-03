import { describe, expect, it } from 'vitest'
import { Catalog, charactersFromIndex, codeFromFileName, labelOf, parseCharactersJson, parseWeaponsJson, weaponsFromIndex } from '../src/content/catalog.ts'

describe('catalog', () => {
  it('derives CodeName128 from converter file names', () => {
    expect(codeFromFileName('chinaman_adventurer')).toBe('CHAR_CH_MAN_ADVENTURER')
    expect(codeFromFileName('chinawoman_necromencerb')).toBe('CHAR_CH_WOMAN_NECROMENCERB')
    expect(codeFromFileName('europeman_adventurer')).toBe('CHAR_EU_MAN_ADVENTURER')
    expect(codeFromFileName('tiger')).toBeUndefined()
    expect(labelOf('CHAR_CH_WOMAN_NOBLEGIRL')).toBe('Noblegirl')
  })

  it('reads /out/index.json rows', () => {
    const index = [
      { id: 'char/china/chinaman_adventurer', category: 'char/china', glb: 'char/china/chinaman_adventurer.glb', sidecar: 'char/china/chinaman_adventurer.json' },
      { id: 'char/europe/europeman_adventurer', category: 'char/europe', glb: 'char/europe/europeman_adventurer.glb' },
      { id: 'item/china/weapon/bow_01', category: 'item/china/weapon', glb: 'item/china/weapon/bow_01.glb' },
      { id: 'mob/china/tiger', category: 'mob/china', glb: 'mob/china/tiger.glb' },
    ]
    const chars = charactersFromIndex(index)
    expect(chars.map(c => c.code)).toEqual(['CHAR_CH_MAN_ADVENTURER', 'CHAR_EU_MAN_ADVENTURER'])
    expect(chars[0]).toMatchObject({ glb: '/out/char/china/chinaman_adventurer.glb', selectable: true, gender: 'male', race: 'china' })
    expect(chars[1]!.selectable).toBe(false)
    expect(weaponsFromIndex(index).bow?.glb).toBe('/out/item/china/weapon/bow_01.glb')
    const cat = new Catalog(chars, weaponsFromIndex(index), 'test')
    expect(cat.selectable('male').map(c => c.code)).toEqual(['CHAR_CH_MAN_ADVENTURER'])
    expect(cat.characterOrFallback('CHAR_CH_MAN_UNKNOWN')?.code).toBe('CHAR_CH_MAN_ADVENTURER')
  })

  it('reads characters.json in several shapes', () => {
    const a = parseCharactersJson([{ codeName128: 'CHAR_CH_WOMAN_FOX', glb: 'char/china/chinawoman_fox.glb', gender: 'F' }])
    expect(a[0]).toMatchObject({ code: 'CHAR_CH_WOMAN_FOX', gender: 'female', glb: '/out/char/china/chinawoman_fox.glb', selectable: true })
    const b = parseCharactersJson({ characters: { CHAR_CH_MAN_MONK: { model: { glb: '/out/x/monk.glb' }, playable: false } } })
    expect(b[0]).toMatchObject({ code: 'CHAR_CH_MAN_MONK', glb: '/out/x/monk.glb', selectable: false })
    const c = parseCharactersJson({ CHAR_CH_MAN_BOGY: { file: 'char/china/chinaman_bogy' } })
    expect(c[0]!.glb).toBe('/out/char/china/chinaman_bogy.glb')
    expect(parseCharactersJson({ nothing: true })).toEqual([])
  })

  it('reads the data export (export-data.ts) characters.json and weapons.json', () => {
    const chars = parseCharactersJson([
      { code: 'CHAR_CH_MAN_ADVENTURER', race: 'china', gender: 'male', name: 'Ryujoyeong', description: 'The son of...', bsr: 'res/char/china/chinaman_adventurer.bsr', glb: '/out/char/china/chinaman_adventurer.glb', sidecar: '/out/char/china/chinaman_adventurer.json' },
    ])
    expect(chars[0]).toMatchObject({ code: 'CHAR_CH_MAN_ADVENTURER', label: 'Adventurer', persona: 'Ryujoyeong', glb: '/out/char/china/chinaman_adventurer.glb', selectable: true })
    const weapons = parseWeaponsJson([{ family: 'glaive', code: 'ITEM_CH_TBLADE_01_A_DEF', name: 'Iron Glaive', familyName: 'Glaive', glb: '/out/item/china/weapon/tblade_01.glb', sidecar: '/out/item/china/weapon/tblade_01.json' }])
    expect(weapons.glaive).toMatchObject({ name: 'Iron Glaive', code: 'ITEM_CH_TBLADE_01_A_DEF', glb: '/out/item/china/weapon/tblade_01.glb' })
  })
})

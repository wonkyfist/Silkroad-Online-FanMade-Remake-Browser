/**
 * Lane UI-W (docs/WAVE_PLAN2.md §5.5): the retail item tooltip model (M11) and the windows' wave-8 mount points that
 * have DOM-free parts: the shop footer (M6), NPC services (M7), bag lock marks (M8), slot decorators (M9) and option
 * rows (M10); plus the pure layout helpers of the Main window pages, shop, storage, quest list and System window.
 */
import type { ItemDef } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { expPercentText, EQUIP_LAYOUT } from '../src/hud/character.ts'
import { BAG_PAGE, bagPages, BagMarks, pageOfSlot } from '../src/hud/inventory.ts'
import { isRareCode, ItemCatalog, tooltipSections, type TooltipLine } from '../src/hud/items.ts'
import { OPTIONS_TABS, pageRows, registerOptionRow, registeredOptionRows, type OptionRow, type OptionsHost } from '../src/hud/options.ts'
import { nextPartyMode } from '../src/hud/party.ts'
import { footerButtonShown, shopPages } from '../src/hud/shop.ts'
import { dialogOptions, HIDDEN_SERVICES, npcServiceHandler, OPTION_KEY, registerNpcServiceHandler } from '../src/hud/shop-logic.ts'
import { MASTERY_TAB_ART, masteryTotal } from '../src/hud/skills.ts'
import { registerSlotDecorator, slotSigns } from '../src/hud/slots.ts'
import { storagePages } from '../src/hud/storage.ts'
import { systemRows, systemRowTop } from '../src/hud/ux-shell.ts'
import type { MenuItem } from '../src/hud/menu-items.ts'
import { questBar } from '../src/quests/log.ts'
import { t } from '../src/i18n/index.ts'
import { en } from '../src/i18n/en.ts'

const SWORD: ItemDef = {
  code: 'ITEM_CH_SWORD_01_A',
  id: 1,
  name: 'Iron Sword',
  typeId: [3, 1, 6, 2],
  category: 'weapon',
  slot: 'weapon',
  weaponType: 'sword',
  degree: 1,
  reqLevel: 5,
  reqGender: 'any',
  race: 'china',
  twoHanded: false,
  range: 0.6,
  stats: { physAttack: [12, 16], durability: [20, 30], hitRate: [10, 14] },
  maxStack: 1,
  price: 100,
  sellPrice: 20,
  model: null,
  icon: null,
}
const POTION: ItemDef = { ...SWORD, code: 'ITEM_ETC_HP_POTION_01', name: 'HP Potion', category: 'potion' as ItemDef['category'], slot: undefined, weaponType: undefined, degree: 0, reqLevel: 0, twoHanded: undefined, range: undefined, stats: undefined, use: { hp: 70, cooldownMs: 1000 }, maxStack: 50, price: 10, sellPrice: 2 }
const QUEST_ITEM: ItemDef = { ...POTION, code: 'ITEM_QUEST_LETTER', name: 'Letter', maxStack: 1, use: undefined, canSell: false, canDrop: false, sellPrice: 0 }
const catalog = new ItemCatalog([SWORD, POTION, QUEST_ITEM])

/** The section classes of a tooltip, with the stat lines folded ("stat*"). */
const shape = (lines: readonly TooltipLine[]) => lines.map(l => l.cls).join(' ').replace(/(stat|desc)( (stat|desc))+/g, 'body')

describe('M11: the item tooltip in the retail layout (docs/UI.md §4.8)', () => {
  it('keeps the fixtures of today: title first, stats, requirements, the hint last', () => {
    const tip = catalog.tooltip({ code: SWORD.code, count: 1, plus: 2, durability: 25 }, { player: { level: 3 } })
    expect(tip[0]).toEqual({ text: 'Iron Sword (+2)', cls: 'title-plus' })
    expect(tip.map(l => l.text)).toContain('Phy. atk. pwr. 12 ~ 16')
    expect(tip.map(l => l.text)).toContain('Durability 25 / 30')
    expect(tip.find(l => l.text === 'Required level: 5')?.cls).toBe('bad')
    expect(tip[tip.length - 1]).toEqual({ text: t('item.hintEquip'), cls: 'hint' })
    for (const l of tip) expect(l.text).not.toMatch(/\{\w+\}/)
  })

  it('separates name, stats, requirements and price with sep lines, in that order', () => {
    const tip = catalog.tooltip({ code: SWORD.code, count: 1 }, { player: { level: 9 } })
    const cls = tip.map(l => l.cls)
    const seps = cls.flatMap((c, i) => (c === 'sep' ? [i] : []))
    expect(seps).toHaveLength(3)
    const iType = cls.indexOf('type')
    const iStat = cls.indexOf('stat')
    const iReq = cls.indexOf('req')
    const iPrice = cls.indexOf('price')
    expect(iType).toBeLessThan(seps[0]!)
    expect(iStat).toBeGreaterThan(seps[0]!)
    expect(iStat).toBeLessThan(seps[1]!)
    expect(iReq).toBeGreaterThan(seps[1]!)
    expect(iReq).toBeLessThan(seps[2]!)
    expect(iPrice).toBeGreaterThan(seps[2]!)
    expect(tip[iPrice]!.text).toBe(t('item.sellPrice', { gold: '20' }))
    expect(shape(tip)).toBe('title type sep body sep req req sep price hint')
  })

  it('never starts, ends or doubles a separator', () => {
    const cases = [
      catalog.tooltip({ code: POTION.code, count: 20 }),
      catalog.tooltip({ code: QUEST_ITEM.code, count: 1 }),
      catalog.tooltip({ code: 'ITEM_UNKNOWN_THING', count: 3 }),
      catalog.tooltip({ code: 'ITEM_CH_M_LIGHT_01_HA_A', count: 1 }, { equipped: true }),
    ]
    for (const tip of cases) {
      const cls = tip.map(l => l.cls)
      expect(cls[0]).toMatch(/^title/)
      expect(cls[cls.length - 1]).toBe('hint')
      expect(cls[cls.length - 2]).not.toBe('sep')
      for (let i = 1; i < cls.length; i++) expect(cls[i] === 'sep' && cls[i - 1] === 'sep').toBe(false)
      for (const l of tip) if (l.cls === 'sep') expect(l.text).toBe('')
    }
    // No price for an unsellable item: its trade section is the two flags.
    const letter = catalog.tooltip({ code: QUEST_ITEM.code, count: 1 })
    expect(letter.some(l => l.cls === 'price')).toBe(false)
    expect(letter.map(l => l.text)).toEqual(expect.arrayContaining([t('item.noSell'), t('item.noDrop')]))
  })

  it('joins sections and colours rare (Seal) items like +N', () => {
    expect(tooltipSections([], [{ text: 'a', cls: 'stat' }], [], [{ text: 'b', cls: 'magic' }])).toEqual([
      { text: 'a', cls: 'stat' },
      { text: '', cls: 'sep' },
      { text: 'b', cls: 'magic' },
    ])
    expect(tooltipSections([], [])).toEqual([])
    expect(isRareCode('ITEM_CH_SWORD_01_A_RARE')).toBe(true)
    expect(isRareCode('ITEM_CH_SWORD_01_A')).toBe(false)
    expect(new ItemCatalog([{ ...SWORD, code: 'ITEM_CH_SWORD_01_A_RARE' }]).tooltip({ code: 'ITEM_CH_SWORD_01_A_RARE', count: 1 })[0]?.cls).toBe('title-plus')
  })
})

describe('M9: slot decorators', () => {
  it('merges the stack sign with each decorator, later wins, and unregisters', () => {
    expect(slotSigns({ code: SWORD.code, count: 1, plus: 3 }, SWORD)).toEqual({ plus: 3, rare: false })
    expect(slotSigns({ code: 'ITEM_CH_SWORD_01_A_RARE', count: 1 }, undefined).rare).toBe(true)
    const off = registerSlotDecorator((stack, def) => (def?.stats?.durability && stack.durability === 0 ? { durability: 'broken' } : null))
    const off2 = registerSlotDecorator(() => {
      throw new Error('boom')
    })
    expect(slotSigns({ code: SWORD.code, count: 1, durability: 0 }, SWORD).durability).toBe('broken')
    expect(slotSigns({ code: SWORD.code, count: 1, durability: 10 }, SWORD).durability).toBeUndefined()
    off()
    off2()
    expect(slotSigns({ code: SWORD.code, count: 1, durability: 0 }, SWORD).durability).toBeUndefined()
  })
})

describe('M8: bag lock marks', () => {
  it('keeps named sets, ORs them and clears with an empty set', () => {
    const m = new BagMarks()
    expect(m.set('trade', new Set([1, 2]))).toBe(true)
    expect(m.set('trade', new Set([2, 1]))).toBe(false)
    expect(m.set('stall', new Set([5]))).toBe(true)
    expect([1, 2, 5].every(i => m.has(i))).toBe(true)
    expect(m.has(3)).toBe(false)
    expect(m.set('trade', new Set())).toBe(true)
    expect(m.has(1)).toBe(false)
    expect(m.all()).toEqual([5])
    expect(m.set('nothing', new Set())).toBe(false)
  })
})

describe('M7: NPC services', () => {
  it('lists registered services after the fixed ones and never repair', () => {
    expect(dialogOptions(['shop', 'repair', 'guild'])).toEqual(['shop'])
    const off = registerNpcServiceHandler('guild', () => {})
    expect(dialogOptions(['shop', 'repair', 'guild'])).toEqual(['shop', 'guild'])
    expect(dialogOptions(['guild', 'quest', 'guild', 'storage'])).toEqual(['storage', 'quest', 'guild'])
    expect(npcServiceHandler('guild')).toBeTypeOf('function')
    off()
    expect(dialogOptions(['shop', 'guild'])).toEqual(['shop'])
    expect(HIDDEN_SERVICES).toContain('repair')
    expect(OPTION_KEY.guild).toBe('npc.option.guild')
    expect(en[OPTION_KEY.guild!]).toBeTruthy()
  })
})

describe('M6: the shop footer', () => {
  it('shows a button when its services match, hides it when `when` throws', () => {
    const repair = { when: (s: readonly string[]) => s.includes('repair') }
    expect(footerButtonShown(repair, ['shop', 'repair'])).toBe(true)
    expect(footerButtonShown(repair, ['shop'])).toBe(false)
    expect(
      footerButtonShown(
        {
          when: () => {
            throw new Error('x')
          },
        },
        ['repair'],
      ),
    ).toBe(false)
  })
})

describe('M10: option rows of other lanes', () => {
  const host: OptionsHost = { engine: 'WebGL2', keyHelp() {}, toast() {}, menu: { app: {} as never, close() {}, characterSelect() {}, logout() {} } }
  it('appends registered rows to their page, once per id, and removes them', () => {
    const row: OptionRow = { id: 'ui.guildName', kind: 'toggle', label: 'options.showFps', get: () => true, patch: v => ({ ui: { showFps: v } }) }
    const before = pageRows(host, 'interface').length
    const off = registerOptionRow('interface', row)
    registerOptionRow('interface', { ...row })
    expect(pageRows(host, 'interface')).toHaveLength(before + 1)
    expect(pageRows(host, 'interface').at(-1)?.id).toBe('ui.guildName')
    expect(registeredOptionRows('graphics')).toHaveLength(0)
    off()
    expect(registeredOptionRows('interface').some(r => r === row)).toBe(false)
    for (const tab of OPTIONS_TABS) expect(pageRows(host, tab).length).toBeGreaterThan(0)
  })
})

describe('window layouts', () => {
  it('pages the 4 × 8 bag lattice', () => {
    expect(BAG_PAGE).toBe(32)
    expect(bagPages(48)).toBe(2)
    expect(bagPages(0)).toBe(1)
    expect(bagPages(96)).toBe(3)
    expect(pageOfSlot(31)).toBe(0)
    expect(pageOfSlot(32)).toBe(1)
  })

  it('pages shop goods and storage by the 6 × 5 lattice', () => {
    expect(shopPages(0)).toBe(1)
    expect(shopPages(30)).toBe(1)
    expect(shopPages(31)).toBe(2)
    expect(storagePages(150)).toBe(5)
  })

  it('places the 12 equipment slots at the retail rects, inside the 178 × 355 panel', () => {
    const rects = Object.values(EQUIP_LAYOUT).map(s => s.rect)
    expect(rects).toHaveLength(12)
    for (const [x, y, w, h] of rects) {
      expect(w).toBe(32)
      expect(h).toBe(32)
      expect(x >= 0 && x + w <= 178 && y >= 0 && y + h <= 355).toBe(true)
    }
    expect(new Set(rects.map(r => r.join(','))).size).toBe(12)
    expect(expPercentText(59, 118)).toBe('50.00 %')
  })

  it('sums masteries and has a tab picture for each', () => {
    expect(masteryTotal({ BICHEON: 5, COLD: 3 })).toBe(8)
    expect(Object.keys(MASTERY_TAB_ART)).toHaveLength(7)
  })

  it('colours quest rows and toggles party modes', () => {
    expect(questBar({ status: 'ready' }, false)).toBe('green')
    expect(questBar({ status: 'active' } as never, false)).toBe('blue')
    expect(questBar(null, true)).toBe('red')
    expect(nextPartyMode('free')).toBe('share')
    expect(nextPartyMode('share')).toBe('free')
  })

  it('lays the System window rows at the retail pitch without "Back to game"', () => {
    expect([0, 1, 2, 3, 4].map(systemRowTop)).toEqual([58, 92, 125, 159, 192])
    const item = (id: string): MenuItem => ({ id, label: 'menu.options', order: 0, run() {} })
    expect(systemRows([item('options'), item('logout'), item('resume')]).map(i => i.id)).toEqual(['options', 'logout'])
  })
})

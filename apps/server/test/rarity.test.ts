/**
 * Rare weapons on the server (docs/RARITY.md §4, §6): the seal roll of weapon drops (only ordinary weapons whose seal
 * row exists; gold, other items and seals untouched), the live admin rates, the server-wide `rareNotice` from
 * RARE_ANNOUNCE_FROM, alchemy on a seal (the code stays, +N rises), the abuse rules (alchemy, a GM edit or a shop
 * never turn a regular weapon into a seal) and the GM `rarity` command.
 */
import type { DropTable, ItemDef, ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerConfig } from '../src/config.ts'
import { loadConfig } from '../src/config.ts'
import { SETTINGS } from '../src/admin/settings.ts'
import { GameData } from '../src/gamedata.ts'
import type { RolledDrop } from '../src/gameplay.ts'
import { isRegularWeapon, rarityRates, rollRareDrops } from '../src/rarity.ts'
import { LEVELS, MANGNYANG, item } from './fixtures.ts'
import { NPC_DEFS, NPC_ITEMS, SHOP_DEFS, npcHarness, type NpcHarness } from './npc-harness.ts'

const SWORD_BASE: Partial<ItemDef> = {
  category: 'weapon', slot: 'weapon', weaponType: 'sword', degree: 3, reqLevel: 16, race: 'china', typeId: [3, 1, 6, 2], range: 1.5,
  stats: { physAttack: [79, 89], magAttack: [134, 154], durability: [75, 91] }, perPlus: { physAttack: 4.7, magAttack: 8.1 },
}
const SWORD_A = item('ITEM_CH_SWORD_03_A', { ...SWORD_BASE, reqLevel: 16, stats: { physAttack: [58.5, 66], durability: [71, 87] } })
const SWORD_C = item('ITEM_CH_SWORD_03_C', { ...SWORD_BASE, reqLevel: 21 })
const STAR = item('ITEM_CH_SWORD_03_A_RARE', { ...SWORD_BASE })
const MOON = item('ITEM_CH_SWORD_03_B_RARE', { ...SWORD_BASE, stats: { physAttack: [102.5, 115], durability: [78, 95] } })
const SUN = item('ITEM_CH_SWORD_03_C_RARE', { ...SWORD_BASE, stats: { physAttack: [130, 146], durability: [81, 99] } })
const SWORD_DEF = item('ITEM_CH_SWORD_01_A_DEF', { ...SWORD_BASE, degree: 1, reqLevel: 1 })
/** A family without seal rows. */
const BLADE = item('ITEM_CH_BLADE_02_A', { ...SWORD_BASE, weaponType: 'blade', typeId: [3, 1, 6, 3] })
const SHIELD = item('ITEM_CH_SHIELD_03_A', { category: 'shield', slot: 'shield', degree: 3, typeId: [3, 1, 4, 1], race: 'china' })
const ELIXIR = item('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A', { category: 'alchemy', typeId: [3, 3, 10, 1], degree: 1, maxStack: 1, reinforce: { kind: 'elixir', targets: [6], rates: [25, 20, 15, 10, 10, 10, 10, 10, 10, 5, 5, 5] } })
const ITEMS = [SWORD_A, SWORD_C, STAR, MOON, SUN, SWORD_DEF, BLADE, SHIELD, ELIXIR]
const BY_CODE = new Map(ITEMS.map((i) => [i.code, i]))
const lookup = (c: string) => BY_CODE.get(c)

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})

function setup(config: Partial<ServerConfig> = {}, drops: DropTable[] = []) {
  const data = new GameData({ mobs: [{ ...MANGNYANG, level: 25 }], items: [...NPC_ITEMS, ...ITEMS], levels: LEVELS, drops, npcs: NPC_DEFS, shops: SHOP_DEFS, towns: [] })
  const h = npcHarness({ data, config })
  harnesses.push(h)
  return h
}

const FIELD: [number, number, number] = [200, 0, 200]
const SWORD_TABLE: DropTable = { mob: MANGNYANG.code, groups: [{ chance: 1, entries: [{ item: SWORD_A.code, weight: 1 }] }], provenance: 'test' as DropTable['provenance'] }

/** A kill by a level-25 monster (docs/CLIMB.md §4.1, D41: degree-3 Moon and Sun come only from the cap band). */
function kill(h: NpcHarness, p: ReturnType<NpcHarness['enter']>['p'], level = 25) {
  const m = h.gameplay.createMob({ ...MANGNYANG, level }, 'normal', 206, 204, 0, null, h.now())
  p.known.add(m.id)
  const before = new Set(h.world.items.keys())
  h.gameplay.dealHits(p, m, [{ outcome: 'hit', damage: 999999, hp: 0 }], {}, h.now())
  return [...h.world.items.values()].filter((i) => !before.has(i.id))
}

describe('rollRareDrops', () => {
  const always = { starPct: 0, moonPct: 0, sunPct: 100 }

  it('turns an ordinary weapon into its seal; count and plus stay', () => {
    const drops: RolledDrop[] = [{ code: SWORD_A.code, count: 1, plus: 2 }]
    expect(rollRareDrops(drops, () => 0, always, lookup)).toEqual([{ code: SUN.code, count: 1, plus: 2 }])
    expect(rollRareDrops([{ code: SWORD_C.code, count: 1 }], () => 0.5, { starPct: 0, moonPct: 100, sunPct: 0 }, lookup)).toEqual([{ code: MOON.code, count: 1 }])
  })

  it('leaves gold, non-weapons, _DEF rows, seals and families without seal rows alone', () => {
    const drops: RolledDrop[] = [
      { code: 'ITEM_ETC_GOLD_01', count: 50, gold: true },
      { code: SHIELD.code, count: 1 },
      { code: SWORD_DEF.code, count: 1 },
      { code: STAR.code, count: 1 },
      { code: BLADE.code, count: 1 },
      { code: ELIXIR.code, count: 1 },
    ]
    expect(rollRareDrops(drops, () => 0, always, lookup)).toEqual(drops)
    expect(isRegularWeapon(STAR)).toBe(false)
    expect(isRegularWeapon(SWORD_DEF)).toBe(false)
    expect(isRegularWeapon(SWORD_C)).toBe(true)
  })

  it('at 0 % nothing changes', () => {
    const drops: RolledDrop[] = [{ code: SWORD_A.code, count: 1 }]
    expect(rollRareDrops(drops, () => 0, { starPct: 0, moonPct: 0, sunPct: 0 }, lookup)).toEqual(drops)
  })
})

describe('settings', () => {
  it('RARE_* env knobs with the defaults, out of range refused; the admin panel lists them as live', () => {
    const base = { DATA_DIR: 'x' }
    expect(rarityRates(loadConfig(base))).toEqual({ starPct: 1.5, moonPct: 0.4, sunPct: 0.1 })
    expect(loadConfig(base).rareAnnounceFrom).toBe(3)
    const c = loadConfig({ ...base, RARE_STAR_PCT: '2', RARE_MOON_PCT: '0.5', RARE_SUN_PCT: '0', RARE_ANNOUNCE_FROM: '2' })
    expect(rarityRates(c)).toEqual({ starPct: 2, moonPct: 0.5, sunPct: 0 })
    // D54: at most 2 % each (RARE_PCT_MAX)
    expect(() => loadConfig({ ...base, RARE_SUN_PCT: '2.5' })).toThrow(/RARE_SUN_PCT/)
    expect(() => loadConfig({ ...base, RARE_ANNOUNCE_FROM: '4' })).toThrow(/RARE_ANNOUNCE_FROM/)
    expect(c.rareAnnounceFrom).toBe(2)
    const keys = SETTINGS.filter((s) => s.group === 'Rare weapons')
    expect(keys.map((s) => s.key)).toEqual(['rareStarPct', 'rareMoonPct', 'rareSunPct', 'rareTopMinLevel', 'rareMidMinLevel', 'rareAnnounceFrom'])
    expect(loadConfig(base).rareTopMinLevel).toBe(25)
    expect(loadConfig({ ...base, RARE_TOP_MIN_LEVEL: '0' }).rareTopMinLevel).toBe(0)
    for (const s of keys) expect(s.apply).toBe('live')
  })
})

describe('kills', () => {
  it('a weapon drop comes as a seal at the live rate; a Sun is announced to every player in the world', () => {
    const h = setup({ rareStarPct: 0, rareMoonPct: 0, rareSunPct: 100, elixirDropPct: 0 }, [SWORD_TABLE])
    const { p } = h.enter(FIELD)
    const other = h.enter([-200, 0, -200])
    const loot = kill(h, p)
    expect(loot.map((i) => i.code)).toEqual([SUN.code])
    const notes = h.of(other.inbox, 'rareNotice')
    expect(notes).toEqual([{ t: 'rareNotice', by: p.name, item: SUN.code, name: SUN.name, tier: 'sun' }])
    expect(h.logs.some((l) => l.includes('Seal of Sun'))).toBe(true)
  })

  it('the Climb (CLIMB §4.1, D41): a degree-3 Moon or Sun only from a monster of RARE_TOP_MIN_LEVEL (25); a level-20 one gives a Star', () => {
    const h = setup({ rareStarPct: 0, rareMoonPct: 0, rareSunPct: 100, elixirDropPct: 0 }, [SWORD_TABLE])
    const { p } = h.enter(FIELD)
    expect(kill(h, p, 20).map((i) => i.code)).toEqual([STAR.code])
    h.config.rareMoonPct = 100
    h.config.rareSunPct = 0
    expect(kill(h, p, 24).map((i) => i.code)).toEqual([STAR.code])
    expect(kill(h, p, 25).map((i) => i.code)).toEqual([MOON.code])
    h.config.rareTopMinLevel = 0
    expect(kill(h, p, 1).map((i) => i.code)).toEqual([MOON.code])
  })

  it('the admin rates apply live; Star and Moon are not announced at the default (Sun only)', () => {
    const h = setup({ rareStarPct: 0, rareMoonPct: 0, rareSunPct: 0, elixirDropPct: 0 }, [SWORD_TABLE])
    const { p, inbox } = h.enter(FIELD)
    expect(kill(h, p).map((i) => i.code)).toEqual([SWORD_A.code])
    h.config.rareStarPct = 100
    expect(kill(h, p).map((i) => i.code)).toEqual([STAR.code])
    h.config.rareStarPct = 0
    h.config.rareMoonPct = 100
    expect(kill(h, p).map((i) => i.code)).toEqual([MOON.code])
    expect(h.of(inbox, 'rareNotice' as ServerMessage['t'])).toEqual([])
    h.config.rareAnnounceFrom = 2
    kill(h, p)
    expect(h.of(inbox, 'rareNotice')).toHaveLength(1)
    h.config.rareAnnounceFrom = 0
    h.config.rareSunPct = 100
    kill(h, p)
    expect(h.of(inbox, 'rareNotice')).toHaveLength(1)
  })
})

describe('alchemy and abuse', () => {
  it('alchemy enhances a seal like any weapon: the code stays, +N rises', () => {
    const h = setup({ alchemyRate: 10, alchemyFuseMs: 0 })
    const { p, inbox } = h.enter(FIELD)
    const sword = h.give(p, SUN.code, 1, { plus: 6 })
    const el = h.give(p, ELIXIR.code, 1)
    expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el })).toMatchObject({ ok: true })
    expect(h.bag(p)[sword]).toMatchObject({ code: SUN.code, plus: 7 })
  })

  it('a regular weapon never becomes a seal: alchemy keeps its code, a seal cannot be bought, GM plus keeps it', () => {
    const h = setup({ alchemyRate: 10, alchemyFuseMs: 0 })
    const { p, inbox } = h.enter(FIELD)
    const sword = h.give(p, SWORD_A.code, 1)
    for (let i = 0; i < 3; i++) {
      const el = h.give(p, ELIXIR.code, 1)
      expect(h.req(p, inbox, { t: 'alchemyReinforce', item: sword, elixir: el })).toMatchObject({ ok: true })
    }
    expect(h.bag(p)[sword]).toMatchObject({ code: SWORD_A.code, plus: 3 })
    expect(h.gameplay.alchemy.gm(p, [String(sword), '7']).ok).toBe(true)
    expect(h.bag(p)[sword]).toMatchObject({ code: SWORD_A.code, plus: 7 })
    const shop = h.npcByCode(NPC_DEFS.find((n) => n.shop)?.code ?? NPC_DEFS[0]!.code)
    const r = h.req(p, inbox, { t: 'shopBuy', npc: shop.id, item: SUN.code, count: 1 })
    expect(r.ok).toBe(false)
    expect(h.countOf(p, SUN.code)).toBe(0)
  })
})

describe('GM rarity', () => {
  it('rates; give a seal of the worn weapon or a named code; drop one at your feet (announced from the rank)', () => {
    const h = setup({ rareStarPct: 4, rareMoonPct: 1, rareSunPct: 0.25 })
    const { p, inbox } = h.enter(FIELD)
    expect(h.gameplay.rarity.gm(p, [])).toMatchObject({ ok: true, message: expect.stringContaining('Seal of Star 4 %') })
    expect(h.gameplay.rarity.gm(p, ['give', 'moon', SWORD_C.code])).toMatchObject({ ok: true })
    expect(h.countOf(p, MOON.code)).toBe(1)
    expect(h.gameplay.rarity.gm(p, ['give', 'sun', STAR.code])).toMatchObject({ ok: true })
    expect(h.countOf(p, SUN.code)).toBe(1)
    expect(h.gameplay.rarity.gm(p, ['give', 'sun', BLADE.code]).ok).toBe(false)
    expect(h.gameplay.rarity.gm(p, ['give', 'sun', ELIXIR.code]).ok).toBe(false)
    expect(h.gameplay.rarity.gm(p, ['give', 'comet', SWORD_A.code]).ok).toBe(false)
    expect(h.gameplay.rarity.gm(p, ['polish']).ok).toBe(false)
    expect(h.gameplay.rarity.gm(p, ['drop', 'sun', SWORD_A.code])).toMatchObject({ ok: true })
    expect([...h.world.items.values()].map((i) => i.code)).toContain(SUN.code)
    expect(h.of(inbox, 'rareNotice')).toHaveLength(1)
  })

  it('takes a shield code too (seal shields exist from degree 3)', () => {
    const h = setup({})
    const shield = 'ITEM_CH_SHIELD_03_A'
    if (!h.data.item(shield) || !h.data.item(`${shield}_RARE`)) return
    const { p } = h.enter(FIELD)
    expect(h.gameplay.rarity.gm(p, ['give', 'star', shield])).toMatchObject({ ok: true })
    expect(h.countOf(p, `${shield}_RARE`)).toBe(1)
  })
})

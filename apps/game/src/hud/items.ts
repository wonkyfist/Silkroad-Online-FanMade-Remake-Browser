/**
 * Item lookup for the HUD: definitions from /out/data/items.json (ItemDef, packages/shared/src/content.ts) and
 * icons from /out/icons/index.json (packages/convert/src/tools/export-icons.ts). Both are optional: without
 * items.json the names come from the game text (SN_<code>) or the code itself, the slot kind is guessed from
 * the CodeName128 pattern, and the tooltip says the data is missing. No DOM here (unit-tested).
 */
import { applyClimbItemLevels, climbSetBonus, climbSetLineFor, contentEntries, equipSlotsFor, rarityOf, type EquipSlot, type ItemDef, type ItemSlotKind, type ItemStack, type PlayerStats } from '@sro/shared'
import { genderOf, weaponLabel } from '../content/catalog.ts'
import { gameText, t, type StringKey } from '../i18n/index.ts'
import { curDurability, durabilityState, maxDurability } from './repair.ts'

const OUT = '/out/'

/**
 * One tooltip line: text plus a style class (title, stat, req, bad, hint, desc; title-plus = the title of a +N or rare
 * item, W9). Wave 7B (docs/UI.md §4.8, M11): 'sep' is a section line (com_grayline, empty text), 'price' the gold
 * line, 'magic' a blue option, 'warn' a yellow warning.
 */
export interface TooltipLine {
  text: string
  cls: 'title' | 'title-plus' | 'type' | 'stat' | 'req' | 'bad' | 'hint' | 'desc' | 'magic' | 'sep' | 'price' | 'warn' | 'struck'
    // docs/RARITY.md §5.6: a seal's name in its tier's colour, and the seal banner
    | 'title-star' | 'title-moon' | 'title-sun' | 'rare-star' | 'rare-moon' | 'rare-sun'
}

/** A section separator line of the item tooltip. */
export const TOOLTIP_SEP: TooltipLine = { text: '', cls: 'sep' }

/**
 * Joins tooltip sections with separator lines (docs/UI.md §4.8): empty sections are dropped, so no two separators
 * touch and none leads or trails.
 */
export function tooltipSections(...sections: readonly (readonly TooltipLine[])[]): TooltipLine[] {
  const out: TooltipLine[] = []
  for (const sec of sections) {
    if (!sec.length) continue
    if (out.length) out.push({ ...TOOLTIP_SEP })
    out.push(...sec)
  }
  return out
}

/** A Seal of Star/Moon/Sun item (retail rare, "_RARE" codes): gold title and the rare sign. */
export function isRareCode(code: string): boolean {
  return /_RARE(_|$)/.test(code)
}

const ARMOR_PARTS: Record<string, ItemSlotKind> = { HA: 'head', SA: 'shoulders', BA: 'chest', LA: 'legs', AA: 'hands', FA: 'feet' }

/** Slot kind from the CodeName128 alone (used while items.json is missing). */
export function guessSlotKind(code: string): ItemSlotKind | undefined {
  if (/^ITEM_ETC_/.test(code)) return undefined
  if (/_(SWORD|BLADE|SPEAR|TBLADE|BOW)_\d/.test(code)) return 'weapon'
  if (/_SHIELD_\d/.test(code)) return 'shield'
  if (/_EARRING_\d/.test(code)) return 'earring'
  if (/_NECKLACE_\d/.test(code)) return 'necklace'
  if (/_RING_\d/.test(code)) return 'ring'
  const m = /^ITEM_CH_[MW]_(HEAVY|LIGHT|CLOTHES)_\d+_([A-Z])A_/.exec(code)
  if (m) return ARMOR_PARTS[`${m[2]}A`]
  return undefined
}

/** "ITEM_ETC_HP_POTION_01" -> "Hp Potion 01": a readable last resort when no name is known. */
export function prettyCode(code: string): string {
  const words = code.replace(/^ITEM_(CH_|EU_|ETC_)?/, '').split('_').filter(Boolean)
  return words.map(w => (/^\d+$/.test(w) ? w : w[0] + w.slice(1).toLowerCase())).join(' ') || code
}

/**
 * Whether the character can wear the item: the server's wearProblem rules (level, gender from the model code, no
 * European gear). Items that are not worn, and items without a definition, count as usable (docs/UX_GAPS.md W3).
 */
export function canUse(def: ItemDef | undefined, player: Pick<PlayerStats, 'level'> | null, model: string | null): boolean {
  if (!def?.slot) return true
  if (player && def.reqLevel > player.level) return false
  if (model && def.reqGender !== 'any' && def.reqGender !== genderOf(model)) return false
  return def.race !== 'europe'
}

function fmtRange(r: [number, number] | undefined, bonus = 0): { min: string; max: string } | null {
  if (!r) return null
  const f = (v: number) => String(Math.round((v + bonus) * 10) / 10)
  return { min: f(r[0]), max: f(r[1]) }
}

export class ItemCatalog {
  private readonly defs = new Map<string, ItemDef>()

  private icons: Record<string, string>

  constructor(defs: ItemDef[] = [], icons: Record<string, string> = {}) {
    this.icons = { ...icons }
    for (const d of defs) if (d && typeof d.code === 'string') this.defs.set(d.code, d)
  }

  /** Takes over another catalog's data (the shared one once it has loaded); views keep their reference. */
  adopt(other: ItemCatalog): void {
    for (const [k, v] of other.defs) this.defs.set(k, v)
    this.icons = { ...this.icons, ...other.icons }
  }

  get size(): number {
    return this.defs.size
  }

  get codes(): string[] {
    return [...new Set([...this.defs.keys(), ...Object.keys(this.icons)])].sort()
  }

  def(code: string): ItemDef | undefined {
    return this.defs.get(code)
  }

  name(code: string): string {
    return this.defs.get(code)?.name ?? gameText(`SN_${code}`, prettyCode(code))
  }

  /** Display name of a stack, with its +N. */
  stackName(stack: ItemStack): string {
    const name = this.name(stack.code)
    return stack.plus ? t('item.plus', { name, plus: stack.plus }) : name
  }

  /** Icon URL: the icon export first, then ItemDef.icon; null when neither exists. */
  icon(code: string): string | null {
    const file = this.icons[code]
    if (file) return file.startsWith('/') ? file : OUT + file
    return this.defs.get(code)?.icon ?? null
  }

  slotKind(code: string): ItemSlotKind | undefined {
    const d = this.defs.get(code)
    if (d) return d.slot
    return guessSlotKind(code)
  }

  isEquipment(code: string): boolean {
    return this.slotKind(code) !== undefined
  }

  /** Whether an item may go into an equipment slot (unknown items are left to the server). */
  fits(code: string, slot: EquipSlot): boolean {
    const kind = this.slotKind(code)
    return kind === undefined ? !this.defs.has(code) && !/^ITEM_ETC_/.test(code) : equipSlotsFor(kind).includes(slot)
  }

  maxStack(code: string): number {
    return this.defs.get(code)?.maxStack ?? 1
  }

  /** A stable colour for the no-icon fallback square. */
  colour(code: string): string {
    let h = 0
    for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0
    return `hsl(${h % 360} 45% 38%)`
  }

  /**
   * Tooltip content in the retail layout (docs/UI.md §4.8): name; type/degree; — stats and effects; — requirements;
   * — price and trade flags; then the action hint. Sections are joined by 'sep' lines.
   */
  tooltip(stack: ItemStack, opts: { player?: Pick<PlayerStats, 'level'> | null; equipped?: boolean; model?: string | null; worn?: readonly string[] } = {}): TooltipLine[] {
    const tier = rarityOf(stack.code)
    const head: TooltipLine[] = [{ text: this.stackName(stack), cls: tier ? `title-${tier}` : stack.plus || isRareCode(stack.code) ? 'title-plus' : 'title' }]
    // docs/RARITY.md §5.6: the seal banner right under the name ("✦ Seal of Sun ✦").
    if (tier) head.push({ text: t(`rarity.banner.${tier}` as StringKey), cls: `rare-${tier}` })
    const d = this.defs.get(stack.code)
    const wearable = d ? !!d.slot : !!guessSlotKind(stack.code)
    const hint: TooltipLine = { text: t(opts.equipped ? 'item.hintUnequip' : wearable ? 'item.hintEquip' : 'item.hintUse'), cls: 'hint' }
    if (!d) {
      const kind = guessSlotKind(stack.code)
      if (kind) head.push({ text: t(`equip.${kind}` as StringKey), cls: 'type' })
      const body: TooltipLine[] = []
      if (stack.count > 1) body.push({ text: t('item.count', { count: stack.count }), cls: 'stat' })
      body.push({ text: t('item.unknown', { code: stack.code }), cls: 'desc' })
      return [...tooltipSections(head, body), hint]
    }
    const typeParts: string[] = []
    if (d.weaponType) typeParts.push(weaponLabel(d.weaponType))
    else if (d.armorType) typeParts.push(t(`item.armor.${d.armorType}` as StringKey))
    else typeParts.push(t(`item.cat.${d.category}` as StringKey))
    if (d.slot && d.category !== 'weapon' && d.category !== 'shield') typeParts.push(t(`equip.${d.slot}` as StringKey))
    if (d.degree > 0) typeParts.push(t('item.degree', { degree: ordinal(d.degree) }))
    head.push({ text: typeParts.join('  ·  '), cls: 'type' })
    const stats: TooltipLine[] = []
    if (d.category === 'weapon' && d.twoHanded !== undefined) stats.push({ text: t(d.twoHanded ? 'item.twoHanded' : 'item.oneHanded'), cls: 'stat' })
    if (stack.count > 1 || d.maxStack > 1) stats.push({ text: t('item.count', { count: stack.count }), cls: 'stat' })
    const s = d.stats ?? {}
    const statKeys: [keyof NonNullable<ItemDef['stats']>, StringKey][] = [
      ['physAttack', 'item.physAttack'],
      ['magAttack', 'item.magAttack'],
      ['physDefence', 'item.physDefence'],
      ['magDefence', 'item.magDefence'],
      ['hitRate', 'item.hitRate'],
      ['parryRate', 'item.parryRate'],
      ['blockRate', 'item.blockRate'],
      ['critRate', 'item.critRate'],
      ['physAbsorb', 'item.physAbsorb'],
      ['magAbsorb', 'item.magAbsorb'],
    ]
    // items.json may carry the per-enhancement increments (additive field perPlus); +N adds them.
    const perPlus = (d as ItemDef & { perPlus?: Partial<Record<string, number>> }).perPlus ?? {}
    // Wave 8 DR (D11): a broken item (durability 0) gives no stats, so its stat lines are dimmed.
    const dur = durabilityState(stack, d)
    for (const [k, key] of statKeys) {
      const r = fmtRange(s[k], (stack.plus ?? 0) * (perPlus[k] ?? 0))
      if (r) stats.push({ text: t(key, r), cls: dur === 'broken' ? 'struck' : 'stat' })
    }
    const max = maxDurability(d)
    if (max !== null && dur) {
      // Wave 8 DR (D11): "cur / max" (a full stack is "max / max"), yellow at <= DUR_WARN_PCT, red "(broken)" at 0.
      const text = t('item.durability', { cur: curDurability(stack, max), max })
      stats.push(dur === 'broken' ? { text: `${text} ${t('dur.broken')}`, cls: 'bad' } : { text, cls: dur === 'low' ? 'warn' : 'stat' })
    }
    if (d.range !== undefined && d.category === 'weapon') stats.push({ text: t('item.range', { m: Math.round(d.range * 10) / 10 }), cls: 'stat' })
    const u = d.use
    if (u) {
      if (u.hp) stats.push({ text: t('item.useHp', { hp: u.hp }), cls: 'stat' })
      if (u.mp) stats.push({ text: t('item.useMp', { mp: u.mp }), cls: 'stat' })
      if (u.hpPct) stats.push({ text: t('item.useHpPct', { pct: u.hpPct }), cls: 'stat' })
      if (u.mpPct) stats.push({ text: t('item.useMpPct', { pct: u.mpPct }), cls: 'stat' })
      if (u.returnToTown) stats.push({ text: t('item.useReturn'), cls: 'stat' })
      if (u.cooldownMs) stats.push({ text: t('item.cooldown', { s: Math.round(u.cooldownMs / 100) / 10 }), cls: 'desc' })
    }
    if (d.maxStack > 1) stats.push({ text: t('item.maxStack', { n: d.maxStack }), cls: 'desc' })
    // The Climb's set bonuses (docs/CLIMB.md §4.2): the set this piece belongs to, counted on the worn items.
    const set = opts.worn ? this.setLine(d, opts.worn) : null
    if (set) stats.push(set)
    const reqs: TooltipLine[] = []
    if (d.reqLevel > 0) {
      const level = opts.player?.level
      reqs.push({ text: t('item.reqLevel', { level: d.reqLevel }), cls: level !== undefined && level < d.reqLevel ? 'bad' : 'req' })
    }
    // Gender is red for a character of the other one (known from its model code).
    const wrongGender = !!opts.model && d.reqGender !== 'any' && d.reqGender !== genderOf(opts.model)
    if (d.reqGender === 'male') reqs.push({ text: t('item.reqMale'), cls: wrongGender ? 'bad' : 'req' })
    if (d.reqGender === 'female') reqs.push({ text: t('item.reqFemale'), cls: wrongGender ? 'bad' : 'req' })
    if (d.race === 'china') reqs.push({ text: t('item.raceChina'), cls: 'req' })
    if (d.race === 'europe') reqs.push({ text: t('item.raceEurope'), cls: 'bad' })
    const trade: TooltipLine[] = []
    if (d.canSell === false) trade.push({ text: t('item.noSell'), cls: 'desc' })
    else if (d.sellPrice > 0) trade.push({ text: t('item.sellPrice', { gold: formatNumber(d.sellPrice * Math.max(1, stack.count)) }), cls: 'price' })
    if (d.canDrop === false) trade.push({ text: t('item.noDrop'), cls: 'desc' })
    return [...tooltipSections(head, stats, reqs, trade), hint]
  }

  /** "Iron set (4/6): +3 % max HP" (the step reached), or the next step's pieces and bonus; null for a piece of no set. */
  setLine(d: ItemDef, worn: readonly string[]): TooltipLine | null {
    const defs = worn.map((c) => this.defs.get(c)).filter((x): x is ItemDef => !!x)
    const line = climbSetLineFor(d, climbSetBonus(defs).lines)
    if (!line) return null
    const text = line.bonus
      ? t('climb.set.on', { name: line.name, n: line.count, of: line.of, bonus: line.bonus })
      : t('climb.set.next', { name: line.name, n: line.count, of: line.of, at: line.next?.at ?? line.of, bonus: line.next?.bonus ?? '' })
    return { text, cls: line.bonus ? 'stat' : 'desc' }
  }
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${s}`
}

/** 1234567 -> "1,234,567" (the client shows gold and EXP with thousands separators). */
export function formatNumber(n: number): string {
  const v = Math.round(n)
  return (v < 0 ? '-' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** Icon index: { items: { CODE: 'icons/...png' } }; anything else reads as empty. */
export function readIconIndex(json: unknown): Record<string, string> {
  const items = (json as { items?: unknown } | null)?.items
  if (!items || typeof items !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(items as Record<string, unknown>)) if (typeof v === 'string') out[k] = v
  return out
}

let shared: Promise<ItemCatalog> | null = null

/** Loads (once per page) the item definitions and icons; never rejects. */
export function loadItemCatalog(): Promise<ItemCatalog> {
  shared ??= (async () => {
    const [defs, icons] = await Promise.all([
      fetchJson(`${OUT}data/items.json`)
        .then(j => contentEntries<ItemDef>(j, 'items'))
        .catch(err => {
          console.warn('[hud] /out/data/items.json unavailable; item names and stats fall back to codes', err)
          return [] as ItemDef[]
        }),
      fetchJson(`${OUT}icons/index.json`)
        .then(readIconIndex)
        .catch(err => {
          console.warn('[hud] /out/icons/index.json unavailable; run pnpm tsx packages/convert/src/tools/export-icons.ts', err)
          return {}
        }),
    ])
    // The Climb (docs/CLIMB.md §4.1.2, D53): the required levels the server checks (every degree inside the cap), as
    // content/gameplay.ts applies them; without this the tooltip and the equip check read the client's retail levels.
    const byCode = new Map(defs.map(d => [d.code, d]))
    applyClimbItemLevels(byCode)
    return new ItemCatalog([...byCode.values()], icons)
  })()
  return shared
}

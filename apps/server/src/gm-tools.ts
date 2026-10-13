import {
  CLOSE_CODE,
  CODE_NAME,
  MAX_GOLD,
  MAX_ITEM_COUNT,
  RARITY,
  RARITY_TIERS,
  codePointLength,
  equipSlotsFor,
  rareCodeOf,
  rarityOf,
  type ArmorType,
  type EquipSlot,
  type ItemDef,
  type RarityTier,
  type Role,
  type StarterWeapon,
} from '@sro/shared'
import type { Connection } from './connection.ts'
import type { GameContext } from './game.ts'
import type { Command, GmCall, GmResult } from './gm.ts'
import { addGold, addItem, newItem, type InvDraft, type InvItem, type Result } from './inventory.ts'
import type { Player } from './world.ts'

/**
 * GM toolbox commands (the in-game GM panel's Toolbox tab): one-click gear sets, starter kits, potions, inventory
 * tools for yourself or an online player, gold, GM invincibility, moderation (mute, warn, ban, chat log),
 * server-wide announcements and rewards, area kills, nest respawns, timed EXP/drop boosts and event calls.
 * Every command runs through gm.ts runGm: staff-only, role re-read from the database, written to gm_audit
 * (who, command, args incl. the target, result, time).
 */

const RANK: Record<Role, number> = { player: 0, gm: 1, admin: 2 }
/** connection.ts cleanChat (not imported: gm.ts loads this module while connection.ts may still be loading). */
const cleanChat = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '').trim()

export const GEARSET_USAGE = 'gearset <degree 1-8> <garment|protector|armor|none> <sword|blade|spear|glaive|bow|none> [star|moon|sun] [+N] [noacc] [wear] [player]'
export const DEGREE_MAX = 8
export const PLUS_MAX = 20
export const ARMOR_SLOTS: readonly EquipSlot[] = ['head', 'shoulders', 'chest', 'legs', 'hands', 'feet']
const WEAPONS: readonly StarterWeapon[] = ['sword', 'blade', 'spear', 'glaive', 'bow']
const ARMORS: readonly ArmorType[] = ['garment', 'protector', 'armor']
export const MUTE_MAX_MIN = 10_080
export const CHATLOG_KEEP = 30
export const KILLALL_DEFAULT_M = 30
export const KILLALL_MAX_M = 150
export const BOOST_MAX_MUL = 10
export const BOOST_MAX_MIN = 480
export const POTION_DEFAULT = 50
export const REWARD_MAX = 1000

const ok = (message: string, data?: unknown): GmResult => (data === undefined ? { ok: true, message } : { ok: true, message, data })
const fail = (message: string): GmResult => ({ ok: false, message })

function int(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || !/^[-+]?\d+$/.test(raw.trim())) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null
}

// ---- per-server state (mutes, recent chat, boosts) ----------------------------------------------------------

interface Mute {
  until: number
  reason: string
  by: string
}
interface ChatLine {
  at: number
  channel: string
  text: string
}
interface Boost {
  exp: number
  drop: number
  baseExp: number
  baseDrop: number
  until: number
  timer: ReturnType<typeof setTimeout>
}
interface ToolsState {
  mutes: Map<number, Mute>
  chat: Map<number, ChatLine[]>
  boost: Boost | null
}
const states = new WeakMap<object, ToolsState>()
function state(ctx: Pick<GameContext, 'sockets'>): ToolsState {
  let s = states.get(ctx.sockets)
  if (!s) states.set(ctx.sockets, (s = { mutes: new Map(), chat: new Map(), boost: null }))
  return s
}

/** The mute of an account, or null (an expired one is forgotten). Checked by connection.ts before any free chat. */
export function muteOf(ctx: Pick<GameContext, 'sockets'>, accountId: number, now = Date.now()): Mute | null {
  const s = state(ctx)
  const m = s.mutes.get(accountId)
  if (!m) return null
  if (m.until <= now) {
    s.mutes.delete(accountId)
    return null
  }
  return m
}

/** Remembers a chat line of an account (the last CHATLOG_KEEP) for `chatlog`. */
export function noteChat(ctx: Pick<GameContext, 'sockets'>, accountId: number, channel: string, text: string, now = Date.now()): void {
  const s = state(ctx)
  const list = s.chat.get(accountId) ?? []
  list.push({ at: now, channel, text: text.slice(0, 200) })
  if (list.length > CHATLOG_KEEP) list.splice(0, list.length - CHATLOG_KEEP)
  s.chat.set(accountId, list)
}

// ---- targets ------------------------------------------------------------------------------------------------

function findOnline(ctx: GameContext, rawName: string): { conn: Connection; player: Player } | null {
  const name = rawName.replace(/^@/, '').toLowerCase()
  for (const conn of ctx.sockets.values()) if (conn.player && conn.player.name.toLowerCase() === name) return { conn, player: conn.player }
  return null
}

/** `.`, empty or the GM's own name = the GM; else an online player the GM does not outrank-fail on. */
function target(g: GmCall, raw: string | undefined): { player: Player; conn: Connection } | GmResult {
  if (raw === undefined || raw === '.' || raw === '' || (g.self && raw.replace(/^@/, '').toLowerCase() === g.self.name.toLowerCase())) {
    if (!g.self) return fail('Enter the world first, or name a player.')
    return { player: g.self, conn: g.conn }
  }
  const t = findOnline(g.ctx, raw)
  if (!t) return fail(`No online player named ${raw}.`)
  if (RANK[t.conn.role] > RANK[g.role]) return fail(`${t.player.name} outranks you.`)
  return t
}
const isResult = (v: unknown): v is GmResult => typeof v === 'object' && v !== null && 'ok' in v && 'message' in v

function invFail(r: { reason: string }, who: string): GmResult {
  return fail(r.reason === 'inventory_full' ? `${who}'s bag is full.` : `Cannot do that: ${r.reason}.`)
}

// ---- gear sets ----------------------------------------------------------------------------------------------

export interface GearSetOptions {
  degree: number
  armor: ArmorType | 'none'
  weapon: StarterWeapon | 'none'
  gender: 'male' | 'female'
  tier: RarityTier | null
  accessories: boolean
}

/** A regular (not sealed, not European) piece: the best of the degree is the one with the highest level, then the code. */
function best(list: ItemDef[]): ItemDef | null {
  if (list.length === 0) return null
  return [...list].sort((a, b) => b.reqLevel - a.reqLevel || Number(a.code.endsWith('_DEF')) - Number(b.code.endsWith('_DEF')) || a.code.localeCompare(b.code))[0]!
}

/**
 * The pieces of a full set: one armour piece per slot (type, degree, gender), earring + necklace + 2 rings of the
 * degree, the weapon (+ a shield for a one-handed one), each swapped for its Seal row when `tier` has one.
 */
export function pickGearSet(items: Iterable<ItemDef>, get: (code: string) => ItemDef | undefined, o: GearSetOptions): { pieces: ItemDef[]; missing: string[]; sealed: number } {
  const pool = [...items].filter((i) => i.degree === o.degree && i.race !== 'europe' && rarityOf(i.code) === null)
  const pieces: ItemDef[] = []
  const missing: string[] = []
  const wears = (i: ItemDef) => i.reqGender === 'any' || i.reqGender === o.gender
  if (o.armor !== 'none') {
    for (const slot of ARMOR_SLOTS) {
      const p = best(pool.filter((i) => i.category === 'armor' && i.slot === slot && i.armorType === o.armor && wears(i)))
      if (p) pieces.push(p)
      else missing.push(slot)
    }
  }
  if (o.accessories) {
    for (const [slot, n] of [['earring', 1], ['necklace', 1], ['ring', 2]] as const) {
      const p = best(pool.filter((i) => i.category === 'accessory' && i.slot === slot && wears(i)))
      if (p) for (let k = 0; k < n; k++) pieces.push(p)
      else missing.push(slot)
    }
  }
  if (o.weapon !== 'none') {
    const w = best(pool.filter((i) => i.category === 'weapon' && i.weaponType === o.weapon))
    if (w) {
      pieces.push(w)
      if (!w.twoHanded) {
        const s = best(pool.filter((i) => i.category === 'shield'))
        if (s) pieces.push(s)
        else missing.push('shield')
      }
    } else missing.push(o.weapon)
  }
  let sealed = 0
  const out = pieces.map((p) => {
    const code = o.tier ? rareCodeOf(p.code, o.tier) : null
    const r = code ? get(code) : undefined
    if (r) sealed++
    return r ?? p
  })
  return { pieces: out, missing, sealed }
}

/** Puts `pieces` (each with +plus) into the bag, or onto the body (the worn item goes to the bag). All or nothing. */
export function grantPieces(d: InvDraft, pieces: ItemDef[], plus: number, wear: boolean): Result<number> {
  const placed: Record<string, number> = {}
  for (const def of pieces) {
    const p = def.maxStack > 1 ? 0 : plus
    if (wear && def.slot) {
      const slots = equipSlotsFor(def.slot)
      const used = placed[def.slot] ?? 0
      const slot = slots[Math.min(used, slots.length - 1)]!
      placed[def.slot] = used + 1
      const old = d.equip[slot]
      if (old) {
        const free = d.firstFree()
        if (free < 0) return { ok: false, reason: 'inventory_full' }
        d.setBag(free, old)
      }
      d.setEquip(slot, newItem(def.code, 1, p))
      continue
    }
    const r = addItem(d, def, 1, p)
    if (!r.ok) return r
  }
  return { ok: true, value: pieces.length }
}

function parseGearArgs(args: string[]): { o: Omit<GearSetOptions, 'gender'>; plus: number; wear: boolean; who: string | undefined } | string {
  const [dRaw, aRaw, wRaw, ...rest] = args
  const degree = int(dRaw, 1, DEGREE_MAX)
  const armor = (aRaw ?? '').toLowerCase().replace(/^armour$/, 'armor')
  const weapon = (wRaw ?? '').toLowerCase()
  if (degree === null || !(armor === 'none' || (ARMORS as string[]).includes(armor)) || !(weapon === 'none' || (WEAPONS as string[]).includes(weapon))) return `Usage: ${GEARSET_USAGE}`
  let tier: RarityTier | null = null
  let plus = 0
  let accessories = true
  let wear = false
  let who: string | undefined
  for (const raw of rest) {
    const a = raw.toLowerCase()
    if ((RARITY_TIERS as readonly string[]).includes(a)) tier = a as RarityTier
    else if (a === 'normal' || a === 'none') tier = null
    else if (/^\+\d+$/.test(a)) {
      const n = int(a.slice(1), 0, PLUS_MAX)
      if (n === null) return `The enhancement is +0 to +${PLUS_MAX}.`
      plus = n
    } else if (a === 'noacc') accessories = false
    else if (a === 'acc') accessories = true
    else if (a === 'wear') wear = true
    else if (who === undefined) who = raw
    else return `Usage: ${GEARSET_USAGE}`
  }
  return { o: { degree, armor: armor as GearSetOptions['armor'], weapon: weapon as GearSetOptions['weapon'], tier, accessories }, plus, wear, who }
}

function giveSet(g: GmCall, p: Player, o: GearSetOptions, plus: number, wear: boolean): GmResult {
  const { ctx } = g
  const set = pickGearSet(ctx.data.items.values(), (c) => ctx.data.item(c), o)
  if (set.pieces.length === 0) return fail(`No degree-${o.degree} pieces of that kind${set.missing.length ? ` (missing: ${set.missing.join(', ')})` : ''}.`)
  const { result, draft } = ctx.store.inventoryTx(p.characterId, (d) => grantPieces(d, set.pieces, plus, wear))
  if (!result.ok) return invFail(result, p.name)
  ctx.gameplay.afterInventory(p, draft)
  const seal = o.tier ? `, ${set.sealed} with a ${RARITY[o.tier].name}` : ''
  const miss = set.missing.length ? ` Not found: ${set.missing.join(', ')}.` : ''
  if (p !== g.self) p.send({ t: 'chat', channel: 'system', text: 'A Game Master gave you a set of equipment.' })
  return ok(
    `${wear ? 'Dressed' : 'Gave'} ${p.name} ${set.pieces.length} degree-${o.degree} piece${set.pieces.length === 1 ? '' : 's'}${plus ? ` at +${plus}` : ''}${seal}.${miss}`,
    { player: p.name, codes: set.pieces.map((x) => x.code), missing: set.missing, sealed: set.sealed, worn: wear },
  )
}

/** The highest degree whose weapons of `weapon` a level-`level` character can wield (at least 1). */
export function degreeForLevel(items: Iterable<ItemDef>, level: number): number {
  let d = 1
  for (const i of items) if (i.category === 'weapon' && i.race !== 'europe' && rarityOf(i.code) === null && i.reqLevel <= level && i.degree > d && i.degree <= DEGREE_MAX) d = i.degree
  return d
}

/** The best HP and MP potions (flat restore) usable at `level`. */
function potionsFor(items: Iterable<ItemDef>, level: number): ItemDef[] {
  const list = [...items].filter((i) => i.category === 'potion' && i.reqLevel <= level && i.maxStack > 1)
  const pick = (k: 'hp' | 'mp') => best(list.filter((i) => (i.use?.[k] ?? 0) > 0 && !(k === 'hp' ? i.use?.mp : i.use?.hp)).map((i) => ({ ...i, reqLevel: i.use?.[k] ?? 0 })))
  return [pick('hp'), pick('mp')].filter((x): x is ItemDef => !!x).map((x) => list.find((i) => i.code === x.code)!)
}

function giveStacks(g: GmCall, p: Player, stacks: { def: ItemDef; n: number }[]): Result<number> {
  const { result, draft } = g.ctx.store.inventoryTx(p.characterId, (d) => {
    for (const s of stacks) {
      const r = addItem(d, s.def, s.n)
      if (!r.ok) return r
    }
    return { ok: true, value: stacks.length }
  })
  if (result.ok) g.ctx.gameplay.afterInventory(p, draft)
  return result
}

// ---- inventory tools ----------------------------------------------------------------------------------------

function itemLine(ctx: GameContext, it: InvItem): string {
  const name = ctx.data.item(it.code)?.name ?? it.code
  return `${name}${it.plus ? ` +${it.plus}` : ''}${it.count > 1 ? ` x${it.count}` : ''}`
}

const CATEGORY_ORDER = ['weapon', 'shield', 'armor', 'accessory', 'wings', 'costume', 'potion', 'pill', 'scroll', 'ammo', 'alchemy', 'etc', 'quest', 'gold']

/** Merges stacks and orders the bag (category, code, +N); empty slots go last. */
export function sortBag(d: InvDraft, get: (code: string) => ItemDef | undefined): Result<number> {
  const items = d.bag.filter((x): x is InvItem => !!x).map((x) => ({ ...x }))
  const merged: InvItem[] = []
  for (const it of items) {
    const def = get(it.code)
    const max = def?.maxStack ?? 1
    if (max > 1) {
      for (const m of merged) {
        if (m.code !== it.code || m.plus !== it.plus || m.durability !== it.durability || m.count >= max) continue
        const move = Math.min(max - m.count, it.count)
        m.count += move
        it.count -= move
        if (it.count === 0) break
      }
    }
    if (it.count > 0) merged.push(it)
  }
  const rank = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(get(c)?.category ?? 'etc')
    return i < 0 ? CATEGORY_ORDER.length : i
  }
  merged.sort((a, b) => rank(a.code) - rank(b.code) || a.code.localeCompare(b.code) || b.plus - a.plus)
  for (let i = 0; i < d.bagSize; i++) {
    const want = merged[i] ?? null
    const have = d.bag[i]
    if (JSON.stringify(want) !== JSON.stringify(have)) d.setBag(i, want)
  }
  return { ok: true, value: merged.length }
}

// ---- the commands -------------------------------------------------------------------------------------------

function announce(ctx: GameContext, text: string, from: string): number {
  let n = 0
  for (const c of ctx.sockets.values()) {
    c.send({ t: 'notice', text, from })
    if (c.player) c.send({ t: 'chat', channel: 'system', text: `[Announcement] ${text}` })
    n++
  }
  return n
}

function zoneOf(ctx: GameContext, p: Player): string {
  const pos = ctx.world.positionAt(p, Date.now())
  return ctx.data.zoneName(pos[0], pos[2], ctx.setup.regionOrigin) ?? `${Math.round(pos[0])}, ${Math.round(pos[2])}`
}

function accountOf(ctx: GameContext, raw: string): { id: number; name: string } | null {
  const name = raw.replace(/^@/, '')
  const online = findOnline(ctx, name)
  if (online) return { id: online.conn.accountId, name: online.player.name }
  const ch = ctx.store.characterByName(name)
  if (ch) return { id: ch.account_id, name: ch.name }
  const acc = ctx.store.accountByName(name)
  return acc ? { id: acc.id, name: acc.username } : null
}

function setRate(ctx: GameContext, exp: number, drop: number): void {
  ctx.config.expRate = exp
  ctx.config.dropRate = drop
}

/** Ends a running boost: the rates go back to what they were. */
export function endBoost(ctx: GameContext, silent = false): boolean {
  const s = state(ctx)
  const b = s.boost
  if (!b) return false
  clearTimeout(b.timer)
  setRate(ctx, b.baseExp, b.baseDrop)
  s.boost = null
  if (!silent) announce(ctx, 'The EXP / drop boost event has ended. Thank you for playing!', 'GM')
  return true
}

export const TOOL_COMMANDS: Record<string, Command> = {
  gearset: {
    usage: GEARSET_USAGE,
    about: 'Give a whole gear set in one go: 6 armour pieces of a type, earring/necklace/2 rings, the weapon (+ shield for sword/blade) of a degree, optionally sealed (star/moon/sun), at +N, worn at once (wear), to yourself or a player.',
    run: (g) => {
      const a = parseGearArgs(g.args)
      if (typeof a === 'string') return fail(a)
      const t = target(g, a.who)
      if (isResult(t)) return t
      return giveSet(g, t.player, { ...a.o, gender: t.player.gender }, a.plus, a.wear)
    },
  },
  starter: {
    usage: 'starter [player]',
    about: "A starter kit by level: the best protector set, accessories and weapon (+ shield) of the player's weapon family for its level, 50 HP and 50 MP potions.",
    run: (g) => {
      if (g.args.length > 1) return fail('Usage: starter [player]')
      const t = target(g, g.args[0])
      if (isResult(t)) return t
      const p = t.player
      const degree = degreeForLevel(g.ctx.data.items.values(), p.level)
      const res = giveSet(g, p, { degree, armor: 'protector', weapon: p.weapon, gender: p.gender, tier: null, accessories: true }, 0, false)
      if (!res.ok) return res
      const pots = potionsFor(g.ctx.data.items.values(), p.level).map((def) => ({ def, n: Math.min(POTION_DEFAULT, def.maxStack) }))
      const r = pots.length ? giveStacks(g, p, pots) : null
      return ok(`${res.message} Starter kit (degree ${degree} for level ${p.level})${r && r.ok ? ` with ${pots.length} potion stacks` : r ? ' (no room for the potions)' : ''}.`, res.data)
    },
  },
  potions: {
    usage: 'potions [player] [n]',
    about: 'Stacks of the best HP and MP potions for the level (n each, default 50).',
    run: (g) => {
      const n = g.args.length >= 2 ? int(g.args[1], 1, MAX_ITEM_COUNT) : POTION_DEFAULT
      if (n === null || g.args.length > 2) return fail(`Usage: potions [player] [1-${MAX_ITEM_COUNT}]`)
      const t = target(g, g.args[0])
      if (isResult(t)) return t
      const pots = potionsFor(g.ctx.data.items.values(), t.player.level)
      if (pots.length === 0) return fail('No potions in the item data.')
      const r = giveStacks(g, t.player, pots.map((def) => ({ def, n })))
      if (!r.ok) return invFail(r, t.player.name)
      return ok(`Gave ${t.player.name} ${n} x ${pots.map((p) => p.name ?? p.code).join(' and ')}.`, { player: t.player.name, codes: pots.map((p) => p.code) })
    },
  },
  give: {
    usage: 'give <player|.> <item code> [n] [+N]',
    about: 'Put n of an item (at +N) into a player\'s bag (ITEM_ETC_GOLD_* adds gold).',
    run: (g) => {
      const [who, codeRaw, ...rest] = g.args
      const code = codeRaw?.trim().toUpperCase()
      if (!who || !code || !CODE_NAME.test(code) || rest.length > 2) return fail('Usage: give <player|.> <item code> [n] [+N]')
      let n = 1
      let plus = 0
      for (const r of rest) {
        if (r.startsWith('+')) {
          const v = int(r.slice(1), 0, PLUS_MAX)
          if (v === null) return fail(`The enhancement is +0 to +${PLUS_MAX}.`)
          plus = v
        } else {
          const v = int(r, 1, MAX_ITEM_COUNT)
          if (v === null) return fail(`The count is 1 to ${MAX_ITEM_COUNT}.`)
          n = v
        }
      }
      const t = target(g, who)
      if (isResult(t)) return t
      const gold = /^ITEM_ETC_GOLD_/.test(code)
      const def = g.ctx.data.item(code)
      if (!def && !gold) return fail(`No item ${code}.`)
      const { result, draft } = g.ctx.store.inventoryTx(t.player.characterId, (d) => (gold ? addGold(d, n) : addItem(d, def!, n, def!.maxStack > 1 ? 0 : plus)))
      if (!result.ok) return invFail(result, t.player.name)
      g.ctx.gameplay.afterInventory(t.player, draft)
      return ok(`Gave ${t.player.name} ${gold ? `${n} gold` : `${n} x ${def!.name ?? code}${plus ? ` +${plus}` : ''}`}.`, { player: t.player.name, code, n })
    },
  },
  inv: {
    usage: 'inv [player]',
    about: "A player's worn items and bag (slot numbers for invdel).",
    run: (g) => {
      const t = target(g, g.args[0])
      if (isResult(t)) return t
      const inv = g.ctx.store.loadInventory(t.player.characterId)
      const worn = Object.entries(inv.equip).map(([slot, it]) => `${slot}: ${itemLine(g.ctx, it!)}`)
      const bag = inv.bag.map((it, i) => (it ? `#${i} ${itemLine(g.ctx, it)}` : null)).filter(Boolean)
      const lines = [`${t.player.name}: ${inv.gold} gold, ${bag.length}/${inv.bagSize} bag slots used`, `Worn: ${worn.join('; ') || 'nothing'}`, ...bag]
      return ok(lines.join('\n'), { player: t.player.name, gold: inv.gold, bagSize: inv.bagSize, bag: inv.bag.map((it, slot) => (it ? { slot, ...it } : null)).filter(Boolean), equip: inv.equip })
    },
  },
  invclear: {
    usage: 'invclear [player] [all]',
    about: 'Delete everything in the bag (all: the worn items too). Cannot be undone.',
    run: (g) => {
      const all = g.args.some((a) => a.toLowerCase() === 'all')
      const rest = g.args.filter((a) => a.toLowerCase() !== 'all')
      if (rest.length > 1) return fail('Usage: invclear [player] [all]')
      const t = target(g, rest[0])
      if (isResult(t)) return t
      const { result, draft } = g.ctx.store.inventoryTx(t.player.characterId, (d) => {
        let n = 0
        for (let i = 0; i < d.bagSize; i++) if (d.bag[i]) (d.setBag(i, null), n++)
        if (all) for (const slot of Object.keys(d.equip) as EquipSlot[]) if (d.equip[slot]) (d.setEquip(slot, null), n++)
        return { ok: true, value: n }
      })
      if (!result.ok) return invFail(result, t.player.name)
      g.ctx.gameplay.afterInventory(t.player, draft)
      return ok(`Cleared ${result.value} item stack${result.value === 1 ? '' : 's'} from ${t.player.name}${all ? ' (bag and worn items)' : "'s bag"}.`, { player: t.player.name, removed: result.value, all })
    },
  },
  invdrop: {
    usage: 'invdrop [player]',
    about: 'Drop every bag item on the ground at the player (items that cannot be dropped stay).',
    run: (g) => {
      if (g.args.length > 1) return fail('Usage: invdrop [player]')
      const t = target(g, g.args[0])
      if (isResult(t)) return t
      const dropped: InvItem[] = []
      const { result, draft } = g.ctx.store.inventoryTx(t.player.characterId, (d) => {
        for (let i = 0; i < d.bagSize; i++) {
          const it = d.bag[i]
          if (!it || g.ctx.data.item(it.code)?.canDrop === false) continue
          dropped.push(it)
          d.setBag(i, null)
        }
        return { ok: true, value: dropped.length }
      })
      if (!result.ok) return invFail(result, t.player.name)
      g.ctx.gameplay.afterInventory(t.player, draft)
      const now = Date.now()
      const at = g.ctx.world.positionAt(t.player, now)
      dropped.forEach((it, k) => {
        const a = (k / Math.max(1, dropped.length)) * Math.PI * 2
        const r = 1 + (k % 3) * 0.6
        g.ctx.gameplay.spawnGroundItem(it.code, it.count, it.plus, [at[0] + Math.sin(a) * r, at[1], at[2] + Math.cos(a) * r], t.player, now, it.durability)
      })
      return ok(`Dropped ${dropped.length} stack${dropped.length === 1 ? '' : 's'} at ${t.player.name}'s feet.`, { player: t.player.name, dropped: dropped.length })
    },
  },
  invdel: {
    usage: 'invdel <player|.> <slot>',
    about: 'Delete one bag slot of a player (see inv for the numbers).',
    run: (g) => {
      const slot = int(g.args[1], 0, 1000)
      if (g.args.length !== 2 || slot === null) return fail('Usage: invdel <player|.> <slot>')
      const t = target(g, g.args[0])
      if (isResult(t)) return t
      let gone: InvItem | null = null
      const { result, draft } = g.ctx.store.inventoryTx(t.player.characterId, (d) => {
        if (!d.inBag(slot) || !d.bag[slot]) return { ok: false, reason: 'invalid_slot' }
        gone = d.bag[slot]
        d.setBag(slot, null)
        return { ok: true, value: 1 }
      })
      if (!result.ok) return fail(`${t.player.name} has nothing in slot ${slot}.`)
      g.ctx.gameplay.afterInventory(t.player, draft)
      return ok(`Deleted ${itemLine(g.ctx, gone!)} from ${t.player.name}'s slot ${slot}.`, { player: t.player.name, slot })
    },
  },
  repair: {
    usage: 'repair [player]',
    about: 'Full durability on every worn and carried item.',
    run: (g) => {
      const t = target(g, g.args[0])
      if (isResult(t)) return t
      const { result, draft } = g.ctx.store.inventoryTx(t.player.characterId, (d) => {
        let n = 0
        for (let i = 0; i < d.bagSize; i++) {
          const it = d.bag[i]
          if (it && it.durability !== null) (d.setBag(i, { ...it, durability: null }), n++)
        }
        for (const slot of Object.keys(d.equip) as EquipSlot[]) {
          const it = d.equip[slot]
          if (it && it.durability !== null) (d.setEquip(slot, { ...it, durability: null }), n++)
        }
        return { ok: true, value: n }
      })
      if (!result.ok) return invFail(result, t.player.name)
      g.ctx.gameplay.afterInventory(t.player, draft)
      return ok(`Repaired ${result.value} item${result.value === 1 ? '' : 's'} of ${t.player.name}.`, { player: t.player.name, repaired: result.value })
    },
  },
  sort: {
    usage: 'sort [player]',
    about: 'Merge stacks and sort the bag by kind.',
    run: (g) => {
      const t = target(g, g.args[0])
      if (isResult(t)) return t
      const { result, draft } = g.ctx.store.inventoryTx(t.player.characterId, (d) => sortBag(d, (c) => g.ctx.data.item(c)))
      if (!result.ok) return invFail(result, t.player.name)
      g.ctx.gameplay.afterInventory(t.player, draft)
      return ok(`Sorted ${t.player.name}'s bag (${result.value} stacks).`, { player: t.player.name })
    },
  },
  gold: {
    usage: 'gold <player|.> <+n | -n | n>',
    about: 'Add (+n), take (-n) or set (n) gold.',
    run: (g) => {
      const raw = g.args[1]
      const v = raw === undefined ? null : int(raw, -MAX_GOLD, MAX_GOLD)
      if (g.args.length !== 2 || v === null) return fail('Usage: gold <player|.> <+n | -n | n>')
      const t = target(g, g.args[0])
      if (isResult(t)) return t
      const relative = /^[-+]/.test(raw!)
      const { result, draft } = g.ctx.store.inventoryTx(t.player.characterId, (d) => {
        const delta = relative ? Math.max(v, -d.gold) : v - d.gold
        return addGold(d, delta)
      })
      if (!result.ok) return invFail(result, t.player.name)
      g.ctx.gameplay.afterInventory(t.player, draft)
      return ok(`${t.player.name} has ${draft.gold} gold.`, { player: t.player.name, gold: draft.gold })
    },
  },
  god: {
    usage: 'god [on|off]',
    about: 'GM invincibility: no damage from monsters, players or hazards (until you leave the world).',
    world: true,
    run: ({ args, self }) => {
      const a = (args[0] ?? '').toLowerCase()
      const on = args.length === 0 ? !self!.godMode : a === 'on' ? true : a === 'off' ? false : null
      if (on === null || args.length > 1) return fail('Usage: god [on|off]')
      self!.godMode = on
      return ok(on ? 'You are invincible.' : 'You can be hurt again.', { god: on })
    },
  },
  killall: {
    usage: `killall [radius 1-${KILLALL_MAX_M}] [all]`,
    about: `Kill every monster around you (no loot or EXP; default ${KILLALL_DEFAULT_M} m). Uniques and quest monsters only with "all".`,
    world: true,
    run: ({ ctx, args, self }) => {
      const all = args.some((a) => a.toLowerCase() === 'all')
      const rest = args.filter((a) => a.toLowerCase() !== 'all')
      const r = rest.length ? int(rest[0], 1, KILLALL_MAX_M) : KILLALL_DEFAULT_M
      if (r === null || rest.length > 1) return fail(`Usage: killall [1-${KILLALL_MAX_M}] [all]`)
      const now = Date.now()
      const me = ctx.world.positionAt(self!, now)
      const doomed = [...ctx.world.mobs.values()].filter((m) => {
        if (m.ai === 'dead' || (!all && (m.variant === 'unique' || m.encounter))) return false
        const p = ctx.world.positionAt(m, now)
        return Math.hypot(p[0] - me[0], p[2] - me[2]) <= r
      })
      for (const m of doomed) ctx.gameplay.gmKill(m, now)
      return ok(`Killed ${doomed.length} monster${doomed.length === 1 ? '' : 's'} within ${r} m.`, { killed: doomed.length })
    },
  },
  respawn: {
    usage: 'respawn',
    about: 'Every nest refills now (pending respawn timers are due at once; unique groups keep their timers).',
    run: ({ ctx }) => {
      const now = Date.now()
      let n = 0
      for (const nest of ctx.gameplay.spawner.nests) {
        if (nest.group || nest.pending.length === 0) continue
        n += nest.pending.length
        nest.pending = nest.pending.map(() => now)
      }
      return ok(`${n} monster${n === 1 ? '' : 's'} respawn on the next tick.`, { respawning: n })
    },
  },
  announce: {
    usage: 'announce <text>',
    about: 'A centre-screen announcement plus a system chat line for everyone.',
    run: ({ ctx, conn, args }) => {
      const text = cleanChat(args.join(' '))
      if (!text) return fail('Usage: announce <text>')
      if (codePointLength(text) > 300) return fail('An announcement is at most 300 characters.')
      const n = announce(ctx, text, conn.player?.name ?? conn.account)
      return ok(`Announced to ${n} connection${n === 1 ? '' : 's'}.`, { recipients: n })
    },
  },
  warn: {
    usage: 'warn <player> <text>',
    about: 'A private warning to one player (on screen and in chat).',
    run: (g) => {
      const text = cleanChat(g.args.slice(1).join(' '))
      if (!g.args[0] || !text) return fail('Usage: warn <player> <text>')
      const t = findOnline(g.ctx, g.args[0])
      if (!t) return fail(`No online player named ${g.args[0]}.`)
      t.conn.send({ t: 'notice', text: `Warning: ${text}`, from: 'Game Master' })
      t.conn.send({ t: 'chat', channel: 'system', text: `[Warning from a Game Master] ${text}` })
      return ok(`Warned ${t.player.name}.`, { player: t.player.name })
    },
  },
  mute: {
    usage: `mute <player> <minutes 1-${MUTE_MAX_MIN}> [reason]`,
    about: 'Silence a player in every chat channel for a while (until then or a server restart).',
    run: (g) => {
      const min = int(g.args[1], 1, MUTE_MAX_MIN)
      if (!g.args[0] || min === null) return fail(`Usage: mute <player> <1-${MUTE_MAX_MIN}> [reason]`)
      const t = findOnline(g.ctx, g.args[0])
      if (!t) return fail(`No online player named ${g.args[0]}.`)
      if (RANK[t.conn.role] >= RANK[g.role] && t.conn !== g.conn) return fail(`${t.player.name} is staff of your rank or above.`)
      const reason = cleanChat(g.args.slice(2).join(' ')).slice(0, 100)
      state(g.ctx).mutes.set(t.conn.accountId, { until: Date.now() + min * 60_000, reason, by: g.conn.account })
      t.conn.send({ t: 'chat', channel: 'system', text: `You are muted for ${min} minute${min === 1 ? '' : 's'}${reason ? `: ${reason}` : '.'}` })
      return ok(`Muted ${t.player.name} for ${min} min${reason ? ` (${reason})` : ''}.`, { player: t.player.name, minutes: min })
    },
  },
  unmute: {
    usage: 'unmute <player>',
    about: 'Lift a mute.',
    run: (g) => {
      const a = g.args[0] ? accountOf(g.ctx, g.args[0]) : null
      if (!a) return fail('Usage: unmute <player>')
      if (!state(g.ctx).mutes.delete(a.id)) return fail(`${a.name} is not muted.`)
      findOnline(g.ctx, a.name)?.conn.send({ t: 'chat', channel: 'system', text: 'You can chat again.' })
      return ok(`Unmuted ${a.name}.`, { player: a.name })
    },
  },
  chatlog: {
    usage: 'chatlog <player>',
    about: `The last ${CHATLOG_KEEP} chat lines of a player (this server run).`,
    run: (g) => {
      const a = g.args[0] ? accountOf(g.ctx, g.args[0]) : null
      if (!a || g.args.length !== 1) return fail('Usage: chatlog <player>')
      const lines = state(g.ctx).chat.get(a.id) ?? []
      const mute = muteOf(g.ctx, a.id)
      const head = `${a.name}: ${lines.length} recent line${lines.length === 1 ? '' : 's'}${mute ? ` (muted ${Math.ceil((mute.until - Date.now()) / 60_000)} more min)` : ''}`
      return ok([head, ...lines.map((l) => `${new Date(l.at).toISOString().slice(11, 19)} [${l.channel}] ${l.text}`)].join('\n'), { player: a.name, lines })
    },
  },
  ban: {
    usage: 'ban <player|account> <reason>',
    about: 'Ban an account (shown at login) and disconnect it. Lift with unban.',
    run: (g) => {
      const reason = cleanChat(g.args.slice(1).join(' ')).slice(0, 200)
      if (!g.args[0] || !reason) return fail('Usage: ban <player|account> <reason>')
      if (!g.ctx.bans) return fail('Bans are not available on this server.')
      const a = accountOf(g.ctx, g.args[0])
      if (!a) return fail(`No player or account named ${g.args[0]}.`)
      if (a.id === g.conn.accountId) return fail('You cannot ban yourself.')
      if (RANK[g.ctx.store.accountRole(a.id)] >= RANK[g.role]) return fail(`${a.name} is staff of your rank or above.`)
      g.ctx.bans.ban(a.id, reason, g.conn.account)
      const conn = g.ctx.sockets.get(a.id)
      if (conn) {
        conn.send({ t: 'chat', channel: 'system', text: `You were banned by a Game Master: ${reason}` })
        conn.close(CLOSE_CODE.kicked, 'banned')
      }
      return ok(`Banned ${a.name} (${reason})${conn ? ' and disconnected them' : ''}.`, { player: a.name, account: a.id })
    },
  },
  unban: {
    usage: 'unban <player|account>',
    about: 'Lift a ban.',
    run: (g) => {
      if (g.args.length !== 1) return fail('Usage: unban <player|account>')
      if (!g.ctx.bans) return fail('Bans are not available on this server.')
      const a = accountOf(g.ctx, g.args[0])
      if (!a) return fail(`No player or account named ${g.args[0]}.`)
      return g.ctx.bans.unban(a.id) ? ok(`Unbanned ${a.name}.`, { player: a.name }) : fail(`${a.name} is not banned.`)
    },
  },
  rewardall: {
    usage: `rewardall <item code | gold> <n 1-${REWARD_MAX}>`,
    about: 'Give every online player n of an item (or n gold), with a notice.',
    run: (g) => {
      const raw = (g.args[0] ?? '').toUpperCase()
      const gold = raw === 'GOLD' || /^ITEM_ETC_GOLD_/.test(raw)
      const n = int(g.args[1], 1, gold ? 100_000_000 : REWARD_MAX)
      if (!raw || n === null || g.args.length !== 2) return fail(`Usage: rewardall <item code | gold> <n>`)
      const def = gold ? undefined : g.ctx.data.item(raw)
      if (!gold && (!def || !CODE_NAME.test(raw))) return fail(`No item ${raw}.`)
      let given = 0
      let full = 0
      for (const c of g.ctx.sockets.values()) {
        const p = c.player
        if (!p) continue
        const { result, draft } = g.ctx.store.inventoryTx(p.characterId, (d) => (gold ? addGold(d, n) : addItem(d, def!, n)))
        if (!result.ok) {
          full++
          continue
        }
        g.ctx.gameplay.afterInventory(p, draft)
        c.send({ t: 'notice', text: `A Game Master gave everyone ${gold ? `${n} gold` : `${n} x ${def!.name ?? raw}`}!`, from: 'GM' })
        given++
      }
      return ok(`Rewarded ${given} player${given === 1 ? '' : 's'}${full ? ` (${full} had no room)` : ''}.`, { given, full })
    },
  },
  boost: {
    usage: `boost <exp|drop|both> <multiplier 1-${BOOST_MAX_MUL}> <minutes 1-${BOOST_MAX_MIN}> | boost off | boost`,
    about: 'A timed EXP and/or drop rate event, announced to everyone; the rates return by themselves.',
    run: ({ ctx, args }) => {
      const s = state(ctx)
      if (args.length === 0) {
        const b = s.boost
        return ok(b ? `Boost running: EXP x${b.exp}, drop x${b.drop}, ${Math.ceil((b.until - Date.now()) / 60_000)} min left.` : `No boost. EXP rate ${ctx.config.expRate ?? 1}, drop rate ${ctx.config.dropRate ?? 1}.`, b ? { exp: b.exp, drop: b.drop, until: b.until } : null)
      }
      if (args[0].toLowerCase() === 'off') return endBoost(ctx) ? ok('Boost ended; the rates are back.') : fail('No boost is running.')
      const kind = args[0].toLowerCase()
      const mul = Number(args[1])
      const min = int(args[2], 1, BOOST_MAX_MIN)
      if (!['exp', 'drop', 'both'].includes(kind) || !Number.isFinite(mul) || mul < 1 || mul > BOOST_MAX_MUL || min === null) return fail(`Usage: boost <exp|drop|both> <1-${BOOST_MAX_MUL}> <1-${BOOST_MAX_MIN}>`)
      const baseExp = s.boost?.baseExp ?? ctx.config.expRate ?? 1
      const baseDrop = s.boost?.baseDrop ?? ctx.config.dropRate ?? 1
      endBoost(ctx, true)
      const exp = kind === 'drop' ? 1 : mul
      const drop = kind === 'exp' ? 1 : mul
      setRate(ctx, baseExp * exp, baseDrop * drop)
      const timer = setTimeout(() => endBoost(ctx), min * 60_000)
      timer.unref?.()
      s.boost = { exp, drop, baseExp, baseDrop, until: Date.now() + min * 60_000, timer }
      const what = kind === 'both' ? `EXP and drop rates x${mul}` : `${kind === 'exp' ? 'EXP' : 'Drop'} rate x${mul}`
      const n = announce(ctx, `Event: ${what} for the next ${min} minutes!`, 'GM')
      return ok(`${what} for ${min} min (announced to ${n}).`, { exp, drop, minutes: min })
    },
  },
  event: {
    usage: 'event hideseek [hint] | event bossrush <mob code> [n 1-20] | event arena [minutes] | event end <text>',
    about: 'Event calls: hide-and-seek (announces your area), a boss rush around you, a PvP arena gathering at you, or an end message.',
    run: (g) => {
      const { ctx, args, self } = g
      const kind = (args[0] ?? '').toLowerCase()
      const from = g.conn.player?.name ?? g.conn.account
      if (kind === 'end') {
        const text = cleanChat(args.slice(1).join(' ')) || 'The event is over. Thanks for joining!'
        return ok(`Announced to ${announce(ctx, text, from)}.`)
      }
      if (!self) return fail('Enter the world first.')
      const zone = zoneOf(ctx, self)
      if (kind === 'hideseek') {
        const hint = cleanChat(args.slice(1).join(' '))
        const n = announce(ctx, `Hide and seek! Game Master ${self.name} is hiding somewhere in ${zone}.${hint ? ` Hint: ${hint}.` : ''} The first to find and click them wins!`, from)
        return ok(`Hide-and-seek announced to ${n} (your area: ${zone}). Tip: give the winner a reward with /give.`)
      }
      if (kind === 'bossrush') {
        const code = (args[1] ?? '').toUpperCase()
        const n = args[2] === undefined ? 5 : int(args[2], 1, 20)
        const def = CODE_NAME.test(code) ? ctx.data.mob(code) : undefined
        if (!def || n === null) return fail('Usage: event bossrush <mob code> [1-20]')
        const ids = ctx.gameplay.gmSpawn(self, def, n)
        const c = announce(ctx, `Boss rush! ${n} x ${def.name ?? code} appeared in ${zone}. Hunt them down!`, from)
        return ok(`Spawned ${ids.length} x ${def.name ?? code}; announced to ${c}.`, { ids })
      }
      if (kind === 'arena') {
        const min = args[1] === undefined ? 5 : int(args[1], 1, 120)
        if (min === null) return fail('Usage: event arena [minutes]')
        const c = announce(ctx, `PvP arena call! Gather at Game Master ${self.name} in ${zone} within ${min} minutes.`, from)
        return ok(`Arena call announced to ${c}.`)
      }
      return fail(`Usage: ${TOOL_COMMANDS.event.usage}`)
    },
  },
}

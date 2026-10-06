import {
  CLOSE_CODE,
  CODE_NAME,
  GM_COMMAND,
  MAX_ITEM_COUNT,
  codePointLength,
  GM_MAX_ARGS,
  isStaff,
  type ClientMessage,
  type GmPlayerInfo,
  type GmPreset,
  type Role,
} from '@sro/shared'
import type { ServerConfig } from './config.ts'
import { cleanChat, type Connection } from './connection.ts'
import { placeName, regionAt } from './content.ts'
import { findNpcs, findPlace, placesText } from './places.ts'
import type { GameContext } from './game.ts'
import { isGoldCode } from './gameplay.ts'
import { describeSetLevel, setLevel as applySetLevel } from './progression.ts'
import { SKILL_USAGE, runSkillCommand } from './skills/gm-skill.ts'
import { PLUS_USAGE } from './alchemy.ts'
import { HWAN_USAGE } from './berserk.ts'
import { DUR_USAGE } from './durability.ts'
import { MOBSKILL_USAGE } from './mob-skills.ts'
import { HORSE_USAGE } from './mounts.ts'
import { GUILDS_USAGE, runGuildsCommand } from './social/gm-guild.ts'
import type { Mob, Player } from './world.ts'
import { CONTENT_USAGE, runContentCommand } from './editors/live.ts'
import { NEST_USAGE, runNestCommand } from './editors/nest-edit.ts'
import { NPC_USAGE, runNpcCommand } from './editors/npc-edit.ts'
import { WEATHER_USAGE } from './weather.ts'
import { WINTER_USAGE } from './winter.ts'
import { GIFT_USAGE } from './winter-play/gifts.ts'
import { SNOWBALL_USAGE } from './winter-play/snowballs.ts'
import { WARMTH_USAGE } from './winter-play/warmth.ts'
import { YETI_USAGE } from './winter-play/yeti.ts'
import { STORM_USAGE } from './storm/service.ts'
import { WALL_USAGE } from './siege/walls.ts'
import { MASON_USAGE } from './siege/repair.ts'
import { LAW_USAGE } from './siege/law.ts'
import { SIEGE_USAGE } from './siege/event.ts'
import { TIME_USAGE } from './world-clock.ts'
import { UNIQUE_USAGE } from './uniques.ts'

/**
 * Game Master commands. Every call is authorized against the account's role as stored in the
 * database right now (so `pnpm gm revoke` takes effect on the very next command) and written to
 * gm_audit, allowed or not. Replies are `gmResult`; non-staff get `error forbidden`.
 */

export interface GmResult {
  ok: boolean
  message: string
  data?: unknown
}

export interface Command {
  usage: string
  about: string
  /** Needs the GM's own character in the world. */
  world?: boolean
  run(g: GmCall): GmResult
}

export interface GmCall {
  ctx: GameContext
  conn: Connection
  role: Role
  args: string[]
  /** The GM's own player (only guaranteed for commands with `world: true`). */
  self: Player | null
}

const RANK: Record<Role, number> = { player: 0, gm: 1, admin: 2 }

export const SPEED_MIN = 0.5
export const SPEED_MAX = 5
export const NOTICE_MAX_LENGTH = 300
/** gmResult.message limit (the client validator accepts up to 8000 characters). */
const RESULT_MAX_LENGTH = 7900
/** A summoned player appears this far in front of the GM (metres). */
const SUMMON_OFFSET_M = 1
/** Most mobs one `spawn` may create. */
export const GM_SPAWN_MAX = 50
/** Most GM-spawned monsters alive at once, server-wide (they never despawn on their own). */
export const GM_SPAWN_TOTAL_MAX = 300

/** A content code typed by a GM: case-insensitive, upper-cased; null when it cannot be a CodeName128. */
function codeArg(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const code = raw.trim().toUpperCase()
  return CODE_NAME.test(code) ? code : null
}

function countArg(raw: string | undefined, max: number): number | null {
  if (raw === undefined) return 1
  const n = parseNumber(raw)
  return n !== null && Number.isInteger(n) && n >= 1 && n <= max ? n : null
}

const ok = (message: string, data?: unknown): GmResult => (data === undefined ? { ok: true, message } : { ok: true, message, data })
const fail = (message: string): GmResult => ({ ok: false, message })

function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1)
}

function parseNumber(s: string | undefined): number | null {
  if (s === undefined || s.trim() === '') return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

/** Online connection of a character (by name, case-insensitive; a leading @ is ignored). */
function findOnline(ctx: GameContext, rawName: string): { conn: Connection; player: Player } | null {
  const name = rawName.replace(/^@/, '').toLowerCase()
  for (const conn of ctx.sockets.values()) {
    if (conn.player && conn.player.name.toLowerCase() === name) return { conn, player: conn.player }
  }
  return null
}

/** GmPlayerInfo plus the client's area name there (zones.json; docs/FIELDS.md §4.6), when known. */
type PlayerInfo = GmPlayerInfo & { zone?: string }

function info(ctx: GameContext, conn: Connection, p: Player): PlayerInfo {
  const pos = ctx.world.positionAt(p, Date.now())
  const r = regionAt(ctx.setup.regionOrigin, pos[0], pos[2])
  const zone = ctx.data.zoneName(pos[0], pos[2], ctx.setup.regionOrigin)
  return {
    id: p.id,
    name: p.name,
    account: conn.account,
    role: conn.role,
    level: p.level,
    pos,
    region: r ? r.id : null,
    regionXZ: r ? [r.rx, r.rz] : null,
    invisible: p.invisible,
    speed: p.speedMul,
    ...(zone ? { zone } : {}),
  }
}

function describe(i: PlayerInfo): string {
  const region = `${i.zone ? ` in ${i.zone},` : ''}${i.regionXZ ? ` region ${i.regionXZ[0]}x${i.regionXZ[1]} (${i.region})` : ''}`
  const flags = [i.role !== 'player' ? i.role.toUpperCase() : '', i.invisible ? 'invisible' : '', i.speed !== 1 ? `speed x${i.speed}` : '']
    .filter(Boolean)
    .join(', ')
  return `${i.name} (Lv ${i.level}, ${i.account}) at ${fmt(i.pos[0])}, ${fmt(i.pos[2])}${region}${flags ? ` [${flags}]` : ''}`
}

function presets(ctx: GameContext): GmPreset[] {
  return ctx.setup.places.map((p) => ({ name: p.name, x: p.x, z: p.z, group: p.group, ...(p.aliases?.length ? { aliases: [...p.aliases] } : {}) }))
}

/** Most NPC names a refused (ambiguous) `tp npc` lists. */
const NPC_LIST_MAX = 12
/** `tp npc` lands this far in front of the NPC (metres), where a player talks to it. */
const NPC_TP_OFFSET_M = 2.5

/** `tp npc <name>`: next to an NPC, by its whole name or code, or a unique part of it (case-insensitive). */
function tpNpc(ctx: GameContext, me: Player, query: string): GmResult {
  const found = findNpcs(ctx.world.npcs.values(), query)
  if (found.length === 0) return fail(`No NPC named like "${query}".`)
  const names = [...new Set(found.map((n) => n.name))]
  if (names.length > 1) {
    const list = names.sort((a, b) => a.localeCompare(b))
    return fail(`"${query}" matches ${list.length} NPCs: ${list.slice(0, NPC_LIST_MAX).join(', ')}${list.length > NPC_LIST_MAX ? ', ...' : ''}. Type more of the name.`)
  }
  const npc = found[0]
  const world = ctx.world
  const [nx, ny, nz] = npc.pos
  // In front of the NPC on its own surface, else wherever open ground is nearest to it.
  const tx = nx + Math.sin(npc.yaw) * NPC_TP_OFFSET_M
  const tz = nz + Math.cos(npc.yaw) * NPC_TP_OFFSET_M
  const at = world.placeFor(tx, tz, ny) ?? world.placeFor(nx, nz, ny)
  const pos = world.warp(me, at?.x ?? tx, at?.y ?? ny, at?.z ?? tz, Date.now(), at)
  ctx.gameplay.warped(me, 'gm')
  return ok(`Teleported next to ${npc.name} (${fmt(pos[0])}, ${fmt(pos[2])}).`, { pos, npc: npc.name })
}

function joined(args: string[]): string {
  return cleanChat(args.join(' '))
}

/**
 * Wave 12 (docs/WORLD_EDITOR.md §2.2, D5, F12; WAVE_PLAN8 D10): the World Editor's tokenless fly-to page. It only asks
 * an open editor tab to fly there (BroadcastChannel); the editor itself runs on the host PC (`pnpm editor`, port 5185).
 */
export const EDITOR_PAGE_URL = 'http://127.0.0.1:5185/editor.html'
/** `/editmap` on any server but this PC's dev server: the editor is never shipped to players (WORLD_EDITOR D32). */
export const EDITMAP_REMOTE = 'The World Editor runs on the host PC.'

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]'])

/**
 * Whether this server is a dev server on the editor's PC: bound to a loopback address, with no proxy in front and no
 * built client served (the live server binds its Tailscale address and serves the build: deploy/remote/install.sh).
 */
export function editorIsLocal(config: Pick<ServerConfig, 'host' | 'trustProxy' | 'serveStatic'>): boolean {
  const host = config.host.trim().toLowerCase()
  const loopback = LOOPBACK_HOSTS.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  return loopback && !config.trustProxy && !config.serveStatic
}

/** The `/editmap` reply: the fly-to link at `pos` (glTF metres; none in the lobby) on a local server, else the host-PC line. */
export function editmapReply(config: Pick<ServerConfig, 'host' | 'trustProxy' | 'serveStatic'>, pos: readonly number[] | null): GmResult {
  if (!editorIsLocal(config)) return ok(EDITMAP_REMOTE, { local: false })
  if (!pos) return ok(`Open the World Editor: ${EDITOR_PAGE_URL}`, { local: true, url: EDITOR_PAGE_URL })
  const url = `${EDITOR_PAGE_URL}?at=${Math.round(pos[0])},${Math.round(pos[2])}`
  return ok(`Open the World Editor at your position: ${url}`, { local: true, url })
}

/** Clips a (multi-line) result message to RESULT_MAX_LENGTH, cutting at a line break. */
function clip(message: string): string {
  if (message.length <= RESULT_MAX_LENGTH) return message
  const cut = message.lastIndexOf('\n', RESULT_MAX_LENGTH - 20)
  return `${message.slice(0, cut > 0 ? cut : RESULT_MAX_LENGTH - 20)}\n... (cut)`
}

export const COMMANDS: Record<string, Command> = {
  help: {
    usage: 'help',
    about: 'List the GM commands.',
    run: () => {
      const commands = Object.entries(COMMANDS).map(([name, c]) => ({ name, usage: c.usage, about: c.about }))
      return ok(['GM commands (also typed in chat as /command):', ...commands.map((c) => `${c.usage} - ${c.about}`)].join('\n'), { commands })
    },
  },
  who: {
    usage: 'who',
    about: 'Online players with their position and region.',
    run: ({ ctx }) => {
      const players: PlayerInfo[] = []
      for (const conn of ctx.sockets.values()) if (conn.player) players.push(info(ctx, conn, conn.player))
      players.sort((a, b) => a.name.localeCompare(b.name))
      const head = `${players.length} player${players.length === 1 ? '' : 's'} online`
      return ok([head, ...players.map(describe)].join('\n'), { players })
    },
  },
  where: {
    usage: 'where [player]',
    about: 'Position and region of a player (yourself without a name).',
    run: ({ ctx, conn, args, self }) => {
      if (args.length === 0) {
        if (!self) return fail('Enter the world first, or name a player.')
        const i = info(ctx, conn, self)
        return ok(describe(i), i)
      }
      const t = findOnline(ctx, args[0])
      if (!t) return fail(`No online player named ${args[0]}.`)
      const i = info(ctx, t.conn, t.player)
      return ok(describe(i), i)
    },
  },
  tp: {
    usage: 'tp <x> <z> | tp <place> | tp <player> | tp npc <name>',
    about: 'Teleport yourself to world coordinates (metres), a named place, a player or next to an NPC (part of its name). "tp" alone lists the places.',
    world: true,
    run: ({ ctx, args, self }) => {
      const me = self!
      const world = ctx.world
      if (args.length === 0) return ok(placesText(ctx.setup.places), { presets: presets(ctx) })
      if (args.length >= 2 && args[0].toLowerCase() === 'npc') return tpNpc(ctx, me, args.slice(1).join(' '))
      if (args.length === 2 || args.length === 3) {
        const nums = args.map(parseNumber)
        if (nums.every((n) => n !== null)) {
          // tp x z (navmesh: the highest open surface there), or tp x y z (the surface nearest y)
          const [x, z] = args.length === 2 ? [nums[0]!, nums[1]!] : [nums[0]!, nums[2]!]
          const hint = args.length === 3 ? nums[1]! : Infinity
          const pos = world.warp(me, x, me.pos[1], z, Date.now(), world.placeFor(x, z, hint))
          ctx.gameplay.warped(me, 'gm')
          const [cx, cz] = world.clamp(x, z)
          const clamped = cx !== x || cz !== z
          return ok(`Teleported to ${fmt(pos[0])}, ${fmt(pos[2])}${clamped ? ' (clamped to the world bounds)' : ''}.`, { pos })
        }
      }
      if (args.length !== 1) return fail('Usage: tp <x> <z> | tp <place> | tp <player> | tp npc <name>')
      const raw = args[0]
      const place = raw.startsWith('@') ? null : placeName(raw)
      const preset = place ? findPlace(ctx.setup.places, place) : undefined
      if (preset) {
        const town = preset.name === ctx.config.world.toLowerCase() || preset.name === 'spawn'
        const at = town ? ctx.gameplay.townPoint() : world.placeFor(preset.x, preset.z, preset.y ?? Infinity)
        const pos = world.warp(me, preset.x, town ? ctx.setup.spawn.y : me.pos[1], preset.z, Date.now(), at)
        ctx.gameplay.warped(me, 'gm')
        return ok(`Teleported to ${preset.name} (${fmt(pos[0])}, ${fmt(pos[2])}).`, { pos, place: preset.name })
      }
      const t = findOnline(ctx, raw)
      if (!t) return fail(`No place or online player named ${raw}. Type /tp for the places, or /tp npc <name>.`)
      if (t.player.id === me.id) return fail('You are already there.')
      // Onto the very surface the player stands on (a bridge, the plaza), not a re-guess from its height.
      const at = world.livePoint(t.player, Date.now())
      const pos = world.warp(me, at.x, at.y, at.z, Date.now(), world.nav.kind === 'mesh' ? at : null)
      ctx.gameplay.warped(me, 'gm')
      return ok(`Teleported to ${t.player.name} (${fmt(pos[0])}, ${fmt(pos[2])}).`, { pos, player: t.player.name })
    },
  },
  summon: {
    usage: 'summon <player>',
    about: 'Bring a player to you.',
    world: true,
    run: ({ ctx, role, args, self }) => {
      const me = self!
      if (args.length !== 1) return fail('Usage: summon <player>')
      const t = findOnline(ctx, args[0])
      if (!t) return fail(`No online player named ${args[0]}.`)
      if (t.player.id === me.id) return fail('You cannot summon yourself.')
      if (RANK[t.conn.role] > RANK[role]) return fail(`${t.player.name} outranks you.`)
      const now = Date.now()
      ctx.world.settle(me, now)
      const here = ctx.world.livePoint(me, now)
      const [x, y, z] = [here.x, here.y, here.z]
      const tx = x + Math.sin(me.yaw) * SUMMON_OFFSET_M
      const tz = z + Math.cos(me.yaw) * SUMMON_OFFSET_M
      // In front of the GM on its own surface: a short straight walk that stops short of a wall.
      const walk = ctx.world.nav.kind === 'mesh' ? ctx.world.nav.walk(here, tx, tz) : null
      const pos = ctx.world.warp(t.player, tx, y, tz, now, walk?.end ?? null)
      ctx.gameplay.warped(t.player, 'gm', now)
      t.conn.send({ t: 'chat', channel: 'system', text: 'You were summoned by a Game Master.' })
      return ok(`Summoned ${t.player.name} to ${fmt(pos[0])}, ${fmt(pos[2])}.`, { pos, player: t.player.name })
    },
  },
  kick: {
    usage: 'kick <player> [reason]',
    about: `Disconnect a player (close code ${CLOSE_CODE.kicked}). The name may be a character or, for someone in the lobby, an account.`,
    run: ({ ctx, conn, role, args }) => {
      if (args.length === 0) return fail('Usage: kick <player> [reason]')
      let target = findOnline(ctx, args[0])?.conn ?? null
      if (!target) {
        const n = args[0].replace(/^@/, '').toLowerCase()
        target = [...ctx.sockets.values()].find((c) => c.account.toLowerCase() === n) ?? null
      }
      if (!target) return fail(`No online player named ${args[0]}.`)
      if (target === conn) return fail('You cannot kick yourself.')
      if (RANK[target.role] > RANK[role]) return fail(`${target.player?.name ?? target.account} outranks you.`)
      const reason = joined(args.slice(1)).slice(0, 100)
      const who = target.player?.name ?? target.account
      target.send({ t: 'chat', channel: 'system', text: `You were disconnected by a Game Master${reason ? `: ${reason}` : '.'}` })
      // WebSocket close reasons are limited to 123 bytes.
      target.close(CLOSE_CODE.kicked, Buffer.from(`kicked${reason ? `: ${reason}` : ''}`).subarray(0, 120).toString('utf8').replace(/�+$/, ''))
      return ok(`Kicked ${who}${reason ? ` (${reason})` : ''}.`, { player: who })
    },
  },
  notice: {
    usage: 'notice <text>',
    about: 'Announce a message to everyone on the server.',
    run: ({ ctx, conn, args }) => {
      const text = joined(args)
      if (!text) return fail('Usage: notice <text>')
      if (codePointLength(text) > NOTICE_MAX_LENGTH) return fail(`A notice is at most ${NOTICE_MAX_LENGTH} characters.`)
      const from = conn.player?.name ?? conn.account
      let n = 0
      for (const c of ctx.sockets.values()) {
        c.send({ t: 'notice', text, from })
        n++
      }
      ctx.config.log(`notice by ${conn.account}: ${text}`)
      return ok(`Notice sent to ${n} connection${n === 1 ? '' : 's'}.`, { recipients: n })
    },
  },
  setlevel: {
    usage: 'setlevel <player> <level>',
    about: 'Set a character level (saved; the player may be offline). Raising grants the stat points and typical SP of those levels; lowering keeps SP.',
    run: ({ ctx, role, args }) => {
      const cap = ctx.config.levelCap
      if (args.length !== 2) return fail(`Usage: setlevel <player> <1-${cap}>`)
      const level = parseNumber(args[1])
      if (level === null || !Number.isInteger(level) || level < 1 || level > cap) return fail(`The level must be a whole number from 1 to ${cap}.`)
      const t = findOnline(ctx, args[0])
      if (t) {
        if (RANK[t.conn.role] > RANK[role]) return fail(`${t.player.name} outranks you.`)
        const change = ctx.gameplay.gmSetLevel(t.player, level)
        return ok(`${t.player.name} is now level ${level} (${describeSetLevel(change)}).`, { player: t.player.name, level, online: true, from: change.from, sp: change.sp, statPoints: change.statPoints })
      }
      const row = ctx.store.characterByName(args[0].replace(/^@/, ''))
      if (!row) return fail(`No character named ${args[0]}.`)
      if (RANK[ctx.store.accountRole(row.account_id)] > RANK[role]) return fail(`${row.name} outranks you.`)
      const progress = { level: row.level, exp: row.exp, sp: row.sp, spExp: row.sp_exp, str: row.strength, int: row.intellect, statPoints: row.stat_points }
      const change = applySetLevel(progress, level, (l) => ctx.gameplay.data.expToNext(l, cap))
      ctx.store.saveProgress(row.id, progress)
      return ok(`${row.name} (offline) is now level ${level} (${describeSetLevel(change)}).`, { player: row.name, level, online: false, from: change.from, sp: change.sp, statPoints: change.statPoints })
    },
  },
  speed: {
    usage: 'speed <multiplier>',
    about: `Your own move speed, ${SPEED_MIN} to ${SPEED_MAX} times normal (until you leave the world).`,
    world: true,
    run: ({ ctx, args, self }) => {
      const me = self!
      if (args.length === 0) return ok(`Your speed is x${me.speedMul} (${fmt(ctx.world.moveSpeed * me.speedMul)} m/s).`, { speed: me.speedMul })
      const mul = parseNumber(args[0])
      if (args.length !== 1 || mul === null || mul < SPEED_MIN || mul > SPEED_MAX) return fail(`Usage: speed <${SPEED_MIN}-${SPEED_MAX}>`)
      ctx.world.setSpeed(me, mul)
      return ok(`Speed set to x${mul} (${fmt(ctx.world.moveSpeed * mul)} m/s).`, { speed: mul })
    },
  },
  invis: {
    usage: 'invis <on|off>',
    about: 'Hide from players (other GMs still see you) until you leave the world.',
    world: true,
    run: ({ ctx, args, self }) => {
      const me = self!
      const a = (args[0] ?? '').toLowerCase()
      const on = args.length === 0 ? !me.invisible : a === 'on' ? true : a === 'off' ? false : null
      if (on === null || args.length > 1) return fail('Usage: invis <on|off>')
      ctx.world.setInvisible(me, on)
      return ok(on ? 'You are invisible to players.' : 'You are visible again.', { invisible: on })
    },
  },
  heal: {
    usage: 'heal [player]',
    about: 'Full HP/MP for yourself or a player; also revives a dead player where it stands.',
    run: ({ ctx, role, args, self }) => {
      let target = self
      if (args.length > 0) {
        const t = findOnline(ctx, args[0])
        if (!t) return fail(`No online player named ${args[0]}.`)
        if (RANK[t.conn.role] > RANK[role]) return fail(`${t.player.name} outranks you.`)
        target = t.player
      }
      if (!target) return fail('Enter the world first, or name a player.')
      const revived = target.dead
      ctx.gameplay.gmHeal(target)
      return ok(`${target.name} is fully healed${revived ? ' and alive again' : ''}.`, { id: target.id })
    },
  },
  spawn: {
    usage: 'spawn <mob code> [n]',
    about: `Spawn n (1-${GM_SPAWN_MAX}) monsters around you. They belong to no nest and do not respawn.`,
    world: true,
    run: ({ ctx, args, self }) => {
      const code = codeArg(args[0])
      const n = countArg(args[1], GM_SPAWN_MAX)
      if (!code || n === null || args.length > 2) return fail(`Usage: spawn <mob code> [1-${GM_SPAWN_MAX}]`)
      const def = ctx.data.mob(code)
      if (!def) return fail(`No monster ${code}.`)
      let alive = 0
      for (const m of ctx.world.mobs.values()) if (m.nest === null && !m.encounter && m.ai !== 'dead') alive++
      if (alive + n > GM_SPAWN_TOTAL_MAX) return fail(`At most ${GM_SPAWN_TOTAL_MAX} GM-spawned monsters may be alive at once (${alive} now).`)
      const ids = ctx.gameplay.gmSpawn(self!, def, n)
      return ok(`Spawned ${n} x ${def.name ?? code}.`, { ids })
    },
  },
  item: {
    usage: 'item <item code> [n]',
    about: 'Put n of an item into your bag (ITEM_ETC_GOLD_* adds n gold).',
    world: true,
    run: ({ ctx, args, self }) => {
      const code = codeArg(args[0])
      const n = countArg(args[1], MAX_ITEM_COUNT)
      if (!code || n === null || args.length > 2) return fail(`Usage: item <item code> [1-${MAX_ITEM_COUNT}]`)
      const def = ctx.data.item(code) ?? null
      if (!def && !isGoldCode(code)) return fail(`No item ${code}.`)
      const r = ctx.gameplay.gmItem(self!, def, code, n)
      if (!r.ok) return fail(r.reason === 'inventory_full' ? 'Your bag is full.' : `Cannot add ${code}: ${r.reason}.`)
      return ok(isGoldCode(code) ? `Added ${n} gold.` : `Added ${n} x ${def!.name ?? code}.`, r.value)
    },
  },
  skill: {
    usage: SKILL_USAGE,
    about: 'Masteries, skills and SP for your own character (all / one skill / sp / cooldown / reset).',
    world: true,
    run: ({ ctx, args, self }) => runSkillCommand(ctx.gameplay.skills, self!, args, ctx.config.levelCap),
  },
  // Wave 8 (docs/WAVE_PLAN2.md §3.6, D42): bodies in the modules. None equals a client chat prefix (the client claims
  // /stall, /guild, /g, /trade, ... before the GM path), so each can be typed.
  horse: { usage: HORSE_USAGE, about: 'Summon a horse without an item (level and lockout ignored), or dismiss it.', world: true, run: ({ ctx, args, self }) => ctx.gameplay.mounts.gm(self!, args) },
  hwan: { usage: HWAN_USAGE, about: 'Set your Berserk points (5 = a full gauge).', world: true, run: ({ ctx, args, self }) => ctx.gameplay.berserk.gm(self!, args) },
  dur: { usage: DUR_USAGE, about: 'Set the durability of your worn items (0 = broken).', world: true, run: ({ ctx, args, self }) => ctx.gameplay.durability.gm(self!, args) },
  plus: { usage: PLUS_USAGE, about: 'Set the enhancement (+N) of an item of yours.', world: true, run: ({ ctx, args, self }) => ctx.gameplay.alchemy.gm(self!, args) },
  mobskill: { usage: MOBSKILL_USAGE, about: 'Make a monster use one of its skills now.', world: true, run: ({ ctx, args, self }) => ctx.gameplay.mobSkills.gm(self!, args) },
  guilds: { usage: GUILDS_USAGE, about: 'Guilds: list, info, rename, disband one, or expel a member.', run: runGuildsCommand },
  // GM content editors (docs/QUESTS.md §5.2, §5.3; lane ED-S): saved to DATA_DIR/content, applied live.
  nest: { usage: NEST_USAGE, about: 'Spawn editor: list, add, move, change or remove monster nests at your position (saved; undo).', run: runNestCommand },
  npc: { usage: NPC_USAGE, about: 'NPC editor: list, add, move, turn, rename, shop or remove NPCs at your position (saved; undo).', run: runNpcCommand },
  content: { usage: CONTENT_USAGE, about: 'The GM content overrides: status, or reload them from disk.', run: runContentCommand },
  // Wave 9 (docs/WAVE_PLAN3.md §3.5): the world clock and the weather; bodies in world-clock.ts and weather.ts.
  time: {
    usage: TIME_USAGE,
    about: 'The world clock: show it, set the time of day, the day, the day length, freeze/resume, night speed-up, season, or reset.',
    run: ({ ctx, args }) => {
      const r = ctx.gameplay.clock.gm(args, Date.now())
      if (r.changed) sendClock(ctx)
      return r.ok ? ok(r.message, r.data) : fail(r.message)
    },
  },
  weather: {
    usage: WEATHER_USAGE,
    about: 'The weather: show it, hold a state, back to auto, wind, surface wetness, or a lightning strike (near you, on a spot, a player, a tree or a wall).',
    run: ({ ctx, args, self }) => ctx.gameplay.weather.gm(args, Date.now(), self),
  },
  // docs/WINTER.md §6: the snow season; body in winter.ts. A snowfall itself is `weather snow` / `weather blizzard`.
  winter: {
    usage: WINTER_USAGE,
    about: 'The snow season: show it (dates, snow cover, frost), preview the full season look for everyone without changing the season, or set the snow cover or the frost now. Snowfall: weather snow / weather blizzard.',
    run: ({ ctx, args }) => ctx.gameplay.winter.gm(args, Date.now()),
  },
  // docs/WINTER.md §13.6: the winter gameplay layer; bodies in winter-play/*.ts. They work any time (a GM can try them
  // outside the season); what they set only acts while the layer is on (the season, or `winter preview on`).
  wintergame: {
    usage: 'wintergame',
    about: 'Winter gameplay: is the layer on (season or preview), can snowballs be thrown, snow spirits, the Ice Yeti, fires, the scoreboard season.',
    run: ({ ctx }) => ctx.gameplay.winterPlay.gmStatus(Date.now()),
  },
  yeti: {
    usage: YETI_USAGE,
    about: 'The Ice Yeti (winter world boss): status, spawn at a lair or in front of you (announced), kill or despawn (silent), set the timer, or make her use a move (slam, breath, barrage, roar).',
    run: ({ ctx, args, self }) => ctx.gameplay.winterPlay.yeti.gm(self, args, Date.now()),
  },
  gift: {
    usage: GIFT_USAGE,
    about: 'Give Holiday Gift Boxes (1-50) to yourself or a player; right-click opens one.',
    run: ({ ctx, args, self }) => ctx.gameplay.winterPlay.gifts.gm(self, args),
  },
  warmth: {
    usage: WARMTH_USAGE,
    about: "Show or set a player's body warmth (0-100; 0 = freezing).",
    run: ({ ctx, args, self }) => ctx.gameplay.winterPlay.warmth.gm(self, args, Date.now()),
  },
  snowball: {
    usage: SNOWBALL_USAGE,
    about: 'Snowballs: status; a test that lets everyone throw for a while (season and snow or not); stats of a player; clear the scoreboard.',
    run: ({ ctx, args, self }) => ctx.gameplay.winterPlay.snowballs.gm(self, args, Date.now()),
  },
  // docs/WEATHER.md §12.5: storm events and their effects; body in storm/service.ts.
  storm: {
    usage: STORM_USAGE,
    about: 'Storms: show the storm status and effects, start one now (or with a forecast), stop it, preview a full storm effects, charge a monster, or call / stop a lightning tornado.',
    run: ({ ctx, args, self }) => ctx.gameplay.storm.gm(args, Date.now(), self),
  },
  // Siege of Jangan (docs/SIEGE.md §12): the destructible walls; body in siege/walls.ts.
  wall: {
    usage: WALL_USAGE,
    about: "Jangan's walls: status of the 33 segments (or one, with its log), set one's integrity (% or a stage), damage it, breach it, repair one or all, reset them all.",
    run: ({ ctx, args }) => ctx.gameplay.walls.gm(args, Date.now()),
  },
  // Siege of Jangan layer 4 (docs/SIEGE.md §6, §12): the siege event; body in siege/event.ts.
  siege: {
    usage: SIEGE_USAGE,
    about: 'The Siege of Jangan: status, start one now (warning minutes), stop it (no rewards), send a wave now, bring out the Bandit Warlord, show the lanes.',
    run: ({ ctx, args, self }) => ctx.gameplay.siege.gm(self, args, Date.now()),
  },
  // Siege of Jangan layer 5 (docs/SIEGE.md §8, §12): warrants, the offence record, Thunder Kegs; body in siege/law.ts.
  law: {
    usage: LAW_USAGE,
    about: "The law: open warrants and recent keg hits, a character's offence record, issue or close a warrant, make one lapse (online minutes left), pardon, forgive offences, capture (pays the bounty), clear the keg cooldown, burning kegs.",
    run: ({ ctx, args, self }) => ctx.gameplay.law.gm(self, args, Date.now()),
  },
  // Siege of Jangan layer 3 (docs/SIEGE.md §2.4, §2.5): repair queues, builders, looters; body in siege/repair.ts.
  mason: {
    usage: MASON_USAGE,
    about: "Wall repair: queued donations and who is repairing, queue free work on a segment (or where needed), clear queues, run the builders now, the looters at the gaps (spawn now or clear).",
    run: ({ ctx, args }) => ctx.gameplay.wallRepair.gm(args, Date.now()),
  },
  // Wave 11 (docs/UNIQUES.md §3.9; lane U-S): the world bosses; body in uniques.ts.
  unique: {
    usage: UNIQUE_USAGE,
    about: 'Unique monsters (world bosses): list, spawn (announced), kill or despawn (silent), set the timer, or hide their notices from you.',
    run: ({ ctx, args, self }) => (ctx.gameplay.uniques ? ctx.gameplay.uniques.gm(self, args) : fail('Uniques are off on this server (UNIQUES=off).')),
  },
  // Wave 12 (docs/WORLD_EDITOR.md §2.2, D5; WAVE_PLAN8 D10, lane W12-G): a link to the local editor, not an editor mode.
  editmap: {
    usage: 'editmap',
    about: 'A link that flies the open World Editor to your position (on the host PC only).',
    run: ({ ctx, self }) => editmapReply(ctx.config, self ? ctx.world.positionAt(self, Date.now()) : null),
  },
  kill: {
    usage: 'kill [entity id]',
    about: 'Kill a monster (no loot or EXP) or a player you outrank; default: your attack target.',
    world: true,
    run: ({ ctx, role, args, self }) => {
      const me = self!
      let id: number | null = null
      if (args.length === 0) id = me.action?.kind === 'attack' ? me.action.target : null
      else {
        const n = parseNumber(args[0])
        if (n !== null && Number.isInteger(n) && n >= 0) id = n
        else {
          const t = findOnline(ctx, args[0])
          if (t) id = t.player.id
        }
      }
      if (id === null || args.length > 1) return fail('Usage: kill [entity id] (default: your attack target)')
      const e = ctx.world.entity(id)
      if (!e || (e.kind !== 'mob' && e.kind !== 'player')) return fail(`No monster or player with id ${id}.`)
      if (e.kind === 'player') {
        const conn = [...ctx.sockets.values()].find((c) => c.player === e)
        if (conn && RANK[conn.role] > RANK[role]) return fail(`${e.name} outranks you.`)
        if (e.dead) return fail(`${e.name} is already dead.`)
      } else if ((e as Mob).ai === 'dead') return fail(`${e.name} is already dead.`)
      ctx.gameplay.gmKill(e as Mob | Player)
      return ok(`Killed ${e.name}.`, { id })
    },
  },
}

/** `worldClock` to every socket with a player in the world (lobby sockets have no clock to update; docs/SKY.md §2.2). */
function sendClock(ctx: GameContext): void {
  const clock = ctx.gameplay.clock.state
  for (const c of ctx.sockets.values()) if (c.player) c.send({ t: 'worldClock', clock })
}

/** Splits a chat line "/cmd a b c" into cmd + args (at most GM_MAX_ARGS; the last one keeps the rest). */
export function parseSlash(text: string): { cmd: string; args: string[] } {
  const tokens = text.replace(/^\//, '').trim().split(/\s+/).filter(Boolean)
  const cmd = (tokens.shift() ?? '').toLowerCase()
  const args = tokens.length > GM_MAX_ARGS ? [...tokens.slice(0, GM_MAX_ARGS - 1), tokens.slice(GM_MAX_ARGS - 1).join(' ')] : tokens
  return { cmd, args }
}

/**
 * Runs one GM command for `conn` (from a `gm` message or a chat slash line, `re`), replies and audits.
 * The role is re-read from the database first. Returns false when the account is not staff (the
 * caller counts a `gm` frame from a player as abuse: the game client never sends one).
 */
export function runGm(ctx: GameContext, conn: Connection, cmd: string, args: string[], re: ClientMessage['t']): boolean {
  const role = ctx.store.accountRole(conn.accountId)
  if (role !== conn.role) conn.applyRole(role)
  const audit = (result: string, success: boolean) =>
    ctx.store.audit({ accountId: conn.accountId, characterId: conn.player?.characterId ?? null, command: cmd.slice(0, 32), args, result, ok: success })

  if (!isStaff(role)) {
    audit('denied: not a Game Master', false)
    conn.error('forbidden', re === 'chat' ? 'Unknown command. Slash commands are for Game Masters.' : 'Game Master commands only.', re)
    return false
  }
  const command = GM_COMMAND.test(cmd) && Object.prototype.hasOwnProperty.call(COMMANDS, cmd) ? COMMANDS[cmd] : null
  let result: GmResult
  if (!command) result = fail(`Unknown command "${cmd.slice(0, 32)}". Type /help for the list.`)
  else if (command.world && !conn.player) result = fail(`${cmd} needs your character in the world.`)
  else {
    try {
      result = command.run({ ctx, conn, role, args, self: conn.player })
    } catch (e) {
      ctx.config.log(`gm ${cmd} by ${conn.account} failed: ${(e as Error).stack ?? e}`)
      result = fail('internal error')
    }
  }
  audit(result.message, result.ok)
  if (result.ok) ctx.config.log(`gm ${conn.account}: ${cleanChat(`${cmd} ${args.join(' ')}`)} -> ${result.message.split('\n')[0]}`)
  const reply = { t: 'gmResult' as const, ok: result.ok, cmd: cmd.slice(0, 32), message: clip(result.message) }
  conn.send(result.data === undefined ? reply : { ...reply, data: result.data })
  return true
}

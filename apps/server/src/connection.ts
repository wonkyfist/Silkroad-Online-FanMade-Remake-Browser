import {
  CHARACTER_NAME,
  CLIENT_RATE_LIMITS,
  CLOSE_CODE,
  GAMEPLAY_REQUESTS,
  MAX_CHARACTER_SLOTS,
  PROTOCOL_VERSION,
  isStaff,
  parseClientMessage,
  type CharacterSummary,
  type ClientMessage,
  type ErrorCode,
  type GameplayRequest,
  type Role,
  type ServerMessage,
  lookBodyOf,
  type CharLook,
} from '@sro/shared'
import type { WebSocket } from 'ws'
import { TokenBucket, hashToken } from './auth.ts'
import { routeChat } from './chat.ts'
import { knob } from './config.ts'
import type { Appearance, CharacterRow } from './db.ts'
import type { GameContext } from './game.ts'
import { parseSlash, runGm } from './gm.ts'
import { VISIBLE_SLOTS } from './inventory.ts'
import type { NavPoint } from './nav.ts'
import { WARP_SEARCH_M, visibleEquipPlus, type Player } from './world.ts'

/** Per-connection message budget. */
const MSG_RATE = 20
const MSG_BURST = 40
/** Chat budget: 1 line/s sustained, bursts of 5. */
const CHAT_RATE = 1
const CHAT_BURST = 5
/** GM command budget (gm frames and slash lines, staff or not): 5/s sustained, bursts of 20. */
const GM_RATE = 5
const GM_BURST = 20
/** Close after this many strikes (malformed frames, message floods, refused gm frames) ... */
const MAX_STRIKES = 20
/**
 * ... where one strike is forgiven every this many ms, so only sustained abuse closes the socket, not the odd bad
 * frame spread over a long evening.
 */
const STRIKE_FORGIVE_MS = 3000
/** Stop sending to a client that has this much unsent data (it is not reading). */
const MAX_BUFFERED = 1 << 20
/** worldEnter.world.levelCap bound of the client parser (validate.ts worldInfo: 1..300); LEVEL_CAP may be higher. */
const MAX_WIRE_LEVEL_CAP = 300

const RESERVED_NAMES = new Set([
  'admin', 'administrator', 'gm', 'gamemaster', 'system', 'server', 'moderator', 'mod', 'support', 'staff', 'joymax', 'root',
  'null', 'undefined', 'nobody', 'everyone',
])
/** Staff-looking prefixes (GM_Bob, Admin01, System_x). Names are ASCII-only, so no homoglyph tricks. */
const RESERVED_PREFIX = /^(gm|admin|administrator|gamemaster|moderator|mod|staff|system|sys|server)(_|\d)/i

const GAMEPLAY_SET = new Set<string>(GAMEPLAY_REQUESTS)

function isGameplay(msg: ClientMessage): msg is Extract<ClientMessage, { t: GameplayRequest }> {
  return GAMEPLAY_SET.has(msg.t)
}

export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name.toLowerCase()) || RESERVED_PREFIX.test(name)
}

/** Control characters (C0, DEL, C1) and bidi overrides/isolates, which can spoof chat lines. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g

export function cleanChat(text: string): string {
  return text.replace(CONTROL_CHARS, '').trim()
}

type State = 'hello' | 'lobby' | 'world' | 'closed'

export class Connection {
  state: State = 'hello'
  accountId = 0
  account = ''
  /** sha256 of the session token this socket authenticated with (logout closes it). */
  tokenHash = ''
  /** Last known role; GM commands re-read it from the database, and a poll picks up CLI changes. */
  role: Role = 'player'
  player: Player | null = null
  private strikes = 0
  /** When the last strike was forgiven (or the count was last empty). */
  private strikeClock = Date.now()
  private readonly bucket = new TokenBucket(MSG_RATE, MSG_BURST)
  private readonly chatBucket = new TokenBucket(CHAT_RATE, CHAT_BURST)
  private readonly gmBucket = new TokenBucket(GM_RATE, GM_BURST)
  /** Per-type budgets of gameplay requests (CLIENT_RATE_LIMITS). */
  private readonly actionBuckets = new Map<ClientMessage['t'], TokenBucket>()
  private helloTimer: NodeJS.Timeout | null

  constructor(
    private readonly ws: WebSocket,
    readonly game: GameContext,
    readonly ip: string,
  ) {
    this.helloTimer = setTimeout(() => {
      if (this.state === 'hello') this.close(CLOSE_CODE.helloTimeout, 'hello timeout')
    }, game.config.helloTimeoutMs)
    ws.on('message', (data, isBinary) => this.onFrame(data, isBinary))
    ws.on('close', () => this.dispose())
    ws.on('error', () => this.dispose())
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      this.close(CLOSE_CODE.abuse, 'not reading')
      return
    }
    this.ws.send(JSON.stringify(msg))
  }

  error(code: ErrorCode, message: string, re?: ClientMessage['t']): void {
    this.send(re ? { t: 'error', code, message, re } : { t: 'error', code, message })
  }

  /** Sends an error, then closes. Cleanup runs synchronously so a replacement login sees a clean slate. */
  close(code: number, reason: string): void {
    if (this.state === 'closed') return
    this.dispose()
    try {
      this.ws.close(code, reason)
    } catch {
      this.ws.terminate()
    }
  }

  /** Leaves the world (saving) and unregisters. Idempotent. */
  dispose(): void {
    if (this.state === 'closed') return
    if (this.helloTimer) clearTimeout(this.helloTimer)
    this.helloTimer = null
    this.leaveWorld(false)
    this.state = 'closed'
    if (this.accountId && this.game.sockets.get(this.accountId) === this) this.game.sockets.delete(this.accountId)
  }

  private strike(now = Date.now()): void {
    const forgiven = Math.floor((now - this.strikeClock) / STRIKE_FORGIVE_MS)
    if (forgiven > 0) {
      this.strikes = Math.max(0, this.strikes - forgiven)
      this.strikeClock += forgiven * STRIKE_FORGIVE_MS
    }
    if (this.strikes === 0) this.strikeClock = now
    if (++this.strikes >= MAX_STRIKES) this.close(CLOSE_CODE.abuse, 'too many bad frames')
  }

  /** Takes one token from this connection's chat budget (chat.ts routes pay it too). false = chatting too fast. */
  takeChat(): boolean {
    return this.chatBucket.take()
  }

  private onFrame(data: unknown, isBinary: boolean): void {
    if (this.state === 'closed') return
    if (!this.bucket.take()) {
      this.error('rate_limited', 'too many messages')
      this.strike()
      return
    }
    if (isBinary) {
      this.error('bad_request', 'binary frames are not supported')
      this.strike()
      return
    }
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')
    const parsed = parseClientMessage(text)
    if (!parsed.ok) {
      this.error('bad_request', parsed.error)
      this.strike()
      return
    }
    try {
      this.handle(parsed.msg)
    } catch (e) {
      this.game.config.log(`error handling ${parsed.msg.t} for ${this.account || this.ip}: ${(e as Error).stack ?? e}`)
      this.error('server_error', 'internal error', parsed.msg.t)
    }
  }

  private handle(msg: ClientMessage): void {
    if (this.state === 'hello') {
      if (msg.t !== 'hello') {
        this.error('unauthorized', 'hello first', msg.t)
        this.close(CLOSE_CODE.unauthorized, 'hello first')
        return
      }
      this.hello(msg.version, msg.token)
      return
    }
    switch (msg.t) {
      case 'hello':
        this.error('bad_request', 'already authenticated', msg.t)
        this.strike()
        return
      case 'ping':
        this.send({ t: 'pong', n: msg.n, clientTime: msg.clientTime, serverTime: Date.now() })
        return
      case 'charList':
        this.send({ t: 'charList', slots: MAX_CHARACTER_SLOTS, characters: this.game.store.characters(this.accountId).map((r) => this.summary(r)) })
        return
      case 'nameCheck': {
        const reason = this.nameProblem(msg.name)
        this.send(reason ? { t: 'nameCheck', name: msg.name, available: false, reason } : { t: 'nameCheck', name: msg.name, available: true })
        return
      }
      case 'charCreate':
        if (this.state !== 'lobby') return this.error('already_in_world', 'leave the world first', msg.t)
        return this.charCreate(msg.name, msg.model, msg.weapon, { height: msg.height ?? msg.look?.height, volume: msg.volume, outfit: msg.outfit, look: msg.look })
      case 'charLook':
        if (this.state !== 'lobby') return this.error('already_in_world', 'leave the world first', msg.t)
        return this.charLook(msg.id, msg.look)
      case 'charDelete':
        if (this.state !== 'lobby') return this.error('already_in_world', 'leave the world first', msg.t)
        if (!this.game.store.softDeleteCharacter(msg.id, this.accountId)) return this.error('not_found', 'no such character', msg.t)
        this.send({ t: 'charDeleted', id: msg.id })
        return
      case 'enterWorld':
        if (this.state !== 'lobby') return this.error('already_in_world', 'already in the world', msg.t)
        return this.enterWorld(msg.id)
      case 'moveTo':
        if (!this.player) return this.error('not_in_world', 'not in the world', msg.t)
        // Play the Boss (docs/PLAY_THE_BOSS.md §3.2): the pilot's moveTo steers the boss instead.
        if (this.game.gameplay.pilot?.steer(this.player, msg.x, msg.z)) return
        // Dead characters stay put (only respawn brings them back); a move cancels auto-attack/pickup.
        if (this.game.gameplay.onMoveTo(this.player)) {
          // Siege of Jangan layer 6 (docs/SIEGE.md §8.5): a prisoner's target is clamped inside the Garrison Stockade.
          const [x, z] = this.game.gameplay.jail.clampMove(this.player, msg.x, msg.z)
          this.game.world.moveTo(this.player, x, z)
        }
        return
      case 'chat': {
        if (!this.player) return this.error('not_in_world', 'not in the world', msg.t)
        const text = cleanChat(msg.text)
        if (!text) return this.error('bad_request', 'empty chat message', msg.t)
        // Play the Boss (§3.10): no free chat on any channel while you steer the boss (slash commands still run).
        if (!text.startsWith('/') && this.game.gameplay.pilot?.chatBlocked(this.player)) return this.error('forbidden', 'You cannot chat while you are the boss. Use the taunt wheel (hold Q).', msg.t)
        // Whisper / party lines (chat.ts) are routed before the slash branch: they are never commands.
        if (routeChat(this, msg, text)) return
        if (text.startsWith('/')) {
          // Slash lines are commands, never broadcast. Non-staff still pay the chat budget.
          if (!isStaff(this.role) && !this.chatBucket.take()) return this.error('rate_limited', 'you are chatting too fast', msg.t)
          if (!this.gmBucket.take()) return this.error('rate_limited', 'too many commands, slow down', msg.t)
          const { cmd, args } = parseSlash(text)
          runGm(this.game, this, cmd, args, 'chat')
          return
        }
        if (!this.chatBucket.take()) return this.error('rate_limited', 'you are chatting too fast', msg.t)
        this.game.world.broadcast({ t: 'chat', channel: 'local', fromId: this.player.id, from: this.player.name, text })
        return
      }
      case 'leaveWorld':
        if (!this.player) return this.error('not_in_world', 'not in the world', msg.t)
        this.leaveWorld(true)
        return
      case 'gm':
        if (!this.gmBucket.take()) {
          this.error('rate_limited', 'too many commands, slow down', msg.t)
          this.strike()
          return
        }
        // The game client never sends `gm` for a player: a refused frame counts as a strike.
        if (!runGm(this.game, this, msg.cmd, msg.args, msg.t)) this.strike()
        return
      default:
        if (isGameplay(msg)) return this.gameplay(msg)
    }
  }

  /** attack .. shopSell, respawn, useSkill: per-type budget, then the rules (gameplay.ts). One actionResult each. */
  private gameplay(msg: Extract<ClientMessage, { t: GameplayRequest }>): void {
    if (!this.player) return this.error('not_in_world', 'not in the world', msg.t)
    const limit = CLIENT_RATE_LIMITS[msg.t]
    if (limit) {
      let bucket = this.actionBuckets.get(msg.t)
      if (!bucket) this.actionBuckets.set(msg.t, (bucket = new TokenBucket(limit.perSecond, limit.burst)))
      if (!bucket.take()) {
        // A well-formed request over its own budget (a player mashing a key) is only refused, never a strike: the
        // global message budget above still strikes a real flood.
        this.send({ t: 'actionResult', re: msg.t, ok: false, reason: 'rate_limited' })
        return
      }
    }
    this.game.gameplay.request(this.player, msg)
  }

  private hello(version: number, token: string): void {
    if (version !== PROTOCOL_VERSION) {
      this.error('version_mismatch', `server speaks protocol v${PROTOCOL_VERSION}`, 'hello')
      this.close(CLOSE_CODE.versionMismatch, 'version mismatch')
      return
    }
    const tokenHash = hashToken(token)
    const account = this.game.store.sessionAccount(tokenHash)
    if (!account) {
      this.error('unauthorized', 'invalid or expired session', 'hello')
      this.close(CLOSE_CODE.unauthorized, 'unauthorized')
      return
    }
    const previous = this.game.sockets.get(account.id)
    if (previous && previous !== this) {
      previous.error('unauthorized', 'logged in from another connection')
      previous.close(CLOSE_CODE.replaced, 'replaced by a new login')
    }
    if (this.helloTimer) clearTimeout(this.helloTimer)
    this.helloTimer = null
    this.accountId = account.id
    this.account = account.username
    this.tokenHash = tokenHash
    this.role = account.role
    this.state = 'lobby'
    this.game.sockets.set(account.id, this)
    // "What's new" (docs/CHANGELOG_WINDOW.md): how many entries this account has not seen; the client shows them in the world.
    const news = this.game.news?.unseenFor(this.game.store, account.id).length ?? 0
    this.send({ t: 'welcome', account: account.username, server: this.game.serverInfo(), slots: MAX_CHARACTER_SLOTS, role: this.role, ...(news > 0 ? { news } : {}) })
  }

  /**
   * Applies a role change while connected: tells the client (`role`), updates what the player can
   * see, and drops GM-only runtime state (invisibility, speed) when the account is no longer staff.
   */
  applyRole(role: Role): void {
    if (role === this.role) return
    this.game.config.log(`${this.account} role ${this.role} -> ${role}`)
    this.role = role
    this.send({ t: 'role', role })
    const p = this.player
    if (!p) return
    const staff = isStaff(role)
    this.game.world.setStaff(p, staff)
    if (!staff) {
      this.game.world.setInvisible(p, false)
      if (p.speedMul !== 1) this.game.world.setSpeed(p, 1)
    }
  }

  private nameProblem(name: string): string | null {
    if (!CHARACTER_NAME.test(name)) return 'Names are 3-12 letters, digits or _, starting with a letter.'
    if (isReservedName(name)) return 'That name is reserved.'
    if (this.game.store.nameInUse(name)) return 'That name is taken.'
    return null
  }

  private charCreate(name: string, model: string, weapon: CharacterRow['weapon'], look: Partial<Appearance>): void {
    if (!CHARACTER_NAME.test(name) || isReservedName(name)) {
      this.error('name_invalid', this.nameProblem(name) ?? 'invalid name', 'charCreate')
      return
    }
    if (!this.game.models.allowed(model)) {
      this.error('bad_request', `model ${model} is not a playable character`, 'charCreate')
      return
    }
    // parseClientMessage already bounded height/volume (0..4) and outfit (STARTER_OUTFITS); absent = the defaults.
    // The look (look.ts) was parsed there too; its body must be the model's (a girl's look on a boy is refused).
    if (look.look && look.look.body !== lookBodyOf(model)) {
      this.error('bad_request', `look.body ${look.look.body} does not match ${model}`, 'charCreate')
      return
    }
    const r = this.game.store.createCharacter(this.accountId, name, model, weapon, this.game.config.world, MAX_CHARACTER_SLOTS, look)
    if (r === 'slots_full') return this.error('slots_full', `at most ${MAX_CHARACTER_SLOTS} characters`, 'charCreate')
    if (r === 'name_taken') return this.error('name_taken', 'That name is taken.', 'charCreate')
    this.game.gameplay.grantStarterKit(r.id, r.weapon, r.model, r.outfit)
    this.game.config.log(`character ${r.name} (${r.model}, height ${r.height}, volume ${r.volume}, ${r.outfit}) created by ${this.account}`)
    this.send({ t: 'charCreated', character: this.summary(r) })
  }

  /**
   * The creator's one-time re-customise (docs/CHARACTERS.md §16.10): a character made before the creator chooses its look
   * once (or skips: keeps its default). Only its owner, only in the lobby, only while the offer is open (characters
   * .look_custom 0); the look's body must be the model's (parseLook already clamped every number and checked every id);
   * a few tries per connection (CLIENT_RATE_LIMITS.charLook). Level, items and gold are untouched.
   */
  private charLook(id: number, look: CharLook | undefined): void {
    const limit = CLIENT_RATE_LIMITS.charLook!
    let bucket = this.actionBuckets.get('charLook')
    if (!bucket) this.actionBuckets.set('charLook', (bucket = new TokenBucket(limit.perSecond, limit.burst)))
    if (!bucket.take()) return this.error('rate_limited', 'too many look changes', 'charLook')
    const row = this.game.store.characterOwned(id, this.accountId)
    if (!row) return this.error('not_found', 'no such character', 'charLook')
    if (look && look.body !== lookBodyOf(row.model)) return this.error('bad_request', `look.body ${look.body} does not match ${row.model}`, 'charLook')
    if (!this.game.store.customiseLookOnce(id, look ?? null)) return this.error('bad_request', 'the look was chosen already', 'charLook')
    this.game.config.log(`character ${row.name} ${look ? 'customised its look' : 'kept its default look'} (${this.account})`)
    this.send({ t: 'charLookSet', character: this.summary(this.game.store.characterById(id)!) })
  }

  /**
   * Character-list location: the client's area name of the saved position (zones.json, e.g. 'Grassland'), else the
   * world's display name (docs/FIELDS.md §4.6).
   */
  private locationOf(r: CharacterRow): string {
    const saved = r.x !== null && r.z !== null && r.world === this.game.config.world
    return (saved && this.game.data.zoneName(r.x!, r.z!, this.game.setup.regionOrigin)) || this.game.setup.displayName
  }

  summary(r: CharacterRow): CharacterSummary {
    const spawn = this.game.setup.spawn
    const placed = r.x !== null && r.z !== null
    const look = this.visibleEquipOf(r.id)
    return {
      id: r.id,
      name: r.name,
      model: r.model,
      level: r.level,
      weapon: r.weapon,
      location: this.locationOf(r),
      pos: placed ? [r.x!, r.y ?? 0, r.z!] : [spawn.x, spawn.y, spawn.z],
      lastPlayed: r.last_played,
      height: r.height,
      volume: r.volume,
      equip: look.equip,
      ...(Object.keys(look.plus).length > 0 ? { equipPlus: look.plus } : {}),
      look: this.game.store.characterLook(r),
      ...(r.look_custom ? {} : { customise: true }),
    }
  }

  /** Item codes worn in visible slots and their +N (character select dresses the character and lights its weapon). */
  private visibleEquipOf(characterId: number): { equip: NonNullable<CharacterSummary['equip']>; plus: NonNullable<CharacterSummary['equipPlus']> } {
    const inv = this.game.store.loadInventory(characterId)
    const out: NonNullable<CharacterSummary['equip']> = {}
    for (const slot of VISIBLE_SLOTS) {
      const it = inv.equip[slot]
      if (it) out[slot] = it.code
    }
    return { equip: out, plus: visibleEquipPlus(inv.equip) }
  }

  /**
   * Where a character enters the world (docs/NAVIGATION.md §5): its saved surface at its saved x/z (a relog keeps the
   * plaza / bridge it stood on); without one, the surface nearest its saved height on open ground; a new character (or
   * one from another world, or with no ground left there) the town spawn.
   */
  private entryPoint(row: CharacterRow): NavPoint {
    const { world, gameplay } = this.game
    const nav = world.nav
    const spawn = this.game.setup.spawn
    const town = (): NavPoint => gameplay.townPoint() ?? { x: spawn.x, y: spawn.y, z: spawn.z, surface: null }
    const placed = row.x !== null && row.z !== null && row.world === this.game.config.world
    if (!placed) return town()
    const [x, z] = world.clamp(row.x!, row.z!)
    const y = row.y ?? 0
    if (nav.kind !== 'mesh') return { x, y, z, surface: null }
    // docs/NAVIGATION.md §11.4: the saved surface if it lies in the town spawn's walkable component (restore refuses
    // the rest), else the nearest point of that component within WARP_SEARCH_M, else the town spawn.
    const kept = nav.restore(row.nav_surface, x, z)
    if (kept && Math.abs(kept.y - y) < 2) return kept
    const moved = nav.place(x, z, y, WARP_SEARCH_M)
    if (!moved) this.game.config.log(`${row.name}: saved position ${x.toFixed(1)},${z.toFixed(1)} is not in the town's walkable area; moved to the town`)
    return moved ?? town()
  }

  private enterWorld(id: number): void {
    let row = this.game.store.characterOwned(id, this.accountId)
    if (!row) return this.error('not_found', 'no such character', 'enterWorld')
    // Characters created before items.json existed get their starter kit now.
    if (!row.starter_kit && this.game.gameplay.grantStarterKit(row.id, row.weapon, row.model, row.outfit)) row = this.game.store.characterOwned(id, this.accountId)!
    this.applyRole(this.game.store.accountRole(this.accountId))
    const { world } = this.game
    // The Climb (docs/CLIMB.md §6.1, F6): the body of this character still lingers in a fight.
    const linger = this.game.gameplay.penalty.lingerLeft(row.id, Date.now())
    if (linger > 0) return this.error('already_in_world', `Your character is still in combat. Try again in ${linger} s.`, 'enterWorld')
    if (world.online >= this.game.config.capacity) return this.error('server_error', 'the server is full', 'enterWorld')
    // Siege of Jangan layer 6 (docs/SIEGE.md §8.5): a prisoner enters in the Garrison Stockade (a served term: at its gate).
    const at = this.game.gameplay.jail.entryPoint(row.id, row.y ?? 0) ?? this.entryPoint(row)
    const [x, y, z] = [at.x, at.y, at.z]
    this.player = world.add({
      ...this.game.gameplay.playerInit(row),
      characterId: row.id,
      name: row.name,
      model: row.model,
      level: row.level,
      weapon: row.weapon,
      pos: [x, y, z],
      surface: at.surface,
      height: row.height,
      volume: row.volume,
      look: this.game.store.characterLook(row),
      yaw: row.yaw,
      send: (m) => this.send(m),
      staff: isStaff(this.role),
    })
    this.state = 'world'
    this.game.persist([this.player])
    this.game.config.log(`${this.account} entered as ${row.name} at ${x.toFixed(1)},${z.toFixed(1)} (${world.online} online)`)
    this.send({
      t: 'worldEnter',
      self: world.state(this.player),
      world: {
        name: this.game.config.worldExport ?? this.game.config.world,
        serverTime: Date.now(),
        tickRate: world.tickHz,
        levelCap: Math.min(this.game.config.levelCap, MAX_WIRE_LEVEL_CAP),
        // Wave 8 (docs/WAVE_PLAN2.md §3.2.2): the alchemy preview and the guild-create prompt.
        alchemyRate: knob(this.game.config, 'alchemyRate'),
        alchemyMaxPlus: knob(this.game.config, 'alchemyMaxPlus'),
        social: { guildCreateGold: knob(this.game.config, 'guildCreateGold'), guildCreateLevel: Math.min(knob(this.game.config, 'guildCreateLevel'), MAX_WIRE_LEVEL_CAP) },
        // Wave 9 (docs/WAVE_PLAN3.md §3.3): the clock anchor and the late-joiner weather.
        clock: this.game.gameplay.clock.state,
        weather: this.game.gameplay.weather.sync(Date.now()),
        // docs/WINTER.md §5: the snow season and the snow on the ground
        winter: this.game.gameplay.winter.sync(Date.now()),
      },
      entities: world.snapshotFor(this.player),
      role: this.role,
    })
    this.game.gameplay.sendEnter(this.player)
  }

  /** Saves and removes the player from the world. `notify` sends worldLeft to this client. */
  private leaveWorld(notify: boolean): void {
    const p = this.player
    if (!p) return
    this.player = null
    const account = this.account
    const game = this.game
    const leave = (): void => {
      const now = Date.now()
      game.world.settle(p, now)
      game.persist([p], now)
      game.world.remove(p.id, now)
      game.gameplay.forget(p)
      game.config.log(`${account} left as ${p.name} (${game.world.online} online)`)
    }
    // The Climb (docs/CLIMB.md §6.1, F6): leaving within seconds of monster damage leaves the body in the world that
    // long (still a target), so closing the tab does not dodge the death penalty; climb/penalty.ts removes it later.
    if (!game.gameplay.penalty.linger(p, Date.now(), leave)) leave()
    if (this.state === 'world') this.state = 'lobby'
    if (notify) this.send({ t: 'worldLeft' })
  }
}

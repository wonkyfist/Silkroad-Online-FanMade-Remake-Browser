import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decodeNavData, type NavData } from '@sro/nav'
import {
  WALL_SEGMENT_ID,
  WallNavState,
  breachZones,
  checkWallsExport,
  clampIp,
  inBreachZone,
  lightningIp,
  outerFaceDistance,
  repairTerms,
  segmentAt,
  tornadoAt,
  wallName,
  wallOpen,
  wallPct,
  wallSettings,
  wallStage,
  wearIp,
  type BreachZone,
  type ServerMessage,
  type TornadoState,
  type Vec3,
  type WallFxKind,
  type WallSegView,
  type WallSettings,
  type WallStage,
  type WallsExport,
} from '@sro/shared'
import type { ServerConfig } from '../config.ts'
import type { GmResult } from '../gm.ts'
import type { StrikeEvent } from '../lightning/service.ts'
import type { GameplayModule } from '../modules.ts'
import type { MeshNav, NavProvider } from '../nav.ts'
import type { TornadoEvent } from '../storm/tornado.ts'
import type { Mob, Player } from '../world.ts'
import { WallStore } from './store.ts'

/**
 * Siege of Jangan, layer 1: walls that break (docs/SIEGE.md §2, §4, §5). A GameplayModule named `walls`, on whenever
 * the world has a mesh nav and its export has `siege/walls.json` (the converter's wall step); otherwise inert.
 *
 * - **State**: 33 segments `{ip, stage}` (ip an integer in [rubble, maxIp]; stage from packages/shared/src/siege.ts
 *   `wallStage`, with the +5 % hysteresis on the way up). Restored from `wall_segments` (migration 17) at start, before
 *   the first player enters; a row is written on every stage change and at most every 30 s per segment otherwise.
 *   Every change is logged to `wall_log` with its cause.
 * - **Nav**: the wall pieces (`siege/walls-nav.bin`) are added to the server's nav and the four retail wall
 *   instances switched off; then `WallNavState.apply` (shared with the client) switches off the thirds that are down
 *   and forces their breach tiles open. Bodies standing in a gap when it closes are put back on open ground (6 m).
 * - **Safe area**: GameData.unsafeAt takes the breach zones out of the town's safe area (every caller follows).
 * - **Wear**: a lightning strike of kind `wall` landing on a segment takes 3-5 % (seeded by the strike); a tornado
 *   within 120 m of a segment's outer face takes 1 % per 10 s. Both stop at the 35 % floor: they crack, never breach.
 *   A downed third's wall-walk rod is skipped by the lightning (LightningService.wallRodUp).
 * - **Repair**: +1 % per 10 min on its own for every damaged segment (not during a siege; layer 3 adds the masons).
 * - **Messages**: `walls` (all 33) on enter-world and after bulk changes, `wallUpdate` on a change (stage changes at
 *   once, integrity at most once a second per segment), `wallFx` for chips, cracks, breaches and collapses.
 * - **GM** `wall` (WALL_USAGE): status, set, damage, break, repair, reset; audited by gm.ts.
 */

export const WALL_USAGE = 'wall [<seg>] | wall <seg> <pct> | wall <seg> intact|cracked|breached|rubble | wall damage <seg> <pct> | wall break <seg> | wall repair <seg|all> | wall reset'

/** Causes written to wall_log (docs/SIEGE.md §10.3); later layers add raider, ram, sapper, warlord, keg, builders, kit. */
export type WallCause = 'lightning' | 'tornado' | 'natural' | 'gm' | 'raider' | 'ram' | 'sapper' | 'warlord' | 'keg' | 'builders' | 'kit'

/** How often the tornado wear is sampled (ms), and the natural repair step (ms). */
export const TORNADO_STEP_MS = 10_000
export const NATURAL_STEP_MS = 10 * 60_000
/** A segment's row is written at most this often while its stage stays (ms). */
export const SAVE_EVERY_MS = 30_000
/** A segment's `wallUpdate` goes out at most this often unless its stage changes (ms). */
export const UPDATE_EVERY_MS = 1000
/** A body inside a closing gap is moved to open ground within this (m; docs/SIEGE.md §4.2). */
export const RESCUE_M = 6
/** Bodies this close to a closing segment are checked (m). */
const RESCUE_NEAR_M = 40

/** GM stage names -> the % they set. */
const STAGE_PCT: Readonly<Record<WallStage, number>> = { intact: 100, cracked: 50, breached: -10, rubble: -50 }

interface Seg {
  id: string
  ip: number
  stage: WallStage
  queued: number
  lastCause: string | null
  lastAt: number
  /** Unsaved changes, and when the row was last written. */
  dirty: boolean
  savedAt: number
  /** Last `wallUpdate` sent (ms) and an integrity change not sent yet. */
  sentAt: number
  pending: boolean
}

export interface WallChange {
  id: string
  before: number
  after: number
  stage: WallStage
  stageBefore: WallStage
}

/** What the module needs of Gameplay (tests pass a stand-in). */
/**
 * Layer 3: the admin panel's live numbers (config.ts, admin/settings.ts 'Siege of Jangan'): a config field that is set
 * wins over the settings of content/siege/jangan.json.
 */
export const WALL_KNOBS = {
  wallNaturalPctPer10Min: 'naturalPctPer10Min',
  wallGoldPerPct: 'goldPerPct',
  wallBlocksPerPct: 'blocksPerPct',
  wallBuilderPctPerMin: 'builderPctPerMin',
  wallQueueCapPct: 'queueCapPct',
  wallKitPct: 'kitPct',
  wallKitChannelS: 'kitChannelS',
  wallKitPrice: 'kitPrice',
  wallLooters: 'looters',
  wallLooterRespawnMin: 'looterRespawnMin',
} as const satisfies Partial<Record<keyof ServerConfig, keyof WallSettings>>
export type WallKnob = keyof typeof WALL_KNOBS

export interface WallsHost {
  config: Pick<ServerConfig, 'world' | 'outDir' | 'outOptDir' | 'worldExport' | 'contentDir' | 'log'> & Partial<Pick<ServerConfig, WallKnob>>
  world: {
    players: ReadonlyMap<number, Player>
    mobs: ReadonlyMap<number, Mob>
    positionAt(p: { pos: Vec3; move?: Player['move'] }, now: number): Vec3
    warp(p: Player | Mob, x: number, y: number, z: number, now?: number, at?: ReturnType<NavProvider['place']>): Vec3
  }
  nav: NavProvider
  data: { unsafeAt: ((world: string, x: number, z: number) => boolean) | null }
  store: { db: ConstructorParameters<typeof WallStore>[0] }
  lightning?: { onStrike(fn: (e: StrikeEvent) => void): () => void; wallRodUp: ((x: number, z: number) => boolean) | null }
  tornado?: { onTornado(fn: (e: TornadoEvent) => void): () => void }
}

export interface WallsOptions {
  /** The export and its nav pieces (tests); default: read from the world export. */
  walls?: WallsExport | null
  pieces?: NavData | null
  settings?: Partial<WallSettings>
  now?: number
}

const ok = (message: string, data?: unknown): GmResult => (data === undefined ? { ok: true, message } : { ok: true, message, data })
const fail = (message: string): GmResult => ({ ok: false, message })

export class WallService implements GameplayModule {
  readonly name = 'walls'
  readonly walls: WallsExport | null
  readonly settings: WallSettings
  /** Why the module is inert ('' when on). */
  readonly problem: string
  private readonly segs = new Map<string, Seg>()
  private readonly store: WallStore | null
  private navState: WallNavState | null = null
  private zones: BreachZone[] = []
  private readonly tornadoes = new Map<number, TornadoState>()
  /** Segments that fell to rubble and have not closed since (the scaffold flag). */
  private readonly wasRubble = new Set<string>()
  private nextTornadoAt = 0
  private nextNaturalAt = 0
  /** Layer 4 sets this while a siege runs (wider zones, no natural repair). */
  sieging: () => boolean = () => false
  /** Layer 3 (siege/repair.ts): whether builders or a kit are working on a segment now (WallSegView.repairing). */
  repairingOf: (id: string) => boolean = () => false

  constructor(private readonly g: WallsHost, opts: WallsOptions = {}) {
    const now = opts.now ?? Date.now()
    this.settings = wallSettings({ ...readSettingsPatch(g.config), ...(opts.settings ?? {}) })
    let walls: WallsExport | null = null
    let pieces: NavData | null = null
    let problem = ''
    if (opts.walls !== undefined) {
      walls = opts.walls
      pieces = opts.pieces ?? null
      if (!walls) problem = 'no walls'
    } else {
      const r = loadWalls(g.config)
      walls = r.walls
      pieces = r.pieces
      problem = r.problem
    }
    if (walls && g.nav.kind !== 'mesh') {
      problem = 'no mesh nav'
      walls = null
    }
    this.walls = walls
    this.problem = problem
    this.store = walls ? new WallStore(g.store.db, g.config.world) : null
    if (!walls) return
    for (const s of walls.segments) {
      this.segs.set(s.id, { id: s.id, ip: this.settings.maxIp, stage: 'intact', queued: 0, lastCause: null, lastAt: 0, dirty: false, savedAt: 0, sentAt: 0, pending: false })
    }
    for (const row of this.store!.load()) {
      const s = this.segs.get(row.id)
      if (!s) continue
      s.ip = clampIp(row.ip, this.settings)
      s.stage = wallStage(s.ip, this.settings, row.stage)
      s.queued = row.queued
      s.lastCause = row.last_cause
      s.lastAt = row.updated_at
      s.savedAt = now
    }
    // the pieces into the nav, the retail walls out, then the stages
    const nav = g.nav as MeshNav
    const indexOf = pieces ? nav.installPieces(pieces) : new Map<number, number>()
    for (const side of walls.sides) {
      const i = nav.instanceIndex(side.retailInstance)
      if (i !== undefined && pieces) nav.setInstanceEnabled(i, false)
    }
    this.navState = pieces ? new WallNavState(walls, indexOf) : null
    this.applyNav()
    g.data.unsafeAt = (world, x, z) => world === g.config.world && inBreachZone(this.zones, x, z) !== null
    if (g.lightning) {
      g.lightning.onStrike((e) => this.onStrike(e))
      g.lightning.wallRodUp = (x, z) => this.rodUp(x, z)
    }
    g.tornado?.onTornado((e) => this.onTornado(e))
    this.nextTornadoAt = now + TORNADO_STEP_MS
    this.nextNaturalAt = now + NATURAL_STEP_MS
    const down = [...this.segs.values()].filter((s) => s.stage !== 'intact')
    g.config.log(`walls: ${walls.segments.length} segments, ${pieces?.instances.length ?? 0} nav pieces${down.length ? `; not intact: ${down.map((s) => `${s.id} ${s.stage} ${wallPct(s.ip, this.settings)}%`).join(', ')}` : ''}`)
  }

  get on(): boolean {
    return this.walls !== null
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------

  stageOf(id: string): WallStage | null {
    return this.segs.get(id)?.stage ?? null
  }

  ipOf(id: string): number | null {
    return this.segs.get(id)?.ip ?? null
  }

  view(id: string): WallSegView | null {
    const s = this.segs.get(id)
    if (!s) return null
    const v: WallSegView = { id: s.id, stage: s.stage, pct: wallPct(s.ip, this.settings) }
    // a rubble segment climbing back shows its repair scaffolding (layer 3 draws it)
    if (s.stage === 'breached' && this.wasRubble.has(s.id)) v.scaffold = true
    if (this.repairingOf(s.id)) v.repairing = true
    if (s.queued > 0) v.queued = wallPct(s.queued, this.settings)
    return v
  }

  /** The settings with the admin panel's live numbers on top (WALL_KNOBS). */
  live(): WallSettings {
    const out: WallSettings = { ...this.settings }
    for (const [k, key] of Object.entries(WALL_KNOBS) as [WallKnob, keyof WallSettings][]) {
      const v = this.g.config[k]
      if (typeof v === 'number' && Number.isFinite(v)) (out as unknown as Record<string, number>)[key] = v
    }
    return out
  }

  /** Every segment as the repair queue sees it (layer 3). */
  queues(): { id: string; ip: number; queued: number }[] {
    return [...this.segs.values()].map((s) => ({ id: s.id, ip: s.ip, queued: s.queued }))
  }

  queuedOf(id: string): number {
    return this.segs.get(id)?.queued ?? 0
  }

  /**
   * Changes a segment's queued repair work (layer 3; never below 0) and tells the clients. Saved with the segment's row:
   * at once with `save` (a paid donation), else within SAVE_EVERY_MS.
   */
  addQueued(id: string, delta: number, now: number, save = false): number {
    const s = this.segs.get(id)
    if (!s || !Number.isFinite(delta) || delta === 0) return s?.queued ?? 0
    const next = Math.max(0, Math.round(s.queued + delta))
    if (next === s.queued) return next
    s.queued = next
    s.dirty = true
    s.pending = true
    if (save) this.save(s, now)
    return next
  }

  /** A wall_log row that changes no integrity (layer 3: a donation, with who gave what). */
  note(id: string, cause: string, now: number, characterId: number | null, data: Record<string, unknown>): void {
    const s = this.segs.get(id)
    if (s) this.store?.log(id, now, cause, 0, s.stage, characterId, data)
  }

  /** A segment's look changed without its integrity (layer 3: repairing on or off): sends its wallUpdate soon. */
  touch(id: string): void {
    const s = this.segs.get(id)
    if (s) s.pending = true
  }

  /** Sends `walls` to everyone (layer 3: the repair numbers changed in the admin panel). */
  resend(): void {
    this.broadcastAll()
  }

  views(): WallSegView[] {
    return [...this.segs.keys()].map((id) => this.view(id)!)
  }

  /** The breach zones now (safe-area holes). */
  breachZones(): readonly BreachZone[] {
    return this.zones
  }

  // ---- changes -------------------------------------------------------------------------------------------------------

  /**
   * Adds `delta` ip to a segment (negative: damage), clamped to the scale; `floorIp` (natural wear) never lets it go
   * below that. Returns the change, or null for an unknown segment or no change.
   */
  change(id: string, delta: number, cause: WallCause, now: number, opts: { floorIp?: number; characterId?: number | null; at?: Vec3; fx?: WallFxKind; data?: Record<string, unknown> } = {}): WallChange | null {
    const s = this.segs.get(id)
    if (!s || !Number.isFinite(delta) || delta === 0) return null
    let target = s.ip + delta
    if (opts.floorIp !== undefined && delta < 0) target = s.ip <= opts.floorIp ? s.ip : Math.max(opts.floorIp, target)
    return this.setIp(id, target, cause, now, opts)
  }

  /** Sets a segment's integrity (clamped). Returns the change, or null when nothing changed. */
  setIp(id: string, ip: number, cause: WallCause, now: number, opts: { characterId?: number | null; at?: Vec3; fx?: WallFxKind; data?: Record<string, unknown> } = {}): WallChange | null {
    const s = this.segs.get(id)
    if (!s) return null
    const after = clampIp(ip, this.settings)
    if (after === s.ip) return null
    const before = s.ip
    const stageBefore = s.stage
    s.ip = after
    s.stage = wallStage(after, this.settings, stageBefore)
    s.lastCause = cause
    s.lastAt = now
    s.dirty = true
    s.pending = true
    if (s.stage === 'rubble') this.wasRubble.add(id)
    if (!wallOpen(s.stage)) this.wasRubble.delete(id)
    this.store?.log(id, now, cause, after - before, s.stage, opts.characterId ?? null, opts.data ?? {})
    const change: WallChange = { id, before, after, stage: s.stage, stageBefore }
    if (s.stage !== stageBefore) this.stageChanged(s, stageBefore, now, opts.at)
    else if (opts.fx) this.fx(id, opts.fx, now, opts.at)
    return change
  }

  /** Full repair of one segment or all of them (GM, admin). Returns how many changed. */
  repair(id: string | 'all', cause: WallCause, now: number): number {
    const ids = id === 'all' ? [...this.segs.keys()] : [id]
    let n = 0
    for (const k of ids) if (this.setIp(k, this.settings.maxIp, cause, now)) n++
    return n
  }

  private stageChanged(s: Seg, before: WallStage, now: number, at?: Vec3): void {
    const opened = wallOpen(s.stage) !== wallOpen(before) || (s.stage === 'rubble') !== (before === 'rubble')
    if (opened) this.applyNav()
    if (!wallOpen(s.stage) && wallOpen(before)) this.rescue(s.id, now)
    // saved at once
    this.save(s, now)
    this.sendUpdate(s, now)
    const kind: WallFxKind = s.stage === 'rubble' ? 'collapse' : s.stage === 'breached' ? (before === 'rubble' ? 'repair' : 'breach') : s.stage === 'cracked' ? (before === 'intact' ? 'crack' : 'repair') : 'repair'
    this.fx(s.id, kind, now, at)
    this.g.config.log(`walls: ${wallName(s.id)} ${before} -> ${s.stage} (${wallPct(s.ip, this.settings)}%, ${s.lastCause})`)
  }

  /** Re-applies the nav and the breach zones from the stages. */
  private applyNav(): void {
    if (!this.walls) return
    const stages = new Map([...this.segs].map(([id, s]) => [id, s.stage]))
    if (this.navState) this.navState.apply(this.g.nav as MeshNav, stages)
    this.zones = breachZones(stages, this.walls, this.settings, this.sieging())
  }

  /** Puts bodies standing inside a closed segment's footprint back on open ground (docs/SIEGE.md §4.2). */
  private rescue(id: string, now: number): void {
    const seg = this.walls?.segments.find((s) => s.id === id)
    const side = seg && this.walls!.sides.find((x) => x.side === seg.side)
    const nav = this.g.nav as MeshNav
    if (!seg || !side || nav.kind !== 'mesh') return
    const bodies: (Player | Mob)[] = [...this.g.world.players.values(), ...this.g.world.mobs.values()]
    for (const e of bodies) {
      if (e.kind === 'player' ? e.dead : e.ai === 'dead') continue
      const [x, y, z] = this.g.world.positionAt(e, now)
      const along = side.axis === 'x' ? x : z
      const across = side.axis === 'x' ? z : x
      if (along < seg.from - RESCUE_NEAR_M || along > seg.to + RESCUE_NEAR_M || Math.abs(across - side.line) > RESCUE_NEAR_M) continue
      if (!nav.insideSolid(x, z, y)) continue
      const at = nav.place(x, z, y, RESCUE_M)
      if (at) this.g.world.warp(e, at.x, at.y, at.z, now, at)
    }
  }

  private save(s: Seg, now: number): void {
    if (!this.store) return
    this.store.save({ id: s.id, ip: s.ip, stage: s.stage, queued: s.queued, last_cause: s.lastCause, updated_at: s.lastAt || now })
    s.dirty = false
    s.savedAt = now
  }

  private sendUpdate(s: Seg, now: number): void {
    const msg: Extract<ServerMessage, { t: 'wallUpdate' }> = { t: 'wallUpdate', id: s.id, stage: s.stage, pct: wallPct(s.ip, this.settings), at: now }
    if (this.repairingOf(s.id)) msg.repairing = true
    if (s.queued > 0) msg.queued = wallPct(s.queued, this.settings)
    for (const p of this.g.world.players.values()) p.send(msg)
    s.sentAt = now
    s.pending = false
  }

  private broadcastAll(): void {
    const msg = this.wallsMessage()
    for (const p of this.g.world.players.values()) p.send(msg)
  }

  /** A cosmetic moment at `at` (default: the middle of the segment's middle third, on the wall walk). */
  private fx(id: string, kind: WallFxKind, now: number, at?: Vec3): void {
    const p = at ?? this.midpoint(id)
    if (!p) return
    const msg: ServerMessage = { t: 'wallFx', id, kind, x: p[0], y: p[1], z: p[2], at: now }
    for (const pl of this.g.world.players.values()) pl.send(msg)
  }

  private midpoint(id: string): Vec3 | null {
    const seg = this.walls?.segments.find((s) => s.id === id)
    const side = seg && this.walls!.sides.find((x) => x.side === seg.side)
    if (!seg || !side) return null
    const along = (seg.thirds[1].from + seg.thirds[1].to) / 2
    return side.axis === 'x' ? [along, side.walkY, side.line] : [side.line, side.walkY, along]
  }

  /** A wall-walk rod still has a wall under it (not over a downed third). */
  rodUp(x: number, z: number): boolean {
    if (!this.walls) return true
    const at = segmentAt(this.walls, x, z)
    if (!at) return true
    const stage = this.segs.get(at.seg.id)?.stage ?? 'intact'
    return stage === 'rubble' ? false : stage === 'breached' ? at.third !== 1 : true
  }

  // ---- wear (docs/SIEGE.md §2.3) --------------------------------------------------------------------------------------

  private onStrike(e: StrikeEvent): void {
    if (e.phase !== 'land' || e.strike.kind !== 'wall' || !this.walls) return
    const [x, y, z] = e.strike.pos
    const at = segmentAt(this.walls, x, z)
    if (!at) return
    // seeded by the strike: every server rolls the same wear for the same bolt
    const u = ((e.strike.seed >>> 0) % 10_007) / 10_007
    this.wear(at.seg.id, lightningIp(u, this.settings), 'lightning', e.strike.at, [x, y, z], { strike: e.strike.id })
  }

  /** Natural wear: never below the floor (35 %), never a breach. */
  wear(id: string, dmg: number, cause: 'lightning' | 'tornado', now: number, at?: Vec3, data?: Record<string, unknown>): WallChange | null {
    const s = this.segs.get(id)
    if (!s) return null
    const target = wearIp(s.ip, dmg, this.settings)
    if (target === s.ip) return null
    return this.setIp(id, target, cause, now, { at, fx: 'chip', ...(data ? { data } : {}) })
  }

  private onTornado(e: TornadoEvent): void {
    if (e.phase === 'end') this.tornadoes.delete(e.tornado.id)
    else this.tornadoes.set(e.tornado.id, e.tornado as TornadoState)
  }

  private tornadoWear(now: number): void {
    if (!this.walls || this.tornadoes.size === 0) return
    const dmg = Math.round((this.settings.tornadoPctPer10s / 100) * this.settings.maxIp * (TORNADO_STEP_MS / 10_000))
    for (const t of this.tornadoes.values()) {
      const at = tornadoAt(t, now)
      if (at.phase !== 'active') continue
      for (const seg of this.walls.segments) {
        const side = this.walls.sides.find((x) => x.side === seg.side)!
        if (outerFaceDistance(side, seg, at.pos[0], at.pos[2]) > this.settings.tornadoReachM) continue
        this.wear(seg.id, dmg, 'tornado', now, undefined, { tornado: t.id })
      }
    }
  }

  private naturalRepair(now: number): void {
    const rate = this.live().naturalPctPer10Min
    if (this.sieging() || !(rate > 0)) return
    const step = Math.round((rate / 100) * this.settings.maxIp * (NATURAL_STEP_MS / 600_000))
    for (const s of this.segs.values()) if (s.ip < this.settings.maxIp) this.change(s.id, step, 'natural', now)
  }

  // ---- module hooks ---------------------------------------------------------------------------------------------------

  enter(p: Player): void {
    if (this.walls) p.send(this.wallsMessage())
  }

  /** `walls`: every segment and (layer 3) the repair numbers. */
  private wallsMessage(): ServerMessage {
    return { t: 'walls', segs: this.views(), repair: repairTerms(this.live()) }
  }

  tick(now: number): void {
    if (!this.walls) return
    if (now >= this.nextTornadoAt) {
      this.nextTornadoAt = now + TORNADO_STEP_MS
      this.tornadoWear(now)
    }
    if (now >= this.nextNaturalAt) {
      this.nextNaturalAt = now + NATURAL_STEP_MS
      this.naturalRepair(now)
    }
    for (const s of this.segs.values()) {
      if (s.pending && now - s.sentAt >= UPDATE_EVERY_MS) this.sendUpdate(s, now)
      if (s.dirty && now - s.savedAt >= SAVE_EVERY_MS) this.save(s, now)
    }
  }

  /** Writes every unsaved segment (shutdown). */
  flush(now = Date.now()): void {
    for (const s of this.segs.values()) if (s.dirty) this.save(s, now)
  }

  // ---- GM `wall` (docs/SIEGE.md §12) ------------------------------------------------------------------------------------

  gm(args: string[], now: number): GmResult {
    if (!this.walls) return fail(`The walls are off on this server (${this.problem || 'no walls.json'}).`)
    const a = args.map((s) => s.trim())
    const seg = (raw: string | undefined): string | null => {
      const id = (raw ?? '').toUpperCase()
      return WALL_SEGMENT_ID.test(id) && this.segs.has(id) ? id : null
    }
    const usage = fail(`Usage: ${WALL_USAGE}`)
    if (a.length === 0) return this.status()
    const verb = a[0]!.toLowerCase()
    if (verb === 'reset') {
      const n = this.repair('all', 'gm', now)
      this.broadcastAll()
      return ok(`All ${this.segs.size} wall segments repaired to 100 % (${n} changed).`)
    }
    if (verb === 'repair') {
      if (a[1]?.toLowerCase() === 'all') {
        const n = this.repair('all', 'gm', now)
        this.broadcastAll()
        return ok(`Repaired every wall segment (${n} changed).`)
      }
      const id = seg(a[1])
      if (!id) return usage
      this.repair(id, 'gm', now)
      return ok(`${wallName(id)} repaired: ${this.line(id)}.`)
    }
    if (verb === 'break' || verb === 'breach') {
      const id = seg(a[1])
      if (!id) return usage
      const s = this.segs.get(id)!
      if (!wallOpen(s.stage)) this.setIp(id, Math.round((STAGE_PCT.breached / 100) * this.settings.maxIp), 'gm', now)
      return ok(`${wallName(id)} breached: ${this.line(id)}.`)
    }
    if (verb === 'damage') {
      const id = seg(a[1])
      const pct = Number(a[2])
      if (!id || !Number.isFinite(pct) || pct <= 0 || pct > 150) return fail('Usage: wall damage <seg> <pct> (1-150, % of the segment)')
      this.change(id, -Math.round((pct / 100) * this.settings.maxIp), 'gm', now)
      return ok(`${wallName(id)} damaged: ${this.line(id)}.`)
    }
    const id = seg(a[0])
    if (!id) return usage
    if (a.length === 1) return this.detail(id)
    const v = a[1]!.toLowerCase()
    let pct: number
    if (v in STAGE_PCT) pct = STAGE_PCT[v as WallStage]
    else {
      pct = Number(v.replace(/%$/, ''))
      if (!Number.isFinite(pct) || pct < this.settings.rubblePct || pct > 100) return fail(`A wall's integrity is ${this.settings.rubblePct}..100 %.`)
    }
    this.setIp(id, Math.round((pct / 100) * this.settings.maxIp), 'gm', now)
    return ok(`${wallName(id)}: ${this.line(id)}.`)
  }

  private line(id: string): string {
    const s = this.segs.get(id)!
    return `${s.stage} ${wallPct(s.ip, this.settings)}%`
  }

  private status(): GmResult {
    const bySide = new Map<string, string[]>()
    for (const s of this.segs.values()) {
      const list = bySide.get(s.id[0]!) ?? []
      list.push(s.stage === 'intact' && s.ip === this.settings.maxIp ? `${s.id}` : `${s.id} ${s.stage} ${wallPct(s.ip, this.settings)}%`)
      bySide.set(s.id[0]!, list)
    }
    const zones = this.zones.length ? `\nBreach zones (not safe): ${this.zones.map((z) => `${z.seg} r${Math.round(z.r)} m at ${Math.round(z.x)},${Math.round(z.z)}`).join(', ')}` : ''
    return ok(`Walls (${this.segs.size} segments; plain id = intact 100 %):\n${[...bySide].map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n')}${zones}`, { segs: this.views(), zones: this.zones })
  }

  private detail(id: string): GmResult {
    const s = this.segs.get(id)!
    const seg = this.walls!.segments.find((x) => x.id === id)!
    const log = this.store?.recent(id, 5) ?? []
    const lines = log.map((r) => `  ${new Date(r.at).toISOString().slice(5, 19).replace('T', ' ')} ${r.cause} ${r.delta >= 0 ? '+' : ''}${wallPct(r.delta, this.settings)}% -> ${r.stage}`)
    return ok(`${wallName(id)}: ${this.line(id)}, span ${seg.from.toFixed(1)}..${seg.to.toFixed(1)} m, last ${s.lastCause ?? 'never touched'}${lines.length ? `\n${lines.join('\n')}` : ''}`, this.view(id))
  }
}

/** content/siege/jangan.json `settings.walls` (a sparse patch), or {} (problems logged). */
function readSettingsPatch(config: Pick<ServerConfig, 'contentDir' | 'log'>): Partial<WallSettings> {
  if (!config.contentDir) return {}
  const file = join(config.contentDir, 'siege', 'jangan.json')
  if (!existsSync(file)) return {}
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { settings?: { walls?: Partial<WallSettings> } }
    const patch = v.settings?.walls ?? {}
    wallSettings(patch)
    return patch
  } catch (e) {
    config.log(`walls: ${file}: ${(e as Error).message}; defaults used`)
    return {}
  }
}

/** OUT_DIR (then out-opt)/world/<export>/siege/walls.json and its nav pieces. */
export function loadWalls(config: Pick<ServerConfig, 'world' | 'outDir' | 'outOptDir' | 'worldExport'>): { walls: WallsExport | null; pieces: NavData | null; problem: string } {
  if (!config.outDir) return { walls: null, pieces: null, problem: 'no OUT_DIR' }
  const dirs = [config.outDir, config.outOptDir ?? join(dirname(config.outDir), 'out-opt')]
  let problem = 'no siege/walls.json in the world export'
  for (const dir of dirs) {
    const base = join(dir, 'world', config.worldExport ?? config.world)
    const file = join(base, 'siege', 'walls.json')
    if (!existsSync(file)) continue
    try {
      const walls = JSON.parse(readFileSync(file, 'utf8')) as WallsExport
      const problems = checkWallsExport(walls)
      if (problems.length) {
        problem = `${file}: ${problems.slice(0, 3).join('; ')}`
        continue
      }
      const bytes = readFileSync(join(base, ...walls.navFile.split('/')))
      const pieces = decodeNavData(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      return { walls, pieces, problem: '' }
    } catch (e) {
      problem = `${file}: ${(e as Error).message}`
    }
  }
  return { walls: null, pieces: null, problem }
}

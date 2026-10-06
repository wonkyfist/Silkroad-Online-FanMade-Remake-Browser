import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFENDER_MIN_LEVEL,
  LAW_CODES,
  SALTPETER_DROP,
  DEFENDER_RANGE_M,
  SIEGE_APPROACHES,
  SIEGE_EVENT_CODES,
  SIEGE_EVENT_DEFAULTS,
  SIEGE_HONOR,
  SIEGE_POINTS,
  SIEGE_REQUESTS,
  approachList,
  checkSiegeEventSettings,
  clipWalk,
  distToLeg,
  installSiegeEventContent,
  mergeSiegeEventSettings,
  mulberry32,
  pickApproaches,
  siegeReward,
  siegeScale,
  wallName,
  wallOpen,
  wardLines,
  warlordHp,
  yawTowards,
  waveOf,
  waveRoster,
  type GameplayRequest,
  type MobVariant,
  type ServerMessage,
  type SiegeApproach,
  type SiegeContribKind,
  type SiegeEventPatch,
  type SiegeEventSettings,
  type SiegeOutcome,
  type SiegePhase,
  type SiegeRole,
  type SiegeView,
  type Vec3,
  type WallSegView,
  type WallStage,
  type WallsExport,
  type WardLine,
  type XZ,
} from '@sro/shared'
import type { Gameplay, RolledDrop } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { addGold, addItem, fail } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule, KillOwner } from '../modules.ts'
import type { MeshNav } from '../nav.ts'
import { nextSlotAt } from '../pilot/lottery.ts'
import type { Mob, Player } from '../world.ts'
import { Army, outerPath, slotOffset, slotStart, SWING_MS, type ArmyHost, type SiegeMob } from './army.ts'
import { KEG_BLAST_M, KEG_DEFUSE_M, KEG_HURT, beginDefuse, blastHurt, defuseStep, kegMessage, nextKegId, type KegDefuse } from './keg.ts'
import { registerSiegeAdmin } from './event-admin.ts'
import { SiegeStore, type SiegeEventRow } from './event-store.ts'
import { LEG_EPS_M, readSiegeLanes, validateLanes, type ApproachLanes, type Lane } from './lanes.ts'
import type { WallEvent, WallService } from './walls.ts'

/**
 * Siege of Jangan, layer 4: the siege event (docs/SIEGE.md §6). A GameplayModule named `siege`, on when the walls are
 * on and content/siege/jangan.json has lanes that walk on the nav (siege/lanes.ts); otherwise inert.
 *
 * - **Start**: the weekly schedule (Sunday 20:00 server time by default, OFF until the admin turns it on; the slot is
 *   the warning's start), `/siege start [warningMin]` or the admin's Start. A scheduled slot is skipped (a `skipped`
 *   row) with fewer than `minPlayers` players of level ≥ 10 online; while a Night of the Tiger runs it waits
 *   `tigerWaitMin` (twice at most, then it is skipped); a Night due during a siege waits the same way (pilot/call.ts).
 * - **Warning** (10 min): 2 of the 4 approaches are picked (seeded), the Town Bell rises on the plaza, wave 1 musters
 *   ≥ 350 m out, the alarm (siegeNotice 'phase'), chat lines at 10, 5 and 1 min. The breach zones grow to 80 m.
 * - **Waves**: wave 1 at t = 0 (12 raiders + 2 sappers per approach), wave 2 at +8 min (14 raiders, 6 archers, 3
 *   sappers, 2 rams), wave 3 at +16 min (the Bandit Warlord at one approach, 10 elite raiders, 2 rams per approach); a
 *   wave comes early once 80 % of the monsters alive at the last wave's start are dead. Counts × s (siegeScale, N
 *   sampled at each wave start); the Warlord's HP × s^0.9. The army (army.ts) marches the lanes, assaults the walls,
 *   plants sapper kegs, and goes for the Bell through any gap. The gates are warded (World.mobWalkClip).
 * - **The ground**: during a wave the Bell's circle (`bell.zoneM`) and the lanes from the open gaps to it are not safe
 *   (WallService.extraUnsafe), so defenders and monsters can fight there.
 * - **Kegs**: a planted sapper keg burns `fuseSec`; any defender within 3 m may defuse it (`kegDefuse`, a `defuseSec`
 *   channel, broken by moving or damage); the blast takes `sapperIp` off the segment and 25 % of max HP from everyone
 *   within 6 m (non-lethal for players).
 * - **The end**: `won` (the Warlord killed), `lost_bell` (the Bell destroyed), `lost_time` (`durationMin` after wave 1),
 *   `cancelled` (GM / admin stop), `restart` (a wave found at boot: nothing paid). Living siege monsters run back and
 *   are gone within 60 s, the Bell 60 s after the end; breaches stay (looters move in). No town penalty.
 * - **Rewards**: contribution points (siege-event.ts SIEGE_POINTS: damage, sappers stopped, kegs defused, kit repairs,
 *   donations, Bell repairs, a player's hits on the Bell repair it); paid to the defenders online at the end (gold,
 *   Siege Seals, the "Defender of Jangan" title), each one gets `siegeReward`; layer 5: the traitors of the siege (player
 *   kegs) and their associates get nothing (LawService.barredFromSiege). Siege monsters give 50 % EXP and no loot but
 *   Saltpeter (2 %).
 * - **Persistence** (migration 18): siege_events (phase, approaches, stats), siege_log, siege_contrib, siege_settings.
 *   A restart during the warning resumes (≥ 3 min left); during a wave the siege ends `restart`.
 * - **GM** `siege` (SIEGE_USAGE), the admin page (event-admin.ts).
 */

export const SIEGE_USAGE = 'siege [status] | siege start [warningMin] | siege stop | siege wave <1-3> | siege warlord | siege lanes | siege army'
/** The settings row of siege_settings. */
export const SIEGE_SETTINGS_CODE = 'jangan'
/** The Bell stays this long after the end (ms). */
export const BELL_LEAVE_MS = 60_000
/** A warning resumed after a restart has at least this long left (ms). */
export const RESUME_MIN_MS = 3 * 60_000
/** A slot found this late at boot still starts; later it is skipped (ms). */
export const MISSED_GRACE_MS = 30 * 60_000
/** The view goes out at most this often unless the phase changes (ms). */
export const VIEW_EVERY_MS = 1000
/** The event row is saved this often (ms). */
export const SAVE_EVERY_MS = 60_000
/** The army steps this often (ms). */
export const ARMY_STEP_MS = 200
/** Keg: blast radius, defuse reach (m), share of max HP the blast takes (siege/keg.ts: the rules every keg shares). */
export { KEG_BLAST_M, KEG_DEFUSE_M, KEG_HURT }
/** The ground this close to a lane from an open gap to the Bell is not safe during a wave (m). */
export const CORRIDOR_M = 20
/** A defender's Bell repair hits count at most this often (ms). */
export const BELL_REPAIR_MS = 2000
/** The countdown chat lines before wave 1 (minutes). */
const COUNTDOWN_MIN = [10, 5, 1]
/** Muster scatter (m). */
const MUSTER_R = 12

/** What the module needs of the walls (WallService; tests pass a stand-in). */
export interface SiegeWalls {
  readonly on: boolean
  readonly walls: WallsExport | null
  readonly settings: { maxIp: number }
  stageOf(id: string): WallStage | null
  change(id: string, delta: number, cause: 'raider' | 'ram' | 'sapper' | 'warlord', now: number, opts?: { at?: Vec3; fx?: 'chip'; data?: Record<string, unknown> }): unknown
  onWallEvent(fn: (e: WallEvent) => void): () => void
  sieging: () => boolean
  extraUnsafe: ((x: number, z: number) => boolean) | null
  refreshZones(): void
  views(): WallSegView[]
}

interface Contrib {
  characterId: number
  name: string
  points: number
  parts: Partial<Record<SiegeContribKind, number>>
  donated: number
  bellAt: number
}

interface Keg {
  id: number
  seg: string
  at: Vec3
  fuseEndsAt: number
  sapper: number | null
  defuse: KegDefuse | null
}

export interface SiegeEv {
  id: number
  origin: 'schedule' | 'gm' | 'admin'
  phase: SiegePhase
  createdAt: number
  wave1At: number
  /** The next wave's time (0 = none). */
  nextAt: number
  /** lost_time (0 before wave 1). */
  endsAt: number
  approaches: SiegeApproach[]
  /** The approach the Warlord takes. */
  lead: SiegeApproach
  seed: number
  defenders: number
  scale: number
  breaches: Set<string>
  bell: number | null
  warlord: number | null
  mobs: Set<number>
  /** Siege monsters alive at the last wave's start (the early-wave rule). */
  waveAlive: number
  contrib: Map<number, Contrib>
  kegs: Map<number, Keg>
  outcome: SiegeOutcome | null
  endedAt: number
  /** Countdown lines already said. */
  said: Set<number>
  sent: string
  sentAt: number
  savedAt: number
  armyAt: number
  /** Ground not safe: the Bell's circle and the lanes from the open gaps. */
  corridors: [XZ, XZ][]
}

type StartResult = { ok: true; message: string; event: SiegeEv } | { ok: false; status: number; message: string }

export class SiegeService implements GameplayModule {
  readonly name = 'siege'
  readonly handles: readonly GameplayRequest[] = SIEGE_REQUESTS
  walls: SiegeWalls
  lanes: ApproachLanes[] = []
  bellAt: XZ = [97, -63]
  wards: WardLine[] = []
  /** Why the module is inert ('' when on). */
  problem = ''
  ev: SiegeEv | null = null
  /** The settings: defaults (SIEGE_EVENT_DEFAULTS ⊕ content), the admin's patch at `rev`, the effective ones. */
  defaults: SiegeEventSettings
  patch: SiegeEventPatch = {}
  rev = 0
  settings: SiegeEventSettings
  /** The schedule: the next slot (server ms), a wait for a Night of the Tiger. */
  next: number | null = null
  waitUntil = 0
  private waits = 0
  private schedKey = ''
  private booted = false
  private storeCache: SiegeStore | null = null
  private rng: () => number
  readonly army: Army
  private readonly honors = new Map<number, string | null>()
  private offWalls: (() => void) | null = null

  constructor(
    readonly g: Gameplay,
    walls: WallService,
  ) {
    this.walls = walls
    this.rng = g.config.rng ? mulberry32(0x5e1e6e) : Math.random
    this.defaults = mergeSiegeEventSettings(SIEGE_EVENT_DEFAULTS, readContentPatch(g))
    this.settings = structuredClone(this.defaults)
    this.army = new Army(this.armyHost())
    installSiegeEventContent({ mobs: g.data.mobs, items: g.data.items }, this.defaults.bell.hp)
    g.world.mobWalkClip = (m, ax, az, bx, bz) => (this.wards.length ? clipWalk(ax, az, bx, bz, this.wards) : null)
    g.world.decorators.push((e, s) => {
      if (e.kind === 'mob' && e.siege) s.siege = e.siege.role
      // without Play the Boss (UNIQUES=off) the siege shows its own title
      if (e.kind === 'player' && !g.pilot && !s.honor) {
        const h = this.honorOf(e.characterId)
        if (h) s.honor = h
      }
    })
    registerSiegeAdmin()
    if (!walls.on || !walls.walls) {
      this.problem = 'the walls are off'
      return
    }
    const r = readSiegeLanes(g.config.contentDir)
    if (!r.content) {
      this.problem = r.problem
      g.config.log(`siege: off (${r.problem})`)
      return
    }
    this.bellAt = r.content.bell
    const nav = g.nav as MeshNav
    const t0 = performance.now()
    this.lanes = validateLanes(r.content, walls.walls, {
      walk: (a, b) => {
        // locate, not place: place() rebuilds the home component after every nav switch (≈ 0.6 s each)
        const p = nav.locate(a[0], a[1], Infinity) ?? nav.place(a[0], a[1], NaN, 6)
        if (!p) return null
        const w = nav.walk(p, b[0], b[1])
        if (!w) return null
        return { ok: !w.blocked && Math.hypot(w.end.x - b[0], w.end.z - b[1]) <= LEG_EPS_M, end: [w.end.x, w.end.z] }
      },
      withStage: (seg, stage, fn) => walls.withStage(seg, stage, fn),
    })
    this.wards = wardLines(walls.walls)
    this.attachWalls()
    const checkedMs = Math.round(performance.now() - t0)
    const usable = this.lanes.filter((a) => a.lanes.length)
    if (!usable.length) this.problem = 'no lane walks on the nav'
    for (const a of this.lanes) for (const d of a.dropped) g.config.log(`siege: lane ${a.approach} ${d.seg} dropped: ${d.why}`)
    g.config.log(`siege: ${usable.length ? 'on' : 'off'}; ${this.lanes.map((a) => `${a.approach} ${a.lanes.map((l) => l.seg).join('/') || '-'}`).join(', ')}; ${this.wards.length} gate wards; lanes checked in ${checkedMs} ms`)
  }

  /** Tests: the walls, lanes, Bell and wards to use (the module turns on). */
  configure(o: { walls: SiegeWalls; lanes: ApproachLanes[]; bell?: XZ; wards?: WardLine[] }): void {
    this.offWalls?.()
    this.walls = o.walls
    this.lanes = o.lanes
    if (o.bell) this.bellAt = o.bell
    this.wards = o.wards ?? []
    this.problem = o.lanes.some((a) => a.lanes.length) ? '' : 'no lanes'
    this.attachWalls()
  }

  private attachWalls(): void {
    this.walls.sieging = () => this.running()
    this.offWalls = this.walls.onWallEvent((e) => this.onWall(e))
  }

  get on(): boolean {
    return this.walls.on && this.problem === '' && this.lanes.some((a) => a.lanes.length)
  }

  get store(): SiegeStore {
    return (this.storeCache ??= new SiegeStore(this.g.store.db))
  }

  /** A siege runs (warning or a wave). */
  running(): boolean {
    return this.ev !== null && this.ev.phase !== 'ended'
  }

  /** Why another big event may not start now (Play the Boss asks), or null. */
  busyWhy(): string | null {
    return this.running() ? `the Siege of Jangan is on (${this.ev!.phase})` : null
  }

  // ---- settings ----------------------------------------------------------------------------------------------

  /** The stored patch over the defaults (bad stored fields dropped). */
  loadSettings(): void {
    let row: { json: string; rev: number } | undefined
    try {
      row = this.store.settingsOf(SIEGE_SETTINGS_CODE)
    } catch {
      row = undefined
    }
    if (!row) return this.applyPatch({}, 0)
    let patch: SiegeEventPatch = {}
    try {
      patch = JSON.parse(row.json) as SiegeEventPatch
    } catch {
      this.g.config.log('siege: the stored settings are not JSON; using the defaults')
    }
    if (checkSiegeEventSettings(patch).length) {
      this.g.config.log('siege: stored settings out of bounds; using the defaults')
      patch = {}
    }
    this.applyPatch(patch, row.rev)
  }

  applyPatch(patch: SiegeEventPatch, rev: number): void {
    this.patch = patch
    this.rev = rev
    this.settings = mergeSiegeEventSettings(this.defaults, patch)
    this.schedKey = ''
  }

  // ---- the army's host ---------------------------------------------------------------------------------------

  private armyHost(): ArmyHost {
    const g = this.g
    return {
      get now() {
        return g.now
      },
      speed: (m) => this.settings.army.marchSpeed * (m.siege?.role === 'sapper' ? 0.8 : 1) * (m.siege?.mode === 'flee' ? 1.4 : 1),
      settings: () => this.settings.army,
      lane: (m) => this.laneOf(m),
      bell: () => this.bellMob(),
      bellAt: () => this.bellAt,
      wallOpen: (seg) => {
        const st = this.walls.stageOf(seg)
        return st !== null && wallOpen(st)
      },
      wallHit: (m, lane, at) => this.wallHit(m, lane, at),
      planted: (m, lane, at) => this.planted(m, lane, at),
      position: (e) => g.world.positionAt(e, g.now),
      walk: (m, x, z, speed) => g.world.walkEntity(m, x, z, speed, g.now),
      halt: (m, yaw) => g.world.halt(m, g.now, yaw),
      warpTo: (m, x, z) => {
        const at = g.nav.place(x, z, m.pos[1], 8)
        if (at) g.world.warp(m, at.x, at.y, at.z, g.now, at)
      },
      defendersNear: (x, z, r) => g.playersNear(x, z, r),
      hitBell: (m, bell) => g.attack(m, bell, g.now),
      swingAnim: (m, yaw) => {
        g.world.halt(m, g.now, yaw)
        g.world.broadcastAbout(m, { t: 'cast', id: m.id, skill: 'SIEGE_WALL_SWING', instance: 1_900_000_000 + (m.id % 99_999_999), prepareMs: 0, castMs: 0, actionMs: SWING_MS, clip: 'ATTACK1' })
      },
      remove: (m) => {
        this.ev?.mobs.delete(m.id)
        if (g.world.mobs.has(m.id)) g.world.removeEntity(m.id)
      },
      report: (e) => g.config.log(`siege: army step failed: ${(e as Error)?.stack ?? e}`),
    }
  }

  laneOf(m: Mob): Lane | null {
    const s = m.siege
    if (!s) return null
    return this.lanes.find((a) => a.approach === s.approach)?.lanes.find((l) => l.seg === s.seg) ?? null
  }

  bellMob(): Mob | null {
    const id = this.ev?.bell
    const m = id === null || id === undefined ? undefined : this.g.world.mobs.get(id)
    return m && m.ai !== 'dead' ? m : null
  }

  private warlordMob(): Mob | null {
    const id = this.ev?.warlord
    const m = id === null || id === undefined ? undefined : this.g.world.mobs.get(id)
    return m && m.ai !== 'dead' ? m : null
  }

  // ---- the event ---------------------------------------------------------------------------------------------

  /** A siege starts now: the warning (`warningMin`, default the setting). */
  start(origin: SiegeEv['origin'], warningMin: number | undefined, now: number): StartResult {
    this.boot(now)
    if (!this.on) return { ok: false, status: 409, message: `The Siege of Jangan is off on this server (${this.problem || 'no lanes'}).` }
    if (this.running()) return { ok: false, status: 409, message: `A siege is running (event ${this.ev!.id}, ${this.ev!.phase}).` }
    const st = this.settings
    const min = warningMin ?? st.timing.warningMin
    if (!(Number.isFinite(min) && min >= 0 && min <= 60)) return { ok: false, status: 400, message: 'The warning lasts 0 to 60 minutes.' }
    // the last siege's stragglers and Bell go now
    this.cleanupEnded(now, true)
    const usable = this.lanes.filter((a) => a.lanes.length).map((a) => a.approach)
    const seed = Math.floor(this.rng() * 0xffffffff) >>> 0
    const r = mulberry32(seed)
    const approaches = pickApproaches(usable, Math.min(st.timing.approaches, usable.length), r)
    const lead = approaches[Math.floor(r() * approaches.length) % approaches.length]!
    const wave1At = Math.round(now + min * 60_000)
    const id = this.store.create(origin, 'warning', now, wave1At, approaches, { lead, seed })
    const ev = this.makeEvent(id, origin, now, wave1At, approaches, lead, seed)
    this.ev = ev
    this.store.log(id, 'start', { origin, approaches, lead, warningMin: min }, now)
    this.beginWarning(ev, now)
    this.g.config.log(`siege: event ${id} (${origin}): an army marches on Jangan from ${approaches.join(', ')}; wave 1 in ${min} min`)
    return { ok: true, event: ev, message: `The Siege of Jangan begins (event ${id}): ${this.approachNames(approaches)}; wave 1 in ${min} min.` }
  }

  private makeEvent(id: number, origin: SiegeEv['origin'], now: number, wave1At: number, approaches: SiegeApproach[], lead: SiegeApproach, seed: number): SiegeEv {
    return {
      id, origin, phase: 'warning', createdAt: now, wave1At, nextAt: wave1At, endsAt: 0, approaches, lead, seed, defenders: 0, scale: 1,
      breaches: new Set(), bell: null, warlord: null, mobs: new Set(), waveAlive: 0, contrib: new Map(), kegs: new Map(), outcome: null,
      endedAt: 0, said: new Set(), sent: '', sentAt: 0, savedAt: now, armyAt: 0, corridors: [],
    }
  }

  /** The warning: the Bell, wave 1 at its musters, the alarm, wider breach zones. */
  private beginWarning(ev: SiegeEv, now: number): void {
    this.spawnBell(ev, now)
    ev.defenders = this.defenders(now)
    ev.scale = siegeScale(ev.defenders, this.settings.army)
    for (const a of ev.approaches) this.spawnWave(ev, a, 1, false, now)
    this.walls.refreshZones()
    this.notice({ t: 'siegeNotice', event: 'phase', phase: 'warning', approaches: ev.approaches })
    this.chat(`[Siege] Scouts report an army marching on Jangan from ${this.approachNames(ev.approaches)}! Defend the walls and the Town Bell.`)
    this.broadcastView(ev, now, true)
  }

  private approachNames(list: readonly SiegeApproach[]): string {
    return approachList(list.map((a) => this.lanes.find((x) => x.approach === a)?.name ?? a))
  }

  private spawnBell(ev: SiegeEv, now: number): void {
    const def = this.g.data.mob(SIEGE_EVENT_CODES.bell)
    if (!def) return
    const at = this.g.nav.place(this.bellAt[0], this.bellAt[1], NaN, 10) ?? { x: this.bellAt[0], y: 0, z: this.bellAt[1], surface: null }
    const m = this.g.createMob(def, 'normal', at.x, at.z, at.y, null, now, at.surface, undefined, (b) => {
      b.maxHp = b.hp = this.settings.bell.hp
      b.yaw = 0
      b.aggressive = false
      b.siege = this.unit(ev, 'bell', ev.approaches[0] ?? 'S', '', 0, 'still', [], 0, now)
    })
    ev.bell = m.id
  }

  private unit(ev: SiegeEv, role: SiegeRole, approach: SiegeApproach, seg: string, wave: number, mode: SiegeMob['mode'], path: XZ[], i: number, startAt: number): SiegeMob {
    return { event: ev.id, role, approach, seg, wave, mode, resume: 'march', path, offset: slotOffset(i), startAt, retried: false, stuck: 0, nextActAt: 0, nextLookAt: startAt + (i % 5) * 100 }
  }

  /** Spawns one approach's share of wave `wave` at its muster; `march`: it sets off now (else it waits: wave 1). */
  private spawnWave(ev: SiegeEv, approach: SiegeApproach, wave: 1 | 2 | 3, march: boolean, now: number): number {
    const al = this.lanes.find((a) => a.approach === approach)
    if (!al || !al.lanes.length) return 0
    const r = waveRoster(wave, ev.scale, this.settings.waves, approach === ev.lead)
    const list: { role: SiegeRole; code: string; variant: MobVariant }[] = []
    if (r.warlord) list.push({ role: 'warlord', code: SIEGE_EVENT_CODES.warlord, variant: 'normal' })
    for (let i = 0; i < r.rams; i++) list.push({ role: 'ram', code: SIEGE_EVENT_CODES.ram, variant: 'giant' })
    for (let i = 0; i < r.sappers; i++) list.push({ role: 'sapper', code: SIEGE_EVENT_CODES.sapper, variant: 'normal' })
    for (let i = 0; i < r.elite; i++) list.push({ role: 'raider', code: SIEGE_EVENT_CODES.raider, variant: 'champion' })
    for (let i = 0; i < r.raiders; i++) list.push({ role: 'raider', code: i % 3 === 2 ? SIEGE_EVENT_CODES.raiderBeast : SIEGE_EVENT_CODES.raider, variant: 'normal' })
    for (let i = 0; i < r.archers; i++) list.push({ role: 'archer', code: SIEGE_EVENT_CODES.archer, variant: 'normal' })
    let n = 0
    const rr = mulberry32((ev.seed ^ (wave * 7919) ^ approach.charCodeAt(0)) >>> 0)
    // the Warlord goes for the weakest of his approach's segments; everyone else round-robin over the lanes
    const weakest = [...al.lanes].sort((a, b) => this.pctOf(a.seg) - this.pctOf(b.seg))[0]!
    list.forEach((u, i) => {
      if (ev.mobs.size >= this.settings.army.maxMobs) return
      const def = this.g.data.mob(u.code)
      if (!def) return
      const lane = u.role === 'warlord' ? weakest : al.lanes[i % al.lanes.length]!
      const a = rr() * Math.PI * 2
      const d = Math.sqrt(rr()) * MUSTER_R
      const at = this.g.nav.place(al.muster[0] + Math.sin(a) * d, al.muster[1] + Math.cos(a) * d, NaN, 20)
      if (!at) return
      const tuning: { expMul: number; attackMul?: number } = { expMul: this.settings.army.expMul }
      if (u.role === 'warlord') tuning.attackMul = 3
      const spread = ((i % 7) - 3) * 2.2
      const startAt = march ? slotStart(i, now) : 0
      const m = this.g.createMob(def, u.variant, at.x, at.z, at.y, null, now, at.surface, tuning, (x) => {
        if (u.role === 'warlord') x.maxHp = x.hp = warlordHp(ev.scale, this.settings.army)
        x.aggressive = true
        x.siege = this.unit(ev, u.role, approach, lane.seg, wave, march ? 'march' : 'muster', outerPath(lane, spread, u.role), i, startAt)
        x.siege.last = [...al.muster]
        // face the town while waiting
        x.yaw = yawTowards(this.bellAt[0] - at.x, this.bellAt[1] - at.z)
      })
      if (u.role === 'warlord') ev.warlord = m.id
      ev.mobs.add(m.id)
      n++
    })
    return n
  }

  private pctOf(seg: string): number {
    const v = this.walls.views().find((x) => x.id === seg)
    return v ? v.pct : 100
  }

  /** Wave `n` starts now. */
  startWave(ev: SiegeEv, n: 1 | 2 | 3, now: number): void {
    const st = this.settings
    ev.defenders = this.defenders(now)
    ev.scale = siegeScale(ev.defenders, st.army)
    ev.phase = `wave${n}` as SiegePhase
    let spawned = 0
    if (n === 1) {
      ev.wave1At = now
      ev.endsAt = now + st.timing.durationMin * 60_000
      // each approach's column sets off row by row
      const rows = new Map<string, number>()
      for (const id of ev.mobs) {
        const m = this.g.world.mobs.get(id)
        if (!m?.siege || m.siege.mode !== 'muster') continue
        const i = rows.get(m.siege.approach) ?? 0
        rows.set(m.siege.approach, i + 1)
        m.siege.mode = 'march'
        m.siege.startAt = slotStart(i, now)
        spawned++
      }
    } else for (const a of ev.approaches) spawned += this.spawnWave(ev, a, n, true, now)
    ev.nextAt = n < 3 ? now + st.timing.waveGapMin * 60_000 : 0
    ev.waveAlive = this.foes()
    this.corridorsFor(ev)
    this.store.update(ev.id, { phase: ev.phase, wave1_at: ev.wave1At, defenders: ev.defenders })
    this.store.log(ev.id, 'wave', { wave: n, defenders: ev.defenders, scale: Math.round(ev.scale * 100) / 100, spawned }, now)
    this.notice({ t: 'siegeNotice', event: 'phase', phase: ev.phase, approaches: ev.approaches })
    if (n === 1) this.chat(`[Siege] The army attacks! Wave 1 of 3 marches on Jangan (${ev.defenders} defenders).`)
    else if (n === 2) this.chat('[Siege] Wave 2 of 3: archers and Stone Rams join the assault!')
    else this.chat('[Siege] The Bandit Warlord leads the final assault!')
    this.broadcastView(ev, now, true)
  }

  /** Siege monsters alive (the Bell excluded; fleeing sappers excluded). */
  foes(): number {
    const ev = this.ev
    if (!ev) return 0
    let n = 0
    for (const id of ev.mobs) {
      const m = this.g.world.mobs.get(id)
      if (m && m.ai !== 'dead' && m.siege && m.siege.role !== 'bell' && m.siege.mode !== 'flee') n++
    }
    return n
  }

  /** Living players of level ≥ 10 within 600 m of the town centre. */
  defenders(now: number): number {
    const c = this.townCentre()
    let n = 0
    for (const p of this.g.world.players.values()) {
      if (p.dead || p.level < DEFENDER_MIN_LEVEL || p.trance) continue
      const q = this.g.world.positionAt(p, now)
      if ((q[0] - c[0]) ** 2 + (q[2] - c[1]) ** 2 <= DEFENDER_RANGE_M ** 2) n++
    }
    return n
  }

  private townCentre(): XZ {
    const t = this.g.data.towns.find((x) => x.world === this.g.config.world && x.safeArea)
    return t?.safeArea ? [t.safeArea.x, t.safeArea.z] : this.bellAt
  }

  /** The siege ends with `outcome`. */
  end(ev: SiegeEv, outcome: SiegeOutcome, now: number, why = ''): void {
    if (ev.phase === 'ended') return
    const was = ev.phase
    ev.phase = 'ended'
    ev.outcome = outcome
    ev.endedAt = now
    for (const k of ev.kegs.values()) this.notice({ t: 'kegEnd', id: k.id, how: 'cancelled' })
    ev.kegs.clear()
    const paid = this.reward(ev, outcome, now)
    for (const id of ev.mobs) {
      const m = this.g.world.mobs.get(id)
      if (!m?.siege || m.ai === 'dead' || m.siege.role === 'bell') continue
      const al = this.lanes.find((a) => a.approach === m.siege!.approach)
      this.army.flee(m, m.siege, al?.muster ?? null)
    }
    ev.corridors = []
    this.walls.extraUnsafe = null
    this.walls.refreshZones()
    this.store.update(ev.id, { phase: 'ended', ended_at: now, outcome, breaches: ev.breaches.size, defenders: ev.defenders, stats: JSON.stringify({ lead: ev.lead, seed: ev.seed, from: was, contributors: ev.contrib.size, paid }) })
    this.store.log(ev.id, 'end', { outcome, why, from: was }, now)
    this.notice({ t: 'siegeNotice', event: 'phase', phase: 'ended', outcome })
    const top = this.ranked(ev).slice(0, 3).map((c) => `${c.name} (${Math.floor(c.points)})`)
    const line =
      outcome === 'won'
        ? `[Siege] The Bandit Warlord has fallen! Jangan is saved.${top.length ? ` Its finest defenders: ${top.join(', ')}.` : ''}`
        : outcome === 'lost_bell'
          ? '[Siege] The Town Bell has fallen. The army plunders and withdraws; the breaches stay open until they are repaired.'
          : outcome === 'lost_time'
            ? '[Siege] The Warlord withdraws with his loot. The breaches stay open until they are repaired.'
            : `[Siege] The siege is called off${why ? ` (${why})` : ''}.`
    this.chat(line)
    this.broadcastView(ev, now, true)
    this.g.config.log(`siege: event ${ev.id} ended ${outcome}${why ? ` (${why})` : ''}; ${ev.breaches.size} breaches, ${ev.contrib.size} contributors`)
  }

  /** After the end: the Bell leaves; the event is forgotten once nothing of it is left. */
  private cleanupEnded(now: number, force = false): void {
    const ev = this.ev
    if (!ev || ev.phase !== 'ended') return
    if (!force && now < ev.endedAt + BELL_LEAVE_MS) return
    for (const id of ev.mobs) if (this.g.world.mobs.has(id)) this.g.world.removeEntity(id)
    if (ev.bell !== null && this.g.world.mobs.has(ev.bell)) this.g.world.removeEntity(ev.bell)
    this.ev = null
  }

  // ---- rewards -----------------------------------------------------------------------------------------------

  private ranked(ev: SiegeEv): Contrib[] {
    return [...ev.contrib.values()].filter((c) => Math.floor(c.points) > 0).sort((a, b) => b.points - a.points || a.characterId - b.characterId)
  }

  /** Pays the defenders online (gold, seals, the title); a row per contributor; `siegeReward` to each one online. */
  private reward(ev: SiegeEv, outcome: SiegeOutcome, now: number): { gold: number; seals: number; titles: number } {
    const total = { gold: 0, seals: 0, titles: 0 }
    if (outcome === 'restart') return total
    const rs = this.settings.rewards
    const list = this.ranked(ev)
    const top = list.slice(0, 5).map((c) => ({ name: c.name, points: Math.floor(c.points) }))
    const online = new Map<number, Player>()
    for (const p of this.g.world.players.values()) online.set(p.characterId, p)
    const sealDef = this.g.data.items.get(SIEGE_EVENT_CODES.seal)
    let place = 0
    for (const c of list) {
      const pts = Math.floor(c.points)
      const p = online.get(c.characterId)
      // §6.6 associates: the siege's traitors (layer 5 kegs) and their associates get nothing
      const barred = this.g.law.barredFromSiege(ev.id, c.characterId, p ?? null)
      const rank = pts >= rs.minPoints && !barred ? ++place : 0
      const r = barred ? { gold: 0, seals: 0, title: false } : siegeReward(pts, rank, outcome, rs)
      let gold = 0
      let seals = 0
      let title: string | undefined
      if (p) {
        if (r.gold > 0) {
          const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => addGold(d, r.gold))
          if (result.ok) {
            this.g.afterInventory(p, draft)
            gold = r.gold
          }
        }
        if (r.seals > 0 && sealDef) {
          const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => addItem(d, sealDef, r.seals))
          if (result.ok) {
            this.g.afterInventory(p, draft)
            seals = r.seals
          } else this.store.log(ev.id, 'reward', { character: c.characterId, seals: r.seals, granted: false, why: result.message ?? 'bag full' }, now)
        }
        if (r.title) {
          title = SIEGE_HONOR
          if (this.store.grantHonor(p.characterId, SIEGE_HONOR, now)) {
            this.honors.set(p.characterId, SIEGE_HONOR)
            this.g.pilot?.honorGranted(p.characterId, SIEGE_HONOR)
            this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, honor: SIEGE_HONOR })
            total.titles++
          }
        }
      }
      total.gold += gold
      total.seals += seals
      this.store.saveContrib(ev.id, c.characterId, pts, gold, seals)
      if (p) {
        const reward: Extract<ServerMessage, { t: 'siegeReward' }>['reward'] = { event: ev.id, outcome, points: pts, rank, of: list.length, gold, seals, top, parts: roundParts(c.parts) }
        if (title) reward.title = title
        p.send({ t: 'siegeReward', reward })
      }
    }
    this.store.log(ev.id, 'reward', { outcome, defenders: list.length, ...total }, now)
    return total
  }

  private contrib(p: Player, kind: SiegeContribKind, points: number): Contrib | null {
    const ev = this.ev
    if (!ev || ev.phase === 'ended' || !(points > 0)) return null
    let c = ev.contrib.get(p.characterId)
    if (!c) {
      c = { characterId: p.characterId, name: p.name, points: 0, parts: {}, donated: 0, bellAt: 0 }
      ev.contrib.set(p.characterId, c)
    }
    c.points += points
    c.parts[kind] = (c.parts[kind] ?? 0) + points
    return c
  }

  private playerOf(characterId: number): Player | null {
    for (const p of this.g.world.players.values()) if (p.characterId === characterId) return p
    return null
  }

  // ---- hooks from Gameplay and the walls ------------------------------------------------------------------------

  /** Gameplay.dealHits: damage to siege monsters counts (1 point per 100). */
  onHits(a: Player | Mob, t: Player | Mob | { kind: string; id: number }, dealt: number, _now: number): void {
    if (a.kind !== 'player' || t.kind !== 'mob' || dealt <= 0 || !this.running()) return
    const m = t as Mob
    if (!m.siege || m.siege.role === 'bell' || m.siege.event !== this.ev!.id) return
    this.contrib(a, 'damage', dealt / SIEGE_POINTS.damagePer)
  }

  /**
   * Gameplay.dealHits, before any damage: a player's hit on the Town Bell repairs it instead (bell.repairPct of its HP, at
   * most every 2 s per defender, 15 points). True = the hit was taken here (nothing else happens).
   */
  bellHit(a: Player | Mob, t: Player | Mob, now: number): boolean {
    if (t.kind !== 'mob' || t.siege?.role !== 'bell') return false
    if (a.kind !== 'player') return false
    const ev = this.ev
    if (!ev || ev.phase === 'ended' || ev.phase === 'warning' || t.ai === 'dead') return true
    const c = ev.contrib.get(a.characterId)
    if (c && now - c.bellAt < BELL_REPAIR_MS) return true
    if (t.hp >= t.maxHp) return true
    t.hp = Math.min(t.maxHp, t.hp + Math.max(1, Math.round((this.settings.bell.repairPct / 100) * t.maxHp)))
    this.g.world.broadcastAbout(t, { t: 'entityUpdate', id: t.id, hp: Math.round(t.hp) })
    const got = this.contrib(a, 'bell', SIEGE_POINTS.bell)
    if (got) got.bellAt = now
    return true
  }

  /** Gameplay's loot: siege monsters drop nothing but, at 2 %, Saltpeter (layer 5; null: not a siege monster). */
  drops(m: Mob): RolledDrop[] | null {
    if (!m.siege) return null
    if (m.siege.role === 'bell' || !this.g.data.items.has(LAW_CODES.saltpeter)) return []
    return this.g.rng() < SALTPETER_DROP ? [{ code: LAW_CODES.saltpeter, count: 1 }] : []
  }

  mobDied(m: Mob, _now: number, _credit: ReadonlySet<number>, owner: KillOwner): void {
    const s = m.siege
    const ev = this.ev
    if (!s || !ev || s.event !== ev.id) return
    if (s.role === 'sapper' && !s.planted && ev.phase !== 'ended' && owner.player) this.contrib(owner.player, 'sapper', SIEGE_POINTS.sapper)
  }

  /** The walls: breaches during the siege; kit repairs and donations count. */
  private onWall(e: WallEvent): void {
    const ev = this.ev
    if (!ev || ev.phase === 'ended') return
    if (!wallOpen(e.stageBefore) && wallOpen(e.stage)) {
      ev.breaches.add(e.id)
      this.store.update(ev.id, { breaches: ev.breaches.size })
      this.store.log(ev.id, 'breach', { seg: e.id, cause: e.cause }, e.at)
      // a player's Thunder Keg: the law names the traitor (law.ts); the army pours in all the same
      if (e.cause !== 'keg') {
        this.notice({ t: 'siegeNotice', event: 'breach', wall: e.id })
        this.chat(`[Siege] ${cap(wallName(e.id))} is breached! The army pours toward the Town Bell.`)
      }
      this.corridorsFor(ev)
    }
    if (e.characterId === null) return
    const p = this.playerOf(e.characterId)
    if (!p) return
    if (e.cause === 'kit' && e.delta > 0) this.contrib(p, 'kit', (SIEGE_POINTS.kitPerPct * 100 * e.delta) / this.walls.settings.maxIp)
    if (e.cause === 'donation' && typeof e.data.gold === 'number' && e.data.gold > 0) {
      const c = this.contrib(p, 'donation', 0.000001)
      if (!c) return
      const before = Math.min(SIEGE_POINTS.donationCap, Math.floor(c.donated / SIEGE_POINTS.donationPer) * SIEGE_POINTS.donation)
      c.donated += e.data.gold
      const after = Math.min(SIEGE_POINTS.donationCap, Math.floor(c.donated / SIEGE_POINTS.donationPer) * SIEGE_POINTS.donation)
      if (after > before) this.contrib(p, 'donation', after - before)
    }
  }

  /** Ground that is not safe during a wave: the Bell's circle and the lanes from every open gap to it. */
  private corridorsFor(ev: SiegeEv): void {
    const legs: [XZ, XZ][] = []
    for (const al of this.lanes) {
      for (const l of al.lanes) {
        const st = this.walls.stageOf(l.seg)
        if (!st || !wallOpen(st)) continue
        const pts: XZ[] = [l.rally, ...l.inner, this.bellAt]
        for (let i = 0; i + 1 < pts.length; i++) legs.push([pts[i]!, pts[i + 1]!])
      }
    }
    ev.corridors = legs
    const zone = this.settings.bell.zoneM
    const bell = this.bellAt
    this.walls.extraUnsafe =
      ev.phase === 'ended' || ev.phase === 'warning'
        ? null
        : (x, z) => (x - bell[0]) ** 2 + (z - bell[1]) ** 2 <= zone * zone || legs.some(([a, b]) => distToLeg([x, z], a, b) <= CORRIDOR_M)
  }

  private wallHit(m: Mob, lane: Lane, at: Vec3): void {
    const s = m.siege!
    const a = this.settings.army
    const ip = s.role === 'ram' ? a.ramIp : s.role === 'warlord' ? a.warlordIp : a.raiderIp
    // a raider swings only while no defender stands near (the army checks); the wall takes it
    this.walls.change(lane.seg, -ip, s.role === 'ram' ? 'ram' : s.role === 'warlord' ? 'warlord' : 'raider', this.g.now, { at, fx: 'chip', data: { mob: m.id } })
  }

  private planted(m: Mob, lane: Lane, at: Vec3): void {
    const ev = this.ev
    if (!ev || ev.phase === 'ended') return
    const now = this.g.now
    const k: Keg = { id: nextKegId(), seg: lane.seg, at, fuseEndsAt: now + this.settings.army.fuseSec * 1000, sapper: m.id, defuse: null }
    ev.kegs.set(k.id, k)
    this.sendKeg(k)
    this.notice({ t: 'siegeNotice', event: 'plant', wall: lane.seg })
    this.store.log(ev.id, 'plant', { seg: lane.seg, keg: k.id }, now)
    // the sapper runs for another keg
    const al = this.lanes.find((a) => a.approach === m.siege!.approach)
    this.army.flee(m, m.siege!, al?.muster ?? null)
  }

  private sendKeg(k: Keg): void {
    this.notice(kegMessage(k, true))
  }

  private tickKegs(ev: SiegeEv, now: number): void {
    for (const k of [...ev.kegs.values()]) {
      const d = defuseStep(this.g, k, now)
      if (d?.state === 'broken') {
        k.defuse = null
        this.sendKeg(k)
      } else if (d?.state === 'done') {
        ev.kegs.delete(k.id)
        this.notice({ t: 'kegEnd', id: k.id, how: 'defused' })
        this.notice({ t: 'siegeNotice', event: 'defused', wall: k.seg, name: d.p.name })
        this.contrib(d.p, 'defuse', SIEGE_POINTS.defuse)
        this.store.log(ev.id, 'defused', { seg: k.seg, keg: k.id, by: d.p.name }, now)
        continue
      }
      if (now < k.fuseEndsAt) continue
      ev.kegs.delete(k.id)
      this.blast(ev, k, now)
    }
  }

  private blast(ev: SiegeEv, k: Keg, now: number): void {
    this.notice({ t: 'kegEnd', id: k.id, how: 'blast' })
    this.walls.change(k.seg, -this.settings.army.sapperIp, 'sapper', now, { at: k.at, fx: 'chip', data: { keg: k.id } })
    this.store.log(ev.id, 'blast', { seg: k.seg, keg: k.id }, now)
    blastHurt(this.g, k.at, now)
  }

  /** Layer 5: a player's Thunder Keg defused during a siege counts as a defused keg (siege/keg.ts). */
  creditDefuse(p: Player): void {
    if (this.running()) this.contrib(p, 'defuse', SIEGE_POINTS.defuse)
  }

  // ---- requests ----------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (msg.t !== 'kegDefuse') return answer(fail('not_found'))
    const ev = this.ev
    const k = ev?.kegs.get(msg.id)
    // not a sapper's keg: the players' Thunder Kegs (layer 5)
    if (!ev || !k) return this.g.kegs.defuse(p, msg.id, answer, now)
    const q = this.g.world.positionAt(p, now)
    if (Math.hypot(q[0] - k.at[0], q[2] - k.at[2]) > KEG_DEFUSE_M) return answer(fail('too_far', 'Get closer to the keg to defuse it.'))
    if (k.defuse && k.defuse.player !== p.id) return answer(fail('busy', 'Someone is defusing it already.'))
    beginDefuse(this.g, p, k, this.settings.army.defuseSec, now)
    this.sendKeg(k)
    answer(true)
  }

  forget(p: Player): void {
    for (const k of this.ev?.kegs.values() ?? []) if (k.defuse?.player === p.id) k.defuse = null
  }

  enter(p: Player, now: number): void {
    const ev = this.ev
    if (!ev) return
    p.send({ t: 'siegeEvent', view: this.view(ev, now) })
    for (const k of ev.kegs.values()) p.send(kegMessage(k, true))
  }

  // ---- the tick ------------------------------------------------------------------------------------------------

  tick(now: number): void {
    this.boot(now)
    this.schedule(now)
    const ev = this.ev
    if (!ev) return
    if (ev.phase === 'ended') {
      if (now - ev.armyAt >= ARMY_STEP_MS) {
        ev.armyAt = now
        this.army.tick(this.mobsOf(ev))
      }
      this.cleanupEnded(now)
      return
    }
    // the Bell and the Warlord, whatever killed them (a GM kill has no mobDied)
    if (ev.bell !== null && !this.bellMob()) return this.end(ev, 'lost_bell', now)
    if (ev.warlord !== null && !this.warlordMob()) return this.end(ev, 'won', now)
    if (ev.phase === 'warning') {
      for (const min of COUNTDOWN_MIN) {
        const left = ev.wave1At - now
        if (!ev.said.has(min) && left <= min * 60_000 && left > (min - 1) * 60_000 + 1000 && left > 0) {
          ev.said.add(min)
          this.chat(`[Siege] The army reaches Jangan's walls in ${min} minute${min === 1 ? '' : 's'}!`)
        }
      }
      if (now >= ev.wave1At) this.startWave(ev, 1, now)
    } else {
      if (now >= ev.endsAt) return this.end(ev, 'lost_time', now)
      const wave = waveOf(ev.phase)
      if (wave < 3) {
        const alive = this.foes()
        const early = ev.waveAlive > 0 && alive <= ev.waveAlive * (1 - this.settings.timing.earlyPct / 100)
        if (now >= ev.nextAt || early) this.startWave(ev, (wave + 1) as 2 | 3, now)
      }
    }
    if (now - ev.armyAt >= ARMY_STEP_MS) {
      ev.armyAt = now
      this.army.tick(this.mobsOf(ev))
      this.sweep(ev)
    }
    this.tickKegs(ev, now)
    this.broadcastView(ev, now)
    if (now - ev.savedAt >= SAVE_EVERY_MS) {
      ev.savedAt = now
      this.store.update(ev.id, { breaches: ev.breaches.size, defenders: ev.defenders })
    }
  }

  private *mobsOf(ev: SiegeEv): Iterable<Mob> {
    for (const id of [...ev.mobs]) {
      const m = this.g.world.mobs.get(id)
      if (m) yield m
    }
  }

  /** Forgets siege monsters that are gone (killed and removed, GM removed). */
  private sweep(ev: SiegeEv): void {
    for (const id of [...ev.mobs]) {
      const m = this.g.world.mobs.get(id)
      if (!m || m.ai === 'dead') ev.mobs.delete(id)
    }
  }

  view(ev: SiegeEv, _now: number): SiegeView {
    const v: SiegeView = { id: ev.id, phase: ev.phase, approaches: [...ev.approaches], defenders: ev.defenders, foes: this.foes(), breaches: ev.breaches.size }
    if (ev.phase === 'warning') v.nextAt = ev.wave1At
    else if (ev.phase === 'wave1' || ev.phase === 'wave2') v.nextAt = ev.nextAt
    if (ev.endsAt > 0 && ev.phase !== 'ended') v.endsAt = ev.endsAt
    const bell = this.bellMob()
    if (bell) v.bellPct = Math.round((1000 * bell.hp) / bell.maxHp) / 10
    else if (ev.bell !== null) v.bellPct = 0
    const w = ev.phase === 'ended' ? null : this.warlordMob()
    if (w) v.warlordPct = Math.round((1000 * w.hp) / w.maxHp) / 10
    if (ev.outcome) v.outcome = ev.outcome
    return v
  }

  /** `siegeEvent` to every world player when it changed (at most once a second unless forced). */
  broadcastView(ev: SiegeEv, now: number, force = false): void {
    const v = this.view(ev, now)
    const json = JSON.stringify(v)
    if (json === ev.sent && !force) return
    if (!force && now - ev.sentAt < VIEW_EVERY_MS) return
    ev.sent = json
    ev.sentAt = now
    for (const p of this.g.world.players.values()) p.send({ t: 'siegeEvent', view: v })
  }

  private notice(msg: ServerMessage): void {
    for (const p of this.g.world.players.values()) p.send(msg)
  }

  private chat(text: string): void {
    for (const p of this.g.world.players.values()) p.send({ t: 'chat', channel: 'system', text })
  }

  // ---- the schedule and restarts ----------------------------------------------------------------------------------

  /**
   * The weekly schedule, every tick: a slot starts the warning. Skipped (a `skipped` row): fewer than `minPlayers`
   * eligible players online, more than 30 min late (the server was down), a siege already running. A Night of the
   * Tiger running: wait `tigerWaitMin`, twice at most, then skipped.
   */
  schedule(now: number): void {
    if (!this.on) return
    const st = this.settings
    const key = JSON.stringify([st.enabled, st.schedule])
    if (key !== this.schedKey) {
      this.schedKey = key
      this.next = st.enabled ? nextSlotAt(st.schedule.slots, st.schedule.tz, now) : null
      this.waits = 0
      this.waitUntil = 0
    }
    const slot = this.next
    if (slot === null || now < Math.max(slot, this.waitUntil)) return
    const due = Math.max(slot, this.waitUntil)
    const skip = (why: string) => {
      this.next = nextSlotAt(st.schedule.slots, st.schedule.tz, Math.max(slot, now))
      this.waits = 0
      this.waitUntil = 0
      const id = this.store.create('schedule', 'ended', now, null, [], { slot, why })
      this.store.update(id, { ended_at: now, outcome: 'skipped' })
      this.store.log(id, 'skipped', { slot, why }, now)
      this.g.config.log(`siege: the siege of ${new Date(slot).toISOString()} is skipped: ${why}`)
    }
    if (now - due > MISSED_GRACE_MS) return skip(`${Math.round((now - due) / 60_000)} min late (the server was down)`)
    if (this.running()) return skip('a siege is running')
    const tiger = this.tigerWhy()
    if (tiger) {
      if (this.waits < 2) {
        this.waits++
        this.waitUntil = now + st.timing.tigerWaitMin * 60_000
        this.g.config.log(`siege: the siege of ${new Date(slot).toISOString()} waits ${st.timing.tigerWaitMin} min: ${tiger}`)
        return
      }
      return skip(tiger)
    }
    const eligible = [...this.g.world.players.values()].filter((p) => p.level >= DEFENDER_MIN_LEVEL).length
    if (eligible < st.timing.minPlayers) return skip(`only ${eligible} eligible players online (${st.timing.minPlayers} needed)`)
    this.next = nextSlotAt(st.schedule.slots, st.schedule.tz, Math.max(slot, now))
    this.waits = 0
    this.waitUntil = 0
    this.start('schedule', undefined, now)
  }

  /** A Night of the Tiger is on (call, draw or hunt), or null. */
  tigerWhy(): string | null {
    const ev = this.g.pilot?.event
    return ev && ev.phase !== 'ended' ? `a Night of the Tiger is on (${ev.phase})` : null
  }

  /** Once, at the first tick: the settings, and a siege found open (a restart). */
  private boot(now: number): void {
    if (this.booted) return
    this.booted = true
    this.loadSettings()
    let rows: SiegeEventRow[] = []
    try {
      rows = this.store.open()
    } catch {
      rows = []
    }
    for (const r of rows) this.recover(r, now)
  }

  /** A siege found open at boot: the warning resumes (at least 3 min left); a wave ends `restart` (nothing paid). */
  private recover(r: SiegeEventRow, now: number): void {
    let stats: { lead?: SiegeApproach; seed?: number } = {}
    try {
      stats = JSON.parse(r.stats) as typeof stats
    } catch {
      stats = {}
    }
    let approaches: SiegeApproach[] = []
    try {
      approaches = (JSON.parse(r.approaches) as string[]).filter((a): a is SiegeApproach => SIEGE_APPROACHES.includes(a as SiegeApproach))
    } catch {
      approaches = []
    }
    if (r.phase !== 'warning' || this.running() || !this.on || !approaches.length) {
      this.store.update(r.id, { phase: 'ended', ended_at: now, outcome: 'restart' })
      this.store.log(r.id, 'end', { outcome: 'restart', from: r.phase }, now)
      this.g.config.log(`siege: event ${r.id} (${r.phase}) ended by the restart`)
      return
    }
    const wave1At = Math.max(r.wave1_at ?? now, now + RESUME_MIN_MS)
    const origin = r.origin === 'schedule' || r.origin === 'admin' ? r.origin : 'gm'
    const ev = this.makeEvent(r.id, origin, r.created_at, wave1At, approaches, stats.lead ?? approaches[0]!, (stats.seed ?? r.id) >>> 0)
    this.ev = ev
    this.store.update(r.id, { wave1_at: wave1At })
    this.store.log(r.id, 'restart', { phase: 'warning', wave1At }, now)
    this.beginWarning(ev, now)
    this.g.config.log(`siege: event ${r.id} resumes its warning after the restart; wave 1 in ${Math.round((wave1At - now) / 1000)} s`)
  }

  // ---- titles (only without Play the Boss, which shows them itself) ----------------------------------------------

  private honorOf(characterId: number): string | null {
    let h = this.honors.get(characterId)
    if (h === undefined) {
      try {
        h = (this.g.store.db.prepare('SELECT code FROM pilot_honors WHERE character_id = ? ORDER BY at DESC LIMIT 1').get(characterId) as { code: string } | undefined)?.code ?? null
      } catch {
        h = null
      }
      this.honors.set(characterId, h)
    }
    return h
  }

  // ---- GM `siege` (docs/SIEGE.md §12) ------------------------------------------------------------------------------

  /** Stops the running siege (GM, admin). */
  stop(who: string, now: number): { ok: true; message: string } | { ok: false; status: number; message: string } {
    const ev = this.ev
    if (!ev || ev.phase === 'ended') return { ok: false, status: 409, message: 'No siege is running.' }
    this.end(ev, 'cancelled', now, `stopped by ${who}`)
    return { ok: true, message: `The siege (event ${ev.id}) is called off; no rewards. The army withdraws.` }
  }

  gm(self: Player | null, args: string[], now: number): GmResult {
    const a = args.map((x) => x.trim()).filter(Boolean)
    const verb = (a[0] ?? 'status').toLowerCase()
    const who = self?.name ?? 'a GM'
    if (verb === 'status') return this.status(now)
    if (verb === 'lanes') {
      const lines = this.lanes.map((x) => `${x.approach} (${x.name}): ${x.lanes.map((l) => l.seg).join(', ') || 'none'}${x.dropped.length ? `; dropped ${x.dropped.map((d) => `${d.seg} (${d.why})`).join(', ')}` : ''}`)
      return { ok: true, message: `Siege lanes (${this.wards.length} gate wards):\n${lines.join('\n') || 'none'}${this.problem ? `\nOff: ${this.problem}` : ''}` }
    }
    if (verb === 'army') {
      const ev = this.ev
      if (!ev) return { ok: true, message: 'No siege is running.' }
      const lines: string[] = []
      for (const m of this.mobsOf(ev)) {
        const s = m.siege
        if (!s || m.ai === 'dead') continue
        const p = this.g.world.positionAt(m, now)
        lines.push(`#${m.id} ${s.role} ${s.mode}${s.mode === 'engage' ? ` (${m.ai})` : ''} ${s.approach}/${s.seg || '-'} at ${p[0].toFixed(0)},${p[2].toFixed(0)}${s.path.length ? ` → ${s.path[0]![0].toFixed(0)},${s.path[0]![1].toFixed(0)} (+${s.path.length - 1})` : ''} ${Math.round((100 * m.hp) / m.maxHp)}%`)
      }
      return { ok: true, message: `Siege army (${lines.length}):\n${lines.slice(0, 60).join('\n')}` }
    }
    if (verb === 'start') {
      if (a.length > 2 || (a[1] !== undefined && !/^\d{1,2}(\.\d+)?$/.test(a[1]))) return { ok: false, message: 'Usage: siege start [warning minutes 0-60]' }
      const r = this.start('gm', a[1] === undefined ? undefined : Number(a[1]), now)
      return r.ok ? { ok: true, message: r.message, data: { event: r.event.id } } : { ok: false, message: r.message }
    }
    if (verb === 'stop') {
      const r = this.stop(who, now)
      return { ok: r.ok, message: r.message }
    }
    const ev = this.ev
    if (verb === 'wave') {
      const n = Number(a[1])
      if (!ev || ev.phase === 'ended') return { ok: false, message: 'No siege is running (siege start first).' }
      if (![1, 2, 3].includes(n)) return { ok: false, message: 'Usage: siege wave <1-3>' }
      if (n <= waveOf(ev.phase)) return { ok: false, message: `Wave ${waveOf(ev.phase)} is on already.` }
      for (let w = waveOf(ev.phase) + 1; w <= n; w++) this.startWave(ev, w as 1 | 2 | 3, now)
      return { ok: true, message: `Wave ${n} attacks now.` }
    }
    if (verb === 'warlord') {
      if (!ev || ev.phase === 'ended') return { ok: false, message: 'No siege is running (siege start first).' }
      if (this.warlordMob()) return { ok: false, message: 'The Warlord is in the field already.' }
      const before = ev.warlord
      const lead = ev.lead
      const al = this.lanes.find((x) => x.approach === lead)
      if (!al) return { ok: false, message: 'His approach has no lane.' }
      ev.warlord = null
      this.spawnWave(ev, lead, 3, true, now)
      if (ev.warlord === null) {
        ev.warlord = before
        return { ok: false, message: 'The Warlord could not be placed.' }
      }
      if (ev.phase !== 'wave3') {
        ev.phase = 'wave3'
        ev.nextAt = 0
        if (!ev.endsAt) ev.endsAt = now + this.settings.timing.durationMin * 60_000
        this.notice({ t: 'siegeNotice', event: 'phase', phase: 'wave3', approaches: ev.approaches })
      }
      this.broadcastView(ev, now, true)
      return { ok: true, message: `The Bandit Warlord and wave 3 march from ${this.approachNames([lead])}.` }
    }
    return { ok: false, message: `Usage: ${SIEGE_USAGE}` }
  }

  status(now: number): GmResult {
    const ev = this.ev
    if (!this.on) return { ok: true, message: `The Siege of Jangan is off (${this.problem || 'no lanes'}).` }
    const nextLine = this.next !== null ? `Next scheduled siege: ${new Date(this.next).toISOString().slice(0, 16).replace('T', ' ')} UTC${this.waitUntil > now ? ` (waiting for a Night of the Tiger until ${new Date(this.waitUntil).toISOString().slice(11, 16)})` : ''}.` : `The weekly siege is ${this.settings.enabled ? 'on, without slots' : 'off'}.`
    if (!ev) return { ok: true, message: `No siege is running. ${nextLine} /siege start [minutes] begins one.` }
    const v = this.view(ev, now)
    const left = (t?: number) => (t ? `${Math.max(0, Math.round((t - now) / 1000))} s` : '-')
    const roles = new Map<string, number>()
    for (const m of this.mobsOf(ev)) if (m.siege && m.ai !== 'dead') roles.set(`${m.siege.role}:${m.siege.mode}`, (roles.get(`${m.siege.role}:${m.siege.mode}`) ?? 0) + 1)
    const lines = [
      `Siege event ${ev.id} (${ev.origin}): ${ev.phase}${ev.outcome ? ` (${ev.outcome})` : ''}, from ${ev.approaches.join(', ')} (Warlord: ${ev.lead})`,
      `next wave in ${left(v.nextAt)}, ends in ${left(v.endsAt)}; Bell ${v.bellPct ?? '-'}%, Warlord ${v.warlordPct ?? '-'}%`,
      `defenders ${ev.defenders} (scale ×${ev.scale.toFixed(2)}), foes ${v.foes}, breaches ${[...ev.breaches].join(', ') || 'none'}, kegs ${ev.kegs.size}, contributors ${ev.contrib.size}`,
      `army: ${[...roles].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`,
      nextLine,
    ]
    return { ok: true, message: lines.join('\n'), data: v }
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function roundParts(p: Partial<Record<SiegeContribKind, number>>): Partial<Record<SiegeContribKind, number>> {
  const out: Partial<Record<SiegeContribKind, number>> = {}
  for (const [k, v] of Object.entries(p) as [SiegeContribKind, number][]) {
    const n = Math.floor(v)
    if (n > 0) out[k] = n
  }
  return out
}

/** content/siege/jangan.json `settings.siege` (a sparse patch over SIEGE_EVENT_DEFAULTS), or {} (problems logged). */
function readContentPatch(g: Gameplay): SiegeEventPatch {
  return g.config.contentDir ? readPatchFile(g.config.contentDir, g.config.log) : {}
}

function readPatchFile(dir: string, log: (line: string) => void): SiegeEventPatch {
  const file = join(dir, 'siege', 'jangan.json')
  if (!existsSync(file)) return {}
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { settings?: { siege?: SiegeEventPatch } }
    const patch = v.settings?.siege ?? {}
    const issues = checkSiegeEventSettings(patch)
    if (issues.length) {
      log(`siege: ${file} settings.siege: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}; defaults used`)
      return {}
    }
    return patch
  } catch (e) {
    log(`siege: ${file}: ${(e as Error).message}; defaults used`)
    return {}
  }
}


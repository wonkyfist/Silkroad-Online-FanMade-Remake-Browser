import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FENCE_SPOT,
  JOB_CODES,
  JOB_IDS,
  JOB_LICENCE_NPC,
  JOB_NAMES,
  JOB_SERVICE,
  JOB_SETTINGS_BOUNDS,
  JOB_SETTINGS_DEFAULTS,
  JOBS_CONTENT,
  LAW_CODES,
  checkJobSettings,
  checkJobsContent,
  fenceNpc,
  hunterRankOfLevel,
  inStockade,
  installJobsContent,
  jobLevelExp,
  jobLevelName,
  jobLevelOf,
  jobNextExp,
  jobPostNpcs,
  jobSide,
  joinRefusal,
  mergeJobPatch,
  mergeJobSettings,
  pruneJobPatch,
  unsetJobPaths,
  JOB_SETTING_PATHS,
  type AdminJobsView,
  type GameplayRequest,
  type JobBadge,
  type JobId,
  type JobRequest,
  type JobSettings,
  type JobSettingsPatch,
  type JobSide,
  type JobView,
  type JobsContent,
  type JoinRefusal,
  type NpcService,
} from '@sro/shared'
import { addBaseNpc } from '../editors/overrides.ts'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import { addGold, fail, type Fail } from '../inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from '../modules.ts'
import type { Player } from '../world.ts'
import { JobStore, type JobRow } from './job-store.ts'
import { registerJobsAdmin } from './jobs-admin.ts'

/**
 * The job system, layer 1: the jobs core (docs/JOBS.md §2, §3, §4, §9). A GameplayModule named `jobs`, after the
 * Hunters (siege/hunters.ts keeps the bounties, the Net, pings and captures; this module owns who holds which job).
 *
 * - **Content**: content/jobs/jobs.json (else the built-in JOBS_CONTENT): the goods, the four trade posts and their
 *   traders (installed, with Old Fang when the walls did not install him, on a world export that has Jodaesan), the den,
 *   the transports.
 * - **Joining** (`jobJoin {npc, job}`): the Trader licence at Jodaesan (`trader` service), the Thief's at Old Fang
 *   (`thief`), the Hunter's at Captain Yun (the existing `hunterLicence`, which asks `joinProblem` here). Level
 *   `jobs.minLevel`, not Wanted, not jailed, one job per character, one side per account (`account_jobs`: no joining the
 *   other side while another character holds a job of the old side, nor within `sideChangeDays` of the last change),
 *   `leaveWaitDays` after a character of the account left a job; `jobs.licenceGold`.
 * - **Leaving** (`jobLeave {npc}` at the job's NPC): refused while Wanted, jailed, in job mode, or a revoked Hunter; the
 *   row (level, EXP, captures) is gone and the account waits `leaveWaitDays`.
 * - **Job mode** (`jobMode {on}`, the suit; `hunterDuty` stays the Hunters' alias): on in a safe area (Traders; Hunters
 *   through HunterService.setDuty) or within `mode.thiefDressM` of Old Fang or the den (Thieves), out of combat, not
 *   jailed; off refused for `mode.offLockMin` after a PvP hit. EntityState.job while on.
 * - **PvP** (HunterService.side asks `pvpSide`): the job rows of `pvpAllowed`, towns, the stockade and the 12 m rings
 *   of the posts and the den safe (`inJobSafe`).
 * - **Job EXP** (`addExp`): levels 1-7 by `jobs.levels`; a Hunter's rank (the badge) is its level − 1. Sources today:
 *   a wall-breaker captured (`exp.hunterWallCapture`); the trade, transports and robbery (layers 2-4) add theirs.
 * - **Settings**: a sparse patch in `job_settings` (code `jobs`) over JOB_SETTINGS_DEFAULTS; GM `job`; admin routes.
 */

export const JOB_SETTINGS_CODE = 'jobs'
const OUT_OF_COMBAT_MS = 10_000
const DAY_MS = 86_400_000

const REFUSAL_TEXT: Record<JoinRefusal, string> = {
  disabled: 'There are no jobs on this server.',
  level: 'Jobs are for level {level} and up.',
  has_job: 'You already have a job: leave it first (at its NPC).',
  wanted: 'Not while you are Wanted.',
  jailed: 'Not from the Garrison Stockade.',
  wrong_side: 'Your account holds jobs on the other side ({others}): one side per account. Leave those jobs first.',
  side_wait: 'Your account changed sides not long ago: come back in {days} day(s).',
  leave_wait: 'A character of your account left a job not long ago: come back in {days} day(s).',
}

/** A refusal's ActionFailReason (no new reasons: the text says which rule). */
const REFUSAL_REASON: Record<JoinRefusal, 'not_found' | 'requirements' | 'not_usable' | 'jailed' | 'cooldown'> = {
  disabled: 'not_found',
  level: 'requirements',
  has_job: 'not_usable',
  wanted: 'not_usable',
  jailed: 'jailed',
  wrong_side: 'requirements',
  side_wait: 'cooldown',
  leave_wait: 'cooldown',
}

export class JobService implements GameplayModule {
  readonly name = 'jobs'
  readonly handles: readonly GameplayRequest[] = ['jobJoin', 'jobLeave', 'jobMode'] satisfies readonly JobRequest[]
  content: JobsContent
  /** Where the content came from (the file, or 'built-in' and why). */
  readonly contentSource: string
  /** Whether the post traders (and Old Fang) stand in this world (an export with Jodaesan). */
  readonly placed: boolean
  /** characterId -> the char_jobs row (null: no job), loaded on demand. */
  private readonly rows = new Map<number, JobRow | null>()
  /** Seams for layers 2-4: refuse job mode off / leaving while a loaded transport or stolen goods are carried. */
  readonly carrying: ((p: Player) => string | null)[] = []
  private storeCache: JobStore | null = null
  private settingsCache: { patch: JobSettingsPatch; effective: JobSettings; rev: number } | null = null

  constructor(private readonly g: Gameplay) {
    registerJobsAdmin()
    const read = readJobsContent(g.config.contentDir)
    this.content = read.content
    this.contentSource = read.source
    if (read.problem) g.config.log(`jobs: ${read.problem}; using the built-in content`)
    g.world.decorators.push((e, s) => {
      if (e.kind !== 'player') return
      const b = this.badgeOf(e.characterId)
      if (b) s.job = b
    })
    const d = g.data
    this.placed = d.npcs.some((n) => n.code === JOB_CODES.traderNpc && n.world === g.config.world)
    if (!this.placed) return
    installJobsContent({ npcs: d.npcs }, g.config.world, this.content)
    for (const { npc, base } of jobPostNpcs(this.content, g.config.world)) {
      const def = d.npcs.find((n) => n.code === npc.code) ?? npc
      if (!d.npcModel.has(def.code)) d.npcModel.set(def.code, base)
      addBaseNpc(d, def, d.npcModel.get(def.code))
    }
    // Old Fang licenses the Thieves even where the walls (and his kegs) are off
    if (!d.npcs.some((n) => n.code === LAW_CODES.fence)) {
      const fang = fenceNpc(g.config.world)
      d.npcs.push(fang)
      if (!d.npcModel.has(fang.code)) d.npcModel.set(fang.code, LAW_CODES.fenceBase)
      addBaseNpc(d, fang, d.npcModel.get(fang.code))
    }
    g.config.log(`jobs: the trade posts stand (${this.content.posts.length - 1} traders, content ${this.contentSource})`)
  }

  /** Tests: other content (posts and the den inside a small test world). */
  configure(o: { content?: Partial<JobsContent> }): void {
    if (o.content) this.content = { ...this.content, ...o.content }
  }

  /** Where NPC `code` stands in this world (the live entity; the GM NPC editor may have moved it). */
  private npcAt(code: string): { x: number; z: number } | null {
    for (const n of this.g.world.npcs.values()) if (n.code === code) return { x: n.pos[0], z: n.pos[2] }
    return null
  }

  /** The Bandit Den (Seopok where he stands, else the content's spot). */
  private den(): { x: number; z: number } {
    return this.npcAt(this.content.den.npc) ?? this.content.den
  }

  get store(): JobStore {
    return (this.storeCache ??= new JobStore(this.g.store.db))
  }

  // ---- settings -------------------------------------------------------------------------------------------------------

  private loadSettings(): { patch: JobSettingsPatch; effective: JobSettings; rev: number } {
    let patch: JobSettingsPatch = {}
    let rev = 0
    try {
      const row = this.store.settingsOf(JOB_SETTINGS_CODE)
      if (row) {
        const v = JSON.parse(row.json) as unknown
        const issues = checkJobSettings(v)
        if (issues.length) this.g.config.log(`jobs: the stored settings have problems (${issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join('; ')}); using the defaults`)
        else patch = v as JobSettingsPatch
        rev = row.rev
      }
    } catch {
      // no table yet (an old schema in a test): the defaults
    }
    return { patch, effective: mergeJobSettings(JOB_SETTINGS_DEFAULTS, patch), rev }
  }

  get settings(): JobSettings {
    return (this.settingsCache ??= this.loadSettings()).effective
  }

  get patch(): JobSettingsPatch {
    return (this.settingsCache ??= this.loadSettings()).patch
  }

  get rev(): number {
    return (this.settingsCache ??= this.loadSettings()).rev
  }

  /** Stores and applies a new patch (admin PUT / reset). */
  savePatch(patch: JobSettingsPatch, by: number | null, now: number): number {
    const rev = this.rev + 1
    this.store.saveSettings(JOB_SETTINGS_CODE, JSON.stringify(patch), rev, now, by)
    this.settingsCache = { patch, effective: mergeJobSettings(JOB_SETTINGS_DEFAULTS, patch), rev }
    return rev
  }

  // ---- reads ----------------------------------------------------------------------------------------------------------

  private row(characterId: number): JobRow | null {
    let r = this.rows.get(characterId)
    if (r === undefined) {
      try {
        r = this.store.job(characterId)
      } catch {
        r = null
      }
      this.rows.set(characterId, r)
    }
    return r
  }

  /** Drops the cached row (HunterService calls it after writing the Hunter's row). */
  invalidate(characterId: number): void {
    this.rows.delete(characterId)
  }

  private reload(characterId: number): JobRow | null {
    this.rows.delete(characterId)
    this.g.hunters.invalidate(characterId)
    return this.row(characterId)
  }

  jobOf(characterId: number): JobId | null {
    return this.row(characterId)?.job ?? null
  }

  levelOf(characterId: number): number {
    const r = this.row(characterId)
    return r ? jobLevelOf(r.job_exp, this.settings.jobs.levels) : 0
  }

  /** Job mode on (the Hunter's duty). */
  inMode(characterId: number): boolean {
    return this.row(characterId)?.on_duty === 1
  }

  /** The badge others see (null: out of job mode). */
  badgeOf(characterId: number): JobBadge | null {
    const r = this.row(characterId)
    return r && r.on_duty === 1 ? { job: r.job, level: jobLevelOf(r.job_exp, this.settings.jobs.levels) } : null
  }

  /** Whether (x, z) is safe from the job war: a safe area, the stockade, a post's or the den's ring. */
  inJobSafe(x: number, z: number): boolean {
    if (this.g.data.inSafeArea(this.g.config.world, x, z) || inStockade(x, z)) return true
    const r = this.settings.mode.safeRingM
    if (r <= 0) return false
    const den = this.den()
    if (Math.hypot(x - den.x, z - den.z) <= r) return true
    return this.content.posts.some((p) => Math.hypot(x - p.x, z - p.z) <= r)
  }

  /** docs/JOBS.md §6.4: within the Bandit Den's safe ring (a robber is sheltered there from Bounty Hunters too). */
  inDenRing(x: number, z: number): boolean {
    const r = this.settings.mode.safeRingM
    if (r <= 0 || !this.settings.jobs.enabled) return false
    const den = this.den()
    return Math.hypot(x - den.x, z - den.z) <= r
  }

  /** The Bandit Den's spot (Seopok where he stands). */
  denSpot(): { x: number; z: number } {
    return this.den()
  }

  /** The job fields of the PvP rule (siege-hunter.ts PvpSide). */
  pvpSide(p: Player, x: number, z: number): { job: JobId | null; jobMode: boolean; inJobSafe: boolean } {
    const r = this.row(p.characterId)
    if (!r || !this.settings.jobs.enabled) return { job: null, jobMode: false, inJobSafe: true }
    return { job: r.job, jobMode: r.on_duty === 1, inJobSafe: this.inJobSafe(x, z) }
  }

  /** Whether NPC `code` offers a job service. */
  offers(code: string, service: NpcService): boolean {
    if (!this.settings.jobs.enabled) return false
    if (service === 'trader') return this.placed && code === JOB_LICENCE_NPC.trader
    if (service === 'thief') return this.placed && code === JOB_LICENCE_NPC.thief
    return false
  }

  private accountOf(characterId: number): number | null {
    return this.g.law.accountOf(characterId)
  }

  view(p: Player, now: number): JobView {
    const r = this.row(p.characterId)
    const acc = this.accountOf(p.characterId)
    let ar = null
    try {
      ar = acc === null ? null : this.store.account(acc)
    } catch {
      ar = null
    }
    const s = this.settings
    const level = r ? jobLevelOf(r.job_exp, s.jobs.levels) : 0
    const v: JobView = { job: r?.job ?? null, level, exp: r?.job_exp ?? 0, mode: r?.on_duty === 1, side: ar?.side ?? null }
    const next = r ? jobNextExp(level, s.jobs.levels) : null
    if (next !== null) v.next = next
    const lock = this.lockUntil(p)
    if (r?.on_duty === 1 && lock > now) v.lockUntil = lock
    if (ar?.left_at != null && ar.left_at + s.jobs.leaveWaitDays * DAY_MS > now) v.joinAfter = ar.left_at + s.jobs.leaveWaitDays * DAY_MS
    return v
  }

  sendState(p: Player, now: number): void {
    p.send({ t: 'jobState', ...this.view(p, now) })
  }

  private lockUntil(p: Player): number {
    const last = this.g.hunters.lastPvpAt(p.characterId)
    if (last === null) return 0
    const min = this.jobOf(p.characterId) === 'hunter' ? this.g.siege.settings.hunter.offDutyLockMin : this.settings.mode.offLockMin
    return last + min * 60_000
  }

  // ---- joining and leaving (§2.1) -----------------------------------------------------------------------------------------

  /** Why `p` may not join `job` now (null: may); the Hunter's licence (hunters.ts) asks this too. */
  joinProblem(p: Player, job: JobId, now: number): Fail | null {
    const s = this.settings.jobs
    const acc = this.accountOf(p.characterId)
    const ar = acc === null ? null : this.store.account(acc)
    const others = acc === null ? [] : this.store.jobsOfAccount(acc).filter((x) => x.character_id !== p.characterId)
    const minLevel = job === 'hunter' ? this.g.siege.settings.hunter.minLevel : s.minLevel
    const why = joinRefusal(
      {
        job,
        level: p.level,
        current: this.jobOf(p.characterId),
        wanted: this.g.law.isWanted(p.characterId),
        jailed: this.g.jail.jailedNow(p),
        accountSide: ar?.side ?? null,
        sideChangedAt: ar?.side_changed_at ?? null,
        leftAt: ar?.left_at ?? null,
        otherJobs: others.map((x) => x.job),
        now,
      },
      s,
      minLevel,
    )
    if (!why) return null
    const days = (from: number | null | undefined, n: number) => Math.max(1, Math.ceil(((from ?? now) + n * DAY_MS - now) / DAY_MS))
    const names = others
      .filter((x) => jobSide(x.job) !== jobSide(job))
      .map((x) => `${this.g.store.characterById(x.character_id)?.name ?? `#${x.character_id}`} (${JOB_NAMES[x.job]})`)
    const text = REFUSAL_TEXT[why]
      .replace('{level}', String(minLevel))
      .replace('{others}', names.join(', '))
      .replace('{days}', String(why === 'side_wait' ? days(ar?.side_changed_at, s.sideChangeDays) : days(ar?.left_at, s.leaveWaitDays)))
    return fail(REFUSAL_REASON[why], text)
  }

  /** After a licence was written (here, or the Hunter's at Yun): the account's side. */
  joined(p: Player, job: JobId, now: number): void {
    const acc = this.accountOf(p.characterId)
    if (acc !== null) {
      const side = jobSide(job)
      const ar = this.store.account(acc)
      if (!ar || ar.side !== side) this.store.putAccount({ account_id: acc, side, side_changed_at: now, left_at: ar?.left_at ?? null })
    }
    this.reload(p.characterId)
    this.sendState(p, now)
  }

  private join(p: Player, npcId: number, job: JobId, answer: Answer, now: number): void {
    if (job === 'hunter') return this.g.hunters.licenceAt(p, npcId, answer, now)
    if (!this.settings.jobs.enabled) return answer(fail('not_found', REFUSAL_TEXT.disabled))
    const npc = this.g.npcs.requireService(p, npcId, JOB_SERVICE[job], now)
    if (!npc.ok) return answer(npc)
    const why = this.joinProblem(p, job, now)
    if (why) return answer(why)
    const gold = this.settings.jobs.licenceGold
    const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) =>
      d.gold < gold ? fail('not_enough_gold', `The licence costs ${gold.toLocaleString('en-US')} gold.`) : addGold(d, -gold),
    )
    if (!result.ok) return answer(result)
    this.store.join(p.characterId, job, now)
    this.joined(p, job, now)
    answer(true)
    this.g.afterInventory(p, draft)
    const who = job === 'trader' ? 'Specialty Trader Jodaesan' : 'Old Fang'
    p.send({ t: 'chat', channel: 'system', text: `${who} takes ${gold.toLocaleString('en-US')} gold: you are a ${JOB_NAMES[job]} now (${jobLevelName(job, 1)}). Put on your suit to work.` })
    this.g.config.log(`jobs: ${p.name} joined as a ${job}`)
  }

  /** Why `p` may not leave its job now (null: may). */
  leaveProblem(p: Player, now: number): Fail | null {
    const r = this.row(p.characterId)
    if (!r) return fail('not_usable', 'You have no job.')
    if (r.on_duty === 1) return fail('not_usable', 'Take your suit off first.')
    if (this.g.law.isWanted(p.characterId)) return fail('not_usable', 'Not while you are Wanted.')
    if (this.g.jail.jailedNow(p)) return fail('jailed')
    if (r.job === 'hunter' && r.revoked_until !== null && r.revoked_until > now) return fail('not_usable', 'Your licence is revoked: it stays on your record until it runs out.')
    for (const c of this.carrying) {
      const why = c(p)
      if (why) return fail('not_usable', why)
    }
    return null
  }

  private leave(p: Player, npcId: number, answer: Answer, now: number): void {
    const r = this.row(p.characterId)
    if (!r) return answer(fail('not_usable', 'You have no job.'))
    const npc = this.g.npcs.requireService(p, npcId, JOB_SERVICE[r.job], now)
    if (!npc.ok) return answer(npc)
    const why = this.leaveProblem(p, now)
    if (why) return answer(why)
    this.leaveNow(p.characterId, now)
    answer(true)
    p.send({ t: 'chat', channel: 'system', text: `You leave the ${JOB_NAMES[r.job]}s. Your job level is gone; your account may take a job again in ${this.settings.jobs.leaveWaitDays} day(s).` })
  }

  /** Removes the job (the request, or GM `job leave`): the account's leave wait starts. */
  leaveNow(characterId: number, now: number, wait = true): JobId | null {
    const r = this.row(characterId)
    if (!r) return null
    const p = this.playerOf(characterId)
    this.store.leave(characterId)
    const acc = this.accountOf(characterId)
    if (acc !== null && wait) {
      const ar = this.store.account(acc)
      this.store.putAccount({ account_id: acc, side: ar?.side ?? jobSide(r.job), side_changed_at: ar?.side_changed_at ?? now, left_at: now })
    }
    this.reload(characterId)
    if (p) {
      if (r.on_duty === 1) this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, job: null, ...(r.job === 'hunter' ? { hunter: -1 } : {}) })
      this.sendState(p, now)
      if (r.job === 'hunter') this.g.law.sendState(p, now)
    }
    this.g.config.log(`jobs: ${this.g.store.characterById(characterId)?.name ?? characterId} left the ${r.job}s`)
    return r.job
  }

  // ---- job mode (§2.2) ----------------------------------------------------------------------------------------------------------

  /** The suit on or off (the request; Hunters go through HunterService.setDuty, the same rules as `hunterDuty`). */
  setMode(p: Player, on: boolean, now: number): true | Fail {
    const r = this.row(p.characterId)
    if (!r) return fail('not_usable', 'You have no job.')
    if (r.job === 'hunter') return this.g.hunters.setDuty(p, on, now)
    if (on) {
      if (r.on_duty === 1) return true
      if (!this.settings.jobs.enabled) return fail('not_found', REFUSAL_TEXT.disabled)
      // layer 7: a licence revoked by an admin keeps the suit off until it runs out
      if (r.revoked_until !== null && r.revoked_until > now) return fail('not_usable', `Your licence is revoked until ${new Date(r.revoked_until).toISOString().slice(0, 10)}.`)
      if (this.g.jail.jailedNow(p)) return fail('jailed')
      const [x, , z] = this.g.world.positionAt(p, now)
      if (r.job === 'thief') {
        const m = this.settings.mode.thiefDressM
        const fang = this.npcAt(LAW_CODES.fence) ?? FENCE_SPOT
        const den = this.den()
        const near = Math.hypot(x - fang.x, z - fang.z) <= m || Math.hypot(x - den.x, z - den.z) <= m
        if (!near) return fail('wrong_place', "Thieves dress at Old Fang's camp or at the Bandit Den.")
      } else if (!this.g.data.inSafeArea(this.g.config.world, x, z)) return fail('wrong_place', 'Put the suit on in a town (a safe area).')
      if (now - p.lastCombatAt < OUT_OF_COMBAT_MS) return fail('in_combat', 'Not in the middle of a fight.')
    } else {
      if (r.on_duty === 0) return true
      const lock = this.lockUntil(p)
      if (lock > now) return fail('in_combat', `You fought another player not long ago: the suit comes off in ${Math.ceil((lock - now) / 1000)} s.`)
      for (const c of this.carrying) {
        const why = c(p)
        if (why) return fail('not_usable', why)
      }
    }
    this.store.setMode(p.characterId, on)
    this.modeChanged(p, now)
    return true
  }

  /** After job mode changed (here or in HunterService): the badge to everyone around, the own state. */
  modeChanged(p: Player, now: number): void {
    this.reload(p.characterId)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, job: this.badgeOf(p.characterId) })
    this.sendState(p, now)
  }

  /** Forced out of job mode (jailed; GM). */
  modeOff(p: Player, now: number): void {
    const r = this.row(p.characterId)
    if (!r || r.on_duty === 0) return
    if (r.job === 'hunter') return this.g.hunters.dutyOff(p, now)
    this.store.setMode(p.characterId, false)
    this.modeChanged(p, now)
  }

  // ---- job EXP (§3) ----------------------------------------------------------------------------------------------------------------

  /** Adds job EXP (never character EXP): the level from the thresholds; a Hunter's rank follows (level − 1). */
  addExp(characterId: number, n: number, now: number, why = ''): { level: number; exp: number } | null {
    const r = this.row(characterId)
    if (!r || !(n > 0)) return r ? { level: jobLevelOf(r.job_exp, this.settings.jobs.levels), exp: r.job_exp } : null
    return this.setExp(characterId, r.job_exp + Math.floor(n), now, why)
  }

  /** Sets job EXP (GM `job exp`/`level`): rank, badge, promotion line, state. */
  setExp(characterId: number, exp: number, now: number, why = ''): { level: number; exp: number } | null {
    const r = this.row(characterId)
    if (!r) return null
    const levels = this.settings.jobs.levels
    const before = jobLevelOf(r.job_exp, levels)
    const e = Math.max(0, Math.min(1_000_000_000, Math.floor(exp)))
    const level = jobLevelOf(e, levels)
    this.store.setExp(characterId, e, r.job === 'hunter' ? hunterRankOfLevel(level) : r.rank)
    this.reload(characterId)
    const p = this.playerOf(characterId)
    if (p) {
      if (level !== before) {
        if (r.on_duty === 1) {
          this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, job: { job: r.job, level }, ...(r.job === 'hunter' ? { hunter: hunterRankOfLevel(level) } : {}) })
        }
        if (level > before) {
          const by = r.job === 'hunter' ? 'Captain Yun promotes you' : 'Your job level rises'
          p.send({ t: 'chat', channel: 'system', text: `${by}: ${JOB_NAMES[r.job]} level ${level}, ${jobLevelName(r.job, level)}.` })
        }
      }
      this.sendState(p, now)
      if (r.job === 'hunter') this.g.law.sendState(p, now)
    }
    if (why) this.g.config.log(`jobs: ${this.g.store.characterById(characterId)?.name ?? characterId} +${e - r.job_exp} job EXP (${why})`)
    return { level, exp: e }
  }

  // ---- requests and hooks ------------------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'jobJoin':
        return this.join(p, msg.npc, msg.job, answer, now)
      case 'jobLeave':
        return this.leave(p, msg.npc, answer, now)
      case 'jobMode':
        return answer(this.setMode(p, msg.on, now))
      default:
        return answer(fail('not_found'))
    }
  }

  enter(p: Player, now: number): void {
    this.rows.delete(p.characterId)
    const acc = this.accountOf(p.characterId)
    let side = false
    try {
      side = acc !== null && this.store.account(acc) !== null
    } catch {
      side = false
    }
    if (this.row(p.characterId) || side) this.sendState(p, now)
  }

  forget(p: Player): void {
    this.rows.delete(p.characterId)
  }

  playerOf(characterId: number): Player | null {
    for (const p of this.g.world.players.values()) if (p.characterId === characterId) return p
    return null
  }

  // ---- GM (§9.5) -----------------------------------------------------------------------------------------------------------------

  /** `job <name> [join <job>|leave|level <n>|exp <n>|mode on|off|side law|outlaw]` (no rules but one job per character). */
  gm(args: readonly string[], now: number): GmResult {
    const [name, verb, arg] = args
    if (!name) return { ok: false, message: `Usage: ${JOB_USAGE}` }
    const row = this.g.store.characterByName(name.replace(/^@/, ''))
    if (!row) return { ok: false, message: `No character named ${name}.` }
    const p = this.playerOf(row.id)
    const r = this.row(row.id)
    const v = (verb ?? 'status').toLowerCase()
    const levels = this.settings.jobs.levels
    if (v === 'status') {
      const acc = this.store.account(row.account_id)
      if (!r) return { ok: true, message: `${row.name}: no job${acc ? ` (account side: ${acc.side})` : ''}.` }
      const lv = jobLevelOf(r.job_exp, levels)
      return { ok: true, message: `${row.name}: ${JOB_NAMES[r.job]} level ${lv} (${jobLevelName(r.job, lv)}), ${r.job_exp} job EXP, job mode ${r.on_duty ? 'on' : 'off'}${acc ? `, account side ${acc.side}` : ''}.` }
    }
    if (v === 'join') {
      const job = (arg ?? '').toLowerCase() as JobId
      if (!JOB_IDS.includes(job)) return { ok: false, message: 'Usage: job <name> join trader|hunter|thief' }
      if (r) return { ok: false, message: `${row.name} is already a ${JOB_NAMES[r.job]} (job <name> leave first).` }
      this.store.join(row.id, job, now)
      const ar = this.store.account(row.account_id)
      if (!ar || ar.side !== jobSide(job)) this.store.putAccount({ account_id: row.account_id, side: jobSide(job), side_changed_at: now, left_at: ar?.left_at ?? null })
      this.reload(row.id)
      if (p) {
        this.sendState(p, now)
        if (job === 'hunter') this.g.law.sendState(p, now)
      }
      return { ok: true, message: `${row.name} is a ${JOB_NAMES[job]} now.` }
    }
    if (!r) return { ok: false, message: `${row.name} has no job.` }
    if (v === 'leave') {
      this.leaveNow(row.id, now, false)
      return { ok: true, message: `${row.name} left the ${JOB_NAMES[r.job]}s (no wait).` }
    }
    if (v === 'level' || v === 'exp') {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < (v === 'level' ? 1 : 0) || n > (v === 'level' ? 7 : 1_000_000_000)) return { ok: false, message: `Usage: job <name> ${v} <${v === 'level' ? '1-7' : 'EXP'}>` }
      const out = this.setExp(row.id, v === 'level' ? jobLevelExp(n, levels) : n, now)!
      return { ok: true, message: `${row.name}: ${JOB_NAMES[r.job]} level ${out.level}, ${out.exp} job EXP.` }
    }
    if (v === 'mode') {
      const a = (arg ?? '').toLowerCase()
      if (a !== 'on' && a !== 'off') return { ok: false, message: 'Usage: job <name> mode on|off' }
      if (r.job === 'hunter') return this.g.hunters.gm(row.name, 'duty', a, now)
      this.store.setMode(row.id, a === 'on')
      if (p) this.modeChanged(p, now)
      else this.reload(row.id)
      return { ok: true, message: `${row.name}: job mode ${a}.` }
    }
    if (v === 'side') {
      const side = (arg ?? '').toLowerCase() as JobSide
      if (side !== 'law' && side !== 'outlaw') return { ok: false, message: 'Usage: job <name> side law|outlaw' }
      const ar = this.store.account(row.account_id)
      this.store.putAccount({ account_id: row.account_id, side, side_changed_at: now, left_at: ar?.left_at ?? null })
      if (p) this.sendState(p, now)
      return { ok: true, message: `${row.name}'s account is on the ${side === 'law' ? "law's" : "outlaws'"} side.` }
    }
    return { ok: false, message: `Usage: ${JOB_USAGE}` }
  }

  /**
   * Layer 7 (admin): a Trader's or Thief's licence revoked until `until` (the suit comes off) or restored (`until`
   * null). Bounty Hunters go through HunterService (`law hunter <name> revoke|restore`: `hunter.revokeDays`, the
   * restore keeps rank and captures). Returns the job, or null.
   */
  adminRevoke(characterId: number, until: number | null, now: number): JobId | null {
    const r = this.row(characterId)
    if (!r) return null
    if (r.job === 'hunter') {
      const name = this.g.store.characterById(characterId)?.name
      if (name) this.g.hunters.gm(name, until === null ? 'restore' : 'revoke', undefined, now)
      this.reload(characterId)
      return r.job
    }
    this.store.setRevoked(characterId, until)
    if (until !== null) {
      const p = this.playerOf(characterId)
      if (p) this.modeOff(p, now)
      else this.store.setMode(characterId, false)
    }
    this.reload(characterId)
    return r.job
  }

  /** Layer 7 (admin): the account's job waits cleared (leaving a job, changing sides). */
  adminResetWaits(accountId: number): boolean {
    const a = this.store.account(accountId)
    if (!a) return false
    this.store.putAccount({ account_id: a.account_id, side: a.side, side_changed_at: 0, left_at: null })
    return true
  }

  // ---- admin (§9.5) ---------------------------------------------------------------------------------------------------------------

  adminView(now: number): AdminJobsView {
    const levels = this.settings.jobs.levels
    const counts: Record<JobId, number> = { trader: 0, hunter: 0, thief: 0 }
    const members = this.store.all().map((r) => {
      counts[r.job]++
      return {
        characterId: r.character_id,
        name: this.g.store.characterById(r.character_id)?.name ?? `#${r.character_id}`,
        job: r.job,
        level: jobLevelOf(r.job_exp, levels),
        exp: r.job_exp,
        mode: r.on_duty === 1,
        online: this.playerOf(r.character_id) !== null,
        revokedUntil: r.revoked_until !== null && r.revoked_until > now ? r.revoked_until : null,
      }
    })
    return {
      enabled: this.settings.jobs.enabled,
      members,
      counts,
      accounts: this.store.accounts().map((a) => ({ accountId: a.account_id, side: a.side, sideChangedAt: a.side_changed_at, leftAt: a.left_at })),
      settings: { defaults: structuredClone(JOB_SETTINGS_DEFAULTS) as JobSettings, effective: structuredClone(this.settings), patch: structuredClone(this.patch), rev: this.rev, bounds: { ...JOB_SETTINGS_BOUNDS } },
      content: {
        posts: this.content.posts.map((p) => ({ id: p.id, name: p.name, npc: p.npc.name, x: p.x, z: p.z, danger: p.danger })),
        goods: this.content.goods.length,
        transports: this.content.transports.map((t) => t.name),
        source: this.contentSource,
      },
    }
  }

  /** PUT settings: `delta` over the stored patch, based on `baseRev`. */
  saveSettings(baseRev: unknown, delta: unknown, by: number | null, now: number): { ok: true; rev: number } | { ok: false; status: number; message: string; issues?: { path: string; message: string }[] } {
    if (!Number.isInteger(baseRev)) return { ok: false, status: 400, message: 'baseRev must be the rev you loaded.' }
    if (baseRev !== this.rev) return { ok: false, status: 409, message: `The settings were changed since you loaded them (rev ${this.rev}, yours ${String(baseRev)}). Reload and try again.` }
    const issues = checkJobSettings(delta)
    if (issues.length) return { ok: false, status: 422, message: 'Some values are out of bounds.', issues }
    const patch = pruneJobPatch(mergeJobPatch(this.patch, delta as JobSettingsPatch), JOB_SETTINGS_DEFAULTS)
    return { ok: true, rev: this.savePatch(patch, by, now) }
  }

  /** POST settings/reset: `paths` (none = all) back to their defaults. */
  resetSettings(paths: unknown, by: number | null, now: number): { ok: true; rev: number } | { ok: false; status: number; message: string } {
    if (paths === undefined) return { ok: true, rev: this.savePatch({}, by, now) }
    const groups = new Set(JOB_SETTING_PATHS.map((p) => p.split('.')[0]))
    if (!Array.isArray(paths) || paths.length > 64 || !paths.every((p) => typeof p === 'string' && (JOB_SETTING_PATHS.includes(p) || groups.has(p)))) {
      return { ok: false, status: 422, message: 'paths must name settings (e.g. "jobs.minLevel", or a group: "jobs").' }
    }
    return { ok: true, rev: this.savePatch(unsetJobPaths(this.patch, paths as string[]), by, now) }
  }
}

export const JOB_USAGE = 'job <name> [status|join trader|hunter|thief|leave|level <1-7>|exp <n>|mode on|off|side law|outlaw]'

/** content/jobs/jobs.json, checked; the built-in JOBS_CONTENT when absent or broken. */
export function readJobsContent(contentDir: string | undefined): { content: JobsContent; source: string; problem: string } {
  const builtIn = structuredClone(JOBS_CONTENT) as JobsContent
  if (!contentDir) return { content: builtIn, source: 'built-in', problem: '' }
  const file = join(contentDir, 'jobs', 'jobs.json')
  if (!existsSync(file)) return { content: builtIn, source: 'built-in', problem: '' }
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const problems = checkJobsContent(v)
    if (problems.length) return { content: builtIn, source: 'built-in', problem: `${file}: ${problems.slice(0, 3).join('; ')}` }
    return { content: v as JobsContent, source: 'content/jobs/jobs.json', problem: '' }
  } catch (e) {
    return { content: builtIn, source: 'built-in', problem: `${file}: ${(e as Error).message}` }
  }
}

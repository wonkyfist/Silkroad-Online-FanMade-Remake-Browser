/**
 * The FX lab (docs/EFFECTS.md §2.5 H2, §6.7; docs/WAVE_PLAN2.md §5.12), dev only: `?mock=1&auto=1&gm=1&fxlab=1`.
 *
 * It exposes `window.__sroFxLab` and plays every skill line and system effect through the real client pipeline: it
 * feeds the same server frames the real server sends (`cast`, `combat {instance}`, `effectAdd`/`effectRemove`,
 * `levelUp`, `itemEffect`, `itemCast`) into the mock connection, so the skills feature, the ActionPlayer, SkillFx and
 * the world features present them exactly as in a game. The mock server has no skill engine, so the lab plays it.
 *
 * What it records (the H2 log, `log()`), with no edits to the presentation code:
 *  - every started effect program (`FxInstance`, first update: key and world position; its dispose for the leak check);
 *  - `SkillFx.onSpawn` entries when that lab hook exists (trails, .bsr models, hits);
 *  - every clip that starts on an actor (`CharacterActor.onClip`);
 *  - every hit shown (`onCombatHit`).
 * `report()` compares the log with a table computed from the data (fx index v2 stages, skills.json timings and cues,
 * the actor's clip events, characterInfo DamagePos): clips per phase, each stage key at its time (±50 ms), anchors in
 * caster-local metres, duplicates, and effects still alive after the drain. `sheet()` shows a contact sheet of every
 * line at its first damage cue; `grid()` lays out every effect program of a group family in front of you.
 */
import { CreateScreenshotAsync, Matrix, Vector3, type ArcRotateCamera, type Scene } from '@babylonjs/core'
import { FxInstance, FxLibrary, type FxEffect, type FxRootPose } from '@sro/fx'
import { DEFAULT_LEVEL_CAP, type CombatHit, type EffectState, type ServerMessage, type SkillDef, type SkillStatusKind } from '@sro/shared'
import type { App } from '../app.ts'
import { STARTER_WEAPON_ITEMS } from '../content/builtin.ts'
import { OUT } from '../content/catalog.ts'
import type { EntityView } from '../world/entities.ts'
import { WORLD_FEATURES, type CombatMessage, type WorldFeature, type WorldFeatureContext, type WorldFeatureFactory } from '../world/features.ts'
import type { FxCharacterInfo, FxLabEntry, FxSkillV2, FxStageV2, FxVec3 } from '../world/fx/types.ts'
import { isFlight, SkillFx, stageRoll } from '../world/skill-fx.ts'
import { planPhases } from '../world/skills-view.ts'

/** Level cap of the lines the lab plays (mastery level). */
const CAP = DEFAULT_LEVEL_CAP
/** Time tolerance of a stage (one 30 fps frame + one 60 fps frame, ms). */
const TOL_MS = 50
/** A spawn this much later than expected still matches (then it is "late"). */
const LATE_MS = 600
/** How far from the caster an effect still belongs to the line that runs (m). */
const NEAR_M = 25
/** Wait after the runs before the leak check: the 3 s fade of stopped effects plus slack (ms). */
const DRAIN_MS = 7000
/** Buffs, imbues and statuses stay on this long before the lab removes them (ms). */
const HOLD_MS = 3000
/** Synthetic instance ids start here (the mock has no skill engine, so nothing collides). */
const INSTANCE_BASE = 900_000
const MOB = 'MOB_CH_MANGNYANG'
const SCALE_KEYS = ['Bip01', 'Bip01 R Hand', 'Bip01 L Hand', 'Bip01 R Finger2', 'Bip01 Head']

type Family = 'sword' | 'blade' | 'spear' | 'glaive' | 'bow'
type Src = 'fx' | 'hook' | 'clip' | 'hit' | 'note'

/** A log line: FxLabEntry plus where it came from and, for effect programs, their instance. */
export interface LabEntry extends FxLabEntry {
  src: Src
  /** The line (skill code) running when it was logged. */
  run?: string
  /** Caster-local position of the current run's caster (m). */
  local?: FxVec3
  /** Victim-local positions (m) of the run's targets, by entity id. */
  victim?: Record<number, FxVec3>
  /** Caster-local joint positions at that moment (bone anchors). */
  joints?: Record<string, FxVec3>
}

interface Expect {
  what: 'stage' | 'dmg' | 'spark' | 'blood' | 'arrive' | 'defense' | 'model' | 'trail' | 'loop'
  key: string
  phase: string
  /** Local ms it should start (null = anytime in the run). */
  at: number | null
  anchor: 'caster' | 'victim' | 'target' | 'none'
  bone?: string | null
  offset?: FxVec3
  roll?: number
  victim?: number
  /** A loop row: it must be gone by then (+ fade). */
  endBy?: number
  optional?: boolean
  /** A flying row: its first sample may already sit on the arrow (0.5 m tolerance). */
  flight?: boolean
  row?: number
  /** Built by expectHits from the logged hits (rebuilt on every report, so report() can be called any time). */
  fromHits?: boolean
}

interface ExpectResult extends Expect {
  status: 'ok' | 'late' | 'early' | 'missing' | 'unverified'
  gotAt?: number
  deltaMs?: number
  /** Anchor deviation (m) from the data's position, and the positions compared (caster- or victim-local). */
  devM?: number
  got?: FxVec3
  want?: FxVec3
  leaked?: boolean
}

interface ClipCheck {
  phase: string
  type: string
  clip: string | null
  at: number | null
  wantAt: number
  ok: boolean
  note?: string
}

interface LineRun {
  code: string
  group: string
  kind: string
  /** When the lab started the line (the log window opens here). */
  start: number
  /** When the client received the line's first frame (expectations count from here). */
  t0: number
  /** The first frame was seen (cast, or combat for basic attacks). */
  seen: boolean
  tEnd: number
  caster: number
  targets: number[]
  release: number
  expects: Expect[]
  hits: { t: number; target: number; index: number; skill: string }[]
  clips: { t: number; name: string }[]
  notes: string[]
  shot?: string
  weapon?: string
}

interface LineReport {
  code: string
  group: string
  kind: string
  ok: boolean
  problems: string[]
  clips: ClipCheck[]
  stages: ExpectResult[]
  extra: Record<string, number>
  leaks: string[]
  notes: string[]
  shot?: string
}

export interface FxLabReport {
  at: string
  lines: number
  ok: number
  problems: number
  skillFx: unknown
  live: number
  started: number
  disposed: number
  detail: LineReport[]
  /** One line per skill line, for the console. */
  text: string
}

interface GridCell {
  key: string
  pos: FxVec3
  fx: FxInstance | null
  label: HTMLElement
  wait: number
}

interface Born {
  t: number
  key: string
  run: string | null
  pos: FxVec3 | null
  disposedAt: number | null
  entry: LabEntry | null
  /** The program's own length (ms); null = it loops until stopped. */
  lengthMs: number | null
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)))
const now = () => performance.now()
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d
const r3 = (v: FxVec3): FxVec3 => [round(v[0]), round(v[1]), round(v[2])]
const dist3 = (a: FxVec3, b: FxVec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** A skilleffect offset "x,y,z" (dm, file frame) in glTF metres: (x, y, -z) * 0.1 (docs/EFFECTS.md §1.3). */
function parseOffset(s: string | null | undefined): FxVec3 {
  const [x = 0, y = 0, z = 0] = (s ?? '').split(',').map(Number).map(n => (Number.isFinite(n) ? n : 0))
  return [x * 0.1, y * 0.1, z ? -z * 0.1 : 0]
}

/** World → the frame of a view (its root, turned with its yaw; the game's `facing` convention, skill-fx.ts). */
function toLocal(v: EntityView, p: FxVec3): FxVec3 {
  const r = v.root.position
  const d: FxVec3 = [p[0] - r.x, p[1] - r.y, p[2] - r.z]
  const c = Math.cos(v.yaw)
  const s = Math.sin(v.yaw)
  return [d[0] * c - d[2] * s, d[1], d[0] * s + d[2] * c]
}

function familyOf(code: string | undefined): Family | null {
  if (!code) return null
  for (const [f, c] of Object.entries(STARTER_WEAPON_ITEMS) as [Family, string][]) if (c === code) return f
  const m = /_CH_(SWORD|BLADE|SPEAR|TBLADE|BOW)_/.exec(code)
  if (!m) return null
  return m[1] === 'TBLADE' ? 'glaive' : (m[1]!.toLowerCase() as Family)
}

const BASIC_BY_FAMILY: Record<Family, string> = {
  sword: 'SKILL_CH_SWORD_BASE_01',
  blade: 'SKILL_CH_SWORD_BASE_01',
  spear: 'SKILL_CH_SPEAR_BASE_01',
  glaive: 'SKILL_CH_SPEAR_BASE_01',
  bow: 'SKILL_CH_BOW_BASE_01',
}

class FxLab {
  private ctx: WorldFeatureContext | null = null
  private entries: LabEntry[] = []
  private born = new Map<FxInstance, Born>()
  private runs: LineRun[] = []
  private current: LineRun | null = null
  private index = new Map<string, FxSkillV2>()
  private chars: Record<string, FxCharacterInfo> = {}
  private indexLoaded: Promise<void> | null = null
  private instance = INSTANCE_BASE
  private skillFx = new Set<SkillFx>()
  private hookedActors = new WeakSet<object>()
  private gmWaiters: ((msg: Extract<ServerMessage, { t: 'gmResult' }>) => void)[] = []
  private gridLib: FxLibrary | null = null
  private cells: GridCell[] = []
  private labels: HTMLElement | null = null
  private sheetEl: HTMLElement | null = null
  private busy = false
  private lastReport: FxLabReport | null = null
  private startedCount = 0
  private disposedCount = 0
  /** Average frame time (ms): stage times are only as exact as one frame, so the tolerance grows with it. */
  private frameMs = 16.7

  /** Time tolerance of a stage: one 30 fps frame plus one frame of this machine (at least TOL_MS). */
  private get tolMs(): number {
    return Math.max(TOL_MS, 34 + this.frameMs)
  }

  constructor(private readonly app: App) {}

  // ---- installation -------------------------------------------------------------------------------------------

  install(): void {
    patchFxInstance(this)
    patchSkillFx(this)
    const list = WORLD_FEATURES as WorldFeatureFactory[]
    if (!list.some(f => f.name === 'fxLabFeature')) {
      const lab = this
      const fxLabFeature: WorldFeatureFactory = ctx => lab.attach(ctx)
      list.push(fxLabFeature)
    }
    console.info('[fxlab] ready: await __sroFxLab.runAll(); __sroFxLab.report(); __sroFxLab.sheet(); __sroFxLab.grid("system")')
  }

  private attach(ctx: WorldFeatureContext): WorldFeature {
    this.ctx = ctx
    void this.loadIndex()
    return {
      onMessage: msg => this.onMessage(msg),
      onCombatHit: (msg, i) => this.onHit(msg, i),
      onFrame: (_now, dt) => this.onFrame(dt),
      onEntityAdded: v => this.hookActor(v),
      dispose: () => {
        this.clearGrid()
        if (this.ctx === ctx) this.ctx = null
      },
    }
  }

  /** An FxInstance ran its first update (patched prototype): log its key and where it started. */
  fxBorn(inst: FxInstance, pose: FxRootPose | null): void {
    this.startedCount++
    const pos = pose ? ([pose.position[0], pose.position[1], pose.position[2]] as FxVec3) : null
    const key = inst.effect.key
    const d = inst.effect.duration
    const lengthMs = d === null || !Number.isFinite(d) ? null : (d / (inst.effect.fps || 30)) * 1000
    const b: Born = { t: now(), key, run: this.current?.code ?? null, pos, disposedAt: null, entry: null, lengthMs }
    this.born.set(inst, b)
    if (this.cells.some(c => c.fx === inst)) return
    const e = this.entry({ kind: 'fx', name: key, key, src: 'fx', ...(pos ? { pos: r3(pos) } : {}) })
    b.entry = e
  }

  fxDisposed(inst: FxInstance): void {
    const b = this.born.get(inst)
    if (b && b.disposedAt === null) {
      b.disposedAt = now()
      this.disposedCount++
    }
  }

  /** SkillFx.onSpawn (FX-C1's lab hook), when it exists. */
  hookEntry(e: FxLabEntry): void {
    this.entry({ ...e, src: 'hook', t: now() })
  }

  adoptSkillFx(fx: SkillFx): void {
    if (this.skillFx.has(fx)) return
    this.skillFx.add(fx)
    const h = fx as unknown as { onSpawn?: (e: FxLabEntry) => void }
    if (typeof h.onSpawn !== 'function') h.onSpawn = e => this.hookEntry(e)
  }

  private hookActor(v: EntityView): void {
    const a = v.actor
    if (!a || this.hookedActors.has(a)) return
    this.hookedActors.add(a)
    const prev = a.onClip
    a.onClip = name => {
      prev?.(name)
      this.entry({ kind: 'clip', name, entity: v.id, src: 'clip' })
      if (this.current && v.id === this.current.caster) this.current.clips.push({ t: now(), name })
    }
  }

  private onFrame(dt: number): void {
    const ctx = this.ctx
    if (!ctx) return
    if (dt > 0 && dt < 0.5) this.frameMs += (dt * 1000 - this.frameMs) * 0.05
    for (const v of ctx.views()) if (v.actor && !this.hookedActors.has(v.actor)) this.hookActor(v)
    if (this.cells.length) this.tickGrid(dt)
  }

  /**
   * The lab's own frames as the client receives them (after the mock's latency): the expectations count from these
   * moments, like the presentation does.
   */
  private onMessage(msg: ServerMessage): void {
    if (msg.t === 'gmResult') {
      const w = this.gmWaiters.shift()
      w?.(msg)
      return
    }
    const run = this.current
    if (!run) return
    const t = now()
    if (msg.t === 'cast' && msg.id === run.caster) {
      const row = this.skills.get(msg.skill)
      if (!row || run.seen) return
      run.seen = true
      run.t0 = t
      if (!msg.instant) this.expectPhases(row, run, t)
      const kind = row.kind ?? 'attack'
      if (kind === 'heal' || kind === 'cure' || kind === 'resurrect') this.expectBuff(row, run, msg.target ?? msg.id, t + msg.prepareMs + msg.castMs, 'ACT_S')
    } else if (msg.t === 'combat' && msg.attacker === run.caster && msg.instance === undefined && !run.seen) {
      run.seen = true
      run.t0 = t
      run.expects.push({ what: 'stage', key: 'clip:ATTACK', phase: 'SHOT', at: t, anchor: 'none' })
    } else if (msg.t === 'effectAdd' && msg.effect.skill && msg.effect.instance > INSTANCE_BASE) {
      const row = this.skills.get(msg.effect.skill)
      if (row) this.expectBuff(row, run, msg.id, t)
    } else if (msg.t === 'effectRemove' && msg.instance > INSTANCE_BASE) {
      this.expectLoopEnd(run, t)
    }
  }

  private onHit(msg: CombatMessage, i: number): void {
    const t = now()
    this.entry({ kind: 'hit', name: msg.skill ?? 'attack', entity: msg.target, src: 'hit' })
    if (this.current && msg.attacker === this.current.caster) this.current.hits.push({ t, target: msg.target, index: i, skill: msg.skill ?? '' })
  }

  /** Adds a log line with the local frames of the current run. */
  private entry(e: Omit<LabEntry, 't' | 'entity'> & { t?: number; entity?: number }): LabEntry {
    const out: LabEntry = { t: e.t ?? now(), entity: e.entity ?? this.current?.caster ?? -1, ...e } as LabEntry
    const run = this.current
    if (run) {
      out.run = run.code
      const ctx = this.ctx
      const caster = ctx?.view(run.caster)
      if (out.pos && caster) {
        out.local = r3(toLocal(caster, out.pos))
        const joints: Record<string, FxVec3> = {}
        for (const b of this.bonesOf(run.group)) {
          const j = caster.actor?.joint(b)
          if (!j) continue
          const m = j.computeWorldMatrix(true).m
          joints[b] = r3(toLocal(caster, [m[12]!, m[13]!, m[14]!]))
        }
        out.joints = joints
        const vic: Record<number, FxVec3> = {}
        for (const id of run.targets) {
          const tv = ctx?.view(id)
          if (tv) vic[id] = r3(toLocal(tv, out.pos))
        }
        out.victim = vic
      }
    }
    this.entries.push(out)
    if (this.entries.length > 20000) this.entries.splice(0, 5000)
    return out
  }

  private bonesOf(group: string): string[] {
    const s = this.index.get(group)
    const set = new Set<string>(SCALE_KEYS)
    for (const st of s?.stages ?? []) if (st.startBone) set.add(st.startBone)
    return [...set]
  }

  // ---- data --------------------------------------------------------------------------------------------------

  private loadIndex(): Promise<void> {
    this.indexLoaded ??= (async () => {
      try {
        const res = await fetch(`${OUT}fx/skills.json`, { cache: 'no-cache' })
        const j = (await res.json()) as { version?: number; skills?: FxSkillV2[]; characters?: Record<string, FxCharacterInfo> }
        for (const s of j.skills ?? []) this.index.set(s.group, s)
        this.chars = j.characters ?? {}
        if (j.version !== 2) console.warn('[fxlab] fx index is not v2; anchors and v2 checks are skipped')
      } catch (err) {
        console.warn('[fxlab] /out/fx/skills.json unavailable', err)
      }
    })()
    return this.indexLoaded
  }

  private get skills(): Map<string, SkillDef> {
    return this.app.catalog.content.skills
  }

  private groupOf(code: string): string {
    const d = this.skills.get(code)
    return d?.group ?? code.replace(/_\d+$/, '')
  }

  /** Every line the lab plays: the basic attacks and the level-1 row of each active line ≤ the cap. */
  lines(): string[] {
    const out: string[] = []
    for (const d of this.skills.values()) {
      if (d.basicAttack && d.mastery) out.push(d.code)
      else if (d.mastery && d.masteryLevel <= CAP && d.skillLevel === 1 && d.kind !== 'passive' && !(d.chainIndex !== undefined && d.chainIndex > 1)) out.push(d.code)
    }
    const punch = this.skills.get('SKILL_PUNCH_01')
    if (punch) out.unshift(punch.code)
    return out
  }

  // ---- the world -----------------------------------------------------------------------------------------------

  private need(): WorldFeatureContext {
    if (!this.ctx) throw new Error('[fxlab] not in the world yet')
    return this.ctx
  }

  private self(): EntityView {
    const ctx = this.need()
    const id = ctx.selfId()
    const v = id === null ? undefined : ctx.view(id)
    if (!v) throw new Error('[fxlab] no own character')
    return v
  }

  /** Delivers a server frame as if the server sent it (through the mock connection, validated there). */
  deliver(msg: ServerMessage): void {
    const api = this.app.transport.api as unknown as { conns?: Set<{ entityId?: number; deliver(m: ServerMessage): void }> }
    const selfId = this.ctx?.selfId()
    const conn = api.conns ? [...api.conns].find(c => c.entityId === selfId) : undefined
    if (conn) return conn.deliver(msg)
    // Not the mock: hand it to the session's listeners directly.
    const s = this.app.session as unknown as { listeners?: Set<(m: ServerMessage) => void> } | null
    for (const l of [...(s?.listeners ?? [])]) l(msg)
  }

  gm(cmd: string, ...args: string[]): Promise<Extract<ServerMessage, { t: 'gmResult' }> | null> {
    const ctx = this.need()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const i = this.gmWaiters.indexOf(done)
        if (i >= 0) this.gmWaiters.splice(i, 1)
        resolve(null)
      }, 4000)
      const done = (m: Extract<ServerMessage, { t: 'gmResult' }>) => {
        clearTimeout(timer)
        resolve(m)
      }
      this.gmWaiters.push(done)
      if (!ctx.send({ t: 'gm', cmd, args })) done({ t: 'gmResult', ok: false, cmd, message: 'not sent' })
    })
  }

  /** Learns every line ≤ the cap on the client (a `skillsUpdate`; the mock has no skill engine) so the windows show them. */
  learnAll(): string[] {
    const learned = this.lines().filter(c => !this.skills.get(c)?.basicAttack)
    const masteries: Record<string, number> = {}
    for (const c of learned) {
      const m = this.skills.get(c)?.mastery
      if (m) masteries[m] = CAP
    }
    this.deliver({ t: 'skillsUpdate', learned, masteries } as ServerMessage)
    return learned
  }

  /** Shows the own character holding a starter weapon of `family` (and the shield for one-handed ones). */
  async equip(family: Family | 'none'): Promise<void> {
    const v = this.self()
    const equip = { ...(v.state.equip ?? {}) }
    const code = family === 'none' ? null : STARTER_WEAPON_ITEMS[family]
    if (code) equip.weapon = code
    else delete equip.weapon
    if (family === 'sword' || family === 'blade') equip.shield = 'ITEM_CH_SHIELD_01_A_DEF'
    else delete equip.shield
    this.deliver({ t: 'appearance', id: v.id, equip })
    const until = now() + 5000
    const worn = () => v.actor?.wornCodes.some(c => /_CH_(SWORD|BLADE|SPEAR|TBLADE|BOW)_/.test(c)) ?? false
    while (now() < until && (code ? !v.actor?.wornCodes.includes(code) : worn())) await sleep(100)
    await sleep(300)
  }

  private weaponFamily(): Family | null {
    return familyOf(this.self().state.equip?.weapon)
  }

  /** Only bladed weapons carry the ai_start/ai_end trail points (bows and fists have none: no trail, FX-X report). */
  private weaponTrails(): boolean {
    const f = this.weaponFamily()
    return !!f && f !== 'bow'
  }

  /** Living mobs by distance from `from`. */
  private mobsNear(from: EntityView, max = 30): EntityView[] {
    const out: EntityView[] = []
    for (const v of this.need().views()) {
      if (v.kind !== 'mob' || v.dead || v.dying || v.isDisposed || v.fading) continue
      const d = Math.hypot(v.pos.x - from.pos.x, v.pos.z - from.pos.z)
      if (d <= max) out.push(v)
    }
    return out.sort((a, b) => Math.hypot(a.pos.x - from.pos.x, a.pos.z - from.pos.z) - Math.hypot(b.pos.x - from.pos.x, b.pos.z - from.pos.z))
  }

  /** Makes sure `n` Mangnyangs stand near you (GM spawn). */
  async ensureMobs(n = 5): Promise<EntityView[]> {
    const self = this.self()
    let mobs = this.mobsNear(self, 14)
    if (mobs.length < n) {
      await this.gm('spawn', MOB, String(n - mobs.length))
      const until = now() + 4000
      while (now() < until && this.mobsNear(self, 14).length < n) await sleep(150)
      await sleep(600)
      mobs = this.mobsNear(self, 14)
    }
    return mobs
  }

  /** Walks next to `t` (a real moveTo) when it is out of melee reach. */
  private async approach(t: EntityView, reach: number): Promise<void> {
    const self = this.self()
    const d = Math.hypot(t.pos.x - self.pos.x, t.pos.z - self.pos.z)
    if (d <= reach + 0.3) return
    const k = (d - reach) / d
    this.need().send({ t: 'moveTo', x: self.pos.x + (t.pos.x - self.pos.x) * k, z: self.pos.z + (t.pos.z - self.pos.z) * k })
    const until = now() + 6000
    await sleep(200)
    while (now() < until && (self.moving || self.move)) await sleep(100)
    await sleep(250)
  }

  private sideCamera(caster: EntityView, target: EntityView | undefined): void {
    const cam = this.ctx?.camera as ArcRotateCamera | undefined
    if (!cam) return
    const dx = target && target !== caster ? target.pos.x - caster.pos.x : Math.sin(caster.yaw)
    const dz = target && target !== caster ? target.pos.z - caster.pos.z : Math.cos(caster.yaw)
    const len = Math.hypot(dx, dz) || 1
    // Perpendicular to the caster → target line, slightly behind the caster.
    const px = -dz / len - (dx / len) * 0.35
    const pz = dx / len - (dz / len) * 0.35
    cam.alpha = Math.atan2(pz, px)
    cam.beta = 1.2
    cam.radius = Math.max(7, Math.min(11, len + 6))
  }

  // ---- one line ----------------------------------------------------------------------------------------------

  /**
   * Plays one skill line (a skill row code) the way the server would: `cast`, then at the release `combat` on the
   * target (and the area's other victims), buffs as `effectAdd`/`effectRemove`. target: 'nearest' mob or 'self'.
   */
  async cast(code: string, target: 'self' | 'nearest' = 'nearest', o: { shot?: boolean; camera?: boolean } = {}): Promise<LineRun | null> {
    await this.loadIndex()
    const def = this.skills.get(code)
    if (!def) {
      console.warn('[fxlab] unknown skill', code)
      return null
    }
    const self = this.self()
    // The weapon the row needs (basic attacks: their family).
    const fam = this.weaponFamily()
    const want = def.weapons?.length ? (def.weapons as Family[]) : []
    if (want.length && (!fam || !want.includes(fam))) await this.equip(want[0]!)
    else if (def.basicAttack && !def.mastery && fam) await this.equip('none')
    const offensive = def.kind === 'attack' || def.kind === 'debuff'
    let primary: EntityView = self
    if (offensive && target === 'nearest') {
      const mobs = await this.ensureMobs(def.area?.maxTargets ? Math.max(3, def.area.maxTargets) : 3)
      if (!mobs[0]) {
        console.warn('[fxlab] no mob near you for', code)
        return null
      }
      primary = mobs[0]
      const melee = !(def.hitCues ?? []).some(c => c.projectile) && def.range < 5
      const reach = melee ? Math.max(1.2, def.range + self.radius + primary.radius - 0.2) : Math.min(8, Math.max(3, def.range))
      await this.approach(primary, def.basicAttack && this.weaponFamily() === 'bow' ? 8 : reach)
    }
    if (o.camera !== false) this.sideCamera(self, primary)
    const group = this.groupOf(code)
    const t = now()
    const run: LineRun = { code, group, kind: def.kind ?? 'attack', start: t, t0: t, seen: false, tEnd: 0, caster: self.id, targets: primary !== self ? [primary.id] : [], release: 0, expects: [], hits: [], clips: [], notes: [], weapon: self.state.equip?.weapon }
    this.runs.push(run)
    this.current = run
    try {
      if (o.shot) void this.shoot(run, def.kind === 'attack' || def.kind === 'debuff' || !!def.basicAttack)
      if (def.basicAttack) await this.playBasic(def, self, primary, run)
      else if (def.instant || def.kind === 'imbue') await this.playInstant(def, self, primary, run)
      else await this.playAction(def, self, primary, run)
      await sleep(700)
    } finally {
      run.tEnd = now()
      this.current = null
    }
    return run
  }

  /** Basic attacks: two swings (no instance: the default attack presentation). */
  private async playBasic(def: SkillDef, self: EntityView, target: EntityView, run: LineRun): Promise<void> {
    if (target === self) {
      run.notes.push('no target')
      return
    }
    const hits = Math.max(1, def.damage?.hits ?? 1)
    for (let s = 0; s < 2; s++) {
      run.release = now()
      this.deliver({ t: 'combat', attacker: self.id, target: target.id, skill: def.code, hits: this.hits(target, hits, s === 1) })
      await sleep(Math.max(600, def.cooldownMs || 1200))
    }
    const skill = this.fxSkill(this.groupOf(def.code))
    if (skill?.trail && this.weaponTrails()) run.expects.push({ what: 'trail', key: skill.trail.texture ?? 'trail', phase: 'SHOT', at: null, anchor: 'caster', optional: true })
  }

  private hits(t: EntityView, n: number, crit = false, extra: Partial<CombatHit> = {}): CombatHit[] {
    const hp = t.hp > 0 ? t.hp : Math.max(1, t.maxHp)
    return Array.from({ length: n }, (_, i) => ({ outcome: crit && i === 0 ? 'crit' : 'hit', damage: 40 + Math.round(Math.random() * 60), hp, ...extra }) as CombatHit)
  }

  /** Instant lines (imbues, Grass Walk): `cast {instant}` then the effect; imbues then swing twice on a mob. */
  private async playInstant(def: SkillDef, self: EntityView, target: EntityView, run: LineRun): Promise<void> {
    const instance = ++this.instance
    run.release = now()
    this.deliver({ t: 'cast', id: self.id, skill: def.code, instance, prepareMs: 0, castMs: 0, actionMs: 0, instant: true })
    const effect: EffectState = { instance, skill: def.code, remainingMs: def.durationMs || 30000, source: self.id, level: def.skillLevel }
    this.deliver({ t: 'effectAdd', id: self.id, effect })
    if (def.kind === 'imbue') {
      const fam = this.weaponFamily() ?? 'sword'
      const basic = this.skills.get(BASIC_BY_FAMILY[fam])
      const mob = this.mobsNear(self)[0] ?? (await this.ensureMobs(3))[0]
      if (basic && mob) {
        await this.approach(mob, fam === 'bow' ? 8 : 1.4)
        this.sideCamera(self, mob)
        run.targets = [mob.id]
        for (let s = 0; s < 2; s++) {
          run.release = now()
          this.deliver({ t: 'combat', attacker: self.id, target: mob.id, skill: basic.code, hits: this.hits(mob, Math.max(1, basic.damage?.hits ?? 1)) })
          await sleep(Math.max(900, basic.cooldownMs || 1200))
        }
        this.expectImbueHits(def, run)
        const st = def.statuses?.[0]
        if (st) await this.status(mob, st.status, 1500)
      }
    } else await sleep(HOLD_MS)
    this.deliver({ t: 'effectRemove', id: self.id, instance, reason: 'cancelled' })
  }

  /** An abnormal state on a victim for `ms`, as effectAdd/effectRemove. */
  async status(v: EntityView, status: SkillStatusKind, ms: number): Promise<void> {
    const instance = ++this.instance
    this.deliver({ t: 'effectAdd', id: v.id, effect: { instance, status, remainingMs: ms, level: 1, source: this.self().id } })
    await sleep(ms)
    this.deliver({ t: 'effectRemove', id: v.id, instance, reason: 'expired' })
  }

  /** Actions with clips: cast (and each chain segment), the release, combat or the buff, the end. */
  private async playAction(def: SkillDef, self: EntityView, primary: EntityView, run: LineRun): Promise<void> {
    const instance = ++this.instance
    let row: SkillDef | undefined = def
    let t = now()
    let first = true
    while (row) {
      const prepareMs = Math.max(0, row.preparingMs ?? 0)
      const castMs = Math.max(0, row.castMs)
      const actionMs = Math.max(0, row.actionMs)
      const cast: Extract<ServerMessage, { t: 'cast' }> = { t: 'cast', id: self.id, skill: row.code, instance, prepareMs, castMs, actionMs }
      if (primary !== self) cast.target = primary.id
      await sleep(t - now())
      this.deliver(cast)
      await sleep(prepareMs + castMs)
      const release = now()
      if (first) run.release = release
      await this.release(row, self, primary, run, instance)
      t = release + actionMs
      first = false
      row = row.chainNext ? this.skills.get(row.chainNext) : undefined
    }
    await sleep(t - now())
  }

  private async release(row: SkillDef, self: EntityView, primary: EntityView, run: LineRun, instance: number): Promise<void> {
    const kind = row.kind ?? 'attack'
    if (kind === 'attack' || kind === 'debuff') {
      if (primary === self) return
      const victims = [primary, ...this.aoeVictims(row, self, primary)]
      run.targets = [...new Set([...run.targets, ...victims.map(v => v.id)])]
      const proj = (row.hitCues ?? []).find(c => c.projectile)?.projectile
      const n = Math.max(1, row.damage?.hits ?? 1)
      const down = (row.statuses ?? []).some(s => s.status === 'knockdown')
      const send = (v: EntityView, i: number) => {
        const msg: CombatMessage = { t: 'combat', attacker: self.id, target: v.id, skill: row.code, hits: this.hits(v, n, false, { ...(down ? { down: true as const } : {}), ...(row.damage ? {} : { damage: 0 }) }), instance }
        if (proj) msg.at = Math.round(this.need().serverNow())
        if (i > 0) msg.aoe = true
        this.deliver(msg)
      }
      if (proj) {
        // The server sends the combat when the projectile arrives (engine.ts `arrive`).
        victims.forEach((v, i) => {
          const d = Math.hypot(v.pos.x - self.pos.x, v.pos.z - self.pos.z)
          const at = proj.delayMs + (d / (proj.speed / 10)) * 1000
          setTimeout(() => send(v, i), at)
        })
      } else victims.forEach(send)
      const st = row.statuses?.find(s => s.status !== 'knockdown' && s.status !== 'knockback')
      if (st) {
        const cue = row.hitCues?.[0]
        void sleep(cue ? 900 : 300).then(() => this.status(primary, st.status, Math.min(st.durationMs || HOLD_MS, HOLD_MS)))
      }
      return
    }
    if (kind === 'heal' || kind === 'cure' || kind === 'resurrect') return
    // Buffs: the effect lands at the release and stays a while (the hawk a little longer, to see it circle).
    const effect: EffectState = { instance, skill: row.code, remainingMs: row.durationMs || 30000, source: self.id, level: row.skillLevel }
    this.deliver({ t: 'effectAdd', id: primary.id, effect })
    await sleep(row.group === 'SKILL_CH_BOW_CALL_A' ? HOLD_MS + 2000 : HOLD_MS)
    this.deliver({ t: 'effectRemove', id: primary.id, instance, reason: 'cancelled' })
  }

  /** Other victims of an area row (nearest living mobs within its reach), primary excluded. */
  private aoeVictims(row: SkillDef, self: EntityView, primary: EntityView): EntityView[] {
    const a = row.area
    if (!a || a.maxTargets === 1) return []
    const from = a.shape === 'caster' ? self : primary
    const reach = Math.max(a.distance, 3) + 1.5
    const max = a.maxTargets > 0 ? a.maxTargets - 1 : 4
    return this.mobsNear(from, reach)
      .filter(v => v !== primary)
      .slice(0, max)
  }

  /** Grabs the canvas at the first hit of a line (others: 0.5 s after the release) for the contact sheet. */
  private async shoot(run: LineRun, atHit: boolean): Promise<void> {
    const until = now() + 8000
    if (atHit) {
      while (now() < until && !run.hits.length) await sleep(16)
      if (!run.hits.length) return
      await sleep(60)
    } else {
      while (now() < until && !run.release) await sleep(16)
      await sleep(500)
    }
    try {
      const scene = this.need().scene
      const cam = scene.activeCamera
      if (!cam) return
      const eng = scene.getEngine()
      run.shot = await CreateScreenshotAsync(eng, cam, { width: 384, height: Math.round((384 * eng.getRenderHeight()) / Math.max(1, eng.getRenderWidth())) }, 'image/jpeg', 0.8)
    } catch (err) {
      run.notes.push(`screenshot failed: ${String(err)}`)
    }
  }

  // ---- expectations (the golden table, from the data) ------------------------------------------------------------

  private fxSkill(group: string): FxSkillV2 | undefined {
    return this.index.get(group)
  }

  private keyOf(skill: FxSkillV2, st: FxStageV2): string | null {
    if (st.effect && !/\.bsr$/i.test(st.effect)) return st.effect
    if (isFlight(st.actType)) return skill.arrowTail
    return null
  }

  /** The phases of one cast (the ActionPlayer's plan rules) with the clip each starts; the rows with their times. */
  private expectPhases(row: SkillDef, run: LineRun, t0: number): void {
    const self = this.self()
    const a = self.actor
    const plan = planPhases({ prepareMs: row.preparingMs ?? 0, castMs: row.castMs, actionMs: row.actionMs }, row, type => {
      const c = a?.skillClip(row.aniGroup, type)
      const info = c ? a?.clips.get(c.name) : undefined
      return info ? { durationMs: info.durationMs, hits: info.hits } : null
    })
    const skill = this.fxSkill(this.groupOf(row.code))
    // A chain head's SHOT holds its whole clip: the segments' rows sit on its events (SKILLS.md §5.2).
    let start = t0
    const shotStart = plan.reduce((s, p) => (p.phase === 'SHOT' ? s : s + p.ms), t0)
    for (const p of plan) {
      const clip = a?.skillClip(row.aniGroup, p.type)
      const info = clip ? a?.clips.get(clip.name) : undefined
      const hits = info?.hits ?? []
      const phaseStart = start
      const phaseEnd = start + (p.phase === 'SHOT' && row.chainNext ? Math.max(p.ms, info?.durationMs ?? 0) : p.ms)
      run.expects.push({ what: 'stage', key: `clip:${p.type}`, phase: p.phase, at: phaseStart, anchor: 'none', optional: false })
      for (const st of skill?.stages ?? []) {
        if (st.phase !== p.phase) continue
        const key = this.keyOf(skill!, st)
        const ev = st.startEvent > 0 ? hits[st.startEvent - 1] ?? 0 : 0
        const at = phaseStart + ev + (isFlight(st.actType) ? (Number((st.move ?? '').split(',')[1]) || 0) : 0)
        if (st.effect && /\.bsr$/i.test(st.effect)) {
          run.expects.push({ what: 'model', key: st.effect, phase: st.phase, at, anchor: 'caster', bone: st.startBone, optional: true, row: st.id })
          continue
        }
        if (!key) continue
        if (st.dmg && !isFlight(st.actType)) continue // at the hit (expectHits)
        const caster = st.actType === 'AT_ONE_FOLLOW' || st.actType === 'AT_LOOP' || isFlight(st.actType) || st.actType === 'AT_SOURCE'
        const e: Expect = {
          what: st.actType === 'AT_LOOP' ? 'loop' : 'stage',
          key,
          phase: st.phase,
          at,
          anchor: caster ? 'caster' : st.actType === 'AT_DMG_POS' ? 'victim' : 'target',
          bone: st.startBone,
          offset: parseOffset(st.startOffset) as FxVec3,
          roll: stageRoll(st.rotate, st.script),
          flight: isFlight(st.actType),
          row: st.id,
        }
        // READY/WAIT loops end when SHOT starts (or its Kill row plays); SHOT loops with their phase.
        if (st.actType === 'AT_LOOP') e.endBy = p.phase === 'SHOT' ? phaseEnd : Math.max(shotStart, phaseEnd)
        run.expects.push(e)
        if (isFlight(st.actType) && !st.dmg && st.effect2) run.expects.push({ what: 'arrive', key: st.effect2, phase: st.phase, at: null, anchor: 'target', row: st.id })
      }
      start = phaseEnd
    }
    // Trail while SHOT plays (attacks with a trail row): only the hook sees it.
    if (skill?.trail && this.weaponTrails() && (row.kind === 'attack' || row.basicAttack)) run.expects.push({ what: 'trail', key: skill.trail.texture ?? 'trail', phase: 'SHOT', at: null, anchor: 'caster', optional: true })
  }

  /** An imbue's own DamageEfp on the imbued basic hits, and its trail (M14). */
  private expectImbueHits(imbue: SkillDef, run: LineRun): void {
    const skill = this.fxSkill(this.groupOf(imbue.code))
    if (skill?.damage) run.expects.push({ what: 'spark', key: skill.damage, phase: 'HIT', at: null, anchor: 'victim', row: -1 })
    if (skill?.trail && this.weaponTrails()) run.expects.push({ what: 'trail', key: skill.trail.texture ?? 'trail', phase: 'SHOT', at: null, anchor: 'caster', optional: true })
  }

  /** ACT_S once and ACT_L loops on the carrier from `t` (heals: ACT_S only, at the release). */
  private expectBuff(row: SkillDef, run: LineRun, carrier: number, t: number, only?: 'ACT_S'): void {
    const skill = this.fxSkill(this.groupOf(row.code))
    for (const st of skill?.stages ?? []) {
      if (st.phase !== 'ACT_S' && (only || st.phase !== 'ACT_L')) continue
      if (st.effect && /\.bsr$/i.test(st.effect)) {
        run.expects.push({ what: 'model', key: st.effect, phase: st.phase, at: t, anchor: 'caster', bone: st.startBone, optional: true, row: st.id })
        continue
      }
      if (!st.effect) continue
      run.expects.push({
        what: st.phase === 'ACT_L' ? 'loop' : 'stage',
        key: st.effect,
        phase: st.phase,
        at: t,
        anchor: carrier === run.caster ? 'caster' : 'target',
        bone: st.startBone,
        offset: parseOffset(st.startOffset) as FxVec3,
        roll: stageRoll(st.rotate, st.script),
        victim: carrier,
        row: st.id,
      })
    }
  }

  private expectLoopEnd(run: LineRun, t: number): void {
    for (const e of run.expects) if (e.what === 'loop' && (e.phase === 'ACT_L' || e.endBy === undefined)) e.endBy = t
  }

  /** Hit-time rows, known once the hits are logged: DMG rows, DamageEfp, blood, flight arrivals. */
  private expectHits(run: LineRun): void {
    // Idempotent (I7B): a report() while a run is going must not add the same hit rows twice.
    run.expects = run.expects.filter(e => !e.fromHits)
    const before = run.expects.length
    const def = this.skills.get(run.code)
    if (!def || def.kind === 'imbue') return
    const byCode = new Map<string, SkillDef>()
    for (const h of run.hits) {
      const d = this.skills.get(h.skill)
      if (d) byCode.set(h.skill, d)
    }
    // Once per (cue, time) for caster-anchored DMG rows; per victim for victim-anchored ones.
    const casterDone = new Set<string>()
    for (const h of run.hits) {
      const row = byCode.get(h.skill) ?? def
      const skill = this.fxSkill(this.groupOf(row.code))
      if (!skill) continue
      const cues = row.hitCues ?? []
      const cue = cues[h.index] ?? cues[cues.length - 1] ?? { phase: 'SHOT', event: h.index + 1 }
      for (const st of skill.stages) {
        if (!st.dmg || st.phase !== cue.phase || st.startEvent !== cue.event) continue
        if (isFlight(st.actType)) {
          if (st.effect2) run.expects.push({ what: 'arrive', key: st.effect2, phase: st.phase, at: h.t, anchor: 'target', victim: h.target, row: st.id })
          continue
        }
        const key = this.keyOf(skill, st)
        if (!key) continue
        const onCaster = st.actType === 'AT_ONE_FOLLOW' || st.actType === 'AT_LOOP'
        if (onCaster) {
          const k = `${st.id}:${cue.phase}:${cue.event}:${Math.round(h.t / 40)}`
          if (casterDone.has(k)) continue
          casterDone.add(k)
        }
        run.expects.push({
          what: 'dmg',
          key,
          phase: st.phase,
          at: h.t,
          anchor: onCaster ? 'caster' : st.actType === 'AT_DMG_POS' ? 'victim' : 'target',
          bone: st.startBone,
          offset: parseOffset(st.startOffset) as FxVec3,
          roll: stageRoll(st.rotate, st.script),
          victim: h.target,
          row: st.id,
        })
      }
      if (skill.damage) run.expects.push({ what: 'spark', key: skill.damage, phase: 'HIT', at: h.t, anchor: 'victim', victim: h.target })
      const vic = this.need().view(h.target)
      const blood = vic ? this.chars[vic.state.model ?? '']?.bloodType : null
      if (skill.bleeds && blood) run.expects.push({ what: 'blood', key: blood, phase: 'HIT', at: h.t, anchor: 'victim', victim: h.target, optional: true })
    }
    for (const e of run.expects.slice(before)) e.fromHits = true
  }

  // ---- the report ----------------------------------------------------------------------------------------------

  private judge(run: LineRun): LineReport {
    this.expectHits(run)
    const problems: string[] = []
    const t1 = run.tEnd
    const fx = this.entries.filter(e => e.src === 'fx' && e.run === run.code && e.t >= run.start - 50 && e.t <= t1 + 200)
    const hooks = this.entries.filter(e => e.src === 'hook' && e.t >= run.start - 50 && e.t <= t1 + 200)
    const used = new Set<LabEntry>()
    const clips: ClipCheck[] = []
    const stages: ExpectResult[] = []
    const caster = this.ctx?.view(run.caster)
    const casterClips = run.clips.slice()
    for (const e of run.expects) {
      if (e.key.startsWith('clip:')) {
        const type = e.key.slice(5)
        const i = casterClips.findIndex(c => c.name === type || c.name.startsWith(`${type}_`) || (type === 'ATTACK' && /^ATTACK\d/.test(c.name)))
        const got = i >= 0 ? casterClips.splice(0, i + 1)[i]! : null
        const at = got ? got.t : null
        const ok = !!got && (e.at === null || Math.abs(got.t - e.at) <= 150)
        const c: ClipCheck = { phase: e.phase, type, clip: got?.name ?? null, at: at === null ? null : Math.round(at - run.t0), wantAt: Math.round((e.at ?? run.t0) - run.t0), ok }
        if (!got) c.note = 'clip never started'
        else if (!ok) c.note = `started ${Math.round(got.t - (e.at ?? 0))} ms off`
        clips.push(c)
        if (!ok) problems.push(`${e.phase} clip ${type}: ${c.note}`)
        continue
      }
      const r: ExpectResult = { ...e, status: 'missing' }
      // Phase rows placed on the target (AT_DMG_POS / AT_TARGET in READY/WAIT/SHOT) belong to the main target.
      if (r.victim === undefined && (r.anchor === 'victim' || r.anchor === 'target') && run.targets[0] !== undefined) r.victim = run.targets[0]
      if (e.what === 'model' || e.what === 'trail') {
        const h = hooks.find(x => (e.what === 'trail' ? x.kind === 'trail' : x.key === e.key || x.name === e.key || (x.name ?? '').includes(e.key.split(/[\\/]/).pop()!.replace(/\.bsr$/i, ''))))
        r.status = h ? 'ok' : hooks.length ? 'missing' : 'unverified'
        if (h) r.gotAt = Math.round(h.t - run.t0)
        stages.push(r)
        if (r.status === 'missing') problems.push(`${e.what} ${e.key} missing`)
        continue
      }
      const cands = fx.filter(x => !used.has(x) && x.key === e.key && (e.at === null || (x.t >= e.at - LATE_MS && x.t <= e.at + LATE_MS)))
      cands.sort((a, b) => (e.at === null ? a.t - b.t : Math.abs(a.t - e.at) - Math.abs(b.t - e.at)))
      // Rows on a victim (AoE: one per victim at the same moment): take the spawn nearest that victim's body.
      let got = cands[0]
      const vid = r.victim
      if (vid !== undefined && cands.length > 1) {
        const tv = this.ctx?.view(vid)
        const want = tv ? this.damageLocal(tv) : null
        const score = (x: LabEntry) => {
          const loc = x.victim?.[vid]
          const d = loc && want ? dist3(loc, want) : x.pos && tv ? Math.hypot(x.pos[0] - tv.pos.x, x.pos[2] - tv.pos.z) : 99
          return d + (e.at === null ? 0 : Math.abs(x.t - e.at) / 1000)
        }
        got = cands.reduce((a, b) => (score(b) < score(a) ? b : a))
      }
      if (got) {
        used.add(got)
        r.gotAt = Math.round(got.t - run.t0)
        if (e.at !== null) {
          r.deltaMs = Math.round(got.t - e.at)
          r.status = Math.abs(r.deltaMs) <= this.tolMs ? 'ok' : r.deltaMs > 0 ? 'late' : 'early'
        } else r.status = 'ok'
        this.anchorCheck(r, got, caster)
        const inst = [...this.born.entries()].find(([, b]) => b.entry === got)
        if (inst && e.what === 'loop' && e.endBy !== undefined) {
          const end = inst[1].disposedAt
          r.leaked = end === null || end > e.endBy + 3500
        }
      } else if (e.optional) r.status = 'unverified'
      stages.push(r)
      if (r.status === 'missing') problems.push(`${e.what} ${e.phase} ${e.key} missing`)
      else if (r.status === 'late' || r.status === 'early') problems.push(`${e.what} ${e.key} ${r.status} ${r.deltaMs} ms`)
      if (r.devM !== undefined && r.devM > (e.flight ? 0.5 : 0.1)) problems.push(`${e.what} ${e.key} placed ${round(r.devM, 2)} m off (${e.anchor}${e.bone ? ` ${e.bone}` : ''})`)
      if (r.leaked) problems.push(`loop ${e.key} still alive after its end`)
    }
    const extra: Record<string, number> = {}
    for (const x of fx) if (!used.has(x)) extra[x.key ?? x.name] = (extra[x.key ?? x.name] ?? 0) + 1
    // The same key spawned again beyond what the data asks: M8-style stacking.
    for (const [k, n] of Object.entries(extra)) if (stages.some(s => s.key === k && s.what === 'dmg' && s.anchor === 'caster')) problems.push(`${k} spawned ${n} extra time(s) (stacked)`)
    const leaks: string[] = []
    // Alive past its own length + the 3 s fade (a looping program: past the end of the run + the fade).
    const t = now()
    for (const b of this.born.values()) {
      if (b.run !== run.code || b.t < run.start || b.t > run.tEnd + 200 || b.disposedAt !== null) continue
      const due = b.lengthMs === null ? run.tEnd + 3500 : b.t + b.lengthMs + 3500
      if (t > due) leaks.push(b.key)
    }
    if (leaks.length) problems.push(`${leaks.length} effect(s) still alive after the drain: ${[...new Set(leaks)].join(', ')}`)
    return { code: run.code, group: run.group, kind: run.kind, ok: problems.length === 0, problems, clips, stages, extra, leaks, notes: run.notes, ...(run.shot ? { shot: run.shot } : {}) }
  }

  /** Anchor deviation: caster rows vs the joint (or root) + offset in caster-local metres; victim rows vs DamagePos. */
  private anchorCheck(r: ExpectResult, got: LabEntry, caster: EntityView | undefined): void {
    if (!got.local || !caster) return
    // StartOffset is in the caster's facing frame; the roll (col 24 / SCT_RUT) turns the effect, not where it sits.
    const off = r.offset ?? [0, 0, 0]
    if (r.anchor === 'caster') {
      const base: FxVec3 = r.bone ? got.joints?.[r.bone] ?? [0, 0, 0] : [0, 0, 0]
      if (r.bone && !got.joints?.[r.bone]) return
      const scale = caster.scale || 1
      const want: FxVec3 = [base[0] + off[0] * scale, base[1] + off[1] * scale, base[2] + off[2] * scale]
      r.want = r3(want)
      r.got = got.local
      r.devM = round(dist3(want, got.local), 3)
      return
    }
    if (r.anchor === 'victim' && r.victim !== undefined) {
      const loc = got.victim?.[r.victim]
      const tv = this.ctx?.view(r.victim)
      const want = tv ? this.damageLocal(tv) : null
      if (!loc || !want) return
      r.want = r3(want)
      r.got = loc
      // The row's own offset turns with the attacker, not the victim: allow its length.
      r.devM = round(Math.max(0, dist3(want, loc) - Math.hypot(...off)), 3)
    }
  }

  /**
   * A victim's DamagePos in its own frame (m): characterInfo stores raw dm in the file frame (FX-X report), so
   * (x, y, -z) * 0.1, times the view's scale. Null without a characterInfo row.
   */
  private damageLocal(v: EntityView): FxVec3 | null {
    const info = this.chars[v.state.model ?? '']
    if (!info) return null
    const dp = info.damagePos
    const s = v.scale || 1
    return [dp[0] * 0.1 * s, dp[1] * 0.1 * s, -dp[2] * 0.1 * s]
  }

  /** Runs every line (or the ones matching `only`) on the nearest Mangnyang, `gapMs` apart, then the drain. */
  async runAll(o: { only?: string | RegExp | string[]; gapMs?: number; shots?: boolean; drain?: boolean } = {}): Promise<FxLabReport> {
    if (this.busy) throw new Error('[fxlab] already running')
    this.busy = true
    try {
      await this.loadIndex()
      this.need()
      const match = (c: string) =>
        !o.only || (Array.isArray(o.only) ? o.only.some(s => c.includes(s)) : o.only instanceof RegExp ? o.only.test(c) : c.includes(o.only))
      const list = this.lines().filter(match)
      this.learnAll()
      await this.ensureMobs(5)
      await this.warm(list)
      const first = this.runs.length
      for (const code of list) {
        console.info(`[fxlab] ${code}`)
        try {
          await this.cast(code, 'nearest', { shot: o.shots !== false })
        } catch (err) {
          console.error('[fxlab] line failed', code, err)
        }
        await sleep(o.gapMs ?? 1200)
      }
      if (o.drain !== false) await sleep(DRAIN_MS)
      return this.report(this.runs.slice(first))
    } finally {
      this.busy = false
    }
  }

  /** Loads every program the lines use first, so a first spawn is not late by its download. */
  private async warm(codes: string[]): Promise<void> {
    const keys = new Set<string>()
    for (const c of codes) {
      const s = this.fxSkill(this.groupOf(c))
      if (!s) continue
      for (const k of [s.damage, s.defense, s.arrowTail, s.arrowForce]) if (k) keys.add(k)
      for (const st of s.stages) for (const k of [st.effect, st.effect2]) if (k && !/\.bsr$/i.test(k)) keys.add(k)
    }
    const lib = (this.gridLib ??= new FxLibrary(this.need().scene, OUT))
    await Promise.all([...keys].map(k => lib.load(k).catch(() => null)))
    // SkillFx loads its own copy: ask it too when its loader is reachable.
    for (const fx of this.skillFx) {
      const p = (fx as unknown as { program?: (k: string) => Promise<unknown> }).program
      if (typeof p === 'function') await Promise.all([...keys].map(k => p.call(fx, k)))
    }
  }

  /** The comparison of the last runs (or the given ones) with the data. */
  report(runs?: LineRun[]): FxLabReport {
    const list = runs ?? this.lastRuns()
    const detail = list.map(r => this.judge(r))
    const fx = [...this.skillFx][0]
    const text = detail
      .map(d => `${d.ok ? 'OK  ' : 'FAIL'} ${d.code.padEnd(36)} ${d.ok ? `${d.stages.filter(s => s.status === 'ok').length} stages` : d.problems.join('; ')}`)
      .join('\n')
    const live = [...this.born.values()].filter(b => b.disposedAt === null).length
    const rep: FxLabReport = {
      at: new Date().toISOString(),
      lines: detail.length,
      ok: detail.filter(d => d.ok).length,
      problems: detail.reduce((n, d) => n + d.problems.length, 0),
      skillFx: fx ? fx.stats : null,
      live,
      started: this.startedCount,
      disposed: this.disposedCount,
      detail,
      text,
    }
    this.lastReport = rep
    return rep
  }

  private lastRuns(): LineRun[] {
    // The latest run of each line.
    const by = new Map<string, LineRun>()
    for (const r of this.runs) by.set(r.code, r)
    return [...by.values()]
  }

  /**
   * The leak hunt (docs/WAVE_PLAN2.md §5.15): `n` casts of random lines, `gapMs` apart, about half of them cut short
   * by a `castEnd` at a random moment; then the drain. Nothing may stay alive (SkillFx started === disposed, no live
   * program of those lines) and the weapon must be visible again (Hide Weapon restored).
   */
  async hunt(n = 200, gapMs = 150): Promise<{ casts: number; cancelled: number; live: Record<string, number>; skillFx: unknown; weaponVisible: boolean | null }> {
    await this.loadIndex()
    const self = this.self()
    const mobs = await this.ensureMobs(3)
    const target = mobs[0]
    const codes = this.lines().filter(c => {
      const d = this.skills.get(c)
      return d && !d.basicAttack && !d.instant && d.kind !== 'imbue'
    })
    const t0 = now()
    let cancelled = 0
    for (let i = 0; i < n; i++) {
      const def = this.skills.get(codes[Math.floor(Math.random() * codes.length)]!)!
      const instance = ++this.instance
      const offensive = def.kind === 'attack' || def.kind === 'debuff'
      const cast: Extract<ServerMessage, { t: 'cast' }> = { t: 'cast', id: self.id, skill: def.code, instance, prepareMs: def.preparingMs ?? 0, castMs: def.castMs, actionMs: def.actionMs }
      if (offensive && target) cast.target = target.id
      this.deliver(cast)
      const release = (def.preparingMs ?? 0) + def.castMs
      if (Math.random() < 0.5) {
        cancelled++
        const at = Math.random() * (release + 300)
        setTimeout(() => this.deliver({ t: 'castEnd', id: self.id, instance, reason: 'cancelled' }), at)
      } else if (offensive && target && !target.dead) {
        setTimeout(() => this.deliver({ t: 'combat', attacker: self.id, target: target.id, skill: def.code, hits: this.hits(target, 1), instance }), release)
      }
      await sleep(gapMs)
    }
    await sleep(DRAIN_MS + 3000)
    const live: Record<string, number> = {}
    for (const b of this.born.values()) {
      if (b.t < t0 || b.disposedAt !== null) continue
      if (b.lengthMs !== null && now() < b.t + b.lengthMs + 3500) continue
      live[b.key] = (live[b.key] ?? 0) + 1
    }
    const out = { casts: n, cancelled, live, skillFx: this.stats(), weaponVisible: self.actor ? self.actor.weaponVisible : null }
    console.info('[fxlab] hunt', out)
    return out
  }

  // ---- system effects and drops --------------------------------------------------------------------------------

  /** Level-up, potions, return scroll on yourself, through the same frames the server sends. */
  async system(): Promise<{ event: string; keys: string[] }[]> {
    const self = this.self()
    const out: { event: string; keys: string[] }[] = []
    const watch = async (event: string, run: () => void, ms: number) => {
      const t0 = now()
      run()
      await sleep(ms)
      const keys = [...new Set([...this.born.values()].filter(b => b.t >= t0 && b.pos && Math.hypot(b.pos[0] - self.pos.x, b.pos[2] - self.pos.z) < 6).map(b => b.key))]
      out.push({ event, keys })
    }
    this.sideCamera(self, undefined)
    await watch('levelUp', () => this.deliver({ t: 'levelUp', id: self.id, level: self.state.level }), 7500)
    await watch('itemEffect HP potion', () => this.deliver({ t: 'itemEffect', id: self.id, item: 'ITEM_ETC_HP_POTION_01' }), 2500)
    await watch('itemEffect MP potion', () => this.deliver({ t: 'itemEffect', id: self.id, item: 'ITEM_ETC_MP_POTION_01' }), 2500)
    await watch(
      'return scroll (cast, done)',
      () => {
        this.deliver({ t: 'itemCast', id: self.id, item: 'ITEM_ETC_SCROLL_RETURN_01', castMs: 3000 })
        setTimeout(() => this.deliver({ t: 'itemCastEnd', id: self.id, item: 'ITEM_ETC_SCROLL_RETURN_01', reason: 'done' }), 3000)
      },
      5000,
    )
    console.table(out.map(o => ({ event: o.event, effects: o.keys.join(', ') || '(none)' })))
    return out
  }

  /**
   * Spawns `n` Mangnyangs and kills them yourself (a GM kill drops nothing: loot needs a player killer), so their
   * gold and item drops fall with the models and effects they get. `level`: yours first (GM setlevel), for quick kills.
   */
  async drops(n = 4, level = 20): Promise<{ id: number; model: string; keys: string[] }[]> {
    const self = this.self()
    if (level > self.state.level) await this.gm('setlevel', self.state.name, String(level))
    const res = await this.gm('spawn', MOB, String(n))
    const ids = ((res?.data as { ids?: number[] } | undefined)?.ids ?? []).slice()
    await sleep(1500)
    const t0 = now()
    for (const id of ids) {
      const v = this.need().view(id)
      if (!v || v.dead) continue
      this.sideCamera(self, v)
      this.need().send({ t: 'attack', target: id })
      const until = now() + 15000
      while (now() < until && !v.dead && !v.isDisposed) await sleep(200)
    }
    this.need().send({ t: 'stopAction' })
    await sleep(3000)
    const items = [...this.need().views()].filter(v => v.kind === 'item' && Math.hypot(v.pos.x - self.pos.x, v.pos.z - self.pos.z) < 15)
    const out = items.map(v => ({
      id: v.id,
      model: v.state.model ?? '',
      keys: [...new Set([...this.born.values()].filter(b => b.t >= t0 - 100 && b.pos && Math.hypot(b.pos[0] - v.pos.x, b.pos[2] - v.pos.z) < 1.2).map(b => b.key))],
    }))
    console.table(out.map(o => ({ id: o.id, model: o.model, effects: o.keys.join(', ') || '(none)' })))
    return out
  }

  // ---- the program grid ----------------------------------------------------------------------------------------

  /**
   * Every effect program of the matching groups in a grid in front of you, looping, with its name above it.
   * which: 'system' | 'mob' | 'player' | 'lines' (the lines ≤ the cap) | a group substring or RegExp; 30 per page.
   */
  async grid(which: string | RegExp = 'system', o: { page?: number; spacing?: number; perRow?: number } = {}): Promise<string[]> {
    await this.loadIndex()
    const ctx = this.need()
    this.clearGrid()
    const mine = new Set(this.lines().map(c => this.groupOf(c)))
    const groups = [...this.index.values()].filter(s =>
      which instanceof RegExp
        ? which.test(s.group)
        : which === 'lines'
          ? mine.has(s.group)
          : which === 'system' || which === 'mob' || which === 'player'
            ? s.kind === which
            : s.group.includes(which),
    )
    const keys: string[] = []
    for (const s of groups) {
      for (const k of [s.damage, s.defense, s.arrowTail, s.arrowForce]) if (k && !keys.includes(k)) keys.push(k)
      for (const st of s.stages) for (const k of [st.effect, st.effect2]) if (k && !/\.bsr$/i.test(k) && !keys.includes(k)) keys.push(k)
    }
    const per = 30
    const page = keys.slice((o.page ?? 0) * per, ((o.page ?? 0) + 1) * per)
    const self = this.self()
    const spacing = o.spacing ?? 4.5
    const perRow = o.perRow ?? 6
    const rows = Math.ceil(page.length / perRow)
    // Laid out around you, facing the camera (its ground direction), and the camera pulled up to see it all.
    const cam = ctx.camera as ArcRotateCamera
    const fwd: [number, number] = [-Math.cos(cam.alpha), -Math.sin(cam.alpha)]
    const right: [number, number] = [fwd[1], -fwd[0]]
    cam.beta = 0.8
    cam.radius = Math.max(18, Math.max(rows, perRow) * spacing * 1.15)
    const lib = (this.gridLib ??= new FxLibrary(ctx.scene, OUT))
    this.labels ??= this.makeLabelLayer()
    const ground = ctx.world()
    page.forEach((key, i) => {
      const row = Math.floor(i / perRow)
      const col = (i % perRow) - (perRow - 1) / 2
      const ahead = ((rows - 1) / 2 - row) * spacing
      const x = self.pos.x + fwd[0] * ahead + right[0] * col * spacing
      const z = self.pos.z + fwd[1] * ahead + right[1] * col * spacing
      const y = ground ? ground.heightAt(x, z, self.pos.y + 2) : self.pos.y
      const label = document.createElement('div')
      label.textContent = key.split('/').pop()!.replace(/\.efp$/, '')
      label.style.cssText = 'position:absolute;transform:translate(-50%,-100%);font:10px/1.2 Tahoma,sans-serif;color:#fff;text-shadow:0 0 2px #000,0 0 2px #000;white-space:nowrap;pointer-events:none'
      this.labels!.append(label)
      const cell: GridCell = { key, pos: [x, y, z], fx: null, label, wait: 0 }
      this.cells.push(cell)
      void lib.load(key).then(
        (effect: FxEffect) => {
          if (!this.cells.includes(cell)) return
          cell.fx = new FxInstance(lib, effect, { position: cell.pos, loop: effect.duration === null, camera: ctx.scene.activeCamera })
        },
        () => {
          label.textContent = `${label.textContent} (missing)`
          label.style.color = '#f66'
        },
      )
    })
    console.info(`[fxlab] grid ${String(which)}: ${keys.length} programs, page ${o.page ?? 0} shows ${page.length}`)
    return page
  }

  clearGrid(): void {
    for (const c of this.cells) {
      c.fx?.dispose()
      c.label.remove()
    }
    this.cells = []
  }

  private makeLabelLayer(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'fxlab-labels'
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;overflow:hidden'
    document.body.append(el)
    return el
  }

  private tickGrid(dt: number): void {
    const ctx = this.ctx
    if (!ctx) return
    const scene: Scene = ctx.scene
    const cam = scene.activeCamera
    const engine = scene.getEngine()
    const vp = cam?.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
    const canvas = engine.getRenderingCanvas()
    const k = canvas ? canvas.clientWidth / Math.max(1, engine.getRenderWidth()) : 1
    for (const c of this.cells) {
      if (c.fx) {
        c.fx.update(dt)
        if (c.fx.finished) {
          c.wait += dt
          if (c.wait > 0.6) {
            c.fx.restart()
            c.wait = 0
          }
        }
      }
      if (cam && vp) {
        const p = Vector3.Project(new Vector3(c.pos[0], c.pos[1] + 2.2, c.pos[2]), Matrix.IdentityReadOnly, scene.getTransformMatrix(), vp)
        const behind = p.z < 0 || p.z > 1
        c.label.style.display = behind ? 'none' : ''
        c.label.style.left = `${p.x * k}px`
        c.label.style.top = `${p.y * k}px`
      }
    }
  }

  // ---- the contact sheet ---------------------------------------------------------------------------------------

  /** A page with every line at its first damage cue (or its release), with the report's verdict under each. */
  sheet(): HTMLElement {
    this.sheetEl?.remove()
    const rep = this.lastReport ?? this.report()
    const el = document.createElement('div')
    el.className = 'fxlab-sheet'
    el.style.cssText =
      'position:fixed;inset:24px;z-index:9999;background:rgba(10,10,14,.94);border:1px solid #876;overflow:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;font:11px/1.3 Tahoma,sans-serif;color:#ddd'
    const close = document.createElement('button')
    close.textContent = 'Close'
    close.style.cssText = 'position:sticky;top:0;grid-column:1/-1;justify-self:end;padding:2px 10px'
    close.onclick = () => el.remove()
    el.append(close)
    for (const d of rep.detail) {
      const card = document.createElement('div')
      card.style.cssText = `border:1px solid ${d.ok ? '#4a6' : '#a54'};padding:4px;background:#111`
      if (d.shot) {
        const img = document.createElement('img')
        img.src = d.shot
        img.style.cssText = 'width:100%;display:block'
        card.append(img)
      }
      const cap = document.createElement('div')
      cap.style.cssText = 'margin-top:3px'
      cap.textContent = `${d.ok ? 'OK' : 'FAIL'} ${d.code.replace(/^SKILL_CH_/, '')}`
      cap.style.color = d.ok ? '#8e8' : '#f98'
      card.append(cap)
      if (!d.ok) {
        const p = document.createElement('div')
        p.style.cssText = 'color:#caa;font-size:10px'
        p.textContent = d.problems.slice(0, 4).join(' · ')
        card.append(p)
      }
      el.append(card)
    }
    document.body.append(el)
    this.sheetEl = el
    return el
  }

  // ---- log access ----------------------------------------------------------------------------------------------

  log(): LabEntry[] {
    return this.entries.slice()
  }

  clear(): void {
    this.entries = []
    this.runs = []
    this.lastReport = null
    for (const [k, b] of this.born) if (b.disposedAt !== null) this.born.delete(k)
  }

  /** Effect programs alive now, by key (for the leak hunt). */
  live(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const b of this.born.values()) if (b.disposedAt === null) out[b.key] = (out[b.key] ?? 0) + 1
    return out
  }

  stats(): unknown {
    return [...this.skillFx].map(f => f.stats)
  }
}

// ---- prototype hooks (installed once per page) ----------------------------------------------------------------

const PATCHED = Symbol.for('sro.fxlab.patched')

function patchFxInstance(lab: FxLab): void {
  const proto = FxInstance.prototype as unknown as Record<symbol, unknown> & { update(dt: number): void; dispose(): void }
  const holder = proto as unknown as { [PATCHED]?: { lab: FxLab } }
  if (holder[PATCHED]) {
    holder[PATCHED]!.lab = lab
    return
  }
  const state = { lab }
  holder[PATCHED] = state
  const seen = new WeakSet<object>()
  const update = proto.update
  const dispose = proto.dispose
  proto.update = function (this: FxInstance, dt: number) {
    if (!seen.has(this)) {
      seen.add(this)
      let pose: FxRootPose | null = null
      try {
        pose = (this as unknown as { pose: () => FxRootPose }).pose()
      } catch {
        pose = null
      }
      try {
        state.lab.fxBorn(this, pose)
      } catch (err) {
        console.warn('[fxlab] log failed', err)
      }
    }
    return update.call(this, dt)
  }
  proto.dispose = function (this: FxInstance) {
    try {
      state.lab.fxDisposed(this)
    } catch {
      // the log never breaks an effect
    }
    return dispose.call(this)
  }
}

function patchSkillFx(lab: FxLab): void {
  const proto = SkillFx.prototype as unknown as { update(dt: number): void; [PATCHED]?: { lab: FxLab } }
  if (proto[PATCHED]) {
    proto[PATCHED]!.lab = lab
    return
  }
  const state = { lab }
  proto[PATCHED] = state
  const update = proto.update
  proto.update = function (this: SkillFx, dt: number) {
    state.lab.adoptSkillFx(this)
    return update.call(this, dt)
  }
}

/** Installs the lab (main.ts, `?fxlab=1`): `window.__sroFxLab`. */
export function installFxLab(app: App): void {
  const lab = new FxLab(app)
  lab.install()
  ;(window as unknown as { __sroFxLab?: FxLab }).__sroFxLab = lab
}

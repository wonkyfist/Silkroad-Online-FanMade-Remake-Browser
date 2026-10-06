import { GOLD_ITEM_CODES, WINTER_CODES, WINTER_PLAY, WINTER_WORLD, YETI_KIT, YETI_LAIRS, inCone, yawTowards, yetiNest, type MobDef, type NestDef, type ServerMessage, type Vec3, type YetiSkill } from '@sro/shared'
import type { UniqueRow } from '../db.ts'
import { rollSkillHit } from '../formulas.ts'
import { goldCode, type Gameplay, type RolledDrop } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import type { GameplayModule, KillOwner } from '../modules.ts'
import type { NavPoint } from '../nav.ts'
import type { Mob, Player } from '../world.ts'
import type { WinterPlay } from './service.ts'

/**
 * The Ice Yeti (docs/WINTER.md §13.4): the snow season's world boss, a Big-Eyed Ghost grown huge under white fur. A
 * GameplayModule named `iceYeti`:
 *
 * - **Season only.** While the winter layer is on she spawns 10-30 min after it begins (or after a boot), at one of the
 *   lairs in the snowy north-western mountains (YETI_LAIRS; the first that places on the navmesh, in a random order),
 *   and respawns YETI_RESPAWN_MIN (± 25 %) after a kill. When the layer goes off she retreats (despawns) and waits for
 *   the next season. Her timer is a row of the `uniques` table (code MOB_WINTER_ICE_YETI), so a restart keeps it; a
 *   row that was alive at shutdown respawns 1-2 min after the boot.
 * - **Announced like Tiger Girl**: `uniqueNotice` appeared (the area, her roar for players within 120 m) and defeated (the
 *   loot-owner group). A GM kill or despawn is silent.
 * - **Her kit** besides the basic swings, one move every 2.5 s at most while she fights, each telegraphed (`yetiSkill`;
 *   she stands still while she winds up): Ground Slam (6 m around her: 160 % damage and a 3 s slow), Frost Breath (a
 *   10 m cone of 70°: 120 %, a slow and 25 warmth), Snowball Barrage (5 big snowballs at up to three players within
 *   22 m: 45 % each), Roar (16 m: a slow and 20 warmth; the first roar below half HP calls two Snow Spirits). Below 30 %
 *   HP she is enraged (damage x 1.3). A leash reset clears all of it and sends her spirits away.
 * - **Loot**: three gold piles, YETI gift boxes (GIFT_YETI_COUNT), potions, a Lucky Powder and a good chance of an
 *   elixir, for the loot-owner group (it replaces any drops.json row).
 */

export const YETI_USAGE = 'yeti [spawn [here] | kill | despawn | timer <minutes|now>]'

const MINUTE_MS = 60_000
const RESTART_MIN: [number, number] = [1, 2]
const RETRY_MS = 60_000
/** Players within this many metres hear her enrage and retreat lines. */
const AREA_LINE_M = 60

interface Pending {
  skill: YetiSkill
  at: number
  pos: Vec3
  yaw: number
}

export class YetiService implements GameplayModule {
  readonly name = 'iceYeti'
  private row: UniqueRow | null = null
  /** The live mob's entity id (a corpse included until its death is handled). */
  id: number | null = null
  private lair = 0
  private readonly cd: Record<YetiSkill, number> = { slam: 0, breath: 0, barrage: 0, roar: 0 }
  private nextKitAt = 0
  private pending: Pending | null = null
  private enraged = false
  private addsCalled = false
  private readonly adds = new Set<number>()
  private wasOn = false
  /** Telegraphs sent (tests). */
  readonly cast: YetiSkill[] = []

  constructor(
    private readonly g: Gameplay,
    private readonly play: WinterPlay,
  ) {}

  private get mob(): MobDef | undefined {
    return this.g.data.mob(WINTER_CODES.yeti)
  }

  /** Her timer row (the `uniques` table, loaded on first use). */
  private state(): UniqueRow {
    if (this.row) return this.row
    const r = this.g.store.db.prepare('SELECT code, phase, due_at, camp, spawns, last_killer, last_killed_at FROM uniques WHERE code = ?').get(WINTER_CODES.yeti) as UniqueRow | undefined
    this.row = r ? { ...r } : { code: WINTER_CODES.yeti, phase: 'waiting', due_at: 0, camp: null, spawns: 0, last_killer: null, last_killed_at: null }
    // alive at shutdown: she comes back soon after the boot (when the season is on)
    if (this.row.phase === 'alive') {
      this.row.phase = 'waiting'
      this.row.due_at = this.g.now + this.minutes(RESTART_MIN)
      this.save()
    }
    return this.row
  }

  private save(): void {
    const r = this.row
    if (!r) return
    this.g.store.db
      .prepare(
        `INSERT INTO uniques (code, phase, due_at, camp, spawns, last_killer, last_killed_at) VALUES (@code, @phase, @due_at, @camp, @spawns, @last_killer, @last_killed_at)
         ON CONFLICT(code) DO UPDATE SET phase = excluded.phase, due_at = excluded.due_at, camp = excluded.camp, spawns = excluded.spawns, last_killer = excluded.last_killer, last_killed_at = excluded.last_killed_at`,
      )
      .run({ ...r })
  }

  private minutes(r: readonly [number, number]): number {
    return Math.round((r[0] + this.g.rng() * (r[1] - r[0])) * MINUTE_MS)
  }

  private respawnMs(): number {
    const m = this.play.knobs().yetiRespawnMin
    const s = WINTER_PLAY.yeti.respawnSpread
    return this.minutes([m * (1 - s), m * (1 + s)])
  }

  /** The live yeti, or null. */
  live(): Mob | null {
    const m = this.id === null ? undefined : this.g.world.mobs.get(this.id)
    return m && m.ai !== 'dead' ? m : null
  }

  /** Server ms of her next spawn while she waits (0 = not scheduled), for the GM line and tests. */
  get dueAt(): number {
    return this.state().due_at
  }

  // ---- the scheduler ----------------------------------------------------------------------------------------

  tick(now: number): void {
    if (this.g.config.world !== WINTER_WORLD || !this.mob) return
    const r = this.state()
    const on = this.play.isOn
    if (!on) {
      if (this.wasOn) this.retreat(now)
      this.wasOn = false
      return
    }
    if (!this.wasOn) {
      this.wasOn = true
      // the season (or a preview) began: her first spawn of it, unless a timer already runs
      if (r.phase === 'waiting' && r.due_at === 0) {
        r.due_at = now + this.minutes(WINTER_PLAY.yeti.firstSpawnMin)
        this.save()
      }
    }
    if (this.id === null) {
      if (r.phase === 'waiting' && r.due_at > 0 && now >= r.due_at && this.g.config.spawnMobs !== false) this.spawn(now)
      return
    }
    const m = this.g.world.mobs.get(this.id)
    if (!m || m.ai === 'dead') return this.ended(now, null, m ? 'killed by a GM' : 'removed')
    this.behave(m, now)
  }

  /** She appears at a lair (the given one, else the first that places in a random order); saved and announced. */
  spawn(now: number, at?: { point: NavPoint; lair: number }): Mob | null {
    const def = this.mob
    if (!def || this.live()) return null
    let place = at ?? null
    if (!place) {
      const order = YETI_LAIRS.map((_, i) => i).sort(() => this.g.rng() - 0.5)
      for (const i of order) {
        const p = this.g.nestSpawnPoint(yetiNest(i, def))
        if (p) {
          place = { point: p, lair: i }
          break
        }
        this.g.config.log(`winter: the Ice Yeti's lair ${i} does not place on the navmesh; skipped`)
      }
    }
    const r = this.state()
    if (!place) {
      r.due_at = now + RETRY_MS
      this.save()
      return null
    }
    const nest: NestDef = yetiNest(place.lair, def)
    const pt = place.point
    // the placed point's height (the navmesh's; a flat world gives the hint back)
    const y = Number.isFinite(pt.y) ? pt.y : (nest.y ?? 0)
    const m = this.g.createMob(def, 'unique', pt.x, pt.z, y, nest, now, pt.surface, { hpMul: this.play.knobs().yetiHpMul })
    m.corpseMs = WINTER_PLAY.yeti.corpseSec * 1000
    this.id = m.id
    this.lair = place.lair
    this.resetFight(m)
    r.phase = 'alive'
    r.due_at = 0
    r.camp = nest.id
    r.spawns++
    this.save()
    const area = this.g.data.zoneName(pt.x, pt.z, this.g.setup.regionOrigin)
    this.g.config.log(`winter: the Ice Yeti appeared at lair ${place.lair}${area ? ` (${area})` : ''}, id ${m.id}, ${m.maxHp} HP`)
    const near = new Set(this.g.world.playersNear(pt.x, pt.z, WINTER_PLAY.yeti.roarRadiusM, now).map((p) => p.id))
    const msg = { t: 'uniqueNotice', event: 'appeared', mob: def.code, name: m.name, ...(area ? { area } : {}), at: Math.round(now) } as const
    for (const p of this.g.world.players.values()) p.send(near.has(p.id) ? { ...msg, roar: true } : msg)
    return m
  }

  /** The season (or the preview) ended with her alive: she retreats into the mountains, quietly. */
  private retreat(now: number): void {
    const m = this.live()
    if (m) {
      this.areaLine(m, now, `${m.name} retreats into the mountains.`)
      this.g.world.removeEntity(m.id)
    } else if (this.id !== null && this.g.world.mobs.has(this.id)) this.g.world.removeEntity(this.id)
    this.dismissAdds()
    this.id = null
    this.pending = null
    const r = this.state()
    r.phase = 'waiting'
    // the next season rolls her first spawn again
    r.due_at = 0
    this.save()
  }

  /** Her life ended: a rewarded kill (announced) or a GM kill / removal (silent). The respawn timer runs. */
  private ended(now: number, owner: KillOwner | null, how: string): void {
    const def = this.mob
    this.id = null
    this.pending = null
    this.dismissAdds()
    const r = this.state()
    r.phase = 'waiting'
    r.due_at = now + this.respawnMs()
    if (owner) {
      r.last_killer = owner.player?.name ?? null
      r.last_killed_at = Math.round(now)
    }
    this.save()
    this.g.config.log(`winter: the Ice Yeti ${how}; next spawn in ${Math.round((r.due_at - now) / MINUTE_MS)} min`)
    if (owner && def) {
      const by = owner.player?.name
      const msg: ServerMessage = { t: 'uniqueNotice', event: 'defeated', mob: def.code, name: def.name ?? def.code, ...(by ? { by } : {}), ...(by && owner.party !== null ? { party: true } : {}) }
      for (const p of this.g.world.players.values()) p.send(msg)
    }
  }

  // ---- the fight --------------------------------------------------------------------------------------------

  private resetFight(m: Mob): void {
    for (const k of Object.keys(this.cd) as YetiSkill[]) this.cd[k] = 0
    this.nextKitAt = 0
    this.pending = null
    this.enraged = false
    this.addsCalled = false
    delete m.damageMul
    delete m.holdUntil
  }

  private behave(m: Mob, now: number): void {
    if (this.pending) {
      if (now >= this.pending.at) this.land(m, this.pending, now)
      return
    }
    if (m.ai === 'return' || (m.ai === 'idle' && m.damage.size === 0)) {
      if (this.enraged || this.addsCalled || this.adds.size > 0) {
        this.dismissAdds()
        this.resetFight(m)
      }
      return
    }
    if (!this.enraged && m.hp <= (m.maxHp * WINTER_PLAY.yeti.enrageHpPct) / 100) {
      this.enraged = true
      m.damageMul = WINTER_PLAY.yeti.enrageDamageMul
      this.areaLine(m, now, `${m.name} howls in fury!`)
    }
    if (m.ai !== 'chase' || m.target === null || now < this.nextKitAt) return
    const target = this.g.world.players.get(m.target)
    if (!target || target.dead) return
    this.nextKitAt = now + WINTER_PLAY.yeti.kitEveryMs
    const skill = this.choose(m, target, now)
    if (skill) this.windUp(m, skill, target, now)
  }

  /** The move for now: the ones off cooldown whose reach fits, by weight. */
  private choose(m: Mob, target: Player, now: number): YetiSkill | null {
    const at = this.g.world.positionAt(m, now)
    const tp = this.g.world.positionAt(target, now)
    const d = Math.hypot(tp[0] - at[0], tp[2] - at[2]) - m.radius
    const near = this.victims(m, at, YETI_KIT.barrage.radiusM, now).length
    const options: [YetiSkill, number][] = []
    if (now >= this.cd.slam && d <= YETI_KIT.slam.radiusM - 1) options.push(['slam', 3])
    if (now >= this.cd.breath && d <= YETI_KIT.breath.radiusM - 1) options.push(['breath', 3])
    if (now >= this.cd.barrage && near > 0 && d > 3) options.push(['barrage', 4])
    if (now >= this.cd.barrage && near > 1) options.push(['barrage', 2])
    if (now >= this.cd.roar && (m.hp < m.maxHp * 0.7 || near > 2)) options.push(['roar', 2])
    if (options.length === 0) return null
    const total = options.reduce((s, [, w]) => s + w, 0)
    let r = this.g.rng() * total
    return (options.find(([, w]) => (r -= w) < 0) ?? options[options.length - 1]!)[0]
  }

  /** The telegraph: she stops, faces the target and every viewer sees where it lands. */
  windUp(m: Mob, skill: YetiSkill, target: Player | null, now: number): void {
    const k = YETI_KIT[skill]
    const at = this.g.world.positionAt(m, now)
    const tp = target ? this.g.world.positionAt(target, now) : null
    const yaw = tp ? yawTowards(tp[0] - at[0], tp[2] - at[2]) : m.yaw
    this.g.world.halt(m, now, yaw)
    m.holdUntil = now + k.castMs
    this.cd[skill] = now + k.cooldownMs
    const pos: Vec3 = [at[0], at[1], at[2]]
    this.pending = { skill, at: now + k.castMs, pos, yaw }
    this.cast.push(skill)
    const msg: ServerMessage = { t: 'yetiSkill', id: m.id, skill, at: Math.round(now + k.castMs), castMs: k.castMs, pos: round3(pos), yaw: Math.round(yaw * 1000) / 1000, radiusM: k.radiusM }
    if (skill === 'breath') msg.angleDeg = YETI_KIT.breath.angleDeg
    this.g.world.broadcastAbout(m, msg)
  }

  /** The move lands: damage, slows and the cold on the players it reaches. */
  private land(m: Mob, p: Pending, now: number): void {
    this.pending = null
    delete m.holdUntil
    const o = { x: p.pos[0], z: p.pos[2] }
    if (p.skill === 'barrage') {
      const k = YETI_KIT.barrage
      const list = this.victims(m, p.pos, k.radiusM, now).slice(0, 3)
      for (let i = 0; i < k.count && list.length; i++) {
        const t = list[i % list.length]!
        const q = this.g.world.positionAt(t, now)
        const jitter = i < list.length ? 0 : 1.2
        const to: Vec3 = [q[0] + (this.g.rng() - 0.5) * jitter, q[1] + 1, q[2] + (this.g.rng() - 0.5) * jitter]
        this.play.snowballs.launch(m, [p.pos[0], p.pos[1] + m.radius * 1.4, p.pos[2]], to, null, now + i * 120, true, k.hitRadiusM)
      }
      return
    }
    const k = YETI_KIT[p.skill]
    const hitList = this.victims(m, p.pos, k.radiusM + 0.5, now).filter((t) => {
      if (p.skill !== 'breath') return true
      const q = this.g.world.positionAt(t, now)
      return inCone(o, p.yaw, { x: q[0], z: q[2] }, YETI_KIT.breath.radiusM, YETI_KIT.breath.angleDeg)
    })
    for (const t of hitList) this.strike(m, t, k.pct, k.slowPct, k.slowMs, k.chill, now)
    if (p.skill === 'roar' && !this.addsCalled && m.hp < m.maxHp / 2) {
      this.addsCalled = true
      this.callAdds(m, now)
    }
  }

  /** One player hit by a move: `pct` of her attack (0 = no damage), the slow and the cold. */
  private strike(m: Mob, t: Player, pct: number, slowPct: number, slowMs: number, chill: number, now: number): void {
    if (pct > 0) {
      const h = rollSkillHit(m.combat, t.combat, { pct: pct * (m.damageMul ?? 1), magic: false }, this.g.rng)
      this.g.dealHits(m, t, [{ outcome: h.outcome, damage: h.damage, hp: 0 }], { aoe: true }, now)
    }
    if (t.dead) return
    if (slowPct > 0) this.play.slow(t, slowPct, slowMs, now)
    if (chill > 0) this.play.warmth.add(t, -chill, now)
  }

  /** A big snowball of her barrage hit a player (snowballs.ts onBigHit). */
  barrageHit(thrower: number, t: Player, now: number): void {
    const m = this.g.world.mobs.get(thrower)
    if (!m || m.id !== this.id || m.ai === 'dead') return
    const k = YETI_KIT.barrage
    this.strike(m, t, k.pct, k.slowPct, k.slowMs, k.chill, now)
  }

  /** Living, hittable players within `r` of `at` (never inside a town, never a trance body or an invisible GM). */
  private victims(_m: Mob, at: Vec3, r: number, now: number): Player[] {
    return this.g.world.playersNear(at[0], at[2], r, now).filter((p) => {
      if (p.dead || p.trance || p.invisible) return false
      const q = this.g.world.positionAt(p, now)
      return Math.abs(q[1] - at[1]) < 8 && !this.g.data.inSafeArea(this.g.config.world, q[0], q[2])
    })
  }

  private callAdds(m: Mob, now: number): void {
    const def = this.g.data.mob(WINTER_CODES.spirit)
    if (!def) return
    const at = this.g.world.livePoint(m, now)
    for (let i = 0; i < WINTER_PLAY.yeti.adds; i++) {
      const a = this.g.rng() * Math.PI * 2
      const [x, z] = this.g.world.clamp(at.x + Math.sin(a) * 4, at.z + Math.cos(a) * 4)
      const w = this.g.nav.kind === 'mesh' ? this.g.nav.walk(at, x, z) : null
      const p = w && Number.isFinite(w.end.y) ? w.end : { x, y: at.y, z, surface: at.surface }
      const add = this.g.createMob(def, 'normal', p.x, p.z, p.y, m.nest, now, p.surface)
      add.ai = 'chase'
      add.target = m.target
      this.adds.add(add.id)
    }
    this.areaLine(m, now, `${m.name} calls the snow spirits!`)
  }

  private dismissAdds(): void {
    for (const id of this.adds) {
      const a = this.g.world.mobs.get(id)
      if (a && a.ai !== 'dead') this.g.world.removeEntity(id)
    }
    this.adds.clear()
  }

  private areaLine(m: Mob, now: number, text: string): void {
    const at = this.g.world.positionAt(m, now)
    for (const p of this.g.world.playersNear(at[0], at[2], AREA_LINE_M, now)) p.send({ t: 'chat', channel: 'system', text })
  }

  // ---- Gameplay seams ---------------------------------------------------------------------------------------

  mobDied(m: Mob, now: number, _credit: ReadonlySet<number>, owner: KillOwner): void {
    this.adds.delete(m.id)
    if (m.id === this.id) this.ended(now, owner, `defeated by ${owner.player?.name ?? 'nobody'}${owner.party !== null ? "'s party" : ''}`)
  }

  /** Her whole loot (null for every other mob). */
  drops(m: Mob): RolledDrop[] | null {
    if (m.id !== this.id) return null
    const rng = this.g.rng
    const known = (c: string) => this.g.data.items.has(c)
    const out: RolledDrop[] = []
    const goldRate = this.g.config.goldRate ?? 1
    for (let i = 0; i < 3; i++) {
      const amount = Math.round((3000 + rng() * 3000) * goldRate)
      if (amount > 0) out.push({ code: goldCode(amount), count: amount, gold: true })
    }
    const gifts = this.play.knobs().giftYetiCount
    if (gifts > 0 && known(WINTER_CODES.gift)) out.push({ code: WINTER_CODES.gift, count: gifts })
    const add = (code: string, count: number, chance = 1) => {
      if (known(code) && rng() < Math.min(1, chance * (this.g.config.dropRate ?? 1))) out.push({ code, count })
    }
    add('ITEM_ETC_HP_POTION_03', 10)
    add('ITEM_ETC_MP_POTION_03', 10)
    add('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_02', 2, 0.8)
    add(rng() < 0.5 ? 'ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A' : 'ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_ARMOR_A', 1, 0.6)
    add(WINTER_CODES.tea, 5)
    return out
  }

  forget(p: Player): void {
    void p
  }

  // ---- GM -------------------------------------------------------------------------------------------------

  gm(self: Player | null, args: string[], now: number): GmResult {
    const a = (args[0] ?? '').toLowerCase()
    const usage: GmResult = { ok: false, message: `Usage: ${YETI_USAGE}` }
    if (!this.mob) return { ok: false, message: 'No Ice Yeti on this server (the winter content is not installed).' }
    const r = this.state()
    if (args.length === 0) {
      const m = this.live()
      if (m) {
        const at = this.g.world.positionAt(m, now)
        return { ok: true, message: `Ice Yeti alive (id ${m.id}, lair ${this.lair}, ${Math.round(m.hp)}/${m.maxHp} HP${this.enraged ? ', enraged' : ''}) at ${Math.round(at[0])}, ${Math.round(at[2])}.`, data: { id: m.id } }
      }
      const when = r.due_at > 0 ? `spawns in ${Math.max(0, Math.round((r.due_at - now) / 1000))} s` : 'no timer (waits for the season)'
      return { ok: true, message: `Ice Yeti waiting: ${when}; the winter layer is ${this.play.isOn ? 'on' : 'off'}; spawned ${r.spawns} times; last killed by ${r.last_killer ?? 'nobody'}.`, data: { dueAt: r.due_at } }
    }
    if (a === 'spawn') {
      if (args.length > 2 || (args.length === 2 && args[1]!.toLowerCase() !== 'here')) return usage
      if (this.live()) return { ok: false, message: 'The Ice Yeti is already in the world (`yeti despawn` first).' }
      let at: { point: NavPoint; lair: number } | undefined
      if (args[1]?.toLowerCase() === 'here') {
        if (!self) return { ok: false, message: 'Only in the world.' }
        const lp = this.g.world.livePoint(self, now)
        const ahead = this.g.nav.kind === 'mesh' ? this.g.nav.place(lp.x + Math.sin(self.yaw) * 8, lp.z + Math.cos(self.yaw) * 8, lp.y, 10) : null
        at = { point: ahead ?? lp, lair: 0 }
      }
      const m = this.spawn(now, at)
      if (!m) return { ok: false, message: 'No lair places on the navmesh here.' }
      return { ok: true, message: `The Ice Yeti appeared (id ${m.id}${at ? ', in front of you' : `, lair ${this.lair}`}); announced.${this.play.isOn ? '' : ' Note: the winter layer is off now; she retreats at the next tick unless `winter preview on`.'}`, data: { id: m.id } }
    }
    if (a === 'kill' || a === 'despawn') {
      const m = this.live()
      if (!m || args.length !== 1) return m ? usage : { ok: false, message: 'The Ice Yeti is not in the world.' }
      if (a === 'kill') this.g.gmKill(m, now)
      else this.g.world.removeEntity(m.id)
      this.ended(now, null, a === 'kill' ? 'killed by a GM' : 'despawned by a GM')
      return { ok: true, message: `The Ice Yeti ${a === 'kill' ? 'killed' : 'despawned'} (not announced); next spawn in ${Math.round((this.state().due_at - now) / MINUTE_MS)} min.` }
    }
    if (a === 'timer') {
      const v = (args[1] ?? '').toLowerCase()
      const min = v === 'now' ? 0 : Number(v)
      if (args.length !== 2 || !Number.isFinite(min) || min < 0 || min > 10_000) return usage
      if (this.live()) return { ok: false, message: 'The Ice Yeti is alive; the timer starts at her death.' }
      r.phase = 'waiting'
      r.due_at = Math.max(1, Math.round(now + min * MINUTE_MS))
      this.save()
      return { ok: true, message: `The Ice Yeti spawns in ${min} min${this.play.isOn ? '' : ' (once the winter layer is on)'}.` }
    }
    if (a === 'skill') {
      // tests and showcases: `yeti skill <slam|breath|barrage|roar>` at the GM
      const s = (args[1] ?? '') as YetiSkill
      const m = this.live()
      if (!m || !(s in YETI_KIT) || args.length !== 2) return usage
      this.windUp(m, s, self, now)
      return { ok: true, message: `The Ice Yeti winds up ${s}.` }
    }
    return usage
  }

  /** The gold code of a pile (kept here so a test can tell piles from items). */
  static isGold(code: string): boolean {
    return (GOLD_ITEM_CODES as readonly string[]).includes(code)
  }
}

function round3(v: Vec3): Vec3 {
  return [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 1000) / 1000, Math.round(v[2] * 1000) / 1000]
}

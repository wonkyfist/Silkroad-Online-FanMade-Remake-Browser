import { dirname, join } from 'node:path'
import { WINTER_CAMPFIRES, WINTER_WORLD, installWinterContent, setWinterShopTab, winterSeasonKey, type ColdEnv, type FireSpot, type ServerMessage, type Vec3, type WinterPlayState } from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import type { GameplayModule } from '../modules.ts'
import type { Player } from '../world.ts'
import { FireIndex, loadWorldFires } from './fires.ts'
import { GiftService } from './gifts.ts'
import { winterKnobs, type WinterKnobs } from './knobs.ts'
import { WinterMonsters } from './monsters.ts'
import { SnowballService } from './snowballs.ts'
import { WarmthService } from './warmth.ts'
import { YetiService } from './yeti.ts'

/**
 * The winter gameplay layer (docs/WINTER.md §13). A GameplayModule named `winterPlay` that owns the season gate and the
 * parts every winter module shares, and builds the five winter modules Gameplay registers right after it:
 * warmth (warmth.ts), snowballs (snowballs.ts), snow spirits (monsters.ts), the Ice Yeti (yeti.ts), gift boxes (gifts.ts).
 *
 * - **The gate**: on while WINTER_PLAY is on and the snow season is (WinterService.active) or a GM previews it
 *   (`winter preview on`). Checked once a second (and at once on an admin change); every player hears `winterPlay`
 *   when it turns on or off, or when snowballs become possible or not (the snow cover against SNOWBALL_COVER).
 * - **Content**: the derived winter monsters, Ginger Tea and the gift box go into GameData at construction
 *   (winter-play.ts installWinterContent; existing rows win); the potion shop's Winter tab exists only while it is on.
 * - **Fires**: the winter campfires (placed on the navmesh) at once, the world's fire placements once the manifest is read.
 * - **Slows**: one stat-mod provider for the cold (warmth level) and the snowball / yeti slows (the larger counts),
 *   refreshed only when a player's slow changes.
 */
export class WinterPlay implements GameplayModule {
  readonly name = 'winterPlay'
  readonly warmth: WarmthService
  readonly snowballs: SnowballService
  readonly monsters: WinterMonsters
  readonly yeti: YetiService
  readonly gifts: GiftService
  /** The winter modules Gameplay registers after this one. */
  readonly parts: readonly GameplayModule[]
  readonly fires = new FireIndex()
  /** The winter's campfires as placed (glTF metres), for the client. */
  campfires: Vec3[] = []
  private on = false
  private snowOk = false
  private lastCheck = -Infinity
  /** Active slows per player: the larger one counts, the cold's included. */
  private readonly slows = new Map<number, { pct: number; until: number }[]>()
  private readonly applied = new Map<number, number>()
  firesState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'

  constructor(private readonly g: Gameplay) {
    const added = installWinterContent({ mobs: g.data.mobs, items: g.data.items, drops: g.data.drops })
    if (added.mobs + added.items > 0) g.config.log(`winter: content ${added.mobs} monsters, ${added.items} items, ${added.drops} drop tables`)
    this.warmth = new WarmthService(g, this)
    this.snowballs = new SnowballService(g, this)
    this.monsters = new WinterMonsters(g, this)
    this.yeti = new YetiService(g, this)
    this.gifts = new GiftService(g, this)
    this.snowballs.onBigHit = (thrower, hit, now) => this.yeti.barrageHit(thrower, hit, now)
    this.parts = [this.warmth, this.snowballs, this.monsters, this.yeti, this.gifts]
    g.skills.addModProvider((p) => {
      const pct = this.slowPct(p)
      return pct > 0 ? [{ stat: 'speedPct', value: -pct }] : []
    })
    this.placeCampfires()
  }

  // ---- the gate -------------------------------------------------------------------------------------------

  knobs(): WinterKnobs {
    return winterKnobs(this.g.config)
  }

  /** The layer is on (as of the last check, at most a second old). */
  get isOn(): boolean {
    return this.on
  }

  /** Whether the layer should be on at `now`. */
  wanted(now: number): boolean {
    return this.knobs().enabled && (this.g.winter.active(now) || this.g.winter.previewing)
  }

  /** The snow is deep enough for snowballs (a GM preview draws full cover: so it is). */
  snowDeep(now: number): boolean {
    if (this.g.winter.previewing) return true
    return this.g.winter.state(now).cover >= this.knobs().snowballCover
  }

  /** What the cold reads now: the night, the snowfall and the storm level. */
  coldEnv(now: number): ColdEnv {
    const env = this.g.storm.env
    return { night: 1 - this.g.daylight(now), snow: env.snow ?? 0, storm: env.storm }
  }

  /** The winter the scoreboard counts ("2026-27"). */
  seasonKey(now: number): string {
    return winterSeasonKey(now, this.g.winter.dates())
  }

  state(now: number): WinterPlayState {
    const s: WinterPlayState = { on: this.on, snowballs: this.snowballs.allowed(now) }
    if (this.on) {
      s.fires = this.campfires.map((f) => [...f] as Vec3)
      s.season = this.seasonKey(now)
    }
    return s
  }

  broadcastState(now: number): void {
    const msg: ServerMessage = { t: 'winterPlay', play: this.state(now) }
    for (const p of this.g.world.players.values()) p.send(msg)
  }

  /** The admin changed a winter-gameplay knob (or the season): re-evaluate at once. */
  refresh(now = Date.now()): void {
    this.lastCheck = -Infinity
    this.check(now, true)
  }

  private check(now: number, force = false): void {
    const on = this.wanted(now)
    const snow = this.snowballs.allowed(now)
    if (on === this.on && snow === this.snowOk && !force) return
    const turned = on !== this.on
    this.on = on
    this.snowOk = snow
    if (turned) {
      this.g.config.log(`winter: the winter gameplay layer turns ${on ? 'on' : 'off'}`)
      if (on) this.warmth.started(now)
      else this.warmth.reset(now)
      if (setWinterShopTab(this.g.data.shops, on)) for (const code of this.g.data.npcShop.keys()) this.g.shops.forgetGoods(code)
      if (on) this.loadFires()
    }
    this.broadcastState(now)
  }

  // ---- module hooks ---------------------------------------------------------------------------------------

  enter(p: Player, now: number): void {
    if (this.on || now < this.snowballs.testUntil) p.send({ t: 'winterPlay', play: this.state(now) })
  }

  forget(p: Player): void {
    this.slows.delete(p.id)
    this.applied.delete(p.id)
  }

  tick(now: number): void {
    if (now - this.lastCheck >= 1000 || now < this.lastCheck) {
      this.lastCheck = now
      this.check(now)
    }
    for (const [id, list] of this.slows) {
      const left = list.filter((s) => s.until > now)
      if (left.length === list.length) continue
      if (left.length) this.slows.set(id, left)
      else this.slows.delete(id)
      const p = this.g.world.players.get(id)
      if (p) this.speedChanged(p, now)
    }
  }

  // ---- shared parts ------------------------------------------------------------------------------------------

  /** Slows `p` by `pct` for `ms` (a snowball, the yeti's moves). */
  slow(p: Player, pct: number, ms: number, now: number): void {
    const list = this.slows.get(p.id) ?? []
    list.push({ pct, until: now + ms })
    this.slows.set(p.id, list)
    this.speedChanged(p, now)
  }

  /** The run speed `p` loses now (percent): the larger of the cold and the active slows. */
  slowPct(p: Player): number {
    let pct = this.warmth.slowPct(p)
    for (const s of this.slows.get(p.id) ?? []) if (s.until > this.g.now) pct = Math.max(pct, s.pct)
    return Math.min(90, pct)
  }

  /** Re-derives `p`'s speed when its slow changed (a stat refresh and `stats` to the player). */
  speedChanged(p: Player, now: number): void {
    void now
    const pct = this.slowPct(p)
    if ((this.applied.get(p.id) ?? 0) === pct) return
    if (pct > 0) this.applied.set(p.id, pct)
    else this.applied.delete(p.id)
    this.g.refresh(p)
    p.send({ t: 'stats', stats: this.g.stats(p) })
  }

  /** Regeneration multiplier of `p` (Gameplay's player regen): the cold slows it. */
  regenMul(p: Player): number {
    return this.on ? this.warmth.regenMul(p) : 1
  }

  /** Places the winter campfires on the navmesh (a flat world keeps them as authored). */
  private placeCampfires(): void {
    if (this.g.config.world !== WINTER_WORLD) return
    for (const c of WINTER_CAMPFIRES) {
      const at = this.g.nav.kind === 'mesh' ? this.g.nav.place(c.x, c.z, c.y, 6) : { x: c.x, y: c.y, z: c.z }
      if (!at) {
        this.g.config.log(`winter: the campfire at ${c.x}, ${c.z} does not place on the navmesh; skipped`)
        continue
      }
      const spot: FireSpot = { kind: 'campfire', x: at.x, y: at.y, z: at.z }
      this.fires.add(spot)
      this.campfires.push([Math.round(at.x * 100) / 100, Math.round(at.y * 100) / 100, Math.round(at.z * 100) / 100])
    }
  }

  /** Reads the world's own fires (once, asynchronously) the first time the layer turns on. */
  private loadFires(): void {
    const c = this.g.config
    if (this.firesState !== 'idle' || !c.outDir) return
    this.firesState = 'loading'
    const dirs = [c.outDir, c.outOptDir ?? join(dirname(c.outDir), 'out-opt')]
    void loadWorldFires(dirs, c.worldExport ?? c.world)
      .then(({ fires, problem }) => {
        for (const f of fires) this.fires.add(f)
        this.firesState = fires.length ? 'ready' : 'failed'
        c.log(fires.length ? `winter: ${this.fires.counts.brazier} braziers and fires, ${this.fires.counts.lamp} lamps warm (plus ${this.fires.counts.campfire} campfires)` : `winter: no world fires (${problem || 'none in the manifest'}); only the campfires warm`)
      })
      .catch((e) => {
        this.firesState = 'failed'
        c.log(`winter: world fires failed to load: ${(e as Error)?.message ?? e}`)
      })
  }

  // ---- GM -------------------------------------------------------------------------------------------------

  /** `wintergame`: the layer's status in one line. */
  describe(now: number): string {
    const k = this.knobs()
    const why = !k.enabled ? 'WINTER_PLAY is off' : this.g.winter.previewing ? 'a GM preview' : this.g.winter.active(now) ? 'the snow season' : 'not the season'
    return `Winter gameplay ${this.on ? 'on' : 'off'} (${why}); snowballs ${this.snowballs.allowed(now) ? 'possible' : 'not possible'}; ${this.monsters.describe()}; Ice Yeti ${this.yeti.live() ? 'alive' : 'waiting'}; fires ${this.fires.size} (${this.firesState}); scoreboard ${this.seasonKey(now)}.`
  }

  gmStatus(now: number): GmResult {
    return { ok: true, message: this.describe(now), data: this.state(now) }
  }
}

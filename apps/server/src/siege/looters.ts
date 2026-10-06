import { SIEGE_CODES, looterNest, wallName, wallOpen, type MobDef, type NestDef } from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import type { GameplayModule } from '../modules.ts'
import type { Mob } from '../world.ts'
import type { WallService } from './walls.ts'

/**
 * Siege of Jangan, layer 3: looters at the breaches (docs/SIEGE.md §2.5). A GameplayModule named `wallLooters`, on with
 * the walls. Outside a siege every open segment (breached or rubble) gets a temporary nest of `looters` (3) Bandits
 * centred on its breach zone (10 m inside the gap), leashed to the zone: "monsters walk into town". A looter killed comes
 * back `looterRespawnMin` (5) minutes later while the gap stays open. When the segment closes its looters leave at once
 * (no corpse, no loot). During a siege the nests are not refilled (the army is the threat). The nests are not Spawner
 * nests (no GM nest editor, no storm counts); the looters themselves are ordinary mobs (AI, combat, loot, quests). Not
 * persisted: after a restart the open gaps fill again.
 */

/** How often the gaps are checked (ms). */
export const LOOTER_PASS_MS = 5000

interface Gap {
  seg: string
  def: NestDef
  alive: Set<number>
  /** Server ms of the next refills. */
  pending: number[]
}

export class WallLooters implements GameplayModule {
  readonly name = 'wallLooters'
  private readonly gaps = new Map<string, Gap>()
  private readonly byMob = new Map<number, Gap>()
  private nextPass = 0
  private mob: MobDef | null | undefined = undefined

  constructor(
    private readonly g: Gameplay,
    private readonly walls: WallService,
  ) {}

  private mobDef(): MobDef | null {
    if (this.mob === undefined) {
      this.mob = this.g.data.mob(SIEGE_CODES.looter) ?? null
      if (!this.mob && this.walls.on) this.g.config.log(`walls: no looters (${SIEGE_CODES.looter} is not in mobs.json)`)
    }
    return this.mob
  }

  /** Looters alive now. */
  get count(): number {
    return this.byMob.size
  }

  /** The looter ids at a segment's gap (tests, GM). */
  at(seg: string): number[] {
    return [...(this.gaps.get(seg)?.alive ?? [])]
  }

  tick(now: number): void {
    if (!this.walls.on || now < this.nextPass) return
    this.nextPass = now + LOOTER_PASS_MS
    this.pass(now)
  }

  /** One pass: forget the dead, open nests at new gaps, empty closed ones, refill (not during a siege). */
  pass(now: number): void {
    this.sweep(now)
    const s = this.walls.live()
    const zones = new Map(this.walls.breachZones().map((z) => [z.seg, z]))
    const ids = this.walls.walls?.segments.map((x) => x.id) ?? []
    for (const [seg, gap] of [...this.gaps]) {
      const stage = this.walls.stageOf(seg)
      if (!stage || !wallOpen(stage)) this.close(gap)
    }
    const mob = this.mobDef()
    if (!mob || this.g.config.spawnMobs === false) return
    for (const [seg, zone] of zones) {
      let gap = this.gaps.get(seg)
      const def = looterNest(zone, Math.max(0, ids.indexOf(seg)), mob, this.g.config.world, s)
      if (!gap) {
        gap = { seg, def, alive: new Set(), pending: [] }
        this.gaps.set(seg, gap)
      } else gap.def = def // rubble widens the zone; the admin may change the count
      if (this.walls.sieging()) continue
      this.fill(gap, mob, now)
    }
  }

  private fill(gap: Gap, mob: MobDef, now: number): void {
    const want = Math.max(0, Math.round(gap.def.count))
    if (gap.alive.size > want) {
      for (const id of [...gap.alive].slice(0, gap.alive.size - want)) this.remove(id)
      return
    }
    let missing = want - gap.alive.size - gap.pending.length
    // a fresh gap fills at once; deaths come back on their timers
    while (missing-- > 0) gap.pending.push(now)
    gap.pending.sort((a, b) => a - b)
    while (gap.pending.length && gap.pending[0]! <= now && gap.alive.size < want) {
      gap.pending.shift()
      const at = this.g.nestSpawnPoint(gap.def)
      if (!at) {
        gap.pending.push(now + 30_000)
        break
      }
      const m = this.g.createMob(mob, 'normal', at.x, at.z, at.y, gap.def, now, at.surface)
      gap.alive.add(m.id)
      this.byMob.set(m.id, gap)
    }
    if (gap.pending.length > want) gap.pending.length = want
  }

  /** The segment closed: its looters leave at once. */
  private close(gap: Gap): void {
    for (const id of [...gap.alive]) this.remove(id)
    gap.pending.length = 0
    this.gaps.delete(gap.seg)
  }

  private remove(id: number): void {
    this.drop(id)
    if (this.g.world.mobs.has(id)) this.g.world.removeEntity(id)
  }

  private drop(id: number): void {
    const gap = this.byMob.get(id)
    if (!gap) return
    gap.alive.delete(id)
    this.byMob.delete(id)
  }

  /** A looter died: back on a timer while the gap is open. */
  mobDied(m: Mob, now: number): void {
    const gap = this.byMob.get(m.id)
    if (!gap) return
    this.drop(m.id)
    gap.pending.push(now + gap.def.respawnSec[0] * 1000)
  }

  /** A removal that skipped mobDied (GM kill, despawn): forget it, back on the respawn timer. */
  private sweep(now: number): void {
    for (const [id, gap] of [...this.byMob]) {
      const m = this.g.world.mobs.get(id)
      if (m && m.ai !== 'dead') continue
      this.drop(id)
      gap.pending.push(now + gap.def.respawnSec[0] * 1000)
    }
  }

  /** Every looter leaves (GM). Returns how many. */
  clear(): number {
    const n = this.byMob.size
    for (const gap of [...this.gaps.values()]) this.close(gap)
    return n
  }

  describe(): string {
    const gaps = [...this.gaps.values()]
    return gaps.length ? `Looters: ${gaps.map((x) => `${x.seg} ${x.alive.size}/${x.def.count}`).join(', ')}` : 'Looters: no open gaps.'
  }

  gm(args: string[], now: number): GmResult {
    const verb = (args[0] ?? '').toLowerCase()
    if (verb === 'clear') return { ok: true, message: `${this.clear()} looters left (open gaps fill again on the next pass).` }
    if (verb === 'spawn') {
      for (const gap of this.gaps.values()) gap.pending = gap.pending.map(() => now)
      this.nextPass = 0
      this.pass(now)
      return { ok: true, message: this.describe() }
    }
    if (verb && verb !== 'status') return { ok: false, message: 'Usage: mason looters [spawn|clear]' }
    const where = [...this.gaps.keys()].map((id) => wallName(id))
    return { ok: true, message: `${this.describe()}${where.length ? ` (${where.join('; ')})` : ''}` }
  }
}

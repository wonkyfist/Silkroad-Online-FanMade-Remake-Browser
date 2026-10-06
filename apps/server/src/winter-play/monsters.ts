import { WINTER_FIELDS, WINTER_PLAY, WINTER_WORLD, winterNest, type MobDef, type NestDef } from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { GameplayModule } from '../modules.ts'
import type { Mob } from '../world.ts'
import type { WinterPlay } from './service.ts'

/**
 * Snow spirits (docs/WINTER.md §13.3). A GameplayModule named `snowSpirits` that keeps the winter fields
 * (winter-play.ts WINTER_FIELDS: Snow Sprites south of Jangan, Snow Spirits in the north-west water meadows) filled
 * while the winter layer is on: each field holds `count x SNOW_SPIRIT_SCALE` and refills one 45-90 s after a death.
 * When the layer goes off (the season ends, a GM preview ends, the admin switch) they leave: idle ones a few per pass,
 * fighting ones once they are idle again or after two minutes. The fields are not Spawner nests (no GM nest editor, no
 * storm counts); the monsters themselves are ordinary mobs (AI, combat, loot, quests).
 */

const PASS_MS = 5000
/** A spirit still fighting this long after the layer went off leaves anyway. */
const LINGER_MS = 120_000

interface Field {
  def: NestDef
  mob: MobDef
  alive: Set<number>
  /** Server ms of the next refills. */
  pending: number[]
}

export class WinterMonsters implements GameplayModule {
  readonly name = 'snowSpirits'
  private fields: Field[] | null = null
  private nextPass = 0
  private offSince: number | null = null
  private readonly byMob = new Map<number, Field>()

  constructor(
    private readonly g: Gameplay,
    private readonly play: WinterPlay,
  ) {}

  /** The fields of this world whose monster is known (built on first use: the content is installed by then). */
  private list(): Field[] {
    if (this.fields) return this.fields
    this.fields = []
    if (this.g.config.world !== WINTER_WORLD) return this.fields
    WINTER_FIELDS.forEach((f, i) => {
      const mob = this.g.data.mob(f.mob)
      if (mob) this.fields!.push({ def: winterNest(f, i, mob), mob, alive: new Set(), pending: [] })
    })
    return this.fields
  }

  /** Spirits alive now (tests, GM status). */
  get count(): number {
    return this.byMob.size
  }

  private want(f: Field): number {
    const scale = this.play.knobs().spiritScale
    return Math.max(0, Math.round(f.def.count * scale))
  }

  tick(now: number): void {
    if (now < this.nextPass) return
    this.nextPass = now + PASS_MS
    if (this.g.config.spawnMobs === false) return
    this.sweep()
    if (this.play.isOn) {
      this.offSince = null
      for (const f of this.list()) this.fill(f, now)
    } else if (this.byMob.size > 0) {
      this.offSince ??= now
      this.thin(now, now - this.offSince >= LINGER_MS)
    }
  }

  private fill(f: Field, now: number): void {
    const want = this.want(f)
    // a lowered scale thins the field the same way the season's end does
    if (f.alive.size > want) return this.leave([...f.alive].slice(0, f.alive.size - want), false)
    let missing = want - f.alive.size - f.pending.length
    // a fresh field (the season began) fills at once; deaths come back on their timers
    while (missing-- > 0) f.pending.push(now)
    f.pending.sort((a, b) => a - b)
    while (f.pending.length && f.pending[0]! <= now && f.alive.size < want) {
      f.pending.shift()
      const at = this.g.nestSpawnPoint(f.def)
      if (!at) {
        f.pending.push(now + 30_000)
        break
      }
      const y = this.g.nav.kind === 'mesh' ? at.y : (f.def.y ?? 0)
      const m = this.g.createMob(f.mob, 'normal', at.x, at.z, y, f.def, now, at.surface)
      f.alive.add(m.id)
      this.byMob.set(m.id, f)
    }
  }

  /** The layer is off: idle spirits leave a few per pass; `all` = the stragglers too. */
  private thin(now: number, all: boolean): void {
    const out: number[] = []
    for (const [id] of this.byMob) {
      const m = this.g.world.mobs.get(id)
      if (!m) {
        this.drop(id)
        continue
      }
      if (all || (m.ai === 'idle' && m.damage.size === 0) || m.ai === 'dead') out.push(id)
      if (!all && out.length >= WINTER_PLAY.spirits.despawnPerPass) break
    }
    this.leave(out, true)
    for (const f of this.list()) if (this.byMob.size === 0) f.pending.length = 0
  }

  private leave(ids: number[], seasonEnd: boolean): void {
    for (const id of ids) {
      const f = this.byMob.get(id)
      this.drop(id)
      if (!seasonEnd && f) f.pending.length = 0
      if (this.g.world.mobs.has(id)) this.g.world.removeEntity(id)
    }
  }

  private drop(id: number): void {
    const f = this.byMob.get(id)
    if (!f) return
    f.alive.delete(id)
    this.byMob.delete(id)
  }

  /** A spirit died: its field refills on a timer (only while the layer is on). */
  mobDied(m: Mob, now: number): void {
    const f = this.byMob.get(m.id)
    if (!f) return
    this.drop(m.id)
    if (!this.play.isOn) return
    const [lo, hi] = f.def.respawnSec
    f.pending.push(now + (lo + this.g.rng() * Math.max(0, hi - lo)) * 1000)
  }

  /** A GM `/kill` or any removal that skipped mobDied: forget the gone ones (checked every pass by `thin`/`fill`). */
  sweep(): void {
    for (const id of [...this.byMob.keys()]) {
      const m = this.g.world.mobs.get(id)
      if (!m || m.ai === 'dead') {
        const f = this.byMob.get(id)!
        this.drop(id)
        if (this.play.isOn) f.pending.push(this.g.now + f.def.respawnSec[0] * 1000)
      }
    }
  }

  /** Everything leaves at once (GM, tests). */
  clear(): number {
    const n = this.byMob.size
    this.leave([...this.byMob.keys()], true)
    for (const f of this.list()) f.pending.length = 0
    return n
  }

  describe(): string {
    const fields = this.list()
    return `${this.byMob.size} snow spirits in ${fields.length} fields (want ${fields.reduce((s, f) => s + this.want(f), 0)})`
  }
}

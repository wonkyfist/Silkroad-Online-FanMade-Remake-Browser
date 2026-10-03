/**
 * Auto looting, key G (docs/UX_GAPS.md K3; SRO "Auto Looting (G)", UIIT_CTL_AUTOGET_TT). One press picks up to 8
 * free items within 15 m, gold first, then the nearest; holding G keeps going. The server walks us to each item:
 * `actionResult ok` only means the walk started, so the loop advances when that item despawns (picked up, by us or
 * anyone) or after 6 s. A refused pickup (bag full, not yours, ...) stops it; the world screen already shows why.
 * Any click in the world stops it too. Pure logic with injected send/views, so it is tested without a scene.
 */
import type { ClientMessage } from '@sro/shared'
import { intents } from './intents.ts'

export const LOOT_RADIUS = 15
export const LOOT_PER_PRESS = 8
export const LOOT_TIMEOUT_MS = 6000

/** What auto-loot reads of a view (EntityView satisfies it). */
export interface LootCandidate {
  readonly id: number
  readonly kind: string
  readonly pos: { x: number; z: number }
  readonly state: { model: string }
  readonly isDisposed: boolean
  readonly fading?: boolean
  itemFree(now: number): boolean
}

export const isGold = (model: string) => /^ITEM_ETC_GOLD_/.test(model)

/** The item to pick next: free to us, within `radius`, gold before anything else, then the nearest. */
export function nearestFreeItem<T extends LootCandidate>(views: Iterable<T>, self: { x: number; z: number }, now: number, radius = LOOT_RADIUS, skip: ReadonlySet<number> = new Set()): T | null {
  let best: T | null = null
  let bestKey = Infinity
  for (const v of views) {
    if (v.kind !== 'item' || v.isDisposed || v.fading || skip.has(v.id) || !v.itemFree(now)) continue
    const d = Math.hypot(v.pos.x - self.x, v.pos.z - self.z)
    if (d > radius) continue
    const key = (isGold(v.state.model) ? 0 : 1e6) + d
    if (key < bestKey) {
      bestKey = key
      best = v
    }
  }
  return best
}

/** Z: nearest-monster targeting range (docs/UX_GAPS.md K8, our addition; SRO has no Tab targeting). */
export const NEAREST_MOB_RADIUS = 25

/** What the nearest-monster key reads of a view (EntityView satisfies it). */
export interface MobCandidate {
  readonly id: number
  readonly kind: string
  readonly pos: { x: number; z: number }
  readonly isDisposed: boolean
  readonly fading?: boolean
  readonly dead: boolean
  readonly dying: boolean
}

/** Living monsters within `radius`, nearest first (ties by id, so the order is stable). */
export function nearestMobs<T extends MobCandidate>(views: Iterable<T>, self: { x: number; z: number }, radius = NEAREST_MOB_RADIUS): T[] {
  const out: { v: T; d: number }[] = []
  for (const v of views) {
    if (v.kind !== 'mob' || v.isDisposed || v.fading || v.dead || v.dying) continue
    const d = Math.hypot(v.pos.x - self.x, v.pos.z - self.z)
    if (d <= radius) out.push({ v, d })
  }
  out.sort((a, b) => a.d - b.d || a.v.id - b.v.id)
  return out.map(o => o.v)
}

/**
 * Z pressed: the nearest living monster, or, when the current target is one of them, the next farther one (cycling
 * back to the nearest). Only selects; it never attacks.
 */
export function nextMobTarget<T extends MobCandidate>(views: Iterable<T>, self: { x: number; z: number }, current: { id: number } | null, radius = NEAREST_MOB_RADIUS): T | null {
  const list = nearestMobs(views, self, radius)
  if (!list.length) return null
  const i = current ? list.findIndex(v => v.id === current.id) : -1
  return list[(i + 1) % list.length]!
}

export interface AutoLootDeps<T extends LootCandidate> {
  send(msg: ClientMessage): boolean
  views(): Iterable<T>
  /** Own position; null while dead or not in the world (the loop stops). */
  self(): { x: number; z: number } | null
}

export class AutoLoot<T extends LootCandidate = LootCandidate> {
  /** The item being walked to. */
  current: number | null = null
  private startedAt = 0
  private picked = 0
  private held = false
  /** A refused pickup: key repeats do not restart the loop until G is released. */
  private refused = false
  private running = false
  /** Pickups of ours still waiting for their actionResult (results arrive in order, shared with world clicks). */
  private pending = 0
  private readonly skip = new Set<number>()

  constructor(private readonly deps: AutoLootDeps<T>) {}

  get active(): boolean {
    return this.running
  }

  /** G pressed (a repeat while held only marks it held). */
  press(now: number): void {
    this.held = true
    if (this.running || this.refused) return
    this.running = true
    this.picked = 0
    this.skip.clear()
    this.next(now)
  }

  /** G released: the per-press cap applies from now on. */
  release(): void {
    this.held = false
    this.refused = false
    if (this.running && this.picked >= LOOT_PER_PRESS) this.stop()
  }

  stop(): void {
    this.running = false
    this.current = null
  }

  /** actionResult for a `pickup`: true when it was one of ours (the caller then stays quiet about it). */
  onPickupResult(ok: boolean): boolean {
    if (this.pending <= 0) return false
    this.pending--
    if (!ok && this.running) {
      this.stop()
      this.refused = this.held
    }
    return true
  }

  /** An entity left the view: our item picked up (or gone) → the next one. */
  onDespawn(id: number, now: number): void {
    if (!this.running || id !== this.current) return
    this.picked++
    this.current = null
    this.next(now)
  }

  /** Per frame: gives up on an item after LOOT_TIMEOUT_MS (unreachable, or the pickup failed on arrival). */
  tick(now: number): void {
    if (!this.running) return
    if (this.current === null) {
      this.next(now)
      return
    }
    if (now - this.startedAt > LOOT_TIMEOUT_MS) {
      this.skip.add(this.current)
      this.current = null
      this.next(now)
    }
  }

  private next(now: number): void {
    if (!this.held && this.picked >= LOOT_PER_PRESS) return this.stop()
    const self = this.deps.self()
    if (!self) return this.stop()
    const item = nearestFreeItem(this.deps.views(), self, now, LOOT_RADIUS, this.skip)
    if (!item) return this.stop()
    if (!this.deps.send(intents.pickup(item.id))) return this.stop()
    this.pending++
    this.current = item.id
    this.startedAt = now
  }
}

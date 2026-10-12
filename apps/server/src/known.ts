import type { Player } from './world.ts'

/**
 * The recipient index (docs/SERVER_ARCHITECTURE.md F1, phase P0): entity id -> the players whose client has that entity
 * spawned, i.e. the inverse of every Player.known. Broadcasts about an entity (move, stop, combat, entityUpdate,
 * despawn) go to its watchers instead of scanning every player in the world.
 */
export type Watchers = Map<number, Set<Player>>

/**
 * A player's `known` set (World.add makes it): a plain Set<number> to every reader, whose add/delete/clear also keep the
 * World's watcher index in step, so code anywhere (modules, tests) that spawns or forgets an entity for a client updates
 * the index too. Detached when the player leaves the world: from then on it is an ordinary set.
 */
export class KnownSet extends Set<number> {
  private owner: Player | null = null
  private index: Watchers | null = null

  /** Starts indexing this set as `owner`'s (World.add). */
  attach(owner: Player, index: Watchers): void {
    this.owner = owner
    this.index = index
    for (const id of this) watch(index, id, owner)
  }

  /** Stops indexing (World.remove): the player no longer receives broadcasts; the set keeps its contents. */
  detach(): void {
    const { owner, index } = this
    if (owner && index) for (const id of this) unwatch(index, id, owner)
    this.owner = null
    this.index = null
  }

  get attached(): boolean {
    return this.index !== null
  }

  override add(id: number): this {
    if (super.has(id)) return this
    super.add(id)
    if (this.index) watch(this.index, id, this.owner!)
    return this
  }

  override delete(id: number): boolean {
    if (!super.delete(id)) return false
    if (this.index) unwatch(this.index, id, this.owner!)
    return true
  }

  override clear(): void {
    const { owner, index } = this
    if (owner && index) for (const id of this) unwatch(index, id, owner)
    super.clear()
  }
}

function watch(index: Watchers, id: number, p: Player): void {
  const s = index.get(id)
  if (s) s.add(p)
  else index.set(id, new Set([p]))
}

function unwatch(index: Watchers, id: number, p: Player): void {
  const s = index.get(id)
  if (s && s.delete(p) && s.size === 0) index.delete(id)
}

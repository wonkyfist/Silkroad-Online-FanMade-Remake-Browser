import type { EntityState } from '@sro/shared'
import type { Entity } from './world.ts'

/**
 * The [GM] name tag (docs/UX_GAPS.md §5.2, lane UX-B): a player whose account is gm/admin carries `gm: true` in its
 * EntityState. Display only: the role itself is never changed here (only the owner CLI does that, role-policy.test.ts).
 * World.setStaff broadcasts `entityUpdate {gm}` when the role poll sees a grant or revoke.
 */
export function gmTag(e: Entity, s: EntityState): void {
  if (e.kind === 'player' && e.staff) s.gm = true
}

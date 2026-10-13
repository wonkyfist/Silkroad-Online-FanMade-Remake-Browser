/**
 * English strings of lane MR-C (horses, docs/SYSTEMS_COMBAT.md §1.5).
 * Spread into en.ts (docs/WAVE_PLAN2.md D22): only that lane edits this file.
 * en.ts keys win over a duplicate here. Retail wording where the client has it (textuisystem UIIT_*).
 */
export const enMount = {
  // The horse frame in the player frame's pet area (GDR_PMI_PET_MINI_INFO).
  'mount.frame.level': 'Lv {level}',
  'mount.frame.hp': 'HP {hp} / {max}',
  'mount.frame.ride': 'Ride',
  'mount.frame.dismount': 'Dismount',
  'mount.frame.dismiss': 'Send home',
  'mount.frame.release': 'Release',
  'mount.frame.rideTip': 'Get on your horse (or click it). You walk to it first when it is further than 2 m.',
  'mount.frame.dismountTip': 'Step down from your horse (/dismount). It follows you; click it to ride again.',
  'mount.frame.dismissTip': 'Send your horse home (/unsummon). Its item stays in your bag: use it to call the horse back.',
  'mount.frame.releaseTip': 'Release your horse for good: the horse and its item are gone forever.',
  'mount.frame.dead': 'Dead',
  'mount.release.title': 'Release horse for good',
  'mount.release.confirm': 'Release {name} for good? The horse leaves and its horse item is deleted from your inventory. This cannot be undone.',
  // Refusals of the mount requests, where retail has its own line (else the generic action.fail.<reason>).
  'mount.fail.in_combat': 'Cannot board a transport for 20 seconds after the end of combat.',
  'mount.fail.moving': 'Cannot step down while the transport is moving.',
  'mount.fail.not_found': 'Your horse is no longer there.',
  'mount.fail.not_mounted': 'You are not riding a horse.',
} satisfies Record<string, string>

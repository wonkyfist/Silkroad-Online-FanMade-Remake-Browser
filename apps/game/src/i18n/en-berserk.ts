/**
 * English strings of lane BZ (Berserk, docs/SYSTEMS_COMBAT.md §5.3).
 * Spread into en.ts (docs/WAVE_PLAN2.md D22): only that lane edits this file.
 * en.ts keys win over a duplicate here. The refusal lines (`action.fail.berserk_not_ready`, `berserk_active`,
 * `mounted`) live in en-fail-w8.ts.
 */
export const enBerserk = {
  'bz.key': 'Berserk mode',
  'bz.button': 'Berserk mode [Tab]',
  'bz.gaugeTip': 'Berserk gauge {points} / {max}. Hunt monsters to fill it; press [Tab] when it is full.',
  'bz.activeTip': 'Berserk: {seconds} s left',
  'bz.started': 'Your power and agility are increased substantially!',
  'bz.ended': 'Berserk mode has ended.',
} satisfies Record<string, string>

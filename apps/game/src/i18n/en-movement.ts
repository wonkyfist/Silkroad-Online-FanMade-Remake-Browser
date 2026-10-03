/**
 * English strings of the jump (docs/MOVEMENT.md §6.3, lane MV-C): the key help line and the refusal toasts (`mounted`,
 * `stalling`; the other refusals are silent). Spread into en.ts (docs/WAVE_PLAN6.md D15): only MV-C edits this file.
 * en.ts keys win over a duplicate here.
 *
 * MV-WASD (docs/MOVEMENT.md §13): the four walking keys, the key help note and the Options row.
 */
export const enMovement = {
  'movement.key.jump': 'Jump',
  'movement.fail.mounted': 'You cannot jump on a horse.',
  'movement.fail.stalling': 'You cannot jump while running a stall.',
  'movement.key.forward': 'Walk forward',
  'movement.key.back': 'Walk back',
  'movement.key.left': 'Walk left',
  'movement.key.right': 'Walk right',
  'keyhelp.wasd': 'W A S D or the arrow keys walk where the camera looks; a click on the ground still walks there.',
  'options.keyboardMove': 'Keyboard movement (W A S D, arrows)',
} satisfies Record<string, string>

/**
 * English strings of lane AL (alchemy, docs/SYSTEMS_COMBAT.md §4.7). Retail wording from the 1.188 English textdata
 * where it exists (UIIT_STT_ALCHEMYBOX_REINFORCE_ITEM, UIIT_STT_ALCHEMYBOX_COMPOUND, UIIT_MSG_ALCHEMY_CANCELED_COMPOUND,
 * UIIT_MSG_REINFORCERR_*), with its grammar fixed.
 * Spread into en.ts (docs/WAVE_PLAN2.md D22): only that lane edits this file. en.ts keys win over a duplicate here.
 */
export const enAlchemy = {
  'alchemy.title': 'Alchemy',
  'alchemy.menu': 'Alchemy',
  'alchemy.heading': 'Equip Enhance',
  'alchemy.hint': 'Put in the equipment and an Elixir. A Lucky Powder of the same degree raises the chance.',
  'alchemy.target': '{name}  +{from} → +{to}',
  'alchemy.chance': 'Success rate: {pct}%',
  'alchemy.warning': 'Used items disappear. A failure resets the item to +0.',
  'alchemy.fuse': 'Fuse',
  'alchemy.cancel': 'Cancel',
  'alchemy.fusing': 'Fusing…',
  'alchemy.slot.item': 'Equipment',
  'alchemy.slot.elixir': 'Elixir',
  'alchemy.slot.powder': 'Lucky Powder (optional)',
  'alchemy.slot.empty': 'Drag it here from the inventory, or right-click it there.',
  'alchemy.slot.remove': 'Right-click to take it out.',
  'alchemy.problem.noItem': 'Load the equipment first.',
  'alchemy.problem.notEquipment': 'Items that are not equipment cannot be reinforced.',
  'alchemy.problem.broken': 'A broken item cannot be enhanced. Repair it first.',
  'alchemy.problem.noElixir': 'Cannot reinforce without an Elixir.',
  'alchemy.problem.elixirMismatch': 'This Elixir does not fit this type of equipment.',
  'alchemy.problem.powderMismatch': "The Lucky Powder's degree does not match the item.",
  'alchemy.problem.maxPlus': 'This item cannot be enhanced any further.',
  'alchemy.problem.notMaterial': 'That does not go into the alchemy window.',
  'alchemy.result.success': 'Success! {name} is now +{plus}.',
  'alchemy.result.fail': 'The alchemy enhancement has failed. The enhancement level on the equipment is gone.',
  'alchemy.result.destroyed': 'The alchemy enhancement has failed. The item has been destroyed.',
  'alchemy.result.cancelled': 'Fusing has been cancelled.',
} satisfies Record<string, string>

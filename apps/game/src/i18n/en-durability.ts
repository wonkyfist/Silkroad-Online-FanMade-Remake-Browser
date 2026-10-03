/**
 * English strings of lane DR (durability and repair, docs/SYSTEMS_COMBAT.md §3.4).
 * Spread into en.ts (docs/WAVE_PLAN2.md D22): only that lane edits this file.
 * en.ts keys win over a duplicate here. Retail wording (textuisystem) where the client has it.
 */
export const enDurability = {
  // Shop footer (UIIT_CTL_REPAIR, UIIT_CTL_REPAIR_ALL) and their states.
  'dur.repair': 'Repair',
  'dur.repairAll': 'Repair all',
  'dur.repairHint': 'Repair one item: click it in your inventory or equipment (right click or Esc to stop).',
  'dur.repairAllHint': 'Repair every damaged item in the inventory and weaponry slots: {gold} gold.',
  'dur.nothing': 'No item needs repairing.',
  // UIIT_MSG_MSGBOX_REPAIR_ITEM + the total.
  'dur.confirmTitle': 'Repair all',
  'dur.confirmText': 'Repair all equipment in the inventory and weaponry slots.',
  'dur.confirmCost': 'Cost: {gold} gold.',
  'dur.confirmOk': 'Repair',
  'dur.hammerOn': 'Click the item to repair.',
  'dur.itemFull': 'That item does not need repairing.',
  'dur.unrepairable': 'The selected item is unrepairable.',
  'dur.noGold': 'Cannot repair due to insufficient gold',
  'dur.repaired': 'Repaired for {gold} gold.',
  // Broken weapon (UIIT_SKILL_USE_FAIL_BROKEN_WEAPON) and equip (UIIT_MSG_STRGERR_CANT_EQUIP_RAZED_ITEM).
  'dur.brokenWeapon': 'Cannot attack because the weapon is broken',
  'dur.cantEquipBroken': 'Cannot equip a broken item.',
  // Tooltip.
  'dur.broken': '(broken)',
  // HUD warnings (GDR_EQUIP_DUR_ERROR_WND, GDR_EQUIP_STATE_WND).
  'dur.warnTitle': 'Equipment durability',
  'dur.warnLow': '{name}: almost broken ({cur} / {max})',
  'dur.warnBroken': '{name}: broken',
  'dur.warnHint': 'Repair at Blacksmith Chulsan or Protector Trader Mrs Jang.',
} satisfies Record<string, string>

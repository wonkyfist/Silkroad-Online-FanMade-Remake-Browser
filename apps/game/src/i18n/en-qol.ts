/**
 * English strings of three playtest asks: the "cannot get there" warning switch (world/move-feedback.ts), the mouse
 * quick slot of the underbar (hud/hotbar.ts, middle mouse button) and the auto potion (world/auto-potion.ts). Spread
 * into en.ts; en.ts keys win over a duplicate here.
 */
export const enQol = {
  // Options → Controls
  'options.unreachableWarning': 'Warn when a spot cannot be reached',
  'options.autoPotion': 'Auto potion',
  'options.autoPotion.enabled': 'Use potions automatically',
  'options.autoPotion.hp': 'HP potion below',
  'options.autoPotion.mp': 'MP potion below',
  'options.autoPotion.pct': '{pct}%',
  'options.autoPotion.never': 'Never',
  'options.autoPotion.cure': 'Cure bad states with Universal Pills',
  // the auto potion's notices and HUD badge
  'autoPotion.noHp': 'Auto potion: no HP potions left.',
  'autoPotion.noMp': 'Auto potion: no MP potions left.',
  'autoPotion.noPill': 'Auto potion: no Universal Pills left.',
  'autoPotion.badge': 'Auto potion is on (Options → Controls).',
  // the mouse quick slot (the underbar's "M" frame)
  'skills.hotbar.mouseEmpty': 'Mouse slot: drag a skill or a potion here, then click the middle mouse button (the wheel) in the world to use it.',
  'skills.hotbar.mouseHint': 'Middle mouse button (the wheel). Right-click to remove.',
} satisfies Record<string, string>

/**
 * English strings of lane UI-W (the windows: Main window tabs, NPC, shop, storage, options, system; docs/UI.md §9.1).
 * Created empty by UI-K and spread into en.ts (decision D22); only UI-W edits it.
 */
export const enUiWindows = {
  'map.centre': 'Centre on you',
  'skills.win.masteryShort': 'Mastery {level}',
  // Main window: Inventory tab
  'inv.page.prev': 'Previous page',
  'inv.page.next': 'Next page',
  'inv.used': 'Slots in use',
  // Main window: Character tab
  'chr.caption': 'Lv {level}  {name}',
  'chr.exp.current': 'EXP',
  'chr.exp.next': 'Next level',
  // Main window: Skill tab
  'skills.win.total': 'Mastery total',
  'skills.win.levelUp': 'Level up',
  // Main window: Party tab
  'party.win.caption': 'Party information',
  'party.win.clickToChange': 'Click to change.',
  // Main window: Quest tab
  'quest.win.caption': 'Quest list',
  'quest.win.detail': 'Quest information',
  'quest.win.expand': 'Show the objectives',
  'quest.win.collapse': 'Hide the objectives',
  'quest.win.back': 'Quest list',
  // NPC dialog, shop, storage
  'npc.option.guild': 'Guild services.',
  'shop.rebuy': 'Re-buy',
  'storage.items': 'Stored items',
} satisfies Record<string, string>

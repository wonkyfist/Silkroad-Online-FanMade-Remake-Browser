/**
 * English strings of the Siege of Jangan, layer 3: repair (docs/SIEGE.md §2.4, §9.5): Master Mason Ko's donation
 * window and the Mason's Kit. Spread into en.ts.
 */
export const enSiegeRepair = {
  'npc.option.mason': 'Repair the town walls',
  'mason.title': 'Master Mason Ko · Wall repair',
  'mason.text': '1 % of a wall segment costs {gold} gold or {blocks} Stone Blocks. My builders mend up to {rate} % a minute on every damaged segment; work beyond a full repair waits for the next damage (up to {cap} % per segment). Donations are never returned.',
  'mason.anywhere': 'Where it is needed',
  'mason.anywhereHint': 'The worst segments first',
  'mason.segment': '{side} wall {id}',
  'mason.queued': '+{pct} % queued',
  'mason.repairing': 'builders at work',
  'mason.whole': 'whole',
  'mason.gold': 'Gold',
  'mason.blocks': 'Stone Blocks',
  'mason.carry': 'You carry {gold} gold and {blocks} Stone Blocks.',
  'mason.preview': 'Buys {pct} % of repair work.',
  'mason.previewNone': 'Enter gold or Stone Blocks to donate.',
  'mason.previewFull': 'The builders cannot take more work there now.',
  'mason.donate': 'Donate',
  'mason.back': 'Back',
  'mason.noWalls': 'The walls of this world cannot be repaired.',
  'mason.kitHint': "A Mason's Kit adds {pct} % every {s} s at the wall (within {m} m).",
} as const

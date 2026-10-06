/**
 * English strings of the Siege of Jangan, layer 5: player kegs and Wanted (docs/SIEGE.md §7, §8, §9.3, §9.5): the law's
 * banners, the WANTED label and panel, the plant prompt, Old Fang's window. Spread into en.ts.
 */
export const enSiegeLaw = {
  'action.fail.keg_limit': 'Not another Thunder Keg yet.',
  'npc.option.fence': 'Buy a Thunder Keg',
  'fence.title': 'Old Fang · Thunder Kegs',
  'fence.text': "A Thunder Keg: {gold} gold and {saltpeter} Saltpeter, and I ask no questions. Plant it at the outer foot of the town wall; {fuse} seconds later it takes {pct} % of the stone. Break the wall and the whole server hears your name: you will be WANTED, and the garrison pays for your head.",
  'fence.carry': 'You carry {gold} gold, {saltpeter} Saltpeter and {kegs} of {max} kegs.',
  'fence.rules': 'Level {level}+ and {hours} h played on this character; one keg per account every {min} min. A keg is bound to you.',
  'fence.craft': 'Pack a keg',
  'fence.back': 'Back',
  'law.title': 'The Law',
  'law.someWall': 'the town wall',
  'law.notice.plant': 'Someone is planting a Thunder Keg at {wall}!',
  'law.notice.wanted': '{name} has breached {wall}! A bounty of {bounty} gold is posted.',
  'law.notice.wantedTreason': 'Treason! {name} has breached {wall} during the siege! A bounty of {bounty} gold is posted.',
  'law.notice.accomplices': 'Accomplices: {list}.',
  'law.notice.defused': '{name} defused a Thunder Keg at {wall}.',
  'law.notice.lapsed': 'The warrant for {name} has lapsed.',
  'law.notice.pardoned': '{name} has been pardoned.',
  'law.notice.captured': '{name} has been captured! The bounty of {bounty} gold is paid.',
  'law.label': 'WANTED · {bounty}',
  'law.panel.head': 'Wanted',
  'law.panel.bounty': 'Bounty on your head: {bounty} gold',
  'law.panel.lapse': 'The warrant lapses in {time} online',
  'law.panel.offence': 'Offence {n}',
  'law.panel.accomplice': 'accomplice',
  'law.panel.treason': 'treason',
  'law.plant': 'Plant a Thunder Keg at {wall}',
  'law.plantHint': 'If it breaches the wall, you become WANTED.',
  'law.plantButton': 'Plant the keg',
} as const

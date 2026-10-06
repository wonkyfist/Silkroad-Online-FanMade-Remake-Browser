/**
 * English strings of the winter gameplay layer (docs/WINTER.md §13): the warmth bar and its warnings, snowballs and
 * the scoreboard, gift boxes, the Ice Yeti's lines. Spread into en.ts.
 */
export const enWinterPlay = {
  // the layer turning on / off (a chat line)
  'winterPlay.on': 'The snow season is here: keep warm (fires, towns, Ginger Tea), throw snowballs with B, and watch out for snow spirits and the Ice Yeti. Monsters may drop holiday gift boxes.',
  'winterPlay.off': 'The snow season is over: the cold, the snowballs and the winter monsters are gone until next winter.',
  // the warmth bar
  'winterPlay.warmth.label': 'Warmth',
  'winterPlay.warmth.tip': 'Body warmth {v} / {max}',
  'winterPlay.level.warm': 'Warm: no effect.',
  'winterPlay.level.chilly': 'Chilly: your HP and MP recover 25 % slower.',
  'winterPlay.level.cold': 'Cold: recovery at half speed, running 8 % slower.',
  'winterPlay.level.freezing': 'Freezing: no recovery, running 12 % slower, the cold takes a little HP (never below a tenth).',
  'winterPlay.source.fire': 'A fire is warming you.',
  'winterPlay.source.town': 'The town keeps you warm.',
  'winterPlay.source.tea': 'Ginger Tea keeps the cold out for a while.',
  // the warnings (chat)
  'winterPlay.warn.chilly': 'You feel chilly: your wounds heal more slowly. Stand by a fire, go into a town or drink Ginger Tea.',
  'winterPlay.warn.cold': 'You are cold: you heal slowly and run slower. Find a fire or a town!',
  'winterPlay.warn.freezing': 'You are freezing! The cold drains your health (never below a tenth). Get to a fire or a town, or drink Ginger Tea.',
  'winterPlay.warn.warm': 'You are warm again.',
  'winterPlay.drained': 'The cold bites: -{hp} HP.',
  // snowballs
  'winterPlay.snowball.key': 'Throw a snowball (Shift+B: the scoreboard)',
  'winterPlay.snowball.noSnow': 'The snow is not deep enough for a snowball.',
  'winterPlay.snowball.off': 'Snowballs are only for the snow season.',
  'winterPlay.splat': 'Splat!',
  'winterPlay.score': 'Splat! {n} hits this winter.',
  // the scoreboard
  'winterPlay.board.title': 'Snowball fight {season}',
  'winterPlay.board.empty': 'Nobody has hit anyone yet this winter. Press B!',
  'winterPlay.board.me': 'You: {hits} hits, {thrown} thrown, hit {hitBy} times',
  'winterPlay.board.rank': 'rank {rank}',
  'winterPlay.board.close': 'Close',
  // gift boxes
  'winterPlay.gift.title': 'Holiday Gift Box',
  'winterPlay.gift.rare': 'A rare gift!',
  'winterPlay.gift.gold': '{gold} gold',
} as const

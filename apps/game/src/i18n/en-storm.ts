/**
 * English strings of storm gameplay (docs/WEATHER.md §12): the weather icon by the minimap and its tooltip, the
 * forecast lines in chat, the charged-monster badge. Spread into en.ts.
 */
export const enStorm = {
  // the icon's tooltip: a title, then one line per active effect ({pct} carries its sign)
  'storm.title.calm': 'Calm weather',
  'storm.title.rain': 'Rain',
  'storm.title.forecast': 'A storm is coming (in about {min} min)',
  'storm.title.storm': 'Thunderstorm',
  'storm.title.ends': 'Ends in about {min} min',
  'storm.effect.wet': 'Wet: lightning damage to you {pct}%',
  'storm.effect.sight': 'Monster sight {pct}%: sneak past camps',
  'storm.effect.fire': 'Fire force damage {pct}%',
  'storm.effect.lightning': 'Lightning force damage {pct}%',
  'storm.effect.cold': 'Cold force damage {pct}%',
  'storm.effect.mud': 'Mud: running speed {pct}% outside towns',
  'storm.effect.wind': 'Strong wind: bow and ranged skill misses {pct}%',
  'storm.effect.night': 'Night storm: you see less far; monster sight a further {pct}%',
  'storm.effect.undead': 'Undead and ghosts: faster, damage {pct}%',
  'storm.effect.water': 'Water spirits rise: numbers {pct}%',
  'storm.effect.critters': 'Small animals hide: numbers {pct}%',
  'storm.effect.packs': 'Tigers hunt in bigger packs: numbers {pct}%',
  'storm.effect.bandits': 'Bandits pull back to their camps (chase range {pct}%)',
  'storm.effect.panic': 'Thunder panics the beasts near a strike',
  'storm.effect.charged': 'Monsters struck by lightning become charged: damage {pct}%, arcing hits, better loot',
  // chat (system) when the phase changes
  'storm.chat.forecast': 'A storm is gathering over the fields... It breaks in about {min} min.',
  'storm.chat.breaks': 'The storm breaks! The dead grow restless and the beasts fear the thunder.',
  'storm.chat.passes': 'The storm passes.',
  // a charged monster's name label
  'storm.badge.charged': 'Charged',
  // the lightning tornado (docs/WEATHER.md §13): chat lines and the icon's tooltip line
  'tornado.chat.warn': 'A tornado is forming {where}! It touches down in about {s} s. Keep clear of the funnel.',
  'tornado.chat.where.area': 'over {area}, {dist} m {dir} of you',
  'tornado.chat.where.near': '{dist} m {dir} of you',
  'tornado.chat.lift': 'The tornado lifts back into the clouds.',
  'tornado.chat.thrown': 'The tornado throws you!',
  'tornado.tip.warn': 'Tornado forming {dist} m {dir}: touchdown in {s} s',
  'tornado.tip.active': 'Tornado {dist} m {dir}: it pulls in and throws whatever it catches',
  'tornado.tip.lifting': 'The tornado is lifting ({dist} m {dir})',
  'tornado.dir.n': 'north',
  'tornado.dir.ne': 'north-east',
  'tornado.dir.e': 'east',
  'tornado.dir.se': 'south-east',
  'tornado.dir.s': 'south',
  'tornado.dir.sw': 'south-west',
  'tornado.dir.w': 'west',
  'tornado.dir.nw': 'north-west',
} satisfies Record<string, string>

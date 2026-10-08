/**
 * English strings of the Climb's rewards (docs/CLIMB.md §4.2, §5.1, §7.3; layer L7): the set line of item tooltips,
 * the Arts row of the skill window, the title line of the character window and the title names (the name plate reads
 * `pilot.honor.<code>`, like Play the Boss's and the Siege's titles). Spread into en.ts.
 */
export const enClimb = {
  'climb.set.on': '{name} ({n}/{of}): {bonus}',
  'climb.set.next': '{name} ({n}/{of}): {at} pieces give {bonus}',
  'climb.arts.title': 'Arts (choose one per tier)',
  'climb.arts.tier': 'M {tier}',
  'climb.arts.locked': 'Needs mastery level {tier}.',
  'climb.arts.picked': 'Chosen.',
  'climb.arts.free': 'Click to choose (the first choice of a tier is free).',
  'climb.arts.respec': 'Click to change: {gold} gold.',
  'climb.title.cycle': '{n} titles held: click to wear the next.',
  'pilot.honor.pioneer': 'Pioneer',
  'pilot.honor.climber': 'Climber',
  'pilot.honor.deathless': 'Deathless',
  'pilot.honor.scar_breaker': 'Scar-Breaker',
  'pilot.honor.magistrate_breaker': 'Magistrate-Breaker',
  'pilot.honor.chief_breaker': 'Chief-Breaker',
  'pilot.honor.warden_breaker': 'Warden-Breaker',
  'pilot.honor.wind_breaker': 'Wind-Breaker',
  'pilot.honor.warlord_breaker': 'Warlord-Breaker',
  'pilot.honor.canyon_breaker': 'Canyon-Breaker',
  'pilot.honor.tiger_queens_bane': "Tiger Queen's Bane",
} as const

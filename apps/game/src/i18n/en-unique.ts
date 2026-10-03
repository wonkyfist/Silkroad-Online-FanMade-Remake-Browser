/**
 * English strings of wave 11's unique-monster announcements (docs/UNIQUES.md §3.3, docs/WAVE_PLAN7.md D8), owned by
 * U-H. Spread into en.ts: only that lane edits this file. en.ts keys win over a duplicate here.
 * `{area}` is the server's zone name printed as is (a trailing "." such as "North-Tiger Mt." is part of the name, so the
 * sentence adds no full stop of its own).
 */
export const enUnique = {
  'unique.title': 'Unique Monster',
  'unique.appeared': '{name} has appeared! Area: {area}',
  'unique.appearedNoArea': '{name} has appeared!',
  'unique.defeated': '{by} has defeated {name}!',
  'unique.defeatedParty': '{by}\'s party has defeated {name}!',
  'unique.defeatedNoBy': '{name} has been defeated!',
  'unique.chat': '[Unique] {text}',
} satisfies Record<string, string>

/**
 * English strings of the rare weapons (docs/RARITY.md): the tooltip's seal banner, the server-wide notice of a rare
 * drop and its chat line. Retail names the seals "Seal of Star / Moon / Sun".
 * Spread into en.ts: only the rarity lane edits this file. en.ts keys win over a duplicate here.
 */
export const enRarity = {
  'rarity.banner.star': '✦ Seal of Star ✦',
  'rarity.banner.moon': '☾ Seal of Moon ☾',
  'rarity.banner.sun': '☀ Seal of Sun ☀',
  'rarity.notice.title': 'Rare weapon',
  'rarity.notice.text': '{by} found a {seal} weapon: {name}!',
  'rarity.chat': '[{seal}] {by} found {name}!',
} satisfies Record<string, string>

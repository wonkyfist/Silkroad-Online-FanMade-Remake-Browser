/**
 * English strings of wave 9's sky (docs/WAVE_PLAN3.md D11: sky style, the HUD clock), owned by GAME. Spread into
 * en.ts: only that lane edits this file. en.ts keys win over a duplicate here.
 */
export const enSky = {
  // Options → Graphics (settings.ts graphics.sky)
  'options.sky': 'Sky',
  'options.sky.modern': 'Modern',
  'options.sky.classic': 'Classic',
  // Options → Interface (settings.ts ui.clock): the game time next to the minimap
  'options.clock': 'Game clock by the minimap',
  // The HUD clock (world/features/sky-clock.ts)
  'sky.clock.title': 'Game time in Jangan (a game day lasts {hours} real hours)',
} satisfies Record<string, string>

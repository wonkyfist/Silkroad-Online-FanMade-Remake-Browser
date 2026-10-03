/**
 * English strings of the remastered-textures test switch (three/remaster.ts). Spread into en.ts (docs/WAVE_PLAN.md
 * decision 39): only that lane edits this file. en.ts keys win over a duplicate here.
 */
export const enRemaster = {
  // Options → Graphics (settings.ts graphics.remaster: retired in wave 9B, kept for the ?remaster=1 test switch)
  'options.remaster': 'Remastered textures (test)',
  // Wave 9B (TX-R): Options → Graphics → the texture tier (settings.ts graphics.textures)
  'options.textures': 'Textures (applies after reload)',
  'options.textures.auto': 'Auto (by quality)',
  'options.textures.retail': 'Classic',
  'options.textures.remaster': 'Remastered',
  'options.textures.1024': 'Remastered, sharp (up to 1024)',
  'options.textures.2048': 'Remastered, sharpest (up to 2048)',
} satisfies Record<string, string>

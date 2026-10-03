/**
 * English strings of lane W5-G, grass and plant scatter (docs/WAVE_PLAN.md §6; world-render scatter.ts). Spread into
 * en.ts (docs/WAVE_PLAN.md decision 39): only that lane edits this file. en.ts keys win over a duplicate here.
 */
export const enScatter = {
  // Options → Graphics (settings.ts graphics.scatter)
  'options.scatter': 'Grass & plants',
  'options.scatter.auto': 'Auto',
  'options.scatter.off': 'Off',
  'options.scatter.low': 'Low',
  'options.scatter.medium': 'Med',
  'options.scatter.high': 'High',
} satisfies Record<string, string>

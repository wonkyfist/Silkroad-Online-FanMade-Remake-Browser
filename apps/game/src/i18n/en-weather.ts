/**
 * English strings of wave 9's weather (docs/WAVE_PLAN3.md D11, docs/WEATHER.md §9.1: options.weather*,
 * options.reduceFlashing), owned by WX-C. Spread into en.ts: only that lane edits this file. en.ts keys win over a
 * duplicate here.
 */
export const enWeather = {
  // Options → Graphics (settings.ts graphics.weather; world/features/weather.ts registers the row)
  'options.weather': 'Weather effects',
  'options.weather.auto': 'Auto',
  'options.weather.off': 'Off',
  'options.weather.low': 'Low',
  'options.weather.medium': 'Medium',
  'options.weather.high': 'High',
  'options.weather.ultra': 'Ultra',
  // Options → Interface (settings.ts ui.reduceFlashing): lightning at a quarter strength, no bolt
  'options.reduceFlashing': 'Reduce flashing (lightning)',
} satisfies Record<string, string>

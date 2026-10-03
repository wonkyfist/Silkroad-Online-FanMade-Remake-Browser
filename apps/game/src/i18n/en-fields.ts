/**
 * English strings of lane FLD-C fields and the world map (docs/FIELDS.md). Spread into en.ts (docs/WAVE_PLAN.md decision 39):
 * only that lane edits this file. en.ts keys win over a duplicate here.
 */
export const enFields = {
  // world map window (M, docs/FIELDS.md §5.3)
  'map.title': 'World Map',
  'map.you': 'You',
  'map.town': 'Town',
  'map.unique': '{name} (unique)',
  'map.hunt': '{name} Lv {level}',
  'map.levelShort': 'Lv {level}',
  'map.zoneUnknown': 'Unknown area',
  'map.region': 'region {x}, {z}',
  'map.hint': 'Wheel: zoom  |  Drag: pan  |  Right click: centre on you',
  'keys.window.map': 'World map',
  // region streaming (UX-A's performance line, Options → Show FPS)
  'map.streamStats': 'Regions {ready}/{wanted}  |  {mb} MB  |  stream {last}/{worst} ms',
  'map.streamLoading': 'Loading the area…',
} satisfies Record<string, string>

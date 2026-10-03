/**
 * English strings of lane SND-C sound (docs/SOUND.md). Spread into en.ts (docs/WAVE_PLAN.md decision 39):
 * only that lane edits this file. en.ts keys win over a duplicate here.
 */
export const enSound = {
  'menu.sound': 'Sound',
  'sound.title': 'Sound',
  'sound.master': 'Master',
  'sound.music': 'Music',
  'sound.sfx': 'Effects',
  'sound.ui': 'Interface',
  'sound.ambient': 'Ambience',
  'sound.muteHidden': 'Mute when the game is in the background',
  'sound.muted': 'All sound is muted (corner button).',
  'sound.unmute': 'Unmute',
  'sound.missing': 'Sound effects are not installed on this server; only music plays.',
  'sound.percent': '{value}%',
  'corner.soundOn': 'Sound: On',
  'corner.soundOff': 'Sound: Off',
  'corner.soundTitle': 'Mute or unmute all sound',
} satisfies Record<string, string>

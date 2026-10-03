/**
 * English strings of lane UX-B world feel, chat, minimap (docs/UX_GAPS.md). Spread into en.ts (docs/WAVE_PLAN.md decision 39):
 * only that lane edits this file. en.ts keys win over a duplicate here.
 */
export const enUxWorld = {
  // chat (C1-C3, C5, C7)
  'chat.tab.all': 'All',
  'chat.tab.whisper': 'Whisper',
  'chat.tab.party': 'Party',
  'chat.tab.system': 'System',
  'chat.newMessages': 'New messages ↓',
  'chat.whisperTo': 'To {name}: ',
  'chat.whisperFrom': 'From {name}: ',
  'chat.partyFrom': '(Party) {name}: ',
  'chat.whisperHint': 'Click to whisper {name}',
  'chat.whisperUsage': 'To whisper: /w name message',
  'chat.whisperBadName': '"{name}" is not a character name.',
  'chat.noReply': 'Nobody has whispered you yet.',
  'chat.expGain': 'You gained {exp} EXP and {sp} SP-EXP.',
  // minimap (M1, M2)
  'minimap.zoomIn': 'Zoom in',
  'minimap.zoomOut': 'Zoom out',
  'minimap.worldMap': 'World map (M)',
  'minimap.coords': '{x}, {y}',
  'minimap.area.field': 'Jangan Outskirts',
  // keys (K3, K6)
  'keys.loot.auto': 'Auto looting (hold to keep going)',
  'keys.camera.left': 'Turn camera left',
  'keys.camera.right': 'Turn camera right',
  'keys.camera.zoomIn': 'Zoom camera in',
  'keys.camera.zoomOut': 'Zoom camera out',
  'keys.camera.reset': 'Camera behind you',
  // wave 4 UX-R (K8)
  'keys.target.nearest': 'Target the nearest monster (again: the next one)',
  'world.noMobNear': 'No monster nearby.',
  // gm tag
  'world.gmTag': '[GM]',
} satisfies Record<string, string>

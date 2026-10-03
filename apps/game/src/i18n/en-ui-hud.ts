/**
 * English strings of lane UI-H (the HUD: underbar, player frame, target window, minimap, chat; docs/UI.md §9.1).
 * Created empty by UI-K and spread into en.ts (decision D22); only UI-H edits it.
 */
export const enUiHud = {
  'uh.menu': 'Menu',
  'uh.race.china': 'Chinese',
  'uh.minimap.x': 'X {x}',
  'uh.minimap.y': 'Y {y}',
  'chat.tab.guild': 'Guild',
  'uh.chat.guildFrom': '(Guild) {name}: ',
  'uh.chat.stallFrom': '(Stall) {name}: ',
  'uh.chat.whisperButton': 'Whisper (reply to the last whisper)',
  'uh.chat.hideTabs': 'Hide or show the chat tabs',
  'uh.chat.size': 'Chat size',
  'uh.chat.mode.all': 'Talk: everyone nearby (click for party)',
  'uh.chat.mode.party': 'Talk: party (click for everyone)',
  'uh.chat.partyPlaceholder': 'Party chat: press Enter to talk',
} satisfies Record<string, string>

/**
 * English refusal lines of the 22 wave-8 ActionFailReasons (docs/WAVE_PLAN2.md §3.2.5, D22; step W8-F). Spread into
 * en.ts; the HUD toast looks up `action.fail.<reason>`. Retail wording where the client has it (docs/SYSTEMS_COMBAT.md
 * §3.1, §4.1; docs/SYSTEMS_SOCIAL.md §2.2). Each system lane keeps its other strings in its own en-<lane>.ts file.
 */
export const enFailW8 = {
  // ---- combat and items (docs/SYSTEMS_COMBAT.md §7.4) ----
  'action.fail.mounted': 'Cannot do that while on a horse.',
  'action.fail.not_mounted': 'You are not riding a horse.',
  'action.fail.moving': 'Stop moving first.',
  'action.fail.in_combat': 'Cannot do that during battle.',
  'action.fail.cos_active': 'You already have a horse.',
  'action.fail.broken': 'The item is broken.',
  'action.fail.nothing_to_repair': 'No item needs repairing.',
  'action.fail.alchemy_mismatch': 'That elixir or powder does not fit this equipment.',
  'action.fail.max_plus': 'This item cannot be enhanced any further.',
  'action.fail.berserk_not_ready': 'Your Berserk gauge is not full.',
  'action.fail.berserk_active': 'Cannot be used in Berserk mode.',
  // ---- trade, stalls, guilds (docs/SYSTEMS_SOCIAL.md §2.2) ----
  'action.fail.trading': 'Cannot do that during an exchange.',
  'action.fail.stalling': 'Cannot do that while running a stall.',
  'action.fail.stall_changed': 'The item on sale has changed.',
  'action.fail.stall_full': 'The member limit(8) has been reached.',
  'action.fail.stall_closed': 'The shop is under construction.',
  'action.fail.not_in_guild': 'You do not belong to a guild.',
  'action.fail.in_guild': 'Already in a guild.',
  'action.fail.no_permission': 'You do not have the right to do that.',
  'action.fail.guild_full': 'The guild is full.',
  'action.fail.name_taken': 'The selected guild name already exists.',
  'action.fail.bad_name': 'Guild name must consist of 2~12 English letters.',
} satisfies Record<string, string>

/**
 * Documented exceptions of the skill audit (skill-audit.ts), keyed `category:group`. Each says why the row cannot or
 * should not pass that check; the audit test fails on any other failure.
 */
export const AUDIT_EXCEPTIONS: Record<string, string> = {
  // 'nbuf', 'bbuf', 'dttp' [5, 3]: "Detects enemies in stealth state". The game has no stealth yet, so there is
  // nothing to reveal; the buff lands, shows its effect and expires.
  'inert-buff:SKILL_CH_FIRE_DESCRY_A': 'stealth detection; no stealth in the game yet',
  'inert-buff:SKILL_CH_FIRE_DETECT_A': 'stealth detection; no stealth in the game yet',
}

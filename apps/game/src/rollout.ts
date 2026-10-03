/**
 * The wave-9 render rollout gate (docs/WAVE_PLAN3.md §6.15; the user's decisions of 2026-09-28 and 2026-09-29): how the
 * new look (the PBR material path, the modern sky with its day and night, weather rendering and weather sounds, the post
 * stack and the night point lights) reaches players.
 *
 * - 'on' (the release, since 2026-09-29: "Default Medium, High optional"): every preset follows docs/WAVE_PLAN3.md
 *   §5.1, the first run applies its recommendation (Medium on every adapter class; an integrated GPU at render scale
 *   0.75 with weather low; a Retina Mac at 0.75), and the "Modern graphics (preview)" row is gone (the saved
 *   graphics.modern is ignored). Saved settings keep their preset: a player saved on Medium (the old default) moves from
 *   the Classic look to Medium PBR, Low stays the Classic material path ("Low (Classic)"), High and Ultra stay. A blob
 *   saved on Low with the preview off also keeps its classic sky and weather off (settings.ts runReleaseMigration, once),
 *   and Low + classic sky + weather off renders the Low guard state in full (settings.ts classicLook: frozen noon, clear
 *   weather frame, no night splats), in both modes.
 * - 'preview': the opt-in used before the release. The new look shows only for a player who turns on Options →
 *   Graphics → "Modern graphics (preview)" (settings graphics.modern, default off). With it off the world renders
 *   exactly as before wave 9 (the Low guard state: Classic material path, classic sky, weather off, a frozen noon);
 *   every preset keeps its non-render effects (sight range, effect budgets, streaming). The first-run device check only
 *   records its recommendation (graphics.recommended, shown under the toggle); it changes nothing.
 *
 * The server's clock and weather run in both modes; only the client rendering is gated. Everything reads the gate
 * through settings.ts effectiveGraphics (qualityFor / worldQualityFor, weatherLevelFor, weatherShown). Both modes stay
 * covered by `pnpm vitest run apps/game/test/rollout.test.ts`; going back to the preview is this one value.
 */
export type RenderRollout = 'preview' | 'on'

export const RENDER_ROLLOUT: RenderRollout = 'on'

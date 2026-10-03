/**
 * Level bands: mob name colours and target gems (docs/UX_GAPS.md §4.2; docs/WAVE_PLAN.md decision 24). The
 * thresholds are our rule, not derived from the server's level-difference bonus. Shared by the nameplates (UX-B)
 * and the world map's hunting labels (FLD-C). Pure: no DOM.
 */

export type LevelBand = 'weak2' | 'weak1' | 'normal' | 'strong1' | 'strong2'

export const LEVEL_BANDS: readonly LevelBand[] = ['weak2', 'weak1', 'normal', 'strong1', 'strong2']

/** d = mob level − own level. */
export function levelBand(mobLevel: number, selfLevel: number): LevelBand {
  const d = mobLevel - selfLevel
  return d <= -6 ? 'weak2' : d <= -3 ? 'weak1' : d <= 2 ? 'normal' : d <= 5 ? 'strong1' : 'strong2'
}

/** Name colour per band (UX_GAPS §4.2 table). */
export const LEVEL_BAND_COLOR: Readonly<Record<LevelBand, string>> = {
  weak2: '#a0a0a0',
  weak1: '#8fe08a',
  normal: '#ffe066',
  strong1: '#ffa04a',
  strong2: '#ff5a48',
}

/** Target-window gem art key per band. */
export const LEVEL_BAND_GEM: Readonly<Record<LevelBand, string>> = {
  weak2: 'targetwindow/tw_gem_weak2',
  weak1: 'targetwindow/tw_gem_weak1',
  normal: 'targetwindow/tw_gem_normal',
  strong1: 'targetwindow/tw_gem_strong1',
  strong2: 'targetwindow/tw_gem_strong2',
}

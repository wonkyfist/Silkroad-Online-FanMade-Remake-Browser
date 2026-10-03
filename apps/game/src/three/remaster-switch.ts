/**
 * The remastered-textures test switch (three/remaster.ts): Options -> Graphics -> "Remastered textures (test)"
 * (settings.ts graphics.remaster, persisted) and the `?remaster=1` / `?remaster=0` page-load override. The override
 * wins until the Options toggle is used; the row shows the effective state. No Babylon here (hud/options.ts uses it).
 *
 * W9F LG-1 / TEX-4: the switch is part of the new look. Without it (the preview off: the Low guard) neither the saved
 * setting nor the URL override applies, since no Options row can clear the retired setting while the preview is off.
 * Release (2026-09-29): the approved sets reach every player through the in-place swaps (three/actor-textures.ts), so
 * the switch is a test tool only: on a production page it needs `?remaster=1` (settings.ts REMASTER_TEST_SETS), and a
 * setting saved long ago no longer brings back the twins or RemasterLighting there.
 */
import { RENDER_ROLLOUT, type RenderRollout } from '../rollout.ts'
import { REMASTER_TEST_SETS, newLook, settings, type Settings } from '../settings.ts'

/** `?remaster=1` -> true, `?remaster=0|false|off` -> false, absent -> null (the setting decides). */
export function remasterFromSearch(search: string): boolean | null {
  let v: string | null
  try {
    v = new URLSearchParams(search).get('remaster')
  } catch {
    return null
  }
  if (v === null) return null
  return !(v === '0' || v === 'false' || v === 'off')
}

/**
 * Effective state: off without the new look (the preview off, or the Low guard's combination: settings.ts `newLook`),
 * and off where the test sets are not looked for (`testSets`: the dev server or `?remaster=1`); otherwise a URL
 * override wins over the setting.
 */
export function remasterWanted(s: Settings, override: boolean | null, rollout: RenderRollout = RENDER_ROLLOUT, testSets: boolean = REMASTER_TEST_SETS): boolean {
  return testSets && newLook(s, rollout) && (override ?? s.graphics.remaster)
}

let urlOverride: boolean | null = (() => {
  try {
    return remasterFromSearch(globalThis.location?.search ?? '')
  } catch {
    return null
  }
})()
let enabled = remasterWanted(settings.get(), urlOverride)
const listeners = new Set<(on: boolean) => void>()

function update(): void {
  const next = remasterWanted(settings.get(), urlOverride)
  if (next === enabled) return
  enabled = next
  for (const fn of [...listeners]) {
    try {
      fn(enabled)
    } catch (err) {
      console.error('[remaster] listener failed', err)
    }
  }
}

settings.onChange(() => update())

export function remasterEnabled(): boolean {
  return enabled
}

export function onRemasterChange(fn: (on: boolean) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** What the Options row shows for these settings: the effective state while a URL override is active. */
export function remasterShown(s: Settings, rollout: RenderRollout = RENDER_ROLLOUT): boolean {
  return remasterWanted(s, urlOverride, rollout)
}

/** The Options toggle was used: the setting decides from now on (this page load included). */
export function endRemasterOverride(): void {
  if (urlOverride === null) return
  urlOverride = null
  update()
}

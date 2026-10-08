/**
 * The lighting upgrade's switches (docs/LIGHTING.md): each new piece is on by default and has one switch here for the
 * A/B (the look lab, `window.__sroLook` on the bench page). Nothing in the game changes them; the per-preset choice is
 * RenderQuality (render/quality.ts). `applyLightLook` re-applies the scene's render parts after a change.
 */
import type { Scene } from '@babylonjs/core'
import { renderPostOf } from './post.ts'

export const LIGHT_LOOK = {
  /** The sun-lit ground's bounce in the world's ambient SH (render/lighting.ts groundBounceSH). */
  groundBounce: true,
  /** The bounded auto exposure (render/adaptation.ts) where the preset asks for it. */
  eyeAdaptation: true,
  /** PCSS (contact-hardening) sun shadows where the preset asks for them (render/shadows.ts). */
  softShadows: true,
  /** The lanterns' glow in the air (the shafts' composite, render/volumetrics/shafts.ts pickGlowLights). */
  lanternGlow: true,
  /** Pass 2: the all-day atmosphere (render/atmosphere.ts) and the daytime sun shafts (SHAFT_TUNING). */
  atmosphere: true,
  /** Pass 2: the cinematic grade (render/grade.ts GRADE_TIME; off = GRADE_TIME_V1). */
  cinematicGrade: true,
}

export type LightLookSwitch = keyof typeof LIGHT_LOOK

/** Sets switches and re-applies the scene's render (post rebuild, shadow and light settings). */
export function applyLightLook(scene: Scene, next: Partial<typeof LIGHT_LOOK> = {}): typeof LIGHT_LOOK {
  Object.assign(LIGHT_LOOK, next)
  const post = renderPostOf(scene)
  const render = post?.render
  if (render) render.setQuality(render.quality)
  return { ...LIGHT_LOOK }
}

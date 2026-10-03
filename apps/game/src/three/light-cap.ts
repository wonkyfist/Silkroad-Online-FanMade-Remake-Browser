/**
 * Every scene material's light cap at the scene's light count from the start (lane P-STALL).
 *
 * Babylon 9.28's glTF loader ends every load (AssetContainers too) by raising `maxSimultaneousLights` of EVERY material
 * in the scene to `scene.lights.length` (glTFLoader `_loadAsync`, for the lights a glTF may bring). The material's
 * MAXLIGHTCOUNT define follows, so the first character model loaded after the scene gained a light recompiled the whole
 * world: on the create stage, switching to the female model rebuilt 12 world effects (terrain, batches, trees, water)
 * in one 0.25-1.2 s frame (MAXLIGHTCOUNT 5 to 6: the night lights' cluster arrives after the world's own loads).
 *
 * `keepLightCap` applies the same raise when it is due instead, before each frame's render and after it (ahead of the
 * warm-up's own asks): on every scene material whenever the scene's material or light count changed. The materials end
 * in the state the loader would leave them in (the same cap, the same lights drawn); only the moment moves, to before a
 * material's first compile, and the loader's raise then finds nothing to change. (Babylon announces a new material or
 * light a tick late, after PBR's own field defaults, so the frame hooks are used rather than those observables.)
 */
import type { Material, Scene } from '@babylonjs/core'

type Capped = Material & { maxSimultaneousLights?: number }

/** Raises one material's light cap to `lights` (as the glTF loader would). */
export function raiseLightCap(m: Material, lights: number): void {
  const c = m as Capped
  if (typeof c.maxSimultaneousLights === 'number' && c.maxSimultaneousLights < lights) c.maxSimultaneousLights = lights
}

/** Keeps the scene's materials at its light count (see the file comment); returns the remover. */
export function keepLightCap(scene: Scene): () => void {
  let materials = -1
  let lights = -1
  const check = () => {
    const n = scene.lights.length
    if (scene.materials.length === materials && n === lights) return
    materials = scene.materials.length
    lights = n
    for (const m of scene.materials) raiseLightCap(m, n)
  }
  check()
  const before = scene.onBeforeRenderObservable.add(check, undefined, true)
  const after = scene.onAfterRenderObservable.add(check, undefined, true)
  return () => {
    scene.onBeforeRenderObservable.remove(before)
    scene.onAfterRenderObservable.remove(after)
  }
}

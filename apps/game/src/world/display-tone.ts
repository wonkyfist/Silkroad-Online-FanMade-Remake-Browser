/**
 * Display-referred colours on the unlit StandardMaterials the game lays into the world (W9F R1): the target circle
 * and the click marker (world/effects.ts GroundDecal), the level-up column, the "cannot get there" marker
 * (features/ux-world.ts) and the weapon trails (fx/trail.ts). Their colours are UI art: on Classic they reach the screen
 * as they are.
 *
 * On the PBR presets the scene target is linear HDR that the post stack multiplies by its exposure (SkyState.exposure ×
 * EXPOSURE_TRIM: about 1 at noon, up to ~41 in a night storm) before the tone curve, and a StandardMaterial's output is
 * linearised there (`toLinearSpace`, pow 2.2: image processing runs as a post process). So a colour c came out as
 * c^2.2 × exposure: a near-white disc with a bloom halo at night, the hostile / neutral / friendly tone lost.
 *
 * `displayScale(scene)` = exposure^(−1/2.2) undoes both: (c × s)^2.2 × exposure = c^2.2, the art's own linear colour,
 * which the tone curve and the output encoding then show as the art (the hover overlay's rule, world-render
 * highlightOverlayColor, for a colour the material linearises itself). It is 1 without a post stack (the Classic path:
 * the Low guard's image is unchanged). The registered materials and textures follow the exposure every frame.
 */
import { Color3, type BaseTexture, type Observer, type Scene, type StandardMaterial } from '@babylonjs/core'
import { sceneExposure } from '@sro/world-render'

/** Babylon's toLinearSpace power (LinearEncodePowerApprox). */
const LINEAR_POWER = 2.2

/** The factor a display colour takes on `scene` now: exposure^(−1/2.2) on the PBR presets, 1 on Classic. */
export function displayScale(scene: Scene): number {
  const e = sceneExposure(scene)
  return e > 0 && Number.isFinite(e) && e !== 1 ? Math.pow(e, -1 / LINEAR_POWER) : 1
}

interface Toned {
  apply(s: number): void
}

interface Registry {
  readonly entries: Set<Toned>
  last: number
  readonly obs: Observer<Scene> | null
}

const REGISTRIES = new WeakMap<Scene, Registry>()

function registry(scene: Scene): Registry {
  let r = REGISTRIES.get(scene)
  if (!r) {
    const entries = new Set<Toned>()
    const reg: Registry = {
      entries,
      last: displayScale(scene),
      obs: scene.onBeforeRenderObservable.add(() => {
        if (!entries.size) return
        const s = displayScale(scene)
        if (s === reg.last) return
        reg.last = s
        for (const e of entries) e.apply(s)
      }),
    }
    r = reg
    REGISTRIES.set(scene, r)
  }
  return r
}

function track(scene: Scene, owner: { onDisposeObservable: { addOnce(fn: () => void): unknown } }, entry: Toned): () => void {
  const r = registry(scene)
  r.entries.add(entry)
  entry.apply(displayScale(scene))
  const off = () => r.entries.delete(entry)
  owner.onDisposeObservable.addOnce(off)
  return off
}

const colours = new WeakMap<StandardMaterial, { base: Color3; off: () => void }>()

/** Keeps `mat.emissiveColor` at `base` × displayScale (call again to change the base colour). */
export function displayEmissive(mat: StandardMaterial, base: Readonly<Color3>): void {
  const known = colours.get(mat)
  if (known) {
    known.base.copyFrom(base)
    const s = displayScale(mat.getScene())
    mat.emissiveColor.set(known.base.r * s, known.base.g * s, known.base.b * s)
    return
  }
  const own = new Color3().copyFrom(base)
  const off = track(mat.getScene(), mat, {
    apply: s => {
      if (!mat.emissiveColor) mat.emissiveColor = new Color3()
      mat.emissiveColor.set(own.r * s, own.g * s, own.b * s)
    },
  })
  colours.set(mat, { base: own, off })
}

/** Keeps the level of a texture used only as a material's emissive (not shared with its opacity) at displayScale. */
export function displayTexture(scene: Scene, tex: BaseTexture): () => void {
  return track(scene, tex, { apply: s => (tex.level = s) })
}

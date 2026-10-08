// P1 pilot (docs/CHARACTERS.md §15.3): which tracks of a retail clip a pilot body plays. Dependency-free so the converter
// (packages/convert/src/tools/pilot-char.ts) runs the same rule as a check over the real animation packs.
// Retail clips key every joint's translation (the retail bone lengths) and could key scale; on a pilot body only the
// root (`Bip01`) translates, every other joint keeps its rest offset (the body's own bone lengths), and no scale plays.

/** The skeleton root: the only joint whose translation track a pilot body keeps. */
export const PILOT_ROOT_JOINT = 'Bip01'

/** Whether a track (glTF path `translation` / `rotation` / `scale`, or Babylon `position` / `rotationQuaternion` /
 *  `scaling`) on joint `target` plays on a pilot body. */
export function pilotTrackKept(property: string, target: string | undefined): boolean {
  if (property === 'scale' || property === 'scaling') return false
  if (property === 'translation' || property === 'position') return target === PILOT_ROOT_JOINT
  return true
}

/** The root translation scale of a pilot body (own hip height / retail hip height), from its sidecar; 1 if absent. */
export function pilotRootScale(sidecar: Record<string, unknown> | null | undefined): number {
  const s = (sidecar?.pilot as { rootScale?: unknown } | undefined)?.rootScale
  return typeof s === 'number' && s > 0.5 && s < 1.5 ? s : 1
}

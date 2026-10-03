/**
 * Clip sound tracks of one model (docs/SOUND.md §2.1): BSR sound mods joined to the sidecar's clips.
 *
 * For each sidecar clip:
 *   1. a LOCOMOTION system set whose name equals the clip's BAN base name (`banName`) wins;
 *   2. otherwise the animation-linked set with name === the clip's aniGroup and animationType === the clip's type;
 *   3. otherwise the clip has no tracks.
 * Inside the set, every `sound` mod contributes the tracks of its inner set named 'default' (all inner sets when
 * none is named so). Node-free.
 */
import type { BsrModDataSet, BsrResource, BsrSoundTrack } from '@sro/formats'
import { SOUND_MODEL_FORMAT, soundHandle, type ClipTrack, type ModelSounds } from '../../../shared/src/sound.ts'
import type { SoundResolver } from './resolve.ts'

/** The sidecar clip fields the join uses (work/out/<cat>/<name>.json `animations[]`). */
export interface SidecarClip {
  name: string
  group: string
  type: number
  banName: string
}

function setTracks(set: BsrModDataSet): BsrSoundTrack[] {
  const out: BsrSoundTrack[] = []
  for (const mod of set.mods) {
    if (mod.kind !== 'sound') continue
    const named = mod.sets.filter(s => s.name.trim().toLowerCase() === 'default')
    for (const inner of named.length ? named : mod.sets) {
      for (const t of inner.tracks) if (t && t.path.trim()) out.push(t)
    }
  }
  return out
}

export function modelTracks(code: string, bsrPath: string, bsr: BsrResource, clips: readonly SidecarClip[], resolver: SoundResolver): ModelSounds {
  const loco = new Map<string, BsrSoundTrack[]>()
  for (const s of bsr.modPalette.systemSets) {
    if (s.type !== 0) continue
    const t = setTracks(s)
    if (t.length) loco.set(s.name.trim().toLowerCase(), [...(loco.get(s.name.trim().toLowerCase()) ?? []), ...t])
  }
  const ani = new Map<string, BsrSoundTrack[]>()
  for (const s of bsr.modPalette.aniSets) {
    if (s.animationType === null || s.animationType < 0) continue
    const t = setTracks(s)
    const key = `${s.name.trim().toLowerCase()}|${s.animationType}`
    if (t.length) ani.set(key, [...(ani.get(key) ?? []), ...t])
  }
  const out: ModelSounds = { format: SOUND_MODEL_FORMAT, version: 1, code, bsr: bsrPath, clips: {} }
  for (const clip of clips) {
    const raw = loco.get(clip.banName.trim().toLowerCase()) ?? ani.get(`${clip.group.trim().toLowerCase()}|${clip.type}`)
    if (!raw) continue
    const tracks: ClipTrack[] = []
    for (const t of raw) {
      const file = resolver.resolve(t.path, code)
      if (!file) continue
      tracks.push({ ms: Math.max(0, Math.round(t.keyTimeMs)), handle: soundHandle(t.event), raw: t.event, file })
    }
    if (!tracks.length) continue
    tracks.sort((a, b) => a.ms - b.ms)
    out.clips[clip.name] = tracks
  }
  return out
}

/** Every track count of a model file. */
export const trackCount = (m: ModelSounds): number => Object.values(m.clips).reduce((n, t) => n + t.length, 0)

/** Every track path of every sound mod in a BSR (system and animation sets), joined to a clip or not. */
export function bsrSoundPaths(bsr: BsrResource): string[] {
  const out = new Set<string>()
  for (const s of [...bsr.modPalette.systemSets, ...bsr.modPalette.aniSets]) {
    for (const mod of s.mods) {
      if (mod.kind !== 'sound') continue
      for (const inner of mod.sets) for (const t of inner.tracks) if (t && t.path.trim()) out.add(t.path.trim())
    }
  }
  return [...out]
}

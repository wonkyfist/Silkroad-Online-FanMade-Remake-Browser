/**
 * World feature of the sound zones (docs/WORLD_EDITOR.md §4.10, D14, D31; docs/WAVE_PLAN8.md D9, D13, lane WE-R): the
 * user's editor-made ambience zones on the world screen, through audio/zones.ts. On every preset (Low too: the zones
 * need no render part):
 *
 * - the export's `sound-zones.json` (`/out(-opt)/world/<world>/sound-zones.json`, written by the converter's edits pass
 *   from the layer's `zones.json`): a list, or `{ zones: [...] }`; none (404) = no zone, silently;
 * - played as zone voices beside the area loop (SOUND §5.10's `setArea` keeps the area loop): at most 2 zone loops at
 *   a time, nearest first, at most 1 inside the town box (wave 11's town sound runs up to 3 there);
 * - `when` follows the server clock (worldEnter / worldClock, as sky-clock.ts keeps it), else the sky's solar time.
 *
 * Registered after the sound, coast and town-sound features (the area and the town loops are set first). Silent without
 * sound. The console's view: `window.__sroSoundZones`.
 */
import { clockAt, type WorldClockState, type WorldEditZone } from '@sro/shared'
import type { World } from '@sro/world-render'
import type { GameAudio } from '../../audio/index.ts'
import { SoundZones, readSoundZones, type SoundZonesOutput } from '../../audio/zones.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'

/** The export's sound-zone file, beside town.json. */
export const SOUND_ZONES_FILE = 'sound-zones.json'

/** SoundZones' output on GameAudio: a file of the index, else a cue's first file; the ambient bus's loops. */
export function soundZonesOutput(audio: GameAudio): SoundZonesOutput {
  return {
    file: sound => {
      const index = audio.index
      if (!index) return null
      if (index.files[sound]) return sound
      return index.cues[sound]?.files.find(f => !!index.files[f]) ?? null
    },
    loopAt: (file, o) => audio.loopAt(file, o),
  }
}

/** Loads the export's zones ([] when it has none or nothing in it validates). */
export async function loadSoundZones(url: string, fetcher: typeof fetch = fetch): Promise<WorldEditZone[]> {
  try {
    const res = await fetcher(url)
    if (!res.ok) return []
    return readSoundZones(await res.json(), msg => console.warn(msg))
  } catch {
    return []
  }
}

export function soundZonesFeature(ctx: WorldFeatureContext): WorldFeature {
  const audio: GameAudio | undefined = ctx.app?.audio
  if (!audio) return {}
  const zones = new SoundZones(soundZonesOutput(audio))
  let clock: WorldClockState | null = null
  let inTown = false
  let world: World | null = null
  let loaded: WorldEditZone[] = []
  /** The console preview's zones while one is set (they win over the file, even one still loading). */
  let previewing: WorldEditZone[] | null = null
  let preloaded = false

  const preload = () => {
    const index = audio.index
    if (preloaded || !index || !loaded.length) return
    preloaded = true
    const out = soundZonesOutput(audio)
    audio.bank.preload(loaded.map(z => out.file(z.sound)))
  }

  const followWorld = (w: World | null, base: string | null, folder: string | null) => {
    if (w === world) return
    world = w
    loaded = []
    preloaded = false
    zones.stop()
    zones.setZones(previewing ?? [])
    if (!w || !base || !folder) return
    void loadSoundZones(`${base}world/${folder}/${SOUND_ZONES_FILE}`).then(list => {
      if (world !== w) return
      loaded = list
      if (!previewing) zones.setZones(list)
    })
  }

  const debug = {
    get zones() {
      return zones.size
    },
    get loops() {
      return zones.loops
    },
    get active() {
      return zones.active
    },
    get stats() {
      return zones.stats()
    },
    /** The editor's "Listen here" in the game: plays these zones instead of the export's (null: back to the file). */
    preview(list: WorldEditZone[] | null) {
      previewing = list
      zones.setZones(list ?? loaded)
    },
    runtime: zones,
  }
  if (typeof window !== 'undefined') (window as unknown as { __sroSoundZones?: unknown }).__sroSoundZones = debug

  return {
    onMessage(msg) {
      if (msg.t === 'worldEnter') clock = msg.world.clock ?? null
      else if (msg.t === 'worldClock') clock = msg.clock
    },

    onFrame(now, dt) {
      const ground = ctx.world()
      const w = ground?.world ?? null
      try {
        followWorld(w, ground?.base ?? null, ground?.folder ?? null)
      } catch (err) {
        console.warn('[sound-zones] follow failed', err)
      }
      if (!w) return
      if (!zones.size) {
        if (zones.loops) zones.stop()
        return
      }
      const selfId = ctx.selfId()
      const self = selfId !== null ? ctx.view(selfId) : undefined
      if (!self) return
      preload()
      const p = self.root.position
      const clockT = clock ? clockAt(clock, now).t : undefined
      zones.update({ x: p.x, y: p.y, z: p.z, solarT: w.timeOfDay, ...(clockT !== undefined ? { clockT } : {}), inTown, dt })
    },

    onTownChange(t) {
      inTown = t
    },

    dispose() {
      if (typeof window !== 'undefined') {
        const win = window as unknown as { __sroSoundZones?: unknown }
        if (win.__sroSoundZones === debug) delete win.__sroSoundZones
      }
      zones.stop()
      zones.setZones([])
      world = null
      loaded = []
      previewing = null
    },
  }
}

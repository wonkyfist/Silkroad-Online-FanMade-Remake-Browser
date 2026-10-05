/**
 * World feature of lane TL-S (docs/TOWN_LIFE.md §6; docs/WAVE_PLAN7.md lane TL-S): the town's sound on the world
 * screen, through audio/town.ts. On every preset (Low too: no `World.town` is needed, WAVE_PLAN7 D23):
 *
 * - the bed by the folk near, the hourly temple bell, the vendors' murmurs, the smith's hammer, the animals, the
 *   fountain, and the night layers in town (TownAudio); the bed and the murmurs (the folk's voices) only while the
 *   crowd draws townsfolk (`setTownCrowd`, docs/SOUND.md §10.5);
 * - the town file (`/out(-opt)/world/<world>/town.json`, TL-R) for the stalls, anvils, stables, fountain and the
 *   population when the export has one; Jangan's defaults otherwise;
 * - the pigeons' wing claps on a flush of the life part within the town.
 *
 * The crowd (TL-C) and the pure schedule (TL-R) plug in through `activeTownAudio()` (vendorCall, hammerHit, animal,
 * setExternal) and `setTownFolkCounter` (the schedule's `populationNear`). Silent without sound or an index.
 */
import { clockAt, validateTownFile, type TownFile, type WorldClockState } from '@sro/shared'
import { TownSchedule, type LifePart, type World } from '@sro/world-render'
import { resolveArea, type GameAudio } from '../../audio/index.ts'
import { TOWN_SOUND_CUES, TownAudio, townSoundFromFile, type FolkCounter, type TownAudioOutput } from '../../audio/town.ts'
import { UNIQUE_ALARM_S, uniqueAlarmFromS } from '../../hud/unique-notice.ts'
import type { WorldFeatureContext, WorldFeatureFactory } from '../features.ts'

/** The ambient mute reason while it is night in town (audio/ambient.ts `mute`). */
export const TOWN_NIGHT_MUTE = 'townNight'

let current: TownAudio | null = null
let folkCounter: FolkCounter | null = null
/** The crowd draws townsfolk now (world/features/town.ts says so); false until it does (Low has no crowd at all). */
let crowdDrawn = false
/** The town file the world loaded (the schedule counter's source) and its pure schedule, built on first use. */
let scheduleFile: TownFile | null = null
let schedule: TownSchedule | null = null
/** A unique's appearance alarm (server s, length) not yet handed to the schedule. */
let pendingAlarm: { nowS: number; sec: number } | null = null

function townSchedule(): TownSchedule | null {
  if (!schedule && scheduleFile) {
    try {
      schedule = new TownSchedule(scheduleFile)
    } catch (err) {
      console.warn('[town-sound] the town schedule failed; the district estimate counts', err)
      scheduleFile = null
      return null
    }
  }
  if (schedule && pendingAlarm) {
    schedule.alarm(pendingAlarm.nowS, pendingAlarm.sec)
    pendingAlarm = null
  }
  return schedule
}

/**
 * The pure schedule's count (H11 S2, LOW-1; WAVE_PLAN7 D23, TOWN_LIFE §6 F10): who the town file puts within `r` of
 * (x, z) at that time, as on every client. The bed's counter wherever no town part draws folk (Low, Town life Off,
 * cut 20); null while the town file loads (the district estimate counts meanwhile).
 */
export const scheduleFolkCounter: FolkCounter = (x, z, r, nowS, solarT) => townSchedule()?.populationNear(x, z, r, nowS, solarT) ?? null

/** The world screen's town sound (null outside the world, or without sound): the crowd's events go here. */
export function activeTownAudio(): TownAudio | null {
  return current
}

/** The drawn crowd's count for the bed (null: the pure schedule's, scheduleFolkCounter). */
export function setTownFolkCounter(fn: FolkCounter | null): void {
  folkCounter = fn
  current?.setFolkCounter(fn ?? scheduleFolkCounter)
}

/**
 * Whether the crowd draws townsfolk (docs/SOUND.md §10.5): their voices (the bed, the vendors' murmurs) play only
 * then, so Options → Town life Off, switched live or not, and Low (no crowd) leave the town without talk.
 */
export function setTownCrowd(drawn: boolean): void {
  crowdDrawn = drawn
  current?.setCrowd(drawn)
}

/** TownAudio's output on GameAudio: the ambient bus, the index's cues and files. */
export function townAudioOutput(audio: GameAudio): TownAudioOutput {
  return {
    files: cue => {
      const index = audio.index
      return index?.cues[cue]?.files.filter(f => !!index.files[f]) ?? []
    },
    ms: file => audio.index?.files[file]?.ms ?? 0,
    loopAt: (file, o) => audio.loopAt(file, o),
    oneShot: (file, o) => {
      if (!audio.index?.files[file]) return false
      audio.playFile(file, { bus: 'ambient', kind: 'other', pos: o.pos, gain: o.gain, follow: o.follow, priority: o.unculled ? 1 : 0, self: !!o.unculled })
      return true
    },
    nightLayers: () => {
      const index = audio.index
      const area = index ? resolveArea(index, 'JANGAN_TOWN') : null
      return area?.[1].night.filter(l => !l.loop && !!index?.files[l.file]) ?? []
    },
    muteDayLayers: on => audio.ambient.mute(TOWN_NIGHT_MUTE, on),
  }
}

/** Loads the export's town file (null when it has none or it does not validate). */
async function loadTownFile(url: string): Promise<TownFile | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const v = validateTownFile(await res.json())
    return v.ok && v.file.kind === 'town' ? v.file : null
  } catch {
    return null
  }
}

export const townSoundFeature: WorldFeatureFactory = (ctx: WorldFeatureContext) => {
  const audio: GameAudio | undefined = ctx.app?.audio
  if (!audio) return {}
  const town = new TownAudio(townAudioOutput(audio))
  town.setFolkCounter(folkCounter ?? scheduleFolkCounter)
  town.setCrowd(crowdDrawn)
  current = town
  /** The server clock (worldEnter / worldClock, as sky-clock.ts keeps it): the bell's hours and the count (H11 S1). */
  let clock: WorldClockState | null = null
  let lastNowS = Number.NaN
  let inTown = false
  let world: World | null = null
  let life: LifePart | null = null
  let offFlush: (() => void) | null = null
  let preloaded = false

  const preload = () => {
    const index = audio.index
    if (preloaded || !index) return
    preloaded = true
    const cues = Object.values(TOWN_SOUND_CUES).flat()
    audio.bank.preload(cues.flatMap(c => index.cues[c]?.files ?? []).filter(f => !!index.files[f]))
  }

  const followWorld = (w: World | null, base: string | null, folder: string | null) => {
    if (w === world) return
    world = w
    if (!w || !base || !folder) return
    void loadTownFile(`${base}world/${folder}/town.json`).then(file => {
      if (!file || world !== w) return
      town.configure(townSoundFromFile(file))
      scheduleFile = file
      schedule = null
      // No drawn crowd counts (Low): compile the schedule now, at the world entry (as the town part compiles its own
      // on Medium), not at the bed's first count in play: it takes ~0.2 s for Jangan's ~270 agents.
      if (!folkCounter) townSchedule()
    })
  }

  const followLife = (next: LifePart | null) => {
    if (next === life) return
    offFlush?.()
    offFlush = null
    life = next
    if (!next) return
    const o = next.onFlush.add(f => {
      if (inTown) town.wings(f)
    })
    offFlush = () => next.onFlush.remove(o)
  }

  // The console's view (`window.__sroTownSound`): the count, the bed, the voices.
  const debug = {
    get folk() {
      return town.folk
    },
    get bed() {
      return town.bed
    },
    get loops() {
      return town.loops
    },
    get oneShots() {
      return town.oneShots
    },
    get night() {
      return town.isNight
    },
    get stats() {
      return town.stats()
    },
    town,
  }
  if (typeof window !== 'undefined') (window as unknown as { __sroTownSound?: unknown }).__sroTownSound = debug

  return {
    onMessage(msg) {
      if (msg.t === 'worldEnter') clock = msg.world.clock ?? null
      else if (msg.t === 'worldClock') clock = msg.clock
      else if (msg.t === 'uniqueNotice' && msg.event === 'appeared' && Number.isFinite(lastNowS)) {
        // the appearance's alarm empties the schedule's streets too (the town part does its own)
        pendingAlarm = { nowS: uniqueAlarmFromS(msg, lastNowS), sec: UNIQUE_ALARM_S }
        if (schedule) townSchedule()
      }
    },

    onFrame(now, dt) {
      const ground = ctx.world()
      const w = ground?.world ?? null
      try {
        followWorld(w, ground?.base ?? null, ground?.folder ?? null)
        followLife(w?.life ?? null)
      } catch (err) {
        console.warn('[town-sound] follow failed', err)
      }
      const selfId = ctx.selfId()
      const self = selfId !== null ? ctx.view(selfId) : undefined
      if (!self || !w) return
      preload()
      const p = self.root.position
      lastNowS = now / 1000
      const clockT = clock ? clockAt(clock, now).t : undefined
      town.update({ x: p.x, y: p.y, z: p.z, nowS: now / 1000, solarT: w.timeOfDay, ...(clockT !== undefined ? { clockT } : {}), inTown, dt })
    },

    onTownChange(t) {
      inTown = t
    },

    dispose() {
      if (typeof window !== 'undefined') {
        const win = window as unknown as { __sroTownSound?: unknown }
        if (win.__sroTownSound === debug) delete win.__sroTownSound
      }
      followLife(null)
      town.stop()
      if (current === town) current = null
      world = null
      scheduleFile = null
      schedule = null
      pendingAlarm = null
    },
  }
}

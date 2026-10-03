/**
 * The coast's sounds (docs/COAST.md §10.1, §12.6; docs/WAVE_PLAN6.md lane CST-A): the `COAST` area of the sound
 * index and the four `env/*` files it needs, added to every export scope like the weather files.
 *
 * - **The area** is built from retail's Asia Minor beach (소아시아해변, effectenvsnd.txt): its gull and gust one-shots
 *   (`seabird`, `seabird2`, `day_wind02`), with the loop bed of the Jangan field (`day_wind` / `night_wind`) in place
 *   of the beach's `sea_wave1` loop [decision, CST-A]: the field ↔ coast switch then keeps one bed with no seam, and
 *   the surf is the client's positional emitters (apps/game/src/audio/coast.ts), so it gets louder near the sea
 *   instead of droning at the same level 120 m inland. Music stays the field's.
 * - **The files**: `env/sea_wave1` (the surf loop), `env/seabird`, `env/seabird2` (the gulls) and `env/oceana` (the
 *   storm surf, gain from Hs): 35.7 s, ≈ 0.29 MB at the ambience bitrate (§10.1).
 *
 * Without the beach area in the source (another client build), the area falls back to the retail file names, so the
 * index still gets a `COAST` area whenever the files exist. Node-free.
 */
import type { AmbientLayer, AreaSound } from '../../../shared/src/sound.ts'
import type { SoundPlan } from './build.ts'
import type { EnvArea } from './envsnd.ts'
import type { SoundResolver } from './resolve.ts'

/** The index id of the coast area (GameAudio.setArea('COAST')). */
export const COAST_AREA_ID = 'COAST'
/** The retail area the coast ambience is built from (Asia Minor beach). */
export const COAST_AREA_SOURCE = '소아시아해변'
/** The field area whose loop bed the coast keeps (JANGAN_FIELD). */
export const COAST_BED_AREA = 'JANGAN_FIELD'
/** The files the export adds in every scope (lower-case ids under prim/snd). */
export const COAST_SOUND_FILES: readonly string[] = ['env/sea_wave1', 'env/seabird', 'env/seabird2', 'env/oceana']

/** The beach's one-shots when the source lacks the area (retail effectenvsnd.txt line 437). */
const FALLBACK: Pick<EnvArea, 'day' | 'night'> = {
  day: [
    { file: 'seabird2.wav', min: 20, max: 35 },
    { file: 'day_wind02.wav', min: 30, max: 40 },
    { file: 'seabird.wav', min: 35, max: 40 },
  ],
  night: [
    { file: 'seabird2.wav', min: 10, max: 25 },
    { file: 'day_wind02.wav', min: 20, max: 30 },
    { file: 'seabird.wav', min: 15, max: 30 },
  ],
}
const FALLBACK_BED = { day: 'env/day_wind', night: 'env/night_wind' } as const

/**
 * Adds the coast files (as ambient) and the `COAST` area to an export plan. A file without a source ends in
 * report.notExported, and `finishSoundIndex` drops the layers left without a file.
 */
export function addCoastSounds(plan: Pick<SoundPlan, 'files' | 'ambient'> & { index: { areas: Record<string, AreaSound> } }, envAreas: readonly EnvArea[], resolver: SoundResolver): AreaSound {
  for (const id of COAST_SOUND_FILES) {
    plan.files.add(id)
    plan.ambient.add(id)
  }
  const beach = envAreas.find(a => a.name === COAST_AREA_SOURCE) ?? null
  const field = plan.index.areas[COAST_BED_AREA] ?? null
  const layers = (time: 'day' | 'night'): AmbientLayer[] => {
    const out: AmbientLayer[] = []
    const bed = field?.[time].find(l => l.loop)?.file ?? FALLBACK_BED[time]
    out.push({ file: bed, loop: true, everyS: [0, 0] })
    plan.files.add(bed)
    plan.ambient.add(bed)
    for (const l of (beach ?? FALLBACK)[time]) {
      // The beach's own loop (sea_wave1) is the client's positional surf, not the bed.
      if (l.min === 0 && l.max === 0) continue
      const file = resolver.resolveIn('env', l.file, `effectenvsnd ${COAST_AREA_SOURCE}`) ?? `env/${l.file.toLowerCase().replace(/\.wav$/, '')}`
      plan.files.add(file)
      plan.ambient.add(file)
      out.push({ file, loop: false, everyS: [l.min, l.max] })
    }
    return out
  }
  const area: AreaSound = {
    source: COAST_AREA_SOURCE,
    kind: 'field',
    music: field?.music ?? null,
    day: layers('day'),
    night: layers('night'),
    regions: [],
  }
  plan.index.areas[COAST_AREA_ID] = area
  return area
}

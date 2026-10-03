/**
 * TL-S (docs/TOWN_LIFE.md §6; docs/WAVE_PLAN7.md D29): the town's seeded synthesis.
 * - the same seed and sources give the same bytes; another seed gives other sounds;
 * - every file of the cue table is made, mono at 22,050 Hz, with the lengths and levels it is meant to have;
 * - the loops are seamless (the wrap is no louder a step than the signal's own), nothing clips;
 * - without retail sources everything falls back to pure synthesis; with them (the extracted client) the dog is the
 *   wolf pitched up 1.3×;
 * - the export plan gets the cues, the loops on the ambience bitrate, and drops a cue whose files were not written.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SoundCue } from '../../shared/src/sound.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { parseWav, type Pcm } from '../src/sound/pcm.ts'
import {
  BED_LOOP_S, DOG_PITCH, FOUNTAIN_LOOP_S, TOWN_SYNTH_CUES, TOWN_SYNTH_FILES, TOWN_SYNTH_LOOPS, TOWN_SYNTH_RATE, TOWN_SYNTH_SEED, addTownSynthSounds,
  synthTownSounds, townSynthWavs,
} from '../src/sound/town-synth.ts'

const SND = join(REPO_ROOT, 'work', 'extracted', 'Data', 'prim', 'snd')
const haveRetail = existsSync(join(SND, 'emoticon')) && existsSync(join(SND, 'cos', 'cos_wolf_01_stand1.wav'))
const readRetail = (id: string): Pcm | null => {
  const p = join(SND, ...id.split('/')) + '.wav'
  return existsSync(p) ? parseWav(readFileSync(p)) : null
}

const pure = synthTownSounds()
const float = (p: Pcm) => Array.from(p.channels[0]!, v => v / 32768)
const peak = (x: number[]) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
const rmsDb = (x: number[]) => 20 * Math.log10(Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length))

describe('the town synthesis', () => {
  it('makes every file of the cue table, mono at 22,050 Hz', () => {
    expect([...pure.keys()]).toEqual([...TOWN_SYNTH_FILES])
    expect(new Set(TOWN_SYNTH_CUES.map(([k]) => k)).size).toBe(TOWN_SYNTH_CUES.length)
    for (const [id, p] of pure) {
      expect(p.sampleRate, id).toBe(TOWN_SYNTH_RATE)
      expect(p.channels, id).toHaveLength(1)
    }
    for (const id of TOWN_SYNTH_LOOPS) expect(TOWN_SYNTH_FILES).toContain(id)
  })

  it('is deterministic in its seed', () => {
    const again = townSynthWavs(() => null)
    const bytes = townSynthWavs(() => null, TOWN_SYNTH_SEED)
    for (const id of TOWN_SYNTH_FILES) expect(Buffer.from(again.get(id)!).equals(Buffer.from(bytes.get(id)!)), id).toBe(true)
    const other = synthTownSounds(() => null, TOWN_SYNTH_SEED + 1)
    expect(Buffer.from(other.get('town/bed_busy')!.channels[0]!.buffer).equals(Buffer.from(pure.get('town/bed_busy')!.channels[0]!.buffer))).toBe(false)
  })

  it('the loops have their lengths, levels, and a seamless wrap', () => {
    const len = (id: string) => pure.get(id)!.channels[0]!.length / TOWN_SYNTH_RATE
    expect(len('town/bed_calm')).toBeCloseTo(BED_LOOP_S, 3)
    expect(len('town/bed_busy')).toBeCloseTo(BED_LOOP_S, 3)
    expect(len('town/fountain')).toBeCloseTo(FOUNTAIN_LOOP_S, 3)
    for (const id of TOWN_SYNTH_LOOPS) {
      const x = float(pure.get(id)!)
      const steps = x.slice(1).map((v, i) => Math.abs(v - x[i]!)).sort((a, b) => a - b)
      const p99 = steps[Math.floor(steps.length * 0.99)]!
      expect(Math.abs(x[0]! - x.at(-1)!), id).toBeLessThan(p99)
      // the quietest 100 ms is never silence (the export's trailing-silence trim cannot shorten a loop)
      const tail = x.slice(-Math.round(TOWN_SYNTH_RATE * 0.02))
      expect(peak(tail) * 32768, id).toBeGreaterThan(32)
    }
    expect(rmsDb(float(pure.get('town/bed_busy')!))).toBeCloseTo(-23, 0)
    expect(rmsDb(float(pure.get('town/bed_calm')!))).toBeCloseTo(-27, 0)
    expect(rmsDb(float(pure.get('town/fountain')!))).toBeCloseTo(-22, 0)
  })

  it('one-shots are short, start and end quietly, and never clip', () => {
    for (const [id, p] of pure) {
      const x = float(p)
      expect(peak(x), id).toBeLessThan(1)
      if (TOWN_SYNTH_LOOPS.includes(id)) continue
      expect(x.length / TOWN_SYNTH_RATE, id).toBeLessThan(2)
      expect(Math.abs(x.at(-1)!), id).toBeLessThan(0.01)
    }
    const murmurs = TOWN_SYNTH_FILES.filter(f => f.startsWith('town/murmur_')).map(f => pure.get(f)!.channels[0]!.length / TOWN_SYNTH_RATE)
    for (const s of murmurs) expect(s).toBeGreaterThan(0.6)
    for (const s of murmurs) expect(s).toBeLessThan(1.5)
  })

  it.skipIf(!haveRetail)('with the retail client: grains of the emote voices, the wolf pitched up 1.3× as the dog', () => {
    const real = synthTownSounds(readRetail)
    expect(Buffer.from(real.get('town/bed_busy')!.channels[0]!.buffer).equals(Buffer.from(pure.get('town/bed_busy')!.channels[0]!.buffer))).toBe(false)
    const wolf = readRetail('cos/cos_wolf_01_stand1')!
    const dog = real.get('town/dog_1')!
    expect(dog.channels[0]!.length).toBe(Math.floor((wolf.channels[0]!.length * TOWN_SYNTH_RATE) / wolf.sampleRate / DOG_PITCH))
    // and again the same bytes
    const again = synthTownSounds(readRetail)
    for (const id of TOWN_SYNTH_FILES) expect(Buffer.from(again.get(id)!.channels[0]!.buffer).equals(Buffer.from(real.get(id)!.channels[0]!.buffer)), id).toBe(true)
  })

  it('adds its cues to the export plan: loops as ambience, a cue without files left out', () => {
    const plan = { files: new Set<string>(), ambient: new Set<string>(), index: { cues: {} as Record<string, SoundCue> } }
    const written = TOWN_SYNTH_FILES.filter(f => !f.startsWith('town/wings_') && f !== 'town/murmur_2')
    const added = addTownSynthSounds(plan, written)
    expect(added).not.toContain('town.wings')
    expect(plan.index.cues['town.murmur']!.files).toEqual(['town/murmur_1', 'town/murmur_3', 'town/murmur_4'])
    expect([...plan.ambient].sort()).toEqual([...TOWN_SYNTH_LOOPS].sort())
    expect(plan.files.size).toBe(written.length)
    expect(plan.index.cues['town.bed.busy']).toEqual({ files: ['town/bed_busy'], gain: 1, category: 'ambient' })
  })
})

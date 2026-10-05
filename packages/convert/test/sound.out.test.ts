/**
 * Checks a finished sound export (work/out/sound, from `pnpm tsx packages/convert/src/tools/export-sound.ts`) against
 * docs/SOUND.md §6 lane 1. Skips when work/out/sound/index.json is missing.
 *
 * The corpus census (every BSR of Data.pk2, parse only) skips without sro.config.json. The spec expected about a
 * minute for the 5,563 parses; measured well under 10 s, so it is not gated further (generous timeout kept).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBsr } from '@sro/formats'
import { validateModelSounds, validateSoundIndex, type ModelSounds, type SoundIndex } from '../../shared/src/sound.ts'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { normalizeSoundPath } from '../src/sound/resolve.ts'

const OUT = join(REPO_ROOT, 'work', 'out')
const INDEX = join(OUT, 'sound', 'index.json')
const HAS = existsSync(INDEX)
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T

describe.skipIf(!HAS)('work/out/sound', () => {
  const idx = HAS ? readJson<SoundIndex>(INDEX) : (null as unknown as SoundIndex)
  const models = new Map<string, ModelSounds>()
  if (HAS) {
    for (const [code, url] of Object.entries(idx.models)) models.set(code, readJson<ModelSounds>(join(OUT, ...url.split('/'))))
  }

  it('validates, and every file exists on disk with its recorded size', () => {
    expect(validateSoundIndex(idx)).toEqual([])
    for (const [id, f] of Object.entries(idx.files)) {
      const p = join(OUT, ...f.url.split('/'))
      expect(existsSync(p), f.url).toBe(true)
      expect(statSync(p).size, f.url).toBe(f.bytes)
      if (f.wav) expect(existsSync(join(OUT, ...f.wav.split('/'))), f.wav).toBe(true)
      // An Opus export made without ffmpeg writes the uncached files as PCM .wav (docs/SOUND.md §10.4).
      expect(idx.codec === 'opus' ? /\.(ogg|wav)$/.test(f.url) : f.url.endsWith('.wav'), id).toBe(true)
    }
  })

  it('every file id referenced by cues, steps, hits, skills, voices, mobs, areas and model tracks exists', () => {
    const ids = new Set<string>()
    const add = (xs: Iterable<string | null | undefined>) => {
      for (const x of xs) if (x) ids.add(x)
    }
    for (const c of Object.values(idx.cues)) add(c.files)
    for (const m of [idx.steps.walk, idx.steps.run]) for (const l of Object.values(m)) add(l ?? [])
    for (const h of Object.values(idx.hits)) add([...Object.values(h.weak), ...Object.values(h.strong)])
    for (const s of Object.values(idx.skills)) {
      for (const l of Object.values(s.swing ?? {})) add(l)
      if (Array.isArray(s.dmg)) add(s.dmg)
      else if (s.dmg) add([...Object.values(s.dmg.weak), ...Object.values(s.dmg.strong)])
      for (const st of s.stages ?? []) add([st.begin, st.end])
    }
    for (const v of [...Object.values(idx.voices), ...Object.values(idx.mobs)]) {
      add([...v.moan.normal, ...v.moan.crit, ...v.deathVoice, ...v.deathThud, ...v.shout1, ...v.shout2, ...v.avoid, ...(v.sitDown ?? []), ...(v.standUp ?? [])])
    }
    for (const m of Object.values(idx.mobs)) {
      add([...m.walk, ...(m.idle ?? [])])
      for (const a of Object.values(m.attacks)) add([...(a.swing ?? []), ...(a.shout ?? []), ...(a.dmg ?? [])])
    }
    for (const a of Object.values(idx.areas)) add([...a.day, ...a.night].map(l => l.file))
    for (const m of models.values()) {
      expect(validateModelSounds(m, idx.files), m.code).toEqual([])
      for (const list of Object.values(m.clips)) add(list.map(t => t.file))
    }
    const missing = [...ids].filter(id => !(id in idx.files))
    expect(missing).toEqual([])
    expect(ids.size).toBeGreaterThan(300)
  })

  it('covers every player (voice set + model), every Jangan mob, and both Jangan areas with a loop', () => {
    const chars = readJson<Array<{ code: string }>>(join(OUT, 'data', 'characters.json'))
    expect(chars.length).toBe(26)
    for (const c of chars) {
      expect(idx.voices[c.code], c.code).toBeDefined()
      expect(idx.voices[c.code]!.deathVoice.length, c.code).toBeGreaterThan(0)
      expect(idx.models[c.code], c.code).toBe(`sound/model/${c.code}.json`)
    }
    const mobs = readJson<{ entries: Array<{ code: string }> }>(join(OUT, 'data', 'mobs.json')).entries
    for (const m of mobs) {
      expect(idx.mobs[m.code], m.code).toBeDefined()
      const s = idx.mobs[m.code]!
      expect(s.moan.normal.length + s.deathVoice.length + s.walk.length, `${m.code} has no effectsound rows`).toBeGreaterThan(0)
    }
    for (const id of ['JANGAN_TOWN', 'JANGAN_FIELD']) {
      const a = idx.areas[id]
      expect(a, id).toBeDefined()
      expect(a!.day.some(l => l.loop), id).toBe(true)
    }
    expect(idx.areas.JANGAN_TOWN!.kind).toBe('town')
    expect(idx.areas.JANGAN_FIELD!.kind).toBe('field')
  })

  it('ships the 22 footstep files and the documented clip tracks', () => {
    const mv = Object.keys(idx.files).filter(id => /^player\/mv(walk|run)/.test(id))
    expect(mv).toHaveLength(22)
    const mang = models.get('MOB_CH_MANGNYANG')!
    expect(mang.clips.ATTACK1!.some(t => t.handle === 'swing' && t.ms === 607 && t.file === 'player/battswordswing1')).toBe(true)
    expect(mang.clips.DIE1!.map(t => `${t.ms}:${t.handle}:${t.file}`)).toEqual(['0:death_voice:monster/cm_mang_die', '1503:death_thud:monster/cm_beye_thud'])
    const adv = models.get('CHAR_CH_MAN_ADVENTURER')!
    expect(adv.clips.RUN!.filter(t => t.handle === 'step_run').map(t => t.ms)).toEqual([289, 619])
    expect(adv.clips.WALK!.filter(t => t.handle === 'step_walk').map(t => t.ms)).toEqual([347, 899])
  })

  it('has the hit sets, cues and stage sounds the runtime asks for', () => {
    expect(Object.keys(idx.hits.PUNCH!.strong).length).toBeGreaterThan(0)
    for (const w of ['SWORD', 'BLADE', 'SPEAR', 'BOW']) expect(Object.keys(idx.hits[w]!.strong).sort(), w).toEqual(['a', 'b', 'n'])
    for (const k of ['ui.click', 'ui.click2', 'ui.windowOpen', 'ui.windowClose', 'ui.error', 'ui.warning', 'ui.levelUp', 'ui.potion', 'ui.revive',
      'ui.questOpen', 'ui.questDone', 'item.pickup', 'item.dropGold', 'item.equip.SWORD', 'hit.crit', 'block.normal', 'block.crit']) {
      expect(idx.cues[k], k).toBeDefined()
    }
    expect(idx.cues['ui.levelUp']!.files).toEqual(['ui/itlevelup'])
    expect(idx.skills.SKILL_CH_SWORD_SMASH_A!.dmg).toEqual(['skill/csk_sword_hit_c'])
    expect(idx.skills.SKILL_CH_SWORD_SMASH_A!.swing!.snd_swing_s1).toEqual(['skill/csk_sword_swing_b'])
    expect(idx.skills.SKILL_CH_COLD_GANGGI_A!.stages!.map(s => `${s.phase}:${s.begin}`)).toEqual(['READY:skill/csk_cold_ready', 'ACT_S:skill/csk_cold_binghon'])
    expect(idx.skills.SKILL_CH_WATER_HEAL_A!.stages!.map(s => s.phase)).toEqual(['READY', 'ACT_S'])
    expect(Array.isArray(idx.skills.SKILL_CH_SWORD_BASE!.dmg)).toBe(false)
    expect(idx.steps.walk.Stone).toEqual(['player/mvwalkhground'])
    expect(idx.steps.run.Grass).toEqual(['player/mvrungrass'])
  })

  it('is about the documented size (about 590-600 files, ~29 MB PCM -> ~4 MB Opus, ~21 unresolved BSR paths)', () => {
    const n = Object.keys(idx.files).length
    expect(n).toBeGreaterThan(450)
    expect(n).toBeLessThan(800)
    if (idx.codec === 'opus') expect(idx.report.outBytes).toBeLessThan(8e6)
    expect(idx.report.unresolved.length).toBeLessThan(60)
    expect(idx.report.notExported).toEqual([])
    const models = readdirSync(join(OUT, 'sound', 'model'))
    expect(models.length).toBe(Object.keys(idx.models).length)
  })
})

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

describe.skipIf(!hasConfig)('sound corpus census (all BSRs, parse only)', () => {
  it('matches docs/SOUND.md §2.1: 398 BSRs with sound, 30,866 tracks, 1,230 files, 87 missing at the stored path', () => {
    const data = openArchive('Data')
    const exists = new Set<string>()
    for (const f of data.list('prim/snd', true)) exists.add(normalizeSoundPath(f.path))
    let withSound = 0
    let tracks = 0
    const files = new Set<string>()
    for (const [path, file] of data.files) {
      if (!path.endsWith('.bsr')) continue
      let any = false
      const res = parseBsr(data.read(file))
      for (const s of [...res.modPalette.systemSets, ...res.modPalette.aniSets]) {
        for (const m of s.mods) {
          if (m.kind !== 'sound') continue
          for (const inner of m.sets) {
            for (const t of inner.tracks) {
              if (!t || !t.path.trim()) continue
              any = true
              tracks++
              files.add(normalizeSoundPath(t.path))
            }
          }
        }
      }
      if (any) withSound++
    }
    expect(withSound).toBe(398)
    expect(tracks).toBe(30866)
    expect(files.size).toBe(1230)
    expect([...files].filter(f => !exists.has(f)).length).toBe(87)
  }, 600_000)
})

/**
 * Exports the retail sound effects and their wiring for the browser game (docs/SOUND.md §4).
 *   pnpm tsx packages/convert/src/tools/export-sound.ts [--scope jangan|all] [--codec opus|wav] [--also-wav] [--force]
 *     [--ffmpeg <path>] [--jobs <n>] [--out <dir>] [--mirror <dir> | --no-mirror]
 *
 * Inputs: Data.pk2 prim/snd/** (work/extracted/Data first), effectsound.txt (textdata, else resinfo), effectenvsnd.txt,
 * skilleffect.txt (Media.pk2 textdata), regioninfo.txt (Data.pk2 root), and the data export (work/out/data:
 * characters, mobs, npcs, skills) with each model's BSR and sidecar. Every scope also takes the 12 weather files and
 * their cues (WEATHER_SOUND_FILES, WEATHER_CUES in shared/src/sound.ts; docs/SOUND.md §8), and the coast's 4 files and
 * its COAST area (sound/coast.ts; docs/COAST.md §10.1), and wave 11's unique-notice and town cues (UNIQUE_CUES, TOWN_CUES
 * in sound/build.ts; docs/WAVE_PLAN7.md D12), and the town's synthesized sounds (sound/town-synth.ts, TL-S).
 * Output (served at /out/sound/):
 *   <out>/sound/index.json                SoundIndex (packages/shared/src/sound.ts)
 *   <out>/sound/model/<CodeName128>.json  ModelSounds, per player/mob/NPC code with at least one clip track
 *   <out>/sound/<folder>/<name>.ogg       Ogg Opus mono 48 kbps (env/* 64 kbps); .wav with --codec wav / --also-wav
 *   <out>/sound/.cache.json               encoder cache (dot-file: never served or deployed)
 * The tree is built in a staging folder and swapped in whole. It is then mirrored to <workDir>/out-opt/sound when
 * out-opt exists (docs/ASSETS.md: out-opt copies everything but glb/world PNGs unchanged; the game reads /out-opt/
 * first), so no optimize-out re-run is needed for sound.
 * Retail data never leaves work/.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { decodeTextdata, parseBsr, type Pk2Archive, type Pk2File } from '@sro/formats'
import { addWeatherSounds, validateModelSounds, validateSoundIndex, type SoundCodec, type SoundFile } from '../../../shared/src/sound.ts'
import { loadConfig, openArchive } from '../node-io.ts'
import { addUniqueAndTownSounds, finishModel, finishSoundIndex, planSoundIndex, type ModelInput, type SoundScope } from '../sound/build.ts'
import { addCoastSounds } from '../sound/coast.ts'
import { mergeEffectSound, parseEffectSound } from '../sound/effectsound.ts'
import { detectFfmpeg, encodeOpus, hasLibopus, pool, readCache, type CacheEntry, type SoundCache } from '../sound/encode.ts'
import { parseEffectEnvSnd } from '../sound/envsnd.ts'
import { downmix, parseWav, pcmMs, trimTrailingSilence, writeWav16 } from '../sound/pcm.ts'
import { parseRegionInfo } from '../sound/regioninfo.ts'
import { SoundResolver, normalizeSoundPath } from '../sound/resolve.ts'
import { addTownSynthSounds, townSynthWavs } from '../sound/town-synth.ts'
import type { SidecarClip } from '../sound/tracks.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const OPUS_KBPS = 48
const AMBIENT_KBPS = 64

async function main(): Promise<void> {
  const t0 = performance.now()
  const cfg = loadConfig()
  const scope = (flag('--scope') ?? 'jangan') as SoundScope
  if (scope !== 'jangan' && scope !== 'all') throw new Error(`--scope must be jangan or all, not ${scope}`)
  const force = args.includes('--force')
  const alsoWav = args.includes('--also-wav')
  const jobs = Math.max(1, Math.min(8, Number(flag('--jobs') ?? 4) || 4))
  const outDir = resolve(flag('--out') ?? join(cfg.workDir, 'out'))
  const mirrorDir = args.includes('--no-mirror') ? null : resolve(flag('--mirror') ?? join(cfg.workDir, 'out-opt'))
  const soundDir = join(outDir, 'sound')
  const extracted = join(cfg.workDir, 'extracted')

  let codec: SoundCodec = (flag('--codec') ?? 'opus') as SoundCodec
  if (codec !== 'opus' && codec !== 'wav') throw new Error(`--codec must be opus or wav, not ${codec}`)
  let ffmpeg: string | null = null
  if (codec === 'opus') {
    ffmpeg = detectFfmpeg(flag('--ffmpeg'))
    if (!ffmpeg || !hasLibopus(ffmpeg)) {
      console.warn(`! ffmpeg with libopus not found (${flag('--ffmpeg') ?? process.env.SRO_FFMPEG ?? 'ffmpeg'}); writing trimmed PCM .wav instead`)
      codec = 'wav'
      ffmpeg = null
    }
  }

  // ---- archives and sources ----
  let data: Pk2Archive | null = null
  let media: Pk2Archive | null = null
  try {
    data = openArchive('Data', cfg)
  } catch (e) {
    console.warn(`! Data.pk2 unavailable (${(e as Error).message}); using work/extracted/Data only`)
  }
  try {
    media = openArchive('Media', cfg)
  } catch (e) {
    console.warn(`! Media.pk2 unavailable (${(e as Error).message}); using work/extracted/Media only`)
  }
  const readFrom = (archive: Pk2Archive | null, folder: string, path: string): Uint8Array | null => {
    const p = join(extracted, folder, ...path.split('/'))
    if (existsSync(p)) return readFileSync(p)
    if (archive?.has(path)) return archive.read(path)
    return null
  }
  const text = (archive: Pk2Archive | null, folder: string, path: string): string | null => {
    const b = readFrom(archive, folder, path)
    return b ? decodeTextdata(b).text : null
  }
  const textdata = (name: string) => text(media, 'Media', `server_dep/silkroad/textdata/${name}`)
  const resinfo = (name: string) => text(media, 'Media', `resinfo/${name}`)

  // Every sound file: id -> where to read it.
  const sources = new Map<string, { pk2?: Pk2File; path?: string }>()
  if (data) {
    for (const f of data.list('prim/snd', true)) {
      const rel = normalizeSoundPath(f.path)
      if (rel.endsWith('.wav')) sources.set(rel.slice(0, -4), { pk2: f })
    }
  }
  const sndRoot = join(extracted, 'Data', 'prim', 'snd')
  if (existsSync(sndRoot)) {
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.wav$/i.test(e.name)) {
          const id = normalizeSoundPath(relative(sndRoot, p)).slice(0, -4)
          if (!data || sources.has(id)) sources.set(id, { ...sources.get(id), path: p })
        }
      }
    }
    walk(sndRoot)
  }
  if (!sources.size) throw new Error('no prim/snd files found (Data.pk2 or work/extracted/Data/prim/snd)')
  const resolver = new SoundResolver([...sources.keys()].map(id => `${id}.wav`))

  const esText = textdata('effectsound.txt')
  const esResinfo = resinfo('effectsound.txt')
  if (!esText && !esResinfo) throw new Error('effectsound.txt not found')
  const rows = mergeEffectSound(esText ? parseEffectSound(esText, 'textdata') : [], esResinfo ? parseEffectSound(esResinfo, 'resinfo') : [])
  const envText = textdata('effectenvsnd.txt') ?? resinfo('effectenvsnd.txt') ?? ''
  const regionText = text(data, 'Data', 'regioninfo.txt') ?? textdata('regioninfo.txt') ?? ''
  const skillEffectText = textdata('skilleffect.txt') ?? ''

  // ---- the data export ----
  const dataDir = join(cfg.workDir, 'out', 'data')
  const json = <T>(name: string): T => {
    const p = join(dataDir, name)
    if (!existsSync(p)) throw new Error(`${p} missing: run export-data first`)
    return JSON.parse(readFileSync(p, 'utf8')) as T
  }
  type Model = { bsr?: string; sidecar?: string }
  const characters = json<Array<{ code: string; bsr?: string; sidecar?: string }>>('characters.json')
  const mobs = json<{ entries: Array<{ code: string; model?: Model; skills?: string[] }> }>('mobs.json').entries
  const npcs = json<{ entries: Array<{ code: string; model?: Model }> }>('npcs.json').entries
  const skills = json<{ entries: Array<{ code: string; group?: string | null }> }>('skills.json').entries
  const uiIndex = join(cfg.workDir, 'out', 'ui', 'index.json')
  const musicKeys = existsSync(uiIndex) ? Object.keys((JSON.parse(readFileSync(uiIndex, 'utf8')) as { music?: Record<string, string> }).music ?? {}) : []

  const bsrCache = new Map<string, ReturnType<typeof parseBsr> | null>()
  const loadBsr = (path: string) => {
    const key = path.toLowerCase()
    if (!bsrCache.has(key)) {
      const b = readFrom(data, 'Data', path.replace(/\\/g, '/'))
      let res: ReturnType<typeof parseBsr> | null = null
      try {
        res = b ? parseBsr(b) : null
      } catch (e) {
        console.warn(`! ${path}: ${(e as Error).message}`)
      }
      bsrCache.set(key, res)
    }
    return bsrCache.get(key)!
  }
  const loadClips = (sidecar: string | undefined): SidecarClip[] => {
    if (!sidecar) return []
    const p = join(cfg.workDir, 'out', ...sidecar.replace(/^\/?out\//, '').split('/'))
    if (!existsSync(p)) return []
    const side = JSON.parse(readFileSync(p, 'utf8')) as { animations?: SidecarClip[] }
    return (side.animations ?? []).map(a => ({ name: a.name, group: a.group, type: a.type, banName: a.banName ?? '' }))
  }
  const models: ModelInput[] = []
  const addModel = (code: string, kind: ModelInput['kind'], m: Model | undefined) => {
    if (!m?.bsr) return
    models.push({ code, kind, bsr: m.bsr, res: loadBsr(m.bsr), clips: loadClips(m.sidecar) })
  }
  for (const c of characters) addModel(c.code, 'player', { bsr: c.bsr, sidecar: c.sidecar })
  for (const m of mobs) addModel(m.code, 'mob', m.model)
  for (const n of npcs) addModel(n.code, 'npc', n.model)

  const envAreas = parseEffectEnvSnd(envText)
  const plan = planSoundIndex({
    scope,
    rows,
    envAreas,
    regionAreas: parseRegionInfo(regionText),
    skillEffectText,
    resolver,
    models,
    players: characters.map(c => c.code),
    mobs: mobs.map(m => ({ code: m.code, skills: m.skills ?? [] })),
    skillGroups: [...new Set(skills.map(s => s.group).filter((g): g is string => !!g && g.startsWith('SKILL_CH_')))],
    musicKeys,
  })
  addWeatherSounds(plan)
  // Wave 10 (docs/COAST.md §10.1, lane CST-A): the surf, gull and storm-surf files and the COAST area.
  addCoastSounds(plan, envAreas, resolver)
  // Wave 11 (docs/WAVE_PLAN7.md D12, W11-CV): the unique notices' two cues and the town's bell and animal cues.
  addUniqueAndTownSounds(plan, resolver)
  // Wave 11 (docs/TOWN_LIFE.md §6, lane TL-S): the town's seeded synthesis (beds, fountain, murmurs, hammer, chickens,
  // the dog), made from retail sources into a temp folder and encoded like any other file.
  const synthDir = join(tmpdir(), `sro-town-synth-${process.pid}`)
  mkdirSync(join(synthDir, 'town'), { recursive: true })
  const synth = townSynthWavs(id => {
    const src = sources.get(id)
    return src ? (src.path ? readFileSync(src.path) : data!.read(src.pk2!)) : null
  })
  for (const [id, bytes] of synth) {
    const p = join(synthDir, ...`${id}.wav`.split('/'))
    writeFileSync(p, bytes)
    sources.set(id, { path: p })
  }
  addTownSynthSounds(plan, synth.keys())

  // ---- encode into a staging folder ----
  const staging = join(outDir, `.sound-staging-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const cachePath = join(soundDir, '.cache.json')
  const oldCache: SoundCache = force ? {} : readCache(cachePath)
  const cache: SoundCache = {}
  const files: Record<string, SoundFile> = {}
  const notExported: string[] = []
  const tmp = join(tmpdir(), `sro-sound-${process.pid}`)
  mkdirSync(tmp, { recursive: true })
  let sourceBytes = 0
  const ids = [...plan.files].sort()
  const ext = codec === 'opus' ? '.ogg' : '.wav'
  const urlPath = (id: string) => id.replace(/[^a-z0-9_\-/.]/g, '_')
  let encoded = 0
  let reused = 0
  await pool(ids, jobs, async id => {
    const src = sources.get(id)
    try {
      if (!src) throw new Error('no source file')
      const bytes = src.path ? readFileSync(src.path) : data!.read(src.pk2!)
      sourceBytes += bytes.byteLength
      const sha1 = createHash('sha1').update(bytes).digest('hex')
      const ambient = plan.ambient.has(id) || id.startsWith('env/')
      const bitrate = codec === 'opus' ? (ambient ? AMBIENT_KBPS : OPUS_KBPS) : 0
      const out = `${urlPath(id)}${ext}`
      const dst = join(staging, ...out.split('/'))
      mkdirSync(dirname(dst), { recursive: true })
      const srcKey = `prim/snd/${id}.wav`
      const prev = oldCache[srcKey]
      const prevOut = prev && join(soundDir, ...prev.out.split('/'))
      const wavOut = alsoWav && codec === 'opus' ? `${urlPath(id)}.wav` : null
      const prevWav = wavOut && join(soundDir, ...wavOut.split('/'))
      let entry: CacheEntry
      if (prev && prev.sha1 === sha1 && prev.bitrate === bitrate && prev.codec === codec && prev.out === out && existsSync(prevOut!) && (!prevWav || existsSync(prevWav))) {
        copyFileSync(prevOut!, dst)
        if (prevWav) copyFileSync(prevWav, join(staging, ...wavOut!.split('/')))
        entry = prev
        reused++
      } else {
        const wav = parseWav(bytes)
        let pcm = trimTrailingSilence(wav)
        if (!(ambient && pcm.channels.length === 2)) pcm = downmix(pcm)
        const channels = pcm.channels.length === 2 ? 2 : 1
        const pcmBytes = writeWav16(pcm)
        if (codec === 'opus') {
          const tmpWav = join(tmp, `${createHash('sha1').update(id).digest('hex')}.wav`)
          writeFileSync(tmpWav, pcmBytes)
          try {
            await encodeOpus(ffmpeg!, tmpWav, dst, bitrate, channels)
          } finally {
            rmSync(tmpWav, { force: true })
          }
          if (wavOut) writeFileSync(join(staging, ...wavOut.split('/')), pcmBytes)
        } else {
          writeFileSync(dst, pcmBytes)
        }
        entry = { size: bytes.byteLength, mtimeMs: src.pk2?.modified ?? (src.path ? statSync(src.path).mtimeMs : 0), sha1, bitrate, codec, out, ms: pcmMs(pcm), channels }
        encoded++
      }
      cache[srcKey] = entry
      const f: SoundFile = { url: `sound/${out}`, ms: entry.ms, channels: entry.channels, bytes: statSync(dst).size }
      if (wavOut) f.wav = `sound/${wavOut}`
      files[id] = f
    } catch (e) {
      notExported.push(`${id}: ${(e as Error).message}`)
    }
  })
  rmSync(tmp, { recursive: true, force: true })
  rmSync(synthDir, { recursive: true, force: true })
  notExported.sort()

  const index = finishSoundIndex(plan, files, resolver, {
    codec,
    wavFallback: alsoWav && codec === 'opus',
    generatedAt: new Date().toISOString(),
    sourceFiles: ids.length,
    sourceBytes,
    outBytes: Object.values(files).reduce((n, f) => n + f.bytes, 0),
    notExported,
  })
  const problems = validateSoundIndex(index)
  mkdirSync(join(staging, 'model'), { recursive: true })
  for (const m of plan.models) {
    const fm = finishModel(m, files)
    problems.push(...validateModelSounds(fm, files).map(p => `model/${m.code}.json ${p}`))
    writeFileSync(join(staging, 'model', `${m.code}.json`), JSON.stringify(fm))
  }
  if (problems.length) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`the index does not validate:\n  ${problems.slice(0, 30).join('\n  ')}`)
  }
  writeFileSync(join(staging, 'index.json'), JSON.stringify(index))
  writeFileSync(join(staging, '.cache.json'), JSON.stringify(cache, null, 1))
  swapIn(staging, soundDir)

  let mirrored = ''
  if (mirrorDir && existsSync(mirrorDir) && resolve(mirrorDir) !== resolve(outDir)) {
    const mStaging = join(mirrorDir, `.sound-staging-${process.pid}`)
    rmSync(mStaging, { recursive: true, force: true })
    copyTree(soundDir, mStaging, name => name !== '.cache.json')
    swapIn(mStaging, join(mirrorDir, 'sound'))
    mirrored = ` (mirrored to ${join(mirrorDir, 'sound')})`
  }

  const mb = (n: number) => `${(n / 1e6).toFixed(2)} MB`
  const unresolved = index.report.unresolved
  const bsrUnresolved = unresolved.filter(u => u.from.some(f => !f.startsWith('effectsound') && !f.startsWith('effectenvsnd') && !f.startsWith('skilleffect')))
  console.log(`sound (${scope}, ${codec}): ${Object.keys(files).length} files, ${mb(sourceBytes)} PCM -> ${mb(index.report.outBytes)} (${encoded} encoded, ${reused} reused)`)
  console.log(`  ${plan.models.length} models with ${index.report.tracks} clip tracks; ${Object.keys(index.cues).length} cues, ${Object.keys(index.hits).length} hit sets, ${Object.keys(index.skills).length} skills, ${Object.keys(index.voices).length} voice sets, ${Object.keys(index.mobs).length} mobs, ${Object.keys(index.areas).length} areas`)
  console.log(`  unresolved paths: ${unresolved.length} (${bsrUnresolved.length} from BSR tracks, ${unresolved.length - bsrUnresolved.length} from tables); fixed by basename: ${resolver.fixed.size}`)
  for (const u of unresolved) console.log(`    ${u.path}  <- ${u.from.slice(0, 4).join(', ')}${u.from.length > 4 ? ` (+${u.from.length - 4})` : ''}`)
  for (const n of notExported) console.warn(`  ! not exported: ${n}`)
  console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s -> ${soundDir}${mirrored}`)
}

/** Replaces `dst` with `staging` (rename old away, rename new in, delete old); retried for Windows file locks. */
function swapIn(staging: string, dst: string): void {
  const old = `${dirname(dst)}/.sound-old-${process.pid}`
  const retry = (f: () => void) => {
    for (let i = 0; ; i++) {
      try {
        return f()
      } catch (e) {
        if (i >= 20) throw e
        const until = Date.now() + 250
        while (Date.now() < until) { /* brief wait for a reader to let go */ }
      }
    }
  }
  if (existsSync(dst)) retry(() => renameSync(dst, old))
  retry(() => renameSync(staging, dst))
  rmSync(old, { recursive: true, force: true })
}

function copyTree(src: string, dst: string, keep: (name: string) => boolean): void {
  mkdirSync(dst, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (!keep(e.name)) continue
    const s = join(src, e.name)
    const d = join(dst, e.name)
    if (e.isDirectory()) copyTree(s, d, keep)
    else copyFileSync(s, d)
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})

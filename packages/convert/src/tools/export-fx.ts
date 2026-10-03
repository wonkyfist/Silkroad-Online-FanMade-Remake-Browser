/**
 * Effect export: every .efp in Particles.pk2 -> an "sro-fx-program" JSON, its textures (DDJ -> PNG) and meshes
 * (BMS -> glb), plus the fx index v2 (skills, mob skills, system effects, lights, characterInfo) and the textures
 * the game draws without a program (weapon trails, target circles).
 *
 *   pnpm tsx packages/convert/src/tools/export-fx.ts [--out <dir>] [--skills-only]
 *
 * Writes <out> (default work/out/fx/, served by the viewer and the game at /out/fx/):
 *   efp/<particles path>.json   one program per effect (format: packages/fx/src/program.ts)
 *   tex/<particles path>.png    effect textures, decoded from DDJ; also the weapon-trail textures the skills use
 *                               (tex/textures/mirage_texture_*.png, docs/EFFECTS.md §5.1)
 *   tex/ui/select_0N.png        target circles (Media.pk2 effect/select_01..04.ddj, docs/EFFECTS.md §5.4, D3)
 *   mesh/<particles path>.glb   effect meshes (validated with the Khronos glTF-Validator)
 *   skills.json                 fx index v2 (`sro-fx-skills` version 2, packages/convert/src/fx/skills.ts): the
 *                               Chinese masteries, the fist, the MSKILL groups of work/out/data/mobs.json, the
 *                               SYSTEM_* effects, lights, and characterInfo of CHAR_CH_* + mobs.json + npcs.json
 *   index.json                  every exported effect: key, url, node count, duration, skills, warnings;
 *                               plus the files that failed to parse
 * --skills-only exports just the effects skills.json references (skills, blood types).
 *
 * Run the data export first (work/out/data/mobs.json, npcs.json) and `pnpm sro convert --preset fx` (the arrows,
 * hawk and death models the index points at: objectModel / dieModel / ride are null until their glb exists).
 * Every file is written atomically (temp file + rename), so a running game never reads half a file.
 *
 * All of it is retail data and stays under work/ (gitignored). Programs reference textures and meshes by
 * out-root-relative URL (fx/tex/..., fx/mesh/...); game data should reference effects by key (Particles path).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import {
  buildStringMap,
  decodeDds,
  decodeTextdata,
  loadTextdataTable,
  parseBms,
  parseDdj,
  parseEfp,
  skillDataRow,
  skillDetail,
} from '@sro/formats'
import { convertedPaths } from '../data/game-data.ts'
import { compileEfp, fxEffectUrl, fxKey, fxMeshUrl, fxTextureUrl } from '../fx/compile.ts'
import { effectMeshDocument } from '../fx/mesh.ts'
import { parseSkillEffect } from '../fx/skilleffect.ts'
import { buildSkillIndexV2, type ModelFiles, type SkillRowLite } from '../fx/skills.ts'
import { summarizeIssues, validateGlb } from '../gltf/validate.ts'
import { textdataReader, TEXTDATA_DIR } from '../data/textdata-source.ts'
import { loadConfig, openArchive } from '../node-io.ts'
import { encodePng } from '../png.ts'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const cfg = loadConfig()
const outRoot = join(cfg.workDir, 'out')
const outDir = outIndex >= 0 && args[outIndex + 1] ? resolve(args[outIndex + 1]!) : join(outRoot, 'fx')
const skillsOnly = args.includes('--skills-only')
const t0 = performance.now()

/** Target-circle textures (Media.pk2), written to tex/ui/<name>.png. */
const SELECT_TEXTURES = ['effect/select_01.ddj', 'effect/select_02.ddj', 'effect/select_03.ddj', 'effect/select_04.ddj']

const particles = openArchive('Particles', cfg)
const media = openArchive('Media', cfg)
/** Writes through a temp file and a rename (retried: Windows refuses a rename over a file being read). */
const write = (rel: string, data: string | Uint8Array) => {
  const file = join(outDir, ...rel.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, data)
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file)
      return
    } catch (e) {
      if (i >= 20) {
        rmSync(tmp, { force: true })
        throw e
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}
/** URLs are relative to the out root; files land under outDir = <out root>/fx. */
const fromUrl = (url: string) => url.replace(/^fx\//, '')
const exists = (path: string) => !!particles.get(fxKey(path))

// Skills first: they decide what --skills-only exports.
const read = textdataReader(media)
const skillRows: SkillRowLite[] = loadTextdataTable('skilldata.txt', read).rows.map(r => {
  const row = skillDataRow(r)
  const d = skillDetail(row)
  return { group: row.group, code: row.code, level: row.level, mastery: d.masteries[0], masteryLevel: d.masteryLevels[0], nameKey: d.nameStrId ?? null }
})
const strings = buildStringMap(['textuisystem.txt', 'textdataname.txt'].flatMap(t => loadTextdataTable(t, read).rows), 'english')
const skillEffectFile = media.get(`${TEXTDATA_DIR}/skilleffect.txt`)
if (!skillEffectFile) throw new Error('skilleffect.txt not found in Media.pk2')
const resinfoFile = media.get('resinfo/skilleffect.txt')
if (!resinfoFile) console.warn('resinfo/skilleffect.txt not found in Media.pk2: no lights')
const seFile = parseSkillEffect(
  decodeTextdata(media.read(skillEffectFile)).text,
  resinfoFile ? decodeTextdata(media.read(resinfoFile)).text : null,
)

/** Codes from the data export (work/out/data): mob skills and characterInfo rows. */
function dataEntries(name: string): Array<Record<string, unknown>> {
  const file = join(outRoot, 'data', `${name}.json`)
  if (!existsSync(file)) {
    console.warn(`${file} missing: no ${name} in the fx index (run export-data.ts first)`)
    return []
  }
  const e = (JSON.parse(readFileSync(file, 'utf8')) as { entries?: unknown }).entries
  return (Array.isArray(e) ? e : Object.values(e ?? {})) as Array<Record<string, unknown>>
}
const mobs = dataEntries('mobs')
const npcs = dataEntries('npcs')
const mobSkills = mobs.flatMap(m => (Array.isArray(m.skills) ? (m.skills as string[]) : []))
const characters = [...mobs, ...npcs].map(e => e.code).filter((c): c is string => typeof c === 'string')
const model = (bsr: string): ModelFiles | null => {
  const { glb, sidecar } = convertedPaths(bsr)
  return existsSync(join(outRoot, ...glb.replace(/^\/out\//, '').split('/'))) ? { glb, sidecar } : null
}
const indexInput = { skillRows, file: seFile, strings, mobSkills, characters, model }

const probe = buildSkillIndexV2({ ...indexInput, exported: () => true })
const wanted = skillsOnly ? new Set(Object.keys(probe.effects)) : null

const index: Array<{ key: string; url: string; version: string; nodes: number; duration: number | null; skills: string[]; warnings: string[] }> = []
const failures: Array<{ key: string; error: string }> = []
const textures = new Map<string, string>()
const meshes = new Map<string, string>()
for (const [key, entry] of particles.files) {
  if (!key.endsWith('.efp')) continue
  if (wanted && !wanted.has(fxKey(key))) continue
  let file
  try {
    file = parseEfp(particles.read(entry))
  } catch (e) {
    failures.push({ key: fxKey(key), error: (e as Error).message })
    continue
  }
  const { effect, texturePaths, meshPaths } = compileEfp(key, file, { exists })
  for (const p of texturePaths) textures.set(fxKey(p), p)
  for (const p of meshPaths) meshes.set(fxKey(p), p)
  write(fromUrl(fxEffectUrl(key)), JSON.stringify(effect))
  index.push({
    key: effect.key,
    url: fxEffectUrl(key),
    version: file.versionText,
    nodes: effect.nodes.length,
    duration: effect.duration,
    skills: probe.effects[effect.key]?.skills ?? [],
    warnings: effect.warnings,
  })
}

// Weapon-trail textures (aniset col 18): Particles textures/mirage_texture_*.ddj, referenced keys only.
const trailTextures = new Set<string>()
const missingTrails: string[] = []
for (const s of probe.skills) {
  const t = s.trail?.texture
  if (!t || trailTextures.has(t)) continue
  if (exists(t)) {
    trailTextures.add(t)
    textures.set(t, t)
  } else if (!missingTrails.includes(t)) missingTrails.push(t)
}

let texBytes = 0
const textureFailures: string[] = []
for (const [k, path] of textures) {
  try {
    const img = decodeDds(parseDdj(particles.read(k)).dds)
    const png = encodePng(img.width, img.height, img.rgba)
    texBytes += png.length
    write(fromUrl(fxTextureUrl(path)), png)
  } catch (e) {
    textureFailures.push(`${k}: ${(e as Error).message}`)
  }
}

// Target circles (Media.pk2 effect/select_0N.ddj -> tex/ui/select_0N.png).
const uiTextures: string[] = []
for (const p of SELECT_TEXTURES) {
  const f = media.get(p)
  if (!f) {
    textureFailures.push(`${p}: not in Media.pk2`)
    continue
  }
  try {
    const img = decodeDds(parseDdj(media.read(f)).dds)
    const rel = `tex/ui/${p.split('/').pop()!.replace(/\.ddj$/i, '')}.png`
    write(rel, encodePng(img.width, img.height, img.rgba))
    uiTextures.push(`fx/${rel}`)
  } catch (e) {
    textureFailures.push(`${p}: ${(e as Error).message}`)
  }
}

const io = new NodeIO()
const meshFailures: string[] = []
let meshErrors = 0
for (const [k, path] of meshes) {
  try {
    const { document } = effectMeshDocument(parseBms(particles.read(k)), k.split('/').pop()!.replace(/\.bms$/, ''))
    const glb = await io.writeBinary(document)
    const v = await validateGlb(glb, k)
    if (v.errors) {
      meshErrors++
      meshFailures.push(`${k}: ${summarizeIssues(v.messages, 0).join(', ')}`)
    }
    write(fromUrl(fxMeshUrl(path)), glb)
  } catch (e) {
    meshFailures.push(`${k}: ${(e as Error).message}`)
  }
}

// With --skills-only the effects exported before stay valid: count them as exported when their program is on disk.
const exportedKeys = new Set(index.map(e => e.key))
const onDisk = (k: string) => exportedKeys.has(k) || (skillsOnly && existsSync(join(outDir, ...fromUrl(fxEffectUrl(k)).split('/'))))
const skills = buildSkillIndexV2({ ...indexInput, exported: onDisk })
write('skills.json', JSON.stringify(skills, null, 1))
index.sort((a, b) => a.key.localeCompare(b.key))
if (!skillsOnly) {
  write(
    'index.json',
    JSON.stringify(
      {
        format: 'sro-fx-index',
        version: 1,
        provenance: 'Particles.pk2 via @sro/formats parseEfp; packages/convert/src/tools/export-fx.ts',
        effects: index,
        failures,
        textures: textures.size,
        meshes: meshes.size,
        trailTextures: [...trailTextures].sort().map(fxTextureUrl),
        uiTextures,
      },
      null,
      1,
    ),
  )
}

const referenced = Object.entries(skills.effects)
const missing = referenced.filter(([, e]) => !e.url)
const kinds = (k: string) => skills.skills.filter(s => s.kind === k).length
console.log(
  `effects ${index.length} exported, ${failures.length} failed to parse; textures ${textures.size} (${(texBytes / 1e6).toFixed(1)} MB), ` +
    `meshes ${meshes.size} (${meshErrors} with validator errors) -> ${outDir} in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
)
console.log(
  `skills.json v${skills.version}: ${kinds('player')} player, ${kinds('mob')} mob, ${kinds('system')} system groups; ` +
    `${Object.keys(skills.lights).length} lights, ${Object.keys(skills.characters).length} characters; ` +
    `trail textures ${trailTextures.size}, ui textures ${uiTextures.length}`,
)
console.log(`effects referenced ${referenced.length}, not exported ${missing.length}`)
for (const [k, e] of missing) console.log(`  not exported: ${k} (used by ${e.skills.slice(0, 3).join(', ') || 'characters'}${e.skills.length > 3 ? ', ...' : ''})`)
for (const t of missingTrails) console.log(`  trail texture not in Particles.pk2: ${t}`)
const noModel = skills.skills.flatMap(s => s.stages.filter(st => st.objectModel === null).map(st => `${s.group}: ${st.object}`))
for (const m of [...new Set(noModel)]) console.log(`  object model not converted: ${m}`)
for (const f of failures) console.log(`  parse failure: ${f.key}: ${f.error}`)
for (const f of textureFailures) console.log(`  texture failure: ${f}`)
for (const f of meshFailures) console.log(`  mesh failure: ${f}`)

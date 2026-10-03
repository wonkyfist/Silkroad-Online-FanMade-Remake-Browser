/**
 * `pnpm sro town`: the crowd's assets (docs/TOWN_LIFE.md §3.2, §12.2; WAVE_PLAN7 §6.1 lane TL-V, D14, D27 X1):
 *
 *   pnpm sro town [--in <dir>] [--out <dir>] [--only variants|vat|atlas[,…]] [--no-models]
 *
 * In (`--in`, default <work>/out): the converted Chinese bodies (`char/china/*.glb` + sidecars), the equipment manifest and its
 * garment glbs (`equipment/`), TL-A2's town clips (`moves/<skel>/town/town_clips.{glb,json}`; optional until they
 * exist), and the retail guards, elders and animals, converted from the client's Data.pk2 by the converter's own BSR
 * path (an existing `<out>/<category>/<name>.glb` is used instead).
 *
 * Out (`--out`, default the input folder), under <out>/town/:
 *   variants/<id>.glb   one dressed variant: one skinned mesh, one material, its atlas embedded (./variants.ts)
 *   vat/<skel>.bin      one half-float VAT per skeleton; vat/<skel>.json its clip table (./vat.ts VatFile)
 *   index.json          TownAssets: every variant (id, glb, skeleton, kind, female, height, rank, triangles, atlas,
 *                       selfLit) and every VAT (json, bin, bytes, frames, clips), paths relative to town/: what TL-C's
 *                       crowd loads (world-render town/crowd.ts `loadCrowdAssets`, `TownAssetIndex`)
 *   atlas/<id>.png      only with `--only atlas`: the atlases as images, for review (never loaded by the game)
 * `--only` limits what is written (everything is built in memory: it takes seconds); index.json is written with the
 * variants or the VATs. `--no-models` leaves out the client models (people only; no Data.pk2 needed).
 *
 * The budgets (WAVE_PLAN7 §5.3 TL-V) are checked and reported: per variant ≤ 3,000 triangles and one atlas ≤ 1024²,
 * each VAT ≤ 2.5 MB; a breach, a glTF-Validator error or a failed variant makes the verb exit 1.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { NodeIO, type Document } from '@gltf-transform/core'
import type { EquipmentManifest } from '@sro/appearance'
import { convertResource } from '../gltf/convert.ts'
import { validateGlb } from '../gltf/validate.ts'
import { openArchive, type SroConfig } from '../node-io.ts'
import { encodePng } from './atlas.ts'
import {
  dressVariant, peopleClips, personParts, PEOPLE_SKELETONS, skeletonOf, TOWN_MODELS, TOWN_PEOPLE, VARIANT_MAX_ATLAS,
  VARIANT_MAX_TRIANGLES, type DressSkeleton, type DressedVariant, type ModelSpec, type TownAssetKind, type TownClipSpec,
  type TownRank,
} from './variants.ts'
import { bakeVat, encodeHalf, vatBytes, vatFile, VAT_MAX_BYTES, type BakedVat, type VatClipSource, type VatTownMeta } from './vat.ts'

export const TOWN_USAGE = `pnpm sro town [--in <dir>] [--out <dir>] [--only variants|vat|atlas[,...]] [--no-models]
  The townsfolk's dressed variants, atlases and VATs -> <out>/town/ (in: work/out; out: the input; docs/TOWN_LIFE.md §3.2)`

export const TOWN_ASSETS_FORMAT = 'sro-town-assets'
export const TOWN_ASSETS_VERSION = 1

/** What the crowd draws a variant as (world-render town/crowd.ts CrowdKind). */
export type CrowdKindName = 'folk' | 'guard' | 'elder' | 'chicken' | 'dog' | 'cat' | 'horse'

/** One variant in index.json (paths relative to the export's `town/` folder). */
export interface TownVariantInfo {
  id: string
  /** `variants/<id>.glb`. */
  glb: string
  /** The VAT it plays (`vats` key: the skeleton's name). */
  skeleton: string
  kind: CrowdKindName
  female: boolean
  /** Bind-pose height in metres (the bubbles, the pick). */
  height: number
  /** The lowest preset that draws it (TOWN_LIFE §8.2). */
  rank: TownRank
  /** TOWN_LIFE's class: a dressed person, a guard, an elder or child, an animal. */
  class: TownAssetKind
  triangles: number
  vertices: number
  atlas: [number, number]
  /** The retail emissive, zeroed in the glb: set it as the material's emissive before decorating (variants.ts). */
  selfLit: [number, number, number]
  /** Where it was made from: the body and the item codes, or the client model. */
  source: { body?: string, character?: string, items?: string[], bsr?: string }
}

/** One VAT in index.json. */
export interface TownVatInfo {
  /** Relative to `town/`. */
  json: string
  bin: string
  bytes: number
  frames: number
  bones: number
  clips: string[]
}

/** `town/index.json` (TL-C's `TownAssetIndex`, a superset). */
export interface TownAssets {
  schema: typeof TOWN_ASSETS_VERSION
  format: typeof TOWN_ASSETS_FORMAT
  generator: string
  vats: Record<string, TownVatInfo>
  variants: TownVariantInfo[]
}

/** Client models that are women or girls (the grandmother; the event child is a girl in a hanbok). */
const FEMALE_MODELS = new Set(['elder_w', 'child'])

/** The crowd kind of a variant (variants.ts TOWN_MODELS ids). */
export function crowdKindOf(spec: { id: string, kind: TownAssetKind }): CrowdKindName {
  if (spec.kind === 'person') return 'folk'
  if (spec.kind === 'guard' || spec.kind === 'elder') return spec.kind
  if (spec.id === 'chicken' || spec.id === 'dog' || spec.id === 'cat') return spec.id
  return 'horse'
}

export type TownOutput = 'variants' | 'vat' | 'atlas'

export interface ExportTownOptions {
  /** The converter output the inputs are read from (<work>/out). */
  inDir: string
  /** Where `town/` is written (default inDir). */
  outDir?: string
  /** What to write (default variants + vat). */
  only?: ReadonlySet<TownOutput>
  /** Reads a client file (Data.pk2) for the guards, elders and animals; null: people only. */
  read: ((path: string) => Uint8Array) | null
  log?: (line: string) => void
}

export interface ExportTownReport {
  variants: Array<TownVariantInfo & { warnings: string[] }>
  vats: Record<string, TownVatInfo>
  failures: string[]
  warnings: string[]
  written: string[]
}

const io = new NodeIO()

async function readGlb(file: string): Promise<Document> {
  return io.readBinary(new Uint8Array(readFileSync(file)))
}

/** The basename of a retail skeleton path ('prim\\skel\\cos\\ch_guard.bsk' → 'ch_guard'). */
export function skeletonName(bsk: string): string {
  return (bsk.replace(/\\/g, '/').split('/').pop() ?? bsk).replace(/\.bsk$/i, '').toLowerCase()
}

interface SidecarAnim { name: string, walkLength?: number, durationMs?: number, partial?: boolean }

/** Metres per cycle of a clip from the sidecar's retail walkLength (decimetres; WALK 17 = 1.7 m per 1.17 s). */
function loopMOf(anims: readonly SidecarAnim[] | undefined, anim: string): number {
  const a = anims?.find(x => x.name === anim)
  return a?.walkLength && a.walkLength > 0 ? Math.round(a.walkLength * 100) / 1000 : 0
}

/** Town clip kinds of TL-A2's pack (`moves/<skel>/town/town_clips.json`, tools/town-clips.ts TownClipsIndex). */
export interface TownClipsIndex { clips: Record<string, { anim: string, frames?: number, durationMs?: number, base?: string, seat?: VatTownMeta['seat'], socket?: VatTownMeta['socket'] }> }

/** The pack entry's metadata the crowd needs (VatClip.town). */
function townMetaOf(k: TownClipsIndex['clips'][string]): VatTownMeta {
  return { base: k.base ?? 'STAND1', ...(k.seat ? { seat: k.seat } : {}), ...(k.socket ? { socket: k.socket } : {}) }
}

/**
 * The re-bake checks of TL-A2's clips in a baked VAT (TL-V2): every town clip has the pack's frame count (its keys'
 * lastFrame + 1 at 30 fps) and its socket joint is one of the skeleton's.
 */
export function checkTownClips(vat: BakedVat, index: TownClipsIndex): string[] {
  const bad: string[] = []
  for (const [name, c] of Object.entries(vat.clips)) {
    if (!c.town) continue
    const k = Object.entries(index.clips).find(([, e]) => c.source.endsWith(`#${e.anim}`))?.[1]
    if (k?.frames !== undefined && k.frames !== c.frames) bad.push(`${vat.skeleton}: town clip ${name} has ${c.frames} rows, its pack ${k.frames}`)
    if (c.town.socket && !vat.joints.includes(c.town.socket.bone)) bad.push(`${vat.skeleton}: town clip ${name}'s socket joint ${c.town.socket.bone} is not in the skin`)
  }
  return bad
}

interface ClipSourceCtx {
  skeleton: string
  canonical: { doc: Document, glb: string, anims: SidecarAnim[] | undefined }
  other: (body: string) => Promise<{ doc: Document, glb: string, anims: SidecarAnim[] | undefined } | null>
  town: { doc: Document, glb: string, index: TownClipsIndex } | null
}

async function clipSources(specs: readonly TownClipSpec[], ctx: ClipSourceCtx, warnings: string[]): Promise<VatClipSource[]> {
  const out: VatClipSource[] = []
  const has = (doc: Document, anim: string) => doc.getRoot().listAnimations().some(a => a.getName() === anim)
  for (const s of specs) {
    if (s.town) {
      const k = ctx.town?.index.clips[s.town]
      if (!ctx.town || !k || !has(ctx.town.doc, k.anim)) {
        const msg = `${ctx.skeleton}: town clip ${s.town} not found (TL-A2's moves/${ctx.skeleton}/town/town_clips.glb)`
        if (s.optional) {
          warnings.push(`${msg}; skipped`)
          continue
        }
        throw new Error(msg)
      }
      // a layer on a gait (CARRY on WALK) travels as its base does
      const loopM = k.base ? loopMOf(ctx.canonical.anims, k.base) : 0
      out.push({ name: s.name, doc: ctx.town.doc, anim: k.anim, fps: s.fps, loop: s.loop, loopM, source: `${ctx.town.glb}#${k.anim}`, town: townMetaOf(k) })
      continue
    }
    const src = s.from ? await ctx.other(s.from) : ctx.canonical
    const anim = s.anim ?? s.name
    if (!src || !has(src.doc, anim)) {
      const msg = `${ctx.skeleton}: clip ${anim}${s.from ? ` of ${s.from}` : ''} not found`
      if (s.optional) {
        warnings.push(`${msg}; skipped`)
        continue
      }
      throw new Error(msg)
    }
    out.push({
      name: s.name, doc: src.doc, anim, fps: s.fps, loop: s.loop, loopM: loopMOf(src.anims, anim),
      source: `${src.glb}#${anim}`, ...(s.base ? { base: s.base } : {}),
    })
  }
  return out
}

/** A variant built in memory. */
export interface BuiltVariant {
  info: TownVariantInfo
  dressed: DressedVariant
}

export interface BuildTownOptions {
  /** The converter output the inputs are read from (<work>/out). */
  inDir: string
  /** Reads a client file (Data.pk2) for the guards, elders and animals; null: people only. */
  read: ((path: string) => Uint8Array) | null
  /** Only these people / models (variants.ts ids); default all. */
  people?: readonly string[]
  models?: readonly string[]
}

/** Every variant and VAT, in memory (the tests build a few; the verb writes them). */
export interface TownBuild {
  variants: BuiltVariant[]
  vats: Map<string, BakedVat>
  /** The skeleton each VAT was baked for (the variants' skin). */
  skeletons: Map<string, DressSkeleton>
  failures: string[]
  warnings: string[]
}

/** Builds the variants and VATs in memory (failures are collected, not thrown). */
export async function buildTown(opts: BuildTownOptions): Promise<TownBuild> {
  const out = opts.inDir
  const report: TownBuild = { variants: [], vats: new Map(), skeletons: new Map(), failures: [], warnings: [] }
  const built = report.variants
  const vats = report.vats
  const manifestFile = join(out, 'equipment', 'equipment.json')
  if (!existsSync(manifestFile)) throw new Error(`town: ${manifestFile} is missing (run the equipment export first)`)
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as EquipmentManifest
  const glbCache = new Map<string, Promise<Document>>()
  const glb = (rel: string) => {
    const key = rel.replace(/^\/?out\//, '')
    let p = glbCache.get(key)
    if (!p) glbCache.set(key, (p = readGlb(join(out, ...key.split('/')))))
    return p
  }
  const sidecar = (rel: string): { animations?: SidecarAnim[] } | null => {
    const f = join(out, ...rel.split('/'))
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
  }

  // ---- people: one skeleton and one VAT per gender, 9 dressed variants each
  for (const gender of ['male', 'female'] as const) {
    const { body, skeleton } = PEOPLE_SKELETONS[gender]
    const bodyRel = `char/china/${body}.glb`
    if (!existsSync(join(out, bodyRel))) {
      report.failures.push(`${skeleton}: ${bodyRel} is missing`)
      continue
    }
    const canonDoc = await glb(bodyRel)
    const skel = skeletonOf(skeleton, canonDoc)
    report.skeletons.set(skeleton, skel)
    try {
      const townGlb = `moves/${skeleton}/town/town_clips.glb`
      const townJson = join(out, 'moves', skeleton, 'town', 'town_clips.json')
      const town = existsSync(join(out, townGlb)) && existsSync(townJson)
        ? { doc: await glb(townGlb), glb: townGlb, index: JSON.parse(readFileSync(townJson, 'utf8')) as TownClipsIndex }
        : null
      const sources = await clipSources(peopleClips(gender), {
        skeleton,
        canonical: { doc: canonDoc, glb: bodyRel, anims: sidecar(`char/china/${body}.json`)?.animations },
        other: async b => {
          const rel = `char/china/${b}.glb`
          if (!existsSync(join(out, rel))) return null
          return { doc: await glb(rel), glb: rel, anims: sidecar(`char/china/${b}.json`)?.animations }
        },
        town,
      }, report.warnings)
      const vat = bakeVat(skel, sources)
      if (town) report.failures.push(...checkTownClips(vat, town.index))
      vats.set(skeleton, vat)
    } catch (e) {
      report.failures.push(`${skeleton}: ${(e as Error).message}`)
      continue
    }
    for (const spec of TOWN_PEOPLE.filter(p => p.gender === gender && (!opts.people || opts.people.includes(p.id)))) {
      try {
        const bodyDoc = await glb(`char/china/${spec.body}.glb`)
        const { parts, character } = await personParts(spec, manifest, bodyDoc, glb)
        const dressed = await dressVariant(spec.id, skel, parts)
        built.push({
          dressed,
          info: {
            id: spec.id, glb: `variants/${spec.id}.glb`, skeleton, kind: 'folk', female: gender === 'female',
            height: dressed.heightM, rank: spec.rank, class: 'person', triangles: dressed.triangles,
            vertices: dressed.vertices, atlas: [dressed.atlas.width, dressed.atlas.height], selfLit: dressed.selfLit,
            source: { body: spec.body, character, items: spec.items },
          },
        })
      } catch (e) {
        report.failures.push(`${spec.id}: ${(e as Error).message}`)
      }
    }
  }

  // ---- guards, elders, animals: client models, one VAT per skeleton (shared when the binds agree)
  if (opts.read) {
    const read = opts.read
    const groups = new Map<string, { skel: DressSkeleton, members: Array<{ spec: ModelSpec, doc: Document, anims: SidecarAnim[] | undefined, rel: string }> }>()
    for (const spec of TOWN_MODELS.filter(m => !opts.models || opts.models.includes(m.id))) {
      try {
        const rel = spec.bsr.replace(/\\/g, '/').replace(/^res\//i, '').replace(/\.bsr$/i, '').toLowerCase()
        let doc: Document
        let anims: SidecarAnim[] | undefined
        let bsk: string | undefined
        if (existsSync(join(out, `${rel}.glb`)) && existsSync(join(out, `${rel}.json`))) {
          doc = await glb(`${rel}.glb`)
          const sc = sidecar(`${rel}.json`) as { animations?: SidecarAnim[], skeleton?: { bsk?: string } } | null
          anims = sc?.animations
          bsk = sc?.skeleton?.bsk
        } else {
          const r = convertResource(spec.bsr, { read })
          doc = r.document
          anims = r.sidecar.animations as SidecarAnim[]
          bsk = r.sidecar.skeleton?.bsk
        }
        const name = skeletonName(bsk ?? spec.id)
        const skel = skeletonOf(name, doc)
        let key = name
        const g = groups.get(key)
        if (g && !sameSkeleton(g.skel, skel)) {
          key = `${name}_${spec.id}`
          report.warnings.push(`${spec.id}: binds differ from ${name}'s other members: own VAT ${key}`)
        }
        const group = groups.get(key) ?? { skel: { ...skel, name: key }, members: [] }
        groups.set(key, group)
        group.members.push({ spec, doc, anims, rel: `${rel}.glb` })
      } catch (e) {
        report.failures.push(`${spec.id}: ${(e as Error).message}`)
      }
    }
    for (const [key, g] of groups) {
      try {
        // the group's clips: the union over its members' specs, each from the first member that has it
        const seen = new Set<string>()
        const sources: VatClipSource[] = []
        for (const m of g.members) {
          const fresh = m.spec.clips.filter(c => !seen.has(c.name))
          const got = await clipSources(fresh, { skeleton: key, canonical: { doc: m.doc, glb: m.rel, anims: m.anims }, other: async () => null, town: null }, report.warnings)
          for (const s of got) {
            seen.add(s.name)
            sources.push(s)
          }
        }
        vats.set(key, bakeVat(g.skel, sources))
        report.skeletons.set(key, g.skel)
        for (const m of g.members) {
          const dressed = await dressVariant(m.spec.id, g.skel, [{ label: m.rel, doc: m.doc, meshes: null }])
          built.push({
            dressed,
            info: {
              id: m.spec.id, glb: `variants/${m.spec.id}.glb`, skeleton: key, kind: crowdKindOf(m.spec),
              female: FEMALE_MODELS.has(m.spec.id), height: dressed.heightM, rank: m.spec.rank, class: m.spec.kind,
              triangles: dressed.triangles, vertices: dressed.vertices, atlas: [dressed.atlas.width, dressed.atlas.height],
              selfLit: dressed.selfLit, source: { bsr: m.spec.bsr },
            },
          })
        }
      } catch (e) {
        report.failures.push(`${key}: ${(e as Error).message}`)
      }
    }
  } else report.warnings.push('no client archive: the guards, elders and animals were not built (--no-models)')
  return report
}

/** The glb bytes of a built variant. */
export function variantGlb(v: BuiltVariant): Promise<Uint8Array> {
  return io.writeBinary(v.dressed.doc)
}

/** Builds every variant and VAT in memory and writes the selected outputs. */
export async function exportTown(opts: ExportTownOptions): Promise<ExportTownReport> {
  const log = opts.log ?? (() => {})
  const only = opts.only ?? new Set<TownOutput>(['variants', 'vat'])
  const dest = opts.outDir ?? opts.inDir
  const b0 = await buildTown({ inDir: opts.inDir, read: opts.read })
  const built = b0.variants
  const vats = b0.vats
  const report: ExportTownReport = { variants: [], vats: {}, failures: b0.failures, warnings: b0.warnings, written: [] }

  // ---- budgets
  for (const b of built) {
    const v = b.info
    if (v.triangles > VARIANT_MAX_TRIANGLES) report.failures.push(`${v.id}: ${v.triangles} triangles > ${VARIANT_MAX_TRIANGLES}`)
    if (v.atlas[0] > VARIANT_MAX_ATLAS || v.atlas[1] > VARIANT_MAX_ATLAS) report.failures.push(`${v.id}: atlas ${v.atlas.join('x')} > ${VARIANT_MAX_ATLAS}²`)
    report.variants.push({ ...v, warnings: b.dressed.warnings })
  }
  const halves = new Map<string, Uint16Array>()
  for (const [key, v] of vats) {
    const half = encodeHalf(v.data)
    halves.set(key, half)
    const bytes = half.byteLength
    if (bytes > VAT_MAX_BYTES) report.failures.push(`vat ${key}: ${bytes} B > ${VAT_MAX_BYTES} B`)
    report.vats[key] = { json: `vat/${key}.json`, bin: `vat/${key}.bin`, bytes, frames: v.height, bones: v.joints.length, clips: Object.keys(v.clips) }
  }

  // ---- write
  const write = (rel: string, data: Uint8Array | string) => {
    const f = join(dest, ...rel.split('/'))
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, data)
    report.written.push(rel)
  }
  if (only.has('variants')) {
    for (const b of built) {
      const bytes = await variantGlb(b)
      const val = await validateGlb(bytes, `${b.info.id}.glb`)
      if (val.errors) report.failures.push(`${b.info.id}: ${val.errors} glTF-Validator errors (${val.messages.slice(0, 3).map(m => m.message).join('; ')})`)
      write(`town/${b.info.glb}`, bytes)
    }
  }
  if (only.has('vat')) {
    for (const [key, v] of vats) {
      write(`town/vat/${key}.bin`, vatBytes(halves.get(key)!))
      write(`town/vat/${key}.json`, JSON.stringify(vatFile(v, `${key}.bin`), null, 1) + '\n')
    }
  }
  if (only.has('atlas')) {
    for (const b of built) write(`town/atlas/${b.info.id}.png`, await encodePng(b.dressed.atlas.image))
  }
  if (only.has('variants') || only.has('vat')) {
    const assets: TownAssets = {
      schema: TOWN_ASSETS_VERSION,
      format: TOWN_ASSETS_FORMAT,
      generator: 'pnpm sro town (packages/convert/src/town/export-town.ts)',
      vats: report.vats,
      variants: built.map(b => b.info),
    }
    write('town/index.json', JSON.stringify(assets, null, 1) + '\n')
  }
  for (const v of report.variants) log(`  ${v.id.padEnd(12)} ${v.kind.padEnd(7)} ${v.rank.padEnd(6)} ${String(v.triangles).padStart(5)} tris  atlas ${v.atlas.join('x').padEnd(9)} vat ${v.skeleton}  h ${v.height} m${v.selfLit.some(c => c > 0) ? `  selfLit ${v.selfLit.join(',')}` : ''}`)
  for (const [k, v] of Object.entries(report.vats)) log(`  vat ${k.padEnd(28)} ${String(v.frames).padStart(5)} frames ${String(v.bones).padStart(3)} bones ${(v.bytes / 1e6).toFixed(2)} MB  ${v.clips.length} clips`)
  return report
}

/** Two skins with the same joints in the same order and inverse binds within IBM tolerance. */
function sameSkeleton(a: DressSkeleton, b: DressSkeleton): boolean {
  if (a.joints.length !== b.joints.length || a.joints.some((j, i) => j !== b.joints[i])) return false
  for (let i = 0; i < a.ibm.length; i++) if (Math.abs(a.ibm[i]! - b.ibm[i]!) > 1e-4) return false
  return true
}

export async function exportTownCli(args: readonly string[], cfg: SroConfig): Promise<number> {
  if (args.includes('--help')) {
    console.log(TOWN_USAGE)
    return 0
  }
  let inDir = join(cfg.workDir, 'out')
  let outDir: string | undefined
  let only: Set<TownOutput> | undefined
  let models = true
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--in') inDir = resolve(args[++i] ?? '')
    else if (a === '--out') outDir = resolve(args[++i] ?? '')
    else if (a === '--only') {
      const list = (args[++i] ?? '').split(',').filter(Boolean)
      const bad = list.filter(x => !['variants', 'vat', 'atlas'].includes(x))
      if (!list.length || bad.length) {
        console.error(`town: --only expects variants, vat or atlas\n${TOWN_USAGE}`)
        return 1
      }
      only = new Set(list as TownOutput[])
    } else if (a === '--no-models') models = false
    else {
      console.error(`town: unexpected argument ${JSON.stringify(a)}\n${TOWN_USAGE}`)
      return 1
    }
  }
  let read: ((p: string) => Uint8Array) | null = null
  if (models) {
    try {
      const data = openArchive('Data', cfg)
      read = p => data.read(p)
    } catch (e) {
      console.error(`town: the client's Data.pk2 could not be opened (${(e as Error).message}); use --no-models for the people only`)
      return 1
    }
  }
  const t0 = performance.now()
  const report = await exportTown({ inDir, outDir, only, read, log: l => console.log(l) })
  for (const w of report.warnings) console.log(`  ! ${w}`)
  for (const f of report.failures) console.error(`  FAILED ${f}`)
  console.log(`town: ${report.variants.length} variants, ${Object.keys(report.vats).length} VATs, ${report.written.length} files -> ${join(outDir ?? inDir, 'town')} in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  return report.failures.length ? 1 : 0
}

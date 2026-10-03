/**
 * Writes converted resources to <outDir>/<category>/<basename>.glb + .json, validates every glb with the Khronos
 * glTF-Validator, and merges the entries into <outDir>/index.json (the viewer's model list).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { mergeIndex, type IndexEntry } from '../tools/make-test-glb.ts'
import { convertResource, type ConvertOptions, type ReadFile, type Sidecar } from './convert.ts'
import { summarizeIssues, validateGlb, type GlbValidation } from './validate.ts'

export const PRESETS: Readonly<Record<string, readonly string[]>> = {
  m1: [
    'res/char/china/chinaman_adventurer.bsr',
    'res/char/china/chinawoman_adventurer.bsr',
    'res/char/europe/europeman_adventurer.bsr',
    'res/item/china/weapon/blade_01.bsr',
    'res/mob/china/mangnyang.bsr',
    'res/mob/china/tiger.bsr',
    'res/mob/china/tigerwoman.bsr',
  ],
  /**
   * Effects models (docs/EFFECTS.md §5.3, lane FX-X): arrows (the imbued ones use the retail spelling
   * `cha_arrow_lighting`), the bandit archer's arrow, White Hawk, the drop models not converted before, the models
   * Mangnyang and Tombstone swap to at death, and the Tiger Girl's mount (characterInfo `ride`). The seven drop
   * models converted before are listed again so their sidecars get the mod-palette `particles` (the sparkles).
   * Quest marks (`res/etc/ex_mark_*.bsr`) are not listed (docs/WAVE_PLAN2.md §8 Q13).
   */
  fx: [
    'res/item/china/weapon/cha_arrow_normal.bsr',
    'res/item/china/weapon/cha_arrow_cold.bsr',
    'res/item/china/weapon/cha_arrow_fire.bsr',
    'res/item/china/weapon/cha_arrow_lighting.bsr',
    'res/item/china/weapon/cha_arrow_critical.bsr',
    'res/item/china/weapon/cha_arrow_chain.bsr',
    'res/mob/china/banditarcher_arrow.bsr',
    'res/npc/animal/whitehawk.bsr',
    'res/item/etc/drop_ch_quest.bsr',
    'res/item/etc/drop_ch_equip_rare.bsr',
    'res/item/etc/drop_ch_acc_rare.bsr',
    'res/item/etc/drop_archemy.bsr',
    'res/item/etc/drop_archemy_1.bsr',
    'res/item/etc/drop_archemy_bag.bsr',
    'res/item/etc/drop_trade.bsr',
    'res/item/etc/drop_ch_money_small.bsr',
    'res/item/etc/drop_ch_money_normal.bsr',
    'res/item/etc/drop_ch_money_large.bsr',
    'res/item/etc/drop_ch_equip.bsr',
    'res/item/etc/drop_ch_acc.bsr',
    'res/item/etc/drop_ch_bag.bsr',
    'res/item/etc/drop_scroll.bsr',
    'res/mob/common/mangnyang_die.bsr',
    'res/mob/common/tombstone_die.bsr',
    'res/mob/china/bluetiger.bsr',
  ],
}

/** 'res/char/china/chinaman_adventurer.bsr' -> 'char/china'. */
export function categoryOf(bsrPath: string): string {
  const parts = bsrPath.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean)
  parts.pop()
  if (parts[0] === 'res') parts.shift()
  return parts.join('/') || 'uncategorized'
}

export function baseNameOf(bsrPath: string): string {
  return (bsrPath.replace(/\\/g, '/').split('/').pop() ?? bsrPath).replace(/\.[^.]*$/, '').toLowerCase()
}

export interface ConvertedAsset {
  entry: IndexEntry
  glbFile: string
  sidecarFile: string
  glbBytes: number
  sidecar: Sidecar
  validation: GlbValidation
}

/** Converter options besides `read` (e.g. `particleExists`, docs/EFFECTS.md §5.2). */
export type ConvertExtras = Omit<ConvertOptions, 'read'>

export async function convertToFiles(bsrPath: string, read: ReadFile, outDir: string, extras: ConvertExtras = {}): Promise<ConvertedAsset> {
  const { document, sidecar } = convertResource(bsrPath, { ...extras, read })
  const glb = await new NodeIO().writeBinary(document)
  const category = categoryOf(bsrPath)
  const base = baseNameOf(bsrPath)
  const rel = `${category}/${base}`
  const validation = await validateGlb(glb, `${base}.glb`)
  sidecar.validation = {
    errors: validation.errors,
    warnings: validation.warnings,
    infos: validation.infos,
    issues: summarizeIssues(validation.messages, 2),
  }
  const glbFile = join(outDir, ...rel.split('/')) + '.glb'
  const sidecarFile = join(outDir, ...rel.split('/')) + '.json'
  mkdirSync(dirname(glbFile), { recursive: true })
  writeFileSync(glbFile, glb)
  writeFileSync(sidecarFile, JSON.stringify(sidecar, null, 2) + '\n')
  return {
    entry: { id: rel, name: base, category, glb: `${rel}.glb`, sidecar: `${rel}.json` },
    glbFile,
    sidecarFile,
    glbBytes: glb.byteLength,
    sidecar,
    validation,
  }
}

export interface ConvertManyResult {
  assets: ConvertedAsset[]
  failures: Array<{ path: string; error: string }>
  indexFile: string
}

/** Converts each path (failures are collected, not thrown) and merges the successes into index.json. */
export async function convertMany(paths: readonly string[], read: ReadFile, outDir: string,
  log: (line: string) => void = () => {}, extras: ConvertExtras = {}): Promise<ConvertManyResult> {
  const assets: ConvertedAsset[] = []
  const failures: Array<{ path: string; error: string }> = []
  for (const path of paths) {
    try {
      const asset = await convertToFiles(path, read, outDir, extras)
      assets.push(asset)
      log(formatAssetLine(asset))
    } catch (e) {
      failures.push({ path, error: (e as Error).message })
      log(`FAILED ${path}: ${(e as Error).message}`)
    }
  }
  mkdirSync(outDir, { recursive: true })
  const indexFile = join(outDir, 'index.json')
  if (assets.length) mergeIndex(indexFile, assets.map(a => a.entry))
  return { assets, failures, indexFile }
}

export function formatAssetLine(a: ConvertedAsset): string {
  const s = a.sidecar.stats
  const v = a.validation
  const issues = summarizeIssues(v.messages, 1)
  return (
    `${a.entry.id.padEnd(34)} v=${String(s.vertices).padStart(5)} t=${String(s.triangles).padStart(5)} ` +
    `joints=${String(s.joints).padStart(3)} anims=${String(s.animations).padStart(3)} tex=${s.textures} ` +
    `h=${s.heightM.toFixed(3)} m  ${(a.glbBytes / 1024).toFixed(0)} KiB  ` +
    `validator: ${v.errors} errors, ${v.warnings} warnings, ${v.infos} infos` +
    (issues.length ? ` [${issues.join(', ')}]` : '')
  )
}

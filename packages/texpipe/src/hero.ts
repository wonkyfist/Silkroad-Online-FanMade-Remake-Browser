/**
 * The terrain hero flip as one call (WAVE_PLAN8 D7, D19; TERRAIN_TEX §5.3): what `pnpm texpipe hero` runs, and what
 * the world editor's Publish calls in-process (or through the CLI with `--json`) for every tile painted past 0.1 %
 * cover. One validated write of `content/texpipe/overrides.json` and one of `work/out/pbr/index.json` for the whole
 * list, never a re-encode: every B3 set is encoded with all its maps, so `hero` only decides whether Medium and High
 * sample them. Nothing else edits the two files for a hero flip.
 *
 * The flip changes `work/out` only; the optimized export takes it with the next `optimize-out` (Publish passes the
 * returned `files` to its `--files` run).
 */
import { join, relative } from 'node:path'
import { tileKey, type PbrIndex } from './format.ts'
import { emptyOverrides, loadOverrides, OVERRIDES_FILE, REPO_ROOT } from './inventory.ts'
import { flipHero, readPbrIndex, writePbrIndex } from './index-writer.ts'
import { formatOverrides } from './review.ts'
import { writeAtomic } from './upscale/cache.ts'

/** TERRAIN_TEX §5.3: a tile whose cover reaches 0.1 % of the export's terrain after an edit becomes hero. */
export const HERO_COVER_MIN = 0.001

/**
 * The tiles an edit should flip to hero: cover (share of the export's non-synthetic terrain vertices, 0..1, by tile
 * stem or `tile2d:` key) at or past HERO_COVER_MIN whose encoded set is not hero yet. Tiles without a set are left
 * out (a tile outside the 108 is out of scope this wave; WAVE_PLAN8 D19). Sorted keys. Pure.
 */
export function heroCandidates(cover: Readonly<Record<string, number>>, index: PbrIndex | null): string[] {
  const out = new Set<string>()
  for (const [tile, share] of Object.entries(cover)) {
    if (!(share >= HERO_COVER_MIN)) continue
    const key = tile.startsWith('tile2d:') ? tile : tileKey(tile)
    const set = index?.sets[key]
    if (set && !set.hero) out.add(key)
  }
  return [...out].sort()
}

export interface SetHeroOptions {
  /** Tile stems or `tile2d:` keys. */
  tiles: readonly string[]
  on: boolean
  /** Default `content/texpipe/overrides.json`. */
  overridesFile?: string
  /** The folder of `index.json`; default `<outDir>/pbr`. */
  pbrDir: string
  /** Report what would change, write nothing. */
  dryRun?: boolean
}

export interface SetHeroResult {
  on: boolean
  /** Per tile key: whether its overrides row and its index set changed. */
  tiles: Array<{ key: string; overrides: boolean; index: boolean }>
  warnings: string[]
  /** Files written (repo-relative, `/`), empty on a dry run or when nothing changed. */
  files: string[]
}

const rel = (file: string) => relative(REPO_ROOT, file).split('\\').join('/')

/** Flips every tile, then validates and writes each file once (overrides first, then the index). */
export function setHero(opts: SetHeroOptions): SetHeroResult {
  if (!opts.tiles.length) throw new Error('hero: give at least one tile')
  const overridesFile = opts.overridesFile ?? OVERRIDES_FILE
  let overrides = loadOverrides(overridesFile) ?? emptyOverrides()
  let index = readPbrIndex(opts.pbrDir)
  const tiles: SetHeroResult['tiles'] = []
  const warnings: string[] = []
  let dirtyO = false, dirtyI = false
  for (const t of opts.tiles) {
    const key = t.startsWith('tile2d:') ? t : tileKey(t)
    if (tiles.some(x => x.key === key)) continue
    const r = flipHero(overrides, index, key, opts.on)
    overrides = r.overrides
    index = r.index
    dirtyO ||= r.changed.overrides
    dirtyI ||= r.changed.index
    warnings.push(...r.warnings)
    tiles.push({ key, overrides: r.changed.overrides, index: r.changed.index })
  }
  const files: string[] = []
  if (!opts.dryRun) {
    if (dirtyO) {
      writeAtomic(overridesFile, formatOverrides(overrides))
      files.push(rel(overridesFile))
    }
    if (dirtyI && index) files.push(rel(writePbrIndex(opts.pbrDir, index)))
  }
  return { on: opts.on, tiles, warnings, files }
}

/** `<outDir>/pbr` (the CLI's default). */
export const pbrDirOf = (outDir: string) => join(outDir, 'pbr')

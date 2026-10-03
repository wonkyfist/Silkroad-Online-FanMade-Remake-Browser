/**
 * CST-C phases 1 and 2 on the real retail heights (docs/COAST.md §12.1, §12.13 with the beaches fact-check's G6, G7, G11,
 * G12; WAVE_PLAN6 §6.1 CST-C): content/coast/coast.json run through the converter's coast pass, paint and sea mask on
 * every .m of the coast domain. Skips without sro.config.json (the client's archives).
 *
 * The checks are ./checks.ts, the same the converter writes into manifest.report.coast; the hotspot allowance is
 * coast.json `hotspots` (the Blender hand-pass list, §3B.7).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { assembleRegionGrid, isRegionActive, parseMapM, parseMfo, parseTile2d, type MfoFile } from '@sro/formats'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { emitCensus, changedRegions, type EmitCensus } from '../src/world/coast/census.ts'
import * as checks from '../src/world/coast/checks.ts'
import { parseCoastConfig, type CoastConfig } from '../src/world/coast/config.ts'
import { seaMasks, type SeaMasks } from '../src/world/coast/field.ts'
import { paintCoast, type CoastPaint } from '../src/world/coast/paint.ts'
import { runCoastPass, type CoastResult } from '../src/world/coast/pass.ts'
import { sampleLattice } from '../src/world/coast/placements.ts'
import { readRetailLattice, type RetailLattice } from '../src/world/coast/retail.ts'
import { WORLD_PRESETS } from '../src/world/convert-world.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

describe.skipIf(!hasConfig)('the coast on the retail heights (content/coast/coast.json, phase 2)', () => {
  const preset = WORLD_PRESETS['jangan-fields']!
  const exportRect = { x0: preset.x0, x1: preset.x1, z0: preset.z0, z1: preset.z1 }
  let cfg: CoastConfig
  let mfo: MfoFile
  let retail: RetailLattice
  let r: CoastResult
  let paint: CoastPaint
  let masks: SeaMasks
  let census: EmitCensus
  let isGrass: (id: number) => boolean

  beforeAll(() => {
    cfg = parseCoastConfig(readFileSync(join(REPO_ROOT, preset.coast!), 'utf8'))
    const map = openArchive('Map')
    mfo = parseMfo(map.read('mapinfo.mfo'))
    const tile2d = parseTile2d(map.read('tile2d.ifo'))
    isGrass = id => tile2d.byId.get(id)?.typeName === 'Grass'
    retail = readRetailLattice(cfg.domain, (x, z) => {
      const path = `${z}/${x}.m`
      if (!map.has(path)) return null
      const mapm = parseMapM(map.read(path))
      return { mapm, grid: assembleRegionGrid(mapm) }
    })
    const active = (x: number, z: number) => isRegionActive(mfo, x, z)
    r = runCoastPass({ heights: retail.heights, water: retail.water, active, playable: preset.playable!, exportRect }, cfg)
    paint = paintCoast(r, cfg, { words: retail.words, heights: retail.heights, isGrass })
    masks = seaMasks(r)
    census = emitCensus(r, cfg, exportRect, active)
  }, 300_000)

  it('keeps the playable set bit-identical outside the S1 patch, and the tomb crest bit for bit (§3B.4)', () => {
    expect(r.stats.playChangedOutsidePatch).toBe(0)
    expect(r.stats.playChanged).toBeGreaterThan(40_000)
    expect(r.stats.tombKeepBitIdentical).toBe(true)
    expect(r.stats.tombKeepVertices).toBeGreaterThan(6000)
  })

  it('keeps the Option A corridor (the land bridge toward Donwhang) retail, bit for bit; phase 2 has no land edge', () => {
    expect(cfg.phase).toBe(2)
    expect(r.landFade.every(v => v === 0)).toBe(true)
    let n = 0
    for (let i = 0; i < r.h.length; i++) {
      if (!r.masks.inCorr[i] || !r.masks.have[i]) continue
      if (r.h[i] !== retail.heights[i]) throw new Error(`corridor vertex ${i} moved`)
      n++
    }
    expect(n).toBeGreaterThan(400_000)
  })

  it('slope census (G6): no land past 100 m of the line on a sea side is steeper than 50° outside the hotspots', () => {
    const sc = checks.slopeCensus(r, cfg)
    expect(sc.land).toBeGreaterThan(150_000)
    expect(sc.samples).toEqual([])
    expect(sc.outside).toBe(0)
    expect(sc.over45 / sc.land).toBeLessThan(0.03)
  })

  it('no crease along the bounds line, no new bench 10-60 m out (G11), no crease along the tomb keep line (G12)', () => {
    const line = checks.lineCreases(r, retail.heights, cfg)
    expect(line.checked).toBeGreaterThan(2000)
    expect(line.findings.filter(f => !f.hotspot)).toEqual([])
    const keep = checks.keepLineCreases(r, retail.heights, cfg)
    expect(keep.checked).toBeGreaterThan(200)
    expect(keep.findings.filter(f => !f.hotspot)).toEqual([])
    const bench = checks.newBenches(r, retail.heights, cfg)
    expect(bench.checked).toBeGreaterThan(4000)
    expect(bench.findings.filter(f => !f.hotspot)).toEqual([])
  })

  it('sand (407, 412, 70) within 12 m of every sea shore outside the bounds', () => {
    const sand = checks.sandCoverage(r, cfg, masks, paint.words)
    expect(sand.shore).toBeGreaterThan(3000)
    expect(sand.gaps).toEqual([])
  })

  it('paints at least 80 % of the moved flank below grassMaxDeg with grass tiles (G7)', () => {
    const f = checks.flankGrassShare(r, cfg, retail.heights, paint.words, isGrass)
    expect(f.flank).toBeGreaterThan(100_000)
    expect(f.share).toBeGreaterThanOrEqual(checks.FLANK_GRASS_SHARE)
  })

  it('keeps the river mouths: retail water within riverMouthKeepM of in-bounds sea-level water is never filled', () => {
    const m = checks.riverMouthFills(r, retail.heights)
    expect(m.checked).toBeGreaterThan(1000)
    expect(m.filled).toEqual([])
  })

  it('never puts the sea on dry playable ground, on dry corridor ground or on a land edge', () => {
    for (let i = 0; i < r.h.length; i++) {
      if (!masks.sea[i]) continue
      if (r.masks.inPlay[i] && !r.masks.patch[i] && !r.masks.wetR[i]) throw new Error(`sea on dry playable vertex ${i}`)
      if (r.masks.inCorr[i] && !r.masks.wetR[i]) throw new Error(`sea on dry corridor vertex ${i}`)
      if (r.landFade[i]! >= 0.5) throw new Error(`sea on land-edge vertex ${i}`)
    }
  })

  it('census (§12.13 test 6): the synthetic regions and the changed export regions of phase 2', () => {
    expect(census.land + census.shallow).toBe(census.emitted.length)
    // COAST §2.2 (beaches): 107 band regions with land or water shallower than 8 m, none on a land edge
    expect(census.emitted.length).toBeGreaterThanOrEqual(100)
    expect(census.emitted.length).toBeLessThanOrEqual(115)
    expect(census.landEdge).toBe(0)
    // the corridor's look-only retail regions beyond the export (x 153-154) are emitted
    const emitted = new Set(census.emitted.map(e => `${e.x},${e.z}`))
    for (let z = 97; z <= 102; z++) for (const x of [153, 154]) expect(emitted.has(`${x},${z}`), `${x},${z}`).toBe(true)
    const exportRegions: Array<{ x: number; z: number }> = []
    for (let z = exportRect.z0; z <= exportRect.z1; z++) for (let x = exportRect.x0; x <= exportRect.x1; x++) if (isRegionActive(mfo, x, z)) exportRegions.push({ x, z })
    const changed = changedRegions(r, retail.heights, exportRegions)
    expect(changed.length).toBeGreaterThan(50)
    expect(changed.length).toBeLessThanOrEqual(80)
    // the S1 regions and the ring on every sea side change, the west and north-west too (phase 2); the export ring
    // inside the corridor (x 155, z 97-102) stays retail
    const keys = new Set(changed.map(c => `${c.x},${c.z}`))
    for (const k of ['170,90', '158,89', '175,95', '172,103', '155,95', '155,90', '156,103', '160,103']) expect(keys.has(k), k).toBe(true)
    for (let z = 97; z <= 102; z++) expect(keys.has(`155,${z}`), `155,${z}`).toBe(false)
  })

  it('puts every coast.json place on ground above the sea level (tp beach-south)', () => {
    for (const p of cfg.places) expect(sampleLattice(r, r.h, p.x, p.z), p.name).toBeGreaterThan(cfg.seaLevelM + 0.5)
  })
})

// The job system's looks (docs/JOBS.md §3.3, layer 6): the job palettes and emblem on the licensed bodies' cloth, the
// retail suit plan, the name plate's job line (merged with the Bounty Hunter badge), the transports' goods bundles.
import { describe, expect, it } from 'vitest'
import { STRIP_W, clothCode, outfitHasEmblem, outfitStrip, stripRow } from '../src/three/licensed-cloth.ts'
import {
  EMBLEM_COL,
  EMBLEM_M_RANGE,
  JOB_PALETTES,
  JOB_PLATE_KEYS,
  TRANSPORT_LOAD,
  bundleCount,
  bundleScale,
  emblemAnchor,
  emblemSides,
  jobDyeOf,
  jobPaletteRow,
  jobPlate,
  readEmblemFlags,
  retailSuitPlan,
  writeEmblem,
  type EmblemAnchors,
} from '../src/three/job-look.ts'
import { PALETTES, clothFxOf, gearOf, outfitFromGear, outfitKey, paletteKey, paletteLinear } from '../src/three/licensed-outfit.ts'
import { applyJobPlate } from '../src/world/features/job-looks.ts'

const ARMOUR = { chest: 'ITEM_CH_W_HEAVY_03_BA_A', legs: 'ITEM_CH_W_HEAVY_03_LA_A', feet: 'ITEM_CH_W_HEAVY_03_FA_A', weapon: 'ITEM_CH_SWORD_03_A' }

describe('job palettes on the worn outfit', () => {
  it('tier I dyes MAIN / SECOND only; II adds the job trim; III its metal trim; leather and linen stay the gear', () => {
    const base = PALETTES.armour[2]!
    const t1 = jobPaletteRow(base, { job: 'trader', level: 1 })
    expect([t1.main, t1.second, t1.trim]).toEqual([JOB_PALETTES.trader[0].main, JOB_PALETTES.trader[0].second, base.trim])
    const t2 = jobPaletteRow(base, { job: 'hunter', level: 4 })
    expect(t2.trim).toBe(JOB_PALETTES.hunter[1].trim)
    const t3 = jobPaletteRow(base, { job: 'thief', level: 7 })
    expect(t3.trim).toBe(JOB_PALETTES.thief[2].trim)
    for (const r of [t1, t2, t3]) expect([r.leather, r.light]).toEqual([base.leather, base.light])
  })

  it('every job colour is dark enough to keep the folds (never a white wash) and the three jobs read apart', () => {
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
    }
    for (const tiers of Object.values(JOB_PALETTES)) for (const t of tiers) expect(lum(t.main)).toBeLessThan(0.6)
    const hue = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    // trader warm (red > blue), hunter blue (blue > red), thief dark
    expect(hue(JOB_PALETTES.trader[0].main)[0]).toBeGreaterThan(hue(JOB_PALETTES.trader[0].main)[2])
    expect(hue(JOB_PALETTES.hunter[0].main)[2]).toBeGreaterThan(hue(JOB_PALETTES.hunter[0].main)[0])
    expect(lum(JOB_PALETTES.thief[0].main)).toBeLessThan(0.2)
  })

  it('outfitFromGear in job mode: every piece carries the job; empty chest / legs / feet get plain cloth; keys apart', () => {
    const plain = outfitFromGear(ARMOUR, 'f')
    const job = outfitFromGear(ARMOUR, 'f', { job: 'trader', level: 7 })
    expect(job.pieces.every(p => p.gear.job?.job === 'trader' && p.gear.job.level === 7)).toBe(true)
    expect(job.pieces.map(p => p.piece).sort()).toEqual(plain.pieces.map(p => p.piece).sort())
    expect(outfitKey(job)).not.toBe(outfitKey(plain))
    expect(paletteKey(job.pieces[0]!.gear)).toMatch(/\|j1l7$/)
    // the Trader and the Thief never share a material (their keys differ)
    expect(paletteKey({ ...job.pieces[0]!.gear, job: { job: 'thief', level: 7 } })).not.toBe(paletteKey(job.pieces[0]!.gear))
    // the colour differs from the plain gear's
    expect(paletteLinear(job.pieces.find(p => p.piece === 'TOP')!.gear).main).not.toEqual(paletteLinear(plain.pieces.find(p => p.piece === 'TOP')!.gear).main)
    // nothing worn: the lingerie without a job, plain dyed cloth with one
    expect(outfitFromGear({}, 'f').pieces.map(p => p.piece).sort()).toEqual(['LINGERIE_BOTTOM', 'LINGERIE_TOP'])
    expect(outfitFromGear({}, 'f', { job: 'thief', level: 1 }).pieces.map(p => p.piece).sort()).toEqual(['PANTS', 'SHOES', 'TOP'])
    // the starter set (`_DEF`, every new character's) is drawn as its plain row with the suit off, never the lingerie
    // (the bug: the gear seemed gone after the suit came off, e.g. at a jailing)
    const starter = { chest: 'ITEM_CH_M_CLOTHES_01_BA_A_DEF', legs: 'ITEM_CH_M_CLOTHES_01_LA_A_DEF', feet: 'ITEM_CH_M_CLOTHES_01_FA_A_DEF' }
    expect(gearOf(starter.chest)).toMatchObject({ slot: 'chest', cls: 'garment', degree: 1, grade: 'A', seal: null })
    const off = outfitFromGear(starter, 'm', null)
    expect(off.pieces.map(p => p.piece).sort()).toEqual(['PANTS', 'SHOES', 'TOP'])
    expect(outfitKey(off)).toBe(outfitKey(outfitFromGear({ chest: 'ITEM_CH_M_CLOTHES_01_BA_A', legs: 'ITEM_CH_M_CLOTHES_01_LA_A', feet: 'ITEM_CH_M_CLOTHES_01_FA_A' }, 'm')))
    expect(outfitKey(outfitFromGear(starter, 'm', { job: 'thief', level: 1 }))).not.toBe(outfitKey(off))
    // a bad badge is ignored
    expect(outfitFromGear(ARMOUR, 'm', null).pieces.every(p => !p.gear.job)).toBe(true)
    expect(jobDyeOf({ job: 'trader', level: 99 })).toEqual({ job: 'trader', level: 7 })
  })

  it('tier III adds the twill, tier II+ a sheen on the job trim; the plain cloth keeps its degree effects', () => {
    const g = gearOf('ITEM_CH_W_CLOTHES_01_BA_A')!
    expect(clothFxOf(g)).toMatchObject({ sheen: 0, weave: 0 })
    expect(clothFxOf({ ...g, job: { job: 'hunter', level: 3 } })).toMatchObject({ weave: 0 })
    expect(clothFxOf({ ...g, job: { job: 'hunter', level: 3 } }).sheen).toBeGreaterThan(0)
    expect(clothFxOf({ ...g, job: { job: 'hunter', level: 6 } }).weave).toBeGreaterThanOrEqual(0.7)
  })
})

describe('the emblem', () => {
  // a 1 m quad facing +z at z = 0.1, uv rotated a quarter turn (u runs down the body, v to the right)
  const pos = [-0.5, 0, 0.1, 0.5, 0, 0.1, 0.5, 1, 0.1, -0.5, 1, 0.1]
  const uv = [1, 0, 1, 1, 0, 1, 0, 0]
  const idx = [0, 1, 2, 0, 2, 3]

  it('finds the spot on the cloth facing the ray and the uv → metres map of that triangle', () => {
    const a = emblemAnchor(pos, uv, idx, 0.25, 0.5, 1)!
    expect(a.u).toBeCloseTo(0.5)
    expect(a.v).toBeCloseTo(0.75)
    // a uv step back to metres: du = -1 → y + 1, dv = +1 → x + 1
    expect(a.m.map(v => Math.round(v * 1000) / 1000)).toEqual([0, 1, -1, 0])
    expect(emblemAnchor(pos, uv, idx, 2, 0.5, 1)).toBeNull()
    // from behind, the same single layer is hit
    expect(emblemAnchor(pos, uv, idx, 0, 0.5, -1)).not.toBeNull()
  })

  it('front from tier I, back from tier II; the strip columns carry the anchors, job and level', () => {
    expect(emblemSides(1)).toEqual(['front'])
    expect(emblemSides(3)).toEqual(['front', 'back'])
    const a = emblemAnchor(pos, uv, idx, 0.25, 0.5, 1)!
    const row = new Uint8Array(STRIP_W * 4)
    writeEmblem(row, { front: a, back: a }, { job: 'thief', level: 1 })
    expect(readEmblemFlags(row)).toEqual({ job: 3, level: 1, sides: 1 })
    expect(row[(EMBLEM_COL + 2) * 4]).toBe(0) // the back stays empty at tier I
    const u = (row[EMBLEM_COL * 4]! * 256 + row[EMBLEM_COL * 4 + 1]!) / 65535
    expect(u).toBeCloseTo(0.5, 4)
    const m01 = (row[(EMBLEM_COL + 1) * 4 + 1]! / 255) * 2 * EMBLEM_M_RANGE - EMBLEM_M_RANGE
    expect(m01).toBeCloseTo(1, 1)
    writeEmblem(row, { front: a, back: a }, { job: 'hunter', level: 5 })
    expect(readEmblemFlags(row)).toEqual({ job: 2, level: 5, sides: 3 })
    const none = new Uint8Array(STRIP_W * 4)
    writeEmblem(none, undefined, { job: 'trader', level: 7 })
    writeEmblem(none, { front: a }, null)
    expect([...none].every(v => v === 0)).toBe(true)
  })

  it('the outfit strip writes the emblem only on job pieces that have an anchor', () => {
    const a = emblemAnchor(pos, uv, idx, 0.25, 0.5, 1)!
    const anchors: EmblemAnchors = new Map([['TOP', { front: a }]])
    const pieces = ['PANTS', 'TOP']
    const job = outfitFromGear(ARMOUR, 'f', { job: 'trader', level: 2 })
    const st = outfitStrip(job, pieces, anchors)
    const row = (r: number) => st.subarray(r * STRIP_W * 4, (r + 1) * STRIP_W * 4)
    expect(readEmblemFlags(row(2))).toEqual({ job: 1, level: 2, sides: 1 })
    expect(readEmblemFlags(row(1)).job).toBe(0)
    expect(Array.from(row(2).subarray(0, 7 * 4))).toEqual(Array.from(stripRow(job.pieces.find(p => p.piece === 'TOP')!.gear).subarray(0, 7 * 4)))
    expect(outfitHasEmblem(job, anchors)).toBe(true)
    expect(outfitHasEmblem(outfitFromGear(ARMOUR, 'f'), anchors)).toBe(false)
    expect(outfitHasEmblem(job, new Map())).toBe(false)
  })

  it('the shader compiles the emblem only for job outfits, in both languages', () => {
    for (const lang of ['glsl', 'wgsl'] as const) {
      const c = clothCode(lang)
      expect(c.CUSTOM_FRAGMENT_DEFINITIONS).toContain('#ifdef SROJOB')
      expect(c.CUSTOM_FRAGMENT_DEFINITIONS).toContain('sroEmblem')
      expect(c.CUSTOM_FRAGMENT_UPDATE_ALPHA).toContain('#ifdef SROJOB')
      expect(c.CUSTOM_FRAGMENT_UPDATE_ALPHA).toContain(`(${EMBLEM_COL + 4}.0 + 0.5) / ${STRIP_W}.0`)
    }
    expect(clothCode('wgsl').CUSTOM_FRAGMENT_DEFINITIONS).toContain('atan2(')
  })
})

describe('retail bodies: the retail suit', () => {
  const methods: Record<string, 'REPLACE' | 'ADD'> = {
    ITEM_CH_F_TRADE_THIEF_02: 'REPLACE',
    ITEM_CH_F_TRADE_TRADER_02: 'ADD',
    ITEM_CH_W_TRADE_HUNTER_04_01: 'REPLACE',
  }
  const method = (c: string) => methods[c]
  const equip = { head: 'ITEM_CH_W_CLOTHES_01_HA_A', ...ARMOUR, earring: 'ITEM_CH_EARRING_01_A' }

  it('a REPLACE suit takes off the armour and keeps the weapon and the accessories', () => {
    const p = retailSuitPlan(equip, { job: 'thief', level: 1 }, 'f', method)
    expect(p.suit).toBe('ITEM_CH_F_TRADE_THIEF_02')
    expect(p.equip).toEqual({ chest: 'ITEM_CH_F_TRADE_THIEF_02', weapon: ARMOUR.weapon, earring: 'ITEM_CH_EARRING_01_A' })
    expect(p.extra).toEqual([])
    expect(retailSuitPlan(equip, { job: 'hunter', level: 4 }, 'f', method).equip.chest).toBe('ITEM_CH_W_TRADE_HUNTER_04_01')
  })

  it('an ADD suit (the flag, the card) comes over the worn gear', () => {
    const p = retailSuitPlan(equip, { job: 'trader', level: 2 }, 'f', method)
    expect(p.equip).toEqual(equip)
    expect(p.extra).toEqual(['ITEM_CH_F_TRADE_TRADER_02'])
  })

  it('an export without the suit rows: the worn gear alone (the label shows the job)', () => {
    const p = retailSuitPlan(equip, { job: 'trader', level: 7 }, 'm', () => undefined)
    expect(p).toEqual({ equip, extra: [], suit: null })
  })
})

describe('the name plate', () => {
  const fmt = (job: string, level: string) => `${job} · ${level}`
  it('one job line per job, the level name in it (the Hunter is the Bounty Hunter)', () => {
    expect(jobPlate({ job: 'trader', level: 1 }, fmt)).toEqual({ key: 'job-trader', text: 'TRADER · Peddler' })
    expect(jobPlate({ job: 'hunter', level: 3 }, fmt)).toEqual({ key: 'job-hunter', text: 'BOUNTY HUNTER · Bloodhound' })
    expect(jobPlate({ job: 'thief', level: 7 }, fmt)).toEqual({ key: 'job-thief', text: 'THIEF · King of the Road' })
    expect(jobPlate(null, fmt)).toBeNull()
  })

  it('a change of job leaves no old line behind; out of job mode clears it', () => {
    const lines = new Map<string, string>()
    const v = { setLabelLine: (k: string, t: string | null) => (t === null ? lines.delete(k) : lines.set(k, t)) }
    applyJobPlate(v, { job: 'hunter', level: 2 })
    expect([...lines.keys()]).toEqual(['job-hunter'])
    applyJobPlate(v, { job: 'thief', level: 2 })
    expect([...lines.keys()]).toEqual(['job-thief'])
    applyJobPlate(v, null)
    expect(lines.size).toBe(0)
    expect(JOB_PLATE_KEYS).toEqual(['job-trader', 'job-hunter', 'job-thief'])
  })
})

describe('transports: the goods by stars', () => {
  it('every trade transport has its spots; more stars, more bundles; empty shows none', () => {
    for (const code of ['COS_T_DONKEY', 'COS_T_HORSE1', 'COS_T_HORSE2', 'COS_T_DHORSE1']) expect(TRANSPORT_LOAD[code]?.spots.length).toBe(10)
    // a light load is one small bundle, a full one ten big ones piled high (they read apart at a glance)
    expect([0, 1, 2, 3, 4, 5].map(s => bundleCount(s, 10))).toEqual([0, 1, 3, 5, 7, 10])
    expect([0, 1, 2, 3, 4, 5].map(s => bundleCount(s, 6))).toEqual([0, 1, 2, 3, 4, 6])
    expect(bundleScale(5) / bundleScale(1)).toBeGreaterThan(1.6)
    for (let s = 1; s < 5; s++) expect(bundleScale(s + 1)).toBeGreaterThan(bundleScale(s))
    const top = (n: number) => Math.max(...TRANSPORT_LOAD.COS_T_DONKEY!.spots.slice(0, n).map(p => p.y))
    expect(top(bundleCount(5, 10))).toBeGreaterThan(top(bundleCount(1, 10)) + 0.3)
    expect(bundleCount(9, 6)).toBe(6)
    expect(bundleCount(3, 0)).toBe(0)
  })
})

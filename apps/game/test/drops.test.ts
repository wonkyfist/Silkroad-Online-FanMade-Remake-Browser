/**
 * Ground items (docs/EFFECTS.md §3.6, §6.5; lane FX-C2): the drop model per item (gold by amount), the seeded yaw,
 * fresh vs old drops (the toss from `dropFrom`), the arc, and the exported drop models on disk. NullEngine; the model
 * loads fail in node (no fetch of /out/), so a DropVisual falls back to its box, which is enough for the toss.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NullEngine, Scene } from '@babylonjs/core'
import type { ItemDef } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DropAssets, dropModelOf, DropVisual, dropYaw, isFreshDrop, QUEST_DROP, TOSS_APEX_M, TOSS_FRESH_MS, TOSS_FROM_UP_M, TOSS_MS, tossOffset } from '../src/world/drops.ts'
import { readParticles } from '../src/world/fx/model-particles.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const OUT = join(ROOT, 'work', 'out')

let engine: NullEngine
let scene: Scene

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterAll(() => {
  scene.dispose()
  engine.dispose()
  vi.restoreAllMocks()
})

const def = (code: string, dropGlb: string | null): ItemDef =>
  ({ code, name: code, category: 'etc', dropModel: dropGlb ? { bsr: '', glb: dropGlb, sidecar: dropGlb.replace(/\.glb$/, '.json') } : null }) as unknown as ItemDef

describe('drop models', () => {
  it('uses the item\'s own drop model, and the quest bundle when it has none', () => {
    const m = dropModelOf(def('ITEM_ETC_GOLD_02', '/out/item/etc/drop_ch_money_normal.glb'))
    expect(m.glb).toBe('/out/item/etc/drop_ch_money_normal.glb')
    expect(m.sidecar).toBe('/out/item/etc/drop_ch_money_normal.json')
    expect(dropModelOf(def('ITEM_BANDIT_LEDGER', null))).toBe(QUEST_DROP)
    expect(dropModelOf(undefined)).toBe(QUEST_DROP)
  })

  it('the yaw is seeded by the entity id: the same on every client, spread over the circle', () => {
    expect(dropYaw(1234)).toBe(dropYaw(1234))
    const yaws = Array.from({ length: 200 }, (_, i) => dropYaw(i + 1))
    for (const y of yaws) {
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThan(Math.PI * 2)
    }
    // Neighbouring ids do not lie in a row.
    expect(new Set(yaws.map(y => Math.floor(y / (Math.PI / 4)))).size).toBe(8)
  })
})

describe('the toss', () => {
  it('fresh = the spawn arrived within TOSS_FRESH_MS of droppedAt; no droppedAt = on the ground already', () => {
    expect(isFreshDrop(10_000, 10_200)).toBe(true)
    expect(isFreshDrop(10_000, 10_000 + TOSS_FRESH_MS + 1)).toBe(false)
    expect(isFreshDrop(undefined, 10_000)).toBe(false)
  })

  it('the arc starts at the throw point, lands on the spot, and rises TOSS_APEX_M over the line at half way', () => {
    const from: [number, number, number] = [1, 0.8, -2]
    expect(tossOffset(0, from)).toEqual([1, 0.8, -2])
    expect(tossOffset(1, from)).toEqual([0, 0, 0])
    const mid = tossOffset(0.5, from)
    expect(mid[0]).toBeCloseTo(0.5)
    expect(mid[1]).toBeCloseTo(0.4 + TOSS_APEX_M)
    expect(tossOffset(2, from)).toEqual([0, 0, 0])
  })

  it('a fresh drop flies from the corpse (+TOSS_FROM_UP_M) to its spot in TOSS_MS; an old one lies still', () => {
    const assets = new DropAssets(scene)
    const fresh = new DropVisual(assets, false, def('ITEM_CH_SWORD_01_A', null))
    fresh.place({ id: 5, now: 50_100, droppedAt: 50_000, from: [10, 2, 10], at: [11, 2, 12] })
    expect(fresh.tossing).toBe(true)
    const body = fresh.root.getChildren()[0]!
    const p0 = (body as unknown as { position: { x: number; y: number; z: number } }).position
    expect([p0.x, p0.y, p0.z]).toEqual([-1, TOSS_FROM_UP_M, -2])
    expect((body as unknown as { rotation: { y: number } }).rotation.y).toBeCloseTo(dropYaw(5))
    fresh.update(TOSS_MS / 2000)
    expect(fresh.tossing).toBe(true)
    fresh.update(TOSS_MS / 1000)
    expect(fresh.tossing).toBe(false)
    expect([p0.x, p0.y, p0.z]).toEqual([0, 0, 0])

    const old = new DropVisual(assets, true, def('ITEM_ETC_GOLD_01', null))
    old.place({ id: 6, now: 90_000, droppedAt: 50_000, from: [10, 2, 10], at: [11, 2, 12] })
    expect(old.tossing).toBe(false)
    const mine = new DropVisual(assets, false, def('ITEM_ETC_HP_POTION_01', null))
    // A player's own drop (no dropFrom): no toss.
    mine.place({ id: 7, now: 50_100, droppedAt: 50_000, at: [11, 2, 12] })
    expect(mine.tossing).toBe(false)
    for (const d of [fresh, old, mine]) d.dispose()
    expect(fresh.root.isDisposed()).toBe(true)
    assets.dispose()
  })
})

describe.runIf(existsSync(join(OUT, 'data', 'items.json')))('exported drop models', () => {
  const items = (JSON.parse(readFileSync(join(OUT, 'data', 'items.json'), 'utf8')) as { entries: ItemDef[] }).entries

  it('gold piles by amount: GOLD_01 small, GOLD_02 normal, GOLD_03 large', () => {
    const glb = (code: string) => dropModelOf(items.find(i => i.code === code)).glb
    expect(glb('ITEM_ETC_GOLD_01')).toBe('/out/item/etc/drop_ch_money_small.glb')
    expect(glb('ITEM_ETC_GOLD_02')).toBe('/out/item/etc/drop_ch_money_normal.glb')
    expect(glb('ITEM_ETC_GOLD_03')).toBe('/out/item/etc/drop_ch_money_large.glb')
  })

  it('every item\'s drop model (and the quest bundle) is on disk, with its sparkle where retail has one', () => {
    const models = new Set([...items.map(i => dropModelOf(i).glb), QUEST_DROP.glb])
    for (const m of models) expect(existsSync(join(OUT, m.replace(/^\/out\//, ''))), m).toBe(true)
    const particles = (name: string) => readParticles(JSON.parse(readFileSync(join(OUT, 'item', 'etc', `${name}.json`), 'utf8'))).map(p => p.efp)
    expect(particles('drop_ch_money_small')).toEqual(['system/item_drop_money.efp'])
    expect(particles('drop_ch_equip')).toEqual(['system/item_drop_equip.efp', 'system/item_drop_acc.efp'])
    expect(particles('drop_ch_bag')).toEqual(['system/item_drop_use.efp'])
    expect(particles('drop_ch_money_large')).toEqual([])
    for (const efp of ['item_drop_money', 'item_drop_equip', 'item_drop_acc', 'item_drop_use']) {
      expect(existsSync(join(OUT, 'fx', 'efp', 'system', `${efp}.json`)), efp).toBe(true)
    }
  })
})

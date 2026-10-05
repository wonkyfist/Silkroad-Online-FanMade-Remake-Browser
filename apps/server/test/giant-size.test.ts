/**
 * Giants are drawn at twice their mob's size (@sro/shared VARIANT_SCALE; the client scales the model, label and pick),
 * and the server's body radius follows, so melee reaches the edge of what the player sees. Champions keep the size.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VARIANT_SCALE, variantScale } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { FlatNav } from '../src/nav.ts'
import { World } from '../src/world.ts'
import { DROPS, ITEMS, LEVELS, NPCS, SHOPS, TIGER } from './fixtures.ts'
import { testConfig } from './helpers.ts'

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

function gameplay(): Gameplay {
  const root = mkdtempSync(join(tmpdir(), 'sro-giant-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const config = testConfig(root)
  const store = openStore(config.dataDir)
  // Closed before the folder goes: Windows can't delete an open database.
  cleanups.push(() => store.close())
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  const data = new GameData({ mobs: [TIGER], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: NPCS, shops: SHOPS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  return new Gameplay({ world, data, store, config, setup, nav })
}

describe('giant size', () => {
  it('a giant is twice its mob; normal, champion and unique keep the size', () => {
    expect(VARIANT_SCALE.giant).toBe(2)
    expect(variantScale('giant')).toBe(2)
    for (const v of ['normal', 'champion', 'unique', 'elite', 'party', undefined] as const) expect(variantScale(v)).toBe(1)
  })

  it('the server gives a giant twice the body radius, so melee reaches the drawn edge', () => {
    const g = gameplay()
    const now = Date.now()
    const normal = g.createMob(TIGER, 'normal', 10, 10, 0, null, now)
    const champion = g.createMob(TIGER, 'champion', 20, 10, 0, null, now)
    const giant = g.createMob(TIGER, 'giant', 30, 10, 0, null, now)
    expect(champion.radius).toBe(normal.radius)
    expect(giant.radius).toBeCloseTo(normal.radius * 2, 6)
  })
})

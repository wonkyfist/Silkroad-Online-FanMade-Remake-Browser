import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_COORD, type ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { FailureLimiter, TokenBucket, hashPassword, verifyPassword } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { cleanChat } from '../src/connection.ts'
import { CharacterModels, FALLBACK_CHARACTER_MODELS, extractModels, resolveWorld } from '../src/content.ts'
import { World } from '../src/world.ts'

const dirs: string[] = []
function tmp(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sro-unit-'))
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const manifest = (m: unknown) => ({ 'world/jangan/manifest.json': JSON.stringify(m) })

describe('resolveWorld', () => {
  it('prefers SPAWN_X/SPAWN_Z, then the manifest spawn', () => {
    const out = tmp(manifest({ spawn: { x: 10, y: 3, z: -20 } }))
    expect(resolveWorld(out, 'jangan', { x: 1, z: 2 }).spawn).toEqual({ x: 1, y: 0, z: 2 })
    const w = resolveWorld(out, 'jangan', null)
    expect(w.spawn).toEqual({ x: 10, y: 3, z: -20 })
    expect(w.displayName).toBe('Jangan')
  })

  it('falls back to 0,0 without a manifest', () => {
    const w = resolveWorld(tmp(), 'jangan', null)
    expect(w.spawn).toEqual({ x: 0, y: 0, z: 0 })
    expect(w.bounds).toBeNull()
  })

  it('uses the centre of the centre region from per-region bounds', () => {
    const regions = []
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) regions.push({ x: 100 + x, z: 50 + z, bounds: { min: [x * 192, 0, -z * 192 - 192], max: [x * 192 + 192, 0, -z * 192] } })
    const w = resolveWorld(tmp(manifest({ regions })), 'jangan', null)
    expect(w.spawn).toEqual({ x: 192 + 96, y: 0, z: -192 - 96 })
    expect(w.bounds).toEqual({ minX: 0, minZ: -576, maxX: 576, maxZ: 0 })
  })

  it('applies the origin rule for regions given only by grid coords / region id', () => {
    const regions = [{ id: (97 << 8) | 168 }, { id: (97 << 8) | 169 }, { id: (98 << 8) | 168 }, { id: (98 << 8) | 169 }, { id: (97 << 8) | 167 }]
    const w = resolveWorld(tmp(manifest({ origin: [168, 97], regions })), 'jangan', null)
    // median x = 168, z = 97 -> region (168, 97) spans x 0..192, z -192..0
    expect(w.spawn).toEqual({ x: 96, y: 0, z: -96 })
    expect(w.spawnSource).toContain('168,97')
  })

  it('uses the manifest bounds centre when there is nothing better', () => {
    const w = resolveWorld(tmp(manifest({ bounds: { minX: -100, minZ: -50, maxX: 100, maxZ: 150 } })), 'jangan', null)
    expect(w.spawn).toEqual({ x: 0, y: 0, z: 50 })
  })

  it('survives a corrupt manifest', () => {
    const out = tmp({ 'world/jangan/manifest.json': '{oops' })
    expect(resolveWorld(out, 'jangan', null).spawn).toEqual({ x: 0, y: 0, z: 0 })
  })
})

describe('character models', () => {
  it('always allows the two adventurers and nothing else without data', () => {
    const m = new CharacterModels(tmp())
    expect(m.list()).toEqual(FALLBACK_CHARACTER_MODELS)
    expect(m.allowed('CHAR_CH_MAN_ADVENTURER')).toBe(true)
    expect(m.allowed('CHAR_CH_MAN_WARRIOR')).toBe(false)
  })

  it('adds Chinese player models found in the converter index', () => {
    const index = [
      { id: 'char/china/chinaman_warrior', glb: 'x.glb' },
      { id: 'char/china/chinawoman_fox', glb: 'x.glb' },
      { id: 'char/europe/europeman_adventurer', glb: 'x.glb' },
      { id: 'char/china/chinaman_notaplayer', glb: 'x.glb' },
      { id: 'mob/china/tiger', glb: 'x.glb' },
    ]
    const m = new CharacterModels(tmp({ 'index.json': JSON.stringify(index) }))
    expect(m.list().sort()).toEqual(['CHAR_CH_MAN_ADVENTURER', 'CHAR_CH_MAN_WARRIOR', 'CHAR_CH_WOMAN_ADVENTURER', 'CHAR_CH_WOMAN_FOX'])
  })

  it('reads characters.json and reloads it when it changes', () => {
    const out = tmp({ 'data/characters.json': JSON.stringify(['CHAR_CH_MAN_WARRIOR', 'CHAR_EU_MAN_NOBLE']) })
    const m = new CharacterModels(out)
    expect(m.allowed('CHAR_CH_MAN_WARRIOR')).toBe(true)
    expect(m.allowed('CHAR_EU_MAN_NOBLE')).toBe(false)
    writeFileSync(join(out, 'data/characters.json'), JSON.stringify({ characters: [{ codeName: 'CHAR_CH_WOMAN_WARRIOR' }] }))
    const later = new Date(Date.now() + 5000)
    utimesSync(join(out, 'data/characters.json'), later, later)
    expect(m.allowed('CHAR_CH_MAN_WARRIOR')).toBe(false)
    expect(m.allowed('CHAR_CH_WOMAN_WARRIOR')).toBe(true)
  })

  it('accepts several shapes and honours selectable flags', () => {
    expect(extractModels(['CHAR_CH_MAN_MONK', 'bad', 'MOB_CH_TIGER', 'CHAR_CH_CUSTOM'])).toEqual(['CHAR_CH_MAN_MONK'])
    expect(extractModels([{ id: 'CHAR_CH_CUSTOM', selectable: true }, { codeName128: 'CHAR_CH_MAN_MONK', playable: false }])).toEqual(['CHAR_CH_CUSTOM'])
    expect(extractModels({ models: [{ code: 'CHAR_CH_MAN_MONK' }] })).toEqual(['CHAR_CH_MAN_MONK'])
    expect(extractModels({ items: { CHAR_CH_WOMAN_FOX: { glb: 'a.glb' } } })).toEqual(['CHAR_CH_WOMAN_FOX'])
    expect(extractModels({ CHAR_CH_MAN_MONK: { glb: 'char/x.glb' }, CHAR_EU_MAN_NOBLE: { selectable: true } })).toEqual(['CHAR_CH_MAN_MONK'])
  })
})

describe('World', () => {
  function setup() {
    const sent: ServerMessage[] = []
    const w = new World('jangan', 10, 10, { minX: -100, minZ: -100, maxX: 100, maxZ: 100 })
    const p = w.add({ characterId: 1, name: 'A', model: 'M', level: 1, weapon: 'bow', pos: [0, 0, 0], yaw: 0, send: (m) => sent.push(m) })
    return { w, p, sent }
  }

  it('moves in a straight line at the configured speed and stops on arrival', () => {
    const { w, p, sent } = setup()
    w.moveTo(p, 0, 50, 1000)
    expect(sent.pop()).toEqual({ t: 'move', id: p.id, move: { from: [0, 0, 0], to: [0, 0, 50], speed: 10, startedAt: 1000 } })
    expect(p.yaw).toBe(0)
    expect(w.positionAt(p, 3000)).toEqual([0, 0, 20])
    w.tick(5999)
    expect(sent).toHaveLength(0)
    w.tick(6000)
    expect(sent.pop()).toEqual({ t: 'stop', id: p.id, pos: [0, 0, 50], yaw: 0 })
    expect(p.move).toBeNull()
  })

  it('clamps targets to bounds and treats a zero-length move as a stop', () => {
    const { w, p, sent } = setup()
    w.moveTo(p, 1000, -1000, 0)
    expect(p.move?.to).toEqual([100, 0, -100])
    expect(p.yaw).toBeCloseTo(Math.atan2(1, -1))
    const at = w.positionAt(p, 1000)
    w.moveTo(p, at[0], at[2], 1000)
    expect(sent.pop()).toMatchObject({ t: 'stop', id: p.id })
    expect(p.move).toBeNull()
  })

  it('lets the navmesh hook shorten or refuse a move', () => {
    const w = new World('jangan', 10, 10, null, (from, to) => (to[0] > 10 ? null : [to[0] / 2, to[1], to[2] / 2]))
    const p = w.add({ characterId: 1, name: 'A', model: 'M', level: 1, weapon: 'bow', pos: [0, 0, 0], yaw: 0, send: () => {} })
    w.moveTo(p, 8, 8, 0)
    expect(p.move?.to).toEqual([4, 0, 4])
    w.moveTo(p, 50, 0, 100)
    expect(p.move).toBeNull()
  })

  it('broadcasts spawn to others and despawn on remove', () => {
    const { w, sent } = setup()
    const other: ServerMessage[] = []
    const q = w.add({ characterId: 2, name: 'B', model: 'M', level: 1, weapon: 'bow', pos: [1, 0, 1], yaw: 0, send: (m) => other.push(m) })
    expect(sent.pop()).toMatchObject({ t: 'spawn', entity: { id: q.id, name: 'B' } })
    expect(other).toHaveLength(0)
    w.remove(q.id)
    expect(sent.pop()).toEqual({ t: 'despawn', id: q.id })
  })

  it('warp clamps to the bounds (or to MAX_COORD without bounds) and refuses non-finite positions', () => {
    const { w, p, sent } = setup()
    expect(w.warp(p, 1e9, 3, -1e9)).toEqual([100, 3, -100])
    expect(sent.pop()).toEqual({ t: 'warp', id: p.id, pos: [100, 3, -100], yaw: 0 })
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => w.warp(p, bad, 0, 0)).toThrow()
      expect(() => w.warp(p, 0, bad, 0)).toThrow()
    }
    expect(p.pos).toEqual([100, 3, -100])
    const open = new World('jangan', 10, 10, null)
    const q = open.add({ characterId: 2, name: 'B', model: 'M', level: 1, weapon: 'bow', pos: [0, 0, 0], yaw: 0, send: () => {} })
    expect(open.warp(q, 1e300, 0, -1e300)).toEqual([MAX_COORD, 0, -MAX_COORD])
  })
})

describe('misc', () => {
  it('hashes passwords with a per-user salt and verifies them', async () => {
    const a = await hashPassword('secret1')
    const b = await hashPassword('secret1')
    expect(a).not.toBe(b)
    expect(a.startsWith('scrypt$32768$8$1$')).toBe(true)
    expect(await verifyPassword('secret1', a)).toBe(true)
    expect(await verifyPassword('secret2', a)).toBe(false)
    expect(await verifyPassword('secret1', null)).toBe(false)
  })

  it('rate limiters', () => {
    const f = new FailureLimiter(2, 1000)
    f.fail('k', 0)
    expect(f.blocked('k', 1)).toBe(false)
    f.fail('k', 2)
    expect(f.blocked('k', 3)).toBe(true)
    expect(f.blocked('k', 1001)).toBe(false)
    const b = new TokenBucket(1, 2, 0)
    expect([b.take(0), b.take(0), b.take(0), b.take(1000)]).toEqual([true, true, false, true])
  })

  it('strips control and bidi characters from chat', () => {
    expect(cleanChat(' a\u0000b\u001bc\u007f\u0085d‮e⁦f ')).toBe('abcdef')
    expect(cleanChat('안녕 你好 😀')).toBe('안녕 你好 😀')
  })

  it('loads config from env with defaults', () => {
    const c = loadConfig({})
    expect(c).toMatchObject({ port: 7000, host: '127.0.0.1', world: 'jangan', moveSpeed: 5.5, tickHz: 10, spawn: null, serveStatic: false })
    expect(c.dataDir.replace(/\\/g, '/')).toMatch(/work\/server$/)
    expect(c.outDir.replace(/\\/g, '/')).toMatch(/work\/out$/)
    expect(c.gameDist.replace(/\\/g, '/')).toMatch(/apps\/game\/dist$/)
    const p = loadConfig({ NODE_ENV: 'production', PORT: '8080', SPAWN_X: '12.5', SPAWN_Z: '-3', MOVE_SPEED: '7' })
    expect(p).toMatchObject({ port: 8080, host: '0.0.0.0', spawn: { x: 12.5, z: -3 }, moveSpeed: 7, serveStatic: true, corsOrigin: '' })
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/)
    expect(() => loadConfig({ WORLD: '../etc' })).toThrow(/WORLD/)
  })
})

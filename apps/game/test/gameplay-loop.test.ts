/**
 * The whole ?mock=1 gameplay loop, driven the way the browser drives it: the net layer (Session over the mock
 * Wire), the world's intent builders, the HUD's intent builders and inventory state, and the GM window's command
 * builders. Babylon is not involved. Runs once with the builtin stand-in content and once with the real data
 * export (work/out/data), when it exists, because that is what the dev server serves to ?mock=1.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CONTENT_FILES,
  NPC_INTERACT_RANGE,
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type ContentKind,
  type EntityState,
  type PlayerStats,
  type ServerMessage,
} from '@sro/shared'
import { builtinTables, mergeTables, type ContentTables } from '../src/content/gameplay.ts'
import { gm, type GmBuild } from '../src/gm/commands.ts'
import { actionFailText } from '../src/hud/index.ts'
import { dragIntent, intent, useIntent } from '../src/hud/intents.ts'
import { InventoryState } from '../src/hud/inventory-state.ts'
import { ItemCatalog } from '../src/hud/items.ts'
import { MockServer, type KeyValueStore } from '../src/net/mock.ts'
import { Session } from '../src/net/session.ts'
import { hitKind } from '../src/screens/world.ts'
import { intents } from '../src/world/intents.ts'

const DATA_DIR = fileURLToPath(new URL('../../../work/out/data/', import.meta.url))
const KINDS: ContentKind[] = ['mobs', 'items', 'drops', 'npcs', 'shops', 'levels']

function exportedTables(): ContentTables | null {
  if (!existsSync(join(DATA_DIR, CONTENT_FILES.mobs))) return null
  const files: Partial<Record<ContentKind, unknown>> = {}
  for (const kind of KINDS) {
    const file = join(DATA_DIR, CONTENT_FILES[kind])
    if (existsSync(file)) files[kind] = JSON.parse(readFileSync(file, 'utf8'))
  }
  return mergeTables(builtinTables(), files)
}

function memory(): KeyValueStore {
  const m = new Map<string, string>()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0))
}

function gmMsg(b: GmBuild): ClientMessage {
  if (!b.ok) throw new Error(b.error)
  return b.msg
}

const exported = exportedTables()
const variants: [string, () => ContentTables][] = [['builtin content', builtinTables]]
if (exported) variants.push(['exported content (work/out/data)', () => exported])

describe.each(variants)('mock gameplay loop with %s', (_label, tables) => {
  it('plays select, attack, kill, EXP, level-up, loot, equip, death, respawn and GM commands with valid frames', async () => {
    let now = 2_000_000_000
    const server = new MockServer(memory(), 0, () => now)
    server.content = tables()
    server.gmRole = 'gm'
    const content = server.content
    await server.register({ username: 'looper', password: 'secret' })
    const { token } = await server.login({ username: 'looper', password: 'secret' })

    const sent: ClientMessage[] = []
    const s = new Session(() => {
      const w = server.wire()
      const inner = w.send.bind(w)
      w.send = msg => {
        sent.push(msg)
        inner(msg)
      }
      return w
    }, token)
    const log: ServerMessage[] = []
    // The HUD's client-side state, fed exactly like the HUD feeds it.
    const inv = new InventoryState()
    const items = new ItemCatalog([...content.items.values()])
    let stats: PlayerStats | null = null
    s.on(m => {
      log.push(m)
      if (m.t === 'inventory') inv.setSnapshot(m.inventory)
      if (m.t === 'inventoryUpdate') {
        inv.apply(m)
        inv.apply(m) // the world forwards it too: must be idempotent
      }
      if (m.t === 'stats') stats = m.stats
      if (m.t === 'statsDelta' && stats) stats = { ...stats, ...m.stats }
    })
    await s.connect()
    const { character } = await s.request({ t: 'charCreate', name: 'Looper', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' }, ['charCreated'])

    const find = <T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, from = 0) =>
      log.slice(from).find(m => m.t === t && pred(m as Extract<ServerMessage, { t: T }>)) as Extract<ServerMessage, { t: T }> | undefined
    const until = async <T>(get: () => T | undefined, what: string, steps = 4000): Promise<T> => {
      for (let i = 0; i < steps; i++) {
        const v = get()
        if (v !== undefined && v !== false) return v
        now += 100
        server.step()
        await flush()
      }
      throw new Error(`timed out: ${what}`)
    }
    const send = async (msg: ClientMessage | null) => {
      if (!msg) throw new Error('no message to send')
      s.send(msg)
      await flush()
    }
    const result = async (msg: ClientMessage | null) => {
      const from = log.length
      await send(msg)
      return until(() => find('actionResult', m => m.re === msg!.t, from), `actionResult ${msg!.t}`)
    }
    const gmRun = async (b: GmBuild) => {
      const msg = gmMsg(b)
      const from = log.length
      await send(msg)
      return until(() => find('gmResult', m => m.cmd === (msg as { cmd: string }).cmd, from), `gm ${(msg as { cmd: string }).cmd}`)
    }

    // ---- enter: worldEnter -> stats -> inventory, a potion merchant next to the spawn --------------
    await send(intents.enterWorld(character.id))
    const enter = await until(() => find('worldEnter'), 'worldEnter')
    const me = enter.self.id
    expect(inv.known).toBe(true)
    expect(stats).not.toBeNull()
    const npc = enter.entities.find(e => e.kind === 'npc')!
    expect(npc, 'a shop NPC in the mock world').toBeDefined()
    expect(Math.hypot(npc.pos[0] - enter.self.pos[0], npc.pos[2] - enter.self.pos[2])).toBeLessThan(NPC_INTERACT_RANGE)
    expect(content.npcs.get(npc.model)?.shop).toBeTruthy()
    const buy = await result({ t: 'shopBuy', npc: npc.id, item: 'ITEM_ETC_HP_POTION_01', count: 1 })
    expect(buy.ok, actionFailText(buy.reason)).toBe(true)

    // ---- farm Mangnyangs from the nests until a level-up and some owned loot ---------------------
    const mobs = () => server.snapshotEntities().filter(e => e.kind === 'mob' && e.model === 'MOB_CH_MANGNYANG' && e.state !== 'dead')
    const myPos = () => server.snapshotEntities().find(e => e.id === me)!.pos
    let kills = 0
    let hitsSeen = 0
    const lootIds = new Set<number>()
    for (let round = 0; round < 25 && !(find('levelUp', m => m.id === me) && lootIds.size); round++) {
      if (stats!.hp < stats!.maxHp * 0.5) {
        const potion = inv.bag.findIndex(b => b?.code === 'ITEM_ETC_HP_POTION_01')
        if (potion >= 0) {
          const used = await result(useIntent(inv, items, potion))
          if (!used.ok) expect(used.reason).toBe('cooldown')
        }
      }
      const p = myPos()
      const target = mobs().sort((a, b) => Math.hypot(a.pos[0] - p[0], a.pos[2] - p[2]) - Math.hypot(b.pos[0] - p[0], b.pos[2] - p[2]))[0]
      if (!target) {
        await until(() => mobs().length > 0 || undefined, 'a Mangnyang respawn')
        continue
      }
      const from = log.length
      const attack = await result(intents.attack(target.id))
      expect(attack.ok, actionFailText(attack.reason)).toBe(true)
      const kill = await until(() => find('combat', m => m.target === target.id && !!m.killed, from) ?? (find('entityUpdate', m => m.id === me && m.state === 'dead', from) ? null : undefined), 'kill')
      expect(kill, 'died while farming Mangnyangs').not.toBeNull()
      kills++
      for (const c of log.slice(from)) {
        if (c.t !== 'combat') continue
        if (c.attacker === me) {
          hitsSeen += c.hits.length
          expect(c.hits.length).toBeLessThanOrEqual(2)
          for (const h of c.hits) expect(['hit', 'crit', 'miss', 'block']).toContain(hitKind(h, false))
        } else if (c.target === me) for (const h of c.hits) expect(['taken', 'miss', 'block']).toContain(hitKind(h, true))
      }
      expect(find('entityUpdate', m => m.id === target.id && m.state === 'dead', from)).toBeDefined()
      const gain = find('statsDelta', m => m.gain?.from === target.id, from)
      expect(gain?.gain?.exp).toBeGreaterThan(0)
      for (const sp of log.slice(from)) if (sp.t === 'spawn' && sp.entity.kind === 'item' && sp.entity.owner === me) lootIds.add(sp.entity.id)
    }
    expect(kills).toBeGreaterThan(1)
    expect(hitsSeen).toBeGreaterThan(kills)
    const lvl = find('levelUp', m => m.id === me)
    expect(lvl, 'level-up after farming').toBeDefined()
    expect(find('entityUpdate', m => m.id === me && m.level === lvl!.level)).toBeDefined()
    expect(stats!.level).toBe(lvl!.level)
    expect(stats!.statPoints).toBeGreaterThan(0)

    // ---- loot: every owned drop is picked up (gold or bag), the entity despawns ---------------------
    expect(lootIds.size, 'loot dropped').toBeGreaterThan(0)
    for (const id of lootIds) {
      const spawn = find('spawn', m => m.entity.id === id)!.entity
      expect(spawn).toMatchObject({ kind: 'item', level: 0 })
      expect(spawn.ownerUntil).toBeGreaterThan(0)
      expect(spawn.expiresAt).toBeGreaterThan(spawn.ownerUntil!)
      const goldBefore = inv.gold
      const totalBefore = inv.totals().get(spawn.model) ?? 0
      const r = await result(intents.pickup(id))
      expect(r.ok, actionFailText(r.reason)).toBe(true)
      await until(() => find('despawn', m => m.id === id), 'loot despawn')
      await flush()
      if (/^ITEM_ETC_GOLD_/.test(spawn.model)) expect(inv.gold).toBe(goldBefore + spawn.count!)
      else expect(inv.totals().get(spawn.model)).toBe(totalBefore + spawn.count!)
    }

    // ---- stat points and equipment via the HUD's intents ------------------------------------------
    expect((await result(intent.statUp('str', 1))).ok).toBe(true)
    const robe = inv.bag.findIndex(b => !!b && items.slotKind(b.code) === 'chest')
    expect(robe).toBeGreaterThanOrEqual(0)
    const robeCode = inv.bag[robe]!.code
    expect((await result(useIntent(inv, items, robe))).ok).toBe(true) // right click = itemEquip
    expect(inv.equipped('chest')?.code).toBe(robeCode)
    expect(find('appearance', m => m.id === me && m.equip.chest === robeCode)).toBeDefined()
    const sword = inv.bag.findIndex(b => b?.code === 'ITEM_CH_SWORD_01_A_DEF')
    const drag = dragIntent(inv, items, { kind: 'bag', slot: sword }, { kind: 'equip', slot: 'weapon' })
    expect(drag).toMatchObject({ t: 'itemEquip', bag: sword, slot: 'weapon' })
    expect((await result(drag as ClientMessage)).ok).toBe(true)
    expect(inv.equipped('weapon')?.code).toBe('ITEM_CH_SWORD_01_A_DEF')
    expect(inv.item(sword)?.code).toBe('ITEM_CH_BLADE_01_A_DEF')
    expect(dragIntent(inv, items, { kind: 'bag', slot: sword }, { kind: 'equip', slot: 'head' })).toBe('nofit')
    const free = inv.freeSlot()
    const back = dragIntent(inv, items, { kind: 'equip', slot: 'chest' }, { kind: 'bag', slot: free })
    expect(back).toEqual({ t: 'itemUnequip', slot: 'chest', bag: free })
    expect((await result(back as ClientMessage)).ok).toBe(true)
    expect(inv.item(free)?.code).toBe(robeCode)

    // ---- GM: spawn / item / kill / heal (the GM window's builders) ---------------------------------
    const spawned = await gmRun(gm.spawn('MOB_CH_MANGNYANG', '2'))
    expect(spawned.ok, spawned.message).toBe(true)
    const ids = (spawned.data as { ids: number[] }).ids
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(find('spawn', m => m.entity.id === id)?.entity.model).toBe('MOB_CH_MANGNYANG')
    const given = await gmRun(gm.item('ITEM_ETC_HP_POTION_01', '7'))
    expect(given.ok, given.message).toBe(true)
    expect((given.data as { bag: unknown[] }).bag.length).toBeGreaterThan(0)
    const goldBefore = inv.gold
    expect((await gmRun(gm.item('ITEM_ETC_GOLD_01', '1000'))).ok).toBe(true)
    await flush()
    expect(inv.gold).toBe(goldBefore + 1000)
    const killed = await gmRun(gm.kill(String(ids[0])))
    expect(killed.ok, killed.message).toBe(true)
    expect(find('entityUpdate', m => m.id === ids[0] && m.state === 'dead')).toBeDefined()
    expect(find('statsDelta', m => m.gain?.from === ids[0])).toBeUndefined() // no EXP for GM kills

    // ---- death and respawn -------------------------------------------------------------------------
    const deathFrom = log.length
    expect((await gmRun(gm.kill(String(me)))).ok).toBe(true)
    await until(() => find('entityUpdate', m => m.id === me && m.state === 'dead', deathFrom), 'own death')
    expect((await result(intents.attack(ids[1]!))).reason).toBe('dead')
    expect((await result(intent.itemUse(0))).reason).toBe('dead')
    const rFrom = log.length
    expect((await result(intent.respawn())).ok).toBe(true)
    expect(find('warp', m => m.id === me, rFrom)).toBeDefined()
    expect(find('entityUpdate', m => m.id === me && m.state === 'alive', rFrom)).toBeDefined()
    expect(stats!.hp).toBe(stats!.maxHp)
    expect((await result(intent.respawn())).reason).toBe('not_dead')
    // GM heal also revives in place.
    expect((await gmRun(gm.kill(String(me)))).ok).toBe(true)
    await until(() => find('entityUpdate', m => m.id === me && m.state === 'dead', rFrom), 'second death')
    const hFrom = log.length
    expect((await gmRun(gm.heal())).ok).toBe(true)
    expect(find('entityUpdate', m => m.id === me && m.state === 'alive', hFrom)).toBeDefined()

    // ---- the HUD's inventory, built from deltas, matches a fresh server snapshot -----------------------
    await s.request(intents.leaveWorld(), ['worldLeft'])
    const snapFrom = log.length
    await send(intents.enterWorld(character.id))
    const fresh = await until(() => find('inventory', () => true, snapFrom), 'second inventory')
    const local = { bagSize: inv.bagSize, bag: inv.bag, equip: inv.equip, gold: inv.gold }
    expect(local).toEqual(JSON.parse(JSON.stringify(fresh.inventory)))

    // ---- protocol conformance ----------------------------------------------------------------------
    for (const m of log) {
      const r = parseServerMessage(JSON.stringify(m))
      expect(r.ok, `${m.t}: ${r.ok ? '' : r.error}`).toBe(true)
    }
    for (const m of sent) {
      const r = parseClientMessage(JSON.stringify(m))
      expect(r.ok, `${m.t}: ${r.ok ? '' : r.error}`).toBe(true)
    }
    expect(log.some(m => m.t === 'error')).toBe(false)
    s.close()
  })
})

describe('mock world content', () => {
  it.each(variants)('places the monster nests and the merchant around the spawn (%s)', async (_label, tables) => {
    const server = new MockServer(memory(), 0, () => 5_000_000)
    server.content = tables()
    await server.register({ username: 'viewer', password: 'secret' })
    const { token } = await server.login({ username: 'viewer', password: 'secret' })
    const s = new Session(() => server.wire(), token)
    await s.connect()
    const { character } = await s.request({ t: 'charCreate', name: 'Viewer', model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'bow' }, ['charCreated'])
    const enter = await s.request(intents.enterWorld(character.id), ['worldEnter'])
    const byModel = (m: string) => enter.entities.filter((e: EntityState) => e.model === m)
    expect(byModel('MOB_CH_MANGNYANG').length).toBe(11)
    expect(byModel('MOB_CH_TIGER').length).toBe(4)
    for (const e of enter.entities) expect(Math.hypot(e.pos[0], e.pos[2])).toBeLessThan(60)
    s.close()
  })
})

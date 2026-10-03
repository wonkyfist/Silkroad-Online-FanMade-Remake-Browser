/**
 * Wave 3 end to end (docs/WAVE_PLAN.md §4.15, the W3-I headless flows) on the REAL export: the real server (temp
 * DATA_DIR, work/out + work/out-opt) driven over WebSockets by helpers.ts clients, every frame checked by the strict
 * shared parser. Flows 1-9 and 11 run twice, on WORLD_EXPORT=jangan (the 3 x 3 town export) and on jangan-fields
 * (307 regions); flow 10 is the fields-only check (counts, places, respawn, tick time with 12 clients).
 *
 *  1. enter order (worldEnter -> stats -> inventory -> skills)      7. potion cooldown, return scroll cast / interrupt
 *  2. masteries and skills, hotbar across a relog                  8. account storage across two characters
 *  3. a skill cast, its cooldown, an interrupted charged cast      9. whisper, party, the [GM] tag via the owner CLI
 *  4. chain, imbue, buff (late joiners see effects)                10. the fields (jangan-fields only)
 *  5. heal and resurrect                                           11. abuse: strict frames, strikes, limits
 *  6. NPC talk walk, shop, buyback, dialog auto-close
 *
 * Skipped without the export.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOSE_CODE, HOTBAR_SLOTS, NPC_INTERACT_RANGE, type ServerMessage, type SkillDef } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli/gm.ts'
import { REPO_ROOT } from '../src/config.ts'
import type { MeshNav } from '../src/nav.ts'
import type { Npc, Player } from '../src/world.ts'
import { seeded } from './fixtures.ts'
import { Client, api, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const OUT_OPT = join(REPO_ROOT, 'work/out-opt')
const DATA = ['mobs', 'nests', 'items', 'levels', 'drops', 'towns', 'npcs', 'shops', 'skills', 'masteries'].map((f) => join(OUT, `data/${f}.json`))
const hasExport = (folder: string) => {
  const man = join(OUT, 'world', folder, 'manifest.json')
  if (!existsSync(man) || !DATA.every((f) => existsSync(f))) return false
  const m = JSON.parse(readFileSync(man, 'utf8')) as { nav?: { file?: string } }
  return typeof m.nav?.file === 'string' && existsSync(join(OUT, 'world', folder, m.nav.file))
}
const HAVE_JANGAN = hasExport('jangan')
const HAVE_FIELDS = HAVE_JANGAN && hasExport('jangan-fields')

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/** GATE_CH, the town return point (the manifests' spawn). */
const GATE_CH = { x: 96.9, y: -3.2609, z: -136.9 }
/** The Mangnyang field south of the town gate (wave2-e2e's route end), outside the safe area on both exports. */
const FIELD = ['108.97', '120']
const MANG = 'MOB_CH_MANGNYANG'
const HERB = 'ITEM_ETC_HP_POTION_01'
const RETURN_5S = 'ITEM_ETC_SCROLL_RETURN_03'
const SWORD = 'ITEM_CH_SWORD_01_A'
const SKILL = {
  smash: 'SKILL_CH_SWORD_SMASH_A_01',
  bowCritical: 'SKILL_CH_BOW_CRITICAL_A_01',
  chain: 'SKILL_CH_SWORD_CHAIN_A_1S_01',
  iceImbue: 'SKILL_CH_COLD_GIGONGTA_A_01',
  weakGuard: 'SKILL_CH_COLD_GANGGI_A_01',
  heal: 'SKILL_CH_WATER_HEAL_A_01',
  rebirth: 'SKILL_CH_WATER_RESURRECTION_A_01',
}
const ROWS = HAVE_JANGAN
  ? new Map((JSON.parse(readFileSync(join(OUT, 'data/skills.json'), 'utf8')) as { entries: SkillDef[] }).entries.map((r) => [r.code, r]))
  : new Map<string, SkillDef>()

async function until<T>(fn: () => T | null | undefined | false, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(20)
  }
}

/** One server on one world export, with the helpers every flow uses. */
function harness(worldExport: string) {
  const logs: string[] = []
  /** The gameplay random source; a flow may pin it (then restores it). */
  let roll: () => number = seeded(31)
  const h = {
    s: null as unknown as TestServer,
    logs,
    names: 0,
    pin(r: (() => number) | null) {
      roll = r ?? seeded(32)
    },
    async start() {
      h.s = await startTestServer({
        logs,
        config: { outDir: OUT, outOptDir: OUT_OPT, serveStatic: false, moveSpeed: 30, tickHz: 20, rolePollMs: 50, rng: () => roll(), worldExport },
      })
      expect(h.s.ctx.nav.kind).toBe('mesh')
    },
    player: (id: number) => h.s.ctx.world.players.get(id)!,
    npc(code: string): Npc {
      const n = [...h.s.ctx.world.npcs.values()].find((x) => x.code === code)
      if (!n) throw new Error(`no NPC ${code}`)
      return n
    },
    bag: (characterId: number) => h.s.ctx.store.loadInventory(characterId).bag,
    count: (characterId: number, code: string) => h.bag(characterId).reduce((n, i) => n + (i?.code === code ? i.count : 0), 0),
    slotOf: (characterId: number, code: string) => h.bag(characterId).findIndex((i) => i?.code === code),
    /** A fresh account (optionally GM, set as the owner CLI does) with one character in the world. */
    async hero(opts: { gm?: boolean; weapon?: 'sword' | 'blade' | 'spear' | 'bow'; outfit?: 'heavy'; prefix?: string } = {}) {
      const acc = await newAccount(h.s.url, opts.prefix ?? 'w3')
      const accountId = h.s.ctx.store.accountByName(acc.username)!.id
      if (opts.gm) h.s.ctx.store.setRole(accountId, 'gm')
      const c = await Client.login(h.s.url, acc.token)
      const name = `W3${worldExport === 'jangan' ? 'j' : 'f'}${(Date.now() % 1e4).toString(36)}${++h.names}`.slice(0, 12)
      c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: opts.weapon ?? 'sword', ...(opts.outfit ? { outfit: opts.outfit } : {}) })
      const ch = (await c.next('charCreated')).character
      const e = await h.enter(c, ch.id)
      return { c, acc, accountId, ch, name, ...e }
    },
    async enter(c: Client, characterId: number) {
      const from = c.log.length
      c.send({ t: 'enterWorld', id: characterId })
      const w = await c.next('worldEnter')
      const stats = await c.next('stats')
      const inventory = await c.next('inventory')
      const skills = await c.next('skills')
      const order = c.log.slice(from).map((m) => m.t).filter((t) => ['worldEnter', 'stats', 'inventory', 'skills'].includes(t))
      return { w, id: w.self.id, stats, inventory, skills, order }
    },
    async gm(c: Client, cmd: string, ...args: string[]) {
      c.send({ t: 'gm', cmd, args })
      const r = await c.next('gmResult', (m) => m.cmd === cmd)
      expect(r.ok, `${cmd} ${args.join(' ')}: ${r.message}`).toBe(true)
      return r
    },
    async act(c: Client, msg: Record<string, unknown> & { t: string }, timeoutMs = 3000): Promise<Msg<'actionResult'>> {
      c.send(msg)
      return c.next('actionResult', (m) => m.re === msg.t, timeoutMs)
    },
    /** A GM-spawned Mangnyang next to the hero that survives any number of hits (HP raised server-side). */
    async dummy(c: Client) {
      const r = await h.gm(c, 'spawn', MANG, '1')
      const id = (r.data as { ids: number[] }).ids[0]
      const m = h.s.ctx.world.mobs.get(id)!
      m.maxHp = 1_000_000
      m.hp = 1_000_000
      return id
    },
    close: async () => h.s?.stopAndClean(),
  }
  return h
}

type Harness = ReturnType<typeof harness>
type Hero = Awaited<ReturnType<Harness['hero']>>

const bye = async (...heroes: Hero[]) => {
  for (const x of heroes) x.c.close()
  await Promise.all(heroes.map((x) => x.c.closed))
}

// ---- flows 1-9 and 11, once per export -------------------------------------------------------------

for (const worldExport of ['jangan', 'jangan-fields'] as const) {
  describe.skipIf(worldExport === 'jangan' ? !HAVE_JANGAN : !HAVE_FIELDS)(`wave 3 flows on WORLD_EXPORT=${worldExport}`, () => {
    const h = harness(worldExport)
    beforeAll(() => h.start(), 120_000)
    afterAll(() => h.close())

    it('1. enter: worldEnter (levelCap, effects) -> stats -> inventory -> skills (40 hotbar slots); welcome names the export', async () => {
      const servers = await api(h.s.url, '/api/servers')
      expect(servers.json[0]).toMatchObject({ id: 'jangan', world: worldExport })
      const p = await h.hero()
      const welcome = p.c.log.find((m): m is Msg<'welcome'> => m.t === 'welcome')!
      expect(welcome.server).toMatchObject({ id: 'jangan', world: worldExport }) // survived parseServerMessage (Client)
      expect(p.order).toEqual(['worldEnter', 'stats', 'inventory', 'skills'])
      expect(p.w.world).toMatchObject({ name: worldExport, levelCap: 20 })
      expect(p.w.self.effects ?? []).toEqual([])
      expect(p.skills.hotbar).toHaveLength(HOTBAR_SLOTS)
      expect(p.skills.skills).toEqual([])
      expect(Object.keys(p.skills.masteries)).toHaveLength(7)
      await bye(p)
    })

    it('2+3. learn (masteries 1+1+1+2+2 SP, Strike Smash), hotbar across a relog, cast -> cooldown, a charged cast interrupted', async () => {
      const g = await h.hero({ gm: true })
      await h.gm(g.c, 'setlevel', g.name, '5')
      await h.gm(g.c, 'skill', 'sp', '100')
      const spBefore = h.player(g.id).progress.sp
      const spent: number[] = []
      for (let i = 0; i < 5; i++) {
        const before = h.player(g.id).progress.sp
        g.c.queue.length = 0
        expect(await h.act(g.c, { t: 'masteryUp', mastery: 'BICHEON' })).toMatchObject({ ok: true })
        const up = await g.c.next('skillsUpdate', (m) => !!m.masteries)
        expect(up.masteries).toEqual({ BICHEON: i + 1 })
        const d = await g.c.next('statsDelta', (m) => m.stats.sp !== undefined)
        expect(d.stats.sp).toBe(h.player(g.id).progress.sp)
        spent.push(before - d.stats.sp!)
      }
      expect(spent).toEqual([1, 1, 1, 2, 2])
      expect(spBefore - h.player(g.id).progress.sp).toBe(7)
      // masteries stop at the character level
      expect(await h.act(g.c, { t: 'masteryUp', mastery: 'BICHEON' })).toMatchObject({ ok: false })
      expect(await h.act(g.c, { t: 'skillLearn', skill: SKILL.smash })).toMatchObject({ ok: true })
      expect((await g.c.next('skillsUpdate', (m) => !!m.learned)).learned).toEqual([SKILL.smash])
      expect(await h.act(g.c, { t: 'hotbarSet', slot: 0, entry: { kind: 'skill', code: SKILL.smash } })).toMatchObject({ ok: true })
      expect((await g.c.next('skillsUpdate', (m) => !!m.hotbar)).hotbar).toEqual([{ slot: 0, entry: { kind: 'skill', code: SKILL.smash } }])
      g.c.send({ t: 'leaveWorld' })
      await g.c.next('worldLeft')
      const again = await h.enter(g.c, g.ch.id)
      expect(again.skills.hotbar[0]).toEqual({ kind: 'skill', code: SKILL.smash })
      expect(again.skills.skills).toContain(SKILL.smash)
      expect(again.skills.masteries.BICHEON).toBe(5)

      // 3. cast on a GM-spawned Mangnyang outside the safe area
      await h.gm(g.c, 'tp', ...FIELD)
      const me = h.player(again.id)
      expect(h.s.ctx.data.inSafeArea('jangan', me.pos[0], me.pos[2])).toBe(false)
      await h.gm(g.c, 'heal')
      const mob = await h.dummy(g.c)
      g.c.queue.length = 0
      const mp0 = h.player(again.id).mp
      expect(await h.act(g.c, { t: 'useSkill', skill: SKILL.smash, target: mob })).toMatchObject({ ok: true })
      const row = ROWS.get(SKILL.smash)!
      const cast = await g.c.next('cast', (m) => m.id === again.id)
      expect(cast).toMatchObject({ skill: SKILL.smash, target: mob, prepareMs: row.preparingMs ?? 0, castMs: row.castMs, actionMs: row.actionMs })
      const mp = await g.c.next('statsDelta', (m) => m.stats.mp !== undefined)
      expect(mp.stats.mp).toBe(mp0 - row.mp)
      const combat = await g.c.next('combat', (m) => m.instance === cast.instance, 5000)
      expect(combat).toMatchObject({ attacker: again.id, target: mob, skill: SKILL.smash })
      expect(g.c.log.indexOf(cast)).toBeLessThan(g.c.log.indexOf(mp))
      expect(g.c.log.indexOf(mp)).toBeLessThan(g.c.log.indexOf(combat))
      // a second use within the 3 s cooldown
      expect(await h.act(g.c, { t: 'useSkill', skill: SKILL.smash, target: mob })).toMatchObject({ ok: false, reason: 'cooldown' })
      g.c.send({ t: 'stopAction' })
      await bye(g)

      // a charged bow skill (prepare 670 ms) interrupted by moveTo before release
      const b = await h.hero({ gm: true, weapon: 'bow' })
      await h.gm(b.c, 'setlevel', b.name, '10')
      await h.gm(b.c, 'skill', SKILL.bowCritical)
      await h.gm(b.c, 'tp', ...FIELD)
      await h.gm(b.c, 'heal')
      const target = await h.dummy(b.c)
      b.c.queue.length = 0
      expect(await h.act(b.c, { t: 'useSkill', skill: SKILL.bowCritical, target })).toMatchObject({ ok: true })
      const charged = await b.c.next('cast', (m) => m.id === b.id)
      expect(charged.prepareMs).toBe(670)
      const pos = h.player(b.id).pos
      b.c.send({ t: 'moveTo', x: pos[0] + 3, z: pos[2] })
      expect(await b.c.next('castEnd', (m) => m.instance === charged.instance)).toMatchObject({ reason: 'interrupted' })
      await sleep(300)
      expect(b.c.queue.find((m) => m.t === 'combat' && m.instance === charged.instance)).toBeUndefined()
      await bye(b)
    }, 60_000)

    it('4. chain (3 combats, one instance), imbue (next basic hit harder), buff (PD up, cancel), late joiners see effects', async () => {
      // heavy armour: Weak Guard of Ice adds a percentage of the armour's defence (defp < 20 = %, SK-S)
      const g = await h.hero({ gm: true, outfit: 'heavy' })
      await h.gm(g.c, 'setlevel', g.name, '20')
      await h.gm(g.c, 'skill', 'all')
      await h.gm(g.c, 'tp', ...FIELD)
      await h.gm(g.c, 'heal')
      const mob = await h.dummy(g.c)
      g.c.queue.length = 0

      // Illusion Chain: one cast per segment, three combats sharing the instance
      expect(await h.act(g.c, { t: 'useSkill', skill: SKILL.chain, target: mob })).toMatchObject({ ok: true })
      const head = await g.c.next('cast', (m) => m.id === g.id)
      expect(head.skill).toMatch(/^SKILL_CH_SWORD_CHAIN_A_1S_\d\d$/)
      const hits: Msg<'combat'>[] = []
      for (let i = 0; i < 3; i++) hits.push(await g.c.next('combat', (m) => m.instance === head.instance, 5000))
      expect(hits.map((m) => m.skill!.replace(/_\d\d$/, ''))).toEqual(['SKILL_CH_SWORD_CHAIN_A_1S', 'SKILL_CH_SWORD_CHAIN_A_2S', 'SKILL_CH_SWORD_CHAIN_A_3S'])
      expect(new Set(hits.map((m) => m.instance)).size).toBe(1)
      await sleep(1200)
      g.c.send({ t: 'stopAction' })
      await h.gm(g.c, 'skill', 'cooldown')
      await h.gm(g.c, 'heal')

      // Imbue: with the rolls pinned, a basic hit before and after Ice River Force
      h.pin(() => 0.5)
      try {
        g.c.queue.length = 0
        expect(await h.act(g.c, { t: 'attack', target: mob })).toMatchObject({ ok: true })
        const plain = await g.c.next('combat', (m) => m.attacker === g.id && /_BASE_/.test(m.skill ?? ''), 5000)
        const base = Math.max(...plain.hits.map((x) => x.damage))
        expect(base).toBeGreaterThan(0)
        expect(await h.act(g.c, { t: 'useSkill', skill: SKILL.iceImbue })).toMatchObject({ ok: true })
        const imbue = await g.c.next('effectAdd', (m) => m.id === g.id)
        expect(imbue.effect.skill).toMatch(/^SKILL_CH_COLD_GIGONGTA_A_/)
        g.c.queue.length = 0
        const imbued = await g.c.next('combat', (m) => m.attacker === g.id && /_BASE_/.test(m.skill ?? ''), 5000)
        expect(Math.min(...imbued.hits.map((x) => x.damage))).toBeGreaterThan(base)
      } finally {
        h.pin(null)
      }
      g.c.send({ t: 'stopAction' })
      await sleep(200)
      await h.gm(g.c, 'heal')

      // Weak Guard of Ice: effectAdd + stats PD up; buffCancel -> effectRemove cancelled + PD back. It adds a few
      // percent (defp < 20 = %, SK-S), so dress the hero in degree-2 heavy armour first to make that at least 1 PD.
      for (const part of ['AA', 'BA', 'CA', 'FA', 'HA', 'LA', 'SA']) {
        const code = `ITEM_CH_M_HEAVY_02_${part}_C`
        const def = h.s.ctx.data.item(code)
        if (!def || def.reqLevel > 20) continue
        await h.gm(g.c, 'item', code, '1')
        await h.act(g.c, { t: 'itemEquip', bag: h.slotOf(g.ch.id, code) })
      }
      await sleep(100)
      const pd0 = h.player(g.id).combat.physDefence
      g.c.queue.length = 0
      expect(await h.act(g.c, { t: 'useSkill', skill: SKILL.weakGuard })).toMatchObject({ ok: true })
      const guard = await g.c.next('effectAdd', (m) => m.id === g.id && /GANGGI/.test(m.effect.skill ?? ''), 5000)
      const up = await g.c.next('stats', (m) => m.stats.physDefence > pd0, 3000)
      expect(up.stats.physDefence).toBeGreaterThan(pd0)

      // a second client entering later sees the effect on the caster
      const late = await h.hero({ gm: true, prefix: 'late' })
      await h.gm(late.c, 'tp', g.name)
      const seen = await late.c.next('spawn', (m) => m.entity.id === g.id, 3000)
      expect(seen.entity.effects?.map((e) => e.instance)).toContain(guard.effect.instance)

      expect(await h.act(g.c, { t: 'buffCancel', skill: guard.effect.skill! })).toMatchObject({ ok: true })
      expect(await g.c.next('effectRemove', (m) => m.instance === guard.effect.instance)).toMatchObject({ id: g.id, reason: 'cancelled' })
      const back = await g.c.next('stats', (m) => m.stats.physDefence === pd0, 3000)
      expect(back.stats.physDefence).toBe(pd0)
      expect(await late.c.next('effectRemove', (m) => m.instance === guard.effect.instance)).toMatchObject({ id: g.id })
      await bye(g, late)
    }, 60_000)

    it('5. heal raises a hurt player; Soul Rebirth Art revives a dead one where it lies', async () => {
      const g = await h.hero({ gm: true })
      await h.gm(g.c, 'setlevel', g.name, '20')
      await h.gm(g.c, 'skill', 'all')
      await h.gm(g.c, 'tp', ...FIELD)
      await h.gm(g.c, 'heal')
      const friend = await h.hero({ prefix: 'friend' })
      await h.gm(g.c, 'summon', friend.name)
      const fp = h.player(friend.id)
      fp.hp = 10
      expect(await h.act(g.c, { t: 'useSkill', skill: SKILL.heal, target: friend.id })).toMatchObject({ ok: true })
      // regeneration adds a few HP a pulse; the heal (369 at level 1 of the line) fills the level-1 friend
      await until(() => fp.hp >= 100, 'heal lands', 5000)

      await h.gm(g.c, 'skill', 'cooldown')
      await h.gm(g.c, 'heal')
      await h.gm(g.c, 'kill', friend.name)
      await friend.c.next('entityUpdate', (m) => m.id === friend.id && m.state === 'dead')
      const deadAt = [...fp.pos]
      friend.c.queue.length = 0
      expect(await h.act(g.c, { t: 'useSkill', skill: SKILL.rebirth, target: friend.id })).toMatchObject({ ok: true })
      await friend.c.next('entityUpdate', (m) => m.id === friend.id && m.state === 'alive', 6000)
      expect(fp.dead).toBe(false)
      expect(Math.hypot(fp.pos[0] - deadAt[0], fp.pos[2] - deadAt[2])).toBeLessThan(0.5)
      expect(friend.c.queue.find((m) => m.t === 'warp' && m.id === friend.id)).toBeUndefined()
      await bye(g, friend)
    }, 30_000)

    it('6. NPC talk walk to the Herbalist, shop buy / sell / buyback, walking away closes the dialog; Wangu and his chest spawn', async () => {
      const codes = [...h.s.ctx.world.npcs.values()].map((n) => n.code)
      expect(codes).toContain('NPC_CH_WAREHOUSE_M')
      expect(codes).toContain('NPC_CH_WAREHOUSE_W')
      const g = await h.hero({ gm: true })
      expect(g.w.entities.some((e) => e.model === 'NPC_CH_WAREHOUSE_M')).toBe(true)
      await h.gm(g.c, 'item', 'ITEM_ETC_GOLD_01', '5000')
      const herbalist = h.npc('NPC_CH_POTION')
      const me = h.player(g.id)
      const far = h.s.ctx.world.distance(me, herbalist, Date.now())
      expect(far).toBeGreaterThan(30)
      g.c.queue.length = 0
      expect(await h.act(g.c, { t: 'npcTalk', npc: herbalist.id })).toMatchObject({ ok: true })
      await g.c.next('move', (m) => m.id === g.id)
      const dialog = await g.c.next('npcDialog', () => true, 10_000)
      expect(dialog).toMatchObject({ npc: herbalist.id, code: 'NPC_CH_POTION', services: ['shop'] })
      const t = g.c.log.map((m) => (m.t === 'stop' && m.id === g.id ? 'selfStop' : m.t))
      expect(t.indexOf('selfStop')).toBeGreaterThan(-1)
      expect(t.indexOf('selfStop')).toBeLessThan(t.indexOf('npcDialog'))
      expect(t.indexOf('buyback', t.indexOf('npcDialog'))).toBeGreaterThan(-1)
      expect(h.s.ctx.world.distance(me, herbalist, Date.now())).toBeLessThanOrEqual(NPC_INTERACT_RANGE)

      const gold0 = me.gold
      expect(await h.act(g.c, { t: 'shopBuy', npc: herbalist.id, item: HERB, count: 10 })).toMatchObject({ ok: true })
      const price = gold0 - me.gold
      expect(price).toBe(600)
      expect(h.count(g.ch.id, HERB)).toBeGreaterThanOrEqual(10)
      const beforeSell = me.gold
      g.c.queue.length = 0
      expect(await h.act(g.c, { t: 'shopSell', npc: herbalist.id, bag: h.slotOf(g.ch.id, HERB), count: 5 })).toMatchObject({ ok: true })
      const list = await g.c.next('buyback')
      expect(list.entries.at(-1)).toMatchObject({ item: { code: HERB, count: 5 } })
      const paid = me.gold - beforeSell
      expect(paid).toBe(list.entries.at(-1)!.price)
      expect(await h.act(g.c, { t: 'shopBuyback', npc: herbalist.id, index: list.entries.length - 1 })).toMatchObject({ ok: true })
      expect(me.gold).toBe(beforeSell)
      expect(await h.act(g.c, { t: 'shopBuyback', npc: herbalist.id, index: list.entries.length - 1 })).toMatchObject({ ok: false })

      // walking 20 m away closes the dialog as too_far (a GM tp closes it as 'warp', NPC-S)
      const here = h.s.ctx.world.livePoint(me, Date.now())
      const away = [...[[20, 0], [-20, 0], [0, 20], [0, -20]]].map(([dx, dz]) => ({ x: here.x + dx, z: here.z + dz }))
      g.c.queue.length = 0
      let closed: Msg<'npcDialogClose'> | null = null
      for (const p of away) {
        g.c.send({ t: 'moveTo', x: p.x, z: p.z })
        closed = await g.c.next('npcDialogClose', () => true, 2500).catch(() => null)
        if (closed) break
        g.c.send({ t: 'moveTo', x: here.x, z: here.z })
        await g.c.next('stop', (m) => m.id === g.id, 3000).catch(() => null)
      }
      expect(closed).toMatchObject({ npc: herbalist.id, reason: 'too_far' })
      expect(await h.act(g.c, { t: 'shopBuy', npc: herbalist.id, item: HERB, count: 1 })).toMatchObject({ ok: false, reason: 'too_far' })
      await bye(g)
    }, 45_000)

    it('7. potions arm the hp cooldown; a 5 s return scroll is interrupted by moving, then completes and warps to GATE_CH', async () => {
      const g = await h.hero({ gm: true })
      await h.gm(g.c, 'item', HERB, '5')
      await h.gm(g.c, 'item', RETURN_5S, '2')
      g.c.queue.length = 0
      expect(await h.act(g.c, { t: 'itemUse', bag: h.slotOf(g.ch.id, HERB) })).toMatchObject({ ok: true })
      expect(await g.c.next('itemCooldown')).toMatchObject({ group: 'hp', readyInMs: 1000, totalMs: 1000 })
      expect(await h.act(g.c, { t: 'itemUse', bag: h.slotOf(g.ch.id, HERB) })).toMatchObject({ ok: false, reason: 'cooldown' })

      await h.gm(g.c, 'tp', ...FIELD)
      g.c.queue.length = 0
      expect(await h.act(g.c, { t: 'itemUse', bag: h.slotOf(g.ch.id, RETURN_5S) })).toMatchObject({ ok: true })
      expect(await g.c.next('itemCast', (m) => m.id === g.id)).toMatchObject({ item: RETURN_5S, castMs: 5000 })
      const p = h.player(g.id).pos
      g.c.send({ t: 'moveTo', x: p[0] + 4, z: p[2] })
      expect(await g.c.next('itemCastEnd', (m) => m.id === g.id)).toMatchObject({ item: RETURN_5S, reason: 'interrupted' })
      expect(h.count(g.ch.id, RETURN_5S)).toBe(2)
      await g.c.next('stop', (m) => m.id === g.id, 3000).catch(() => null)

      g.c.queue.length = 0
      const from = g.c.log.length
      expect(await h.act(g.c, { t: 'itemUse', bag: h.slotOf(g.ch.id, RETURN_5S) })).toMatchObject({ ok: true })
      const done = await g.c.next('itemCastEnd', (m) => m.id === g.id, 8000)
      expect(done.reason).toBe('done')
      const warp = await g.c.next('warp', (m) => m.id === g.id)
      expect(warp.pos[0]).toBeCloseTo(GATE_CH.x, 3)
      expect(warp.pos[2]).toBeCloseTo(GATE_CH.z, 3)
      expect(warp.pos[1]).toBeCloseTo(GATE_CH.y, 3)
      const seq = g.c.log.slice(from).map((m) => m.t).filter((t) => t === 'inventoryUpdate' || t === 'itemCastEnd' || t === 'warp')
      expect(seq).toEqual(['inventoryUpdate', 'itemCastEnd', 'warp'])
      expect(h.count(g.ch.id, RETURN_5S)).toBe(1)
      await bye(g)
    }, 30_000)

    it('8. storage: a sword and 1000 gold deposited at Sansan are withdrawn by the account\'s second character; the Smith is no keeper', async () => {
      const g = await h.hero({ gm: true })
      await h.gm(g.c, 'item', SWORD, '1')
      await h.gm(g.c, 'item', 'ITEM_ETC_GOLD_01', '5000')
      const sansan = h.npc('NPC_CH_WAREHOUSE_W')
      const smith = h.npc('NPC_CH_SMITH')
      expect(await h.act(g.c, { t: 'npcTalk', npc: sansan.id })).toMatchObject({ ok: true })
      expect(await g.c.next('npcDialog', () => true, 10_000)).toMatchObject({ code: 'NPC_CH_WAREHOUSE_W', services: ['storage'] })
      expect(await h.act(g.c, { t: 'storageOpen', npc: sansan.id })).toMatchObject({ ok: true })
      const snap = await g.c.next('storage')
      expect(snap.storage.slots).toHaveLength(snap.storage.size)
      expect(snap.storage.gold).toBe(0)
      const swordAt = h.slotOf(g.ch.id, SWORD)
      expect(swordAt).toBeGreaterThanOrEqual(0)
      expect(await h.act(g.c, { t: 'storageDeposit', npc: smith.id, bag: swordAt })).toMatchObject({ ok: false, reason: 'not_found' })
      expect(await h.act(g.c, { t: 'storageDeposit', npc: sansan.id, bag: swordAt })).toMatchObject({ ok: true })
      expect((await g.c.next('storageUpdate', (m) => !!m.slots)).slots![0].item).toMatchObject({ code: SWORD })
      expect(await h.act(g.c, { t: 'storageGold', npc: sansan.id, dir: 'deposit', amount: 1000 })).toMatchObject({ ok: true })
      expect((await g.c.next('storageUpdate', (m) => m.gold !== undefined)).gold).toBe(1000)
      expect(h.count(g.ch.id, SWORD)).toBe(0)

      // the account's second character
      g.c.send({ t: 'leaveWorld' })
      await g.c.next('worldLeft')
      g.c.send({ t: 'charCreate', name: `${g.name.slice(0, 10)}b`, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'spear' })
      const second = (await g.c.next('charCreated')).character
      const e = await h.enter(g.c, second.id)
      const gold0 = h.player(e.id).gold
      expect(await h.act(g.c, { t: 'npcTalk', npc: sansan.id })).toMatchObject({ ok: true })
      await g.c.next('npcDialog', () => true, 10_000)
      expect(await h.act(g.c, { t: 'storageOpen', npc: sansan.id })).toMatchObject({ ok: true })
      const seen = await g.c.next('storage')
      expect(seen.storage.gold).toBe(1000)
      const at = seen.storage.slots.findIndex((x) => x?.code === SWORD)
      expect(at).toBeGreaterThanOrEqual(0)
      expect(await h.act(g.c, { t: 'storageWithdraw', npc: sansan.id, slot: at })).toMatchObject({ ok: true })
      expect(await h.act(g.c, { t: 'storageGold', npc: sansan.id, dir: 'withdraw', amount: 1000 })).toMatchObject({ ok: true })
      expect(h.count(second.id, SWORD)).toBe(1)
      expect(h.player(e.id).gold).toBe(gold0 + 1000)
      const left = h.s.ctx.gameplay.storage.tables.load(g.accountId)
      expect(left.gold).toBe(0)
      expect(left.slots.every((x) => x === null)).toBe(true)
      await bye(g)
    }, 45_000)

    it('9. whispers reach only their target, /-text is not a GM command, party is refused, the [GM] tag follows the owner CLI', async () => {
      const a = await h.hero({ prefix: 'cha' })
      const b = await h.hero({ prefix: 'chb' })
      const c = await h.hero({ prefix: 'chc' })
      a.c.send({ t: 'chat', text: 'psst', to: b.name })
      expect(await b.c.next('chat', (m) => m.channel === 'whisper')).toMatchObject({ fromId: a.id, from: a.name, to: b.name, text: 'psst' })
      expect(await a.c.next('chat', (m) => m.channel === 'whisper')).toMatchObject({ to: b.name, text: 'psst' })
      a.c.send({ t: 'chat', text: `/kill ${b.name}`, to: b.name })
      expect(await b.c.next('chat', (m) => m.channel === 'whisper')).toMatchObject({ text: `/kill ${b.name}` })
      await a.c.none('gmResult', 200)
      expect(a.c.queue.find((m) => m.t === 'error' && m.code === 'forbidden')).toBeUndefined()
      expect(h.player(b.id).dead).toBe(false)
      expect(c.c.log.some((m) => m.t === 'chat' && m.channel === 'whisper')).toBe(false)
      a.c.send({ t: 'chat', text: 'anyone?', channel: 'party' })
      expect(await a.c.next('error', (m) => m.re === 'chat')).toMatchObject({ code: 'bad_request' })

      // the owner CLI grants and revokes in the database; the running server notices within the role poll
      const quiet = () => {}
      const env = { DATA_DIR: h.s.ctx.config.dataDir }
      expect(runCli(['grant', a.acc.username], env, quiet, quiet)).toBe(0)
      expect(await b.c.next('entityUpdate', (m) => m.id === a.id && m.gm !== undefined, 3000)).toMatchObject({ gm: true })
      expect(await a.c.next('role', () => true, 3000)).toMatchObject({ role: 'gm' })
      expect(runCli(['revoke', a.acc.username], env, quiet, quiet)).toBe(0)
      expect(await b.c.next('entityUpdate', (m) => m.id === a.id && m.gm !== undefined, 3000)).toMatchObject({ gm: false })
      await bye(a, b, c)
    }, 30_000)

    it('11. abuse: an extra key on every new request is bad_request + a strike, hotbar slot 40 and storageGold 0 too; the 20th strike closes', async () => {
      const p = await h.hero({ prefix: 'bad' })
      expect(await h.act(p.c, { t: 'useSkill', skill: SKILL.smash })).toMatchObject({ ok: false, reason: 'not_learned' })
      const npc = h.npc('NPC_CH_WAREHOUSE_W').id
      const frames: Record<string, unknown>[] = [
        { t: 'useSkill', skill: SKILL.smash },
        { t: 'skillLearn', skill: SKILL.smash },
        { t: 'masteryUp', mastery: 'BICHEON' },
        { t: 'buffCancel', skill: SKILL.weakGuard },
        { t: 'hotbarSet', slot: 0, entry: null },
        { t: 'npcTalk', npc },
        { t: 'npcClose' },
        { t: 'storageOpen', npc },
        { t: 'storageDeposit', npc, bag: 0 },
        { t: 'storageWithdraw', npc, slot: 0 },
        { t: 'storageMove', npc, from: 0, to: 1 },
        { t: 'storageGold', npc, dir: 'deposit', amount: 1 },
        { t: 'shopBuyback', npc, index: 0 },
        { t: 'chat', text: 'hi', to: 'Someone', channel: 'local', extra: 1 },
      ]
      let strikes = 0
      const bad = async (frame: Record<string, unknown>) => {
        p.c.send(frame)
        const err = await p.c.next('error', () => true)
        expect(err.code, JSON.stringify(frame)).toBe('bad_request')
        strikes++
      }
      for (const f of frames) await bad(f.t === 'chat' ? f : { ...f, x: 1 })
      await bad({ t: 'hotbarSet', slot: HOTBAR_SLOTS, entry: null })
      await bad({ t: 'storageGold', npc, dir: 'deposit', amount: 0 })
      expect(p.c.queue.find((m) => m.t === 'actionResult')).toBeUndefined() // none of them reached a module
      expect(p.c.isClosed).toBe(false)
      while (strikes < 19) await bad({ t: 'npcClose', why: 'spam' })
      expect(p.c.isClosed).toBe(false)
      p.c.send({ t: 'npcClose', why: 'spam' })
      expect(await p.c.closed).toMatchObject({ code: CLOSE_CODE.abuse })
    }, 30_000)
  })
}

// ---- flow 10: the fields ---------------------------------------------------------------------------

describe.skipIf(!HAVE_FIELDS)('10. the fields (WORLD_EXPORT=jangan-fields)', () => {
  const h = harness('jangan-fields')
  beforeAll(() => h.start(), 120_000)
  afterAll(() => h.close())

  it('loads 307 regions, at least 690 nests and more than 5,500 monsters (unreachable nests logged once)', () => {
    expect(h.logs.some((l) => /^navigation: .*jangan-fields.*nav\.bin \(307 regions/.test(l)), h.logs.join('\n')).toBe(true)
    const m = /world content: (\d+) NPCs, (\d+) nests \(\d+ skipped\), (\d+) monsters spawned/.exec(h.logs.find((l) => l.startsWith('world content:')) ?? '')
    expect(m).not.toBeNull()
    // wave 11: UNIQUES=on (the default) gives Tiger Girl's 11 camps to the uniques module (Spawner refusal): 690 - 11
    expect(Number(m![2])).toBeGreaterThanOrEqual(679)
    expect(Number(m![3])).toBeGreaterThan(5500)
    expect(h.logs.filter((l) => l.startsWith('nests not spawned:'))).toHaveLength(1)
  })

  it('tp north-tiger-mt works, tp jangan lands at the town, death in the fields respawns at GATE_CH', async () => {
    const g = await h.hero({ gm: true })
    const r = await h.gm(g.c, 'tp', 'north-tiger-mt')
    const nav = h.s.ctx.nav as MeshNav
    const p = h.player(g.id)
    expect(nav.place(p.pos[0], p.pos[2], p.pos[1], 1)).not.toBeNull()
    expect((await h.gm(g.c, 'where')).message).toMatch(/North-Tiger Mt\./)
    expect((r.data as { place: string }).place).toBe('north-tiger-mt')
    const home = (await h.gm(g.c, 'tp', 'jangan')).data as { pos: number[] }
    expect(home.pos[0]).toBeCloseTo(GATE_CH.x, 3)
    expect(home.pos[2]).toBeCloseTo(GATE_CH.z, 3)
    await h.gm(g.c, 'tp', 'grassland')
    h.s.ctx.gameplay.gmKill(p)
    await g.c.next('entityUpdate', (m) => m.id === g.id && m.state === 'dead')
    g.c.queue.length = 0
    expect(await h.act(g.c, { t: 'respawn' })).toMatchObject({ ok: true })
    const warp = await g.c.next('warp', (m) => m.id === g.id)
    expect(warp.pos[0]).toBeCloseTo(GATE_CH.x, 3)
    expect(warp.pos[2]).toBeCloseTo(GATE_CH.z, 3)
    await bye(g)
  })

  it('10 idle and 2 fighting clients for 10 s: mean tick < 10 ms (max / p99 printed for the N100 projection)', async () => {
    const idle: Hero[] = []
    for (let i = 0; i < 10; i++) idle.push(await h.hero({ prefix: 'idle' }))
    const fighters = [await h.hero({ gm: true, prefix: 'fight' }), await h.hero({ gm: true, prefix: 'fight' })]
    for (const f of fighters) {
      await h.gm(f.c, 'setlevel', f.name, '20')
      await h.gm(f.c, 'skill', 'all')
      await h.gm(f.c, 'tp', 'grassland')
    }
    await sleep(500)
    const world = h.s.ctx.world
    const samples: number[] = []
    const timed = world.timedTick.bind(world)
    world.timedTick = (now: number) => {
      const ms = timed(now)
      samples.push(ms)
      return ms
    }
    let kills = 0
    const until = Date.now() + 10_000
    const fight = async (f: Hero) => {
      let n = 0
      while (Date.now() < until) {
        const me = h.player(f.id)
        if (me.dead) {
          f.c.send({ t: 'respawn' })
          await f.c.next('warp', (m) => m.id === f.id).catch(() => null)
          await h.gm(f.c, 'tp', 'grassland')
          continue
        }
        const target = [...world.mobs.values()]
          .filter((m) => m.ai !== 'dead' && me.known.has(m.id))
          .sort((x, y) => world.distance(x, me, Date.now()) - world.distance(y, me, Date.now()))[0]
        if (!target) {
          await sleep(200)
          continue
        }
        // alternate skills and basic attacks, as a player would
        f.c.send(++n % 2 ? { t: 'useSkill', skill: SKILL.smash, target: target.id } : { t: 'attack', target: target.id })
        const res = await f.c.next('actionResult', (m) => m.re === 'attack' || m.re === 'useSkill').catch(() => null)
        if (!res?.ok) {
          await sleep(100)
          continue
        }
        const hit = await f.c.next('combat', (m) => m.target === target.id && m.killed === true, Math.max(100, until - Date.now())).catch(() => null)
        if (hit) kills++
        f.c.queue.length = 0
      }
    }
    await Promise.all(fighters.map(fight))
    world.timedTick = timed
    const sorted = [...samples].sort((a, b) => a - b)
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]
    console.log(`wave3 fields perf: ${samples.length} ticks at 20 Hz, mean ${mean.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, max ${sorted.at(-1)!.toFixed(2)} ms, ${kills} kills, ${world.mobs.size} mobs, 12 players`)
    expect(samples.length).toBeGreaterThan(100)
    expect(kills).toBeGreaterThan(0)
    expect(mean).toBeLessThan(10)
    await bye(...idle, ...fighters)
  }, 90_000)
})

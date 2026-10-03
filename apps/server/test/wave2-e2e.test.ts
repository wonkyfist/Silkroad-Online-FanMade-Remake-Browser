/**
 * Wave 2 end to end on the REAL Jangan export: the real server (temp DATA_DIR, work/out + work/out-opt) driven by the
 * game client's own modules — HttpApi, Session and webSocketWire (apps/game/src/net), the world intents
 * (world/intents.ts, hud/intents.ts), the creation screen's buildCharCreate (@sro/appearance) and the world screen's
 * height model (world/jangan/heights.ts: NavTrack prediction of our own walks on the navmesh the client downloads from
 * /out-opt, the nearest-surface rule for everyone else).
 *
 * The run: a character with Height 4 + the heavy outfit shows its choices and the heavy starter set in charCreated,
 * charList, worldEnter and in another player's `spawn`; it walks into the fountain (stops at the rim on the plaza),
 * around it, down the stairs, through the south gate to the Mangnyang field, kills Mangnyang until it levels up,
 * loots, reads a return scroll and later respawns in town. Every server move of the hero is re-walked by the client's
 * prediction and compared with the server's own live position: end points, heights along the walk and at every stop
 * (the divergence is printed). Crafted moveTo frames cannot leave the navmesh. Skipped without the export.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NavGltf, NavWorld, decodeNavData } from '@sro/nav'
import { parseClientMessage, type ClientMessage, type EntityState, type MoveState, type ServerMessage, type Vec3 } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildCharCreate, composeWorn, isEquipmentManifest, starterEquipment } from '../../../packages/appearance/src/index.ts'
import { intent as hudIntent } from '../../game/src/hud/intents.ts'
import { HttpApi } from '../../game/src/net/api.ts'
import { sampleMove } from '../../game/src/net/clock.ts'
import { Session } from '../../game/src/net/session.ts'
import { webSocketWire, type Wire } from '../../game/src/net/wire.ts'
import type { WorldGround } from '../../game/src/world/ground.ts'
import { intents } from '../../game/src/world/intents.ts'
import { EntityHeights } from '../../game/src/world/jangan/heights.ts'
import { REPO_ROOT } from '../src/config.ts'
import type { MeshNav, NavPoint } from '../src/nav.ts'
import { seeded } from './fixtures.ts'
import { startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const OUT_OPT = join(REPO_ROOT, 'work/out-opt')
const MANIFEST = join(OUT, 'world/jangan/manifest.json')
const HAVE =
  existsSync(MANIFEST) &&
  existsSync(join(OUT, 'world/jangan/nav.bin')) &&
  existsSync(join(OUT_OPT, 'world/jangan/nav.bin')) &&
  existsSync(join(OUT, 'equipment/equipment.json')) &&
  ['characters', 'weapons', 'mobs', 'nests', 'items', 'levels', 'drops', 'towns'].every((f) => existsSync(join(OUT, `data/${f}.json`)))

const SPEED = 25
const PLAZA_Y = -3.261
const FOUNTAIN: [number, number] = [97.9, -85.6]
/** Around the fountain (west), down the stairs, through the middle arch of the south gate, to the Mangnyang field. */
const ROUTE: [number, number][] = [[70, -100], [70, -60], [98, -40], [98, -10], [98, 60], [108.97, 120]]
const MANG = 'MOB_CH_MANGNYANG'
/** The Instant Return Scroll: a 5 s cast (docs/SHOPS.md §4.3), the shortest there is. */
const RETURN_SCROLL = 'ITEM_ETC_SCROLL_RETURN_03'

type Msg<K extends ServerMessage['t']> = Extract<ServerMessage, { t: K }>

/** Every frame the game modules sent, with any the server's strict validator refused. */
const refused: { msg: ClientMessage; error: string }[] = []
function checkedWire(url: string): Wire {
  const wire = webSocketWire(url)
  const send = wire.send.bind(wire)
  wire.send = (msg) => {
    const parsed = parseClientMessage(JSON.stringify(msg))
    if (!parsed.ok) refused.push({ msg, error: parsed.error })
    send(msg)
  }
  return wire
}

/** A Session's messages, kept so tests can wait for one that already arrived. */
class Inbox {
  readonly log: ServerMessage[] = []
  private queue: ServerMessage[] = []
  private waiters: (() => void)[] = []

  constructor(readonly session: Session) {
    session.on((m) => {
      this.log.push(m)
      this.queue.push(m)
      const w = this.waiters
      this.waiters = []
      for (const f of w) f()
    })
  }

  /** The next queued message of type `t` matching `where` (consumed); earlier non-matching ones stay queued. */
  async next<K extends ServerMessage['t']>(t: K, where: (m: Msg<K>) => boolean = () => true, timeoutMs = 5000): Promise<Msg<K>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const i = this.queue.findIndex((m) => m.t === t && where(m as Msg<K>))
      if (i >= 0) return this.queue.splice(i, 1)[0] as Msg<K>
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`timed out waiting for ${t}`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  clear(): void {
    this.queue = []
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!HAVE)('wave 2 end to end on the real Jangan (game net modules + real server)', () => {
  let s: TestServer
  let nav: MeshNav
  let api: HttpApi
  let wsUrl: string
  const sessions: Session[] = []
  const manifest = HAVE ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { spawn: { x: number; y: number; z: number } }) : null!

  beforeAll(async () => {
    s = await startTestServer({
      config: { outDir: OUT, outOptDir: OUT_OPT, moveSpeed: SPEED, tickHz: 20, rng: seeded(11), rolePollMs: 50 },
      files: { 'dist/index.html': '<!doctype html><title>game</title>' },
    })
    expect(s.ctx.nav.kind).toBe('mesh')
    nav = s.ctx.nav as MeshNav
    api = new HttpApi(`${s.url}/api`)
    wsUrl = `${s.url.replace(/^http/, 'ws')}/ws`
  })

  afterAll(async () => {
    for (const x of sessions) x.close()
    await s?.stopAndClean()
  })

  const open = (token: string) => {
    const session = new Session(() => checkedWire(wsUrl), token)
    sessions.push(session)
    return { session, inbox: new Inbox(session) }
  }

  /** Server-side check that a live point is somewhere a walker may be (as nav-real.test.ts). */
  function valid(p: NavPoint): string | null {
    if (!p.surface) return 'no surface'
    if (![p.x, p.y, p.z].every(Number.isFinite)) return 'not finite'
    if (Math.abs(nav.heightOn(p.surface, p.x, p.z) - p.y) > 1e-3) return 'y is not on its surface'
    if (p.surface.kind === 'terrain') {
      if (!nav.terrainOpen(p.x, p.z)) return 'closed terrain cell'
      if (nav.insideSolid(p.x, p.z, p.y)) return 'inside a solid object'
      return null
    }
    if (nav.isSolid(p.surface.instance)) return 'on a solid object'
    const settled = nav.g.settle(p.surface, p.x, p.z)
    if (!settled || Math.hypot(settled.x - p.x, settled.z - p.z) > 1e-6) return 'outside its cell'
    return null
  }

  it('plays login -> create (Height 4, heavy) -> select -> world: fountain, gate, Mangnyang, loot, level, return, respawn', async () => {
    // ---- what the browser downloads: the slimmed tree (brotli), the navmesh, the equipment manifest ---------------
    const manRes = await fetch(`${s.url}/out-opt/world/jangan/manifest.json`, { headers: { 'Accept-Encoding': 'br' } })
    expect(manRes.status).toBe(200)
    expect(manRes.headers.get('content-encoding')).toBe('br')
    const clientManifest = (await manRes.json()) as { nav: { file: string }; space: { originRegion: { x: number; z: number } } }
    const navRes = await fetch(`${s.url}/out-opt/world/jangan/${clientManifest.nav.file}`)
    expect(navRes.status).toBe(200)
    const clientNav = new NavGltf(new NavWorld(decodeNavData(new Uint8Array(await navRes.arrayBuffer()))), clientManifest.space.originRegion)
    // The world screen's ground (JanganGround.heightAt = World.heightAt: the surface nearest the hint, else terrain).
    const ground: WorldGround = {
      heightAt: (x, z, yHint = Infinity) => clientNav.locate(x, z, yHint)?.y ?? clientNav.world.terrainHeight(clientNav.fileX(x), clientNav.fileZ(z)) * 0.1,
      isGround: () => false,
      follow() {},
      dispose() {},
    }
    const eqRes = await fetch(`${s.url}/out/equipment/equipment.json`)
    const equipmentManifest = (await eqRes.json()) as unknown
    expect(isEquipmentManifest(equipmentManifest)).toBe(true)
    if (!isEquipmentManifest(equipmentManifest)) return

    // ---- login screen, server select --------------------------------------------------------------------------------
    const suffix = Date.now().toString(36).slice(-5)
    const reg = await api.register({ username: `hero_${suffix}`, password: 'secret-H1' })
    const regObs = await api.register({ username: `obs_${suffix}`, password: 'secret-O1' })
    expect((await api.servers())[0]).toMatchObject({ id: 'jangan', status: 'online' })

    // An observer already in town sees the hero arrive dressed.
    const obs = open(regObs.token)
    await obs.session.connect()
    const obsChar = (await obs.session.request({ t: 'charCreate', name: `Obs${suffix}`, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'bow' }, ['charCreated'])).character
    expect(obsChar).toMatchObject({ height: 2, volume: 2 }) // an old-style charCreate gets the defaults
    await obs.session.request(intents.enterWorld(obsChar.id), ['worldEnter'])

    const hero = open(reg.token)
    await hero.session.connect()

    // ---- character creation: the screen's own message, then the security edges of the new fields --------------------
    const model = 'CHAR_CH_MAN_ADVENTURER'
    const name = `Hero${suffix}`
    const create = buildCharCreate({ name, model, weapon: 'sword', height: 4, volume: 3, outfit: 'heavy' })
    expect(create).toMatchObject({ t: 'charCreate', height: 4, volume: 3, outfit: 'heavy' })
    const worn = starterEquipment('male', 'heavy', 'sword')
    expect(worn).toEqual({ chest: 'ITEM_CH_M_HEAVY_01_BA_A_DEF', legs: 'ITEM_CH_M_HEAVY_01_LA_A_DEF', feet: 'ITEM_CH_M_HEAVY_01_FA_A_DEF', weapon: 'ITEM_CH_SWORD_01_A_DEF' })
    // Out-of-range Height, an unknown outfit and a client-chosen `equip` are refused by the strict validator.
    for (const bad of [{ ...create, height: 5 }, { ...create, volume: -1 }, { ...create, outfit: 'gm_robe' }, { ...create, equip: { chest: 'ITEM_CH_M_HEAVY_10_BA_C_RARE' } }]) {
      hero.session.send(bad as ClientMessage)
      expect(await hero.inbox.next('error')).toMatchObject({ code: 'bad_request' })
    }
    expect(hero.inbox.log.some((m) => m.t === 'charCreated')).toBe(false)
    refused.length = 0 // the four above were meant to be refused
    const created = (await hero.session.request(create, ['charCreated'])).character
    expect(created).toMatchObject({ name, model, weapon: 'sword', level: 1, height: 4, volume: 3, equip: worn })

    // ---- character select ---------------------------------------------------------------------------------------------
    const listed = (await hero.session.request({ t: 'charList' }, ['charList'])).characters
    expect(listed).toEqual([expect.objectContaining({ id: created.id, height: 4, volume: 3, equip: worn })])
    // The client dresses it: every piece of the heavy set composes onto the body, replacing the bare parts.
    const comp = composeWorn(equipmentManifest, model, listed[0]!.equip)
    expect(comp.rejected).toEqual([])
    expect(comp.bind.map((b) => b.code).sort()).toEqual(Object.values(worn).sort())
    expect(comp.hide.length).toBeGreaterThan(0)

    // ---- the world ---------------------------------------------------------------------------------------------------
    // The world screen's per-message handling of our own walks (screens/world.ts onMessage), with the divergence
    // between the client's prediction and the server's live position measured on every move.
    const heights = new EntityHeights(ground, { nav: clientNav } as ConstructorParameters<typeof EntityHeights>[1])
    const div = { frames: 0, moves: 0, endXZ: 0, alongXZ: 0, alongY: 0, stopY: 0, stops: 0, others: 0, othersY: 0 }
    let selfId = -1
    let worstAlong = ''
    let worstStop = ''
    /** Frames of our own walk still to draw: the time, the (predicted) move drawn, the server's live point then. */
    const FRAME_MS = 16
    const frameQueue: { t: number; move: MoveState; label: string; srv: NavPoint }[] = []
    /** Draws the due frames (the world screen's per-frame EntityView.update + heightAt for us) up to time `until`. */
    const frames = (until: number) => {
      while (frameQueue.length && frameQueue[0]!.t <= until) {
        const f = frameQueue.shift()!
        const c = sampleMove(f.move, f.t)
        const y = heights.heightOf(selfId, c.pos[0], c.pos[2], c.pos[1])
        div.frames++
        div.alongXZ = Math.max(div.alongXZ, Math.hypot(c.pos[0] - f.srv.x, c.pos[2] - f.srv.z))
        if (Math.abs(y - f.srv.y) > div.alongY) {
          worstAlong = `${f.label} at ${c.pos[0].toFixed(2)},${c.pos[2].toFixed(2)}: client ${y.toFixed(3)} (${heights.selfSurface}) server ${f.srv.y.toFixed(3)} (${nav.surfaceKey(f.srv.surface)})`
          div.alongY = Math.abs(y - f.srv.y)
        }
      }
    }
    const entities = new Map<number, EntityState>()
    const otherY = (id: number, x: number, z: number, serverY: number) => {
      const y = heights.heightOf(id, x, z, serverY)
      div.others++
      div.othersY = Math.max(div.othersY, Math.abs(y - serverY))
    }
    hero.session.on((m) => {
      switch (m.t) {
        case 'worldEnter':
          selfId = m.self.id
          heights.selfId = selfId
          heights.placeSelf(m.self.pos)
          entities.clear()
          for (const e of m.entities) {
            entities.set(e.id, e)
            otherY(e.id, e.pos[0], e.pos[2], e.pos[1])
          }
          break
        case 'spawn':
          entities.set(m.entity.id, m.entity)
          otherY(m.entity.id, m.entity.pos[0], m.entity.pos[2], m.entity.pos[1])
          break
        case 'despawn':
          entities.delete(m.id)
          break
        case 'move': {
          const e = entities.get(m.id)
          if (e) e.pos = [...m.move.to] as Vec3
          if (m.id !== selfId) {
            otherY(m.id, m.move.to[0], m.move.to[2], m.move.to[1])
            break
          }
          // The frames drawn since the last message ran on the previous move until this one started.
          frames(Math.min(Date.now(), m.move.startedAt))
          const predicted = heights.selfMove(m.move)
          div.moves++
          div.endXZ = Math.max(div.endXZ, Math.hypot(predicted.to[0] - m.move.to[0], predicted.to[2] - m.move.to[2]))
          // The server's own live point (navmesh legs) at every frame time of this move, compared lazily with where
          // the client draws us (its predicted move, height from its NavTrack) as the frames come due.
          const p = s.ctx.world.players.get(selfId)
          if (!p?.move || p.move.startedAt !== m.move.startedAt) break
          const len = Math.hypot(m.move.to[0] - m.move.from[0], m.move.to[2] - m.move.from[2])
          const dur = (len / m.move.speed) * 1000
          for (let at = m.move.startedAt; ; at += FRAME_MS) {
            const t = Math.min(at, m.move.startedAt + dur)
            frameQueue.push({ t, move: predicted, label: `move ${div.moves}`, srv: s.ctx.world.livePoint(p, t) })
            if (t >= m.move.startedAt + dur) break
          }
          break
        }
        case 'stop':
        case 'warp': {
          const e = entities.get(m.id)
          if (e) e.pos = [...m.pos] as Vec3
          if (m.id !== selfId) {
            otherY(m.id, m.pos[0], m.pos[2], m.pos[1])
            break
          }
          frames(Date.now())
          frameQueue.length = 0
          if (m.t === 'stop') heights.selfStop(m.pos)
          else heights.placeSelf(m.pos)
          div.stops++
          const sy = heights.heightOf(selfId, m.pos[0], m.pos[2], m.pos[1])
          if (Math.abs(sy - m.pos[1]) > div.stopY) worstStop = `${m.t} ${div.stops} at ${m.pos.map((v) => v.toFixed(2))}: client ${sy.toFixed(3)} (${heights.selfSurface}) server surface ${nav.surfaceKey(s.ctx.world.players.get(selfId)?.surface ?? null)}`
          div.stopY = Math.max(div.stopY, Math.abs(sy - m.pos[1]))
          break
        }
        case 'entityUpdate': {
          const e = entities.get(m.id)
          if (e && m.state) e.state = m.state
          break
        }
      }
    })

    const obsSeesHero = obs.inbox.next('spawn', (m) => m.entity.name === name)
    const enter = await hero.session.request(intents.enterWorld(created.id), ['worldEnter'])
    const sp = manifest.spawn
    expect(enter.self).toMatchObject({ kind: 'player', name, model, weapon: 'sword', height: 4, volume: 3, equip: worn })
    expect(enter.self.pos[0]).toBeCloseTo(sp.x, 3)
    expect(enter.self.pos[2]).toBeCloseTo(sp.z, 3)
    expect(enter.self.pos[1]).toBeCloseTo(PLAZA_Y, 2) // on the plaza deck, not the terrain 1.5 m below
    expect(heights.heightOf(selfId, sp.x, sp.z, enter.self.pos[1])).toBeCloseTo(PLAZA_Y, 2)
    expect(heights.selfSurface).toMatch(/^object /)
    const inv = await hero.inbox.next('inventory')
    expect(Object.fromEntries(Object.entries(inv.inventory.equip).map(([k, v]) => [k, v?.code]))).toMatchObject(worn)
    // The other player sees the hero dressed, at its height, on the plaza.
    const seen = (await obsSeesHero).entity
    expect(seen).toMatchObject({ kind: 'player', height: 4, volume: 3, equip: worn })
    expect(ground.heightAt(seen.pos[0], seen.pos[2], seen.pos[1])).toBeCloseTo(seen.pos[1], 3)

    const player = () => s.ctx.world.players.get(selfId)!
    /** A click on the ground: moveTo, the server's move and the stop at its end. */
    const walk = async (x: number, z: number) => {
      hero.inbox.clear()
      hero.session.send(intents.moveTo(x, z))
      const move = await hero.inbox.next('move', (m) => m.id === selfId)
      const len = Math.hypot(move.move.to[0] - move.move.from[0], move.move.to[2] - move.move.from[2])
      const stop = await hero.inbox.next('stop', (m) => m.id === selfId, (len / SPEED) * 1000 + 5000)
      expect(stop.pos).toEqual(move.move.to)
      expect(valid(s.ctx.world.livePoint(player(), Date.now()))).toBeNull()
      return { move: move.move as MoveState, stop }
    }

    // ---- the fountain: stopped at the rim, on the plaza ----------------------------------------------------------------
    const f = await walk(...FOUNTAIN)
    const rim = Math.hypot(f.stop.pos[0] - FOUNTAIN[0], f.stop.pos[2] - FOUNTAIN[1])
    expect(rim).toBeGreaterThan(9)
    expect(rim).toBeLessThan(11)
    expect(f.stop.pos[1]).toBeCloseTo(PLAZA_Y, 2)
    expect(heights.heightOf(selfId, f.stop.pos[0], f.stop.pos[2], f.stop.pos[1])).toBeCloseTo(PLAZA_Y, 2)

    // ---- crafted moveTo frames: toward the basin from every side, far outside the world, rapid-fire re-targeting ------
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * 2 * Math.PI
      hero.session.send(intents.moveTo(FOUNTAIN[0] + Math.sin(a) * 0.5, FOUNTAIN[1] + Math.cos(a) * 0.5))
      await sleep(40)
    }
    hero.session.send({ t: 'moveTo', x: 999_999, z: -999_999 })
    await sleep(60)
    hero.session.send(intents.moveTo(...FOUNTAIN))
    await hero.inbox.next('stop', (m) => m.id === selfId && Math.hypot(m.pos[0] - FOUNTAIN[0], m.pos[2] - FOUNTAIN[1]) < 12, 10_000)
    await sleep(100)
    const held = s.ctx.world.livePoint(player(), Date.now())
    expect(valid(held)).toBeNull()
    expect(Math.hypot(held.x - FOUNTAIN[0], held.z - FOUNTAIN[1])).toBeGreaterThan(9)
    expect(held.y).toBeCloseTo(PLAZA_Y, 2)
    await sleep(Math.max(0, (player().move ? s.ctx.world.arrivalTime(player().move!) : 0) - Date.now()) + 100)

    // ---- around the fountain, down the stairs, out of the south gate to the Mangnyang field ----------------------------
    for (const [x, z] of ROUTE) {
      const w = await walk(x, z)
      expect(Math.hypot(w.stop.pos[0] - x, w.stop.pos[2] - z), `reached ${x},${z}`).toBeLessThan(0.05)
    }
    expect(s.ctx.data.inSafeArea('jangan', ...ROUTE.at(-1)!)).toBe(false)

    // ---- the Mangnyang field: every Mangnyang on open ground, drawn where the server has it -----------------------------
    await sleep(300)
    const mangs = () => [...entities.values()].filter((e) => e.kind === 'mob' && e.model === MANG && e.state !== 'dead')
    expect(mangs().length).toBeGreaterThan(5)
    for (const m of s.ctx.world.mobs.values()) if (m.def.code === MANG && m.ai !== 'dead') expect(valid(s.ctx.world.livePoint(m, Date.now())), `mob ${m.id}`).toBeNull()

    // ---- fight: kill the nearest Mangnyang until the level-up, looting on the way ---------------------------------------
    let exp = 0
    let level = 1
    let looted: EntityState | null = null
    // The server's attack walk is one straight line, and a target it cannot reach ends the attack (Gameplay.approach).
    // Which Mangnyang is nearest, and where it wanders, depends on tick timing (the seeded RNG is shared with the
    // ticks), so pick the nearest one with a clear straight walk, and pick again if the attack still ends unkilled.
    const clearWalk = (id: number) => {
      const m = s.ctx.world.mobs.get(id)
      if (!m || m.ai === 'dead') return false
      const at = s.ctx.world.positionAt(m, Date.now())
      const w = s.ctx.world.nav.walk(s.ctx.world.livePoint(player(), Date.now()), at[0], at[2])
      return w !== null && !w.blocked
    }
    for (let kill = 0, tries = 0; kill < 10 && level < 2 && tries < 20; tries++) {
      const me = player().pos
      const target = mangs()
        .filter((e) => clearWalk(e.id))
        .sort((a, b) => Math.hypot(a.pos[0] - me[0], a.pos[2] - me[2]) - Math.hypot(b.pos[0] - me[0], b.pos[2] - me[2]))[0]
      expect(target, 'a reachable Mangnyang in view').toBeDefined()
      hero.inbox.clear()
      hero.session.send(intents.attack(target!.id))
      expect(await hero.inbox.next('actionResult', (m) => m.re === 'attack')).toMatchObject({ ok: true })
      let dropped = false
      const killedMsg = hero.inbox.next('combat', (m) => m.target === target!.id && m.killed === true, 40_000)
      for (;;) {
        const done = await Promise.race([killedMsg.then(() => true), sleep(250).then(() => false)])
        if (done) break
        const mob = s.ctx.world.mobs.get(target!.id)
        if (player().action === null && mob && mob.ai !== 'dead') {
          dropped = true
          break
        }
      }
      if (dropped) {
        killedMsg.catch(() => undefined)
        continue
      }
      kill++
      const gain = await hero.inbox.next('statsDelta', (m) => m.gain?.from === target!.id)
      exp += gain.gain!.exp
      const up = hero.inbox.log.find((m): m is Msg<'levelUp'> => m.t === 'levelUp' && m.id === selfId)
      if (up) level = up.level
      await sleep(250)
      const drop: Msg<'spawn'> | false | undefined = !looted && hero.inbox.log.find((m): m is Msg<'spawn'> => m.t === 'spawn' && m.entity.kind === 'item' && m.entity.owner === selfId && entities.has(m.entity.id))
      if (drop) {
        const item: EntityState = drop.entity
        // loot lands on the ground the corpse stood on
        expect(ground.heightAt(item.pos[0], item.pos[2], item.pos[1])).toBeCloseTo(item.pos[1], 2)
        hero.inbox.clear()
        hero.session.send(intents.pickup(item.id))
        expect(await hero.inbox.next('actionResult', (m) => m.re === 'pickup', 10_000)).toMatchObject({ ok: true })
        await hero.inbox.next('inventoryUpdate')
        await hero.inbox.next('despawn', (m) => m.id === item.id)
        looted = item
      }
    }
    expect(level, `levelled up after ${exp} EXP`).toBe(2)
    expect(looted, 'something dropped and was picked up').not.toBeNull()
    expect(s.ctx.store.characterById(created.id)!.level).toBe(2)

    // ---- return scroll (the GM grants it; a 5 s cast even in combat, then warps to town on the plaza) -----------------
    // (the owner CLI's grant, in process: the CLI is another SQLite connection, which the server's poll notices)
    s.ctx.store.setRole(s.ctx.store.accountByName(`hero_${suffix}`)!.id, 'gm')
    s.ctx.refreshRoles(true)
    await hero.inbox.next('role', (m) => m.role === 'gm', 3000)
    hero.inbox.clear()
    hero.session.send({ t: 'gm', cmd: 'item', args: [RETURN_SCROLL] })
    const granted = await hero.inbox.next('gmResult')
    expect(granted.ok, granted.message).toBe(true)
    const slot = (granted.data as { bag: { slot: number }[] }).bag[0]!.slot
    let warp: Msg<'warp'> | null = null
    for (let tries = 0; tries < 8 && !warp; tries++) {
      hero.inbox.clear()
      hero.session.send(hudIntent.itemUse(slot)!)
      const r = await hero.inbox.next('actionResult', (m) => m.re === 'itemUse')
      if (r.ok) {
        const end = await hero.inbox.next('itemCastEnd', (m) => m.id === selfId, 8000)
        if (end.reason === 'done') warp = await hero.inbox.next('warp', (m) => m.id === selfId)
      } else await sleep(1000)
    }
    expect(warp, 'the return scroll warps to town').not.toBeNull()
    expect(warp!.pos[0]).toBeCloseTo(sp.x, 1)
    expect(warp!.pos[2]).toBeCloseTo(sp.z, 1)
    expect(warp!.pos[1]).toBeCloseTo(PLAZA_Y, 2)
    expect(heights.heightOf(selfId, warp!.pos[0], warp!.pos[2], warp!.pos[1])).toBeCloseTo(PLAZA_Y, 2)

    // ---- death and respawn: back in town on the plaza -------------------------------------------------------------------
    hero.inbox.clear()
    s.ctx.gameplay.gmKill(player())
    await hero.inbox.next('entityUpdate', (m) => m.id === selfId && m.state === 'dead')
    hero.session.send(intents.respawn())
    expect(await hero.inbox.next('actionResult', (m) => m.re === 'respawn')).toMatchObject({ ok: true })
    const back = await hero.inbox.next('warp', (m) => m.id === selfId)
    expect(back.pos[1]).toBeCloseTo(PLAZA_Y, 2)
    expect(valid(s.ctx.world.livePoint(player(), Date.now()))).toBeNull()

    // ---- the client never sent a frame the server refused; prediction and server agree ----------------------------------
    expect(refused).toEqual([])
    console.log(`wave2 e2e divergence: ${div.moves} own moves (${div.frames} frames), ${div.stops} stops/warps: end ${(div.endXZ * 100).toFixed(2)} cm, ` +
      `along the walk x/z ${(div.alongXZ * 100).toFixed(2)} cm, y ${(div.alongY * 100).toFixed(2)} cm, at stops y ${(div.stopY * 100).toFixed(2)} cm; ` +
      `${div.others} other-entity placements, y ${(div.othersY * 100).toFixed(2)} cm
  worst along: ${worstAlong}
  worst stop: ${worstStop}`)
    expect(div.moves).toBeGreaterThan(8)
    expect(div.endXZ).toBeLessThan(0.01)
    expect(div.alongXZ).toBeLessThan(0.03) // the server walks its legs, which skip the ~2 cm seams between surfaces
    expect(div.alongY).toBeLessThan(0.02)
    expect(div.stopY).toBeLessThan(0.01)
    expect(div.others).toBeGreaterThan(50)
    expect(div.othersY).toBeLessThan(0.01)
  }, 180_000)
})

/**
 * Mob skills on the client, on the real rows (docs/WAVE_PLAN2.md D4, §6.4 MS-S; docs/SYSTEMS_COMBAT.md §2.5): the
 * acceptance check of FX-C1's presentation path against wave 8's server contract. The exported MSKILL rows
 * (work/out/data/skills.json), the fx index (work/out/fx/skills.json) and the converted mob models (glb + sidecar clips)
 * go through the skills feature's own wiring (createSkillPresenter, portOf, SkillFx) on a fake clock, fed with the
 * messages mob-skills.ts sends: `cast` at the swing, `combat {skill, instance}` at the release (or at a projectile's
 * landing, with `at`), `castEnd` when the swing is lost. Each message passes the shared validator first.
 *
 * - Mangyang ATTACK02: the cast plays ATTACK2 and its two hits show at the clip's events (821 / 1381 ms).
 * - Tiger Girl ATTACK01 (a 1.1 s wind-up): `castEnd target_lost` stops the clip and the caster's stages.
 * - Black Tiger howl (ATTACK3, which its model lacks): plays ATTACK1 and still shows the hit and the howl effect.
 * - Tomb Stone Ghost force bolt: the bolt flies from the SHOT event and lands with the hit at `combat.at`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ArcRotateCamera, AssetContainer, LoadAssetContainerAsync, MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import '@babylonjs/loaders/glTF/2.0/index.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FX_FORMAT, FX_FPS, FX_VERSION, FxLibrary, type FxEffect } from '@sro/fx'
import { validateServerMessage, type ServerMessage, type SkillDef } from '@sro/shared'
import { SkillCatalog } from '../src/content/skills.ts'
import { CharacterActor } from '../src/three/models.ts'
import type { EntityView } from '../src/world/entities.ts'
import { createSkillPresenter, portOf } from '../src/world/features/skills.ts'
import type { FxLabEntry } from '../src/world/fx/types.ts'
import { readFxSkills, SkillFx } from '../src/world/skill-fx.ts'

const OUT = join(import.meta.dirname, '../../../work/out')
const MODELS = ['mangnyang', 'tigerwoman', 'whitetiger_clon', 'tombstone']
const FILES = ['fx/skills.json', 'data/skills.json', ...MODELS.flatMap(m => [`mob/china/${m}.glb`, `mob/china/${m}.json`])]
const ready = FILES.every(f => existsSync(join(OUT, f)))
const read = (f: string) => JSON.parse(readFileSync(join(OUT, f), 'utf8'))

/** Fake-clock step (ms). */
const DT = 10

/** A finite synthetic program for every effect key (no fetch). */
function program(key: string): FxEffect {
  const LINK = { positionDepth: 1, matrixDepth: 1, velocityDepth: 0, followDepth: 1, localMotion: false, shapeMotion: true, keepMatrix: false, keepOrigin: false }
  return {
    format: FX_FORMAT, version: FX_VERSION, key, fps: FX_FPS, scale: 1, textures: [], meshes: [],
    nodes: [
      { name: 'root', parent: -1, frames: 6, life: 'extinct', emit: { start: 0, duration: 1, period: 1, limit: 1, rate: 1 }, link: { ...LINK }, render: 'none', view: 'none', material: null, commands: [] },
      {
        name: 'plate', parent: 0, frames: 3, life: 'extinct', emit: { start: 0, duration: 3, period: 1, limit: 4, rate: 1 }, link: { ...LINK }, render: 'plate', view: 'billboard',
        material: { texture: -1, mesh: -1, blend: 'add', cull: 'none', colorOp: 'diffuse', alphaOp: 'diffuse', d3d: { srcBlend: 5, dstBlend: 2, cull: 1, colorOp: 2, alphaOp: 2 } }, commands: [],
      },
    ],
    duration: null, provenance: 'mob-skill-view', warnings: [],
  }
}

const boxLoader = async (url: string, sc: Scene) => {
  const c = new AssetContainer(sc)
  const box = MeshBuilder.CreateBox(`msv:${url}`, { width: 0.05, height: 0.05, depth: 1 }, sc)
  sc.removeMesh(box)
  c.meshes.push(box)
  return c
}

let engine: NullEngine
let scene: Scene

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  scene.useRightHandedSystem = true
  scene.activeCamera = new ArcRotateCamera('cam', 0.5, 1, 12, Vector3.Zero(), scene)
})

afterAll(() => {
  scene?.dispose()
  engine?.dispose()
})

async function loadMob(name: string, code: string): Promise<CharacterActor> {
  const b = readFileSync(join(OUT, `mob/china/${name}.glb`))
  const container = await LoadAssetContainerAsync(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), scene, { pluginExtension: '.glb' })
  return new CharacterActor(scene, { code, glb: `/out/mob/china/${name}.glb` }, { container, sidecar: read(`mob/china/${name}.json`), packs: null })
}

interface View {
  id: number
  root: TransformNode
  yaw: number
  height: number
  isDisposed: boolean
  dead: boolean
  kind: 'player' | 'mob'
  scale: number
  state: { model: string }
  pos: Vector3
  actor: CharacterActor | null
  face(x: number, z: number): void
}

function view(id: number, model: string, kind: View['kind'], at: [number, number, number], yaw: number, actor: CharacterActor | null): View & EntityView {
  const root = new TransformNode(`msv:${id}`, scene)
  root.position.set(...at)
  root.rotationQuaternion = null
  root.rotation.y = yaw
  if (actor) actor.root.parent = root
  const v: View = { id, root, yaw, height: actor ? actor.height : 1.8, isDisposed: false, dead: false, kind, scale: 1, state: { model }, pos: root.position, actor, face() {} }
  return v as View & EntityView
}

/** A message as the server sends it: it must pass the shared validator (the client drops anything else). */
function wire<T extends ServerMessage>(m: T): T {
  const r = validateServerMessage(JSON.parse(JSON.stringify(m)))
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return m
}

/** Instances of mob casts (mob-skills.ts INSTANCE_BASE: their own range above the skill engine's). */
let instance = 1_500_000_000
const HERO = 1

describe.skipIf(!ready)('mob skills on the real rows (MS-S acceptance of FX-C1, D4)', () => {
  const defs: SkillDef[] = ready ? (read('data/skills.json').entries as SkillDef[]) : []
  const fxJson = ready ? read('fx/skills.json') : null

  /** The skills feature's presenter with a real SkillFx on the fx index, a hero target and one mob caster. */
  async function rig(model: string, code: string, at: [number, number, number]) {
    let now = 0
    const lib = new FxLibrary(scene, '/out/')
    const index = readFxSkills(fxJson)
    const keys = new Set<string>()
    for (const g of index.values()) for (const k of [g.damage, g.defense, g.arrowTail, g.arrowForce, ...g.stages.flatMap(s => [s.effect, s.effect2])]) if (k) keys.add(k)
    for (const c of Object.values(fxJson.characters as Record<string, { bloodType: string | null }>)) if (c.bloodType) keys.add(c.bloodType)
    for (const k of keys) {
      lib.addProgram(program(k))
      if (/_2_\w+blood\.efp$/.test(k)) lib.addProgram(program(k.replace(/\.efp$/, '_down.efp')))
    }
    lib.addProgram(program('system/ch_blocking.efp'))
    const fx = new SkillFx(scene, () => now, { library: lib, modelLoader: boxLoader, lights: false })
    fx.setIndex(fxJson)
    const log: FxLabEntry[] = []
    fx.onSpawn = e => log.push(e)
    const catalog = new SkillCatalog(defs, [], [])
    const actor = await loadMob(model, code)
    const mob = view(60, code, 'mob', at, Math.PI, actor)
    const hero = view(HERO, 'CHAR_CH_MAN_ADVENTURER', 'player', [0, 0, 0], 0, null)
    const views = new Map<number, View & EntityView>([[mob.id, mob], [hero.id, hero]])
    const { player } = createSkillPresenter(catalog, fx, id => views.get(id))
    const port = portOf(mob, id => views.get(id))!
    // The clips the mob's actor actually plays (glb clip names) and the action's token.
    const plays: string[][] = []
    const playSkill = actor.playSkill.bind(actor)
    actor.playSkill = phases => {
      plays.push(phases.map(p => p.clip.name))
      return playSkill(phases)
    }
    let token: number | null = null
    const rec = {
      ...port,
      play(g: string | undefined, phases: Parameters<typeof port.play>[1]) {
        token = port.play(g, phases)
        return token
      },
    }
    const shown: { i: number; t: number }[] = []
    /** The skills feature's hit presentation (onCombatHit): the MSKILL group's impact on the hero at the hit's moment. */
    const combat = (msg: Extract<ServerMessage, { t: 'combat' }>, serverNow: number) => {
      const def = catalog.get(msg.skill!)!
      const cues = def.hitCues ?? []
      return player.combat(msg, now, serverNow, i => {
        shown.push({ i, t: now })
        fx.hit(def.group!, hero, { attacker: mob, cue: cues[i] ?? cues[cues.length - 1], index: i, landed: true, instance: msg.instance, outcome: msg.hits[i]!.outcome })
      })
    }
    const run = async (until: number) => {
      while (now < until) {
        now += DT
        player.tick(now)
        fx.update(DT / 1000)
        for (let i = 0; i < 8; i++) await Promise.resolve()
      }
    }
    const dispose = () => {
      fx.dispose()
      lib.dispose()
      actor.dispose()
    }
    return { get now() { return now }, player, fx, log, catalog, actor, mob, hero, rec, plays, shown, combat, run, dispose, get token() { return token } }
  }

  it('Mangyang ATTACK02 plays ATTACK2 and shows its two hits at the clip events 821 / 1381 ms', async () => {
    const r = await rig('mangnyang', 'MOB_CH_MANGNYANG', [0, 0, 1.5])
    const skill = 'MSKILL_CH_MANGNYANG_ATTACK02'
    const row = r.catalog.get(skill)!
    expect(row).toMatchObject({ mob: true, animation: { shot: 'ATTACK2' }, castMs: 0, actionMs: 2500 })
    const inst = ++instance
    // mob-skills.ts: castMs 0 -> `cast` and the rolled `combat` in the same tick.
    const cast = wire({ t: 'cast' as const, id: r.mob.id, skill, instance: inst, target: HERO, prepareMs: 0, castMs: row.castMs, actionMs: row.actionMs })
    const hit = wire({ t: 'combat' as const, attacker: r.mob.id, target: HERO, skill, instance: inst, hits: [{ outcome: 'hit' as const, damage: 9, hp: 191 }, { outcome: 'hit' as const, damage: 8, hp: 183 }] })
    const a = r.player.cast(cast, r.now, r.rec)
    expect(a?.group).toBe(skill)
    expect(r.plays).toEqual([['ATTACK2']])
    expect(r.player.hitTimes(a!, hit, r.now, 0)).toEqual([821, 1381])
    expect(r.combat(hit, 0)).toBe(true)
    await r.run(3000)
    expect(r.shown.map(s => s.i)).toEqual([0, 1])
    expect(r.shown.map(s => s.t)).toEqual([830, 1390])
    // The damage effect of its group (hit_3_normal) played on the hero for each hit.
    expect(r.log.filter(e => e.entity === HERO && e.key === 'hiteffect/hit_3_normal.efp').length).toBeGreaterThanOrEqual(2)
    r.dispose()
  })

  it('Tiger Girl ATTACK01: castEnd target_lost during the 1.1 s wind-up stops the clip; no hit shows', async () => {
    const r = await rig('tigerwoman', 'MOB_CH_TIGERWOMAN', [0, 0, 4])
    const skill = 'MSKILL_CH_TIGERWOMAN_ATTACK01'
    const row = r.catalog.get(skill)!
    expect(row).toMatchObject({ castMs: 1109, actionMs: 1391 })
    const inst = ++instance
    r.player.cast(wire({ t: 'cast' as const, id: r.mob.id, skill, instance: inst, target: HERO, prepareMs: 0, castMs: row.castMs, actionMs: row.actionMs }), r.now, r.rec)
    expect(r.plays).toEqual([['ATTACK1']])
    await r.run(500)
    expect(r.actor.isSkillPlaying(r.token!)).toBe(true)
    r.player.castEnd(wire({ t: 'castEnd' as const, id: r.mob.id, instance: inst, reason: 'target_lost' as const }), r.rec)
    expect(r.actor.isSkillPlaying(r.token!)).toBe(false)
    expect(r.player.action(inst)?.ended).toBe(true)
    await r.run(3000)
    expect(r.shown).toEqual([])
    r.dispose()
  })

  it('Black Tiger howl: no ATTACK3 on its model -> plays ATTACK1, the howl effect and the hit still show', async () => {
    const r = await rig('whitetiger_clon', 'MOB_CH_WHITETIGER_CLON', [0, 0, 1.8])
    const skill = 'MSKILL_CH_WHITETIGER_CLON_ATTACK03'
    const row = r.catalog.get(skill)!
    expect(row).toMatchObject({ animation: { shot: 'ATTACK3' }, castMs: 1044, area: { shape: 'caster', distance: 2 } })
    expect([...r.actor.clips.keys()].filter(n => /^ATTACK/.test(n))).toEqual(['ATTACK1'])
    const inst = ++instance
    const a = r.player.cast(wire({ t: 'cast' as const, id: r.mob.id, skill, instance: inst, target: HERO, prepareMs: 0, castMs: row.castMs, actionMs: row.actionMs }), r.now, r.rec)
    expect(r.plays).toEqual([['ATTACK1']])
    // The release at castMs (1044): `combat` comes then; the hit shows at ATTACK1's event (1164 ms).
    await r.run(row.castMs)
    const hit = wire({ t: 'combat' as const, attacker: r.mob.id, target: HERO, skill, instance: inst, hits: [{ outcome: 'hit' as const, damage: 120, hp: 80 }] })
    expect(r.player.hitTimes(a!, hit, r.now, row.castMs)).toEqual([1164])
    r.combat(hit, row.castMs)
    await r.run(2600)
    expect(r.shown).toEqual([{ i: 0, t: 1170 }])
    expect(r.log.some(e => e.entity === r.mob.id && e.key === 'monster/skill_whitetiger_howling.efp')).toBe(true)
    r.dispose()
  })

  it('Tomb Stone Ghost force bolt: flies from its SHOT event and lands with the hit at combat.at', async () => {
    const r = await rig('tombstone', 'MOB_CH_TOMBSTONE_CLON', [0, 0, 8])
    const skill = 'MSKILL_CH_TOMBSTONE_CLON_ATTACK01'
    const row = r.catalog.get(skill)!
    expect(row.hitCues?.[0]?.projectile).toMatchObject({ speed: 200 })
    const inst = ++instance
    r.player.cast(wire({ t: 'cast' as const, id: r.mob.id, skill, instance: inst, target: HERO, prepareMs: 0, castMs: row.castMs, actionMs: row.actionMs }), r.now, r.rec)
    expect(r.plays).toEqual([['ATTACK1']])
    await r.run(row.castMs + 30)
    expect(r.fx.stats.flights).toBeGreaterThanOrEqual(1)
    expect(r.shown).toEqual([])
    // The server lands it at release + 8 m / 20 m/s and sends `combat` then, with `at` (skills/timing.ts arrivalAt).
    const at = row.castMs + 400
    await r.run(at)
    const hit = wire({ t: 'combat' as const, attacker: r.mob.id, target: HERO, skill, instance: inst, at, hits: [{ outcome: 'hit' as const, damage: 60, hp: 140 }] })
    const received = r.now
    r.combat(hit, at)
    await r.run(at + 1500)
    expect(r.shown.length).toBe(1)
    expect(r.shown[0]!.t - received).toBeLessThanOrEqual(DT)
    expect(r.fx.stats.flights).toBe(0)
    r.dispose()
  })
})

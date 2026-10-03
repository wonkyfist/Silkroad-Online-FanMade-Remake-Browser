/**
 * Skill VFX (docs/WAVE_PLAN.md §6 W5-V; docs/SKILLS.md §7): the stage schedule from the clips' hit events and the
 * skill's hitCues on a fake clock (ActionPlayer -> SkillFx, wired like world/features/skills.ts), projectiles that
 * wait for their hit, buff/imbue/status loops, and no leaks after 1,000 casts (created vs disposed meshes).
 * NullEngine; synthetic effect programs registered on the FxLibrary (no fetch).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ArcRotateCamera, AssetContainer, MeshBuilder, NullEngine, Scene, TransformNode, Vector3, type AbstractMesh } from '@babylonjs/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FX_FORMAT, FX_FPS, FX_VERSION, FxLibrary, type FxEffect } from '@sro/fx'
import type { MasteryDef, SkillDef } from '@sro/shared'
import { SkillCatalog } from '../src/content/skills.ts'
import type { EntityView } from '../src/world/entities.ts'
import { damageStages, HOLD_MS, isImbue, readFxSkills, scheduleStages, SkillFx, stageRoll, STATUS_FX, type FxSkill, type FxStage } from '../src/world/skill-fx.ts'
import { ActionPlayer, mobSkillDef, type ActionPort, type CastMessage, type ClipFacts, type PhasePlan, type SkillCombat } from '../src/world/skills-view.ts'
import { pruneSamples, stripPoints, trailStyle } from '../src/world/fx/trail.ts'

// ---- fixture ------------------------------------------------------------------------------------------------------

const LINK = { positionDepth: 1, matrixDepth: 1, velocityDepth: 0, followDepth: 1, localMotion: false, shapeMotion: true, keepMatrix: false, keepOrigin: false }

/** A finite effect: a root that lives 8 ticks and emits one untextured plate per tick for 4 ticks (0.6 s in all). */
function program(key: string): FxEffect {
  return {
    format: FX_FORMAT,
    version: FX_VERSION,
    key,
    fps: FX_FPS,
    scale: 1,
    textures: [],
    meshes: [],
    nodes: [
      { name: 'root', parent: -1, frames: 8, life: 'extinct', emit: { start: 0, duration: 1, period: 1, limit: 1, rate: 1 }, link: { ...LINK }, render: 'none', view: 'none', material: null, commands: [] },
      {
        name: 'plate',
        parent: 0,
        frames: 4,
        life: 'extinct',
        emit: { start: 0, duration: 4, period: 1, limit: 8, rate: 1 },
        link: { ...LINK },
        render: 'plate',
        view: 'billboard',
        material: { texture: -1, mesh: -1, blend: 'add', cull: 'none', colorOp: 'diffuse', alphaOp: 'diffuse', d3d: { srcBlend: 5, dstBlend: 2, cull: 1, colorOp: 2, alphaOp: 2 } },
        commands: [],
      },
    ],
    duration: null,
    provenance: 'test',
    warnings: [],
  }
}

function stage(p: Partial<FxStage> & Pick<FxStage, 'phase' | 'actType'>): FxStage {
  return {
    startEvent: 0, move: 'MOV_NONE,0,0,0', effect: null, startBone: null, startOffset: '0,0,0', targetBone: null, targetOffset: '0,0,0',
    effect2: null, rotate: '0', script: null, dmg: false, kill: 0, sound: { begin: null, end: null }, ...p,
  }
}

/** The fx/skills.json rows of the first-slice skills (shapes as the exporter writes them, keys shortened). */
const FX: FxSkill[] = [
  {
    group: 'SKILL_CH_SWORD_SMASH_A', aniGroup: 'SWORD', defense: null, damage: 'hit/smash_spark.efp', arrowTail: null, arrowForce: null,
    stages: [
      stage({ phase: 'SHOT', startEvent: 1, actType: 'AT_ONE_FOLLOW', effect: 'fx/smash_slash.efp', startOffset: '0,10,-13', rotate: '1035' }),
      stage({ phase: 'SHOT', startEvent: 1, actType: 'AT_DMG_POS', effect: 'fx/smash_mark.efp', dmg: true, script: 'SCT_RUT,315' }),
    ],
  },
  {
    group: 'SKILL_CH_SWORD_GEOMGI_A', aniGroup: 'SWORD', defense: null, damage: 'hit/geomgi_spark.efp', arrowTail: null, arrowForce: null,
    stages: [
      stage({ phase: 'SHOT', startEvent: 1, actType: 'AT_ONE_FOLLOW', effect: 'fx/geomgi_swing.efp', startBone: 'Bip01 R Hand' }),
      stage({ phase: 'SHOT', startEvent: 2, actType: 'AT_MOV_1TAR', move: 'MOV_STRAIGHT,0,300,300', effect: 'fx/geomgi_blade.efp', startOffset: '0,10,0', dmg: true }),
    ],
  },
  {
    group: 'SKILL_CH_COLD_GANGGI_A', aniGroup: 'DEFAULT', defense: null, damage: null, arrowTail: null, arrowForce: null,
    stages: [
      stage({ phase: 'READY', actType: 'AT_LOOP', effect: 'fx/ganggi_ready.efp' }),
      stage({ phase: 'SHOT', actType: 'AT_ONE_FOLLOW', kill: 1 }),
      stage({ phase: 'ACT_S', actType: 'AT_ONE_FOLLOW', effect: 'fx/ganggi_start.efp', startBone: 'Bip01' }),
      stage({ phase: 'ACT_L', actType: 'AT_LOOP', effect: 'fx/ganggi_keep.efp', startBone: 'Bip01' }),
    ],
  },
  {
    group: 'SKILL_CH_COLD_GIGONGTA_A', aniGroup: 'DEFAULT', defense: null, damage: 'hit/cold_hit.efp', arrowTail: null, arrowForce: null,
    stages: [
      stage({ phase: 'ACT_S', actType: 'AT_ONE_FOLLOW', effect: 'fx/gigongta_motion.efp', startBone: 'Bip01 R Finger2' }),
      stage({ phase: 'ACT_L', actType: 'AT_LOOP', effect: 'fx/gigongta_keep.efp', startBone: 'Bip01 R Finger2' }),
    ],
  },
  { group: 'SKILL_CH_BOW_BASE', aniGroup: 'BOW', defense: null, damage: 'hit/bow_spark.efp', arrowTail: 'fx/bow_tail.efp', arrowForce: null, stages: [] },
]

const KEYS = [
  ...new Set([
    ...FX.flatMap(s => [s.damage, s.arrowTail, ...s.stages.map(st => st.effect)]).filter((k): k is string => !!k),
    'battle/status_bad_icing_on.efp', 'battle/status_bad_icing_off.efp', 'battle/status_bad_stun.efp', 'battle/status_bad_burn.efp',
  ]),
]

const sword = ['sword', 'blade'] as SkillDef['weapons']
const enemy = { required: true, groups: ['enemy_mob', 'enemy_player'] } as SkillDef['targets']
const SMASH: SkillDef = {
  code: 'SKILL_CH_SWORD_SMASH_A_01', id: 4, name: 'Strike Smash', mastery: 'BICHEON', masteryLevel: 5, skillLevel: 1, sp: 2, mp: 19, category: 'melee', castMs: 411,
  actionMs: 1022, cooldownMs: 3000, range: 0, weapons: sword, icon: null, group: 'SKILL_CH_SWORD_SMASH_A', animation: { shot: 'SKILL_1' },
  damage: { physPct: 143, magPct: 0, flat: [15, 18], hits: 1 }, kind: 'attack', targets: enemy, aniGroup: 'SWORD', hitCues: [{ phase: 'SHOT', event: 1 }],
}
const GEOMGI: SkillDef = {
  code: 'SKILL_CH_SWORD_GEOMGI_A_01', id: 30, name: 'Soul Cut Blade', mastery: 'BICHEON', masteryLevel: 14, skillLevel: 1, sp: 20, mp: 34, category: 'ranged',
  castMs: 341, actionMs: 792, cooldownMs: 4000, range: 12, weapons: sword, icon: null, group: 'SKILL_CH_SWORD_GEOMGI_A', animation: { shot: 'SKILL_5' },
  damage: { physPct: 200, magPct: 0, flat: [30, 40], hits: 1 }, kind: 'attack', targets: enemy, aniGroup: 'SWORD',
  hitCues: [{ phase: 'SHOT', event: 2, projectile: { move: 'MOV_STRAIGHT', delayMs: 0, speed: 300 } }],
}
const GANGGI: SkillDef = {
  code: 'SKILL_CH_COLD_GANGGI_A_01', id: 93, name: 'Weak Guard of Ice', mastery: 'COLD', masteryLevel: 8, skillLevel: 1, sp: 6, mp: 72, category: 'buff',
  castMs: 1000, actionMs: 1000, cooldownMs: 2000, range: 0, weapons: [], icon: null, group: 'SKILL_CH_COLD_GANGGI_A',
  animation: { ready: 'READY04', wait: 'WAIT04', shot: 'SKILL_4' }, preparingMs: 1000, kind: 'buff', targets: { required: false, groups: [] }, aniGroup: 'DEFAULT', durationMs: 335294,
}
const BOW_BASE: SkillDef = {
  code: 'SKILL_CH_BOW_BASE_01', id: 70, name: null as unknown as string, mastery: 'PACHEON', masteryLevel: 0, skillLevel: 1, sp: 0, mp: 0, category: 'ranged', castMs: 0,
  actionMs: 840, cooldownMs: 840, range: 0, weapons: ['bow'] as SkillDef['weapons'], icon: null, group: 'SKILL_CH_BOW_BASE', animation: { shot: 'ATTACK1' },
  damage: { physPct: 84, magPct: 0, flat: [0, 0], hits: 1 }, basicAttack: true, kind: 'attack', targets: enemy,
}
const MASTERIES: MasteryDef[] = [
  { code: 'BICHEON', id: 257, name: 'Bicheon', race: 'china', weapons: ['sword', 'blade'], skills: [], tab: 'weapon', page: 0, lines: 9 },
  { code: 'COLD', id: 273, name: 'Cold', race: 'china', weapons: [], skills: [], tab: 'force', page: 0, lines: 8 },
]
const CLIPS: Record<string, ClipFacts> = {
  SKILL_1: { durationMs: 1433, hits: [410] },
  SKILL_5: { durationMs: 1133, hits: [86, 341] },
  READY04: { durationMs: 1000, hits: [] },
  WAIT04: { durationMs: 2000, hits: [] },
  SKILL_4: { durationMs: 1000, hits: [106] },
}

class FakePort implements ActionPort {
  private serial = 0
  private readonly live = new Set<number>()
  clip(_g: string | undefined, type: string): ClipFacts | null {
    return CLIPS[type] ?? null
  }
  play(_g: string | undefined, _p: readonly PhasePlan[]): number {
    this.live.clear()
    this.live.add(++this.serial)
    return this.serial
  }
  stop(token: number): void {
    this.live.delete(token)
  }
  playing(token: number): boolean {
    return this.live.has(token)
  }
  face(): void {}
}

// ---- world -------------------------------------------------------------------------------------------------------

let engine: NullEngine
let scene: Scene

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  scene.useRightHandedSystem = true
  scene.activeCamera = new ArcRotateCamera('cam', 0.5, 1, 12, Vector3.Zero(), scene)
})

afterAll(() => {
  scene.dispose()
  engine.dispose()
})

interface FakeView {
  id: number
  root: TransformNode
  yaw: number
  height: number
  isDisposed: boolean
  dead: boolean
  actor: { joint(name: string): TransformNode | undefined } | null
}

function makeView(id: number, x: number, z: number, weapon = false): FakeView & EntityView {
  const root = new TransformNode(`view${id}`, scene)
  root.position.set(x, 0, z)
  const joints = new Map<string, TransformNode>()
  if (weapon) {
    const hand = new TransformNode(`view${id}:hand`, scene)
    hand.parent = root
    hand.position.set(0.3, 1.1, 0)
    const blade = MeshBuilder.CreateBox(`view${id}:blade`, { width: 0.05, height: 0.9, depth: 0.12 }, scene)
    blade.parent = hand
    joints.set('Bip01 R HandMid', hand)
  }
  const v: FakeView = { id, root, yaw: 0, height: 1.8, isDisposed: false, dead: false, actor: { joint: n => joints.get(n) } }
  return v as FakeView & EntityView
}

/** The ActionPlayer and SkillFx wired as world/features/skills.ts wires them, on a fake clock. */
function rig() {
  let now = 0
  const lib = new FxLibrary(scene, '/out/')
  for (const k of KEYS) lib.addProgram(program(k))
  const fx = new SkillFx(scene, () => now, { library: lib })
  fx.setSkills(readFxSkills({ skills: FX }))
  const catalog = new SkillCatalog([SMASH, GEOMGI, GANGGI, BOW_BASE], MASTERIES, [])
  const views = new Map<number, FakeView & EntityView>()
  const view = (id: number) => views.get(id)
  const player = new ActionPlayer(catalog, {
    onPhase(a, phase, start, clip) {
      const caster = view(a.caster)
      if (!caster) return
      const shot = a.phases.find(p => p.plan.phase === 'SHOT')
      const loopUntil = phase.phase === 'SHOT' ? start + phase.ms : shot ? shot.start : a.release
      fx.stages(a.group, phase.phase, { caster, ...(a.target !== undefined ? { target: view(a.target) } : {}), start, hits: clip?.hits ?? [], loopUntil })
    },
    onEnd(a) {
      fx.stopCasterLoops(a.caster)
    },
  })
  /** Hit i shown (world.ts presentHit -> the feature's onCombatHit). */
  const showHit = (msg: SkillCombat, i: number) => {
    const def = catalog.get(msg.skill!)
    const cues = def?.hitCues ?? []
    fx.hit(catalog.groupOf(msg.skill!), view(msg.target), { attacker: view(msg.attacker), cue: cues[i] ?? cues[cues.length - 1], index: i, landed: true, basic: !!def?.basicAttack })
  }
  const started: { key: string; at: number }[] = []
  // Meshes as they are made (onNewMeshAddedObservable fires a tick later, via SetImmediate).
  const addMesh = scene.addMesh
  const meshAdded: ((m: AbstractMesh) => void)[] = []
  scene.addMesh = function (m: AbstractMesh, recursive?: boolean) {
    const key = /^fx:(.+?)#/.exec(m.name)?.[1] ?? m.name
    started.push({ key, at: now })
    for (const f of meshAdded) f(m)
    return addMesh.call(this, m, recursive)
  }
  const flush = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }
  const step = async (until: number, dt = 10) => {
    while (now < until) {
      now = Math.min(until, now + dt)
      player.tick(now)
      fx.update(dt / 1000)
      await flush()
    }
  }
  return {
    fx, player, views, catalog, started, lib, step, flush, showHit, meshAdded,
    get now() {
      return now
    },
    set now(t: number) {
      now = t
    },
    port: new FakePort(),
    firstAt: (key: string) => started.find(s => s.key === key)?.at,
    dispose() {
      scene.addMesh = addMesh
      fx.dispose()
      lib.dispose()
      for (const v of views.values()) v.root.dispose()
    },
  }
}

const cast = (id: number, skill: string, instance: number, ms: [number, number, number], target = 50): CastMessage => ({ t: 'cast', id, skill, instance, target, prepareMs: ms[0], castMs: ms[1], actionMs: ms[2] })
const combat = (attacker: number, skill: string, instance: number | undefined, extra: Partial<SkillCombat> = {}): SkillCombat => ({
  t: 'combat', attacker, target: 50, skill, ...(instance !== undefined ? { instance } : {}), hits: [{ damage: 10, outcome: 'hit', hp: 90 }], ...extra,
})

// ---- tests -------------------------------------------------------------------------------------------------------

describe('stage schedule', () => {
  it('starts rows at phase start + their hit event and leaves DMG rows to the hits', () => {
    const smash = readFxSkills({ skills: FX }).get('SKILL_CH_SWORD_SMASH_A')!
    const s = scheduleStages(smash, 'SHOT', 1000, [410])
    expect(s.map(x => [x.key, x.at])).toEqual([['fx/smash_slash.efp', 1410]])
    expect(damageStages(smash, { phase: 'SHOT', event: 1 }).map(x => x.effect)).toEqual(['fx/smash_mark.efp'])
    expect(damageStages(smash, { phase: 'SHOT', event: 2 })).toEqual([])
    // An export without the DMG flag schedules every row with its phase (the wave-3 behaviour).
    const old = { ...smash, stages: smash.stages.map(({ dmg: _d, ...st }) => st) }
    expect(scheduleStages(old, 'SHOT', 0, [410]).map(x => x.key)).toEqual(['fx/smash_slash.efp', 'fx/smash_mark.efp'])
    expect(damageStages(old, { phase: 'SHOT', event: 1 })).toEqual([])
    // Projectiles launch with their phase even when they are the damage row; kill rows count without an effect.
    const geomgi = readFxSkills({ skills: FX }).get('SKILL_CH_SWORD_GEOMGI_A')!
    expect(scheduleStages(geomgi, 'SHOT', 0, [86, 341]).map(x => [x.key, x.at])).toEqual([['fx/geomgi_swing.efp', 86], ['fx/geomgi_blade.efp', 341]])
    const ganggi = readFxSkills({ skills: FX }).get('SKILL_CH_COLD_GANGGI_A')!
    expect(scheduleStages(ganggi, 'SHOT', 5, []).map(x => [x.stage.kill, x.at])).toEqual([[1, 5]])
    expect(stageRoll('0', 'SCT_RUT,315')).toBeCloseTo((315 * Math.PI) / 180)
    expect(stageRoll('1035', 'SCT_RUT,45')).toBeCloseTo((315 * Math.PI) / 180)
    expect(isImbue(readFxSkills({ skills: FX }).get('SKILL_CH_COLD_GIGONGTA_A')!)).toBe(true)
    expect(isImbue(ganggi)).toBe(false)
  })

  it('plays Strike Smash: slash at event 1 of SKILL_1, the damage mark and spark at the hitCue', async () => {
    const r = rig()
    r.views.set(1, makeView(1, 0, 0))
    r.views.set(50, makeView(50, 0, 2))
    r.now = 1000
    r.player.cast(cast(1, SMASH.code, 11, [0, 411, 1022]), 1000, r.port)
    // The combat arrives at the release (t0 + cast), before its cue.
    await r.step(1200)
    expect(r.player.combat(combat(1, SMASH.code, 11), r.now, r.now, i => r.showHit(combat(1, SMASH.code, 11), i))).toBe(true)
    await r.step(2600)
    expect(r.firstAt('fx/smash_slash.efp')).toBe(1410)
    expect(r.firstAt('fx/smash_mark.efp')).toBe(1410)
    expect(r.firstAt('hit/smash_spark.efp')).toBe(1410)
    // Everything is gone once played out.
    await r.step(9000, 50)
    expect(r.fx.stats).toMatchObject({ live: 0, pending: 0, flights: 0 })
    r.dispose()
  })

  it('flies Soul Cut Blade from event 2 and lands it with its hit (at most HOLD_MS late)', async () => {
    const r = rig()
    r.views.set(1, makeView(1, 0, 0))
    r.views.set(50, makeView(50, 0, 9))
    r.player.cast(cast(1, GEOMGI.code, 21, [0, 341, 792]), 0, r.port)
    await r.step(340)
    // 10 ms frames: event 1 (86 ms) shows on the frame at 90.
    expect(r.firstAt('fx/geomgi_swing.efp')).toBe(90)
    expect(r.fx.stats.flights).toBe(0)
    await r.step(341)
    expect(r.firstAt('fx/geomgi_blade.efp')).toBe(341)
    expect(r.fx.stats.flights).toBe(1)
    // ~9 m at 30 m/s: computed arrival about 641; the server says the blade lands at 700.
    r.player.combat(combat(1, GEOMGI.code, 21, { at: 700 }), r.now, r.now, i => r.showHit(combat(1, GEOMGI.code, 21), i))
    await r.step(690)
    expect(r.fx.stats.flights).toBe(1)
    expect(r.firstAt('hit/geomgi_spark.efp')).toBeUndefined()
    await r.step(700)
    expect(r.fx.stats.flights).toBe(0)
    expect(r.firstAt('hit/geomgi_spark.efp')).toBe(700)
    // Without its hit, a blade lands on its own HOLD_MS after the computed arrival.
    r.player.cast(cast(1, GEOMGI.code, 22, [0, 341, 792]), 5000, r.port)
    await r.step(5341)
    expect(r.fx.stats.flights).toBe(1)
    await r.step(5341 + 290 + HOLD_MS)
    expect(r.fx.stats.flights).toBe(1)
    await r.step(5341 + 320 + HOLD_MS)
    expect(r.fx.stats.flights).toBe(0)
    r.dispose()
  })

  it('shoots an arrow for bow basic attacks and sparks when it arrives', async () => {
    const r = rig()
    r.views.set(1, makeView(1, 0, 0))
    r.views.set(50, makeView(50, 0, 10))
    r.now = 100
    // Basic attacks keep the default presentation; world.ts calls onCombatHit at the release.
    expect(r.player.combat(combat(1, BOW_BASE.code, undefined), 100, 100, () => {})).toBe(false)
    r.showHit(combat(1, BOW_BASE.code, undefined), 0)
    await r.flush()
    expect(r.fx.stats.flights).toBe(1)
    expect(r.started.some(s => s.key === 'fx:arrow')).toBe(true)
    expect(r.firstAt('hit/bow_spark.efp')).toBeUndefined()
    await r.step(400)
    expect(r.fx.stats.flights).toBe(0)
    // Released at 100, about 10 m at 50 m/s: lands on the first frame after 301.
    expect(r.firstAt('hit/bow_spark.efp')).toBe(310)
    r.dispose()
  })

  it('a hit shown just before its projectile launches lets the projectile land on its own, not HOLD_MS later (I7B, FX lab)', async () => {
    const r = rig()
    r.views.set(1, makeView(1, 0, 0))
    r.views.set(50, makeView(50, 0, 9))
    r.player.cast(cast(1, GEOMGI.code, 41, [0, 341, 792]), 0, r.port)
    await r.step(330)
    // The hit shows at 330; the blade leaves at event 2 (341) and flies ~9 m at 30 m/s.
    r.showHit(combat(1, GEOMGI.code, 41), 0)
    expect(r.firstAt('hit/geomgi_spark.efp')).toBeDefined()
    await r.step(345)
    expect(r.fx.stats.flights).toBe(1)
    await r.step(341 + 320)
    expect(r.fx.stats.flights).toBe(0)
    r.dispose()
  })

  it('shootBasic releases the bow arrow ahead of its hit and the hit lands it with the impact (I7B, FX lab)', async () => {
    const r = rig()
    r.views.set(1, makeView(1, 0, 0))
    r.views.set(50, makeView(50, 0, 10))
    r.now = 100
    await r.flush()
    const ms = r.fx.shootBasic(r.catalog.groupOf(BOW_BASE.code), r.views.get(1)!, r.views.get(50)!)
    // about 10 m at 50 m/s
    expect(ms).toBeGreaterThan(150)
    expect(ms).toBeLessThan(260)
    expect(r.fx.stats.flights).toBe(1)
    // It waits at the victim for the hit (no impact on its own before HOLD_MS)...
    await r.step(100 + ms! + 50)
    expect(r.fx.stats.flights).toBe(1)
    expect(r.firstAt('hit/bow_spark.efp')).toBeUndefined()
    // ...and the hit shown at the arrival lands it: the spark plays with the damage number, not 70 ms after.
    const shownAt = r.now
    r.showHit(combat(1, BOW_BASE.code, undefined), 0)
    await r.step(shownAt + 10)
    expect(r.fx.stats.flights).toBe(0)
    // (its instance is built on the next frame)
    expect(r.firstAt('hit/bow_spark.efp')).toBeLessThanOrEqual(shownAt + 10)
    // A melee group flies nothing.
    expect(r.fx.shootBasic('SKILL_CH_SWORD_BASE', r.views.get(1)!, r.views.get(50)!)).toBeNull()
    r.dispose()
  })

  it('ends READY loops at the kill row, then loops ACT_L until effectRemove', async () => {
    const r = rig()
    r.views.set(1, makeView(1, 0, 0))
    r.player.cast(cast(1, GANGGI.code, 31, [1000, 1000, 1000], 1), 0, r.port)
    await r.step(900)
    const ready = r.started.filter(s => s.key === 'fx/ganggi_ready.efp').length
    expect(ready).toBeGreaterThan(0)
    expect(r.fx.stats.live).toBe(1)
    // SHOT (2000) ends the READY loop (its phase end and the kill row): it fades out, nothing else plays.
    await r.step(2500)
    expect(r.fx.stats.live).toBe(0)
    const buff = r.views.get(1)!
    r.fx.buffStart(GANGGI.group!, buff)
    r.fx.startLoop('1:7', GANGGI.group!, buff)
    await r.step(6000, 50)
    expect(r.firstAt('fx/ganggi_start.efp')).toBe(2500)
    expect(r.fx.stats.loops).toBe(1)
    const live = r.fx.stats.live
    expect(live).toBeGreaterThan(0)
    r.fx.stopLoop('1:7')
    await r.step(12000, 50)
    expect(r.fx.stats).toMatchObject({ live: 0, loops: 0 })
    r.dispose()
  })

  it('carries an imbue (no invented glow strips, M14) and runs status loops (freeze forms and breaks, stun stars)', async () => {
    const r = rig()
    const hero = makeView(1, 0, 0, true)
    const mob = makeView(50, 0, 3)
    r.views.set(1, hero)
    r.views.set(50, mob)
    await r.flush()
    r.fx.startLoop('1:9', 'SKILL_CH_COLD_GIGONGTA_A', hero)
    await r.step(300, 20)
    expect(scene.meshes.filter(m => m.name.startsWith('fx:imbue'))).toHaveLength(0)
    expect(r.fx.imbueOf(1)).toBe('SKILL_CH_COLD_GIGONGTA_A')
    r.fx.stopLoop('1:9')
    expect(r.fx.imbueOf(1)).toBeNull()
    await r.step(1200, 20)
    // Statuses.
    r.fx.status('50:3', 'freeze', mob, true)
    r.fx.status('50:4', 'stun', mob, true)
    await r.step(1500, 20)
    expect(r.firstAt('battle/status_bad_icing_on.efp')).toBe(1220)
    expect(r.firstAt('battle/status_bad_stun.efp')).toBe(1220)
    r.fx.stopLoop('50:3')
    await r.step(1520, 20)
    expect(r.firstAt('battle/status_bad_icing_off.efp')).toBe(1520)
    r.fx.stopLoop('50:4')
    // A frozen entity that just came into view (not fresh) is not re-frozen; statuses of a gone entity end silently.
    r.fx.status('50:5', 'freeze', mob, false)
    r.fx.status('50:6', 'burn', mob, false)
    r.fx.forget(50)
    await r.step(9000, 50)
    expect(r.fx.stats).toMatchObject({ live: 0, loops: 0 })
    expect(r.started.filter(s => s.key === 'battle/status_bad_icing_on.efp' && s.at > 1500)).toEqual([])
    r.dispose()
  })
})

describe('no leaks', () => {
  it('disposes every mesh it made after 1,000 casts (buffs, statuses, imbues, projectiles, interrupts)', async () => {
    const baseMeshes = scene.meshes.length
    const baseMaterials = scene.materials.length
    const r = rig()
    let created = 0
    let disposed = 0
    r.meshAdded.push(m => {
      if (!m.name.startsWith('fx:')) return
      created++
      m.onDisposeObservable.addOnce(() => disposed++)
    })
    const casters = [1, 2, 3]
    casters.forEach((id, i) => r.views.set(id, makeView(id, i * 2, 0, true)))
    r.views.set(50, makeView(50, 0, 8))
    r.views.set(51, makeView(51, 3, 6))
    const skills = [SMASH, GEOMGI, GANGGI]
    let t = 0
    for (let n = 0; n < 1000; n++) {
      const id = casters[n % 3]!
      const def = skills[(n + Math.floor(n / 3)) % 3]!
      const ms: [number, number, number] = def === GANGGI ? [1000, 1000, 1000] : [0, def.castMs, def.actionMs]
      const inst = 1000 + n
      const targetId = n % 2 ? 50 : 51
      r.player.cast(cast(id, def.code, inst, ms, targetId), t, r.port)
      const msg = combat(id, def.code, inst, { target: targetId, ...(def === GEOMGI ? { at: t + 640 } : {}) })
      if (def !== GANGGI) r.player.combat(msg, t, t, i => r.showHit(msg, i))
      if (n % 7 === 0) r.player.castEnd({ t: 'castEnd', id, instance: inst, reason: 'interrupted' }, r.port)
      if (def === GANGGI) {
        r.fx.buffStart(GANGGI.group!, r.views.get(id)!)
        r.fx.startLoop(`${id}:${inst}`, GANGGI.group!, r.views.get(id)!)
      }
      if (n % 5 === 0) r.fx.startLoop(`${id}:imbue${n}`, 'SKILL_CH_COLD_GIGONGTA_A', r.views.get(id)!)
      if (n % 4 === 0) r.fx.status(`${targetId}:s${n}`, n % 8 ? 'stun' : 'freeze', r.views.get(targetId)!, true)
      if (n % 11 === 0) r.showHit(combat(id, BOW_BASE.code, undefined, { target: targetId }), 0)
      t += 400
      await r.step(t, 50)
      // Buffs, imbues and statuses end a little later.
      if (n >= 3) {
        const old = n - 3
        r.fx.stopLoop(`${casters[old % 3]}:${1000 + old}`)
        r.fx.stopLoop(`${casters[old % 3]}:imbue${old}`)
        r.fx.stopLoop(`${old % 2 ? 50 : 51}:s${old}`)
      }
      if (n === 500) r.fx.forget(50)
    }
    for (let old = 997; old < 1000; old++) {
      r.fx.stopLoop(`${casters[old % 3]}:${1000 + old}`)
      r.fx.stopLoop(`${casters[old % 3]}:imbue${old}`)
      r.fx.stopLoop(`${old % 2 ? 50 : 51}:s${old}`)
    }
    await r.step(t + 12_000, 50)
    const s = r.fx.stats
    expect(s.started).toBeGreaterThan(3000)
    expect(s).toMatchObject({ live: 0, pending: 0, flights: 0, loops: 0 })
    expect(s.disposed).toBe(s.started)
    expect(created).toBeGreaterThan(3000)
    expect(disposed).toBe(created)
    r.dispose()
    expect(scene.meshes.length).toBe(baseMeshes)
    // Materials are shared per (texture, blend, cull) and per streak blend: a handful, not one per cast.
    expect(scene.materials.length - baseMaterials).toBeLessThanOrEqual(3)
  }, 120_000)
})

const OUT_DIR = join(import.meta.dirname, '../../../work/out')
describe.skipIf(!existsSync(join(OUT_DIR, 'fx/skills.json')))('on the real export (work/out/fx)', () => {
  it('has every status effect and plays the first-slice skills with real programs, leaving nothing behind', async () => {
    for (const def of Object.values(STATUS_FX)) {
      for (const key of [def?.loop, def?.on, def?.off]) if (key) expect(existsSync(join(OUT_DIR, FxLibrary.programPath(key))), key).toBe(true)
    }
    const index = readFxSkills(JSON.parse(readFileSync(join(OUT_DIR, 'fx/skills.json'), 'utf8')))
    const smash = index.get('SKILL_CH_SWORD_SMASH_A')!
    expect(smash.stages.find(s => s.actType === 'AT_DMG_POS')?.dmg).toBe(true)
    expect(damageStages(smash, { phase: 'SHOT', event: 1 }).map(s => s.effect)).toEqual(['hiteffect/hit_1_cut_critical.efp'])
    expect(isImbue(index.get('SKILL_CH_FIRE_GIGONGTA_A')!)).toBe(true)
    let now = 0
    const lib = new FxLibrary(scene, '/out/', async url => {
      const b = readFileSync(join(OUT_DIR, url.replace(/^\/out\//, '')))
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
    })
    const fx = new SkillFx(scene, () => now, { library: lib })
    fx.setSkills(index)
    const base = scene.meshes.length
    const hero = makeView(1, 0, 0, true)
    const mob = makeView(50, 0, 6)
    const step = async (until: number) => {
      while (now < until) {
        now += 50
        fx.update(0.05)
        for (let i = 0; i < 20; i++) await Promise.resolve()
      }
    }
    fx.stages('SKILL_CH_SWORD_SMASH_A', 'SHOT', { caster: hero, target: mob, start: 0, hits: [410], loopUntil: 1433 })
    fx.stages('SKILL_CH_SWORD_GEOMGI_A', 'SHOT', { caster: hero, target: mob, start: 0, hits: [86, 341], loopUntil: 1133 })
    fx.stages('SKILL_CH_COLD_GANGGI_A', 'READY', { caster: hero, start: 0, hits: [], loopUntil: 1000 })
    fx.startLoop('1:1', 'SKILL_CH_COLD_GIGONGTA_A', hero)
    fx.status('50:2', 'stun', mob, true)
    fx.status('50:3', 'freeze', mob, true)
    await step(450)
    fx.hit('SKILL_CH_SWORD_SMASH_A', mob, { attacker: hero, cue: { phase: 'SHOT', event: 1 }, index: 0, landed: true })
    await step(1500)
    expect(fx.stats.started).toBeGreaterThan(8)
    fx.stopLoop('1:1')
    fx.stopLoop('50:2')
    fx.stopLoop('50:3')
    await step(12_000)
    expect(fx.stats).toMatchObject({ live: 0, pending: 0, flights: 0, loops: 0 })
    expect(fx.stats.disposed).toBe(fx.stats.started)
    fx.dispose()
    lib.dispose()
    hero.root.dispose()
    mob.root.dispose()
    expect(scene.meshes.length).toBe(base)
  }, 60_000)
})

// ---- wave 7B, FX-C1 (docs/EFFECTS.md §6.4 M1-M22, docs/WAVE_PLAN2.md D4) ---------------------------------------

describe('retail placement, hits, loops and mobs (FX-C1)', () => {
  const st = (p: Partial<FxStage> & Pick<FxStage, 'phase' | 'actType'>): FxStage => ({ id: 0, trade: 0, fade: { inMs: 0, outMs: 0 }, param: [0, 0, 0], scale: null, ...stage(p) })
  const ARROW_MODEL = { glb: '/out/test/arrow.glb', sidecar: '/out/test/arrow.json' }
  const V2: FxSkill[] = [
    {
      group: 'SKILL_CH_SPEAR_ROUNDAREA_A', aniGroup: 'SPEAR', defense: null, damage: 'hit/crit.efp', arrowTail: null, arrowForce: null, light: 'LIGHT_3', bleeds: true,
      trail: { lengthMs: 120, argb: [200, 255, 255, 255], op: 'ONE', texture: 'textures/mirage_texture_knockdown.ddj' },
      stages: [st({ phase: 'SHOT', startEvent: 1, actType: 'AT_ONE_FOLLOW', effect: 'fx/petal_spin.efp', startBone: 'Bip01', dmg: true })],
    },
    {
      group: 'SKILL_CH_COLD_GANGGI_A', aniGroup: 'DEFAULT', defense: 'fx/ganggi_damage.efp', damage: null, arrowTail: null, arrowForce: null, priority: 0,
      stages: [
        st({ phase: 'READY', actType: 'AT_LOOP', effect: 'fx/circle.efp', id: 1 }),
        st({ phase: 'READY', actType: 'AT_LOOP', effect: 'fx/hands.efp', id: 2 }),
        st({ phase: 'SHOT', actType: 'AT_ONE_FOLLOW', kill: 1, id: 0 }),
        st({ phase: 'ACT_L', actType: 'AT_LOOP', effect: 'fx/ganggi_keep.efp', startBone: 'Bip01' }),
      ],
    },
    {
      group: 'SKILL_CH_BOW_CRITICAL_A', aniGroup: 'BOW', defense: null, damage: 'hit/crit.efp', arrowTail: 'fx/bow_tail.efp', arrowForce: 'fx/bow_force.efp', light: 'LIGHT_4',
      stages: [
        st({ phase: 'READY', actType: 'AT_LOOP', startBone: 'Bip01 R Hand', rotate: '90', script: 'SCT_ARROW', id: 1, object: 'res\\item\\china\\weapon\\cha_arrow_normal.bsr', objectModel: ARROW_MODEL }),
        st({ phase: 'SHOT', startEvent: 1, actType: 'AT_MOV_1TAR', move: 'MOV_STRAIGHT,0,500,500', startBone: 'Bip01 R Hand', targetOffset: '0,10,0', dmg: true, trade: 1, object: 'res\\item\\china\\weapon\\cha_arrow_normal.bsr', objectModel: ARROW_MODEL }),
      ],
    },
    {
      group: 'SKILL_CH_COLD_GIGONGTA_A', aniGroup: 'DEFAULT', defense: null, damage: 'hit/cold_burst.efp', arrowTail: null, arrowForce: null, priority: 2, light: 'LIGHT_2',
      trail: { lengthMs: 160, argb: [200, 255, 255, 255], op: 'ONE', texture: 'textures/mirage_texture_cold.ddj' },
      stages: [st({ phase: 'ACT_L', actType: 'AT_LOOP', effect: 'fx/gigongta_keep.efp', startBone: 'Bip01 R Finger2' })],
    },
    {
      group: 'SKILL_CH_SWORD_BASE', aniGroup: 'SWORD', defense: null, damage: 'hit/normal.efp', arrowTail: null, arrowForce: null, light: 'LIGHT_1', bleeds: true,
      trail: { lengthMs: 80, argb: [64, 255, 255, 255], op: 'ONE', texture: 'textures/mirage_texture_normal.ddj' }, stages: [],
    },
    { group: 'SYSTEM_CH_HWANMODE', aniGroup: 'DEFAULT', defense: null, damage: 'hit/hwan.efp', arrowTail: null, arrowForce: null, priority: 10, trail: { lengthMs: 160, argb: [200, 255, 255, 255], op: 'ONE', texture: 'textures/mirage_texture_hwan.ddj' }, stages: [] },
    // Mobs (MSKILL groups are keyed by their code).
    {
      group: 'MSKILL_CH_MANGNYANG_ATTACK02', aniGroup: 'DEFAULT', defense: null, damage: 'hit/normal.efp', arrowTail: null, arrowForce: null, kind: 'mob', bleeds: true,
      clips: { ready: null, wait: null, shot: 'ANI_ATTACK2' },
      stages: [st({ phase: 'SHOT', startEvent: 1, actType: 'AT_ONE_FOLLOW', dmg: true }), st({ phase: 'SHOT', startEvent: 2, actType: 'AT_ONE_FOLLOW', dmg: true })],
    },
    {
      group: 'MSKILL_CH_TOMBSTONE_ATTACK02', aniGroup: 'DEFAULT', defense: null, damage: null, arrowTail: null, arrowForce: null, kind: 'mob',
      clips: { ready: null, wait: null, shot: 'ANI_ATTACK1' },
      stages: [
        st({ phase: 'SHOT', startEvent: 1, actType: 'AT_MOV_1TAR', move: 'MOV_STRAIGHT,0,200,200', effect: 'fx/tomb_shot.efp', effect2: 'fx/tomb_hit.efp', startBone: 'bolt_a', targetOffset: '2,10,0', id: 1, scale: 'MOB_BASE' }),
        st({ phase: 'SHOT', startEvent: 1, actType: 'AT_MOV_1TAR', move: 'MOV_STRAIGHT,0,200,200', effect: 'fx/tomb_shot.efp', effect2: 'fx/tomb_hit.efp', startBone: 'bolt_b', targetOffset: '-2,8,0', dmg: true, trade: 1, scale: 'MOB_BASE' }),
      ],
    },
    {
      group: 'MSKILL_CH_WHITETIGER_CLON_ATTACK03', aniGroup: 'DEFAULT', defense: null, damage: 'hit/hand.efp', arrowTail: null, arrowForce: null, kind: 'mob',
      clips: { ready: null, wait: null, shot: 'ANI_ATTACK3' },
      stages: [st({ phase: 'SHOT', startEvent: 1, actType: 'AT_ONE_FOLLOW', effect: 'fx/howl.efp', startBone: 'Bip02 Spine1', scale: 'MOB_BASE' })],
    },
  ]
  const CHARS = new Map([
    ['MOB_CH_MANGNYANG', { size: 1.5, damageBone: null, damagePos: [0, 10, -6] as [number, number, number], bloodType: 'hit/redblood.efp', dieModel: null, ride: null }],
    ['CHAR_CH_MAN_ADVENTURER', { size: 2, damageBone: null, damagePos: [0, 13, -2] as [number, number, number], bloodType: 'hit/redblood.efp', dieModel: null, ride: null }],
    ['MOB_CH_TOMBSTONE', { size: 3, damageBone: null, damagePos: [0, 14, -5] as [number, number, number], bloodType: 'hit/stone.efp', dieModel: null, ride: null }],
  ])
  const LIGHTS = new Map([
    ['LIGHT_1', { argb: [255, 255, 255, 255] as [number, number, number, number], timeMs: 300, range: 1000, atten: 0.2 }],
    ['LIGHT_3', { argb: [255, 28, 255, 28] as [number, number, number, number], timeMs: 300, range: 1000, atten: 0.2 }],
  ])
  const V2KEYS = [...new Set([...V2.flatMap(s => [s.damage, s.defense, s.arrowTail, s.arrowForce, ...s.stages.flatMap(x => [x.effect, x.effect2])]), 'hit/redblood.efp', 'hit/redblood_down.efp', 'hit/stone.efp', 'system/ch_blocking.efp'].filter((k): k is string => !!k))]

  interface View2 extends FakeView {
    kind: 'player' | 'mob'
    scale: number
    state: { model: string }
    overlays: string[]
    weaponShown: boolean
    top: string | null
  }

  /** A fake view with bones, weapon trail dummies and the clip hooks SkillFx reads. */
  function view2(id: number, x: number, z: number, o: { kind?: 'player' | 'mob'; model?: string; yaw?: number; weapon?: boolean } = {}): View2 & EntityView {
    const root = new TransformNode(`v2:${id}`, scene)
    root.position.set(x, 0, z)
    root.rotation.y = o.yaw ?? 0
    const joints = new Map<string, TransformNode>()
    const bone = (name: string, p: [number, number, number]) => {
      const n = new TransformNode(`v2:${id}:${name}`, scene)
      n.parent = root
      n.position.set(...p)
      joints.set(name, n)
      return n
    }
    bone('Bip01', [0, 1, 0])
    const hand = bone('Bip01 R Hand', [0.3, 1.2, 0.1])
    bone('Bip01 L Hand', [0.1, 1.3, 0.7])
    bone('bolt_a', [0.5, 2, 0])
    bone('bolt_b', [-0.5, 2, 0])
    bone('Bip02 Spine1', [0, 1.1, 0.3])
    const dummies = new Map<string, TransformNode>()
    if (o.weapon) {
      for (const [n, zz] of [['ai_start', 0.1], ['ai_end', 0.8]] as const) {
        const d = new TransformNode(`v2:${id}:${n}`, scene)
        d.parent = hand
        d.position.set(0, 0, zz)
        dummies.set(n, d)
      }
    }
    const v = {
      id, root, yaw: o.yaw ?? 0, height: 1.8, isDisposed: false, dead: false, kind: o.kind ?? 'player', scale: 1,
      state: { model: o.model ?? (o.kind === 'mob' ? 'MOB_CH_MANGNYANG' : 'CHAR_CH_MAN_ADVENTURER') }, overlays: [] as string[], weaponShown: true, top: null as string | null,
    } as View2
    v.actor = {
      joint: (n: string) => joints.get(n),
      weaponDummy: (n: string) => dummies.get(n) ?? null,
      get weaponVisible() {
        return v.weaponShown
      },
      setWeaponVisible: (on: boolean) => {
        v.weaponShown = on
      },
      playOverlay: (t: string) => {
        v.overlays.push(t)
        return true
      },
      clipCursors: () => ({ top: v.top ? { name: v.top, ms: 0, durationMs: 1000, run: 1 } : null, overlay: null }),
    } as unknown as FakeView['actor']
    return v as View2 & EntityView
  }

  /** A model loader that makes a small box container (no fetch). */
  const boxLoader = async (url: string, sc: Scene) => {
    const c = new AssetContainer(sc)
    const box = MeshBuilder.CreateBox(`model:${url}`, { width: 0.05, height: 0.05, depth: 1.2 }, sc)
    sc.removeMesh(box)
    c.meshes.push(box)
    return c
  }

  function rig2() {
    let now = 0
    const lib = new FxLibrary(scene, '/out/')
    for (const k of V2KEYS) lib.addProgram(program(k))
    const fx = new SkillFx(scene, () => now, { library: lib, modelLoader: boxLoader })
    fx.setSkills(readFxSkills({ skills: V2 }), CHARS, LIGHTS)
    const spawned: { key: string; at: number; pos?: [number, number, number]; entity: number }[] = []
    fx.onSpawn = e => {
      if (e.kind === 'fx') spawned.push({ key: e.key ?? e.name, at: e.t, ...(e.pos ? { pos: e.pos } : {}), entity: e.entity })
    }
    const flush = async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    }
    const step = async (until: number, dt = 10) => {
      while (now < until) {
        now = Math.min(until, now + dt)
        fx.update(dt / 1000)
        await flush()
      }
    }
    return {
      fx, lib, spawned, step, flush,
      get now() {
        return now
      },
      set now(t: number) {
        now = t
      },
      count: (key: string) => spawned.filter(s => s.key === key).length,
      dispose() {
        fx.dispose()
        lib.dispose()
      },
    }
  }

  it('plays a caster-anchored DMG row once per cast and cue, however many victims (M8)', async () => {
    const r = rig2()
    const hero = view2(1, 0, 0)
    const mobs = [view2(50, 0, 2, { kind: 'mob' }), view2(51, 1, 2, { kind: 'mob' }), view2(52, -1, 2, { kind: 'mob' })]
    for (const m of mobs) r.fx.hit('SKILL_CH_SPEAR_ROUNDAREA_A', m, { attacker: hero, cue: { phase: 'SHOT', event: 1 }, landed: true, instance: 7 })
    await r.step(50)
    expect(r.count('fx/petal_spin.efp')).toBe(1)
    // Every victim still gets its spark.
    expect(r.count('hit/crit.efp')).toBe(3)
    // The next cast plays it again.
    r.fx.hit('SKILL_CH_SPEAR_ROUNDAREA_A', mobs[0], { attacker: hero, cue: { phase: 'SHOT', event: 1 }, landed: true, instance: 8 })
    await r.step(100)
    expect(r.count('fx/petal_spin.efp')).toBe(2)
    r.dispose()
  })

  it('lands sparks, blood and the light at the victim DamagePos, in front of it (M9, M11, M12)', async () => {
    const r = rig2()
    const hero = view2(1, 0, -3)
    // Mangyang facing -Z (towards the hero): DamagePos 0,10,-6 dm -> 1.0 m up, 0.6 m in front.
    const mob = view2(50, 0, 0, { kind: 'mob', yaw: Math.PI })
    r.fx.hit('SKILL_CH_SWORD_BASE', mob, { attacker: hero, landed: true, basic: true, outcome: 'hit' })
    await r.step(20)
    const spark = r.spawned.find(s => s.key === 'hit/normal.efp')!
    expect(spark.pos![0]).toBeCloseTo(0, 5)
    expect(spark.pos![1]).toBeCloseTo(1.0, 5)
    expect(spark.pos![2]).toBeCloseTo(-0.6, 5)
    expect(r.count('hit/redblood.efp')).toBe(1)
    expect(r.fx.lightsActive).toBe(1)
    await r.step(400)
    expect(r.fx.lightsActive).toBe(0)
    // Knocked down: the _down blood; a miss plays nothing; a block plays the block effect and the DEFENCE clip.
    r.fx.hit('SKILL_CH_SWORD_BASE', mob, { attacker: hero, landed: true, basic: true, outcome: 'hit', down: true })
    r.fx.hit('SKILL_CH_SWORD_BASE', mob, { attacker: hero, landed: false, basic: true, outcome: 'miss' })
    r.fx.hit('SKILL_CH_SWORD_BASE', hero, { attacker: mob, landed: false, basic: true, outcome: 'block' })
    await r.step(450)
    expect(r.count('hit/redblood_down.efp')).toBe(1)
    expect(r.count('hit/normal.efp')).toBe(2)
    expect(r.count('system/ch_blocking.efp')).toBe(1)
    expect((hero as View2).overlays).toEqual(['DEFENCE'])
    r.dispose()
  })

  it('plays the DefenseEfp of a shield buff and the imbue burst, and Berserk hits use the HWAN spark (M5, M14)', async () => {
    const r = rig2()
    const hero = view2(1, 0, 0, { weapon: true })
    const mob = view2(50, 0, 2, { kind: 'mob' })
    r.fx.startLoop('1:3', 'SKILL_CH_COLD_GANGGI_A', hero)
    r.fx.startLoop('1:4', 'SKILL_CH_COLD_GIGONGTA_A', hero)
    r.fx.hit('SKILL_CH_SWORD_BASE', hero, { attacker: mob, landed: true, outcome: 'hit' })
    r.fx.hit('SKILL_CH_SWORD_BASE', mob, { attacker: hero, landed: true, outcome: 'crit' })
    r.fx.hit('SKILL_CH_SWORD_BASE', mob, { attacker: hero, landed: true, outcome: 'hit', hwan: true })
    await r.step(30)
    expect(r.count('fx/ganggi_damage.efp')).toBe(1)
    expect(r.count('hit/cold_burst.efp')).toBe(2)
    expect(r.count('hit/hwan.efp')).toBe(1)
    expect(r.count('hit/normal.efp')).toBe(2)
    r.fx.stopLoop('1:3')
    r.fx.stopLoop('1:4')
    r.fx.hit('SKILL_CH_SWORD_BASE', hero, { attacker: mob, landed: true, outcome: 'hit' })
    await r.step(60)
    expect(r.count('fx/ganggi_damage.efp')).toBe(1)
    r.dispose()
  })

  it('Kill ends only the loops with its ID (M15)', async () => {
    const r = rig2()
    const hero = view2(1, 0, 0)
    r.fx.stages('SKILL_CH_COLD_GANGGI_A', 'READY', { caster: hero, start: 0, hits: [], loopUntil: 5000 })
    await r.step(200)
    expect(r.fx.stats.live).toBe(2)
    r.fx.stages('SKILL_CH_COLD_GANGGI_A', 'SHOT', { caster: hero, start: 1000, hits: [], loopUntil: 2000 })
    // The kill row (Kill 1) stops the circle; the hands loop (ID 2) plays on until its phase ends.
    await r.step(4500, 50)
    expect(r.fx.stats.live).toBe(1)
    await r.step(9500, 50)
    expect(r.fx.stats.live).toBe(0)
    r.dispose()
  })

  it('nocks an arrow model during READY and trades it into the flight: one arrow, not two (M2, M3, M15)', async () => {
    const r = rig2()
    const hero = view2(1, 0, 0)
    const mob = view2(50, 0, 12, { kind: 'mob', yaw: Math.PI })
    const models = () => scene.meshes.filter(m => /model:\/out\/test\/arrow\.glb/.test(m.name) && m.isEnabled())
    r.fx.stages('SKILL_CH_BOW_CRITICAL_A', 'READY', { caster: hero, target: mob, start: 0, hits: [], loopUntil: 1000 })
    await r.step(100)
    expect(models()).toHaveLength(1)
    // At the drawing hand.
    const p = models()[0]!.getAbsolutePosition()
    expect(p.x).toBeCloseTo(0.3, 2)
    expect(p.y).toBeCloseTo(1.2, 2)
    r.fx.stages('SKILL_CH_BOW_CRITICAL_A', 'SHOT', { caster: hero, target: mob, start: 1000, hits: [32], loopUntil: 1533 })
    await r.step(1040)
    expect(r.fx.stats.flights).toBe(1)
    expect(models()).toHaveLength(1)
    expect(r.count('fx/bow_tail.efp')).toBe(1)
    expect(r.count('fx/bow_force.efp')).toBe(1)
    // The DMG flight waits for its hit (about 11 m at 50 m/s).
    r.now = 1300
    r.fx.hit('SKILL_CH_BOW_CRITICAL_A', mob, { attacker: hero, cue: { phase: 'SHOT', event: 1 }, landed: true, instance: 3 })
    await r.step(1320)
    expect(r.fx.stats.flights).toBe(0)
    expect(r.count('hit/crit.efp')).toBe(1)
    await r.step(9000, 50)
    expect(models()).toHaveLength(0)
    expect(r.fx.stats).toMatchObject({ live: 0, flights: 0 })
    r.dispose()
  })

  it('flies a bow basic attack as the arrow model and lands the impact on arrival', async () => {
    const r = rig2()
    const hero = view2(1, 0, 0)
    const mob = view2(50, 0, 10, { kind: 'mob', yaw: Math.PI })
    r.fx.setSkills(readFxSkills({ skills: [...V2, { group: 'SKILL_CH_BOW_BASE', aniGroup: 'BOW', defense: null, damage: 'hit/normal.efp', arrowTail: 'fx/bow_tail.efp', arrowForce: null, stages: [] }] }), CHARS, LIGHTS)
    // First shot while the arrow model loads: a drawn streak; the next ones fly the model.
    r.fx.hit('SKILL_CH_BOW_BASE', mob, { attacker: hero, landed: true, basic: true, outcome: 'hit' })
    await r.step(400)
    r.fx.hit('SKILL_CH_BOW_BASE', mob, { attacker: hero, landed: true, basic: true, outcome: 'hit' })
    await r.flush()
    expect(r.fx.stats.flights).toBe(1)
    expect(scene.meshes.some(m => /cha_arrow_normal/.test(m.name) && m.isEnabled())).toBe(true)
    expect(r.count('hit/normal.efp')).toBe(1)
    await r.step(800)
    expect(r.fx.stats.flights).toBe(0)
    expect(r.count('hit/normal.efp')).toBe(2)
    r.dispose()
  })

  it('G-11: hit effects of fights the own character is not in are capped; the own hits always play', async () => {
    const { FX_BUDGETS } = await import('../src/world/fx/quality.ts')
    expect(FX_BUDGETS.medium.otherHits).toBe(6)
    expect(FX_BUDGETS.low.otherHits).toBe(Infinity)
    const r = rig2()
    const self = view2(1, 0, -3)
    const others = [2, 3, 4, 5, 6, 7].map(id => view2(id, id, -3))
    const mob = view2(50, 0, 0, { kind: 'mob', yaw: Math.PI })
    r.fx.setOtherHits(4, id => id === 1)
    const hit = (a: EntityView) => r.fx.hit('SKILL_CH_SWORD_BASE', mob, { attacker: a, landed: true, basic: true, outcome: 'hit' })
    // six others' hits (spark + blood each): two hits fill the cap of 4 live effects, the rest show none
    for (const a of others) hit(a)
    await r.step(20)
    expect(r.count('hit/normal.efp')).toBe(2)
    expect(r.fx.stats.otherLive).toBe(4)
    expect(r.fx.stats.otherSkipped).toBe(4)
    // the own hit and a hit on the own character play whatever the cap
    hit(self)
    r.fx.hit('SKILL_CH_SWORD_BASE', self, { attacker: mob, landed: true, basic: true, outcome: 'hit' })
    await r.step(40)
    expect(r.count('hit/normal.efp')).toBe(4)
    // once the others' effects end, their hits show again
    await r.step(8000, 50)
    expect(r.fx.stats.otherLive).toBe(0)
    hit(others[0]!)
    await r.step(8100)
    expect(r.count('hit/normal.efp')).toBe(5)
    // no cap (Low): every hit shows
    r.fx.setOtherHits(Infinity)
    for (const a of others) hit(a)
    await r.step(8200)
    expect(r.count('hit/normal.efp')).toBe(11)
    r.dispose()
  })

  it('G1 rescue: weapon trails of other characters are capped at the preset count; the own character always draws one', async () => {
    const { FX_BUDGETS } = await import('../src/world/fx/quality.ts')
    expect(FX_BUDGETS.medium.otherTrails).toBe(4)
    expect(FX_BUDGETS.high.otherTrails).toBeGreaterThan(FX_BUDGETS.medium.otherTrails)
    expect(FX_BUDGETS.low.otherTrails).toBe(Infinity)
    const r = rig2()
    const self = view2(1, 0, 0, { weapon: true })
    const others = [2, 3, 4, 5].map(id => view2(id, id, 0, { weapon: true }))
    r.fx.setOtherHits(Infinity, id => id === 1)
    r.fx.setOtherTrails(2)
    for (const o of others) r.fx.swing(o, 'SKILL_CH_SWORD_BASE', r.now + 300)
    await r.step(20)
    expect(r.fx.stats.trails).toBe(2)
    expect(r.fx.stats.otherTrailsSkipped).toBe(2)
    r.fx.swing(self, 'SKILL_CH_SWORD_BASE', r.now + 300)
    await r.step(20)
    expect(r.fx.stats.trails).toBe(3)
    // A drawing one swings again whatever the cap; no cap draws them all.
    r.fx.swing(others[0]!, 'SKILL_CH_SWORD_BASE', r.now + 300)
    expect(r.fx.stats.otherTrailsSkipped).toBe(2)
    r.fx.setOtherTrails(Infinity)
    for (const o of others) r.fx.swing(o, 'SKILL_CH_SWORD_BASE', r.now + 300)
    await r.step(20)
    expect(r.fx.stats.trails).toBe(5)
    r.dispose()
  })

  it('the graphics budget switches trails off (low preset) and on again; budgets per preset (I7B, EFFECTS §7)', async () => {
    const { FX_BUDGETS, fxBudget } = await import('../src/world/fx/quality.ts')
    expect(FX_BUDGETS.low).toEqual({ trails: false, hitLights: false, ambientMax: 0, dropSparkles: 8, otherHits: Infinity, otherTrails: Infinity, ambientModels: 0 })
    expect(FX_BUDGETS.high).toMatchObject({ trails: true, hitLights: true, ambientMax: 40, dropSparkles: 30 })
    expect(fxBudget('medium').ambientMax).toBeLessThan(FX_BUDGETS.high.ambientMax)
    const r = rig2()
    const hero = view2(7, 0, 0, { weapon: true })
    r.fx.setTrailsEnabled(false)
    r.fx.swing(hero, 'SKILL_CH_SWORD_BASE', 300)
    await r.step(100, 16)
    expect(r.fx.stats.trails).toBe(0)
    r.fx.setTrailsEnabled(true)
    r.fx.swing(hero, 'SKILL_CH_SWORD_BASE', r.now + 300)
    await r.step(r.now + 100, 16)
    expect(r.fx.stats.trails).toBe(1)
    r.dispose()
  })

  it('swings a weapon trail between the weapon dummies; an imbue or Berserk replaces it; samples age out (M1)', async () => {
    const r = rig2()
    const hero = view2(1, 0, 0, { weapon: true })
    r.fx.swing(hero, 'SKILL_CH_SWORD_BASE', 300)
    await r.step(100, 16)
    const trail = scene.meshes.find(m => m.name === 'fx:trail:1')!
    expect(trail).toBeDefined()
    expect(trail.material?.name).toContain('mirage_texture_normal')
    // An imbue's trail (priority 2) replaces the basic one; Berserk (10) beats the imbue.
    r.fx.startLoop('1:4', 'SKILL_CH_COLD_GIGONGTA_A', hero)
    r.fx.swing(hero, 'SKILL_CH_SWORD_BASE', 600)
    await r.step(150, 16)
    expect(trail.material?.name).toContain('mirage_texture_cold')
    r.fx.setBerserk(1, true)
    r.fx.swing(hero, 'SKILL_CH_SWORD_BASE', 600)
    await r.step(200, 16)
    expect(trail.material?.name).toContain('mirage_texture_hwan')
    r.fx.setBerserk(1, false)
    r.fx.stopLoop('1:4')
    // After emission stops the trail shrinks away within its length and is disposed.
    await r.step(4500, 16)
    expect(r.fx.stats.trails).toBe(0)
    expect(scene.meshes.some(m => m.name === 'fx:trail:1')).toBe(false)
    // Rows without a trail (bows, forces) draw none; a basic attack follows its attack clip.
    r.fx.swing(hero, 'SKILL_CH_BOW_CRITICAL_A', 2000)
    expect(r.fx.stats.trails).toBe(0)
    ;(hero as View2).top = 'ATTACK1_sword'
    r.fx.swing(hero, 'SKILL_CH_SWORD_BASE')
    await r.step(4800, 16)
    expect(r.fx.stats.trails).toBe(1)
    const drawn = scene.meshes.find(m => m.name === 'fx:trail:1')!
    ;(hero as View2).top = 'STAND1'
    await r.step(5000, 16)
    expect(drawn.isVisible).toBe(false)
    await r.step(8200, 16)
    expect(r.fx.stats.trails).toBe(0)
    r.dispose()
  })

  it('keeps trail samples younger than the trail length and smooths between them', () => {
    const s = [0, 20, 40, 60, 80, 100].map(t => ({ t, tip: [t / 100, 1, 0] as [number, number, number], hilt: [t / 100, 0.3, 0] as [number, number, number] }))
    expect(pruneSamples(s, 100, 80).map(x => x.t)).toEqual([20, 40, 60, 80, 100])
    const pts = stripPoints(pruneSamples(s, 100, 80), 100)
    expect(pts[0]!.age).toBe(0)
    expect(pts[pts.length - 1]!.age).toBe(80)
    expect(pts.length).toBe(13)
    expect(trailStyle({ lengthMs: 80, argb: [64, 255, 255, 255], op: 'ONE', texture: 'textures/mirage_texture_normal.ddj' })).toEqual({
      lengthMs: 80, color: [1, 1, 1, 64 / 255], blend: 'add', texture: 'fx/tex/textures/mirage_texture_normal.png',
    })
    expect(trailStyle({ lengthMs: 120, argb: [0, 0, 0, 0], op: 'ONE', texture: null })).toBeNull()
  })

  it('plays mob casts through the ActionPlayer with a SkillDef built from the MSKILL group (D4)', async () => {
    let now = 0
    const lib = new FxLibrary(scene, '/out/')
    for (const k of V2KEYS) lib.addProgram(program(k))
    const fx = new SkillFx(scene, () => now, { library: lib, modelLoader: boxLoader })
    const index = readFxSkills({ skills: V2 })
    fx.setSkills(index, CHARS, LIGHTS)
    const catalog = new SkillCatalog([SMASH], MASTERIES, [])
    const played: string[] = []
    const clips: Record<string, ClipFacts> = { ATTACK2: { durationMs: 2500, hits: [821, 1381] }, ATTACK1: { durationMs: 2000, hits: [1265] }, ATTACK3: { durationMs: 1400, hits: [300] } }
    const port: ActionPort = {
      clip: (_g, type) => clips[type] ?? null,
      play: (_g, phases) => {
        played.push(...phases.map(p => p.type))
        return 1
      },
      stop: () => {},
      playing: () => true,
      face: () => {},
    }
    const views = new Map<number, EntityView>([[60, view2(60, 0, 0, { kind: 'mob' })], [1, view2(1, 0, 6)]])
    const shown: number[] = []
    const player = new ActionPlayer(catalog, {
      fallbackDef: code => {
        const g = index.get(code)
        return g ? mobSkillDef(g) : undefined
      },
      onPhase(a, phase, start, clip) {
        fx.stages(a.group, phase.phase, { caster: views.get(a.caster)!, target: views.get(a.target!)!, start, hits: clip?.hits ?? [], loopUntil: start + phase.ms })
      },
    })
    // Mangyang ATTACK02: two hits at the clip's events 821 and 1381.
    const def = mobSkillDef(index.get('MSKILL_CH_MANGNYANG_ATTACK02')!)
    expect(def.animation).toEqual({ shot: 'ATTACK2' })
    expect(def.hitCues).toEqual([{ phase: 'SHOT', event: 1 }, { phase: 'SHOT', event: 2 }])
    const a = player.cast({ t: 'cast', id: 60, skill: 'MSKILL_CH_MANGNYANG_ATTACK02', instance: 900, target: 1, prepareMs: 0, castMs: 0, actionMs: 2500 }, 0, port)
    expect(a?.group).toBe('MSKILL_CH_MANGNYANG_ATTACK02')
    expect(played).toEqual(['ATTACK2'])
    const msg = { t: 'combat' as const, attacker: 60, target: 1, skill: 'MSKILL_CH_MANGNYANG_ATTACK02', instance: 900, hits: [{ outcome: 'hit' as const, damage: 3, hp: 90 }, { outcome: 'hit' as const, damage: 3, hp: 87 }] }
    expect(player.hitTimes(a!, msg, 0, 0)).toEqual([821, 1381])
    // Tomb Stone: two force bolts at event 1 from its two bones; the DMG one waits for its hit.
    views.set(61, view2(61, 0, 0, { kind: 'mob', model: 'MOB_CH_TOMBSTONE' }))
    const tomb = mobSkillDef(index.get('MSKILL_CH_TOMBSTONE_ATTACK02')!)
    expect(tomb.hitCues).toEqual([{ phase: 'SHOT', event: 1, projectile: { move: 'MOV_STRAIGHT', delayMs: 0, speed: 200 } }])
    player.cast({ t: 'cast', id: 61, skill: 'MSKILL_CH_TOMBSTONE_ATTACK02', instance: 901, target: 1, prepareMs: 0, castMs: 1265, actionMs: 735 }, 0, port)
    const run = async (from: number, to: number) => {
      for (let t = from; t <= to; t += 10) {
        now = t
        player.tick(t)
        fx.update(0.01)
        for (let i = 0; i < 6; i++) await Promise.resolve()
      }
    }
    await run(0, 1300)
    expect(fx.stats.flights).toBe(2)
    const tmsg = { t: 'combat' as const, attacker: 61, target: 1, skill: 'MSKILL_CH_TOMBSTONE_ATTACK02', instance: 901, at: 1265 + 3000, hits: [{ outcome: 'hit' as const, damage: 30, hp: 60 }] }
    player.combat(tmsg, now, now, () => {
      shown.push(0)
      fx.hit('MSKILL_CH_TOMBSTONE_ATTACK02', views.get(1), { attacker: views.get(61), cue: { phase: 'SHOT', event: 1 }, landed: true, instance: 901 })
    })
    await run(1300, 4800)
    expect(shown).toEqual([0])
    expect(fx.stats.flights).toBe(0)
    fx.dispose()
    lib.dispose()
  })

  it('scales MOB_BASE rows with the mob and plays the howl on its spine bone', async () => {
    const r = rig2()
    const tiger = view2(70, 0, 0, { kind: 'mob', model: 'MOB_CH_TOMBSTONE' })
    r.fx.stages('MSKILL_CH_WHITETIGER_CLON_ATTACK03', 'SHOT', { caster: tiger, start: 0, hits: [300], loopUntil: 1400 })
    await r.step(320)
    const howl = r.spawned.find(s => s.key === 'fx/howl.efp')!
    expect(howl.pos![0]).toBeCloseTo(0, 5)
    expect(howl.pos![1]).toBeCloseTo(1.1, 5)
    expect(howl.pos![2]).toBeCloseTo(0.3, 5)
    r.dispose()
  })

  it("plays a mob's own status set (monster/ programs on its bones, MOB_BASE) and the player file otherwise (§3.2)", async () => {
    const r = rig2()
    for (const k of ['monster/status_bad_burn.efp', 'battle/status_bad_burn.efp']) r.lib.addProgram(program(k))
    const mob = view2(80, 0, 0, { kind: 'mob' })
    const tomb = view2(81, 5, 0, { kind: 'mob', model: 'MOB_CH_TOMBSTONE' })
    r.fx.setStatusSource(v => (v.state.model === 'MOB_CH_MANGNYANG' ? new Map([['status_bad_burn', { efp: 'monster/status_bad_burn.efp', bone: 'Bip01', position: [0, 0.2, 0] as [number, number, number] }]]) : null))
    r.fx.status('80:1', 'burn', mob, true)
    r.fx.status('81:1', 'burn', tomb, true)
    await r.step(50)
    const own = r.spawned.find(s => s.key === 'monster/status_bad_burn.efp')!
    expect(own.pos![1]).toBeCloseTo(1.2, 5)
    expect(r.spawned.filter(s => s.key === 'battle/status_bad_burn.efp').map(s => s.entity)).toEqual([81])
    r.fx.stopLoop('80:1')
    r.fx.stopLoop('81:1')
    await r.step(6000, 50)
    expect(r.fx.stats).toMatchObject({ live: 0, loops: 0 })
    r.dispose()
  })

  it('reports ActionPlayer natural ends (Hide Weapon comes back) and chain segments', () => {
    const catalog = new SkillCatalog([GANGGI], MASTERIES, [])
    const log: string[] = []
    const port = new FakePort()
    const player = new ActionPlayer(catalog, { onEnd: (a, why) => log.push(`end:${a.instances[0]}:${why}`), onFinish: a => log.push(`finish:${a.instances[0]}`) })
    player.cast(cast(1, GANGGI.code, 1, [1000, 1000, 1000], 1), 0, port)
    player.tick(2999)
    expect(log).toEqual([])
    player.tick(3000)
    expect(log).toEqual(['finish:1'])
    // A castEnd after the natural end changes nothing; an early castEnd ends it once.
    player.castEnd({ t: 'castEnd', id: 1, instance: 1, reason: 'done' }, port)
    player.cast(cast(1, GANGGI.code, 2, [1000, 1000, 1000], 1), 4000, port)
    player.castEnd({ t: 'castEnd', id: 1, instance: 2, reason: 'interrupted' }, port)
    player.tick(9000)
    expect(log).toEqual(['finish:1', 'end:2:interrupted'])
  })
})

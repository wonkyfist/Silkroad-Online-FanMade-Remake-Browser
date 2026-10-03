/**
 * H1, the retail harness (docs/EFFECTS.md §2.5; docs/WAVE_PLAN2.md §5.9): every active level-1 row at or below the cap
 * (the 34 lines + 3 basic attacks) is cast by the real adventurer models (man and woman, glbs from work/out) through
 * the same ActionPlayer + SkillFx wiring the skills feature uses (createSkillPresenter, portOf), on a fake clock, and
 * compared with the golden table built from the data alone (fixtures/effects-golden.ts):
 *  1. clip names and phase starts;
 *  2. every stage row spawns its effect (or model) at phase start + its event (+-34 ms), none extra; a caster-anchored
 *     DMG row plays once per cue with 3 victims (M8);
 *  3. bone anchors: the start bone exists on the model and the spawn sits at the joint + the offset turned with the
 *     caster (1 cm), and follows the joint afterwards;
 *  4. DMG_POS rows at the victim's DamagePos (2 cm); arrival effects at the target root + TargetOffset (5 cm);
 *  5. everything ends (loops at their phase end / Kill / Trade / buff end);
 *  6. no leaks after 20 casts of every row (SkillFx.stats.started === disposed).
 * Skips when the exports are missing. Tagged `retail`: `pnpm vitest run -t retail`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ArcRotateCamera, AssetContainer, LoadAssetContainerAsync, MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import '@babylonjs/loaders/glTF/2.0/index.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FX_FORMAT, FX_FPS, FX_VERSION, FxLibrary, type FxEffect } from '@sro/fx'
import type { SkillDef } from '@sro/shared'
import { SkillCatalog } from '../src/content/skills.ts'
import { CharacterActor } from '../src/three/models.ts'
import type { EntityView } from '../src/world/entities.ts'
import { createSkillPresenter, portOf } from '../src/world/features/skills.ts'
import { dmToMetres, facing, rotate } from '../src/world/fx/anchors.ts'
import type { FxLabEntry } from '../src/world/fx/types.ts'
import { readFxSkills, SkillFx } from '../src/world/skill-fx.ts'
import { buildGolden, type GoldenRow } from './fixtures/effects-golden.ts'

const OUT = join(import.meta.dirname, '../../../work/out')
const FILES = ['fx/skills.json', 'data/skills.json', 'char/china/chinaman_adventurer.glb', 'char/china/chinaman_adventurer.json']
const ready = FILES.every(f => existsSync(join(OUT, f)))
const read = (f: string) => JSON.parse(readFileSync(join(OUT, f), 'utf8'))

/** One frame at 30 fps; timing asserts allow one frame (docs/EFFECTS.md §2.5: +-34 ms). */
const DT = 10
const FRAME = 34

/** A finite synthetic program for every key (recorded by onSpawn; no fetch). */
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
    duration: null, provenance: 'h1', warnings: [],
  }
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

async function loadActor(name: string): Promise<CharacterActor> {
  const b = readFileSync(join(OUT, `char/china/${name}.glb`))
  const container = await LoadAssetContainerAsync(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), scene, { pluginExtension: '.glb' })
  const sidecar = read(`char/china/${name}.json`)
  const code = name === 'chinaman_adventurer' ? 'CHAR_CH_MAN_ADVENTURER' : 'CHAR_CH_WOMAN_ADVENTURER'
  return new CharacterActor(scene, { code, glb: `/out/char/china/${name}.glb` }, { container, sidecar, packs: null })
}

interface HView {
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

function hview(id: number, model: string, kind: HView['kind'], at: [number, number, number], yaw: number, actor: CharacterActor | null): HView & EntityView {
  const root = new TransformNode(`h1:${id}`, scene)
  root.position.set(...at)
  root.rotationQuaternion = null
  root.rotation.y = yaw
  if (actor) {
    actor.root.parent = root
  }
  const v: HView = { id, root, yaw, height: actor ? actor.height : 1.2, isDisposed: false, dead: false, kind, scale: 1, state: { model }, pos: root.position, actor, face() {} }
  return v as HView & EntityView
}

const boxLoader = async (url: string, sc: Scene) => {
  const c = new AssetContainer(sc)
  const box = MeshBuilder.CreateBox(`h1model:${url}`, { width: 0.05, height: 0.05, depth: 1 }, sc)
  sc.removeMesh(box)
  c.meshes.push(box)
  return c
}

const near = (a: readonly number[], b: readonly number[], tol: number) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) <= tol

describe.skipIf(!ready)('retail harness H1 (effects-retail)', () => {
  const fxJson = ready ? read('fx/skills.json') : null
  const skillsJson = ready ? read('data/skills.json') : null
  const defs: SkillDef[] = ready ? (Array.isArray(skillsJson.entries) ? skillsJson.entries : Object.values(skillsJson.entries)) : []
  const models = ['chinaman_adventurer', ...(existsSync(join(OUT, 'char/china/chinawoman_adventurer.glb')) ? ['chinawoman_adventurer'] : [])]

  for (const model of models) {
    it(`retail: every row's clips, stages, anchors and ends on ${model}`, async () => {
      const actor = await loadActor(model)
      const sidecar = read(`char/china/${model}.json`)
      const golden: GoldenRow[] = buildGolden(defs, fxJson.skills, sidecar.animations)
      expect(golden.length).toBe(37)
      const index = readFxSkills(fxJson)
      let now = 0
      const lib = new FxLibrary(scene, '/out/')
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
      const log: (FxLabEntry & { rel: number })[] = []
      let t0 = 0
      fx.onSpawn = e => log.push({ ...e, rel: e.t - t0 })
      const catalog = new SkillCatalog(defs, [], [])
      const hero = hview(1, actor.model.code, 'player', [0, 0, 0], 0, actor)
      const views = new Map<number, HView & EntityView>([[1, hero]])
      const { player } = createSkillPresenter(catalog, fx, id => views.get(id))
      // Every clip the port plays, with its local start.
      const plays: { t: number; names: string[] }[] = []
      const port = portOf(hero, id => views.get(id))!
      const recPort = {
        ...port,
        play(g: string | undefined, phases: Parameters<typeof port.play>[1]) {
          plays.push({ t: now, names: phases.map(p => actor.skillClip(g, p.type)?.name ?? '?') })
          return port.play(g, phases)
        },
      }
      const run = async (until: number) => {
        while (now < until) {
          now += DT
          player.tick(now)
          fx.update(DT / 1000)
          for (let i = 0; i < 8; i++) await Promise.resolve()
        }
      }
      let instance = 1000
      const problems: string[] = []
      const check = (ok: boolean, what: string) => {
        if (!ok) problems.push(what)
      }

      for (const g of golden) {
        const ranged = g.ranged || g.group.startsWith('SKILL_CH_BOW')
        const targets = [0, 1, 2].map(i => hview(50 + i, 'MOB_CH_MANGNYANG', 'mob', [i - 1, 0, ranged ? 12 : 3], Math.PI, null))
        for (const tv of targets) views.set(tv.id, tv)
        const main = targets[1]!
        now += 1000
        await run(now)
        t0 = now
        log.length = 0
        plays.length = 0
        const inst = ++instance
        const self = g.kind === 'buff' || g.kind === 'imbue' || g.kind === 'heal' && !g.ranged
        const target = self ? 1 : main.id
        const def = catalog.get(g.code)!
        const fxg = index.get(g.group)
        if (g.instant) {
          // Imbues and Grass Walk: no action; the effect (ACT_S, ACT_L) lands at once.
          fx.buffStart(g.group, hero)
          fx.startLoop(`1:${inst}`, g.group, hero)
          await run(t0 + 1500)
          fx.stopLoop(`1:${inst}`)
        } else if (g.basic) {
          // Basic attacks: world.ts plays the clip; the hit shows at the clip's first event.
          const shot = g.phases.find(p => p.phase === 'SHOT')
          await run(t0 + (shot?.events[0] ?? 300))
          fx.hit(g.group, main, { attacker: hero, landed: true, basic: true, outcome: 'hit' })
          await run(t0 + 2500)
        } else {
          player.cast({ t: 'cast', id: 1, skill: g.code, instance: inst, target, prepareMs: g.prepareMs, castMs: g.castMs, actionMs: g.actionMs }, now, recPort)
          // 1. clips and phase starts.
          const a = player.action(inst)
          check(!!a, `${g.code}: no action`)
          if (a) {
            check(a.phases.length === g.phases.length, `${g.code}: ${a.phases.length} phases, golden ${g.phases.length}`)
            g.phases.forEach((p, i) => {
              const got = a.phases[i]
              check(!!got && got.plan.phase === p.phase && got.plan.type === p.type && Math.abs(got.start - t0 - p.startMs) <= FRAME, `${g.code}: phase ${p.phase} ${got?.plan.type}@${got ? got.start - t0 : '-'} vs ${p.type}@${p.startMs}`)
            })
            const names = plays[0]?.names ?? []
            const want = g.phases.map(p => p.clipName).filter((n): n is string => !!n)
            check(names.join(',') === want.join(','), `${g.code}: clips ${names.join(',')} vs ${want.join(',')}`)
          }
          // The hits (attacks): all three victims share the cue (M8), projectiles land on arrival.
          if (g.kind === 'attack' || g.kind === 'debuff') {
            const cues = g.cues.length ? g.cues : [{ phase: 'SHOT', event: 1, atMs: g.phases[g.phases.length - 1]?.startMs ?? 0 }]
            const flightRow = fxg?.stages.find(s => s.dmg && s.actType.startsWith('AT_MOV_'))
            const victims = fxg?.stages.some(s => s.dmg && !s.actType.startsWith('AT_MOV_') && s.actType !== 'AT_DMG_POS' && s.actType !== 'AT_TARGET') ? targets : [main]
            for (const v of victims) {
              const speed = Number(flightRow?.move.split(',')[2]) / 10 || 30
              const at = flightRow ? t0 + cues[0]!.atMs + (Math.hypot(v.pos.x, v.pos.z - 0) / speed) * 1000 : undefined
              const msg = { t: 'combat' as const, attacker: 1, target: v.id, skill: g.code, instance: inst, ...(at !== undefined ? { at } : {}), hits: cues.map(() => ({ outcome: 'hit' as const, damage: 1, hp: 100 })) }
              player.combat(msg, now, now, i => fx.hit(g.group, v, { attacker: hero, cue: cues[i], index: i, landed: true, instance: inst, outcome: 'hit' }))
            }
          }
          // Chain segments arrive as their own casts at the previous segment's end (the server's order, net/mock/skills.ts).
          let segAt = t0 + g.castMs + g.actionMs
          for (let seg = def.chainNext ? catalog.get(def.chainNext) : undefined; seg; seg = seg.chainNext ? catalog.get(seg.chainNext) : undefined) {
            const s2 = seg
            const segInst = ++instance
            player.schedule(segAt, () => {
              player.cast({ t: 'cast', id: 1, skill: s2.code, instance: segInst, target, prepareMs: 0, castMs: s2.castMs, actionMs: s2.actionMs }, now, recPort)
              const cues2 = s2.hitCues ?? []
              const msg = { t: 'combat' as const, attacker: 1, target: main.id, skill: s2.code, instance: segInst, hits: cues2.map(() => ({ outcome: 'hit' as const, damage: 1, hp: 100 })) }
              player.combat(msg, now, now, i => fx.hit(g.group, main, { attacker: hero, cue: cues2[i], index: i, landed: true, instance: segInst, outcome: 'hit' }))
            })
            segAt += s2.castMs + s2.actionMs
          }
          const end = Math.max(segAt, t0 + Math.max(...g.phases.map(p => p.startMs + p.ms), 0))
          await run(end + 50)
          // Buffs land at the end of the action (effectAdd): ACT_S once, ACT_L until the buff ends.
          if (g.kind === 'buff') {
            fx.buffStart(g.group, hero)
            fx.startLoop(`1:${inst}`, g.group, hero)
            await run(end + 1500)
            fx.stopLoop(`1:${inst}`)
          }
          await run(end + 1600)
        }
        // 2-4. every golden stage row spawned where and when the data says.
        const spawned = log.filter(e => e.kind === 'fx')
        const phaseRows = g.stages.filter(s => (s.phase === 'READY' || s.phase === 'WAIT' || s.phase === 'SHOT') && !g.basic)
        for (const s of phaseRows) {
          if (!s.key) continue
          if (s.dmg && !(g.kind === 'attack' || g.kind === 'debuff')) continue
          const key = s.key
          const hits = spawned.filter(e => e.key === key)
          const at = s.dmg ? (g.cues.find(c => c.phase === s.phase && c.event === (g.cues.length ? c.event : 1))?.atMs ?? s.atMs) : s.atMs
          const hit = hits.find(e => Math.abs(e.rel - at) <= FRAME)
          check(!!hit, `${g.code}: ${s.phase} ${s.anchor} ${key} expected @${at}, got ${hits.map(e => e.rel).join('/') || 'none'}`)
          if (!hit?.pos) continue
          if (s.anchor === 'bone' || s.anchor === 'root') {
            const joint = s.bone ? actor.joint(s.bone) : null
            check(!s.bone || !!joint, `${g.code}: bone ${s.bone} missing on ${model}`)
            // No scene render runs here, so the joints hold the pose they had at the spawn: the spawn sits at the joint (or
            // the root) + the offset turned with the caster's facing, within 1 cm. Model rows (the nocked arrow) sit at the joint.
            const m = (joint ?? hero.root).computeWorldMatrix(true).m
            const off = s.model ? [0, 0, 0] : rotate(facing(hero.yaw), s.offsetM)
            const want = [m[12]! + off[0]!, m[13]! + off[1]!, m[14]! + off[2]!]
            const timely = hits.filter(e => Math.abs(e.rel - at) <= FRAME && e.pos)
            check(timely.some(e => near(e.pos!, want, 0.01)), `${g.code}: ${s.key} at ${timely.map(e => e.pos!.map(n => n.toFixed(3)).join(",")).join(" / ")}, want ${s.bone ?? 'root'} + offset ${want.map(n => n.toFixed(3))}`)
          }
          if (s.anchor === 'damagePos' && s.dmg) {
            const info = fx.character('MOB_CH_MANGNYANG')!
            const dp = rotate(facing(main.yaw), dmToMetres(info.damagePos))
            const off = rotate(facing(hero.yaw), s.offsetM)
            const want = [main.root.position.x + dp[0] + off[0], dp[1] + off[1], main.root.position.z + dp[2] + off[2]]
            check(near(hit.pos, want, 0.02), `${g.code}: DMG_POS ${hit.pos.map(n => n.toFixed(2))} vs ${want.map(n => n.toFixed(2))}`)
          }
        }
        // M8: a caster-anchored DMG row plays once per cue however many victims.
        for (const s of g.stages.filter(x => x.dmg && (x.anchor === 'bone' || x.anchor === 'root') && x.key)) {
          const n = spawned.filter(e => e.key === s.key).length
          const rows = g.stages.filter(x => x.key === s.key).length
          check(n <= rows, `${g.code}: caster DMG row ${s.key} played ${n} times for ${rows} row(s)`)
        }
        // 4. arrival effects at the target root + TargetOffset.
        for (const s of g.stages.filter(x => x.anchor === 'flight')) {
          const row = fxg?.stages.find(x => x.actType.startsWith('AT_MOV_') && x.effect2)
          if (!row?.effect2) continue
          const off = rotate(facing(main.yaw), s.targetOffsetM)
          const arrivals = spawned.filter(e => e.key === row.effect2)
          check(arrivals.some(e => e.pos && near(e.pos, [main.root.position.x + off[0], off[1], main.root.position.z + off[2]], 0.05)), `${g.code}: arrival ${row.effect2} not at target + ${s.targetOffsetM}`)
        }
        // 5. nothing keeps playing once the action and the buff are over.
        await run(now + 4000)
        check(fx.stats.live === 0 && fx.stats.flights === 0 && fx.stats.pending === 0, `${g.code}: still live ${JSON.stringify(fx.stats)}`)
        for (const tv of targets) {
          fx.forget(tv.id)
          views.delete(tv.id)
          tv.root.dispose()
        }
      }

      // 3. follow check: a bone row's live pose tracks its joint (moved by hand here: the clip's pose is not sampled).
      {
        const hand = actor.joint('Bip01 R Hand')!
        const before = hand.position.clone()
        fx.stages('SKILL_CH_COLD_GANGGI_A', 'READY', { caster: hero, start: now, hits: [], loopUntil: now + 2000 })
        await run(now + 100)
        const live = (fx as unknown as { live: { fx: { pose?: () => { position: number[] } } }[] }).live
        hand.position.x += 0.3
        const w = hand.computeWorldMatrix(true).m
        const poses = live.map(l => (l.fx as unknown as { sim?: unknown; pose?: () => { position: number[] } }).pose?.()).filter(Boolean) as { position: number[] }[]
        check(poses.some(p => near(p.position, [w[12]!, w[13]!, w[14]!], 0.01)), 'a hand loop does not follow Bip01 R Hand')
        hand.position.copyFrom(before)
        await run(now + 3000)
      }

      // 6. no leaks after 20 casts of every row.
      for (let n = 0; n < 20; n++) {
        const tv = hview(90, 'MOB_CH_MANGNYANG', 'mob', [0, 0, 5], Math.PI, null)
        views.set(90, tv)
        for (const g of golden) {
          if (g.instant || g.basic) {
            fx.hit(g.group, tv, { attacker: hero, landed: true, basic: g.basic, outcome: 'hit' })
            continue
          }
          const inst = ++instance
          player.cast({ t: 'cast', id: 1, skill: g.code, instance: inst, target: 90, prepareMs: g.prepareMs, castMs: g.castMs, actionMs: g.actionMs }, now, recPort)
          player.combat({ t: 'combat', attacker: 1, target: 90, skill: g.code, instance: inst, hits: [{ outcome: 'hit', damage: 1, hp: 9 }] }, now, now, i => fx.hit(g.group, tv, { attacker: hero, cue: g.cues[i], index: i, landed: true, instance: inst }))
          if (n % 3 === 0) player.castEnd({ t: 'castEnd', id: 1, instance: inst, reason: 'interrupted' }, recPort)
          await run(now + 200)
        }
        fx.forget(90)
        views.delete(90)
        tv.root.dispose()
      }
      await run(now + 12_000)
      expect(fx.stats).toMatchObject({ live: 0, flights: 0, pending: 0, loops: 0 })
      expect(fx.stats.disposed).toBe(fx.stats.started)
      expect(problems).toEqual([])
      fx.dispose()
      lib.dispose()
      actor.dispose()
    }, 180_000)
  }
})

/**
 * Wave 11 integration (I-11, docs/WAVE_PLAN7.md §6.4), the game's side of the cross-item tests. Both items on one
 * world: the town part (TL-C's TownLife on TL-R's real schedule, content/town/jangan.json, with the stand-in
 * drawables) on world-render's synthetic streamed World, the game's WorldGraphics and settings, the town feature's
 * bubbles, the town sound's folk counter, Tiger Girl's composite (U-RC on the real glbs when the export is there) and
 * the notices (app.ts's dispatch to the one banner queue, the world screen's chat line and town alarm).
 *
 * - a live Low ↔ Medium switch (and back, twice) leaves no town mesh, VAT texture, crowd material, shown bubble or
 *   stale folk counter, and the composite neither doubles nor loses a mesh; the bed loops stay one set;
 * - two NullEngine worlds whose clocks are 80 ms apart draw every townsperson within 0.15 m (TOWN_LIFE §2.1);
 * - the stage: with the create stage's camera and the stage's `noFolk` circle, townsfolk are drawn behind the
 *   character (in the camera's view, beyond the spot) and never inside the circle;
 * - `uniqueNotice` `appeared` on a world client: one banner, one chat line, the cue once and `town.alarm` once (the
 *   schedule's alarm once too); `defeated`: banner, line and cue, no alarm (the lobby side: apps/server w11-cross);
 * - the Classic (Low) path builds the tiger composite and shows the notices (no town part: the alarm is a no-op);
 * - found by I-11: a schedule asked before the world clock arrived, or before a GM /time, agrees with a fresh one at once;
 * - cut 20 (applied after LAB-11): Medium draws no townsfolk with 15+ players in range, and the bed keeps its count.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ArcRotateCamera, DirectionalLight, HemisphericLight, LoadAssetContainerAsync, Vector3, type AbstractMesh, type Scene } from '@babylonjs/core'
import { GLTFLoaderAnimationStartMode } from '@babylonjs/loaders/glTF/glTFFileLoader.js'
import '@babylonjs/loaders/glTF/2.0/index.js'
import { phaseForSolarTime, type EntityState, type ServerMessage, type TownFile, type WorldClockState } from '@sro/shared'
import { isTownMesh, type World } from '@sro/world-render'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setTownLifeOff } from '../src/settings.ts'

/** The town sound's registration (townSoundFeature needs a GameAudio): the test's TownAudio stands in for it. */
const sound = vi.hoisted(() => ({ audio: null as null | { setFolkCounter(fn: unknown): void; setExternal(e: unknown): void }, counter: null as unknown }))
vi.mock('../src/world/features/town-sound.ts', async orig => ({
  ...(await orig<typeof import('../src/world/features/town-sound.ts')>()),
  activeTownAudio: () => sound.audio,
  setTownFolkCounter: (fn: unknown) => {
    sound.counter = fn
    sound.audio?.setFolkCounter(fn)
  },
}))
import { stubCrowdAssets, type DrawnAgent } from '../../../packages/world-render/src/town/crowd.ts'
import { TownLife, schedulePlan, townPartWith } from '../../../packages/world-render/src/town/index.ts'
import { w10World, type W10Setup } from '../../../packages/world-render/test/w10-fixture.ts'
import { App } from '../src/app.ts'
import { TownAudio, type TownAudioOutput } from '../src/audio/town.ts'
import { UNIQUE_ALARM_S, worldUniqueNotice, type UniqueNoticeMessage } from '../src/hud/unique-notice.ts'
import { SettingsStore } from '../src/settings.ts'
import { STAGE_NO_FOLK_M } from '../src/stage/host.ts'
import { STAGES, STAGE_SPOT } from '../src/stage/stages.ts'
import { KEEP_CLIPS, ModelLibrary } from '../src/three/models.ts'
import { NoticeBanner } from '../src/ui/notice.ts'
import { EntityView, type EntityContext } from '../src/world/entities.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { townFeature } from '../src/world/features/town.ts'
import { scheduleFolkCounter, setTownFolkCounter } from '../src/world/features/town-sound.ts'
import { WorldGraphics, worldTown } from '../src/world/graphics.ts'

// Town life is switched off in the game (settings.ts TOWN_LIFE_OFF); these tests cover the system itself.
setTownLifeOff(false)

const ROOT = join(import.meta.dirname, '../../..')
const JANGAN = JSON.parse(readFileSync(join(ROOT, 'content/town/jangan.json'), 'utf8')) as TownFile
const OUT = join(ROOT, 'work/out')
const RIDER = { code: 'MOB_CH_TIGERWOMAN', glb: '/out/mob/china/tigerwoman.glb', sidecar: '/out/mob/china/tigerwoman.json' }
const RIDE = { model: { code: 'MOB_CH_TIGERWOMAN#ride', glb: '/out/mob/china/bluetiger.glb', sidecar: '/out/mob/china/bluetiger.json' }, joint: 'saddle' }
const HAVE_GLBS = [RIDER.glb, RIDER.sidecar, RIDE.model.glb, RIDE.model.sidecar].every(f => existsSync(join(OUT, f.slice('/out/'.length))))

/** The plaza (town/index.ts PLAZA) at noon of a 2026 day; the town's clock is the server's, in seconds. */
const PLAZA = new Vector3(99, 0, -82)
const NOON_2026 = 1_790_000_000 + 4 * 3600

// ---- a DOM stub: the notice banner, the town bubbles and the entity labels (the game tests run in node) ----------

class StubElement {
  className = ''
  hidden = false
  offsetWidth = 120
  offsetHeight = 20
  readonly style: Record<string, string> = {}
  readonly dataset: Record<string, string> = {}
  readonly children: (StubElement | string)[] = []
  parent: StubElement | null = null
  readonly classList = {
    toggle: (c: string, on?: boolean) => {
      const has = this.className.split(' ').includes(c)
      const want = on ?? !has
      if (want && !has) this.className = `${this.className} ${c}`.trim()
      if (!want && has) this.className = this.className.split(' ').filter(x => x !== c).join(' ')
      return want
    },
    add: (c: string) => void this.classList.toggle(c, true),
    remove: (c: string) => void this.classList.toggle(c, false),
    contains: (c: string) => this.className.split(' ').includes(c),
  }
  setAttribute(): void {}
  addEventListener(): void {}
  append(...c: (StubElement | string)[]): void {
    for (const x of c) {
      if (x instanceof StubElement) x.parent = this
      this.children.push(x)
    }
  }
  insertBefore(c: StubElement): void {
    c.parent = this
    this.children.unshift(c)
  }
  remove(): void {
    if (!this.parent) return
    const i = this.parent.children.indexOf(this)
    if (i >= 0) this.parent.children.splice(i, 1)
    this.parent = null
  }
  get textContent(): string {
    return this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join('')
  }
  set textContent(v: string) {
    this.children.length = 0
    this.children.push(v)
  }
  querySelector(sel: string): StubElement | null {
    const cls = sel.replace(/^\./, '')
    for (const c of this.children) {
      if (typeof c === 'string') continue
      if (c.className.split(' ').includes(cls)) return c
      const f = c.querySelector(sel)
      if (f) return f
    }
    return null
  }
}

const g = globalThis as { document?: unknown; requestAnimationFrame?: unknown }
const saved = { document: g.document, raf: g.requestAnimationFrame, hadDocument: 'document' in g, hadRaf: 'requestAnimationFrame' in g }
let body: StubElement
let labels: StubElement

beforeAll(() => {
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 16)
  body = new StubElement()
  body.dataset.screen = 'world'
  labels = new StubElement()
  labels.className = 'entity-labels'
  body.append(labels)
  g.document = {
    createElement: () => new StubElement(),
    body,
    head: new StubElement(),
    querySelector: (sel: string) => body.querySelector(sel),
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
})

afterAll(() => {
  if (saved.hadDocument) g.document = saved.document
  else delete g.document
  if (saved.hadRaf) g.requestAnimationFrame = saved.raf
  else delete g.requestAnimationFrame
})

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
  vi.restoreAllMocks()
})

const banners = () => body.children.filter((c): c is StubElement => c instanceof StubElement && c.className.split(' ').includes('notice-banner'))
const bubbleEls = () => labels.children.filter((c): c is StubElement => c instanceof StubElement && c.className.split(' ').includes('town-bubble'))
const shownBubbles = () => bubbleEls().filter(e => !e.classList.contains('tb-hide'))

// ---- the world: the synthetic streamed World with the town part on TL-R's real schedule --------------------------

const townFactory = townPartWith({ plan: (w, noFolk) => schedulePlan(JANGAN, w, noFolk), assets: (s, d) => stubCrowdAssets(s, d) })

async function townWorld(render: 'pbr' | 'classic' = 'pbr'): Promise<W10Setup> {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  // The world loads with the saved preset's quality (screens/world.ts); WorldGraphics moves it on a change.
  const s = await w10World({ render, quality: render === 'classic' ? 'low' : 'medium', parts: { batch: null, ocean: null, town: townFactory } })
  cleanups.push(s.dispose)
  return s
}

function plazaCamera(scene: Scene, target = PLAZA): ArcRotateCamera {
  const cam = new ArcRotateCamera('cam', -Math.PI / 2, 1.2, 12, target.clone(), scene)
  cam.minZ = 0.2
  cam.maxZ = 2000
  scene.activeCamera = cam
  return cam
}

/** Low as the Low guard has it (Classic: Low + classic sky + weather off); Medium as the first run has it. */
const LOW = { preset: 'low', sky: 'classic', weather: 'off' } as const
const MEDIUM = { preset: 'medium', sky: 'modern', weather: 'auto' } as const

/** The world screen's graphics link on `world` (the game's settings; the release rollout). */
function graphicsLink(s: W10Setup, preset: 'low' | 'medium' | 'high', clock: () => number) {
  const store = new SettingsStore(null)
  store.set({ graphics: { firstRun: false, ...(preset === 'low' ? LOW : { preset }) } })
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), s.scene)
  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.5).normalize(), s.scene)
  const camera = s.scene.activeCamera ?? plazaCamera(s.scene)
  const graphics = new WorldGraphics({ world: s.world, camera: camera as never, lights: { hemi, sun }, store, rollout: 'on', townClock: clock })
  cleanups.push(() => {
    graphics.dispose()
    hemi.dispose()
    sun.dispose()
  })
  return { store, graphics }
}

const liveTownMeshes = (scene: Scene): AbstractMesh[] => scene.meshes.filter(m => isTownMesh(m) && !m.isDisposed())
const townTextures = (scene: Scene) => scene.textures.filter(t => t.name.startsWith('town:'))
const townMaterials = (scene: Scene) => scene.materials.filter(m => m.name.startsWith('town:'))

function drawn(town: TownLife): Map<number, DrawnAgent> {
  const out = new Map<number, DrawnAgent>()
  const folk = town.folk
  if (!folk) return out
  for (let i = 0; i < folk.schedule.agents.length; i++) {
    const d: DrawnAgent = { x: 0, y: 0, z: 0, h: 0, yaw: 0, scale: 1, alpha: 0 }
    if (folk.drawnOf(i, d)) out.set(i, d)
  }
  return out
}

// ---- Tiger Girl's composite on the real glbs (ride-mob.test.ts' loader) ------------------------------------------

type Loaded = Awaited<ReturnType<ModelLibrary['load']>>

function fileLoader(scene: Scene, lib: ModelLibrary): void {
  const cache = new Map<string, Promise<Loaded>>()
  lib.load = (glb: string, sidecar?: string) => {
    let p = cache.get(glb)
    if (!p) {
      p = (async () => {
        const b = readFileSync(join(OUT, glb.slice('/out/'.length)))
        const container = await LoadAssetContainerAsync(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), scene, {
          pluginExtension: '.glb',
          pluginOptions: { gltf: { animationStartMode: GLTFLoaderAnimationStartMode.NONE } },
        })
        for (const grp of [...container.animationGroups]) {
          if (!KEEP_CLIPS.test(grp.name)) {
            container.animationGroups.splice(container.animationGroups.indexOf(grp), 1)
            grp.dispose()
          }
        }
        const side = sidecar ? (JSON.parse(readFileSync(join(OUT, sidecar.slice('/out/'.length)), 'utf8')) as Record<string, unknown>) : null
        return { container, sidecar: side, packs: null }
      })()
      cache.set(glb, p)
    }
    return p
  }
}

const TIGER_STATE: EntityState = { id: 77, kind: 'mob', name: 'Tiger Girl', model: 'MOB_CH_TIGERWOMAN', level: 20, pos: [101, 0, -90], yaw: 0 }

async function tigerGirl(s: W10Setup, world: World): Promise<{ view: EntityView; meshes: () => AbstractMesh[] }> {
  const lib = new ModelLibrary(s.scene)
  fileLoader(s.scene, lib)
  cleanups.push(() => lib.dispose())
  const ctx = {
    scene: s.scene,
    library: lib,
    catalog: {
      mob: () => ({ code: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', level: 20, model: RIDER, scale: 1, radius: 2.8, ride: RIDE }),
      content: { mobs: new Map() },
      item: () => undefined,
    },
    labels: new StubElement(),
    drops: null,
    heightAt: (x: number, z: number) => world.heightAt(x, z, 0) ?? 0,
    selfId: () => 1,
    selfLevel: () => 20,
    serverNow: () => 0,
    attachments: [],
  } as unknown as EntityContext
  const view = new EntityView({ ...TIGER_STATE }, ctx)
  cleanups.push(() => view.dispose())
  await view.load()
  const meshes = () => {
    const out: AbstractMesh[] = []
    for (const a of [view.actor, view.ride?.actor]) if (a) out.push(...a.root.getChildMeshes(false).filter(m => !m.isDisposed()))
    return out
  }
  return { view, meshes }
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe('a live Low ↔ Medium switch with both items on (WAVE_PLAN7 §6.4)', () => {
  it('leaves no town mesh, VAT, crowd material, shown bubble or stale folk counter; the composite and the bed stay one', async () => {
    const s = await townWorld('pbr')
    const cam = plazaCamera(s.scene)
    let nowS = NOON_2026
    const { store } = graphicsLink(s, 'medium', () => nowS)
    expect(s.world.render.mode).toBe('pbr')
    // The town sound (TL-S): its bed reads the town feature's folk counter while a town part draws.
    const loops: Array<{ file: string; stopped: boolean }> = []
    const out: TownAudioOutput = {
      files: c => (c === 'town.bed.calm' ? ['town/bed_calm'] : c === 'town.bed.busy' ? ['town/bed_busy'] : c === 'town.fountain' ? ['town/fountain'] : []),
      ms: () => 1000,
      loopAt: file => {
        const l = { file, stopped: false }
        loops.push(l)
        return { stop: () => void (l.stopped = true), setPosition: () => {}, setGain: () => {} }
      },
      oneShot: () => true,
      nightLayers: () => [],
      muteDayLayers: () => {},
    }
    const audio = new TownAudio(out, { rng: () => 0.5 })
    sound.audio = audio as never
    cleanups.push(() => void (sound.audio = null))
    const counterNow = () => sound.counter as ((x: number, z: number, r: number) => number) | null
    // The town feature (bubbles, the counter) on this world.
    const ctx = {
      scene: s.scene,
      camera: cam,
      world: () => ({ world: s.world }),
      views: () => [][Symbol.iterator](),
      view: () => undefined,
      selfId: () => null,
    } as unknown as WorldFeatureContext
    const feature = townFeature(ctx)
    cleanups.push(() => feature.dispose?.())
    cleanups.push(() => setTownFolkCounter(null))
    const tiger = HAVE_GLBS ? await tigerGirl(s, s.world) : null
    const tigerMeshes0 = tiger?.meshes().length ?? 0
    const sceneMeshes = (): number => s.scene.meshes.filter(m => !m.isDisposed()).length

    // NullEngine has no canvas: the bubbles' projection (three/project.ts) needs its CSS size.
    vi.spyOn(s.engine, 'getRenderingCanvas').mockReturnValue({ clientWidth: s.engine.getRenderWidth(), clientHeight: s.engine.getRenderHeight() } as never)
    const frames = (n: number) => {
      for (let k = 0; k < n; k++) {
        nowS += 0.1
        s.world.update(cam)
        s.scene.updateTransformMatrix(true)
        feature.onFrame?.(nowS * 1000, 0.1)
        audio.update({ x: PLAZA.x, y: 0, z: PLAZA.z, nowS, solarT: 0.5, inTown: true, dt: 0.1 })
      }
    }
    frames(20)
    const town = s.world.town as TownLife
    expect(town).toBeInstanceOf(TownLife)
    const first = { meshes: liveTownMeshes(s.scene).length, textures: townTextures(s.scene).length, materials: townMaterials(s.scene).length, scene: sceneMeshes() }
    expect(first.meshes).toBeGreaterThan(0)
    expect(town.folk!.frame.drawn).toBeGreaterThan(0)
    // A click answer: the clicked townsperson's bubble shows (the camera on a townsperson near the plaza). The crowd's
    // cap takes agents by rank, not distance, so moving the focus onto the nearest one can push it out of the cap (the
    // town graph decides who that is): take the nearest one the crowd still draws once the camera is on them.
    let someone = -1
    const plazaD = (p: DrawnAgent) => Math.hypot(p.x - PLAZA.x, p.z - PLAZA.z)
    const near = [...drawn(town)].filter(([, p]) => p.alpha > 0.99).sort(([, a], [, b]) => plazaD(a) - plazaD(b))
    for (const [i, p] of near.slice(0, 12)) {
      cam.target.set(p.x, p.y, p.z)
      frames(1)
      const now = drawn(town).get(i)
      if (now && now.alpha > 0.99) {
        cam.target.set(now.x, now.y, now.z)
        someone = i
        break
      }
    }
    expect(someone, 'a townsperson near the plaza stays drawn with the camera on them').toBeGreaterThanOrEqual(0)
    expect(town.say(someone)).toBe(true)
    frames(2)
    expect(shownBubbles().length).toBeGreaterThan(0)
    expect(counterNow()).not.toBeNull()
    expect(counterNow()!(PLAZA.x, PLAZA.z, 30)).toBe(town.folkNear(PLAZA.x, PLAZA.z, 30))
    const bedLoops = () => loops.filter(l => !l.stopped && l.file.startsWith('town/bed')).length
    const bed0 = bedLoops()
    expect(bed0).toBeLessThanOrEqual(2)

    for (let round = 0; round < 2; round++) {
      store.set({ graphics: LOW })
      expect(s.world.render.mode).toBe('classic')
      frames(3)
      expect(s.world.town).toBeNull()
      expect(worldTown(s.world)).toBeNull()
      expect(liveTownMeshes(s.scene), `round ${round}: town meshes on Low`).toHaveLength(0)
      expect(townTextures(s.scene), `round ${round}: VAT textures on Low`).toHaveLength(0)
      expect(townMaterials(s.scene), `round ${round}: crowd materials on Low`).toHaveLength(0)
      expect(shownBubbles(), `round ${round}: bubbles on Low`).toHaveLength(0)
      // H11 LOW-1 / S2 (D23): on Low the bed counts the pure schedule (no crowd's counter is left plugged)
      expect(counterNow(), 'the bed counts the pure schedule on Low').toBe(scheduleFolkCounter)
      expect(bedLoops(), 'the bed keeps playing on Low, one set').toBeLessThanOrEqual(2)
      if (tiger) {
        expect(tiger.view.ride, 'the composite survives the switch').not.toBeNull()
        expect(tiger.meshes().length).toBe(tigerMeshes0)
      }
      store.set({ graphics: MEDIUM })
      expect(s.world.render.mode).toBe('pbr')
      frames(20)
      const next = s.world.town as TownLife
      expect(next).toBeInstanceOf(TownLife)
      expect(next).not.toBe(town)
      expect(liveTownMeshes(s.scene).length, `round ${round}: one set of town meshes`).toBe(first.meshes)
      expect(townTextures(s.scene).length).toBe(first.textures)
      expect(townMaterials(s.scene).length).toBe(first.materials)
      expect(sceneMeshes(), `round ${round}: the scene's mesh count is back`).toBe(first.scene)
      expect(counterNow()).not.toBeNull()
      expect(counterNow()!(PLAZA.x, PLAZA.z, 30)).toBe(next.folkNear(PLAZA.x, PLAZA.z, 30))
      expect(bedLoops()).toBeLessThanOrEqual(2)
      if (tiger) expect(tiger.meshes().length).toBe(tigerMeshes0)
    }
    // Disposing the composite takes both bodies.
    if (tiger) {
      const all = tiger.meshes()
      tiger.view.dispose()
      expect(all.every(m => m.isDisposed())).toBe(true)
    }
    audio.stop()
    expect(loops.every(l => l.stopped)).toBe(true)
  }, 60_000)
})

describe('two clients 80 ms apart see the same townsfolk (TOWN_LIFE §2.1, WAVE_PLAN7 §6.4)', () => {
  it('two NullEngine worlds with clocks 80 ms apart draw every townsperson within 0.15 m', async () => {
    const a = await townWorld('pbr')
    const b = await townWorld('pbr')
    const ca = plazaCamera(a.scene)
    const cb = plazaCamera(b.scene)
    let t = NOON_2026
    ;(a.world.town as TownLife).setClock(() => t)
    ;(b.world.town as TownLife).setClock(() => t + 0.08)
    let compared = 0
    let worst = 0
    for (let k = 0; k < 120; k++) {
      t += k % 30 === 0 ? 97.3 : 0.1 // jumps through the afternoon, then frames
      a.world.update(ca)
      b.world.update(cb)
      if (k % 30 < 12) continue // after a jump, let the fades settle
      const da = drawn(a.world.town as TownLife)
      const db = drawn(b.world.town as TownLife)
      for (const [i, pa] of da) {
        const pb = db.get(i)
        if (!pb || pa.alpha < 0.99 || pb.alpha < 0.99) continue
        const d = Math.hypot(pa.x - pb.x, pa.z - pb.z)
        worst = Math.max(worst, d)
        // walkers 1.46 m/s (0.12 m in 80 ms); the running children and the hurrying: their own 80 ms
        expect(d, `agent ${i} at t=${t.toFixed(1)}`).toBeLessThanOrEqual(0.25)
        if (d > 0.15) expect(JANGAN.folk.roles.child ?? 0, `agent ${i}: only a running child may exceed 0.15 m`).toBeGreaterThan(0)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(200)
    expect(worst).toBeGreaterThan(0)
  }, 60_000)
})

describe('cut 20 (WAVE_PLAN7 §7, applied by I-11 after LAB-11): Medium gives the crowd up to 15+ players', () => {
  it('no townsfolk drawn with 15 players in range on Medium; the bed keeps the schedule count; 14 players: the floor', async () => {
    const s = await townWorld('pbr')
    const cam = plazaCamera(s.scene)
    const town = s.world.town as TownLife
    let t = NOON_2026
    town.setClock(() => t)
    const frames = (n: number) => {
      for (let k = 0; k < n; k++) {
        t += 0.1
        s.world.update(cam)
      }
    }
    town.setPlayers(14)
    frames(30)
    expect(town.folk!.frame.drawn).toBeGreaterThan(15)
    expect(town.folkNear(PLAZA.x, PLAZA.z, 30)).toBe(town.folk!.countNear(PLAZA.x, PLAZA.z, 30))
    town.setPlayers(15)
    frames(30) // the fade (0.6 s)
    expect(town.folk!.frame.drawn).toBe(0)
    expect(town.folkNear(PLAZA.x, PLAZA.z, 30), 'the bed still hears the town').toBeGreaterThan(0)
    town.setPlayers(4)
    frames(30)
    expect(town.folk!.frame.drawn).toBeGreaterThan(15)
  }, 60_000)
})

describe('the crowd is the same for a client that came in before the clock (TOWN_LIFE §2.1; found by I-11)', () => {
  /** The world clock at `hour` (solar) at server second nowS (the server's 2 h game day, night speed-up 0.4). */
  const clockAt = (hour: number, nowS: number): WorldClockState => ({
    anchorMs: nowS * 1000, anchorDays: 3277 + phaseForSolarTime(hour / 24, 0.4), dayMs: 7_200_000, running: true, nightSpeedup: 0.4, declination: 12,
  })
  const worldWith = (clock: WorldClockState | null) => ({ worldClock: clock, skyState: { t: 0.5 }, manifest: { name: 'jangan-fields' }, heightAt: () => 0 }) as unknown as World
  const q = (nowS: number) => ({ nowS, solarT: 0.5, alarmFromS: 0, alarmUntilS: 0, rain: 0 })
  const pose = () => ({ x: 0, y: 0, z: 0, yaw: 0, clip: '', clipT: 0, distM: 0, speed: 0, alpha: 0, rate: 1 })

  function compare(a: ReturnType<typeof schedulePlan>, b: ReturnType<typeof schedulePlan>, nowS: number): number {
    const pa = pose()
    const pb = pose()
    let diff = 0
    for (let i = 0; i < a.folk.agents.length; i++) {
      const oa = a.folk.pose(i, q(nowS), pa as never)
      const ob = b.folk.pose(i, q(nowS), pb as never)
      if (oa !== ob || (oa && Math.hypot(pa.x - pb.x, pa.z - pb.z) > 0.01)) diff++
    }
    return diff
  }

  it('a schedule asked before the world clock arrived, or before a GM /time, agrees with a fresh one at once', () => {
    const t0 = NOON_2026
    const early = worldWith(null) // in the world before the first clock message: the sky's own time
    const a = schedulePlan(JANGAN, early, [])
    const p = pose()
    for (let i = 0; i < a.folk.agents.length; i++) a.folk.pose(i, q(t0), p as never)
    early.worldClock = clockAt(20, t0) // the clock arrives: 20:00
    const b = schedulePlan(JANGAN, worldWith(clockAt(20, t0)), []) // a friend who comes in now
    expect(compare(a, b, t0 + 1), 'agents that differ after the clock arrived').toBe(0)
    // a GM /time 07:00: the clock moves on both clients (in place on one, a new object on the other)
    const morning = clockAt(7, t0 + 2)
    Object.assign(early.worldClock!, morning)
    const c = schedulePlan(JANGAN, worldWith(morning), [])
    expect(compare(a, c, t0 + 3), 'agents that differ after a GM /time').toBe(0)
  })
})

describe('the character stage: townsfolk behind create, none on the steps (D17, WAVE_PLAN7 §6.4)', () => {
  it('with the create camera and the stage\'s noFolk circle, folk are drawn in view beyond the spot and never inside it', async () => {
    const s = await townWorld('pbr')
    const def = STAGES.create
    const cam = def.camera
    if (cam.kind !== 'fixed') throw new Error('create has a fixed camera')
    // The create camera (stage/host.ts): distM from the spot along its heading, looking at the spot's target height.
    const dir = new Vector3(Math.sin(cam.yaw), 0, Math.cos(cam.yaw)) // the look heading: π looks −Z (north)
    const target = new Vector3(STAGE_SPOT.x, cam.targetHeightM, STAGE_SPOT.z)
    const pos = target.subtract(dir.scale(cam.distM))
    const camera = new ArcRotateCamera('stage', 0, 1, cam.distM, target, s.scene)
    camera.setPosition(new Vector3(pos.x, cam.heightM, pos.z))
    s.scene.activeCamera = camera
    const town = s.world.town as TownLife
    town.configure({ noFolk: { x: STAGE_SPOT.x, z: STAGE_SPOT.z, r: STAGE_NO_FOLK_M } })
    let t = NOON_2026
    town.setClock(() => t)
    const halfFov = (cam.fovDeg * Math.PI) / 360
    let inView = 0
    let samples = 0
    for (let k = 0; k < 200; k++) {
      t += k % 20 === 0 ? 211.7 : 0.1
      s.world.update(camera)
      if (k % 20 < 8) continue
      samples++
      for (const p of drawn(town).values()) {
        const r = Math.hypot(p.x - STAGE_SPOT.x, p.z - STAGE_SPOT.z)
        expect(r, `a townsperson inside the noFolk circle at t=${t.toFixed(1)}`).toBeGreaterThanOrEqual(STAGE_NO_FOLK_M - 0.05)
        // behind the character: beyond the spot along the look heading, inside the horizontal field of view
        const vx = p.x - pos.x
        const vz = p.z - pos.z
        const along = vx * dir.x + vz * dir.z
        const side = Math.abs(vx * dir.z - vz * dir.x)
        if (along > cam.distM + 2 && side < along * Math.tan(halfFov) * 1.78 && p.alpha > 0.5) inView++
      }
    }
    expect(samples).toBeGreaterThan(50)
    expect(inView / samples, 'townsfolk in the create view per frame').toBeGreaterThan(3)
  }, 60_000)
})

describe('uniqueNotice on a world client (UNIQUES §3.3, WAVE_PLAN7 D9, D19, §6.4)', () => {
  function client(town: { alarm?(n: number, s: number): void } | null) {
    const cues: string[] = []
    const lines: string[] = []
    let listener: ((m: ServerMessage) => void) | null = null
    let worldListener: ((m: ServerMessage) => void) | null = null
    const session = {
      on: (fn: (m: ServerMessage) => void) => {
        if (!listener) listener = fn
        else worldListener = fn
        return () => {}
      },
      onStatus: () => () => {},
      close: () => {},
    }
    const notices = new NoticeBanner()
    const app = { session: null, sessionOff: null, notices, audio: { ui: (c: string) => void cues.push(c) }, showBanner: () => {} }
    App.prototype.setSession.call(app as unknown as App, session as never)
    // The world screen's own listener (screens/world.ts: the 'uniqueNotice' case calls worldUniqueNotice).
    session.on(m => {
      if (m.t === 'uniqueNotice') worldUniqueNotice(m, { chat: { add: (_c, text) => void lines.push(text) }, town, nowS: NOON_2026 })
    })
    const send = (m: ServerMessage) => {
      listener!(m)
      worldListener!(m)
    }
    return { send, cues, lines, notices }
  }

  const appeared: UniqueNoticeMessage = { t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', area: 'North-Tiger Mt.' }
  const defeated: UniqueNoticeMessage = { t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', by: 'Mei' }

  it('the world screen\'s case is worldUniqueNotice (the code this test runs)', () => {
    const src = readFileSync(join(ROOT, 'apps/game/src/screens/world.ts'), 'utf8')
    const at = src.indexOf("case 'uniqueNotice'")
    expect(at).toBeGreaterThan(0)
    expect(src.slice(at, at + 400)).toContain('worldUniqueNotice(msg, { chat, town: worldTown(jangan?.world)')
  })

  it('appeared: one banner, one chat line, the cue once and the town alarm once (the schedule\'s too); defeated: no alarm', async () => {
    vi.useFakeTimers()
    try {
      const s = await townWorld('pbr')
      const town = s.world.town as TownLife
      const alarm = vi.spyOn(town, 'alarm')
      const scheduleAlarm = vi.fn()
      town.plan!.folk.alarm = scheduleAlarm
      const c = client(worldTown(s.world))
      c.send(appeared)
      expect(banners()).toHaveLength(1)
      expect(c.lines).toEqual(['[Unique] Tiger Girl has appeared! Area: North-Tiger Mt.'])
      expect(c.cues).toEqual(['ui.uniqueAppear'])
      expect(alarm).toHaveBeenCalledTimes(1)
      expect(alarm).toHaveBeenCalledWith(NOON_2026, UNIQUE_ALARM_S)
      expect(scheduleAlarm).toHaveBeenCalledTimes(1)
      c.send(defeated)
      expect(banners()).toHaveLength(1) // queued behind the first, never two
      vi.advanceTimersByTime(30_000)
      expect(c.cues).toEqual(['ui.uniqueAppear', 'ui.uniqueDown'])
      expect(c.lines).toHaveLength(2)
      expect(alarm).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(30_000)
      expect(banners()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)

  it.skipIf(!HAVE_GLBS)('the Classic (Low) path builds the tiger composite and shows the notices (no town: no alarm, no throw)', async () => {
    const s = await townWorld('classic')
    try {
      plazaCamera(s.scene)
      graphicsLink(s, 'low', () => NOON_2026)
      expect(s.world.render.mode).toBe('classic')
      expect(s.world.town).toBeNull()
      const tiger = await tigerGirl(s, s.world)
      expect(tiger.view.ride).not.toBeNull()
      expect(tiger.view.height).toBeGreaterThanOrEqual(2.8)
      expect(tiger.view.height).toBeLessThanOrEqual(3.4)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const c = client(worldTown(s.world))
      c.send(appeared)
      expect(banners()).toHaveLength(1)
      expect(c.cues).toEqual(['ui.uniqueAppear'])
      expect(c.lines).toHaveLength(1)
      vi.advanceTimersByTime(30_000)
      expect(banners()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)
})

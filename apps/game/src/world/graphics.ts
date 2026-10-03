/**
 * The world screen's wave-9 graphics link (docs/WAVE_PLAN3.md §6.15, lane GAME): turns the effective graphics
 * (settings.ts effectiveGraphics, through the rollout gate of rollout.ts) into World calls, and owns the character side
 * of the renderer.
 *
 * - `apply()` (at load and on every settings change): the preset's non-render effects, the render and sky blocks, the
 *   material path (a streamed world rebuilds its regions; a whole-world load keeps its materials until it is entered
 *   again, and the player is told), the sky style and the tone map. A change that leaves the render blocks alone (sight
 *   range, grass) does not touch the renderer, so the post stack is not rebuilt for it.
 * - The characters' own lights (screens/world.ts `hemi` and `sun`): off on the PBR path (the celestial light, the sky
 *   light and the night cluster light characters, RENDER §4.1); on the Classic path `frame()` sets them every frame:
 *   today's values (× the remaster test boost), × the Classic weather multipliers with the classic sky, and through the
 *   sky state (SKY-B's applySkyToLights) whenever the new look is on. Without it they are exactly HEAD's.
 * - Character materials (the ModelLibrary decorator): RND-M's PBR decoration is recorded on every path and applied on
 *   PBR (PbrSurfaces follows path switches), with 6 lights per material on PBR (celestial + the night pool fallback's 2 +
 *   the 2 hit flashes, D12; 4 is Babylon's default, which the other PBR cases never exceed).
 * - Character shadows: an entity attachment hands each model's meshes to `world.render.addCharacter`.
 * - G1 rescue: the crowd budget (world/crowd-budget.ts) over the same attachments: with many characters near, the other
 *   characters cast fewer shadows (blobs under the rest on Medium) and update their poses less often far away; the own
 *   character, the party and the target never change. Runs every frame from `frame()`; nothing on the Classic path.
 * - The frame-time watchdog (RENDER §10): with the new look on, p95 > 33 ms over 10 s drops one preset (once per preset
 *   and visit, never below WATCHDOG_FLOOR: Medium) and says so in chat. It does not judge while the world streams or
 *   compiles shaders, nor for WATCHDOG.settleMs after (W9A perf pass: a switch settles in 5–26 s on the dev PC).
 *   V-12: nor when the display or the browser caps the frame rate (a 30 Hz screen: steady 31–35 ms frames): frames
 *   at the display's own pace (./frame-pace.ts), or with little CPU and GPU work in them, are vsync, not slowness.
 * - Wave 10 (docs/WAVE_PLAN6.md §4.2, W10-G): the grass style and the Mac / iGPU Grass: Low (`grassQualityFor`) ride
 *   along in World.setQuality; Options → Advanced → World batching calls `World.setBatching` on a change (never while
 *   the world stays on the Classic path: Low never batches); Options → Wildlife calls `World.life.setEnabled`.
 * - Wave 11 (docs/WAVE_PLAN7.md §4.4, W11-G): Options → Town life (`townLifeFor`) reaches `World.setTownLife`, and
 *   every town part the world (re)builds gets the shared server clock and the threats feed (the same as the
 *   wildlife's). `World.town` is null on the Classic path (the Low guard).
 * - Wave 12 (docs/WAVE_PLAN8.md D9, W12-G; TREES Part W): Options → Trees. The world loads with `worldTreesOption`
 *   (`LoadWorldOptions.trees`: the setting on the PBR path, 'retail' on Classic: the Low guard); a change reaches
 *   `World.setTreeMode` (it rebuilds the streamed regions) while the world is or turns PBR, never while it stays Classic.
 *   A world without that seam applies it the next time the world is entered (and says so).
 */
import { EngineInstrumentation, type AbstractEngine, type AbstractMesh, type Camera, type DirectionalLight, type HemisphericLight, type Material, type Observer, type Scene } from '@babylonjs/core'
import { CharacterBlobs, RenderPost, STREAM_DEFAULTS, applySkyToLights, type QualitySettings, type RenderPath, type World } from '@sro/world-render'
import { presetLabel } from '../hud/options.ts'
import { t } from '../i18n/index.ts'
import { RENDER_ROLLOUT, type RenderRollout } from '../rollout.ts'
import {
  type FrameCost,
  FrameWatchdog,
  WATCHDOG_FLOOR,
  effectiveGraphics,
  grassQualityFor,
  lowerPreset,
  townLifeFor,
  qualityFor,
  refreshResolution,
  settings,
  setRenderScaleHandler,
  type EffectiveGraphics,
  type GpuHint,
  type GraphicsPreset,
  type Settings,
  type SettingsStore,
  type TownLifeLevel,
  type TreesSetting,
} from '../settings.ts'
import { framePace, type FramePace } from './frame-pace.ts'
import { CrowdBudget, crowdShadowRule, type CrowdView } from './crowd-budget.ts'
import type { EntityAttachment, EntityView } from './entities.ts'
import { CHARACTER_LIGHTS, characterLightIntensities } from './features/weather.ts'

/**
 * Character materials on the PBR path take this many lights (D12: the celestial light, the night pool fallback's 2 and
 * the 2 hit flashes, one to spare). Only the pool fallback goes past Babylon's default of 4.
 */
export const PBR_CHARACTER_LIGHTS = 6
/** How often a character's meshes are checked for a change of equipment (ms of server time). */
export const CHARACTER_SCAN_MS = 2000

export interface WorldGraphicsOptions {
  world: World
  camera: Camera
  /** The characters' hemisphere and sun (screens/world.ts buildWorldScene). */
  lights: { hemi: HemisphericLight; sun: DirectionalLight }
  /** The GPU hint (settings.ts deviceHintOf): the 16-varying cap, the integrated-GPU weather rule. */
  gpu?: GpuHint | null
  store?: SettingsStore
  rollout?: RenderRollout
  /** The remaster test switch's light factors while it is on (three/remaster.ts; default none). */
  remasterBoost?: () => { key: number; fill: number } | null
  /** Called with the material path at start and on every switch (screens/world.ts: RemasterLighting on Classic only). */
  onPath?: (path: RenderPath) => void
  /** A chat line (the watchdog, a whole-world load that cannot switch its path). */
  say?: (text: string) => void
  /** Page time (ms) for the watchdog. */
  now?: () => number
  /** The engine, for the GPU frame time (EngineInstrumentation; timestamp-query) and the watchdog's compile signal. */
  engine?: AbstractEngine | null
  /**
   * Wave 10 (GRASS_LIFE §5.1): what the wildlife flees (screens/world.ts: `actorThreats` of the known actors). Handed to
   * World.life whenever the world has a (new) life part; none on the character stages.
   */
  threats?: () => readonly ThreatPoint[]
  /**
   * Wave 11 (TOWN_LIFE §2.3): the shared server clock in seconds (screens/world.ts: `serverNow() / 1000`), handed to
   * World.town with the threats whenever the world has a (new) town part; none on the character stages.
   */
  townClock?: () => number
  /** G1 rescue: the current target (the crowd budget keeps it at full quality); none on the character stages. */
  target?: () => EntityView | null
  /** G1 rescue: the actors' animation LOD is on (ModelLibrary.animLod; off on Low, the Low guard). Default off. */
  animLod?: () => boolean
  /** Wave 12: the trees the world was loaded with (`LoadWorldOptions.trees`); default the start's `worldTreesOption`. */
  trees?: TreesSetting
  /** V-12: the display's pace and the frames' CPU work for the watchdog (default the page's, fed by app.ts); null none. */
  pace?: FramePace | null
}

/**
 * Wave 12 (W12-SA, packages/world-render world.ts; TREES §3.1 F13): `setTreeMode(mode)` re-requests the streamed
 * regions with the new swap (the claim keys on the render path: Classic never swaps). Read through this view so the
 * link also runs on a World without it (lane tests' fakes, a world-render before the seam).
 */
export interface WorldWave12Seams {
  setTreeMode?(mode: TreesSetting): void
}

/**
 * Wave 12 (WAVE_PLAN8 D9): `LoadWorldOptions.trees` for these effective graphics: Options → Trees on the PBR path,
 * 'retail' on the Classic path and without the new look (the Low guard).
 */
export function worldTreesOption(e: Pick<EffectiveGraphics, 'trees'>): TreesSetting {
  return e.trees
}

/**
 * Wave 11 (docs/WAVE_PLAN7.md §4.3, W11-S): the town part of World (`World.town: TownPart | null`, null on the Classic
 * path), read through this view so the link also runs on a World without it (lane tests' fakes, a world-render
 * before W11-S).
 */
export interface WorldTownSeam {
  setClock?(fn: () => number): void
  setThreats?(fn: () => readonly ThreatPoint[]): void
  /** `counts`: the crowd's count scale (Town life: Low 0.5, Full 1); `noFolk`: where nobody walks. Absent keys keep. */
  configure?(o: { counts?: number; noFolk?: { x: number; z: number; r: number } | null }): void
  alarm?(nowS: number, sec: number): void
  setEnabled?(on: boolean): void
}

/** Wave 11: the World seams the link reads (see WorldTownSeam). */
export interface WorldWave11Seams {
  town?: WorldTownSeam | null
  /** Town life Off / Low / Full on the town part, now and on every part made later (W11-S). */
  setTownLife?(level: TownLifeLevel): void
}

/** Wave 11: the world's town part (null on the Classic path, on a world without the seam, or with no world). */
export function worldTown(world: World | null | undefined): WorldTownSeam | null {
  return (world as (World & WorldWave11Seams) | null | undefined)?.town ?? null
}

/**
 * The wave-10 World seams this link calls (W10-S, packages/world-render world.ts): `setBatching(on)` releases the
 * region batches and rebuilds the streamed regions (BATCHING F12), `life` is null on the Classic path. Read through
 * this view so the link also runs on a World without them (lane tests' fakes).
 */
export interface WorldWave10Seams {
  setBatching?(on: boolean): void
  life?: { setEnabled(on: boolean): void; setThreats?(fn: () => readonly ThreatPoint[]): void } | null
}

/** Where a threat to the wildlife stands (GRASS_LIFE §5.1: read from the entity positions, not the camera). */
export interface ThreatPoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * GRASS_LIFE §5.1's threats: every actor the client knows (the own character, players, mobs, NPCs walking by; no ground
 * items, corpses or fading views), as their positions. One array, refilled on each call (the wildlife asks per frame).
 */
export function actorThreats(views: () => Iterable<EntityView>): () => readonly ThreatPoint[] {
  const out: ThreatPoint[] = []
  return () => {
    out.length = 0
    for (const v of views()) if (v.kind !== 'item' && !v.dead && !v.fading && !v.isDisposed) out.push(v.pos)
    return out
  }
}

/** What `WorldGraphics` takes the world's batching to be at load: W10-S's LoadWorldOptions.batching defaults on. */
export const BATCHING_AT_LOAD = true

/** A mesh list's identity (same meshes in the same order). */
const sameMeshes = (a: readonly AbstractMesh[], b: readonly AbstractMesh[]) => a.length === b.length && a.every((m, i) => m === b[i])

/** The topmost meshes of a character model (each part's root; the renderer walks their children itself). */
export function characterMeshes(view: Pick<EntityView, 'actor'> & { ride?: EntityView['ride'] }): AbstractMesh[] {
  // Wave 11: a ridden mob's ride carries the rider (under its seat): one root for both.
  const root = view.ride?.actor.root ?? view.actor?.root
  if (!root || root.isDisposed()) return []
  const all = root.getChildMeshes(false)
  const set = new Set<unknown>(all)
  return all.filter(m => !set.has(m.parent))
}

export class WorldGraphics {
  /** What the world renders now (settings.ts effectiveGraphics). */
  effective: EffectiveGraphics
  /** The material path the world is on (it can lag `effective.render` on a whole-world load). */
  path: RenderPath
  readonly watchdog = new FrameWatchdog()
  /** G1 rescue: the crowd budget over the characters this link hands to the renderer (`__sroCrowd` in the console). */
  readonly crowd: CrowdBudget
  private readonly world: World
  private readonly store: SettingsStore
  private readonly rollout: RenderRollout
  private readonly gpu: GpuHint | null
  private readonly now: () => number
  private readonly base: { sunDir: [number, number, number]; sun: [number, number, number]; hemi: [number, number, number]; ground: [number, number, number] }
  private lastPreset: GraphicsPreset | null = null
  /** V-12: what the watchdog asks before a drop (the display's pace, the CPU work, the GPU frame time). */
  private readonly cost: FrameCost | null
  private renderKey = ''
  private toldReenter = false
  /** The batching the world was last told (BATCHING_AT_LOAD until a change). */
  private batching = BATCHING_AT_LOAD
  /** Wave 12: the trees the world was last told (the load's until a change). */
  private trees: TreesSetting
  /** The life part the threats were handed to (a path switch can build a new one). */
  private threatsTo: unknown = null
  /** Wave 11: the town part the clock and threats were handed to, and the level it was last told. */
  private townTo: unknown = null
  private townLevel: TownLifeLevel | null = null
  /** onPath ran for the first path. */
  private pathTold = false
  private skyLit = false
  private readonly charMats = new Set<Material>()
  private readonly raised = new Map<Material, number>()
  /** Presets the watchdog already dropped from on this visit (the player's choice back up is kept). */
  private readonly dropped = new Set<GraphicsPreset>()
  private instrumentation: EngineInstrumentation | null = null
  /** A shader compiled since the last frame (the watchdog waits: a compile is a rebuild, not the frame rate). */
  private compiled = false
  private readonly compileObs: Observer<AbstractEngine> | null
  private disposed = false
  private readonly off: () => void

  constructor(private readonly o: WorldGraphicsOptions) {
    this.world = o.world
    this.store = o.store ?? settings
    this.rollout = o.rollout ?? RENDER_ROLLOUT
    this.gpu = o.gpu ?? null
    this.now = o.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()))
    const pace = o.pace === undefined ? framePace : o.pace
    this.cost = {
      paceMs: () => pace?.paceMs() ?? null,
      cpuMs: () => pace?.cpuMs() ?? null,
      gpuMs: () => {
        const ns = this.instrumentation?.gpuFrameTimeCounter.lastSecAverage ?? 0
        return ns > 0 ? ns / 1e6 : null
      },
      gpuMeasurable: () => this.gpuMeasurable(),
    }
    const { sun, hemi } = o.lights
    this.base = {
      sunDir: [sun.direction.x, sun.direction.y, sun.direction.z],
      sun: [sun.diffuse.r, sun.diffuse.g, sun.diffuse.b],
      hemi: [hemi.diffuse.r, hemi.diffuse.g, hemi.diffuse.b],
      ground: [hemi.groundColor.r, hemi.groundColor.g, hemi.groundColor.b],
    }
    this.path = this.world.render.mode
    this.crowd = new CrowdBudget({
      renderer: this.world.render,
      eye: () => o.camera.globalPosition ?? null,
      target: o.target ? () => o.target!() as CrowdView | null : undefined,
      shadows: () => (this.world.render.mode === 'pbr' ? (this.world.render.quality?.shadows ?? null) : null),
      anim: () => o.animLod?.() ?? false,
      blobs: () => {
        // The renderer's scene (a lane test's fake world has none: no blobs there).
        const scene = (this.world.render as { scene?: Scene }).scene
        return this.world.render.mode === 'pbr' && !this.disposed && scene ? new CharacterBlobs(scene) : null
      },
    })
    this.compileObs = o.engine?.onAfterShaderCompilationObservable.add(() => {
      this.compiled = true
    }) ?? null
    this.effective = this.compute()
    this.trees = o.trees ?? worldTreesOption(this.effective)
    // FSR1 takes the resolution on the PBR path where the post plan allows it (RENDER §5.6); else the canvas scales.
    setRenderScaleHandler(r => {
      const post = this.world.render.post
      if (this.disposed || this.world.render.mode !== 'pbr' || !(post instanceof RenderPost)) return false
      post.setRenderScale(r < 1 ? r : null)
      return post.plan.fsrScale > 0
    })
    // Only a graphics change applies (the store hands out fresh objects, so compare the values).
    this.off = this.store.onChange((s, prev) => {
      if (JSON.stringify(s.graphics) !== JSON.stringify(prev.graphics)) this.apply()
    })
    this.apply()
    if (this.world.render.mode === 'pbr' && this.world.render.activeCamera !== o.camera) this.world.render.attachCamera(o.camera)
    this.watchdog.reset(this.now())
  }

  private compute(): EffectiveGraphics {
    return effectiveGraphics(this.store.get(), { gpu: this.gpu, rollout: this.rollout, preset: this.world.quality })
  }

  /** Settings → world (see the file comment). Safe to call again at any time (objectsReady does, for late objects). */
  apply(): void {
    if (this.disposed) return
    const w = this.world
    const s = this.store.get()
    if (s.graphics.preset !== this.lastPreset) {
      // A changed preset (not the first apply: the world loaded with its own, maybe `?quality=`) moves the world.
      if (this.lastPreset !== null) {
        w.quality = s.graphics.preset
        w.stream?.setSettings(STREAM_DEFAULTS[s.graphics.preset])
      }
      this.lastPreset = s.graphics.preset
    }
    const e = (this.effective = this.compute())
    const q: QualitySettings = { ...qualityFor(s, w.quality), ...grassQualityFor(s, e, this.gpu), render: e.renderQuality, sky: e.skyQuality }
    const key = JSON.stringify([e.renderQuality, e.skyQuality])
    const before = w.render.mode
    const wantSwitch = e.render !== before
    // A whole-world load cannot convert its materials in place (World.setRenderMode): it switches on the next entry.
    const canSwitch = wantSwitch && !!w.stream
    if (wantSwitch && !canSwitch && !this.toldReenter) {
      this.toldReenter = true
      this.o.say?.(t('render.reenter'))
    }
    const renderChanged = key !== this.renderKey
    // Leaving PBR: drop its parts first; entering it: the preset's blocks first, so the parts are built with them.
    if (canSwitch && e.render === 'classic') w.setRenderMode('classic')
    if (renderChanged || canSwitch) {
      this.renderKey = key
      w.setQuality(q)
    } else {
      // Only the non-render part of World.setQuality (sight range, animated objects, water, grass): no post rebuild.
      w.objects.setRangeScale(q.drawDistance)
      w.objects.setAnimatedVisible(q.animated)
      w.water.setVisible(q.water)
      if (q.scatter) w.scatter.setLevel(q.scatter)
    }
    // Wave 10: a changed World batching row reaches the world before a switch to PBR builds its regions (the switch's
    // rebuild then claims them or not), or at once on PBR; never while the world stays Classic (the Low guard).
    const seams = w as World & WorldWave10Seams
    const wantBatch = s.graphics.advanced.batching === 'on'
    if (wantBatch !== this.batching && (w.render.mode === 'pbr' || (canSwitch && e.render === 'pbr'))) {
      this.batching = wantBatch
      seams.setBatching?.(wantBatch)
    }
    // Wave 12: Options → Trees, the same way (the PBR path only; Classic keeps retail: the Low guard).
    this.applyTrees(s, w.render.mode === 'pbr' || (canSwitch && e.render === 'pbr'))
    if (canSwitch && e.render === 'pbr') w.setRenderMode('pbr')
    const life = seams.life
    life?.setEnabled(e.wildlife)
    if (life && this.o.threats && life !== this.threatsTo) {
      this.threatsTo = life
      life.setThreats?.(this.o.threats)
    }
    this.applyTown(s, e)
    w.setSkyStyle(e.sky)
    const post = w.render.post
    if (post instanceof RenderPost) post.setToneMap(e.toneMap)
    this.syncPath()
    // A rebuild's shader compiles and TAA refill are not the frame rate: the watchdog waits its grace again.
    if (canSwitch || renderChanged) this.watchdog.reset(this.now())
    refreshResolution()
  }

  /**
   * Wave 12: a changed Trees row reaches `World.setTreeMode` when the world is (or is turning) PBR: before the switch's
   * rebuild, so that rebuild already swaps. Without the seam the world keeps its load's trees until it is entered again.
   */
  private applyTrees(s: Settings, pbr: boolean): void {
    const want = s.graphics.trees
    if (want === this.trees || !pbr) return
    this.trees = want
    const seams = this.world as World & WorldWave12Seams
    if (seams.setTreeMode) seams.setTreeMode(want)
    else if (!this.toldReenter) {
      this.toldReenter = true
      this.o.say?.(t('render.reenter'))
    }
  }

  /**
   * Wave 11: Town life → World.town (on the PBR path only; null on Classic). A new town part (a path switch re-makes
   * it) gets the clock and the threats once, and the level again.
   */
  private applyTown(s: Settings, e: EffectiveGraphics): void {
    const w = this.world as World & WorldWave11Seams
    const level = townLifeFor(s, e, this.gpu)
    // The world keeps the level for every town part it makes later (a switch to PBR), so it is told on Classic too.
    if (level !== this.townLevel) {
      this.townLevel = level
      w.setTownLife?.(level)
    }
    this.wireTown()
  }

  /** A town part not wired yet (new, or re-made by the world) gets the clock and the threats. */
  private wireTown(): void {
    const town = worldTown(this.world)
    if (town === this.townTo) return
    this.townTo = town
    if (!town) return
    if (this.o.townClock) town.setClock?.(this.o.townClock)
    if (this.o.threats) town.setThreats?.(this.o.threats)
  }

  /** Lights, character materials and the remaster lighting follow the path the world is on. */
  private syncPath(): void {
    const path = this.world.render.mode
    const { hemi, sun } = this.o.lights
    const pbr = path === 'pbr'
    hemi.setEnabled(!pbr)
    sun.setEnabled(!pbr)
    if (!pbr) this.world.isolateLights([hemi, sun])
    const changed = path !== this.path
    this.path = path
    if (changed) {
      this.watchdog.reset(this.now())
      for (const m of this.charMats) this.lightsFor(m)
      // The blobs belong to the PBR path (made again there on the next need).
      this.crowd.dropBlobs()
    }
    // G1 rescue: the blob set exists before play where the preset gives blobs (its warm-up hook compiles it at entry).
    if (pbr && crowdShadowRule(this.world.render.quality?.shadows)?.blobs) this.crowd.prepareBlobs()
    if (changed || !this.pathTold) {
      this.pathTold = true
      this.o.onPath?.(path)
    }
  }

  /** The ModelLibrary decorator of the world screen (every character and equipment material). */
  decorate(mat: Material): void {
    if (this.disposed) return
    // Recorded on Classic, dressed on PBR; PbrSurfaces re-dresses or undresses on a path switch (surface-plugin.ts).
    this.world.materials.pbr.decorateCharacterMaterial(mat)
    if (!this.charMats.has(mat)) {
      this.charMats.add(mat)
      mat.onDisposeObservable.addOnce(() => {
        this.charMats.delete(mat)
        this.raised.delete(mat)
      })
    }
    this.lightsFor(mat)
  }

  /** PBR: 6 lights per character material; Classic: the material's own count back (HEAD's shaders). */
  private lightsFor(mat: Material): void {
    const m = mat as Material & { maxSimultaneousLights?: number }
    if (typeof m.maxSimultaneousLights !== 'number') return
    if (this.path === 'pbr') {
      if (m.maxSimultaneousLights < PBR_CHARACTER_LIGHTS) {
        this.raised.set(mat, m.maxSimultaneousLights)
        m.maxSimultaneousLights = PBR_CHARACTER_LIGHTS
      }
    } else {
      const was = this.raised.get(mat)
      if (was !== undefined) {
        m.maxSimultaneousLights = was
        this.raised.delete(mat)
      }
    }
  }

  /** The characters' meshes for the renderer's shadows (every path: the renderer keeps them until it has shadows). */
  attachment(view: EntityView): EntityAttachment | null {
    if (view.kind === 'item') return null
    let added: AbstractMesh[] = []
    let next = -Infinity
    let gone = false
    // `force`: hand the same roots over again (a part merge changed the meshes under them: the shadows re-read them now).
    const refresh = (force = false) => {
      if (this.disposed || gone) return
      const want = characterMeshes(view)
      if (!force && sameMeshes(added, want)) return
      for (const m of added) this.world.render.removeCharacter(m)
      added = want
      for (const m of added) this.world.render.addCharacter(m)
      // G1 rescue: the budget follows the view's roots (each root takes the view's current decision again).
      this.crowd.track(view as CrowdView, added, () => view.height, () => refresh(true))
    }
    return {
      loaded: () => refresh(),
      update: now => {
        if (now < next) return
        next = now + CHARACTER_SCAN_MS
        refresh()
      },
      dispose: () => {
        gone = true
        if (!this.disposed) {
          this.crowd.untrack(view as CrowdView)
          for (const m of added) this.world.render.removeCharacter(m)
        }
        added = []
      },
    }
  }

  /**
   * Per frame, after the world and the features updated: the Classic characters' lights, then the watchdog
   * (`frameMs` of this frame; `watch` false while loading, hidden or not yet entered).
   */
  frame(frameMs: number, watch: boolean): void {
    if (this.disposed) return
    // G1 rescue: the crowd budget (its plan every 250 ms, the blobs every frame).
    this.crowd.update()
    // Wave 11: a town part the world made outside apply() is wired on its first frame.
    this.wireTown()
    this.characterLights()
    const now = this.now()
    const compiled = this.compiled
    this.compiled = false
    if (!watch || !this.effective.modern) {
      this.watchdog.reset(now)
      return
    }
    // V-12: the watchdog asks for the GPU frame time before a drop (a capped display is not slowness)
    if (this.watchdog.wantsGpu && !this.instrumentation) this.gpuMs(true)
    if (this.watchdog.sample(frameMs, now, compiled || !!this.world.stream?.busy, this.cost)) this.slow()
  }

  private characterLights(): void {
    if (this.path === 'pbr') return
    const { hemi, sun } = this.o.lights
    const e = this.effective
    const w = this.world
    const boost = this.o.remasterBoost?.() ?? null
    let sunI: number = CHARACTER_LIGHTS.sun
    let hemiI: number = CHARACTER_LIGHTS.hemi
    // The classic sky carries no weather in its state: the Classic multipliers (WEATHER §7.1) scale the base instead.
    if (e.weatherShown && w.skyStyle === 'classic') ({ sun: sunI, hemi: hemiI } = characterLightIntensities(w.weatherState))
    if (boost) {
      sunI *= boost.key
      hemiI *= boost.fill
    }
    if (e.modern) {
      applySkyToLights(w.skyState, { hemi, sun }, { hemiIntensity: hemiI, sunIntensity: sunI })
      this.skyLit = true
      return
    }
    if (this.skyLit) this.restoreLights()
    sun.intensity = sunI
    hemi.intensity = hemiI
  }

  /** The characters' lights as buildWorldScene made them (direction and colours; the intensities are set per frame). */
  private restoreLights(): void {
    const { hemi, sun } = this.o.lights
    const b = this.base
    sun.direction.set(b.sunDir[0], b.sunDir[1], b.sunDir[2])
    sun.diffuse.set(b.sun[0], b.sun[1], b.sun[2])
    hemi.diffuse.set(b.hemi[0], b.hemi[1], b.hemi[2])
    hemi.groundColor.set(b.ground[0], b.ground[1], b.ground[2])
    this.skyLit = false
  }

  /** The watchdog tripped: one preset down (never below WATCHDOG_FLOOR), once per preset and visit, and a chat line. */
  private slow(): void {
    const s = this.store.get()
    const from = s.graphics.preset
    const to = lowerPreset(from, WATCHDOG_FLOOR)
    if (!to || this.dropped.has(from)) return
    this.dropped.add(from)
    this.store.set({ graphics: { preset: to } })
    this.o.say?.(t('render.watchdog', { preset: presetLabel(to, this.store.get(), this.rollout) }))
  }

  /** The GPU frame time can be measured here (an engine, and timestamp-query). */
  private gpuMeasurable(): boolean {
    return !!this.o.engine && !!this.world.render.gpu.features?.includes('timestamp-query')
  }

  /** GPU frame time in ms (null: not measured). `on` starts or stops the measuring (the perf overlay's visibility). */
  gpuMs(on: boolean): number | null {
    const engine = this.o.engine
    // the watchdog's GPU probe keeps it on while the perf overlay is hidden (V-12)
    if (!(on || this.watchdog.wantsGpu) || !this.gpuMeasurable()) {
      if (this.instrumentation) {
        this.instrumentation.dispose()
        this.instrumentation = null
      }
      return null
    }
    if (!this.instrumentation) {
      try {
        this.instrumentation = new EngineInstrumentation(engine!)
        this.instrumentation.captureGPUFrameTime = true
      } catch {
        return null
      }
    }
    const ns = this.instrumentation.gpuFrameTimeCounter.lastSecAverage
    return ns > 0 ? ns / 1e6 : null
  }

  /** The perf overlay's wave-9 line (hud/perf-overlay.ts PerfSample). */
  perf(gpuOn: boolean): { render: { mode: RenderPath; preset: string }; gpuMs: number | null; weather: { level: string; rain: number; wet: number } | null } {
    const w = this.world.weather.stats()
    const e = this.effective
    // The renderer's preset with the new look (it can be capped); without it, the player's (its non-render effects).
    const preset = presetLabel(e.modern ? e.renderPreset : e.preset, this.store.get(), this.rollout)
    return {
      render: { mode: this.path, preset },
      gpuMs: this.gpuMs(gpuOn),
      weather: { level: w.level, rain: w.rain, wet: w.wet },
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.off()
    this.crowd.dispose()
    if (this.compileObs) this.o.engine?.onAfterShaderCompilationObservable.remove(this.compileObs)
    setRenderScaleHandler(null)
    this.instrumentation?.dispose()
    this.instrumentation = null
    this.charMats.clear()
    this.raised.clear()
  }
}

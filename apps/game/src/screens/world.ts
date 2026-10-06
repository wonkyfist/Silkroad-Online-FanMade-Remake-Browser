/**
 * World: the real Jangan (terrain, buildings, water, sky and fog from @sro/world-render, heights and picks from its
 * navmeshes; a flat placeholder ground if the export is missing), every server entity (players, mobs, NPCs, ground
 * items) standing on the nav surfaces, click-to-move / click-to-attack / click-to-pick-up intents, combat
 * presentation (attack clips, damage overlays, damage numbers, deaths), level-up effects, death and respawn, chat,
 * the HUD (src/hud, fed from here) with the minimap, Esc menu and the MMO orbit camera. The server decides every
 * outcome, including where you spawn; the world only places you on the surface there.
 */
import {
  ArcRotateCamera,
  ArcRotateCameraPointersInput,
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  PointerEventTypes,
  Scene,
  SceneInstrumentation,
  Vector3,
  type AbstractMesh,
  type Observer,
  type PointerInfo,
} from '@babylonjs/core'
import { heightScale } from '@sro/appearance'
import {
  DEFAULT_HEIGHT,
  isStaff,
  type ClientMessage,
  type CombatHit,
  type EntityState,
  type PlayerStats,
  type Role,
  type ServerMessage,
} from '@sro/shared'
import type { App, OwnedScene, Screen, ScreenParams } from '../app.ts'
import { gm, isGmWindowCommand } from '../gm/commands.ts'
import { GmWindow } from '../gm/window.ts'
import { actionFailText, createHud, type DamageKind, type Hud } from '../hud/index.ts'
import { worldUniqueNotice } from '../hud/unique-notice.ts'
import { helpHint } from '../hud/keyhelp.ts'
import { menuItems, type MenuContext } from '../hud/menu-items.ts'
import { PerfOverlay } from '../hud/perf-overlay.ts'
import { spGained, spGainedText } from '../hud/player.ts'
import { cursorFor } from '../hud/target.ts'
import { t } from '../i18n/index.ts'
import { deviceHintOf, effectiveGraphics, runFirstRun, runReleaseMigration, settings } from '../settings.ts'
import { newScene } from '../three/backdrop.ts'
import { actorTexturesFor, type ActorTextures } from '../three/actor-textures.ts'
import { ModelLibrary } from '../three/models.ts'
import { FILL_WITH_ENV, KEY_LIGHT_BOOST, RemasterLighting } from '../three/remaster.ts'
import { toScreen } from '../three/project.ts'
import { anchor } from '../ui/chrome.ts'
import { el, Listeners, place } from '../ui/dom.ts'
import { setCursor } from '../ui/kit/cursor.ts'
import { ChatBox } from '../world/chat.ts'
import { nearestOnScreen } from '../world/screen-pick.ts'
import { DropAssets } from '../world/drops.ts'
import { ClickMarker, EffectList, TargetDecal, type GroundSampler, type RingTone } from '../world/effects.ts'
import { createEntityView, type EntityAttachment, type EntityAttachmentFactory, type EntityContext, type EntityView } from '../world/entities.ts'
import { WorldFeatures, type CombatMessage, type ControlledView, type WorldFeatureContext } from '../world/features.ts'
import { WorldGraphics, actorThreats, worldTown, worldTreesOption } from '../world/graphics.ts'
import { createFlatGround, type WorldGround } from '../world/ground.ts'
import { checkIntent, intents } from '../world/intents.ts'
import { CameraGround } from '../world/jangan/camera.ts'
import { loadJangan, urlQuality, type JanganGround } from '../world/jangan/ground.ts'
import { EntityHeights } from '../world/jangan/heights.ts'
import { HudMinimap, type MinimapEntity } from '../world/jangan/minimap.ts'
import { stageText } from '../world/jangan/strings.ts'
import { loadTownAreas, townAt, type TownArea } from '../world/jangan/zones.ts'
import { levelBand } from '../world/level-band.ts'
import { noteGroundMove, vetoGroundMove } from '../world/move-feedback.ts'
import { ensureWorldStyles } from '../world/style.ts'
import { LOADING_PICTURES, LoadingOverlay, ProgressSet } from './loading.ts'
import { describeError } from './login.ts'
import { GraphicsWarmup, type WarmupResult } from './warmup.ts'
import { watchArm, watchWorld } from '../gpu-watchdog.ts'

/**
 * `window.__sroWarmup` (console, LAB): the graphics warm-up behind the loading picture (screens/warmup.ts). `enabled`
 * false skips it (the A/B: entry and switches as before; `?warmup=0` in the page URL from the start); `last` is the
 * last run's result.
 */
export const warmupSwitch: { enabled: boolean; last: WarmupResult | null } = {
  enabled: !(typeof location !== 'undefined' && /[?&]warmup=0(&|$)/.test(location.search)),
  last: null,
}

/**
 * Kind of floating number for one hit (the HUD draws it). `victimArt`: hits on you keep their outcome
 * (`critTaken`, `missTaken`, `blockTaken`), so the retail red "Critical" / "miss" / "Block" art shows (hud/hitcount.ts).
 */
export function hitKind(hit: CombatHit, selfIsTarget: boolean, victimArt = false): DamageKind {
  if (hit.outcome === 'miss' || hit.outcome === 'block') return victimArt && selfIsTarget ? (hit.outcome === 'miss' ? 'missTaken' : 'blockTaken') : hit.outcome
  if (selfIsTarget) return victimArt && hit.outcome === 'crit' ? 'critTaken' : 'taken'
  return hit.outcome === 'crit' ? 'crit' : 'hit'
}

/** Own-HP rises at least this fraction of max HP show a heal number (potions; not regeneration ticks). */
const HEAL_NUMBER_MIN = 0.05
/** Same-target attack clicks closer than this are not re-sent (the server auto-attacks anyway). */
const ATTACK_RESEND_MS = 400

/** Placeholder look while there is no world (and for the flat fallback ground). */
function flatFog(scene: Scene): void {
  scene.clearColor = new Color4(0.62, 0.74, 0.88, 1)
  scene.fogMode = Scene.FOGMODE_EXP2
  scene.fogDensity = 0.004
  scene.fogColor = new Color3(0.62, 0.74, 0.88)
}

function buildWorldScene(app: App) {
  const scene = newScene(app.engine, new Color4(0.62, 0.74, 0.88, 1))
  flatFog(scene)
  // Only the screen's own picks (entity proxies, the navmesh) are used; skip Babylon's per-move scene pick.
  scene.skipPointerMovePicking = true
  // Character lights. The world has its own fixed-function sun for its objects (World.isolateLights).
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
  hemi.intensity = 0.7
  hemi.groundColor = new Color3(0.3, 0.28, 0.24)
  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.5).normalize(), scene)
  sun.intensity = 1.2
  const camera = new ArcRotateCamera('cam', -Math.PI / 2, 1.1, 9, Vector3.Zero(), scene)
  camera.minZ = 0.2
  camera.maxZ = 2000
  camera.fov = 0.85
  camera.lowerRadiusLimit = 2.5
  camera.upperRadiusLimit = 40
  camera.lowerBetaLimit = 0.25
  camera.upperBetaLimit = 1.5
  camera.wheelDeltaPercentage = 0.015
  camera.panningSensibility = 0
  camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput')
  const pointers = camera.inputs.attached.pointers as ArcRotateCameraPointersInput | undefined
  if (pointers) {
    pointers.buttons = [2] // right-drag rotates; left click is for moving
    pointers.angularSensibilityX = 500
    pointers.angularSensibilityY = 500
  }
  // Babylon 9 resolves camera drags through an input map whose default binds the RIGHT button to
  // "pan"; with panning disabled that made right-drag a no-op. Bind it to rotate (SRO-style camera).
  camera.movement.input.setInteraction('pointer', { button: 2 }, 'rotate')
  const canvas = app.engine.getRenderingCanvas()
  if (canvas) camera.attachControl(canvas, true)
  const library = new ModelLibrary(scene)
  const drops = new DropAssets(scene)
  return {
    kind: 'world',
    scene,
    camera,
    library,
    drops,
    lights: [hemi, sun],
    hemi,
    sun,
    dispose() {
      camera.detachControl()
      library.dispose()
      drops.dispose()
      scene.dispose()
    },
  } satisfies OwnedScene & Record<string, unknown>
}

/** Presentation timers on the frame clock (cleared with the scene, never outlive the screen). */
class Timeline {
  private now = 0
  private items: { at: number; fn: () => void }[] = []

  after(ms: number, fn: () => void): void {
    this.items.push({ at: this.now + Math.max(0, ms), fn })
  }

  tick(dtMs: number): void {
    this.now += dtMs
    if (!this.items.length) return
    const due = this.items.filter(i => i.at <= this.now)
    if (!due.length) return
    this.items = this.items.filter(i => i.at > this.now)
    due.sort((a, b) => a.at - b.at)
    for (const d of due) {
      try {
        d.fn()
      } catch (err) {
        console.error('[world] timeline', err)
      }
    }
  }

  get time(): number {
    return this.now
  }

  clear(): void {
    this.items = []
  }
}

export function worldScreen(app: App, params: ScreenParams['world']): Screen {
  const session = app.session
  if (!session) {
    void app.logout(t('app.notConnected'))
    return { dispose() {} }
  }
  ensureWorldStyles()
  const art = app.art
  const character = params.character
  const stage = app.useScene('world', () => buildWorldScene(app))
  const { scene, camera, library, drops, lights, hemi, sun } = stage
  // `window.__sroModels` (console, LAB): the actor library (actorCulling, liveActors), like `__sroNight`.
  if (typeof window !== 'undefined') (window as unknown as { __sroModels?: ModelLibrary }).__sroModels = library
  if (typeof window !== 'undefined') (window as unknown as { __sroWarmup?: typeof warmupSwitch }).__sroWarmup = warmupSwitch
  app.music.play(null)
  const instrumentation = new SceneInstrumentation(scene)

  /** Pickup requests waiting for their actionResult (FIFO; every `pickup` sent, clicks and autoloot alike). */
  const pickups: { cancelled: boolean; id: number }[] = []
  /** The item of the last accepted pickup (features: fx-world's PICK). */
  let acceptedPickup: number | null = null
  /** Sends an intent when online and valid (the shared validator is the gate). */
  const send = (msg: ClientMessage): boolean => {
    if (session.status !== 'online' || !checkIntent(msg)) return false
    session.send(msg)
    if (msg.t === 'pickup') pickups.push({ cancelled: false, id: msg.id })
    return true
  }

  // ---- DOM ------------------------------------------------------------------------------------
  const root = el('div', 'screen world')
  const labels = el('div', 'entity-labels')
  // FPS / ping / draws: hidden unless Options → Show FPS or Ctrl+Shift+F (UX_GAPS H1).
  const perf = new PerfOverlay()
  // Slash lines go to the server as chat (it runs them as GM commands); '/gm' only opens the GM window.
  const chat = new ChatBox(text => {
    if (gmWin && isGmWindowCommand(text)) gmWin.open()
    else {
      if (gmWin && text.startsWith('/')) gmWin.noteTyped(text)
      send(intents.chat(text))
    }
  })
  const gmHint = el('span', 'hud-help-gm', t('world.helpGm'))
  gmHint.hidden = true
  // "H: key help" for the first few visits (the keys themselves are in the key help window, UX_GAPS H2).
  const help = el('div', 'hud-help', helpHint(), gmHint)
  // Chat, minimap, perf and help are HUD: native px in the zoomed .world-ui layer; the entity labels (projected
  // screen px) stay outside it (docs/UI.md §3.2).
  const worldUi = el('div', 'world-ui')
  worldUi.append(perf.root, chat.root, help)
  root.append(labels, worldUi)
  app.ui.append(root)
  const hud: Hud = createHud(app, session, msg => void send(msg))

  const loadingPicture = art.hasCropped(LOADING_PICTURES.jangan.key) ? LOADING_PICTURES.jangan : LOADING_PICTURES.characters
  const loading = new LoadingOverlay(art, loadingPicture, app.overlay)
  loading.progress(0.03, t('world.entering'))

  // ---- state ----------------------------------------------------------------------------------
  const entities = new Map<number, EntityView>()
  /** Despawned corpses fading out. */
  const fading = new Set<EntityView>()
  const timeline = new Timeline()
  const effects = new EffectList()
  /** Decal ground heights: the surface nearest the decal centre (bridges, the plaza, stairs). */
  const decalGround: GroundSampler = (x, z, nearY) => ground?.heightAt(x, z, nearY) ?? nearY
  const ring = new TargetDecal(scene, decalGround)
  let selfId = -1
  let ground: WorldGround | null = null
  /** Real Jangan (null while loading, or when it failed and the flat fallback is used). */
  let jangan: JanganGround | null = null
  /** Wave 9 (GAME): the graphics link of the loaded world (world/graphics.ts; null while loading or on the fallback). */
  let graphics: WorldGraphics | null = null
  /** Removes the character-material decorator (set once the world loaded). */
  let offDecorator: (() => void) | null = null
  let heights: EntityHeights | null = null
  /** The scene's actor texture swaps while they run on the streamer's scheduler (W9F CPU-1). */
  let actorMaps: ActorTextures | null = null
  let minimap: HudMinimap | null = null
  let towns: TownArea[] = []
  let musicTrack = ''
  let musicT = 0
  const cameraGround = new CameraGround(camera)
  /** The lanes' world features (world/features.ts), created once the screen is wired (see "features" below). */
  let features: WorldFeatures | null = null
  /** Per-view attachment factories the features add (EntityContext.attachments). */
  const attachments: EntityAttachmentFactory[] = []
  // Wave 9 (GAME): every character's meshes go to the renderer (sun shadows on the PBR presets). Views made before the
  // world loaded pick the graphics link up on a later frame.
  attachments.push(view => {
    if (view.kind === 'item') return null
    let owner: WorldGraphics | null = null
    let inner: EntityAttachment | null = null
    const current = () => {
      if (graphics !== owner) {
        inner?.dispose()
        owner = graphics
        inner = graphics?.attachment(view) ?? null
        inner?.loaded?.()
      }
      return inner
    }
    return {
      loaded: () => current()?.loaded?.(),
      update: (now, dt) => current()?.update?.(now, dt),
      dispose: () => {
        inner?.dispose()
        inner = null
      },
    }
  })

  // ---- ground heights ---------------------------------------------------------------------------------
  /** Entity whose update() is running: its heightAt(x, z) calls resolve with its own surface. */
  let current: EntityView | null = null
  let yCache = new WeakMap<EntityView, { x: number; z: number; y: number }>()
  const entityY = (e: EntityView, x: number, z: number): number => {
    const c = yCache.get(e)
    if (c && c.x === x && c.z === z) return c.y
    const y = heights ? heights.heightOf(e.id, x, z, e.pos.y) : ground ? ground.heightAt(x, z, e.pos.y) : e.pos.y
    if (c) {
      c.x = x
      c.z = z
      c.y = y
    } else yCache.set(e, { x, z, y })
    return y
  }
  const selfGroundY = (): number => {
    const s = focusView()
    return s ? entityY(s, s.pos.x, s.pos.z) : camera.target.y
  }
  /**
   * EntityContext.heightAt: entities ask with their own position (update, labels, rings, effects), so the entity is
   * found by position and stands on its own surface; any other point takes the surface nearest the player's level.
   */
  const heightAt = (x: number, z: number): number => {
    if (current && current.pos.x === x && current.pos.z === z) return entityY(current, x, z)
    for (const v of entities.values()) if (v.pos.x === x && v.pos.z === z) return entityY(v, x, z)
    for (const v of fading) if (v.pos.x === x && v.pos.z === z) return entityY(v, x, z)
    return ground?.heightAt(x, z, selfGroundY()) ?? 0
  }
  let entered = false
  let disposed = false
  let leaving = false
  let menu: HTMLElement | null = null
  let role: Role = session.role
  let gmWin: GmWindow | null = null
  let playerStats: PlayerStats | null = null
  let target: EntityView | null = null
  let hovered: EntityView | null = null
  let lastAttack = { id: -1, at: -Infinity }
  let lastHitBy = ''
  /** The last hit on you had no attacker (lightning, docs/WEATHER.md §2.7): the death line names it. */
  let lastHitCause: string | null = null
  let deathShown = false
  /** Ground point under the mouse, for GM 'teleport here'. */
  let cursor: { x: number; z: number } | null = null
  const marker = new ClickMarker(scene, decalGround)

  const selfView = () => entities.get(selfId)
  /** Play the Boss (docs/PLAY_THE_BOSS.md §4.1): the entity the player steers instead of the own character. */
  let controlled: ControlledView | null = null
  /**
   * The view the camera, the ground streaming, the world update, the minimap and the music/town check follow: the
   * steered mob while piloting (once its view is here), else the own character. One function, so none is missed.
   */
  const focusView = () => (controlled ? entities.get(controlled.id) : undefined) ?? selfView()
  const selfLevel = () => playerStats?.level ?? selfView()?.state.level ?? character.level

  const ctx: EntityContext = {
    scene,
    library,
    catalog: app.catalog,
    labels,
    drops,
    heightAt,
    selfId: () => selfId,
    selfLevel,
    serverNow: () => session.clock.serverNow(),
    attachments,
  }

  const project = (view: EntityView) => {
    const tmp = new Vector3()
    return () => {
      if (view.isDisposed) return null
      const p = toScreen(scene, view.head(tmp))
      return p.visible ? { x: p.x, y: p.y } : null
    }
  }

  // Wave 9 (GAME): the release's one-time move of a saved blob (a pre-release Low save keeps its classic sky and weather
  // off), the first-run device check (rollout.ts decides whether it applies or only records), and what the world loads
  // with (settings.ts effectiveGraphics: without the new look, the Classic path, classic sky, weather off).
  const device = deviceHintOf(app.engine, app.engineKind)
  runReleaseMigration(settings)
  runFirstRun(settings, device)
  const startGraphics = effectiveGraphics(settings.get(), { gpu: device, preset: urlQuality() ?? settings.get().graphics.preset })

  // Remastered textures (test switch): sky environment cube and a stronger key light, only while it is on. Classic path
  // only (D15: each probe capture costs ~0.5 s once the world is PBR); graphics.onPath makes and drops it.
  const makeRemasterLight = () =>
    new RemasterLighting(scene, {
      key: lights[1]!,
      fill: lights[0]!,
      sky: () => (jangan ? [jangan.world.sky.mesh] : []),
      center: () => camera.target,
    })
  let remasterLight: RemasterLighting | null = startGraphics.render === 'classic' ? makeRemasterLight() : null

  // ---- the world ------------------------------------------------------------------------------------
  /** Loading-screen share of the world (the rest is the entities' models). */
  const WORLD_SHARE = 0.72
  let worldFraction = 0
  let entityFraction = 0
  let loadingText = t('world.entering')
  const showLoading = () => loading.progress(0.03 + 0.97 * (WORLD_SHARE * worldFraction + (1 - WORLD_SHARE) * entityFraction), loadingText)
  void loadTownAreas().then(a => {
    towns = a
  })

  // ---- graphics warm-up (PERF2, screens/warmup.ts) --------------------------------------------------------
  /** The warm-up running now (the watchdog does not judge meanwhile). */
  let warming: GraphicsWarmup | null = null
  /** Overlays of switch warm-ups still up (removed with the screen). */
  const warmOverlays = new Set<LoadingOverlay>()
  /** Streams and compiles what the world needs behind `overlay` (progress from `base` to 1); a newer run replaces it. */
  const warmUp = async (overlay: LoadingOverlay, base: number): Promise<void> => {
    const w = jangan?.world
    if (!w || !warmupSwitch.enabled || disposed) return
    warming?.cancel()
    const run = new GraphicsWarmup(
      {
        scene,
        engine: app.engine,
        camera,
        stream: w.stream ?? null,
        focus: () => {
          const s = selfView()
          return s ? { x: s.pos.x, z: s.pos.z } : null
        },
        // The ocean's coast field (SroOcean.loaded): its mesh is made the frame after, then warmed (HL-2).
        parts: (w.ocean as { loaded?: Promise<unknown> } | null)?.loaded ?? null,
      },
      { onProgress: f => overlay.progress(base + (1 - base) * f, t('render.warmup')) },
    )
    warming = run
    const r = await run.run()
    if (warming === run) warming = null
    warmupSwitch.last = r
    // The watchdog's grace starts again once the overlay is gone.
    graphics?.watchdog.reset(performance.now())
    watchArm()
  }
  /** A graphics switch that rebuilt the renderer: its own short loading overlay while the world catches up. */
  const switchWarmUp = async (): Promise<void> => {
    if (!warmupSwitch.enabled || disposed) return
    const overlay = new LoadingOverlay(art, loadingPicture, app.overlay)
    overlay.progress(0.02, t('render.warmup'))
    warmOverlays.add(overlay)
    try {
      await warmUp(overlay, 0)
    } finally {
      warmOverlays.delete(overlay)
      if (disposed) overlay.remove()
      else await overlay.finish()
    }
  }
  /** What a switch warms up for: the material path and the effective render and sky blocks. */
  const renderKey = (): string => {
    const g = graphics
    if (!g) return ''
    const e = g.effective
    return JSON.stringify([g.path, e.render, e.renderQuality, e.skyQuality])
  }
  let lastRenderKey = ''
  /** Runs after WorldGraphics' own settings listener (it registers first), so the switch has been applied. */
  let offWarmSettings: (() => void) | null = null
  /** Settles with the ground to use: Jangan, or the flat fallback (null) when the export cannot be loaded. */
  const worldReady: Promise<JanganGround | null> = loadJangan(scene, {
    // FLD-C: the server's export folder (welcome.server.world; streamed when it has a stream block) around our saved spot.
    world: session.server?.world ?? 'jangan',
    focus: { x: character.pos[0], z: character.pos[2] },
    render: startGraphics.render,
    sky: startGraphics.sky,
    weatherLevel: startGraphics.weather,
    // Wave 12 (W12-G): Options → Trees ('retail' on the Classic path: the Low guard).
    trees: worldTreesOption(startGraphics),
    onProgress: p => {
      worldFraction = p.fraction
      loadingText = stageText(p.stage, p.done, p.total)
      showLoading()
    },
  }).then(
    g => {
      if (disposed) {
        g.dispose()
        return null
      }
      jangan = g
      ground = g
      heights = new EntityHeights(g, g.world)
      heights.selfId = selfId
      yCache = new WeakMap()
      // The world's fixed-function sun lights its objects only; the character lights skip the objects.
      g.world.isolateLights(lights)
      remasterLight?.refresh()
      // Options graphics apply live (UX_GAPS R5; WAVE_PLAN decision 50 for the streamer). Wave 9: through the graphics
      // link (world/graphics.ts): the effective render/sky blocks, the material path, the character lights.
      graphics = new WorldGraphics({
        world: g.world,
        camera,
        lights: { hemi, sun },
        gpu: device,
        engine: app.engine,
        trees: worldTreesOption(startGraphics),
        remasterBoost: () => (remasterLight?.active ? { key: KEY_LIGHT_BOOST, fill: FILL_WITH_ENV } : null),
        onPath: path => {
          // D15: no ReflectionProbe on the PBR path; the remaster switch keeps working on Classic.
          if (path === 'pbr' && remasterLight) {
            remasterLight.dispose()
            remasterLight = null
          } else if (path === 'classic' && !remasterLight) {
            remasterLight = makeRemasterLight()
            remasterLight.refresh()
          }
        },
        say: text => chat.add('system', text),
        // Wave 10 (GRASS_LIFE §5.1): the wildlife flees the actors the client knows (World.life.setThreats).
        threats: actorThreats(() => entities.values()),
        // Wave 11 (TOWN_LIFE §2.3, WAVE_PLAN7 D9): World.town walks on the shared server clock (seconds) and steps
        // aside from the same threats; WorldGraphics hands both to every town part the world (re)builds.
        townClock: () => session.clock.serverNow() / 1000,
        // G1 rescue (world/crowd-budget.ts): the target keeps full quality; the pose-rate floors ride on the animation LOD.
        target: () => target,
        animLod: () => library.animLod,
      })
      // `window.__sroCrowd` (console, LAB): the crowd budget (enabled, castersOverride, stats()).
      if (typeof window !== 'undefined') (window as unknown as { __sroCrowd?: unknown }).__sroCrowd = graphics.crowd
      void g.world.objectsReady.then(() => !disposed && graphics?.apply())
      lastRenderKey = renderKey()
      offWarmSettings = settings.onChange(() => {
        const key = renderKey()
        if (key === lastRenderKey) return
        lastRenderKey = key
        if (entered && !disposed) void switchWarmUp()
      })
      // Character and equipment materials: RND-M's PBR decoration (before WX-C's actor wetness, which skips them).
      offDecorator = library.addMaterialDecorator(mat => graphics?.decorate(mat))
      // W9F CPU-1: actor map fetches and uploads go through the streamer's map scheduler (its limiter and frame budget,
      // at the lowest priority), not a second budget of their own (three/actor-textures.ts).
      if (g.world.stream) {
        actorMaps = actorTexturesFor(scene)
        actorMaps.useScheduler(g.world.stream.mapScheduler)
      }
      if (g.world.minimap) {
        minimap = new HudMinimap(g.world.minimap)
        worldUi.append(minimap.root)
      }
      const self = selfView()
      if (self) heights.placeSelf([self.pos.x, self.pos.y, self.pos.z])
      return g
    },
    err => {
      console.error('[world] Jangan failed to load', err)
      if (!disposed) chat.add('error', t('world.worldFailed', { error: describeError(err) }))
      return null
    },
  )

  // ---- targeting --------------------------------------------------------------------------------
  const targetInfo = (v: EntityView) => ({
    id: v.id,
    name: v.displayName(),
    level: v.state.level,
    hp: v.hp,
    maxHp: v.maxHp,
    kind: v.kind === 'item' || v.kind === 'cos' ? ('npc' as const) : v.kind,
    band: v.kind === 'mob' ? levelBand(v.state.level, selfLevel()) : undefined,
    variant: v.kind === 'mob' ? v.state.variant : undefined,
  })

  const clearTarget = () => {
    if (!target) return
    target = null
    ring.hide()
    hud.setTarget(null)
  }

  const setTarget = (v: EntityView) => {
    if (v.kind === 'item') return
    target = v
    const tone: RingTone = v.kind === 'mob' ? 'hostile' : v.kind === 'npc' ? 'neutral' : 'friendly'
    ring.show(tone, v.radius)
    hud.setTarget(targetInfo(v))
  }

  const syncTarget = (v: EntityView) => {
    if (target === v) hud.setTarget(targetInfo(v))
  }

  const setHovered = (v: EntityView | null) => {
    if (hovered === v) return
    hovered?.setHover(false)
    hovered = v
    v?.setHover(true)
    // UI-H: the retail cursors by what is under the pointer (attack / talk / pick-up / the flame hand).
    setCursor(cursorFor(v))
  }

  const cancelPickups = () => {
    for (const p of pickups) p.cancelled = true
  }

  // ---- entities ---------------------------------------------------------------------------------
  const addEntity = (state: EntityState, onProgress?: (f: number) => void): Promise<void> => {
    removeEntity(state.id, false)
    // A kind without a view (an extra kind no lane registered, docs/WAVE_PLAN2.md D8) is ignored.
    const view = createEntityView(state, ctx)
    if (!view) {
      onProgress?.(1)
      return Promise.resolve()
    }
    entities.set(state.id, view)
    features?.each(f => f.onEntityAdded?.(view))
    return view.load(onProgress)
  }

  const removeEntity = (id: number, fade: boolean) => {
    const v = entities.get(id)
    if (!v) return
    entities.delete(id)
    features?.each(f => f.onEntityRemoved?.(v))
    if (target === v) clearTarget()
    if (hovered === v) setHovered(null)
    if (fade && (v.dead || v.dying) && v.kind !== 'item') {
      if (v.dying) v.die()
      v.beginFade()
      fading.add(v)
    } else v.dispose()
  }

  const clearEntities = () => {
    for (const e of entities.values()) {
      features?.each(f => f.onEntityRemoved?.(e))
      e.dispose()
    }
    entities.clear()
    for (const e of fading) e.dispose()
    fading.clear()
    timeline.clear()
    clearTarget()
    setHovered(null)
  }

  const refreshTones = () => {
    for (const e of entities.values()) if (e.kind === 'mob') e.refreshLabel()
  }

  // ---- combat presentation --------------------------------------------------------------------
  const killView = (v: EntityView) => {
    v.die()
    if (target === v) clearTarget()
    if (v.id === selfId) onSelfDeath()
  }

  const onSelfDeath = () => {
    cancelPickups()
    clearTarget()
    if (deathShown) return
    deathShown = true
    chat.add('system', lastHitCause === 'lightning' ? t('world.diedLightning') : lastHitBy ? t('world.diedBy', { name: lastHitBy }) : t('world.died'))
    hud.showDeath(() => send(intents.respawn()))
  }

  const onSelfAlive = () => {
    if (!deathShown) return
    deathShown = false
    hud.hideDeath()
  }

  /** Shows hit `i` of a combat message: hurt clip, HP, damage number, and the death with the last hit of a kill. */
  const presentHit = (msg: CombatMessage, i: number) => {
    const hit = msg.hits[i]
    const v = entities.get(msg.target)
    if (!hit || !v) return
    if (hit.outcome === 'hit' || hit.outcome === 'crit') v.hurt()
    v.setHp(hit.hp)
    syncTarget(v)
    try {
      if (msg.attacker === selfId || msg.target === selfId) hud.damage(project(v), hit.damage, hitKind(hit, msg.target === selfId, true))
    } finally {
      // The death and the feature hooks run even if the number fails to show (a kill must never be lost).
      if (i === msg.hits.length - 1 && msg.killed) {
        killView(v)
        if (msg.attacker === selfId) chat.add('system', t('world.targetKilled', { name: v.displayName() }))
      }
      features?.each(f => f.onCombatHit?.(msg, i))
    }
  }

  const onCombat = (msg: CombatMessage) => {
    const attacker = entities.get(msg.attacker)
    const victim = entities.get(msg.target)
    if (msg.target === selfId && attacker) {
      lastHitBy = attacker.displayName()
      lastHitCause = null
    } else if (msg.target === selfId && msg.cause) lastHitCause = msg.cause
    if (msg.killed && victim) {
      victim.dying = true
      victim.pick.setEnabled(false)
    }
    // A feature may present the message itself (skill actions), calling presentHit at its own cues.
    if (features?.some(f => f.combat?.(msg))) return
    const delays = attacker && !attacker.dead ? attacker.attack(victim, msg.hits.length, timeline.time) : msg.hits.map((_, i) => i * 180)
    if (victim && attacker) victim.face(attacker.pos.x, attacker.pos.z)
    msg.hits.forEach((_, i) => timeline.after(delays[i] ?? 0, () => presentHit(msg, i)))
  }

  const onEntityUpdate = (msg: Extract<ServerMessage, { t: 'entityUpdate' }>) => {
    const e = entities.get(msg.id)
    if (!e) return
    const isSelf = msg.id === selfId
    const before = e.hp
    if (msg.level !== undefined) e.setLevel(msg.level)
    if (msg.name !== undefined) e.setName(msg.name)
    if (msg.invisible !== undefined) e.setInvisible(msg.invisible)
    if (msg.hp !== undefined || msg.maxHp !== undefined) e.setHp(msg.hp ?? e.hp, msg.maxHp)
    if (msg.state === 'dead') {
      // A killing blow in flight shows the death with its last hit (onCombat); otherwise now.
      if (!e.dying) killView(e)
    } else if (msg.state === 'alive' && (e.dead || e.dying)) {
      e.revive()
      if (isSelf) {
        onSelfAlive()
        chat.add('system', t('world.respawned'))
      }
    }
    if (isSelf) {
      if (msg.invisible !== undefined) gmWin?.noteSelf({ invisible: msg.invisible })
      const gained = e.hp - before
      if (msg.hp !== undefined && msg.level === undefined && msg.state === undefined && !e.dead && e.maxHp > 0 && gained >= e.maxHp * HEAL_NUMBER_MIN) {
        hud.damage(project(e), gained, 'heal')
      }
    }
    syncTarget(e)
  }

  // ---- GM window ------------------------------------------------------------------------------
  /** Shows the GM window and hint only to gm/admin accounts; follows live role changes. */
  const syncRole = (next: Role, announce: boolean) => {
    const was = isStaff(role)
    role = next
    const staff = isStaff(next)
    gmHint.hidden = !staff
    if (staff && !gmWin) {
      gmWin = new GmWindow(
        {
          art,
          parent: root,
          modalParent: app.ui,
          send: msg => send(msg),
          selfName: () => selfView()?.state.name ?? character.name,
          selfPos: () => {
            const e = selfView()
            return e ? { x: e.pos.x, z: e.pos.z } : null
          },
          cursorGround: () => cursor,
        },
        next,
      )
    } else if (!staff && gmWin) {
      gmWin.dispose()
      gmWin = null
    }
    gmWin?.setRole(next)
    if (announce && staff !== was) chat.add('system', staff ? t('gm.roleGranted', { role: next === 'admin' ? t('gm.role.admin') : t('gm.role.gm') }) : t('gm.roleRevoked'))
    if (announce && !staff) {
      // The server drops a revoked GM's invisibility and speed.
      selfView()?.setInvisible(false)
    }
  }
  syncRole(role, false)

  const onWorldEnter = async (msg: Extract<ServerMessage, { t: 'worldEnter' }>) => {
    session.clock.seed(msg.world.serverTime)
    selfId = msg.self.id
    if (heights) heights.selfId = selfId
    syncRole(msg.role ?? role, entered)
    clearEntities()
    pickups.length = 0
    acceptedPickup = null
    const first = !entered
    entered = true
    // The server decides where we are; the world only puts us on the surface there.
    const p = msg.self.pos
    heights?.placeSelf(p)
    camera.target.set(p[0], (ground?.heightAt(p[0], p[2], p[1]) ?? p[1]) + 1.5 * heightScale(msg.self.height ?? DEFAULT_HEIGHT), p[2])
    if (first) camera.alpha = Math.atan2(-Math.cos(msg.self.yaw), -Math.sin(msg.self.yaw))
    const players = t('world.loadingPlayers', { count: msg.entities.length + 1 })
    if (worldFraction >= 1) loadingText = players
    const set = new ProgressSet(f => {
      entityFraction = f
      if (worldFraction >= 1) loadingText = players
      showLoading()
    })
    const loads = [addEntity(msg.self, set.add()), ...msg.entities.map(e => addEntity(e, set.add()))]
    if (msg.self.state === 'dead') onSelfDeath()
    else onSelfAlive()
    const world = await worldReady
    if (disposed) return
    // FLD-C: a streamed world waits for the regions around where the server put us, then places us on them.
    if (first && world) await world.ready(p[0], p[2])
    if (disposed) return
    if (first && world?.world.stream) heights?.placeSelf(p)
    if (!world && !ground) {
      // No world export: the flat placeholder ground at the server's height.
      flatFog(scene)
      ground = createFlatGround(scene, p[0], p[1], p[2])
    }
    const self = selfView()
    if (self) ground?.follow(self.pos.x, self.pos.z)
    loadingText = players
    showLoading()
    await Promise.all(loads)
    if (disposed) return
    if (first) {
      // PERF2: the world's shaders compile and its render pipelines are made behind the loading picture.
      await warmUp(loading, 0.97)
      if (disposed) return
      await loading.finish()
      if (disposed) return
      // The black-output watchdog judges from here on (gpu-watchdog.ts; the sun says whether black is possible).
      watchWorld({ sunElevationDeg: () => jangan?.world.sky.state.sunElevationDeg ?? null })
      updateMusic(true)
      chat.add('system', t('world.welcome', { world: character.location || t('world.town'), name: msg.self.name }))
    } else watchArm()
  }

  /** jangan_town inside the town's safe area, jangan_field outside (checked about once a second). */
  const updateMusic = (force = false) => {
    const self = focusView()
    if (!self || !entered) return
    // 8 m of hysteresis so walking along the edge does not flip the track.
    const inTown = townAt(towns, self.pos.x, self.pos.z, musicTrack === 'jangan_town' ? 8 : -8) !== null || !towns.length
    const want = inTown ? 'jangan_town' : 'jangan_field'
    if (!force && want === musicTrack) return
    musicTrack = want
    app.music.play(art.musicUrl(want) ?? art.musicUrl('jangan_town'))
    features?.each(f => f.onTownChange?.(inTown))
  }

  const onMessage = (msg: ServerMessage) => {
    if (disposed) return
    switch (msg.t) {
      case 'worldEnter':
        void onWorldEnter(msg)
        break
      case 'spawn':
        if (entered) void addEntity(msg.entity)
        break
      case 'despawn':
        removeEntity(msg.id, true)
        break
      case 'move':
        // Our own walk is predicted on the navmesh along the server's move (it stops where the walk is blocked).
        entities.get(msg.id)?.setMove(msg.id === selfId && heights ? heights.selfMove(msg.move) : msg.move)
        break
      case 'stop':
        if (msg.id === selfId) heights?.selfStop(msg.pos)
        entities.get(msg.id)?.stop(msg.pos, msg.yaw)
        break
      case 'chat':
        chat.receive(msg, selfId, id => entities.get(id)?.state.name)
        break
      case 'warp': {
        const e = entities.get(msg.id)
        if (msg.id === selfId) heights?.placeSelf(msg.pos) // no retained surface after a warp (§5.2)
        e?.warp(msg.pos, msg.yaw)
        // The camera jumps with the focus (the own character, or the steered mob while piloting: the body's trance warp
        // does not pull the camera away from her).
        if (msg.id === (controlled?.id ?? selfId)) {
          ground?.follow(msg.pos[0], msg.pos[2])
          camera.target.set(msg.pos[0], heightAt(msg.pos[0], msg.pos[2]) + (e?.focusHeight ?? 1.5), msg.pos[2])
          marker.hide()
          if (target && Math.hypot(target.pos.x - msg.pos[0], target.pos.z - msg.pos[2]) > 60) clearTarget()
        }
        break
      }
      case 'entityUpdate':
        onEntityUpdate(msg)
        break
      case 'combat':
        onCombat(msg)
        break
      case 'levelUp': {
        const e = entities.get(msg.id)
        if (e) {
          e.setLevel(msg.level)
          // The level-up effect (SYSTEM_LEVELUP) is played by the fx-world feature (FX-C2).
        }
        if (msg.id === selfId) {
          hud.levelUp(msg.level)
          chat.add('system', t('world.levelUp', { level: msg.level }))
          refreshTones()
        }
        break
      }
      case 'stats': {
        const levelChanged = playerStats?.level !== msg.stats.level
        const spUp = spGained(playerStats?.sp, msg.stats.sp)
        if (spUp > 0) chat.add('system', spGainedText(spUp, msg.stats.sp))
        playerStats = msg.stats
        hud.setPlayer({ ...msg.stats, name: selfView()?.state.name ?? character.name })
        if (levelChanged) refreshTones()
        break
      }
      case 'statsDelta': {
        if (playerStats) {
          const spUp = msg.stats.sp === undefined ? 0 : spGained(playerStats.sp, msg.stats.sp)
          if (spUp > 0) chat.add('system', spGainedText(spUp, msg.stats.sp!))
          playerStats = { ...playerStats, ...msg.stats }
          hud.setPlayer({ ...playerStats, name: selfView()?.state.name ?? character.name })
        }
        // EXP/SP gains are shown by the HUD (EXP bar), which listens to statsDelta itself.
        break
      }
      case 'inventory':
        hud.setInventory(msg.inventory)
        break
      case 'inventoryUpdate':
        hud.applyInventoryUpdate(msg)
        break
      case 'appearance':
        void entities.get(msg.id)?.setEquip(msg.equip, msg.plus)
        break
      case 'actionResult':
        onActionResult(msg)
        break
      case 'notice':
        chat.add('notice', msg.from ? t('notice.chatFrom', { from: msg.from, text: msg.text }) : t('notice.chat', { text: msg.text }))
        break
      case 'uniqueNotice': {
        // Wave 11 (UNIQUES §3.3, WAVE_PLAN7 D9, D19): the chat line (the banner and the cue are app.ts'), and on an
        // appearance the town's 60 s alarm (cosmetic: walkers hurry indoors).
        worldUniqueNotice(msg, { chat, town: worldTown(jangan?.world), world: jangan?.world, nowS: session.clock.serverNow() / 1000 })
        break
      }
      case 'gmResult': {
        const echo = gmWin ? gmWin.onResult(msg) : true
        if (echo) chat.add(msg.ok ? 'gm' : 'error', t('gm.chatResult', { message: msg.message }))
        break
      }
      case 'role':
        syncRole(msg.role, true)
        break
      case 'worldLeft':
        if (!leaving) void app.go('charselect', { select: character.id })
        break
      case 'error':
        // enterWorld failures are handled by the request below.
        if (msg.re === 'chat' || msg.re === 'moveTo' || msg.re === 'gm') chat.add('error', msg.message)
        break
    }
    features?.each(f => f.onMessage?.(msg))
  }

  /** Results of the intents this screen sends; the HUD handles its own (item*, shop*, statUp, respawn). */
  const onActionResult = (msg: Extract<ServerMessage, { t: 'actionResult' }>) => {
    switch (msg.re) {
      case 'pickup': {
        // Success: the HUD announces what arrived (from inventoryUpdate). Failures of pickups we superseded
        // ourselves (clicked elsewhere meanwhile) stay quiet.
        const p = pickups.shift()
        if (msg.ok) acceptedPickup = p?.id ?? null
        else if (!p?.cancelled) hud.toast(actionFailText(msg.reason, msg.message), 'error')
        break
      }
      case 'attack':
      case 'stopAction':
        if (!msg.ok && msg.reason !== 'rate_limited') hud.toast(actionFailText(msg.reason, msg.message), 'error')
        break
    }
  }

  const ls = new Listeners()
  ls.add(session.on(onMessage))
  ls.add(
    session.onStatus(ev => {
      if (disposed) return
      if (ev.status === 'reconnecting') chat.add('system', t('world.lost'))
      if (ev.status === 'online' && ev.resumed) {
        chat.add('system', t('world.reconnected'))
        send(intents.enterWorld(character.id))
      }
    }),
  )

  // ---- menu -----------------------------------------------------------------------------------
  // UI-W: the Esc menu is the retail System window (hud/ux-shell.ts SystemWindow); `menu` is its root while open.
  const closeMenu = () => {
    if (!menu) return
    menu = null
    hud.systemWindow.close()
  }
  hud.systemWindow.onClose = () => {
    menu = null
  }
  const returnToSelect = async () => {
    closeMenu()
    leaving = true
    await session.request(intents.leaveWorld(), ['worldLeft'], 4000).catch(() => {})
    void app.go('charselect', { select: character.id })
  }
  const menuCtx: MenuContext = {
    app,
    close: closeMenu,
    characterSelect: () => void returnToSelect(),
    logout: () => {
      closeMenu()
      leaving = true
      void app.logout()
    },
  }
  /** The Esc menu: the entries of hud/menu-items.ts in order (built-ins: Character select, Log out, Back to game). */
  const openMenu = () => {
    if (menu) return closeMenu()
    hud.systemWindow.show(menuItems(), menuCtx)
    menu = hud.systemWindow.root
  }

  // F9 (GM window, staff only) and F8 (mock: drop the connection) are KeyMap bindings, listed in the key help.
  hud.keys.register({
    id: 'gm.window',
    keys: ['f9'],
    label: 'keys.gm.window',
    group: 'gm',
    when: () => !!gmWin,
    run: () => {
      if (!menu) gmWin?.toggle()
    },
  })
  hud.keys.register({
    id: 'debug.drop',
    keys: ['f8'],
    label: 'keys.debug.drop',
    group: 'debug',
    when: () => !!app.transport.dropConnection,
    run: () => {
      chat.add('system', t('world.mockDrop'))
      app.transport.dropConnection?.()
    },
  })
  ls.on(window, 'keydown', ev => {
    if (chat.typing) return
    const el = ev.target as HTMLElement | null
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
    if (ev.key === 'Enter') {
      ev.preventDefault()
      chat.focus()
    } else if (ev.key === 'Escape') {
      if (menu) closeMenu()
      else if (features?.some(f => f.escape?.())) return
      else if (target) clearTarget()
      else openMenu()
    }
  })
  const canvas = app.engine.getRenderingCanvas()
  if (canvas) ls.on(canvas, 'contextmenu', ev => ev.preventDefault())

  // ---- input: click to move / attack / pick up --------------------------------------------------
  const isProxy = (m: AbstractMesh) => {
    const id = (m.metadata as { entityId?: number } | null)?.entityId
    // Play the Boss: the steered mob is the pilot's own body (a click on her is a click on the ground behind her).
    if (id === undefined || !m.isEnabled() || id === controlled?.id) return false
    return entities.get(id)?.selectable ?? false
  }
  const entityAt = (px: number, py: number): EntityView | null => {
    const hit = scene.pick(px, py, isProxy)
    const id = (hit?.pickedMesh?.metadata as { entityId?: number } | null)?.entityId
    if (hit?.hit && id !== undefined) return entities.get(id) ?? null
    return entityNear(px, py)
  }
  const feetTmp = new Vector3()
  const headTmp = new Vector3()
  /**
   * The selectable entity whose on-screen body (feet to head) passes nearest the pointer, within PICK_SLACK_PX.
   * Zoomed out, a proxy is a few pixels wide and rarely lines up with the drawn model; this makes a click on the
   * figure (or just under its name) select it, as in SRO.
   */
  const entityNear = (px: number, py: number): EntityView | null =>
    nearestOnScreen(px, py, (function* () {
      for (const v of entities.values()) {
        if (!v.selectable || v.id === controlled?.id) continue
        const a = toScreen(scene, feetTmp.copyFrom(v.root.getAbsolutePosition()))
        if (!a.visible) continue
        const b = toScreen(scene, v.head(headTmp))
        yield { item: v, ax: a.x, ay: a.y, bx: b.x, by: b.y }
      }
    })())
  /** The walkable point under the cursor: plaza, stairs, bridges and terrain from the navmeshes (y = that surface). */
  const groundAt = (px: number, py: number): { x: number; y: number; z: number } | null => {
    const ray = scene.createPickingRay(px, py, null, camera)
    const nav = ground?.pick?.(ray)
    if (nav) return nav
    const hit = scene.pick(px, py, m => !!ground?.isGround(m))
    if (hit?.hit && hit.pickedPoint) return { x: hit.pickedPoint.x, y: hit.pickedPoint.y, z: hit.pickedPoint.z }
    // Off the ground: intersect the plane at the camera target's height.
    if (Math.abs(ray.direction.y) < 1e-6) return null
    const y = heightAt(camera.target.x, camera.target.z)
    const d = (y - ray.origin.y) / ray.direction.y
    if (d <= 0 || d > 2000) return null
    return { x: ray.origin.x + ray.direction.x * d, y, z: ray.origin.z + ray.direction.z * d }
  }
  const showMarker = (x: number, z: number, y = heightAt(x, z)) => {
    marker.show(x, y, z)
  }

  const clickEntity = (v: EntityView) => {
    if (features?.some(f => f.clickEntity?.(v))) return
    if (v.kind === 'item') {
      // Older pickups we supersede stay quiet when they fail; send() queues this one (autoloot's go there too).
      cancelPickups()
      if (send(intents.pickup(v.id))) showMarker(v.pos.x, v.pos.z)
      return
    }
    setTarget(v)
    if (v.kind !== 'mob' || selfView()?.dead) return
    const now = timeline.time
    if (lastAttack.id === v.id && now - lastAttack.at < ATTACK_RESEND_MS) return
    if (send(intents.attack(v.id))) {
      cancelPickups()
      lastAttack = { id: v.id, at: now }
    }
  }

  let hoverDirty = false
  let cursorDirty = false
  const pointerObs: Observer<PointerInfo> | null = scene.onPointerObservable.add(pi => {
    if (pi.type === PointerEventTypes.POINTERMOVE) {
      // The GM cursor pick runs once per frame at most (a navmesh ray march), not per mouse event.
      if (gmWin && entered) cursorDirty = true
      hoverDirty = true
      return
    }
    if (pi.type !== PointerEventTypes.POINTERDOWN || pi.event.button !== 0 || !entered || menu) return
    if (gmWin && (pi.event.ctrlKey || pi.event.metaKey)) {
      // GM: Ctrl + left click teleports to the clicked ground point.
      const p = groundAt(scene.pointerX, scene.pointerY)
      if (p) gmWin.run(gm.tpTo(p.x, p.z))
      return
    }
    if (chat.typing) chat.field.blur()
    const v = entityAt(scene.pointerX, scene.pointerY)
    if (v) return clickEntity(v)
    if (selfView()?.dead) return
    const p = groundAt(scene.pointerX, scene.pointerY)
    if (!p) return
    // WorldFeature.beforeGroundMove (docs/WAVE_PLAN2.md §4.3): a feature may consume the click (a stall owner's).
    if (features?.some(f => f.beforeGroundMove?.())) return
    if (send(intents.moveTo(p.x, p.z))) {
      cancelPickups()
      lastAttack = { id: -1, at: -Infinity }
      showMarker(p.x, p.z, p.y)
      noteGroundMove(p) // hold to move, blocked-path feedback (world/move-feedback.ts)
    }
  })

  // ---- per frame ------------------------------------------------------------------------------
  /** Minimap dots: everyone but us and the dead (iterated lazily, only when the minimap redraws). */
  function* minimapEntities(self: EntityView): Iterable<MinimapEntity> {
    for (const e of entities.values()) {
      if (e === self || e.dead || e.kind === 'cos') continue
      // Play the Boss: the pilot's minimap shows hunters only as the pilot feature's own markers.
      if (controlled?.onMinimap && !controlled.onMinimap(e)) continue
      // H11-CH-4: a unique gets its own sign (the label's test, world/entities.ts).
      const s = e.state
      const unique = s.kind === 'mob' && (s.variant === 'unique' || app.catalog.content.mobs.get(s.model)?.rarity === 'unique')
      yield unique ? { kind: e.kind, x: e.pos.x, z: e.pos.z, unique } : { kind: e.kind, x: e.pos.x, z: e.pos.z }
    }
  }
  const tmp = new Vector3()
  const want = new Vector3()
  let statT = 0
  // Draw calls per frame: the instrumentation resets the engine's counter before each render, so after the render it
  // holds that frame's draws (its lastSecAverage is never computed on WebGPU). Averaged over the stats interval.
  let drawSum = 0
  let drawFrames = 0
  let draws = 0
  const drawObs: Observer<Scene> | null = scene.onAfterRenderObservable.add(() => {
    drawSum += instrumentation.drawCallsCounter.current
    drawFrames++
  })
  const frameObs: Observer<Scene> | null = scene.onBeforeRenderObservable.add(() => {
    const dt = Math.min(0.1, app.engine.getDeltaTime() / 1000)
    timeline.tick(dt * 1000)
    const now = session.clock.serverNow()
    for (const e of entities.values()) {
      current = e
      e.update(now, dt)
    }
    for (const e of fading) {
      current = e
      const alive = e.update(now, dt)
      current = null
      if (!alive) {
        fading.delete(e)
        e.dispose()
      }
    }
    current = null
    effects.update(dt)
    if (hoverDirty && entered && !menu) {
      hoverDirty = false
      setHovered(entityAt(scene.pointerX, scene.pointerY))
    }
    if (cursorDirty && gmWin) {
      cursorDirty = false
      cursor = groundAt(scene.pointerX, scene.pointerY) ?? cursor
    }
    // Play the Boss: everything below follows the focus (the steered mob while piloting, else the own character).
    const self = focusView()
    if (self) {
      ground?.follow(self.pos.x, self.pos.z)
      const focusY = self !== selfView() && controlled?.focusHeight ? controlled.focusHeight(self) : self.focusHeight
      want.set(self.pos.x, entityY(self, self.pos.x, self.pos.z) + focusY, self.pos.z)
      Vector3.LerpToRef(camera.target, want, Math.min(1, dt * 10), tmp)
      camera.target.copyFrom(tmp)
    }
    if (ground) cameraGround.update(ground)
    const world = jangan?.world
    if (world) world.update(camera, self ? self.pos : undefined)
    if (minimap && self) minimap.update(dt, { x: self.pos.x, z: self.pos.z, yaw: self.yaw }, minimapEntities(self))
    musicT -= dt
    if (musicT <= 0) {
      musicT = 1
      if (musicTrack) updateMusic()
    }
    features?.each(f => f.onFrame?.(now, dt))
    // Wave 9: the Classic characters' lights from the sky (after the weather feature), and the frame-time watchdog.
    graphics?.frame(app.engine.getDeltaTime(), entered && !warming && !(typeof document !== 'undefined' && document.hidden))
    if (target) {
      if (target.isDisposed) clearTarget()
      else ring.update(dt, target.pos.x, heightAt(target.pos.x, target.pos.z), target.pos.z)
    }
    for (const e of entities.values()) e.updateLabel(scene, tmp, camera.target)
    for (const e of fading) e.updateLabel(scene, tmp, camera.target)
    marker.update(dt)
    statT -= dt
    if (statT <= 0) {
      statT = 0.5
      if (drawFrames > 0) draws = drawSum / drawFrames
      drawSum = 0
      drawFrames = 0
      if (perf.visible) {
        const rtt = session.clock.rtt
        let players = 0
        for (const e of entities.values()) if (e.kind === 'player') players++
        perf.update({ engine: app.engineKind, fps: app.engine.getFps(), ping: Number.isFinite(rtt) ? rtt : null, players, draws, mock: app.transport.mock, ...graphics?.perf(true) })
      } else graphics?.gpuMs(false)
    }
  })

  // ---- features (world/features.ts): the wave lanes' hooks, built once everything above exists ----------
  const featureCtx: WorldFeatureContext = {
    app,
    session,
    scene,
    hud,
    keys: hud.keys,
    chat,
    camera,
    send: msg => send(msg),
    selfId: () => (selfId >= 0 ? selfId : null),
    controlledId: () => controlled?.id ?? (selfId >= 0 ? selfId : null),
    setControlled: c => {
      controlled = c
    },
    view: id => entities.get(id),
    views: () => entities.values(),
    target: () => target,
    setTarget: v => (v ? setTarget(v) : clearTarget()),
    serverNow: () => session.clock.serverNow(),
    acceptedPickup: () => acceptedPickup,
    world: () => jangan,
    minimap: () => minimap,
    presentHit,
    addAttachment: factory => {
      attachments.push(factory)
      return () => {
        const i = attachments.indexOf(factory)
        if (i >= 0) attachments.splice(i, 1)
      }
    },
    addMaterialDecorator: fn => library.addMaterialDecorator(fn),
  }
  features = new WorldFeatures(featureCtx)
  // Hold-to-move asks the same veto before each re-send (world/move-feedback.ts).
  const offGroundVeto = vetoGroundMove(() => features?.some(f => f.beforeGroundMove?.()) ?? false)

  // ---- enter ----------------------------------------------------------------------------------
  session
    // onMessage handles the worldEnter itself; the request only surfaces failures.
    .request(intents.enterWorld(character.id), ['worldEnter'], 15000)
    .catch(err => {
      if (disposed) return
      loading.remove()
      app.toast(t('world.cannotEnter', { error: describeError(err) }), 'error')
      void app.go('charselect', { select: character.id })
    })

  return {
    dispose() {
      disposed = true
      ls.clear()
      warming?.cancel()
      warming = null
      offWarmSettings?.()
      offWarmSettings = null
      for (const o of warmOverlays) o.remove()
      warmOverlays.clear()
      offDecorator?.()
      offDecorator = null
      watchWorld(null)
      graphics?.dispose()
      graphics = null
      remasterLight?.dispose()
      remasterLight = null
      perf.dispose()
      scene.onPointerObservable.remove(pointerObs)
      scene.onBeforeRenderObservable.remove(frameObs)
      scene.onAfterRenderObservable.remove(drawObs)
      app.engine.getRenderingCanvas()?.classList.remove('hover-target')
      setCursor('normal')
      closeMenu()
      offGroundVeto()
      features?.dispose()
      features = null
      gmWin?.dispose()
      gmWin = null
      hud.dispose()
      chat.dispose()
      loading.remove()
      clearEntities()
      effects.dispose()
      ring.dispose()
      marker.dispose()
      minimap?.dispose()
      minimap = null
      instrumentation.dispose()
      // The streamer goes with the world: new actor map work goes back to the scene's own scheduler.
      actorMaps?.useScheduler(null)
      actorMaps = null
      ground?.dispose()
      ground = null
      jangan = null
      // W9F LEAK-1/3: nothing the page keeps (a stray closure, the console handles) may hold this visit's World.
      heights = null
      const w = typeof window === 'undefined' ? null : (window as unknown as { __sroModels?: ModelLibrary })
      if (w?.__sroModels === library) delete w.__sroModels
      if (w) delete (w as { __sroCrowd?: unknown }).__sroCrowd
      app.releaseScene()
    },
  }
}

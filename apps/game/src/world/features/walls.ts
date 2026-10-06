/**
 * Siege of Jangan on the client (docs/SIEGE.md §4.2, §9): Jangan's walls that break, and how they look and sound.
 *
 * - **Nav**: once the world is in, the export's `siege/walls.json` and the wall pieces (`siege/walls-nav.bin`) are
 *   added to the client's nav, the four retail wall instances switched off, and the stages applied with the server's own
 *   rule (packages/shared/src/siege.ts `WallNavState`): a downed third is switched off and its breach tiles forced
 *   open, so the walker's prediction goes through a gap exactly where the server lets it.
 * - **Looks** (layer 2; world/walls/look.ts → view.ts → dressing.ts): every segment's look from its stage, integrity,
 *   `scaffold` and `repairing` (layer 3): crack decals, piles of wall stone, scaffolding. A live `wallUpdate` that takes
 *   thirds down plays the collapse (falling stone, dust, bits) and shakes the camera within 150 m (Options → Camera
 *   shake); the enter-world `walls` snapshot places everything as it lies. `scaffold` comes only with `walls`; live,
 *   a rubble segment climbing back to breached sets it (look.ts `nextScaffold`), as the server does.
 * - **Sound** (walls/sound.ts): each `wallFx` plays its cues at its point (chip, crack, breach with the alarm bell,
 *   collapse), hammer strokes while a segment is repaired; 3D with each cue's own long roll-off.
 * - **Maps**: damaged and breached segments and the breach zones on the minimap and the world map (walls/map.ts).
 * - **Told**: a chat line when a wall is breached, collapses or closes again.
 * - Messages: `walls` (all segments, on enter and bulk changes), `wallUpdate` (one segment), `wallFx`. They may arrive
 *   before the export is loaded: the state is kept and applied when it is.
 * - Debug: `window.__sroWalls` (stages, looks, nav switches, view stats, sounds played).
 */
import { decodeNavData, navPiecePuts } from '@sro/nav'
import { WALL_DEFAULTS, WALL_SIDE_NAMES, WallNavState, checkWallsExport, wallOpen, type WallFxKind, type WallSide, type WallStage, type WallsExport } from '@sro/shared'
import { gameAudio } from '../../audio/index.ts'
import { pannerDistanceFor } from '../../audio/town.ts'
import { t } from '../../i18n/index.ts'
import { effectiveGraphics, settings } from '../../settings.ts'
import type { JanganGround } from '../jangan/ground.ts'
import { addWorldMapOverlay } from '../map/worldmap.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { COLLAPSE, nextScaffold, sameLook, wallLook, wallTierFor, type WallLook, type WallTier } from '../walls/look.ts'
import { wallMapShapes, type WallMapShape } from '../walls/map.ts'
import { WallAudio, type WallAudioHost } from '../walls/sound.ts'
import { WallsView } from '../walls/view.ts'

/** The export's walls, as features/walls.ts loads them. */
export interface LoadedWalls {
  walls: WallsExport
  navState: WallNavState
}

/**
 * Adds the wall pieces to a world's nav and switches the retail walls off (idempotent: the pieces are put by id).
 * Returns the nav state that applies the stages.
 */
export function installWallNav(nav: JanganGround['world']['nav'], walls: WallsExport, piecesBytes: Uint8Array): WallNavState {
  const pieces = decodeNavData(piecesBytes)
  const nw = nav.world
  nw.editInstances({ put: navPiecePuts(pieces) })
  const indexOf = new Map<number, number>()
  nw.data.instances.forEach((inst, i) => indexOf.set(inst.id >>> 0, i))
  for (const side of walls.sides) {
    const i = indexOf.get(side.retailInstance >>> 0)
    if (i !== undefined) nw.setInstanceEnabled(i, false)
  }
  return new WallNavState(walls, indexOf)
}

/** The camera shake of a collapse `d` metres away (0 beyond COLLAPSE.shakeM), stronger for a whole segment. */
export function collapseShake(d: number, thirds: number): number {
  const k = Math.max(0, 1 - d / COLLAPSE.shakeM)
  return COLLAPSE.shakeAmp * k * (thirds >= 2 ? 1.3 : 1)
}

export function wallsFeature(ctx: WorldFeatureContext): WorldFeature {
  if (!ctx.session) return {}
  const stages = new Map<string, WallStage>()
  const pcts = new Map<string, number>()
  const scaffold = new Map<string, boolean>()
  const repairing = new Map<string, boolean>()
  const looks = new Map<string, WallLook>()
  let shapes: WallMapShape[] = []
  let ground: JanganGround | null = null
  let loaded: LoadedWalls | null = null
  let view: WallsView | null = null
  let loading = false
  let failed = false
  let gen = 0
  let shakeLeft = 0
  let shakeAmp = 0
  let shaking = false
  let offMinimap: (() => void) | null = null

  const audioHost: WallAudioHost = {
    files: () => gameAudio()?.index?.files ?? null,
    listener: () => gameAudio()?.listenerPos ?? null,
    // past the voice policy's near cull (the bell's way, town-sound.ts): the gain carries the distance
    play: (file, o) => gameAudio()?.playFile(file, { pos: o.pos, gain: o.gain, bus: o.bus, kind: 'other', self: true, priority: 1 }),
    preload: (ids) => gameAudio()?.preloadFiles(ids),
    pannerDistanceFor,
    random: Math.random,
  }
  const audio = new WallAudio(audioHost)

  const tier = (): WallTier => {
    try {
      return wallTierFor(effectiveGraphics(settings.get(), { gpu: ground?.world.render.gpu ?? null }).renderPreset)
    } catch {
      return wallTierFor(settings.get().graphics.preset)
    }
  }

  /** Recomputes the looks; returns whether any changed. */
  const relook = (ids: Iterable<string>): boolean => {
    let changed = false
    for (const id of ids) {
      const stage = stages.get(id)
      if (!stage) continue
      const look = wallLook({ stage, pct: pcts.get(id) ?? 100, scaffold: scaffold.get(id), repairing: repairing.get(id) })
      if (sameLook(looks.get(id), look)) continue
      looks.set(id, look)
      changed = true
    }
    if (changed) {
      if (loaded) shapes = wallMapShapes(loaded.walls, looks, stages, WALL_DEFAULTS)
      hammers()
    }
    return changed
  }

  const midpoint = (id: string): { x: number; y: number; z: number } | null => {
    const seg = loaded?.walls.segments.find((s) => s.id === id)
    const side = seg && loaded!.walls.sides.find((s) => s.side === seg.side)
    if (!seg || !side) return null
    const along = (seg.from + seg.to) / 2
    const y = side.walkY * 0.6
    return side.axis === 'x' ? { x: along, y, z: side.line } : { x: side.line, y, z: along }
  }

  const hammers = () => {
    for (const [id, look] of looks) audio.setRepairing(id, look.hammer ? midpoint(id) : null)
  }

  const apply = (live: boolean) => {
    if (!loaded || !ground) return
    loaded.navState.apply(ground.world.nav.world, stages)
    view?.apply(looks, live)
  }

  const reset = () => {
    gen++
    view?.dispose()
    view = null
    loaded = null
    ground = null
    loading = false
    failed = false
    audio.clear()
  }

  const onFall = (x: number, _y: number, z: number, thirds: number) => {
    const c = ctx.camera.target
    const amp = collapseShake(Math.hypot(x - c.x, z - c.z), thirds)
    if (amp <= 0) return
    shakeAmp = Math.max(shakeAmp * (shakeLeft > 0 ? 1 : 0), amp)
    shakeLeft = COLLAPSE.shakeS
  }

  const load = async (g: JanganGround, my: number) => {
    try {
      const walls = await g.world.assets.json<WallsExport>('siege/walls.json')
      const problems = checkWallsExport(walls)
      if (problems.length) throw new Error(problems.slice(0, 3).join('; '))
      const bytes = await g.world.assets.bytesOf(walls.navFile)
      if (my !== gen) return
      loaded = { walls, navState: installWallNav(g.world.nav, walls, bytes) }
      relook(stages.keys())
      shapes = wallMapShapes(walls, looks, stages, WALL_DEFAULTS)
      hammers()
      apply(false)
      const v = new WallsView(ctx.scene, g.world, walls, { tier, onFall })
      view = v
      const ok = await v.load()
      if (my !== gen) return
      if (ok) {
        apply(false)
        audio.preload()
      }
    } catch (err) {
      // an export without the siege step (or the 3 x 3 'jangan'): the retail walls, unbreakable, as before
      if (my === gen) failed = true
      console.info('[walls] no destructible walls:', err instanceof Error ? err.message : err)
    }
  }

  const ensure = () => {
    const g = ctx.world()
    if (g !== ground) {
      if (ground) reset()
      ground = g
    }
    if (!offMinimap && loaded) {
      const mm = ctx.minimap?.()
      if (mm) offMinimap = mm.addMarkerSource(() => minimapShapes())
    }
    if (!ground || loading || loaded || failed) return
    loading = true
    void load(ground, gen)
  }

  /** The shapes as minimap markers (line width in `size`). */
  let mmShapes: WallMapShape[] | null = null
  let mmMarkers: { x: number; z: number; color: string; to?: { x: number; z: number }; size?: number; radius?: number }[] = []
  const minimapShapes = () => {
    if (mmShapes !== shapes) {
      mmShapes = shapes
      mmMarkers = shapes.map((s) => (s.to ? { x: s.x, z: s.z, to: s.to, color: s.color, size: s.width } : { x: s.x, z: s.z, color: s.color, radius: s.radius }))
    }
    return mmMarkers
  }
  const offWorldMap = addWorldMapOverlay(() => shapes)

  const say = (id: string, before: WallStage | undefined, after: WallStage) => {
    if (!before || before === after) return
    const vars = { side: WALL_SIDE_NAMES[id[0] as WallSide] ?? id[0]!, id }
    if (after === 'rubble') ctx.chat.add('system', t('wall.chat.collapse', vars))
    else if (after === 'breached' && !wallOpen(before)) ctx.chat.add('system', t('wall.chat.breach', vars))
    else if (!wallOpen(after) && wallOpen(before)) ctx.chat.add('system', t('wall.chat.closed', vars))
  }

  const shake = (dt: number) => {
    const on = shakeLeft > 0 && settings.get().controls.cameraShake
    if (on) {
      shakeLeft = Math.max(0, shakeLeft - dt)
      const k = shakeLeft / COLLAPSE.shakeS
      const s = performance.now() / 1000
      const a = shakeAmp * k
      ctx.camera.targetScreenOffset.set(Math.sin(s * 41) * a + Math.sin(s * 67) * a * 0.4, Math.cos(s * 31) * a * 0.7)
      shaking = true
    } else if (shaking) {
      ctx.camera.targetScreenOffset.set(0, 0)
      shaking = false
      shakeLeft = 0
    }
  }

  if (typeof window !== 'undefined') {
    ;(window as unknown as { __sroWalls?: unknown }).__sroWalls = {
      get stages() {
        return Object.fromEntries(stages)
      },
      get looks() {
        return Object.fromEntries(looks)
      },
      get nav() {
        return ground?.world.nav.world.runtimeSwitches ?? null
      },
      get view() {
        return view ? { active: view.active, ...view.stats } : null
      },
      get sounds() {
        return { ...audio.played, pending: audio.pendingCount, hammering: audio.hammering }
      },
      get shapes() {
        return shapes
      },
      tier,
      /** The scene (console inspection of the siege meshes: names start with `siege`). */
      get scene() {
        return ctx.scene
      },
      thirdsShown: (id: string) => view?.thirdsShown(id) ?? [],
      get loaded() {
        return !!loaded
      },
    }
  }

  return {
    onMessage(msg) {
      if (msg.t === 'walls') {
        for (const s of msg.segs) {
          stages.set(s.id, s.stage)
          pcts.set(s.id, s.pct)
          scaffold.set(s.id, !!s.scaffold)
          repairing.set(s.id, !!s.repairing)
        }
        relook(msg.segs.map((s) => s.id))
        apply(false)
      } else if (msg.t === 'wallUpdate') {
        const before = stages.get(msg.id)
        say(msg.id, before, msg.stage)
        scaffold.set(msg.id, nextScaffold(scaffold.get(msg.id) ?? false, before, msg.stage))
        repairing.set(msg.id, !!msg.repairing)
        stages.set(msg.id, msg.stage)
        pcts.set(msg.id, msg.pct)
        relook([msg.id])
        apply(true)
      } else if (msg.t === 'wallFx') {
        view?.fx(msg.kind, msg.id, msg.x, msg.y, msg.z)
        if (loaded) audio.moment(msg.kind as WallFxKind, msg.x, msg.y, msg.z)
      }
    },
    onFrame(_now, dt) {
      ensure()
      view?.update(dt)
      audio.update(dt)
      shake(dt)
    },
    dispose() {
      reset()
      offWorldMap()
      offMinimap?.()
      offMinimap = null
      if (shaking) ctx.camera.targetScreenOffset.set(0, 0)
      if (typeof window !== 'undefined') delete (window as unknown as { __sroWalls?: unknown }).__sroWalls
    },
  }
}

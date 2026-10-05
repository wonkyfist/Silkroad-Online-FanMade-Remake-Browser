/**
 * World feature of lane UX-B: world feel, chat and minimap (docs/UX_GAPS.md; WAVE_PLAN §4.14). Only that lane edits
 * this file. It wires:
 * - chat: `/w name text` / `/whisper` and `/r text` / `/re` / `/reply` (C2), EXP gains in chat when enabled (H13);
 * - the [GM] name tag from `EntityState.gm` and `entityUpdate.gm` (F3);
 * - name-tag de-cluttering (F1, world/nameplates.ts), run after the world screen has placed the labels;
 * - the minimap: SRO art, the world-map button, coordinates and the area name (M1, M2);
 * - auto looting on G (K3), hold to move and blocked-path feedback (K4, K5), camera keys (K6).
 * Wave 4 (UX-R): Z targets the nearest monster (K8), context cursors (K10), chat bubbles over heads (C8), camera
 * modes and the crit shake (K7, F11, in camera-keys.ts), the death camera (F10: pull back, only the killer's tag) and
 * the pickup fly-to-bag (F9, world/pickup-fly.ts).
 * The world screen's own hooks for this lane: targetInfo band/variant, chat.receive, noteGroundMove.
 * Wave 11 (docs/WAVE_PLAN7.md D11, W11-G): the town pick (`addTownPick`): a left click in the world reaches the
 * town's pick after the world screen's entity and item picks, and never consumes it (the player still walks to the
 * clicked ground: TOWN_LIFE §3.6, F9); over a townsperson the cursor is the NPC (speech) cursor.
 */
import { Color3, CreateDashedLines, CreateTorus, PointerEventTypes, StandardMaterial, Vector3, type LinesMesh, type Mesh, type Observer, type PointerInfo, type Scene } from '@babylonjs/core'
import { t } from '../../i18n/index.ts'
import { settings } from '../../settings.ts'
import { toScreen } from '../../three/project.ts'
import { AutoLoot, nextMobTarget } from '../autoloot.ts'
import { CameraKeys } from '../camera-keys.ts'
import type { ChatPrefixHandler } from '../chat.ts'
import { parseWhisper } from '../chat.ts'
import { displayEmissive } from '../display-tone.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeatureFactory } from '../features.ts'
import { intents } from '../intents.ts'
import type { HudMinimap } from '../jangan/minimap.ts'
import { loadTownAreas, townAt, type TownArea } from '../jangan/zones.ts'
import { zoneAt as mapZoneAt } from '../map/zones.ts'
import { MoveFeedback, onGroundMove, onKeyMove, type GroundPoint } from '../move-feedback.ts'
import { NameplateLayout } from '../nameplates.ts'
import { PICKUP_NEAR_M, PickupMatcher, flyIcon, type PickupFlight } from '../pickup-fly.ts'

/** Mobs that hit us stay "attacking me" (name-tag priority) this long. */
const ATTACKER_MS = 5000
const AREA_EVERY_S = 0.5
const BLOCKED_FX_S = 1.2
/** Chat bubbles (C8): how long the last line stays over the speaker, and its length cap. */
export const BUBBLE_MS = 5000
export const BUBBLE_MAX = 80
/** Death camera (F10): metres the camera pulls back after you die, and how fast (m/s). */
const DEATH_PULL_M = 6
const DEATH_PULL_RATE = 1.5

/** The text a chat bubble shows: one line, whitespace collapsed, capped with an ellipsis. */
export function bubbleText(text: string, max = BUBBLE_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one
}

/** Context cursor kind for a hovered entity (K10): attack, pick up, talk, or plain pointer. */
export function hoverCursor(v: { kind: string; isSelf?: boolean } | null): 'mob' | 'item' | 'npc' | 'player' | '' {
  if (!v) return ''
  if (v.kind === 'mob' || v.kind === 'item' || v.kind === 'npc') return v.kind
  return 'player'
}

/**
 * Wave 11 (TOWN_LIFE §3.6, WAVE_PLAN7 D11): the town's click and hover pick (world/features/town.ts, lane TL-C
 * registers one). Screen coordinates are the scene's pointer (scene.pointerX / pointerY).
 */
export interface TownPick {
  /**
   * A left click in the world that hit no entity or item: runs after the world screen's own click (its move intent is
   * already sent) and can never consume it. A townsperson there says a flavour line.
   */
  click(px: number, py: number): void
  /** The pointer is over a townsperson (the speech cursor); asked at most every TOWN_HOVER_S while no entity is hovered. */
  hover?(px: number, py: number): boolean
}

/** How often the town's hover pick is asked under a still pointer (the townsfolk walk under it), seconds. */
export const TOWN_HOVER_S = 0.25

const townPicks = new Set<TownPick>()

/** Registers the town's pick (TownPick); returns the remover. */
export function addTownPick(pick: TownPick): () => void {
  townPicks.add(pick)
  return () => {
    townPicks.delete(pick)
  }
}

/** The registered town picks (tests). */
export function townPickCount(): number {
  return townPicks.size
}

/** Asks every town pick for a click; never consumes it (a pick that throws is logged and the rest still run). */
export function runTownClick(px: number, py: number): void {
  for (const p of [...townPicks]) {
    try {
      p.click(px, py)
    } catch (err) {
      console.warn('[ux-world] town pick failed', err)
    }
  }
}

/** True when a town pick says the pointer is over a townsperson. */
export function runTownHover(px: number, py: number): boolean {
  for (const p of townPicks) {
    try {
      if (p.hover?.(px, py)) return true
    } catch (err) {
      console.warn('[ux-world] town hover failed', err)
    }
  }
  return false
}

/** FLD-C's zone lookup (world/map/zones.ts): a name, or {area?, name?}, or null while zones.json loads. */
type ZoneLookup = (x: number, z: number) => unknown

function zoneName(v: unknown): string | null {
  if (typeof v === 'string') return v || null
  if (v && typeof v === 'object') {
    const o = v as { area?: unknown; name?: unknown }
    if (typeof o.area === 'string' && o.area) return o.area
    if (typeof o.name === 'string' && o.name) return o.name
  }
  return null
}

/** The red "cannot get there" marker and the dashed line to where the walk stops (K5). */
class BlockedMarker {
  private readonly ring: Mesh
  private readonly mat: StandardMaterial
  private line: LinesMesh | null = null
  private left = 0

  constructor(private readonly scene: Scene) {
    this.ring = CreateTorus('blockedMarker', { diameter: 0.7, thickness: 0.06, tessellation: 32 }, scene)
    this.mat = new StandardMaterial('blockedMarkerMat', scene)
    displayEmissive(this.mat, new Color3(1, 0.25, 0.2)) // W9F R1: exposure-aware on the PBR presets
    this.mat.disableLighting = true
    this.ring.material = this.mat
    this.ring.isPickable = false
    this.ring.setEnabled(false)
  }

  show(want: GroundPoint & { y: number }, stop: GroundPoint & { y: number }): void {
    this.ring.position.set(want.x, want.y + 0.04, want.z)
    this.ring.setEnabled(true)
    this.line?.dispose()
    const d = Math.hypot(want.x - stop.x, want.z - stop.z)
    this.line = d > 0.5
      ? CreateDashedLines('blockedLine', { points: [new Vector3(stop.x, stop.y + 0.12, stop.z), new Vector3(want.x, want.y + 0.12, want.z)], dashSize: 2, gapSize: 1.5, dashNb: Math.max(2, Math.round(d * 1.5)) }, this.scene)
      : null
    if (this.line) {
      this.line.color = new Color3(1, 0.35, 0.3)
      this.line.isPickable = false
    }
    this.left = BLOCKED_FX_S
  }

  update(dt: number): void {
    if (this.left <= 0) return
    this.left -= dt
    const a = Math.max(0, Math.min(1, this.left / 0.4))
    this.mat.alpha = a
    if (this.line) this.line.alpha = a
    if (this.left <= 0) {
      this.ring.setEnabled(false)
      this.line?.dispose()
      this.line = null
    }
  }

  dispose(): void {
    this.line?.dispose()
    this.ring.dispose()
    this.mat.dispose()
  }
}

export const uxWorldFeature: WorldFeatureFactory = ctx => {
  const { chat, hud, scene, camera, keys } = ctx
  const offs: (() => void)[] = []
  const now = () => ctx.serverNow()
  // Play the Boss (docs/PLAY_THE_BOSS.md §4.1): the steered mob while piloting (the blocked-path check, the name tags'
  // focus, the camera keys, the area name follow her), else the own character.
  const selfView = (): EntityView | undefined => {
    const id = ctx.controlledId?.() ?? ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }
  const alivePos = (): GroundPoint | null => {
    const s = selfView()
    return s && !s.dead && !s.dying ? { x: s.pos.x, z: s.pos.z } : null
  }

  // ---- chat: whisper and reply (docs/UX_GAPS.md C2) ----------------------------------------------------
  const sendWhisper = (to: string, text: string) => {
    if (!ctx.send(intents.chat(text, to))) chat.add('error', t('app.notConnected'))
  }
  const whisper: ChatPrefixHandler = rest => {
    const w = parseWhisper(rest)
    if (w.ok) return sendWhisper(w.to, w.text)
    chat.add('error', w.error === 'bad_name' ? t('chat.whisperBadName', { name: rest.split(/\s+/)[0] ?? '' }) : t('chat.whisperUsage'))
  }
  const reply: ChatPrefixHandler = rest => {
    const to = chat.lastWhisperFrom
    if (!to) return chat.add('system', t('chat.noReply'))
    if (!rest) return chat.startWhisper(to)
    sendWhisper(to, rest)
  }
  for (const p of ['/w', '/whisper']) offs.push(chat.registerPrefix(p, whisper))
  for (const p of ['/r', '/re', '/reply']) offs.push(chat.registerPrefix(p, reply))

  // ---- [GM] tag (F3) -------------------------------------------------------------------------------
  const applyGm = (v: EntityView) => {
    if (v.kind !== 'player') return
    const on = v.state.gm === true
    v.setBadge('gm', on ? t('world.gmTag') : null)
    v.setLabelClass('gm', on)
  }

  // ---- name tags (F1) ------------------------------------------------------------------------------
  const plates = new NameplateLayout()
  const attackers = new Map<number, number>()
  const attackerIds = new Set<number>()
  /** Death camera (F10): while we lie dead, only our own tag and the killer's stay up. */
  let deadSelf = false
  let killer: number | null = null
  let deathPull = 0
  let deathRadius: number | null = null
  const showName = (v: EntityView): boolean => {
    if (deadSelf && !v.isSelf && v.id !== killer) return false
    const n = settings.get().ui.names
    if (v.kind === 'player') return v.isSelf || n.players
    if (v.kind === 'mob') return n.mobs
    if (v.kind === 'npc') return n.npcs
    return n.items !== 'hover'
  }
  let plateFailed = false
  // ---- context cursors (K10): the canvas carries data-hover=<kind>; ux-world-style.ts maps it to a cursor ----
  const canvas = ctx.app.engine.getRenderingCanvas()
  let cursorKind = ''
  const setCursor = (kind: string) => {
    if (kind === cursorKind || !canvas) return
    cursorKind = kind
    if (kind) canvas.dataset.hover = kind
    else delete canvas.dataset.hover
  }
  offs.push(() => setCursor(''))
  /** Wave 11: the entity under the pointer at the last frame (a click there is the entity's, not the town's). */
  let hoveredView: EntityView | null = null
  let townHover = false
  let townHoverT = 0
  let townHoverDirty = false
  // Added after the world screen's frame observer, so it runs once the labels have their positions for this frame.
  const plateObs: Observer<Scene> | null = scene.onBeforeRenderObservable.add(() => {
    try {
      let hovered: EntityView | null = null
      for (const v of ctx.views()) {
        if (v.label.classList.contains('hover')) {
          hovered = v
          break
        }
      }
      hoveredView = hovered
      // Wave 11: over a townsperson (no entity hovered) the speech cursor; the pick is asked when the pointer moved
      // or every TOWN_HOVER_S. No town pick registered: nothing is asked (today's cursor).
      if (hovered || !townPicks.size) townHover = false
      else {
        townHoverT -= scene.getEngine().getDeltaTime() / 1000
        if (townHoverDirty || townHoverT <= 0) {
          townHoverDirty = false
          townHoverT = TOWN_HOVER_S
          townHover = runTownHover(scene.pointerX, scene.pointerY)
        }
      }
      setCursor(hoverCursor(hovered) || (townHover ? 'npc' : ''))
      const self = selfView()
      const t0 = now()
      attackerIds.clear()
      for (const [id, until] of attackers) {
        if (until < t0) attackers.delete(id)
        else attackerIds.add(id)
      }
      plates.run(ctx.views(), {
        selfId: ctx.selfId(),
        target: ctx.target(),
        hovered,
        focus: self ? self.pos : camera.target,
        attackers: attackerIds,
        show: showName,
      })
    } catch (err) {
      if (!plateFailed) console.error('[ux-world] name tags', err)
      plateFailed = true
    }
  })
  offs.push(() => scene.onBeforeRenderObservable.remove(plateObs))

  // ---- minimap (M1, M2) ----------------------------------------------------------------------------
  let minimap: HudMinimap | null = null
  let towns: TownArea[] = []
  let inTown: TownArea | null = null
  let zoneAt: ZoneLookup | null = mapZoneAt
  let areaT = 0
  void loadTownAreas().then(a => {
    towns = a
    areaT = 0
  })
  const areaName = (x: number, z: number): string => {
    if (zoneAt) {
      try {
        const name = zoneName(zoneAt(x, z))
        if (name) return name
      } catch (err) {
        console.warn('[ux-world] zoneAt failed', err)
        zoneAt = null
      }
    }
    // Town or field, with 8 m of hysteresis like the music.
    inTown = townAt(towns, x, z, inTown ? 8 : -8)
    return inTown ? inTown.name : t('minimap.area.field')
  }
  const wireMinimap = (m: HudMinimap) => {
    minimap = m
    m.useArt(ctx.app.art)
    m.canOpenMap = () => !!hud.openWorldMap
    m.onMap = () => hud.openWorldMap?.()
    const origin = ctx.world()?.world.manifest.space?.originRegion
    if (origin) m.setOrigin({ x: origin.x, z: origin.z })
    areaT = 0
  }

  // ---- auto looting (K3) ---------------------------------------------------------------------------
  const loot = new AutoLoot<EntityView>({ send: m => ctx.send(m), views: () => ctx.views(), self: alivePos })
  offs.push(
    keys.register({
      id: 'loot.auto',
      keys: ['g'],
      label: 'keys.loot.auto',
      group: 'combat',
      repeat: true,
      run: () => loot.press(now()),
      up: () => loot.release(),
    }),
  )

  // ---- hold to move, blocked paths (K4, K5) --------------------------------------------------------
  const blockedFx = new BlockedMarker(scene)
  const groundY = (p: GroundPoint): number => {
    const g = ctx.world()
    const s = selfView()
    return g ? g.heightAt(p.x, p.z, s?.pos.y) : s?.pos.y ?? 0
  }
  const cursorGround = (): GroundPoint | null => {
    const g = ctx.world()
    if (!g) return null
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, null, camera)
    const nav = g.pick?.(ray)
    if (nav) return { x: nav.x, z: nav.z }
    const hit = scene.pick(scene.pointerX, scene.pointerY, m => g.isGround(m))
    return hit?.hit && hit.pickedPoint ? { x: hit.pickedPoint.x, z: hit.pickedPoint.z } : null
  }
  const move = new MoveFeedback({
    send: m => ctx.send(m),
    self: alivePos,
    cursorGround,
    holdToMove: () => settings.get().controls.holdToMove,
    warn: () => settings.get().controls.unreachableWarning,
    rtt: () => ctx.session.clock.rtt,
    blocked: (want, stop, message) => {
      blockedFx.show({ ...want, y: groundY(want) }, { ...stop, y: groundY(stop) })
      if (message) hud.toast(t('action.fail.unreachable'), 'error')
    },
  })
  offs.push(onGroundMove(p => move.begin(p, now())))
  // MV-WASD: the movement keys end a click walk (no hold re-send, no "cannot get there" for the abandoned click).
  offs.push(onKeyMove(() => move.cancel()))
  const release = () => move.end()
  window.addEventListener('pointerup', release)
  window.addEventListener('blur', release)
  offs.push(() => {
    window.removeEventListener('pointerup', release)
    window.removeEventListener('blur', release)
  })
  // Added after the world screen's pointer observer: a click in the world (anything but G) ends auto looting.
  // Wave 11 (D11): after the world screen's click (the entity and item picks, the move intent), the town pick; it
  // never consumes the click.
  const pointerObs: Observer<PointerInfo> | null = scene.onPointerObservable.add(pi => {
    if (pi.type === PointerEventTypes.POINTERDOWN && pi.event.button === 0) {
      loot.stop()
      if (townPicks.size && !hoveredView && !pi.event.ctrlKey && !pi.event.metaKey) runTownClick(scene.pointerX, scene.pointerY)
    } else if (pi.type === PointerEventTypes.POINTERUP && pi.event.button === 0) move.end()
    else if (pi.type === PointerEventTypes.POINTERMOVE) townHoverDirty = true
  })
  offs.push(() => scene.onPointerObservable.remove(pointerObs))

  // ---- camera keys (K6) ----------------------------------------------------------------------------
  const cameraKeys = new CameraKeys(camera, keys, () => selfView()?.yaw ?? null)
  offs.push(() => cameraKeys.dispose())

  // ---- nearest monster (K8): Z selects the nearest living monster, again for the next one; never attacks ----
  offs.push(
    keys.register({
      id: 'target.nearest',
      keys: ['z'],
      label: 'keys.target.nearest',
      group: 'combat',
      when: () => settings.get().controls.nearestTargetKey,
      run: () => {
        const self = alivePos()
        if (!self) return
        const cur = ctx.target()
        const next = nextMobTarget(ctx.views(), self, cur && cur.kind === 'mob' ? cur : null)
        if (next) ctx.setTarget(next)
        else hud.toast(t('world.noMobNear'))
      },
    }),
  )

  // ---- chat bubbles (C8): a speaker's last local line floats over their name tag for 5 s ------------------
  const bubbles = new Map<number, ReturnType<typeof setTimeout>>()
  const clearBubble = (id: number) => {
    const timer = bubbles.get(id)
    if (timer !== undefined) clearTimeout(timer)
    bubbles.delete(id)
    ctx.view(id)?.setBadge('bubble', null)
  }
  const showBubble = (id: number, text: string) => {
    const v = ctx.view(id)
    const line = bubbleText(text)
    if (!v || !line || v.kind !== 'player') return
    clearBubble(id)
    v.setBadge('bubble', line, 'chat-bubble')
    bubbles.set(id, setTimeout(() => clearBubble(id), BUBBLE_MS))
  }
  offs.push(() => {
    for (const id of [...bubbles.keys()]) clearBubble(id)
  })

  // ---- pickup feedback (F9): the picked item's icon flies to the inventory button ----------------------
  const pickups = new PickupMatcher()
  const flyTmp = new Vector3()
  const fly = (f: PickupFlight) => {
    try {
      const btn = hud.menubar.root.hidden ? null : hud.menubar.root.querySelector('[data-menu="inventory"]')
      const r = btn?.getBoundingClientRect()
      const to = r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth - 48, y: window.innerHeight - 40 }
      flyIcon(document.body, hud.items.icon(f.code), f.from, to)
    } catch (err) {
      console.warn('[ux-world] pickup feedback', err)
    }
  }

  // ---- death camera (F10) -------------------------------------------------------------------------
  const updateDeathCamera = (dt: number) => {
    const s = selfView()
    const dead = !!s && (s.dead || s.dying)
    if (dead !== deadSelf) {
      deadSelf = dead
      if (dead) {
        deathRadius = camera.radius
        deathPull = DEATH_PULL_M
      } else {
        // Back on your feet: the camera returns to where you had it; the killer is forgotten.
        if (deathRadius !== null) camera.radius = deathRadius
        deathRadius = null
        deathPull = 0
        killer = null
      }
    }
    if (deadSelf && deathPull > 0) {
      const step = Math.min(deathPull, DEATH_PULL_RATE * dt)
      deathPull -= step
      camera.radius = Math.min(camera.upperRadiusLimit ?? 40, camera.radius + step)
    }
  }

  return {
    onEntityAdded(v) {
      applyGm(v)
    },

    onEntityRemoved(v) {
      if (bubbles.has(v.id)) clearBubble(v.id)
      if (v.kind !== 'item') return
      const self = alivePos()
      if (!self || Math.hypot(v.pos.x - self.x, v.pos.z - self.z) > PICKUP_NEAR_M) return
      const p = toScreen(scene, v.head(flyTmp))
      const canvasRect = canvas?.getBoundingClientRect()
      if (!p.visible || !canvasRect) return
      const f = pickups.removedNear(v.state.model, { x: canvasRect.left + p.x, y: canvasRect.top + p.y }, performance.now())
      if (f) fly(f)
    },

    onMessage(msg) {
      const selfId = ctx.selfId()
      switch (msg.t) {
        case 'entityUpdate': {
          if (msg.gm === undefined) break
          const v = ctx.view(msg.id)
          if (!v) break
          if (msg.gm) v.state.gm = true
          else delete v.state.gm
          applyGm(v)
          break
        }
        case 'combat':
          if (msg.target === selfId && ctx.view(msg.attacker)?.kind === 'mob') attackers.set(msg.attacker, now() + ATTACKER_MS)
          if (msg.target === selfId && msg.killed) killer = msg.attacker
          break
        case 'chat':
          if ((msg.channel === 'local' || msg.channel === undefined) && msg.fromId !== undefined) showBubble(msg.fromId, msg.text)
          break
        case 'despawn':
          loot.onDespawn(msg.id, now())
          attackers.delete(msg.id)
          if (bubbles.has(msg.id)) clearBubble(msg.id)
          break
        case 'actionResult':
          if (msg.re === 'pickup') loot.onPickupResult(msg.ok)
          break
        case 'inventoryUpdate': {
          const codes: string[] = []
          for (const b of msg.bag ?? []) if (b.item) codes.push(b.item.code)
          for (const f of pickups.arrived(codes, msg.gold !== undefined, performance.now())) fly(f)
          break
        }
        case 'move':
          if (msg.id === (ctx.controlledId?.() ?? selfId)) move.onSelfMove(msg.move, now())
          break
        case 'warp':
          if (msg.id === selfId) {
            move.cancel()
            loot.stop()
            areaT = 0
          }
          break
        case 'levelUp':
        case 'stats': {
          // The target's band follows our level.
          const target = ctx.target()
          if (target && (msg.t === 'stats' || msg.id === selfId)) ctx.setTarget(target)
          break
        }
        case 'statsDelta': {
          const g = msg.gain
          if (g && (g.exp > 0 || g.spExp > 0) && settings.get().ui.expInChat) chat.add('system', t('chat.expGain', { exp: g.exp, sp: g.spExp }))
          break
        }
        case 'worldEnter':
          move.cancel()
          loot.stop()
          attackers.clear()
          break
      }
    },

    onCombatHit(msg, index) {
      // F11: a critical hit landing on us shakes the camera a little (Options → Controls).
      if (msg.target === ctx.selfId() && msg.hits[index]?.outcome === 'crit') cameraKeys.shake()
    },

    onFrame(t0, dt) {
      const m = ctx.minimap()
      if (m && m !== minimap) wireMinimap(m)
      loot.tick(t0)
      move.tick(t0)
      blockedFx.update(dt)
      cameraKeys.update(dt)
      updateDeathCamera(dt)
      areaT -= dt
      if (areaT <= 0 && minimap) {
        areaT = AREA_EVERY_S
        const s = selfView()
        if (s) minimap.setArea(areaName(s.pos.x, s.pos.z))
      }
    },

    dispose() {
      loot.stop()
      move.cancel()
      for (const off of offs.splice(0)) {
        try {
          off()
        } catch (err) {
          console.error('[ux-world] dispose', err)
        }
      }
      blockedFx.dispose()
    },
  }
}

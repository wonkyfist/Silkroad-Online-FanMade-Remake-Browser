/**
 * Character select: up to 4 characters standing in a row, click to select. Each wears its CharacterSummary.equip
 * (armour and weapon) at its Height and Volume.
 *
 * - **The stage** (docs/SCREENS.md §0B.2, §6.1; lane SCR-SEL): the row stands on the Jangan south-gate steps ("the
 *   palace steps"), through the world renderer: `app.stage.enter(STAGES.select)`. The character list and the models
 *   load beside the world (`preload`); the actors are placed and registered before the shader warm-up (`actors`). The
 *   slots are the stage's shallow arc (`stage.slots(n, selected)`); the camera never moves with n. The selected
 *   character steps toward the camera (0.4 s), plays POSE once, then STAND3; the others STAND1. Back from create the
 *   camera orbits round (`orbitMs`). Leaving keeps the stage: create reuses its World, and the next screen's scene
 *   (the world, the title backdrop) releases it.
 * - **The fallback** (§0B.4): when the stage cannot be built (no export, a load error), today's release screen: the
 *   `buildPlaza` scene with `StudioEnvironment`, the fixed SLOT_X row and the torus ring, with a console warning.
 *
 * Layout from Media/resinfo/pscharacterselect.txt: blackbar_up/blackbar_down, the caption (live text where the
 * text-characterselect art would be),
 * info window (228x140: GDR_STA_NAME 32,29; HP/MP gauges 46,50 / 46,62; level label 79,102 and value 126,102), 92x41
 * buttons, warning_delete dialog (344x192, buttons at 90,145 and 178,145). Rebuilt on the UI kit (docs/UI.md §4.7):
 * outer buttons and dialog from screens/outer-ui.ts, name plates on the tooltip frame, and the info window beside the
 * selected character (retail places it in code: its Info section has no rect), never over it, between the bars.
 */
import { CreateCylinder, PointerEventTypes, Vector3, type AbstractMesh, type Mesh, type Observer, type PointerInfo, type Scene, type TransformNode } from '@babylonjs/core'
import { MAX_CHARACTER_SLOTS, type CharacterSummary } from '@sro/shared'
import type { App, OwnedScene, Screen, ScreenParams } from '../app.ts'
import { heightScale } from '@sro/appearance'
import { weaponFamilyOf, weaponLabel } from '../content/catalog.ts'
import { recoveryToast, takeGpuRecovery } from '../gpu-loss.ts'
import { t } from '../i18n/index.ts'
import { STAGES, STAGE_ORBIT_MS } from '../stage/stages.ts'
import type { Stage } from '../stage/types.ts'
import { buildPlaza, selectionRing } from '../three/backdrop.ts'
import { licensedAvailable, licensedChoiceFor, licensedModel } from '../three/licensed-char.ts'
import { ModelLibrary, type BaseClip, type CharacterActor } from '../three/models.ts'
import { StudioEnvironment } from '../three/studio-env.ts'
import { toScreen } from '../three/project.ts'
import { bars, caption } from '../ui/chrome.ts'
import { el, input, Listeners, place } from '../ui/dom.ts'
import { rootScale } from '../ui/kit/index.ts'
import { LOADING_PICTURES, LoadingOverlay, ProgressSet } from './loading.ts'
import { describeError } from './login.ts'
import { creatorAvailable } from './creator.ts'
import { offersCreator } from './creator-model.ts'
import { framedTag, outerButton, outerDialog, setDisabled } from './outer-ui.ts'

const SLOT_X = [-2.4, -0.8, 0.8, 2.4]

/** The selected character's step toward the camera (SCREENS §6.1: a 0.4 s blend). */
const STEP_MS = 400

/**
 * The selected character's idle after POSE (SCREENS §6.1). Not a `BaseClip` name, but `clipFor` resolves it like one:
 * the weapon family's STAND3 variant, the plain STAND3, else STAND1. As a base it loops and comes back after POSE.
 */
const SELECTED_IDLE = 'STAND3' as BaseClip

interface Point {
  x: number
  y: number
  z: number
  yaw: number
}

interface Slot {
  character: CharacterSummary
  actor: CharacterActor | null
  /** Height choice scale of this character. */
  scale: number
  pick: Mesh | null
  tag: HTMLElement
  /** Where the actor stands now, and its step tween (from → to since t0). */
  at: Vector3
  from: Vector3
  to: Vector3
  t0: number
}

/** The 3D side of the screen: the stage, or the fallback plaza. */
interface View {
  readonly scene: Scene
  readonly library: ModelLibrary
  /** The standing points of n characters (the stage steps the selected one forward). */
  points(n: number, selected: number): Point[]
  add(root: TransformNode): void
  remove(root: TransformNode): void
  /** The actor is drawn (the stage hides one while it prepares it: P-STALL). */
  shown(root: TransformNode): boolean
  /** The selection changed (the fallback's ring). */
  selected(at: Vector3 | null): void
  frame(time: number): void
  dispose(): void
}

type ListReply = { characters: CharacterSummary[]; slots: number }

const ease = (f: number) => (f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2)

/** Screen px kept between the info window and the body, and from the screen edges and the bars. */
const INFO_GAP = 16
const INFO_EDGE = 8

/**
 * Where the info window goes (top-left, screen px) for the selected character: `head` = just above its head, `body` =
 * head-to-feet height on screen, `w`/`h` the window's size, `bar` the top and bottom bars' height. Right of the body,
 * else left of it, level with the upper body; when neither side fits (a narrow screen), above the head if that fits
 * under the top bar; else right of the body as far as the screen allows. Never under either bar.
 */
export function infoPlace(head: { x: number; y: number }, body: number, w: number, h: number, screenW: number, screenH: number, bar: number): { x: number; y: number } {
  const half = body * 0.2 + INFO_GAP
  const top = bar + INFO_EDGE / 2
  const bottom = screenH - bar - h - INFO_EDGE / 2
  const beside = Math.min(Math.max(head.y + body * 0.08, top), bottom)
  if (head.x + half + w <= screenW - INFO_EDGE) return { x: head.x + half, y: beside }
  if (head.x - half - w >= INFO_EDGE) return { x: head.x - half - w, y: beside }
  const above = head.y - INFO_GAP - h
  const centred = Math.min(Math.max(head.x - w / 2, INFO_EDGE), screenW - w - INFO_EDGE)
  if (above >= top) return { x: centred, y: above }
  return { x: Math.max(INFO_EDGE, screenW - w - INFO_EDGE), y: beside }
}

export function charSelectScreen(app: App, params: ScreenParams['charselect']): Screen {
  const session = app.session
  if (!session) {
    void app.logout(t('app.notConnected'))
    return { dispose() {} }
  }
  app.music.play(app.art.musicUrl('maintheme_cut'))
  const art = app.art

  // ---- DOM ------------------------------------------------------------------------------------
  const root = el('div', 'screen charselect')
  const tags = el('div', 'name-tags')
  const info = art.window('outer/info', 'char-info', 228, 140)
  const infoName = place(el('div', 'info-name kit-t-title'), [20, 28, 188, 15])
  const hp = place(art.image('outer/hp', 'gauge'), [46, 50, 136, 8])
  const mp = place(art.image('outer/mp', 'gauge'), [46, 62, 136, 8])
  const infoLine = place(el('div', 'info-line kit-t-value'), [20, 79, 188, 15])
  const infoLevelLabel = place(el('div', 'info-level-label', t('outer.select.levelLabel')), [60, 101, 55, 15])
  const infoLevel = place(el('div', 'info-level kit-t-level'), [126, 101, 60, 15])
  info.append(infoName, hp, mp, infoLine, infoLevelLabel, infoLevel)
  info.hidden = true

  const start = outerButton(art, t('select.start'), { primary: true })
  const create = outerButton(art, t('select.create'))
  const del = outerButton(art, t('select.delete'))
  const back = outerButton(art, t('select.back'))
  const buttonBar = el('div', 'bottom-buttons', start, create, del, back)
  const empty = el('div', 'charselect-empty', t('select.empty'))
  empty.hidden = true
  const account = el('div', 'account-line', t('select.account', { account: session.account || app.username, server: session.server?.name ?? '' }))
  root.append(...bars(art, 'outer/blackbar_up', 'outer/blackbar_down_notext'), caption(t('select.caption')), tags, info, empty, account, buttonBar)
  app.ui.append(root)

  const loading = new LoadingOverlay(art, LOADING_PICTURES.characters, app.overlay)

  let view: View | null = null
  let slots: Slot[] = []
  let selected = -1
  let busy = true
  let disposed = false
  let maxSlots = session.slots || MAX_CHARACTER_SLOTS
  const abort = new AbortController()

  const refreshButtons = () => {
    const has = selected >= 0 && !!slots[selected]
    setDisabled([start, del], busy || !has)
    setDisabled([create], busy || slots.length >= maxSlots)
    setDisabled([back], busy)
    empty.hidden = slots.length > 0 || busy
  }

  /** Every slot's goal for the current selection; `snap`: stand there at once (placement), else the step tween. */
  const placeAll = (snap: boolean) => {
    if (!view) return
    const pts = view.points(slots.length, selected)
    const now = performance.now()
    for (const [i, s] of slots.entries()) {
      const p = pts[i]
      if (!p) continue
      s.from.copyFrom(s.at)
      s.to.set(p.x, p.y, p.z)
      s.t0 = snap ? now - STEP_MS : now
      if (snap) s.at.copyFrom(s.to)
      s.actor?.setYaw(p.yaw)
    }
  }

  const select = (i: number) => {
    const prev = selected
    selected = i >= 0 && i < slots.length ? i : -1
    const slot = slots[selected]
    if (selected !== prev) {
      placeAll(false)
      for (const [j, s] of slots.entries()) {
        const a = s.actor
        if (!a) continue
        if (j === selected) {
          a.play(SELECTED_IDLE)
          a.playClip('POSE')
        } else a.play('STAND1')
      }
    }
    view?.selected(slot?.actor ? slot.to : null)
    for (const [j, s] of slots.entries()) {
      s.tag.classList.toggle('selected', j === selected)
    }
    info.hidden = !slot
    if (slot) {
      const c = slot.character
      infoName.textContent = c.name
      infoLine.textContent = t('select.infoLine', { weapon: weaponLabel(c.weapon), town: c.location || t('world.town') })
      infoLevel.textContent = String(c.level)
    }
    refreshButtons()
  }

  const clearSlots = () => {
    for (const s of slots) {
      if (s.actor) {
        view?.remove(s.actor.root)
        s.actor.dispose()
      }
      s.pick?.dispose()
      s.tag.remove()
    }
    slots = []
    selected = -1
  }

  /** The slots and their dressed models (loaded into `library`, not yet placed: hidden until `placeSlots`). */
  const makeSlots = async (characters: CharacterSummary[], library: ModelLibrary, progress?: (f: number) => void) => {
    clearSlots()
    const list = [...characters].slice(0, SLOT_X.length)
    const set = new ProgressSet(f => progress?.(f))
    const loads = list.map(async (character, i) => {
      const tag = framedTag(art, 'name-tag', el('span', 'n', character.name), el('span', 'l', t('select.tagLevel', { level: character.level })))
      tag.hidden = true
      tags.append(tag)
      const scale = heightScale(character.height)
      const slot: Slot = { character, actor: null, scale, pick: null, tag, at: new Vector3(), from: new Vector3(), to: new Vector3(), t0: 0 }
      slots[i] = slot
      const model = app.catalog.characterOrFallback(character.model)
      const tick = set.add()
      if (!model) return tick(1)
      try {
        const worn = character.equip?.weapon
        const family = (worn ? weaponFamilyOf(worn, app.catalog.item(worn)) : undefined) ?? character.weapon
        // the licensed body of its look (CHARACTERS §16.8) when the pack is served here, else the retail model
        const lic = licensedChoiceFor(location.search, model.gender, character.look, character.id)
        const licensed = lic && (await licensedAvailable(lic)) ? lic : null
        const actor = await library.character(licensed ? { code: model.code, ...licensedModel(licensed) } : model, {
          equip: character.equip,
          family,
          fallbackWeapon: app.catalog.weapon(family),
          height: character.height,
          ...(licensed ? { licensed: true, ...(character.look?.body === licensed.gender ? { charLook: character.look } : {}) } : { volume: character.volume }),
          plus: character.equipPlus,
        }, tick)
        if (disposed || slots[i] !== slot) return actor.dispose()
        actor.root.setEnabled(false)
        slot.actor = actor
      } catch (err) {
        console.error('[charselect] model failed', model.glb, err)
        tick(1)
      }
    })
    await Promise.all(loads)
  }

  /**
   * Stands the loaded actors in the row (nobody stepped), registers them with the view and adds their pick cylinders;
   * then selects `selectId` (else the most recently played): it steps forward and poses.
   */
  const placeSlots = (v: View, selectId?: number) => {
    selected = -1
    placeAll(true)
    for (const [i, s] of slots.entries()) {
      const actor = s.actor
      if (!actor) continue
      actor.root.position.copyFrom(s.at)
      actor.root.setEnabled(true)
      actor.play('STAND1')
      v.add(actor.root)
      const h = actor.height * s.scale
      const pick = CreateCylinder(`pick${i}`, { diameter: 0.9, height: h }, v.scene)
      pick.position.set(s.at.x, s.at.y + h / 2, s.at.z)
      pick.visibility = 0
      pick.metadata = { slot: i }
      s.pick = pick
    }
    const byId = slots.findIndex(s => s.character.id === selectId)
    const recent = slots.reduce((best, s, i) => (s.character.lastPlayed > (slots[best]?.character.lastPlayed ?? -1) ? i : best), 0)
    select(byId >= 0 ? byId : slots.length ? recent : -1)
  }

  // ---- 3D: the stage, else the fallback plaza ------------------------------------------------------

  const stageView = (stage: Stage): View => ({
    scene: stage.scene,
    library: stage.library,
    points: (n, sel) => stage.slots(n, sel),
    add: r => stage.addActor(r),
    remove: r => stage.removeActor(r),
    shown: r => stage.isShown(r),
    selected() {},
    frame() {},
    // The stage stays: create reuses its World; the world screen's or the title's scene releases it.
    dispose() {},
  })

  const plazaView = (): View => {
    const owned = app.useScene('charselect', () => {
      const plaza = buildPlaza(app.engine)
      // PBR metals need something to reflect (the characters' weapons): a studio cube on the new look only.
      new StudioEnvironment(plaza.scene, { hemi: plaza.hemi, key: plaza.key })
      const library = new ModelLibrary(plaza.scene)
      return {
        kind: 'charselect',
        scene: plaza.scene,
        plaza,
        library,
        dispose() {
          library.dispose()
          plaza.scene.dispose()
        },
      } satisfies OwnedScene & Record<string, unknown>
    })
    const { scene, camera, floorY } = owned.plaza
    camera.target.set(0, floorY + 1.05, 0)
    camera.radius = 7.2
    camera.fov = 0.7
    const ring = selectionRing(scene)
    ring.position.y = floorY + 0.02
    ring.setEnabled(false)
    return {
      scene,
      library: owned.library,
      points: n => Array.from({ length: n }, (_, i) => ({ x: SLOT_X[i] ?? 0, y: floorY, z: 0, yaw: 0 })),
      add() {},
      remove() {},
      shown: r => r.isEnabled(false),
      selected(at) {
        ring.setEnabled(!!at)
        if (at) ring.position.x = at.x
      },
      frame(time) {
        camera.alpha = Math.PI / 2 + Math.sin(time * 0.11) * 0.16
        camera.beta = 1.36 + Math.sin(time * 0.07) * 0.04
        ring.rotation.y = time * 0.6
      },
      dispose() {
        ring.dispose()
        // The next screen (world or create) builds its own scene.
        app.releaseScene()
      },
    }
  }

  const ls = new Listeners()
  let pointerObs: Observer<PointerInfo> | null = null
  let frameObs: Observer<Scene> | null = null
  let lastClick = 0
  const t0 = performance.now()
  const head = new Vector3()
  const foot = new Vector3()
  // --ui (the outer windows' scale) and the bars' height (both 172/1600 of the width), for keeping the info window on screen.
  let ui = rootScale()
  ls.on(window, 'resize', () => (ui = rootScale()))
  const topBar = () => Math.min((window.innerWidth * 172) / 1600, window.innerHeight * 0.16)

  /** The view's pointer pick and per-frame work (the step tween, the tags, the info window). */
  const attach = (v: View) => {
    view = v
    const scene = v.scene
    pointerObs = scene.onPointerObservable.add(pi => {
      if (pi.type !== PointerEventTypes.POINTERDOWN || pi.event.button !== 0) return
      const hit = scene.pick(scene.pointerX, scene.pointerY, (m: AbstractMesh) => typeof m.metadata?.slot === 'number')
      const i = hit?.pickedMesh?.metadata?.slot as number | undefined
      if (i === undefined) return
      const now = performance.now()
      if (i === selected && now - lastClick < 350) void startGame()
      lastClick = now
      select(i)
    })
    frameObs = scene.onBeforeRenderObservable.add(() => {
      const now = performance.now()
      v.frame((now - t0) / 1000)
      for (const [i, s] of slots.entries()) {
        const a = s.actor
        const f = ease(Math.min(1, Math.max(0, (now - s.t0) / STEP_MS)))
        Vector3.LerpToRef(s.from, s.to, f, s.at)
        if (a) a.root.position.copyFrom(s.at)
        s.pick?.position.set(s.at.x, s.pick.position.y, s.at.z)
        head.set(s.at.x, s.at.y + (a?.height ?? 1.8) * s.scale + 0.18, s.at.z)
        const p = toScreen(scene, head)
        s.tag.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%) scale(${ui})`
        s.tag.hidden = !p.visible || i === selected || !a || !v.shown(a.root)
        if (i === selected) {
          // Beside the character, never over it: right of the body, else left of it, level with the upper body; on a
          // screen too narrow for either, above the head when that fits under the top bar. Always between the bars.
          // (Anchored to the head it covered the face whenever the camera was close.)
          foot.set(s.at.x, s.at.y, s.at.z)
          const body = Math.max(40, toScreen(scene, foot).y - p.y)
          const at = infoPlace({ x: p.x, y: p.y }, body, 228 * ui, 140 * ui, window.innerWidth, window.innerHeight, topBar())
          info.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) scale(${ui})`
          // With its character: hidden while the stage prepares it (P-STALL).
          info.style.visibility = a && !v.shown(a.root) ? 'hidden' : ''
        }
      }
    })
  }

  const request = () => session.request({ t: 'charList' }, ['charList']) as Promise<ListReply>

  /** The first load: the stage with the list and the models beside the world; the fallback plaza if it fails. */
  const open = async () => {
    let listError: unknown = null
    // The list request starts now, beside the world stream (§0B.4 "in parallel, not after").
    const list = request()
    list.catch(() => {})
    const takeList = async (library: ModelLibrary) => {
      try {
        const reply = await list
        if (disposed) return
        maxSlots = reply.slots || maxSlots
        loading.progress(0.1, t('select.found', { count: reply.characters.length }))
        await makeSlots(reply.characters, library)
      } catch (err) {
        // Reported after the stage is up; a list error must not throw the stage away.
        listError = err
      }
    }
    try {
      const stage = await app.stage.enter(STAGES.select, {
        signal: abort.signal,
        orbitMs: STAGE_ORBIT_MS,
        onProgress: f => loading.progress(0.02 + 0.98 * f),
        preload: (_scene, library) => takeList(library),
        actors: async stage => {
          if (disposed) return
          const v = stageView(stage)
          attach(v)
          placeSlots(v, params?.select)
        },
      })
      if (disposed) return
      if (!view) {
        // enter resolved without running `actors` (cannot happen today): attach now.
        attach(stageView(stage))
        placeSlots(view!, params?.select)
      }
    } catch (err) {
      if (disposed || (err as Error)?.name === 'AbortError') return
      console.warn('[charselect] the stage could not be built; running the plaza fallback', err)
      detach()
      clearSlots()
      const v = plazaView()
      attach(v)
      if (!listError) await takeList(v.library)
      if (disposed) return
      placeSlots(v, params?.select)
    } finally {
      if (!disposed) {
        if (listError) app.toast(describeError(listError), 'error')
        busy = false
        refreshButtons()
        void loading.finish()
        // A reload after a graphics device loss whose token could not resume here (gpu-loss.ts): back into the world.
        const back = takeGpuRecovery()
        const i = back ? slots.findIndex(s => s.character.id === back.characterId) : -1
        if (i >= 0) {
          selected = i
          app.toast(t(back ? recoveryToast(back) : 'gpu.restored'), 'info', 8000)
          void startGame()
        }
      }
    }
  }

  /** A later load on the same view (after a delete, a resumed session): the list, then the models in its library. */
  const reload = async (selectId?: number) => {
    const v = view
    if (!v || busy) return
    busy = true
    refreshButtons()
    try {
      const reply = await request()
      if (disposed) return
      maxSlots = reply.slots || maxSlots
      loading.progress(0.1, t('select.found', { count: reply.characters.length }))
      await makeSlots(reply.characters, v.library, f => loading.progress(0.1 + 0.9 * f))
      if (disposed || view !== v) return
      placeSlots(v, selectId)
    } catch (err) {
      if (!disposed) app.toast(describeError(err), 'error')
    } finally {
      busy = false
      refreshButtons()
      void loading.finish()
    }
  }

  const detach = () => {
    const v = view
    if (!v) return
    v.scene.onPointerObservable.remove(pointerObs)
    v.scene.onBeforeRenderObservable.remove(frameObs)
    pointerObs = null
    frameObs = null
  }

  const startGame = async () => {
    const slot = slots[selected]
    if (!slot || busy) return
    busy = true
    refreshButtons()
    // §16.10: a character made before the creator is offered it once (customise now, or keep the look and play)
    if (slot.character.customise && offersCreator(slot.character, await creatorAvailable())) {
      if (disposed) return
      const character = slot.character
      let modal: HTMLElement | null = null
      const err = el('div', 'dialog-error')
      const close = () => {
        modal?.remove()
        busy = false
        refreshButtons()
      }
      const keepLook = async () => {
        try {
          const r = await session.request({ t: 'charLook', id: character.id }, ['charLookSet'])
          modal?.remove()
          void app.go('world', { character: r.character })
        } catch (e) {
          err.textContent = describeError(e)
        }
      }
      modal = outerDialog(art, {
        key: 'outer/warning_delete',
        w: 344,
        h: 192,
        title: t('creator.offerTitle'),
        titleRect: [16, 22, 312, 15],
        body: [el('p', '', t('creator.offerBody', { name: character.name })), err],
        bodyRect: [24, 46, 296, 92],
        buttons: [
          {
            label: t('creator.offerCustomise'),
            primary: true,
            onClick: () => {
              modal?.remove()
              void app.go('creator', { character })
            },
          },
          { label: t('creator.offerKeep'), onClick: () => void keepLook() },
        ],
        at: [
          [90, 145],
          [178, 145],
        ],
      })
      modal.addEventListener('keydown', ev => {
        ev.stopPropagation()
        if (ev.key === 'Escape') close()
      })
      app.ui.append(modal)
      modal.querySelector<HTMLButtonElement>('button.primary')?.focus()
      return
    }
    void app.go('world', { character: slot.character })
  }

  const confirmDelete = () => {
    const slot = slots[selected]
    if (!slot || busy) return
    const name = slot.character.name
    const field = input('field confirm-name', 'text', { maxlength: '12', placeholder: name, 'aria-label': t('select.deleteAria') })
    const err = el('div', 'dialog-error')
    let modal: HTMLElement | null = null
    const close = () => modal?.remove()
    const doDelete = async () => {
      if (field.value !== name) {
        err.textContent = t('select.deleteMismatch')
        return
      }
      busy = true
      refreshButtons()
      try {
        await session.request({ t: 'charDelete', id: slot.character.id }, ['charDeleted'])
        close()
        busy = false
        await reload()
      } catch (e) {
        busy = false
        refreshButtons()
        err.textContent = describeError(e)
      }
    }
    modal = outerDialog(art, {
      key: 'outer/warning_delete',
      w: 344,
      h: 192,
      title: t('select.deleteTitle', { name }),
      titleRect: [16, 22, 312, 15],
      body: [el('p', '', t('select.deleteBody')), field, err],
      bodyRect: [24, 46, 296, 92],
      buttons: [
        { label: t('select.deleteConfirm'), primary: true, onClick: () => void doDelete() },
        { label: t('select.deleteCancel'), onClick: close },
      ],
      at: [
        [90, 145],
        [178, 145],
      ],
    })
    modal.addEventListener('keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') void doDelete()
      if (ev.key === 'Escape') close()
    })
    app.ui.append(modal)
    field.focus()
  }

  ls.on(start, 'click', () => void startGame())
  // §16.10: the creator when the licensed files are served here, else the classic screen
  ls.on(create, 'click', () => void creatorAvailable().then(ok => app.go(ok ? 'creator' : 'charcreate')))
  ls.on(del, 'click', confirmDelete)
  ls.on(back, 'click', () => {
    app.setSession(null)
    void app.go('servers')
  })
  ls.on(window, 'keydown', ev => {
    if ((ev.target as HTMLElement)?.tagName === 'INPUT') return
    if (ev.key === 'Enter') void startGame()
    if (ev.key === 'ArrowRight' && slots.length) select((selected + 1) % slots.length)
    if (ev.key === 'ArrowLeft' && slots.length) select((selected - 1 + slots.length) % slots.length)
  })
  ls.add(
    session.onStatus(ev => {
      if (ev.status === 'online' && ev.resumed && !disposed) void reload(slots[selected]?.character.id)
    }),
  )

  refreshButtons()
  loading.progress(0.02, t('select.loading'))
  void open()

  return {
    dispose() {
      disposed = true
      // A stage load in progress stops and releases the stage (the next screen loads its own).
      abort.abort()
      ls.clear()
      detach()
      loading.remove()
      clearSlots()
      view?.dispose()
      view = null
    },
  }
}

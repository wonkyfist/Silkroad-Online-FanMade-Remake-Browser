/**
 * The character creator (docs/CHARACTERS.md §16.10) for the licensed Waterbender bodies: a turntable of the character
 * in the pack's underwear under soft studio light, and tabs for Body (gender, height, build), Face (the pack's makeup
 * maps), Eyes (iris), Hair (style, bangs, colour), Skin (tone, shift), Markings (the body paint) and Accessories
 * (earrings, hair flower, nails). The face shape never changes. A starter-clothes toggle shows the character as it will
 * walk out (the in-game body dressed in the starter garment: outfits from gear dress it when that lane is live).
 *
 * - **New** (`app.go('creator')`, from character select when the licensed files are served; else the classic screen
 *   charcreate.ts): name, weapon and the look → charCreate with `look`.
 * - **Edit** (`app.go('creator', { character })`): the one-time re-customise of a character made before the creator,
 *   pre-filled with its current look, its gender fixed; Done → charLook with the look, Keep my look → charLook without
 *   one; then into the world. Level, items and gold are untouched (the server only stores the look).
 *
 * The UI is the outer screens' (native px zoomed by --ui, the retail frames, tabs, sliders, the rotate window); it fits
 * 1280×720 at --ui 1 and shrinks below (`.creator` max-height rules in style.css). The state and every message are
 * creator-model.ts (tested); the drawing of a look is three/licensed-look.ts, the same code the world uses.
 * Debug / screenshots: `__sroCreator` (state, tab, zoom, set, clothes, gender).
 */
import { ArcRotateCamera, type AnimationGroup, Color3, Color4, CreateDisc, DirectionalLight, HemisphericLight, PBRMaterial, TransformNode, Vector3, type Observer, type Scene } from '@babylonjs/core'
import { heightScale, starterEquipment } from '@sro/appearance'
import {
  LOOK_ACCESSORIES,
  LOOK_HAIR_COLORS,
  LOOK_IRISES,
  LOOK_LIMITS,
  LOOK_MAKEUP_DEFAULT,
  LOOK_MAKEUPS,
  LOOK_PAINTS,
  LOOK_SKIN_TONES,
  lookBodyOf,
  lookSkinMultiplier,
  type CharLook,
  type CharacterSummary,
  type LookBody,
  type LookBuild,
} from '@sro/shared'
import type { App, OwnedScene, Screen, ScreenParams } from '../app.ts'
import { STARTER_WEAPONS, weaponLabel } from '../content/catalog.ts'
import { t, type StringKey } from '../i18n/index.ts'
import { newScene } from '../three/backdrop.ts'
import { licensedAvailable, licensedEnabled, licensedModel } from '../three/licensed-char.ts'
import { applyLicensedLook, lookIndex, lookUrls } from '../three/licensed-look.ts'
import { ModelLibrary, type CharacterActor } from '../three/models.ts'
import { StudioEnvironment } from '../three/studio-env.ts'
import { anchor, bars, caption } from '../ui/chrome.ts'
import { el, input, Listeners } from '../ui/dom.ts'
import { applyStates, button, Checkbox, Frame, iconButton, ScrollArea, Slider, TabBar } from '../ui/kit/index.ts'
import { CREATOR_TABS, BUILD_SLIDERS, FACE_TABS, createMessage, edit, editCreator, hairOf, lookMessage, nameProblem, newCreator, type CreatorState, type CreatorTab } from './creator-model.ts'
import { describeError } from './login.ts'
import { fitLabel, outerButton, SEX_PLATE } from './outer-ui.ts'

/** Whether the creator can run here: the licensed files and the look files are served (else the classic screen). */
export async function creatorAvailable(): Promise<boolean> {
  if (typeof location === 'undefined' || !licensedEnabled(location.search)) return false
  const [f, m, idx] = await Promise.all([licensedAvailable({ gender: 'f', outfit: 'base' }), licensedAvailable({ gender: 'm', outfit: 'base' }), lookIndex()])
  return f && m && !!idx
}

/** The studio: soft key from the camera side above, a fill, a warm rim, a dark backdrop and a floor disc. */
function buildStudio(app: App) {
  const scene = newScene(app.engine, new Color4(0.045, 0.04, 0.045, 1))
  const hemi = new HemisphericLight('creatorHemi', new Vector3(0, 1, 0.4), scene)
  hemi.intensity = 0.5
  hemi.diffuse = new Color3(1, 0.97, 0.94)
  hemi.groundColor = new Color3(0.28, 0.24, 0.22)
  // the camera sits on +Z: light travelling towards −Z falls on the face
  const key = new DirectionalLight('creatorKey', new Vector3(0.35, -0.42, -1).normalize(), scene)
  key.intensity = 1.6
  key.diffuse = new Color3(1, 0.96, 0.9)
  key.specular = new Color3(0.25, 0.24, 0.22)
  const fill = new DirectionalLight('creatorFill', new Vector3(-0.7, -0.08, -1).normalize(), scene)
  fill.intensity = 0.75
  fill.diffuse = new Color3(0.9, 0.93, 1)
  fill.specular = Color3.Black()
  const rim = new DirectionalLight('creatorRim', new Vector3(-0.2, -0.35, 1).normalize(), scene)
  rim.intensity = 0.9
  rim.diffuse = new Color3(1, 0.86, 0.7)
  new StudioEnvironment(scene, { hemi, key })
  const floor = CreateDisc('creatorFloor', { radius: 0.75, tessellation: 64 }, scene)
  floor.rotation.x = Math.PI / 2
  const fm = new PBRMaterial('creatorFloorMat', scene)
  fm.albedoColor = new Color3(0.035, 0.03, 0.028)
  fm.roughness = 0.85
  fm.metallic = 0
  floor.material = fm
  const turntable = new TransformNode('creatorTurntable', scene)
  const camera = new ArcRotateCamera('creatorCam', Math.PI / 2, Math.PI / 2 - 0.04, 4.6, new Vector3(0, 0.9, 0), scene)
  camera.minZ = 0.03
  camera.fov = 0.42
  scene.activeCamera = camera
  const library = new ModelLibrary(scene)
  return {
    kind: 'creator',
    scene,
    camera,
    turntable,
    library,
    dispose() {
      library.dispose()
      scene.dispose()
    },
  } satisfies OwnedScene & Record<string, unknown>
}

const genderOf = (b: LookBody) => (b === 'f' ? 'female' : 'male') as 'female' | 'male'
const linearToCss = ([r, g, b]: readonly number[]) => {
  const s = (c: number) => Math.round(255 * Math.min(1, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055))
  return `rgb(${s(r!)},${s(g!)},${s(b!)})`
}
/** The pack's skin (linear, mean of the cheek), for the tone swatches. */
const PACK_SKIN = [0.62, 0.42, 0.33] as const

export function creatorScreen(app: App, params: ScreenParams['creator']): Screen {
  const session = app.session
  if (!session) {
    void app.logout(t('app.notConnected'))
    return { dispose() {} }
  }
  const art = app.art
  const editing: CharacterSummary | undefined = params?.character
  const s: CreatorState = editing ? editCreator(editing, lookBodyOf(editing.model)) : newCreator('f')

  // ---- DOM ------------------------------------------------------------------------------------
  const root = el('div', `screen creator ${editing ? 'creator-edit' : 'creator-new'}`)
  // 352: the tab column (as wide as its longest label) + the 226-px content, nothing squeezed
  const panel = new Frame(art, 'main', { w: 352, h: 470, className: 'creator-panel' })
  const title = el('div', 'creator-panel-title kit-t-title', t(editing ? 'creator.captionEdit' : 'creator.captionNew'))
  const tabs = new TabBar<CreatorTab>(art, 'long', CREATOR_TABS.map(id => ({ id, label: t(`creator.tab.${id}`) })), { vertical: true, className: 'creator-tabs' })
  // one width for the whole column (the longest label's), so every label sits centred inside its tab
  const tabW = Math.max(...[...tabs.root.querySelectorAll<HTMLElement>('.kit-tab')].map(b => parseFloat(b.style.width) || 0))
  for (const b of tabs.root.querySelectorAll<HTMLElement>('.kit-tab')) b.style.width = `${tabW}px`
  const content = el('div', 'creator-content')
  panel.root.append(title)
  panel.body.append(tabs.root, content)

  const side = new Frame(art, 'main', { w: 238, h: editing ? 196 : 236, className: 'creator-side' })
  side.root.append(el('div', 'creator-panel-title kit-t-title', editing ? editing.name : t('creator.identity')))
  const status = el('div', 'creator-status')
  const clothes = new Checkbox(art, { label: t('creator.clothes') })
  const nameField = input('field creator-name', 'text', { maxlength: '12', 'aria-label': t('creator.name') })
  const weaponLabelEl = el('div', 'creator-value')
  const weaponPrev = iconButton(art, 'outer/arrow_left', { w: 20, h: 20, fallbackText: '<', className: 'arrow' })
  const weaponNext = iconButton(art, 'outer/arrow_right', { w: 20, h: 20, fallbackText: '>', className: 'arrow' })
  if (editing) side.body.append(el('p', 'creator-intro', t('creator.editIntro')), clothes.root, status)
  else
    side.body.append(
      el('div', 'creator-row', el('span', 'creator-label kit-t-label', t('creator.name')), nameField),
      el('div', 'creator-row', el('span', 'creator-label kit-t-label', t('creator.weapon')), weaponPrev, weaponLabelEl, weaponNext),
      clothes.root,
      status,
    )

  const rotate = art.window('outer/rotate_window', 'rotate-window creator-rotate', 152, 56)
  const rotL = iconButton(art, 'outer/rotate_left', { w: 42, h: 35, title: t('creator.rotateLeft'), fallbackText: '<' })
  const zoomB = iconButton(art, 'outer/zoomin', { w: 39, h: 35, title: t('creator.face'), fallbackText: '+' })
  const rotR = iconButton(art, 'outer/rotate_right', { w: 42, h: 35, title: t('creator.rotateRight'), fallbackText: '>' })
  for (const [b, x] of [[rotL, 12], [zoomB, 57], [rotR, 99]] as const) Object.assign(b.style, { position: 'absolute', left: `${x}px`, top: '11px' })
  rotate.append(rotL, zoomB, rotR)

  const primary = outerButton(art, t(editing ? 'creator.done' : 'creator.create'), { primary: true })
  const keep = outerButton(art, t('creator.keep'))
  const back = outerButton(art, t('creator.back'))
  const loadingNote = el('div', 'preview-note')
  root.append(
    ...bars(art, 'outer/redbar_up', 'outer/redbar_down'),
    caption(t(editing ? 'creator.captionEdit' : 'creator.captionNew')),
    anchor(panel.root, 0.165, 0.5),
    anchor(side.root, 0.86, 0.42),
    anchor(rotate, 0.5, 0.86),
    loadingNote,
    el('div', 'bottom-buttons', primary, ...(editing ? [keep] : []), back),
  )
  app.ui.append(root)

  // ---- 3D -------------------------------------------------------------------------------------
  const studio = app.useScene('creator', () => buildStudio(app))
  const { scene, camera, turntable, library } = studio
  let actor: CharacterActor | null = null
  /** The model the actor shows: underwear base or the in-game body in starter clothes. */
  let actorKey = ''
  let token = 0
  let disposed = false
  let busy = false
  let spin = 0
  let autoSpin = true
  /** Zoom 0 = full body .. 1 = face; the goal follows the tab unless the wheel moved it. */
  let zoom = 0
  let zoomGoal = 0
  let shownScale = heightScale(s.look.height)

  const modelCode = (): string | null => {
    if (editing) return editing.model
    return app.catalog.selectable(genderOf(s.look.body))[0]?.code ?? null
  }
  const modelKey = () => `${s.look.body}|${s.clothes ? s.look.outfit : 'base'}|${s.clothes ? s.weapon : ''}`

  const loadActor = async () => {
    const code = modelCode()
    if (!code) return
    const key = modelKey()
    if (key === actorKey && actor) return
    actorKey = key
    const my = ++token
    loadingNote.textContent = t('creator.loading')
    const g = genderOf(s.look.body)
    const src = s.clothes ? licensedModel({ gender: s.look.body, outfit: s.look.outfit }) : { glb: `${lookUrls.base(s.look.body)}.glb`, sidecar: `${lookUrls.base(s.look.body)}.json` }
    try {
      const next = await library.character(
        { code, ...src },
        {
          licensed: true,
          charLook: structuredClone(s.look),
          height: s.look.height,
          ...(s.clothes ? { equip: starterEquipment(g, 'clothes', s.weapon), family: s.weapon, fallbackWeapon: app.catalog.weapon(s.weapon) } : { equip: {} }),
        },
      )
      if (disposed || my !== token) return next.dispose()
      actor?.dispose()
      actor = next
      next.root.parent = turntable
      next.root.position.setAll(0)
      next.root.scaling.setAll(shownScale)
      next.play('STAND1')
      loadingNote.textContent = ''
      scheduleLook()
    } catch (err) {
      if (my === token) loadingNote.textContent = t('creator.failed', { error: describeError(err) })
    }
  }

  let lookQueued = false
  const scheduleLook = () => {
    if (lookQueued) return
    lookQueued = true
    requestAnimationFrame(() => {
      lookQueued = false
      if (!actor || actor.isDisposed) return
      void applyLicensedLook(actor, structuredClone(s.look), { decorate: m => library.decorateMaterial(m), builtInMakeup: LOOK_MAKEUP_DEFAULT[s.look.body] }).catch(err => console.warn('[creator] look failed', err))
    })
  }

  /** After an edit: the model (gender, clothes) or only the look. */
  const changed = (rebuild = false) => {
    if (modelKey() !== actorKey) void loadActor()
    else scheduleLook()
    if (rebuild) renderTab()
    weaponLabelEl.textContent = weaponLabel(s.weapon)
  }

  // ---- tabs -----------------------------------------------------------------------------------
  const ls = new Listeners()
  const tabLs = new Listeners()
  let scroll: ScrollArea | null = null
  const sliders: Slider[] = []

  const row = (label: string, ...kids: HTMLElement[]) => el('div', 'creator-row', el('span', 'creator-label kit-t-label', label), ...kids)
  const heading = (text: string) => el('div', 'creator-heading kit-t-label', text)
  const slider = (label: string, min: number, max: number, value: number, onInput: (v: number) => void, step = 1) => {
    const sl = new Slider(art, { min, max, step, value, w: 151, className: 'creator-slider' })
    sl.onInput = v => onInput(v)
    sl.onChange = v => onInput(v)
    sliders.push(sl)
    return row(label, sl.root)
  }
  /** A grid of picks: thumbnails or colour swatches; `cur` is highlighted. */
  const grid = <V,>(items: readonly { value: V; title: string; img?: string; color?: string; text?: string }[], cur: V, pick: (v: V) => void, cls = '') => {
    const g = el('div', `creator-grid ${cls}`)
    for (const it of items) {
      const b = el('button', `creator-pick ${it.value === cur ? 'on' : ''}`)
      b.title = it.title
      b.setAttribute('aria-label', it.title)
      if (it.img) b.style.backgroundImage = `url("${it.img}")`
      if (it.color) b.style.background = it.color
      if (it.text) b.textContent = it.text
      tabLs.on(b, 'click', () => {
        pick(it.value)
        for (const o of g.querySelectorAll('.creator-pick.on')) o.classList.remove('on')
        b.classList.add('on')
      })
      g.append(b)
    }
    return g
  }
  const scrolled = (h: number, ...kids: HTMLElement[]) => {
    scroll = new ScrollArea(art, { w: 226, h, className: 'creator-scroll' })
    scroll.view.append(...kids)
    return scroll.root
  }

  const sexButton = (body: LookBody) => {
    const on = s.look.body === body
    const key = body === 'm' ? (on ? 'outer/man_on' : 'outer/man_off') : on ? 'outer/woman_on' : 'outer/woman_off'
    const b = button(art, { label: '', skin: { key, w: SEX_PLATE.w, h: SEX_PLATE.h, slice: 0 }, width: SEX_PLATE.w, className: `sex-button sex-${body === 'm' ? 'male' : 'female'} ${on ? 'on' : ''}` })
    fitLabel(b.querySelector<HTMLElement>('.kit-btn-label')!, t(body === 'm' ? 'create.male' : 'create.female'), SEX_PLATE.textW - 2)
    applyStates(b, art, key)
    if (editing) b.setDisabled(!on)
    tabLs.on(b, 'click', () => {
      if (edit.gender(s, body)) {
        shownScale = heightScale(s.look.height)
        changed(true)
      }
    })
    return b
  }

  const renderTab = () => {
    tabLs.clear()
    scroll?.dispose()
    scroll = null
    sliders.length = 0
    content.replaceChildren()
    const L = s.look
    switch (s.tab) {
      case 'body': {
        content.append(
          row(t('creator.gender'), sexButton('m'), sexButton('f')),
          slider(t('creator.height'), 0, 4, L.height, v => edit.height(s, v)),
          heading(t('creator.build')),
          ...BUILD_SLIDERS.map(k => slider(t(`creator.build.${k}` as StringKey), 0, 100, L.build[k], v => edit.build(s, k as keyof LookBuild, v) && changed())),
        )
        const reset = button(art, { label: t('creator.reset'), skin: 'small' })
        tabLs.on(reset, 'click', () => edit.resetBuild(s) && changed(true))
        content.append(el('div', 'creator-row creator-row-end', reset))
        break
      }
      case 'face': {
        const list = LOOK_MAKEUPS[L.body]
        content.append(
          heading(t('creator.makeup')),
          scrolled(372, grid(list.map((v, i) => ({ value: v, title: v === '00' ? t('creator.makeupNone') : t('creator.makeupOf', { index: i + 1, count: list.length }), img: lookUrls.faceThumb(L.body, v) })), L.makeup, v => edit.makeup(s, v) && changed(), 'thumbs')),
        )
        break
      }
      case 'eyes':
        content.append(
          heading(t('creator.iris')),
          scrolled(372, grid(LOOK_IRISES.map((v, i) => ({ value: v, title: t('creator.irisOf', { index: i + 1, count: LOOK_IRISES.length }), img: lookUrls.eyeThumb(v) })), L.iris, v => edit.iris(s, v) && changed(), 'thumbs small')),
        )
        break
      case 'hair': {
        const h = hairOf(s)
        const bangs = new Checkbox(art, { label: t('creator.bangs'), checked: h.bangs })
        bangs.onChange = on => edit.bangs(s, on) && changed()
        content.append(
          heading(t('creator.hairStyle')),
          grid([1, 2, 3].map(n => ({ value: n, title: t('creator.hairStyleN', { n }), text: String(n) })), h.style, v => edit.hairStyle(s, v) && changed(), 'styles'),
          el('div', 'creator-row', bangs.root),
          heading(t('creator.hairColor')),
          grid(
            [{ value: 0, title: t('creator.natural'), text: '—' }, ...LOOK_HAIR_COLORS.map((c, i) => ({ value: i + 1, title: c, color: c }))],
            L.hairColor,
            v => edit.hairColor(s, v) && changed(),
            'swatches',
          ),
        )
        break
      }
      case 'skin': {
        const tones = [{ value: 0, title: t('creator.natural'), color: linearToCss(PACK_SKIN) }, ...LOOK_SKIN_TONES.map((_, i) => ({ value: i + 1, title: `${i + 1}`, color: linearToCss(lookSkinMultiplier(i + 1, 0).map((m, c) => m * PACK_SKIN[c]!)) }))]
        content.append(
          heading(t('creator.skinTone')),
          grid(tones, L.skinTone, v => edit.skinTone(s, v) && changed(), 'swatches'),
          slider(t('creator.skinShift'), -50, 50, L.skinShift, v => edit.skinShift(s, v) && changed(), 5),
        )
        break
      }
      case 'markings': {
        const cur = L.markings[0] ?? null
        content.append(
          heading(t('creator.paint')),
          grid(
            [{ value: null as string | null, title: t('creator.paintNone'), text: '—' }, ...Object.entries(LOOK_PAINTS).map(([id, c]) => ({ value: id as string | null, title: t(`creator.paint.${id}` as StringKey), color: c }))],
            cur,
            v => edit.paint(s, v) && changed(),
            'swatches big',
          ),
        )
        break
      }
      case 'accessories': {
        const list = LOOK_ACCESSORIES[L.body]
        if (!list.length) content.append(el('p', 'creator-note', t('creator.accNone')))
        for (const id of list) {
          const c = new Checkbox(art, { label: t(`creator.acc.${id}` as StringKey), checked: L.accessories.includes(id) })
          c.onChange = on => edit.accessory(s, id, on) && changed()
          content.append(el('div', 'creator-row', c.root))
        }
        break
      }
    }
  }

  const setTab = (tab: CreatorTab) => {
    s.tab = tab
    tabs.value = tab
    zoomGoal = FACE_TABS.has(tab) ? 1 : 0
    renderTab()
  }
  tabs.onChange = setTab

  // ---- actions --------------------------------------------------------------------------------
  const setStatus = (text: string, bad = false) => {
    status.textContent = text
    status.classList.toggle('bad', bad)
  }

  const submit = async (skip = false) => {
    if (busy) return
    busy = true
    setStatus('')
    try {
      if (editing) {
        const msg = lookMessage(s, skip)
        if (!msg) throw new Error(t('create.nameRule'))
        const r = await session.request(msg, ['charLookSet'])
        void app.go('world', { character: r.character })
      } else {
        const problem = nameProblem(s.name)
        if (problem) {
          setStatus(t(problem as StringKey), true)
          nameField.focus()
          busy = false
          return
        }
        const code = modelCode()
        const msg = code ? createMessage(s, code) : null
        if (!msg) throw new Error(t('create.noModel'))
        const r = await session.request(msg, ['charCreated'])
        void app.go('charselect', { select: r.character.id })
      }
    } catch (err) {
      busy = false
      setStatus(describeError(err), true)
    }
  }

  ls.on(primary, 'click', () => void submit(false))
  ls.on(keep, 'click', () => void submit(true))
  ls.on(back, 'click', () => void app.go('charselect', editing ? { select: editing.id } : undefined))
  ls.on(nameField, 'input', () => {
    s.name = nameField.value
    setStatus('')
  })
  ls.on(nameField, 'keydown', ev => {
    if (ev.key === 'Enter') void submit(false)
  })
  const stepWeapon = (d: number) => {
    const i = STARTER_WEAPONS.indexOf(s.weapon)
    s.weapon = STARTER_WEAPONS[(i + d + STARTER_WEAPONS.length) % STARTER_WEAPONS.length]!
    changed()
  }
  ls.on(weaponPrev, 'click', () => stepWeapon(-1))
  ls.on(weaponNext, 'click', () => stepWeapon(1))
  clothes.onChange = on => {
    s.clothes = on
    changed()
  }
  ls.on(zoomB, 'click', () => {
    zoomGoal = zoomGoal > 0.5 ? 0 : 1
    const k = zoomGoal > 0.5 ? 'outer/zoomout' : 'outer/zoomin'
    if (art.has(k)) applyStates(zoomB, art, k)
  })
  const hold = (b: HTMLElement, dir: number) => {
    ls.on(b, 'pointerdown', () => {
      spin = dir
      autoSpin = false
    })
    for (const ty of ['pointerup', 'pointerleave', 'pointercancel'] as const) ls.on(b, ty, () => (spin = 0))
  }
  hold(rotL, -1)
  hold(rotR, 1)
  ls.on(window, 'keydown', ev => {
    if ((ev.target as HTMLElement)?.tagName === 'INPUT') return
    if (ev.key === 'Escape') void app.go('charselect', editing ? { select: editing.id } : undefined)
  })
  // drag turns the character, the wheel zooms between the full body and the face
  let dragX: number | null = null
  const canvas = app.engine.getRenderingCanvas()
  if (canvas) {
    ls.on(canvas, 'pointerdown', ev => {
      if (ev.button !== 0) return
      dragX = ev.clientX
      autoSpin = false
    })
    ls.on(window, 'pointermove', ev => {
      if (dragX === null) return
      turntable.rotation.y += (ev.clientX - dragX) * 0.012
      dragX = ev.clientX
    })
    for (const ty of ['pointerup', 'pointercancel'] as const) ls.on(window, ty, () => (dragX = null))
    ls.on(canvas, 'wheel', ev => {
      zoomGoal = Math.max(0, Math.min(1, zoomGoal - Math.sign(ev.deltaY) * 0.2))
    })
  }

  // ---- per frame: turntable, height blend, the portrait camera ---------------------------------
  const frameObs: Observer<Scene> = scene.onBeforeRenderObservable.add(() => {
    const dt = Math.min(0.1, scene.getEngine().getDeltaTime() / 1000)
    if (autoSpin && zoomGoal < 0.5) turntable.rotation.y += dt * 0.3
    if (autoSpin && zoomGoal >= 0.5) turntable.rotation.y += (0 - turntable.rotation.y) * Math.min(1, dt * 3)
    turntable.rotation.y += spin * dt * 2
    // the height follows the slider on the next frame (it used to creep at 0.15/s: a step took ~0.2 s to show)
    shownScale = heightScale(s.look.height)
    if (actor && !actor.isDisposed) actor.root.scaling.setAll(shownScale)
    zoom += (zoomGoal - zoom) * Math.min(1, dt * 5)
    const base = actor && !actor.isDisposed ? actor.height : 1.7
    const h = base * shownScale
    // full body: framed on the tallest height (that figure fills ~62 % between the bars), so a taller or shorter
    // character reads as taller or shorter (framing the shown height cancelled the height slider on screen);
    // face: the head and neck at the shown height
    const ref = base * heightScale(LOOK_LIMITS.height[1])
    const full = { y: ref * 0.5, r: ref / 0.62 / (2 * Math.tan(camera.fov / 2)) }
    const face = { y: h * 0.905, r: 0.62 / (2 * Math.tan(camera.fov / 2)) }
    const e = zoom * zoom * (3 - 2 * zoom)
    camera.target.y = full.y + (face.y - full.y) * e
    camera.radius = full.r + (face.r - full.r) * e
  })

  // ---- debug / screenshots ---------------------------------------------------------------------
  const frozen: AnimationGroup[] = []
  ;(globalThis as { __sroCreator?: unknown }).__sroCreator = {
    state: () => structuredClone(s),
    tab: (tab: CreatorTab) => setTab(tab),
    zoom: (z: number) => {
      zoomGoal = z
      zoom = z
    },
    turn: (y: number) => {
      autoSpin = false
      turntable.rotation.y = y
    },
    set: (patch: Partial<CharLook>) => {
      Object.assign(s.look, patch)
      changed(true)
    },
    gender: (b: LookBody) => edit.gender(s, b) && changed(true),
    clothes: (on: boolean) => {
      clothes.checked = on
      s.clothes = on
      changed()
    },
    ready: () => !!actor && !actor.isDisposed && actorKey === modelKey() && !loadingNote.textContent,
    /** Holds the idle on its first frame (or resumes it), so joint measures and shots compare one pose. */
    freeze: (on: boolean) => {
      if (!on) {
        for (const g of frozen) g.play(true)
        frozen.length = 0
        return
      }
      for (const g of scene.animationGroups)
        if (g.isPlaying) {
          g.goToFrame(g.from)
          g.pause()
          frozen.push(g)
        }
    },
    /** What the preview draws now: the visible meshes' look variants (material `sroLook` keys) and parts. */
    drawn: () => {
      if (!actor || actor.isDisposed) return []
      const keys = new Set<string>()
      for (const m of actor.meshes) {
        if (!m.isVisible || !m.isEnabled()) continue
        const k = (m.material?.metadata as { sroLook?: string } | null)?.sroLook
        keys.add(`${m.name.replace(/__LOD\d.*$/, '')}=${k ?? m.material?.name ?? ''}`)
      }
      return [...keys].sort()
    },
    /** World positions of joints (the build / height checks). */
    joints: (names: string[]) => {
      const out: Record<string, number[]> = {}
      if (!actor?.skeleton) return out
      actor.root.computeWorldMatrix(true)
      for (const b of actor.skeleton.bones) {
        const n = b.getTransformNode()
        if (!n || !names.includes(n.name)) continue
        n.computeWorldMatrix(true)
        out[n.name] = n.getAbsolutePosition().asArray().map(v => Math.round(v * 1e4) / 1e4)
      }
      return out
    },
  }

  // ---- start ----------------------------------------------------------------------------------
  app.music.play(app.art.musicUrl('maintheme_cut'))
  weaponLabelEl.textContent = weaponLabel(s.weapon)
  setTab('body')
  if (!editing) nameField.focus()
  void loadActor()

  return {
    dispose() {
      disposed = true
      ls.clear()
      tabLs.clear()
      scroll?.dispose()
      scene.onBeforeRenderObservable.remove(frameObs)
      actor?.dispose()
      actor = null
      app.releaseScene()
      delete (globalThis as { __sroCreator?: unknown }).__sroCreator
    },
  }
}

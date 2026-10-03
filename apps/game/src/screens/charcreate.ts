/**
 * Character creation (Chinese only). Layout from Media/resinfo/pscharactercreatechina.txt:
 * customize_window 264x316 (GDR_EDIT_NAME 92,32,135,20; check button overlap 156,57; male/female 87,95 / 166,95;
 * five slider rows at y = 131, 162, 193, 224, 255 with arrows at x = 88 and 208: GDR_SLI_FIGURE, _HEIGHT, _VOLUME,
 * _PROTECTOR, _WEAPON = Model, Height, Body, Cloth, Arms), explain-window 212x180,
 * rotate_window 152x56 (rotate left 12,11 / zoom 57,11 / rotate right 99,11), warning_create 248x128 dialog.
 * The caption is live text where the text-custom art would be. Persona names and stories come from the
 * game's English textdata (characters.json: UIO_NEWCHAR_*), weapon names from weapons.json / textdata.
 * The preview wears the chosen starter outfit and weapon (@sro/appearance starterEquipment), is scaled by Height
 * (blended over 1 s like the original) and shaped by Volume; charCreate carries height, volume and outfit.
 * Rebuilt on the UI kit (docs/UI.md §4.7): the man / woman plates draw at their native 72x28 with the live label in
 * the plate's text window (shrunk to fit, so "Female" never clips), Height and Body are retail sliders (outer/slider
 * thumb on the track, Slider section: thumb 20,0 .. 104,0), the story scrolls with the kit bar, buttons fit their text.
 *
 * - **The stage** (docs/SCREENS.md §0B.2, §6.2; lane SCR-CRE): the character stands on the Jangan south-gate steps,
 *   through the world renderer: `app.stage.enter(STAGES.create)`. From select on the same export the World is kept and
 *   the camera orbits 180° round the spot to the plaza and the golden dragon (`orbitMs`); the character loads beside the
 *   orbit (`preload`) and appears when it is dressed (`actors`). The retail rotate window turns the character (the
 *   turntable on the spot); the zoom button blends the stage camera between the full-body and face keys in
 *   STAGE_ZOOM_MS (`stage.setZoom`). The calligraphy (outer/back_image) is a screen panel in its retail rect
 *   (`.create-backimage`, style.css). Leaving keeps the stage: select reuses the World and orbits back.
 * - **The fallback** (§0B.4): when the stage cannot be built, today's release screen: the pedestal scene with
 *   `StudioEnvironment` and the 3D calligraphy plane, with a console warning.
 */
import {
  ArcRotateCamera,
  Color3,
  Color4,
  CreateCylinder,
  CreateTorus,
  DirectionalLight,
  HemisphericLight,
  SpotLight,
  StandardMaterial,
  TransformNode,
  Vector3,
  type Observer,
  type Scene,
} from '@babylonjs/core'
import { buildCharCreate, DEFAULT_OUTFIT, heightScale, starterEquipment, stepChoice, stepScale } from '@sro/appearance'
import { APPEARANCE_STEPS, CHARACTER_NAME, DEFAULT_HEIGHT, DEFAULT_VOLUME, STARTER_OUTFITS, type StarterOutfit, type StarterWeapon } from '@sro/shared'
import type { App, OwnedScene, Screen } from '../app.ts'
import { STARTER_WEAPONS, weaponAbout, weaponLabel, type CharacterModel, type Gender } from '../content/catalog.ts'
import { gameText, t } from '../i18n/index.ts'
import { STAGES, STAGE_ORBIT_MS, STAGE_ZOOM_MS } from '../stage/stages.ts'
import type { Stage } from '../stage/types.ts'
import { artPlane, newScene } from '../three/backdrop.ts'
import { ModelLibrary, type CharacterActor, type Look } from '../three/models.ts'
import { StudioEnvironment } from '../three/studio-env.ts'
import { anchor, bars, caption } from '../ui/chrome.ts'
import { el, input, Listeners, place } from '../ui/dom.ts'
import { applyStates, button, iconButton, ScrollArea, type KitButton } from '../ui/kit/index.ts'
import { LOADING_PICTURES, LoadingOverlay } from './loading.ts'
import { describeError } from './login.ts'
import { fitLabel, outerButton, outerDialog, SEX_PLATE, sliderStepAt, sliderThumbX } from './outer-ui.ts'

const ROW_Y = [131, 162, 193, 224, 255]
/** Rows drawn as retail sliders (a thumb on the track): Height and Body. The others show their value as text. */
const SLIDER_ROWS = new Set([1, 2])
/** The slider thumb's travel (pscharactercreatechina.txt Slider: thumb at 20..104 of the 120-px control at x 88). */
const THUMB_X0 = 108
const THUMB_RANGE = 84

/** Cloth row: the game's own names for the three starter sets, the UI table as fallback. */
const OUTFIT_TEXT: Record<StarterOutfit, [string, 'item.armor.garment' | 'item.armor.protector' | 'item.armor.armor']> = {
  clothes: ['UIO_NEWCHAR_STT_CLOTHES', 'item.armor.garment'],
  light: ['UIO_NEWCHAR_STT_LIGHT_ARMOR', 'item.armor.protector'],
  heavy: ['UIO_NEWCHAR_STT_HEAVY_ARMOR', 'item.armor.armor'],
}

function outfitLabel(o: StarterOutfit): string {
  const [id, key] = OUTFIT_TEXT[o]
  return gameText(id, t(key))
}

const thumbX = (v: number) => sliderThumbX(v, APPEARANCE_STEPS, THUMB_X0, THUMB_RANGE)
const stepAtX = (x: number) => sliderStepAt(x, APPEARANCE_STEPS, THUMB_X0, THUMB_RANGE, 16)

/** The fallback scene (§0B.4): today's release screen, a pedestal before the 3D calligraphy plane. */
function buildFallbackScene(app: App) {
  const scene = newScene(app.engine, new Color4(0.02, 0.02, 0.03, 1))
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0.3), scene)
  hemi.intensity = 0.55
  hemi.groundColor = new Color3(0.12, 0.1, 0.08)
  const key = new DirectionalLight('key', new Vector3(-0.3, -0.8, -1).normalize(), scene)
  key.intensity = 1.1
  const spot = new SpotLight('spot', new Vector3(0, 6, 2), new Vector3(0, -1, -0.3), 0.9, 8, scene)
  spot.intensity = 0.8
  spot.diffuse = new Color3(1, 0.9, 0.7)
  // PBR metals need something to reflect (the starter weapons' remastered sets): a studio cube on the new look only.
  new StudioEnvironment(scene, { hemi, key })

  const pedestal = CreateCylinder('pedestal', { diameterTop: 1.8, diameterBottom: 2.1, height: 0.35, tessellation: 64 }, scene)
  pedestal.position.y = -0.175
  const pm = new StandardMaterial('pedMat', scene)
  pm.diffuseColor = new Color3(0.22, 0.2, 0.18)
  pm.specularColor = new Color3(0.2, 0.18, 0.12)
  pedestal.material = pm
  const rim = CreateTorus('pedRim', { diameter: 1.8, thickness: 0.05, tessellation: 64 }, scene)
  const rm = new StandardMaterial('rimMat', scene)
  rm.diffuseColor = new Color3(0.75, 0.58, 0.22)
  rm.emissiveColor = new Color3(0.35, 0.25, 0.06)
  rim.material = rm
  if (app.art.has('outer/back_image')) {
    const cal = artPlane(scene, 'calligraphy', app.art.url('outer/back_image'), 3.4, 4.63)
    cal.position.set(1.9, 1.5, -2.6)
  }
  const turntable = new TransformNode('turntable', scene)
  const camera = new ArcRotateCamera('cam', Math.PI / 2, 1.42, 4.4, new Vector3(0, 0.95, 0), scene)
  camera.minZ = 0.05
  camera.fov = 0.7
  const library = new ModelLibrary(scene)
  return {
    kind: 'charcreate',
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

/** The 3D side of the screen: the stage, or the fallback pedestal scene. */
interface View {
  readonly scene: Scene
  readonly library: ModelLibrary
  /** The turntable the character stands on (the rotate window and a drag turn it). */
  readonly turntable: TransformNode
  /** The screen-space calligraphy panel shows (the stage; the fallback has its 3D plane). */
  readonly panel: boolean
  /** Stands an actor on the turntable, facing the camera, and hands it to the renderer (shadows, the key light). */
  mount(actor: CharacterActor): void
  unmount(actor: CharacterActor): void
  /** Per frame: the zoom (the stage's camera keys, the fallback's radius) and the shown height scale. */
  frame(dt: number, zoomed: boolean, scale: number): void
  dispose(): void
}

const ease = (f: number) => (f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2)

export function charCreateScreen(app: App): Screen {
  const session = app.session
  if (!session) {
    void app.logout(t('app.notConnected'))
    return { dispose() {} }
  }
  const art = app.art

  // ---- DOM ------------------------------------------------------------------------------------
  const root = el('div', 'screen charcreate')
  const win = art.window('outer/customize_window', 'customize-window', 264, 316)
  const nameField = place(input('field', 'text', { maxlength: '12', 'aria-label': t('create.nameAria') }), [92, 32, 135, 20])
  const check = place(outerButton(art, t('create.check'), { skin: { key: 'outer/overlap', w: 75, h: 25, slice: 8 } }), [156, 57, 0, 0])
  const nameStatus = place(el('div', 'name-status'), [8, 61, 146, 15])
  const sexButton = (key: string, label: string, side: 'male' | 'female') => {
    const b = button(art, { label: '', skin: { key, w: SEX_PLATE.w, h: SEX_PLATE.h, slice: 0 }, width: SEX_PLATE.w, className: `sex-button sex-${side}` })
    fitLabel(b.querySelector<HTMLElement>('.kit-btn-label')!, label, SEX_PLATE.textW - 2)
    return place(b, [side === 'male' ? 86 : 165, 94, 0, 0])
  }
  const male = sexButton('outer/man_on', t('create.male'), 'male')
  const female = sexButton('outer/woman_off', t('create.female'), 'female')
  win.append(place(el('div', 'label kit-t-label', t('create.name')), [32, 35, 55, 15]), nameField, check, nameStatus, place(el('div', 'label kit-t-label', t('create.sex')), [32, 100, 55, 15]), male, female)

  const rowValue: HTMLElement[] = []
  const rowButtons: [KitButton, KitButton][] = []
  const thumbs = new Map<number, HTMLElement>()
  const rowLabels = [t('create.model'), t('create.height'), t('create.volume'), gameText('UIO_NEWCHAR_STT_PROTECTOR', t('create.cloth')), t('create.weapon')]
  ROW_Y.forEach((y, i) => {
    win.append(place(el('div', 'label kit-t-label', rowLabels[i]!), [32, y + 5, 55, 15]))
    const v = place(el('div', 'row-value'), [108, y + 4, 100, 16])
    rowValue.push(v)
    win.append(v)
    if (SLIDER_ROWS.has(i)) {
      // The track takes clicks; the thumb (outer/slider, 16x24) drags. Both land on one of the five steps.
      v.classList.add('row-track')
      const thumb = place(el('div', 'slider-thumb'), [thumbX(0), y, 16, 24])
      if (!applyStates(thumb, art, 'outer/slider')) thumb.classList.add('no-art')
      thumbs.set(i, thumb)
      win.append(thumb)
    }
    const prev = place(iconButton(art, 'outer/arrow_left', { w: 20, h: 20, fallbackText: '<', className: 'arrow prev' }), [88, y + 2, 20, 20])
    const next = place(iconButton(art, 'outer/arrow_right', { w: 20, h: 20, fallbackText: '>', className: 'arrow next' }), [208, y + 2, 20, 20])
    rowButtons.push([prev, next])
    win.append(prev, next)
  })

  const explain = art.window('outer/explain-window', 'explain-window', 212, 180)
  const explainTitle = place(el('div', 'explain-title'), [15, 18, 183, 14])
  const explainScroll = new ScrollArea(art, { w: 186, h: 122, className: 'explain-scroll' })
  const explainText = explainScroll.view
  explainText.classList.add('explain-text')
  explain.append(explainTitle, place(explainScroll.root, [15, 42, 186, 122]))

  const rotate = art.window('outer/rotate_window', 'rotate-window', 152, 56)
  const rotL = place(iconButton(art, 'outer/rotate_left', { w: 42, h: 35, title: t('create.rotateLeft'), fallbackText: '<' }), [12, 11, 42, 35])
  const zoom = place(iconButton(art, 'outer/zoomin', { w: 39, h: 35, title: t('create.zoom'), fallbackText: '+' }), [57, 11, 39, 35])
  const rotR = place(iconButton(art, 'outer/rotate_right', { w: 42, h: 35, title: t('create.rotateRight'), fallbackText: '>' }), [99, 11, 42, 35])
  rotate.append(rotL, zoom, rotR)

  const ok = outerButton(art, t('create.ok'), { primary: true })
  const cancel = outerButton(art, t('create.back'))
  const loadingNote = el('div', 'preview-note')
  // The calligraphy in its retail screen rect (§6.2), shown once the stage is up; under the bars and the windows.
  const backImage = el('div', 'create-backimage')
  backImage.hidden = true
  if (art.has('outer/back_image')) backImage.style.backgroundImage = art.cssUrl('outer/back_image')
  root.append(
    backImage,
    ...bars(art, 'outer/redbar_up', 'outer/redbar_down'),
    caption(t('create.caption')),
    anchor(win, 0.2, 0.5),
    anchor(explain, 0.8, 0.62),
    anchor(rotate, 0.5, 0.8),
    loadingNote,
    el('div', 'bottom-buttons', ok, cancel),
  )
  app.ui.append(root)

  // ---- state ----------------------------------------------------------------------------------
  let gender: Gender = 'male'
  let index = 0
  let weapon: StarterWeapon = 'blade'
  let height = DEFAULT_HEIGHT
  let volume = DEFAULT_VOLUME
  let outfit: StarterOutfit = DEFAULT_OUTFIT
  /** Height scale shown now (blends towards the choice). */
  let shownScale = heightScale(height)
  let view: View | null = null
  let loading: LoadingOverlay | null = null
  const abort = new AbortController()
  let actor: CharacterActor | null = null
  /** The library the actor was loaded into, and the preview request it shows (a newer request makes it stale). */
  let actorLib: ModelLibrary | null = null
  let actorToken = -1
  let previewToken = 0
  let zoomed = false
  let spin = 0
  let autoSpin = true
  let disposed = false
  let nameOk: boolean | null = null
  let checkTimer: ReturnType<typeof setTimeout> | undefined
  let busy = false

  const models = (): CharacterModel[] => app.catalog.selectable(gender)
  const current = (): CharacterModel | undefined => models()[index]

  const setGenderArt = () => {
    const set = (b: HTMLButtonElement, key: string) => {
      b.classList.toggle('on', key.endsWith('_on'))
      applyStates(b, art, key)
    }
    set(male, gender === 'male' ? 'outer/man_on' : 'outer/man_off')
    set(female, gender === 'female' ? 'outer/woman_on' : 'outer/woman_off')
  }

  const look = (): Look => ({
    equip: starterEquipment(gender, outfit, weapon),
    family: weapon,
    fallbackWeapon: app.catalog.weapon(weapon),
    height,
    volume,
  })

  const updateTexts = () => {
    const list = models()
    const m = current()
    const counter = m ? t('create.modelOf', { index: index + 1, count: list.length }) : ''
    rowValue[0]!.textContent = m ? (m.persona ?? m.label) : t('create.modelNone')
    rowValue[0]!.title = counter
    thumbs.get(1)!.style.left = `${thumbX(height)}px`
    thumbs.get(1)!.title = t('create.stepOf', { index: height + 1, count: APPEARANCE_STEPS })
    thumbs.get(2)!.style.left = `${thumbX(volume)}px`
    thumbs.get(2)!.title = t('create.stepOf', { index: volume + 1, count: APPEARANCE_STEPS })
    rowValue[3]!.textContent = outfitLabel(outfit)
    rowValue[3]!.title = outfitLabel(outfit)
    const w = app.catalog.weapon(weapon)
    const family = weaponLabel(weapon)
    rowValue[4]!.textContent = w?.name ?? family
    rowValue[4]!.title = weaponAbout(weapon)
    explainTitle.replaceChildren(m?.persona ?? m?.label ?? '', el('span', 'explain-count', counter))
    explainText.replaceChildren(
      el('p', '', m?.description ?? weaponAbout(weapon)),
      el('p', 'explain-weapon', w ? `${w.name ?? family} (${family})` : t('create.weaponMissing', { weapon: family })),
      el('p', 'explain-weapon', [
        gameText('UIO_NEWCHAR_CTL_CHINESE', t('create.raceChinese')),
        t('create.startTown'),
        `${t('create.level')} ${t('create.startLevel')}`,
      ].join(' · ')),
    )
    explainText.scrollTop = 0
    explainScroll.refresh()
  }

  /**
   * A new model (sex / figure): loads it dressed as chosen into `lib` (the view's; the stage's own during its
   * `preload`, before the view exists). Without a library yet it only marks the preview stale: `attach` reloads it.
   */
  const refreshPreview = async (lib: ModelLibrary | null = view?.library ?? null) => {
    updateTexts()
    const token = ++previewToken
    const m = current()
    if (!m) {
      loadingNote.textContent = t(gender === 'female' ? 'create.noModelsFemale' : 'create.noModelsMale')
      return
    }
    if (!lib) return
    loadingNote.textContent = t('create.loadingModel')
    const wanted = look()
    const key = (l: Look) => JSON.stringify([l.equip, l.volume])
    try {
      const next = await lib.character(m, wanted, f => {
        if (token === previewToken) loadingNote.textContent = t('create.loadingModelPct', { pct: Math.round(f * 100) })
      })
      if (disposed || token !== previewToken || (view && view.library !== lib)) return next.dispose()
      // Hidden until a view stands it on the turntable (the stage's preload runs before the view exists).
      next.root.setEnabled(false)
      if (actor) {
        view?.unmount(actor)
        actor.dispose()
      }
      actor = next
      actorLib = lib
      actorToken = token
      actor.root.scaling.setAll(shownScale)
      actor.play('STAND1')
      view?.mount(actor)
      loadingNote.textContent = ''
      // Clothes or build changed while the model loaded.
      if (key(look()) !== key(wanted)) redress()
    } catch (err) {
      if (token === previewToken) loadingNote.textContent = t('create.modelFailed', { error: describeError(err) })
    }
  }

  /** Same model, other clothes / weapon / build: re-dresses the preview in place. */
  const redress = () => {
    updateTexts()
    if (!actor || actor.isDisposed || !actorLib) return void refreshPreview()
    const a = actor
    void actorLib
      .dress(a, look())
      .then(() => {
        // New item meshes: hand them to the renderer again (the shadow casters, the key light).
        if (!disposed && a === actor && view) {
          view.unmount(a)
          view.mount(a)
        }
      })
      .catch(err => console.warn('[charcreate] dress failed', err))
  }

  const step = (row: number, d: number) => {
    if (row === 0) {
      const n = models().length
      if (!n) return
      index = (index + d + n) % n
      return void refreshPreview()
    }
    if (row === 1) {
      height = stepScale(height, d)
      return updateTexts()
    }
    if (row === 2) volume = stepScale(volume, d)
    else if (row === 3) outfit = stepChoice(STARTER_OUTFITS, outfit, d)
    else weapon = stepChoice(STARTER_WEAPONS, weapon, d)
    redress()
  }

  const setGender = (g: Gender) => {
    if (g === gender) return
    gender = g
    index = 0
    setGenderArt()
    void refreshPreview()
  }

  const setNameStatus = (text: string, ok: boolean | null) => {
    nameStatus.textContent = text
    nameStatus.className = `name-status ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`
    nameOk = ok
  }

  const runNameCheck = async () => {
    const name = nameField.value.trim()
    if (!name) return setNameStatus('', null)
    if (!CHARACTER_NAME.test(name)) return setNameStatus(t('create.nameRule'), false)
    setNameStatus(t('create.checking'), null)
    try {
      const r = await session.request({ t: 'nameCheck', name }, ['nameCheck'])
      if (disposed || nameField.value.trim() !== r.name) return
      setNameStatus(r.available ? t('create.available') : r.reason ?? t('create.unavailable'), r.available)
    } catch (err) {
      if (!disposed) setNameStatus(describeError(err), false)
    }
  }

  const create = () => {
    if (busy) return
    const name = nameField.value.trim()
    const m = current()
    if (!CHARACTER_NAME.test(name)) {
      setNameStatus(t('create.nameRule'), false)
      nameField.focus()
      return
    }
    if (nameOk === false) {
      nameField.focus()
      return
    }
    if (!m) return app.toast(t('create.noModel'), 'error')
    let modal: HTMLElement | null = null
    const err = el('div', 'dialog-error')
    const close = () => modal?.remove()
    const confirm = async () => {
      busy = true
      try {
        const r = await session.request(buildCharCreate({ name, model: m.code, weapon, height, volume, outfit }), ['charCreated'])
        close()
        void app.go('charselect', { select: r.character.id })
      } catch (e) {
        busy = false
        err.textContent = describeError(e)
      }
    }
    modal = outerDialog(art, {
      key: 'outer/warning_create',
      w: 248,
      h: 128,
      title: name,
      titleRect: [4, 21, 239, 15],
      body: [el('p', '', t('create.confirmBody', { persona: m.persona ?? m.label, weapon: weaponLabel(weapon).toLowerCase() })), err],
      bodyRect: [8, 42, 231, 32],
      buttons: [
        { label: t('create.confirm'), primary: true, onClick: () => void confirm() },
        { label: t('create.cancel'), onClick: close },
      ],
      at: [
        [42, 75],
        [130, 75],
      ],
    })
    modal.addEventListener('keydown', ev => {
      ev.stopPropagation()
      if (ev.key === 'Enter') void confirm()
      if (ev.key === 'Escape') close()
    })
    app.ui.append(modal)
    modal.querySelector<HTMLButtonElement>('button.primary')?.focus()
  }

  // ---- wiring -----------------------------------------------------------------------------------
  const ls = new Listeners()
  rowButtons.forEach(([prev, next], row) => {
    ls.on(prev, 'click', () => step(row, -1))
    ls.on(next, 'click', () => step(row, 1))
  })
  // Slider rows: a click on the track or a thumb drag picks the step under the pointer (window px = client px / scale).
  const setStep = (row: number, v: number) => {
    const cur = row === 1 ? height : volume
    if (v !== cur) step(row, v - cur)
  }
  const stepAtPointer = (ev: PointerEvent) => {
    const r = win.getBoundingClientRect()
    return stepAtX((ev.clientX - r.left) / (r.width / 264))
  }
  for (const [row, thumb] of thumbs) {
    ls.on(rowValue[row]!, 'pointerdown', ev => setStep(row, stepAtPointer(ev)))
    ls.on(thumb, 'pointerdown', ev => {
      ev.preventDefault()
      thumb.setPointerCapture(ev.pointerId)
      thumb.classList.add('pressed')
    })
    ls.on(thumb, 'pointermove', ev => {
      if (thumb.hasPointerCapture(ev.pointerId)) setStep(row, stepAtPointer(ev))
    })
    for (const type of ['pointerup', 'pointercancel'] as const) ls.on(thumb, type, () => thumb.classList.remove('pressed'))
  }
  ls.on(male, 'click', () => setGender('male'))
  ls.on(female, 'click', () => setGender('female'))
  ls.on(check, 'click', () => void runNameCheck())
  ls.on(nameField, 'input', () => {
    clearTimeout(checkTimer)
    setNameStatus('', null)
    checkTimer = setTimeout(() => void runNameCheck(), 400)
  })
  ls.on(nameField, 'keydown', ev => {
    if (ev.key === 'Enter') create()
  })
  ls.on(ok, 'click', create)
  ls.on(cancel, 'click', () => void app.go('charselect'))
  ls.on(zoom, 'click', () => {
    zoomed = !zoomed
    const key = zoomed ? 'outer/zoomout' : 'outer/zoomin'
    if (art.has(key)) applyStates(zoom, art, key)
  })
  const hold = (b: HTMLButtonElement, dir: number) => {
    ls.on(b, 'pointerdown', () => {
      spin = dir
      autoSpin = false
    })
    for (const t of ['pointerup', 'pointerleave', 'pointercancel'] as const) ls.on(b, t, () => (spin = 0))
  }
  hold(rotL, -1)
  hold(rotR, 1)
  ls.on(window, 'keydown', ev => {
    if ((ev.target as HTMLElement)?.tagName === 'INPUT') return
    if (ev.key === 'Escape') void app.go('charselect')
  })

  // A drag on the 3D view turns the character. DOM events on the canvas, not the scene's pointer observable: on the
  // stage a press would pick over the whole world.
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
      if (view) view.turntable.rotation.y += (ev.clientX - dragX) * 0.012
      dragX = ev.clientX
    })
    for (const type of ['pointerup', 'pointercancel'] as const) ls.on(window, type, () => (dragX = null))
  }

  let frameObs: Observer<Scene> | null = null
  const frame = () => {
    const v = view
    if (!v) return
    // Clamped: the first frame after a load (or a hidden tab) must not whirl the turntable.
    const dt = Math.min(0.1, v.scene.getEngine().getDeltaTime() / 1000)
    if (autoSpin) v.turntable.rotation.y += dt * 0.35
    v.turntable.rotation.y += spin * dt * 2
    // Height blends linearly over about a second (native 6D0B40).
    const want = heightScale(height)
    const stepS = dt * 0.12
    shownScale = Math.abs(want - shownScale) <= stepS ? want : shownScale + Math.sign(want - shownScale) * stepS
    if (actor && !actor.isDisposed) actor.root.scaling.setAll(shownScale)
    v.frame(dt, zoomed, shownScale)
  }

  // ---- 3D: the stage, else the fallback pedestal --------------------------------------------------

  const stageView = (stage: Stage): View => {
    // One character on the spot, facing the camera (south); the turntable turns it from there.
    const [p] = stage.slots(1)
    const turntable = new TransformNode('createTurntable', stage.scene)
    turntable.position.set(p?.x ?? stage.def.spot.x, p?.y ?? stage.ground, p?.z ?? stage.def.spot.z)
    const yaw = p?.yaw ?? stage.def.facing
    // The zoom blend 0 (full body) .. 1 (face): linear over STAGE_ZOOM_MS, eased into the stage's camera keys.
    let zf = 0
    stage.setZoom(0)
    return {
      scene: stage.scene,
      library: stage.library,
      turntable,
      panel: true,
      mount(a) {
        a.root.parent = turntable
        a.root.position.setAll(0)
        a.setYaw(yaw)
        a.root.setEnabled(true)
        stage.addActor(a.root)
      },
      unmount(a) {
        stage.removeActor(a.root)
      },
      frame(dt, zoom) {
        const goal = zoom ? 1 : 0
        if (zf === goal) return
        const s = (dt * 1000) / STAGE_ZOOM_MS
        zf = Math.abs(goal - zf) <= s ? goal : zf + Math.sign(goal - zf) * s
        stage.setZoom(ease(zf))
      },
      // The stage stays: select reuses its World and orbits back; the world screen's or the title's scene releases it.
      dispose() {
        turntable.dispose()
      },
    }
  }

  const fallbackView = (): View => {
    const owned = app.useScene('charcreate', () => buildFallbackScene(app))
    const { scene, camera, turntable, library } = owned
    return {
      scene,
      library,
      turntable,
      panel: false,
      mount(a) {
        a.root.parent = turntable
        a.root.setEnabled(true)
      },
      unmount() {},
      frame(dt, zoom, scale) {
        // Today's zoom: the camera eases in, its focus follows the height.
        const wantR = zoom ? 2.1 : 4.4
        const wantY = (zoom ? 1.45 : 0.95) * scale
        camera.radius += (wantR - camera.radius) * Math.min(1, dt * 6)
        camera.target.y += (wantY - camera.target.y) * Math.min(1, dt * 6)
      },
      dispose() {
        app.releaseScene()
      },
    }
  }

  /** Makes `v` the view: the panel, the per-frame work, the character (loaded already, or now). */
  const attach = (v: View) => {
    view = v
    backImage.hidden = !v.panel
    frameObs = v.scene.onBeforeRenderObservable.add(frame)
    if (actor && actorLib === v.library) v.mount(actor)
    if (!actor || actorLib !== v.library || actorToken !== previewToken) void refreshPreview()
  }

  const detach = () => {
    view?.scene.onBeforeRenderObservable.remove(frameObs)
    frameObs = null
  }

  /** The stage (reused from select: the orbit; else a load behind the loading picture); the fallback if it fails. */
  const open = async () => {
    try {
      const stage = await app.stage.enter(STAGES.create, {
        signal: abort.signal,
        orbitMs: STAGE_ORBIT_MS,
        onProgress: f => {
          // A reused World reports only its end (1): the picture shows for a real load only.
          if (f < 1 && !loading) {
            loading = new LoadingOverlay(art, LOADING_PICTURES.characters, app.overlay)
            loading.progress(0, t('select.loading'))
          }
          loading?.progress(f)
        },
        preload: (_scene, library) => refreshPreview(library),
        actors: async s => {
          if (!disposed && !view) attach(stageView(s))
        },
      })
      if (disposed) return
      if (!view) attach(stageView(stage))
    } catch (err) {
      if (disposed || (err as Error)?.name === 'AbortError') return
      console.warn('[charcreate] the stage could not be built; running the pedestal fallback', err)
      // The host released the stage (its library, the actor's meshes): start over on today's scene.
      detach()
      if (actor && !actor.isDisposed) actor.dispose()
      actor = null
      actorLib = null
      if (view && !view.turntable.isDisposed()) view.turntable.dispose()
      view = null
      attach(fallbackView())
    } finally {
      if (!disposed) void loading?.finish()
    }
  }

  app.music.play(app.art.musicUrl('maintheme_cut'))
  setGenderArt()
  updateTexts()
  nameField.focus()
  void open()

  return {
    dispose() {
      disposed = true
      // A stage load in progress stops (a fresh load is released; a reused World stays for select).
      abort.abort()
      clearTimeout(checkTimer)
      ls.clear()
      detach()
      loading?.remove()
      if (actor) {
        view?.unmount(actor)
        actor.dispose()
      }
      actor = null
      explainScroll.dispose()
      view?.dispose()
      view = null
    },
  }
}

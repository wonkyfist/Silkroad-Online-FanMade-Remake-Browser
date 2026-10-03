// Asset viewer for converter output (work/out, served at /out/ by vite.config.ts).
// Query string: ?model=<id>&anim=<clip>&attach=<id>&bone=<name>&mode=bone|bind&equip=<code,code>&engine=webgl
import { AnimationController, clipEvents, findSidecarAnimation } from './animation.ts'
import { createEngine } from './engine.ts'
import { EquipmentPanel } from './equip/panel.ts'
import { isIndexEntry, type AnimEvent, type IndexEntry, type Sidecar } from './types.ts'
import { Viewer, type AttachMode, type ModelSource } from './viewer.ts'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`#${id} missing from index.html`)
  return node as T
}

const ui = {
  engineBadge: el<HTMLSpanElement>('engine-badge'),
  reloadIndex: el<HTMLButtonElement>('reload-index'),
  modelFilter: el<HTMLInputElement>('model-filter'),
  modelList: el<HTMLSelectElement>('model-list'),
  modelCount: el<HTMLDivElement>('model-count'),
  info: el<HTMLDListElement>('info'),
  clipList: el<HTMLSelectElement>('clip-list'),
  loop: el<HTMLInputElement>('loop'),
  speed: el<HTMLInputElement>('speed'),
  speedOut: el<HTMLOutputElement>('speed-out'),
  showSkeleton: el<HTMLInputElement>('show-skeleton'),
  showWireframe: el<HTMLInputElement>('show-wireframe'),
  showNormals: el<HTMLInputElement>('show-normals'),
  showGrid: el<HTMLInputElement>('show-grid'),
  frame: el<HTMLButtonElement>('frame'),
  attachModel: el<HTMLSelectElement>('attach-model'),
  attachBone: el<HTMLSelectElement>('attach-bone'),
  attachMode: el<HTMLSelectElement>('attach-mode'),
  attachInfo: el<HTMLDivElement>('attach-info'),
  sidecar: el<HTMLPreElement>('sidecar'),
  canvas: el<HTMLCanvasElement>('canvas'),
  stage: el<HTMLElement>('stage'),
  status: el<HTMLDivElement>('status'),
  hud: el<HTMLDivElement>('hud'),
  play: el<HTMLButtonElement>('play'),
  time: el<HTMLSpanElement>('time'),
  scrub: el<HTMLInputElement>('scrub'),
  markers: el<HTMLDivElement>('markers'),
}

const OUT_BASE = new URL('out/', document.baseURI)
const EVENT_NAMES: Record<number, string> = { 1: 'hit', 2: 'footstep' }

function outUrl(rel: string): string {
  return new URL(rel.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'), OUT_BASE).href
}

let viewer: Viewer
let equipPanel: EquipmentPanel | null = null
let entries: IndexEntry[] = []
const localFiles = new Map<string, { glb: File; sidecar?: Sidecar }>()
let anim: AnimationController | null = null
let events: AnimEvent[] = []
let scrubbing = false
let lastTime = 0
let statusTimer = 0
let selectSeq = 0

function setStatus(text: string, kind: 'info' | 'error' = 'info', ms = kind === 'error' ? 10_000 : 2500): void {
  ui.status.textContent = text
  ui.status.className = text ? `show ${kind}` : ''
  window.clearTimeout(statusTimer)
  if (text && ms > 0) statusTimer = window.setTimeout(() => setStatus(''), ms)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- URL state --------------------------------------------------------------------------------

const initial = new URLSearchParams(location.search)

function writeUrlState(): void {
  const p = new URLSearchParams()
  const model = viewer.model?.entry
  if (model && !localFiles.has(model.id)) p.set('model', model.id)
  if (anim?.current) p.set('anim', anim.current.name)
  const att = viewer.attachment
  if (att && !localFiles.has(att.model.entry.id)) {
    p.set('attach', att.model.entry.id)
    p.set('bone', att.boneName)
    if (att.mode !== 'bone') p.set('mode', att.mode)
  }
  const equip = equipPanel?.urlValue()
  if (equip) p.set('equip', equip)
  const engine = initial.get('engine')
  if (engine) p.set('engine', engine)
  const qs = p.toString()
  history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname)
}

// ---- index / pickers --------------------------------------------------------------------------

async function loadIndex(): Promise<void> {
  const res = await fetch(new URL('index.json', OUT_BASE), { cache: 'no-cache' })
  if (!res.ok) {
    throw new Error(`/out/index.json: HTTP ${res.status}. Run the converter, or ` +
      '`pnpm exec tsx packages/convert/src/tools/make-test-glb.ts` for test assets.')
  }
  const data: unknown = await res.json()
  if (!Array.isArray(data)) throw new Error('/out/index.json is not an array')
  const valid = data.filter(isIndexEntry).map(e => ({ ...e, name: e.name || e.id, category: e.category || 'uncategorized' }))
  if (valid.length !== data.length) setStatus(`index.json: skipped ${data.length - valid.length} malformed entries`, 'error')
  const locals = entries.filter(e => localFiles.has(e.id))
  entries = [...valid, ...locals]
  renderModelList()
  renderAttachList()
}

function groupByCategory(list: IndexEntry[]): Map<string, IndexEntry[]> {
  const groups = new Map<string, IndexEntry[]>()
  for (const e of list) {
    const g = groups.get(e.category)
    if (g) g.push(e)
    else groups.set(e.category, [e])
  }
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)))
}

function fillGroupedSelect(select: HTMLSelectElement, list: IndexEntry[], selected: string | undefined, leading?: HTMLOptionElement): void {
  const frag = document.createDocumentFragment()
  if (leading) frag.append(leading)
  for (const [category, items] of groupByCategory(list)) {
    const group = document.createElement('optgroup')
    group.label = `${category} (${items.length})`
    for (const e of items) {
      const opt = new Option(e.name, e.id, false, e.id === selected)
      opt.title = `${e.id}\n${e.glb}`
      group.append(opt)
    }
    frag.append(group)
  }
  select.replaceChildren(frag)
}

function renderModelList(): void {
  const q = ui.modelFilter.value.trim().toLowerCase()
  const list = q
    ? entries.filter(e => `${e.name}\n${e.id}\n${e.category}\n${e.glb}`.toLowerCase().includes(q))
    : entries
  fillGroupedSelect(ui.modelList, list, viewer.model?.entry.id)
  ui.modelCount.textContent = q ? `${list.length} of ${entries.length} entries` : `${entries.length} entries`
}

function renderAttachList(): void {
  const current = viewer.attachment?.model.entry.id ?? ui.attachModel.value
  fillGroupedSelect(ui.attachModel, entries, current, new Option('(none)', '', false, !current))
}

function renderBoneList(preferred?: string): void {
  const names = viewer.attachTargets()
  const pick = preferred && names.includes(preferred) ? preferred : viewer.defaultAttachTarget()
  ui.attachBone.replaceChildren(...names.map(n => new Option(n, n, false, n === pick)))
  ui.attachBone.disabled = names.length === 0
}

// ---- model loading ----------------------------------------------------------------------------

function sourceFor(entry: IndexEntry): ModelSource {
  return localFiles.get(entry.id)?.glb ?? outUrl(entry.glb)
}

async function fetchSidecar(entry: IndexEntry): Promise<Sidecar | undefined> {
  const local = localFiles.get(entry.id)
  if (local) return local.sidecar
  if (!entry.sidecar) return undefined
  try {
    const res = await fetch(outUrl(entry.sidecar), { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as Sidecar
  } catch (err) {
    setStatus(`Sidecar ${entry.sidecar}: ${errorText(err)}`, 'error')
    return undefined
  }
}

async function selectModel(id: string, opts: { anim?: string | null } = {}): Promise<void> {
  const entry = entries.find(e => e.id === id)
  if (!entry) {
    setStatus(`Unknown model id ${JSON.stringify(id)}`, 'error')
    return
  }
  const seq = ++selectSeq
  setStatus(`Loading ${entry.name}…`, 'info', 0)
  const previousBone = viewer.attachment?.boneName ?? ui.attachBone.value
  const sidecar = await fetchSidecar(entry)
  if (seq !== selectSeq) return
  const model = await viewer.loadModel(entry, sourceFor(entry), sidecar)
  if (!model || seq !== selectSeq) return
  setStatus('')
  anim?.dispose()
  anim = new AnimationController(model.container.animationGroups, name => !!findSidecarAnimation(sidecar, name)?.partial)
  anim.loop = ui.loop.checked
  anim.speed = Number(ui.speed.value)
  if (ui.modelList.value !== entry.id) ui.modelList.value = entry.id
  renderInfo()
  renderClips()
  renderBoneList(previousBone)
  ui.sidecar.textContent = sidecar ? JSON.stringify(sidecar, null, 2) : '(no sidecar)'
  const clip = opts.anim === undefined ? anim.groups[0]?.name ?? null : opts.anim
  selectClip(clip)
  if (ui.attachModel.value) await applyAttachment()
  await equipPanel?.onModelLoaded()
  writeUrlState()
}

function fmt(n: number): string {
  const a = Math.abs(n)
  return a >= 100 ? n.toFixed(1) : a >= 1 ? n.toFixed(3) : n.toPrecision(3)
}

function renderInfo(): void {
  const m = viewer.model
  const rows: Array<[string, string]> = []
  if (m) {
    const s = m.stats
    rows.push(
      ['id', m.entry.id],
      ['file', m.entry.glb],
      ['size (x·y·z)', `${fmt(s.size.x)} × ${fmt(s.size.y)} × ${fmt(s.size.z)}`],
      ['min', `${fmt(s.min.x)}, ${fmt(s.min.y)}, ${fmt(s.min.z)}`],
      ['max', `${fmt(s.max.x)}, ${fmt(s.max.y)}, ${fmt(s.max.z)}`],
      ['meshes', String(s.meshes)],
      ['vertices', s.vertices.toLocaleString()],
      ['triangles', s.triangles.toLocaleString()],
      ['bones', s.skeletons > 1 ? `${s.bones} (${s.skeletons} skeletons)` : String(s.bones)],
      ['materials', `${s.materials} (${s.textures} textures)`],
      ['clips', String(s.animationGroups)],
      ['grid step', fmt(viewer.gridStep)],
      ['load', `${s.loadMs.toFixed(0)} ms`],
    )
  }
  ui.info.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt')
    dt.textContent = k
    const dd = document.createElement('dd')
    dd.textContent = v
    dd.title = v
    return [dt, dd]
  }))
}

// ---- animation --------------------------------------------------------------------------------

function renderClips(): void {
  const groups = anim?.groups ?? []
  const fps = (g: (typeof groups)[number]) => g.targetedAnimations[0]?.animation.framePerSecond ?? 60
  ui.clipList.replaceChildren(
    new Option(groups.length ? '(rest pose)' : '(no animations)', ''),
    ...groups.map(g => new Option(`${g.name}  ${((g.to - g.from) / fps(g)).toFixed(2)} s`, g.name)),
  )
}

function selectClip(name: string | null): void {
  if (!anim) return
  const group = name ? anim.select(name) : null
  if (!group) {
    anim.stopAll()
    viewer.returnToRest()
    if (name) setStatus(`No clip named ${JSON.stringify(name)}`, 'error')
  }
  ui.clipList.value = group?.name ?? ''
  if (anim.baseName) setStatus(`${group!.name} is an overlay clip, playing over ${anim.baseName}`, 'info')
  events = group && viewer.model ? clipEvents(viewer.model.sidecar, group.name) : []
  lastTime = 0
  renderMarkers()
  writeUrlState()
}

function renderMarkers(): void {
  const duration = anim?.duration ?? 0
  ui.markers.replaceChildren(...events.map(e => {
    const m = document.createElement('div')
    const t = e.timeMs / 1000
    const pct = duration > 0 ? Math.min(1, Math.max(0, t / duration)) : 0
    m.className = `marker ev-${e.type === 1 || e.type === 2 ? e.type : 'other'}`
    m.style.left = `calc(7px + (100% - 14px) * ${pct})`
    m.title = `${EVENT_NAMES[e.type] ?? `type ${e.type}`} @ ${e.timeMs} ms`
    m.dataset.time = String(t)
    return m
  }))
}

function flashCrossedEvents(prev: number, cur: number): void {
  if (!events.length || cur === prev) return
  const wrapped = cur < prev
  const markers = ui.markers.children
  for (let i = 0; i < events.length; i++) {
    const t = events[i]!.timeMs / 1000
    const crossed = wrapped ? t > prev || t <= cur : t > prev && t <= cur
    if (!crossed) continue
    const m = markers[i] as HTMLElement | undefined
    if (!m) continue
    m.classList.remove('flash')
    void m.offsetWidth
    m.classList.add('flash')
  }
}

function updateTimeline(): void {
  const duration = anim?.duration ?? 0
  const time = anim?.time ?? 0
  const playing = anim?.isPlaying ?? false
  if (playing) flashCrossedEvents(lastTime, time)
  lastTime = time
  const label = `${time.toFixed(2)} / ${duration.toFixed(2)} s`
  if (ui.time.textContent !== label) ui.time.textContent = label
  const playLabel = playing ? 'Pause' : 'Play'
  if (ui.play.textContent !== playLabel) ui.play.textContent = playLabel
  ui.play.disabled = !anim?.current
  ui.scrub.disabled = !anim?.current
  if (!scrubbing) ui.scrub.value = String(duration > 0 ? time / duration : 0)
}

// ---- attachment -------------------------------------------------------------------------------

/** Items name their own socket in the converter sidecar (e.g. blade_01 -> "Bip01 R HandMid"); select it when present. */
async function preferItemAttachBone(): Promise<void> {
  const entry = entries.find(e => e.id === ui.attachModel.value)
  const bone = entry ? (await fetchSidecar(entry))?.attachBone : undefined
  if (typeof bone === 'string' && [...ui.attachBone.options].some(o => o.value === bone)) ui.attachBone.value = bone
}

async function applyAttachment(): Promise<void> {
  const id = ui.attachModel.value
  if (!id || !viewer.model) {
    viewer.detach()
    ui.attachInfo.textContent = ''
    writeUrlState()
    return
  }
  const entry = entries.find(e => e.id === id)
  const bone = ui.attachBone.value
  if (!entry) return setStatus(`Unknown attachment id ${JSON.stringify(id)}`, 'error')
  if (!bone) return setStatus('The current model has no bones or nodes to attach to', 'error')
  try {
    const att = await viewer.attach(entry, sourceFor(entry), bone, ui.attachMode.value as AttachMode)
    if (att) {
      const s = att.model.stats.size
      ui.attachInfo.textContent = `${entry.name} on "${bone}": ${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)}, ${att.model.stats.vertices} verts`
    }
  } catch (err) {
    setStatus(errorText(err), 'error')
  }
  writeUrlState()
}

// ---- drag & drop of local files ---------------------------------------------------------------

async function openLocalFiles(files: FileList): Promise<void> {
  const list = [...files]
  const glb = list.find(f => /\.glb$/i.test(f.name))
  if (!glb) return setStatus('Drop a .glb file (optionally with its sidecar .json)', 'error')
  const json = list.find(f => /\.json$/i.test(f.name))
  let sidecar: Sidecar | undefined
  if (json) {
    try {
      sidecar = JSON.parse(await json.text()) as Sidecar
    } catch (err) {
      setStatus(`${json.name}: ${errorText(err)}`, 'error')
    }
  }
  const id = `local:${glb.name}`
  localFiles.set(id, { glb, sidecar })
  if (!entries.some(e => e.id === id)) entries.push({ id, name: glb.name, category: 'local', glb: glb.name })
  renderModelList()
  renderAttachList()
  await selectModel(id)
}

// ---- wiring -----------------------------------------------------------------------------------

function run(task: () => Promise<void>): void {
  task().catch(err => {
    console.error(err)
    setStatus(errorText(err), 'error')
  })
}

function wireUi(): void {
  ui.modelFilter.addEventListener('input', renderModelList)
  ui.modelList.addEventListener('change', () => run(() => selectModel(ui.modelList.value)))
  ui.reloadIndex.addEventListener('click', () => run(async () => {
    await loadIndex()
    setStatus(`index.json: ${entries.length} entries`)
  }))
  ui.clipList.addEventListener('change', () => selectClip(ui.clipList.value || null))
  ui.loop.addEventListener('change', () => { if (anim) anim.loop = ui.loop.checked })
  ui.speed.addEventListener('input', () => {
    const v = Number(ui.speed.value)
    ui.speedOut.textContent = `${v.toFixed(2)}x`
    if (anim) anim.speed = v
  })
  ui.showSkeleton.addEventListener('change', () => viewer.setSkeletonVisible(ui.showSkeleton.checked))
  ui.showWireframe.addEventListener('change', () => viewer.setWireframe(ui.showWireframe.checked))
  ui.showNormals.addEventListener('change', () => viewer.setNormalsVisible(ui.showNormals.checked))
  ui.showGrid.addEventListener('change', () => viewer.setGridVisible(ui.showGrid.checked))
  ui.frame.addEventListener('click', () => viewer.frame())
  ui.attachModel.addEventListener('change', () => run(async () => {
    await preferItemAttachBone()
    await applyAttachment()
  }))
  for (const s of [ui.attachBone, ui.attachMode]) s.addEventListener('change', () => run(applyAttachment))

  ui.play.addEventListener('click', () => anim?.togglePlay())
  ui.scrub.addEventListener('pointerdown', () => { scrubbing = true })
  window.addEventListener('pointerup', () => { scrubbing = false })
  ui.scrub.addEventListener('change', () => { scrubbing = false })
  ui.scrub.addEventListener('input', () => anim?.scrub(Number(ui.scrub.value) * anim.duration))
  window.addEventListener('keydown', e => {
    const t = e.target as HTMLElement | null
    if (e.code !== 'Space' || (t && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(t.tagName))) return
    e.preventDefault()
    anim?.togglePlay()
  })

  ui.stage.addEventListener('dragover', e => {
    e.preventDefault()
    ui.stage.classList.add('dragging')
  })
  ui.stage.addEventListener('dragleave', () => ui.stage.classList.remove('dragging'))
  ui.stage.addEventListener('drop', e => {
    e.preventDefault()
    ui.stage.classList.remove('dragging')
    if (e.dataTransfer?.files.length) run(() => openLocalFiles(e.dataTransfer!.files))
  })
  window.addEventListener('unhandledrejection', e => setStatus(errorText(e.reason), 'error'))
}

async function main(): Promise<void> {
  const created = await createEngine(ui.canvas, initial.get('engine') !== 'webgl')
  ui.canvas = created.canvas
  const { engine, kind, note } = created
  ui.engineBadge.textContent = kind
  ui.engineBadge.className = `badge ${kind === 'WebGPU' ? 'gpu' : 'gl'}`
  ui.engineBadge.title = note ?? engine.description
  if (note) console.info(note)

  viewer = new Viewer(engine)
  equipPanel = new EquipmentPanel(el('equip-panel'), { viewer, selectModel: id => selectModel(id), setStatus, changed: writeUrlState })
  viewer.onBeforeUnload = () => equipPanel?.beforeModelUnload()
  if (import.meta.env.DEV) Object.assign(window, { __sro: { viewer, get anim() { return anim }, equip: equipPanel } })
  wireUi()
  new ResizeObserver(() => engine.resize()).observe(ui.canvas)

  let hudAt = 0
  engine.runRenderLoop(() => {
    viewer.scene.render()
    updateTimeline()
    const now = performance.now()
    if (now - hudAt > 500) {
      hudAt = now
      ui.hud.textContent = `${kind} · ${engine.getFps().toFixed(0)} fps${viewer.model ? ` · ${viewer.model.entry.name}` : ''}`
    }
  })

  try {
    await loadIndex()
  } catch (err) {
    setStatus(errorText(err), 'error', 0)
    return
  }

  try {
    await equipPanel.load(initial.get('equip'))
  } catch (err) {
    setStatus(errorText(err), 'error')
  }

  const wantAttach = initial.get('attach')
  if (wantAttach) {
    ui.attachModel.value = wantAttach
    const mode = initial.get('mode')
    if (mode === 'socket' || mode === 'bone' || mode === 'bind') ui.attachMode.value = mode
  }
  const wantModel = initial.get('model')
  if (wantModel) {
    // Pre-seed the bone so selectModel's re-attach uses the linked one when it exists.
    const bone = initial.get('bone')
    if (bone) ui.attachBone.replaceChildren(new Option(bone, bone, false, true))
    await selectModel(wantModel, { anim: initial.get('anim') ?? undefined })
  } else {
    setStatus('Pick a model on the left, or drop a .glb onto the view.', 'info', 6000)
  }
}

run(main)
